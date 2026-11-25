import {
  AREA_EPS, EPS, ON_LINE_EPS, apply as mapPoint, applyToLine, area, bounds, chord, clipPolygon, containsPoint,
  distance, dot, intersectConvex, invert, lineDirection, perpendicularBisector, reflection, signedDistance, sub,
  type Line, type Polygon, type Vec,
} from '../../vendor/origamio/src/geometry';
import {
  createPaper, currentPolygon, fold, type FoldResult,
} from '../../vendor/origamio/src/paper';
import { hinges, tears } from '../../vendor/origamio/src/rigid';
import { parseStep, type FoldStep, type StepJson } from '../../vendor/origamio/src/sequence';
import { connected, foldPacket, type MaterialPacket } from './packets';
import type { MaterialMark } from './material-points';
import { facetCreases } from './crease-references';
import { resolveLineFold, type LineFoldIntent, type LineReference } from './line-constraints';
import { paperInView, paperTransform, type PaperPose, type PaperState } from './paper-pose';
import type { GeometryEvidence } from './proof-geometry';

export type Move = StepJson & {
  readonly packet?: MaterialPacket;
  readonly intent?: LineFoldIntent;
  readonly geometry?: GeometryEvidence;
};
export type { PaperState };
export type Validation = {
  readonly status: 'accepted' | 'rejected' | 'unverified';
  readonly code: string;
  readonly reason: string;
};

export const ENGINE_REVISION = 'c28937855e8d4b08cd10c83b66689f3e94b924b2';

export const NUMERICS = Object.freeze({
  validatorVersion: 2,
  precision: 'IEEE 754 binary64',
  paperSize: 1,
  engineEpsilon: EPS,
  engineAreaEpsilon: AREA_EPS,
  engineOnLineEpsilon: ON_LINE_EPS,
  auditDistance: 1e-8,
  auditArea: 1e-8,
  maxFacets: 128,
});

const { auditDistance, auditArea, maxFacets } = NUMERICS;
const verifiedStates = new WeakSet<PaperState>();
const foldSources = new WeakMap<PaperState, PaperState>();

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function verified(state: PaperState): PaperState {
  deepFreeze(state);
  verifiedStates.add(state);
  return state;
}

export function initialState(): PaperState {
  return verified(createPaper());
}

const outcome = (status: Validation['status'], code: string, reason: string): Validation =>
  ({ status, code, reason });

function parseMove(value: unknown): FoldStep & { readonly packet?: MaterialPacket } {
  const fields = ['line', 'side', 'layers', 'region', 'window', 'placement', 'angle', 'attached'];
  function check(part: unknown, extras: string[]) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Expected a move object.');
    for (const key of Object.keys(part)) {
      if (!fields.includes(key) && !extras.includes(key)) throw new Error(`Unknown move field: ${key}.`);
    }
    const layers = (part as Move).layers;
    if (layers && typeof layers === 'object') {
      const keys = Object.keys(layers);
      if (keys.length !== 1 || !['top', 'bottom'].includes(keys[0])) {
        throw new Error('Choose exactly one layer selector.');
      }
    }
  }
  // The experiment checker handles geometric evidence separately from the material model.
  check(value, ['also', 'label', 'packet', 'intent', 'geometry']);
  const move = value as Move;
  if (Array.isArray(move.also)) {
    for (const part of move.also) check(part, []);
  }
  const step = parseStep(move);
  if (move.intent !== undefined) {
    const intent = move.intent;
    if (!intent || (intent.kind !== 'align-lines' && intent.kind !== 'perpendicular' && intent.kind !== 'perpendicular-point') ||
        !resolveLineFold(intent).solutions.some(solution => solution.side === step.side &&
          distance(solution.line.a, step.line.a) === 0 && distance(solution.line.b, step.line.b) === 0)) {
      throw new Error('The crease must match the recorded line constraint.');
    }
  }
  const packet = move.packet;
  if (packet === undefined) return step;
  if (!packet || typeof packet !== 'object' || Object.keys(packet).some(key => key !== 'facetIds') ||
      !Array.isArray(packet.facetIds) || !packet.facetIds.length || packet.facetIds.length > maxFacets ||
      !Array.from(packet.facetIds).every(id => Number.isSafeInteger(id) && id >= 0) ||
      new Set(packet.facetIds).size !== packet.facetIds.length) {
    throw new Error('A material packet needs distinct facet IDs from the current sheet.');
  }
  if (move.layers !== undefined || move.attached) throw new Error('Use material facet IDs or layer and attachment selectors.');
  return { ...step, packet };
}

