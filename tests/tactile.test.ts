import { expect, it } from 'vitest';
import {
  createExperiment, createTactileSession, importExperiment, recordMark, recordMove, recordUnfold, replayTactileTrajectory,
  serializeExperiment, type Experiment, type Move, type TactileHand,
} from '../src/lab';

const point = (x: number, y: number) => ({x, y});
const foldAndOpen = (experiment: Experiment, move: Move) => recordUnfold(recordMove(experiment, move));
const vertical = (x: number): Move => ({line: [[x, 0], [x, 1]], side: -1});
const horizontal = (y: number): Move => ({line: [[0, y], [1, y]], side: -1});
const crossed = () => foldAndOpen(foldAndOpen(createExperiment(), vertical(.27)), horizontal(.63));

/** Motor-only raster search. This controller sees neither the scene nor the intersection coordinate. */
function findAndMark(hand: TactileHand) {
  for (let row = 10; row <= 90; row++) {
    const y = row / 100;
    const start = hand.beginTrace(point(.1, y));
    const sweep = hand.move(point(.42, y));
    const hit = [...start.events, ...sweep.events].find(event =>
      event.kind === 'contact' && event.contact === 'intersection');
    if (hit) {
      expect(hand.move(hit.motor).contact).toBe('intersection');
      return {motor: hit.motor, feedback: hand.mark()};
    }
  }
  throw new Error('No tactile intersection in the raster.');
}

it('discovers a local intersection between coarse motor samples and marks its source geometry', () => {
  const session = createTactileSession(crossed());
  expect(session.hand.mark().validation?.code).toBe('no-intersection');
  expect(findAndMark(session.hand).feedback.validation?.status).toBe('accepted');
  const attempt = session.experiment().attempts.at(-1);
  expect(attempt?.operation).toBe('mark');
  if (attempt?.operation !== 'mark') throw new Error('Missing mark.');
  expect(attempt.move.sources).toEqual([{crease: 0}, {crease: 1}]);
  expect(attempt.move.point.x).toBeCloseTo(.27, 14);
  expect(attempt.move.point.y).toBeCloseTo(.63, 14);
  session.hand.move(point(.41, .7));
  expect(session.hand.mark().validation?.code).toBe('no-intersection');
});

it('does not feel a covered crease or mark, and finds the same material again after turning over', () => {
  const flat = createTactileSession(crossed());
  findAndMark(flat.hand);
  const folded = recordMove(flat.experiment(), vertical(.5));
  expect(folded.attempts.at(-1)?.validation.status).toBe('accepted');
  const {hand} = createTactileSession(folded);
  hand.beginTrace(point(.1, .42));
  expect(hand.move(point(.42, .42)).events).toEqual([]);
  expect(hand.move(point(.27, .42))).toMatchObject({contact: 'surface', proximity: 0});
  hand.beginTrace(point(.1, .63));
  const hidden = hand.move(point(.27, .63));
  expect(hidden.events).toEqual([]);
  expect(hidden.landmark).toBeUndefined();
  expect(hand.mark().validation?.code).toBe('no-intersection');

  expect(hand.flip().validation?.status).toBe('accepted');
  hand.beginTrace(point(.1, .42));
  expect(hand.move(point(.42, .42)).events).toContainEqual(expect.objectContaining({kind: 'contact', contact: 'crease'}));
  hand.beginTrace(point(.1, .63));
  expect(hand.move(point(.42, .63)).events).toContainEqual(expect.objectContaining({kind: 'contact', contact: 'mark'}));
});

it('distinguishes the sheet edge from a material crease meeting it', () => {
  const flat = foldAndOpen(createExperiment(), horizontal(.625));
  const session = createTactileSession(flat);
  const {hand} = session;
  expect(hand.beginTrace(point(0, .4)).contact).toBe('edge');
  expect(hand.move(point(0, .6)).contact).toBe('edge');
  expect(hand.move(point(0, .626)).contact).toBe('intersection');
  expect(hand.mark().validation?.status).toBe('accepted');
  expect(session.experiment().attempts.at(-1)?.move).toMatchObject({
    point: point(0, .625), sources: [{edge: 3}, {crease: 0}],
  });
});

it('feels an exposed crease without turning projected crossings across layers into intersections', () => {
  const left = foldAndOpen(createExperiment(), {line: [[0, .4], [.3, 0]], side: -1});
  const both = foldAndOpen(left, {line: [[.65, 0], [1, .2]], side: -1});
  const covered = recordMove(both, vertical(.5));
  expect(covered.final.creases).toHaveLength(3);
  const {hand} = createTactileSession(covered);
  hand.beginTrace(point(.21, .05));
  const sweep = hand.move(point(.32, .05));
  const contacts = sweep.events.flatMap(event => event.kind === 'contact' ? [event.contact] : []);
  expect(contacts).toContain('crease');
  expect(contacts).not.toContain('intersection');
});

