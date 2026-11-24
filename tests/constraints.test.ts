import { describe, expect, it } from 'vitest';
import { apply as mapPoint, distance, perpendicularBisector, reflection, sideOf, signedDistance, type Line, type Side } from '../vendor/origamio/src/geometry';
import { currentPolygon } from '../vendor/origamio/src/paper';
import { tears } from '../vendor/origamio/src/rigid';
import {
  canUnfold, cornerPackets, createExperiment, exportFold, importExperiment, recordMove, recordUnfold,
  serializeExperiment, solvePointOntoLine, stateAt, undoMove, validate, type Experiment, type Move,
} from '../src/lab';

const A = {x: 0, y: 0};
const B = {x: 1, y: 0};
const center = {a: {x: .5, y: 0}, b: {x: .5, y: 1}};
const outerLine = (x: number) => ({a: {x, y: -1}, b: {x, y: 1}});
const moveOn = ({a, b}: Line, side: Side): Move => ({line: [[a.x, a.y], [b.x, b.y]], side});
const half = moveOn(center, -1);

function checkReplay(experiment: Experiment) {
  const restored = importExperiment(serializeExperiment(experiment));
  expect(restored).toEqual(experiment);
  expect(stateAt(restored, restored.attempts.length)).toEqual(experiment.final);
  expect(undoMove(restored).final).toEqual(stateAt(experiment, experiment.attempts.length - 1));
}

describe('compound constructions', () => {
  it('carries the dog-eared flap with a whole-stack half-fold and reverses the moving layer order', () => {
    const tip = {x: 1, y: 1};
    const axis = perpendicularBisector(tip, {x: .5, y: .5});
    const dog = recordMove(createExperiment('stripes'), moveOn(axis, sideOf(axis, tip)));
    const packet = cornerPackets(dog.final, B)[0];
    expect(validate(dog.final, {...half, packet}).code).toBe('torn-hinge');
    const result = recordMove(dog, half);
    expect(result.attempts[1].validation.status).toBe('accepted');
    expect(tears(result.final)).toBe(0);
    expect(result.final.creases[0]).toBe(dog.final.creases[0]);
    const priorFlap = dog.final.facets.find(({id}) => id === 1)!;
    const flap = result.final.facets.find(({id}) => id === 1)!;
    expect(flap.poly).toBe(priorFlap.poly);
    const before = currentPolygon(priorFlap);
    const after = currentPolygon(flap);
    after.forEach((point, i) => {
      expect(distance(point, mapPoint(reflection(center), before[i]))).toBeLessThan(1e-12);
      expect(distance(point, after[(i + 1) % after.length])).toBeCloseTo(distance(before[i], before[(i + 1) % before.length]), 12);
    });
    expect(flap.z).toBeGreaterThan(result.final.facets[0].z);
    expect(flap.z).toBeLessThan(result.final.facets.at(-1)!.z);
    checkReplay(result);
  });

  it('reverses the half-fold while retaining the center crease in material coordinates and FOLD', () => {
    const folded = recordMove(createExperiment(), half);
    expect(canUnfold(folded)).toBe(true);
    const unfolded = recordUnfold(folded);
    expect(unfolded.attempts[1]).toMatchObject({operation: 'unfold', move: {foldAttempt: 1}});
    expect(unfolded.final.facets).toBe(folded.initial.facets);
    expect(unfolded.final.foldCount).toBe(0);
    expect(unfolded.final.creases).toEqual([center]);
    expect(canUnfold(unfolded)).toBe(false);
    expect(tears(unfolded.final)).toBe(0);
    const exported = exportFold(unfolded.final, 'creasePattern');
    const crease = exported.edges_vertices[exported.edges_assignment.indexOf('F')];
    expect(crease.map(index => exported.vertices_coords[index]).sort((a, b) => a[1] - b[1])).toEqual([[.5, 0], [.5, 1]]);
    expect(undoMove(unfolded)).toEqual(folded);
    expect(undoMove(folded).final.creases).toEqual([]);
    checkReplay(unfolded);
    const tampered = JSON.parse(serializeExperiment(unfolded));
    tampered.attempts[1].move.foldAttempt = 0;
    expect(() => importExperiment(JSON.stringify(tampered))).toThrow('Invalid unfold source');
  });

  it('folds the adjacent corner onto the retained center crease to make an equilateral triangle', () => {
    const flat = recordUnfold(recordMove(createExperiment(), half));
    const result = solvePointOntoLine(A, B, flat.final.creases[0], true);
    expect(result.status).toBe('solved');
    expect(result.solutions).toHaveLength(1);
    const [solution] = result.solutions;
    expect(solution.destination.x).toBe(.5);
    expect(solution.destination.y).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(Math.abs(signedDistance(solution.line, A))).toBeLessThan(1e-12);
    const folded = recordMove(flat, moveOn(solution.line, solution.side));
    expect(folded.attempts[2].validation.status).toBe('accepted');
    expect(tears(folded.final)).toBe(0);
    const flap = folded.final.facets.at(-1)!;
    const image = mapPoint(flap.transform, B);
    expect(distance(image, solution.destination)).toBeLessThan(1e-12);
    expect(distance(mapPoint(flap.transform, A), A)).toBeLessThan(1e-12);
    expect(distance(A, B)).toBe(1);
    expect(distance(A, image)).toBeCloseTo(1, 12);
    expect(distance(B, image)).toBeCloseTo(1, 12);
    expect(folded.final.creases).toContainEqual(center);
    expect(exportFold(folded.final).edges_assignment).toContain('F');
    checkReplay(folded);
  });
});

describe('point-to-line geometry', () => {
  it('finds zero, one or two destinations and distinguishes a finite segment', () => {
    expect(solvePointOntoLine(A, B, outerLine(2)).status).toBe('no-solution');
    expect(solvePointOntoLine(A, {x: 0, y: 1}, outerLine(1)).solutions.map(solution => solution.destination)).toEqual([B]);
    expect(solvePointOntoLine(A, B, outerLine(.5), true).solutions).toHaveLength(2);
    expect(solvePointOntoLine(A, B, center, true).solutions).toHaveLength(1);
    expect(solvePointOntoLine(A, B, center).solutions).toHaveLength(2);
  });

  it('reports a degenerate pin or target and near-tangency uncertainty', () => {
    expect(solvePointOntoLine(A, A, center).status).toBe('unverified');
    expect(solvePointOntoLine(A, B, {a: A, b: A}).status).toBe('unverified');
    expect(solvePointOntoLine(A, B, outerLine(1 + Number.EPSILON)).status).toBe('unverified');
  });
});
