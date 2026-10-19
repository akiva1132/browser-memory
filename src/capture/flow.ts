/**
 * The shape of a recorded form flow, and everything about it that is a pure
 * function of the steps.
 *
 * Split out of the Observer because it is the one detector with a vocabulary of
 * its own — which tools count as a step, what a value is called, how many pages
 * a flow may cross — and none of it depends on the Observer's state. What is
 * left in the class is the part that genuinely does: which page we are on, and
 * what has happened since.
 *
 * There used to be a second consumer. The same steps were written twice, once
 * as this prose and once as a trajectory an engine could replay, and the
 * runnable half was withdrawn on 2026-08-06 — offered to twelve agents on the
 * one form it could have helped with and used by none, and uncapturable on the
 * sites where it might have paid, because agents route around Playwright's
 * actionability checks through `browser_evaluate` and every such step is
 * invisible here. The code is on the `recorded-flows` branch.
 */
import type { Kind, LessonInput } from '../types.ts';

/**
 * One tool call worth writing down, as it actually happened.
 *
 * The reusable half and nothing else: `fills` records that a value belonged
 * here and what the field was called, and the value itself is somebody's errand
 * and is discarded on purpose.
 */
export type Step = {
  tool: string;
  element: string;
  target: string;
  /** True when `target` is a (role, name) pair rather than a CSS selector. */
  anchored: boolean;
  /** Parameter name when this step entered a value, e.g. `to`, `subject`. */
  fills?: string;
  /**
   * Which page this step happens on, present only when that is not the page the
   * flow started on — so an ordinary single-page form keeps the shape it has
   * always had, and a form that crosses pages says where the joins are.
   */
  page?: string;
};

/** Which argument each filling tool carries its value in. A click carries none. */
export const VALUE_ARG: Record<string, string> = {
  browser_type: 'text',
  browser_select_option: 'values',
  browser_file_upload: 'paths',
};

/** Actions that make up a form flow. Anything else is navigation or looking. */
export const FLOW_TOOLS = new Set([
  'browser_type', 'browser_click', 'browser_file_upload', 'browser_select_option', 'browser_press_key',
]);

/**
 * The name a value would go by, or undefined when the step carries no value.
 *
 * Derived from the field's own label rather than from anything typed, so it is
 * the same class of fact as the target beside it: `to`, `subject`, `message`.
 * A field with no usable label still gets a hole — losing the value's *position*
 * would silently shift every later parameter by one — it is just numbered.
 */
export function holeFor(tool: string, args: Record<string, unknown>, element: string): string | undefined {
  const key = VALUE_ARG[tool];
  if (!key || args[key] === undefined || args[key] === null || args[key] === '')
    return undefined;
  const name = element.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return name || 'value';
}

/**
 * Which single-target tool each kind of field is driven by, taken from the type
 * the browser itself reported rather than guessed from the value.
 */
const FIELD_TOOL: Record<string, string> = {
  textbox: 'browser_type',
  searchbox: 'browser_type',
  combobox: 'browser_select_option',
  listbox: 'browser_select_option',
  checkbox: 'browser_click',
  radio: 'browser_click',
  slider: 'browser_type',
};

/**
 * `browser_fill_form` unpacked into one step per field.
 *
 * This is the tool for filling in a form — it does the whole thing in one call
 * — and the recorder was watching only the single-target tools, so the most
 * natural way to perform exactly the interaction this feature exists to capture
 * produced nothing at all. It is in the real audit log twice, once on a
 * registration form and once on a login, and both recorded no flow.
 *
 * Every field already carries what a step needs: a target, the accessible name,
 * and the type. Nothing about the *value* is read here beyond whether there was
 * one — the second of those two real calls was a password.
 */
export function fieldsOf(args: Record<string, unknown>): { tool: string; args: Record<string, unknown> }[] {
  const fields = Array.isArray(args['fields']) ? args['fields'] : [];
  const out: { tool: string; args: Record<string, unknown> }[] = [];
  for (const raw of fields) {
    if (!raw || typeof raw !== 'object')
      continue;
    const field = raw as Record<string, unknown>;
    const tool = FIELD_TOOL[String(field['type'] ?? '')] ?? 'browser_type';
    const value = field['value'];
    out.push({
      tool,
      args: {
        target: field['target'],
        element: field['name'],
        // Placed under the key the tool reads, so a hole is named for it in the
        // same way a direct call would name one — and the value is thrown away
        // by `holeFor`, which only ever asks whether the key was present.
        ...(value === undefined || value === '' ? {} : { [VALUE_ARG[tool] ?? 'text']: value }),
      },
    });
  }
  return out;
}

