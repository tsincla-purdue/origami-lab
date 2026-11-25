import { apply, type Line, type Vec } from '../../vendor/origamio/src/geometry';
import type { Move, PaperState } from './engine';
import { pointOnLineBranch, type CreaseReference, type GeometryEvidence, type SelectedLine, type SelectedPoint, type VertexReference } from './geometry-intent';
import { paperInView } from './paper-pose';
import type { Experiment } from './experiment';
import { CORNERS, ProofBudget, ProofGraph, project, squareVertices, type SquareCorner } from './proof-graph';

export type { CapturedGeometry, CreaseReference, GeometryEvidence, VertexReference } from './geometry-intent';

export interface GeometryCheckOptions {
  /** Optional number of derived proof nodes to evaluate, excluding the square's four vertices. */
  readonly maxDerivedNodes?: number;
}

export interface GeometryReport {
  readonly status: 'certified' | 'near-match' | 'unverified' | 'inconclusive' | 'invalid';
  readonly detail: string;
  readonly dependencies: readonly string[];
}

const report = (status: GeometryReport['status'], detail: string, dependencies: readonly string[] = []): GeometryReport =>
  ({status, detail, dependencies});
const root = (corner: SquareCorner) => `square:${corner}`;
const axisId = (attempt: number) => `step:${attempt}:axis`;
const landingId = (attempt: number) => `step:${attempt}:landing`;
const assert: (condition: unknown, detail: string) => asserts condition = (condition, detail) => {
  if (!condition) throw new Error(detail);
};

type XY = readonly [number, number];
type XYObject = {readonly x: number; readonly y: number};
const xy = ({x, y}: XYObject): XY => [x, y];
const cross = ([x, y]: XY, [u, v]: XY) => x * v - y * u;
const delta = ([x, y]: XY, [u, v]: XY): XY => [x - u, y - v];
const exactCoordinates = (a: XY, b: XY) => a[0] === b[0] && a[1] === b[1];
const norm = (p: XY) => Math.hypot(...p);

// Projection consistency for this unit-square slice. Exact identity is checked in ProofGraph.
const projectionTolerance = 2e-12;
const consistencyTolerance = 1e-8;
const near = (a: XY, b: XY) => norm(delta(a, b)) <= consistencyTolerance;
const close = (a: XY, b: XY) => norm(delta(a, b)) <= projectionTolerance;
const facetFor = (state: PaperState, id: number) => state.facets.find(facet => facet.id === id);
type Facet = NonNullable<ReturnType<typeof facetFor>>;

function keys(object: unknown, fields: readonly string[]) {
  return Boolean(object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === fields.length && fields.every(key => Object.hasOwn(object, key)));
}

function identity({transform: {a, b, c, d, e, f}}: Facet) {
  return a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0;
}

function vertex(state: PaperState, ref: VertexReference) {
  assert(keys(ref, ['corner', 'facetId']) && Number.isSafeInteger(ref.facetId) && CORNERS.includes(ref.corner),
    'Invalid material vertex ID.');
  const facet = facetFor(state, ref.facetId);
  assert(facet && facet.poly.some(point => exactCoordinates(xy(point), squareVertices[ref.corner])),
    'The named facet does not contain that material vertex.');
  const [x, y] = squareVertices[ref.corner];
  const {a, b, c, d, e, f} = facet.transform;
  return {facet, projected: [a * x + c * y + e, b * x + d * y + f] as XY};
}

function axisDistance(point: XY, origin: XY, direction: XY) {
  return cross(direction, delta(point, origin)) / norm(direction);
}

function covers(facet: Facet, point: XY, tolerance = projectionTolerance) {
  const signed = facet.poly.map((p, i) => axisDistance(point, xy(p), delta(xy(facet.poly[(i + 1) % facet.poly.length]), xy(p))));
  return signed.every(d => d >= -tolerance) || signed.every(d => d <= tolerance);
}

