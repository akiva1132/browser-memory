import path from 'node:path';

import { SiteFile } from '../lib/siteFile.ts';
import { domainChain } from '../memory/store.ts';
import { today } from '../lib/dates.ts';

/**
 * A site's internal API, learned by watching the page rather than by asking the
 * agent to find it.
 *
 * The first version of automatic capture only noticed an endpoint when an agent
 * fetched it deliberately — which means it could only record what the agent had
 * already worked out. That is backwards. The expensive case is the opposite one:
 * an agent clicks through thirty pages of UI while the page quietly calls the
 * six endpoints that would have answered the question directly.
 *
 * Those calls are already visible. One navigation to hPanel exposes its billing,
 * resources, profile and orders endpoints, with their parameter names, all
 * returning 200 — for free, before the agent does anything at all.
 *
 * Kept as one map per domain instead of one lesson per endpoint, because a busy
 * SPA emits dozens per page load and lessons are meant to be read. A map is a
 * reference; a hundred lessons is a landfill.
 */

export type Endpoint = {
  method: string;
  /** Ids collapsed to `:id`, so one endpoint is one entry however often it is called. */
  path: string;
  /** Query parameter names. What they are called is reusable; their values are not. */
  params: string[];
  seen: number;
  firstSeen: string;
  lastSeen: string;
  status: number;
  /** When a route that used to answer stopped. Absent while it is working. */
  brokeAt?: string;
  /**
   * Code an agent actually ran against this endpoint, which came back with
   * data.
   *
   * This is the difference between "the site's own page calls this" and
   * "somebody called this deliberately and got what they wanted", and it used
   * to live in a separate fast-path lesson. One `fetch` therefore produced four
   * records in three stores — an endpoint here, a lesson there, a promotion
   * suggestion, a draft candidate — each with its own idea of what the path
   * was. The endpoint is the thing; proof of it is a property of the endpoint,
   * not a second thing to keep in step.
   */
  proven?: {
    /** Redacted with the code rules: prose redaction rewrites expressions. */
    snippet: string;
    /** Shape, never contents — the response belongs to whoever asked for it. */
    returns: string;
    at: string;
  };
};

/** 2xx and 3xx: the site got what it asked for, or was told where to get it. */
export const ok = (status: number): boolean => status >= 200 && status < 400;

/**
 * The route itself is gone. Only these are worth telling an agent about.
 *
 * Everything else that is not `ok` says something about the moment rather than
 * about the route: 429 is "you are going too fast", 401 and 403 are "not you",
 * 5xx and 408 are "not now". Treating any of them as breakage was the bug the
 * harvest crawl exposed the first time it ran — ten navigations in forty
 * seconds tripped Hostinger's rate limit, and six endpoints that were working
 * perfectly were stamped `⚠ answering 429 since 2026-08-05`.
 *
 * That is worse than recording nothing. The warning exists so an agent does not
 * pick a route that has moved; a warning that fires on a route which is fine
 * teaches agents to scroll past the one that is true. And it was self-inflicted
 * — the mapper caused the rate limit and then wrote down that the site was
 * broken.
 */
const gone = (status: number): boolean => status === 404 || status === 405 || status === 410;

/** Past this a site is telling us about its own noise, not its interface. */
const MAX_ENDPOINTS = 60;
/** How many make it into a brief. The rest are there for anyone who asks. */
const IN_BRIEF = 12;

/** `303. [GET] https://host/path?q=1 => [200]` */
const LINE = /^\s*\d+\.\s*\[(\w+)\]\s+(\S+)\s+=>\s+\[(\d+)\]/;

/**
 * Static assets are already excluded upstream; what is left that is still not
 * an interface is analytics, error reporting and bot-check traffic.
 */
/*
 * The vendor names are there because analytics is increasingly proxied through
 * the site's own host to survive tracker blocking, and filtering by host cannot
 * see that. The Tailscale console calls `/api/rudderstack-proxy/sourceConfig`
 * from its own origin, and it went into the map as part of the interface — onto
 * the list an agent reads to decide what to call next. A wrong entry presented
 * as fact is worse than a missing one.
 */
const NOT_AN_API =
  /\/cdn-cgi\/|\/gtm\.|\/collect\b|\/envelope\b|\/beacon\b|\/telemetry\b|\/analytics\b|rudderstack|segment\.io|mixpanel|posthog|amplitude|heap\.io|fullstory|hotjar|datadog|newrelic|bugsnag|rollbar|clarity\.ms|intercom|pendo/i;

