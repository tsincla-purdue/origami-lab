import { apply, distance, type Line, type Vec } from '../../vendor/origamio/src/geometry';
import type { Move, PaperState } from './engine';
import { pointOnLineBranch, type CreaseReference, type GeometryEvidence, type SelectedLine, type SelectedPoint, type VertexReference } from './geometry-intent';
import { paperInView } from './paper-pose';
import { displayAxis, MaterialGeometry, vertexId as root, type MaterialAxis } from './material-geometry';
import { materialLine } from './material-points';
import type { Experiment } from './experiment';
import { CORNERS, ProofBudget, ProofGraph, ProofUnsupported, project, squareVertices } from './proof-graph';

export type { CapturedGeometry, CreaseReference, GeometryEvidence, VertexReference } from './geometry-intent';

export interface GeometryCheckOptions {
  /** Optional number of derived proof nodes to evaluate, excluding the square's four vertices. */
  readonly maxDerivedNodes?: number;
}

export interface GeometryReport {
  readonly status: 'certified' | 'conditional' | 'near-match' | 'unverified' | 'inconclusive' | 'invalid' | 'quarantined';
  readonly detail: string;
  readonly dependencies: readonly string[];
  readonly assumptions?: readonly string[];
}

const report = (status: GeometryReport['status'], detail: string, dependencies: readonly string[] = []): GeometryReport =>
  ({status, detail, dependencies});
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
  checkAxis(move, project(exact.point), project(exact.direction), moving);
}

function checkAxis(move: Move, origin: XY, direction: XY, moving?: XY) {
  const [a, b] = move.line;
  const actualDirection = delta(b, a);
  const extent = norm(actualDirection);
  assert(extent > projectionTolerance &&
    Math.abs(cross(actualDirection, direction)) <= projectionTolerance * extent * norm(direction) &&
    [a, b].every(point => Math.abs(axisDistance(point, origin, direction)) <= projectionTolerance),
    'The recorded axis is inconsistent with the exact constraint.');
  assert(!moving || move.side * axisDistance(moving, a, actualDirection) > projectionTolerance,
    'The recorded side does not move the selected source.');
}

