import { describe, expect, it } from 'vitest';
import { area, distance, signedDistance, type Vec } from '../vendor/origamio/src/geometry';
import { currentPolygon, isFlipped } from '../vendor/origamio/src/paper';
import { tears } from '../vendor/origamio/src/rigid';
import {
  activeFoldAttempts, canUnfold, createExperiment, exportFold, importExperiment, materialIntersections,
  recordMark, recordMove, recordRemoveMark, recordUnfold, serializeExperiment, stateAt, undoMove,
  visibleMaterialMarks, type Experiment, type Move,
} from '../src/lab';
import { paperGeometry } from '../src/playground/geometry';

const vertical = (x: number): Move => ({line: [[x, 0], [x, 1]], side: -1});
const horizontal = (y: number): Move => ({line: [[0, y], [1, y]], side: -1});
const identity = {a: 1000, b: 0, c: 0, d: 1000, e: 0, f: 0};
const foldAndOpen = (experiment: Experiment, move: Move) => recordUnfold(recordMove(experiment, move));
const point = (x: number, y: number): Vec => ({x, y});
const replay = (experiment: Experiment) => importExperiment(serializeExperiment(experiment));

describe('sequential unfold', () => {
  it('reverses certified folds in LIFO order, retaining both material creases and the facet allocation', () => {
    const first = recordMove(createExperiment(), vertical(.5));
    const second = recordMove(first, horizontal(.5));
    expect(activeFoldAttempts(second)).toEqual([1, 2]);
    const ignored = recordMove(second, vertical(2));
    expect(ignored.attempts.at(-1)?.validation.status).toBe('rejected');
    expect(activeFoldAttempts(ignored)).toEqual([1, 2]);

    const openB = recordUnfold(ignored);
    expect(openB.attempts.at(-1)?.move).toMatchObject({foldAttempt: 2});
    expect(openB.final.facets).toBe(first.final.facets);
    expect(canUnfold(openB)).toBe(true);
    expect(activeFoldAttempts(openB)).toEqual([1]);
    const openA = recordUnfold(openB);
    expect(openA.attempts.at(-1)?.move).toMatchObject({foldAttempt: 1});
    expect(activeFoldAttempts(openA)).toEqual([]);
    expect(canUnfold(openA)).toBe(false);
    expect(openA.final.facets).toBe(openA.initial.facets);
    expect(openA.final.creases).toBe(second.final.creases);
    expect(openA.final.nextId).toBe(second.final.nextId);
    expect(openA.final.foldCount).toBe(0);
    expect(tears(openA.final)).toBe(0);
    const [facet] = openA.final.facets;
    expect(area(currentPolygon(facet))).toBe(1);
    expect(isFlipped(facet)).toBe(false);

    const restored = replay(openA);
    expect(restored).toEqual(openA);
    expect(serializeExperiment(restored)).toBe(serializeExperiment(openA));
    expect(undoMove(restored)).toEqual(openB);
    expect(recordUnfold(undoMove(restored))).toEqual(openA);
    const altered = JSON.parse(serializeExperiment(openA));
    altered.attempts[3].move.foldAttempt = 1;
    expect(() => replay(altered)).toThrow('Invalid unfold source');

    const pattern = exportFold(restored.final, 'creasePattern');
    const flat = pattern.edges_vertices.flatMap((edge, index) => pattern.edges_assignment[index] === 'F'
      ? [edge.map(id => point(...pattern.vertices_coords[id]))] : []);
    expect(flat).toHaveLength(4);
    for (const segment of flat) {
      expect(segment.some(p => distance(p, point(.5, .5)) <= 1e-12)).toBe(true);
      expect(second.final.creases.some(crease => segment.every(p => Math.abs(signedDistance(crease, p)) <= 1e-12))).toBe(true);
    }
  });
});

describe('material intersection marks', () => {
  it('stores exact crease and paper-edge intersections and moves them with material through nested folds', () => {
    const flat = foldAndOpen(foldAndOpen(createExperiment(), vertical(.27)), horizontal(.63));
    const crossing = materialIntersections(flat.final, point(.28, .62), .035);
    expect(crossing).toHaveLength(1);
    expect(distance(crossing[0], point(.27, .63))).toBeLessThan(1e-12);
    const edge = materialIntersections(flat.final, point(.01, .628), .03);
    expect(edge).toEqual([point(0, .63)]);
    const marked = recordMark(recordMark(flat, crossing[0]), edge[0]);
    expect(marked.final.marks?.map(({point}) => point)).toEqual([crossing[0], edge[0]]);
    expect(undoMove(undoMove(marked))).toEqual(flat);
    expect(() => recordMark(marked, point(.28, .62))).toThrow('Choose a crease intersection');
    expect(() => recordMark(marked, crossing[0])).toThrow('already marked');

    const half = recordMove(marked, {...vertical(.5), side: 1});
    const shown = visibleMaterialMarks(half.final);
    expect(shown).toHaveLength(2);
    expect(distance(shown[0].position, point(.73, .63))).toBeLessThan(1e-12);
    expect(shown[1].position).toEqual(point(1, .63));
    expect(paperGeometry(half.final).snapPoints()).toContainEqual(shown[0].position);
    expect(paperGeometry(half.final).creasePoints()).toContainEqual(shown[0].position);
    const removed = recordRemoveMark(half, shown[1].id);
    expect(undoMove(removed)).toEqual(half);
    const opened = recordUnfold(removed);
    expect(opened.final.marks).toEqual([marked.final.marks?.[0]]);
    expect(replay(opened)).toEqual(opened);
    expect(serializeExperiment(replay(opened))).toBe(serializeExperiment(opened));
    expect(stateAt(opened, 5).marks).toHaveLength(1);
    expect(stateAt(opened, 6).marks).toHaveLength(2);
    expect(() => recordRemoveMark(opened, shown[1].id)).toThrow('Choose an existing mark');
    const tampered = JSON.parse(serializeExperiment(opened));
    tampered.attempts[4].move.point.x += 1e-5;
    expect(() => replay(tampered)).toThrow('Choose a crease intersection');
  });

  it('separates coincident material layers and rejects a projected crossing between different layers', () => {
    const scored = foldAndOpen(createExperiment(), horizontal(.5));
    const folded = recordMove(scored, vertical(.5));
    const choices = paperGeometry(folded.final).markOptions(point(4, 503), identity, 15);
    expect(choices.map(({point, rank}) => ({point, rank}))).toEqual([
      {point: point(1, .5), rank: 2}, {point: point(0, .5), rank: 1},
    ]);
    const both = recordMark(recordMark(folded, choices[1].point), choices[0].point);
    expect(visibleMaterialMarks(both.final).map(mark => mark.point)).toEqual([point(1, .5)]);
    expect(visibleMaterialMarks(recordUnfold(both).final).map(mark => mark.point)).toEqual([point(0, .5), point(1, .5)]);

    const verticalScore = foldAndOpen(createExperiment(), vertical(.72));
    const dog = recordMove(verticalScore, {line: [[.5, 1], [1, .5]], side: 1});
    expect(dog.attempts.at(-1)?.validation.status).toBe('accepted');
    expect(paperGeometry(dog.final).markOptions(point(720, 500), identity, 15)).toEqual([]);
  });
});
