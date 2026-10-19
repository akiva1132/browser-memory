import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { z } from 'zod';

import type { LocalTool } from '../types.ts';
import { bodyOf } from '../lib/toolResult.ts';
import type { ToolResult } from '../lib/toolResult.ts';
export type { ToolResult };

/**
 * Handing control back to the person, and taking it back when they are done.
 *
 * Some steps are not the agent's to do. A CAPTCHA is designed to refuse it. A
 * login is the user's credential, not the agent's. A card number is not
 * something to hand a model, and a form field whose meaning is genuinely
 * ambiguous is a guess that silently corrupts real data. In all of those the
 * right move is to stop and ask — and the failure mode today is that the agent
 * instead tries, fails, retries, and eventually reports the task as impossible.
 *
 * Two things make this usable rather than annoying:
 *
 * The tab is brought to the front first. The agent works in its own tab, which
 * is deliberately not the one the user is looking at, so "please solve the
 * CAPTCHA" is useless unless the page in question is actually on screen.
 *
 * And it returns the moment the user acts, without them having to say so. The
 * ask goes out through the client's own prompt, but at the same time the page
 * is watched for the thing that was asked for: the URL changing, the challenge
 * disappearing, the dashboard appearing. Whichever happens first releases it.
 * Telling a chat window "ok done" after already doing the thing is exactly the
 * kind of double work that makes people stop using a tool.
 */

export type AskDeps = {
  /** Upstream browser call. Deliberately the un-observed path: this reads pages mid-login. */
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * Puts the request in front of the user through the client they are already
   * using, so it obeys whatever permission rules they have chosen rather than
   * inventing a second set. Resolves false when the client cannot ask, which is
   * not a refusal — the watcher below still runs.
   */
  ask: (title: string, message: string, mediaPath?: string) => Promise<boolean>;
};

const POLL_MS = 1500;
const DEFAULT_TIMEOUT_S = 180;
const MAX_TIMEOUT_S = 900;

/** Enough for the model to say what it needs without inventing prose for it. */
const NEEDS = {
  captcha: 'a CAPTCHA or "I am not a robot" challenge',
  login: 'a sign-in, including SSO and two-factor',
  payment: 'card or payment details',
  'form-field': 'a form field whose correct value is not knowable from the page',
  consent: 'a cookie banner, terms acceptance or permission prompt',
  other: 'something else only a person can do here',
} as const;

/**
 * One probe of the page: where it is, and whether the caller's marker text is
 * present. Kept to a single evaluate so watching costs one round trip.
 *
 * The result is a delimited string rather than JSON because the value comes
 * back through another layer of string encoding, which leaves every quote
 * escaped. A JSON reply parsed cleanly in the first draft of the test and would
 * have matched nothing at all against a real page.
 */
async function probe(deps: AskDeps, marker: string): Promise<{ url: string; present: boolean }> {
  const test = marker ? `document.body.innerText.includes(${JSON.stringify(marker)})` : 'false';
  const result = await deps.call('browser_evaluate', {
    function: `() => "probe:" + location.href + " marker:" + (${test})`,
  });
  const found = /probe:(\S*)\s+marker:(true|false)/.exec(bodyOf(result));
  return { url: found?.[1] ?? '', present: found?.[2] === 'true' };
}

/**
 * Selecting a tab is what raises it on screen. Which index is ours has to be
 * read back rather than assumed: the listing marks the session's current tab,
 * and that marker is the only reliable way to point at our own page instead of
 * whichever one the user has open.
 */
async function bringOurTabToFront(deps: AskDeps): Promise<void> {
  try {
    const listing = bodyOf(await deps.call('browser_tabs', { action: 'list' }));
    const current = listing.split('\n').find(line => /current/i.test(line));
    const index = current ? Number(/(\d+)/.exec(current)?.[1]) : NaN;
    await deps.call('browser_tabs', {
      action: 'select',
      ...(Number.isFinite(index) ? { index } : {}),
    });
  } catch {
    // Being unable to raise the tab is worth continuing past: the user can
    // still switch to it themselves, and the request is about to be shown.
  }
}

/**
 * The page as a picture, for the message that leaves the machine.
 *
 * Raising the tab is enough on a laptop. On a server the tab is on a display
 * nobody is sitting at, and the person is on their phone — so the ask has to
 * carry the thing itself. A CAPTCHA is easier to read than to describe, and a
 * short-lived code cannot be described at all: by the time anyone walks to the
 * desk a forty-five second QR has already been replaced.
 *
 * Failure is deliberately quiet and deliberately not fatal. An ask with no
 * picture is still an ask; an ask that threw because a screenshot failed is a
 * user who was never told anything.
 */
