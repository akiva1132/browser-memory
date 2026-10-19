import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

/**
 * Running one measured session, separated from the script that orders them.
 *
 * It lives apart for one reason: `eval/run.ts` executes on import, so nothing
 * in it can be tested. That mattered the day three runs in a row came back
 * `600s · 0 turns · $0.00` — the shape of a run that worked and failed its
 * checks, and in fact a wedged browser stack that had stopped measuring
 * anything in its first minute. The detection that now prevents that is error
 * handling, which is the code least likely to be exercised by accident and
 * most costly to get wrong, so it is reachable from a test.
 */

export type Metrics = {
  ok: boolean;
  seconds: number;
  turns: number;
  costUsd: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  output: string;
  error?: string;
  /**
   * The instrument broke, as distinct from the agent failing. A run marked
   * here is not data: it is excluded from every median and said out loud.
   */
  broken?: 'stalled' | 'timed-out' | 'no-agent';
};

type ClaudeJson = {
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
  usage?: {
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

/** How often to look at the heartbeat. Cheap: one stat of one file. */
/**
 * The agent never ran at all: a usage limit, a missing credential, a refusal to
 * start. Matched on what the CLI actually prints, which is why the wording is
 * quoted rather than paraphrased.
 */
const NO_AGENT = /You've hit your (?:session|usage) limit[^\n]*|Credit balance is too low|Invalid API key|not logged in/i;

export const HEARTBEAT_MS = 10_000;
/**
 * Silence long enough to mean stuck rather than thinking.
 *
 * Generous on purpose — killing a slow-but-working run would corrupt the very
 * measurement this protects — and still two orders of magnitude faster than
 * finding out at the timeout.
 */
export const STALL_MS = 180_000;

export type RunSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /**
   * The heartbeat. `--output-format json` emits one blob at the end, so stdout
   * says nothing about progress until there is nothing left to learn from it.
   * The gateway appends to this file on every single tool call, which is a
   * liveness signal that already exists and costs one stat to read.
   */
  auditFile: string;
  stallMs?: number;
  heartbeatMs?: number;
};

export function runProcess(spec: RunSpec): Promise<Metrics> {
  const started = Date.now();
  const stallMs = spec.stallMs ?? STALL_MS;
  return new Promise(resolve => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));

    let broken: Metrics['broken'];
    const timer = setTimeout(() => {
      broken = 'timed-out';
      child.kill('SIGKILL');
    }, spec.timeoutMs);

    let lastSize = -1;
    let quietSince = Date.now();
    const heartbeat = setInterval(() => {
      void fs.stat(spec.auditFile).then(stat => stat.size).catch(() => lastSize).then(size => {
        if (size !== lastSize) {
          lastSize = size;
          quietSince = Date.now();
          return;
        }
        if (Date.now() - quietSince >= stallMs) {
          broken = 'stalled';
          child.kill('SIGKILL');
        }
      });
    }, spec.heartbeatMs ?? HEARTBEAT_MS);

    child.on('close', () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      const seconds = Math.round((Date.now() - started) / 1000);
      const empty = {
        ok: false, seconds, turns: 0, costUsd: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
      };
      /*
       * Checked before the stall verdict, because it explains the same
       * symptom and calls for the opposite response.
       *
       * A run that never gets an agent produces exactly what a wedged browser
       * produces: no tool calls, no audit growth, silence until the heartbeat
       * gives up. The runner used to answer that with "the browser stack is
       * wedged — restart playwright-mcp.service", and it said so through four
       * runs while the doctor reported the stack healthy and a real browser
       * call round-tripping. An instrument confidently naming the wrong
       * subsystem is worse than one that says nothing: it sends whoever is
       * reading it to go and fix something that was never broken.
       */
      const limited = NO_AGENT.exec(`${stdout}\n${stderr}`);
      if (limited) {
        resolve({
          ...empty,
          output: stdout.slice(0, 2000),
          broken: 'no-agent',
          error: `no agent ran — ${limited[0].trim()}. Nothing here is about the browser or the ` +
            `scenario; the measurement has to wait.`,
        });
        return;
      }
      if (broken) {
        resolve({
          ...empty,
          output: stdout.slice(0, 2000),
          broken,
          error: broken === 'stalled'
            ? `no tool call for ${Math.round(stallMs / 1000)}s and the agent produced nothing — ` +
              `check \`npm run doctor\` before blaming the browser; if it is green the agent ` +
              `never started`
            : `hit the ${Math.round(spec.timeoutMs / 1000)}s ceiling with no parseable result`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as ClaudeJson;
        resolve({
          ok: !parsed.is_error,
          seconds,
          turns: parsed.num_turns ?? 0,
          costUsd: parsed.total_cost_usd ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
          cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
          output: parsed.result ?? '',
        });
      } catch {
        resolve({
          ...empty,
          output: stdout.slice(0, 2000),
          error: stderr.slice(-500) || 'could not parse the session result',
        });
      }
    });
  });
}
