import { describe, expect, it } from 'vitest';
import { apply as mapPoint, area, containsPoint, distance, intersectConvex, perpendicularBisector, sideOf } from '../vendor/origamio/src/geometry';
import { currentPolygon } from '../vendor/origamio/src/paper';
import { tears } from '../vendor/origamio/src/rigid';
import {
  apply, cornerPackets, createExperiment, importExperiment, initialState, recordMove, recordUnfold,
  serializeExperiment, stateAt, undoMove, validate, type Move, type PaperState,
} from '../src/lab';
import { packetHingeLanding } from '../src/lab/packets';

const half: Move = { line: [[.5, 0], [.5, 1]], side: 1 };
const quarter: Move = { line: [[0, .5], [1, .5]], side: -1 };
const corner = {x: 1, y: 1};
const rightHalf: Move = { ...half, side: -1 };
const newFlapCrease: Move = {line: [[.2, 0], [.2, 1]], side: 1, packet: {facetIds: [1]}};

function checkMotion(before: PaperState, after: PaperState, selected: readonly number[]) {
  expect(tears(after)).toBe(0);
  expect(after.facets.reduce((sum, facet) => sum + area(facet.poly), 0)).toBeCloseTo(1, 12);
  for (const original of before.facets) {
    const result = after.facets.find(facet => facet.id === original.id)!;
    expect(result.poly).toBe(original.poly);
    if (!selected.includes(original.id)) {
      expect(result.transform).toBe(original.transform);
    } else {
      expect(result.transform).not.toEqual(original.transform);
      const originalPoints = currentPolygon(original);
      const finalPoints = currentPolygon(result);
      for (let i = 0; i < originalPoints.length; i++) {
        for (let j = i + 1; j < originalPoints.length; j++) {
          expect(distance(finalPoints[i], finalPoints[j])).toBeCloseTo(distance(originalPoints[i], originalPoints[j]), 12);
        }
      }
    }
  }
}

