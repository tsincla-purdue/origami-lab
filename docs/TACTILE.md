# Headless tactile sessions

`createTactileSession(experiment, options?)` runs in TypeScript or in the built
`dist/api/index.js` module. The host owns the starting experiment and can read
`session.experiment()` at any time. Give a controller only `session.hand` so
its inputs and observations stay local.

| Motor input | Effect |
| --- | --- |
| `beginTrace(at)` | Place a probe and sense the exposed material there. |
| `beginDrag(at)` | Try to grab a visible corner, edge, crease, or marked point within the playground's hit bands. |
| `move(to)` | Advance the active probe or grab along a straight segment. |
| `release()` | Lift the probe or try to commit the current fold or opening. |
| `mark()` | Record the current traced intersection and its defining material lines. |
| `flip()` | Turn the whole sheet over using the ordinary recorded operation. |

Motor positions use the displayed, y-up paper coordinates. One unit is the
original square's side length. Positions may extend outside the sheet. Set
`pixelsPerUnit` to match the browser's paper scale when comparing gestures.
The default is 400 and the supported range is 32–4096. Divide individual
motions longer than 4096 virtual pixels into smaller moves. Each move is
sampled at intervals of at most 2 virtual pixels.

## Feedback

- `motor` echoes the current hand position. Positions on events are
  intermediate motor samples. A controller can return to the sample that
  produced a contact.
- `proximity` is between zero and one. For a trace on paper it rises
  linearly from zero at 12 virtual pixels to one on the closest exposed
  feature. Off the sheet, there is no contact or warmth. During a drag the
  signal uses the closest eligible solver score over the snap's release band.
- `contact` reports surface, edge, crease, intersection, or a previously
  marked point, with events when the contact changes or ends. Feature contacts
  occur within 3 virtual pixels. Several events can occur during one move.
  Marking requires the probe to be at an eligible intersection when called.
- `snap-acquired` identifies a point, line alignment, axis, or opening constraint.
  The normal playground threshold is 13 virtual pixels on the candidate
  score. The snap remains locked out to 19.5 virtual pixels. `snap-lost`
  indicates that the lock broke or the grab ended. A loss and a new acquisition
  can occur in one move. The event gives no target coordinates or material IDs.
- `validation` and `resistance` report rejected or unverified motion, using
  the physical validator's code and reason where it supplies a verdict. An
  exact acquisition can still encounter resistance. Only a uniquely accepted
  proposal can commit on release. With unresolved rivals, move the hand to
  distinguish them. A click describes the acquired geometry and conveys no
  symbolic proof status.

Tracing examines a neighborhood of the topmost facet at the probe. A feature
must also be exposed at its nearest point. Intersection contact requires
actual material lines on that facet. A crease under a flap, a mark on a
covered layer, and a projected crossing between separate layers produce no
contact. A turnover can expose those features. Dragging uses the same solver,
snap selection, packet inference, validator, and recorder as the playground,
with exposed references only. Preview choices that require human controls,
such as explicitly selecting buried material or pinning, are outside this
motor vocabulary. The tactile hand skips synthetic targets such as the
bounding-box center. Resistance comes from the existing planar folding model,
which does not simulate continuous 3D collisions.

## Opening a flap

An ordinary drag can acquire an `opening` snap. The grab must belong to the
exposed material of a recorded moving packet, and that packet must still have
its common hinge. The drag must pass to the other side of the hinge and approach
the exact reflected landing. The same snap bands and hysteresis apply as for
new folds. The hand receives the click and the validator result independently.
A covered portion can block a packet even when its tip is exposed. A turnover
can expose or hide the recorded moving face. A drag on the opposite leaf
cannot reverse a hidden flap.

Only the latest active fold has a verified reversal. Other intact hinges can
click and report an unverified reversal. An accepted competing fold on a
different axis or packet leaves the gesture undecided. Move the hand to
resolve the competing proposals.

An opening records a regular `unfold` attempt and preserves the paper's
creases and marks. Undo edits history. Undoing the opening restores the
folded paper, while undoing the original fold removes the crease it created.

This exploration starts with a blank square. It sweeps the flap toward its
former side and waits for tactile acquisition, then sweeps the flat paper
for contact with the crease.

```ts
import {createExperiment, createTactileSession, type TactileHand} from '../src/lab';

function explore(hand: TactileHand) {
  hand.beginDrag({x: 1, y: 0});
  hand.move({x: 0, y: 0});
  if (hand.release().validation?.status !== 'accepted') return;

  hand.beginDrag({x: 0, y: 0});
  for (let step = 1; step <= 50; step++) {
    const feedback = hand.move({x: step / 50, y: 0});
    if (feedback.events.some(event => event.kind === 'snap-acquired' && event.constraint === 'opening')) {
      if (hand.release().validation?.status !== 'accepted') return;
      hand.beginTrace({x: .25, y: .6});
      return hand.move({x: .75, y: .6}).events;
    }
  }
  hand.release();
}

const initial = createExperiment();
const discovery = createTactileSession(initial, {trajectoryLimit: 80});
explore(discovery.hand);
console.log(JSON.stringify(discovery.trajectory()));
```

## Example controller

This sweep works on a seeded experiment with an exposed intersection along
the probe's search path. The controller learns the contact from movement.

```ts
import {createTactileSession, type TactileHand} from '../src/lab';

function search(hand: TactileHand) {
  for (let row = 10; row <= 90; row++) {
    const y = row / 100;
    const start = hand.beginTrace({x: .1, y});
    const sweep = hand.move({x: .42, y});
    const hit = [...start.events, ...sweep.events].find(event =>
      event.kind === 'contact' && event.contact === 'intersection');
    if (hit && hand.move(hit.motor).contact === 'intersection') return hand.mark();
  }
}

const session = createTactileSession(initialExperiment, {trajectoryLimit: 180});
search(session.hand);
```

`session.trajectory()` optionally returns a separate versioned log of motor
commands and their feedback. Recording defaults to off. It keeps a prefix of
up to the configured number of commands (maximum 2048) and at most 4096
events, with a `truncated` flag. `replayTactileTrajectory(initial, log)` runs
the recorded commands again from the same starting experiment and recomputes
their feedback. Sensations and refused releases stay outside the canonical
experiment export. Accepted folds, marks, and turnovers use the normal
experiment format and replay.
