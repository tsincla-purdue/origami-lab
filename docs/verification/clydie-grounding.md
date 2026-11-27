# Grounded sensing and inquiry in Clydie v0.3

An experiment can now show exactly what the hand reported before Clydie wrote a remark. Episode version 2 stores each executed motor step with projected feedback, a literal delta and an index. The host builds its sensory memory from those readings. A model-authored question, conjecture or reflection has its own notebook and a host-assigned time stamp. Free text can still make unsupported claims. Review those claims against the preceding readings. [Design rationale in PR #39](https://github.com/tsincla-purdue/origami-lab/pull/39)

## Matched local comparison

Load `qwen/qwen3-4b-2507` in LM Studio with a **4096-token context**. From the repository root, run the following with Node 24 or newer.

```sh
npm ci
npm run clydie -- --controller lmstudio --model qwen/qwen3-4b-2507 --seed 17 --max-commands 40 --temperature 0.7 --top-p 0.9 --tokens 128 --timeout-ms 60000
```

For an exact match to a saved LM Studio baseline, including its initial sheet and all episode limits, use the original JSON on the server machine.

```sh
npm run preclydie
node scripts/compare-clydie.mjs /path/to/baseline/episode.json --live
npm run clydie -- inspect /path/to/new/episode.json
npm run clydie -- replay /path/to/new/episode.json
```

The live comparison starts with empty working memory. Each provider sends the same invitation, measurement contract and action schema. Each returns one choice per request. `--fixed-choices` is a separate offline control. When importing accepted v1 choices into that control, it copies the motor action and leaves legacy notes in the source file.

**Grounding.** For each note at index *n*, compare its claims with the recorded view before *n*. A zero proximity reading reports absence of a local signal. The host cannot measure stiffness or texture. A reflection asserting either needs independent evidence. Keep questions and explicitly tentative guesses identifiable during review.

**Exploration.** Compare sites visited, grip outcomes, traces versus repositioning, and choices following reported transitions. A shorter notebook by itself supplies no evidence of better grounding. Live behavioral results for v0.3 require the locally hosted model.

## Prompt budget

The following are offline maxima over all decision inputs. The first condition runs the seeded random controller (seed 17). The second repeats a stationary surface trace with a 240-character CJK note per decision. Each saved view was serialized as the provider sends it, paired with the exact system prompt and encoded using the Qwen3 tokenizer (`@lenml/tokenizer-qwen3` 3.7.2, ChatML system/user turns and assistant generation prefix). The tokenizer was used for measurement only.

| Condition | 40 motor commands | 100 motor commands |
| --- | ---: | ---: |
| Seeded random | 1,178 tokens | 1,189 tokens |
| Stationary with maximum-length notes | 854 tokens | 854 tokens |

The runner separately enforces a conservative UTF-8 byte bound on the two message contents. With byte-level BPE this reserves 128 tokens for template framing and 128 for the requested completion at context 4096. Nonstandard server templates or generation limits can change those reservations. The full record remains available to the host. [Memory and replay rules](../CLYDIE.md)
