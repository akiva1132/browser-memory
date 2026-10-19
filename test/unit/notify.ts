/**
 * The out-of-band channel is the only way an ask reaches anyone, so the two
 * things worth pinning are that a failure is reported with its reason, and that
 * nothing ever falls back to the client's elicitation prompt — the prompt that
 * 53 of 62 measured asks were raised into while nobody was watching.
 *
 * Driven with a fake BROWSER_ASK_CMD script, so no message leaves the machine.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notify-test-'));
// The trace writes under the memory dir; keep it away from the real one.
process.env['BROWSER_MEMORY_DIR'] = path.join(dir, 'memory');

const log = path.join(dir, 'sent.log');
const ok = path.join(dir, 'ok.sh');
const fail = path.join(dir, 'fail.sh');
await fs.writeFile(ok, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
await fs.writeFile(fail,
    '#!/bin/sh\necho "sendMessage failed: {\\"ok\\":false,\\"error_code\\":401} ' +
    'https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage ' +
    'bare 987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" >&2\nexit 1\n',
    { mode: 0o755 });

const { notifyOutOfBand } = await import('../../src/gateway/notify.ts');
const { attachClient, requestUserAction } = await import('../../src/gateway/elicit.ts');

// ── unset target is a reported failure, not a quiet no-op ────────────────────
{
  delete process.env['BROWSER_ASK_TARGET'];
  const result = await notifyOutOfBand('t', 'm');
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : '', /BROWSER_ASK_TARGET is unset/);
  console.log('  no target configured is reported, with the reason');
}

process.env['BROWSER_ASK_TARGET'] = '42';
process.env['BROWSER_ASK_CHANNEL'] = 'telegram';

// ── a successful send passes target, text and media through ──────────────────
{
  process.env['BROWSER_ASK_CMD'] = ok;
  const result = await notifyOutOfBand('Your turn: x', 'do x', { mediaPath: '/tmp/shot.png' });
  assert.deepEqual(result, { ok: true });
  const line = await fs.readFile(log, 'utf8');
  assert.match(line, /message send --channel telegram -t 42 -m Your turn: x/);
  assert.match(line, /--media \/tmp\/shot\.png/);
  console.log('  a send passes chat, text and screenshot to the command');
}

// ── a failed send carries stderr, without the bot token ──────────────────────
{
  process.env['BROWSER_ASK_CMD'] = fail;
  const result = await notifyOutOfBand('t', 'm');
  assert.equal(result.ok, false);
  const reason = !result.ok ? result.reason : '';
  assert.match(reason, /401/, 'the reason is what the agent will repeat to the user');
  assert.doesNotMatch(reason, /AAAAAAAAAAAA|BBBBBBBBBBBB/, 'a bot token must never reach a tool result');
  const traced = await fs.readFile(path.join(dir, 'memory', 'trace.jsonl'), 'utf8').catch(() => '');
  assert.doesNotMatch(traced, /AAAAAAAAAAAA|BBBBBBBBBBBB/, 'nor the trace');
  console.log(`  a failed send is reported: ${reason.slice(0, 70)}…`);
}

// ── a silent failure still says how it failed, not the command line ─────────
{
  const quiet = path.join(dir, 'quiet.sh');
  await fs.writeFile(quiet, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  process.env['BROWSER_ASK_CMD'] = quiet;
  const result = await notifyOutOfBand('t', 'secret body text');
  const reason = !result.ok ? result.reason : '';
  assert.match(reason, /exited with code 3/);
  assert.doesNotMatch(reason, /secret body text/, 'the message body is not a reason');
  console.log('  a failure with no stderr reports its exit code');
}

// ── a missing command is a failure with a reason, not a throw ────────────────
{
  process.env['BROWSER_ASK_CMD'] = path.join(dir, 'no-such-command');
  const result = await notifyOutOfBand('t', 'm');
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : '', /ENOENT/);
  console.log('  a missing notifier is reported as such');
}

// ── asks never go to elicitation, even when the client says it can ───────────
{
  let elicited = 0;
  const server = {
    getClientCapabilities: () => ({ elicitation: {} }),
    elicitInput: async () => { elicited++; return { action: 'accept', content: { done: true } }; },
  };
  attachClient(server as never);

  process.env['BROWSER_ASK_CMD'] = ok;
  assert.deepEqual(await requestUserAction('t', 'm'), { ok: true });
  process.env['BROWSER_ASK_CMD'] = fail;
  const failed = await requestUserAction('t', 'm');
  assert.equal(failed.ok, false, 'a failed send stays failed: no prompt is a second chance');
  assert.equal(elicited, 0, 'the client prompt is never raised for an ask');
  console.log('  an eliciting client is never prompted, whether the send works or not');
}

await fs.rm(dir, { recursive: true, force: true });
console.log('NOTIFY OK');