/** Long enough for a real flow, short enough that it cannot become a transcript. */
export const MAX_FLOW_STEPS = 24;

/**
 * How many pages one flow may cross before it is treated as a session rather
 * than a form.
 *
 * A wizard is three or four steps; beyond that the thing being recorded is an
 * agent working, not a procedure. The cap matters because the rule below is a
 * heuristic — a click that happens to be a link, on a page where the agent had
 * already typed something, extends the flow — and a bounded mistake is a
 * recording with one stray page in it, while an unbounded one is a transcript
 * of the whole session advertised as a form.
 */
export const MAX_FLOW_PAGES = 4;

/**
 * The steps that can commit a page and hand over to the next one.
 *
 * Only these extend a flow across a navigation. The distinction is what keeps
 * this from recording everything: an agent that types into a search box, reads
 * the results and *then* navigates away has not advanced a form, and its last
 * recorded step was not a commit.
 */
export const COMMITTING = new Set(['browser_click', 'browser_press_key']);

/**
 * Why the page changed, as the gateway knows it.
 *
 * `went` is the agent calling `browser_navigate` — a decision to be somewhere
 * else, which ends whatever form was in progress. `landed` is the page changing
 * underneath some other call, which on a multi-page form is the form advancing.
 * The gateway can tell these apart for nothing, because it knows which tool it
 * just forwarded; the observer cannot, and guessed wrong for every wizard.
 */
export type Arrival = 'went' | 'landed';

/** Evidence for one candidate lesson, before it has earned its way into memory. */
export type FlowLesson = LessonInput & { domain: string; detector: 'form-flow'; signature: string };


  /**
   * The addresses that worked, in order — and nothing that was typed into
   * them.
   *
   * This is the whole instance-versus-knowledge distinction in one place. The
   * address in the To field is the errand; the compose dialog's To field is the
   * site. Measured: an agent spent 186 seconds and 36 calls rediscovering
   * Gmail's compose DOM, three runs in a row, because nothing here was ever
   * written down.
   */
export function formFlow(domain: string, path: string, steps: Step[], pages: string[] = []): FlowLesson {
  const where = path && path !== '/' ? path : 'the main page';
  const spans = pages.length > 1;
  /*
   * Rendered with the page changes in it, because a flow that crosses pages
   * and does not say so reads as one long form. An agent that takes step
   * seven from this block and issues it against page one gets a target that
   * is genuinely not there, and the recording looks stale when it is exact.
   */
  let at = pages[0] ?? path;
  const what = (step: Step): string => {
    const page = step.page ?? pages[0] ?? path;
    const join = page === at ? '' : `\n── the page becomes ${page} ──\n`;
    at = page;
    return `${join}${step.tool.replace('browser_', '').padEnd(11)} ${step.element || '(unlabelled)'}\n    ` +
      `${step.target}${step.anchored ? '' : '   ← css: tied to the layout, not the element'}`;
  };
  return {
    domain,
    detector: 'form-flow',
    // Keyed by where the flow happens, not by what it was for, so the same
    // page worked twice sharpens one entry instead of making two.
    signature: `${path}|${steps.map(step => step.tool).join(',')}`,
    kind: 'landmark' as Kind,
    title: spans
      ? `Working targets for the ${pages.length}-page form starting at ${where}`
      : `Working targets for the form on ${where}`,
    gist: `A ${steps.length}-step flow on ${domain}${where === 'the main page' ? '' : ` at ${where}`} ` +
      `${spans ? `that crosses ${pages.length} pages (${pages.join(' → ')}) and worked` : 'that worked'}: ` +
      `${steps.map(step => step.element).filter(Boolean).slice(0, 5).join(' → ')}. ` +
      `Go straight to these instead of hunting for them.`,
    body: `Recorded by the gateway as it happened — every one of these calls succeeded, which is ` +
      `why one sighting is enough.\n\n\`\`\`\n${steps.map(what).join('\n')}\n\`\`\`\n\n` +
      (spans
        ? `Start at ${pages[0]}; the page changes where the block says it does, and each change is ` +
          `caused by the step above it rather than by navigating.\n\n`
        : '') +
      `Each address goes straight into \`target\` on the tool above it. The \`role=…[name=…]\` ones are ` +
      `the (role, accessible name) pairs the page itself reported at the moment the step worked, which ` +
      `is what survives a restyle — and when one does stop matching, the call fails rather than acting ` +
      `on whatever now occupies that position. Take a fresh snapshot at that point instead of guessing.` +
      `\n\nWhat was typed into these fields belonged to one errand and is deliberately not recorded.`,
    snippet: '',
    trigger: `you need to fill in or submit something on ${domain}`,
    tags: ['auto', 'selectors', 'ui'],
  };
}
