// Build with npm run preclydie. Both inputs and outputs are ordinary Clydie episode records.
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {importExperiment, observe, lmstudioController, replayEpisode, runEpisode, serializeExperiment, summarize} from '../.clydie-build/episode.js';

function behavior(record) {
  const motors = [...record.trajectory.entries, ...record.overflow];
  const positions = new Set(), destinations = new Set(), gripSites = new Set();
  const sensoryEvents = {};
  let acquired = 0, failed = 0, relocated = 0, same = 0, completed = 0;
  let grip = false, moved = false, failedAt;
  for (const decision of record.decisions) {
    if (decision.choice?.at && decision.motorCount) {
      const target = JSON.stringify([decision.choice.at.x, decision.choice.at.y]);
      destinations.add(target);
      if (failedAt !== undefined) {
        if (failedAt === target) same++;
        else relocated++;
        failedAt = undefined;
      }
    }
    for (const {command, feedback} of motors.slice(decision.motorStart, decision.motorStart + decision.motorCount)) {
      const position = JSON.stringify([feedback.motor.x, feedback.motor.y]);
      positions.add(position);
      const events = record.trajectory.version === 1 ? feedback.events.slice(-8) : observe(feedback, command).events;
      for (const event of events) sensoryEvents[event.kind] = (sensoryEvents[event.kind] ?? 0) + 1;
      switch (command.kind) {
        case 'drag':
          grip = feedback.validation?.code !== 'no-grab';
          moved = false;
          gripSites.add(position);
          if (grip) acquired++;
          else { failed++; failedAt = position; }
          break;
        case 'move': if (grip) moved = true; break;
        case 'release':
          if (grip && moved) completed++;
          grip = false;
          break;
        case 'trace': case 'flip': case 'unfold': grip = false; break;
      }
    }
  }
  return {...summarize(record), motorPositions: positions.size, requestedLocations: destinations.size,
    gripLocations: gripSites.size, sensoryEvents, acquired, failed, nextPositionAfterFailure: {changed: relocated, same},
    gripMoveRelease: completed, notes: record.decisions.flatMap((d, i) => d.choice?.note ? [{decision: i + 1, ...d.choice.note}] : [])};
}

const [file, condition] = process.argv.slice(2);
if (!file || !['--live', '--fixed-choices'].includes(condition)) {
  throw new Error('Usage: node scripts/compare-clydie.mjs baseline-episode.json --fixed-choices|--live');
}
const baseline = JSON.parse(await readFile(file, 'utf8'));
if (baseline.controller.type !== 'lmstudio' || replayEpisode(baseline).status !== 'verified') {
  throw new Error('Expected a complete replayable LM Studio baseline.');
}
const {model, options} = baseline.controller;
const live = condition === '--live';
let i = 0;
const controller = live ? lmstudioController(model, {endpoint: process.env.CLYDIE_ENDPOINT, seed: options.seed,
  temperature: options.temperature, topP: options.top_p, tokens: options.max_tokens}) : {
  metadata: {type: 'fixed-choices', sourceModel: model, sourceStarted: baseline.started},
  async decide() {
    const raw = baseline.decisions[i++]?.raw;
    if (raw === undefined) throw new Error('Historical decision stream exhausted.');
    return {raw};
  },
};
const episode = await runEpisode(controller, baseline.settings, importExperiment(JSON.stringify(baseline.initial)));
const summary = summarize(episode);
await mkdir('runs/clydie', {recursive: true});
const path = await mkdtemp(join('runs/clydie', live ? 'matched-' : 'fixed-choices-'));
await writeFile(join(path, 'episode.json'), JSON.stringify({...episode, summary}, null, 2));
await writeFile(join(path, 'experiment.json'), serializeExperiment(episode.experiment));
console.log(path);
console.log(JSON.stringify({baseline: behavior(baseline), condition, current: behavior(episode), replay: replayEpisode(episode).status}, null, 2));
if (['provider-error', 'model-timeout'].includes(episode.ending)) {
  console.error(episode.decisions.at(-1).error);
  process.exitCode = 1;
}
