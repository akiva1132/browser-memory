import type { Endpoint } from './apiMap.ts';
import { PROCEDURE_NAME } from '../procedures/store.ts';
import type { ProcedureInput } from '../types.ts';

/**
 * A procedure, written from an endpoint the site was already seen calling.
 *
 * `procedure_save` is described in its own text as the highest-leverage thing
 * an agent can leave behind, and across three measured runs it was called zero
 * times. The reason is visible in what it asks for: a name, an origin, a
 * parameter list, and a body of JavaScript, composed from nothing, at the end
 * of a task, under a review gate the agent knows is there. Every one of those
 * is individually reasonable and together they are a wall.
 *
 * Almost all of it is already known. The API map holds the method, the path,
 * the query parameters and the status the site itself got back. What an agent
 * has to supply is the part only it knows — what the endpoint is for, and which
 * field of the response is the answer. So this generates everything else and
 * leaves those two.
 *
 * Nothing here is speculative: an endpoint reaches the map only after the site
 * called it and got a 2xx, so a draft is a description of something that has
 * already worked, not a guess about something that might.
 */

/**
 * The label a person would call the site by.
 *
 * Not the first label: `dash.cloudflare.com` would name every procedure
 * `dash_*`, which collides with the next dashboard and identifies nothing.
 * The registrable label is the site's identity — `hostinger`, `cloudflare` —
 * and stepping left past a short one keeps `site.co.uk` from becoming `co`.
 */
function siteLabel(domain: string): string {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2)
    return labels[0] ?? 'site';
  const index = labels.length - 2;
  const picked = labels[index]!;
  return picked.length <= 3 && index > 0 ? labels[index - 1]! : picked;
}

/** Turns `/api/v1/servers/:id/metrics` into `hostinger_servers_metrics`. */
export function suggestName(domain: string, endpoint: Endpoint): string {
  const site = siteLabel(domain);
  const parts = endpoint.path.split('/')
      .filter(part => part && part !== ':id' && !/^(api|rest|v\d+|graphql|json|ajax)$/i.test(part))
      .map(part => part.replace(/[^a-z0-9]+/gi, '_').toLowerCase())
      .filter(Boolean);
  const verb = endpoint.method === 'GET' ? '' : `${endpoint.method.toLowerCase()}_`;
  return fitName([site, verb + (parts.join('_') || 'call')].join('_').replace(/_+/g, '_'));
}

/** Longest name `procedure_save` accepts: one letter plus 48 more. */
const MAX_NAME = 49;

/**
 * Cut to what will actually save.
 *
 * The draft path exists to lower the barrier to saving a procedure, and it was
 * cutting names at 60 against a limit of 49 — so a deep path produced a snippet
 * that `procedure_save` rejected the moment anybody copied it, and it did that
 * precisely on the endpoints deep enough to be worth the trouble. The rule is
 * imported from the store rather than restated, so the two cannot drift apart
 * again.
 */
function fitName(raw: string): string {
  const cleaned = raw.toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^[^a-z]+/, '')
      .replace(/_+/g, '_');
  // Trailing underscores are legal but read as a truncation artefact.
  const cut = cleaned.slice(0, MAX_NAME).replace(/_+$/, '');
  if (PROCEDURE_NAME.test(cut))
    return cut;
  // Too short, or nothing usable survived: a name that saves beats a prettier
  // one that does not.
  const padded = `${cut || 'endpoint'}_call`.slice(0, MAX_NAME).replace(/_+$/, '');
  return PROCEDURE_NAME.test(padded) ? padded : 'saved_endpoint';
}

/** Path placeholders become required parameters; query names become optional ones. */
export function suggestParams(endpoint: Endpoint): ProcedureInput['params'] {
  const ids = endpoint.path.split('/').filter(part => part === ':id').length;
  const path = Array.from({ length: ids }, (_, index) => ({
    name: ids === 1 ? 'id' : `id${index + 1}`,
    type: 'string' as const,
    description: `Value for the ${ordinal(index + 1)} \`:id\` in ${endpoint.path}.`,
    required: true,
  }));
  const query = endpoint.params.map(name => ({
    name: safeName(name),
    type: 'string' as const,
    description: `Query parameter \`${name}\`, which the site sends on this call.`,
    required: false,
  }));
  /*
   * A request that is not a GET has a body, and nothing declared one — so the
   * generated code read `params.body`, found nothing, and sent `{}` on every
   * call. A drafted POST was not merely unsafe, it was inert: it changed
   * something, always with an empty payload.
   *
   * Declared as a string because a procedure parameter can only be a string, a
   * number or a boolean. That is honest here anyway: the caller is passing JSON
   * text through, and the generated code sends it as it stands.
   */
  const body = endpoint.method === 'GET' ? [] : [{
    name: 'body',
    type: 'string' as const,
    description: 'JSON request body, as text. The site decides the shape; watch one real ' +
      `${endpoint.method} in the network log to see it.`,
    required: true,
  }];
  return [...path, ...query, ...body];
}