/**
 * A framework fetching the *next page* rather than calling an interface.
 *
 * Modern routers prefetch page payloads over XHR, which puts them on the wire
 * looking exactly like API calls — and on a documentation site the paths make
 * it worse, because they genuinely contain `/api/`. Harvesting
 * platform.claude.com filed seven of these as endpoints: `/docs/en/api/overview`
 * is a page about the API, and an agent that fetched it would get a rendered
 * manual and try to parse it as JSON.
 *
 * The marker is in the query string, which is what makes this a fact rather
 * than a guess: Next.js appends `_rsc`, and `_next/data` is the older form of
 * the same thing. `NOISE_PARAM` had been stripping `_rsc` as a cache-buster
 * before anything got to look at it, which is how the signal was being thrown
 * away right before the moment it was needed.
 */
const PAGE_PAYLOAD = /[?&](_rsc|__flight__|_next_data)=|\/_next\/data\//i;

/**
 * Distinguishes an endpoint from an ordinary page. Without this every HTML
 * route in a multi-page app is recorded as though it were an API.
 */
export const LOOKS_LIKE_API = /(^|\/)(api|rest|graphql|gql|ajax|json)(\/|$)|\/v\d+\//i;

/**
 * Parameters that identify this browser or this moment, not this endpoint.
 * Short names are matched whole: as a prefix, `t` also swallows `types[]`.
 */
const NOISE_PARAM = /^(t|ts|v|cb|rand|gaid|nocache|cachebust|timestamp)$|^(_|ga_|utm_|sentry_)/i;

/**
 * Exported because `curate` compares what a lesson claims against what was
 * actually seen, and that comparison is only meaningful if both sides are
 * normalized the same way. It had a copy of this; a copy that drifts turns the
 * check into "every endpoint is unobserved", which accuses every lesson on the
 * site of citing something imaginary.
 *
 * `${…}` is collapsed for the caller's benefit rather than this one: traffic
 * never contains an interpolation, but the snippet in a lesson usually does.
 */
export function normalizePath(target: string): string {
  return target
      // Three ways of writing "an id goes here", because all three turn up:
      // `${id}` in a snippet, `{id}` in prose copied from documentation, and
      // `:id` when someone has already normalized by hand. Missing the middle
      // one made every hPanel lesson about `/virtual-machine/{id}/metrics` fail
      // to match the traffic it was describing.
      .replace(/\$\{[^}]*\}/g, ':id')
      .replace(/\{[^}/]*\}/g, ':id')
      .replace(/\/:[A-Za-z_][\w-]*/g, '/:id')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/[0-9a-f]{24,}/gi, '/:id')
      .replace(/\/\d[\w.-]*/g, '/:id');
}

/**
 * One parsed request, or undefined if it is not this site's interface.
 * `domain` is matched down the chain so an api.example.com call counts as part
 * of example.com's interface rather than as a stranger.
 */
export function parseRequest(line: string, domain: string): Endpoint | undefined {
  const match = LINE.exec(line);
  if (!match)
    return undefined;
  const [, method = '', raw = '', code = ''] = match;
  const status = Number(code);
  /*
   * A failing request is parsed and returned; whether it is worth keeping is
   * the caller's decision, and the two callers want opposite things.
   *
   * Discarding it here was right for building the map — a 403 on a download is
   * not a working endpoint and does not belong in a list of things to call —
   * and it made drift impossible to see. A route that answered yesterday and
   * 404s today never reached `learn` at all, so the stored entry kept its 200
   * forever and the site could be redesigned underneath the map without a
   * single trace. `learn` now keeps the distinction where it belongs: a failure
   * on a route already known is news, a failure on an unknown one is not an
   * endpoint.
   */

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const chain = new Set(domainChain(domain));
  if (![...domainChain(url.hostname)].some(part => chain.has(part)))
    return undefined;
  if (NOT_AN_API.test(url.pathname) || !LOOKS_LIKE_API.test(url.pathname))
    return undefined;
  // Path and query together: `_rsc` arrives as a parameter, `_next/data` as a
  // path prefix, and they are two spellings of the same thing.
  if (PAGE_PAYLOAD.test(url.pathname + url.search))
    return undefined;

  const params = [...new Set([...url.searchParams.keys()]
      .map(key => key.replace(/\[\d*\]$/, '[]'))
      .filter(key => !NOISE_PARAM.test(key)))].sort();

  return {
    method: method.toUpperCase(),
    path: normalizePath(url.pathname),
    params,
    seen: 1,
    firstSeen: today(),
    lastSeen: today(),
    status,
  };
}

