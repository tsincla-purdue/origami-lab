# Origami Lab

Origami Lab is a shared world for mathematical play: people and small AI agents explore the same paper, whose geometry, layers, and physical constraints do some of the mathematical work. See our [guiding principles](docs/PRINCIPLES.md).

A browser playground and headless TypeScript API for experiments with elementary
flat folds. Origamio supplies polygon geometry, the folding operation, hinge
diagnostics, and both SVG views. The lab supplies validation, candidate
generation, experiment records, and FOLD export.

## Run the playground

Node.js 24 or newer is required.

```sh
npm ci
npm run dev
```

Open the address Vite prints and choose a **Paper style**. Grab a marked corner
with a mouse, finger, or pen and move it onto a new point. You can also tap a
point on the paper or an edge, then drag it. The dashed line is the perpendicular bisector of that motion. The
shaded area shows the selected moving material, and the translucent paper
shows the validated flat endpoint. Release to commit a unique accepted fold.

An ordinary drag tries the top material first. It also checks connected
packets for the same crease, including flaps attached on the moving side.
The preview highlights the smallest accepted packet. If more than one packet
can move, use **Moving packet** after release to compare the previews and
confirm your choice. Try a dog-ear from the upper-right corner to the center,
then drag the lower-right corner straight to the lower-left.

Tap the same corner repeatedly to explicitly select one of its connected
packets. The highlighted facets and
the **Layers** count show the current selection. Allow up to 3.5 seconds between
taps. The selection remains available for a drag after that interval. Choose
another corner to start at one layer again.

The **Corner** and **Layers** controls offer the same selections by keyboard.
An explicit packet is used as selected, so a blocked fold shows its reason.
**Automatic** enables packet inference again. **Whole stack** directly selects
all material on the moving side. A selected packet can also be used in
**Advanced Controls**. A successful fold or reset clears the selection.

For an explicit crease, open **Advanced Controls** and select **Draw crease**.
Drag to draw the line, then click or tap the side of
the paper to move. Select **Confirm fold** after checking the preview. Press
**Escape** or use **Cancel** to discard a preview. Rejected and unverified
gestures display the reason and leave the paper and history unchanged.

**Snap to points** uses a screen-pixel tolerance around visible corners, edge
midpoints, exposed intersections, and the center of the folded silhouette's
bounds. When the selected packet has one hinge axis, snapping also offers the
corner's exact landing point across it. A green ring marks the snap target.
When the drag has no landing-point snap and its crease passes close to two
visible vertices, midpoints, or crease intersections, the crease can lock to the
exact line through those points. Two green rings and a green crease show that
the landing has changed to the exact reflection. The crease stays locked
through small pointer movements and waits for a clear match when nearby lines
compete. Turn off **Snap to points** or hold **Alt** while using a mouse to
disable both kinds of snapping. Open **Advanced Controls** to preview and record
the original command-based folds.

Grab an exposed edge or crease away from a corner or marked dot and drag it
toward another visible line. The dashed brown line identifies the material
you grabbed, the green line shows the target, and the preview shows the
angle bisector or halfway crease (O3). Release an accepted unique fold to
commit it. If two folds are admissible, the preview nearest the pointer is
selected first. Use **Fold preview** to inspect either before confirming.

Hold a point to pin it, then grab a visible edge or crease and slide along
that same line toward the other side of the pin. The crease goes through the
pin at right angles to the line (O4). For example, hold the top midpoint of
a square, then slide the bottom edge from left to right to fold at the center.
With a pin in place, you can also grab a corner, marked dot, or other snap
point on a line and drag it along that line. The preview shows a right angle
and snaps to the exact reflected point, which can lie beyond the visible
segment. Dragging a point toward a different line still uses O5.

Use **Flip over** to turn the entire folded sheet around its vertical center.
The opposite faces and layers become accessible for folding. The turn is
recorded in the history and can be undone. Turning twice about the same
center restores the previous view.

Select **Unfold** to reverse the most recent active fold while keeping all
creases on the paper. After several folds, select it repeatedly to open them
in reverse order, even after a turnover. For example, fold the square vertically in half and select
**Unfold** to return to a flat square with a center crease.

