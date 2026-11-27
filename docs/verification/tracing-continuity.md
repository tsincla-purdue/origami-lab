# Stationary tracing in sensory version 3

The previous hand ended its current gesture on every trace start. At a stationary fingertip this emitted a loss immediately followed by a new contact with the same surface. The new hand preserves an active trace when both requested coordinates equal the current motor coordinates. Each command and its feedback still occupy their own place in the trajectory.

## Controlled reproduction

The browser regression exercises the published headless API with 20 trace starts, one unsuccessful drag start and 19 more trace starts, all at (0.5, 0.5) on a blank sheet. This uses the command counts from the reported episode and places the failed grab at command 21 for the test.

| Native feedback over 40 commands | Version 1 | Version 2 | Version 3 |
| --- | ---: | ---: | ---: |
| Surface contacts acquired | 39 | 39 | 2 |
| Contact losses | 38 | 38 | 1 |
| Rejected grabs (`no-grab`) | 1 | 1 | 1 |

In version 3 the finger first touches the sheet, lifts to attempt the grab, and touches it again on the next trace start. The other 37 trace starts retain the existing sensation. The host keeps the failed grab's diagnostic and the agent receives `grip-failed`. All 40 commands remain recorded and the sheet stays blank.

## Interpretation and checks

Motor continuity means the finger stays down until an action lifts it. Sensory continuity means that a steady contact can persist across decisions without adding contact events. Moving still samples intervening features, and placing the finger elsewhere can yield a real loss and acquisition even when both endpoints feel like surface.

The agent decides whether to repeat, move, lift, or try another manipulation. This controlled sequence establishes what feedback those choices produce. Its results cannot establish how often Qwen will move or what it will write in its notebook during a fresh episode.

The regression failed under the previous build. Unit coverage checks model-facing memory, stationary corner intensity, release and recontact, movement across a retained crease intersection, and discontinuous placement. Frozen historical episode tests verify native feedback and canonical experiments under versions 1 and 2.
