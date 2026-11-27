# Clydie v0.2

Clydie explores one sheet through the same tactile hand as the playground. A local instruction model chooses one action at a time. A small host moves the hand, keeps the experiment and records what happened. A seeded random controller can take the model's place in the same loop. Neither controller has a construction objective. [First three episodes and their records](verification/clydie-v0/README.md)

## Run an episode

Use Node.js 24 or newer in the repository root. The baseline and saved episodes work with Node alone after installing the existing project dependencies.

```sh
npm ci
npm run clydie -- --controller random --seed 17 --max-commands 60
```

For live inference with Ollama, start Ollama locally and choose an installed instruction model that supports structured JSON output. For example, `ollama pull smollm2:360m` installs a small model. Start `ollama serve` if the service is stopped. Model installation requires access to the weights. Once installed, inference runs locally without an API key.

```sh
npm run clydie -- --controller ollama --model smollm2:360m --seed 17 --max-commands 60
```

### LM Studio

Load an instruction model that supports structured output in LM Studio. Start the local server from the Developer tab. Its default address is `http://127.0.0.1:1234`. Copy the loaded model identifier from the server or from the `id` field in its model list.

```sh
curl http://127.0.0.1:1234/v1/models
npm run clydie -- --controller lmstudio --model '<loaded-model-id>' --seed 17 --max-commands 60
```

Use `--endpoint http://127.0.0.1:PORT` for a different server address. A base URL ending in `/v1` also works. Clydie posts to `/v1/chat/completions` with the shared action schema in `response_format.json_schema`. Every reply still passes through the host action parser. Set the context window when loading the model in LM Studio. The CLI sends `--tokens` as `max_tokens`.

The command prints the run directory, a behavioral summary and a motor replay result. Each run gets a new directory under `runs/clydie/`, ignored by Git. It contains `episode.json` and a separate `experiment.json` in the ordinary Origami Lab format. Use `--output DIR` to choose a different parent. To give Clydie a previously saved sheet, pass `--initial PATH/experiment.json`. The host verifies that file by import. Memory always starts empty.

## Inspect, replay and continue

These commands use a saved demonstration record and work with the model server stopped. Use a new filename for each export.

```sh
npm run clydie -- inspect docs/verification/clydie-v0/a.json.gz
npm run clydie -- replay docs/verification/clydie-v0/b.json.gz --export baseline-paper.json
npm run dev
```

**Inspect** shows the exact proposed action and note, any error, each motor position and its sensations, validation reasons, the final notebook and counts. The full JSON also includes the precise view before each decision. A note belongs to the decision that proposed the action, so it can only refer to experience available earlier.

**Replay** applies the recorded inputs to a fresh tactile session from the saved starting experiment. It checks the feedback and canonical experiment against the record using `replayTactileTrajectory`. The model takes no part in replay. A repeated live inference run can make different choices even with the same seed.

**Continue** by choosing **Import** in the existing playground and loading the run's `experiment.json` or the file produced by `replay --export`. Inspect the geometry, use the history controls, manipulate the sheet and export again. The episode file contains the decision history and is read by the CLI.

## Controls

| CLI option | Default | Meaning |
| --- | --- | --- |
| `--controller`, `--model` | `ollama`, model required | Select `ollama`, `lmstudio` or `random`. Supply the installed model identifier for either model provider. |
| `--endpoint` | Loopback port 11434 (Ollama) or 1234 (LM Studio) | Model server base URL. Both providers send the same prompt and tactile view. |
| `--seed` | 1 | Integer 0–2147483647. Sets the baseline generator or the requested model sampling seed. |
| `--temperature`, `--top-p` | 0.7, 0.9 | Model sampling parameters. |
| `--tokens`, `--context` | 128, 4096 | Maximum generated tokens per reply (1–512) and Ollama context window (512–16384). The episode output budget is at most decisions × tokens with a conforming provider. |
| `--max-commands`, `--max-decisions` | 100, 100 | Independent limits, each 1–2048. Invalid replies consume a decision. Interpolated movements each consume one motor command. |
| `--duration-ms`, `--timeout-ms` | 600000, 30000 | Wall-clock limits for the episode and each model request, including model loading. |
| `--step`, `--pixels-per-unit` | 0.125, 400 | Maximum length per interpolated move (0.01–1 sheet units) and virtual scale (32–4096 pixels per unit). |
| `--recent-limit`, `--notebook-limit` | 6, 6 | Most recent motor/observation pairs (1–16) and model-written notes (0–16) retained in the next view. |
| `--trajectory-limit` | 2048 | Native tactile recorder's command capacity, 0–2048. Its independent 4096-event cap also applies. |

A model can choose `stop`. The host can stop on a command or decision limit, elapsed time, provider failure, or Ctrl-C. The record distinguishes these endings. A malformed action is saved verbatim and followed by a short format correction on the next budgeted decision. A transport failure or timeout ends the episode immediately. A malformed provider envelope is kept up to 64 KiB with an explicit truncation flag for larger replies.

## What the controller can experience

The provider sends two messages per request. The fixed system message gives a blank-sheet invitation, the action vocabulary, coordinate conventions and the meanings of sensations. The user message contains only the hand’s motor position and current mode (`handMode` is `idle`, `tracing` or `dragging`), recent motor actions and observations, notebook and any format correction. The system message and JSON schema are saved verbatim in model records. The controller receives detached data. The isolated model service has no handle to the session or host tools. A custom JavaScript controller, like other code running in the Node process, is trusted code. [Protocol and prompt](../src/clydie/protocol.ts)