function hasLineReference(state: PaperState, {facetId, line}: LineReference): boolean {
  const facet = state.facets.find(({id}) => id === facetId);
  if (!facet) return false;
  const poly = currentPolygon(facet);
  const edges = poly.map((a, i) => ({a, b: poly[(i + 1) % poly.length]}));
  return [line.a, line.b].every(point => containsPoint(poly, point)) &&
    [...facetCreases(state, facet), ...edges].some(segment =>
      [line.a, line.b].every(point => Math.abs(signedDistance(segment, point)) <= EPS &&
        dot(sub(point, segment.a), sub(point, segment.b)) <= EPS));
}

/** An outward swing on the exposed reverse side is a bottom placement in material space. */
function inPaperFrame(step: ReturnType<typeof parseMove>, pose: PaperPose | undefined): ReturnType<typeof parseMove> {
  if (!pose) return step;
  const line = applyToLine(invert(paperTransform(pose)), step.line);
  if (!pose.reversed) return {...step, line};
  const {layers, placement} = step.options;
  return {
    ...step, line, side: step.side === 1 ? -1 : 1,
    options: {
      ...step.options,
      layers: !layers || layers.kind === 'all' ? layers
        : {...layers, kind: layers.kind === 'top' ? 'bottom' : 'top'},
      placement: placement === 'inside' ? placement : placement === 'bottom' ? 'top' : 'bottom',
    },
  };
}

const interval = (poly: Polygon, axis: Line) => {
  const ds = poly.map(point => signedDistance(axis, point));
  return { low: Math.min(...ds), high: Math.max(...ds), ds };
};

function onAxis(axis: Line, points: Polygon): boolean {
  return points.every(point => Math.abs(signedDistance(axis, point)) <= auditDistance);
}

function segmentsOverlap(first: readonly Vec[], second: readonly Vec[], axis: Line): boolean {
  const direction = lineDirection(axis);
  const [a, b] = first.map(point => dot(point, direction)).sort((x, y) => x - y);
  const [c, d] = second.map(point => dot(point, direction)).sort((x, y) => x - y);
  return Math.min(b, d) - Math.max(a, c) > auditDistance;
}

function blockedHinge(before: PaperState, trial: FoldResult): boolean {
  const after = new Map(trial.state.facets.map(facet => [facet.id, facet]));
  const moved = new Set(trial.movedIds);
  const covers = before.facets.filter(facet => {
    if (moved.has(facet.id) || after.get(facet.id)?.poly !== facet.poly) return false;
    const { low, high } = interval(currentPolygon(facet), trial.line);
    return low < -ON_LINE_EPS && high > ON_LINE_EPS;
  });
  return hinges(trial.state).some(hinge => {
    if (moved.has(hinge.p) === moved.has(hinge.q)) return false;
    const p = after.get(hinge.p)!;
    const q = after.get(hinge.q)!;
    const edge = [hinge.a, hinge.b].map(point => mapPoint(p.transform, point));
    if (!onAxis(trial.line, edge)) return false;
    // Restrict the overlap to the actual welded segment on the new axis.
    const common = intersectConvex(currentPolygon(p), currentPolygon(q));
    return covers.some(cover => {
      const z = after.get(cover.id)!.z;
      if (z <= Math.min(p.z, q.z) || z >= Math.max(p.z, q.z)) return false;
      const overlap = intersectConvex(common, currentPolygon(cover));
      if (area(overlap) <= auditArea) return false;
      const segment = chord(overlap, trial.line);
      if (!segment) return false;
      // Keep the original tolerance along the dominant coordinate for legacy replay.
      const coordinate = Math.abs(edge[0].x - edge[1].x) >= Math.abs(edge[0].y - edge[1].y) ? 'x' : 'y';
      const [a, b] = edge.map(point => point[coordinate]).sort((x, y) => x - y);
      const [c, d] = segment.map(point => point[coordinate]).sort((x, y) => x - y);
      return Math.min(b, d) - Math.max(a, c) > auditDistance;
    });
  });
}

