/**
 * An agent fetched something from the page and got data back. That is proof.
 *
 * This was a method on the Observer called `_apiShortcut`, sitting in the list
 * of detectors, declared to return `Candidate[]` — and returning `[]` from
 * every exit it has. It could not detect anything. Anyone reading `saw()` saw
 * three detectors and would reasonably assume all three could produce a lesson;
 * two can.
 *
 * The shape is left over. It used to write a `fast-path` lesson saying "GET
 * /path returns data directly", which is what the API map is for and which the
 * map already knew — the agent's own fetch is a request the traffic miner
 * watches go past. One call then produced an endpoint here, a lesson there, a
 * promotion suggestion and a draft candidate: four records of one fact across
 * three stores, each with its own spelling of the path. The lesson was removed
 * and the empty detector stayed.
 *
 * What the lesson did carry that the map did not is the code that worked, so
 * that comes across. Which makes this a function of the API map, not of the
 * thing watching the browser, and it is named for what it records rather than
 * for the lesson it no longer writes.
 */
import { ApiMap } from './apiMap.ts';
import {
  clip, describePayload, endpointOf, FETCH_CALL, METHOD_OPTION, MIN_PAYLOAD_CHARS, payloadOf,
  XHR_OPEN,
} from './evidence.ts';
import { redactCode } from '../lib/redact.ts';

/** The endpoint a `browser_evaluate` called, if it called one on this site. */
function calledEndpoint(
  domain: string, code: string,
): { method: string; path: string } | undefined {
  const xhr = XHR_OPEN.exec(code);
  const fetched = FETCH_CALL.exec(code);
  const raw = xhr?.[2] ?? fetched?.[1];
  if (!raw)
    return undefined;
  // An absolute URL to somewhere else is not this site's API.
  if (/^https?:\/\//i.test(raw) && !raw.includes(domain))
    return undefined;
  const method = (xhr?.[1] ?? METHOD_OPTION.exec(code)?.[1] ?? 'GET').toUpperCase();
  return { method, path: endpointOf(raw).path };
}

/**
 * Records proof against the endpoint, or does nothing.
 *
 * Nothing is the ordinary case: most `browser_evaluate` calls read the DOM.
 * Returns the promise of the write rather than awaiting it, because the caller
 * settles every proof together before reporting the call as watched — a write
 * left in flight is a write that lands only sometimes.
 */
export function proveFromEvaluate(
  map: ApiMap, domain: string, tool: string, args: Record<string, unknown>, body: string,
): Promise<void> | undefined {
  if (tool !== 'browser_evaluate')
    return undefined;
  const code = typeof args['function'] === 'string' ? args['function'] : '';
  // Measured on what came back, not on the reply that carries it.
  const payload = payloadOf(body);
  if (!code || payload.length < MIN_PAYLOAD_CHARS)
    return undefined;
  const called = calledEndpoint(domain, code);
  if (!called)
    return undefined;
  // `prove` adds the endpoint when the map has not seen it yet rather than
  // declining — mining runs on a timer and on leaving a domain, so a route an
  // agent fetched and got data from is routinely not there at the moment it is
  // proved. Its own interface test still applies, so an agent fetching an HTML
  // page does not turn into an endpoint here.
  return map.prove(
      domain, called.method, called.path,
      clip(redactCode(code).text, 600), describePayload(payload));
}
