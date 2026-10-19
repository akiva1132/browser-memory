
import { ApiMap } from './apiMap.ts';
import { anchorOf, nameOf, REF_ATTR, SNAPSHOT_NODE } from '../browser/aria.ts';
import type { Anchor } from '../browser/aria.ts';
import { MemoryStore } from '../memory/store.ts';
import { redactText } from '../lib/redact.ts';
import { silent } from '../lib/trace.ts';
import type { Trace } from '../lib/trace.ts';
import type { Kind } from '../types.ts';
import { changedKeys, clip, errorFingerprint } from './evidence.ts';
import { LessonLog, THRESHOLD } from './lessonLog.ts';
import { proveFromEvaluate } from './proveEndpoint.ts';
import type { Candidate } from './lessonLog.ts';
import {
  COMMITTING, fieldsOf, FLOW_TOOLS, formFlow, holeFor, MAX_FLOW_PAGES, MAX_FLOW_STEPS, } from './flow.ts';
import type { Arrival, Step } from './flow.ts';


/**
 * Capture that does not depend on the agent choosing to capture.
 *
 * The measured problem: a 49-turn session across three sites recorded nothing,
 * and reported that it had. Asking an agent to write down what it learned is a
 * request it can forget, skip, or believe it honoured — and the one session that
 * most needed to leave a trail is the one with the least context left to do it.
 *
 * The gateway does not have that problem. It sees every call and every outcome,
 * below the agent's narration, so two kinds of knowledge can be derived from
 * what actually happened rather than from what was claimed:
 *
 *   - an internal endpoint the agent proved works, by fetching it from the page
 *     and getting data back;
 *   - a call that failed and then succeeded once something changed, which is a
 *     fix with its own before-and-after evidence attached.
 *
 * Neither needs a model. Both are the shapes that cost agents the most time.
 *
 * Promotion is gated on recurrence, not on a single sighting, because the point
 * of an observation log is that it spans sessions: something seen twice by two
 * agents is a property of the site, something seen once may be a typo.
 */

/**
 * What a ref looks like — the same test the browser server applies on the way
 * in, where anything failing it is handed to the selector engine instead:
 *
 *   if (!param.target.match(/^(f\d+)?e\d+$/))  →  page.locator(selector)
 *   else                                       →  page.locator(`aria-ref=${target}`)
 *
 * Kept identical on purpose. The first version of this guarded against refs by
 * looking for an `args.ref`, which this server stopped sending: refs now arrive
 * through `target`, alongside genuine selectors. Measured on the real audit log
 * afterwards — 13 of 14 recorded steps were refs being stored as though they
 * were selectors.
 */
const REF = /^(?:f\d+)?e\d+$/;

/** Bounded because a single snapshot of a busy page is thousands of nodes. */
const MAX_REFS = 2000;

/** A failed call held open in case the next success explains it. */
type PendingFailure = {
  domain: string;
  args: Record<string, unknown>;
  error: string;
};

/*
 * `Step` now lives in trajectory.ts, which owns the runnable form of a
 * recording. It used to be declared here and flattened into markdown a few
 * lines later — the structure was computed on every flow and then dropped, so
 * the one artifact an engine could execute was the one thing not kept.
 */

export class Observer {
  /** Where proof of a working endpoint goes, instead of into a lesson of its own. */
  private readonly _map: ApiMap;
  /** Chained so two fetches in one turn cannot race each other's file write. */
  private _proving: Promise<void> = Promise.resolve();
  /**
   * Promotion, off the call the agent is waiting on.
   *
   * Deciding whether an observation has earned a lesson means re-reading the
   * whole log and then taking the domain lock to write one — and `withLock`
   * waits up to fifteen seconds for a lock another agent is holding. All of it
   * used to sit under `await observer.saw(...)`, which is on the path of every
   * single tool call, so bookkeeping could stall the agent's next reply by
   * fifteen seconds while the browser sat idle.
   *
   * What must be synchronous is the *evidence*: the append to the log. That is
   * one line, and it is the record that spans sessions. Everything after it is
   * derived from a file already on disk, so it can be worked out a moment later
   * without being any less true — and if the process dies first, the next
   * session recounts from the same log and reaches the same answer.
   *
   * Chained rather than floating, and drained in `flush`, so writes still
   * cannot race each other and still land before the session ends.
   */
  private readonly _log: LessonLog;
  private _domain = '';
  private _path = '';
  /** Successful UI steps since the agent arrived on this page. */
  private _flow: Step[] = [];
  /** Set when a step of the flow in progress could not be recorded. See `_collectOne`. */
  private _spoiled = false;
  private _flowAt = '';
  /**
   * The pages this flow has crossed, entry first.
   *
   * A flow used to be pinned to one page because `navigated` closed it — so a
   * form spread over three pages produced three recordings, each too short to
   * be kept, and the shape most worth replaying was the one shape that could
   * not be recorded at all.
   */
  private _flowPages: string[] = [];
  /** The last step's tool, which decides whether a page change extends the flow. */
  private _lastStep = '';
  private readonly _pending = new Map<string, PendingFailure>();
  /** ref → what it pointed at, taken from every snapshot that goes past. */
  private readonly _refs = new Map<string, Anchor>();
  private _broken = false;
  /**
   * Where this class explains itself. Every decision below used to be silent,
   * which made the recorder the least understood thing in the product: it runs
   * on every call, writes to the store on its own initiative, and left no
   * account of why it did or did not.
   */
  private readonly _trace: Pick<Trace, 'write'>;

