import { describe, expect, it } from 'vitest';
import { createExperiment, importExperiment, inspectGeometry, realizeMarkedPerpendicular, recordMark, recordMove, recordUnfold, serializeExperiment, validate,
  solvePointOntoLine, type Experiment, type Move } from '../src/lab';
import { recordGestureMove } from '../src/lab/experiment';
import type { CapturedGeometry } from '../src/lab/proof-geometry';
import { ProofBudget, ProofGraph, ProofUnsupported, project } from '../src/lab/proof-graph';

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
    const replayed = importExperiment(serializeExperiment(experiment));
    expect(replayed.attempts[2]).toEqual(experiment.attempts[2]);
    expect(replayed.attempts[2].move).toMatchObject({geometry: {version: 1, ...upper}});
    expect(inspectGeometry(replayed)[2]).toMatchObject({status: 'unverified', detail: expect.stringContaining('no exact proof')});
  });

  it('imports 250 physical operations when the last proof exceeds the node budget', () => {
    const options = {maxDerivedNodes: 124};
    let experiment = createExperiment();
    for (let i = 0; i < 125; i++) {
      experiment = recordUnfold(recordGestureMove(experiment, center, bisector));
    }
    const text = serializeExperiment(experiment);
    const replayed = importExperiment(text, options);
    expect(serializeExperiment(replayed)).toBe(text);
    expect(replayed.attempts).toHaveLength(250);
    expect(replayed.attempts[248].validation.status).toBe('accepted');
    expect(replayed.attempts[248].move).toHaveProperty('geometry.kind', 'vertex-bisector');
    const reports = inspectGeometry(replayed, options);
    expect(reports[246].status).toBe('certified');
    expect(reports[248]).toMatchObject({status: 'inconclusive', detail: expect.stringContaining('budget')});
    expect(inspectGeometry(replayed)[248].status).toBe('certified');
  });

  it('retains inconclusive dependencies and still checks malformed evidence after budget exhaustion', () => {
    const options = {maxDerivedNodes: 0};
    const experiment = equilateral();
    const text = serializeExperiment(experiment);
    const replayed = importExperiment(text, options);
    expect(inspectGeometry(replayed, options).map(({status}) => status)).toEqual(['inconclusive', 'unverified', 'inconclusive']);
    expect(serializeExperiment(replayed)).toBe(text);

    const tampered = JSON.parse(text);
    tampered.attempts[2].move.geometry.branch = 'below-pin';
    expect(() => importExperiment(JSON.stringify(tampered), options)).toThrow(/Geometric evidence at attempt 3/);
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
    expect(() => recordMove(experiment, move)).toThrow(/inconsistent with the selected reflection/);
    const {geometry: _geometry, ...physicalMove} = move;
    const recorded = recordGestureMove(experiment, physicalMove, bisector);
    expect(recorded.attempts[0].validation.status).toBe('accepted');
    expect(recorded.attempts[0].move).toEqual(move);
    expect(inspectGeometry(recorded)[0].status).toBe('invalid');
    expect(() => importExperiment(serializeExperiment(recorded))).toThrow(/inconsistent with the selected reflection/);
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
    expect(graph.point(previous)[0]).toEqual({a: (2n ** 251n + 1n) / 3n, b: 0n, d: 2n ** 250n});
    expect(project(graph.point(previous))[0]).toBeCloseTo(2 / 3, 15);
    expect(() => graph.add('overflow', {kind: 'midpoint', from: 'a', to: previous})).toThrow(ProofBudget);
    expect(graph.size).toBe(252);
  }, 2000);

  it('checks reference types and order before evaluating a rule', () => {
    const graph = new ProofGraph();
    graph.add('a', {kind: 'vertex', corner: 'A'});
    expect(() => graph.add('line', {kind: 'bisector', from: 'a', to: 'later'})).toThrow('Missing geometric operand');
    graph.add('line', {kind: 'bisector', from: 'a', to: 'a'});
    expect(() => graph.axis('line')).toThrow('coincide');
    expect(graph.size).toBe(2);
  });
});


