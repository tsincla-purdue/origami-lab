import { describe, expect, it } from 'vitest';
import { apply, cross, dot, lineDirection, reflection, signedDistance, type Line } from '../vendor/origamio/src/geometry';
import { createExperiment, importExperiment, recordMove, resolveLineFold, serializeExperiment,
  solveLineOntoLine, solvePerpendicularThroughPoint, validate, type LineFoldIntent } from '../src/lab';
import { nearestLine, paperGeometry } from '../src/playground/geometry';

const bottom = {a: {x: 0, y: 0}, b: {x: 1, y: 0}};
const left = {a: {x: 0, y: 0}, b: {x: 0, y: 1}};
const right = {a: {x: 1, y: 1}, b: {x: 1, y: 0}};

describe('line alignment', () => {
  it('finds both supporting-line bisectors and verifies their reflections', () => {
    const {status, axes} = solveLineOntoLine(bottom, left);
    expect(status).toBe('solved');
    expect(axes).toHaveLength(2);
    expect(dot(lineDirection(axes[0]), lineDirection(axes[1]))).toBeCloseTo(0, 14);
    for (const axis of axes) {
      for (const p of [bottom.a, bottom.b, {x: .4, y: 0}]) {
        expect(signedDistance(left, apply(reflection(axis), p))).toBeCloseTo(0, 14);
      }
    }
  });

  it('solves distinct antiparallel directions and diagnoses coincidence and numerical uncertainty', () => {
    const midway = solveLineOntoLine(left, right);
    expect(midway.axes).toHaveLength(1);
    expect(midway.axes[0].a.x).toBe(.5);
    expect(midway.axes[0].b.x).toBe(.5);
    expect(solveLineOntoLine(left, {...left, b: {x: 0, y: 3}}).status).toBe('underdetermined');
    expect(solveLineOntoLine(bottom, {a: left.a, b: left.a}).status).toBe('unverified');
    expect(solveLineOntoLine(bottom, {a: {x: 0, y: 1}, b: {x: 1, y: 1 + Number.EPSILON}}).status).toBe('unverified');
  });

  it('preserves both finite interpretations when both fit and uses only the supported ray at square corners', () => {
    const reference = (line: Line) => ({line, facetId: 0});
    const square: LineFoldIntent = {kind: 'align-lines', source: reference(bottom), target: reference(left), moving: {x: .6, y: 0}};
    const [solution] = resolveLineFold(square).solutions;
    expect(resolveLineFold(square).solutions).toHaveLength(1);
    expect(solution.destination.x).toBeCloseTo(0, 14);
    expect(solution.destination.y).toBeCloseTo(.6, 14);
    const crossing = resolveLineFold({
      ...square, source: reference({a: {x: 0, y: .5}, b: {x: 1, y: .5}}),
      target: reference({a: {x: .5, y: 0}, b: {x: .5, y: 1}}), moving: {x: .7, y: .5},
    });
    expect(crossing.solutions).toHaveLength(2);
    expect(crossing.solutions[0].destination.y).not.toBeCloseTo(crossing.solutions[1].destination.y);

    const {a, b} = solution.line;
    const move = {intent: square, side: solution.side, line: [[a.x, a.y], [b.x, b.y]] as const};
    const experiment = recordMove(createExperiment(), move);
    expect(experiment.attempts[0].validation.status).toBe('accepted');
    expect(importExperiment(serializeExperiment(experiment))).toEqual(experiment);
    expect(validate(createExperiment().final, {...move, side: -solution.side}).code).toBe('invalid-move');
    expect(validate(createExperiment().final, {...move, intent: {...square, source: {...square.source, facetId: 99}}}).code).toBe('line-material');
  });

  it('identifies the exposed material when two folded line segments coincide', () => {
    const experiment = recordMove(createExperiment(), {line: [[.5, 0], [.5, 1]], side: 1});
    const [covered, exposed] = experiment.final.facets;
    const geometry = paperGeometry(experiment.final);
    const lines = geometry.grabLines();
    const screen = {a: 100, b: 0, c: 0, d: 100, e: 0, f: 0};
    expect(nearestLine(lines, {x: 100, y: 45}, screen, 8)?.reference.facetId).toBe(exposed.id);
    expect(lines.every(({facetId}) => facetId !== covered.id)).toBe(true);
    const point = {x: 1, y: .45};
    expect(geometry.pointSources(point, exposed.id)).toEqual([{
      facetId: exposed.id, line: expect.objectContaining({a: expect.objectContaining({x: 1}), b: expect.objectContaining({x: 1})}),
    }]);
    expect(geometry.pointSources(point, covered.id)).toEqual([]);
  });
});