  constructor(dir: string, session: string, trace: Pick<Trace, 'write'> = silent) {
    this._trace = trace;
    // A distinct provenance, so an automatically captured lesson is visibly
    // that when a human reads the file, and so the growth cap can find them.
    this._log = new LessonLog(dir, session, new MemoryStore(dir, `auto:${session}`), trace);
    this._map = new ApiMap(dir);
  }

  /**
   * Everything is attributed to the page the agent is actually on. Leaving a
   * page also closes whatever flow was in progress there — that is the moment
   * the sequence is known to be complete.
   *
   * Except when the page changed because the flow committed it. A multi-page
   * form advances by submitting page one and arriving at page two, and treating
   * that arrival as "the agent left" is what made the recorder single-page:
   * every wizard was cut into fragments at exactly the joins that made it worth
   * recording. Four conditions have to hold before a flow is allowed to
   * continue, and each of them is one way the alternative goes wrong:
   *
   *   - the arrival was not an explicit `browser_navigate`, so it is the page
   *     moving under the agent rather than the agent choosing a destination;
   *   - the last recorded step committed something, so a search box and a read
   *     do not drag the next page into the recording;
   *   - the domain is unchanged, because a click that lands on another site is
   *     a handoff and the flow ends at the boundary;
   *   - and the page count is under the cap, so a heuristic that misfires costs
   *     one stray page instead of the session.
   */
  async navigated(domain: string, path = '', arrival: Arrival = 'went'): Promise<void> {
    const moved = domain !== this._domain || path !== this._path;
    const advanced = moved && arrival === 'landed' && domain === this._domain &&
      this._flow.length > 0 && COMMITTING.has(this._lastStep) &&
      this._flowPages.length < MAX_FLOW_PAGES && !this._flowPages.includes(path);
    if (advanced) {
      this._flowPages.push(path);
      this._trace.write('observe', 'span',
        `The flow on ${domain}${this._flowPages[0]} carried on to ${path} — ` +
        `page ${this._flowPages.length} of at most ${MAX_FLOW_PAGES}, reached by ` +
        `${this._lastStep.replace('browser_', '')}.`,
        { domain, from: this._path, to: path, pages: this._flowPages.length });
    }
    this._domain = domain;
    this._path = path;
    // Awaited rather than left floating: a flush that writes after its caller
    // has moved on is a write nobody can order, and the first version of this
    // recorded the flow only sometimes.
    if (moved && !advanced)
      await this.flush().catch(() => {});
  }

