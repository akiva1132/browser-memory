#!/usr/bin/env node
/**
 * One MCP endpoint for the agent.
 *
 * Claude connects here and nowhere else. Everything the upstream Playwright MCP
 * server offers is passed straight through, and the memory, procedure and
 * curation tools are advertised alongside it, so from the agent's side there is
 * a single browser capability rather than several servers to reason about.
 *
 * Being in the middle is also the point: it is the only place we can react to
 * what the agent does without forking Playwright. Today that means surfacing a
 * site's accumulated lessons the first time an agent navigates there, instead of
 * hoping it remembers to ask, and running saved procedures as first-class tools.
 */
import fs from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { memoryTools } from '../memory/tools.ts';
import { procedureTools } from '../procedures/tools.ts';
import { curateTools } from '../memory/curateTools.ts';
import { isCallable, procedureDescription, procedureInputSchema } from '../procedures/store.ts';
import { runProcedure } from '../procedures/run.ts';
import { describeArgs } from '../lib/trace.ts';
import { explainFailure } from '../browser/diagnose.ts';
import { collapseRepeat, snapshotFileOf, snapshotWithin, treeOf, urlOf } from '../browser/repeat.ts';
import type { Remembered } from '../browser/repeat.ts';
import { askUserTools } from '../browser/askUser.ts';
import { credentialTools } from '../browser/credentials.ts';
import { explainFindings, reviewProcedureCode } from '../procedures/codeReview.ts';
import { redactCode } from '../lib/redact.ts';
import { projectRoot } from '../lib/roots.ts';
import { bodyOf, failure, text, withNote } from '../lib/toolResult.ts';
import type { ToolResult } from '../lib/toolResult.ts';
import type { JsonSchema, LocalTool } from '../types.ts';
import { ABLATABLE, WITHOUT, without, withheldTools } from './ablation.ts';
import { apiMap, audit, observer, OUTPUT_DIR, places, procedures, store, trace, UPSTREAM } from './context.ts';
import { attachClient, clientCapabilities, confirmWithUser, requestUserAction } from './elicit.ts';
import {
  callUpstream, currentDomain, getUpstream, noteNavigation, releaseTab,
} from './upstream.ts';
import { currentPageFrom, memoryNudge, unstickHint } from './brief.ts';
import { environment, INSTRUCTIONS, knownSites } from './instructions.ts';

const tools: LocalTool[] = [
  ...memoryTools(store, !without('inline')),
  ...procedureTools(procedures, apiMap),
  ...curateTools(store, procedures, apiMap),
  // Deliberately given the un-observed browser path: this one reads pages
  // mid-login, and none of that belongs in the API map or the lesson store.
  ...askUserTools({
    call: (name, args) => callUpstream(name, args),
    ask: (title, message, mediaPath) => requestUserAction(title, message, mediaPath),
  }),
  // Same un-observed path, and for the same reason: these read and type into
  // login forms, and a password has no business in the API map or the lessons.
  ...credentialTools({ call: (name, args) => callUpstream(name, args) }),
];
const byName = new Map(tools.map(tool => [tool.name, tool]));
let capabilitiesLogged = false;

/**
 * The last accessibility tree handed to this agent, so an identical one is not
 * handed over twice. Counted in calls rather than in time, because what matters
 * is whether the earlier reply is still in the conversation, and a conversation
 * advances by turns.
 */
let calls = 0;
let lastTree: Remembered | undefined;

// Every trigger awaits the same release, so whichever arrives second exits
// after the work has finished rather than through the middle of it.
const stop = (): void => {
  void releaseTab().finally(() => process.exit(0));
};
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, stop);
process.stdin.on('end', stop);

/**
 * The tree a reply linked to instead of carrying.
 *
 * Measured: only `browser_snapshot` answers with an inline tree. `navigate` and
 * `click` answer with `- [Snapshot](.playwright-mcp/page-….yml)` — 536 bytes,
 * no `[ref=` anywhere in them. The agent opens that file itself, so it acts on
 * refs this process has never seen, and a session that worked straight off a
 * navigation recorded nothing at all: not a step of a form flow, nor the role-and-
 * name anchors that make a landmark lesson survive a restyle.
 *
 * Read from the upstream's own output directory, bounded, and never fatal — a
 * tree that cannot be read costs the recording, not the agent's call.
 */
const MAX_TREE_BYTES = 4_000_000;

