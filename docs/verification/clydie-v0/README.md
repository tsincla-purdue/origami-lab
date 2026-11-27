# Clydie's first three tactile episodes

Both local-model episodes spent all 60 motor commands touching the edge at (0, 0). The random baseline used the same budget on traces, attempted drags, moves and releases. All three ended with the original one-facet sheet, zero creases and zero marks.

| Blank-sheet episode | Seed | Decisions / motor commands | Contact acquisitions | Snap / resistance events | Notes |
| --- | ---: | ---: | --- | ---: | ---: |
| [A · SmolLM2](a.json.gz) | 17 | 60 / 60 | 60 edge | 0 / 0 | 2 |
| [B · random](b.json.gz) | 17 | 33 / 60 | 8 surface | 0 / 7 | 0 |
| [C · SmolLM2](c.json.gz) | 43 | 60 / 60 | 60 edge | 0 / 0 | 4 |

Each link contains the complete episode JSON compressed with gzip. All three reached the motor limit with zero invalid decisions. Motor replay reproduced every recorded feedback entry and each canonical experiment. Each of the three canonical exports also passed the independent Python audit.

## What happened

**A and C.** Every decision requested `beginTrace` at (0, 0). Each new trace lifted the previous probe and acquired the same edge again. No model decision requested a move, grab, release or mark. In A, the first note said, “I started touching the paper and moved it without releasing.” The model wrote this before its first action, with an empty sensory history. The third decision repeated the note. In C, the four notes restated coordinate conventions from the prompt. The two seeds produced identical motor and sensory histories but different words.

**B.** The baseline proposed eight traces, seven drags, ten moves and eight releases. The ten moves expanded into 37 motor commands, including the first step of a final path cut short by the budget. Six drag starts were rejected with `no-grab`. One command returned an unverified `unsolved-gesture` verdict. No command received an accepted verdict and the canonical operation history stayed empty. For example, after the first rejected drag the policy started a trace at a new position. That reaction is built into the baseline.

**Interpretation.** The two model runs show a recurring action at one known position. Their traces offer no evidence that a sensation influenced the next target, that Clydie intentionally compared conditions or that she reused a geometric relationship. The baseline covered more positions and elicited different feedback. Its movement policy already accounts for some of that difference. The notes can be checked against the timeline, especially when a claim precedes the experience it describes.

## Conditions and reproduction

Each run started a fresh episode on the same untouched square, with empty memory, tactile feedback only and no shape objective. Both controllers used the same prompt-independent motor runner, 0.125-unit maximum move step, 400 virtual pixels per sheet unit, six recent motor observations and six notebook slots. Limits were 60 motor commands, 100 decisions, 600 seconds per episode and 30 seconds per provider response. The trajectory recorder was enabled at its full 2048-command capacity.

Live inference used Ollama 0.6.8 on a local CPU (four model threads), with SmolLM2-360M-Instruct quantized as Q4_K_M. Sampling used temperature 0.7, top-p 0.9, 128 output tokens per decision and a 4096-token context. A generated 1461 tokens and C generated 1560. The complete model prompt, output schema, options and per-decision messages are recoverable from the two records.

The local tag was `smollm2-360m-clydie`, created from the GGUF in `ai/smollm2:360m-q4_K_M` with a ChatML role template, stop strings `<|im_start|>` and `<|im_end|>` and four CPU threads. GGUF SHA-256 was `16c7f1667fea34bacad196a57b548effcb37614db4ab5677a20c8c7b823b9e63`. The saved tag's Ollama digest was `1a7edff7ec9fa50ab317e2161a47c4c2348d79dcb478c001d7953d8ded99b8c3`.

During instrument checkout an earlier output schema allowed coordinate-bearing actions to omit their position. With each seed, every one of 100 proposals was rejected and zero motor commands ran. We corrected the schema to require a position for those three actions and repeated the same two seeds. The table contains the first runs under the corrected schema. The runtime validator remained in force throughout.

To inspect the actual decisions, replay the exact motor inputs and export an ordinary playground file, run these commands from the repository root. For a new live run, substitute any installed Ollama tag. New inference may produce different behavior. [Setup and controls](../../CLYDIE.md)

```sh
npm run clydie -- inspect docs/verification/clydie-v0/a.json.gz
npm run clydie -- replay docs/verification/clydie-v0/c.json.gz --export clydie-paper.json
npm run clydie -- --controller random --seed 17 --max-commands 60
```
