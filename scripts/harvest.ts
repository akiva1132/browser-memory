#!/usr/bin/env node
/**
 * Map a site on purpose, with no model in the loop.
 *
 *   node scripts/harvest.ts hpanel.hostinger.com
 *   node scripts/harvest.ts cloudflare.com --limit 10 --dry-run
 *
 * Everything the API map knows is learned from traffic the page makes on its
 * own; the agent never contributed to it. So the map does not need an agent —
 * it needs navigations. This is the script that makes them.
 *
 * The cost of mapping a site therefore drops from "a task somebody happened to
 * be given, at whatever that task cost in turns" to zero tokens and about a
 * minute of wall-clock. That is the whole argument for this file.
 *
 * It runs in the user's real, signed-in browser, which is what makes it useful
 * — the pages behind the login are the ones with the interesting traffic — and
 * is also why it will not open anything matching `DESTRUCTIVE`, opens its own
 * tab rather than steering one the user is reading, and never submits a form.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ApiMap, renderApiMap } from '../src/capture/apiMap.ts';
import { MAX_VISITS, parseLlmsTxt, parseSitemap, plan, unwrapResult } from '../src/capture/harvest.ts';
import { PlaceMap } from '../src/browser/places.ts';
import type { ToolResult } from '../src/lib/toolResult.ts';

const UPSTREAM = process.env['PLAYWRIGHT_MCP_URL'] || 'http://localhost:8931/mcp';
const MEMORY_DIR = process.env['BROWSER_MEMORY_DIR'] || 'memory';
/**
 * The same delay the gateway uses, for the same reason: a single-page app fires
 * the requests worth learning from *after* the navigation resolves, so reading
 * the log at that moment catches almost nothing.
 */
const SETTLE_MS = 3000;
/**
 * A pause on top of the settle, because a mapper is not a person.
 *
 * Ten hPanel pages went past in forty seconds on the first real run, each
 * firing a dozen or so XHRs, and the site rate-limited the lot. Nothing was
 * lost — a 429 is no longer recorded as breakage — but the traffic those pages
 * would have made is exactly what this script exists to read, and a throttled
 * page makes less of it. Going slower maps more.
 */
const PACE_MS = 2000;

const args = process.argv.slice(2);
const VALUED = new Set(['--limit', '--pace']);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const limit = Number(flag('--limit') ?? MAX_VISITS);
const pace = Number(flag('--pace') ?? PACE_MS);
const dryRun = args.includes('--dry-run');
/** Whatever is left once the flags and their values are removed. */
const root = args.filter((arg, index) =>
  !arg.startsWith('--') && !VALUED.has(args[index - 1] ?? ''))[0];

if (!root) {
  console.error('usage: node scripts/harvest.ts <domain> [--limit N] [--pace MS] [--dry-run]');
  process.exit(2);
}

const client = new Client({ name: 'browser-harvest', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM)));

/**
 * One slow page must cost seconds, not the pass.
 *
 * The SDK's default is sixty seconds, and a single navigation that reached it
 * threw straight past the landing-page call — which, unlike every other
 * navigation here, had no catch around it. The pass died with a stack trace,
 * reported none of what it had already learned, and left its tab open in the
 * user's browser, which is the one outcome this whole system is meant to
 * prevent.
 */
const CALL_TIMEOUT_MS = 20_000;

const call = async (name: string, params: Record<string, unknown>): Promise<ToolResult> =>
  await client.callTool({ name, arguments: params }, undefined,
      { timeout: CALL_TIMEOUT_MS }) as ToolResult;
const bodyOf = (result: ToolResult): string =>
  (result.content ?? []).map(part => part.text ?? '').join('\n');

/**
 * Reads a value out of the page as a string.
 *
 * Two layers have to come off, and the first draft of this took off the wrong
 * one. `browser_evaluate` answers with a formatted reply whose `### Result`
 * section holds the value and whose `### Ran Playwright code` section holds a
 * fenced copy of the function that was sent — so pulling out "the fenced block"
 * returns the *question* rather than the answer. Against hPanel that produced
 * zero links from a page with twenty-three of them, and reported it as a site
 * that publishes no navigation.
 *
 * The section is read by name with `payloadOf`, the same function the observer
 * uses, rather than a second copy of that logic. What is inside it is then JSON
 * — a page returning a string comes back quoted and escaped — and one unwrap
 * turns it back into the value.
 */
