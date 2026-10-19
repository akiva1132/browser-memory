/**
 * Serves the measurement fixtures over http, because the browser server blocks
 * the `file:` protocol — a setting worth keeping, since a page that can be
 * opened from disk is a page an agent can be talked into opening from disk.
 *
 * Deliberately a fixture and not a live site. Both things being measured need
 * conditions a real site supplies only by accident: a control that cannot be
 * clicked, and a page that changes without navigating. Measuring those against
 * somebody's production dashboard means measuring whatever they shipped today.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env['FIXTURE_PORT'] ?? 8977);

export function serveFixtures(port = PORT): Promise<http.Server> {
  const server = http.createServer(async (request, response) => {
    const name = path.basename(new URL(request.url ?? '/', 'http://x').pathname) || 'index.html';
    try {
      const body = await fs.readFile(path.join(here, name));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await serveFixtures();
  console.log(`fixtures on http://127.0.0.1:${PORT}/`);
}