interface PacketPart {
  readonly poly: Polygon;
  readonly rank: number;
}

function inspectPacket(before: PaperState, trial: FoldResult, step: FoldStep, selected?: ReadonlySet<number>): Map<number, number> | undefined {
  const moved = new Set(trial.movedIds);
  const flip = reflection(step.line);
  const moving = new Map<number, PacketPart>();
  const staying = new Map<number, PacketPart>();
  const splitSources = new Map<number, number>();
  let splitId = before.nextId;

  // Check material-space clipping against the same construction in folded space.
  for (const facet of before.facets) {
    const poly = currentPolygon(facet);
    if (selected && !selected.has(facet.id)) {
      staying.set(facet.id, { poly, rank: facet.z });
      continue;
    }
    const { positive, negative } = clipPolygon(poly, step.line);
    const { low, high } = interval(poly, step.line);
    if ((high > ON_LINE_EPS && !positive.length) || (low < -ON_LINE_EPS && !negative.length)) {
      return;
    }
    const front = step.side === 1 ? positive : negative;
    const back = step.side === 1 ? negative : positive;
    if (front.length) {
      const id = back.length ? splitId++ : facet.id;
      moving.set(id, { poly: front.map(point => mapPoint(flip, point)), rank: facet.z });
      if (back.length) splitSources.set(id, facet.id);
    }
    if (back.length) staying.set(facet.id, { poly: back, rank: facet.z });
  }
  if (!moving.size || !staying.size || trial.state.facets.length !== moving.size + staying.size) return;

  function checkOrder(parts: Map<number, PacketPart>, movingPacket: boolean) {
    const ranks = new Map<number, number>();
    for (const facet of trial.state.facets.filter(f => moved.has(f.id) === movingPacket)) {
      const part = parts.get(facet.id);
      const poly = currentPolygon(facet);
      if (!part || part.poly.length !== poly.length ||
          poly.some((point, index) => distance(point, part.poly[index]) > auditDistance)) return false;
      parts.delete(facet.id);
      if (ranks.has(part.rank) && ranks.get(part.rank) !== facet.z) return false;
      ranks.set(part.rank, facet.z);
    }
    const ordered = [...ranks].sort(([a], [b]) => a - b).map(([, rank]) => rank);
    return !parts.size && ordered.every((rank, index) =>
      index === 0 || (movingPacket ? rank < ordered[index - 1] : rank > ordered[index - 1]));
  }

  if (!checkOrder(moving, true) || !checkOrder(staying, false)) return;

  const movingRanks = trial.state.facets.filter(f => moved.has(f.id)).map(f => f.z);
  const stationaryRanks = trial.state.facets.filter(f => !moved.has(f.id)).map(f => f.z);
  const position = step.options.placement === 'bottom'
    ? Math.max(...movingRanks) < Math.min(...stationaryRanks)
    : Math.min(...movingRanks) > Math.max(...stationaryRanks);
  if (!position) return;

  const join = hinges(trial.state);
  const inTrial = new Map(trial.state.facets.map(facet => [facet.id, facet]));
  const crossing = join.filter(hinge => moved.has(hinge.p) !== moved.has(hinge.q));
  if (crossing.length > 0 && crossing.every(hinge =>
    onAxis(step.line, [hinge.a, hinge.b].map(p => mapPoint(inTrial.get(hinge.p)!.transform, p))))) return splitSources;
}

