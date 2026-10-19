/**
 * The advertised tool list is the first thing in the cached prefix of every
 * request, so its order is not cosmetic: two sessions holding identical
 * procedures must advertise them identically, or every request pays full price
 * for tools, system and messages alike.
 *
 * `readdir` promises no order, which is how this could drift without anyone
 * seeing it. So the check writes several domains in one order, then writes the
 * same set in the opposite order into a second store, and asserts the two
 * advertise identically.
 *
 * Worth knowing about this test: on the ext4 it was written against, `readdir`
 * returns sorted for every arrangement tried, so it passes with and without the
 * sort it guards. It is a contract check, not a reproduction — it will earn its
 * keep on a filesystem that answers in hash order, and it states the property
 * so that a later change cannot quietly drop it.
 *
 * No browser: this is about what the store hands to the list, and the gateway
 * appends it verbatim.
 */
import assert from 'node:assert/strict';

import { ProcedureStore } from '../../src/procedures/store.ts';
import { cleanup, tempMemoryDir } from '../harness.ts';

const DOMAINS = ['zebra.example.com', 'alpha.example.com', 'middle.example.com', 'beta.example.com'];

const spec = (name: string) => ({
  name,
  description: `does ${name}`,
  code: 'async () => "ok"',
  origin: 'https://example.com/',
  params: [],
  mutating: false,
});

/** The names a session would advertise, given these domains written in this order. */
async function advertised(order: string[]): Promise<string[]> {
  const dir = await tempMemoryDir('toolorder');
  const store = new ProcedureStore(dir);
  for (const domain of order)
    await store.save(domain, spec(`run_${domain.split('.')[0]}`));
  const names = (await store.all()).map(procedure => procedure.name);
  await cleanup(dir);
  return names;
}

const forwards = await advertised(DOMAINS);
const backwards = await advertised([...DOMAINS].reverse());

assert.equal(forwards.length, DOMAINS.length, 'every saved procedure should be advertised');
assert.deepEqual(forwards, backwards,
    'the same procedures written in a different order must still be advertised in one order');
assert.deepEqual(forwards, [...forwards].sort(),
    'and that order has to be one a second machine would also produce');

console.log(`  ${forwards.length} procedures, same order regardless of how they were written`);
console.log('TOOL ORDER OK');
