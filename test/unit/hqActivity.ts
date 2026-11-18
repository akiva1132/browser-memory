/**
 * The report hq keeps the tabs' owners by (agent-company tab/tabs.ts). What is worth pinning: the call carries
 * the session, the pid and the shift; hq's "lost" comes back to the caller; and an hq that does not know the
 * route, or does not answer, costs one try and then a pause — never a wait on every browser call.
 *
 * Driven against a fake hq on a unix socket in a temp dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-activity-test-'));
process.env['COMPANY_STATE_DIR'] = dir;
process.env['COMPANY_IDENTITY'] = 'yoav';
process.env['COMPANY_SHIFT'] = 'yoav-7';
delete process.env['BROWSER_ASK_HQ'];

const seen: Record<string, unknown>[] = [];
let answer: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true } };
const server = http.createServer((req, res) => {
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => {
    seen.push({ path: req.url, ...JSON.parse(text) });
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
});
await new Promise<void>(resolve => server.listen(path.join(dir, 'hq.sock'), resolve));

const { reportActivity } = await import('../../src/gateway/hq.ts');

{
  assert.deepEqual(await reportActivity('begin', 's-1'), { lost: false });
  assert.deepEqual(seen.at(-1), { path: '/v1/browser', op: 'begin', session: 's-1', pid: process.pid, identity: 'yoav', shift: 'yoav-7' });
  console.log('  begin carries the session, the pid and the shift');
}

{
  answer = { status: 200, body: { ok: true, lost: true } };
  assert.deepEqual(await reportActivity('begin', 's-1'), { lost: true });
  console.log('  hq closing the session\'s tab comes back as lost');
}

{
  answer = { status: 404, body: { ok: false } };
  const before = seen.length;
  assert.deepEqual(await reportActivity('end', 's-1'), {});
  assert.deepEqual(await reportActivity('begin', 's-1'), {});
  assert.equal(seen.length, before + 1, 'an hq without the route is asked once, then left alone');
  console.log('  an hq from before the route costs one request, then a pause');
}

server.close();
await fs.rm(dir, { recursive: true, force: true });
console.log('HQ ACTIVITY OK');
