// Manual integration check. Build with npm run preclydie and set CLYDIE_MODEL first.
import assert from 'node:assert/strict';
import {lmstudioController, ollamaController, replayEpisode, runEpisode} from '../.clydie-build/episode.js';

const provider = process.env.CLYDIE_PROVIDER ?? 'ollama';
assert.ok(['ollama', 'lmstudio'].includes(provider), 'Choose ollama or lmstudio for CLYDIE_PROVIDER.');
const createController = provider === 'lmstudio' ? lmstudioController : ollamaController;
const controller = createController(process.env.CLYDIE_MODEL ?? '', {endpoint: process.env.CLYDIE_ENDPOINT});
const episode = await runEpisode(controller, {maxCommands: 4, maxDecisions: 4, durationMs: 120000});
assert.ok(!['provider-error', 'model-timeout', 'duration'].includes(episode.ending), episode.decisions.at(-1)?.error ?? episode.ending);
assert.ok(episode.decisions.some(d => d.choice), 'No valid local model choice in four decisions.');
assert.equal(replayEpisode(episode).status, 'verified');
console.log(episode.controller.model, episode.ending, episode.decisions.length, 'decisions, verified motor replay');
