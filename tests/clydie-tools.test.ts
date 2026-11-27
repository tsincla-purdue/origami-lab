import {afterEach, expect, it, vi} from 'vitest';
import {createExperiment, recordMove, recordUnfold} from '../src/lab';
import {lmstudioController, replayEpisode, runEpisode} from '../src/clydie/episode';
import {actions, invitation, observe, type Action, type Interaction} from '../src/clydie/protocol';

afterEach(() => vi.unstubAllGlobals());
function call(name: string, args: string, id = 'a') {
  return {type: 'function', id, function: {name, arguments: args}};
}
function response(...calls: object[]) {
  return {role: 'assistant', content: 'diagnostic prose', tool_calls: calls};
}
function mock(messages: object[]) {
  const requests: Record<string, any>[] = [];
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    if (!messages.length) throw new Error('Unexpected extra inference');
    return Response.json({model: 'mock', choices: [{message: messages.shift()}]});
  });
  return requests;
}
const controller = (interaction: Interaction) => lmstudioController('mock', {interaction});
const native = (a: Action, i: number) => response(call(a.action, JSON.stringify('at' in a ? a.at : {}), String(i)));
const json = (a: object) => ({role: 'assistant', content: JSON.stringify(a)});

it('executes the same motor choices and preserves intermediate observations across all three interfaces', async () => {
  const initial = recordUnfold(recordMove(createExperiment(), {line: [[.5, 0], [.5, 1]], side: -1}));
  const choices: Action[] = [{action: 'beginTrace', at: {x: .3, y: 0}}, {action: 'move', at: {x: .7, y: 0}},
    {action: 'release'}, {action: 'beginDrag', at: {x: .5, y: .5}}, {action: 'stop'}];
  const runs = [];
  for (const mode of ['structured', 'motor-json', 'native-tools'] as const) {
    const requests = mock(mode === 'native-tools' ? choices.map(native) : choices.map(json));
    const r = await runEpisode(controller(mode), {step: .125}, initial);
    expect(r.ending, r.decisions.at(-1)?.error).toBe('agent-stop');
    expect(requests).toHaveLength(choices.length);
    expect(r.controller.instructions).toEqual(requests[0].messages[0].content);
    expect(requests[0].messages[0].content.startsWith(invitation + '\n\n')).toBe(true);
    expect(replayEpisode(JSON.parse(JSON.stringify(r))).status).toBe('verified');
    runs.push(r);
    if (mode === 'structured') continue;
    for (const req of requests) expect(JSON.stringify(req.messages)).not.toMatch(/inquiryNotebook|diagnostic prose/);
    if (mode === 'motor-json') {
      expect(JSON.stringify(requests[0].response_format)).not.toContain('"note"');
      continue;
    }
    expect(requests[0]).toMatchObject({tool_choice: 'auto', parallel_tool_calls: false});
    expect(requests[0]).not.toHaveProperty('response_format');
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(actions);
    const move = r.decisions[1];
    const result = requests[2].messages.at(-1);
    expect(result).toEqual(move.tool?.result);
    expect(requests[2].messages.at(-2)).toEqual({role: 'assistant', content: null, tool_calls: [move.tool?.call]});
    expect(result.tool_call_id).toBe('1');
    const report = JSON.parse(result.content);
    let previous: Record<string, unknown> = {};
    const readings = report.readings.flatMap((r: any) => {
      previous = r.sense ?? {...previous, ...r.changes};
      if (previous.landmark === null) delete previous.landmark;
      return Array(r.count).fill(previous);
    });
    expect(readings).toEqual(r.trajectory.entries.slice(1, 1 + move.motorCount).map(({command, feedback}) => {
      const {motor, ...reading} = observe(feedback, command);
      return reading;
    }));
    expect(readings.flatMap((s: any) => s.events)).toContainEqual({kind: 'contact', contact: 'intersection'});
    expect(JSON.stringify(requests)).not.toMatch(/facetId|no-grab|validation.code|diagnostic prose/);
    expect(r.decisions[0].raw).toContain('diagnostic prose');
    expect(r.decisions.at(-1)?.tool?.result.content).toContain('"motorCount":0');
  }
  for (const r of runs.slice(1)) {
    expect(r.trajectory).toEqual(runs[0].trajectory);
    expect(r.experiment).toEqual(runs[0].experiment);
  }
});