export class ApiMap {
  private readonly _file: SiteFile<Endpoint>;

  constructor(memoryDir: string) {
    this._file = new SiteFile<Endpoint>(
        path.join(memoryDir, 'api'), 'endpoints', { lockPrefix: 'api:', label: 'API map' });
  }

  async forDomain(domain: string): Promise<Endpoint[]> {
    return this._file.items(domain);
  }

  /**
   * Records that an agent ran this endpoint and got data back.
   *
   * Kept on the endpoint rather than in a lesson of its own. Traffic mining
   * already knows the route exists — it is watching the same request go past —
   * so the only thing a separate record added was a second spelling of the same
   * path to keep in step with this one. What it did carry that is worth having
   * is the code, and that comes here with it.
   */
  async prove(domain: string, method: string, route: string, snippet: string, returns: string): Promise<void> {
    const key = `${method.toUpperCase()} ${normalizePath(route)}`;
    await this._file.mutate(domain, async () => {
      const endpoints = await this.forDomain(domain);
      let found = endpoints.find(entry => `${entry.method} ${entry.path}` === key);
      /*
       * Added when it is not there yet, rather than declined.
       *
       * Refusing looked like the careful choice — the map is built from what
       * the site itself calls, and an agent can fetch anything. But mining runs
       * on a timer and on leaving a domain, so a route an agent fetched and got
       * data from is routinely not in the map at the moment it is proved: on
       * the real store, four of seven were not. Declining there does not keep
       * the map honest, it throws away the better evidence of the two. The
       * site's page calling a route says it exists; an agent calling it and
       * getting what it wanted says it works.
       *
       * The interface test still applies, so an agent fetching an HTML page or
       * somebody else's host does not turn into an endpoint.
       */
      if (!found) {
        const path = normalizePath(route);
        if (!LOOKS_LIKE_API.test(path) || NOT_AN_API.test(path))
          return;
        found = {
          method: method.toUpperCase(), path, params: [],
          seen: 1, firstSeen: today(), lastSeen: today(), status: 200,
        };
        endpoints.push(found);
      }
      found.proven = { snippet, returns, at: today() };
      await this._file.write(domain, endpoints);
    });
  }

  /** What has changed under us since these lessons were written. */
  async drift(domain: string): Promise<{ broken: Endpoint[]; quiet: Endpoint[] }> {
    const { items, meta } = await this._file.read(domain);
    // `updated` is the day the map was last written, and `drift` parses it as a
    // bare date. That contract now belongs to SiteFile, which is the only thing
    // that writes the field.
    return drift(items, typeof meta['updated'] === 'string' ? meta['updated'] : undefined);
  }

