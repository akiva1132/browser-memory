
import { SiteFile } from '../lib/siteFile.ts';
import { redactEntry } from '../lib/redact.ts';
import { ENV_SCOPE, GLOBAL_SCOPE, KINDS } from '../types.ts';
import { daysSince, today } from '../lib/dates.ts';
import type {
  DomainSummary, Kind, Lesson, LessonInput, RememberResult, SourcedLesson, Trust,
} from '../types.ts';

export { ENV_SCOPE, GLOBAL_SCOPE, KINDS };
export type { Kind, Lesson, SourcedLesson };
export type { Invalidation } from '../types.ts';

export const KIND_HELP: Record<Kind, string> = {
  'fast-path': 'a snippet that gets the data directly (internal API, fetch) instead of driving the UI',
  'recipe': 'the ordered steps that achieved a goal, so the next agent replays instead of re-deriving',
  'fix': 'a symptom the agent will actually observe, paired with what resolves it',
  'dead-end': 'something that looks like it should work but does not — the wrong turn nobody documents',
  'auth': 'how sessions, logins and tokens behave on this site',
  'landmark': 'selectors, routes and URLs that stay stable',
  'fact': 'durable knowledge that prevents a wrong assumption',
};

/** Days after which an unverified lesson is announced as stale rather than trusted. */
const STALE_AFTER_DAYS = 45;

/** Domains become filenames, so anything outside this set is a bug, not a site. */
const SAFE_DOMAIN = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * The memory directory holds both lesson files and the system's own records,
 * side by side. `normalizeDomain('tabs')` used to return `tabs`, so a single
 * `domain_remember({url: 'tabs'})` would overwrite `tabs.json` with lessons —
 * silently destroying the record of which session owns which browser tab, after
 * which no orphaned tab is ever closed again. `domain_forget` on the last entry
 * deletes the file outright.
 *
 * Underscore-prefixed like GLOBAL_SCOPE would have avoided this; renaming files
 * that already exist on disk is worse than refusing four words.
 */
export const RESERVED_NAMES = new Set(['tabs', 'audit', 'observations', 'api', 'procedures']);

export function normalizeDomain(input: string): string {
  if (!input || typeof input !== 'string')
    throw new Error('Expected a URL or domain.');
  let value = input.trim();
  // "*" is how an agent asks for knowledge that is not tied to one site.
  if (value === '*' || value === GLOBAL_SCOPE)
    return GLOBAL_SCOPE;
  // Machine facts, kept out of every site's briefing on purpose.
  if (value === ENV_SCOPE || value.toLowerCase() === 'env')
    return ENV_SCOPE;
  if (RESERVED_NAMES.has(value.toLowerCase())) {
    throw new Error(
        `"${input}" is reserved for this system's own records, not a site. ` +
        `Pass a real URL or domain.`);
  }
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      throw new Error(`Could not parse "${input}" as a URL.`);
    }
  }
  value = value.toLowerCase().split('/')[0]!.split(':')[0]!.replace(/^www\./, '');
  if (!SAFE_DOMAIN.test(value))
    throw new Error(`"${input}" does not look like a domain.`);
  return value;
}

/**
 * hpanel.hostinger.com -> [hpanel.hostinger.com, hostinger.com]
 * A lesson about how login works belongs on the apex and should surface for
 * every subdomain without being written five times. Two-label public suffixes
 * (co.uk) over-generalize by one level, which is harmless here.
 */
export function domainChain(domain: string): string[] {
  if (domain === GLOBAL_SCOPE || domain === ENV_SCOPE)
    return [domain];
  const labels = domain.split('.');
  const chain: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++)
    chain.push(labels.slice(i).join('.'));
  return chain;
}

export function slugify(text: string): string {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
}

/**
 * One list, shared with curation. There were two, and they disagreed — which
 * meant "the same words" meant two different things depending on which part of
 * the system asked.
 */
const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is',
  'it', 'this', 'that', 'with', 'from', 'how', 'i', 'we', 'my', 'get', 'page', 'site', 'browser',
  'you', 'your', 'are', 'be', 'as', 'at', 'by', 'not', 'but', 'if', 'then', 'when', 'which',
  'use', 'used', 'using']);

/**
 * Case boundaries are separators, and lowercasing first destroyed them.
 *
 * The vocabulary agents actually record is compound identifiers, and matching
 * `[a-z0-9]{2,}` against already-lowercased text turned `getVpsList` into the
 * single token `getvpslist`. A goal of "list the vps instances" then overlapped
 * it by zero words, so the lesson that answered the goal scored below one that
 * had nothing to do with it — the kind bonus was the only thing deciding. The
 * seams are recovered here instead, before the case is thrown away.
 *
 * The compound survives alongside its parts because a goal that names
 * `getVpsList` verbatim is the strongest signal available and must not be
 * traded away for the looser match. Slashes and dots never needed this: they
 * are outside the character class and have always split.
 *
 * Exported because curation had its own copy that did neither of those things.
 * Two tokenizers is two answers to "are these the same words": `getVpsList`
 * matched `get vps list` when ranking a brief and did not when deciding whether
 * two lessons say the same thing, so the near-duplicate that pass exists to
 * find was invisible to it.
 */
