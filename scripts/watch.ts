#!/usr/bin/env node
/**
 * The gateway, out loud, while it runs.
 *
 * Nothing here is new information — every line comes from `trace.jsonl`, which
 * the gateway writes as it works. What this adds is the ability to watch it
 * happen in a second terminal while you drive the browser from the first, which
 * turns out to be the difference between a component you have read about and one
 * you understand.
 *
 *   node scripts/watch.ts                    # follow, live
 *   node scripts/watch.ts --all              # print what is already there first
 *   node scripts/watch.ts --kind observe     # only the recorder's decisions
 *   node scripts/watch.ts --session 1778914  # one gateway, when several are up
 *
 * Every Claude session starts its own gateway and they all append here, so
 * interleaving is normal and expected. The session column appears by itself as
 * soon as more than one is talking.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { defaultMemoryDir } from '../src/lib/roots.ts';

import type { TraceEvent, TraceKind } from '../src/lib/trace.ts';

const argv = process.argv.slice(2);
/**
 * Which flags take a value, listed rather than inferred.
 *
 * Inferring it — "the argument after a flag belongs to it" — swallowed the
 * memory directory in `--all <dir>`, because `--all` is a switch and takes
 * nothing. The watcher then followed the default log and reported, correctly
 * and uselessly, that there was nothing in it.
 */
const TAKES_VALUE = new Set(['kind', 'session']);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const positional = argv.filter((arg, index) => {
  const before = argv[index - 1];
  return !arg.startsWith('--')
    && !(before?.startsWith('--') && TAKES_VALUE.has(before.slice(2)));
});

const dir = positional[0] || defaultMemoryDir;
const file = path.join(dir, 'trace.jsonl');
const fromStart = argv.includes('--all');
const wantKinds = flag('kind')?.split(',').map(part => part.trim());
const wantSession = flag('session');

const colour = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (code: string, text: string): string => colour ? `[${code}m${text}[0m` : text;
const dim = (text: string): string => paint('2', text);
const bold = (text: string): string => paint('1', text);

/**
 * How each kind announces itself.
 *
 * Deliberately one column wide and aligned: the reason to watch a log rather
 * than read it afterwards is to catch the shape of a run at a glance, and a
 * shape needs a grid.
 */
const MARK: Record<TraceKind, { sign: string; colour: string }> = {
  list: { sign: '▸', colour: '35' },
  call: { sign: '→', colour: '36' },
  serve: { sign: '★', colour: '33' },
  observe: { sign: '·', colour: '32' },
  gate: { sign: '!', colour: '31' },
  upstream: { sign: '~', colour: '34' },
};

const seenSessions = new Set<string>();

function render(event: TraceEvent): string {
  const clock = event.at.slice(11, 19);
  const mark = MARK[event.kind] ?? { sign: '?', colour: '0' };
  // A finished call earns its own sign, because the outcome is the thing being
  // scanned for. Everything else keeps the sign of its kind.
  const outcome = event.data?.['outcome'];
  const sign = event.kind === 'call' && typeof outcome === 'string'
    ? ({ ok: '✓', error: '✗', refused: '⊘' }[outcome] ?? mark.sign)
    : mark.sign;
  const signColour = outcome === 'error' || outcome === 'refused' ? '31' : mark.colour;
  seenSessions.add(event.session);
  // Shown only once it can matter. One gateway is the common case and a column
  // of identical ids is noise.
  const who = seenSessions.size > 1 ? ` ${dim(event.session.split('-')[0]!.padStart(7))}` : '';
  return `${dim(clock)}${who} ${paint(signColour, sign)} ` +
    `${paint(signColour, event.kind.padEnd(8))} ${bold(event.what.padEnd(22))} ${event.detail}`;
}

function show(line: string): void {
  let event: TraceEvent;
  try {
    event = JSON.parse(line) as TraceEvent;
  } catch {
    return;
  }
  if (wantKinds && !wantKinds.includes(event.kind))
    return;
  if (wantSession && !event.session.startsWith(wantSession))
    return;
  console.log(render(event));
}

/**
 * Follows the file across rotation.
 *
 * `rotateSync` renames the log out from under whoever is reading it once it
 * passes 4 MB, and a reader holding a byte offset into the old file then sits
 * silent forever. Comparing the size against the offset catches both that and a
 * file that was deleted: if it is smaller than where we are, start over.
 */
async function follow(): Promise<void> {
  let offset = 0;
  let carry = '';
  if (!fromStart) {
    offset = await fsp.stat(file).then(stat => stat.size).catch(() => 0);
  }
  for (;;) {
    const size = await fsp.stat(file).then(stat => stat.size).catch(() => -1);
    if (size >= 0 && size < offset) {
      console.log(dim('  — log rotated, following the new one —'));
      offset = 0;
      carry = '';
    }
    if (size > offset) {
      const stream = fs.createReadStream(file, { start: offset, end: size - 1, encoding: 'utf8' });
      let chunk = '';
      for await (const part of stream)
        chunk += part;
      offset = size;
      const lines = (carry + chunk).split('\n');
      // The gateway appends whole lines, but a read can still land mid-write, so
      // the tail is held back until the newline that completes it arrives.
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim())
          show(line);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

console.log(dim(`watching ${file}`));
console.log(dim('  ▸ list   ★ serve   → call   · observe   ! gate   ~ upstream'));
if (!fs.existsSync(file)) {
  console.log(dim('  (nothing yet — the file appears on the first tool call)'));
}
await follow();