it('rejects missing, multiple, malformed and unsupported calls, then recovers on a real tool call', async () => {
  const flip = call('flip', '{}');
  const bad = [json({action: 'flip'}), response(), response(flip, flip), response(call('invent', '{}')),
    response(call('beginTrace', '{"x":0}')), response(call('move', '{"x":2.1,"y":0}')), response(call('move', '{"x":1e999,"y":0}')),
    response(call('mark', '{"note":"text"}')), response(call('move', '{}x')), response(call('release', 'null')),
    response({...flip, id: ''}), response({...flip, type: 'custom'}), {...response(flip), role: 'tool'}];
  const requests = mock([...bad, response(call('stop', '{}'))]);
  const r = await runEpisode(controller('native-tools'));
  expect(r.ending).toBe('agent-stop');
  expect(r.trajectory.entries).toEqual([]);
  expect(r.decisions.slice(0, -1).every(d => d.error && !d.choice && !d.tool && d.motorCount === 0)).toBe(true);
  expect(requests).toHaveLength(bad.length + 1);
  for (const req of requests.slice(1)) {
    expect(req.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    expect(JSON.parse(req.messages[1].content).correction).toBeTruthy();
  }
  expect(replayEpisode(r).status).toBe('verified');
});

it('rejects authored notes in motor-json at the host boundary', async () => {
  mock([json({action: 'flip', note: {kind: 'reflection', text: 'fiction'}}), json({action: 'stop'})]);
  const r = await runEpisode(controller('motor-json'));
  expect(r.decisions[0]).toMatchObject({motorCount: 0, error: 'Return only a motor action.'});
  expect(r.inquiryNotebook).toEqual([]);
  expect(replayEpisode(r).status).toBe('verified');
});

it.each([40, 100])('bounds complete native exchanges across %i commands', async count => {
  const requests = mock(Array.from({length: count}, (_, i) => native({action: 'beginTrace', at: {x: .5, y: .5}}, i)));
  const r = await runEpisode(controller('native-tools'), {maxCommands: count});
  expect(r.ending).toBe('motor-limit');
  expect(requests).toHaveLength(count);
  for (const [i, req] of requests.entries()) {
    const bytes = new TextEncoder().encode(JSON.stringify(req.messages) + JSON.stringify(req.tools)).length;
    expect(bytes + 128 + req.max_tokens).toBeLessThanOrEqual(4096);
    expect(r.decisions[i].responseMetadata?.inputBytes).toBe(bytes);
    const turns = req.messages.slice(2);
    expect(turns.length % 2).toBe(0);
    if (i) expect(turns.at(-1).tool_call_id).toBe(String(i - 1));
    for (let j = 0; j < turns.length; j += 2) {
      expect(turns[j].role).toBe('assistant');
      expect(turns[j + 1]).toMatchObject({role: 'tool', tool_call_id: turns[j].tool_calls[0].id});
    }
  }
  expect(replayEpisode(r).status).toBe('verified');
});

it('verifies a budget-interrupted tool move and detects tampered calls, ranges and feedback', async () => {
  mock([native({action: 'move', at: {x: 1, y: 0}}, 0)]);
  const r = await runEpisode(controller('native-tools'), {maxCommands: 2});
  expect(r.ending).toBe('motor-limit');
  expect(JSON.parse(r.decisions[0].tool!.result.content)).toMatchObject({motorStart: 0, motorCount: 2, motor: {x: .25, y: 0}});
  expect(replayEpisode(r).status).toBe('verified');
  for (const change of [
    (d: typeof r.decisions[number]) => {d.raw = JSON.stringify(native({action: 'move', at: {x: 0, y: 1}}, 0));},
    (d: typeof r.decisions[number]) => {d.tool!.call.id = 'other';},
    (d: typeof r.decisions[number]) => {d.tool!.result.tool_call_id = 'other';},
    (d: typeof r.decisions[number]) => {d.tool!.result.content = d.tool!.result.content.replace('"motorStart":0', '"motorStart":1');},
    (d: typeof r.decisions[number]) => {d.tool!.result.content = '{"contact":"corner"}';},
  ]) {
    const copy = structuredClone(r);
    change(copy.decisions[0]);
    expect(() => replayEpisode(copy)).toThrow(/disagrees/);
  }
});

it('keeps the last host result paired through a correction and preserves dropped-response diagnostics', async () => {
  const requests = mock([native({action: 'release'}, 0), json({action: 'flip'}), response(call('stop', '{}'))]);
  const r = await runEpisode(controller('native-tools'));
  expect(requests[2].messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
  expect(requests[2].messages[3]).toEqual(r.decisions[0].tool?.result);
  expect(requests[2].messages[4].content).toBe(r.decisions[1].error);
  expect(requests[2].messages[4].content).not.toContain('flip');
  expect(replayEpisode(r).status).toBe('verified');

  vi.stubGlobal('fetch', () => new Response('unsupported tools', {status: 400}));
  const failed = await runEpisode(controller('native-tools'));
  expect(failed.ending).toBe('provider-error');
  expect(failed.decisions).toHaveLength(1);
  expect(failed.decisions[0]).toMatchObject({motorCount: 0, providerResponse: {body: 'unsupported tools'}});
  expect(replayEpisode(failed).status).toBe('verified');
});

it.each([40, 100])('bounds motor-json input over %i commands', async count => {
  const requests = mock(Array.from({length: count}, () => json({action: 'beginTrace', at: {x: .5, y: .5}})));
  const r = await runEpisode(controller('motor-json'), {maxCommands: count});
  expect(r.ending).toBe('motor-limit');
  for (const req of requests) {
    expect(new TextEncoder().encode(JSON.stringify(req.messages) + JSON.stringify(req.response_format.json_schema.schema)).length +
      128 + req.max_tokens).toBeLessThanOrEqual(4096);
    expect(req.tools).toBeUndefined();
  }
});

it('uses the tactile hand as the sole author of tool feedback and verifies the next input', async () => {
  const requests = mock([{...native({action: 'beginDrag', at: {x: .5, y: .5}}, 0),
    tool_result: {contact: 'invented-contact'}}, native({action: 'stop'}, 1)]);
  const r = await runEpisode(controller('native-tools'));
  expect(r.trajectory.entries[0].feedback.validation?.code).toBe('no-grab');
  const result = requests[1].messages.at(-1);
  expect(JSON.parse(result.content)).toMatchObject({handMode: 'idle', readings: [
    {sense: {outcome: 'rejected', events: expect.arrayContaining([{kind: 'grip-failed'}])}},
  ]});
  expect(JSON.stringify(requests[1])).not.toMatch(/no-grab|invented-contact|facetId|diagnostic prose/);
  const messages = r.decisions[1].responseMetadata!.messages as {role: string; content: string}[];
  messages.at(-1)!.content = '{"contact":"invented-contact"}';
  expect(() => replayEpisode(r)).toThrow(/recorded model input/);
});
