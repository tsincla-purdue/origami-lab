import type { Move, PaperState } from './engine';
import type { Experiment } from './experiment';
import { CORNERS, ProofBudget, ProofGraph, project, squareVertices, type SquareCorner } from './proof-graph';

export interface VertexReference { readonly facetId: number; readonly corner: SquareCorner }
export interface CreaseReference { readonly facetId: number; readonly crease: number }

export type CapturedGeometry =
  | { readonly kind: 'freehand' }
  | { readonly kind: 'vertex-bisector'; readonly moving: VertexReference; readonly target: VertexReference }
  | { readonly kind: 'equilateral-o5'; readonly moving: VertexReference; readonly pin: VertexReference;
      readonly target: CreaseReference; readonly branch: 'above-pin' }
  | { readonly kind: 'perpendicular-through'; readonly pin: VertexReference; readonly source: CreaseReference };

export type GeometryEvidence = { readonly version: 1 } & (
  Extract<CapturedGeometry, {kind: 'freehand'}> |
  (Exclude<CapturedGeometry, {kind: 'freehand'}> & {
    readonly projection: { readonly axis: Move['line']; readonly side: Move['side'] };
  })
);

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

function covers(facet: Facet, point: XY) {
  const signed = facet.poly.map((p, i) => axisDistance(point, xy(p), delta(xy(facet.poly[(i + 1) % facet.poly.length]), xy(p))));
  return signed.every(d => d >= -projectionTolerance) || signed.every(d => d <= projectionTolerance);
}