  /**
   * Writes out the flow in progress, if it looks like one. Called when the
   * agent leaves a page and once more when the session ends, so a task that
   * finishes on its last form still leaves the selectors behind.
   */
  async flush(): Promise<void> {
    let steps = this._flow;
    const domain = this._flowAt.split(' ')[0] ?? '';
    const path = this._flowAt.slice(domain.length + 1);
    const spoiled = this._spoiled;
    const pages = this._flowPages;
    this._flow = [];
    this._flowAt = '';
    this._spoiled = false;
    this._flowPages = [];
    this._lastStep = '';

    /*
     * A page the flow only clicked through is not part of the form.
     *
     * Letting a flow cross pages buys the wizard and costs this: fill, fill,
     * submit, land on the receipt — and then whatever the agent does next on
     * that receipt is inside the recording, because the flow is still open.
     * Three clicks reading an order confirmation become three clicks replayed
     * *after* the payment goes through.
     *
     * So the tail is trimmed back to the last page that had a value entered on
     * it. The entry page is never trimmed; it is the flow. What survives for an
     * ordinary fill-fill-submit is exactly the recording that shape produced
     * before any of this existed, which is the property the capture test pins.
     */
    const pageOf = (step: Step): string => step.page ?? pages[0] ?? '';
    while (pages.length > 1) {
      const last = pages[pages.length - 1]!;
      if (steps.some(step => pageOf(step) === last && step.fills))
        break;
      const dropped = steps.filter(step => pageOf(step) === last).length;
      steps = steps.filter(step => pageOf(step) !== last);
      pages.pop();
      this._trace.write('observe', 'trim',
        `Nothing was entered on ${last}, so it is where the flow ended rather than part of it — ` +
        `dropped ${dropped} step(s) taken there.`,
        { domain, page: last, dropped });
    }
    // A flow is filling something in and then committing it. Poking at a page
    // — three clicks and no input — is exploration, and its selectors say
    // nothing about how the site is used.
    const filled = steps.filter(step => step.tool !== 'browser_click').length;
    const committed = steps.some(step => step.tool === 'browser_click');
    /*
     * Why, in the same breath as the decision.
     *
     * Five conditions, any one of which silently discards a flow — and the
     * product went a week with zero recordings while every one of them looked
     * equally plausible as the culprit. Naming the failed condition at the
     * moment it fails is the difference between that week and a glance.
     */
    const refused = !domain ? 'no page was open'
      : this._broken ? 'the observer had already failed a write'
      : spoiled ? 'a step could not be written down, which spoils the whole flow'
      : steps.length < 3 ? `only ${steps.length} step(s), and a flow needs 3`
      : filled < 2 ? `only ${filled} step(s) entered a value, and a flow needs 2`
      : !committed ? 'nothing was clicked, so nothing was committed — this was exploration'
      : undefined;
    if (steps.length || domain) {
      this._trace.write('observe', 'flow', refused
        ? `Discarded the ${steps.length}-step flow on ${domain}${path}: ${refused}.`
        : `Recording a ${steps.length}-step flow on ${domain}${path}` +
          `${pages.length > 1 ? ` across ${pages.length} pages (${pages.join(' → ')})` : ''} — ` +
          `${steps.filter(step => step.anchored).length}/${steps.length} anchored, ` +
          `${steps.filter(step => step.fills).length} parameter(s).`,
        { domain, path, pages, steps: steps.length, filled, committed, spoiled,
          ...(refused ? { refused } : {}) });
    }
    if (!this._broken && !spoiled && domain && steps.length >= 3 && filled >= 2 && committed) {
      try {
        await this._log.record(formFlow(domain, path, steps, pages));
      } catch {
        this._broken = true;
      }
    }

    /*
     * Drained last, and that ordering is the whole of it.
     *
     * Promotions run off the agent's call — see `_writing` — so this is where
     * a deferred write stops being allowed to be late: the session may be
     * ending, and a lesson that lands after the process exits lands nowhere.
     *
     * Draining first instead looks equivalent and is not. `flush` records the
     * flow it just closed, so the queue gains an entry *after* the drain and
     * nothing settles it until some later flush that may never come. The
     * growth-cap test caught it as one lesson too many: each session was
     * writing its predecessor's flow, so the count the cap checks was always a
     * session behind what was on disk.
     */
    await this._log.settled();
  }

  /**
   * One tool call, as it happened. Errors here are swallowed on purpose:
   * capture is a side effect of the agent's task and must never be able to fail
   * that task.
   */
  /**
   * @param tree the accessibility tree behind this reply, when the reply only
   *   linked to it. Only `browser_snapshot` carries one inline; `navigate` and
   *   `click` answer with a file path, and the agent reads that file itself —
   *   so without this the refs it then acts on were never seen here, and 80% of
   *   flow targets are refs.
   */
  async saw(
    tool: string, args: Record<string, unknown>, body: string, isError: boolean, tree?: string,
  ): Promise<void> {
    const domain = this._domain;
    // Resolved against the snapshots that came before this call, then this
    // call's own snapshot is folded in — in that order, deliberately. A click
    // that changes the page comes back with a tree in which the ref just used
    // may already mean something else, and reading it from there would record
    // the element the agent landed on instead of the one it acted on.
    if (!this._broken && domain && !isError)
      await this._collectStep(domain, tool, args).catch(() => {});
    // Indexed whether or not anything can be attributed yet: the first snapshot
    // of a session arrives before any page has been established, and the refs
    // in it are the ones the agent is about to use.
    this._indexRefs(tree ? `${body}\n${tree}` : body);
    if (this._broken || !domain)
      return;
    try {
      for (const candidate of this._repair(domain, tool, args, body, isError))
        await this._log.record(candidate);
      // A successful call may also have proved an endpoint. Queued rather than
      // awaited inline so two fetches in one turn cannot race each other's
      // write, then settled here — a write left in flight lands only sometimes,
      // and its own failure is swallowed because capture must never fail the
      // call it is watching.
      if (!isError) {
        const proof = proveFromEvaluate(this._map, domain, tool, args, body);
        if (proof)
          this._proving = this._proving.then(() => proof).catch(() => {});
      }
      await this._proving;
    } catch {
      // One malformed call must not stop the observer for the rest of the run,
      // but a broken log should stop retrying rather than throw on every call.
      this._broken = true;
    }
  }