async function linkedTree(body: string): Promise<string | undefined> {
  const link = snapshotFileOf(body);
  if (!link)
    return undefined;
  // Confined to the output directory, because the path arrives in a tool reply
  // and a reply is not a trusted source of file names — the reply to
  // `browser_evaluate` carries whatever the page returned.
  // `projectRoot` is the second candidate the link may have been written
  // relative to; either way it has to land inside OUTPUT_DIR to be read.
  const within = await snapshotWithin(OUTPUT_DIR, link, [projectRoot]);
  if ('refused' in within) {
    trace.write('upstream', 'tree', `Refused the linked snapshot ${link}: ${within.refused}.`);
    return undefined;
  }
  const file = within.file;
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat) {
    trace.write('upstream', 'tree', `The reply linked ${link}, but no such file exists.`);
    return undefined;
  }
  if (stat.size > MAX_TREE_BYTES) {
    trace.write('upstream', 'tree',
      `The linked snapshot ${link} is ${Math.round(stat.size / 1024)} KB, over the ` +
      `${Math.round(MAX_TREE_BYTES / 1024)} KB ceiling — not read.`, { bytes: stat.size });
    return undefined;
  }
  const tree = await fs.readFile(file, 'utf8').catch(() => undefined);
  trace.write('upstream', 'tree', tree === undefined
    ? `The linked snapshot ${link} could not be read.`
    : `Read the tree the agent was given: ${link}, ${Math.round(stat.size / 1024)} KB.`,
    { file: link, bytes: stat.size });
  return tree;
}

/**
 * The first line of an error body that says something, for the audit note.
 *
 * Playwright's failures open with a line of context — `### Result`, or the call
 * that was attempted — before the sentence that names the problem, so the
 * literal first line is often the least informative one available.
 */
