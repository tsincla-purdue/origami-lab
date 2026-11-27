import {expect, it} from 'vitest';
import {createExperiment, recordMove, recordUnfold} from '../src/lab';
import {runEpisode, replayEpisode} from '../src/clydie/episode';
import {instructions, parseChoice, type Controller} from '../src/clydie/protocol';

function scripted(...choices: object[]): Controller {
  return {metadata: {type: 'test'}, async decide() {
    const choice = choices.shift();
    if (!choice) throw new Error('Unexpected decision');
    return {raw: JSON.stringify(choice)};
  }};
}

it('separates pre-action inquiry from later interpolated readings and verifies saved evidence', async () => {
  const text = 'I felt stiffness.';
  const at = {x: .5, y: .5};
  const r = await runEpisode(scripted(
    {action: 'flip', note: {kind: 'observation', text}},
    {action: 'beginTrace', at},
    {action: 'move', at: {x: .9, y: .5}, note: {kind: 'reflection', text}},
    {action: 'stop', note: {kind: 'question', text: 'What happened?'}},
  ));
  const [invalid, trace, move, stop] = r.decisions;
  expect(invalid.motorCount).toBe(0);
  expect(trace.view.inquiryNotebook).toEqual([]);
  expect(trace.view.correction).toBeTruthy();
  expect(move.view).toMatchObject({nextMotorIndex: 1, inquiryNotebook: []});
  expect(move.motorCount).toBe(4);
  expect(stop.view.nextMotorIndex).toBe(5);
  expect(stop.view.inquiryNotebook).toEqual([{kind: 'reflection', text, beforeMotorIndex: 1}]);
  expect(r.inquiryNotebook[1].beforeMotorIndex).toBe(5);
  expect(r.sensoryMemory).toMatchObject([
    {firstMotorIndex: 0, lastMotorIndex: 0, reading: {events: [{kind: 'contact', contact: 'surface'}]}},
    {firstMotorIndex: 1, lastMotorIndex: 4, reading: {contact: 'surface', proximity: 0, events: []}},
  ]);
  expect(stop.view.recent.at(-1)?.delta).toEqual({firstReading: false, changes: {}, eventsChanged: false, noReportedChange: true});
  expect(JSON.stringify([r.sensoryMemory, stop.view.recent])).not.toContain(text);
  expect(() => parseChoice(JSON.stringify({action: 'stop', note: {kind: 'question', text, beforeMotorIndex: 5}}))).toThrow();
  expect(r.version).toBe(2);
  expect(replayEpisode(JSON.parse(JSON.stringify(r))).status).toBe('verified');
  for (const change of [
    (copy: typeof r) => { copy.sensoryMemory[0].reading.contact = 'edge'; },
    (copy: typeof r) => { copy.inquiryNotebook[0].beforeMotorIndex++; },
    (copy: typeof r) => { copy.decisions[2].view.recent[0].motorIndex++; },
  ]) {
    const copy = structuredClone(r);
    change(copy);
    expect(() => replayEpisode(copy)).toThrow(/disagrees/);
  }
});

it('rejects a substituted choice even when its raw reply and motor count agree', async () => {
  const r = await runEpisode(scripted({action: 'beginTrace', at: {x: .5, y: .5}}, {action: 'stop'}));
  expect(replayEpisode(r).status).toBe('verified');
  r.decisions[0].choice = {action: 'flip'};
  r.decisions[0].raw = JSON.stringify(r.decisions[0].choice);
  expect(() => replayEpisode(r)).toThrow(/motor path/);
});

it('accepts a partial motor path only when the final decision can be interrupted', async () => {
  const r = await runEpisode(scripted({action: 'beginTrace', at: {x: .5, y: .5}},
    {action: 'move', at: {x: .75, y: .5}}), {step: .125, maxCommands: 2});
  expect(r.decisions[1].motorCount).toBe(1);
  expect(replayEpisode(r).status).toBe('verified');
  r.settings.maxCommands++;
  expect(() => replayEpisode(r)).toThrow(/motor path/);
  for (const ending of ['host-stop', 'duration'] as const) {
    expect(replayEpisode({...r, ending}).status).toBe('verified');
  }
  const continued = await runEpisode(scripted({action: 'beginTrace', at: {x: .5, y: .5}},
    {action: 'move', at: {x: .625, y: .5}}, {action: 'stop'}), {step: .125});
  continued.decisions[1].choice = r.decisions[1].choice;
  continued.decisions[1].raw = r.decisions[1].raw;
  expect(() => replayEpisode(continued)).toThrow(/motor path/);
});

