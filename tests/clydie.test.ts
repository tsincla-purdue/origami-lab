import {afterEach, describe, expect, it, vi} from 'vitest';
import {createExperiment, recordFlip, recordMove, type TactileFeedback} from '../src/lab';
import {importExperiment, serializeExperiment, lmstudioController, ollamaController, randomController, replayEpisode, runEpisode, summarize} from '../src/clydie/episode';
import {actions, format, instructions, observe, parseChoice, type Controller} from '../src/clydie/protocol';

afterEach(() => vi.unstubAllGlobals());

it('invites Clydie to play and pursue its own question without a target', () => {
  expect(instructions).toContain('Fully engage with the paper in a way you find pleasing.');
  expect(instructions).toContain('Find a guiding question of your own and explore it.');
  expect(instructions).toContain('There is no particular shape you need to make or outcome you need to reach.');
});

function mockOllama(...outputs: string[]) {
  const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
    const raw = outputs.shift();
    if (raw === undefined) throw new Error('Unexpected model call');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json({message: {content: raw}, eval_count: 13});
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function script(...actions: object[]): Controller {
  return {metadata: {type: 'test'}, async decide() {
    const action = actions.shift();
    if (!action) throw new Error('Unexpected test decision');
    return {raw: JSON.stringify(action)};
  }};
}

describe('bounded tactile exploration', () => {
  it('requires coordinates in the provider schema for exactly the actions that need them', () => {
    for (const action of actions) {
      const branches = format.oneOf.filter(branch => branch.properties.action.enum.some(a => a === action));
      expect(branches).toHaveLength(1);
      const [branch] = branches;
      const needsPoint = ['beginDrag', 'beginTrace', 'move'].includes(action);
      expect('at' in branch.properties).toBe(needsPoint);
      expect(branch.required.some(key => key === 'at')).toBe(needsPoint);
      const positioned = () => parseChoice(JSON.stringify({action, at: {x: .3, y: .4}}));
      const unpositioned = () => parseChoice(JSON.stringify({action}));
      expect(needsPoint ? positioned : unpositioned).not.toThrow();
      expect(needsPoint ? unpositioned : positioned).toThrow();
    }
  });

  it('rejects malformed or out-of-vocabulary replies without issuing any motor commands', async () => {
    const bad = ['not JSON', 'null', '[{"action":"flip"}]', '{"action":"fold"}', '{"action":"move"}',
      '{"action":"move","at":{"x":1e999,"y":0}}', '{"action":"move","at":{"x":-1.01,"y":0}}',
      '{"action":"move","at":{"x":0,"y":0,"facet":2}}', '{"action":"move","at":{"x":"1","y":0}}',
      '{"action":"flip","at":{"x":0,"y":0}}', '{"action":"flip","packet":[0]}', '{"action":"__proto__"}',
      '{"action":"mark","note":{"kind":"fact","text":"example"}}',
      JSON.stringify({action: 'unfold', note: {kind: 'observation', text: 'x'.repeat(241)}})];
    mockOllama(...bad);
    const initial = recordFlip(createExperiment());
    const r = await runEpisode(ollamaController('mock'), {maxDecisions: bad.length}, initial);
    expect(r.ending).toBe('decision-limit');
    expect(r.decisions.map(d => d.raw)).toEqual(bad);
    expect(r.decisions.every(d => d.error && d.motorCount === 0)).toBe(true);
    expect(r.decisions[1].view.correction).toBe(r.decisions[0].error);
    expect(r.experiment).toEqual(initial);
    expect(r.notebook).toEqual([]);
    expect(r.trajectory.entries).toEqual([]);
  });

  it('projects sensory events field by field and withholds diagnostic and target coordinates', () => {
    const privatePoint = {x: .98765, y: .12345};
    const validation = {status: 'unverified', code: 'private-code', reason: 'private geometry'} as const;
    const feedback = {motor: {x: 0, y: 1}, proximity: .8, snapped: true, contact: 'edge',
      validation, facets: [123], events: [
        {kind: 'contact', contact: 'edge', motor: privatePoint, rank: 7},
        {kind: 'snap-acquired', constraint: 'line', target: privatePoint, motor: privatePoint},
        {kind: 'resistance', motor: privatePoint, validation},
        {kind: 'snap-lost', motor: privatePoint},
      ]} as const;
    expect(observe(feedback)).toEqual({motor: {x: 0, y: 1}, proximity: .8, snapped: true, contact: 'edge',
      outcome: 'unverified', events: [{kind: 'contact', contact: 'edge'}, {kind: 'snap-acquired', constraint: 'line'},
        {kind: 'resistance', outcome: 'unverified'}, {kind: 'snap-lost'}], omittedEvents: 0});
    const busy: TactileFeedback = {...feedback, events: Array(10).fill(feedback.events[0])};
    expect(observe(busy).events).toHaveLength(8);
    expect(observe(busy).omittedEvents).toBe(2);
  });

  it('presents detached bounded memory and never corrects a notebook entry using the paper', async () => {
    const choices = script({action: 'unfold', note: {kind: 'observation', text: 'I felt a tap.'}},
      {action: 'release', note: {kind: 'conjecture', text: 'Maybe the sheet moved.'}}, {action: 'stop'});
    const r = await runEpisode({...choices, async decide(view, signal) {
      expect(Object.keys(view).sort()).toEqual(['handMode', 'motor', 'notebook', 'recent']);
      view.motor.x = 99;
      view.notebook.push({kind: 'observation', text: 'external mutation'});
      view.recent.length = 0;
      return choices.decide(view, signal);
    }}, {recentLimit: 1, notebookLimit: 1});
    expect(r.decisions[0].view).toEqual({handMode: 'idle', motor: {x: 0, y: 0}, recent: [], notebook: []});
    expect(r.decisions[1].view.recent[0].sense.outcome).toBe('rejected');
    expect(r.trajectory.entries[0].feedback.validation?.code).toBe('no-active-fold');
    expect(r.decisions[2].view.recent.map(e => e.action.action)).toEqual(['release']);
    expect(r.notebook).toEqual([{kind: 'conjecture', text: 'Maybe the sheet moved.'}]);
    expect(r.experiment).toEqual(r.initial);
    expect(r.ending).toBe('agent-stop');
  });

  it('sends only the recorded view to the model and replays a saved fold without inference', async () => {
    const choices = [{action: 'beginDrag', at: {x: 1, y: 0}}, {action: 'move', at: {x: 0, y: 0}},
      {action: 'release'}, {action: 'stop'}];
    const fetch = mockOllama(...choices.map(c => JSON.stringify(c)));
    const r = await runEpisode(ollamaController('test-model', {seed: 42, tokens: 64}));
    expect(r.controller).toMatchObject({model: 'test-model', options: {seed: 42, num_predict: 64}, instructions, format});
    for (const [i, [url, init]] of fetch.mock.calls.entries()) {
      expect(url.href).toBe('http://127.0.0.1:11434/api/chat');
      expect(JSON.parse(init.body as string)).toEqual({model: 'test-model', stream: false, options: r.controller.options, format,
        messages: [{role: 'system', content: instructions}, {role: 'user', content: JSON.stringify(r.decisions[i].view)}]});
    }
    expect(r.decisions.every(d => d.generatedTokens === 13)).toBe(true);
    expect(r.experiment.attempts[0].validation.status).toBe('accepted');
    expect(summarize(r).snaps).toBeGreaterThan(0);
    const saved = JSON.parse(JSON.stringify(r));
    expect(replayEpisode(saved).status).toBe('verified');
    expect(importExperiment(serializeExperiment(saved.experiment))).toEqual(saved.experiment);
    saved.experiment = Object.fromEntries(Object.entries(saved.experiment).reverse());
    expect(replayEpisode(saved).status).toBe('verified');
    expect(fetch).toHaveBeenCalledTimes(4);
    const wrongPaper = {...saved, experiment: saved.initial};
    expect(() => replayEpisode(wrongPaper)).toThrow(/disagrees/);
    saved.trajectory.entries[0].feedback.snapped = true;
    expect(() => replayEpisode(saved)).toThrow(/disagrees/);
    saved.trajectory.entries[0].command = {kind: 'score', at: {x: 0, y: 0}};
    expect(() => replayEpisode(saved)).toThrow(/Unknown recorded/);
  });

  it('runs a seeded baseline and its identical model choices through the same motor path', async () => {
    const initial = recordFlip(createExperiment());
    const options = {maxCommands: 25};
    const baselineController = randomController(17);
    const baseline = await runEpisode(baselineController, options, initial);
    const repeat = await runEpisode(baselineController, options, initial);
    expect(repeat.decisions).toEqual(baseline.decisions);
    mockOllama(...baseline.decisions.map(d => d.raw!));
    const model = await runEpisode(ollamaController('mock'), options, initial);
    expect(model.trajectory).toEqual(baseline.trajectory);
    expect(model.decisions.map(d => d.view)).toEqual(baseline.decisions.map(d => d.view));
    expect(model.experiment).toEqual(baseline.experiment);
    expect(model.initial.attempts.length).toBe(1);
    expect(replayEpisode(model).status).toBe('verified');
  });

  it('cuts a path at the command budget, including at the largest allowed virtual scale', async () => {
    const r = await runEpisode(script({action: 'beginTrace', at: {x: -1, y: -1}}, {action: 'move', at: {x: 2, y: 2}}),
      {step: 1, pixelsPerUnit: 4096, maxCommands: 3});
    expect(r.ending).toBe('motor-limit');
    expect(r.decisions.map(d => [d.motorStart, d.motorCount])).toEqual([[0, 1], [1, 2]]);
    const positions = r.trajectory.entries.map(e => e.feedback.motor);
    for (const [i, p] of positions.slice(1).entries()) {
      expect(Math.hypot(p.x - positions[i].x, p.y - positions[i].y) * 4096).toBeLessThanOrEqual(4096);
    }
    expect(positions.at(-1)).not.toEqual({x: 2, y: 2});
    expect(replayEpisode(r).status).toBe('verified');
    for (const config of [{step: 1.1}, {pixelsPerUnit: 4097}, {maxCommands: Infinity}, {maxDecisions: 0}]) {
      await expect(runEpisode(script(), config)).rejects.toThrow();
    }
  });

  it.each([0, 1])('marks limited trajectories incomplete and keeps diagnostic feedback (limit %i)', async limit => {
    const r = await runEpisode(script({action: 'unfold'}, {action: 'flip'}, {action: 'stop'}), {trajectoryLimit: limit});
    expect(r.trajectory.version).toBe(3);
    expect(r.trajectory.truncated).toBe(true);
    expect(r.trajectory.entries.length).toBe(limit);
    expect(r.overflow.length).toBe(2 - limit);
    expect(summarize(r).feedbackOutcomes).toEqual({rejected: 1, accepted: 1});
    expect(replayEpisode(r).status).toBe('incomplete');
  });

  it('aborts stalled inference at the first deadline and records a host stop separately', async () => {
    const seen: AbortSignal[] = [];
    vi.stubGlobal('fetch', (_url: URL, init: RequestInit) => {
      seen.push(init.signal!);
      return new Promise(() => {});
    });
    const model = ollamaController('mock');
    const timeout = await runEpisode(model, {timeoutMs: 10});
    const duration = await runEpisode(model, {durationMs: 10});
    const host = new AbortController();
    const pending = runEpisode(model, {}, undefined, host.signal);
    host.abort();
    const interrupted = await pending;
    expect([timeout.ending, duration.ending, interrupted.ending]).toEqual(['model-timeout', 'duration', 'host-stop']);
    expect(seen.every(signal => signal.aborted)).toBe(true);
    for (const r of [timeout, duration, interrupted]) {
      expect(r.decisions).toHaveLength(1);
      expect(r.trajectory.entries).toHaveLength(0);
    }
  });

  it.each([[404, 'missing model'], [200, 'not JSON'], [200, '{}'], [200, 'a'.repeat(65537)]] as const)(
    'terminates on a provider error and records the bounded response', async (status, body) => {
      vi.stubGlobal('fetch', () => new Response(body, {status}));
      const r = await runEpisode(ollamaController('mock'));
      expect(r.ending).toBe('provider-error');
      expect(r.decisions).toHaveLength(1);
      expect(r.decisions[0].providerResponse).toEqual({body: body.slice(0, 65536), truncated: body.length > 65536});
      expect(r.experiment).toEqual(r.initial);
    });
});

describe('LM Studio', () => {
  it('sends the shared schema and detached view, and records completions before action validation', async () => {
    const model = 'local-model';
    const outputs = [{action: 'beginDrag'}, {action: 'beginTrace', at: {x: .5, y: .5}}, {action: 'stop'}];
    const usage = {prompt_tokens: 50, completion_tokens: 10, total_tokens: 60};
    const fetch = vi.fn(async (_url: URL, _init: RequestInit) => Response.json({
      id: 'completion-id', model: 'loaded-model', usage,
      choices: [{finish_reason: 'stop', message: {role: 'assistant', content: JSON.stringify(outputs.shift())}}],
    }));
    vi.stubGlobal('fetch', fetch);
    const options = {temperature: .2, top_p: .8, seed: 23, max_tokens: 64};
    const response_format = {type: 'json_schema', json_schema: {name: 'clydie_action', strict: true, schema: format}};
    const controller = lmstudioController(model, {temperature: .2, topP: .8, seed: 23, tokens: 64});
    const r = await runEpisode(controller);
    expect(r.controller).toMatchObject({type: 'lmstudio', model, options, response_format});
    for (const [i, [url, init]] of fetch.mock.calls.entries()) {
      expect(url.href).toBe('http://127.0.0.1:1234/v1/chat/completions');
      expect(init).toMatchObject({method: 'POST', redirect: 'error'});
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(init.body as string)).toEqual({model, stream: false, ...options, response_format, messages: [
        {role: 'system', content: instructions}, {role: 'user', content: JSON.stringify(r.decisions[i].view)},
      ]});
      expect(r.decisions[i]).toMatchObject({generatedTokens: 10,
        responseMetadata: {id: 'completion-id', model: 'loaded-model', finishReason: 'stop', usage}});
    }
    expect(r.ending).toBe('agent-stop');
    expect(r.decisions[0]).toMatchObject({motorCount: 0, error: expect.any(String)});
    expect(r.trajectory.entries.map(e => e.command.kind)).toEqual(['trace']);
    expect(replayEpisode(r).status).toBe('verified');
  });

  it.each([[404, 'missing model'], [200, '{'], [200, '{"choices":[]}']])(
    'records an unusable provider reply without executing a command', async (status, body) => {
      vi.stubGlobal('fetch', () => new Response(String(body), {status: Number(status)}));
      const r = await runEpisode(lmstudioController('test', {endpoint: 'http://localhost:9000/test/v1/'}));
      expect(r.controller.url).toBe('http://localhost:9000/test/v1/chat/completions');
      expect(r.ending).toBe('provider-error');
      expect(r.decisions[0]).toMatchObject({motorCount: 0, providerResponse: {body, truncated: false}});
    });
});