function checkRecordedProjection(move: Move, evidence: Exclude<GeometryEvidence, {kind: 'freehand'}>) {
  const projection = evidence.projection;
  assert(keys(projection, ['axis', 'side']) && (projection.side === -1 || projection.side === 1) &&
    Array.isArray(projection.axis) && projection.axis.length === 2 && Array.isArray(move.line) && move.line.length === 2 &&
    projection.axis.every((point, i) => Array.isArray(point) && point.length === 2 &&
      point.every(Number.isFinite) && Array.isArray(move.line[i]) && exactCoordinates(point, move.line[i])) &&
    projection.side === move.side, 'Geometric projection does not match the recorded axis or side.');
}

function checkProjection(move: Move, graph: ProofGraph, axis: string, moving: XY) {
  const exact = graph.axis(axis);
  const origin = project(exact.point), direction = project(exact.direction);
  const [a, b] = move.line;
  const actualDirection = delta(b, a);
  const extent = norm(actualDirection);
  assert(extent > projectionTolerance &&
    Math.abs(cross(actualDirection, direction)) <= projectionTolerance * extent * norm(direction) &&
    [a, b].every(point => Math.abs(axisDistance(point, origin, direction)) <= projectionTolerance),
    'The recorded axis is inconsistent with the exact constraint.');
  assert(move.side * axisDistance(moving, a, actualDirection) > projectionTolerance,
    'The recorded side does not move the selected source.');
}

function freehandReport(move: Move, activeApex: number | undefined, graph: ProofGraph): GeometryReport {
  if (activeApex !== undefined) {
    const id = landingId(activeApex);
    const [x, y] = project(graph.point(id));
    const [[ax, ay], [bx, by]] = move.line;
    const dx = bx - ax;
    const slope = (by - ay) / dx;
    // This diagnostic neither resolves a reference ID nor enters the proof graph.
    if (Math.abs(dx) > projectionTolerance && Math.abs(slope) <= .01 &&
        Math.abs(ay + (x - ax) * slope - y) <= .01) {
      return report('near-match', 'Freehand axis is near the horizontal through the certified apex.', [id]);
    }
  }
  return report('unverified', 'Freehand axis has no recorded exact constraint.');
}

function vector(point: unknown): point is Vec {
  return keys(point, ['x', 'y']) && Number.isFinite((point as Vec).x) && Number.isFinite((point as Vec).y);
}

function selectedPoint(view: PaperState, selected: SelectedPoint) {
  const material = selected?.material;
  assert(keys(selected, material === undefined ? ['point'] : ['point', 'material']) && vector(selected.point),
    'Invalid acquired point.');
  if (material === undefined) return;
  assert(keys(material, ['facetId', 'point', ...(material?.corner === undefined ? [] : ['corner']),
    ...(material?.markId === undefined ? [] : ['markId'])]) && Number.isSafeInteger(material.facetId) &&
    vector(material.point), 'Invalid material point reference.');
  const facet = facetFor(view, material.facetId);
  assert(facet && covers(facet, xy(material.point), consistencyTolerance) &&
    near(xy(apply(facet.transform, material.point)), xy(selected.point)),
    'The material point does not match its recorded placement.');
  if (material.corner !== undefined) {
    assert(CORNERS.includes(material.corner) && exactCoordinates(xy(material.point), squareVertices[material.corner]),
      'The point is not the named square vertex.');
  }
  if (material.markId !== undefined) {
    const mark = view.marks?.find(({id}) => id === material.markId);
    assert(mark && exactCoordinates(xy(mark.point), xy(material.point)), 'The point is not the named material mark.');
  }
}

function onSegment(point: XY, {a, b}: Line) {
  const direction = delta(xy(b), xy(a));
  const extent = norm(direction);
  const [u, v] = direction;
  const [x, y] = delta(point, xy(a));
  const along = (x * u + y * v) / extent;
  return Math.abs(axisDistance(point, xy(a), direction)) <= consistencyTolerance &&
    along >= -consistencyTolerance && along <= extent + consistencyTolerance;
}

