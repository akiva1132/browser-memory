/**
 * A procedure is code an agent wrote, stored permanently, and executed inside a
 * browser holding live sessions for everything its owner uses. The agent that
 * writes it has just been reading web pages, and a hostile page can steer what
 * an agent does next — so a saved procedure has to be treated as attacker-
 * influenced input, not as trusted code.
 *
 * What this module does: refuse the shapes an exfiltration payload needs. A
 * procedure reads from the site it runs on and returns the result; it has no
 * reason to send data somewhere else, read raw cookies, or build code at
 * runtime.
 *
 * What it does NOT do, and what an earlier version of this comment claimed:
 * guarantee a human sees every procedure. Saving one is an ordinary MCP tool
 * call, and clients grant permission per tool name — so once `procedure_save`
 * is allowed once, or the session runs in auto-accept, later procedures are
 * saved without anyone reading them. The elicitation prompt is a courtesy that
 * fires when the client supports it and the user has not already blanket-
 * approved the tool. Treating it as the control that catches what these rules
 * miss would be a false sense of one.
 *
 * The controls that always hold are narrower and worth stating plainly: a
 * procedure runs only on its declared origin, anything state-changing needs an
 * explicit confirm, and the code is filtered for credentials before it is
 * stored.
 */

export type Finding = {
  rule: string;
  why: string;
  evidence: string;
};

/**
 * Absolute URLs are the giveaway. A legitimate procedure talks to its own site
 * with a relative path; an absolute URL to anywhere else is either pointless or
 * the whole point of the attack.
 */
function foreignTargets(code: string, origin: string): string[] {
  const urls = code.match(/(['"`])(https?:\/\/[^'"`\s]+)\1/g) ?? [];
  return urls
      .map(quoted => quoted.slice(1, -1))
      .filter(url => {
        try {
          return new URL(url).origin !== new URL(origin).origin;
        } catch {
          return true;
        }
      });
}

const RULES: { rule: string; pattern: RegExp; why: string }[] = [
  {
    rule: 'runtime-code-generation',
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bimport\s*\(/,
    why: 'builds code at runtime, which hides what the procedure actually does from this review and from you',
  },
  {
    rule: 'raw-cookie-access',
    pattern: /document\s*\.\s*cookie/,
    why: 'reads raw cookies. The browser already attaches them to same-origin requests, so a procedure that needs to read them is collecting credentials, not doing work',
  },
  {
    rule: 'beacon-exfiltration',
    pattern: /navigator\s*\.\s*sendBeacon|new\s+WebSocket|new\s+EventSource/,
    why: 'opens a side channel out of the page',
  },
  {
    rule: 'credential-storage-sweep',
    pattern: /(localStorage|sessionStorage)\s*\.\s*(valueOf|toString)|JSON\.stringify\s*\(\s*(localStorage|sessionStorage)\s*\)|Object\.(keys|entries)\s*\(\s*(localStorage|sessionStorage)\s*\)/,
    why: 'dumps an entire storage area rather than reading a named key, which is what a credential sweep looks like',
  },
  {
    rule: 'dynamic-script-injection',
    pattern: /createElement\s*\(\s*['"`]script|\.innerHTML\s*=|insertAdjacentHTML/,
    why: 'injects markup or script into the page',
  },
];

/**
 * @param code the procedure body
 * @param origin the origin it declares it runs on
 */
export function reviewProcedureCode(code: string, origin: string): Finding[] {
  const findings: Finding[] = [];

  for (const { rule, pattern, why } of RULES) {
    const match = pattern.exec(code);
    if (match)
      findings.push({ rule, why, evidence: match[0] });
  }

  for (const target of foreignTargets(code, origin)) {
    findings.push({
      rule: 'cross-origin-request',
      why: `sends or fetches from ${target}, which is not ${origin}. This is how data leaves an authenticated session`,
      evidence: target,
    });
  }

  return findings;
}

export function explainFindings(findings: Finding[]): string {
  return findings.map(finding =>
    `- **${finding.rule}** — ${finding.why}\n  found: \`${finding.evidence}\``).join('\n');
}
