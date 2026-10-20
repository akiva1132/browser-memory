/**
 * The browser this session talks to, and the one tab it owns there.
 *
 * Everything in here is about a resource held for the length of a session: a
 * connection that outlives any single call, a tab claimed at the start and
 * handed back at the end, and a timer that reads the page's traffic after it has
 * settled. The dispatcher used to own all three as loose module variables and
 * poke at them from the middle of a tool call — `opened.add(path)`, compare
 * against `currentDomain`, flush the old domain's places, restart the timer —
 * which is four statements of bookkeeping inlined into the one function that
 * should be about routing a call.
 *
 * So the dispatcher now says what happened (`noteNavigation`) and this decides
 * what that means.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { PagesSeen } from '../capture/pagesSeen.ts';
import { prune } from '../lib/rotate.ts';
import { bodyOf } from '../lib/toolResult.ts';
import type { ToolResult } from '../lib/toolResult.ts';
import {
  apiMap, audit, observer, OUTPUT_DIR, OUTPUT_KEEP_DAYS, places, tabs, UPSTREAM,
} from './context.ts';

/**
 * The upstream server restarts independently of us (systemd owns it), so the
 * connection is established lazily and torn down on error rather than assumed.
 */
let upstream: Client | undefined;
let connecting: Promise<Client> | undefined;

async function connectUpstream(): Promise<Client> {
  const client = new Client({ name: 'browser-gateway', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM)));
  client.onclose = () => {
    if (upstream === client)
      upstream = undefined;
  };
  return client;
}

export async function getUpstream(): Promise<Client> {
  if (upstream)
    return upstream;
  connecting ??= connectUpstream()
      .then(client => (upstream = client))
      .finally(() => (connecting = undefined));
  return connecting;
}

/**
 * A call to the browser with no tab claim and no observation.
 *
 * Used for this gateway's own bookkeeping — opening and closing its tab,
 * reading the network log — and by the ask-the-user tools, which read pages
 * mid-login and must keep none of it.
 */
export async function rawCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const client = await getUpstream();
  try {
    return await client.callTool({ name, arguments: args }) as ToolResult;
  } catch {
    // A dropped connection should cost one retry, not the agent's whole task.
    upstream = undefined;
    const retry = await getUpstream();
    return await retry.callTool({ name, arguments: args }) as ToolResult;
  }
}

/**
 * Each gateway process serves exactly one agent, so it takes exactly one tab.
 *
 * Playwright already tracks a current tab per MCP session — the problem is that
 * a fresh session adopts whatever page happens to exist instead of opening its
 * own. Measured with three concurrent agents: one of them navigated and got
 * back another agent's destination. On a navigate-and-report task that costs a
 * retry; on a fill-the-form-then-submit task it silently produces the wrong
 * result. Claiming a tab up front is what makes concurrent agents safe, and it
 * also stops an agent from steering a tab the user is reading.
 */
let ownTab: Promise<void> | undefined;

/**
 * Returns the target snapshot to claim against once the caller's own call has
 * returned, and only to the caller that caused the tab to be opened.
 *
 * Held in a local rather than a module variable because MCP may have several
 * calls in flight: a shared slot is consumed by whichever call returns first,
 * which is usually not the one that opened the tab. That call then diffs
 * against targets taken before a tab that does not exist yet, claims nothing,
 * and the tab is leaked.
 */
