import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What a scenario is, and what counts as having done the job.
 *
 * A check is the whole difference between a run that finished and a run that
 * worked, and every one here is deliberately mechanical: a file on disk with
 * real bytes in it, two page objects inside a PDF, a message the mail server
 * agrees exists. None of them ask the agent whether it succeeded.
 *
 * Scenarios are the honest test of this whole system. Unit tests prove the
 * parts behave; these prove an agent given a real, multi-site, multi-step job
 * actually finishes it — and, run cold against warm, whether the accumulated
 * memory made any difference. A claim that memory helps is worth exactly as
 * much as the number next to it.
 *
 * Each scenario names the claim it tests, so a failure says what broke rather
 * than only that something did.
 */

export type CheckContext = {
  /** Fresh directory the agent runs in; artifacts it produces land here. */
  workdir: string;
  /** The agent's final message. */
  output: string;
  /**
   * Drives the same browser the agent used, for checks that have to look at the
   * world instead of at what the agent said about it. Present only when the
   * browser stack is up.
   */
  browser?: (tool: string, args: Record<string, unknown>) => Promise<string>;
  /**
   * The store this run read and wrote. For the checks whose subject is memory
   * itself — whether a lesson that turned out to be false was corrected, rather
   * than quietly routed around and left in place for the next agent to obey.
   */
  memoryDir: string;
};

export type Check = {
  name: string;
  run: (context: CheckContext) => Promise<boolean>;
};

export type Scenario = {
  id: string;
  title: string;
  /** The claim this exercises — what we learn if it passes or fails. */
  tests: string;
  prompt: string;
  allowedTools: string[];
  /** Sends mail, downloads, or otherwise touches the world. Opt in with --side-effects. */
  sideEffects: boolean;
  /** Sites that must already be logged in for this to mean anything. */
  needsAuth: string[];
  timeoutMs: number;
  checks: Check[];
};

const BROWSER = 'mcp__browser__';

/**
 * Prompts here state the task and nothing else.
 *
 * They deliberately do not repeat "do this through the browser". That is the
 * server's contract, declared in its MCP instructions, and a scenario that has
 * to restate it is measuring the prompt rather than the system. When an agent
 * reaches for a service API instead, that is a result — it means the contract
 * is not landing, which is exactly what these runs exist to find out.
 */

/** The read-only browsing surface: enough to explore and extract, nothing that writes. */
export const READ_TOOLS = [
  `${BROWSER}browser_navigate`,
  `${BROWSER}browser_snapshot`,
  `${BROWSER}browser_evaluate`,
  `${BROWSER}browser_find`,
  `${BROWSER}browser_click`,
  `${BROWSER}browser_type`,
  `${BROWSER}browser_take_screenshot`,
  `${BROWSER}browser_network_requests`,
  `${BROWSER}browser_tabs`,
  `${BROWSER}browser_wait_for`,
  `${BROWSER}browser_file_upload`,
  `${BROWSER}browser_fill_form`,
  `${BROWSER}browser_press_key`,
  // Cookie walls and CAPTCHAs are the normal state of the open web, so the way
  // out of one has to be reachable in every scenario that touches it.
  `${BROWSER}browser_ask_user`,
];

/** The memory surface. Present in every scenario — using it is the agent's choice. */
export const MEMORY_TOOLS = [
  `${BROWSER}domain_brief`,
  `${BROWSER}domain_open`,
  `${BROWSER}domain_unstick`,
  `${BROWSER}domain_remember`,
  `${BROWSER}domain_report`,
  `${BROWSER}domain_interface`,
  `${BROWSER}procedure_save`,
  `${BROWSER}procedure_list`,
];

async function filesIn(workdir: string): Promise<{ name: string; size: number }[]> {
  const names = await fs.readdir(workdir).catch(() => [] as string[]);
  const out: { name: string; size: number }[] = [];
  for (const name of names) {
    const stat = await fs.stat(path.join(workdir, name)).catch(() => undefined);
    if (stat?.isFile())
      out.push({ name, size: stat.size });
  }
  return out;
}

/** A produced file, matched by extension, big enough not to be an error page. */
export const producedFile = (label: string, pattern: RegExp, minBytes: number): Check => ({
  name: `${label} (>${Math.round(minBytes / 1024)}KB)`,
  run: async ({ workdir }) => (await filesIn(workdir)).some(
      file => pattern.test(file.name) && file.size >= minBytes),
});

export const mentions = (label: string, pattern: RegExp): Check => ({
  name: label,
  run: async ({ output }) => pattern.test(output),
});

/** Waits for a Gmail search to settle before believing an empty result. */
export async function gmailShows(
  browser: NonNullable<CheckContext['browser']>, query: string, needle: RegExp,
): Promise<boolean> {
  await browser('browser_navigate', {
    url: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`,
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    const seen = await browser('browser_evaluate', {
      function: '() => document.body.innerText.slice(0, 6000)',
    });
    if (needle.test(seen))
      return true;
    if (/No messages matched/i.test(seen))
      return false;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return false;
}

/** A real PDF with more than one page in it, rather than a file with the right name. */
export const mergedPdf = (label: string): Check => ({
  name: label,
  run: async ({ workdir }) => {
    for (const file of await filesIn(workdir)) {
      if (!/\.pdf$/i.test(file.name) || file.size < 10_000)
        continue;
      const raw = await fs.readFile(path.join(workdir, file.name)).catch(() => undefined);
      if (!raw || !raw.subarray(0, 5).toString('latin1').startsWith('%PDF'))
        continue;
      // Two page objects is the whole claim: a merge that silently produced
      // only the receipt would pass a name-and-size check.
      const pages = raw.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
      if (pages >= 2)
        return true;
    }
    return false;
  },
});
