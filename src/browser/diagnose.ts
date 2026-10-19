/**
 * Why the call failed, said in one line, at the moment the agent is about to
 * guess.
 *
 * Measured in the real audit log: half the clicks in the long working session
 * failed, and every failure cost the full five-second action ceiling — 20
 * seconds of timeout, plus 16 more the agent then spent in blind
 * `browser_wait_for` sleeps. 18% of all time inside tool calls went to failing
 * and recovering from it. The sequence is legible in the log: click the radio,
 * fail after 5s; click its label, fail after 5s; sleep 4s; carry on.
 *
 * The striking part is that the browser already said what was wrong. Playwright
 * writes a call log, and in it sits the operative line — `element is not
 * visible`, or `<div class="cover"> intercepts pointer events` — buried under
 * thirteen repetitions of the retry loop, at the end of a five-second wait, in
 * a block that opens with the word Timeout. An agent skimming that reads
 * "timeout" and concludes it picked the wrong selector, which is precisely the
 * wrong conclusion: the selector was right, the element was found, and the
 * click could not land.
 *
 * So nothing here is inferred about the page. The cause is lifted from what the
 * browser already reported, and what follows it is the part the browser does
 * not say: whether trying again will help. That last sentence is the whole
 * point — it is what a second five-second timeout costs to learn otherwise.
 *
 * Fixtures for all of this were captured from a live browser rather than
 * written from memory, because the exact wording is the contract.
 */

export type Cause = 'hidden' | 'covered' | 'disabled' | 'unstable' | 'stale-ref' | 'no-match';

export type Failure = {
  cause: Cause;
  /** What the locator resolved to, when it resolved to anything. */
  element?: string;
  /** For a covered element, the thing sitting on top of it. */
  blocker?: string;
  /** Whether this burned the full action ceiling rather than failing fast. */
  timedOut: boolean;
};

const RESOLVED = /locator resolved to (<[^\n]+?>)/;
/**
 * Anchored to the log's bullet rather than to `<`, because the element is
 * printed with its closing tag — `<div class="cover"></div>` — and a pattern
 * that just looks for a tag before the message matches the `</div>` at the end
 * of it, naming a blocker of `</div>` and telling the agent to go and close it.
 */
const INTERCEPTS = /-\s+(<[^\n]+?>)\s+intercepts pointer events/;
const TIMEOUT = /Timeout (\d+)ms exceeded/;

/**
 * Ordered by specificity rather than by position. A covered element also logs
 * "visible, enabled and stable", and a hidden one logs the retry loop — the
 * distinguishing line is the one to key on, not the last one printed.
 */
const CAUSES: readonly (readonly [Cause, RegExp])[] = [
  ['covered', INTERCEPTS],
  ['hidden', /element is not visible/],
  ['disabled', /element is not enabled/],
  ['unstable', /element is not stable/],
  ['stale-ref', /Ref \S+ not found in the current page snapshot/],
  ['no-match', /does not match any elements/],
];

export function readFailure(body: string): Failure | undefined {
  const found = CAUSES.find(([, pattern]) => pattern.test(body));
  if (!found)
    return undefined;
  const [cause] = found;
  return {
    cause,
    ...(RESOLVED.exec(body)?.[1] ? { element: RESOLVED.exec(body)![1]! } : {}),
    ...(cause === 'covered' && INTERCEPTS.exec(body)?.[1] ? { blocker: INTERCEPTS.exec(body)![1]! } : {}),
    timedOut: TIMEOUT.test(body),
  };
}

/**
 * What to do instead. Every line ends with whether retrying the same target is
 * worth anything, because that is the question the agent is actually about to
 * answer, and the expensive way to answer it is another five seconds.
 */
function advise(failure: Failure): string {
  switch (failure.cause) {
    case 'covered':
      return `Something is on top of it: \`${failure.blocker}\`. Close or dismiss that first — ` +
        `a cookie banner, a modal, or an overlay left open by the last step. The same click will ` +
        `land once it is gone, and will keep timing out until then.`;
    case 'hidden':
      return `The element exists but is not visible, so the click can never land on it. This is ` +
        `usually a styled control whose real input is hidden — a radio or checkbox drawn by its ` +
        `label. Click the label instead (its text is in the snapshot next to this element), or set ` +
        `the value directly with \`browser_evaluate\`. Retrying this target will time out again.`;
    case 'disabled':
      return `The control is disabled. Nothing about the target is wrong, so retrying it will fail ` +
        `the same way — something earlier in the form is unfinished, or the page is still working.`;
    case 'unstable':
      return `The element is still moving — an animation or a list settling. This one is worth ` +
        `retrying once the page is quiet; \`browser_wait_for\` on text that appears when it settles ` +
        `is more reliable than waiting a fixed number of seconds.`;
    case 'stale-ref':
      return `Refs belong to the snapshot they came from and do not survive the page changing. ` +
        `Take a fresh snapshot, or address the element by role and accessible name ` +
        `(\`role=button[name="Save"]\`), which stays valid across redraws.`;
    case 'no-match':
      return `Nothing on the page matched. Take a snapshot, or use \`browser_find\` to locate the ` +
        `element by its text — it is cheaper than a full tree and gives you the ref directly.`;
  }
}

/**
 * The block appended to a failing reply, or undefined when the error is not one
 * of the shapes this can speak to — in which case the browser's own message is
 * left to stand alone rather than being padded with a guess.
 */
export function explainFailure(body: string): string | undefined {
  const failure = readFailure(body);
  if (!failure)
    return undefined;
  const cost = failure.timedOut
    ? ` This one spent the full action timeout before reporting, which is why it was slow.`
    : '';
  return `\n\n**Why it failed:** ${advise(failure)}` +
    `${failure.element ? `\n\nThe locator did find something — \`${failure.element}\` — so the ` +
      `target itself is not the problem.` : ''}${cost}`;
}