it('reports hand mode from issued commands and grab feedback', async () => {
  const corner = {x: 1, y: 0};
  const r = await runEpisode(script({action: 'beginTrace', at: corner}, {action: 'mark'},
    {action: 'move', at: corner}, {action: 'beginDrag', at: {x: -1, y: -1}},
    {action: 'beginDrag', at: corner}, {action: 'move', at: corner}, {action: 'release'},
    {action: 'beginTrace', at: corner}, {action: 'unfold'}, {action: 'beginDrag', at: corner},
    {action: 'flip'}, {action: 'stop'}));
  expect(r.decisions.map(d => d.view.handMode)).toEqual([
    'idle', 'tracing', 'tracing', 'tracing', 'idle', 'dragging', 'dragging',
    'idle', 'tracing', 'idle', 'dragging', 'idle',
  ]);
});

it('distinguishes an empty hand from a resisted manipulation in the model view', async () => {
  const at = {x: .5, y: .5};
  const r = await runEpisode(script({action: 'beginDrag', at}, {action: 'move', at: {x: .6, y: .5}},
    {action: 'beginDrag', at: {x: 1, y: 0}}, {action: 'release'}, {action: 'stop'}));
  const senses = r.decisions.slice(1).map(d => d.view.recent.at(-1)!.sense);
  expect(senses[0].events).toEqual([{kind: 'grip-failed'}]);
  expect(senses[1].motor).toEqual({x: .6, y: .5});
  expect(senses[2].events).toContainEqual({kind: 'grip-acquired'});
  expect(senses[3].events).toContainEqual({kind: 'resistance', outcome: 'unverified'});
  expect(r.decisions.map(d => d.view.handMode)).toEqual(['idle', 'idle', 'idle', 'dragging', 'idle']);
  expect(r.trajectory.entries[0].feedback.validation?.code).toBe('no-grab');
  expect(r.experiment).toEqual(r.initial);
});

