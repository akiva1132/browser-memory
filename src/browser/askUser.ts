import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { z } from 'zod';

import type { LocalTool } from '../types.ts';
import type { HandoffCreated, HandoffView, HqHandoffs } from '../gateway/hq.ts';
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
 * ask goes out as a message to their phone, and then the page is watched for
 * the thing that was asked for: the URL changing, the challenge disappearing,
 * the dashboard appearing. Telling a chat window "ok done" after already doing
 * the thing is exactly the kind of double work that makes people stop using a
 * tool.
 *
 * It never asks through the MCP client's elicitation prompt. Clients advertise
 * that capability in sessions no human is watching (phone Remote Control,
 * `claude -p`), and the measured result was asks that reached nobody. And a
 * send that fails is returned to the agent as an error, immediately — waiting
 * out a timeout for a user who was never told is the failure being fixed.
 */

export type AskDeps = {
  /** Upstream browser call. Deliberately the un-observed path: this reads pages mid-login. */
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * Sends the request to wherever the user actually is (Telegram, out of band).
   * Resolves with whether it was delivered; it is never the user's answer —
   * only the page watcher below can see them act. A failed delivery carries a
   * reason, which is returned to the agent rather than swallowed.
   */
  ask: (title: string, message: string, mediaPath?: string, link?: string) => Promise<AskDelivery>;
  /**
   * hq's tab handoff (agent-company B.9), when this runs on a machine that has
   * one: a one-time link that puts this session's own tab on the user's phone,
   * and a "done" button that comes straight back here. Absent, the ask is the
   * message alone and the page watcher is the only way to see them act.
   */
  handoffs?: HqHandoffs;
  /** This session's recorded tab (its CDP target id): the fallback when the current page cannot name its own target. */
  ownTarget?: () => string | undefined;
};

export type AskDelivery = { ok: true } | { ok: false; reason: string };

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

