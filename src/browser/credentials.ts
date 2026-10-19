import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { LocalTool } from '../types.ts';
import { bodyOf } from '../lib/toolResult.ts';
import type { ToolResult } from '../lib/toolResult.ts';

/**
 * Signing in without handing the password to the model.
 *
 * The browser already survives a restart with its sessions intact, so this is
 * only about the first login on a site — and about the servers, where "the user
 * will just type it" is not available. What was happening instead was the agent
 * stopping on every login page forever.
 *
 * Two rules shape the whole file.
 *
 * The password never comes back through a tool result. There is no
 * `credentials_get`. `browser_credentials_fill` reads the store and types
 * straight into the page, and reports only which fields it filled. A secret
 * returned to the model is a secret written into the transcript, the session
 * log, and whatever the client syncs to a server — none of which the user
 * agreed to when they said "here is my password".
 *
 * And the store is plain JSON at mode 600, which is stated plainly rather than
 * dressed up. Anything an unattended agent can decrypt on its own is readable
 * by anything running as that agent; a passphrase it holds itself buys nothing
 * but the feeling of encryption. The real boundary is the `agent` user, and it
 * is the same boundary already protecting the Chrome profile next to it.
 */

/** Kept outside the repository: `git status` should never be the thing that catches this. */
const DEFAULT_FILE = join(homedir(), '.browser-credentials.json');

type Entry = {
  username?: string;
  password?: string;
  /** Which account to pick at a "Choose an account" screen, when a site uses Google SSO. */
  googleAccount?: string;
  /** Anything the next agent needs that is not a secret — "use the SSO button, not the form". */
  note?: string;
  updated: string;
};

type Vault = Record<string, Entry>;

export type CredentialDeps = {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
};

const file = (): string => (process.env['BROWSER_CREDENTIALS_FILE'] || '').trim() || DEFAULT_FILE;

/**
 * `app.mercury.com` and `mercury.com` are one login. Matching on the full host
 * would store the same password twice and then miss it from the third subdomain,
 * so entries are keyed by the registrable-ish domain: the last two labels, minus
 * a leading `www.`. It is not the public-suffix list, and for `co.il` and
 * friends it keeps one label too few — which is why lookup below tries the full
 * host first and only then falls back.
 */
function normalize(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase();
  try {
    if (host.includes('://'))
      host = new URL(host).hostname;
  } catch {
    // Not a URL; treat it as a bare host.
  }
  host = host.replace(/^www\./, '');
  return host;
}

function parentDomain(host: string): string {
  const labels = host.split('.');
  return labels.length > 2 ? labels.slice(-2).join('.') : host;
}

function read(): Vault {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Vault;
  } catch {
    // A missing or unreadable store is an empty one. The tools below say so
    // explicitly rather than pretending a site is simply absent from it.
    return {};
  }
}

function write(vault: Vault): void {
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies `mode` when it creates the file, so an entry
  // added to a store that already exists would silently keep whatever
  // permissions it had. Re-assert every time.
  chmodSync(path, 0o600);
}

/** Exact host first, then the registrable domain — so a stored `mercury.com` serves `app.mercury.com`. */
function lookup(vault: Vault, hostOrUrl: string): { key: string; entry: Entry } | undefined {
  const host = normalize(hostOrUrl);
  for (const key of [host, parentDomain(host)]) {
    const entry = vault[key];
    if (entry)
      return { key, entry };
  }
  return undefined;
}

/** Where the browser currently is, so the agent does not have to tell us. */
async function currentHost(deps: CredentialDeps): Promise<string> {
  try {
    const result = await deps.call('browser_evaluate', { function: '() => "at:" + location.href' });
    return /at:(\S+)/.exec(bodyOf(result))?.[1] ?? '';
  } catch {
    return '';
  }
}

