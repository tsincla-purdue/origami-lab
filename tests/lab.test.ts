import { describe, expect, it } from 'vitest';
import { area, determinant, distance, intersectConvex, orientCCW } from '../vendor/origamio/src/geometry';
import { currentPolygon } from '../vendor/origamio/src/paper';
import { tears } from '../vendor/origamio/src/rigid';
import {
  apply, createExperiment, ENGINE_REVISION, exportFold, importExperiment, initialState,
  PRESETS, propose, recordMove, serializeExperiment, stateAt, validate,
  type Move, type PaperState,
} from '../src/lab';

const half: Move = { line: [[0.5, 0], [0.5, 1]], side: -1 };
const turn: Move = { line: [[0, 0.5], [1, 0.5]], side: 1 };
const blocked: Move = {
  line: [[0.25, 0], [0.25, 1]], side: 1,
  layers: { bottom: 1 }, attached: true, placement: 'top',
};

function checkSheet(state: PaperState) {
  const {facets} = state;
  expect(tears(state)).toBe(0);
  expect(facets.reduce((sum, facet) => sum + area(facet.poly), 0)).toBeCloseTo(1, 9);
  expect(new Set(facets.map(facet => facet.id)).size).toBe(facets.length);
  for (const [i, facet] of facets.entries()) {
    const folded = currentPolygon(facet);
    expect(Math.abs(determinant(facet.transform))).toBeCloseTo(1, 10);
    expect(area(folded)).toBeCloseTo(area(facet.poly), 10);
    for (let j = 0; j < facet.poly.length; j++) {
      for (let k = j + 1; k < facet.poly.length; k++) {
        expect(distance(folded[j], folded[k])).toBeCloseTo(distance(facet.poly[j], facet.poly[k]), 10);
      }
    }
    for (const other of facets.slice(i + 1)) {
      expect(area(intersectConvex(orientCCW(facet.poly), orientCCW(other.poly)))).toBeCloseTo(0, 9);
      if (area(intersectConvex(folded, currentPolygon(other))) > 1e-8) {
        expect(facet.z).not.toBe(other.z);
      }
    }
  }
}

describe('restricted folding API', () => {
  it('proposes a stable finite set and accepts each elementary move on a fresh square', () => {
    const state = initialState();
    expect(propose(state)).toEqual(propose(initialState()));
    expect(propose(state)).toHaveLength(8);
    for (const move of propose(state)) {
      const result = apply(state, move);
      expect(result.validation).toEqual(validate(state, move));
      expect(result.validation.status).toBe('accepted');
      checkSheet(result.state);
    }
    expect(state.foldCount).toBe(0);
    expect(Object.isFrozen(state.facets[0].poly[0])).toBe(true);
  });

  it('keeps the moving packet below when a whole stack is placed underneath', () => {
    const after = apply(initialState(), { ...half, placement: 'bottom' });
    expect(after.validation.status).toBe('accepted');
    expect(after.state.facets.map(facet => [facet.id, facet.z])).toEqual([[1, 0], [0, 1]]);
    checkSheet(after.state);
  });

  for (const preset of PRESETS) {
    it(`executes every step of ${preset.name} and preserves the sheet`, () => {
      let state = initialState();
      for (const move of preset.moves) {
        const result = apply(state, move);
        expect(result.validation.status, result.validation.reason).toBe('accepted');
        state = result.state;
        checkSheet(state);
      }
      expect(state.foldCount).toBe(preset.moves.length);
    });
  }

  it('rejects a fixed cover threaded through a closing hinge even with attachment enabled', () => {
    const state = apply(initialState(), half).state;
    const result = apply(state, blocked);
    expect(result.validation).toMatchObject({status: 'rejected', code: 'blocked-hinge'});
    expect(result.state).toBe(state);
  });

  it('refuses no-ops, malformed moves, unsupported motions and unauthenticated states', () => {
    const state = initialState();
    expect(validate(state, { ...half, mystery: true }).status).toBe('rejected');
    expect(validate(state, { ...half, layers: { bottom: 1, top: 1 } }).status).toBe('rejected');
    expect(validate(state, { ...half, line: [[2, 0], [2, 1]] }).code).toBe('no-op');
    expect(validate(state, { ...half, line: [[-1, 0], [-1, 1]] }).code).toBe('no-stationary-paper');
    expect(apply(state, { ...half, angle: 60 }).state).toBe(state);
    expect(validate(state, { ...half, also: [turn] }).status).toBe('unverified');
    expect(validate(state, { ...half, layers: { top: 1 } }).status).toBe('unverified');
    expect(validate(state, { ...half, line: [[5e-8, 0], [5e-8, 1]] }).code).toBe('near-axis');
    expect(validate(structuredClone(state), half).code).toBe('unknown-state');
  });

  it('tracks rank reversal for an already stacked packet', () => {
    const before = apply(initialState(), half).state;
    const after = apply(before, turn).state;
    expect(after.facets.map(f => f.id)).toEqual([0, 1, 3, 2]);
  });
});