  /**
   * Folds a `browser_network_requests` listing into what is already known.
   * Returns how many endpoints were new, which is the only part worth telling
   * anyone about.
   */
  /**
   * @param pages paths something navigated to, which are therefore pages
   *
   * `LOOKS_LIKE_API` reads the path, and a documentation site defeats it
   * completely: platform.claude.com serves `/docs/en/api/overview` as ordinary
   * HTML, and the first harvest of it filed seven of its own navigations as
   * endpoints. An agent reading that map would fetch a documentation page and
   * try to parse the manual as JSON.
   *
   * Whoever navigated knows what they navigated to, and that is the one thing
   * no amount of pattern matching on a URL can work out. So it is passed in.
   */
  async learn(domain: string, listing: string, pages?: Iterable<string>): Promise<number> {
    const visited = new Set([...(pages ?? [])].map(normalizePath));
    const found = new Map<string, Endpoint>();
    for (const line of listing.split('\n')) {
      const endpoint = parseRequest(line, domain);
      if (!endpoint || visited.has(endpoint.path))
        continue;
      const key = `${endpoint.method} ${endpoint.path}`;
      const existing = found.get(key);
      if (existing)
        existing.params = [...new Set([...existing.params, ...endpoint.params])].sort();
      else
        found.set(key, endpoint);
    }
    if (!found.size)
      return 0;

    return this._file.mutate(domain, async () => {
      const endpoints = await this.forDomain(domain);
      const byKey = new Map(endpoints.map(entry => [`${entry.method} ${entry.path}`, entry]));
      let added = 0;
      for (const [key, endpoint] of found) {
        const existing = byKey.get(key);
        if (!existing) {
          // Never seen working, so it is not part of the interface. A 403 on a
          // download is a permission, not an endpoint worth advertising.
          if (!ok(endpoint.status))
            continue;
          byKey.set(key, endpoint);
          added += 1;
          continue;
        }
        existing.seen += 1;
        existing.lastSeen = endpoint.lastSeen;
        /*
         * A route that used to answer and now does not is the cheapest redesign
         * signal there is, and it arrives without anyone going to look for it —
         * the traffic is mined on every navigation regardless.
         *
         * It is worth recording rather than merely overwriting, because the
         * expensive failure is an agent reading a fast-path lesson, calling the
         * endpoint it names, and working out from scratch that the site moved.
         * The date is kept so the answer to "since when" is in the map instead
         * of in somebody's memory.
         */
        if (gone(endpoint.status))
          existing.brokeAt ??= today();
        else if (ok(endpoint.status))
          delete existing.brokeAt;
        /*
         * A transient status is not recorded at all, so a rate limit or a bad
         * minute cannot overwrite the last status this route was known to
         * answer with. Without this the endpoint reads `429` long after the
         * limit has lifted, since nothing rewrites it until the same page is
         * visited again.
         */
        if (ok(endpoint.status) || gone(endpoint.status))
          existing.status = endpoint.status;
        existing.params = [...new Set([...existing.params, ...endpoint.params])].sort();
      }
      // Evicting the least-seen keeps the endpoints a site actually depends on
      // and drops the one-off calls that happened to fire once.
      const kept = [...byKey.values()]
          .sort((a, b) => b.seen - a.seen || a.path.localeCompare(b.path))
          .slice(0, MAX_ENDPOINTS);
      await this._file.write(domain, kept);
      return added;
    });
  }
}

const describe = (endpoint: Endpoint): string =>
  `- \`${endpoint.method} ${endpoint.path}\`` +
  `${endpoint.params.length ? ` — takes ${endpoint.params.join(', ')}` : ''}` +
  // Said on the line itself rather than in a footnote: an agent scanning this
  // list is choosing what to call next, and a route that answered yesterday and
  // returns 404 today is the one thing it must not pick without knowing.
  `${endpoint.brokeAt ? ` **⚠ answering ${endpoint.status} since ${endpoint.brokeAt}**` : ''}` +
  // The difference between "the page calls this" and "someone called it on
  // purpose and got what they wanted". Worth a word, because it is the one an
  // agent should reach for first.
  `${endpoint.proven ? ` — ✓ called directly, returns ${shapeOf(endpoint.proven)}` : ''}` +
  renderProof(endpoint);

/**
 * The shape, whichever generation wrote the record.
 *
 * `proven.returns` is documented as the shape and nothing else, and every
 * record on the real store holds a sentence instead: `Fetching /api/v4/zones
 * from a page on dash.cloudflare.com returns a JSON payload (~1364 chars,
 * contains ar` — a lesson gist, clipped at 120 characters mid-word, left behind
 * by the fast-path detector that wrote it before it was removed. Both readers
 * print `returns ${…}` in front of it, so the line says "returns" twice.
 *
 * Read rather than migrated, because the store belongs to whoever has been
 * using it and rewriting five of their records to tidy a sentence is not this
 * change's business. `prove` has written the bare shape since the detector
 * went; this can go when nothing on disk predates that.
 */
export function shapeOf(proven: NonNullable<Endpoint['proven']>): string {
  return proven.returns
      .replace(/^Fetching\b.*?\breturns\s+/, '')
      // The gist carried a closing clause — "— no clicking through the UI" —
      // which is advice, not shape, and is usually where the clip landed.
      .replace(/\s+—\s.*$/, '')
      .trim() || proven.returns;
}