it('acquires a precise corner snap once, holds through jitter and emits a discrete loss', () => {
  const session = createTactileSession(createExperiment());
  const {hand} = session;
  hand.beginDrag(point(1, 0));
  const far = hand.move(point(.1, .035));
  const warm = hand.move(point(.043, .01));
  const click = hand.move(point(.02, .006));
  expect(far.proximity).toBeLessThan(warm.proximity);
  expect(warm.proximity).toBeLessThan(click.proximity);
  expect([...warm.events, ...click.events].filter(event => event.kind === 'snap-acquired')).toHaveLength(1);
  for (const x of [.024, .029, .032, .028, .024]) {
    const frame = hand.move(point(x, .006));
    expect(frame.snapped).toBe(true);
    expect(frame.events).toEqual([]);
  }
  expect(hand.move(point(.11, .042)).events).toContainEqual(expect.objectContaining({kind: 'snap-lost'}));
  expect(hand.move(point(.02, .006)).snapped).toBe(true);
  expect(hand.release().validation?.status).toBe('accepted');
  const crease = session.experiment().final.creases[0];
  expect([crease.a, crease.b]).toEqual(expect.arrayContaining([point(.5, 0), point(.5, 1)]));
});

it('feels an exact snap separately from hinge resistance and preserves the refused paper', () => {
  const dog = recordMove(createExperiment(), {line: [[0, .02], [1, .82]], side: -1});
  const session = createTactileSession(dog);
  session.hand.beginDrag(point(1, .82));
  const aligned = session.hand.move(point(1, 1.16));
  expect(aligned.snapped).toBe(true);
  expect(aligned.events).toContainEqual(expect.objectContaining({kind: 'snap-acquired', constraint: 'axis'}));
  expect(aligned.events).toContainEqual(expect.objectContaining({kind: 'resistance', validation: {
    status: 'rejected', code: 'torn-hinge', reason: 'The fold would pull shared material edges apart.',
  }}));
  expect(session.hand.release().validation).toEqual(aligned.validation);
  expect(session.experiment()).toBe(dog);
});

it('retains the acquired line when a marked point becomes a plausible rival', () => {
  let flat = foldAndOpen(foldAndOpen(createExperiment(), horizontal(.375)), vertical(.625));
  flat = recordMark(flat, point(.625, .375), [{crease: 0}, {crease: 1}]);
  const session = createTactileSession(flat);
  const {hand} = session;
  hand.beginDrag(point(.59, 0));
  const line = hand.move(point(.59, .375));
  expect(line.events.filter(event => event.kind === 'snap-acquired')).toEqual([
    expect.objectContaining({kind: 'snap-acquired', constraint: 'line'}),
  ]);
  for (const x of [.6175, .616, .618, .6175]) {
    const near = hand.move(point(x, .375));
    expect(near.snapped).toBe(true);
    expect(near.events.filter(event => event.kind !== 'resistance')).toEqual([]);
    expect(near.validation?.code).toBe('competing-interpretations');
  }
  expect(hand.release().validation).toMatchObject({status: 'unverified', code: 'competing-interpretations'});
  expect(session.experiment()).toBe(flat);

  hand.beginDrag(point(.59, 0));
  hand.move(point(.59, .375));
  expect(hand.release().validation?.status).toBe('accepted');
  expect(session.experiment().attempts.at(-1)?.move).toMatchObject({intent: {kind: 'align-lines'}});
});

it('replays a bounded tactile log independently of the ordinary marked and folded experiment', () => {
  const initial = crossed();
  const session = createTactileSession(initial, {trajectoryLimit: 180});
  const {hand} = session;
  const discovery = findAndMark(hand);
  expect(discovery.feedback.validation?.status).toBe('accepted');
  hand.release();
  hand.beginDrag(point(1, 0));
  expect(hand.move(discovery.motor).snapped).toBe(true);
  expect(hand.release().validation?.status).toBe('accepted');
  expect(session.experiment().attempts.at(-1)?.move.label).toBe('Point onto mark');
  expect(hand.flip().validation?.status).toBe('accepted');

  const serialized = serializeExperiment(session.experiment());
  expect(importExperiment(serialized)).toEqual(session.experiment());
  const log = session.trajectory()!;
  expect(log.truncated).toBe(false);
  const replay = replayTactileTrajectory(initial, JSON.parse(JSON.stringify(log)));
  expect(replay.feedback).toEqual(log.entries.map(({feedback}) => feedback));
  expect(serializeExperiment(replay.experiment)).toBe(serialized);
  expect(serialized).not.toContain('snap-acquired');
  expect(Object.keys(hand).sort()).toEqual(['beginDrag', 'beginTrace', 'flip', 'mark', 'move', 'release', 'unfold']);

  const short = createTactileSession(initial, {trajectoryLimit: 1});
  short.hand.beginTrace(point(.4, .4));
  short.hand.move(point(.4, .7));
  expect(short.trajectory()).toMatchObject({truncated: true, entries: [{command: {kind: 'trace'}}]});
  expect(short.experiment()).toBe(initial);
});

