/**
 * When a recorded flow is allowed to cross a page boundary, and when it is not.
 *
 * The recorder was single-page by construction: `navigated` closed the flow in
 * progress, so a form spread over three pages produced three fragments, each
 * too short to keep. A multi-page form is exactly the shape whose targets are
 * worth writing down — nothing about page two is knowable from page one — so
 * the one case with most to say was the one case that said nothing.
 *
 * Opening that boundary is the riskiest thing in the recorder, because the
 * signal is a heuristic. Most of what follows is the refusals: the cases where
 * a page change must still end the flow. Each of them, allowed through, turns a
 * lesson about a form into a transcript of a session filed under the form's
 * name.
 */
import assert from 'node:assert/strict';

import { Observer } from '../../src/capture/observe.ts';
import { MemoryStore } from '../../src/memory/store.ts';
import { cleanup, stepsIn, tempMemoryDir } from '../harness.ts';

const memoryDir = await tempMemoryDir('spanning');
const store = new MemoryStore(memoryDir);

/** What the recorder leaves behind: a lesson carrying the addresses that worked. */
const flowFor = async (domain: string) =>
  (await store.entries(domain)).find(entry => entry.tags.includes('selectors'));

/**
 * Drives one step exactly the way the gateway does: the call is seen first,
 * then the page it landed on is announced, with how it got there.
 *
 * That order is not a detail — a step belongs to the page it was made on, and
 * reversing it discards the submit that makes the rest worth keeping.
 */
function driver(observer: Observer, site: string) {
  return async (
    tool: string, element: string, landed: string, how: 'went' | 'landed' = 'landed',
    value?: string,
  ): Promise<void> => {
    await observer.saw(tool, {
      element,
      target: `role=${tool === 'browser_click' ? 'button' : 'textbox'}[name=${JSON.stringify(element)}]`,
      ...(value === undefined ? {} : { text: value }),
    }, 'ok', false);
    await observer.navigated(site, landed, how);
  };
}