Tap near a crossing between creases or where a crease meets a paper edge, then
choose **Mark point**. When genuine intersections overlap, **Intersection layer**
lets you choose the sheet location to mark. A dot follows that material and
appears when it is exposed. You can hold a visible dot to pin it, drag it, or
use it as a snap target or one of two crease references. Exposed marks use
the same grab radius as corners and the same snap tolerances as other points.
Tap a mark and choose **Remove mark** to erase the dot.
Both actions are recorded, support **Undo**, and are saved in experiment JSON.

To construct an equilateral triangle on that square, press and hold the
lower-left corner until the pin appears. Release it, then drag the lower-right
corner near the center crease. The preview snaps to the exact landing. Release
to commit when there is a single accepted fold. For multiple accepted choices,
pick a preview and select **Confirm fold**. You can also select a point and use
**Pin point**, which keeps a confirmation step. Hold the pin again, use
**Cancel** or **Unpin point**, or press **Escape** to clear it.

Select a history row to browse a saved state. **Replay** plays from the initial
square. At the history tip, **Undo** removes the last attempt from the history
and JSON export and leaves the retained state ready for a new fold. Undoing an
Unfold restores the folded sheet. Undoing the original fold removes its crease.
**Reset paper**
clears the history and restores the
initial square in the selected style, ready to fold again. Continue folding
from the latest step in **Folded** view.
**New experiment** starts a fresh history. Presets load at their initial
position and keep the chosen paper style.

**Export experiment** saves the complete experiment as JSON, even if the view is
showing an earlier step. **Import** reconstructs and checks each step. Export
before leaving the page to keep the history. **Export FOLD** writes the currently
displayed snapshot, either a folded form or a crease pattern. The browser runs
locally without a server-side service or a model.

Paper styles are painted in the original sheet coordinates. Each facet carries
its original polygon and pattern through every reflection. The renderer shows
the appropriate face and draws upper layers over lower ones. The selected
style is saved with the experiment and remembered as a local preference when
storage is available. Older JSON files open with Classic white. FOLD export
continues to describe geometry and layer order.

## Build for distribution

```sh
npm ci
npm test
npm run build
npm run preview
```

The build type-checks the project and writes the browser application to `dist/`
and the headless ES module to `dist/api/index.js`. `npm run preview` serves the
built playground locally.

For browser tests, install Chromium with `npx playwright install chromium`, then
run `npm run test:browser`. The suite builds and serves the production files
and exercises mouse and touch gestures. Set `ORIGAMI_CHROMIUM_PATH` to use a
compatible Chromium executable already installed on your machine.

To distribute the browser app, serve `dist/index.html` with `dist/assets/` and
the `LICENSE`, `Origamio-LICENSE.txt`, and `THIRD-PARTY-NOTICES.txt` files in
`dist/`. To distribute the headless API, keep the license files in `dist/api/`
with `index.js`. The JavaScript bundles also carry their applicable notices.

The application requires no API keys or environment configuration. Use
placeholders in tracked templates such as `.env.example` or
`.env.production.example`. Keep secrets out of `VITE_*` variables because Vite
can expose those values to browser code.

### GitHub Pages