function clipReason(body: string): string {
  const line = body.split('\n').map(part => part.trim())
      .find(part => part && !part.startsWith('#') && !part.startsWith('```')
        && !/^- \[/.test(part) && !/^(Ran Playwright code|Error:)$/i.test(part));
  return (line ?? body.slice(0, 200)).slice(0, 200);
}

// zod v4 emits JSON Schema natively; the separate zod-to-json-schema package
// silently produced empty schemas against v4, which the agent sees as a tool
// that takes no arguments.
function jsonSchemaFor(tool: LocalTool): JsonSchema {
  if (!Object.keys(tool.schema).length)
    return { type: 'object', properties: {} };
  const { $schema, ...schema } = z.toJSONSchema(z.object(tool.schema)) as JsonSchema & { $schema?: string };
  void $schema;
  return schema;
}

const server = new Server(
    { name: 'browser', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS + await environment() + await knownSites(),
    });

// Everything that asks the user goes through the client, which only exists now.
attachClient(server);

/**
 * Procedures saved by earlier agents appear as ordinary tools. Broken ones are
 * withheld: an agent that calls a tool which has failed its last two runs pays
 * the cost twice, once in the call and once in the detour it takes afterwards.
 */
async function procedureToolDefs() {
  const saved = await procedures.all().catch(() => []);
  return saved
      .filter(procedure => isCallable(procedure) && !byName.has(procedure.name))
      .map(procedure => ({
        name: procedure.name,
        title: `${procedure.domain}: ${procedure.name}`,
        description: procedureDescription(procedure),
        inputSchema: procedureInputSchema(procedure),
      }));
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const local = tools.filter(tool => !withheldTools.has(tool.name)).map(tool => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: jsonSchemaFor(tool),
  }));
  const fromProcedures = await procedureToolDefs();
  if (WITHOUT.size) {
    trace.write('list', '_without',
      `This arm is running without ${[...WITHOUT].map(name => ABLATABLE[name]?.what ?? name).join(' and ')}` +
      `${withheldTools.size ? `, so ${[...withheldTools].join(', ')} are not offered` : ''}.`,
      { without: [...WITHOUT] });
  }
  const generated = [...fromProcedures];
  /*
   * The generated half, spelled out one tool at a time.
   *
   * These are the only tools nobody wrote — a procedure an earlier agent saved.
   * An agent meets them as ordinary entries in a list with no hint of where
   * they came from, and so did everybody else, which is why "what is actually
   * being offered right now, and why" had no answer short of reading the store
   * by hand.
   */
  for (const tool of fromProcedures) {
    trace.write('list', tool.name,
      `Offering hand-saved procedure \`${tool.name}\` — ${tool.description}`,
      { origin: 'procedure' });
  }
  try {
    const { tools: remote } = await (await getUpstream()).listTools();
    // Local names win: a memory tool must never be shadowed by an upstream one.
    const taken = new Set([...byName.keys(), ...generated.map(tool => tool.name)]);
    const browser = remote.filter(tool => !taken.has(tool.name));
    trace.write('list', '_total',
      `Published ${local.length + generated.length + browser.length} tools: ` +
      `${local.length} memory, ${fromProcedures.length} procedure(s), ` +
      `${browser.length} browser.`,
      {
        memory: local.length, procedures: fromProcedures.length,
        browser: browser.length,
      });
    return { tools: [...local, ...generated, ...browser] };
  } catch (error) {
    trace.write('upstream', 'listTools',
      `The browser server at ${UPSTREAM} did not answer (${(error as Error).message}); ` +
      `publishing memory tools only.`);
    return {
      tools: [...local, ...generated, {
        name: 'browser_unavailable',
        description:
          `The browser server at ${UPSTREAM} is not reachable (${(error as Error).message}). ` +
          `Browser tools are offline; domain memory still works. ` +
          `Check: systemctl --user status playwright-mcp.service`,
        inputSchema: { type: 'object' as const, properties: {} },
      }],
    };
  }
});

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const started = Date.now();
  // Recorded here, below the agent, because an agent that has been talked into
  // something will also describe it innocently. This is the one account of a
  // session the agent cannot edit.
  const done = (outcome: 'ok' | 'error' | 'refused', note?: string, bytes?: number): void => {
    audit.record({
      tool: name, args, outcome, ms: Date.now() - started,
      ...(bytes === undefined ? {} : { bytes }),
      ...(note ? { note } : {}),
    });
    const ms = Date.now() - started;
    trace.write('call', name,
      `${name} ${outcome} in ${(ms / 1000).toFixed(1)}s` +
      `${bytes === undefined ? '' : `, ${bytes.toLocaleString()} bytes back`}` +
      `${note ? ` — ${note}` : ''}.`,
      { outcome, ms, ...(bytes === undefined ? {} : { bytes }) });
  };
  trace.write('call', name, describeArgs(args) || '(no arguments)', { phase: 'enter' });

  // Recorded once per connection, because how this server can reach the user
  // depends entirely on it: without elicitation the only way to ask for a
  // CAPTCHA to be solved is the agent's own message plus watching the page.
  if (!capabilitiesLogged) {
    capabilitiesLogged = true;
    audit.record({
      tool: '_client', outcome: 'ok',
      note: `capabilities: ${JSON.stringify(clientCapabilities())}`,
    });
  }

  const local = byName.get(name);
  // Withdrawing a tool from the list is not the same as withdrawing it: an
  // agent can hold a name from an earlier turn or from a brief, and one call
  // through the back door undoes the arm.
  if (local && withheldTools.has(name)) {
    done('refused', 'withheld by BROWSER_MEMORY_WITHOUT');
    return failure(`\`${name}\` is not available in this session.`);
  }
  if (local) {
    if (name === 'procedure_save') {
      // Reviewed and shown as the bytes that will actually be stored and run.
      // Previously the raw argument was reviewed and displayed while a
      // redacted variant was saved, so the user approved one thing and a
      // different thing executed.
      const { text: code } = redactCode(String(args['code'] ?? ''));
      const findings = reviewProcedureCode(code, String(args['origin'] ?? ''));
      const ok = await confirmWithUser(
          `Save procedure "${String(args['name'])}"?`,
          `${String(args['description'] ?? '')}\n\nRuns on ${String(args['origin'])}. ` +
          `Every later agent will be able to call it.\n\n` +
          `${findings.length ? `Static review flagged:\n${explainFindings(findings)}\n\n` : ''}` +
          `--- code ---\n${code}`);
      if (!ok) {
        done('refused', 'user declined');
        return failure('Not saved — the user declined this procedure.');
      }
    }
    try {
      const reply = text(await local.handle(args));
      done('ok', undefined, bodyOf(reply).length);
      return reply;
    } catch (error) {
      done('error', (error as Error).message);
      return failure(`${name} failed: ${(error as Error).message}`);
    }
  }

  if (name === 'browser_unavailable')
    return failure(`Browser server at ${UPSTREAM} is offline.`);

  const procedure = await procedures.find(name).catch(() => undefined);
  if (procedure) {
    // Withheld from the advertised list once broken, but an agent that has the
    // name from a brief or an earlier turn could still call it — and pay for
    // the failure twice, once in the call and once in the detour after it.
    if (!isCallable(procedure)) {
      done('refused', 'broken procedure');
      return failure(
        `\`${procedure.name}\` is marked broken: it failed its last ` +
        `${procedure.consecutiveFailures} runs, most recently on ${procedure.lastRun}. ` +
        `Do the work directly, and if you find the correct version, save it with procedure_save ` +
        `under the same name.`);
    }
    const result = await runProcedure(procedure, args, {
      call: callUpstream,
      recordRun: async (name, ok) => void await procedures.recordRun(name, ok),
    });
    done(result.isError ? 'error' : 'ok', 'procedure');
    return result;
  }

  let result: ToolResult;
  try {
    result = await callUpstream(name, args);
  } catch (error) {
    done('error', 'upstream unreachable');
    return failure(
      `Browser server at ${UPSTREAM} is unreachable: ${(error as Error).message}\n` +
      `Check: systemctl --user status playwright-mcp.service`);
  }
  // Read after every call, not only after a navigation: a click that leaves the
  // site is a navigation too, and used to leave every later observation filed
  // under the previous domain with no brief for the new one.
  const body = bodyOf(result);
  /*
   * The reason, on an upstream failure, rather than the bare word "error".
   *
   * Local tools have always recorded one and upstream ones never did, which
   * made the audit log's failure rows unreadable exactly where the failures
   * are: thirty-nine errors in one measured run, every note empty. The text is
   * in the body — "element is not visible", "Timeout 5000ms exceeded" — and
   * clipped to its first line it is the difference between a list of calls that
   * failed and knowing what a site did.
   */
  done(result.isError ? 'error' : 'ok',
      result.isError ? clipReason(body) : undefined, body.length);
  const { domain: landed, path, title } = currentPageFrom(body);

  /*
   * Below the agent, so what gets learned is what happened rather than what was
   * reported. Never allowed to fail the call it is watching.
   *
   * Before `navigated`, and that order is the whole fix for a class of flow
   * that was never once recorded. A step belongs to the page it was made on,
   * not to the page it led to — and announcing the new page first closes the
   * flow in progress, so the submit click that caused the navigation arrived
   * after its own flow had already been flushed and discarded for having no
   * click in it. type → type → submit, the commonest shape there is and the
   * exact case this module cites, could not survive its own success.
   */
  await observer.saw(name, args, body, Boolean(result.isError), await linkedTree(body)).catch(() => {});

  if (landed) {
    /*
     * Told on every call, not only on a change: leaving a page is what closes
     * the form flow that was in progress on it.
     *
     * And told *how* it got here, which the observer cannot work out and used
     * to assume. An explicit `browser_navigate` is the agent deciding to be
     * somewhere else; a page that changed under a click is a form advancing.
     * Treating both as leaving is what cut every multi-page form into fragments
     * at exactly the joins that made it worth recording.
     */
    await observer.navigated(landed, path,
        name === 'browser_navigate' || name === 'browser_navigate_back' ? 'went' : 'landed');
    places.saw(landed, path, title);
    // The rest of what a navigation means — this path is a page, the site just
    // left has a place map to write out, the new one has traffic worth reading
    // once it settles — belongs to the session's tab, not to this dispatcher.
    await noteNavigation(landed, path);
  }

  /*
   * Only after everything above has read the real body. The tree is what the
   * observer resolves refs against, so withholding it from the agent must not
   * mean withholding it from this gateway — the agent is being told it already
   * has this text, which is true; nothing here has it twice.
   *
   * Measured before it was built: an action on this browser server returns no
   * tree at all, so the only tree anyone pays for is one the agent asked for by
   * name — and 12 of the 15 in the one long session in the audit log were taken
   * with no navigation since the last.
   */
  calls += 1;
  const collapsed = result.isError || without('collapse') ? undefined : collapseRepeat(body, lastTree, calls);
  const tree = treeOf(body);
  const url = urlOf(body);
  // Pinned to the last time the tree was actually sent, not the last time it
  // was recognised. Refreshing it on a collapse would let a run of repeats walk
  // the reach forward indefinitely, until "unchanged since the previous call"
  // meant text the agent last saw fifty calls ago.
  if (tree && url && !collapsed)
    lastTree = { url, tree, at: calls };
  if (collapsed)
    result = { ...result, content: [{ type: 'text', text: collapsed }] };

  /*
   * A brief when the call worked; when it did not, two different things.
   *
   * The diagnosis comes first because it is about *this* failure and is read
   * off what the browser already reported — the call log holds the operative
   * line, under thirteen repetitions of the retry loop, in a block that opens
   * with the word Timeout. The remembered fix comes after, because it is a
   * guess from another session that may or may not apply here.
   *
   * Measured: half the clicks in the long working session failed, each burning
   * the full five-second ceiling, and the agent answered by retrying the same
   * element and then sleeping. That is what this is for.
   */
  const appended = result.isError
    ? await unstickHint(landed || currentDomain(), body).catch(() => undefined)
    : landed ? await memoryNudge(landed).catch(() => undefined) : undefined;
  const why = result.isError && !without('diagnosis') ? explainFailure(body) : undefined;
  const extra = [why, appended].filter(Boolean).join('\n');
  if (extra)
    result = withNote(result, extra);
  return result;
});

await server.connect(new StdioServerTransport());