function materialCrease(view: PaperState, ref: CreaseReference) {
  assert(keys(ref, ['crease', 'facetId']) && Number.isSafeInteger(ref.crease) && Number.isSafeInteger(ref.facetId),
    'Invalid material crease ID.');
  const facet = facetFor(view, ref.facetId);
  const crease = view.creases[ref.crease];
  assert(facet && crease, 'The named material crease or facet does not exist.');
  return {facet, line: {a: apply(facet.transform, crease.a), b: apply(facet.transform, crease.b)}};
}

function selectedLine(view: PaperState, selected: SelectedLine) {
  const crease = selected?.crease;
  assert(keys(selected, crease === undefined ? ['facetId', 'line'] : ['facetId', 'line', 'crease']) &&
    Number.isSafeInteger(selected.facetId) && keys(selected.line, ['a', 'b']) &&
    vector(selected.line.a) && vector(selected.line.b) && !exactCoordinates(xy(selected.line.a), xy(selected.line.b)),
    'Invalid acquired line.');
  const facet = facetFor(view, selected.facetId);
  assert(facet, 'The named line facet does not exist.');
  const world = facet.poly.map(point => apply(facet.transform, point));
  const candidates = crease === undefined
    ? world.map((a, i) => ({a, b: world[(i + 1) % world.length]}))
    : [materialCrease(view, {facetId: selected.facetId, crease}).line];
  assert(candidates.some(line => [selected.line.a, selected.line.b].every(point => onSegment(xy(point), line))) &&
    [selected.line.a, selected.line.b].every(point => covers({...facet, poly: world}, xy(point), consistencyTolerance)),
    'The acquired segment does not match its material reference.');
}

function checkReflection(move: Move, moving: XY, landing: XY, pin?: XY) {
  const [start, end] = move.line;
  const direction = delta(end, start);
  const extent = norm(direction);
  const distance = axisDistance(moving, start, direction);
  const reflected: XY = [moving[0] + 2 * distance * direction[1] / extent, moving[1] - 2 * distance * direction[0] / extent];
  assert(move.side * distance > 0 && near(reflected, landing) &&
    (!pin || Math.abs(axisDistance(pin, start, direction)) <= consistencyTolerance),
    'The recorded axis is inconsistent with the selected reflection or moving side.');
}

const unsupported = (detail: string) => report('unverified', detail);