In the repository, set **Settings → Pages → Build and deployment → Source** to
**GitHub Actions**. Pushes to `main`, including merged pull requests, run
`npm ci`, `npm test`, and `npm run build` on Node.js 24. The workflow uploads
the browser files and license notices from `dist/` and deploys to
[tsincla-purdue.github.io/origami-lab](https://tsincla-purdue.github.io/origami-lab/).
After enabling Pages, you can also run the workflow manually from `main`.

To verify the Pages build and preview it locally, use the same base path.

```sh
ORIGAMI_BASE_PATH=/origami-lab/ npm run build
ORIGAMI_BASE_PATH=/origami-lab/ npm run preview
```

## Programmable API

```js
import {
  apply, createExperiment, propose, recordMove, serializeExperiment, validate,
} from './dist/api/index.js';

let experiment = createExperiment();
const state = experiment.final;
const move = propose(state)[0];
const verdict = validate(state, move);
const result = apply(state, move); // { state, validation }
experiment = recordMove(experiment, move); // execute and retain the attempt
const json = serializeExperiment(experiment);
```

Use `initialState()` for state-only work and `stateAt(experiment, n)` to inspect
history after attempt `n`. Engine states are frozen and valid for that API
instance. Import a record to reconstruct states in another process. A move has
`line: [[ax, ay], [bx, by]]` in the current folded coordinates and a `side` of
`1` (left of the directed line) or `-1` (right). It may include a label and
`placement: 'top'` or `'bottom'`. The programmatic validator understands
Origamio's other move fields so it can explicitly report unsupported motions.
Call `cornerPackets(state, {x, y})` with a displayed corner to find the
edge-connected prefixes of the local stack, starting from the top layer. To fold just one of those
packets, pass it as `move.packet`, for example `{ facetIds: [2, 3] }`.
The IDs refer to the material facets in the state immediately before the move.
`propose` returns eight candidates from the current bounds in stable order.
They comprise the two midlines and two opposite-corner bisectors, with both
sides for each axis. Check each candidate before applying it.

Use `activeFoldAttempts(experiment)` to inspect the one-based attempt IDs of
active folds. `canUnfold(experiment)` and `recordUnfold(experiment)` allow the
latest active fold to be reversed when the current geometry matches its
certified endpoint. Each Unfold record names that attempt and retains all
material creases. Arbitrary opening of locked or interacting flaps is outside
the model.

`recordFlip(experiment)` records a turnover about the current displayed
vertical center. The optional paper pose records orientation and position
separately from the intrinsic facet mesh and material creases.
`paperInView(state)` gives the exposed side's positions and layer order.
Submit folds in those displayed coordinates. The validator maps the axis,
moving side, and layer placement into the intrinsic sheet frame. Unfold
keeps the current pose. JSON replay restores the pose at each step, and
FOLD export applies it to the folded form while keeping the crease pattern in
material coordinates.

`materialIntersections(state, near, radius)` returns exact finite intersections
in original sheet coordinates. Use `recordMark(experiment, point)` to mark one
and `recordRemoveMark(experiment, markAttempt)` to remove it by its original
mark attempt ID. The marks stay in material coordinates in experiment JSON.
`visibleMaterialMarks(state)` gives their current exposed positions. FOLD export
continues to describe the sheet geometry and its crease pattern.

`solveCreaseThroughPoints(moving, a, b)` implements O1 in folded paper
coordinates. It returns the same exact line, reflected destination, and moving
side used by the drag preview. To submit a solved construction, pass
`{line: [[a.x, a.y], [b.x, b.y]], side: solution.side}` to `recordMove` or
`apply`, with the intended material packet if needed. The normal validator
checks the proposed fold and experiment JSON records its exact axis.

`solveLineOntoLine(source, target)` computes O3 using supporting lines. It
returns both bisectors for intersecting lines, the midway axis for distinct
parallel lines, or a diagnostic for coincidence or numerical uncertainty.
It verifies the reflection of both source endpoints to the paper-coordinate
epsilon (`1e-9`). `solvePerpendicularThroughPoint(point, line)` computes and
verifies O4. Nearly parallel O3 directions and O4 orthogonality are checked
against 64 binary64 epsilons in normalized directions.

Use `resolveLineFold(intent)` to resolve the same line constraints used by
dragging. Supply a `source` reference with its `facetId` and projected `line`,
and the grabbed point as `moving`. Use `kind: 'align-lines'` with a `target`
reference, or supply a `pin` with `kind: 'perpendicular'` for a line drag or
`kind: 'perpendicular-point'` for a point drag along its line. The point drag
allows a nontrivial landing anywhere on the supporting line. Pass a returned
solution's resolved `line` and `side` with that `intent` to the normal move API.
The physical validator still evaluates the selected packet. Replay checks
that the recorded axis and side resolve from the intent. Older moves without
line intent remain readable.

`solvePointOntoLine(pin, moving, {a, b}, finite)` implements O5. It intersects
the target line with the circle centered at the pin with radius equal to the
pin-to-moving distance. Each nontrivial landing defines a perpendicular
bisector through the pin. Pass `true` to restrict the targets to the finite
segment. The solver treats nonzero discriminants within a scale-adjusted
64 binary64 epsilons as uncertain and verifies the pin-to-axis distance against
the engine epsilon. The browser passes every candidate through the fold
validator and records the chosen exact axis and moving material.

The material mesh continues to store each facet's original polygon, transform,
and layer rank. Retained creases are separate material-space segments. The
browser clips them to facets and projects them with the same transforms for
rendering and snapping. Unfold can restore the previous panel layout without
losing that reference geometry. FOLD export represents retained creases as flat
edges by subdividing the export mesh where needed.

## Validation model

**Accepted** means executable within the lab's idealized model and numerical
tolerances. The input is a trusted, initially flat unit square with no cuts or
stretch. A move carries material in one half-plane through a common 180°
rigid rotation about the in-plane axis. It can move the whole half-plane or
just the portions of explicitly selected material facets on that side. The
rest of the sheet stays fixed. Existing folds inside each packet stay closed.
The model permits
coincident plies with a preserved order within a packet, and assumes zero
thickness and no friction. During an upward or downward rotation, every
off-axis moving point lies outside the stationary plane until landing. At
landing the moving packet is placed wholly above or below the stationary one,
with its internal order reversed.

The lab checks for nonempty packets and a shared material hinge, checks that
attachments between packets lie on the axis, and checks for torn shared edges.
It audits the resulting polygons against Origamio's half-plane clipping in
folded coordinates, checks total area, and verifies stack reversal and
placement. Vertices within the engine epsilon of the axis are treated as
on-axis. Vertices between that epsilon and Origamio's larger clipping
tolerance yield an unverified result. Degenerate or ambiguous splits also
remain unverified. This is a floating-point model of a restricted motion,
with no guarantee for finite-thickness paper.

For a partial move, the moving pieces must be connected by material edges.
The packet must be exposed on the side it swings through at the start, and
unselected paper must clear the fixed hinge. A stationary sheet may cross the
projection of a new crease when both incident pieces come from the same facet
and the stationary sheet stays on the opposite side of both pieces at launch
and landing. In the open interval of rotation,
off-axis moving points are off the stationary plane. At landing the packet
rests on the same exterior side of the fixed material, with its order reversed.
This verifies opening the top flap of a half-fold, adding a new crease to it
above the stationary lower sheet, and opening the top two connected layers of
a quarter-fold.

- **Rejected** covers malformed moves, no-ops, torn hinges, and detected hinge
  obstructions, as well as packets buried under stationary paper in the
  direction of the swing. The blocked-hinge regression checks an uncut
  stationary cover caught between the closing plies of a partial-stack fold.
- **Unverified** covers unknown states, results outside the numerical or facet
  bounds, motions at non-flat angles, grouped operations, region and window
  selections, disconnected moving pieces, and ambiguous hinge clearances.
  Origamio can compute flat trials for some of these configurations. Legacy
  rank-only selectors and inside placements retain their previous verification
  rules. General pocket insertion, squash folds, flexible motion, and arbitrary
  3D paths remain outside this validator.

Rejected and unverified moves keep the previous state. Any geometric trial used
to diagnose them is discarded.

## Experiment data and interoperability

Experiment JSON includes the initial sheet, exact numeric action inputs,
validation outcomes, material facet IDs for packet moves, snapshots after
each attempt, the final state, the full
Origamio revision, and the numerical policy. Proposal generation and execution
use no randomness. Import checks the engine and policy, reruns the move log,
and compares each recorded outcome, intermediate snapshot, and final state to
the replay. Archived hinge-clearance decisions retain their original validator
version on import. New attempts use the current validator. Determinism is tested
on the same build and JavaScript runtime.
A runtime with different floating-point results can report a replay mismatch.
Experiments are limited to 256 attempts and 128 facets per state.

`exportFold(state)` emits a FOLD 1.1 crease-pattern frame and an inheriting
folded-form frame. Pass `'creasePattern'` or `'foldedForm'` for a standalone
snapshot. The exporter derives adjacency in material coordinates, inserts
shared seam vertices, and writes winding-relative `faceOrders` for significant
overlaps. Use the experiment JSON for actions and outcomes. FOLD import is
outside this milestone.

## Licensing

Original Origami Lab code is available under the [MIT license](LICENSE).
Origamio source and selected upstream tests are vendored without edits at
`c28937855e8d4b08cd10c83b66689f3e94b924b2` under
[Origamio's MIT license](vendor/origamio/LICENSE). The browser build includes the
module-preload helper from Vite and Rolldown under their respective MIT licenses.
See [third-party notices](THIRD-PARTY-NOTICES.txt).
