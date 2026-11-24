import { describe, expect, it } from 'vitest';
import { perpendicularBisector, sideOf, type Vec } from '../vendor/origamio/src/geometry';
import { tears } from '../vendor/origamio/src/rigid';
import { apply, cornerPackets, initialState, type PaperState } from '../src/lab';
import { foldMove } from '../src/playground/geometry';
import { interpretDraft } from '../src/playground/intent';
import type { Draft } from '../src/playground/gestures';

function dragDraft(state: PaperState, anchor: Vec, destination: Vec): Draft {
  const line = perpendicularBisector(anchor, destination);
  const local = cornerPackets(state, anchor);
  return {
    tool: 'corner', anchor, destination, line, side: sideOf(line, anchor), snapped: [],
    packet: local[0], inferFrom: local,
  };
}

function foldTo(state: PaperState, from: Vec, to: Vec) {
  const line = perpendicularBisector(from, to);
  const result = apply(state, foldMove(line, sideOf(line, from), 'Setup fold'));
  expect(result.validation.status).toBe('accepted');
  return result.state;
}

describe('gesture material interpretations', () => {
  it('carries the attached dog-ear without changing the proposed crease', () => {
    const dog = foldTo(initialState(), {x: 1, y: 1}, {x: .5, y: .5});
    const draft = dragDraft(dog, {x: 1, y: 0}, {x: 0, y: 0});
    expect(draft.packet?.facetIds).toEqual([0]);
    const [choice] = interpretDraft(dog, draft);
    expect(choice.move.packet?.facetIds).toEqual([0, 1]);
    expect(choice.draft.line).toBe(draft.line);
    expect(choice.draft.side).toBe(draft.side);
    expect(choice.result.validation.status).toBe('accepted');
    expect(tears(choice.result.state)).toBe(0);
    const [explicit] = interpretDraft(dog, { ...draft, inferFrom: undefined });
    expect(explicit.move.packet?.facetIds).toEqual([0]);
    expect(explicit.result.validation.code).toBe('torn-hinge');
    expect(explicit.result.state).toBe(dog);
  });

  it('keeps the independent flap when the other moving material is disconnected from it', () => {
    const folded = foldTo(initialState(), {x: 1, y: 1}, {x: 0, y: 1});
    const draft = dragDraft(folded, {x: 0, y: 1}, {x: .4, y: 1});
    const choices = interpretDraft(folded, draft);
    expect(choices.map(({move}) => move.packet?.facetIds)).toEqual([[1]]);
    expect(choices[0].result.state.facets[0]).toEqual(folded.facets[0]);
  });

  it('orders two accepted, materially distinct packets from smallest to largest', () => {
    const half = foldTo(initialState(), {x: 0, y: 1}, {x: 1, y: 1});
    const folded = foldTo(half, {x: .5, y: 1}, {x: 1, y: 1});
    const choices = interpretDraft(folded, dragDraft(folded, {x: 1, y: 1}, {x: .5, y: 1}));
    expect(choices.map(({move}) => move.packet?.facetIds)).toEqual([[2, 3], [1, 2, 3]]);
    for (const {move, result} of choices) {
      expect(move.line[0][0]).toBe(.75);
      expect(result.validation.status).toBe('accepted');
      expect(tears(result.state)).toBe(0);
    }
    expect(choices[0].result.state.facets.find(({id}) => id === 1)?.transform)
      .not.toEqual(choices[1].result.state.facets.find(({id}) => id === 1)?.transform);
  });
});
