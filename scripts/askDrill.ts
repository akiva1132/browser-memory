#!/usr/bin/env node
/**
 * Acceptance drill for browser_ask_user's delivery: three asks, end to end
 * through the real tool and the real notify path, against a fake browser whose
 * page "changes" a moment after each ask so the watcher releases it.
 *
 *   node scripts/askDrill.ts            # dry run: the notifier records, nothing is sent
 *   node scripts/askDrill.ts --live     # same, then ONE combined real message via BROWSER_ASK_CMD
 *
 * The dry run swaps BROWSER_ASK_CMD for a recorder, so it exercises everything
 * except the network. `--live` sends a single summary message to the configured
 * BROWSER_ASK_TARGET with the real command — one message, not three, so a drill
 * is never spam. A fourth ask with a broken notifier shows the visible error.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const live = process.argv.includes('--live');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ask-drill-'));
process.env['BROWSER_MEMORY_DIR'] = path.join(dir, 'memory');

const realCmd = process.env['BROWSER_ASK_CMD'] || path.join(os.homedir(), 'bin/telegram-send');
const target = process.env['BROWSER_ASK_TARGET'] || '521842667';
process.env['BROWSER_ASK_TARGET'] = target;
process.env['BROWSER_ASK_CHANNEL'] ||= 'telegram';

const record = path.join(dir, 'sent.ndjson');
const recorder = path.join(dir, 'dry-run-send.sh');
await fs.writeFile(recorder,
    `#!/bin/sh\nnode -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@" >> ${JSON.stringify(record)}\n`,
    { mode: 0o755 });

const { askUserTools } = await import('../src/browser/askUser.ts');
const { requestUserAction } = await import('../src/gateway/elicit.ts');
const { notifyOutOfBand } = await import('../src/gateway/notify.ts');

function fakeBrowser() {
  const page = { url: 'https://site.example/login' };
  setTimeout(() => { page.url = 'https://site.example/done'; }, 1600);
  return async (name: string) => {
    if (name === 'browser_tabs')
      return { content: [{ type: 'text', text: '0: https://site.example/login (current)' }] };
    if (name === 'browser_evaluate')
      return { content: [{ type: 'text', text: `"probe:${page.url} marker:false"` }] };
    return { content: [{ type: 'text', text: 'ok' }] };
  };
}

const asks = [
  { need: 'captcha', what: 'Drill 1/3: tick the CAPTCHA box' },
  { need: 'login', what: 'Drill 2/3: approve the sign-in' },
  { need: 'payment', what: 'Drill 3/3: enter the card details' },
];

process.env['BROWSER_ASK_CMD'] = recorder;
let released = 0;
for (const ask of asks) {
  const tool = askUserTools({ call: fakeBrowser(), ask: requestUserAction })[0]!;
  const result = await tool.handle({ ...ask, timeoutSeconds: 10 });
  if (/has done it/.test(result))
    released++;
  console.log(`  ${ask.what} -> ${result.split('\n')[0]}`);
}
const sends = (await fs.readFile(record, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
const toTarget = sends.filter(line => {
  const argv = JSON.parse(line) as string[];
  return argv[argv.indexOf('-t') + 1] === target;
});
console.log(`dry run: ${toTarget.length}/${asks.length} sends to chat ${target}, ${released}/${asks.length} released by the page`);

// A broken notifier must come back as a visible error, at once.
process.env['BROWSER_ASK_CMD'] = path.join(dir, 'no-such-notifier');
const started = Date.now();
let visible = '';
try {
  await askUserTools({ call: fakeBrowser(), ask: requestUserAction })[0]!
      .handle({ need: 'captcha', what: 'Drill: broken notifier', timeoutSeconds: 60 });
} catch (error) {
  visible = (error as Error).message;
}
console.log(`broken notifier: ${visible ? `error in ${Date.now() - started}ms — ${visible.slice(0, 90)}…` : 'NO ERROR (bug)'}`);

let liveOk = true;
if (live) {
  process.env['BROWSER_ASK_CMD'] = realCmd;
  const summary =
    `בדיקה בלבד — לא צריך לעשות כלום.\n` +
    `תרגיל browser_ask_user: ${toTarget.length}/${asks.length} שליחות (dry-run), ` +
    `${released}/${asks.length} שוחררו מהדף, ושגיאה גלויה כשההתראה נכשלת.\n` +
    `ההודעה הזו היא שליחה אמיתית אחת דרך ${path.basename(realCmd)}.`;
  const sent = await notifyOutOfBand('🧪 בדיקת התראות', summary);
  liveOk = sent.ok;
  console.log(`live: ${sent.ok ? 'one combined message sent' : `FAILED — ${sent.reason}`}`);
}

await fs.rm(dir, { recursive: true, force: true });
const pass = toTarget.length === asks.length && released === asks.length && Boolean(visible) && liveOk;
console.log(pass ? 'ASK DRILL OK' : 'ASK DRILL FAILED');
process.exit(pass ? 0 : 1);
