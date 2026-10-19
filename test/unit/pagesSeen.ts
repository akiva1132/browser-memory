/**
 * The landing page of every site, which the API map was never told about.
 *
 * Two loose variables and a rule split across two functions: the dispatcher
 * added the path it had just navigated to, and the miner — called next, on the
 * same navigation — cleared the set because the site had changed. In that
 * order. So the one path a navigation proves is a page was the one path that
 * never reached `apiMap.learn`, on every first visit to every site.
 *
 * Nothing could see it. `opened` was module state in the gateway, written by
 * one function and cleared by another, and neither was reachable from a test.
 *
 * The first case here is the bug. The rest are the reason the class exists at
 * all: the ordering is no longer something a caller can get wrong.
 */
import assert from 'node:assert/strict';

import { PagesSeen } from '../../src/capture/pagesSeen.ts';

{
  const pages = new PagesSeen();
  pages.saw('example.com', '/dashboard');
  pages.saw('other.com', '/login');
  assert.deepEqual([...pages.paths], ['/login'],
      'the path a navigation just proved is a page must survive the site change that carried it');
  console.log('  the landing path of a new site is kept, not cleared by its own arrival');
}

{
  const pages = new PagesSeen();
  pages.saw('example.com', '/a');
  pages.saw('example.com', '/b');
  pages.saw('example.com', '/a');
  assert.deepEqual([...pages.paths].sort(), ['/a', '/b'], 'paths on one site accumulate, deduped');
  console.log('  paths on the same site accumulate');
}

{
  const pages = new PagesSeen();
  assert.equal(pages.saw('example.com', '/'), true, 'the first navigation is a move');
  assert.equal(pages.saw('example.com', '/x'), false, 'a second page on the same site is not');
  assert.equal(pages.saw('other.com', '/'), true, 'leaving the site is');
  console.log('  a move is reported exactly when the site changed, which is what flushes the place map');
}

{
  const pages = new PagesSeen();
  assert.equal(pages.domain, '', 'no site until something is seen');
  pages.saw('example.com', '/');
  assert.equal(pages.domain, 'example.com', 'and then the one just arrived at');
  console.log('  the current site is whatever was last navigated to');
}

console.log('PAGES SEEN OK');