export function tokenize(text: string | undefined): string[] {
  const words: string[] = [];
  for (const raw of String(text ?? '').match(/[A-Za-z0-9]{2,}/g) ?? []) {
    // Two boundaries, because acronyms run the two conventions together:
    // `getVpsList` breaks after a lowercase, `VPSMetrics` before the tail of an
    // uppercase run. Applying only the first leaves `vpsmetrics` whole.
    const split = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ');
    for (const word of split.length > 1 ? [raw, ...split] : [raw]) {
      const lower = word.toLowerCase();
      if (lower.length >= 2 && !STOPWORDS.has(lower))
        words.push(lower);
    }
  }
  return words;
}

/**
 * Evidence, not vibes. Two failures outweigh a confirmation because a lesson
 * that misfires costs an agent more than a missing lesson does.
 */
export function trust(entry: Lesson): Trust {
  const score = entry.confirmed - 2 * entry.failed;
  const age = daysSince(entry.verified);
  const stale = age > STALE_AFTER_DAYS;
  if (entry.failed >= 2 && entry.failed >= entry.confirmed)
    return { score, age, stale, status: 'disputed' };
  return { score, age, stale, status: stale ? 'stale' : 'active' };
}

export function trustLabel(entry: Lesson): string {
  const { score, age, status } = trust(entry);
  const parts: string[] = [];
  if (entry.confirmed > 1)
    parts.push(`worked ${entry.confirmed}×`);
  if (entry.failed)
    parts.push(`failed ${entry.failed}×`);
  parts.push(`verified ${age === 0 ? 'today' : `${age}d ago`}`);
  // Announced ahead of everything else, and with the date and note spelled out,
  // because "this was true until then" is the whole reason the entry was kept
  // instead of deleted. A reader who reaches a superseded lesson at all wants
  // the date first and the confidence history second.
  if (entry.invalidated) {
    const { at, note } = entry.invalidated;
    return `⛔ SUPERSEDED — held until ${at}${note ? `: ${note}` : ''} (${parts.join(', ')}) — do not act on it`;
  }
  if (status === 'disputed')
    return `⚠ DISPUTED (${parts.join(', ')}) — treat as a hypothesis, verify before acting`;
  if (status === 'stale')
    return `⚠ STALE (${parts.join(', ')}) — site may have changed since`;
  return `${parts.join(', ')}${score >= 3 ? ', reliable' : ''}`;
}

/**
 * Where the previous version of a corrected lesson goes.
 *
 * Slug-shaped so `domain_open` and `domain_forget` can address it: an id nobody
 * can type is a record nobody can read or prune.
 */
const SUPERSEDED = '-superseded';

/**
 * Keeps the claim a correction just replaced, instead of overwriting it away.
 *
 * `invalidate` existed, was tested, and no path in the product could reach it —
 * while the one thing that retires a claim, `domain_remember` under an existing
 * title, destroyed the old text in place. That is the case the whole mechanism
 * was built for: "the metrics screen lived at /servers until March" is
 * navigation knowledge, and it is exactly what an in-place overwrite throws
 * away along with the mistake.
 *
 * Asking an agent to mark it instead would be a second tool and a decision, and
 * the measured result of asking is that it mostly does not happen —
 * `procedure_save` was called zero times across three runs. Correcting a lesson
 * already goes through here, so the record is taken here, off a comparison the
 * method was making anyway.
 *
 * One generation, replaced rather than accumulated, for the same reason the
 * logs keep one: enough to answer "what did this say before", bounded enough
 * that nobody has to think about a store that grows on every correction.
 */
function retire(entries: Lesson[], previous: Lesson, replacement: string, session: string): void {
  const id = `${previous.id}${SUPERSEDED}`;
  const record: Lesson = {
    ...previous,
    id,
    tags: [...previous.tags],
    invalidated: { at: today(), by: session, note: `replaced by: ${replacement}` },
  };
  const at = entries.findIndex(entry => entry.id === id);
  if (at === -1)
    entries.push(record);
  else
    entries[at] = record;
}

function newEntry(fields: LessonInput): Lesson {
  return {
    id: slugify(fields.title),
    kind: fields.kind,
    title: fields.title,
    gist: fields.gist,
    body: fields.body ?? '',
    snippet: fields.snippet ?? '',
    trigger: fields.trigger ?? '',
    tags: fields.tags ?? [],
    created: today(),
    updated: today(),
    verified: today(),
    confirmed: 1,
    failed: 0,
    used: 0,
  };
}

