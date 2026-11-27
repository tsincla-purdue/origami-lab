import { expect, it } from 'vitest';
import type { Vec } from '../vendor/origamio/src/geometry';
import {
  activeFoldAttempts, canUnfold, createExperiment, createTactileSession, importExperiment, paperInView,
  recordFlip, recordMark, recordMove, recordUnfold, replayTactileTrajectory, serializeExperiment,
  type Experiment, type TactileHand,
} from '../src/lab';

const at = (x: number, y: number) => ({x, y});
const half = {line: [[.5, 0], [.5, 1]], side: -1} as const;

function fold(hand: TactileHand, from: Vec, to: Vec) {
  hand.beginDrag(from);
  hand.move(to);
  expect(hand.release().validation?.status).toBe('accepted');
}

function latest(experiment: Experiment) {
  return experiment.attempts.at(-1)!;
}

it('unfolds a corner fold and leaves a crease the hand can trace', () => {
  const initial = createExperiment();
  const session = createTactileSession(initial);
  const {hand} = session;
  fold(hand, at(1, 0), at(0, 0));
  const folded = session.experiment();
  const motor = at(.25, .4);
  expect(hand.beginTrace(motor).contact).toBe('surface');

  const opened = hand.unfold();
  expect(opened).toMatchObject({
    motor, proximity: 0, snapped: false, validation: {status: 'accepted', code: 'unfold'},
    events: [{kind: 'contact-lost', motor}],
  });
  expect(opened.contact).toBeUndefined();
  expect(opened.validation).toEqual(latest(session.experiment()).validation);
  expect(session.experiment().final.facets).toBe(initial.initial.facets);
  expect(session.experiment().final.creases).toBe(folded.final.creases);
  expect(hand.move(at(.75, .4)).events).toEqual([]);

  hand.beginTrace(motor);
  expect(hand.move(at(.75, .4)).events)
    .toContainEqual(expect.objectContaining({kind: 'contact', contact: 'crease'}));
});

it('reverses the compound dog-ear and releases its live opening snap', () => {
  const session = createTactileSession(createExperiment());
  const {hand} = session;
  fold(hand, at(1, 0), at(.5, 1));
  const first = session.experiment();
  fold(hand, at(0, 1), at(.84, .12));
  const compound = session.experiment();

  hand.beginDrag(at(.84, .12));
  const motor = at(0, 1);
  const preview = hand.move(motor);
  expect(preview.snapped).toBe(true);
  expect(preview.validation).toMatchObject({status: 'unverified', code: 'opening-disconnected'});
  expect(session.experiment()).toBe(compound);

  expect(hand.unfold()).toMatchObject({
    motor, snapped: false, proximity: 0, events: [{kind: 'snap-lost', motor}],
    validation: {status: 'accepted', code: 'unfold'},
  });
  const restored = session.experiment();
  expect(latest(restored)).toMatchObject({operation: 'unfold', move: {foldAttempt: 2}});
  expect(restored.final.facets).toBe(first.final.facets);
  expect(restored.final.creases).toBe(compound.final.creases);
  expect(hand.release().validation).toBeUndefined();
  expect(session.experiment()).toBe(restored);
});

it('unfolds successive folds in reverse order and preserves material marks', () => {
  let folded = recordMove(createExperiment(), half);
  folded = recordMove(folded, {line: [[0, .5], [1, .5]], side: -1});
  folded = recordMove(folded, {line: [[.25, 0], [.25, 1]], side: -1});
  expect(activeFoldAttempts(folded)).toEqual([1, 2, 3]);
  folded = recordMark(folded, at(.5, .5), [{crease: 0}, {crease: 1}]);
  const session = createTactileSession(folded);

  for (const foldAttempt of [3, 2, 1]) {
    expect(session.hand.unfold().validation?.code).toBe('unfold');
    const current = session.experiment();
    expect(latest(current)).toMatchObject({operation: 'unfold', move: {foldAttempt}});
    expect(current.final.facets).toBe(foldAttempt === 1 ? folded.initial.facets : folded.attempts[foldAttempt - 2].state.facets);
    expect(current.final.creases).toBe(folded.final.creases);
    expect(current.final.marks).toBe(folded.final.marks);
  }
  expect(activeFoldAttempts(session.experiment())).toEqual([]);
});

it('returns resistance on a blank sheet and at the history limit', () => {
  const blank = createExperiment();
  let full = recordMove(blank, half);
  for (let i = 1; i < 256; i++) full = recordFlip(full);
  expect(activeFoldAttempts(full)).toEqual([1]);
  expect(canUnfold(full)).toBe(false);

  for (const [experiment, status, code] of [
    [blank, 'rejected', 'no-active-fold'], [full, 'unverified', 'history-limit'],
  ] as const) {
    const session = createTactileSession(experiment);
    const failed = session.hand.unfold();
    expect(failed.validation).toMatchObject({status, code, reason: expect.any(String)});
    expect(failed.events).toEqual([{kind: 'resistance', motor: at(0, 0), validation: failed.validation}]);
    expect(session.experiment()).toBe(experiment);
  }
});

it('unfolds on the reverse face and replays a flip, unfold, trace, and mark trajectory', () => {
  const initial = createExperiment();
  const session = createTactileSession(initial, {trajectoryLimit: 32});
  const {hand} = session;
  fold(hand, at(1, 0), at(0, 0));
  expect(hand.flip().validation?.code).toBe('flip');
  const turned = session.experiment();
  expect(turned.final.pose?.reversed).toBe(true);

  expect(hand.unfold().validation?.code).toBe('unfold');
  const opened = session.experiment();
  expect(opened).toEqual(recordUnfold(turned));
  expect(opened.final.facets).toBe(initial.initial.facets);
  expect(opened.final.pose).toBe(turned.final.pose);
  expect(paperInView(opened.final).facets[0].transform).toMatchObject({a: -1, d: 1, e: .5});

  hand.beginTrace(at(-.2, 1));
  expect(hand.move(at(0, 1)).contact).toBe('intersection');
  expect(hand.mark().validation?.code).toBe('mark-point');
  const finished = session.experiment();
  expect(finished.attempts.map(attempt => attempt.operation ?? 'fold')).toEqual(['fold', 'flip', 'unfold', 'mark']);
  expect(finished.final.marks?.[0].point).toEqual(at(.5, 1));
  expect(finished.final.creases).toBe(turned.final.creases);
  expect(importExperiment(serializeExperiment(finished))).toEqual(finished);

  const log = session.trajectory()!;
  expect(log.version).toBe(3);
  expect(log.entries.map(entry => entry.command.kind)).toEqual(['drag', 'move', 'release', 'flip', 'unfold', 'trace', 'move', 'mark']);
  const replay = replayTactileTrajectory(initial, JSON.parse(JSON.stringify(log)));
  expect(replay.experiment).toEqual(finished);
  expect(replay.feedback).toEqual(log.entries.map(entry => entry.feedback));
});