export function credentialTools(deps: CredentialDeps): LocalTool[] {
  return [
    {
      name: 'browser_credentials_list',
      title: 'What sign-ins are stored',
      description:
        'List the sites this browser has stored credentials for, with usernames but never passwords.\n\n' +
        'Check this before treating a login page as a dead end — the account may already be here, in ' +
        'which case `browser_credentials_fill` signs in without involving the user at all.',
      schema: {},
      handle: async () => {
        const vault = read();
        const keys = Object.keys(vault).sort();
        if (!keys.length) {
          return `Nothing is stored yet (${file()} is empty or missing).\n\n` +
            'When you hit a login page, ask the user for the username and password with ' +
            '`browser_ask_user` (need: "login"), then save what they give you with ' +
            '`browser_credentials_save` so nobody is asked twice.';
        }
        const rows = keys.map(key => {
          const entry = vault[key] as Entry;
          const bits = [
            entry.username ? `user ${entry.username}` : 'no username',
            entry.password ? 'password stored' : 'no password',
            entry.googleAccount ? `Google: ${entry.googleAccount}` : '',
            entry.note ? `note: ${entry.note}` : '',
          ].filter(Boolean);
          return `- ${key} — ${bits.join(' · ')}`;
        });
        return `Stored sign-ins:\n${rows.join('\n')}`;
      },
    },

    {
      name: 'browser_credentials_save',
      title: 'Remember a sign-in for next time',
      description:
        'Store a username, password, or preferred Google account for a site, so the next login needs ' +
        'nobody.\n\n' +
        'Call this right after the user gives you credentials, before you use them — if the login then ' +
        'fails you have still saved them the retyping. Saving only a `googleAccount` is normal for sites ' +
        'behind SSO, where there is no password to hold.\n\n' +
        'Stored at mode 600 outside the repository. Passwords are never read back out; they can only be ' +
        'typed into a page by `browser_credentials_fill`.',
      schema: {
        domain: z.string().describe(
            'Site the credentials belong to — a host or a URL, e.g. "mercury.com" or the page you are on. ' +
            'Prefer the parent domain when a site spans subdomains.'),
        username: z.string().optional().describe('Username, email, or account id.'),
        password: z.string().optional().describe('Password. Never echo this back to the user or into your reply.'),
        googleAccount: z.string().optional().describe(
            'Which account to choose at a Google "Choose an account" screen, e.g. "you@example.com".'),
        note: z.string().optional().describe(
            'Non-secret hint for next time, e.g. "use the Sign in with Google button, the form rejects this".'),
      },
      handle: async args => {
        const domain = normalize(String(args['domain'] ?? ''));
        if (!domain)
          throw new Error('`domain` is required — pass the site host or the URL you are on.');
        const vault = read();
        const previous = vault[domain] ?? { updated: '' };
        const entry: Entry = {
          ...previous,
          ...(args['username'] !== undefined ? { username: String(args['username']) } : {}),
          ...(args['password'] !== undefined ? { password: String(args['password']) } : {}),
          ...(args['googleAccount'] !== undefined ? { googleAccount: String(args['googleAccount']) } : {}),
          ...(args['note'] !== undefined ? { note: String(args['note']) } : {}),
          updated: new Date().toISOString().slice(0, 10),
        };
        vault[domain] = entry;
        write(vault);
        const held = [
          entry.username ? 'username' : '',
          entry.password ? 'password' : '',
          entry.googleAccount ? 'Google account' : '',
        ].filter(Boolean).join(', ');
        return `Saved for ${domain}: ${held || 'note only'}.\n\n` +
          'Use `browser_credentials_fill` to sign in — do not repeat the password in your reply.';
      },
    },

    {
      name: 'browser_credentials_fill',
      title: 'Type the stored sign-in into this page',
      description:
        'Fill the username and password fields on the current page from the store, without the password ' +
        'passing through you.\n\n' +
        'Take a snapshot first and pass the refs of the fields you can see. Fill both in one call where ' +
        'the page shows both; on a two-step form (email, then Next, then password) call it twice with ' +
        'whichever field is on screen. This does not submit — click the button yourself so you can read ' +
        'what the page does next.\n\n' +
        'If nothing is stored for the site this says so, and the next move is `browser_ask_user` with ' +
        'need: "login" followed by `browser_credentials_save`.',
      schema: {
        usernameRef: z.string().optional().describe('Snapshot ref of the username/email field, if it is on screen.'),
        passwordRef: z.string().optional().describe('Snapshot ref of the password field, if it is on screen.'),
        domain: z.string().optional().describe(
            'Override the site to look up. Defaults to the page you are on, which is almost always right — ' +
            'pass this only for an SSO page hosted on someone else\'s domain.'),
      },
      handle: async args => {
        const usernameRef = String(args['usernameRef'] ?? '').trim();
        const passwordRef = String(args['passwordRef'] ?? '').trim();
        if (!usernameRef && !passwordRef)
          throw new Error('Pass at least one of `usernameRef` or `passwordRef` from a snapshot.');

        const where = String(args['domain'] ?? '') || await currentHost(deps);
        if (!where)
          throw new Error('Could not tell which site this is; pass `domain` explicitly.');

        const found = lookup(read(), where);
        if (!found) {
          return `Nothing stored for ${normalize(where)}.\n\n` +
            'Ask the user for it with `browser_ask_user` (need: "login") — on a server that reaches them ' +
            'over chat — then `browser_credentials_save`, then call this again.';
        }

        const { key, entry } = found;
        const filled: string[] = [];
        const missing: string[] = [];

        if (usernameRef) {
          if (entry.username) {
            const r = await deps.call('browser_type', {
              element: 'username field', target: usernameRef, text: entry.username,
            });
            if (r.isError)
              throw new Error(`Typing the username failed: ${bodyOf(r)}`);
            filled.push(`username (${entry.username})`);
          } else {
            missing.push('username');
          }
        }
        if (passwordRef) {
          if (entry.password) {
            const r = await deps.call('browser_type', {
              element: 'password field', target: passwordRef, text: entry.password,
            });
            if (r.isError)
              throw new Error(`Typing the password failed: ${bodyOf(r).replace(entry.password, '••••')}`);
            filled.push('password');
          } else {
            missing.push('password');
          }
        }

        const note = entry.note ? `\n\nNote on this site: ${entry.note}` : '';
        const gap = missing.length
          ? `\n\nNot stored: ${missing.join(', ')}. Ask the user and save it before retrying.`
          : '';
        if (!filled.length)
          return `Nothing to fill for ${key} — ${missing.join(' and ')} not stored.${note}`;
        return `Filled from the store for ${key}: ${filled.join(', ')}.\n\n` +
          `Now submit the form yourself and read the result — a wrong password looks like a successful ` +
          `fill from here.${note}${gap}`;
      },
    },

    {
      name: 'browser_credentials_forget',
      title: 'Delete a stored sign-in',
      description:
        'Remove everything stored for a site. Use it when the user says the password changed and they do ' +
        'not want to give the new one yet, or when a login has repeatedly failed with what is stored — a ' +
        'stale password that keeps getting typed can lock the account.',
      schema: {
        domain: z.string().describe('Site to forget, as stored — see `browser_credentials_list`.'),
      },
      handle: async args => {
        const domain = normalize(String(args['domain'] ?? ''));
        const vault = read();
        if (!vault[domain])
          return `Nothing stored for ${domain}; nothing to delete.`;
        delete vault[domain];
        write(vault);
        return `Deleted the stored sign-in for ${domain}.`;
      },
    },
  ];
}