/** The same, for the message the user reads. */
const NEEDS_HE: Record<keyof typeof NEEDS, string> = {
  captcha: 'אימות "אני לא רובוט"',
  login: 'כניסה לחשבון, כולל אימות דו-שלבי',
  payment: 'פרטי כרטיס או תשלום',
  'form-field': 'שדה בטופס שאי אפשר לדעת מהדף מה למלא בו',
  consent: 'אישור עוגיות, תנאים או הרשאה',
  other: 'משהו שרק אתה יכול לעשות כאן',
};

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
 * The CDP target of the page this session is driving right now — the one the
 * probe read and the screenshot shows — so the phone gets that tab.
 *
 * `ownTarget` alone is not it. That is the window opened at the start of the
 * session, and Playwright's current page drifts away from it: a `browser_tabs
 * new` or `select`, or the upstream resetting its current page, and the agent
 * works in another tab while the recorded one stays on its blank marker. Handed
 * that, the phone showed a white page titled "blank" three times running
 * (26/10, Mercury), while the screenshot in the same message showed the login.
 *
 * Asked through the page itself, because the tab listing offers indices and
 * URLs but no target ids. Undefined when the browser cannot say; the caller
 * then falls back to the recorded tab.
 */
async function currentTarget(deps: AskDeps): Promise<string | undefined> {
  try {
    const body = bodyOf(await deps.call('browser_run_code_unsafe', {
      code: 'async (page) => { const s = await page.context().newCDPSession(page); ' +
        'try { const r = await s.send("Target.getTargetInfo"); return "target:" + r.targetInfo.targetId; } ' +
        'finally { await s.detach().catch(() => {}); } }',
    }));
    return /target:([0-9A-Fa-f]{16,})/.exec(body)?.[1];
  } catch {
    return undefined;
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

/**
 * Another worker is signing the user in to this site right now. Asking as well
 * would race it — two codes, one void — and the browser profile is shared, so
 * when theirs finishes this session is usually signed in too.
 */
async function waitForOthersLogin(
    handoffs: HqHandoffs, busy: HandoffView, seconds: number, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  let view: HandoffView | undefined = busy;
  // Cancelled, this must not stay a waiter on the other worker's handoff: hq mails the ending only when none is left.
  while (view?.state === 'live' && Date.now() < deadline && !signal?.aborted)
    view = await handoffs.wait(busy.id, Math.min(25_000, deadline - Date.now()), signal).catch(() => undefined) ?? view;
  const who = busy.from ?? 'another session';
  if (view?.state === 'live') {
    return `Another worker (${who}) is already having the user sign in to ${busy.domain}, and that is still ` +
      `going after ${seconds}s. Asking as well would send a second code and void the first. Wait, then ` +
      `take a fresh snapshot — the browser profile is shared, so their sign-in is yours too.`;
  }
  return `Another worker (${who}) was already having the user sign in to ${busy.domain}; that has now ` +
    `ended (${view?.state ?? 'unknown'}). The browser profile is shared, so reload and take a fresh snapshot: ` +
    `you are probably signed in. Only if you are not, call this again.`;
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
        'This brings your tab to the front, sends the user a message on their phone with a screenshot ' +
        'of the page — and, on the company server, a one-time link that shows them just your tab — and then ' +
        'waits. It returns as soon as the page shows they are done or they press "done" on the phone — they do ' +
        'not have to come back and tell you. If the message cannot be sent — or, on the company server, hq ' +
        'cannot make the phone link — it fails at once and says why; then fix that or tell the user yourself, ' +
        'in your reply, what is needed. Give `untilTextGone` or `untilTextAppears` when you can ' +
        'name what will change, and it will notice within a second or two instead of waiting for a URL ' +
        'change.\n\n' +
        (deps.handoffs
          ? 'If this call is interrupted (a message arrived while it waited) after a phone link went out, the ' +
            'request is NOT cancelled: the link stays live, and when the user finishes, declines or it expires ' +
            'you get a message saying so. Do not call it again for the same step; answer the message and wait ' +
            'for that one. If no link went out, take a snapshot and ask again if it is still needed.\n\n'
          : 'If this call is interrupted (a message arrived while it waited), nothing reports back afterwards: ' +
            'take a snapshot, and ask again if the step is still not done.\n\n') +
        'Say what you need in plain language, as if to someone who cannot see your reasoning.',
      schema: {
        need: z.enum(['captcha', 'login', 'payment', 'form-field', 'consent', 'other'])
            .describe('What kind of step this is.'),
        what: z.string().describe(
            'What the user should do, concretely. It reaches them exactly as written, so write it in ' +
            'Hebrew — they do not read English. e.g. "לסמן את התיבה של reCAPTCHA בתחתית הטופס" or ' +
            '"להיכנס עם חשבון הגוגל של Cloudflare".'),
        why: z.string().optional().describe(
            'Why you cannot do it yourself, in one line, in Hebrew like `what`. Skip it when it is obvious.'),
        untilTextGone: z.string().optional().describe(
            'Text on the page now that will be gone once they are done, e.g. the challenge prompt.'),
        untilTextAppears: z.string().optional().describe(
            'Text that will appear once they are done, e.g. a heading on the page behind the login.'),
        timeoutSeconds: z.number().optional().describe(
            `How long to wait. Default ${DEFAULT_TIMEOUT_S}, maximum ${MAX_TIMEOUT_S}. On timeout this ` +
            'returns without failing, so you can report where things stand and ask again.'),
      },
      handle: async (args, signal) => {
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

        /*
         * The handoff first, because its link goes into the message. Another
         * worker already signing in to the same site holds hq's login lock: two
         * sign-ins at once would send two SMS codes and the first would be
         * void. The profile is shared, so the right move is to wait for theirs.
         */
        const handoff = deps.handoffs
          ? await deps.handoffs.create({ target: (await currentTarget(deps)) ?? deps.ownTarget?.(), url: before.url || undefined, what, need })
              .catch((error: unknown): HandoffCreated => ({ ok: false, reason: String(error) }))
          : undefined;
        const busy = handoff && !handoff.ok ? handoff.busy : undefined;
        if (busy && busy.from !== deps.handoffs!.identity)
          return waitForOthersLogin(deps.handoffs!, busy, seconds, signal);
        /*
         * hq is here and did not open the link: the user's app gets no card, so
         * falling back to the chat message and waiting is the silent "still
         * running" this must never be (31/10: hq refused a file:// page with a
         * 400, the agent waited out its timeout, and the user saw only a bare
         * tool row). Its reason says what to fix — usually the tab.
         */
        if (handoff && !handoff.ok && !handoff.busy && !handoff.noHq) {
          // "NOT asked" (and "NOT notified" below) is read by the company app: it marks the card as never sent.
          const tab = /blank|not open/.test(handoff.reason)
            ? ' (`browser_tabs select` the tab with the page they must act on)'
            : '';
          throw new Error(
              `the user was NOT asked — hq could not open the phone link: ${handoff.reason}. ` +
              `Fix what that says${tab} and call this again. If you cannot, tell the user directly what is ` +
              `needed (${what}) and report this error.`);
        }
        // Our own live link for this site is already on their phone: wait on it, do not send another.
        const handoffId = handoff?.ok ? handoff.handoff.id : busy?.id;
        const link = handoff?.ok ? handoff.link : undefined;

        // In Hebrew: this is read by the user, and he does not read English (agent-company dir-0002).
        const message =
          `${what}\n\n` +
          `${why ? `${why}\n\n` : ''}` +
          (link
            ? `זה ${NEEDS_HE[need] ?? NEEDS_HE.other}. פתח את הקישור בטלפון: הוא מציג רק את הדף הזה, בגודל של ` +
              `טלפון ועם המקלדת שלך (מכשיר אחד, 10 דקות): ${link}\nכשתסיים, לחץ "סיימתי" ואני אמשיך לבד.`
            : `זה ${NEEDS_HE[need] ?? NEEDS_HE.other}. הטאב בדפדפן הובא לחזית. עשה את זה שם ואני אמשיך לבד, ` +
              `אין צורך לענות כאן.`);

        /*
         * Taken here rather than earlier: after the tab is raised, so it is the
         * page being asked about, and as late as possible, because anything with
         * a countdown on it is worth least the moment after it is captured.
         */
        const shot = busy ? undefined : await pageShot(deps);

        /*
         * Sent before anything waits. A delivery that failed is the one outcome
         * that must never turn into a silent timeout: nobody was told, so there
         * is nothing to wait for. Thrown, it reaches the agent as an error
         * result with the reason in it. With a handoff, hq has already put the
         * link in the user's "waiting for you" list and pushed it, so a failed
         * message is a note rather than a dead end.
         */
        const delivery: AskDelivery = busy
          ? { ok: true }
          : await deps.ask(`תורך: ${what.slice(0, 80)}`, message, shot, link)
              .catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
        if (!delivery.ok && !handoffId) {
          throw new Error(
              `the user was NOT notified — ${delivery.reason}. Nobody knows this step is waiting. ` +
              `Do not wait for it and do not retry the step yourself: tell the user directly, in your ` +
              `reply, what is needed (${what}), and report the notification failure.`);
        }
        const deliveryNote = delivery.ok ? '' :
          `\n(The chat message failed — ${delivery.reason} — but the link reached the user's company app.)`;

        /*
         * Held in an object rather than a bare `let`, so the compiler keeps the
         * whole union in view: assigned only from callbacks, a plain variable
         * narrows to its initial value and every later comparison reads as
         * unreachable.
         */
        const outcome: { via: 'page-changed' | 'timeout' | 'nothing-to-watch' | 'handoff-ended' | 'cancelled'; ended?: HandoffView } =
          { via: 'timeout' };
        const deadline = Date.now() + seconds * 1000;
        /**
         * Stops the watcher the moment the wait is over. Without it the watcher
         * keeps interrogating the page for the rest of the timeout after the
         * user has already finished — dozens of pointless round trips against a
         * live browser, and a process that will not exit.
         */
        let settled = false;

        if (alreadySatisfied && !handoffId) {
          /*
           * The marker was already true before anyone was asked, so it cannot
           * mark the change, and no reply is coming back through this channel.
           * Nothing would be left in the race but the expiry timer; say so now
           * rather than in fifteen minutes.
           */
          outcome.via = 'nothing-to-watch';
        } else {
          const watched = (async (): Promise<void> => {
            // A marker that was already true cannot mark the change; then only the handoff can.
            if (alreadySatisfied)
              return new Promise<void>(() => {});
            while (!settled && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, POLL_MS));
              if (settled)
                return;
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
          })();

          /*
           * "סיימתי" on the phone (or in the app) ends the handoff in hq, and
           * this long-poll returns with it — the wake-up does not depend on the
           * page showing anything.
           */
          const handedOver = (async (): Promise<void> => {
            if (!handoffId || !deps.handoffs)
              return new Promise<void>(() => {});
            while (!settled && Date.now() < deadline) {
              const view = await deps.handoffs.wait(handoffId, Math.min(25_000, deadline - Date.now()), signal)
                  .catch(() => undefined);
              if (settled)
                return;
              if (!view) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
              }
              if (view.state !== 'live') {
                settled = true;
                outcome.via = 'handoff-ended';
                outcome.ended = view;
                return;
              }
            }
          })();

          /*
           * The client gave up on this call: Claude Code cancels a running tool
           * when a message for the agent arrives. Nobody will read what this
           * returns, so stop watching and let go of hq's long-poll — with no
           * waiter left, hq sends the ending (done, declined, expired) to the
           * worker's mailbox, which is what the tool description promises.
           * The page is no longer watched, so a user who finishes on the page
           * without pressing "סיימתי" reads as expired when the link runs out.
           */
          let onAbort: (() => void) | undefined;
          const cancelled = new Promise<void>(resolve => {
            if (!signal)
              return;
            onAbort = () => { outcome.via = 'cancelled'; resolve(); };
            if (signal.aborted)
              onAbort();
            else
              signal.addEventListener('abort', onAbort, { once: true });
          });

          let expiry: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              cancelled,
              watched,
              handedOver,
              new Promise(resolve => { expiry = setTimeout(resolve, seconds * 1000); }),
            ]);
          } finally {
            settled = true;
            clearTimeout(expiry);
            if (onAbort)
              signal?.removeEventListener('abort', onAbort);
          }
        }

        if (outcome.via === 'cancelled') {
          return `Cancelled by the client before it finished. The request is still with the user` +
            `${handoffId ? '; its ending will arrive as a message' : ''}.`;
        }

        const after = await probe(deps, marker).catch(() => ({ url: '', present: false }));
        const moved = (after.url && after.url !== before.url ? `\nThe page is now ${after.url}.` : '') + deliveryNote;

        // The page shows it is done: close the handoff, so the phone says "thanks" and the link is spent.
        if (outcome.via === 'page-changed' && handoffId)
          await deps.handoffs?.end(handoffId, after.url || undefined).catch(() => {});

        if (outcome.via === 'handoff-ended') {
          const ended = outcome.ended!;
          if (ended.state === 'done') {
            return `The user has done it — they finished on their phone and pressed "done".${moved}\n\n` +
              `Take a fresh snapshot before acting: the page is not where you left it.`;
          }
          const why = ended.state === 'expired' ? 'the link expired before they got to it'
            : ended.state === 'closed' ? 'your tab was closed'
            : 'they declined it for now';
          return `The handoff ended without the step being done: ${why}.${moved}\n\n` +
            `Do not retry the step yourself. Tell the user plainly what is still needed (${what}), and ` +
            `call this again if they say they are ready.`;
        }

        // Reported as unfinished, not as done: the marker was true before the
        // user was asked anything, so it never described the state being waited
        // for and nothing here has evidence either way. Saying "the user has
        // done it" would be an invention.
        if (outcome.via === 'nothing-to-watch') {
          return `Asked, but there is no way to tell when it is finished: ` +
            `\`${gone ? 'untilTextGone' : 'untilTextAppears'}\` was already ` +
            `${gone ? 'absent' : 'present'} before the user was asked, so it cannot mark the change. ` +
            `The user has been sent the request, but nothing reports back when they are done.${moved}\n\n` +
            `Either call this again with a marker ` +
            `that is only true afterwards, or take a snapshot and check for yourself.`;
        }

        if (outcome.via === 'timeout') {
          const stillLive = handoffId
            ? `\n\nThe phone link stays valid for its 10 minutes. Whatever happens to it after this — done, ` +
              `declined or expired — you will get a message saying so; you do not need to poll.`
            : '';
          return `Waited ${seconds}s and detected no change on the page — it has probably not been done yet, ` +
            `though a change this cannot see (inside an iframe, or with no marker given) is possible.` +
            `${moved}${stillLive}\n\nDo not retry the step yourself. Take a snapshot to check, tell the user plainly ` +
            `what is still needed (${what}), and call this again — with \`untilTextGone\` or ` +
            `\`untilTextAppears\` if you can name what will change — if they say they are ready.`;
        }
        return `The user has done it — the page changed while waiting.` +
          `${moved}\n\nTake a fresh snapshot before acting: the page is not where you left it.`;
      },
    },
  ];
}