- `beginDrag` and `beginTrace` place the hand directly. `move` follows a straight line in equal steps from the current motor position. Each requires `at` with finite numeric `x` and `y` in [−1, 2]. The original sheet spans [0, 1] on each axis, with y increasing upwards.
- `release`, `mark`, `flip` and `unfold` issue the corresponding hand command. They take no coordinates. `stop` ends deliberation without touching the paper. The host validates the whole reply before execution.
- Each executed command contributes a position, proximity, contact class, snap state and validation status when present. The view retains up to the last eight events per command and reports how many were omitted. Contact class, snap constraint class and resistance status are the only event details passed through. Event coordinates, hidden target coordinates, identities, shapes and diagnostic reasons stay with the host. Vision is absent.
- Movement interpolation uses only the starting motor position and requested destination. It follows the path until completion or a host limit. The underlying tactile hand handles surface sampling, snapping, gesture interpretation and validation.
- An optional note has a `kind` of `observation` or `conjecture` and up to 240 characters of `text`. The controller chooses both. Old notes drop out of working memory in insertion order. They remain in the episode record. The host never grades notes or supplies discoveries.

While tracing, `move` samples the path to the next position. Repeating
`beginTrace` at the same position consumes a motor command and reports the
current sensation with zero new events. A trace start elsewhere lifts and
repositions the finger. [Stationary-trace verification](verification/tracing-continuity.md)

A sensing finger can trace without gripping. A drag start yields `grip-acquired`
and dragging mode, or `grip-failed` and idle mode. After a failed grip, moving
only changes the hand position. An acquired grip can still encounter resistance
on a move or release. The model sees the grip event and any verdict status.
The host retains the original diagnostic, including `no-grab` and its native
resistance event. The diagnostic summary counts those native events.

During tracing, an optional `landmark: {kind, intensity}` signals a nearby exposed
corner, intersection or mark. It is local to the current motor sample. The
ordinary contact and proximity fields remain available. Sensing a feature
does not affect the path or establish a grip. [Tactile ranges and contact precedence](TACTILE.md)

The v0.2 comparison uses the original Qwen choices as a control and supports a
fresh, matched LM Studio episode. [Baseline measurements, limits and commands](verification/clydie-v02.md)

The random baseline samples positions uniformly from the original unit square. At rest it starts a trace or a drag with equal probability within an 88% chance of starting a bout. The remaining choices split evenly between flip and unfold. During a bout it normally moves (62%) or releases. At a felt intersection a 25% chance of marking comes out of the move probability. A rejected grab returns the policy to rest. The baseline generates no notes and uses the host budget to end. Its decisions, including these feedback rules, are part of the experimental condition. [Controllers](../src/clydie/controllers.ts)

## Record layout

| Field | Contents |
| --- | --- |
| `version`, `controller`, `settings`, `started`, `elapsedMs` | Version 1 of the Clydie v0 harness protocol, controller and seed, model tag, prompt, schema and generation options where applicable, all limits and timing. |
| `initial`, `experiment` | Full starting and final canonical experiments, including the Origamio revision and numerical policy. |
| `decisions[]` | Exact presented view, raw model content when available, generated token count when reported, validated choice or diagnostic, and a zero-based `motorStart` and `motorCount`. |
| `trajectory`, `overflow` | The native tactile log plus any subsequent host diagnostic entries. Each pairs a motor command with its complete feedback. Decision ranges index the concatenation. |
| `notebook`, `ending`, `summary` | Final bounded notebook, reason for stopping and post-episode measures. |

A budget can end a planned move partway through. The requested endpoint stays in the decision. Only issued motor commands enter the log. A full or disabled recorder with missing motor entries produces an explicitly incomplete trajectory. The diagnostic overflow preserves what the host experienced. The replay command reports `incomplete` and exits unsuccessfully in that case.

LM Studio records the requested model, generation parameters and exact response format under `controller`. Each decision with returned message content also keeps the reported completion ID, served model, finish reason and token usage in `responseMetadata` when supplied. These fields stay in the host record. Older episodes retain their original views and replay as before.

The summary counts contact acquisitions, snap acquisitions, resistance events and validation statuses per motor command. A draft movement can encounter resistance without committing an operation. The separate canonical history shows which operations entered the sheet's history. The runner computes these measures after the episode and never sends them to the controller.

## Verification

`npm test` runs the mock-provider, boundary, timeout, replay and common-path tests alongside the folding and tactile suites. `npm run test:browser` includes import and human continuation of a saved model episode. The independent audit can also inspect an exported sheet with `python3 -B scripts/audit_experiment.py experiment.json`.

For an **optional real local-model integration test**, start Ollama with an installed model, then run the following. Set `CLYDIE_ENDPOINT` as well if the service uses a different address. This checks for a validated reply and verifies motor replay within four decisions and four motor commands. It runs separately from CI.

```sh
npm run preclydie
CLYDIE_MODEL=smollm2:360m node scripts/test-clydie-local.mjs
```

To run the same manual integration check against a loaded LM Studio model, use its identifier below. The test calls the local server, requires a valid action or stop decision, and verifies motor replay.

```sh
npm run preclydie
CLYDIE_PROVIDER=lmstudio CLYDIE_MODEL='<loaded-model-id>' node scripts/test-clydie-local.mjs
```
