/**
 * What this has to get right is asymmetric, so the tests are too.
 *
 * Missing a page costs one unmapped URL. Opening the wrong one runs a real,
 * irreversible action in the user's signed-in browser — the crawler navigates
 * with their live Hostinger and Cloudflare sessions attached. So most of what
 * is asserted here is what must *not* be opened.
 */
import assert from 'node:assert/strict';

import { crawlable, distinctShapes, parseLlmsTxt, parseSitemap, plan, unwrapResult } from '../../src/capture/harvest.ts';

// ── reading the answer, not the question ─────────────────────────────────────
//
// The fixture is a real `browser_evaluate` reply, copied from hPanel. The first
// version of the reader pulled out "the fenced block" and got the *function it
// had just sent*, because that is what `### Ran Playwright code` contains. The
// symptom was not an error: it was a page with twenty-three navigation links
// reported as a site that publishes no navigation.
{
  const REPLY = `### Result
"{\\"chrome\\":23,\\"sample\\":[\\"/websites\\",\\"/domains\\"]}"
### Ran Playwright code
\`\`\`js
await page.evaluate('() => { const sel=\\'nav a[href]\\'; return JSON.stringify({chrome: 23}); }');
\`\`\``;
  const value = unwrapResult(REPLY);
  assert.doesNotMatch(value, /page\.evaluate/, 'that is the function that was sent, not its result');
  const parsed = JSON.parse(value) as { chrome: number; sample: string[] };
  assert.equal(parsed.chrome, 23);
  assert.deepEqual(parsed.sample, ['/websites', '/domains']);

  // A plain string result loses exactly one layer of quoting.
  assert.equal(unwrapResult('### Result\n"https://hpanel.hostinger.com/"\n### Ran Playwright code\n```js\nx\n```'),
      'https://hpanel.hostinger.com/');
  // And a reply that is not JSON at all is already the value.
  assert.equal(unwrapResult('### Result\nplain\n'), 'plain');
  console.log('  browser_evaluate replies yield the result, not the code that was sent');
}

const ROOT = 'hostinger.com';
const BASE = 'https://hpanel.hostinger.com/dashboard';

// ── links that must never be opened ──────────────────────────────────────────
//
// Every one of these is an ordinary anchor on a real dashboard, reachable with
// a plain GET, and this browser is signed in.
for (const href of [
  '/logout',
  '/auth/sign-out',
  'https://hpanel.hostinger.com/vps/1234/delete',
  '/subscriptions/98765/cancel',
  '/websites/mine.com?action=remove',
  '/billing/payment-methods/1/disable',
  '/vps/1234/reset-password',
  '/emails/unsubscribe/abc',
  '/order/checkout',
  '/domains/transfer',
]) {
  assert.equal(crawlable(href, BASE, ROOT), undefined, `${href} changes something and must not be opened`);
}
console.log('  destructive links are refused, including as a query parameter');

// ── not pages ────────────────────────────────────────────────────────────────
for (const href of [
  'mailto:support@hostinger.com',
  'tel:+1234567890',
  'javascript:void(0)',
  '/invoices/98765/download.pdf',
  '/static/app.js',
  '/assets/logo.svg',
  // An llms.txt is a list of markdown documents. Seeding from the one on
  // platform.claude.com filled the entire visit budget with `.md` URLs, each
  // of which loads as text, runs no JavaScript and produces nothing to mine.
  '/docs/en/get-started.md',
  '/feed.xml',
  '/robots.txt',
]) {
  assert.equal(crawlable(href, BASE, ROOT), undefined, `${href} is not a page to mine`);
}
// An endpoint renders raw JSON in a tab and produces no traffic of its own.
assert.equal(crawlable('/api/v1/virtual-machines', BASE, ROOT), undefined);
console.log('  downloads, non-http schemes and endpoints are not crawl targets');

// ── somebody else's site ─────────────────────────────────────────────────────
assert.equal(crawlable('https://evil.example.com/', BASE, ROOT), undefined);
assert.equal(crawlable('https://facebook.com/hostinger', BASE, ROOT), undefined);
// But a sibling host is the same site, which is how the map already files it.
assert.ok(crawlable('https://auth.hostinger.com/profile', BASE, ROOT));
console.log('  same-site is judged by the domain chain, so siblings count and strangers do not');

