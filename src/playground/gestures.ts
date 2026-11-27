import {
  EPS, add, apply, distance, dot, invert, reflection, sideOf, signedDistance, sub, type Line, type Mat, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';
import { connected, cornerPackets, packetHingeAxis, packetHingeLanding, type MaterialPacket } from '../lab/packets';
import type { openingMotions } from '../lab/experiment';
import { containsLinePoint, resolveLineFold, type LineFoldIntent, type LineReference } from '../lab/line-constraints';
import { solvePointOntoLine, type ConstraintResult, type ConstraintSolution } from '../lab/constraints';
import type { PaperState } from '../lab/engine';
import { pointOnLineBranch, type CapturedGeometry, type PointOnLine } from '../lab/geometry-intent';
import { creasePairs, drawnMarkCandidates, sameAxis } from './crease-snap';
import { lineKey, pointKey, releaseRadius, selectSnap, snapRadius, type SnapCandidate } from './snap-selection';
import {
  CORNER_HIT_RADIUS, LINE_GRAB_RADIUS, MARK_HIT_RADIUS, cornerFold, foldMove, nearestLine,
  nearestPoint, nearestSupportingLine, paperGeometry, type MarkOption,
} from './geometry';

export type Tool = 'corner' | 'crease';
export interface Draft {
  readonly tool: Tool;
  readonly line: Line;
  readonly side?: Side;
  readonly anchor: Vec;
  readonly destination: Vec;
  readonly snapped: readonly Vec[];
  readonly creaseSnapped?: boolean;
  readonly packet?: MaterialPacket;
  readonly inferFrom?: readonly MaterialPacket[];
  readonly constraint?: { readonly target: Line; readonly solutions: readonly ConstraintSolution[]; readonly index: number };
  readonly lineIntent?: LineFoldIntent;
  readonly source?: Line;
  readonly snapLabel?: string;
  readonly alternatives?: readonly Draft[];
  readonly capture?: Exclude<CapturedGeometry, {kind: 'point-on-line'}> | PointOnLine;
  readonly opening?: {readonly foldAttempt: number; readonly obstruction?: 'covered' | 'disconnected'};
}

export function draftCapture({capture, destination}: Draft): CapturedGeometry | undefined {
  return capture?.kind === 'point-on-line'
    ? {...capture, landing: destination, branch: pointOnLineBranch(capture.pin.point, destination, capture.target)}
    : capture;
}

export interface ConstraintIssue {
  readonly reason: string;
  readonly target?: Line;
  readonly source?: Line;
  readonly status?: 'unverified' | 'rejected';
}

export function draftMove(draft: Draft) {
  if (draft.side === undefined || draft.opening) return;
  const label = draft.lineIntent?.kind === 'align-lines' ? 'Align lines'
    : draft.lineIntent ? 'Perpendicular through point'
    : draft.constraint ? 'Point onto line' : draft.snapLabel ?? (draft.creaseSnapped ? 'Crease through two points'
    : draft.tool === 'corner' ? 'Point drag' : 'Drawn crease');
  const move = foldMove(draft.line, draft.side, label);
  return {...move, ...(draft.packet && {packet: draft.packet}), ...(draft.lineIntent && {intent: draft.lineIntent})};
}

export interface CornerSelection {
  readonly corner: Vec;
  readonly packets: readonly MaterialPacket[];
  readonly count: number | 'all';
}

const TAP_INTERVAL = 3500; // Milliseconds between deliberate taps. Dragging has no deadline.

interface Drag {
  id: number;
  start: Vec;
  anchor: Vec;
  tapAnchor: Vec;
  rawAnchor: Vec;
  grabOffset: Vec;
  minimum: number;
  moved: boolean;
  tapOnly: boolean;
  hingeLandings: readonly Vec[];
  openings: readonly Draft[];
  source?: LineReference;
  pointSources: readonly LineReference[];
  snapKey?: string;
  longPress?: boolean;
}

export interface GestureInput {
  readonly point: Vec;
  readonly pointerType: string;
  readonly altKey?: boolean;
}

export interface GesturePress extends GestureInput {
  readonly id: number;
  readonly time: number;
}

export interface SnapObservation {
  readonly key?: string;
  readonly proximity: number;
}

export interface GestureCallbacks {
  snapping: () => boolean;
  show: (draft?: Draft, hover?: Vec, issue?: ConstraintIssue) => void;
  commit: (draft: Draft) => void;
  openingMotions: () => ReturnType<typeof openingMotions>;
  markedPerpendicular: (moving: number, through: number, crease: number, facetId: number) =>
    {line: Line; landing: Vec} | undefined;
}

export function createGestureInterpreter(callbacks: GestureCallbacks & {
  transform: () => Mat | undefined;
  ended?: (id: number) => void;
  exposedOnly?: boolean;
}) {
  const {transform, exposedOnly} = callbacks;
  let state: PaperState | undefined;
  let tool: Tool = 'corner';
  let geometry: ReturnType<typeof paperGeometry> | undefined;
  let targets: readonly Vec[] | undefined;
  let drag: Drag | undefined;
  let held: Draft | undefined;
  let pin: Vec | undefined;
  let confirmPin = false;
  let issue: ConstraintIssue | undefined;
  let observation: SnapObservation = {proximity: 0};
  let selection: CornerSelection | undefined;
  let lastTap: number | undefined;
  let wholeStack = false;
  let explicit = false;
  let offeredMarks: readonly MarkOption[] = [];
  let ghost: MarkOption | undefined;
  const packetOptions = new Map<Vec, readonly MaterialPacket[]>();

  function chooseCorner(corner: Vec | undefined) {
    if (selection?.corner === corner) return;
    const packets = corner && state ? packetOptions.get(corner) ?? cornerPackets(state, corner) : [];
    if (corner) packetOptions.set(corner, packets);
    selection = corner && packets.length ? { corner, packets, count: wholeStack ? 'all' : packets[0].facetIds.length } : undefined;
    lastTap = undefined;
    explicit = wholeStack;
  }

  function packet() {
    return selection?.packets.find(choice => choice.facetIds.length === selection?.count);
  }

  function material() {
    return { packet: packet(), inferFrom: tool === 'corner' && !explicit ? selection?.packets : undefined };
  }

  function cycle(time: number) {
    if (!selection) return;
    const current = selection.packets.findIndex(choice => choice.facetIds.length === selection?.count);
    const next = lastTap !== undefined && time - lastTap <= TAP_INTERVAL
      ? (current + 1) % selection.packets.length : 0;
    selection = { ...selection, count: selection.packets[next].facetIds.length };
    wholeStack = false;
    explicit = true;
    lastTap = time;
  }

  function refreshHeld() {
    if (held?.opening || held?.alternatives?.some(option => option.opening)) held = undefined;
    else if (held) held = { ...held, ...material() };
    callbacks.show(held, undefined, issue);
  }

  function snap(point: Vec, map: NonNullable<ReturnType<typeof transform>>, event: GestureInput, hingeLandings: readonly Vec[] = []) {
    if (!geometry || !callbacks.snapping() || event.altKey) return;
    targets ??= geometry.snapPoints();
    return nearestPoint(hingeLandings.length ? [...hingeLandings, ...targets] : targets, point, map, snapRadius(event.pointerType));
  }

  function release() {
    const id = drag?.id;
    drag = undefined;
    observation = {proximity: 0};
    if (id !== undefined) callbacks.ended?.(id);
  }

  function cancel() {
    release();
    held = undefined;
    pin = undefined;
    confirmPin = false;
    issue = undefined;
    offeredMarks = [];
    ghost = undefined;
    callbacks.show();
  }

  function constrainedDraft(
    result: ConstraintResult, anchor: Vec, target: Vec, map: Mat, targetLine: Line, lineIntent?: LineFoldIntent,
  ): Draft | undefined {
    const source = lineIntent?.source.line;
    if (result.status !== 'solved') {
      issue = {source, target: targetLine, reason: result.reason, status: result.status === 'unverified' ? 'unverified' : 'rejected'};
      return;
    }
    const candidates = result.solutions.map(solution => solution.destination);
    const landing = nearestPoint(candidates, target, map, Infinity)!;
    const start = apply(map, anchor);
    if (lineIntent && lineIntent.kind !== 'align-lines' &&
        dot(sub(target, start), sub(apply(map, landing), start)) <= 0) {
      issue = {source, reason: 'Drag along the line toward the reflected landing.'};
      return;
    }
    const index = candidates.indexOf(landing);
    const capture = geometry && lineIntent ? {kind: 'line-fold' as const, source: geometry.lineReference(lineIntent.source),
      ...(lineIntent.kind === 'align-lines' ? {target: geometry.lineReference(lineIntent.target)}
        : {pin: geometry.pointReference(lineIntent.pin)})} : undefined;
    return {...result.solutions[index], tool, anchor, snapped: [landing], ...material(), lineIntent,
      capture, constraint: {target: targetLine, solutions: result.solutions, index}};
  }

  function pinnedDraft(reference: LineReference, anchor: Vec, target: Vec, map: Mat, fixed: Vec) {
    const result = solvePointOntoLine(fixed, anchor, reference.line, true);
    const draft = constrainedDraft(result, anchor, target, map, reference.line);
    if (!draft || !geometry) return draft;
    const capture: PointOnLine = {kind: 'point-on-line', moving: geometry.pointReference(anchor, drag?.source?.facetId),
      pin: geometry.pointReference(fixed), target: geometry.lineReference(reference)};
    return {...draft, capture};
  }

  function previewSnap(options: readonly SnapCandidate<Draft>[], radius: number, press: Drag, target: Vec, map: Mat): Draft | undefined {
    const openings = options.filter(option => option.value.opening);
    // A fold onto the very same hinge is the geometric description of the opening.
    // Keep separate axes in the normal competition and use the same hysteresis.
    const candidatesForSnap = options.filter(({value}) => value.opening ||
      !openings.some(option => (option.score <= radius || option.key === press.snapKey) &&
        sameAxis(option.value.line, value.line)));
    // An axis can score well through retained crease points even when its reflected
    // landing misses the hand. Near an opening, compare actual landings in pixels.
    const directOpening = openings.find(opening => opening.score <= radius / 4 &&
      candidatesForSnap.every(option => option === opening ||
        distance(apply(map, option.value.destination), target) > opening.score + 1));
    const [primary, ...nearby] = directOpening ? [directOpening] : selectSnap(candidatesForSnap, radius, press.snapKey);
    if (exposedOnly) {
      const range = releaseRadius(radius);
      const score = options.reduce((best, option) => Math.min(best, option.score), range);
      observation = {key: primary?.key, proximity: 1 - score / range};
    }
    press.snapKey = primary?.key;
    if (!primary) return;
    const candidates = [primary, ...nearby];
    const distinct: Draft[] = [];
    const targetFacet = (draft: Draft) => draft.lineIntent?.kind === 'align-lines' ? draft.lineIntent.target.facetId : undefined;
    for (const {value} of candidates) {
      // The same motion may hit a mark and align its line. Keep the alignment's material reference.
      const alignment = !value.opening && value.source && candidates.find(({value: option}) =>
        option.lineIntent?.kind === 'align-lines' && sameAxis(value.line, option.line));
      const marked = !value.opening && candidates.find(({value: option}) =>
        option.capture?.kind === 'marked-perpendicular' && sameAxis(value.line, option.line));
      const draft = marked ? marked.value : alignment ? alignment.value : value;
      if (!distinct.some(other => targetFacet(draft) === targetFacet(other) && sameAxis(draft.line, other.line))) distinct.push(draft);
    }
    return distinct.length > 1 ? {...distinct[0], alternatives: distinct.slice(1)} : distinct[0];
  }

  function openingCandidates(press: Drag, target: Vec, map: Mat, radius: number): SnapCandidate<Draft>[] {
    return press.openings.flatMap(value => {
      const destination = apply(map, value.destination);
      const start = apply(map, press.anchor);
      const axis = sub(destination, start);
      const score = distance(target, destination);
      if (score > releaseRadius(radius) || dot(sub(target, start), axis) <= dot(axis, axis) / 2) return [];
      return [{key: `opening/${value.opening!.foldAttempt}`, score, value}];
    });
  }

  function pointDrafts(press: Drag, target: Vec, map: Mat, points: readonly Vec[], radius: number) {
    return points.flatMap(destination => {
      const score = distance(apply(map, destination), target);
      if (score > releaseRadius(radius)) return [];
      const fold = cornerFold(press.anchor, destination, map, press.minimum);
      if (!fold) return [];
      const source = press.source?.line;
      const snapLabel = source ? 'Grabbed point onto mark'
        : geometry?.marked.includes(destination) ? 'Point onto mark' : undefined;
      const moving = geometry?.vertexReference(press.anchor);
      const vertex = geometry?.vertexReference(destination);
      const capture = moving && vertex ? {kind: 'vertex-bisector', moving, target: vertex} as const
        : geometry && {kind: 'point-to-point', moving: geometry.pointReference(press.anchor, press.source?.facetId),
          target: geometry.pointReference(destination)} as const;
      const value: Draft = {...fold, tool, anchor: press.anchor, destination, snapped: [destination], source, snapLabel, capture, ...material()};
      return [{key: `point/${pointKey(destination)}`, score, value}];
    });
  }

  function markedDrafts(press: Drag, target: Vec, map: Mat, radius: number): SnapCandidate<Draft>[] {
    const paper = geometry;
    if (!paper || !paper.marked.includes(press.anchor)) return [];
    const anchor = press.anchor;
    const moving = paper.pointReference(anchor);
    if (moving.material?.markId === undefined) return [];
    const {facetId, markId} = moving.material;
    const sources = paper.pointSources(anchor, facetId).map(paper.lineReference).filter(line => line.crease !== undefined);
    const start = apply(map, anchor);
    return paper.marked.flatMap(point => {
      if (point === anchor) return [];
      const through = paper.pointReference(point);
      const throughId = through.material?.markId;
      if (throughId === undefined || through.material?.facetId !== facetId) return [];
      const direction = sub(apply(map, point), start);
      // The dragged mark must actually pass the second mark. Dropping on it remains point-to-point.
      if (dot(sub(target, start), direction) <= dot(direction, direction)) return [];
      const match = sources.filter(({line}) => containsLinePoint(line, point));
      if (match.length !== 1) return [];
      const [source] = match;
      const midpointLanding = add(point, sub(point, anchor));
      if (distance(apply(map, midpointLanding), target) > releaseRadius(radius) + 2) return [];
      const realized = callbacks.markedPerpendicular(markId, throughId, source.crease!, facetId);
      const landing = realized?.landing ?? midpointLanding;
      const fold = realized ? {line: realized.line, side: sideOf(realized.line, anchor)}
        : cornerFold(anchor, landing, map, press.minimum);
      if (!fold) return [];
      const value: Draft = {...fold, tool, anchor, destination: landing, snapped: [point], source: source.line,
        snapLabel: 'Perpendicular through mark', capture: {kind: 'marked-perpendicular', moving, through, source, landing},
        ...material()};
      return [{key: `marked-perpendicular/${facetId}/${source.crease}/${throughId}`,
        score: Math.max(0, distance(apply(map, landing), target) - 2), value}];
    });
  }

  function projection(event: GestureInput): Draft | undefined {
    observation = {proximity: 0};
    const map = transform();
    if (!drag || drag.tapOnly || drag.longPress || !map || distance(drag.start, event.point) < drag.minimum) return;
    const target = add(event.point, drag.grabOffset);
    const {anchor} = drag;
    issue = undefined;
    const magnet = snapRadius(event.pointerType);
    const radius = event.pointerType === 'touch' ? 24 : 17;
    const snapping = callbacks.snapping() && !event.altKey;
    const openings = snapping && !pin ? openingCandidates(drag, target, map, magnet) : [];
    if (!snapping) drag.snapKey = undefined;
    if (tool === 'corner' && pin && !snapping) {
      issue = {reason: 'Enable snapping to continue the pinned fold.'};
      return;
    }
    const source = drag.source;
    const sameLine = source && nearestLine([source], target, map, radius);
    if (source && geometry && (!pin || sameLine)) {
      if (!pin) {
        if (!snapping) {
          issue = {source: source.line, reason: 'Enable snapping to align an edge or bring its grabbed point onto a mark.'};
          return;
        }
        const lines = geometry.grabLines().flatMap(reference => {
          if (reference === source || sameAxis(source.line, reference.line)) return [];
          const hit = nearestLine([reference], target, map, releaseRadius(magnet), geometry!.lineVisible);
          if (!hit) return [];
          const intent: LineFoldIntent = {kind: 'align-lines', source, moving: anchor, target: reference};
          const value = constrainedDraft(resolveLineFold(intent), anchor, target, map, reference.line, intent);
          if (!value) return [];
          const lineGap = distance(target, apply(map, hit.point));
          const landingGap = distance(target, apply(map, value.destination));
          // The reflected grab gives the expected drag direction. Allow more leeway along a line than toward a point.
          const score = Math.max(lineGap, landingGap / 2);
          return [{key: `line/${reference.facetId}/${lineKey(reference.line)}`, score, value}];
        });
        const points = pointDrafts(drag, target, map, geometry.marked, magnet);
        const snapped = previewSnap([...openings, ...lines, ...points], magnet, drag, target, map);
        if (snapped) issue = undefined;
        else issue ??= {source: source.line, reason: 'Drag toward a visible line or marked point.'};
        return snapped;
      }
      const lineIntent: LineFoldIntent = {kind: 'perpendicular', source, moving: anchor, pin};
      return constrainedDraft(resolveLineFold(lineIntent), anchor, target, map, source.line, lineIntent);
    }
    if (tool === 'corner' && pin && geometry) {
      const choices = selectSnap(geometry.lineCandidates(target, map, radius), radius, drag.snapKey);
      const nearby = choices[0];
      // At a junction, favor the grabbed line on a tie. A closer distinct target still uses O5.
      const reach = nearby ? Math.min(radius, nearby.score + 1) : radius;
      const pointSource = nearestSupportingLine(drag.pointSources, target, map, reach);
      if (pointSource) {
        const lineIntent: LineFoldIntent = {kind: 'perpendicular-point', source: pointSource, moving: anchor, pin};
        const draft = constrainedDraft(resolveLineFold(lineIntent), anchor, target, map, pointSource.line, lineIntent);
        const source = geometry.creaseReference(pointSource);
        const vertex = geometry.vertexReference(pin);
        return draft && source && vertex
          ? {...draft, capture: {kind: 'perpendicular-through', pin: vertex, source}} : draft;
      }
      if (!nearby) {
        drag.snapKey = undefined;
        issue = {reason: 'Drag toward a visible crease or edge while the pin stays fixed.'};
        return;
      }
      drag.snapKey = nearby.key;
      const fixed = pin;
      const primary = pinnedDraft(nearby.value, anchor, target, map, fixed);
      if (!primary) return;
      const alternatives = choices.slice(1).flatMap(({value}) => {
        if (sameAxis(nearby.value.line, value.line)) return [];
        const draft = pinnedDraft(value, anchor, target, map, fixed);
        return draft ? [draft] : [];
      });
      issue = undefined;
      return alternatives.length ? {...primary, alternatives} : primary;
    }
    const destination = apply(invert(map), target);
    if (tool === 'corner') {
      const fold = cornerFold(anchor, destination, map, drag.minimum);
      if (fold && geometry && snapping) {
        const {pointReference} = geometry;
        targets ??= geometry.snapPoints();
        const points = pointDrafts(drag, target, map, [...drag.hingeLandings, ...targets], magnet);
        const marked = markedDrafts(drag, target, map, magnet);
        const radius = event.pointerType === 'touch' ? 13 : event.pointerType === 'pen' ? 10 : 8;
        const creases = creasePairs(fold.line, geometry.creasePoints(), map, radius, anchor, target)
          .map(({key, score, value, solution}) => ({key, score: score * magnet / radius,
            value: {...solution!, tool, anchor, snapped: [], creaseSnapped: true, ...material(),
              capture: {kind: 'through-points', points: [pointReference(value.a), pointReference(value.b)]} as const}}));
        // A close aim declares a direct landing. At the outer edge of the hit band,
        // compare both constraints and let an already acquired axis hold through jitter.
        const candidates = points.some(({score}) => score <= magnet / 2) && !drag.snapKey?.startsWith('axis/')
          ? points : [...points, ...creases];
        const snapped = previewSnap([...openings, ...marked, ...candidates], magnet, drag, target, map);
        if (snapped) return snapped;
      }
      return fold && {...fold, tool, anchor, destination, snapped: [], capture: {kind: 'freehand'}, ...material()};
    }
    const raw = {a: drag.rawAnchor, b: destination};
    if (distance(raw.a, raw.b) <= EPS) return;
    if (snapping && geometry) {
      const {pointReference} = geometry;
      const {pairs, singles} = drawnMarkCandidates(raw, geometry.marked, map, magnet);
      const previews = (candidates: typeof pairs) => candidates.map(({key, score, value: line, points}) => ({key, score,
        value: {tool, line, anchor, destination, snapped: points.length === 1 ? points : [], creaseSnapped: points.length === 2,
          capture: {kind: 'through-points', points: points.map(point => pointReference(point))} as const,
          snapLabel: points.length === 1 ? 'Drawn crease through mark' : 'Drawn crease through two marks'}}));
      const matchingPair = pairs.some(({score}) => score <= magnet) || drag.snapKey?.startsWith('axis/');
      const draft = (matchingPair && previewSnap(previews(pairs), magnet, drag, target, map)) ||
        previewSnap(previews(singles), magnet, drag, target, map);
      if (draft) return draft;
      const first = snap(drag.start, map, event);
      const last = snap(target, map, event);
      const start = first ?? raw.a, end = last ?? raw.b;
      const points = [first, last].flatMap(point => point ? [pointReference(point)] : []);
      if (points.length && distance(start, end) > EPS) return {line: {a: start, b: end}, tool, anchor: start, destination: end,
        snapped: [], capture: {kind: 'through-points', points}};
    }
    return {line: raw, tool, anchor: raw.a, destination, snapped: [], capture: {kind: 'freehand'}};
  }

  function openingDrafts(anchor: Vec, probe: Vec, source: LineReference | undefined): Draft[] {
    const paper = geometry;
    const current = state;
    if (!paper || !current || tool !== 'corner' || pin || wholeStack) return [];
    const facetId = paper.exposedFacet(anchor);
    if (facetId === undefined || (source && source.facetId !== facetId) || !paper.sameSurface(anchor, probe)) return [];
    const selected = packet();
    return callbacks.openingMotions().flatMap(({foldAttempt, packet, line}) => {
      const ids = new Set(packet.facetIds);
      if (!ids.has(facetId) || (explicit && (!selected || selected.facetIds.length !== ids.size ||
          selected.facetIds.some(id => !ids.has(id))))) return [];
      const hinge = packetHingeAxis(current, packet);
      if (!hinge || !sameAxis(hinge, line) || Math.abs(signedDistance(line, anchor)) <= EPS) return [];
      const destination = apply(reflection(line), anchor);
      const obstruction = !paper.packetExposed(ids) ? 'covered' : !connected(ids, current) ? 'disconnected' : undefined;
      return [{tool, line, side: sideOf(line, anchor), anchor, destination, snapped: [destination], ...material(), packet,
        snapLabel: 'Open flap', opening: {foldAttempt, obstruction}}];
    });
  }

  function press(event: GesturePress) {
    if (drag || !geometry) return;
    const paper = geometry;
    const map = transform();
    if (!map) return;
    const start = event.point;
    const point = apply(invert(map), start);
    const touch = event.pointerType === 'touch';
    const grab = nearestPoint([
      ...paper.marked, ...paper.corners, ...(!exposedOnly && selection ? [selection.corner] : []),
    ].filter(candidate => !exposedOnly || paper.sameSurface(candidate, point)),
    start, map, CORNER_HIT_RADIUS);
    const anchor = tool === 'corner' ? grab ?? (pin && snap(start, map, event)) : undefined;
    const lineGrab = tool === 'corner' && !anchor
      ? nearestLine(paper.grabLines(), start, map, LINE_GRAB_RADIUS, (reference, candidate) =>
        !exposedOnly || (paper.lineVisible?.(reference, candidate) && paper.sameSurface(candidate, point)) === true)
      : undefined;
    if (exposedOnly && !anchor && !lineGrab) return;
    const edgePoint = callbacks.snapping() && !event.altKey ? geometry.snapLine(start, map, touch ? 18 : 13)?.point : undefined;
    if (tool === 'corner' && !anchor && !lineGrab && !edgePoint && !geometry.contains(point) &&
        !geometry.markOptions(start, map, touch ? 18 : MARK_HIT_RADIUS).length) return;
    const tapOnly = tool === 'corner' && !anchor && !lineGrab;
    const referencePoint = anchor ?? (tool === 'corner' ? snap(start, map, event) ?? edgePoint : undefined) ?? point;
    const selectedPoint = lineGrab?.point ?? referencePoint;
    if (tool === 'corner' && !tapOnly) chooseCorner(selectedPoint);
    const facetId = selection?.packets[0].facetIds[0];
    const pointSources = tool === 'corner' && pin && anchor && facetId !== undefined
      ? geometry.pointSources(anchor, facetId) : [];
    const {packet: selected, inferFrom} = material();
    const current = state;
    const hingeLandings = tool === 'corner' && current && anchor && !exposedOnly
      ? (inferFrom ?? (selected ? [selected] : [])).flatMap(packet => {
        const landing = packetHingeLanding(current, packet, anchor);
        return landing ? [landing] : [];
      })
      : [];
    drag = {
      id: event.id, start, anchor: selectedPoint, tapAnchor: referencePoint,
      rawAnchor: point,
      grabOffset: tool === 'corner' && (anchor || lineGrab) ? sub(apply(map, selectedPoint), start) : {x: 0, y: 0},
      minimum: touch ? 8 : 5,
      moved: false,
      tapOnly,
      hingeLandings,
      openings: tapOnly ? [] : openingDrafts(selectedPoint, point, lineGrab?.reference),
      source: lineGrab?.reference,
      pointSources,
    };
    if (tool === 'corner') {
      held = undefined;
      issue = undefined;
      offeredMarks = [];
      ghost = exposedOnly ? undefined : geometry.markOptions(start, map, snapRadius(event.pointerType), ghost)[0];
    }
    if (lineGrab) issue = {source: lineGrab.reference.line, reason: pin
      ? 'Drag along this line to fold it back through the pin.' : 'Drag this line toward another visible edge or crease.'};
    callbacks.show(held, tool === 'corner' ? anchor : undefined, issue);
    return drag;
  }

  function hold() {
    if (!drag || drag.moved || tool !== 'corner') return;
    drag.longPress = true;
    const {tapAnchor} = drag;
    chooseCorner(tapAnchor);
    const map = transform();
    const same = pin && map && distance(apply(map, pin), apply(map, tapAnchor)) <= CORNER_HIT_RADIUS;
    pin = same ? undefined : tapAnchor;
    confirmPin = false;
    lastTap = undefined;
    ghost = undefined;
    callbacks.show();
  }

  function noticeMovement(event: GestureInput) {
    if (drag && distance(drag.start, event.point) >= drag.minimum) {
      drag.moved = true;
      ghost = undefined;
    }
    return drag?.moved;
  }

  function move(event: GestureInput) {
    if (drag) {
      if (drag.longPress) return;
      callbacks.show(projection(event) ?? held, tool === 'corner' && !drag.tapOnly ? drag.anchor : undefined, issue);
    } else if (!exposedOnly && tool === 'corner' && event.pointerType !== 'touch') {
      const map = transform();
      if (map && geometry) {
        ghost = !held && !offeredMarks.length
          ? geometry.markOptions(event.point, map, snapRadius(event.pointerType), ghost)[0] : undefined;
        callbacks.show(held, nearestPoint(geometry.corners, event.point, map, CORNER_HIT_RADIUS), issue);
      }
    }
  }

  function finish(event: GesturePress) {
    if (!drag || event.id !== drag.id) return;
    if (drag.longPress) {
      release();
      return;
    }
    const wasTap = !drag.moved && distance(drag.start, event.point) < drag.minimum;
    const draft = projection(event);
    const anchor = drag.tapAnchor;
    release();
    if (tool === 'corner') {
      if (draft) {
        held = draft;
        callbacks.show(held);
        callbacks.commit(draft);
      } else {
        if (wasTap && !exposedOnly) {
          chooseCorner(anchor);
          cycle(event.time);
          const map = transform();
          if (map && geometry) {
            offeredMarks = geometry.markOptions(event.point, map, snapRadius(event.pointerType), ghost);
          }
          ghost = undefined;
        }
        callbacks.show(undefined, undefined, issue);
      }
      return;
    }
    if (draft) {
      held = draft;
    } else if (wasTap && held) {
      const map = transform();
      if (map) {
        const point = apply(invert(map), event.point);
        const offset = signedDistance(held.line, point);
        const pixelScale = Math.hypot(map.a, map.b);
        if (geometry?.contains(point) && Math.abs(offset) * pixelScale >= 5) {
          const alternatives = held.alternatives?.flatMap(option => {
            const side = signedDistance(option.line, point);
            return Math.abs(side) * pixelScale >= 5 ? [{...option, side: side > 0 ? 1 as const : -1 as const, packet: packet()}] : [];
          });
          held = {...held, side: offset > 0 ? 1 : -1, packet: packet(), alternatives};
        }
      }
    }
    callbacks.show(held);
  }

  function leave() {
    if (drag && (!drag.tapOnly || drag.longPress)) return;
    if (drag) release();
    ghost = undefined;
    callbacks.show(held, undefined, issue);
  }

  function cancelPointer(id: number) {
    if (drag?.id === id) {
      if (drag.tapOnly || drag.longPress) release();
      else cancel();
    }
  }

  return {
    press, hold, noticeMovement, move, finish, leave, cancelPointer,
    tracking: () => drag,
    snapObservation: () => observation,
    surfaceAt: (probe: Vec, reach: number, contactRadius: number, sensoryVersion: 1 | 2 = 2) =>
      geometry?.surfaceAt(probe, reach, contactRadius, sensoryVersion),
    setContext(next: PaperState | undefined, nextTool: Tool) {
      if (state === next && tool === nextTool) return;
      if (state !== next) {
        geometry = next && paperGeometry(next, exposedOnly);
        targets = undefined;
        wholeStack = false;
        explicit = false;
        chooseCorner(undefined);
        packetOptions.clear();
      }
      state = next;
      tool = nextTool;
      cancel();
    },
    cancel,
    selection: () => selection,
    hasExplicitPacket: () => explicit,
    pinned: () => pin,
    pinNeedsConfirmation: () => confirmPin,
    wholeStack: () => wholeStack,
    togglePin() {
      release();
      pin = pin ? undefined : selection?.corner;
      confirmPin = Boolean(pin);
      held = undefined;
      issue = undefined;
      callbacks.show();
    },
    canConfirm: (draft: Draft) => draft === held,
    packet,
    availableCorners: () => geometry?.corners ?? [],
    markedPoints: () => tool === 'corner' ? geometry?.marked ?? [] : [],
    grabLines: () => tool === 'corner' ? geometry?.grabLines() ?? [] : [],
    markOptions: () => offeredMarks,
    markGhost: () => ghost,
    corners: () => tool === 'corner' ? geometry?.corners ?? [] : [],
    selectCorner(corner: Vec | undefined) {
      release();
      chooseCorner(corner);
      explicit = Boolean(selection) || wholeStack;
      refreshHeld();
    },
    selectCount(count: number | 'all' | undefined) {
      if (typeof count === 'number' && !selection?.packets.some(choice => choice.facetIds.length === count)) return;
      release();
      wholeStack = count === 'all';
      explicit = count !== undefined;
      if (selection) selection = { ...selection, count: count ?? selection.packets[0].facetIds.length };
      lastTap = undefined;
      refreshHeld();
    },
  };
}
