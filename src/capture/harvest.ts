import { LOOKS_LIKE_API, normalizePath } from './apiMap.ts';
import { payloadOf } from './evidence.ts';
import { domainChain } from '../memory/store.ts';

/**
 * Mapping a site on purpose, with no model in the loop at all.
 *
 * Everything expensive in `apiMap` is learned from traffic the page makes by
 * itself — the agent contributes nothing to it. That has an consequence nobody
 * had taken: if the knowledge comes from the navigation rather than from the
 * reasoning, then a plain Node script that navigates is enough to acquire it.
 * No tokens, no turns, no model.
 *
 * Until now the map only ever grew *incidentally*, as a side effect of tasks
 * agents happened to be given. A site nobody had a task on stayed unknown, and
 * the first agent sent there paid full price for a discovery any script could
 * have made in ninety seconds.
 *
 * This module is the part with no browser in it: which URLs are worth opening
 * and which must never be opened. It is separate so those decisions can be
 * tested without driving anything, because the cost of getting the second one
 * wrong is a crawler that clicks Delete on the user's real, logged-in account.
 */

/** How many pages one pass will open. Beyond this a site is being scraped, not mapped. */
export const MAX_VISITS = 25;

/**
 * The value a `browser_evaluate` reply is carrying.
 *
 * Two layers, and the first attempt took off the wrong one. The reply has a
 * `### Result` section holding the value and a `### Ran Playwright code`
 * section holding a fenced copy of the function that was *sent* — so reaching
 * for "the fenced block" returns the question instead of the answer. Against
 * hPanel that read zero links off a page with twenty-three of them, and the
 * pass reported the site as publishing no navigation at all.
 *
 * The section is picked by name using the observer's own `payloadOf`, not a
 * second copy of it. What is inside is JSON — a page returning a string comes
 * back quoted and escaped — so one unwrap yields the value, and anything that
 * is not JSON is already plain text.
 */
export function unwrapResult(body: string): string {
  const payload = payloadOf(body);
  try {
    const value = JSON.parse(payload) as unknown;
    return typeof value === 'string' ? value : payload;
  } catch {
    return payload;
  }
}

/**
 * Links whose whole purpose is to change something.
 *
 * The crawler is GET-only, which is not remotely sufficient: on a real site
 * plenty of destructive actions are ordinary links, and this browser is signed
 * in to the user's actual accounts. `logout` alone would end the session that
 * makes the whole system work, and it is on literally every page.
 *
 * Matched against the full URL, so it catches `?action=delete` as well as
 * `/account/delete`. Deliberately over-broad: a false positive costs one
 * unvisited page, and a false negative costs something that cannot be undone.
 */
const DESTRUCTIVE =
  /\b(logout|log-out|signout|sign-out|delete|destroy|remove|cancel|unsubscribe|deactivate|terminate|revoke|purge|disable|reset|restore|upgrade|downgrade|checkout|pay|buy|purchase|renew|transfer|impersonate)\b/i;

/**
 * A link that hands back a file rather than a page. Either it lands on disk or
 * it renders as text — and either way it runs no JavaScript, so there is no
 * traffic to mine from it.
 *
 * `.md` and `.txt` are in here for a reason that only showed up on a real site:
 * an `llms.txt` is a list of markdown documents, so seeding from one on
 * platform.claude.com filled the entire visit budget with `.md` URLs. Every one
 * would have loaded, cost a navigation, and taught the map nothing.
 */
const DOWNLOAD = /\.(pdf|zip|tar|gz|tgz|rar|7z|csv|tsv|xlsx?|docx?|pptx?|dmg|exe|msi|deb|rpm|apk|iso|mp4|mp3|wav|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|css|js|map|md|txt|xml|rss|atom)(\?|#|$)/i;

/** Only these can be navigated to. `mailto:`, `tel:` and `javascript:` are not pages. */
const NAVIGABLE = /^https?:$/;

/**
 * Same site, judged by the same rule the API map uses.
 *
 * Reusing `domainChain` rather than comparing hosts means `api.example.com` and
 * `app.example.com` count as one site — which is what a user means by "map
 * Hostinger for me", and matches where the endpoints will be filed.
 */
export function sameSite(url: URL, root: string): boolean {
  return domainChain(url.hostname).includes(root) || domainChain(root).includes(url.hostname);
}

/**
 * Whether this crawler may open a URL. Everything is a reason to say no.
 */
export function crawlable(href: string, base: string, root: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return undefined;
  }
  if (!NAVIGABLE.test(url.protocol))
    return undefined;
  if (!sameSite(url, root))
    return undefined;
  if (DESTRUCTIVE.test(url.pathname + url.search))
    return undefined;
  if (DOWNLOAD.test(url.pathname))
    return undefined;
  // An endpoint is for calling, not for looking at, and navigating to one
  // renders raw JSON in a tab and mines nothing.
  if (LOOKS_LIKE_API.test(url.pathname))
    return undefined;
  // The fragment picks a spot on a page already counted; keeping it would visit
  // the same page once per anchor in its own table of contents.
  url.hash = '';
  return url.href;
}

/**
 * One URL per *shape*, not per URL.
 *
 * A billing section with four hundred invoices offers four hundred links that
 * are the same page with a different id. Visiting them costs four hundred
 * navigations and teaches exactly what the first one taught, because the
 * endpoint behind them collapses to a single `:id` entry anyway. Grouping by
 * the same `normalizePath` the map itself uses means the budget is spent on
 * four hundred *different* pages instead.
 */
export function distinctShapes(urls: string[], limit = MAX_VISITS): string[] {
  const byShape = new Map<string, string>();
  for (const href of urls) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    const shape = `${url.hostname}${normalizePath(url.pathname)}`;
    if (!byShape.has(shape))
      byShape.set(shape, href);
  }
  return [...byShape.values()].slice(0, limit);
}

/**
 * `<loc>` entries from a sitemap, including a sitemap index pointing at more
 * sitemaps — which is the common shape on any site big enough to be worth
 * mapping, and returning its index URLs as though they were pages would have
 * the crawler navigate to XML.
 */
export function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(match => match[1]!);
  const isIndex = /<sitemapindex/i.test(xml);
  return isIndex ? { pages: [], sitemaps: locs } : { pages: locs, sitemaps: [] };
}

/**
 * URLs from an `llms.txt` — a markdown file of links, which Anthropic, Stripe
 * and Cloudflare publish, and which describes a whole site in one request.
 */
export function parseLlmsTxt(text: string): string[] {
  return [...text.matchAll(/\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g)].map(match => match[1]!);
}

/**
 * What a pass should open, in the order it should open them.
 *
 * Seeded URLs come first because they are the site's own description of itself
 * — a sitemap says which pages matter in a way that a header nav does not — and
 * the visit budget is small enough that order decides what gets mapped.
 */
export function plan(root: string, base: string, seeded: string[], links: string[],
    limit = MAX_VISITS): string[] {
  const allowed = [...seeded, ...links]
      .map(href => crawlable(href, base, root))
      .filter((href): href is string => Boolean(href));
  return distinctShapes(allowed, limit);
}
