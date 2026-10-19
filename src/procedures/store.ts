import { reviewProcedureCode } from './codeReview.ts';
import { today } from '../lib/dates.ts';
import { redactCode } from '../lib/redact.ts';
import { SiteFile } from '../lib/siteFile.ts';
import type { JsonSchema, ParamType, Procedure, ProcedureInput } from '../types.ts';

/**
 * A procedure is the end state of a lesson: once a session has worked out how
 * to do something, that knowledge stops being prose to read and becomes a tool
 * to call. The next agent does not learn the technique — it invokes it.
 *
 * Kept separate from lessons on purpose. A lesson is prose whose worst failure
 * is being unhelpful; a procedure is code that runs against an authenticated
 * browser, so it carries an origin guard, a mutation flag and a pass/fail
 * record, and it earns its place by running successfully.
 */

/**
 * Exported so the draft generator can hold itself to the same rule. It used to
 * cut names at 60 characters against this limit of 49, and a deep path then
 * produced a draft whose `procedure_save` call was rejected the moment anyone
 * copied it — the one path built to lower the barrier to saving, failing
 * exactly on the endpoints deep enough to be worth saving.
 */
export const PROCEDURE_NAME = /^[a-z][a-z0-9_]{2,48}$/;
const NAME = PROCEDURE_NAME;
/** Two failures in a row and it stops being offered — a broken tool is worse than no tool. */
const BROKEN_AFTER = 2;

export class ProcedureStore {
  private readonly _file: SiteFile<Procedure>;
  private readonly _session: string;

  constructor(dir: string, session = 'unknown') {
    this._file = new SiteFile<Procedure>(dir, 'procedures', { lockPrefix: 'proc:', label: 'procedures' });
    this._session = session;
  }

  async forDomain(domain: string): Promise<Procedure[]> {
    return this._file.items(domain);
  }

  /**
   * Every procedure across every domain, which is also what the gateway
   * advertises.
   *
   * The order comes from `SiteFile.domains()`, which sorts. That matters more
   * than it looks: this list becomes the tail of the advertised tool list, and
   * the tool list is the first thing in the cached prefix of every request. Two
   * sessions holding identical procedures that advertised them in different
   * orders would miss the prompt cache on tools, system and messages alike, for
   * no reason anybody could see.
   */
  async all(): Promise<Procedure[]> {
    const out: Procedure[] = [];
    for (const domain of await this._file.domains())
      out.push(...await this.forDomain(domain));
    return out;
  }

  async find(name: string): Promise<Procedure | undefined> {
    return (await this.all()).find(procedure => procedure.name === name);
  }

  async save(domain: string, spec: ProcedureInput): Promise<Procedure> {
    if (!NAME.test(spec.name))
      throw new Error(`name must match ${NAME} — lowercase, starts with a letter, e.g. "hostinger_list_vps".`);
    if (spec.name.startsWith('browser_') || spec.name.startsWith('domain_') || spec.name.startsWith('procedure_'))
      throw new Error('name must not start with browser_, domain_ or procedure_ — those are reserved.');

    const clash = await this.find(spec.name);
    if (clash && clash.domain !== domain)
      throw new Error(`The name "${spec.name}" is already used by a procedure on ${clash.domain}. Pick another.`);

    // Filtered with the code rules, not the prose ones. The prose rule rewrites
    // `name = value` wholesale, which turns `const key = params.key` into
    // `const key = «redacted»` — a procedure saved broken, failing twice, and
    // demoted to broken, with nobody told why.
    const { text: code } = redactCode(spec.code);
    // A cheap first pass, not the defence.
    const findings = reviewProcedureCode(code, spec.origin);

    return this._file.mutate(domain, async () => {
      const procedures = await this.forDomain(domain);
      const existing = procedures.find(procedure => procedure.name === spec.name);
      const next: Procedure = {
        name: spec.name,
        domain,
        origin: spec.origin,
        description: spec.description,
        params: spec.params ?? [],
        code,
        mutating: Boolean(spec.mutating),
        expects: spec.expects ?? '',
        created: existing?.created ?? today(),
        updated: today(),
        lastRun: existing?.lastRun ?? null,
        runs: existing?.runs ?? 0,
        ok: existing?.ok ?? 0,
        failed: existing?.failed ?? 0,
        // A rewrite is a new claim: it has to prove itself again, and it has to
        // be approved again — otherwise "edit an approved procedure" is a way
        // to smuggle code past the one control that actually holds.
        consecutiveFailures: 0,
        status: 'unverified',
        findings,
        by: this._session,
      };
      if (existing)
        Object.assign(existing, next);
      else
        procedures.push(next);
      await this._file.write(domain, procedures);
      return existing ?? next;
    });
  }

  /**
   * Running a procedure is what verifies it. This replaces a scheduled health
   * check: knowledge that has gone stale is discovered by the next agent that
   * relies on it, which is the same moment it would have mattered anyway.
   */
  async recordRun(name: string, ok: boolean): Promise<Procedure | undefined> {
    const procedure = await this.find(name);
    if (!procedure)
      return undefined;
    return this._file.mutate(procedure.domain, async () => {
      const procedures = await this.forDomain(procedure.domain);
      const target = procedures.find(candidate => candidate.name === name);
      if (!target)
        return undefined;
      target.runs += 1;
      target.lastRun = today();
      if (ok) {
        target.ok += 1;
        target.consecutiveFailures = 0;
        target.status = 'verified';
      } else {
        target.failed += 1;
        target.consecutiveFailures += 1;
        if (target.consecutiveFailures >= BROKEN_AFTER)
          target.status = 'broken';
      }
      await this._file.write(procedure.domain, procedures);
      return target;
    });
  }