it('keeps intermediate path events when endpoints match, distinct from lift and reposition', async () => {
  const initial = recordUnfold(recordMove(createExperiment(), {line: [[.5, 0], [.5, 1]], side: -1}));
  const left = {x: .3, y: 0}, right = {x: .7, y: 0};
  const r = await runEpisode(scripted({action: 'beginTrace', at: left}, {action: 'move', at: right},
    {action: 'beginTrace', at: left}, {action: 'beginDrag', at: {x: .3, y: .2}}, {action: 'stop'}), {step: 1}, initial);
  const latest = (decision: number) => r.decisions[decision].view.recent.at(-1)!;
  expect(latest(2).sense.events).toEqual([{kind: 'contact', contact: 'intersection'}, {kind: 'contact', contact: 'edge'}]);
  expect(latest(2).delta).toMatchObject({changes: {}, eventsChanged: true, noReportedChange: false});
  expect(latest(3).sense.events).toEqual([{kind: 'contact-lost'}, {kind: 'contact', contact: 'edge'}]);
  expect(latest(4).delta.changes).toMatchObject({outcome: {from: null, to: 'rejected'}, contact: {from: 'edge', to: null}});
  expect(r.sensoryMemory.at(-1)?.reading.events).toContainEqual({kind: 'grip-failed'});
  expect(JSON.stringify(r.sensoryMemory)).not.toMatch(/no-grab|facetId|"motor":|reason/);
});

it.each([40, 100])('bounds every input and coalesces stationary readings over %i commands', async count => {
  const actions = Array.from({length: count}, () => ({action: 'beginTrace', at: {x: .5, y: .5},
    note: {kind: 'conjecture', text: '紙'.repeat(240)}}));
  const r = await runEpisode(scripted(...actions), {maxCommands: count});
  expect(r.ending).toBe('motor-limit');
  expect(r.sensoryMemory).toHaveLength(2);
  expect(r.sensoryMemory[1]).toMatchObject({firstMotorIndex: 1, lastMotorIndex: count - 1, reading: {events: []}});
  for (const {view} of r.decisions) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(instructions).length + encoder.encode(JSON.stringify(view)).length;
    expect(bytes + 128 + 128).toBeLessThanOrEqual(4096);
  }
  expect(r.decisions.at(-1)?.view.omittedInquiryNotes).toBeGreaterThan(0);
  expect(replayEpisode(r).status).toBe('verified');
});

it('records snap transitions, landmark intensity and ordered resistance events as reported', async () => {
  const r = await runEpisode(scripted({action: 'beginTrace', at: {x: .02, y: 0}},
    {action: 'move', at: {x: .01, y: 0}}, {action: 'beginDrag', at: {x: 1, y: 0}},
    {action: 'move', at: {x: .01, y: 0}}, {action: 'release'}, {action: 'stop'}), {step: 1});
  const landmark = r.decisions[2].view.recent.at(-1)!.delta.changes.landmark;
  expect(landmark.from).toMatchObject({kind: 'corner', intensity: expect.closeTo(1 / 3)});
  expect(landmark.to).toMatchObject({kind: 'corner', intensity: expect.closeTo(2 / 3)});
  expect(r.decisions[3].view.recent.at(-1)?.sense.events).toContainEqual({kind: 'grip-acquired'});
  expect(r.decisions[4].view.recent.at(-1)?.delta.changes.snapped).toEqual({from: false, to: true});
  expect(r.sensoryMemory.at(-1)?.reading.outcome).toBe('accepted');
  const blocked = recordMove(createExperiment(), {line: [[0, .02], [1, .82]], side: -1});
  const attempted = await runEpisode(scripted({action: 'beginDrag', at: {x: 1, y: .82}},
    {action: 'move', at: {x: 1, y: 1.16}}, {action: 'release'}, {action: 'stop'}), {step: 1}, blocked);
  expect(attempted.decisions[2].view.recent.at(-1)?.sense.events).toContainEqual({kind: 'resistance', outcome: 'rejected'});
  expect(attempted.sensoryMemory.some(f => f.reading.events.some(e => e.kind === 'resistance'))).toBe(true);
});
