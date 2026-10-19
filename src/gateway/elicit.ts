/**
 * Reaching the person, through the client they are already using.
 *
 * Two directions, kept apart because they reach the person differently. "May I
 * save this?" goes through the client's prompt and defaults to yes when it
 * cannot be shown — the client has already asked about the call itself. "Please
 * solve this CAPTCHA" never goes through the client: it is sent out of band, and
 * the watcher on the page is what releases it.
 *
 * The client arrives after these functions do. The tool list is built at module
 * load and closes over `confirmWithUser`, while the Server that can actually
 * elicit is constructed a few lines later with instructions that have to be
 * awaited first. Rather than reorder that around a detail, `attachClient` is
 * called once the server exists; every caller here runs during a tool call,
 * long after.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { trace } from './context.ts';
import { notifyOutOfBand, scrub } from './notify.ts';
import type { NotifyResult } from './notify.ts';

let client: Server | undefined;

/** Called once, as soon as the server exists. */
export function attachClient(server: Server): void {
  client = server;
}

/** What the connected client says it can do — recorded once per connection. */
export const clientCapabilities = (): Record<string, unknown> =>
  client?.getClientCapabilities() ?? {};

const canAsk = (): boolean => Boolean(client?.getClientCapabilities()?.elicitation);

/**
 * Not "may I", but "please do this" — a CAPTCHA, a sign-in, a card number.
 *
 * Always out of band, never through the client's elicitation prompt. Capability
 * is not presence: Claude Code advertises elicitation in a phone Remote Control
 * session and under `claude -p`, where no human ever sees the dialog, so 53 of
 * 62 measured asks were raised into a window nobody was looking at. The page
 * watcher in askUser is what notices the user act; this only has to tell them.
 *
 * The result is the delivery, not the answer. `ok: false` carries the reason so
 * askUser can return it to the agent as a visible error instead of waiting out a
 * timeout for a user who was never told.
 *
 * `mediaPath` is the page as the user would have seen it — for a code that
 * expires in forty-five seconds it is the difference between a useful ask and a
 * description of something already gone.
 */
export async function requestUserAction(
    title: string, message: string, mediaPath?: string): Promise<NotifyResult> {
  return notifyOutOfBand(title, message, mediaPath ? { mediaPath } : {})
      .catch((error: unknown) => ({ ok: false as const, reason: `notifier crashed: ${scrub(String(error))}` }));
}

/**
 * Saving a procedure means writing code that later agents will run in a browser
 * holding live sessions, so it deserves a look. The client is the right place to
 * ask: it already knows this user's rules, and someone in auto-accept mode has
 * said once, globally, that they do not want to be asked.
 */
export async function confirmWithUser(title: string, message: string): Promise<boolean> {
  if (!client || !canAsk()) {
    trace.write('gate', 'confirm',
      `${title} — the client cannot show a prompt, so this proceeds unasked.`);
    return true;
  }
  try {
    const answer = await client.elicitInput({
      mode: 'form',
      message: `${title}\n\n${message}`,
      requestedSchema: {
        type: 'object',
        properties: {
          proceed: { type: 'boolean', title: 'Save it?', description: 'Yes to store this procedure.' },
        },
        required: ['proceed'],
      },
    });
    const ok = answer.action === 'accept' && answer.content?.['proceed'] === true;
    trace.write('gate', 'confirm', `${title} — the user ${ok ? 'agreed' : 'declined'}.`, { ok });
    return ok;
  } catch {
    // An elicitation that errors must not become a silent refusal of ordinary work.
    trace.write('gate', 'confirm', `${title} — the prompt itself failed, so this proceeds.`);
    return true;
  }
}