const ordinal = (n: number): string => (n === 1 ? 'first' : n === 2 ? 'second' : `${n}th`);

/** `statuses[]` is a real query name and not a usable identifier. */
const safeName = (raw: string): string => raw.replace(/[^a-z0-9_]/gi, '_').replace(/_+$/, '') || 'param';

export function draftCode(endpoint: Endpoint): string {
  const ids = endpoint.path.split('/').filter(part => part === ':id').length;
  const names = Array.from({ length: ids }, (_, index) => (ids === 1 ? 'id' : `id${index + 1}`));
  // Substituted one at a time so a path with two placeholders fills both.
  const pathExpr = names.length
    ? names.reduce((expr, name) => `${expr}.replace(':id', String(params.${name}))`,
        JSON.stringify(endpoint.path))
    : JSON.stringify(endpoint.path);

  const query = endpoint.params.length
    ? [
      'const query = new URLSearchParams();',
      ...endpoint.params.map(name =>
        `if (params.${safeName(name)} !== undefined) query.set(${JSON.stringify(name)}, String(params.${safeName(name)}));`),
      'const url = query.size ? `${path}?${query}` : path;',
    ].join('\n')
    : 'const url = path;';

  const body = endpoint.method === 'GET'
    ? `const response = await fetch(url, { credentials: "include" });`
    // `params.body` is already JSON text, so it is sent as it stands. Passing it
    // through JSON.stringify would send a quoted string, and the previous
    // version stringified a parameter nothing declared, so every drafted
    // request carried an empty object.
    : `const response = await fetch(url, {\n  method: ${JSON.stringify(endpoint.method)},\n  credentials: "include",\n  headers: { "content-type": "application/json" },\n  body: params.body,\n});`;

  return [
    `const path = ${pathExpr};`,
    query,
    body,
    'if (!response.ok) throw new Error(`${response.status} from ${url}`);',
    'const data = await response.json();',
    '// TODO: return the part that answers the question, not the whole payload.',
    'return data;',
  ].join('\n');
}

/**
 * The snippet an agent ran, handed over with the one thing it lacks: a note
 * that the values in it were that call's, and are this procedure's parameters.
 */
function provenCode(endpoint: Endpoint): string {
  return [
    `// Proved on ${endpoint.proven!.at}: an agent ran this and got back ${endpoint.proven!.returns}.`,
    '// Whatever is hard-coded below belonged to that one call — take those through `params`.',
    endpoint.proven!.snippet,
  ].join('\n');
}

export type Draft = {
  name: string;
  origin: string;
  code: string;
  params: ProcedureInput['params'];
  endpoint: Endpoint;
  /**
   * Anything that is not a GET, until a human says otherwise. A drafted
   * procedure saved without this ran with no confirmation gate at all — the
   * gate exists for exactly the requests a draft is most likely to get wrong,
   * and defaulting it to false made every generated POST, PUT and DELETE
   * unguarded.
   */
  mutating: boolean;
};

export function draftFor(domain: string, endpoint: Endpoint): Draft {
  return {
    name: suggestName(domain, endpoint),
    origin: `https://${domain}`,
    /*
     * Code that has run beats code that was generated.
     *
     * When an agent has already fetched this endpoint and got data back, the
     * map holds what it ran. That snippet knows things the template cannot
     * guess — the headers this site wants, whether the response is JSON or a
     * wrapped envelope, which query parameters actually matter. Generating a
     * fresh guess alongside it and offering that instead was throwing away the
     * only version anybody had evidence for.
     */
    code: endpoint.proven ? provenCode(endpoint) : draftCode(endpoint),
    params: suggestParams(endpoint),
    endpoint,
    mutating: endpoint.method !== 'GET',
  };
}

export function renderDraft(domain: string, draft: Draft): string {
  const params = draft.params?.length
    ? draft.params.map(param =>
      `  { name: ${JSON.stringify(param.name)}, type: "string", required: ${param.required ?? false}, ` +
      `description: ${JSON.stringify(param.description)} }`).join(',\n')
    : '';
  return [
    `Draft for \`${draft.endpoint.method} ${draft.endpoint.path}\` on ${domain} ` +
      `— seen ${draft.endpoint.seen}x, last returning ${draft.endpoint.status}.`,
    '',
    'Run it first. Then save it with the two things only you can supply: what it is for,',
    'and which part of the response is the answer.',
    '',
    '```js',
    draft.code,
    '```',
    '',
    'procedure_save({',
    `  url: ${JSON.stringify(domain)},`,
    `  name: ${JSON.stringify(draft.name)},`,
    '  description: "<what an agent deciding whether to call this needs to know>",',
    `  origin: ${JSON.stringify(draft.origin)},`,
    ...(draft.mutating
      ? ['  // Not a GET: it changes something, so it is gated behind confirm.',
        '  mutating: true,']
      : []),
    ...(params ? ['  params: [', params, '  ],'] : []),
    '  expects: "<shape of a good result, so a wrong answer is recognizable>",',
    '  code: "<the code above, with the TODO resolved>",',
    '})',
  ].join('\n');
}
