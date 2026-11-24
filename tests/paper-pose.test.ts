import { describe, expect, it } from 'vitest';
import { apply as project, type Line, type Side } from '../vendor/origamio/src/geometry';
import { currentPolygon, isFlipped } from '../vendor/origamio/src/paper';
import { hinges, tears } from '../vendor/origamio/src/rigid';
import {
  activeFoldAttempts, canUnfold, cornerPackets, createExperiment, exportFold, importExperiment, paperInView, propose,
  recordFlip, recordMark, recordMove, recordUnfold, resolveLineFold, serializeExperiment, solveCreaseThroughPoints,
  solvePointOntoLine, undoMove, visibleMaterialMarks, type ConstraintSolution, type LineFoldIntent, type Move,
} from '../src/lab';

const vertical = (x: number): Move => ({line: [[x, 0], [x, 1]], side: -1});
const axisMove = ({a, b}: Line, side: Side): Move => ({line: [[a.x, a.y], [b.x, b.y]], side});

describe('paper turnover', () => {
  it('mirrors the dog-ear around its visible center without replacing any material', () => {
    const folded = recordMove(createExperiment('stripes'), {line: [[.5, 1], [1, .5]], side: 1});
    const turned = recordFlip(folded);
    const axisX = turned.final.pose!.materialAxisX;
    expect(turned.attempts[1]).toMatchObject({operation: 'flip', move: {axisX: .5}});
    expect(axisX).toBe(.5);
    expect(turned.final.facets).toBe(folded.final.facets);
    expect(turned.final.creases).toBe(folded.final.creases);
    expect(turned.final.foldCount).toBe(1);
    expect(activeFoldAttempts(turned)).toEqual([1]);
    const view = paperInView(turned.final);
    const opposite = [...folded.final.facets].reverse();
    for (const [i, facet] of view.facets.entries()) {
      expect(facet.id).toBe(opposite[i].id);
      expect(facet.poly).toBe(opposite[i].poly);
      expect(isFlipped(facet)).toBe(!isFlipped(opposite[i]));
      expect(currentPolygon(facet)).toEqual(currentPolygon(opposite[i]).map(({x, y}) => ({x: 1 - x, y})));
    }
    expect(tears(view)).toBe(0);
    expect(hinges(turned.final)).toEqual(hinges(folded.final));
    expect(recordFlip(turned).final).toEqual(folded.final);
    expect(undoMove(turned)).toEqual(folded);

    const original = exportFold(folded.final);
    const reflected = exportFold(turned.final);
    expect(reflected.vertices_coords).toEqual(original.vertices_coords);
    expect(reflected.edges_assignment).toEqual(original.edges_assignment);
    if (!('file_frames' in original) || !('file_frames' in reflected)) throw new Error('Expected folded frames.');
    expect(reflected.file_frames[0].vertices_coords).toEqual(
      original.file_frames[0].vertices_coords.map(([x, y]) => [1 - x, y]),
    );
    expect(reflected.file_frames[0].faceOrders).toEqual(original.file_frames[0].faceOrders);
  });

  it('retains the current pose when a prior fold is reversed and returns exactly in a translated frame', () => {
    const folded = recordMove(createExperiment(), vertical(.38));
    const reversed = recordFlip(folded);
    expect(canUnfold(reversed)).toBe(true);
    const opened = recordUnfold(reversed);
    expect(opened.final.facets).toBe(opened.initial.facets);
    expect(opened.final.pose).toBe(reversed.final.pose);
    expect(opened.final.creases).toBe(folded.final.creases);
    const shifted = recordFlip(opened);
    const offset = shifted.final.pose!.frontOffset;
    expect(shifted.final.pose?.reversed).toBe(false);
    expect(offset).not.toBe(0);
    expect(propose(shifted.final)[0].line[0][0]).toBeCloseTo(offset + .5, 12);
    const changed = recordMove(shifted, vertical(offset + .29));
    expect(changed.attempts.at(-1)?.validation.status).toBe('accepted');
    const twice = recordFlip(recordFlip(changed));
    expect(paperInView(twice.final)).toEqual(paperInView(changed.final));
    expect(canUnfold(twice)).toBe(true);
    expect(paperInView(undoMove(twice).final)).toEqual(paperInView(recordFlip(changed).final));
    expect(importExperiment(serializeExperiment(twice))).toEqual(twice);

    const tampered = JSON.parse(serializeExperiment(twice));
    tampered.attempts[1].move.axisX += .01;
    expect(() => importExperiment(JSON.stringify(tampered))).toThrow('mismatch');
  });

  it('picks the newly exposed material marks and packet when the stack order reverses', () => {
    const scored = recordUnfold(recordMove(createExperiment(), {
      line: [[0, .5], [1, .5]], side: -1,
    }));
    const marked = recordMark(recordMark(scored, {x: 0, y: .5}), {x: 1, y: .5});
    const folded = recordMove(marked, vertical(.5));
    const reversed = recordFlip(folded);
    expect(reversed.final.marks).toBe(marked.final.marks);
    expect(visibleMaterialMarks(folded.final).map(({point}) => point)).toEqual([{x: 1, y: .5}]);
    expect(visibleMaterialMarks(reversed.final)).toEqual([{id: 3, point: {x: 0, y: .5}, position: {x: .5, y: .5}}]);
    expect(cornerPackets(reversed.final, {x: .5, y: 1})[0].facetIds).toEqual([0]);
    const covered = paperInView(reversed.final).facets[0].id;
    const buried = recordMove(reversed, {...vertical(.32), packet: {facetIds: [covered]}});
    expect(buried.attempts.at(-1)?.validation.code).toMatch(/^(blocked-hinge|buried-packet)$/);
    expect(buried.final).toBe(reversed.final);
  });

  it('accepts geometric constraints resolved in the displayed coordinates and validates the new exposed side', () => {
    const flipped = recordFlip(createExperiment());
    const bottom = {a: {x: 0, y: 0}, b: {x: 1, y: 0}};
    const left = {a: {x: 0, y: 0}, b: {x: 0, y: 1}};
    const source = {line: bottom, facetId: 0};
    const moving = {x: .2, y: 0};
    const reference = {x: .5, y: 1};
    const intents: LineFoldIntent[] = [
      {kind: 'align-lines', source, target: {line: left, facetId: 0}, moving},
      {kind: 'perpendicular', source, moving, pin: reference},
    ];
    const cases: (ConstraintSolution & {intent?: LineFoldIntent})[] = [
      solveCreaseThroughPoints({x: 0, y: 1}, bottom.a, {x: 1, y: 1}).solutions[0],
      solvePointOntoLine({x: 1, y: 0}, {x: 0, y: 0}, {a: {x: .5, y: 0}, b: reference}, true).solutions[0],
      ...intents.map(intent => ({...resolveLineFold(intent).solutions[0], intent})),
    ];
    for (const solution of cases) {
      const move = {...axisMove(solution.line, solution.side), ...(solution.intent && {intent: solution.intent})};
      const folded = recordMove(flipped, move);
      expect(folded.attempts.at(-1)?.validation.status).toBe('accepted');
      expect(folded.final.pose).toBe(flipped.final.pose);
      expect(folded.final.facets[0].id).toBe(1);
      const view = paperInView(folded.final);
      expect(view.facets.at(-1)?.id).toBe(1);
      expect(tears(view)).toBe(0);
      expect(project(view.facets[0].transform, bottom.a)).toEqual({x: 1, y: 0});
      expect(importExperiment(serializeExperiment(folded))).toEqual(folded);
    }
  });
});