describe('compositional exact constructions', () => {
  it('constructs and reflects through a perpendicular at a non-dyadic intersection', () => {
    const graph = new ProofGraph();
    for (const corner of ['A', 'B', 'C', 'D'] as const) graph.add(corner, {kind: 'vertex', corner});
    graph.add('bottom', {kind: 'midpoint', from: 'A', to: 'B'});
    graph.add('right', {kind: 'midpoint', from: 'B', to: 'C'});
    graph.add('top', {kind: 'midpoint', from: 'C', to: 'D'});
    graph.add('first', {kind: 'through', from: 'bottom', to: 'right'});
    graph.add('second', {kind: 'through', from: 'top', to: 'B'});
    graph.add('crossing', {kind: 'intersection', first: 'first', second: 'second'});
    graph.add('perpendicular', {kind: 'perpendicular', point: 'crossing', line: 'first'});
    graph.add('reflection', {kind: 'reflection', point: 'bottom', line: 'perpendicular'});
    graph.add('middle', {kind: 'midpoint', from: 'reflection', to: 'bottom'});
    graph.add('bisector', {kind: 'bisector', from: 'reflection', to: 'bottom'});
    expect(graph.point('crossing')).toEqual([{a: 5n, b: 0n, d: 6n}, {a: 1n, b: 0n, d: 3n}]);
    expect(graph.contains('first', 'crossing')).toBe(true);
    expect(graph.contains('second', 'crossing')).toBe(true);
    expect(graph.perpendicular('first', 'perpendicular')).toBe(true);
    expect(graph.perpendicular('first', 'bisector')).toBe(true);
    expect(graph.samePoint('middle', 'crossing')).toBe(true);
    expect(graph.assumptions('bisector')).toEqual([]);
  });

  it('inherits freehand assumptions and refuses approximate collinearity as a proof', () => {
    const graph = new ProofGraph();
    for (const corner of ['A', 'B', 'C', 'D'] as const) graph.add(corner, {kind: 'vertex', corner});
    graph.add('freehand', {kind: 'parameter-line', from: [0, .001], to: [1, .51], assumption: 'stroke:1'});
    graph.add('left', {kind: 'through', from: 'A', to: 'D'});
    graph.add('right', {kind: 'through', from: 'B', to: 'C'});
    graph.add('P', {kind: 'intersection', first: 'freehand', second: 'left'});
    graph.add('Q', {kind: 'intersection', first: 'freehand', second: 'right'});
    graph.add('perpendicular', {kind: 'perpendicular', point: 'Q', line: 'freehand'});
    expect(graph.assumptions('perpendicular')).toEqual(['stroke:1']);
    expect(graph.perpendicular('freehand', 'perpendicular')).toBe(true);
    expect(project(graph.markedPerpendicular('P', 'Q', 'freehand').landing)[0]).toBe(2);
    expect(() => graph.markedPerpendicular('A', 'Q', 'freehand')).toThrow(ProofUnsupported);
  });

  it('realizes an exterior landing while leaving the physical refusal authoritative', () => {
    let experiment = recordUnfold(recordGestureMove(createExperiment(), center, bisector));
    const horizontal: Move = {line: [[0, .25], [1, .25]], side: -1};
    experiment = recordUnfold(recordGestureMove(experiment, horizontal, {kind: 'freehand'}));
    experiment = recordMark(experiment, {x: .5, y: 1}, [{edge: 2}, {crease: 0}]);
    experiment = recordMark(experiment, {x: .5, y: .25}, [{crease: 0}, {crease: 1}]);
    const realized = realizeMarkedPerpendicular(experiment, 5, 6, 0, 0);
    expect(realized?.landing).toEqual({x: .5, y: -.5});
    const {line, landing} = realized!;
    const [moving, through] = experiment.final.marks!.map(({id, point}) => ({point, material: {facetId: 0, point, markId: id}}));
    const move: Move = {line: [[line.a.x, line.a.y], [line.b.x, line.b.y]], side: line.b.x > line.a.x ? 1 : -1, angle: 90};
    const proposed = recordGestureMove(experiment, move, {kind: 'marked-perpendicular', moving, through, landing,
      source: {facetId: 0, crease: 0, line: experiment.final.creases[0]}});
    expect(proposed.attempts.at(-1)?.validation.status).toBe('unverified');
    expect(proposed.final).toEqual(experiment.final);
    const report = inspectGeometry(importExperiment(serializeExperiment(proposed))).at(-1);
    expect(report).toMatchObject({status: 'conditional', assumptions: ['step:3:crease:1:freehand']});
    const tampered = JSON.parse(serializeExperiment(proposed));
    tampered.attempts[5].move.sources = [{edge: 2}, {crease: 0}];
    expect(() => importExperiment(JSON.stringify(tampered))).toThrow(/mark does not match/);
  });

  it('reports unsupported circle-line roots without approximating an exact result', () => {
    const graph = new ProofGraph();
    graph.add('A', {kind: 'vertex', corner: 'A'});
    graph.add('B', {kind: 'vertex', corner: 'B'});
    graph.add('line', {kind: 'parameter-line', from: [0, .25], to: [1, .25], assumption: 'stroke:1'});
    graph.add('root', {kind: 'circle-line', pin: 'A', moving: 'B', target: 'line', branch: 1});
    expect(() => graph.point('root')).toThrow(ProofUnsupported);
  });
});
