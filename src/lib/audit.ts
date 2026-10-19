import path from 'node:path';

import { JsonlFile } from './jsonl.ts';

/**
 * Every tool call, recorded by the gateway rather than by the agent.
 *
 * The distinction is the entire point: an agent that has been talked into
 * something by a web page will also narrate that something innocently. A log
 * the agent writes is a log the attacker writes. The gateway sits below the
 * agent and sees the calls as they actually happen, so this is the one account
 * of a session that survives the agent being wrong.
 *
 * Append-only JSONL, written synchronously — a crash mid-task must not be the
 * reason the record of that task is missing.
 */

export type AuditEvent = {
  at: string;
  session: string;
  tool: string;
  /** Trimmed: enough to reconstruct intent, not enough to become a second copy of the data. */
  args?: unknown;
  outcome: 'ok' | 'error' | 'refused';
  ms?: number;
  /**
   * How much text the agent got back.
   *
   * Recorded because latency is the cheaper half of what a call costs. A reply
   * is paid once in the turn that asks for it and again in every turn after,
   * since the whole conversation is re-read each time — so a large snapshot is
   * a recurring charge, and until this was here the size of that charge was
   * nobody's measurement.
   */
  bytes?: number;
  note?: string;
};

const MAX_ARG_CHARS = 800;

/**
 * Comfortably inside the 4KB the kernel writes without splitting, so one record
 * is one write however many arguments a call carries.
 */
const MAX_LINE_CHARS = 3_500;

/** Long strings are truncated rather than dropped: a snippet's shape matters, its bulk does not. */
function summarize(value: unknown): unknown {
  if (typeof value === 'string')
    return value.length > MAX_ARG_CHARS ? `${value.slice(0, MAX_ARG_CHARS)}…[${value.length} chars]` : value;
  if (Array.isArray(value))
    return value.slice(0, 20).map(summarize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[key] = summarize(item);
    return out;
  }
  return value;
}

export class AuditLog {
  private readonly _file: JsonlFile;
  private readonly _session: string;

  constructor(dir: string, session: string) {
    this._file = new JsonlFile(path.join(dir, 'audit.jsonl'));
    this._session = session;
  }

  record(event: Omit<AuditEvent, 'at' | 'session'>): void {
    if (this._file.broken)
      return;
    const write = (args: unknown): string => JSON.stringify({
      at: new Date().toISOString(),
      session: this._session,
      ...event,
      ...(args === undefined ? {} : { args }),
    });
    let line = write(event.args === undefined ? undefined : summarize(event.args));
    /*
     * One record, one write, and small enough that the kernel keeps it that
     * way. Every gateway on the machine appends to this same file, and while
     * each field is already clipped, an object with many clipped fields is not
     * — a call with a dozen long arguments could produce a line big enough to
     * be split, and a split line is two corrupt ones in the only account of a
     * session the agent cannot edit.
     */
    if (line.length > MAX_LINE_CHARS)
      line = write(`«${String(line.length)} chars of arguments, too large to record»`);
    // A broken log must never take the session down with it: `append` latches
    // rather than throws, and nothing is retried after the first failure.
    this._file.append(line);
  }
}