describe('perpendicular through point', () => {
  it('gives an axis through the supplied point normal to an angled line', () => {
    const target = {a: {x: -.2, y: .2}, b: {x: .7, y: .9}};
    const pin = {x: .28, y: .61};
    const {status, axes} = solvePerpendicularThroughPoint(pin, target);
    expect(status).toBe('solved');
    expect(axes[0].a).toEqual(pin);
    expect(dot(lineDirection(axes[0]), lineDirection(target))).toBeCloseTo(0, 14);
    expect(Math.abs(cross(lineDirection(axes[0]), lineDirection(target)))).toBeCloseTo(1, 14);
    expect(solvePerpendicularThroughPoint({x: NaN, y: 0}, target).status).toBe('unverified');
    expect(solvePerpendicularThroughPoint(pin, {a: bottom.a, b: bottom.a}).status).toBe('unverified');
  });

  it('checks the finite reflected landing and keeps physical validation separate', () => {
    const source = {line: bottom, facetId: 0};
    const valid = resolveLineFold({kind: 'perpendicular', pin: {x: .5, y: 1}, source, moving: {x: .2, y: 0}});
    expect(valid.solutions[0].destination.x).toBeCloseTo(.8, 14);
    expect(resolveLineFold({kind: 'perpendicular', pin: {x: 2, y: 1}, source, moving: {x: .2, y: 0}}).status).toBe('no-solution');
    const axis = solvePerpendicularThroughPoint({x: 0, y: 1}, bottom).axes[0];
    expect(validate(createExperiment().final, {line: [[axis.a.x, axis.a.y], [axis.b.x, axis.b.y]], side: -1}).status).toBe('rejected');
  });

  it('reflects a grabbed point beyond its segment with an on-line or an off-line pin', () => {
    const source = {line: {a: {x: 0, y: 0}, b: {x: .4, y: .4}}, facetId: 0};
    const moving = {x: .2, y: .2};
    for (const pin of [{x: .5, y: .5}, {x: 0, y: 1}]) {
      const intent = {kind: 'perpendicular-point', source, moving, pin} as const;
      const result = resolveLineFold(intent);
      expect(result.status).toBe('solved');
      expect(result.solutions).toHaveLength(1);
      const [solution] = result.solutions;
      expect(solution.destination.x).toBeCloseTo(.8, 12);
      expect(solution.destination.y).toBeCloseTo(.8, 12);
      expect(signedDistance(solution.line, pin)).toBeCloseTo(0, 12);
      expect(dot(lineDirection(solution.line), lineDirection(source.line))).toBeCloseTo(0, 12);
      expect(resolveLineFold({...intent, kind: 'perpendicular'}).status).toBe('no-solution');
    }
  });

  it('excludes the stationary point, checks its source segment, and leaves physical rejection to the engine', () => {
    const intent = {
      kind: 'perpendicular-point', source: {line: bottom, facetId: 0},
      moving: {x: .2, y: 0}, pin: {x: .2, y: .7},
    } as const;
    expect(resolveLineFold(intent)).toMatchObject({status: 'no-solution', solutions: []});
    expect(resolveLineFold({...intent, moving: {x: 2, y: 0}}).status).toBe('unverified');
    expect(resolveLineFold({...intent, moving: {x: .2, y: .1}}).status).toBe('unverified');
    const boundary = {...intent, pin: {x: 1, y: 1}};
    const [{line: {a, b}, side}] = resolveLineFold(boundary).solutions;
    expect(validate(createExperiment().final, {
      intent: boundary, line: [[a.x, a.y], [b.x, b.y]], side,
    }).status).toBe('rejected');
  });
});
