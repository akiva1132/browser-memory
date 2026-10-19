/**
 * Where this program writes, asserted rather than assumed.
 *
 * Splitting `src/gateway.ts` into `src/gateway/` moved the file that computed
 * these paths one directory deeper without changing the `..`s it counted. The
 * store's directory silently became `src/memory` — a source directory — and the
 * upstream's output directory became a path that does not exist. Twenty-five
 * suites passed, because every one of them passes its directories in
 * explicitly: the defaults have exactly one caller, the installed server, and
 * it does not complain about writing lessons into the source tree.
 *
 * So this is the one check that runs them. It spawns a child with the overrides
 * removed from the environment, which is the only way to see what the installed
 * server sees from inside a test harness that always sets them.
 *
 * The last assertion is the interesting one. Two separate processes have to
 * agree on the output directory — the upstream writes snapshots there, the
 * gateway reads them back to turn a repeat snapshot into a pointer — and they
 * used to agree only because both defaulted to a path relative to a working
 * directory that happened to be shared. That is not agreement; it is a
 * coincidence that survived until someone moved a file. Now each names the path
 * outright, and this asserts the two names are the same string.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { packageRoot, projectRoot } from '../../src/lib/roots.ts';

const roots = new URL('../../src/lib/roots.ts', import.meta.url).href;

type Resolved = {
  packageRoot: string; projectRoot: string; workDir: string;
  memory: string; output: string; entry: string;
};

/** What `import roots.ts` resolves to in a process with this environment. */
function resolvedIn(overrides: Record<string, string | undefined>): Resolved {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) delete env[key];
  const script =
    `const r = await import(${JSON.stringify(roots)});\n` +
    `console.log(JSON.stringify({ packageRoot: r.packageRoot, projectRoot: r.projectRoot, ` +
    `workDir: r.workDir, memory: r.defaultMemoryDir, output: r.defaultOutputDir, entry: r.gatewayEntry }));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { env, encoding: 'utf8' }));
}

const CLEARED = { BROWSER_MEMORY_DIR: undefined, PLAYWRIGHT_MCP_OUTPUT_DIR: undefined, BROWSER_WORK_DIR: undefined };
const installed = resolvedIn(CLEARED);

// The package is found by its package.json, from whatever depth the importing
// file sits at. Both of these were wrong by exactly one level.
assert.equal(installed.packageRoot, packageRoot, 'the package root must not depend on who imports it');
assert.equal(installed.projectRoot, projectRoot, 'and neither must the project root');

assert.equal(installed.memory, path.join(packageRoot, 'memory'),
    'the store belongs beside the source, not inside it');
assert.ok(!installed.memory.startsWith(path.join(packageRoot, 'src') + path.sep),
    `the store would be written into the source tree: ${installed.memory}`);

assert.equal(installed.output, path.join(projectRoot, 'work', 'output'),
    'generated files belong under work/, which is not versioned');
assert.ok(!installed.output.startsWith(packageRoot + path.sep),
    `output would be written into the package: ${installed.output}`);

// An entrypoint that has moved is not a stale string somebody notices later:
// the MCP client spawns exactly this path and the server simply fails to start.
assert.ok(fs.existsSync(installed.entry), `the gateway entrypoint does not exist: ${installed.entry}`);
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
for (const [where, declared] of [['scripts.start', manifest.scripts.start.replace(/^node /, '')],
  ['bin.browser-gateway', manifest.bin['browser-gateway']]] as const)
  assert.equal(path.resolve(packageRoot, declared), installed.entry,
      `package.json ${where} points somewhere else`);

// The agreement between the two processes, stated once and checked here.
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'playwright-mcp.config.json'), 'utf8'));
assert.equal(config.outputDir, installed.output,
    'the upstream server and the gateway must name the same output directory');

// The overrides still win — the harnesses depend on it for every other suite.
const redirected = resolvedIn({ BROWSER_MEMORY_DIR: '/tmp/elsewhere', PLAYWRIGHT_MCP_OUTPUT_DIR: '/tmp/out' });
assert.equal(redirected.memory, '/tmp/elsewhere', 'BROWSER_MEMORY_DIR must still redirect the store');
assert.equal(redirected.output, '/tmp/out', 'PLAYWRIGHT_MCP_OUTPUT_DIR must still redirect the output');

const shown = (p: string) => path.relative(projectRoot, p) || '.';
console.log(`  store → ${shown(installed.memory)}, output → ${shown(installed.output)}, both agreed with by the config`);
console.log('ROOTS OK');
