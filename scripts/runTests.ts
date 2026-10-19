#!/usr/bin/env node
/**
 * Runs every test in a directory, in order, and stops at the first failure.
 *
 *   node scripts/runTests.ts test/unit
 *   node scripts/runTests.ts test/browser
 *
 * The list used to live in `package.json`, spelled out one file at a time, and
 * the failure mode of that is silent: a test file is added, nobody remembers to
 * wire it in, and it never runs again. It reads as covered because the file
 * exists. This has happened here.
 *
 * A directory is the list. Adding a file adds a test, deleting one removes it,
 * and neither requires editing anything else.
 *
 * Sequential on purpose. The browser suite drives one real Chrome and cannot be
 * parallel at all, and the unit suite writes into temp directories whose names
 * come from the test — running those concurrently would trade a clear failure
 * for an intermittent one.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/runTests.ts <directory>');
  process.exit(2);
}

const files = (await fs.readdir(dir))
    .filter(name => name.endsWith('.ts'))
    .sort();

if (!files.length) {
  // Not a pass. An empty suite that reports success is the same lie as a test
  // nobody wired in.
  console.error(`no tests found in ${dir}`);
  process.exit(2);
}

const run = (file: string): Promise<number> => new Promise(resolve => {
  const child = spawn('node', [path.join(dir, file)], { stdio: 'inherit' });
  child.on('exit', code => resolve(code ?? 1));
});

const started = Date.now();
for (const file of files) {
  const code = await run(file);
  if (code !== 0) {
    console.error(`\n✖ ${path.join(dir, file)} failed (exit ${code})`);
    process.exit(code);
  }
}
console.log(`\n${files.length} suite(s) in ${dir} — ${Math.round((Date.now() - started) / 1000)}s`);