async function evaluate(fn: string): Promise<string> {
  const body = bodyOf(await call('browser_evaluate', { function: fn }).catch(() => ({} as ToolResult)));
  return unwrapResult(body);
}

/**
 * A site's own description of itself, fetched from a page already on that
 * origin so the request carries the session — a sitemap behind a login is
 * common, and fetching it from Node would get the login page instead.
 *
 * One request buys the skeleton of a whole site; the crawl below only exists
 * for sites that publish neither.
 *
 * Takes no origin, and cannot: every fetch here is a relative path evaluated in
 * the page, so the origin is whichever one the tab is already on. The parameter
 * it used to take was never read, and naming one would have implied this could
 * be pointed somewhere else.
 */
async function seed(): Promise<{ urls: string[]; from: string[] }> {
  const from: string[] = [];
  const urls: string[] = [];

  const llms = await evaluate(
      `async () => { const r = await fetch("/llms.txt", {credentials:"include"});` +
      ` return r.ok ? (await r.text()).slice(0, 200000) : ""; }`);
  const fromLlms = parseLlmsTxt(llms);
  if (fromLlms.length) {
    urls.push(...fromLlms);
    from.push(`llms.txt (${fromLlms.length})`);
  }

  // A sitemap index names more sitemaps rather than pages; one level of
  // following is enough to reach real URLs without turning into a crawl of
  // its own.
  let pending = ['/sitemap.xml'];
  let pages: string[] = [];
  for (let depth = 0; depth < 2 && pending.length && pages.length < limit * 4; depth++) {
    const next: string[] = [];
    for (const target of pending.slice(0, 3)) {
      const xml = await evaluate(
          `async () => { const r = await fetch(${JSON.stringify(target)}, {credentials:"include"});` +
          ` return r.ok ? (await r.text()).slice(0, 400000) : ""; }`);
      const parsed = parseSitemap(xml);
      pages.push(...parsed.pages);
      next.push(...parsed.sitemaps);
    }
    pending = next;
  }
  if (pages.length) {
    urls.push(...pages);
    from.push(`sitemap.xml (${pages.length})`);
  }
  return { urls, from };
}

/**
 * Links in the site's chrome first, then everything else on the page.
 *
 * Chrome — nav, header, footer — is the site's own answer to "where can you go
 * from here", and on a server-rendered site it is the whole list. On an SPA it
 * is often nearly empty: the Tailscale console put three anchors in semantic
 * chrome and the rest in plain divs, so a chrome-only selector mapped three
 * pages of a dashboard that has many more.
 *
 * So chrome is a *preference*, expressed as ordering, not a filter. The rest of
 * the anchors follow it, and what actually bounds the pass is `crawlable`
 * refusing anything destructive and `distinctShapes` refusing to spend the
 * budget on four hundred versions of one page.
 */
const CHROME = 'nav a[href], header a[href], footer a[href], [role=navigation] a[href], aside a[href]';
const LINKS_FN =
  `() => { const href = a => a.getAttribute('href');` +
  ` const chrome = [...document.querySelectorAll(${JSON.stringify(CHROME)})].map(href);` +
  ` const all = [...document.querySelectorAll('a[href]')].map(href);` +
  ` return JSON.stringify([...new Set([...chrome, ...all])].filter(Boolean).slice(0, 600)); }`;

const apiMap = new ApiMap(MEMORY_DIR);
const places = new PlaceMap(MEMORY_DIR, 'harvest');

// Its own tab. The premise of this system is that the browser belongs to the
// user and is often being watched; a mapping pass must not take the page they
// are reading somewhere else.
await call('browser_tabs', { action: 'new' });

/**
 * The domain actually landed on, which is not always the one asked for.
 *
 * `docs.anthropic.com` redirects to another host, and judging its own sitemap
 * against the name typed on the command line made all 3,318 seeded URLs look
 * like somebody else's site. The pass read both files correctly, filtered
 * every single URL out, and reported nothing to open — a wrong answer that
 * looked like a site with nothing to map.
 */
