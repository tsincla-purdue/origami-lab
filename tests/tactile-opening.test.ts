import { expect, it } from 'vitest';
import {
  activeFoldAttempts, createExperiment, createTactileSession, importExperiment, recordMark, recordMove,
  recordUnfold, replayTactileTrajectory, serializeExperiment, undoMove, type TactileFeedback, type TactileHand,
} from '../src/lab';

const at = (x: number, y: number) => ({x, y});
const halfFold = {line: [[.5, 0], [.5, 1]], side: -1} as const;
const openingClick = (feedback: TactileFeedback) => feedback.events.some(event =>
  event.kind === 'snap-acquired' && event.constraint === 'opening');

function foldAndExplore(hand: TactileHand) {
  hand.beginDrag(at(1, 0));
  hand.move(at(0, 0));
  expect(hand.release().validation?.status).toBe('accepted');

  hand.beginDrag(at(0, 0));
  let closest = 0;
  for (let step = 1; step <= 50; step++) {
    const feedback = hand.move(at(step / 50, 0));
    if (openingClick(feedback)) {
      expect(feedback.proximity).toBeGreaterThan(closest);
      // Wiggle the gripper without losing the acquired hinge.
      expect(hand.move(at(feedback.motor.x - .006, .003)).snapped).toBe(true);
      expect(openingClick(hand.move(feedback.motor))).toBe(false);
      expect(hand.release().validation?.code).toBe('unfold');
      hand.beginTrace(at(.25, .6));
      return hand.move(at(.75, .6));
    }
    closest = feedback.proximity;
  }
  throw new Error('The sweep did not discover an opening.');
}

it('discovers an opening with the same hand, then discovers its retained crease by tracing', () => {
  const initial = createExperiment();
  const session = createTactileSession(initial, {trajectoryLimit: 80});
  const trace = foldAndExplore(session.hand);
  expect(trace.events).toContainEqual(expect.objectContaining({kind: 'contact', contact: 'crease'}));
  const complete = session.experiment();
  expect(complete.attempts).toHaveLength(2);
  expect(complete.attempts[1]).toMatchObject({operation: 'unfold', move: {foldAttempt: 1}});
  expect(complete.final.facets).toBe(initial.final.facets);
  expect(complete.final.creases).toEqual(complete.attempts[0].state.creases);
  expect(complete.final.creases).toHaveLength(1);
  expect(activeFoldAttempts(complete)).toEqual([]);
  expect(undoMove(complete).final).toEqual(complete.attempts[0].state);

  const serialized = serializeExperiment(complete);
  expect(importExperiment(serialized)).toEqual(complete);
  const log = JSON.parse(JSON.stringify(session.trajectory()));
  expect(log.truncated).toBe(false);
  const replay = replayTactileTrajectory(initial, log);
  expect(serializeExperiment(replay.experiment)).toBe(serialized);
  expect(replay.feedback).toEqual(log.entries.map((entry: {feedback: TactileFeedback}) => entry.feedback));
});

it('cannot open hidden material and refuses a flap with an exposed tip but a covered packet', () => {
  const buried = recordMove(createExperiment(), {...halfFold, placement: 'bottom'});
  const concealed = createTactileSession(buried);
  concealed.hand.beginDrag(at(0, 0));
  expect(openingClick(concealed.hand.move(at(1, 0)))).toBe(false);
  expect(concealed.hand.release().validation?.code).not.toBe('unfold');
  expect(concealed.experiment().final.facets.find(({id}) => id === 1)).toEqual(
    buried.final.facets.find(({id}) => id === 1));

  const overhang = recordMove(createExperiment(), {line: [[.75, 0], [.75, 1]], side: 1, placement: 'bottom'});
  const session = createTactileSession(overhang);
  session.hand.beginDrag(at(1.5, 0));
  const aligned = session.hand.move(at(.01, 0));
  expect(openingClick(aligned)).toBe(true);
  expect(aligned.validation).toMatchObject({status: 'rejected', code: 'opening-covered'});
  expect(session.hand.release().validation).toEqual(aligned.validation);
  expect(session.experiment()).toBe(overhang);
});

