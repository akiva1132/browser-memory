/**
 * Where does a site actually land in the agent browser? Answers the question
 * "am I still logged in" against the real CDP-attached Chrome, rather than
 * whatever browser a stale MCP session happens to own.
 *
 *   node scripts/checkAuth.ts https://hpanel.hostinger.com/ https://dash.cloudflare.com/
 */
import { Harness } from '../test/harness.ts';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('Usage: node scripts/checkAuth.ts <url> [url...]');
  process.exit(1);
}

const harness = await Harness.start(process.env['BROWSER_MEMORY_DIR'] ?? '/tmp/check-auth-memory');

for (const url of urls) {
  await harness.call('browser_navigate', { url });
  const seen = await harness.text('browser_evaluate', {
    function: '() => location.href + " :: " + document.title',
  });
  const landed = seen.match(/(https?:\/\/[^\s"]+) :: (.*)/);
  const finalUrl = landed?.[1] ?? '(unknown)';
  const signedOut = /login|signin|sign-in|auth\./i.test(finalUrl);
  console.log(`${signedOut ? 'SIGNED OUT' : 'signed in '}  ${url}\n            → ${finalUrl}`);
}

await harness.close();