// ── ordinary pages, resolved against the page they were found on ─────────────
assert.equal(crawlable('/websites', BASE, ROOT), 'https://hpanel.hostinger.com/websites');
assert.equal(crawlable('vps', BASE, ROOT), 'https://hpanel.hostinger.com/vps');
// The fragment picks a spot on a page already counted; keeping it would visit
// the same page once per entry in its own table of contents.
assert.equal(crawlable('/websites#section-two', BASE, ROOT), 'https://hpanel.hostinger.com/websites');
console.log('  relative links resolve, fragments collapse');

// ── one visit per shape, not per URL ─────────────────────────────────────────
//
// The failure this prevents: a billing section with four hundred invoices
// offers four hundred links that are the same page with a different id. They
// all collapse to one endpoint in the map anyway, so visiting them spends the
// entire budget learning what the first one taught.
{
  const invoices = Array.from({ length: 400 }, (_, i) => `https://hpanel.hostinger.com/invoices/${1000 + i}`);
  const chosen = distinctShapes([...invoices, 'https://hpanel.hostinger.com/websites',
    'https://hpanel.hostinger.com/vps'], 25);
  assert.equal(chosen.length, 3, '400 invoices are one shape; the other two are their own');
  assert.ok(chosen.includes('https://hpanel.hostinger.com/websites'));
  assert.ok(chosen.includes('https://hpanel.hostinger.com/vps'));
  console.log(`  402 URLs → ${chosen.length} shapes`);

  // The budget is a hard stop even when every URL is genuinely different.
  const distinct = Array.from({ length: 90 }, (_, i) => `https://hpanel.hostinger.com/section-${i}/page`);
  assert.equal(distinctShapes(distinct, 25).length, 25, 'the visit budget is a ceiling');
}

// ── a site's own description of itself ───────────────────────────────────────
{
  const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://hostinger.com/vps</loc><lastmod>2026-07-01</lastmod></url>
  <url><loc>https://hostinger.com/hosting</loc></url>
</urlset>`;
  const parsed = parseSitemap(SITEMAP);
  assert.deepEqual(parsed.pages, ['https://hostinger.com/vps', 'https://hostinger.com/hosting']);
  assert.deepEqual(parsed.sitemaps, []);

  // An index names more sitemaps rather than pages. Returning those as pages
  // would have the crawler spend its budget navigating to XML documents.
  const INDEX = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://hostinger.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://hostinger.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;
  const index = parseSitemap(INDEX);
  assert.deepEqual(index.pages, [], 'an index lists sitemaps, and none of them is a page');
  assert.equal(index.sitemaps.length, 2);

  assert.deepEqual(parseSitemap('<html>404</html>'), { pages: [], sitemaps: [] },
      'a site with no sitemap is the ordinary case, not an error');
  console.log('  sitemap and sitemap index are told apart');
}

{
  const LLMS = `# Hostinger

> Hosting and VPS.

## Docs
- [VPS API](https://hostinger.com/docs/vps): managing servers
- [Billing](https://hostinger.com/docs/billing)

Plain text with a bare https://hostinger.com/not-a-link in it.`;
  assert.deepEqual(parseLlmsTxt(LLMS),
      ['https://hostinger.com/docs/vps', 'https://hostinger.com/docs/billing'],
      'the links are the markdown links; prose that mentions a URL is prose');
  console.log('  llms.txt yields its links and not its prose');
}

// ── the whole plan, seeded first ─────────────────────────────────────────────
//
// Order decides what gets mapped, because the budget is smaller than most
// sites. A sitemap is the site saying which pages matter; a header nav is not.
{
  const seeded = ['https://hostinger.com/vps', 'https://hostinger.com/hosting'];
  const links = ['/logout', '/websites', 'https://twitter.com/hostinger', '/vps'];
  const targets = plan(ROOT, BASE, seeded, links, 3);

  assert.equal(targets.length, 3);
  assert.equal(targets[0], 'https://hostinger.com/vps', 'seeded URLs come first');
  assert.ok(!targets.some(url => /logout/.test(url)), 'the destructive link is gone');
  assert.ok(!targets.some(url => /twitter/.test(url)), 'so is the off-site one');
  // `/vps` from the nav is the same shape as the seeded one on the apex host?
  // No — different hostname, so it is a different shape and legitimately its
  // own visit. What matters is that nothing forbidden survived.
  console.log(`  plan: 6 candidates → ${targets.length} visits, seeded first`);
}

console.log('HARVEST OK');