async function ensureOwnTab(opensItsOwn: boolean): Promise<string[] | undefined> {
  if (ownTab) {
    await ownTab;
    return undefined;
  }
  let claimAfter: string[] | undefined;
  ownTab = (async () => {
    // Sweeping first means a session killed last time gets its tab closed now,
    // before this one adds another.
    const swept = await tabs.sweep().catch(() => 0);
    if (swept)
      audit.record({ tool: '_tabs', outcome: 'ok', note: `closed ${swept} tab(s) left by dead sessions` });
    // The upstream writes a page snapshot and two console logs per session into
    // its output directory and never removes any of them. Same moment, same
    // reasoning as the tabs: the start of a session is when clearing something
    // up cannot interrupt anyone.
    const pruned = await prune(OUTPUT_DIR, OUTPUT_KEEP_DAYS).catch(() => 0);
    if (pruned)
      audit.record({ tool: '_output', outcome: 'ok', note: `removed ${pruned} file(s) older than ${OUTPUT_KEEP_DAYS}d` });
    // undefined, not [], when the browser could not be asked: a diff against a
    // list that was never read makes every tab on the machine look like ours.
    const before = await tabs.targets().catch(() => undefined);
    // If the agent's own first move is to open a tab, that tab is ours — but it
    // does not exist yet, so the claim happens on the other side of the call.
    if (opensItsOwn) {
      claimAfter = before;
      return;
    }
    if (await openOwnWindow())
      return;
    await rawCall('browser_tabs', { action: 'new' });
    await noteClaim(await tabs.claim(before).catch(() => 'unenumerable' as const));
  })().catch(error => {
    /*
     * Cleared on failure, or the session gives up its tab silently and forever.
     *
     * Every other step in here is `.catch`-guarded; opening the tab is not,
     * deliberately — a session with no tab of its own must not carry on as
     * though it had one. But a rejected `ownTab` is still a truthy `ownTab`, so
     * the early return above would await it, throw, get swallowed by the
     * caller's catch, and never try again. The upstream restarts on its own
     * schedule (systemd owns it), so being unreachable for one call at the
     * start of a session is ordinary — and it used to mean tab isolation was
     * off for the rest of that session, with concurrent agents quietly
     * steering each other's pages again.
     */
    ownTab = undefined;
    throw error;
  });
  await ownTab;
  return claimAfter;
}

/**
 * This session's tab in a window of its own, made current in the Playwright
 * session. Playwright notices the new page on its own; finding it means
 * matching the marker URL in the listing, which may take a moment to include
 * it. Anything short of selecting it gives the target back and returns false,
 * so the caller opens an ordinary tab the way it always did.
 */
async function openOwnWindow(): Promise<boolean> {
  const marker = `browser-memory-${process.pid}-${Date.now().toString(36)}`;
  const target = await tabs.openWindow(marker);
  if (!target)
    return false;
  const list = async (): Promise<string[]> =>
    bodyOf(await rawCall('browser_tabs', { action: 'list' })).split('\n');
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const line = (await list()).find(entry => entry.includes(marker));
      const index = line ? Number(/(\d+)/.exec(line)?.[1]) : NaN;
      if (Number.isFinite(index)) {
        await rawCall('browser_tabs', { action: 'select', index });
        // Indices shift when any tab closes; only a listing that marks ours current proves the select landed.
        if ((await list()).some(entry => entry.includes(marker) && /current/i.test(entry))) {
          await tabs.adopt(target);
          return true;
        }
      }
    } catch {
      // The upstream restarting is ordinary; the attempts are the budget for it.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await tabs.discard(target);
  return false;
}

/**
 * A tab this session opened and could not put its name to is open for good: the
 * sweep only closes tabs with an ownership record, so unlike a session that is
 * killed — which leaves one — there is no route back to it. Recorded rather
 * than shrugged off, so a browser filling up with orphans is something anyone
 * can see in the log instead of something they notice weeks later.
 */
async function noteClaim(outcome: 'claimed' | 'unenumerable' | 'ambiguous'): Promise<void> {
  if (outcome === 'claimed')
    return;
  audit.record({
    tool: '_tabs',
    outcome: 'error',
    note: outcome === 'unenumerable'
      ? 'opened a tab but could not list targets to identify it — it will never be swept'
      : 'opened a tab at the same moment as another session — neither could be told apart, so it is unowned',
  });
}

/** A browser call made on this session's own tab, claiming one first if needed. */
export async function callUpstream(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!name.startsWith('browser_'))
    return rawCall(name, args);
  const claimAfter = await ensureOwnTab(
      name === 'browser_tabs' && args['action'] === 'new').catch(() => undefined);
  const result = await rawCall(name, args);
  if (claimAfter)
    await noteClaim(await tabs.claim(claimAfter).catch(() => 'unenumerable' as const));
  return result;
}