/** Check captured intent against replay, then certify the supported subset without calling a fold solver. */
export function inspectGeometry(experiment: Experiment, options: GeometryCheckOptions = {}): readonly GeometryReport[] {
  const budget = options.maxDerivedNodes;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
    throw new RangeError('The derived proof node budget must be a nonnegative integer.');
  }
  const graph = budget === undefined ? new ProofGraph() : new ProofGraph(CORNERS.length + budget);
  for (const corner of CORNERS) graph.add(root(corner), {kind: 'vertex', corner});
  const centers = new Map<number, string | 'inconclusive'>();
  const apices = new Map<number, string>();
  const inconclusive = new Set<number>();
  const active: number[] = [];
  let turned = false;
  let before = experiment.initial;

  function certifyEquilateral(attempt: number, move: Move, moving: XY, crease: number) {
    const proof = centers.get(crease);
    if (proof === 'inconclusive') return report('inconclusive', 'Checking the selected center crease ran out of proof budget.');
    if (!proof) return unsupported('The selected center crease has no exact proof.');
    const landing = landingId(attempt), axis = axisId(attempt);
    graph.add(landing, {kind: 'equilateral-apex', pin: root('A'), moving: root('B'), target: proof, branch: 'above-pin'});
    graph.add(axis, {kind: 'bisector', from: root('B'), to: landing});
    checkProjection(move, graph, axis, moving);
    apices.set(attempt, proof);
    return report('certified', 'Equilateral upper branch at (1/2, √3/2).',
      [...new Set([...graph.dependencies(axis), ...graph.dependencies(landing)])]);
  }

  function check(move: Move, attempt: number): GeometryReport {
    const evidence = move.geometry;
    if (evidence === undefined) return unsupported('No geometric reference was recorded.');
    assert(evidence?.version === 1, 'Unknown geometric evidence version.');
    const activeApex = !turned && active.length === 1 && apices.has(active[0]) ? active[0] : undefined;
    if (evidence.kind === 'freehand') {
      assert(keys(evidence, ['kind', 'version']) && !move.intent, 'Invalid freehand evidence.');
      return freehandReport(move, activeApex, graph);
    }
    checkRecordedProjection(move, evidence);
    const view = paperInView(before);
    const axis = axisId(attempt);
    const common = ['version', 'kind', 'projection'];
    const flat = !turned && active.length === 0;
    switch (evidence.kind) {
      case 'vertex-bisector': {
        assert(keys(evidence, [...common, 'moving', 'target']) && !move.intent, 'Invalid vertex bisector evidence.');
        const moving = vertex(view, evidence.moving), target = vertex(view, evidence.target);
        checkReflection(move, moving.projected, target.projected);
        if (!flat || !identity(moving.facet) || !identity(target.facet)) {
          return unsupported('Selected vertex bisector is outside the exact flat-square frame.');
        }
        graph.add(axis, {kind: 'bisector', from: root(evidence.moving.corner), to: root(evidence.target.corner)});
        checkProjection(move, graph, axis, moving.projected);
        return report('certified', 'Exact perpendicular bisector of the selected square vertices.', graph.dependencies(axis));
      }
      case 'equilateral-o5': {
        // Earlier exports used a specialized assertion for this witness.
        assert(keys(evidence, [...common, 'moving', 'pin', 'target', 'branch']) && !move.intent &&
          evidence.branch === 'above-pin', 'Invalid equilateral witness or branch.');
        const moving = vertex(view, evidence.moving), pin = vertex(view, evidence.pin);
        const {facet, line} = materialCrease(view, evidence.target);
        const upper: XY = [.5, Math.sqrt(3) / 2];
        assert(flat && identity(facet) && evidence.pin.corner === 'A' && evidence.moving.corner === 'B' &&
          Math.abs(line.a.x - .5) <= projectionTolerance && Math.abs(line.b.x - .5) <= projectionTolerance &&
          onSegment(upper, line) && covers(facet, upper), 'The asserted equilateral references do not match the unit square.');
        checkReflection(move, moving.projected, upper, pin.projected);
        return certifyEquilateral(attempt, move, moving.projected, evidence.target.crease);
      }
      case 'point-on-line': {
        assert(keys(evidence, [...common, 'moving', 'pin', 'target', 'branch', 'landing']) && !move.intent &&
          vector(evidence.landing), 'Invalid point-on-line evidence.');
        selectedPoint(view, evidence.moving);
        selectedPoint(view, evidence.pin);
        selectedLine(view, evidence.target);
        const moving = xy(evidence.moving.point), pin = xy(evidence.pin.point), landing = xy(evidence.landing);
        assert(onSegment(landing, evidence.target.line) &&
          evidence.branch === pointOnLineBranch(evidence.pin.point, evidence.landing, evidence.target),
          'The recorded landing does not match the selected line or solution branch.');
        checkReflection(move, moving, landing, pin);
        if (flat && evidence.pin.material?.corner === 'A' && evidence.moving.material?.corner === 'B' &&
            evidence.target.crease !== undefined && centers.has(evidence.target.crease) && evidence.landing.y > 0) {
          return certifyEquilateral(attempt, move, moving, evidence.target.crease);
        }
        return unsupported('The selected point-on-line constraint is outside the current proof rules.');
      }
      case 'point-to-point': {
        assert(keys(evidence, [...common, 'moving', 'target']) && !move.intent, 'Invalid point-to-point evidence.');
        selectedPoint(view, evidence.moving);
        selectedPoint(view, evidence.target);
        checkReflection(move, xy(evidence.moving.point), xy(evidence.target.point));
        return unsupported('The selected point-to-point constraint is outside the current proof rules.');
      }
      case 'through-points': {
        assert(keys(evidence, [...common, 'points']) && !move.intent && Array.isArray(evidence.points) &&
          evidence.points.length >= 1 && evidence.points.length <= 2, 'Invalid crease-through-points evidence.');
        const [start, end] = move.line;
        for (const point of evidence.points) {
          selectedPoint(view, point);
          assert(Math.abs(axisDistance(xy(point.point), start, delta(end, start))) <= consistencyTolerance,
            'The recorded crease does not pass through the selected point.');
        }
        return unsupported('The selected crease-through-points constraint is outside the current proof rules.');
      }
      case 'line-fold': {
        const intent = move.intent;
        assert(intent && keys(evidence, [...common, 'source', intent.kind === 'align-lines' ? 'target' : 'pin']),
          'Invalid line-fold evidence.');
        function matchesLine(recorded: SelectedLine | undefined, used: SelectedLine) {
          assert(recorded && recorded.facetId === used.facetId && near(xy(recorded.line.a), xy(used.line.a)) &&
            near(xy(recorded.line.b), xy(used.line.b)), 'The selected line disagrees with the numerical fold.');
          selectedLine(view, recorded);
        }
        matchesLine(evidence.source, intent.source);
        if (intent.kind === 'align-lines') matchesLine(evidence.target, intent.target);
        else {
          assert(evidence.pin && near(xy(evidence.pin.point), xy(intent.pin)), 'The selected pin disagrees with the numerical fold.');
          selectedPoint(view, evidence.pin);
        }
        return unsupported('The selected line fold is outside the current proof rules.');
      }
      case 'perpendicular-through': {
        const intent = move.intent;
        assert(keys(evidence, [...common, 'pin', 'source']) && intent?.kind === 'perpendicular-point',
          'Invalid perpendicular evidence.');
        const pin = vertex(view, evidence.pin);
        assert(near(pin.projected, xy(intent.pin)), 'The selected pin disagrees with the numerical fold.');
        const {facet} = materialCrease(view, evidence.source);
        selectedLine(view, {...intent.source, crease: evidence.source.crease});
        assert(facet.id === intent.source.facetId, 'The selected line facet disagrees with the numerical fold.');
        const proof = centers.get(evidence.source.crease);
        if ((!turned && active.length === 1 && inconclusive.has(active[0])) || proof === 'inconclusive') {
          return report('inconclusive', 'Checking a selected dependency ran out of proof budget.');
        }
        if (activeApex === undefined || !proof || proof !== apices.get(activeApex) || !identity(facet) ||
            evidence.pin.corner !== 'B' || identity(pin.facet)) {
          return unsupported('The selected perpendicular is outside the proved equilateral frame.');
        }
        const landing = landingId(activeApex);
        assert(close(pin.projected, project(graph.point(landing))), 'The pin is not the proved apex on the recorded facet.');
        graph.add(axis, {kind: 'perpendicular', point: landing, line: proof});
        checkProjection(move, graph, axis, xy(intent.moving));
        return report('certified', 'Horizontal through the certified apex at y = √3/2.', graph.dependencies(axis));
      }
      default:
        throw new Error('Unknown geometric constraint.');
    }
  }

  return experiment.attempts.map((entry, index) => {
    const attempt = index + 1;
    let result = unsupported('This operation has no fold constraint.');
    if (!entry.operation) {
      try {
        result = check(entry.move, attempt);
      } catch (error) {
        result = report(error instanceof ProofBudget ? 'inconclusive' : 'invalid', (error as Error).message);
      }
      if (result.status === 'inconclusive') inconclusive.add(attempt);
      if (entry.validation.status === 'accepted') {
        if (entry.move.geometry?.kind === 'vertex-bisector' &&
          (result.status === 'inconclusive' || result.status === 'certified' && graph.isCenter(axisId(attempt)))) {
          for (let i = before.creases.length; i < entry.state.creases.length; i++) {
            const {a, b} = entry.state.creases[i];
            if ([a, b].every(point => Math.abs(point.x - .5) <= projectionTolerance)) {
              centers.set(i, result.status === 'certified' ? axisId(attempt) : 'inconclusive');
            }
          }
        }
        active.push(attempt);
      }
    } else if (entry.operation === 'unfold' && active.at(-1) === entry.move.foldAttempt) {
      active.pop();
    } else if (entry.operation === 'flip') {
      turned = true;
    }
    before = entry.state;
    return result;
  });
}
