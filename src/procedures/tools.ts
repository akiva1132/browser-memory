import { z } from 'zod';

import { explainFindings } from './codeReview.ts';
import { draftFor, renderDraft } from '../capture/draft.ts';
import { normalizeDomain } from '../memory/store.ts';
import type { Endpoint } from '../capture/apiMap.ts';
import type { ProcedureStore } from './store.ts';
import type { LocalTool, ProcedureInput } from '../types.ts';

/** Only the read side of the API map is needed here. */
type ApiMapReader = { forDomain: (domain: string) => Promise<Endpoint[]> };

const paramSchema = z.object({
  name: z.string().describe('Parameter name, as the caller will pass it.'),
  type: z.enum(['string', 'number', 'boolean']).describe('Its type.'),
  description: z.string().describe('What it means, and any constraint (units, format, allowed values).'),
  required: z.boolean().optional().describe('Whether the procedure fails without it.'),
});

export function procedureTools(store: ProcedureStore, apiMap: ApiMapReader): LocalTool[] {
  return [
    {
      name: 'procedure_draft',
      title: 'Start a procedure from an endpoint the site already calls',
      description:
        'Turn an endpoint from this site\'s observed API into working code you can run, adjust and save. ' +
        'Use it before writing a fetch by hand: the method, the path, the parameter names and the fact ' +
        'that it returns 2xx were all learned from the site\'s own traffic, so a draft describes ' +
        'something that has already worked rather than something that might.\n\n' +
        'Pass no name to see what is available. What is left for you is the part only you know: what ' +
        'the endpoint is for, and which field of the response actually answers the question.',
      schema: {
        url: z.string().describe('The site.'),
        endpoint: z.string().optional().describe(
            'Which one, as `GET /api/v1/servers` or just a distinctive fragment of the path. ' +
            'Omit to list the candidates.'),
      },
      handle: async args => {
        const { url, endpoint: wanted } = args as { url: string; endpoint?: string };
        const domain = normalizeDomain(url);
        const observed = await apiMap.forDomain(domain);
        if (!observed.length) {
          return `No API traffic has been observed on ${domain} yet. Browse the page that shows what ` +
            `you need — the endpoints it calls are recorded automatically — then try again.`;
        }
        if (!wanted) {
          return `${observed.length} endpoint(s) observed on ${domain}. Draft one with ` +
            `procedure_draft({ url, endpoint }):\n\n` +
            observed.slice(0, 20).map(item =>
              `- \`${item.method} ${item.path}\`${item.params.length ? ` ?${item.params.join('&')}` : ''} ` +
              `· seen ${item.seen}x · ${item.status}`).join('\n');
        }
        const needle = wanted.trim().toLowerCase();
        const matches = observed.filter(item =>
          `${item.method} ${item.path}`.toLowerCase().includes(needle) ||
          item.path.toLowerCase().includes(needle));
        if (!matches.length)
          return `Nothing observed on ${domain} matches "${wanted}". Call procedure_draft({ url }) to see the list.`;
        if (matches.length > 1 && matches[0]!.path !== matches[1]!.path) {
          return `"${wanted}" matches ${matches.length} endpoints on ${domain} — say which:\n\n` +
            matches.slice(0, 10).map(item => `- \`${item.method} ${item.path}\``).join('\n');
        }
        return renderDraft(domain, draftFor(domain, matches[0]!));
      },
    },
    {
      name: 'procedure_save',
      title: 'Turn something you just worked out into a reusable tool',
      description:
        'Promote a task you have just completed into a callable tool, so the next agent invokes it ' +
        'instead of working it out again. This is the highest-leverage thing you can leave behind: a ' +
        'lesson still has to be read and applied, a procedure is simply called.\n\n' +
        'Save one only when you have actually run the code and seen it work in this session.\n\n' +
        'Parameterize it. If you fetched metrics for one VPS over one time window, the procedure takes ' +
        '(vpsId, hours) — hardcoding the values you happened to use is the single most common way this ' +
        'goes wrong and produces a tool nobody can reuse.\n\n' +
        'The code runs in the page via evaluate, with your parameters available as `params`. It must ' +
        'return a value. It is checked against `origin` before running, so it cannot fire on the wrong ' +
        'site. Mark `mutating: true` for anything that creates, changes or deletes — those refuse to run ' +
        'without explicit confirmation, and should be rare.',
      schema: {
        url: z.string().describe('The site this belongs to.'),
        name: z.string().describe('Tool name: lowercase with underscores, descriptive, globally unique. e.g. "hostinger_list_vps".'),
        description: z.string().describe('What it does, for an agent deciding whether to call it.'),
        origin: z.string().describe('Exact origin it must run on, e.g. "https://hpanel.hostinger.com".'),
        code: z.string().describe('JS body with `params` in scope. Must return a value. No secrets — they are stripped.'),
        params: z.array(paramSchema).optional().describe('The parameters it accepts.'),
        expects: z.string().optional().describe('Shape of a successful result, so a wrong answer is recognizable.'),
        mutating: z.boolean().optional().describe('True if it changes state on the site. Defaults to false.'),
      },
      handle: async args => {
        const { url, ...spec } = args as ProcedureInput & { url: string };
        const domain = normalizeDomain(url);
        const saved = await store.save(domain, spec);
        const flagged = saved.findings.length
          ? `\n\nThe static review flagged this code:\n${explainFindings(saved.findings)}\n` +
            `If any of that was not deliberate, fix it and save again — flagged code is unlikely to be approved.`
          : '';
        return `Saved procedure \`${saved.name}\` for ${domain}. ` +
          `${saved.mutating ? 'Marked as state-changing: callers must pass confirm: true.' : 'Marked read-only.'} ` +
          `It is now advertised as a tool named \`${saved.name}\`, and marked unverified until it runs ` +
          `successfully through that tool.${flagged}`;
      },
    },
    {
      name: 'procedure_list',
      title: 'Which procedures exist',
      description:
        'List saved procedures, including unverified and broken ones that are not advertised as tools. ' +
        'Use it to see what automation a site already has, or to find something worth repairing.',
      schema: {
        url: z.string().optional().describe('Limit to one site. Omit for all sites.'),
      },
      handle: async args => {
        const { url } = args as { url?: string };
        const all = url ? await store.forDomain(normalizeDomain(url)) : await store.all();
        if (!all.length)
          return url ? `No procedures for ${normalizeDomain(url)}.` : 'No procedures saved yet.';
        return all.map(procedure =>
          `- \`${procedure.name}\` · ${procedure.domain} · ` +
          `**${procedure.status}**` +
          `${procedure.mutating ? ' · mutating' : ''}` +
          `${procedure.findings.length ? ` · ${procedure.findings.length} review flag(s)` : ''} — ${procedure.description}\n` +
          `    ${procedure.ok}/${procedure.runs} runs succeeded` +
          `${procedure.lastRun ? `, last ${procedure.lastRun}` : ', never run'}`).join('\n');
      },
    },
    {
      name: 'procedure_delete',
      title: 'Remove a procedure',
      description: 'Delete a procedure that is wrong or obsolete. A broken one is often worth fixing with procedure_save instead.',
      schema: {
        url: z.string().describe('The site it belongs to.'),
        name: z.string().describe('The procedure name.'),
      },
      handle: async args => {
        const { url, name } = args as { url: string; name: string };
        const domain = normalizeDomain(url);
        const removed = await store.remove(domain, name);
        return removed ? `Deleted procedure \`${name}\` from ${domain}.` : `No procedure \`${name}\` on ${domain}.`;
      },
    },
  ];
}
