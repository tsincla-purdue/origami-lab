// Build with npm run preclydie. Both inputs and outputs are ordinary Clydie episode records.
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
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

// Offline comparison. Retain the unit of observation: one decision and the evidence available before it.
async function report(files) {
  if (files.length !== 3) throw new Error('Supply one episode.json per LM Studio interaction.');
  const records = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
  const modes = new Set(records.map(r => r.controller.interaction ?? 'structured'));
  if (modes.size !== 3 || records.some(r => r.controller.type !== 'lmstudio' || replayEpisode(r).status !== 'verified')) {
    throw new Error('Expected three verified LM Studio episodes with distinct interactions.');
  }
  const configuration = r => [r.initial, r.settings, r.controller.model, r.controller.options,
    r.controller.context, r.controller.serverInfo?.version, r.controller.serverInfo?.modelConfiguration];
  for (const r of records) {
    if (!isDeepStrictEqual(configuration(r), configuration(records[0]))) throw new Error('Run configurations differ.');
  }
  return records.map(r => {
    const decisions = r.decisions.map((d, index) => {
      const {note, ...action} = d.choice ?? {};
      const raw = r.controller.interaction === 'native-tools' && d.raw ? JSON.parse(d.raw) : undefined;
      return {index, beforeMotorIndex: d.motorStart, precedingSense: d.view.recent.at(-1)?.sense,
        action: d.choice && action, executedCommands: d.motorCount, latencyMs: d.latencyMs,
        modelText: note?.text ?? raw?.content ?? (!d.choice ? d.raw : undefined), error: d.error};
    });
    const entries = r.trajectory.entries;
    const moved = entries.filter(({command, feedback}, i) => {
      const from = i ? entries[i - 1].feedback.motor : {x: 0, y: 0};
      return command.kind === 'move' && (from.x !== feedback.motor.x || from.y !== feedback.motor.y);
    });
    const repeated = decisions.filter((d, i) => i && d.action && isDeepStrictEqual(d.action, decisions[i - 1].action));
    return {interaction: r.controller.interaction, toolSupport: r.controller.serverInfo?.toolSupport,
      ...behavior(r), validChoices: decisions.filter(d => d.action).length, changedPositionMoves: moved.length,
      consecutiveRepeatedChoices: repeated.length, decisions};
  });
}

if (process.argv[2] === '--report') {
  console.log(JSON.stringify(await report(process.argv.slice(3)), null, 2));
} else {
  await compareBaseline(...process.argv.slice(2));
}

async function compareBaseline(file, condition) {
  if (!file || !['--live', '--fixed-choices'].includes(condition)) {
    throw new Error('Usage: node scripts/compare-clydie.mjs baseline-episode.json --fixed-choices|--live');
  }
  const baseline = JSON.parse(await readFile(file, 'utf8'));
  if (baseline.controller.type !== 'lmstudio' || replayEpisode(baseline).status !== 'verified') {
    throw new Error('Expected a complete replayable LM Studio baseline.');
  }
  if (baseline.version >= 3) throw new Error('Use --report for the motor-only comparison.');
  const {model, options} = baseline.controller;
  const live = condition === '--live';
  let i = 0;
  const controller = live ? lmstudioController(model, {endpoint: process.env.CLYDIE_ENDPOINT, seed: options.seed,
    temperature: options.temperature, topP: options.top_p, tokens: options.max_tokens}) : {
    metadata: {type: 'fixed-choices', sourceModel: model, sourceStarted: baseline.started},
    async decide() {
      const decision = baseline.decisions[i++];
      // Retain v1 motor choices without attributing historical notes to the v2 inquiry channel.
      if (baseline.version === 1 && decision?.choice?.note) {
        const {note, ...action} = decision.choice;
        return {raw: JSON.stringify(action)};
      }
      const raw = decision?.raw;
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
}
