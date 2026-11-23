import { describe, expect, it } from 'vitest';
import { IDENTITY, apply as transformPoint, invert, reflection, type Vec } from '../vendor/origamio/src/geometry';
import {
  PAPER_STYLES, apply, createExperiment, exportFold, importExperiment, initialState, recordMove,
  serializeExperiment, setPaperStyle, stateAt, validate,
} from '../src/lab';
import { cornerFold, foldMove, nearestPoint, paperGeometry, paperToScreen } from '../src/playground/geometry';
import { foldedFacets, paperMarkup, styleSwatch } from '../src/playground/paper-view';

const screen = paperToScreen({ ...IDENTITY, a: 250, d: 250, e: 28, f: 73 }, 1);
const origin = {x: 0, y: 0};
const drag = (from: Vec, to: Vec) => {
  const proposed = cornerFold(from, to, screen, 5);
  if (!proposed) throw new Error('Expected a corner fold');
  return { ...proposed, move: foldMove(proposed.line, proposed.side, 'Corner drag') };
};

describe('fold gestures', () => {
  it('reflects the grabbed corner exactly onto the destination and moves its side', () => {
    const from = {x: 1, y: 1};
    const to = {x: .3, y: .2};
    const {line, side, move} = drag(from, to);
    const landed = transformPoint(reflection(line), from);
    expect(landed.x).toBeCloseTo(to.x, 12);
    expect(landed.y).toBeCloseTo(to.y, 12);
    expect(side).toBe(1);
    expect(validate(initialState(), move).status).toBe('accepted');
  });

  it('converts SVG screen positions and snaps by screen distance without rounding geometry', () => {
    const target = {x: 1 / 3, y: 2 / 3};
    const mapped = transformPoint(screen, target);
    expect(transformPoint(screen, origin)).toEqual({x: 28, y: 323});
    const back = transformPoint(invert(screen), mapped);
    expect(back.x).toBeCloseTo(target.x, 12);
    expect(back.y).toBeCloseTo(target.y, 12);
    expect(nearestPoint([target], {x: mapped.x + 10, y: mapped.y}, screen, 13)).toBe(target);
    expect(nearestPoint([target], {x: mapped.x + 14, y: mapped.y}, screen, 13)).toBeUndefined();
    const zoom = paperToScreen({ ...IDENTITY, a: 500, d: 500, e: 28, f: 73 }, 1);
    expect(nearestPoint([target], transformPoint(screen, target), zoom, 13)).toBeUndefined();
  });

  it('ignores coincident and very short drags', () => {
    expect(cornerFold(origin, origin, screen, 5)).toBeUndefined();
    expect(cornerFold(origin, {x: .01, y: 0}, screen, 5)).toBeUndefined();
  });

  it('deduplicates coincident corners and finds exact edge and bounds-center targets', () => {
    const half = apply(initialState(), drag(origin, {x: 1, y: 0}).move).state;
    const geometry = paperGeometry(half);
    expect(geometry.corners).toHaveLength(4);
    expect(geometry.corners.every(({x}) => x >= .5)).toBe(true);
    expect(geometry.snapPoints()).toContainEqual({x: .75, y: 0});
    expect(geometry.snapPoints()).toContainEqual({x: .75, y: .5});
  });

  it('uses the existing rejection and uncertainty checks for generated moves', () => {
    const state = initialState();
    const rejected = apply(state, drag(origin, {x: 2.4, y: 0}).move);
    const unverified = apply(state, drag(origin, {x: 2 - 1e-7, y: 0}).move);
    expect(rejected.validation).toMatchObject({status: 'rejected', code: 'no-stationary-paper'});
    expect(unverified.validation).toMatchObject({status: 'unverified', code: 'near-axis'});
    expect(rejected.state).toBe(state);
    expect(unverified.state).toBe(state);
  });

  it('replays a two-drag construction deterministically', () => {
    const moves = [drag(origin, {x: 1, y: 0}).move, drag({x: .5, y: 0}, {x: .5, y: 1}).move];
    const experiment = moves.reduce(recordMove, createExperiment('grid'));
    expect(experiment.attempts.map(({validation}) => validation.status)).toEqual(['accepted', 'accepted']);
    expect(importExperiment(serializeExperiment(experiment))).toEqual(experiment);
  });
});

describe('patterned paper', () => {
  it('renders an opaque front and back in stacking order with the original polygon and reflecting transform', () => {
    const folded = apply(initialState(), drag(origin, {x: 1, y: 0}).move).state;
    const markup = foldedFacets({ ...folded, facets: [...folded.facets].reverse() });
    const [stationary, moving] = folded.facets;
    const vertexString = (facet: typeof moving) => facet.poly.map(({x, y}) => `${x},${y}`).join(' ');
    expect(markup).toContain(`data-id="${stationary.id}" data-face="front" points="${vertexString(stationary)}"`);
    expect(markup).toContain(`data-id="${moving.id}" data-face="back" points="${vertexString(moving)}" transform="matrix(-1 0 0 1 1 0)" fill="url(#paper-back)"`);
    expect(markup.indexOf('data-face="front"')).toBeLessThan(markup.indexOf('data-face="back"'));
    expect(paperMarkup(folded, 'checker', false)).toContain('id="paper-back" patternUnits="userSpaceOnUse" width="0.125"');
    expect(paperMarkup(folded, 'stripes', true)).toContain('class="crease"');
  });

  it('defines all eight swatches with independent paint IDs', () => {
    expect(PAPER_STYLES).toHaveLength(8);
    for (const {id} of PAPER_STYLES) {
      expect(styleSwatch(id)).toContain(`fill="url(#swatch-${id}-front)"`);
    }
  });

  it('stores appearance without changing history, snapshots or FOLD export', () => {
    const original = recordMove(createExperiment(), drag(origin, {x: 1, y: 0}).move);
    const styled = setPaperStyle(original, 'stripes');
    expect(styled.attempts).toBe(original.attempts);
    expect(stateAt(styled, 0)).toBe(original.initial);
    expect(exportFold(styled.final)).toEqual(exportFold(original.final));
    expect(importExperiment(serializeExperiment(styled))).toEqual(styled);
  });

  it('imports version-one experiments without appearance and rejects invalid style IDs', () => {
    const source = recordMove(createExperiment('waves'), drag(origin, {x: 1, y: 0}).move);
    const legacy = JSON.parse(serializeExperiment(source));
    delete legacy.appearance;
    expect(importExperiment(JSON.stringify(legacy))).toEqual(setPaperStyle(source, 'classic'));
    legacy.appearance = {paperStyle: 'unknown'};
    expect(() => importExperiment(JSON.stringify(legacy))).toThrow('Unknown paper style');
  });
});