describe('explicit material packets', () => {
  it.each([[.5, .5], [.31, .58], [.7, .29], [.39, .52]])('folds a triangular dog-ear onto (%f, %f)', (x, y) => {
    const initial = initialState();
    const destination = {x, y};
    const {a, b} = perpendicularBisector(corner, destination);
    const axis = {a, b};
    const packet = cornerPackets(initial, corner)[0];
    const trial = apply(initial, {line: [[a.x, a.y], [b.x, b.y]], side: sideOf(axis, corner), packet});
    expect(trial.validation.status).toBe('accepted');
    const [fixed, moving] = trial.state.facets;
    expect(fixed.transform).toBe(initial.facets[0].transform);
    expect(moving.poly).toHaveLength(3);
    expect(moving.z).toBeGreaterThan(fixed.z);
    expect(distance(mapPoint(moving.transform, corner), destination)).toBeLessThan(1e-12);
    expect(tears(trial.state)).toBe(0);
    expect(area(fixed.poly) + area(moving.poly)).toBeCloseTo(1, 12);
  });

  it('opens only the top flap of a half-fold, leaving the lower material fixed', () => {
    const folded = apply(initialState(), half);
    expect(folded.validation.status).toBe('accepted');
    const [top, all] = cornerPackets(folded.state, corner);
    expect(top.facetIds).toEqual([1]);
    expect(all.facetIds).toEqual([0, 1]);
    expect(packetHingeLanding(folded.state, top, corner)).toEqual({x: 0, y: 1});
    const result = apply(folded.state, { ...half, side: -1, packet: top });
    expect(result.validation.code).toBe('packet-fold');
    checkMotion(folded.state, result.state, top.facetIds);
    expect(result.state.facets.map(facet => facet.transform.a)).toEqual([1, 1]);
  });

  it('opens a connected two-layer packet from a four-layer sheet and replays the same material IDs', () => {
    const folded = [half, quarter].reduce(recordMove, createExperiment('stripes'));
    const choices = cornerPackets(folded.final, corner);
    expect(choices.map(choice => choice.facetIds.length)).toEqual([1, 2, 3, 4]);
    const packet = choices[1];
    expect(packet.facetIds).toEqual([2, 3]);
    expect(packetHingeLanding(folded.final, packet, corner)).toEqual({x: 1, y: 0});
    const experiment = recordMove(folded, { ...quarter, side: 1, packet });
    expect(experiment.attempts[2].validation.code).toBe('packet-fold');
    checkMotion(folded.final, experiment.final, packet.facetIds);
    expect(stateAt(experiment, 2)).toBe(folded.final);
    expect(experiment.final.facets.map(facet => facet.id)).toEqual([0, 1, 2, 3]);
    expect(importExperiment(serializeExperiment(experiment))).toEqual(experiment);
    const altered = JSON.parse(serializeExperiment(experiment));
    altered.attempts[2].move.packet.facetIds = [1, 2];
    expect(() => importExperiment(JSON.stringify(altered))).toThrow('attempt 3');
  });

  it('rejects a tearing packet and an upward swing from underneath stationary paper', () => {
    const folded = apply(initialState(), half).state;
    const torn = apply(folded, { ...quarter, packet: cornerPackets(folded, corner)[0] });
    expect(torn.validation.code).toBe('torn-hinge');
    expect(torn.state).toBe(folded);
    const buried = apply(folded, { ...half, side: -1, packet: {facetIds: [0]} });
    expect(buried.validation.code).toBe('buried-packet');
    expect(buried.state).toBe(folded);
    const under = apply(folded, { ...half, side: -1, packet: {facetIds: [0]}, placement: 'bottom' });
    expect(under.validation.code).toBe('packet-fold');
    checkMotion(folded, under.state, [0]);
  });

  it('certifies a fresh upper-ply split but leaves the same swing at an inherited flat seam unverified', () => {
    // Both legal histories retain the score at x = 3/4. Only the fold back retains its mesh seam.
    const score: Move = {line: [[.75, 0], [.75, 1]], side: -1};
    const scored = recordMove(createExperiment(), score);
    const foldedBack = recordMove(scored, {...score, side: 1, packet: {facetIds: [1]}});
    expect(foldedBack.attempts.at(-1)?.validation.code).toBe('packet-fold');
    const coarse = recordMove(recordUnfold(scored), rightHalf).final;
    const refined = recordMove(foldedBack, rightHalf).final;
    expect(refined.creases).toEqual(coarse.creases);
    expect(coarse.facets).toHaveLength(2);
    expect(refined.facets).toHaveLength(3);
    const [base, upper] = coarse.facets;
    const [otherBase, strip, rest] = refined.facets;
    expect(otherBase).toEqual(base);
    for (const part of [strip, rest]) {
      expect(part.transform).toEqual(upper.transform);
      expect(part.z).toBeGreaterThan(base.z);
      expect(part.poly.every(p => containsPoint(upper.poly, p))).toBe(true);
    }
    expect(upper.z).toBeGreaterThan(base.z);
    expect(area(intersectConvex(strip.poly, rest.poly))).toBe(0);
    expect(area(strip.poly) + area(rest.poly)).toBe(area(upper.poly));
    expect(strip.poly.every(p => p.x >= .75)).toBe(true);
    expect(rest.poly.every(p => p.x <= .75)).toBe(true);

    const swing: Move = {line: [[.25, 0], [.25, 1]], side: 1};
    const probe = {x: 0, y: 1};
    expect(cornerPackets(coarse, probe)[0].facetIds).toEqual([upper.id]);
    expect(cornerPackets(refined, probe)[0].facetIds).toEqual([strip.id]);
    expect(validate(coarse, {...swing, packet: {facetIds: [upper.id]}}))
      .toMatchObject({status: 'accepted', code: 'packet-fold'});
    const attempt = apply(refined, {...swing, packet: {facetIds: [strip.id]}});
    expect(attempt.validation).toMatchObject({status: 'unverified', code: 'hinge-cover'});
    expect(attempt.state).toBe(refined);
  });

  it('keeps non-flat and inside motions unverified and validates packet identities', () => {
    const folded = apply(initialState(), half).state;
    const move: Move = { ...half, side: -1, packet: cornerPackets(folded, corner)[0] };
    for (const option of [{angle: 45}, {placement: 'inside' as const}]) {
      const result = apply(folded, { ...move, ...option });
      expect(result.validation.status).toBe('unverified');
      expect(result.state).toBe(folded);
    }
    expect(validate(folded, {...move, packet: {facetIds: [98]}}).code).toBe('unknown-facet');
    expect(validate(folded, {...move, packet: {facetIds: [0, 0]}}).code).toBe('invalid-move');
  });

  it('rejects the blocked hinge when the same material is selected by identity', () => {
    const folded = apply(initialState(), { ...half, side: -1 }).state;
    const blocked = apply(folded, {line: [[.25, 0], [.25, 1]], side: 1, packet: {facetIds: [0]}});
    expect(blocked.validation).toMatchObject({status: 'rejected', code: 'blocked-hinge'});
    expect(blocked.state).toBe(folded);
  });

  it('certifies a new upper-flap crease with a stationary lower sheet beneath it', () => {
    const folded = apply(initialState(), rightHalf).state;
    const result = apply(folded, newFlapCrease);
    expect(result.validation.code).toBe('packet-fold');
    expect(result.state.facets).toHaveLength(3);
    expect(result.state.facets[0]).toEqual(folded.facets[0]);
    expect(result.state.facets[1].transform).toBe(folded.facets[1].transform);
    expect(result.state.creases).toHaveLength(2);
    expect(result.state.creases[1].a.x).toBeCloseTo(.8);
    expect(result.state.creases[1].b.x).toBeCloseTo(.8);
    expect(tears(result.state)).toBe(0);
    expect(result.state.facets.reduce((sum, facet) => sum + area(facet.poly), 0)).toBeCloseTo(1);

    const both = apply(folded, {...newFlapCrease, packet: {facetIds: [0, 1]}});
    expect(both.validation.status).toBe('accepted');
    expect(both.state.facets[0].poly).not.toEqual(result.state.facets[0].poly);
  });

  it('certifies the mirrored underside swing and still rejects a buried swing', () => {
    const folded = apply(initialState(), rightHalf).state;
    const lower: Move = {...newFlapCrease, packet: {facetIds: [0]}};
    const result = apply(folded, {...lower, placement: 'bottom'});
    expect(result.validation.code).toBe('packet-fold');
    expect(result.state.facets.at(-1)?.transform).toBe(folded.facets[1].transform);
    expect(apply(folded, lower).validation.code).toBe('blocked-hinge');
  });

  it('replays a saved legacy hinge-cover attempt and applies new decisions only to new moves', () => {
    const folded = recordMove(createExperiment('stripes'), rightHalf);
    const legacy = apply(folded.final, newFlapCrease, 1);
    expect(legacy.validation.code).toBe('hinge-cover');
    const archived = {
      ...folded, numerics: { ...folded.numerics, validatorVersion: 1 },
      attempts: [...folded.attempts, {move: newFlapCrease, ...legacy}],
    };
    const restored = importExperiment(JSON.stringify(archived));
    expect(restored.final).toBe(restored.attempts[0].state);
    expect(restored.attempts[1].validatorVersion).toBe(1);
    const continued = recordMove(restored, newFlapCrease);
    expect(continued.attempts[2].validation.code).toBe('packet-fold');
    expect(importExperiment(serializeExperiment(continued))).toEqual(continued);
    const accepted = recordMove(folded, newFlapCrease);
    expect(() => importExperiment(JSON.stringify({ ...accepted, numerics: archived.numerics }))).toThrow('attempt 2');
    expect(undoMove(continued)).toEqual(restored);
    expect(undoMove(restored)).toEqual(folded);
  });

  it('preserves the legacy result for rank-only partial attempts in stored experiments', () => {
    const start = recordMove(createExperiment(), half);
    const legacy = recordMove(start, { ...half, side: -1, layers: {top: 1} });
    expect(legacy.attempts[1].validation.code).toBe('unsupported-stack');
    expect(legacy.final).toBe(start.final);
    expect(importExperiment(serializeExperiment(legacy))).toEqual(legacy);
  });
});
