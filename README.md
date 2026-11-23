# Origami Lab

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

Open the address Vite prints. Choose an operation to preview its axis and moving
side, then select **Apply fold**. The history records each attempt and its
outcome. Click a history row, use **Undo** to move back one attempt, or **Replay**
to play from the initial square. **Reset paper** returns to the initial square
and preserves the history for replay. Continue folding from the latest step.
**New experiment** starts a fresh history. Presets load at their initial
position and can be replayed or inspected one step at a time.

**Export experiment** saves the complete experiment as JSON, even if the view is
showing an earlier step. **Import** reconstructs and checks each step. Export
before leaving the page to keep the history. **Export FOLD** writes the currently
displayed snapshot, either a folded form or a crease pattern. The browser runs
locally without a server-side service or a model.

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
`propose` returns eight candidates from the current bounds in stable order.
They comprise the two midlines and two opposite-corner bisectors, with both
sides for each axis. Check each candidate before applying it.

## Validation model

**Accepted** means executable within the lab's idealized model and numerical
tolerances. The input is a trusted, initially flat unit square with no cuts or
stretch. Each move carries **all** material in one half-plane through a common
180° rigid rotation about the in-plane axis. All material on the other side
stays fixed. Existing folds inside each packet stay closed. The model permits
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

- **Rejected** covers malformed moves, no-ops, torn hinges, and detected hinge
  obstructions. The blocked-hinge regression checks an uncut stationary cover
  caught between the closing plies of a partial-stack fold.
- **Unverified** covers unknown states, results outside the numerical or facet
  bounds, motions at non-flat angles, grouped operations, region and window
  selections, and partial or inside folds without a detected obstruction.
  General pocket insertion, squash folds, flexible motion, and arbitrary 3D
  paths remain outside this validator.

Rejected and unverified moves keep the previous state. Any geometric trial used
to diagnose them is discarded.

## Experiment data and interoperability

Experiment JSON includes the initial sheet, exact numeric action inputs,
validation outcomes, snapshots after each attempt, the final state, the full
Origamio revision, and the numerical policy. Proposal generation and execution
use no randomness. Import checks the engine and policy, reruns the move log,
and compares each recorded outcome, intermediate snapshot, and final state to
the replay. Determinism is tested on the same build and JavaScript runtime.
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
