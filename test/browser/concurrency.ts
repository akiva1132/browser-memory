/**
 * The failure this guards against: two Claude sessions each run their own
 * gateway process, both record a lesson on the same site, and one write lands
 * on a snapshot the other already replaced — so a lesson silently disappears.
 *
 * Uses separate processes rather than separate promises, because an in-process
 * queue alone would pass this test while still losing data in production.
 * Removing the lock makes it fail: 7 of 20 lessons vanished when measured.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Harness, cleanup, tempMemoryDir } from '../harness.ts';

const WRITERS = 4;
const PER_WRITER = 5;

const memoryDir = await tempMemoryDir('race');

async function writer(index: number): Promise<void> {
  const harness = await Harness.start(memoryDir);
  for (let n = 0; n < PER_WRITER; n++) {
    await harness.call('domain_remember', {
      url: 'https://race.example.com',
      kind: 'fact',
      title: `lesson from writer ${index} number ${n}`,
      gist: `written by process ${index}`,
    });
  }
  await harness.close();
}

await Promise.all(Array.from({ length: WRITERS }, (_, index) => writer(index)));

const stored = JSON.parse(
    await fs.readFile(path.join(memoryDir, 'race.example.com.json'), 'utf8')) as { entries: unknown[] };
console.log(`expected ${WRITERS * PER_WRITER} lessons, found ${stored.entries.length}`);
assert.equal(stored.entries.length, WRITERS * PER_WRITER, 'concurrent writes must not lose lessons');

const leftovers = (await fs.readdir(memoryDir)).filter(name => name.endsWith('.lock'));
assert.deepEqual(leftovers, [], 'locks must be released');

await cleanup(memoryDir);
console.log('CONCURRENCY OK');
