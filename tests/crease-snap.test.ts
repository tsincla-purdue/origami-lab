import { describe, expect, it } from 'vitest';
import { perpendicularBisector, type Vec } from '../vendor/origamio/src/geometry';
import { createExperiment, recordMove, recordUnfold } from '../src/lab';
import { paperGeometry } from '../src/playground/geometry';
import { creasePairs } from '../src/playground/crease-snap';
import { lineKey, selectSnap } from '../src/playground/snap-selection';

const moving = {x: 0, y: 0};
const edgePoints = (y: number) => [{x: 0, y}, {x: 1, y}] as const;
const match = (y: number, points: readonly Vec[], pixelsPerUnit = 100, locked?: {a: Vec; b: Vec}) => {
  const destination = {x: 0, y: 2 * y};
  const screen = {a: pixelsPerUnit, b: 0, c: 0, d: -pixelsPerUnit, e: 25, f: 100};
  return selectSnap(creasePairs(perpendicularBisector(moving, destination), points, screen, 8, moving,
    {x: 25, y: 100 - destination.y * pixelsPerUnit}), 8, locked && `axis/${lineKey(locked)}`)[0]?.solution;
};

describe('two-point drag snapping', () => {
  it('keeps a lock beyond acquisition and exposes a nearby rival until deliberate pull-away', () => {
    const candidates = (a: number, b: number) => [
      {key: 'a', value: 'first mark', score: a}, {key: 'b', value: 'second mark', score: b},
    ];
    const choose = (a: number, b: number, locked?: string) => selectSnap(candidates(a, b), 10, locked).map(({key}) => key);
    expect(choose(4, 5)).toEqual(['a', 'b']);
    expect(choose(11, 3, 'a')).toEqual(['a', 'b']);
    expect(choose(16, 3, 'a')).toEqual(['b']);
    expect(choose(16, 12, 'a')).toEqual([]);
  });
  it('uses screen pixels for proximity and merges collinear reference pairs', () => {
    const points = [...edgePoints(.5), {x: .5, y: .5}];
    expect(match(.55, points)?.line).toEqual({a: points[0], b: points[1]});
    expect(match(.55, points)?.destination).toEqual({x: 0, y: 1});
    expect(match(.55, points, 200)).toBeUndefined();
  });

  it('ignores closely spaced pairs and lines that swing the landing too far', () => {
    expect(match(.5, [{x: 0, y: .5}, {x: .1, y: .5}])).toBeUndefined();
    expect(match(.5, [{x: .6, y: .46}, {x: 1, y: .54}])).toBeUndefined();
  });

  it('retains an acquired line until it leaves the release band', () => {
    const lower = edgePoints(.45);
    const upper = edgePoints(.55);
    const points = [...lower, ...upper];
    expect(match(.5, points)).toBeDefined();
    const first = match(.46, points)!;
    expect(first.line).toEqual({a: lower[0], b: lower[1]});
    expect(match(.52, points)?.line).toEqual({a: upper[0], b: upper[1]});
    for (const y of [.499, .522, .496, .526]) {
      expect(match(y, points, 100, first.line)?.line).toEqual(first.line);
    }
    expect(match(.585, points, 100, first.line)?.line).toEqual({a: upper[0], b: upper[1]});
  });

  it('finds an off-center intersection of retained crease segments and visible edge references', () => {
    let experiment = recordUnfold(recordMove(createExperiment(), {line: [[.27, 0], [.27, 1]], side: -1}));
    experiment = recordUnfold(recordMove(experiment, {line: [[0, .63], [1, .63]], side: -1}));
    const geometry = paperGeometry(experiment.final);
    expect(experiment.final.creases).toHaveLength(2);
    expect(geometry.creasePoints()).toContainEqual({x: 0, y: .5});
    expect(geometry.creasePoints()).toContainEqual({x: 1, y: 1});
    const crossings = geometry.creasePoints().filter(({x, y}) => Math.hypot(x - .27, y - .63) < 1e-12);
    expect(crossings).toHaveLength(1);
  });
});
