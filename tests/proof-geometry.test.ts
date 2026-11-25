import { describe, expect, it } from 'vitest';
import { createExperiment, importExperiment, inspectGeometry, recordMove, recordUnfold, serializeExperiment, validate,
  solvePointOntoLine, type Experiment, type Move } from '../src/lab';
import { recordGestureMove } from '../src/lab/experiment';
import type { CapturedGeometry } from '../src/lab/proof-geometry';
import { ProofBudget, ProofGraph, project } from '../src/lab/proof-graph';

const a = {x: 0, y: 0}, b = {x: 1, y: 0};
const fromA = {facetId: 0, corner: 'A'} as const;
const fromB = {facetId: 0, corner: 'B'} as const;
const center: Move = {line: [[.5, 0], [.5, 1]], side: -1};
const bisector = {kind: 'vertex-bisector', moving: fromB, target: fromA} as const;
const upper = {kind: 'equilateral-o5', moving: fromB, pin: fromA, target: {facetId: 0, crease: 0}, branch: 'above-pin'} as const;

function equilateral(first: CapturedGeometry = bisector): Experiment {
  const experiment = recordUnfold(recordGestureMove(createExperiment(), center, first));
  const [solution] = solvePointOntoLine(a, b, {a: {x: .5, y: 0}, b: {x: .5, y: 1}}, true).solutions;
  const {line: {a: start, b: end}, side} = solution;
  return recordGestureMove(experiment, {line: [[start.x, start.y], [end.x, end.y]], side}, upper);
}

describe('geometric evidence in experiment files', () => {
  it('recomputes the selected upper branch and its dependencies through v1 replay', () => {
    const experiment = equilateral();
    const text = serializeExperiment(experiment);
    const replayed = importExperiment(text);
    expect(serializeExperiment(replayed)).toBe(text);
    expect(inspectGeometry(replayed).map(({status}) => status)).toEqual(['certified', 'unverified', 'certified']);
    expect(inspectGeometry(replayed)[2].dependencies).toEqual(['square:B', 'step:3:landing', 'square:A', 'step:1:axis']);
    expect(replayed.attempts.at(-1)?.validation.status).toBe('accepted');
  });

  it('keeps legacy intentions unknown and gives the same material history', () => {
    const experiment = equilateral();
    const legacy = JSON.parse(serializeExperiment(experiment));
    for (const attempt of legacy.attempts) delete attempt.move.geometry;
    const replayed = importExperiment(JSON.stringify(legacy));
    expect(inspectGeometry(replayed).map(({status}) => status)).toEqual(['unverified', 'unverified', 'unverified']);
    expect(replayed.attempts.map(({state, validation}) => ({state, validation})))
      .toEqual(experiment.attempts.map(({state, validation}) => ({state, validation})));
  });

  it('does not infer a proof from a freehand center even if its coordinates match', () => {
    const experiment = equilateral({kind: 'freehand'});
    expect(experiment.final).toEqual(equilateral().final);
    expect(inspectGeometry(experiment).map(({status}) => status)).toEqual(['unverified', 'unverified', 'unverified']);
    expect(experiment.attempts[2].move).not.toHaveProperty('geometry');
  });

  it('can report a checked planar constraint independently of a refused move', () => {
    const experiment = recordGestureMove(createExperiment(), {...center, angle: 90}, bisector);
    expect(experiment.attempts[0].validation.status).not.toBe('accepted');
    expect(inspectGeometry(experiment)[0].status).toBe('certified');
    expect(experiment.final).toEqual(experiment.initial);
  });

  it.each([
    ['reference ID', (evidence: Record<string, unknown>) => { evidence.target = {facetId: 0, crease: 1}; }],
    ['branch', (evidence: Record<string, unknown>) => { evidence.branch = 'below-pin'; }],
    ['projection coordinate', (evidence: Record<string, unknown>) => {
      const projection = evidence.projection as {axis: number[][]};
      projection.axis[0][0] += .001;
    }],
    ['self-asserted certificate verdict', (evidence: Record<string, unknown>) => { evidence.status = 'certified'; }],
  ])('rejects a tampered %s even though the material snapshots match', (_, tamper) => {
    const file = JSON.parse(serializeExperiment(equilateral()));
    tamper(file.attempts[2].move.geometry);
    expect(() => importExperiment(JSON.stringify(file))).toThrow(/Geometric evidence at attempt 3/);
  });

  it('does not accept a supplied proof for a different recorded axis', () => {
    const move: Move = {line: [[.501, 0], [.501, 1]], side: -1,
      geometry: {version: 1, ...bisector, projection: {axis: [[.501, 0], [.501, 1]], side: -1}}};
    const experiment = createExperiment();
    expect(validate(experiment.initial, move).status).toBe('accepted');
    expect(() => recordMove(experiment, move)).toThrow(/inconsistent with the exact constraint/);
  });
});

describe('bounded exact graph', () => {
  it('shares dependencies for 250 operations and refuses a node beyond its budget', () => {
    const graph = new ProofGraph(252);
    graph.add('a', {kind: 'vertex', corner: 'A'});
    graph.add('b', {kind: 'vertex', corner: 'B'});
    let earlier = 'a';
    let previous = 'b';
    for (let i = 0; i < 250; i++) {
      const id = `mid:${i}`;
      graph.add(id, {kind: 'midpoint', from: earlier, to: previous});
      expect(graph.dependencies(id)).toEqual([earlier, previous]);
      earlier = previous;
      previous = id;
    }
    expect(graph.size).toBe(252);
    expect(graph.point(previous)[0]).toEqual({a: (2n ** 251n + 1n) / 3n, b: 0n, shift: 250});
    expect(project(graph.point(previous))).toEqual([2 / 3, 0]);
    expect(() => graph.add('overflow', {kind: 'midpoint', from: 'a', to: previous})).toThrow(ProofBudget);
    expect(graph.size).toBe(252);
  }, 2000);

  it('checks reference types and order before evaluating a rule', () => {
    const graph = new ProofGraph();
    graph.add('a', {kind: 'vertex', corner: 'A'});
    expect(() => graph.add('line', {kind: 'bisector', from: 'a', to: 'later'})).toThrow('a proved point');
    expect(() => graph.add('line', {kind: 'bisector', from: 'a', to: 'a'})).toThrow('coincide');
    expect(graph.size).toBe(1);
  });
});