/**
 * The code that worked, under the endpoint it worked on.
 *
 * Three renderers announced that a proven endpoint had a working call behind it
 * — `describe` here, `renderInterface` in the reference an agent opens before
 * real work, and each in its own words — and all three printed the label and
 * dropped the code. The snippet was reachable from `procedure_draft` and
 * nowhere else, and across 594 recorded tool calls `procedure_draft` was called
 * zero times.
 *
 * What that cost is measurable in the same log: `GET /api/v4/zones` was written
 * from scratch by hand in four separate sessions and `/api/vps/v1/virtual-machine`
 * in three, while the working call for both sat in this field from the first
 * session onwards. Announcing that a better version exists and requiring a
 * second call to see it is the shape this brief already established costs turns
 * — inlining lesson bodies took one scenario from 17.3 turns to 11.3 while
 * serving *more* text. This is the last field that was still doing it.
 *
 * Cheap because proof is rare and earned: 5 of 250 endpoints across the real
 * store carry one, never more than two on a domain, none longer than 600
 * characters — which is the length `prove` clips them to.
 */
export function renderProof(endpoint: Endpoint): string {
  if (!endpoint.proven)
    return '';
  return `\n  \`\`\`js\n${endpoint.proven.snippet.split('\n').map(line => `  ${line}`).join('\n')}\n  \`\`\`\n` +
    `  _Ran on ${endpoint.proven.at}. Anything hard-coded in it belonged to that one call._`;
}

/**
 * Routes the site has stopped exercising, without having stopped working.
 *
 * Separate from a broken one on purpose. A 404 is the site telling us the route
 * is gone; silence is only the site not needing it on the pages that were
 * visited, which is why this is phrased as something to notice rather than
 * something to believe. It is still worth surfacing, because the pattern that
 * matters — a site redesigned underneath a store full of lessons about it —
 * looks exactly like a cluster of routes going quiet at once.
 */
const VANISHED_AFTER_DAYS = 30;

export function drift(endpoints: Endpoint[], mapUpdated?: string): { broken: Endpoint[]; quiet: Endpoint[] } {
  const broken = endpoints.filter(endpoint => endpoint.brokeAt);
  const asOf = mapUpdated ? Date.parse(`${mapUpdated}T00:00:00Z`) : Date.now();
  const quiet = endpoints.filter(endpoint => {
    if (endpoint.brokeAt)
      return false;
    // Judged against the map's own last update, not against now: a store nobody
    // has touched for a year should not report its whole contents as vanished.
    const age = Math.floor((asOf - Date.parse(`${endpoint.lastSeen}T00:00:00Z`)) / 86400000);
    // Something seen once and never again was probably always a one-off.
    return age >= VANISHED_AFTER_DAYS && endpoint.seen >= 3;
  });
  return { broken, quiet };
}

/**
 * The compact form that rides along with a brief. Ordered by how often the site
 * itself calls each one, which is a good proxy for how central it is.
 */
export function renderApiMap(domain: string, endpoints: Endpoint[], limit = IN_BRIEF): string {
  if (!endpoints.length)
    return '';
  /*
   * A proven endpoint is never cut, and is never below one that is merely
   * observed.
   *
   * The order is `seen` descending — how often the site's own pages call a
   * route, which is a fair proxy for how central it is and knows nothing about
   * whether anyone has made it work. Proof is the other kind of evidence
   * entirely, and the limit exists to drop one-off calls, so a route proved by
   * a single deliberate fetch was exactly what it discarded. Measured on the
   * real store: four of the five proven endpoints fell below the cut and never
   * appeared in a brief at all — `/api/v4/zones` at rank 18 of 37 and
   * `POST /api/v4/zones/:id/dns_records`, the most expensive kind to work out
   * again, dead last at 37.
   *
   * Bounded by the same rarity that makes it worth doing: the cap still governs
   * the observed routes, and proof has to be earned one deliberate call at a
   * time.
   */
  const proven = endpoints.filter(endpoint => endpoint.proven);
  const observed = endpoints.filter(endpoint => !endpoint.proven);
  const shown = [...proven, ...observed.slice(0, Math.max(0, limit - proven.length))];
  const rest = endpoints.length - shown.length;
  // "Mostly", because `prove` also admits a route an agent called directly and
  // got data back from, which the miner may never have watched go past. The
  // line used to say these were all the site's own traffic; the ✓ on a proven
  // entry is what tells the two apart, and the header must not contradict it.
  return `**Internal API observed on ${domain}** — mostly the requests the site's own pages make, ` +
    `captured from real traffic. Calling them with \`fetch\` from a page on ${domain} reuses the ` +
    `session cookies already in the browser, and is almost always faster than driving the UI.\n\n` +
    `${shown.map(describe).join('\n')}` +
    `${rest > 0 ? `\n\n_…and ${rest} more. \`domain_interface\` lists them all._` : ''}`;
}