function checkPartialMotion(
  before: PaperState, trial: FoldResult, step: FoldStep, selected: ReadonlySet<number>,
  splitSources: ReadonlyMap<number, number>, legacyClearance: boolean,
): Validation | undefined {
  const movingIds = new Set(trial.movedIds);
  if (!connected(movingIds, trial.state)) {
    return outcome('unverified', 'disconnected-packet', 'The moving pieces do not form one edge-connected material packet.');
  }
  const towardTop = step.options.placement !== 'bottom';
  const stationary = before.facets.filter(facet => !selected.has(facet.id))
    .map(facet => ({ id: facet.id, z: facet.z, poly: currentPolygon(facet) }));
  const oppositeSwing = (coverRank: number, rank: number) => towardTop ? coverRank < rank : coverRank > rank;
  for (const facet of before.facets.filter(facet => selected.has(facet.id))) {
    const cut = clipPolygon(currentPolygon(facet), step.line);
    const moving = step.side === 1 ? cut.positive : cut.negative;
    if (stationary.some(cover => (towardTop ? cover.z >= facet.z : cover.z <= facet.z) &&
        area(intersectConvex(moving, cover.poly)) > AREA_EPS)) {
      return outcome('rejected', 'buried-packet', 'Stationary paper covers the moving packet on the side it would swing through.');
    }
  }

  const facets = new Map(trial.state.facets.map(facet => [facet.id, facet]));
  const sources = new Map(before.facets.map(facet => [facet.id, facet]));
  const welds = hinges(trial.state).filter(hinge => movingIds.has(hinge.p) !== movingIds.has(hinge.q));
  for (const {id, z, poly} of stationary) {
    const {low, high} = interval(poly, step.line);
    if (low >= -ON_LINE_EPS || high <= ON_LINE_EPS) continue;
    const crossing = chord(poly, step.line);
    if (crossing && welds.some(({p, q, a, b}) => {
      const first = facets.get(p)!;
      const second = facets.get(q)!;
      const edge = [mapPoint(first.transform, a), mapPoint(first.transform, b)];
      if (!segmentsOverlap(edge, crossing, step.line)) return false;

      // At a new crease, both incident pieces shared one rank before the split.
      // A crossing sheet on the back of both pieces at launch and landing
      // stays outside the closing hinge throughout the half-turn.
      const [moving, fixed] = movingIds.has(p) ? [p, q] : [q, p];
      const landingRank = facets.get(id)!.z;
      return legacyClearance || splitSources.get(moving) !== fixed ||
        !oppositeSwing(z, sources.get(fixed)!.z) ||
        !oppositeSwing(landingRank, first.z) || !oppositeSwing(landingRank, second.z);
    })) {
      return outcome('unverified', 'hinge-cover', 'Stationary paper spans the joined hinge, so its clearance cannot be verified.');
    }
  }
}