try {
  // ── a form across three pages is one recording ─────────────────────────────
  {
    const site = 'grants.example.com';
    const observer = new Observer(memoryDir, 'span-1');
    await observer.navigated(site, '/apply-1', 'went');
    const step = driver(observer, site);
    await step('browser_type', 'Full name', '/apply-1', 'landed', 'Akiva');
    await step('browser_type', 'Email', '/apply-1', 'landed', 'a@example.com');
    // The commit that hands over to page two.
    await step('browser_click', 'Continue to institution', '/apply-2');
    await step('browser_type', 'Institution', '/apply-2', 'landed', 'Weizmann');
    await step('browser_type', 'Department', '/apply-2', 'landed', 'Physics');
    await step('browser_click', 'Continue to proposal', '/apply-3');
    await step('browser_type', 'Project title', '/apply-3', 'landed', 'Something');
    await step('browser_click', 'Submit application', '/apply-3');
    await observer.flush();

    const flow = await flowFor(site);
    assert.ok(flow, 'a form spread over three pages has to record as a flow, not as nothing');
    assert.equal(stepsIn(flow.body).length, 8,
        'every step across every page, including both hand-overs');
    assert.match(flow.title, /3-page form/, 'and it says so, rather than reading as one long form');
    assert.match(flow.title, /\/apply-1/,
        'identified by where it starts, which is the only page an agent can navigate to');

    /*
     * The joins, spelled out in the body.
     *
     * Without them the block reads as eight steps on one page, and an agent
     * that takes step seven and issues it against page one gets a target that
     * is genuinely not there — so the recording looks stale when it is exact.
     */
    assert.match(flow.body, /the page becomes \/apply-2/);
    assert.match(flow.body, /the page becomes \/apply-3/);
    assert.match(flow.body, /Start at \/apply-1/);
    assert.ok(!flow.body.includes('a@example.com'),
        'and nothing anyone typed is kept, on any page of it');
    console.log('  a 3-page form records as one 8-step flow starting at /apply-1');
  }

  // ── refusal: the agent chose to be somewhere else ──────────────────────────
  //
  // An explicit `browser_navigate` is a decision, not a form advancing. Without
  // this the recording would run on through whatever the agent did next, and
  // the first thing most agents do next is go and check something.
  {
    const site = 'explicit.example.com';
    const observer = new Observer(memoryDir, 'explicit-1');
    await observer.navigated(site, '/form', 'went');
    const step = driver(observer, site);
    await step('browser_type', 'Name', '/form', 'landed', 'x');
    await step('browser_type', 'Email', '/form', 'landed', 'y');
    await step('browser_click', 'Save', '/form');
    // Typed into the URL bar, so to speak.
    await observer.navigated(site, '/somewhere-else', 'went');
    await step('browser_type', 'Search', '/somewhere-else', 'landed', 'z');
    await observer.flush();

    const flow = await flowFor(site);
    assert.ok(flow, 'the flow itself is still recorded');
    assert.equal(stepsIn(flow.body).length, 3, 'and stops at the navigation the agent chose');
    assert.doesNotMatch(flow.body, /the page becomes/, 'so it is a single-page flow, as it always was');
    console.log('  an explicit navigate still ends the flow, and records what came before it');
  }

  // ── refusal: nothing had committed ─────────────────────────────────────────
  //
  // A page that changes after a `type` is not a form advancing — it is a search
  // box, an autocomplete, or a link that happened to be focused.
  {
    const site = 'typed.example.com';
    const observer = new Observer(memoryDir, 'typed-1');
    await observer.navigated(site, '/search', 'went');
    const step = driver(observer, site);
    await step('browser_type', 'Query', '/search', 'landed', 'a');
    await step('browser_type', 'Filter', '/results', 'landed', 'b');
    await step('browser_click', 'Open', '/results');
    await observer.flush();

    assert.equal(await flowFor(site), undefined,
        'a page change after typing is not a commit, so the first fragment ends there and is too short');
    console.log('  a page change that no click caused does not extend the flow');
  }

  // ── refusal: the click left the site ───────────────────────────────────────
  {
    const site = 'origin.example.com';
    const observer = new Observer(memoryDir, 'cross-1');
    await observer.navigated(site, '/checkout', 'went');
    const step = driver(observer, site);
    await step('browser_type', 'Card number', '/checkout', 'landed', '4242');
    await step('browser_type', 'Expiry', '/checkout', 'landed', '12/30');
    await step('browser_click', 'Pay with provider', '/checkout');
    // The click hands off to a payment processor. A flow ends at the boundary.
    await observer.navigated('processor.example.net', '/pay', 'landed');
    await observer.flush();

    const flow = await flowFor(site);
    assert.ok(flow, 'what happened on this site is still worth keeping');
    assert.equal(stepsIn(flow.body).length, 3);
    assert.equal(await flowFor('processor.example.net'), undefined,
        'and nothing is attributed to the site it handed over to');
    console.log('  a click that lands on another site ends the flow at the boundary');
  }

  /*
   * ── refusal: the page it landed on was only read ──────────────────────────
   *
   * The expensive one, and the reason the trim exists. Pay, land on the
   * receipt, then click three things while reading it — and those three clicks
   * are inside the recording, filed as part of paying. The tail is cut back to
   * the last page anything was entered on, which for this shape leaves exactly
   * the recording it produced before flows could span at all.
   */
  {
    const site = 'receipt.example.com';
    const observer = new Observer(memoryDir, 'receipt-1');
    await observer.navigated(site, '/order', 'went');
    const step = driver(observer, site);
    await step('browser_type', 'Card number', '/order', 'landed', '4242');
    await step('browser_type', 'Expiry', '/order', 'landed', '12/30');
    await step('browser_click', 'Pay now', '/receipt');
    for (const label of ['Show details', 'Download invoice', 'Print'])
      await step('browser_click', label, '/receipt');
    await observer.flush();

    const flow = await flowFor(site);
    assert.ok(flow);
    const steps = stepsIn(flow.body);
    assert.equal(steps.length, 3,
        'the three clicks taken while reading the receipt are not part of paying');
    assert.equal(steps.at(-1)!.element, 'Pay now', 'the flow ends at the commit');
    assert.doesNotMatch(flow.body, /the page becomes/,
        'and it is a single-page flow again, as it always was');
    console.log('  a page that was only read is where the flow ended, not part of it');
  }

  // ── the cap, so a heuristic that misfires costs one page and not a session ─
  {
    const site = 'long.example.com';
    const observer = new Observer(memoryDir, 'long-1');
    await observer.navigated(site, '/p0', 'went');
    const step = driver(observer, site);
    for (let page = 0; page < 8; page++) {
      await step('browser_type', `Field ${page}`, `/p${page}`, 'landed', 'x');
      await step('browser_click', `Next ${page}`, `/p${page + 1}`);
    }
    await observer.flush();

    const flow = await flowFor(site);
    assert.ok(flow);
    assert.match(flow.title, /4-page form/, 'a flow may cross at most four pages');
    assert.equal((flow.body.match(/the page becomes/g) ?? []).length, 3,
        'which is three joins, and no more however far the agent went');
    console.log('  the page cap holds at 4, so a misfire is bounded');
  }
} finally {
  await cleanup(memoryDir);
}

console.log('SPANNING OK');