  /**
   * Every ref the browser has shown us, and what it pointed at.
   *
   * Never cleared, only bounded, and the same ref seen again overwrites the
   * older meaning. Ids are handed out per snapshot and reused across pages, so
   * a stale entry could in principle name the wrong element — except that this
   * is only ever read for a step that *succeeded*, and a ref the browser
   * accepted was one it found in the page's live snapshot. Whatever we hold for
   * it came from that same snapshot, because it is the most recent one we saw.
   */
  private _indexRefs(body: string): void {
    if (!body.includes('[ref=')) {
      // Silence here is what a whole week of zero recordings looked like: every
      // ref the agent then acted on was one this class had never been shown.
      this._trace.write('observe', 'refs',
        'No accessibility tree in this reply — any ref used next will be unexplained.');
      return;
    }
    const before = this._refs.size;
    for (const line of body.split('\n')) {
      const node = SNAPSHOT_NODE.exec(line);
      const ref = node && REF_ATTR.exec(node[3] ?? '')?.[1];
      if (!node || !ref)
        continue;
      this._refs.delete(ref);
      this._refs.set(ref, { role: node[1] ?? '', name: nameOf(node) });
    }
    for (const stale of this._refs.keys()) {
      if (this._refs.size <= MAX_REFS)
        break;
      this._refs.delete(stale);
    }
    this._trace.write('observe', 'refs',
      `Indexed the accessibility tree: ${this._refs.size} refs known ` +
      `(${this._refs.size - before >= 0 ? '+' : ''}${this._refs.size - before}).`,
      { known: this._refs.size, added: this._refs.size - before });
  }

  /**
   * Remembers a successful UI step, keeping only the reusable half.
   *
   * A ref is a handle into one snapshot of one page in one session: the id
   * itself is worth nothing next time, and storing it is worse than storing
   * nothing, because next session it resolves to whatever now sits in that
   * slot and the agent clicks it. What it pointed *at* is worth everything, and
   * the snapshot the agent read it from has already gone past this class — so
   * it is turned here into the (role, accessible name) pair the browser will
   * still accept after the page is redesigned.
   *
   * A ref that cannot be resolved is dropped rather than recorded. A CSS
   * selector is kept: the agent wrote it deliberately and it is at least a
   * claim about the site, but it is marked, because it is tied to how the page
   * is built rather than to what the element is.
   */
  private async _collectStep(
    domain: string, tool: string, args: Record<string, unknown>,
  ): Promise<void> {
    const parts = tool === 'browser_fill_form' ? fieldsOf(args) : [{ tool, args }];
    if (!parts.length)
      return;
    for (const part of parts)
      await this._collectOne(domain, part.tool, part.args);
  }

