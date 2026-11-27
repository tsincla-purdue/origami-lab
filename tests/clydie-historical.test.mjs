import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {expect, it} from 'vitest';
import {replayEpisode} from '../src/clydie/episode';

for (const path of ['../docs/verification/clydie-v0/a.json.gz', './fixtures/clydie-v01-replay.json.gz']) {
  it(`replays historical sensations in ${path}`, () => {
    const record = JSON.parse(gunzipSync(readFileSync(new URL(path, import.meta.url))));
    expect(record.trajectory.version).toBe(1);
    expect(record.trajectory.entries[0].feedback.contact).toBe('edge');
    expect(replayEpisode(record).status).toBe('verified');
    const relabeled = {...record, trajectory: {...record.trajectory, version: 2}};
    expect(() => replayEpisode(relabeled)).toThrow(/disagrees/);
  });
}

it('replays a frozen version 2 episode with its original stationary corner recontacts', () => {
  const path = new URL('./fixtures/clydie-v02-stationary.json.gz', import.meta.url);
  const record = JSON.parse(gunzipSync(readFileSync(path)));
  expect(record.trajectory.version).toBe(2);
  expect(record.trajectory.entries[1].feedback).toMatchObject({
    contact: 'corner', landmark: {kind: 'corner', intensity: 1},
    events: [{kind: 'contact-lost'}, {kind: 'contact', contact: 'corner'}],
  });
  expect(replayEpisode(record).status).toBe('verified');
  expect(() => replayEpisode({...record, trajectory: {...record.trajectory, version: 3}})).toThrow(/disagrees/);
});

it('replays version 3 native calls with their original endpoint-only tool results', () => {
  const path = new URL('./fixtures/clydie-v3-native.json.gz', import.meta.url);
  const record = JSON.parse(gunzipSync(readFileSync(path)));
  expect(record.version).toBe(3);
  expect(JSON.parse(record.decisions[0].tool.result.content)).not.toHaveProperty('positions');
  expect(replayEpisode(record).status).toBe('verified');
  expect(() => replayEpisode({...record, version: 4})).toThrow(/recorded tool call or host result/);
});
