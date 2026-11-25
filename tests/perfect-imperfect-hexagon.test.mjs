import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { importExperiment, inspectGeometry, serializeExperiment } from '../src/lab';

const text = readFileSync(new URL('./fixtures/perfect-imperfect-hexagon.json', import.meta.url), 'utf8');
const fixture = JSON.parse(text);

function replayFixture(source = text) {
  try {
    return importExperiment(source);
  } catch (error) {
    const record = JSON.parse(source);
    // Some errors report the attempt internally. Find the first failing prefix
    // even when a lower-level error only names the invalid operation.
    for (let step = 0; step <= record.attempts.length; step++) {
      const attempts = record.attempts.slice(0, step);
      const final = attempts.at(-1)?.state ?? record.initial;
      try {
        importExperiment(JSON.stringify({...record, attempts, final}));
      } catch (failure) {
        const detail = failure.message;
        const category = /engine revision or numerical policy/.test(detail) ? 'engine or numerical policy incompatibility'
          : /Geometric evidence|mark.*selected material lines/.test(detail) ? 'evidence discrepancy'
          : 'material replay mismatch';
        const where = step ? `step ${step} (${attempts.at(-1).move.label})` : 'initial state or format';
        throw new Error(`Hexagon fixture, ${where}, ${category}. ${detail}`, {cause: failure});
      }
    }
    throw new Error(`Hexagon fixture, final snapshot after step ${record.attempts.length}. ${error.message}`, {cause: error});
  }
}

function lineReference(ref) {
  if (!ref) return undefined;
  if ('crease' in ref || 'edge' in ref) {
    const name = 'crease' in ref ? `crease:${ref.crease}` : `square:edge:${ref.edge}`;
    return ref.facetId === undefined ? name : `${name} on facet:${ref.facetId}`;
  }
  return ref.facetId === undefined ? undefined : `recorded segment on facet:${ref.facetId}`;
}

function pointReference(ref) {
  if (!ref) return undefined;
  const material = ref.material ?? ref;
  const {facetId, markId, corner, edgeMidpoint} = material;
  const id = markId !== undefined ? `step:${markId}:mark` : corner !== undefined ? `square:${corner}`
    : edgeMidpoint !== undefined ? `square:midpoint:${edgeMidpoint}` : undefined;
  if (id) return facetId === undefined ? id : `${id} on facet:${facetId}`;
  const {x, y} = material.point ?? ref.point;
  const location = facetId === undefined ? 'displayed point' : `facet:${facetId} material point`;
  return `${location} (${x}, ${y}) with no construction ID`;
}

function recordedOperands({operation, move}) {
  if (operation === 'mark') return move.sources.map(lineReference);
  if (operation === 'unfold') return [`step:${move.foldAttempt} (reversed fold)`];
  const evidence = move.geometry;
  switch (evidence?.kind) {
    case 'through-points': return evidence.points.map(pointReference);
    case 'point-to-point':
    case 'vertex-bisector': return [pointReference(evidence.moving), pointReference(evidence.target)];
    case 'point-on-line': return [pointReference(evidence.moving), pointReference(evidence.pin), lineReference(evidence.target)];
    case 'line-fold': return [lineReference(evidence.source), lineReference(evidence.target), pointReference(evidence.pin)].filter(Boolean);
    case 'perpendicular-through': return [pointReference(evidence.pin), lineReference(evidence.source)];
    default: return [];
  }
}

test('the human hexagon replays every recorded material state and gesture', () => {
  const experiment = replayFixture();
  const saved = serializeExperiment(experiment);
  const {attempts, ...rest} = JSON.parse(saved);
  const {attempts: original, ...originalRest} = fixture;
  expect(rest).toEqual(originalRest);
  expect(attempts).toHaveLength(36);
  const counts = {};
  for (const [index, attempt] of attempts.entries()) {
    const step = `Step ${index + 1} (${original[index].move.label})`;
    expect(attempt, step).toEqual(original[index]);
    expect(attempt.validation.status, step).toBe('accepted');
    expect(attempt.move.geometry?.kind, step).not.toBe('freehand');
    expect(attempt.geometryDiagnostic, step).toBeUndefined();
    const operation = attempt.operation ?? 'fold';
    counts[operation] = (counts[operation] ?? 0) + 1;
  }
  expect(counts).toEqual({fold: 17, unfold: 10, mark: 6, flip: 3});
  expect(experiment.final.facets).toHaveLength(15);
  expect(serializeExperiment(importExperiment(saved))).toBe(saved);
});

test('the human hexagon reports checked relationships and missing proof dependencies', () => {
  const experiment = replayFixture();
  const marks = experiment.attempts.flatMap((entry, index) =>
    entry.operation === 'mark' ? [[index + 1, entry.move.sources]] : []);
  expect(marks).toEqual([
    [11, [{crease: 0}, {crease: 2}]], [12, [{crease: 1}, {crease: 4}]],
    [13, [{crease: 2}, {crease: 3}]], [24, [{crease: 6}, {crease: 8}]],
    [25, [{crease: 7}, {crease: 9}]], [26, [{crease: 0}, {crease: 1}]],
  ]);
  expect(experiment.final.marks.map(({id}) => id)).toEqual(marks.map(([step]) => step));
  const altered = structuredClone(fixture);
  altered.attempts[10].move.sources[1] = {crease: 1};
  expect(() => replayFixture(JSON.stringify(altered))).toThrow(/step 11 .*evidence discrepancy.*selected material lines/i);
  const reports = inspectGeometry(experiment);
  expect(reports).toHaveLength(36);
  for (const [index, report] of reports.entries()) {
    expect(['invalid', 'quarantined'], `Step ${index + 1}. ${report.detail}`).not.toContain(report.status);
  }
  expect(reports[0]).toMatchObject({status: 'certified', dependencies: ['square:midpoint:0', 'square:midpoint:2']});
  expect(reports[2]).toMatchObject({status: 'certified', dependencies: expect.arrayContaining(['step:3:landing'])});
  expect(reports[25]).toMatchObject({status: 'certified', dependencies: ['step:1:axis', 'step:3:axis']});

  if (process.env.ORIGAMI_REPORT_HEXAGON === '1') {
    const rows = reports.map(({status, detail, dependencies, assumptions}, index) => {
      const entry = experiment.attempts[index];
      return {step: index + 1, operation: entry.operation ?? 'fold', label: entry.move.label,
        status, detail, dependencies, assumptions: assumptions ?? [], operands: recordedOperands(entry)};
    });
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    const first = rows.find(row => (row.operation === 'fold' || row.operation === 'mark') &&
      row.status !== 'certified' && row.status !== 'conditional');
    console.log(JSON.stringify({
      counts,
      firstMissingProofDependency: first ? {
        step: first.step, detail: first.detail, recordedOperands: first.operands,
      } : null,
      steps: rows,
    }, null, 2));
  }
});