function checkProjection(move: Move, evidence: Exclude<GeometryEvidence, {kind: 'freehand'}>,
  graph: ProofGraph, axis: string, moving: XY) {
  const projection = evidence.projection;
  assert(keys(projection, ['axis', 'side']) && Array.isArray(projection.axis) && projection.axis.length === 2 &&
    projection.axis.every((point, i) => Array.isArray(point) && point.length === 2 && exactCoordinates(point, move.line[i])) &&
    projection.side === move.side, 'Geometric projection does not match the recorded axis or side.');
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

/** Check symbolic evidence against a replayed history. No geometry solver or validator is used here. */
export function inspectGeometry(experiment: Experiment): readonly GeometryReport[] {
  const graph = new ProofGraph();
  for (const corner of CORNERS) graph.add(root(corner), {kind: 'vertex', corner});
  const centers = new Map<number, string>();
  const apices = new Map<number, string>();
  const active: number[] = [];
  let turned = false;
  let before = experiment.initial;

  function center(ref: CreaseReference) {
    assert(keys(ref, ['crease', 'facetId']) && Number.isSafeInteger(ref.crease) && Number.isSafeInteger(ref.facetId),
      'Invalid material crease ID.');
    const facet = facetFor(before, ref.facetId);
    const crease = before.creases[ref.crease];
    const proof = centers.get(ref.crease);
    assert(facet && identity(facet) && crease && proof, 'No certified center crease on the named stationary facet.');
    return {facet, crease, proof};
  }

  function check(move: Move, attempt: number) {
    const evidence = move.geometry;
    if (evidence === undefined) return report('unverified', 'No geometric reference was recorded.');
    assert(evidence?.version === 1, 'Unknown geometric evidence version.');
    const activeApex = !turned && active.length === 1 && apices.has(active[0]) ? active[0] : undefined;
    if (evidence.kind === 'freehand') {
      assert(keys(evidence, ['kind', 'version']) && !move.intent, 'Invalid freehand evidence.');
      return freehandReport(move, activeApex, graph);
    }
    const axis = axisId(attempt);
    const common = ['version', 'kind', 'projection'];
    if (evidence.kind === 'vertex-bisector') {
      assert(keys(evidence, [...common, 'moving', 'target']) && !move.intent && !turned && active.length === 0,
        'The vertex bisector needs two references on the flat sheet.');
      const moving = vertex(before, evidence.moving), target = vertex(before, evidence.target);
      assert(identity(moving.facet) && identity(target.facet), 'The named vertices are not in the flat frame.');
      graph.add(axis, {kind: 'bisector', from: root(evidence.moving.corner), to: root(evidence.target.corner)});
      checkProjection(move, evidence, graph, axis, moving.projected);
      return report('certified', 'Exact perpendicular bisector of the selected square vertices.', graph.dependencies(axis));
    }
    if (evidence.kind === 'equilateral-o5') {
      assert(keys(evidence, [...common, 'moving', 'pin', 'target', 'branch']) && !move.intent && !turned && active.length === 0,
        'The equilateral witness needs the flat sheet and its retained center crease.');
      const moving = vertex(before, evidence.moving), pin = vertex(before, evidence.pin);
      const {facet, crease, proof} = center(evidence.target);
      assert(identity(moving.facet) && identity(pin.facet) && covers(facet, xy(crease.a)) && covers(facet, xy(crease.b)),
        'The O5 references are not on the flat square.');
      const landing = landingId(attempt);
      graph.add(landing, {kind: 'equilateral-apex', pin: root(evidence.pin.corner), moving: root(evidence.moving.corner),
        target: proof, branch: evidence.branch});
      const [, y] = project(graph.point(landing));
      assert(Math.min(crease.a.y, crease.b.y) < y && y < Math.max(crease.a.y, crease.b.y),
        'The chosen branch is outside the source segment.');
      graph.add(axis, {kind: 'bisector', from: root(evidence.moving.corner), to: landing});
      checkProjection(move, evidence, graph, axis, moving.projected);
      apices.set(attempt, proof);
      return report('certified', 'Equilateral upper branch at (1/2, √3/2).',
        [...new Set([...graph.dependencies(axis), ...graph.dependencies(landing)])]);
    }
    assert(evidence.kind === 'perpendicular-through' && keys(evidence, [...common, 'pin', 'source']) &&
      activeApex !== undefined && move.intent?.kind === 'perpendicular-point',
    'A perpendicular certificate needs the placed equilateral apex and the selected line.');
    const pin = vertex(before, evidence.pin);
    const {facet, crease, proof} = center(evidence.source);
    const landing = landingId(activeApex);
    assert(evidence.pin.corner === 'B' && !identity(pin.facet) && close(pin.projected, project(graph.point(landing))) &&
      close(pin.projected, xy(move.intent.pin)) && proof === apices.get(activeApex),
    'The pin is not the proved apex on the recorded facet.');
    assert(move.intent.source.facetId === facet.id &&
      [move.intent.source.line.a, move.intent.source.line.b, move.intent.moving].every(point =>
        Math.abs(point.x - crease.a.x) <= projectionTolerance && covers(facet, xy(point)) &&
        point.y >= Math.min(crease.a.y, crease.b.y) - projectionTolerance &&
        point.y <= Math.max(crease.a.y, crease.b.y) + projectionTolerance),
    'The numerical grab does not belong to the recorded center segment.');
    graph.add(axis, {kind: 'perpendicular', point: landing, line: proof});
    checkProjection(move, evidence, graph, axis, xy(move.intent.moving));
    return report('certified', 'Horizontal through the certified apex at y = √3/2.', graph.dependencies(axis));
  }

  return experiment.attempts.map((entry, index) => {
    const attempt = index + 1;
    let result = report('unverified', 'This operation has no fold constraint.');
    if (!entry.operation) {
      try {
        result = check(entry.move, attempt);
      } catch (error) {
        result = report(error instanceof ProofBudget ? 'inconclusive' : 'invalid', (error as Error).message);
      }
      if (entry.validation.status === 'accepted') {
        if (result.status === 'certified' && entry.move.geometry?.kind === 'vertex-bisector' && graph.isCenter(axisId(attempt))) {
          const origin = [0.5, 0] as const, direction = [0, 1] as const;
          for (let i = before.creases.length; i < entry.state.creases.length; i++) {
            const {a, b} = entry.state.creases[i];
            if ([a, b].every(point => Math.abs(axisDistance(xy(point), origin, direction)) <= projectionTolerance)) {
              centers.set(i, axisId(attempt));
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