it('leaves a normal new fold available when the same flap is dragged in another direction', () => {
  const folded = recordMove(createExperiment(), halfFold);
  const session = createTactileSession(folded);
  session.hand.beginDrag(at(0, 1));
  expect(openingClick(session.hand.move(at(0, .65)))).toBe(false);
  session.hand.beginDrag(at(0, 1));
  expect(openingClick(session.hand.move(at(.4, 1)))).toBe(false);
  expect(session.hand.release().validation?.status).toBe('accepted');
  expect(activeFoldAttempts(session.experiment())).toEqual([1, 2]);
});

it('reports ambiguity with a new crease that is close to the opening hinge', () => {
  const ruled = recordUnfold(recordMove(createExperiment(), {line: [[.5125, 0], [.5125, 1]], side: -1}));
  const folded = recordMove(ruled, halfFold);
  const session = createTactileSession(folded);
  session.hand.beginDrag(at(0, 0));
  const near = session.hand.move(at(.99, 0));
  expect(near.events).toContainEqual(expect.objectContaining({kind: 'snap-acquired', constraint: 'axis'}));
  expect(near.validation?.code).toBe('competing-interpretations');
  expect(session.hand.release().validation?.status).toBe('unverified');
  expect(session.experiment()).toBe(folded);
});

it('does not choose between opening a hinge and folding a different packet about it', () => {
  const first = recordMove(createExperiment(), {...halfFold, side: 1});
  const second = recordMove(first, {line: [[.75, 0], [.75, 1]], side: 1});
  const session = createTactileSession(second);
  session.hand.beginDrag(at(1, 1));
  const near = session.hand.move(at(.51, 1));
  expect(openingClick(near)).toBe(true);
  expect(near.validation?.code).toBe('competing-interpretations');
  expect(session.hand.release().validation).toMatchObject({status: 'unverified', code: 'competing-interpretations'});
  expect(session.experiment()).toBe(second);
});

it('refuses an earlier intact hinge out of order and restores it after opening the newest flap', () => {
  let folded = recordMove(createExperiment(), {line: [[.5, 1], [1, .5]], side: 1});
  folded = recordMove(folded, {line: [[0, .25], [.25, 0]], side: -1});
  folded = recordMark(folded, at(0, .25), [{edge: 3}, {crease: 1}]);
  const session = createTactileSession(folded);
  const {hand} = session;
  hand.beginDrag(at(.5, .5));
  expect(openingClick(hand.move(at(1, 1)))).toBe(true);
  expect(hand.release().validation).toMatchObject({status: 'unverified', code: 'unfold-order'});
  expect(session.experiment()).toBe(folded);

  hand.beginDrag(at(.25, .25));
  expect(openingClick(hand.move(at(0, 0)))).toBe(true);
  expect(hand.release().validation?.code).toBe('unfold');
  expect(activeFoldAttempts(session.experiment())).toEqual([1]);
  expect(session.experiment().final.facets).toEqual(folded.attempts[0].state.facets);

  hand.beginDrag(at(.5, .5));
  expect(openingClick(hand.move(at(1, 1)))).toBe(true);
  expect(hand.release().validation?.code).toBe('unfold');
  expect(session.experiment().final.facets).toEqual(folded.initial.facets);
  expect(session.experiment().final.creases).toEqual(folded.final.creases);
  expect(session.experiment().final.marks).toEqual(folded.final.marks);
});

it('opens the moved material in displayed coordinates after turning its face upward', () => {
  const folded = recordMove(createExperiment(), {...halfFold, placement: 'bottom'});
  const session = createTactileSession(folded);
  const {hand} = session;
  expect(hand.flip().validation?.code).toBe('flip');
  hand.beginDrag(at(.5, 0));
  const feedback = hand.move(at(-.49, 0));
  expect(openingClick(feedback)).toBe(true);
  expect(hand.move(at(-.4, 0)).events).toContainEqual(expect.objectContaining({kind: 'snap-lost'}));
  expect(openingClick(hand.move(at(-.49, 0)))).toBe(true);
  expect(hand.release().validation?.code).toBe('unfold');
  const final = session.experiment().final;
  expect(final.pose?.reversed).toBe(true);
  expect(final.facets).toBe(folded.initial.facets);
  expect(final.creases).toBe(folded.final.creases);
});