describe('experiments', () => {
  it('replays accepted, rejected and unverified attempts and stores all snapshots', () => {
    const actions = [half, blocked, { ...half, angle: 45 }, turn];
    const original = actions.reduce(recordMove, createExperiment());
    expect(original.attempts.map(a => a.validation.status)).toEqual(['accepted', 'rejected', 'unverified', 'accepted']);
    expect(original.engine.revision).toBe(ENGINE_REVISION);
    expect(stateAt(original, 1)).toBe(stateAt(original, 2));
    expect(stateAt(original, 2)).toBe(stateAt(original, 3));
    expect(stateAt(original, 0).foldCount).toBe(0);
    expect(stateAt(original, 4)).toBe(original.final);
    const encoded = serializeExperiment(original);
    expect(serializeExperiment(importExperiment(encoded))).toBe(encoded);
    expect(serializeExperiment(actions.reduce(recordMove, createExperiment()))).toBe(encoded);
    expect(validate(importExperiment(encoded).final, propose(original.final)[0]).status).toBe('accepted');
  });

  it('rejects inconsistent states, statuses and numerical policies in imports', () => {
    const original = recordMove(createExperiment(), half);
    const altered = () => JSON.parse(serializeExperiment(original));
    const corruptSnapshot = altered();
    corruptSnapshot.attempts[0].state.facets[0].z = 99;
    expect(() => importExperiment(JSON.stringify(corruptSnapshot))).toThrow('attempt 1');
    const corruptFinal = altered();
    corruptFinal.final = corruptFinal.initial;
    expect(() => importExperiment(JSON.stringify(corruptFinal))).toThrow('final state');
    const corruptValidation = altered();
    corruptValidation.attempts[0].validation.status = 'accepted-ish';
    expect(() => importExperiment(JSON.stringify(corruptValidation))).toThrow('attempt 1');
    const corruptPolicy = altered();
    corruptPolicy.numerics.auditDistance *= 10;
    expect(() => importExperiment(JSON.stringify(corruptPolicy))).toThrow('numerical policy');
  });
});

describe('FOLD interoperability', () => {
  it('preserves material vertices, winding-relative orders and matching frame indices', () => {
    const state = apply(initialState(), half).state;
    const data = exportFold(state);
    expect(data.frame_classes).toEqual(['creasePattern']);
    expect(data.vertices_coords).toHaveLength(6);
    expect(data.edges_assignment.filter(a => a === 'V')).toHaveLength(1);
    expect(data.faces_vertices).toHaveLength(2);
    if (!('file_frames' in data)) throw new Error('Missing folded frame');
    const folded = data.file_frames![0];
    expect(folded.frame_parent).toBe(0);
    expect(folded.faceOrders).toEqual([[0, 1, 1]]);
    expect(new Set(folded.vertices_coords.map(p => p.join(','))).size).toBe(4);
    expect(exportFold(state, 'foldedForm').frame_classes).toEqual(['foldedForm']);
  });

  it('subdivides an existing seam when only one of its neighboring facets splits', () => {
    const shallow: Move = { line: [[0.2, 0], [0.2, 1]], side: 1 };
    const middle: Move = { line: [[0, 0.5], [1, 0.5]], side: 1 };
    const before = [shallow, middle].reduce(recordMove, createExperiment());
    const diagonal: Move = { line: [[0.4, 0], [0.65, 0.5]], side: -1 };
    const after = recordMove(before, diagonal);
    expect(after.attempts[2].validation.status).toBe('accepted');
    const frame = exportFold(after.final, 'creasePattern');
    const incidences = frame.edges_vertices.map(([a, b]) => frame.faces_vertices.filter(face =>
      face.some((v, i) => (v === a && face[(i + 1) % face.length] === b) ||
        (v === b && face[(i + 1) % face.length] === a))).length);
    expect(incidences).toEqual(frame.edges_assignment.map(a => a === 'B' ? 1 : 2));
    for (const [a, b] of frame.edges_vertices.filter((_, i) => frame.edges_assignment[i] === 'B')) {
      const [x, y] = frame.vertices_coords[a];
      const [u, v] = frame.vertices_coords[b];
      expect((x === u && (x === 0 || x === 1)) || (y === v && (y === 0 || y === 1))).toBe(true);
    }
  });
});