function evaluate(state: PaperState, move: unknown, legacyClearance = false): { validation: Validation; trial?: FoldResult } {
  let step: ReturnType<typeof parseMove>;
  try {
    step = inPaperFrame(parseMove(move), state.pose);
  } catch (error) {
    return { validation: outcome('rejected', 'invalid-move', (error as Error).message) };
  }
  if (!verifiedStates.has(state)) {
    return { validation: outcome('unverified', 'unknown-state', 'Reconstruct the state by replaying a lab experiment first.') };
  }
  const intent = (move as Move).intent;
  if (intent && (!hasLineReference(paperInView(state), intent.source) ||
      (intent.kind === 'align-lines' && !hasLineReference(paperInView(state), intent.target)) ||
      (step.packet && !step.packet.facetIds.includes(intent.source.facetId)))) {
    return {validation: outcome('rejected', 'line-material', 'The selected line and moving packet must refer to the current material.')};
  }
  const opts = step.options;
  if (step.also?.length || opts.angle !== undefined || opts.region || opts.window) {
    return { validation: outcome('unverified', 'unsupported-motion', 'This motion is outside the single-axis flat-fold model.') };
  }
  const selected = step.packet && new Set(step.packet.facetIds);
  if (selected && [...selected].some(id => !state.facets.some(facet => facet.id === id))) {
    return { validation: outcome('rejected', 'unknown-facet', 'The selected material does not belong to this state.') };
  }
  const partial = selected && selected.size < state.facets.length ? selected : undefined;
  const full = !partial && (!opts.layers || opts.layers.kind === 'all');
  if (state.facets.length >= maxFacets) {
    return { validation: outcome('unverified', 'facet-limit', 'This state has reached the validator’s facet budget.') };
  }

  const portions = state.facets.map(facet => interval(currentPolygon(facet), step.line));
  const moving = (low: number, high: number) => (step.side === 1 ? high : -low) > ON_LINE_EPS;
  const stationary = (low: number, high: number) => moving(-high, -low);
  if (portions.some(({ds}) => ds.some(d => Math.abs(d) > EPS && Math.abs(d) <= ON_LINE_EPS))) {
    return { validation: outcome('unverified', 'near-axis', 'A vertex lies in the uncertain band around the fold axis.') };
  }
  if (!portions.some(({low, high}) => moving(low, high))) {
    return { validation: outcome('rejected', 'no-op', 'There is no paper on the moving side.') };
  }
  if (partial && state.facets.some((facet, index) => partial.has(facet.id) && !moving(portions[index].low, portions[index].high))) {
    return { validation: outcome('rejected', 'packet-side', 'Choose a moving side that contains part of every selected facet.') };
  }
  if (full && !portions.some(({low, high}) => stationary(low, high))) {
    return { validation: outcome('rejected', 'no-stationary-paper', 'This would turn the entire sheet over without a fixed hinge.') };
  }

  try {
    const trial = partial ? foldPacket(state, step.line, step.side, partial, opts) : fold(state, step.line, step.side, opts);
    if (!trial.movedIds.length) {
      return { validation: outcome('rejected', 'no-op', 'No selected paper moved.') };
    }
    if (trial.state.facets.length > maxFacets) {
      return { validation: outcome('unverified', 'facet-limit', 'The result exceeds the validator’s facet budget.') };
    }
    if (tears(trial.state)) {
      return { validation: outcome('rejected', 'torn-hinge', 'The fold would pull shared material edges apart.') };
    }
    if ((!full || opts.placement === 'inside') && blockedHinge(state, trial)) {
      return { validation: outcome('rejected', 'blocked-hinge', 'A stationary layer crosses the hinge between its closing plies.') };
    }
    if ((!full && !partial) || opts.placement === 'inside') {
      return { validation: outcome('unverified', 'unsupported-stack', 'The motion of a partial stack or inside placement is unverified.') };
    }
    const foldedArea = trial.state.facets.reduce((total, facet) => total + area(currentPolygon(facet)), 0);
    const splitSources = Math.abs(foldedArea - state.width * state.height) <= auditArea
      ? inspectPacket(state, trial, step, partial) : undefined;
    if (!splitSources) {
      return { validation: outcome('unverified', 'packet-audit', 'The result could not be verified as two packets joined only along the fold axis.') };
    }
    if (partial) {
      const obstruction = checkPartialMotion(state, trial, step, partial, splitSources, legacyClearance);
      if (obstruction) return { validation: obstruction };
      return { validation: outcome('accepted', 'packet-fold', 'The connected material packet can swing 180° on the exposed side of its fixed hinge.'), trial };
    }
    return { validation: outcome('accepted', 'simple-fold', 'A whole-stack half-plane can rotate 180° about the fixed axis.'), trial };
  } catch {
    return { validation: outcome('unverified', 'geometry-error', 'The geometric checks could not complete for this move.') };
  }
}

export function validate(state: PaperState, move: unknown): Validation {
  return evaluate(state, move).validation;
}

