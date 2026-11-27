# Clydie v0.2 on the Qwen centerline trace

On the supplied v0.1 recording, Qwen attempted seven grips at two interior positions. Each attempt left its hand empty. Under v0.2, passing those same decisions through the current runner changed all seven model-facing events from resistance to grip failure. Every issued motor command and the final canonical sheet matched the baseline.

| Measurement | Recorded v0.1 Qwen | v0.2 with choices held fixed |
| --- | ---: | ---: |
| Decisions / motor commands | 25 / 40 | 25 / 40 |
| Distinct requested positions / issued motor endpoints | 9 / 14 | 9 / 14 |
| Surface contact acquisitions | 5 | 5 |
| Edge / corner / crease / intersection acquisitions | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Successful / failed grips | 0 / 7 | 0 / 7 |
| Next positioned decision changed / repeated failed grip location | 4 / 3 | 4 / 3 |
| Completed grip–move–release sequences / committed operations | 0 / 0 | 0 / 0 |
| Model-facing resistance / grip-failed events | 7 / 0 | 0 / 7 |

Distinct positions are exact coordinate pairs. Motor endpoints include interpolated moves. The changed-location count compares each failed grab with the next executed positioned decision. Looking specifically at subsequent **grabs**, five of the six retries returned to the previous grip site. Five grabs targeted (0.5, 0.5) and two targeted (0.5, 0.75). The hand reached y = 0 while idle. It acquired no boundary contact there.

The note at decision 3 described uniform surface texture. The trace supports repeated surface contact, but the sampler does not measure texture. Notes at decisions 19 and 24 attributed resistance to stiffness or edge tension. Each was written before its proposed grab, and the earlier diagnostics showed failed acquisition. The fixed-choice condition copies these notes verbatim. It cannot establish how the model would interpret the revised feedback.

## Reproduce the comparison

The source file was the supplied `episode.json` (SHA-256 `a66279b4273d7bb08729e958ed65f199736b9d5ca9b110f9a4f9c4dace555f6c`). The LM Studio model identifier was `qwen/qwen3-4b-2507`. Seed 17, temperature 0.7, top-p 0.9 and a 128-token reply limit were recorded. The runner allowed 40 commands, 100 decisions, ten minutes per episode and 60 seconds per request. It used a 0.125-unit step, 400 pixels per unit and six slots each for recent experience and notebook entries.

From the repository root, supply the path to the original episode. The first comparison requires no server. For the second, load the same model and server-side configuration in LM Studio on the machine running the command. The server address defaults to loopback port 1234 and can be set with `CLYDIE_ENDPOINT`.

```sh
npm ci
npm run preclydie
node scripts/compare-clydie.mjs /path/to/episode.json --fixed-choices
node scripts/compare-clydie.mjs /path/to/episode.json --live
```

Both commands verify historical replay, copy the initial sheet and limits, create fresh working memory, save the new episode under `runs/clydie/`, and print both behavioral summaries with decision-indexed notes. The live command copies the recorded model and generation settings. Review notes against each decision's preceding sensory view. The baseline omits the model file digest, quantization and loaded context length, so exact model identity also depends on the local installation.

## Verification and open question

The build, all 181 unit tests, all 65 Chromium tests (including browser export auditing), and all 11 independent audit tests passed locally. Tests cover grip acquisition and failure, resistance after acquiring a grip, increasing corner intensity along an already saturated edge, approach along a retained crease, a displaced flap corner before and after turnover, covered features and observation field filtering. Frozen records from both historical harness versions exercise version 1 motor replay. The small scripted v0.1 fixture was recorded on commit `b5cc1c4`.

The original file replayed successfully in its historical mode. The fixed-choice result also passed independent motor replay under sensory version 2. A fresh Qwen run requires the user's local LM Studio server. Whether the richer sensations change the model's exploration or its notebook remains open.