  async remove(domain: string, name: string): Promise<Procedure | undefined> {
    return this._file.mutate(domain, async () => {
      const procedures = await this.forDomain(domain);
      const index = procedures.findIndex(procedure => procedure.name === name);
      if (index === -1)
        return undefined;
      const [removed] = procedures.splice(index, 1);
      await this._file.write(domain, procedures);
      return removed;
    });
  }
}

const TYPES: Record<ParamType, ParamType> = { string: 'string', number: 'number', boolean: 'boolean' };

/** The JSON Schema the agent sees for a generated tool. */
export function procedureInputSchema(procedure: Procedure): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of procedure.params) {
    properties[param.name] = {
      type: TYPES[param.type] ?? 'string',
      description: param.description ?? '',
    };
    if (param.required)
      required.push(param.name);
  }
  if (procedure.mutating) {
    properties['confirm'] = {
      type: 'boolean',
      description: 'This procedure changes state on the site. Must be true to run it.',
    };
    required.push('confirm');
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/**
 * Callable means not currently broken.
 *
 * There is deliberately no second approval system here. Saving a procedure and
 * calling one are both ordinary MCP tool calls, so the client already asks the
 * user about them under whatever rules they have chosen — and a user running in
 * auto-accept mode has already made that decision once, globally, rather than
 * being asked again by this server in a different way. Two permission systems
 * disagreeing is worse than one the user actually understands.
 */
export function isCallable(procedure: Procedure): boolean {
  return procedure.status !== 'broken';
}

export function procedureDescription(procedure: Procedure): string {
  const flags = procedure.findings.length
    ? `⚠ Static review flagged ${procedure.findings.length} thing(s) in its code: ` +
      `${procedure.findings.map(finding => finding.rule).join(', ')}.`
    : '';
  const trust = procedure.status === 'verified'
    ? `Proven: ${procedure.ok}/${procedure.runs} runs succeeded, last on ${procedure.lastRun}.`
    : procedure.status === 'broken'
      ? `BROKEN: failed the last ${procedure.consecutiveFailures} runs.`
      : 'Not yet verified — recorded but never successfully run through this tool.';
  return [
    procedure.description,
    procedure.expects ? `Returns: ${procedure.expects}` : '',
    `Runs on ${procedure.origin}; navigate there first.`,
    procedure.mutating ? 'CHANGES STATE — requires confirm: true.' : 'Read-only.',
    flags,
    trust,
  ].filter(Boolean).join(' ');
}

/**
 * Arguments are inlined rather than passed, because browser_evaluate calls the
 * function with no arguments. The origin guard and try/catch are what make the
 * result machine-readable, so a failure updates the record instead of looking
 * like a successful call that returned something odd.
 */
export function buildEvaluateFunction(procedure: Procedure, args: Record<string, unknown>): string {
  const params = { ...args };
  delete params['confirm'];
  return `async () => {
  const params = ${JSON.stringify(params)};
  if (location.origin !== ${JSON.stringify(procedure.origin)})
    return { __proc: "wrong-origin", error: "this procedure runs on ${procedure.origin} but the page is on " + location.origin + ". Navigate there first." };

  // Hardening, not a boundary — and scoped, which is the part that matters.
  //
  // These are local bindings that shadow the globals inside this function, so
  // the procedure's own code sees the guarded versions and the page's code
  // never does. The previous version assigned to window.fetch,
  // XMLHttpRequest.prototype.open, navigator.sendBeacon and window.WebSocket on
  // a real, logged-in page: for the life of the procedure every poll, autosave
  // and live connection belonging to the site itself threw "procedure blocked
  // from contacting …". Breaking the user's open Gmail to slow down a payload
  // that can reach a pristine copy through a fresh iframe anyway is a bad
  // trade. Shadowing costs nothing and stops the same naive attempt.
  const sameOrigin = (target) => {
    try { return new URL(target, location.href).origin === location.origin; } catch { return false; }
  };
  const blocked = (target) => { throw new Error("procedure blocked from contacting " + target); };
  const fetch = (input, init) => {
    const target = typeof input === "string" ? input : (input && input.url);
    return sameOrigin(target) ? window.fetch(input, init) : blocked(target);
  };
  const XMLHttpRequest = class extends window.XMLHttpRequest {
    open(method, url, ...rest) {
      return sameOrigin(url) ? super.open(method, url, ...rest) : blocked(url);
    }
  };
  const WebSocket = (url) => blocked(url);
  const navigator = new Proxy(window.navigator, {
    get: (target, key) => {
      if (key === "sendBeacon")
        return (url) => blocked(url);
      const value = Reflect.get(target, key);
      // Bound, or a method called through the proxy loses its receiver.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    const value = await (async () => {
${procedure.code}
    })();
    return { __proc: "ok", value };
  } catch (error) {
    return { __proc: "error", error: String(error && error.message || error) };
  }
}`;
}

export const PROCEDURE_OK = /"__proc":\s*"ok"/;
export const PROCEDURE_ERROR = /"__proc":\s*"error"/;
/**
 * Called on the wrong page. That is the caller's mistake, not evidence about
 * the procedure, and counting it would demote working tools for the one reason
 * that says nothing about whether they work.
 */
export const PROCEDURE_WRONG_ORIGIN = /"__proc":\s*"wrong-origin"/;
