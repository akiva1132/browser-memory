import { execFile } from 'node:child_process';

import { trace } from './context.ts';

/**
 * Reaching the person, wherever they actually are.
 *
 * This is the only way `browser_ask_user` reaches anyone. It used to be the
 * fallback behind MCP elicitation, and the trace showed what that cost: 53 of
 * 62 asks went to a client prompt that a phone Remote Control session or an
 * unattended run never shows, and the tool waited out its timeout with nobody
 * told. The chat app is the one place the user reliably is: a CAPTCHA
 * screenshot lands on their phone, they act on it, and the page watcher in
 * askUser notices without them replying to anything.
 *
 * Configured through the environment: `BROWSER_ASK_TARGET` (chat id),
 * `BROWSER_ASK_CHANNEL`, and `BROWSER_ASK_CMD` (anything speaking
 * `message send --channel C -t T -m M [--media F]`; defaults to `openclaw` for
 * history, but a server may point it at a `telegram-send` script). Unset target is
 * reported as a failure, not treated as a quiet no-op.
 */

/** Long enough for an image upload, short enough not to stall the ask. */
const SEND_TIMEOUT_MS = 30_000;

type NotifyOptions = {
  /** A local file to attach — the CAPTCHA itself is worth more than any description of it. */
  mediaPath?: string;
  /** A handoff link is already in the message (hq, B.9): then the desk is not where to act. */
  link?: string;
};

const env = (name: string): string => (process.env[name] ?? '').trim();

/**
 * Where the person can go to act, when acting needs a real browser. On a server
 * the tab raised by askUser is on a display nobody is looking at, so the message
 * has to carry the way in with it.
 */
function whereToAct(): string {
  const url = env('BROWSER_ASK_DESK_URL');
  return url ? `\n\nDo it here: ${url}` : '';
}

/**
 * What happened to one send. `ok: false` is not "the user said no" — it means
 * nobody was told, and `reason` says why in words the agent can repeat. The
 * caller is expected to surface it: a send that failed silently is exactly how
 * three of nine Telegram asks vanished before 20/10.
 */
export type NotifyResult = { ok: true } | { ok: false; reason: string };

/** Bot tokens (`123456:AA…`, bare or in an API URL) never reach a tool result or the trace. */
export const scrub = (value: string): string =>
  value.replace(/\d{6,}:[\w-]{30,}/g, '«redacted»').replace(/\s+/g, ' ').trim().slice(0, 300);

export async function notifyOutOfBand(
    title: string, message: string, options: NotifyOptions = {}): Promise<NotifyResult> {
  const target = env('BROWSER_ASK_TARGET');
  if (!target) {
    return {
      ok: false,
      reason: 'no out-of-band channel is configured (BROWSER_ASK_TARGET is unset), so the user cannot be reached',
    };
  }

  const channel = env('BROWSER_ASK_CHANNEL') || 'telegram';
  const command = env('BROWSER_ASK_CMD') || 'openclaw';
  const body = `${title}\n\n${message}${options.link ? '' : whereToAct()}`;

  const args = ['message', 'send', '--channel', channel, '-t', target, '-m', body];
  if (options.mediaPath)
    args.push('--media', options.mediaPath);

  return new Promise<NotifyResult>(resolve => {
    execFile(command, args, { timeout: SEND_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) {
        // Stderr first; the exec error's own message is mostly the command line,
        // which echoes the user-facing text back instead of saying what broke.
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        const detail = scrub(String(stderr ?? ''))
          || (failure.killed ? `timed out after ${SEND_TIMEOUT_MS / 1000}s` : '')
          || (typeof failure.code === 'number' ? `exited with code ${failure.code}` : '')
          || (failure.code ? String(failure.code) : '')
          || scrub(error.message);
        trace.write('gate', 'notify', `${channel} send failed: ${detail}`, { ok: false });
        resolve({ ok: false, reason: `${channel} send via ${command} failed: ${detail}` });
        return;
      }
      trace.write('gate', 'notify', `asked the user over ${channel}`, { ok: true });
      resolve({ ok: true });
    });
  });
}

/** Whether an out-of-band channel is configured at all, for callers that want to say so. */
export const canNotifyOutOfBand = (): boolean => Boolean(env('BROWSER_ASK_TARGET'));