function freehandReport(move: Move, activeApex: number | undefined, graph: ProofGraph, state: PaperState): GeometryReport {
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
  const [start, end] = move.line;
  const axis = delta(end, start);
  for (const facet of paperInView(state).facets) {
    for (const mark of state.marks ?? []) {
      if (!covers(facet, xy(mark.point), consistencyTolerance)) continue;
      const point = xy(apply(facet.transform, mark.point));
      if (Math.abs(axisDistance(point, start, axis)) > .01) continue;
      for (const [index, line] of state.creases.entries()) {
        if (!onSegment(xy(mark.point), line)) continue;
        const [x, y] = delta(xy(apply(facet.transform, line.b)), xy(apply(facet.transform, line.a)));
        const cosine = (axis[0] * x + axis[1] * y) / (norm(axis) * Math.hypot(x, y));
        if (Math.abs(cosine) <= .02) {
          return report('near-match', 'Freehand axis is near a perpendicular through a marked point.',
            [`step:${mark.id}:mark`, `crease:${index}`]);
        }
      }
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
    ...(material?.markId === undefined ? [] : ['markId']), ...(material?.edgeMidpoint === undefined ? [] : ['edgeMidpoint'])]) && Number.isSafeInteger(material.facetId) &&
    vector(material.point), 'Invalid material point reference.');
  const facet = facetFor(view, material.facetId);
  assert(facet && covers(facet, xy(material.point), consistencyTolerance) &&
    near(xy(apply(facet.transform, material.point)), xy(selected.point)),
    'The material point does not match its recorded placement.');
  if (material.corner !== undefined) {
    assert(CORNERS.includes(material.corner) && exactCoordinates(xy(material.point), squareVertices[material.corner]),
      'The point is not the named square vertex.');
  }
  if (material.edgeMidpoint !== undefined) {
    const edge = materialLine(view, {edge: material.edgeMidpoint});
    assert(edge && material.corner === undefined && material.markId === undefined &&
      exactCoordinates(xy(material.point), [(edge.a.x + edge.b.x) / 2, (edge.a.y + edge.b.y) / 2]),
      'The point is not the named material edge midpoint.');
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
function replayGeometry(experiment: Experiment, options: GeometryCheckOptions = {}) {
  const budget = options.maxDerivedNodes;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
    throw new RangeError('The derived proof node budget must be a nonnegative integer.');
  }
  const graph = budget === undefined ? new ProofGraph() : new ProofGraph(CORNERS.length + budget);
  for (const corner of CORNERS) graph.add(root(corner), {kind: 'vertex', corner});
  const material = new MaterialGeometry(graph);
  const limitedCreases = new Set<number>();
  let intrinsic: MaterialAxis | undefined;
  const apices = new Map<number, string>();
  const inconclusive = new Set<number>();
  const active: number[] = [];
  let turned = false;
  let before = experiment.initial;

  function certifyEquilateral(attempt: number, move: Move, moving: XY, crease: number) {
    const proof = material.line({crease});
    if (limitedCreases.has(crease)) return report('inconclusive', 'Checking the selected center crease ran out of proof budget.');
    if (!proof || graph.assumptions(proof).length || !graph.isCenter(proof)) return unsupported('The selected center crease has no exact proof.');
    const landing = landingId(attempt), axis = axisId(attempt);
    graph.add(landing, {kind: 'equilateral-apex', pin: root('A'), moving: root('B'), target: proof, branch: 'above-pin'});
    graph.add(axis, {kind: 'bisector', from: root('B'), to: landing});
    checkProjection(move, graph, axis, moving);
    apices.set(attempt, proof);
    intrinsic = {id: axis, facetId: before.facets[0].id};
    return report('certified', 'Equilateral upper branch at (1/2, √3/2).',
      [...new Set([...graph.dependencies(axis), ...graph.dependencies(landing)])]);
  }

  function deduction(detail: string, dependencies: readonly string[], ...ids: string[]): GeometryReport {
    const assumptions = [...new Set(ids.flatMap(id => graph.assumptions(id)))];
    return assumptions.length ? {...report('conditional', detail, dependencies), assumptions}
      : report('certified', detail, dependencies);
  }

  function inMaterialFrame(move: Move, axis: string, facetId: number, detail: string, moving?: XY) {
    const line = displayAxis(graph, axis, before, facetId);
    checkAxis(move, xy(line.a), delta(xy(line.b), xy(line.a)), moving);
    intrinsic = {id: axis, facetId};
    return deduction(detail, graph.dependencies(axis), axis);
  }

  function check(move: Move, attempt: number): GeometryReport {
    const evidence = move.geometry;
    if (evidence === undefined) return unsupported('No geometric reference was recorded.');
    assert(evidence?.version === 1, 'Unknown geometric evidence version.');
    const activeApex = !turned && active.length === 1 && apices.has(active[0]) ? active[0] : undefined;
    if (evidence.kind === 'freehand') {
      assert(keys(evidence, ['kind', 'version']) && !move.intent, 'Invalid freehand evidence.');
      return freehandReport(move, activeApex, graph, before);
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
        if (moving.facet.id !== target.facet.id) return unsupported('The selected vertices are on separate material placements.');
        graph.add(axis, {kind: 'bisector', from: root(evidence.moving.corner), to: root(evidence.target.corner)});
        return inMaterialFrame(move, axis, moving.facet.id, 'Exact perpendicular bisector of the selected square vertices.', moving.projected);
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
        const crease = evidence.target.crease;
        if (crease === undefined || evidence.moving.material?.facetId !== evidence.target.facetId ||
            evidence.pin.material?.facetId !== evidence.target.facetId) {
          return unsupported('The selected circle and line do not share a supported material placement.');
        }
        if (limitedCreases.has(crease)) return report('inconclusive', 'Checking the supporting crease exceeded the proof budget.');
        const target = material.line({crease}), fixedId = material.point(evidence.pin), movingId = material.point(evidence.moving);
        if (!target || !fixedId || !movingId) return unsupported('The selected point-on-line constraint has unproved operands.');
        const placement = displayAxis(graph, target, before, evidence.target.facetId);
        const actual = delta(xy(evidence.target.line.b), xy(evidence.target.line.a));
        const expected = delta(xy(placement.b), xy(placement.a));
        const agrees = actual[0] * expected[0] + actual[1] * expected[1] > 0;
        const branch = evidence.branch === 'at-foot' ? 0 : (evidence.branch === 'after-foot') === agrees ? 1 : -1;
        const landingNode = landingId(attempt);
        graph.add(landingNode, {kind: 'circle-line', moving: movingId, pin: fixedId, target, branch});
        const facet = facetFor(view, evidence.target.facetId)!;
        const [x, y] = project(graph.point(landingNode));
        assert(near(xy(apply(facet.transform, {x, y})), landing), 'The exact circle-line branch disagrees with the landing.');
        graph.add(axis, {kind: 'bisector', from: movingId, to: landingNode});
        const result = inMaterialFrame(move, axis, facet.id, 'Exact circle-line branch and perpendicular bisector.', moving);
        // Keep the previous apex diagnostic available for equivalent captures from the general solver.
        if (flat && fixedId === root('A') && movingId === root('B') && y > 0 && graph.isCenter(target) &&
            result.status === 'certified') {
          apices.set(attempt, target);
          return {...result, detail: 'Equilateral upper branch at (1/2, √3/2).',
            dependencies: [...new Set([...result.dependencies, ...graph.dependencies(landingNode)])]};
        }
        return result;
      }
      case 'point-to-point': {
        assert(keys(evidence, [...common, 'moving', 'target']) && !move.intent, 'Invalid point-to-point evidence.');
        selectedPoint(view, evidence.moving);
        selectedPoint(view, evidence.target);
        checkReflection(move, xy(evidence.moving.point), xy(evidence.target.point));
        const facetId = evidence.moving.material?.facetId;
        const from = material.point(evidence.moving), to = material.point(evidence.target);
        if (facetId === undefined || facetId !== evidence.target.material?.facetId || !from || !to) {
          return unsupported('The selected points do not share a supported material placement.');
        }
        graph.add(axis, {kind: 'bisector', from, to});
        return inMaterialFrame(move, axis, facetId, 'Exact perpendicular bisector of the selected points.', xy(evidence.moving.point));
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
        const [a, b] = evidence.points;
        const facetId = a.material?.facetId;
        const from = material.point(a), to = b && material.point(b);
        if (facetId === undefined || facetId !== b?.material?.facetId || !from || !to) {
          return unsupported('The acquired points do not define a supported material line.');
        }
        graph.add(axis, {kind: 'through', from, to});
        return inMaterialFrame(move, axis, facetId, 'Exact line through the two selected points.');
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
        if (intent.kind !== 'align-lines' && evidence.pin?.material?.facetId === intent.source.facetId &&
            evidence.source.crease !== undefined) {
          const point = material.point(evidence.pin), source = material.line({crease: evidence.source.crease});
          if (point && source) {
            graph.add(axis, {kind: 'perpendicular', point, line: source});
            return inMaterialFrame(move, axis, intent.source.facetId, 'Exact perpendicular through the selected pin.', xy(intent.moving));
          }
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
        const proof = material.line({crease: evidence.source.crease});
        if ((!turned && active.length === 1 && inconclusive.has(active[0])) || limitedCreases.has(evidence.source.crease)) {
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
        intrinsic = {id: axis, facetId: facet.id};
        return report('certified', 'Horizontal through the certified apex at y = √3/2.', graph.dependencies(axis));
      }
      case 'marked-perpendicular': {
        assert(keys(evidence, [...common, 'moving', 'through', 'source', 'landing']) && !move.intent &&
          vector(evidence.landing), 'Invalid marked perpendicular evidence.');
        selectedPoint(view, evidence.moving);
        selectedPoint(view, evidence.through);
        selectedLine(view, evidence.source);
        const p = evidence.moving.material, q = evidence.through.material;
        const {facetId, crease, line} = evidence.source;
        assert(p?.markId !== undefined && q?.markId !== undefined && p.markId !== q.markId &&
          p.facetId === facetId && q.facetId === facetId && crease !== undefined, 'The marks and source must share one material facet.');
        const moving = xy(evidence.moving.point), through = xy(evidence.through.point), landing = xy(evidence.landing);
        assert(onSegment(moving, line) && onSegment(through, line) &&
          near(landing, [2 * through[0] - moving[0], 2 * through[1] - moving[1]]),
          'The marks or reflected landing disagree with the selected crease.');
        checkReflection(move, moving, landing, through);
        const solved = material.perpendicular(before, p.markId, q.markId, crease, facetId);
        if (!solved) return report('inconclusive', 'The supporting crease or marked intersections have no available exact construction.');
        assert(near(xy(solved.landing), landing), 'The exact reflected landing disagrees with the recorded landing.');
        const [, throughId, source] = solved.dependencies;
        graph.add(axis, {kind: 'perpendicular', point: throughId, line: source});
        const result = inMaterialFrame(move, axis, facetId, 'The marked point is the exact midpoint of the grab and landing. The fold is perpendicular to the selected crease.', moving);
        return {...result, dependencies: solved.dependencies};
      }
      default:
        throw new Error('Unknown geometric constraint.');
    }
  }

  const reports = experiment.attempts.map((entry, index) => {
    const attempt = index + 1;
    let result = unsupported('This operation has no fold constraint.');
    intrinsic = undefined;
    try {
      if (entry.operation === 'mark' && entry.move.sources) {
        const id = material.mark(attempt, entry.move.sources, entry.move.point);
        result = id ? deduction('Exact intersection of the two selected material lines.', graph.dependencies(id), id)
          : report('inconclusive', 'A source line has no available exact evaluation.');
      } else if (!entry.operation) {
        const diagnostic = entry.geometryDiagnostic;
        result = diagnostic && entry.move.geometry === undefined
          ? report('quarantined', `The fold was saved. The ${diagnostic.kind} capture failed consistency checks. ${diagnostic.reason}`)
          : check(entry.move, attempt);
      }
    } catch (error) {
      result = report(error instanceof ProofBudget || error instanceof ProofUnsupported ? 'inconclusive' : 'invalid', (error as Error).message);
    }
    if (result.status === 'inconclusive') inconclusive.add(attempt);
    if (!entry.operation && entry.validation.status === 'accepted') {
      try {
        const assumptions = material.recordCreases(attempt, before, entry.state, intrinsic, entry.move.geometry?.kind === 'freehand');
        if (assumptions.length && result.status !== 'certified') {
          result = {...result, assumptions: [...(result.assumptions ?? []), ...assumptions]};
        }
      } catch (error) {
        if (!(error instanceof ProofBudget || error instanceof ProofUnsupported)) throw error;
        for (let i = before.creases.length; i < entry.state.creases.length; i++) limitedCreases.add(i);
      }
      active.push(attempt);
    } else if (entry.operation === 'unfold' && active.at(-1) === entry.move.foldAttempt) {
      active.pop();
    } else if (entry.operation === 'flip') {
      turned = true;
    }
    before = entry.state;
    return result;
  });
  return {reports, material};
}

const inspections = new WeakMap<Experiment, ReturnType<typeof replayGeometry>>();
function geometryContext(experiment: Experiment) {
  const cached = inspections.get(experiment);
  if (cached) return cached;
  const result = replayGeometry(experiment);
  inspections.set(experiment, result);
  return result;
}

export function inspectGeometry(experiment: Experiment, options?: GeometryCheckOptions): readonly GeometryReport[] {
  return (options === undefined ? geometryContext(experiment) : replayGeometry(experiment, options)).reports;
}

export function realizeMarkedPerpendicular(experiment: Experiment, moving: number, through: number, crease: number, facetId: number) {
  try {
    return geometryContext(experiment).material.perpendicular(experiment.final, moving, through, crease, facetId);
  } catch (error) {
    if (!(error instanceof ProofBudget || error instanceof ProofUnsupported)) throw error;
  }
}
