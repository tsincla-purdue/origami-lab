import { expect, it } from 'vitest';
import { apply, distance, perpendicularBisector, sideOf, signedDistance, type Vec } from '../vendor/origamio/src/geometry';
import { hinges, tears } from '../vendor/origamio/src/rigid';
import {
  canUnfold, cornerPackets, createExperiment, createTactileSession, importExperiment, recordMark, serializeExperiment, validate,
  type Experiment, type Move, type TactileHand,
} from '../src/lab';
import { packetCandidates } from '../src/lab/packet-intent';
import { interpretGesture } from '../src/playground/intent';

const at = (x: number, y: number) => ({x, y});
const grab = at(0, 1);
const landing = at(.84, .12);

function drag(hand: TactileHand, from: Vec, to: Vec) {
  hand.beginDrag(from);
  const preview = hand.move(to);
  return {preview, release: hand.release()};
}

function dogEar(x = .5) {
  const session = createTactileSession(createExperiment());
  expect(drag(session.hand, at(1, 0), at(x, 1)).release.validation?.status).toBe('accepted');
  return session.experiment();
}

function checkReplay(experiment: Experiment) {
  const json = serializeExperiment(experiment);
  expect(importExperiment(json)).toEqual(experiment);
  expect(serializeExperiment(importExperiment(json))).toBe(json);
}

it('infers the overlapping dog-ear even when both ends of its old hinge stay fixed', () => {
  const first = dogEar();
  const local = cornerPackets(first.final, grab);
  const line = perpendicularBisector(grab, landing);
  const side = sideOf(line, grab);
  const move: Move = {line: [[line.a.x, line.a.y], [line.b.x, line.b.y]], side};
  const [weld] = hinges(first.final);
  expect(hinges(first.final)).toHaveLength(1);
  expect([weld.p, weld.q]).toEqual([0, 1]);
  expect([weld.a, weld.b].every(point => side * signedDistance(line, point) < 0)).toBe(true);
  expect(local).toEqual([{facetIds: [0]}]);
  // The original search stopped at [0] and reported blocked-hinge on this exact axis.
  expect(validate(first.final, {...move, packet: local[0]})).toMatchObject({status: 'rejected', code: 'blocked-hinge'});

  const session = createTactileSession(first);
  const {preview, release} = drag(session.hand, grab, landing);
  expect(preview.snapped).toBe(false);
  expect(release.validation).toMatchObject({status: 'accepted', code: 'simple-fold'});
  expect(packetCandidates(first.final, local, line, side)).toEqual([{facetIds: [0]}, {facetIds: [0, 1]}]);
  const choices = interpretGesture(first, {tool: 'corner', line, side, anchor: grab, destination: landing,
    snapped: [], packet: local[0], inferFrom: local});
  expect(choices).toHaveLength(1);
  expect(choices[0].move?.packet?.facetIds).toEqual([0, 1]);

  const complete = session.experiment();
  expect(complete.attempts[1]).toMatchObject({move: {packet: {facetIds: [0, 1]}}});
  expect(complete.final.facets.map(facet => facet.id)).toEqual([0, 1, 3, 2]);
  expect(tears(complete.final)).toBe(0);
  const finalWelds = hinges(complete.final).map(({p, q}) => [Math.min(p, q), Math.max(p, q)]);
  expect(finalWelds).toHaveLength(3);
  expect(finalWelds).toEqual(expect.arrayContaining([[0, 1], [0, 2], [1, 3]]));
  expect(complete.final.creases).toHaveLength(3);
  expect(complete.final.creases[0]).toEqual(first.final.creases[0]);
  expect(distance(apply(complete.final.facets.at(-1)!.transform, grab), landing)).toBeLessThan(1e-12);
  checkReplay(complete);

  // The two moved portions share an axis but have no weld to each other.
  expect(canUnfold(complete)).toBe(true);
  expect(drag(session.hand, landing, grab).release.validation)
    .toMatchObject({status: 'unverified', code: 'opening-disconnected'});
  expect(session.experiment()).toBe(complete);

  const marked = recordMark(first, at(0, .125), [{edge: 3}, {crease: 0}]);
  const markedSession = createTactileSession(marked);
  expect(drag(markedSession.hand, grab, landing).release.validation?.status).toBe('accepted');
  expect(markedSession.experiment().final.marks).toEqual(marked.final.marks);
  checkReplay(markedSession.experiment());
});

it.each([
  {first: .55, target: at(.55, .45), code: 'packet-fold', packet: [0]},
  {first: .5, target: at(.7, .21), code: 'simple-fold', packet: [0, 1]},
  {first: .5, target: at(1, 0), code: 'simple-fold', packet: [0, 1]},
  {first: .2, target: at(.84, .12), code: 'simple-fold', packet: [0, 1]},
  {first: .65, target: at(.84, .12), code: 'simple-fold', packet: [0, 1]},
])('infers the appropriate packet for first landing $first and second landing $target', ({first, target, code, packet}) => {
  const session = createTactileSession(dogEar(first));
  expect(drag(session.hand, grab, target).release.validation?.code).toBe(code);
  expect(session.experiment().attempts[1]).toMatchObject({move: {packet: {facetIds: packet}}});
});

it('retains ambiguity when distinct snapped axes are admissible after adding the cover', () => {
  const first = dogEar(.2);
  const session = createTactileSession(first);
  expect(drag(session.hand, grab, at(.98, .02)).release.validation)
    .toMatchObject({status: 'unverified', code: 'competing-interpretations'});
  expect(session.experiment()).toBe(first);
});

it('reports an uncertified partial swing when a third flap stays entirely on the fixed side', () => {
  const session = createTactileSession(dogEar());
  expect(drag(session.hand, at(1, 1), at(.94, .94)).release.validation?.code).toBe('packet-fold');
  const before = session.experiment();
  const line = perpendicularBisector(grab, landing);
  const move: Move = {line: [[line.a.x, line.a.y], [line.b.x, line.b.y]], side: sideOf(line, grab)};
  expect(validate(before.final, {...move, packet: {facetIds: [0]}})).toMatchObject({
    status: 'rejected', code: 'blocked-hinge',
  });
  expect(validate(before.final, {...move, packet: {facetIds: [0, 1]}})).toMatchObject({
    status: 'unverified', code: 'disconnected-packet',
  });
  expect(validate(before.final, {...move, packet: {facetIds: [0, 1, 2]}})).toMatchObject({
    status: 'accepted', code: 'simple-fold',
  });
  expect(drag(session.hand, grab, landing).release.validation).toMatchObject({
    status: 'unverified', code: 'disconnected-packet',
  });
  expect(session.experiment()).toBe(before);
});

it('uses the exposed ranks when the same construction is made on the reverse face', () => {
  const session = createTactileSession(createExperiment());
  expect(session.hand.flip().validation?.status).toBe('accepted');
  expect(drag(session.hand, at(0, 0), at(.5, 1)).release.validation?.status).toBe('accepted');
  expect(drag(session.hand, at(1, 1), at(.16, .12)).release.validation?.code).toBe('simple-fold');
  const complete = session.experiment();
  expect(complete.attempts[2]).toMatchObject({move: {packet: {facetIds: [0, 1]}}});
  expect(tears(complete.final)).toBe(0);
  expect(complete.final.pose?.reversed).toBe(true);
  checkReplay(complete);
});