export class MemoryStore {
  private readonly _file: SiteFile<Lesson>;
  private readonly _session: string;

  constructor(dir: string, session = 'unknown') {
    this._file = new SiteFile<Lesson>(dir, 'entries', { label: 'memory' });
    this._session = session;
  }

  async entries(domain: string): Promise<Lesson[]> {
    return this._file.items(domain);
  }

  /** The day a curation pass last ran here, or null if none ever has. */
  async curatedAt(domain: string): Promise<string | null> {
    const { meta } = await this._file.read(domain);
    return typeof meta['curated'] === 'string' ? meta['curated'] : null;
  }

  async markCurated(domain: string): Promise<void> {
    await this._file.mutate(domain, async () => {
      await this._write(domain, await this.entries(domain), { curated: today() });
    });
  }

  /**
   * Ordered by kind, then title: the file is read by people as well as by this
   * program, and a diff of it should show what changed rather than what moved.
   */
  private async _write(domain: string, entries: Lesson[], extra?: { curated?: string }): Promise<void> {
    const { meta } = await this._file.read(domain);
    // Broken by id as well as by title: a retired copy carries the same kind
    // and title as the entry that replaced it, so without the last term their
    // order is whatever `sort` happened to do and the diff shows movement on
    // every write.
    const ordered = [...entries].sort(
        (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
          a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    await this._file.write(domain, ordered, {
      // Preserved across every ordinary write, so a curation pass is not undone
      // by the next lesson anyone records.
      ...(meta['curated'] ? { curated: meta['curated'] } : {}),
      ...extra,
    });
  }

  /** Upsert by slugified title, so re-learning a lesson sharpens it instead of duplicating it. */
  async remember(domain: string, rawFields: LessonInput): Promise<RememberResult> {
    if (!KINDS.includes(rawFields.kind))
      throw new Error(`kind must be one of: ${KINDS.join(', ')}`);
    // Strip credentials before anything touches disk, not after.
    const { fields, redacted } = redactEntry(rawFields);
    const id = slugify(fields.title);
    if (!id)
      throw new Error('title must contain at least one alphanumeric character.');

    return this._file.mutate(domain, async () => {
      const entries = await this.entries(domain);
      const existing = entries.find(entry => entry.id === id);
      if (!existing) {
        const entry = { ...newEntry(fields), by: this._session };
        entries.push(entry);
        await this._write(domain, entries);
        return { action: 'created' as const, entry, redacted };
      }

      const unchanged = existing.body.trim() === (fields.body ?? '').trim() &&
          existing.snippet.trim() === (fields.snippet ?? '').trim();
      // A correction retires what it corrects. Not when the entry is already a
      // retired copy — that would retire the record of a retirement — and not
      // on a re-assertion, which changes nothing to keep.
      if (!unchanged && !existing.invalidated)
        retire(entries, existing, fields.gist, this._session);
      Object.assign(existing, {
        kind: fields.kind,
        title: fields.title,
        gist: fields.gist,
        body: fields.body ?? existing.body,
        snippet: fields.snippet ?? existing.snippet,
        trigger: fields.trigger ?? existing.trigger,
        tags: fields.tags ?? existing.tags,
        updated: today(),
        verified: today(),
        by: this._session,
      });
      // Re-writing a lesson is a correction; re-asserting it unchanged is evidence.
      if (unchanged)
        existing.confirmed += 1;
      else
        existing.failed = 0;
      // Recording it again is a first-hand claim that it holds now, which is the
      // one thing that can end a supersession. Without this a lesson retired
      // under its old title would stay invisible however many agents re-learned
      // it, since `remember` upserts by title and would keep writing into the
      // retired entry.
      delete existing.invalidated;
      await this._write(domain, entries);
      return { action: unchanged ? ('confirmed' as const) : ('updated' as const), entry: existing, redacted };
    });
  }

  /** Closes the loop: an agent that used a lesson reports whether it held. */
  async report(
    domain: string, id: string, outcome: 'worked' | 'failed', note?: string,
  ): Promise<Lesson | undefined> {
    const safeNote = note ? redactedNote(note) : undefined;
    return this._file.mutate(domain, async () => {
      const entries = await this.entries(domain);
      const entry = entries.find(candidate => candidate.id === slugify(id));
      if (!entry)
        return undefined;
      entry.used += 1;
      if (outcome === 'worked') {
        entry.confirmed += 1;
        entry.verified = today();
      } else {
        entry.failed += 1;
        if (safeNote)
          entry.body += `\n\n**Reported failure ${today()}:** ${safeNote}`;
      }
      await this._write(domain, entries);
      return entry;
    });
  }

  /**
   * Retires a lesson without erasing it — the rung between reporting a failure
   * and deleting outright.
   *
   * Deleting is what `forget` does, and it takes the date and the reason down
   * with the claim. What is left is a site whose memory cannot say that the
   * export moved, only that nothing is known about exports — so the next agent
   * tries the old route and spends the same ten minutes discovering it 404s.
   * Here the entry stays and recall stops offering it.
   */
  async invalidate(domain: string, id: string, note?: string): Promise<Lesson | undefined> {
    const safeNote = note ? redactedNote(note) : undefined;
    return this._file.mutate(domain, async () => {
      const entries = await this.entries(domain);
      const entry = entries.find(candidate => candidate.id === slugify(id));
      if (!entry)
        return undefined;
      // A second marking may add the reason the first one lacked, and must not
      // drop one that was already there.
      const reason = safeNote ?? entry.invalidated?.note;
      entry.invalidated = {
        // The first marking dates the change. Re-marking must not drag "held
        // until" forward to today, which would erase the one fact being kept.
        at: entry.invalidated?.at ?? today(),
        by: this._session,
        ...(reason ? { note: reason } : {}),
      };
      entry.updated = today();
      await this._write(domain, entries);
      return entry;
    });
  }

  async forget(domain: string, id: string): Promise<Lesson | undefined> {
    return this._file.mutate(domain, async () => {
      const entries = await this.entries(domain);
      const index = entries.findIndex(entry => entry.id === slugify(id));
      if (index === -1)
        return undefined;
      const [removed] = entries.splice(index, 1);
      await this._write(domain, entries);
      return removed;
    });
  }

  /**
   * Every entry that applies to this domain: its own, its parents', and the
   * global lessons that hold anywhere. Globals come last so a site-specific
   * lesson always outranks a general one about sites in general.
   *
   * Superseded entries are left out unless asked for. This is the path every
   * brief, every open and every unstick reads, and a lesson kept for the record
   * of when it stopped being true is not something to hand an agent that is
   * about to act. `includeInvalidated` is how anything that wants the record —
   * curation, an agent chasing why a route changed — gets it back.
   */
  async applicable(domain: string, options?: { includeInvalidated?: boolean }): Promise<SourcedLesson[]> {
    const visible = (entry: Lesson): boolean => options?.includeInvalidated === true || !entry.invalidated;
    const out: SourcedLesson[] = [];
    for (const source of domainChain(domain)) {
      for (const entry of (await this.entries(source)).filter(visible))
        out.push({ ...entry, source });
    }
    // `_env` is deliberately absent from this: a path on this disk is not
    // knowledge about the site an agent has just arrived at, and inheriting it
    // here is what would turn every recorded environment quirk into permanent
    // noise in every briefing. It reaches the agent once, in the server's
    // instructions.
    if (domain !== GLOBAL_SCOPE && domain !== ENV_SCOPE) {
      for (const entry of (await this.entries(GLOBAL_SCOPE)).filter(visible))
        out.push({ ...entry, source: GLOBAL_SCOPE, global: true });
    }
    return out;
  }

  /**
   * Sites, excluding the system's own records. The memory directory holds
   * `tabs.json` and `api/` beside the lesson files, and treating those as
   * domains is how a cross-domain pass would report on the tab registry.
   */
  private async _domains(): Promise<string[]> {
    return (await this._file.domains()).filter(domain => !RESERVED_NAMES.has(domain));
  }

  /** Every domain with its entries — what cross-domain pattern detection needs. */
  async everyDomain(): Promise<{ domain: string; entries: Lesson[] }[]> {
    const out: { domain: string; entries: Lesson[] }[] = [];
    for (const domain of await this._domains())
      out.push({ domain, entries: await this.entries(domain) });
    return out;
  }

  async index(): Promise<DomainSummary[]> {
    const out: DomainSummary[] = [];
    for (const domain of await this._domains()) {
      // Live only. This count is what the connect-time site list is built from,
      // and "8 lessons" that turns out to be five plus three records of what
      // they used to say is a promise the brief cannot keep. A retired claim is
      // never handed to anyone who has not asked for it by id.
      const entries = (await this.entries(domain)).filter(entry => !entry.invalidated);
      if (!entries.length)
        continue;
      out.push({
        domain,
        count: entries.length,
        kinds: [...new Set(entries.map(entry => entry.kind))],
        used: entries.reduce((sum, entry) => sum + entry.used, 0),
        disputed: entries.filter(entry => trust(entry).status === 'disputed').length,
        updated: entries.map(entry => entry.updated).sort().at(-1),
      });
    }
    return out.sort((a, b) => b.count - a.count);
  }
}

function redactedNote(note: string): string {
  return redactEntry({ body: note }).fields.body;
}
