/**
 * The four directories this program writes to, found rather than counted.
 *
 * Every one of them used to be spelled `path.join(here, '..', '..', …)` at the
 * top of whichever file needed it — ten copies of the same arithmetic, each
 * correct only for the directory its file happened to sit in. Moving
 * `src/gateway.ts` to `src/gateway/index.ts` moved two of them one level: the
 * store's directory became `src/memory`, which is a *source* directory, and the
 * upstream's output directory became a path that does not exist.
 *
 * Neither failed. Every test and every eval passes these directories in
 * explicitly, so the defaults are exercised by exactly one caller — the
 * installed server — and it says nothing when it writes lessons into the source
 * tree. The bug was found by reading, which is not a control.
 *
 * So the depth is no longer counted. `packageRoot` is the nearest ancestor
 * holding a package.json, which is true from `src/`, from `scripts/analysis/`,
 * from `test/` and from anywhere else a file may later be moved to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package itself: the directory holding package.json. */
export const packageRoot = ((): string => {
  const from = path.dirname(fileURLToPath(import.meta.url));
  for (let dir = from; ; ) {
    if (fs.existsSync(path.join(dir, 'package.json')))
      return dir;
    const up = path.dirname(dir);
    if (up === dir)
      throw new Error(`no package.json in any directory above ${from}`);
    dir = up;
  }
})();

/** The checkout: the package, the browser profile, and the working directory. */
export const projectRoot = path.dirname(packageRoot);

/**
 * Everything produced while working — screenshots, downloads, scraped JSON, the
 * upstream's snapshots. Not source, never versioned, and safe to delete whole.
 *
 * It exists because the alternative was the repository root: agents write
 * relative paths, relative resolves against the working directory, and 7.5MB of
 * one-off artifacts accumulated there over four days, including a personal PDF
 * with nothing to do with this project.
 */
export const workDir = process.env['BROWSER_WORK_DIR'] || path.join(projectRoot, 'work');

/** Accumulated knowledge: lessons, procedures, the API map, the audit log. */
export const defaultMemoryDir = process.env['BROWSER_MEMORY_DIR'] || path.join(packageRoot, 'memory');

/**
 * Where the upstream drops per-session snapshots and console logs.
 *
 * Two processes have to agree on this: the upstream server writes here, and the
 * gateway reads what it wrote in order to turn a repeat snapshot into a
 * pointer. They agreed by accident before — both defaulted to a path relative
 * to a working directory that happened to be the same one — which is why one of
 * them could be moved without the other noticing. Now `outputDir` in
 * playwright-mcp.config.json names this path outright.
 */
export const defaultOutputDir = process.env['PLAYWRIGHT_MCP_OUTPUT_DIR'] || path.join(workDir, 'output');

/** The gateway's entrypoint, for the tests and scripts that spawn it. */
export const gatewayEntry = path.join(packageRoot, 'src', 'gateway', 'index.ts');
