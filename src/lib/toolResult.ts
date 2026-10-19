/**
 * What an MCP tool answers with, and the four things anyone ever does to one.
 *
 * This shape was declared four times — in the gateway, in askUser, in the test
 * harness and in the harvest script — each with its own private `bodyOf`
 * beside it, each spelled slightly differently. It is the single most-passed
 * value in the program and it had no home, so every file that touched it
 * re-described it.
 *
 * The constructors matter more than the type. `{ ...text(msg), isError: true }`
 * appeared six times and `{ ...result, isError: true, content: [...(result
 * .content ?? []), { type: 'text', text: … }] }` three more — the same two
 * intentions, written out longhand, in a spread that silently does nothing when
 * `content` is undefined. Naming them is what stops the next one from being
 * written a fourth way.
 */

/** One block of a reply. Text is the only kind this program produces or reads. */
export type ContentBlock = { type: string; text?: string };

export type ToolResult = {
  content?: ContentBlock[];
  isError?: boolean;
};

/** A plain successful answer. */
export const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });

/**
 * A refusal or a failure, in the form an MCP client renders as one.
 *
 * Distinct from `text` on purpose: an error that forgets `isError` is reported
 * to the agent as an ordinary answer, and the agent then acts on the message as
 * though it were a result.
 */
export const failure = (value: string): ToolResult => ({ ...text(value), isError: true });

/** Everything the reply says, as one string. */
export const bodyOf = (result: ToolResult): string =>
  (result.content ?? []).map(part => part.text ?? '').join('\n');

/**
 * The same reply with something added after it — a diagnosis, a remembered fix,
 * a note about what was recorded.
 *
 * `content` is optional in the protocol, so appending has to cope with its
 * absence rather than spread `undefined` and lose the addition.
 */
export const withNote = (result: ToolResult, note: string, isError?: boolean): ToolResult => ({
  ...result,
  ...(isError === undefined ? {} : { isError }),
  content: [...(result.content ?? []), { type: 'text', text: note }],
});
