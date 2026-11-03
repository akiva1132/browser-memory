import fs from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * The company's hq, which owns the tab handoff (agent-company B.9).
 *
 * On a headless server a person cannot reach the server's browser from where they are —
 * their phone. hq can: it issues a one-time link that shows only this session's
 * tab, at phone size, with the phone's own keyboard (and its SMS-code autofill),
 * puts it in the owner's "waiting for you" list with a push, and says the moment
 * he presses "done". That replaces pointing him at a remote desktop.
 *
 * Reached over hq's local socket, `$COMPANY_STATE_DIR/hq.sock` (the same one
 * the company MCP writes to; file permissions are the auth). No socket — the
 * laptop — means no handoff, and the ask is the message alone. A socket that
 * is there but does not give a link (hq refused, crashed and left the socket,
 * or did not answer) is an error to the agent, never a silent message-only
 * wait: the user's app would have no card. `BROWSER_ASK_HQ=off` turns it off.
 */

export type HandoffView = {
  id: string;
  state: 'live' | 'done' | 'expired' | 'closed' | 'cancelled';
  domain: string;
  from: string | null;
  expires_at: number;
  final_url: string | null;
  ended_by: string | null;
};

export type HandoffCreated =
  | { ok: true; link: string; handoff: HandoffView }
  | { ok: false; busy: HandoffView; reason: string }
  /** `noHq`: no hq on this machine (the laptop) — the ask goes out as the message alone. Otherwise hq refused or failed. */
  | { ok: false; busy?: undefined; reason: string; noHq?: true };

export type HqHandoffs = {
  /** The company identity this session asks as (COMPANY_IDENTITY), or null for a personal session. */
  identity: string | null;
  create(req: { target?: string; url?: string; what: string; need: string }): Promise<HandoffCreated>;
  /** Resolves when it ends, or with its current state after `ms`. */
  wait(id: string, ms: number, signal?: AbortSignal): Promise<HandoffView | undefined>;
  end(id: string, finalUrl?: string): Promise<void>;
};

const env = (name: string): string => (process.env[name] ?? '').trim();

/** Off by switch only; whether hq is up is decided per call. */
hqSocket.enabled = (): boolean => env('BROWSER_ASK_HQ') !== 'off';

export function hqSocket(): string | undefined {
  if (env('BROWSER_ASK_HQ') === 'off')
    return undefined;
  const dir = env('COMPANY_STATE_DIR') || path.join(os.homedir(), '.local', 'state', 'agent-company');
  const sock = path.join(dir, 'hq.sock');
  return fs.existsSync(sock) ? sock : undefined;
}

function call(sock: string, method: string, pathname: string, body?: unknown, timeoutMs = 15_000, signal?: AbortSignal):
    Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      socketPath: sock, method, path: pathname, timeout: timeoutMs,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || '{}') as Record<string, unknown> });
        } catch {
          reject(new Error(`hq answered ${res.statusCode} with something that is not JSON`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`hq did not answer within ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    // Closing the request is what tells hq this waiter is gone, so the ending reaches the worker by mail instead.
    if (signal) {
      const gone = () => req.destroy(new Error('cancelled'));
      if (signal.aborted)
        gone();
      else
        signal.addEventListener('abort', gone, { once: true });
      req.on('close', () => signal.removeEventListener('abort', gone));
    }
    req.end(data);
  });
}

/** Looked up on every call: hq restarting mid-session must not switch handoffs off for good. */
function socketOrThrow(): string {
  const sock = hqSocket();
  if (!sock)
    throw new Error('hq is not reachable here (no hq.sock)');
  return sock;
}

export function hqHandoffs(): HqHandoffs {
  // Who is asking: the company worker this session belongs to. Unset (a personal session) is fine.
  const identity = env('COMPANY_IDENTITY') || undefined;
  return {
    identity: identity ?? null,
    async create(req) {
      const sock = hqSocket();
      if (!sock)
        return { ok: false, reason: 'hq is not reachable here (no hq.sock)', noHq: true };
      const r = await call(sock, 'POST', '/v1/handoffs', { identity, ...req }, 20_000);
      if (r.status === 200 && typeof r.json['link'] === 'string')
        return { ok: true, link: r.json['link'] as string, handoff: r.json['handoff'] as HandoffView };
      const reason = String(r.json['error'] ?? `hq answered ${r.status}`);
      if (r.status === 409 && r.json['busy'])
        return { ok: false, busy: r.json['busy'] as HandoffView, reason };
      return { ok: false, reason };
    },
    async wait(id, ms, signal) {
      const r = await call(socketOrThrow(), 'GET', `/v1/handoffs/${encodeURIComponent(id)}?wait=${Math.round(ms)}`, undefined, ms + 10_000, signal);
      return r.status === 200 ? r.json['handoff'] as HandoffView : undefined;
    },
    async end(id, finalUrl) {
      await call(socketOrThrow(), 'POST', `/v1/handoffs/${encodeURIComponent(id)}/end`, { state: 'done', final_url: finalUrl });
    },
  };
}