  private async _collectOne(
    domain: string, tool: string, args: Record<string, unknown>,
  ): Promise<void> {
    if (!FLOW_TOOLS.has(tool))
      return;
    const target = typeof args['target'] === 'string' ? args['target'].trim() : '';
    const anchor = target && REF.test(target) ? anchorOf(this._refs.get(target)) : undefined;
    /*
     * A step that cannot be written down spoils the whole recording, rather
     * than shortening it.
     *
     * Both ways of failing to record a step used to return quietly and leave
     * the rest of the flow in place. A sequence with a hole in it is not a
     * shorter sequence, it is a different one — and this one gets replayed.
     * Measured on the real audit log: `browser_file_upload` carries only
     * `paths` and no target at all, twelve times, so "click Attach → choose the
     * file → click Send" was recorded as "click Attach → click Send". Replaying
     * that opens a file picker and then submits the form behind it with nothing
     * attached.
     *
     * `browser_press_key` has the same shape (three sightings, `{key}` alone),
     * and so does a ref that arrived without the snapshot explaining it.
     */
    if (!target || (REF.test(target) && !anchor)) {
      this._spoiled = true;
      this._trace.write('observe', 'spoil', !target
        ? `${tool} carried no target at all, so the flow on ${domain} is spoiled.`
        : `${tool} used ref ${target}, which no snapshot seen here explains — ` +
          `the flow on ${domain} is spoiled.`,
        { tool, target, reason: target ? 'unexplained-ref' : 'no-target' });
      return;
    }
    /*
     * The flow belongs to where it started, not to where it currently is.
     *
     * This used to compare `domain path` against the current page and flush on
     * any difference, which was the second place a multi-page form was cut in
     * half: `navigated` could decide the flow carried on, and then the first
     * step on the new page ended it anyway. Now only a change of site closes a
     * flow here — a page change is `navigated`'s decision, made with the one
     * fact this method does not have, which is why the page changed.
     */
    if (this._flowAt && this._flowAt.split(' ')[0] !== domain)
      await this.flush();
    if (!this._flowAt) {
      this._flowAt = `${domain} ${this._path}`;
      this._flowPages = [this._path];
    }
    this._lastStep = tool;
    if (this._flow.length >= MAX_FLOW_STEPS)
      return;
    const element = typeof args['element'] === 'string' ? clip(args['element'], 60) : '';
    // What was typed stays discarded — that value is somebody's errand. What is
    // kept now is that a value belonged here at all, named after the field's own
    // label, which is site knowledge like every other field on this step.
    // Without it a recording can only be replayed with the one set of values it
    // was made with, which is to say not replayed.
    const fills = holeFor(tool, args, element);
    const step = {
      tool,
      element,
      target: clip(redactText(anchor ?? target).text, 200),
      anchored: Boolean(anchor),
      ...(fills ? { fills } : {}),
      // Only where it says something. See `Step.page`.
      ...(this._path === this._flowPages[0] ? {} : { page: this._path }),
    };
    this._flow.push(step);
    this._trace.write('observe', 'step',
      `Step ${this._flow.length} on ${domain}${this._path}: ${tool.replace('browser_', '')} ` +
      `${element || '(unlabelled)'} → ${step.target}` +
      `${step.anchored ? '' : ' (CSS selector — tied to the layout, not the element)'}` +
      `${fills ? `, holding a value named "${fills}"` : ''}.`,
      { tool, element, target: step.target, anchored: step.anchored, ...(fills ? { fills } : {}) });
  }

  /**
   * An endpoint the agent fetched from the page and got data back from. This is
   * the single highest-value thing to capture: it is what turns a thirty-page
   * click-through into two calls, and the agent has already proved it works.
   */
  /**
   * A call that failed and then succeeded once something changed. The changed
   * argument is the lesson, and it comes with both halves of the evidence —
   * which is exactly the shape an agent needs when it hits the same wall.
   */
  private _repair(
    domain: string, tool: string, args: Record<string, unknown>, body: string, isError: boolean,
  ): Candidate[] {
    if (!tool.startsWith('browser_'))
      return [];
    if (isError) {
      this._pending.set(tool, { domain, args, error: body });
      return [];
    }
    const failure = this._pending.get(tool);
    this._pending.delete(tool);
    if (!failure || failure.domain !== domain)
      return [];
    const changed = changedKeys(failure.args, args);
    if (!changed.length)
      return [];

    const fingerprint = errorFingerprint(failure.error);
    const subject = changed.join(', ');
    return [{
      domain,
      detector: 'repair',
      signature: `${tool}|${subject}|${clip(fingerprint, 80)}`,
      kind: 'fix' as Kind,
      title: `${tool} on ${domain} fails until ${subject} is right`,
      gist: `${tool} failed here, then succeeded after changing ${subject}. The error was: ` +
        `${clip(redactText(failure.error).text, 160)}`,
      body: `Observed by the gateway across ${THRESHOLD.repair} sessions.\n\n` +
        `**Failed with:** \`${clip(redactText(JSON.stringify(failure.args)).text, 300)}\`\n\n` +
        `**Error:** ${clip(redactText(failure.error).text, 300)}\n\n` +
        `**Then worked with:** \`${clip(redactText(JSON.stringify(args)).text, 300)}\`\n\n` +
        `The difference is ${subject}. Start from the working form.`,
      snippet: clip(redactText(JSON.stringify(args, null, 2)).text, 400),
      trigger: clip(fingerprint, 120),
      tags: ['auto', 'repair'],
    }];
  }
}
