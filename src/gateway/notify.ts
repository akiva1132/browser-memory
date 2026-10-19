import { execFile } from 'node:child_process';

import { trace } from './context.ts';

/**
 * Reaching the person when the client cannot reach them.
 *
 * `requestUserAction` asks through the MCP client, which is right on a laptop:
 * the prompt appears in the window the user is already looking at. On a server
 * it is a dead end. A session driven from Telegram, from `claude -p`, or from a
 * scheduled job declares no elicitation capability at all, so the ask is never
 * made — the tool falls straight through to watching the page and times out
 * three minutes later having told nobody anything. From the user's side the
 * agent simply hangs.
 *
 * So when the client cannot ask, the message goes out of band instead. The
 * chat app is the right channel because it is the one place the user actually
 * is: a CAPTCHA screenshot lands on their phone, they glance at it, and the
 * page watcher in askUser notices the challenge clear without them replying to
 * anything.
 *
 * Everything here is opt-in through the environment. With `BROWSER_ASK_TARGET`
 * unset this is a no-op, which is exactly what the laptop wants — there the
 * client can ask, and a second notification would be noise.
 */

/** Long enough for an image upload, short enough not to stall the ask. */
const SEND_TIMEOUT_MS = 30_000;

type NotifyOptions = {
  /** A local file to attach — the CAPTCHA itself is worth more than any description of it. */
  mediaPath?: string;
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
 * Returns true only when the message was handed off successfully. A false here
 * is not "the user said no" — it means nobody was told, and the caller should
 * keep behaving as though the request is still unanswered.
 */
export async function notifyOutOfBand(
    title: string, message: string, options: NotifyOptions = {}): Promise<boolean> {
  const target = env('BROWSER_ASK_TARGET');
  if (!target)
    return false;

  const channel = env('BROWSER_ASK_CHANNEL') || 'telegram';
  const command = env('BROWSER_ASK_CMD') || 'openclaw';
  const body = `${title}\n\n${message}${whereToAct()}`;

  const args = ['message', 'send', '--channel', channel, '-t', target, '-m', body];
  if (options.mediaPath)
    args.push('--media', options.mediaPath);

  return new Promise<boolean>(resolve => {
    execFile(command, args, { timeout: SEND_TIMEOUT_MS }, error => {
      if (error) {
        /*
         * Worth tracing rather than throwing. This runs inside an ask that is
         * already the fallback path; making the whole tool fail because the
         * notifier is misconfigured would replace a silent hang with a loud
         * one and still leave the user stuck.
         */
        trace.write('gate', 'notify', `${channel} send failed: ${error.message}`, { ok: false });
        resolve(false);
        return;
      }
      trace.write('gate', 'notify', `asked the user over ${channel}`, { ok: true });
      resolve(true);
    });
  });
}

/** Whether an out-of-band channel is configured at all, for callers that want to say so. */
export const canNotifyOutOfBand = (): boolean => Boolean(env('BROWSER_ASK_TARGET'));