/**
 * The requests worth learning from are the ones a single-page app fires after
 * the navigation has already resolved, so reading the log at that moment
 * catches almost nothing. Deferred and never awaited: this is the gateway's
 * own bookkeeping and must not sit in front of the agent's next call.
 */
const MINE_AFTER_MS = 3000;
let mineTimer: ReturnType<typeof setTimeout> | undefined;

/** Where this session's tab has been — never the user's. */
const pages = new PagesSeen();

/** The site this session's tab is on, for anything that needs it by name. */
export const currentDomain = (): string => pages.domain;

async function mineApi(domain: string): Promise<void> {
  const result = await rawCall('browser_network_requests', { static: false });
  await apiMap.learn(domain, bodyOf(result), pages.paths);
}

/**
 * This agent went somewhere. Everything that follows from that is here rather
 * than at the call site: the path is a page because a navigation reached it,
 * the site it left has a place map worth writing out, and the new one has
 * traffic worth reading once it settles.
 */
export async function noteNavigation(domain: string, path: string): Promise<void> {
  const left = pages.domain;
  if (!pages.saw(domain, path))
    return;
  // Written out when the agent leaves the site, not on every hop: nothing reads
  // a place map before the next session. There is no site to leave on the first
  // navigation, and asking for one by an empty name used to mean "flush
  // everything" — which wrote the page just landed on straight to disk.
  if (left)
    await places.flush(left).catch(() => {});
  clearTimeout(mineTimer);
  mineTimer = setTimeout(() => void mineApi(domain).catch(() => {}), MINE_AFTER_MS);
}

/**
 * Hand the tab back when the agent goes away, or a browser used by many
 * short-lived agents fills up with abandoned pages.
 *
 * The last page is mined here rather than left to the timer: a turn that ends
 * within three seconds of its final navigation would otherwise throw away
 * exactly the traffic from the page the agent cared about most. It happens in
 * this process, before the tab closes, because this is the only place that
 * knows which tab is ours — a separate cleanup process would read whatever
 * page the user themselves happened to be on.
 */

/**
 * The one release in flight, shared by every trigger.
 *
 * A boolean here was the bug. Closing a stdio server fires at least two of the
 * three triggers — stdin end, then SIGTERM — and the second one used to find
 * `releasing` already true, return immediately, and run its own
 * `.finally(exit)` while the first was still four seconds deep in flushing the
 * observer and closing the tab. The process left in the middle of exactly the
 * work this function exists to guarantee: tab leaked, observations and places
 * lost. Returning the promise makes the second trigger wait for the first
 * rather than overtake it.
 */
let releasing: Promise<void> | undefined;

export function releaseTab(): Promise<void> {
  releasing ??= releaseNow();
  return releasing;
}

async function releaseNow(): Promise<void> {
  clearTimeout(mineTimer);
  /*
   * Flushed whether or not this session ever owned a tab.
   *
   * This used to return early on `!ownTab`, which reads as "nothing to hand
   * back" and meant "nothing to write down" — two different facts. A session
   * whose tab claim failed carries on working: `callUpstream` swallows that
   * failure on purpose and forwards the call anyway, and `ensureOwnTab` clears
   * `ownTab` so the next call retries. So the browser work happens, the
   * observer accumulates a flow and the place map fills up, and then shutdown
   * decided there was nothing to do because of a claim that never landed. The
   * recording is the session's; the tab is only the browser's.
   */
  // A task that ends on its last form would otherwise throw away the selectors
  // it just proved work, and the last site it was on would lose every place it
  // reached there — which for a single-domain task is all of them.
  await observer.flush().catch(() => {});
  await places.flush().catch(() => {});
  // Mining is given its own small budget so that a slow browser cannot eat the
  // whole shutdown window and leave the tab behind — the traffic is a bonus,
  // the tab is a debt.
  if (pages.domain) {
    await Promise.race([
      mineApi(pages.domain).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1500)),
    ]);
  }
  if (!ownTab)
    return;
  await Promise.race([
    rawCall('browser_tabs', { action: 'close' }).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 2500)),
  ]);
  await tabs.release().catch(() => {});
}
