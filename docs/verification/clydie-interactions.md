# Compare Clydie’s LM Studio interactions

## Establish the model configuration

Load `qwen/qwen3-4b-2507` with a 4096-token context and start the LM Studio server. Check its exact instance ID with `curl http://127.0.0.1:1234/v1/models`. Check the loaded model’s hammer badge in the app and inspect a tool request with `lms log stream`. LM Studio documents the badge as native support. Its Default formatter supplies a tool-use prompt and can translate tool results into user messages. A successful API call alone cannot identify which template ran. [LM Studio tool-use documentation](https://lmstudio.ai/docs/developer/openai-compat/tools)

Create `studio-info.json` outside the repository or under the ignored `runs/` directory. Fill in the observed LM Studio version, artifact/quantization, runtime, loaded context and any template override. Set `toolSupport` to `native` or `default` only with evidence for the loaded configuration. Keep `unverified` when evidence is unavailable. This file supplies operator observations to the record. Server-reported model, fingerprint and usage appear separately under each response.

```json
{
  "version": "<installed LM Studio version>",
  "modelConfiguration": {
    "artifact": "<exact model file and quantization>",
    "runtime": "<loaded runtime and version>",
    "context": 4096,
    "template": "<active template or override>",
    "toolSupportEvidence": "<badge or template log observation>"
  },
  "toolSupport": "unverified"
}
```

## Run the comparison

From the repository root, set `studio_info` to that file. This shell loop creates three fresh runs from the default square using the same motor step, virtual scale, decision limit and sampling settings. The tool condition uses ordinary function decoding. The two JSON conditions use a response schema. These decoding constraints and message layouts are part of the intervention.

```sh
npm ci
npm run preclydie
studio_info=/path/to/studio-info.json
comparison=$(mktemp -d)
for mode in structured motor-json native-tools; do
  node scripts/run-clydie.mjs --controller lmstudio --interaction "$mode" \
    --model qwen/qwen3-4b-2507 --context 4096 --seed 17 --temperature 0.7 \
    --top-p 0.9 --tokens 128 --max-commands 40 --max-decisions 100 \
    --step 0.125 --pixels-per-unit 400 --lmstudio-info "$studio_info" \
    --output "$comparison/$mode"
done
node scripts/compare-clydie.mjs --report "$comparison"/*/*/episode.json > "$comparison/report.json"
```

A shorter live smoke check uses `CLYDIE_PROVIDER=lmstudio CLYDIE_INTERACTION=native-tools CLYDIE_MODEL=qwen/qwen3-4b-2507 node scripts/test-clydie-local.mjs` after the build. Use the full runs to evaluate behavior. For each mode, inspect the exact recorded prompt, schema or tool definitions, requested output and input budget, and reported prompt/completion tokens. Check the served model ID against the loaded instance. Record a distinct condition if you adjust the token cap after seeing truncated calls. Keep failed and early-stopping episodes.

## Read the evidence

The report verifies the three episodes offline and checks their starting paper, model, sampling options, limits and recorded load configuration. For a detailed timeline, run `node scripts/run-clydie.mjs inspect PATH/episode.json`. Use `replay PATH/episode.json` on the same CLI to verify a single recording.

| Question | Evidence to compare |
| --- | --- |
| What actions occurred? | Distinct requested positions and realized motor positions, position-changing move commands, consecutive repeated choices, grip attempts and grip sites. Interpolation can yield several commands per choice. |
| What did the hand encounter? | Contact classes, landmarks, snap events, grip acquisitions/failures and resistance from the trajectory. Track events along a move as well as at its endpoint. |
| Did the next action depend on feedback? | Compare next actions after changed and repeated readings in comparable hand states, including what follows failed grips. Read the complete tool result or bounded view that preceded the choice. Treat observed associations in a single run as descriptive. |
| Did narration exceed the evidence? | Inspect notes, invalid replies and diagnostic assistant text. For each sensory claim, check the host evidence available **before** that decision. Count unsupported claims and decisions containing them separately from executed actions. Record interpretations or ambiguous claims separately. A silent decision supplies no narrative claim. |
| Did the protocol work? | Valid choices, malformed replies, provider errors, per-decision latency, finish reasons, actual token use and ending. Separate a valid explicit stop from exhaustion without a valid choice. |

These measures are computed offline. A difference in prose, distance traveled or completed folds alone cannot establish whether feedback influenced the next choice. Automated tests use mocked completions. Behavioral conclusions require the local model recordings.
