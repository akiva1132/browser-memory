import type { z } from 'zod';

/** Ordered by how much time each saves an agent starting cold; ranking leans on the order. */
export const KINDS = ['fast-path', 'recipe', 'fix', 'dead-end', 'auth', 'landmark', 'fact'] as const;
export type Kind = (typeof KINDS)[number];

/**
 * Lessons that hold on sites nobody has visited yet. Underscore-prefixed so it
 * can never collide with a real hostname.
 */
export const GLOBAL_SCOPE = '_global';

/**
 * Facts about this machine rather than about the web: where the browser puts
 * downloads, which directory an upload has to be staged in, what this install
 * is allowed to reach.
 *
 * Separate from `_global` because the two are true in different ways. A global
 * lesson is knowledge that transfers to a site nobody has visited yet — "check
 * the network tab before driving the UI" is worth reading on any dashboard. A
 * path on this disk is not knowledge about any site at all, and an agent
 * arriving at an unfamiliar domain was being handed it in the briefing as
 * though it were.
 *
 * The store held three global lessons and one of them was already this, which
 * is small enough not to hurt and is exactly the mechanism that produces a
 * landfill at scale: every environment quirk anyone records lands in the recall
 * path for every site forever. These are surfaced once, in the server's own
 * instructions, where installation facts belong.
 */
export const ENV_SCOPE = '_env';

/**
 * Recorded when a lesson stops being true, as opposed to never having been true.
 *
 * The two failure modes look identical to `domain_report` and are not: a fix
 * that was always wrong is noise, but "the metrics screen lived at /servers
 * until March" is navigation knowledge in its own right — it tells the next
 * agent which of two plausible routes is the dead one, and it is exactly what
 * deleting the lesson throws away along with the mistake.
 */
export type Invalidation = {
  /** The day it was marked superseded, which is the "this held until" date. */
  at: string;
  /** The session that marked it; cross-references audit.jsonl the way `by` does. */
  by?: string;
  /** What replaced it, or why it stopped holding. The part a reader actually needs. */
  note?: string;
};

/** A single thing an earlier agent learned about a site. */
export type Lesson = {
  id: string;
  kind: Kind;
  title: string;
  gist: string;
  body: string;
  snippet: string;
  trigger: string;
  tags: string[];
  created: string;
  updated: string;
  /** Last date the lesson was confirmed to still hold. */
  verified: string;
  confirmed: number;
  failed: number;
  used: number;
  /**
   * Which gateway session wrote it. Pairs with audit.jsonl: given a lesson that
   * turns out to be wrong or planted, this is what lets you find the session
   * that produced it and see everything else that session did.
   */
  by?: string;
  /**
   * Present only on a lesson that has been superseded. Absent is the normal
   * state and the on-disk default, so files written before this field existed
   * load as live lessons without a migration.
   */
  invalidated?: Invalidation;
};

/** A lesson as returned by a lookup, annotated with where it came from. */
export type SourcedLesson = Lesson & {
  source: string;
  /** True when it came from the global scope rather than this domain or a parent. */
  global?: boolean;
};

export type LessonInput = {
  kind: Kind;
  title: string;
  gist: string;
  body?: string;
  snippet?: string;
  trigger?: string;
  tags?: string[];
};

export type RememberResult = {
  action: 'created' | 'updated' | 'confirmed';
  entry: Lesson;
  redacted: number;
};

export type TrustStatus = 'active' | 'stale' | 'disputed';

export type Trust = {
  score: number;
  /** Days since last verification. */
  age: number;
  stale: boolean;
  status: TrustStatus;
};

export type DomainSummary = {
  domain: string;
  count: number;
  kinds: Kind[];
  used: number;
  disputed: number;
  updated: string | undefined;
};

export type ParamType = 'string' | 'number' | 'boolean';

export type ProcedureParam = {
  name: string;
  type: ParamType;
  description?: string;
  required?: boolean;
};

export type ProcedureStatus = 'unverified' | 'verified' | 'broken';

/** A static-review finding recorded against a procedure at save time. */
export type ReviewFinding = {
  rule: string;
  why: string;
  evidence: string;
};

/**
 * A capability discovered by an agent and promoted to a callable tool. Unlike a
 * lesson it executes, so it carries an origin guard, a mutation flag and a
 * pass/fail record.
 */
export type Procedure = {
  name: string;
  domain: string;
  origin: string;
  description: string;
  params: ProcedureParam[];
  code: string;
  mutating: boolean;
  expects: string;
  created: string;
  updated: string;
  lastRun: string | null;
  runs: number;
  ok: number;
  failed: number;
  consecutiveFailures: number;
  status: ProcedureStatus;
  /** What the static review flagged when it was saved, surfaced wherever it is listed. */
  findings: ReviewFinding[];
  /** The gateway session that proposed it; cross-references audit.jsonl. */
  by?: string;
};

export type ProcedureInput = {
  name: string;
  origin: string;
  description: string;
  code: string;
  params?: ProcedureParam[];
  expects?: string;
  mutating?: boolean;
};

/** JSON Schema as advertised to an MCP client. Loose on purpose — the SDK validates. */
export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

/**
 * A tool the gateway serves itself, as data, so memory and browser tools can be
 * advertised from a single endpoint without a second server.
 */
export type LocalTool = {
  name: string;
  title: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  /** `signal` aborts when the client cancels the call (Claude Code does, when a message arrives mid-call). */
  handle: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
};
