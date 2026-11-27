// Exercise the public export path. These snapshots are inputs to the independent Python oracle.
import {
  canUnfold, createExperiment, recordFlip, recordMark, recordMove, recordRemoveMark, recordUnfold,
  resolveLineFold, serializeExperiment, solveCreaseThroughPoints, solvePointOntoLine,
} from '../../dist/api/index.js';

const point = (x, y) => ({x, y});
const line = (x1, y1, x2, y2) => ({a: point(x1, y1), b: point(x2, y2)});
const move = ({a, b}, side, extra = {}) => ({line: [[a.x, a.y], [b.x, b.y]], side, ...extra});
const vertical = x => move(line(x, 0, x, 1), -1);
const horizontal = y => move(line(0, y, 1, y), -1);
const flat = createExperiment();
const fold = (experiment, proposal) => {
  const next = recordMove(experiment, proposal);
  const verdict = next.attempts.at(-1).validation;
  if (verdict.status !== 'accepted') throw new Error(`${proposal.label ?? JSON.stringify(proposal)}: ${verdict.code}`);
  return next;
};
const solutionMove = ({line, side}, extra) => move(line, side, extra);
const half = fold(flat, vertical(.5));
const foldedTwice = fold(half, horizontal(.5));
const dogEar = fold(flat, move(line(.5, 1, 1, .5), 1));
const reverse = recordFlip(half);
const scored = recordUnfold(half);
const horizontalScore = recordUnfold(fold(scored, horizontal(.63)));
const marked = recordMark(horizontalScore, point(.5, .63));
const markedTurned = recordFlip(marked);
const markedFolded = fold(markedTurned, vertical(.5));
const markedOpened = recordUnfold(recordFlip(markedFolded));

const bottom = {facetId: 0, line: line(0, 0, 1, 0)};
const left = {facetId: 0, line: line(0, 0, 0, 1)};
const o3 = {kind: 'align-lines', source: bottom, target: left, moving: point(.6, 0)};
const o4 = {kind: 'perpendicular-point', source: bottom, pin: point(.75, 1), moving: point(.2, 0)};
const construction = (e, intent) => fold(e, solutionMove(resolveLineFold(intent).solutions[0], {intent}));
function pointToLine(e, pin, moving, target) {
  const [solution] = solvePointOntoLine(pin, moving, target, true).solutions;
  return fold(e, solutionMove(solution, {label: 'Point onto line'}));
}
const goldenAxis = line(.25, 0, .25, 1);
const goldenPaper = recordUnfold(fold(flat, vertical(.25)));

const fixtures = {
  initial: flat,
  half,
  dogEar: fold(dogEar, vertical(.5)),
  lifo: recordUnfold(recordUnfold(foldedTwice)),
  doubleFlip: recordFlip(reverse),
  reverse: fold(reverse, {...vertical(.325), packet: {facetIds: [0]}}),
  marks: recordRemoveMark(markedOpened, marked.final.marks[0].id),
  o1: fold(flat, solutionMove(solveCreaseThroughPoints(point(0, 1), point(0, .5), point(1, 1)).solutions[0],
    {label: 'Crease through two points'})),
  o2: fold(flat, move(line(0, 0, 1, 1), -1, {label: 'Point drag'})),
  o3: construction(flat, o3),
  o4: construction(flat, o4),
  equilateral: pointToLine(scored, point(0, 0), point(1, 0), line(.5, 0, .5, 1)),
  golden: pointToLine(goldenPaper, point(.25, .25), point(.75, 0), goldenAxis),
  rejected: recordMove(half, vertical(2)),
  near: [1e-10, 2e-9, 5e-8, 2e-7, 1e-5].map(x => recordMove(flat, {...vertical(x), side: 1})),
  slivers: [1e-6, 3e-6, 2e-5].map(s => recordMove(flat, move(line(s, 0, 0, s), 1))),
};

// One physical upper-strip swing expressed in three frames, then reversed through its history.
const markedHalf = recordMark(half, point(.5, 0), [{edge: 0}, {crease: 0}]);
const turnedHalf = recordFlip(markedHalf);
fixtures.packetSymmetries = [-1, 0, 1].map(offset => {
  const x = 3 / 16 + offset / 1024;
  const packet = {facetIds: [1]};
  // The half-sheet spans [0, .5], so turnover maps the displayed x coordinate to .5 - x.
  return [
    fold(markedHalf, move(line(x, 0, x, 1), 1, {packet})),
    fold(markedHalf, move(line(x, 1, x, 0), -1, {packet})),
    fold(turnedHalf, move(line(.5 - x, 0, .5 - x, 1), -1, {packet, placement: 'bottom'})),
  ].map(experiment => recordUnfold(experiment));
});

let seed = 0x0a16;
function random() {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}

// Reverse the directed axis and side together. This must preserve material motion.
fixtures.seeded = Array.from({length: 32}, () => {
  let original = flat;
  let equivalent = flat;
  for (let i = 0; i < 7; i++) {
    const y = random();
    const axis = random() < .5 ? line(y, -1, y + .2 * (random() - .5), 2)
      : line(-1, y, 2, y + .2 * (random() - .5));
    const side = random() < .5 ? -1 : 1;
    original = recordMove(original, move(axis, side));
    equivalent = recordMove(equivalent, move({a: axis.b, b: axis.a}, -side));
    if (i === 2) {
      original = recordFlip(original);
      equivalent = recordFlip(equivalent);
    }
    if (i === 4 && canUnfold(original) && canUnfold(equivalent)) {
      original = recordUnfold(original);
      equivalent = recordUnfold(equivalent);
    }
  }
  return [original, equivalent];
});
const exported = value => Array.isArray(value) ? value.map(exported) : JSON.parse(serializeExperiment(value));
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(fixtures).map(([key, value]) => [key, exported(value)]))));