let site = root;
let before: Awaited<ReturnType<ApiMap['forDomain']>> = [];

let visited = 0;
let failed = 0;
/** Paths this pass navigated to, which are pages however much they look otherwise. */
const opened = new Set<string>();
try {
  const origin = `https://${root}`;
  // Caught like every other navigation, rather than being the one that is not.
  // A landing page that will not load still leaves a tab to hand back and a
  // count to report, and the count is the whole output of this script.
  const landing = await call('browser_navigate', { url: `${origin}/` }).catch(() => undefined);
  if (!landing || landing.isError)
    throw new Error(`${origin}/ did not load within ${CALL_TIMEOUT_MS / 1000}s`);
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

  const landed = await evaluate('() => location.href');
  try {
    site = new URL(landed).hostname;
  } catch {
    // Keep the name that was asked for; it is the only one we have.
  }
  before = await apiMap.forDomain(site);
  console.log(`▸ ${site}${site === root ? '' : ` (redirected from ${root})`}` +
      ` — ${before.length} endpoint(s) on record before this pass`);

  const { urls: seeded, from } = await seed();
  console.log(`  seeded: ${from.length ? from.join(', ') : 'nothing published'}`);

  let links: string[] = [];
  try {
    links = JSON.parse(await evaluate(LINKS_FN)) as string[];
  } catch {
    // A page that answers nothing still has a sitemap and a landing page worth
    // mining; an unreadable link list is not a reason to abandon the pass.
  }

  const targets = plan(site, landed || `${origin}/`, seeded, links, limit);
  console.log(`  ${links.length} link(s) in the site chrome → ${targets.length} distinct page shape(s) to open`);

  if (dryRun) {
    for (const target of targets)
      console.log(`    would open ${target}`);
  } else {
    // The landing page's own traffic, before going anywhere.
    try {
      opened.add(new URL(landed).pathname);
    } catch { /* keep going; an unparseable URL just excludes nothing */ }
    await apiMap.learn(site, bodyOf(await call('browser_network_requests', { static: false })), opened);

    for (const target of targets) {
      // One page is one page. Whatever it does — refuse to load, time out, come
      // back unreadable — it costs this iteration and nothing else, because
      // everything learned from the pages before it is already on disk.
      try {
        const result = await call('browser_navigate', { url: target }).catch(() => undefined);
        if (!result || result.isError) {
          failed++;
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, SETTLE_MS + pace));
        opened.add(new URL(target).pathname);
        await apiMap.learn(site, bodyOf(await call('browser_network_requests', { static: false })), opened);
        // One sighting each, which is what a single pass honestly is: a place
        // needs two before it is established, and a second pass or a real visit
        // supplies the other.
        //
        // JSON rather than a delimiter character: a separator has to be one no
        // title can contain, and the first attempt at that put a literal NUL in
        // this file, which made it a binary as far as grep was concerned.
        const [pathname, title] = JSON.parse(await evaluate(
            '() => JSON.stringify([location.pathname, document.title])')) as [string, string];
        if (pathname)
          places.saw(site, pathname, title ?? '');
        visited++;
      } catch {
        failed++;
      }
      process.stdout.write(`\r  visited ${visited}/${targets.length}`);
    }
    process.stdout.write('\n');
    await places.flush(site);
  }
} catch (error) {
  // Reported as a line, not as a stack: what the pass did learn before it
  // stopped is below, and it is still worth having.
  console.log(`\n  stopped early — ${(error as Error).message}`);
} finally {
  await call('browser_tabs', { action: 'close' }).catch(() => {});
  await client.close().catch(() => {});
}

const after = await apiMap.forDomain(site);
const gained = after.length - before.length;
console.log(`\n${site}: ${before.length} → ${after.length} endpoint(s)` +
    `${gained > 0 ? ` (+${gained})` : ' (nothing new)'}` +
    `${failed ? `, ${failed} page(s) would not open` : ''}`);
if (gained > 0)
  console.log(`\n${renderApiMap(site, after)}`);
