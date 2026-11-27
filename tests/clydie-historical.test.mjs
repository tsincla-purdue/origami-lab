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