async function pageShot(deps: AskDeps): Promise<string | undefined> {
  try {
    /*
     * No `filename`: passing one writes relative to this process's cwd, which is
     * not the output directory and not anywhere the caller can read afterwards.
     * Left off, the upstream tool puts it in PLAYWRIGHT_MCP_OUTPUT_DIR and says
     * where in the result.
     */
    const body = bodyOf(await deps.call('browser_take_screenshot', { scale: 'device' }));
    const found = /\(([^()]+\.(?:png|jpe?g))\)/i.exec(body)?.[1];
    if (!found)
      return undefined;
    // The path comes back relative to the output directory, so resolve it there
    // rather than against a cwd that has nothing to do with it.
    const dir = (process.env['PLAYWRIGHT_MCP_OUTPUT_DIR'] ?? '').trim();
    const shot = found.startsWith('/') ? found : dir ? join(dir, basename(found)) : '';
    if (!shot)
      return undefined;
    return stageForSending(shot);
  } catch {
    return undefined;
  }
}

/**
 * The output directory is where the browser writes; it is not necessarily
 * anywhere the chat client is allowed to read from. OpenClaw, for one, refuses
 * a local attachment outside its workspace — `LocalMediaAccessError` — and the
 * refusal surfaces as a send that failed, which notify.ts swallows, which is a
 * user who was told nothing and an agent that waits out its whole timeout.
 *
 * Copying into a directory the client already trusts is the cheap fix, and a
 * better one than relaxing that boundary: the workspace stays the only place
 * outbound files come from. Unset — the laptop, where the client reads
 * anywhere — this returns the original path untouched.
 */
function stageForSending(shot: string): string {
  const staging = (process.env['BROWSER_ASK_MEDIA_DIR'] ?? '').trim();
  if (!staging)
    return shot;
  try {
    mkdirSync(staging, { recursive: true });
    const staged = join(staging, basename(shot));
    copyFileSync(shot, staged);
    return staged;
  } catch {
    // Better to try sending the original than to send nothing at all.
    return shot;
  }
}