export function apply(state: PaperState, move: unknown, validatorVersion: 1 | 2 = NUMERICS.validatorVersion): {state: PaperState; validation: Validation} {
  const { validation, trial } = evaluate(state, move, validatorVersion === 1);
  if (!trial) return { state, validation };
  const folded = verified({
    ...trial.state, ...(state.marks && {marks: state.marks}), ...(state.pose && {pose: state.pose}),
  });
  foldSources.set(folded, state);
  return { state: folded, validation };
}

/** A later fold must have been reversed before the earlier path is safe to traverse. */
export function canReverseFold(state: PaperState, source: PaperState, folded: PaperState): boolean {
  // Only certified folds change the immutable mesh. Marks and retained creases do not affect the path.
  return verifiedStates.has(state) && foldSources.get(folded) === source &&
    state.facets === folded.facets && state.foldCount === folded.foldCount;
}

/** Keep the material annotations and ID allocation from the current state. */
export function reverseFold(state: PaperState, source: PaperState, folded: PaperState): PaperState | undefined {
  if (!canReverseFold(state, source, folded)) return;
  const {marks: _marks, pose: _pose, ...base} = source;
  return verified({
    ...base, creases: state.creases, nextId: state.nextId,
    ...(state.marks && {marks: state.marks}), ...(state.pose && {pose: state.pose}),
  });
}

/** Turn the whole object around its displayed vertical center without replacing its mesh. */
export function turnPaper(state: PaperState): {state: PaperState; axisX: number} {
  if (!verifiedStates.has(state)) throw new Error('Reconstruct the state by replaying a lab experiment first.');
  const {pose, ...paper} = state;
  const {minX, maxX} = bounds(state.facets.flatMap(facet => currentPolygon(facet)));
  const transform = paperTransform(pose);
  const materialAxisX = (minX + maxX) / 2;
  const axisX = transform.e + transform.a * materialAxisX;
  // Preserve both offsets so even a translated sheet returns exactly when turned twice about the same axis.
  const offsets = pose?.materialAxisX === materialAxisX ? pose : {
    materialAxisX,
    frontOffset: pose?.reversed ? transform.e - 2 * materialAxisX : transform.e,
    backOffset: pose?.reversed ? transform.e : transform.e + 2 * materialAxisX,
  };
  const nextPose = {...offsets, reversed: !pose?.reversed};
  const turned = nextPose.reversed || nextPose.frontOffset !== 0 ? {...paper, pose: nextPose} : paper;
  return {state: verified(turned), axisX};
}

export function withMaterialMarks(state: PaperState, marks: readonly MaterialMark[]): PaperState {
  if (!verifiedStates.has(state)) throw new Error('Reconstruct the state by replaying a lab experiment first.');
  const {marks: _marks, ...base} = state;
  return verified(marks.length ? { ...base, marks } : base);
}

/** Finite candidate set in the current folded bounds, in stable order. */
export function propose(state: PaperState): Move[] {
  if (!verifiedStates.has(state)) return [];
  const { minX, minY, maxX, maxY } = bounds(paperInView(state).facets.flatMap(facet => currentPolygon(facet)));
  const min = { x: minX, y: minY };
  const max = { x: maxX, y: maxY };
  const x = (min.x + max.x) / 2;
  const y = (min.y + max.y) / 2;
  const candidates: readonly [string, Line, readonly [string, string]][] = [
    ['Vertical half', {a: {x, y: min.y}, b: {x, y: max.y}}, ['left', 'right']],
    ['Horizontal half', {a: {x: max.x, y}, b: {x: min.x, y}}, ['bottom', 'top']],
    ['Corner to corner', perpendicularBisector({x: max.x, y: min.y}, {x: min.x, y: max.y}), ['lower-right', 'upper-left']],
    ['Opposite corner', perpendicularBisector(min, max), ['lower-left', 'upper-right']],
  ];
  const point = (p: Vec) => [p.x, p.y] as const;
  return candidates.flatMap(([label, axis, sides]) => ([1, -1] as const).map((side, index) => ({
    line: [point(axis.a), point(axis.b)], side, label: `${label} · ${sides[index]}`,
  })));
}
