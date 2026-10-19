/**
 * Loads the knowledge already learned by hand into the store, so a fresh
 * install is not empty. Safe to re-run: same titles overwrite.
 */

import { defaultMemoryDir } from '../src/lib/roots.ts';

import { Harness } from '../test/harness.ts';

const harness = await Harness.start(defaultMemoryDir);

// Nothing here is a principle. "Every action goes through the browser" was
// seeded as a global lesson once; it is the server's contract and now lives in
// the gateway's MCP instructions, where it cannot be ranked, disputed, curated
// away or aged out. What belongs in this file is only what an agent could have
// discovered on the site itself.
const lessons = [
  {
    url: '*',
    kind: 'fast-path',
    title: 'Check the network tab before touching the UI',
    gist: 'Most dashboards are an SPA over an internal JSON API; one call usually replaces a dozen page loads.',
    body: 'Load the page that already shows the data you want, then list network requests filtered by "api". ' +
      'The page\'s own XHRs are the authoritative list of what is available, and they are session-authenticated ' +
      'already. Call the endpoint directly with browser_evaluate + fetch instead of clicking through the UI.',
    tags: ['principle', 'api', 'spa', 'network'],
  },
  {
    url: 'https://hpanel.hostinger.com',
    kind: 'fast-path',
    title: 'Read every VPS from the internal API instead of the UI',
    gist: 'One session-authed fetch returns all VPS fully hydrated; replaces dozens of page loads.',
    body: 'hPanel is an SPA over a session-cookie-authenticated REST API. Once logged in, no bearer token is needed.\n\n' +
      'Useful routes:\n' +
      '- `/api/vps/v1/virtual-machine` — all VPS: plan, node, datacenter id, cpus, memory, disk_space/disk_usage, bandwidth, ipv4/ipv6, firewall_group_id, daily_backup, metadata\n' +
      '- `/api/vps/v1/virtual-machine/{id}/backups` — plural; `/backup` is 404\n' +
      '- `/api/vps/v1/virtual-machine/{id}/snapshot` — singular here\n' +
      '- `/api/vps/v1/firewall`, `/api/vps/v1/data-centers`\n' +
      '- `/api/resources/api/v2/resources?state[]=active` — all account resources\n' +
      '- `/api/billing/api/v1/customer/subscriptions-with-scheduled-changes?per_page=100` — join to a VPS via `subscription.id == vm.metadata.order_id`\n\n' +
      'To discover more: load the relevant page, then browser_network_requests with filter "api" — the SPA\'s own XHRs are the authoritative list.\n\n' +
      'Routes that look plausible but 404: `/actions`, `/public-keys`.',
    snippet: "await fetch('/api/vps/v1/virtual-machine').then(r => r.json())",
    tags: ['vps', 'api', 'hostinger', 'billing', 'firewall'],
  },
  {
    url: 'https://hpanel.hostinger.com',
    kind: 'fix',
    title: 'VPS metrics endpoint returns 422 on ISO dates',
    gist: 'Pass unix seconds, not ISO-8601, and read the response from data[0].',
    trigger: '422 from /api/vps/v1/virtual-machine metrics',
    body: '`/api/vps/v1/virtual-machine/{id}/metrics?date_from=&date_to=` accepts **unix seconds only**; ISO-8601 returns 422.\n\n' +
      'The response shape is `data[0]` — an object keyed by human-readable names ("CPU usage", "RAM usage", "Disk space", ' +
      '"Incoming traffic", "Outgoing traffic", "Uptime"), each `{unit, usage: {unixTs: value}}`. Iterating `data` directly yields nothing useful.',
    snippet: "const to = Math.floor(Date.now()/1000), from = to - 86400;\n" +
      "const r = await fetch(`/api/vps/v1/virtual-machine/${id}/metrics?date_from=${from}&date_to=${to}`).then(r => r.json());\n" +
      "const metrics = r.data[0];",
    tags: ['metrics', 'vps', '422'],
  },
  {
    url: 'https://hpanel.hostinger.com',
    kind: 'auth',
    title: 'Log in by hand once; the browser profile keeps the session',
    gist: 'Never type credentials — navigate to the login page, stop, and let Akiva log in.',
    body: 'The persistent Chrome profile keeps cookies across sessions, so check whether you are already ' +
      'authenticated before asking. Hostinger tokens do expire within hours, unlike Google. When they lapse, ' +
      'navigate to the login page and wait for Akiva rather than attempting the login yourself.',
    tags: ['login', 'session', 'cookies'],
  },
  {
    url: 'https://dash.cloudflare.com',
    kind: 'fast-path',
    title: 'Use the dashboard API v4 with the session cookie',
    gist: 'dash.cloudflare.com/api/v4 works session-authed; one call returns all zone settings.',
    body: 'The full Cloudflare API v4 is reachable at `dash.cloudflare.com/api/v4` using the dashboard session ' +
      'cookie — no API token needed. All zone settings come back in a single call rather than one request per setting.\n\n' +
      'RDAP lookups need `curl -L`; they redirect.',
    snippet: "await fetch('/api/v4/zones').then(r => r.json())",
    tags: ['cloudflare', 'dns', 'zones', 'api'],
  },
];

for (const lesson of lessons)
  console.log(await harness.text('domain_remember', lesson));

console.log('\n' + await harness.text('domain_index'));
await harness.close();
