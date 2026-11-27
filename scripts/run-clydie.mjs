import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {parseArgs} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {defaults, observe, lmstudioController, importExperiment, ollamaController, randomController, replayEpisode, runEpisode,
  serializeExperiment, summarize} from '../.clydie-build/episode.js';

const options = Object.fromEntries([
  'controller', 'interaction', 'lmstudio-info', 'model', 'endpoint', 'seed', 'temperature', 'top-p', 'tokens', 'context',
  'max-commands', 'max-decisions', 'duration-ms', 'timeout-ms', 'step', 'pixels-per-unit',
  'trajectory-limit', 'sensory-limit', 'recent-limit', 'notebook-limit', 'initial', 'output', 'export',
].map(key => [key, {type: 'string'}]));
options.help = {type: 'boolean'};
const {values, positionals} = parseArgs({options, allowPositionals: true});
const number = (name, fallback) => values[name] === undefined ? fallback : Number(values[name]);
async function loadRecord(path) {
  const bytes = await readFile(path);
  return JSON.parse(path.endsWith('.gz') ? gunzipSync(bytes).toString() : bytes.toString());
}

function inspect(record) {
  const motors = [...record.trajectory.entries, ...record.overflow];
  console.log('Controller', record.controller.type, record.controller.model ?? record.controller.policy, 'seed', record.controller.seed ?? record.controller.options?.seed);
  if (record.controller.type === 'lmstudio') console.log('Interaction', record.controller.interaction ?? 'structured', record.controller.serverInfo ?? '');
  console.log('Tactile trajectory', record.trajectory.truncated ? 'incomplete' : 'complete');
  for (const [i, d] of record.decisions.entries()) {
    console.log(`\nDecision ${i + 1} before motor ${d.motorStart}`);
    if (record.version >= 2) {
      console.log('Observed (host), before choice', JSON.stringify(d.view.sensoryMemory));
      console.log('Recent executed steps and deltas', JSON.stringify(d.view.recent));
      if (record.version === 2) console.log('Inquiry (model), visible before choice', JSON.stringify(d.view.inquiryNotebook));
    }
    console.log(record.controller.interaction === 'native-tools' ? 'Tool request (model, raw message)' : 'Controller reply', d.raw ?? '(no reply)');
    if (d.tool) console.log('Tool feedback (host)', d.tool.result.tool_call_id, d.tool.result.content);
    if (d.choice?.note) console.log('Inquiry (model), before motor', d.motorStart, d.choice.note);
    if (d.error) console.log('  Error', d.error);
    for (let index = d.motorStart; index < d.motorStart + d.motorCount; index++) {
      const {command, feedback} = motors[index];
      const felt = record.trajectory.version === 1 ? feedback.events : observe(feedback, command).events;
      const events = felt.map(e => [e.kind, e.contact ?? e.constraint].filter(Boolean).join(' '));
      console.log('  Observed (host), motor', index, command.kind, JSON.stringify(feedback.motor), feedback.contact ?? '', 'proximity', feedback.proximity.toFixed(2),
        feedback.landmark ? `${feedback.landmark.kind} intensity ${feedback.landmark.intensity.toFixed(2)}` : '',
        feedback.snapped ? 'snapped' : '', ...events, feedback.validation?.status ?? '');
      if (feedback.validation) console.log('  Host diagnostic', feedback.validation.code, feedback.validation.reason);
    }
  }
  if (record.version >= 2) console.log('\nFinal observed (host)', record.sensoryMemory);
  if (record.version <= 2) console.log(record.version === 1 ? 'Legacy notebook (model-authored)' : 'Final inquiry (model)',
    record.version === 1 ? record.notebook : record.inquiryNotebook);
  console.log(JSON.stringify(summarize(record), null, 2));
}

async function main() {
  if (values.help) {
    console.log('npm run clydie -- --controller ollama --model TAG [--seed N] [--output DIR]');
    console.log('npm run clydie -- --controller lmstudio --model ID [--interaction structured|motor-json|native-tools] [--endpoint URL]');
    console.log('npm run clydie -- --controller random [--seed N] [--max-commands N]');
    console.log('npm run clydie -- inspect FILE | replay FILE [--export NEW_FILE]');
    console.log('All controls and defaults are documented in docs/CLYDIE.md.');
    return;
  }
  const [mode = 'run', path] = positionals;
  if (mode === 'inspect' || mode === 'replay') {
    if (!path || positionals.length !== 2) throw new Error('Supply the path to an episode.json or episode.json.gz.');
    const record = await loadRecord(path);
    if (mode === 'inspect') return inspect(record);
    const result = replayEpisode(record);
    console.log('Motor replay', result.status);
    if (result.status !== 'verified') { process.exitCode = 1; return; }
    if (values.export) await writeFile(values.export, serializeExperiment(record.experiment), {flag: 'wx'});
    return;
  }
  if (mode !== 'run' || path) throw new Error('Use run, inspect FILE, or replay FILE.');
  const seed = number('seed', 1);
  const type = values.controller ?? 'ollama';
  const options = {endpoint: values.endpoint, seed, temperature: number('temperature', .7),
    topP: number('top-p', .9), tokens: number('tokens', 128)};
  if (type !== 'lmstudio' && (values.interaction !== undefined || values['lmstudio-info'] !== undefined)) {
    throw new Error('--interaction and --lmstudio-info apply to LM Studio.');
  }
  let controller;
  switch (type) {
    case 'random': controller = randomController(seed); break;
    case 'ollama': controller = ollamaController(values.model ?? '', {...options, context: number('context', 4096)}); break;
    case 'lmstudio':
      controller = lmstudioController(values.model ?? '', {...options, interaction: values.interaction,
        context: number('context', 4096), serverInfo: values['lmstudio-info']
          ? JSON.parse(await readFile(values['lmstudio-info'], 'utf8')) : undefined});
      break;
    default: throw new Error('Choose ollama, lmstudio or random.');
  }
  const config = Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
    [key, number(key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value)]));
  const initial = values.initial ? importExperiment(await readFile(values.initial, 'utf8')) : undefined;
  const root = resolve(values.output ?? 'runs/clydie');
  await mkdir(root, {recursive: true});
  const directory = await mkdtemp(join(root, `${type}-${seed}-`));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  let episode;
  try { episode = await runEpisode(controller, config, initial, abort.signal); }
  finally { process.off('SIGINT', stop); }
  const summary = summarize(episode);
  await writeFile(join(directory, 'episode.json'), JSON.stringify({...episode, summary}, null, 2));
  await writeFile(join(directory, 'experiment.json'), serializeExperiment(episode.experiment));
  console.log(directory);
  console.log(JSON.stringify({...summary, motorReplay: replayEpisode(episode).status}, null, 2));
  if (episode.version >= 3 && episode.ending === 'decision-limit' && !episode.decisions.some(d => d.choice)) {
    console.error('Decision budget exhausted without a valid motor choice.');
    process.exitCode = 1;
  }
  if (episode.ending === 'provider-error' || episode.ending === 'model-timeout') {
    console.error(episode.decisions.at(-1).error);
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