it('feels a corner approaching along an edge even at saturated edge proximity', () => {
  const initial = createExperiment();
  const session = createTactileSession(initial);
  const hand = session.hand;
  expect(hand.beginTrace(point(.2, .2))).toMatchObject({contact: 'surface', proximity: 0});
  const samples = [.05, .025, .015, .005, 0].map(x => hand.move(point(x, 0)));
  expect(samples.map(f => f.contact)).toEqual(['edge', 'edge', 'edge', 'corner', 'corner']);
  expect(samples.map(f => f.proximity)).toEqual([1, 1, 1, 1, 1]);
  expect(samples[0].landmark).toBeUndefined();
  for (const [i, x] of [.025, .015, .005, 0].entries()) {
    const f = samples[i + 1];
    expect(f.landmark?.kind).toBe('corner');
    expect(f.landmark?.intensity).toBeCloseTo(1 - x / .03);
    expect(f.motor).toEqual(point(x, 0));
    expect(f.snapped).toBe(false);
  }
  expect(session.experiment()).toBe(initial);
});

it('feels an intersection on approach along a retained crease and a mark at coincidence', () => {
  const hand = createTactileSession(crossed()).hand;
  expect(hand.beginTrace(point(.27, .58)).contact).toBe('crease');
  const near = hand.move(point(.27, .61));
  expect(near.contact).toBe('crease');
  expect(near.landmark?.kind).toBe('intersection');
  expect(near.landmark?.intensity).toBeCloseTo(1 / 3);
  const at = hand.move(point(.27, .63));
  expect(at.contact).toBe('intersection');
  expect(at.landmark?.intensity).toBeCloseTo(1);
  expect(hand.mark()).toMatchObject({contact: 'mark', landmark: {kind: 'mark'}});
});

it('feels a displaced flap corner only from its exposed side', () => {
  const dog = recordMove(createExperiment(), {line: [[.6, 1], [1, .6]], side: 1});
  expect(dog.attempts[0].validation.status).toBe('accepted');
  const {hand} = createTactileSession(dog);
  expect(hand.beginTrace(point(.6, .6))).toMatchObject({contact: 'corner', landmark: {kind: 'corner'}});
  expect(hand.flip().validation?.status).toBe('accepted');
  const hidden = hand.beginTrace(point(.4, .6));
  expect(hidden.contact).toBe('surface');
  expect(hidden.landmark).toBeUndefined();
});

it('retains each stationary trace command with its current sensation until the finger lifts', () => {
  const initial = createExperiment();
  const session = createTactileSession(initial, {trajectoryLimit: 40});
  const at = point(.005, 0);
  const first = session.hand.beginTrace(at);
  expect(first.events).toEqual([{kind: 'contact', motor: at, contact: 'corner'}]);
  expect(first.landmark?.kind).toBe('corner');
  for (let i = 0; i < 38; i++) expect(session.hand.beginTrace({...at})).toEqual({...first, events: []});
  expect(session.trajectory()?.entries.map(e => e.command)).toEqual(Array(39).fill({kind: 'trace', at}));
  expect(session.hand.release().events).toEqual([{kind: 'contact-lost', motor: at}]);
  expect(session.hand.beginTrace(at)).toEqual(first);
  expect(session.experiment()).toBe(initial);
});

it('distinguishes sampling a path from lifting and placing at a different point', () => {
  const {hand} = createTactileSession(foldAndOpen(createExperiment(), vertical(.5)));
  const left = point(.3, 0), right = point(.7, 0);
  hand.beginTrace(left);
  expect(hand.beginTrace(right).events).toEqual([
    {kind: 'contact-lost', motor: left}, {kind: 'contact', motor: right, contact: 'edge'},
  ]);
  const sweep = hand.move(left);
  expect(sweep.events).toContainEqual(expect.objectContaining({kind: 'contact', contact: 'intersection'}));
  expect(sweep.contact).toBe('edge');
  expect(hand.beginTrace(left).events).toEqual([]);
  expect(hand.move(point(0, 0)).contact).toBe('corner');
  expect(hand.move(point(-.1, 0)).events).toContainEqual(expect.objectContaining({kind: 'contact-lost'}));
  expect(hand.move(point(0, 0)).events).toContainEqual(expect.objectContaining({kind: 'contact', contact: 'corner'}));
});
