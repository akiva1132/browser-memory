/**
 * Reaching the person, through the client they are already using.
 *
 * Two directions, and they are kept apart because their fallbacks are
 * opposites. "May I save this?" that cannot be shown defaults to yes — the
 * client has already asked about the call itself, and turning ordinary work
 * into a silent refusal because a prompt was unavailable helps nobody. "Please
 * solve this CAPTCHA" that cannot be shown must default to *not* done; the
 * watcher on the page is what releases it, and answering yes for a user who was
 * never asked steps straight past the thing they have not solved.
 *
 * The client arrives after these functions do. The tool list is built at module
 * load and closes over `requestUserAction`, while the Server that can actually
 * elicit is constructed a few lines later with instructions that have to be
 * awaited first. Rather than reorder that around a detail, `attachClient` is
 * called once the server exists; every caller here runs during a tool call,
 * long after.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { trace } from './context.ts';
import { notifyOutOfBand } from './notify.ts';

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
 * Not "may I", but "please do this, and tell me when" — a CAPTCHA, a sign-in, a
 * card number. False means it was not done, including when it could not be asked.
 *
 * `mediaPath` is the page as the user would have seen it. For a CAPTCHA it saves
 * them opening the desk at all; for a code that expires — a bank's scan-to-log-in
 * QR is good for forty-five seconds — it is the difference between the ask being
 * useful and being a description of something already gone. It rides the
 * out-of-band message because that is the copy that reaches a phone.
 */
export async function requestUserAction(
    title: string, message: string, mediaPath?: string): Promise<boolean> {
  /*
   * The out-of-band copy goes first, and goes regardless of what the client can
   * do. Gating it on `canAsk()` was wrong in a way that only shows on a server:
   * `claude -p` *does* advertise elicitation, so the prompt was dutifully raised
   * into a session with no human attached, answered by nobody, and the user was
   * never told anything. Capability is not presence.
   *
   * `BROWSER_ASK_TARGET` is therefore the switch, not the client's capability
   * flags. Unset — the laptop — this is a no-op and the behaviour below is
   * exactly what it always was. Set, it means "there is a chat channel where
   * this user actually is", and a message there is never the wrong move.
   */
  const toldOutOfBand =
    await notifyOutOfBand(title, message, mediaPath ? { mediaPath } : {}).catch(() => false);

  /*
   * Once the message has actually reached the chat channel, the client prompt is
   * not a second chance — it is a trap. `claude -p` advertises elicitation while
   * no human is attached to it, so `elicitInput` below is raised into a session
   * nobody is looking at and never resolves; the whole tool then sits out its
   * timeout with the user's own screenshot already on their phone, waiting for a
   * tick they cannot possibly give. Worse, the run is blocked meanwhile, so
   * every message they send in the chat aborts it instead of arriving.
   *
   * Delivery out of band therefore ends the asking. False is the honest answer —
   * nothing here is evidence the step was done — and it hands the decision to
   * askUser's page watcher, which is the only thing that can actually see the
   * user act.
   */
  if (toldOutOfBand)
    return false;

  /*
   * Still false when nobody can be prompted: nothing here is evidence the thing
   * was done. False keeps askUser's page watcher running, which is the part
   * that notices the challenge clearing without the user replying to anything.
   */
  if (!client || !canAsk())
    return false;
  try {
    const answer = await client.elicitInput({
      mode: 'form',
      message: `${title}\n\n${message}`,
      requestedSchema: {
        type: 'object',
        properties: {
          done: {
            type: 'boolean',
            title: 'Done?',
            description: 'Tick once you have done it in the browser. You can also just do it and ignore this.',
          },
        },
        required: ['done'],
      },
    });
    return answer.action === 'accept' && answer.content?.['done'] === true;
  } catch {
    return false;
  }
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
