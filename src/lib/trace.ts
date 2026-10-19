import path from 'node:path';

import { JsonlFile } from './jsonl.ts';

/**
 * What the gateway is doing, while it is doing it.
 *
 * The audit log next door answers "what was called". That is the security
 * question, and it is deliberately narrow: one line per tool call, written
 * below the agent so an agent that has been talked into something cannot
 * describe it away. It is not, and must not become, a diagnostic log — diluting
 * the one account of a session that the agent cannot edit is how it stops being
 * evidence.
 *
 * This answers the other question, the one nobody could answer: *why*. Which
 * tools were published this connection and where each came from. What memory
 * was served, and how much. Whether the observer took a step or threw the whole
 * flow away, and on what grounds. Every one of those decisions was already
 * being made on the hot path of every session and none of them left a mark, so
 * the honest description of the product was "it does something".
 *
 * `detail` is a finished English sentence rather than fields to be assembled by
 * a renderer. That is on purpose: `tail -f trace.jsonl` has to be useful with no
 * tooling at all, because the moment you need to build something to read your
 * logs you stop reading them.
 *
 * Written synchronously, like the audit log, for a weaker reason: not because
 * losing the tail would destroy evidence, but because a diagnostic log whose
 * last few lines are missing is misleading in exactly the situation it exists
 * for — the crash. The lines are small and the volume is a few per tool call.
 */

export type TraceKind =
  /** The tool list this connection was given, and where each generated tool came from. */
  | 'list'
  /** A tool call, entering and leaving. */
  | 'call'
  /** Memory handed to the agent: a brief, an interface, a place map. */
  | 'serve'
  /** The observer's decisions — the part that was completely dark. */
  | 'observe'
  /** A confirmation gate: asked, granted, declined, or refused outright. */
  | 'gate'
  /** Talking to the browser server: connecting, and what came back. */
  | 'upstream';

export type TraceEvent = {
  at: string;
  session: string;
  kind: TraceKind;
  /** The subject: a tool name, a domain, a detector. One token, for grouping. */
  what: string;
  /** A readable sentence. This is the field a human actually looks at. */
  detail: string;
  /** Structured extras, for anything that wants to count rather than read. */
  data?: Record<string, unknown>;
};

/** Smaller than the audit log's: these lines are sentences, not arguments. */
const MAX_DETAIL_CHARS = 600;

/** The audit log's ceiling, for the same reason: one record, one write. */
const MAX_LINE_CHARS = 3_500;

export class Trace {
  private readonly _file: JsonlFile;
  private readonly _session: string;

  constructor(dir: string, session: string) {
    this._file = new JsonlFile(path.join(dir, 'trace.jsonl'));
    this._session = session;
  }

  get file(): string {
    return this._file.path;
  }

  write(kind: TraceKind, what: string, detail: string, data?: Record<string, unknown>): void {
    if (this._file.broken)
      return;
    const event: TraceEvent = {
      at: new Date().toISOString(),
      session: this._session,
      kind,
      what,
      detail: detail.length > MAX_DETAIL_CHARS
        ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail,
      ...(data ? { data } : {}),
    };
    let line = JSON.stringify(event);
    if (line.length > MAX_LINE_CHARS)
      line = JSON.stringify({ ...event, data: { dropped: 'too large to record' } });
    // A diagnostic log that cannot be written must never be the reason a
    // session fails.
    this._file.append(line);
  }
}

/** Past this, an argument is described by its size rather than quoted. */
const MAX_VALUE_CHARS = 80;

/**
 * Fields whose value is never shown, by the name of the field or of the control
 * being typed into.
 *
 * The audit log stores arguments unredacted and that is the right call for
 * evidence. This file is different in one way that matters: it is meant to be
 * *watched*, on a screen, possibly while someone else is in the room. A
 * password going past in a live tail is a disclosure the audit log never makes,
 * so the value is dropped here and the fact that there was one is kept.
 */
const SECRET_FIELD = /pass(word|phrase)?|secret|token|otp|\bpin\b|cvv|card|credential|auth|סיסמ/i;

/**
 * A call's arguments on one line, for someone watching them go past.
 *
 * The audit log already stores them properly; this is the reading view, so it
 * optimises for a glance rather than for reconstruction. Long values become
 * their length, arrays become their count, and the whole thing is clipped —
 * a `browser_evaluate` carrying forty lines of JavaScript must not push the
 * next twenty calls off the screen.
 */
export function describeArgs(args: Record<string, unknown>): string {
  // `browser_type` names the control in `element` and carries the value in
  // `text`, so the field that reveals a secret is never the field named for it.
  const intoSecret = SECRET_FIELD.test(String(args['element'] ?? ''));
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null)
      continue;
    if (Array.isArray(value)) {
      parts.push(`${key}=[${value.length}]`);
    } else if (typeof value === 'object') {
      parts.push(`${key}={…}`);
    } else if ((intoSecret && key !== 'element' && key !== 'target') || SECRET_FIELD.test(key)) {
      parts.push(`${key}=«hidden»`);
    } else {
      const text = String(value);
      parts.push(`${key}=${text.length > MAX_VALUE_CHARS
        ? `«${text.length} chars»` : text}`);
    }
  }
  const line = parts.join(' ');
  return line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS)}…` : line;
}

/**
 * A no-op trace, so callers never have to branch.
 *
 * Used by the observer when it is constructed without one — every test builds
 * an Observer directly, and none of them should have to know this exists.
 */
export const silent = {
  write: (): void => {},
} as Pick<Trace, 'write'>;
