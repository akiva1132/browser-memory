/**
 * Running a saved procedure, which is also the only way one is ever verified.
 *
 * There is no scheduled health check by design: a procedure that has rotted is
 * discovered by the next agent that depends on it, which is the same moment the
 * rot would have mattered — and the record it leaves is evidence rather than a
 * guess about age.
 *
 * Three outcomes, and the middle one is the reason this is not two lines. A
 * call that reached the wrong site says nothing about the procedure, so it is
 * not counted against it; counting it would let an agent on the wrong page
 * break a working capability for everyone after them.
 */
import { bodyOf, failure, withNote } from '../lib/toolResult.ts';
import type { ToolResult } from '../lib/toolResult.ts';
import type { Procedure } from '../types.ts';
import {
  PROCEDURE_ERROR, PROCEDURE_OK, PROCEDURE_WRONG_ORIGIN, buildEvaluateFunction,
} from './store.ts';

/** What the runner needs from the rest of the gateway, so this file needs none of it. */
export type ProcedureDeps = {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  recordRun: (name: string, ok: boolean) => Promise<void>;
};

export async function runProcedure(
  procedure: Procedure, args: Record<string, unknown>, deps: ProcedureDeps,
): Promise<ToolResult> {
  if (procedure.mutating && args['confirm'] !== true) {
    return failure(
      `\`${procedure.name}\` changes state on ${procedure.domain} and was called without confirmation.\n\n` +
      `${procedure.description}\n\nRe-call it with confirm: true only if that is genuinely intended.`);
  }

  let result: ToolResult;
  try {
    result = await deps.call('browser_evaluate', { function: buildEvaluateFunction(procedure, args) });
  } catch (error) {
    return failure(`Could not run \`${procedure.name}\`: ${(error as Error).message}`);
  }

  const body = bodyOf(result);
  const wrongOrigin = PROCEDURE_WRONG_ORIGIN.test(body);
  const ok = PROCEDURE_OK.test(body) && !result.isError;
  const failed = !wrongOrigin && (PROCEDURE_ERROR.test(body) || Boolean(result.isError));
  // A wrong-origin call says nothing about the procedure, so it is not recorded.
  if (ok || failed)
    await deps.recordRun(procedure.name, ok).catch(() => {});

  if (wrongOrigin) {
    return withNote(result,
      `\n\n_Navigate to ${procedure.origin} and call \`${procedure.name}\` again. ` +
      `This was not counted against the procedure._`, true);
  }
  if (failed) {
    return withNote(result,
      `\n\n_\`${procedure.name}\` failed and the failure was recorded. Two consecutive ` +
      `failures and it stops being offered. If you work out the correct version, save it with ` +
      `procedure_save under the same name._`, true);
  }
  return result;
}
