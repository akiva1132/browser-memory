/**
 * The one instance of everything, made once and shared.
 *
 * These are process-level singletons — one store, one audit log, one tab claim
 * — and they were declared at the top of the server file, which is the reason
 * no other part of `gateway/` could be its own module: every piece reaches for
 * the same store and the same trace. Naming them here is what lets the brief,
 * the instructions and the dispatcher be separate files.
 *
 * Nothing here decides anything. It is construction, in the order the
 * constructors need.
 */
import path from 'node:path';

import { defaultMemoryDir, defaultOutputDir } from '../lib/roots.ts';
import { MemoryStore } from '../memory/store.ts';
import { ProcedureStore } from '../procedures/store.ts';
import { ApiMap } from '../capture/apiMap.ts';
import { PlaceMap } from '../browser/places.ts';
import { TabRegistry } from '../browser/tabs.ts';
import { AuditLog } from '../lib/audit.ts';
import { Trace } from '../lib/trace.ts';
import { Observer } from '../capture/observe.ts';

export const UPSTREAM = process.env['PLAYWRIGHT_MCP_URL'] || 'http://localhost:8931/mcp';
export const memoryDir = defaultMemoryDir;
export const session = `${process.pid}-${Date.now().toString(36)}`;
export const store = new MemoryStore(memoryDir, session);
export const procedures = new ProcedureStore(path.join(memoryDir, 'procedures'), session);
/** The site's own traffic, folded into a reference nobody had to write. */
export const apiMap = new ApiMap(memoryDir);
/** Where agents actually went, which is the other half of what a repeat visit needs. */
export const places = new PlaceMap(memoryDir, session);
/** Who owns which tab, so a killed session still gives its tab back. */
export const tabs = new TabRegistry(memoryDir, session);
/** Where the upstream drops its per-session snapshots and console logs. */
export const OUTPUT_DIR = defaultOutputDir;


/*
 * There used to be a BROWSER_TOOLS_PROFILE=lean switch here, cutting the
 * advertised surface from 76 tools to 11 and writing snapshots to disk instead
 * of inline. The schema saving was real — 12.9k tokens of tool definitions down
 * to 2.6k — and it still lost, twice, on every axis worth measuring: 82s vs 51s
 * median, $1.42 vs $1.16, and roughly double the output tokens.
 *
 * The reason is that the saving is charged at cache-read rates while the cost
 * is paid in turns: an agent missing a tool works around its absence, and every
 * extra turn re-reads the whole conversation. 13 turns over a small prefix
 * costs more than 10 over a large one. So the surface stays whole.
 */
export const audit = new AuditLog(memoryDir, session);
/**
 * Why, alongside the audit log's what. Kept as a separate file on purpose: the
 * audit log is evidence and must not be diluted with diagnostics.
 * `node scripts/watch.ts` renders this live.
 */
export const trace = new Trace(memoryDir, session);
/**
 * Derives lessons from what the calls actually did, rather than from the agent
 * remembering to write them down — which, measured over a 49-turn session, it
 * did not, while reporting that it had.
 */
export const observer = new Observer(memoryDir, session, trace);

/** Domains already briefed on this connection; the nudge is worth tokens once, not every hop. */
export const briefed = new Set<string>();

/** How long the upstream's snapshot and console files are kept. */
export const OUTPUT_KEEP_DAYS = 7;