it('keeps resistance during a held movement distinct from failing to grip', async () => {
  const sheet = recordMove(createExperiment(), {line: [[0, .02], [1, .82]], side: -1});
  const r = await runEpisode(script({action: 'beginDrag', at: {x: 1, y: .82}},
    {action: 'move', at: {x: 1, y: 1.16}}, {action: 'stop'}), {step: 1}, sheet);
  const afterMove = r.decisions[2].view;
  expect(afterMove.handMode).toBe('dragging');
  expect(afterMove.recent.at(-1)?.sense.events).toContainEqual({kind: 'resistance', outcome: 'rejected'});
  expect(r.trajectory.entries.at(-1)?.feedback.validation?.code).toBe('torn-hinge');
});

it('projects only the local landmark class and intensity', () => {
  const f = {motor: {x: .02, y: 0}, contact: 'edge', proximity: 1, snapped: false, events: [],
    landmark: {kind: 'corner', intensity: .33, position: {x: 0, y: 0}, facetId: 3, suggestedAction: 'move'}} as const;
  expect(observe(f).landmark).toEqual({kind: 'corner', intensity: .33});
});

it('presents a repeated trace as the same motor action with steady sensation', async () => {
  const trace = {action: 'beginTrace', at: {x: .5, y: .5}};
  const record = await runEpisode(script(trace, trace, {action: 'stop'}));
  const {recent, handMode} = record.decisions[2].view;
  expect(handMode).toBe('tracing');
  expect(recent.map(entry => entry.action)).toEqual([trace, trace]);
  expect(recent[0].sense.events).toEqual([{kind: 'contact', contact: 'surface'}]);
  expect(recent[1].sense).toEqual({...recent[0].sense, events: []});
  expect(summarize(record)).toMatchObject({motorCommands: 2, contacts: {surface: 1}});
});