export function askUserTools(deps: AskDeps): LocalTool[] {
  return [
    {
      name: 'browser_ask_user',
      title: 'Stop and ask the person to do this part',
      description:
        'Hand control to the user for a step that is not yours to do, then carry on when they have ' +
        'done it.\n\n' +
        'Use it the moment you recognise one, rather than after failing:\n' +
        `- ${NEEDS.captcha} — but try it yourself first; escalate after two failed attempts\n` +
        `- ${NEEDS.login} — only once \`browser_credentials_list\` shows nothing stored for the site\n` +
        `- ${NEEDS.payment} — never type a card number yourself\n` +
        `- ${NEEDS['form-field']} — a plausible guess in a real form is worse than a question\n` +
        `- ${NEEDS.consent}\n\n` +
        'This brings your tab to the front so the user is looking at the right page, asks them through ' +
        'their own client, and then waits. It returns as soon as the page shows they are done — they do ' +
        'not have to come back and tell you. Give `untilTextGone` or `untilTextAppears` when you can ' +
        'name what will change, and it will notice within a second or two instead of waiting for a URL ' +
        'change.\n\n' +
        'Say what you need in plain language, as if to someone who cannot see your reasoning.',
      schema: {
        need: z.enum(['captcha', 'login', 'payment', 'form-field', 'consent', 'other'])
            .describe('What kind of step this is.'),
        what: z.string().describe(
            'What the user should do, concretely, in their words. e.g. "Tick the reCAPTCHA box at the ' +
            'bottom of the form" or "Sign in with the Google account you use for Cloudflare".'),
        why: z.string().optional().describe(
            'Why you cannot do it yourself, in one line. Skip it when it is obvious.'),
        untilTextGone: z.string().optional().describe(
            'Text on the page now that will be gone once they are done, e.g. the challenge prompt.'),
        untilTextAppears: z.string().optional().describe(
            'Text that will appear once they are done, e.g. a heading on the page behind the login.'),
        timeoutSeconds: z.number().optional().describe(
            `How long to wait. Default ${DEFAULT_TIMEOUT_S}, maximum ${MAX_TIMEOUT_S}. On timeout this ` +
            'returns without failing, so you can report where things stand and ask again.'),
      },
      handle: async args => {
        const need = String(args['need'] ?? 'other') as keyof typeof NEEDS;
        const what = String(args['what'] ?? '').trim();
        const why = String(args['why'] ?? '').trim();
        const gone = String(args['untilTextGone'] ?? '');
        const appears = String(args['untilTextAppears'] ?? '');
        const seconds = Math.min(
            MAX_TIMEOUT_S, Math.max(5, Number(args['timeoutSeconds']) || DEFAULT_TIMEOUT_S));
        if (!what)
          throw new Error('`what` must say what the user should do.');

        // Without this the user is being asked about a page they cannot see:
        // the agent's tab is deliberately not the one they are reading.
        await bringOurTabToFront(deps);

        const marker = gone || appears;
        const before = await probe(deps, marker).catch(() => ({ url: '', present: false }));
        // Asking to wait for text that is already gone, or already present,
        // would return instantly and look like the user acted in zero seconds.
        const alreadySatisfied = (gone && !before.present) || (appears && before.present);

        const message =
          `${what}\n\n` +
          `${why ? `${why}\n\n` : ''}` +
          `This is ${NEEDS[need] ?? NEEDS.other}. Your browser tab has been brought to the front — ` +
          `do it there and I will carry on by myself. You do not need to reply here.`;

        /*
         * Held in an object rather than a bare `let`, so the compiler keeps the
         * whole union in view: assigned only from callbacks, a plain variable
         * narrows to its initial value and every later comparison reads as
         * unreachable.
         */
        const outcome: { via: 'user-said-so' | 'page-changed' | 'timeout' | 'nothing-to-watch' } =
          { via: 'timeout' };
        const deadline = Date.now() + seconds * 1000;
        /**
         * Everything below stops the moment one of them wins. Without it the
         * watcher keeps interrogating the page for the rest of the timeout
         * after the user has already finished — dozens of pointless round trips
         * against a live browser, and a process that will not exit.
         */
        let settled = false;

        /**
         * Only ever settles on success. A client that cannot elicit answers
         * "no" immediately, and a race that treated that as an outcome would
         * abandon the user mid-CAPTCHA a millisecond after asking them.
         */
        const pending = new Promise<void>(() => {});

        /*
         * Taken here rather than earlier: after the tab is raised, so it is the
         * page being asked about, and as late as possible, because anything with
         * a countdown on it is worth least the moment after it is captured.
         */
        const shot = await pageShot(deps);

        const answered = deps.ask(`Your turn: ${what.slice(0, 80)}`, message, shot)
            .then(ok => {
              if (ok && !settled) {
                settled = true;
                outcome.via = 'user-said-so';
                return undefined;
              }
              /*
               * A client that cannot elicit answers "no" immediately, and the
               * page watcher is already standing down because the marker was
               * true before anyone was asked. With both of those, the only
               * thing left in the race is the expiry timer — so the tool sat
               * out its whole timeout, up to fifteen minutes, over a condition
               * it had already decided it could not measure. Nothing is going
               * to arrive; say so now rather than in three minutes.
               */
              if (!ok && alreadySatisfied && !settled) {
                settled = true;
                outcome.via = 'nothing-to-watch';
                return undefined;
              }
              return pending;
            })
            .catch(() => pending);

        const watched = (async (): Promise<void> => {
          if (alreadySatisfied)
            return pending;
          while (!settled && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
            if (settled)
              return pending;
            const now = await probe(deps, marker).catch(() => undefined);
            if (!now)
              continue;
            const done = gone
              ? !now.present
              : appears
                ? now.present
                : Boolean(now.url) && now.url !== before.url;
            if (done) {
              settled = true;
              outcome.via = 'page-changed';
              return;
            }
          }
          return pending;
        })();

        let expiry: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            answered,
            watched,
            new Promise(resolve => { expiry = setTimeout(resolve, seconds * 1000); }),
          ]);
        } finally {
          settled = true;
          clearTimeout(expiry);
        }

        const after = await probe(deps, marker).catch(() => ({ url: '', present: false }));
        const moved = after.url && after.url !== before.url ? `\nThe page is now ${after.url}.` : '';

        // Reported as unfinished, not as done: the marker was true before the
        // user was asked anything, so it never described the state being waited
        // for and nothing here has evidence either way. Saying "the user has
        // done it" would be an invention.
        if (outcome.via === 'nothing-to-watch') {
          return `Asked, but there is no way to tell when it is finished: ` +
            `\`${gone ? 'untilTextGone' : 'untilTextAppears'}\` was already ` +
            `${gone ? 'absent' : 'present'} before the user was asked, so it cannot mark the change — ` +
            `and this client cannot report back when they are done.${moved}\n\n` +
            `Tell the user plainly what is needed (${what}). Then either call this again with a marker ` +
            `that is only true afterwards, or take a snapshot and check for yourself.`;
        }

        if (outcome.via === 'timeout') {
          return `Waited ${seconds}s and the page has not changed — it looks like this has not been done yet.` +
            `${moved}\n\nDo not retry the step yourself. Tell the user plainly what is still needed ` +
            `(${what}), and call this again if they say they are ready.`;
        }
        return `The user has done it${outcome.via === 'page-changed' ? ' — the page changed while waiting' : ''}.` +
          `${moved}\n\nTake a fresh snapshot before acting: the page is not where you left it.`;
      },
    },
  ];
}
