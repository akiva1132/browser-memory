import { z } from 'zod';

import { CURATE_THRESHOLD, analyze } from './curate.ts';
import { renderCuration, renderInterface } from './curateRender.ts';
import { GLOBAL_SCOPE, normalizeDomain } from './store.ts';
import type { ApiMap } from '../capture/apiMap.ts';
import type { MemoryStore } from './store.ts';
import type { ProcedureStore } from '../procedures/store.ts';
import type { LocalTool } from '../types.ts';

export { CURATE_THRESHOLD };

export function curateTools(
  store: MemoryStore, procedures: ProcedureStore, apiMap: ApiMap,
): LocalTool[] {
  return [
    {
      name: 'domain_interface',
      title: 'What this site can already do',
      description:
        'The operations a site has accumulated: proven procedures with their signatures, shortcuts not ' +
        'yet turned into operations, how access works, and what is known not to work. Read this when ' +
        'you are about to do real work on a site that has been visited before — it is shorter than the ' +
        'lessons and tells you what is callable right now.',
      schema: {
        url: z.string().describe('The URL or domain.'),
      },
      handle: async args => {
        const { url } = args as { url: string };
        const domain = normalizeDomain(url);
        const [entries, procs, endpoints] = await Promise.all([
          store.applicable(domain),
          procedures.forDomain(domain),
          apiMap.forDomain(domain),
        ]);
        return renderInterface(domain, entries, procs, endpoints);
      },
    },
    {
      name: 'domain_curate',
      title: 'Consolidate what a site has accumulated',
      description:
        'Run this when a site has built up enough knowledge to be worth tidying — domain_brief will say ' +
        'so. It returns candidates found mechanically: lessons that overlap, values hardcoded into ' +
        'procedures that should be parameters, knowledge that is really about the web rather than this ' +
        'site, entries nobody has used, and procedures that are broken or never proven.\n\n' +
        'It changes nothing. Every item is a candidate and the judgement is yours: whether two lessons ' +
        'really say the same thing, whether a pattern generalizes, whether a literal would differ on the ' +
        'next call. Apply what you agree with using domain_remember, domain_forget and procedure_save, ' +
        'then call this again with done: true to record that the pass happened.\n\n' +
        'The goal is a site that converges on a small set of proven operations, not an archive that ' +
        'grows forever. Every entry costs ranking quality and tokens on every single brief.',
      schema: {
        url: z.string().describe('The URL or domain to curate.'),
        done: z.boolean().optional().describe('Pass true after you have applied your changes, to record the pass.'),
      },
      handle: async args => {
        const { url, done } = args as { url: string; done?: boolean };
        const domain = normalizeDomain(url);
        if (done) {
          await store.markCurated(domain);
          return `Recorded a curation pass for ${domain}.`;
        }
        // The observed traffic is what turns "these two lessons disagree" into
        // "and here is which of them the site has never actually done".
        const [entries, procs, everyDomain, endpoints] = await Promise.all([
          store.entries(domain),
          procedures.forDomain(domain),
          store.everyDomain(),
          apiMap.forDomain(domain).catch(() => []),
        ]);
        if (!entries.length && !procs.length)
          return `Nothing recorded for ${domain} yet.`;
        const others = everyDomain.filter(other => other.domain !== domain && other.domain !== GLOBAL_SCOPE);
        const target = { domain, entries, procedures: procs, endpoints };
        const report = renderCuration(domain, target, analyze(target, others));
        const last = await store.curatedAt(domain);
        return `${report}\n\n---\n\n_${last ? `Last curated ${last}.` : 'Never curated before.'} ` +
          `When you are finished, call domain_curate({ url: "${domain}", done: true })._`;
      },
    },
  ];
}
