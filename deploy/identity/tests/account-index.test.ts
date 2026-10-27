/**
 * The account index must never mistake a pod it could not read for a pod without
 * credentials. That mistake left the identity server knowing 8 of 445 accounts after a
 * restart: tokens failed "User for token not found", passkeys failed "No passkey found",
 * and people registered new accounts to get back in.
 *
 * Run:
 *   node --test --import tsx tests/account-index.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { listPods, loadAccounts, podResourceExists, PodReadError, readPodJson, type FetchLike } from '../account-index.js';

const reply = (status: number, body = '', statusText = ''): FetchLike => async () => ({
  ok: status >= 200 && status < 300, status, statusText, text: async () => body,
});

test('readPodJson returns the document, or null only for a 404', async () => {
  assert.deepEqual(await readPodJson(reply(200, '{"userId":"u-pk-1"}'), 'http://css/u-pk-1/auth-methods.jsonld'), { userId: 'u-pk-1' });
  assert.equal(await readPodJson(reply(404), 'http://css/u-pk-1/auth-methods.jsonld'), null);
});

test('readPodJson throws PodReadError for every failure that is not a 404', async () => {
  const url = 'http://css/u-pk-1/auth-methods.jsonld';
  for (const f of [reply(500, '', 'Internal Server Error'), reply(502), reply(401), reply(200, '<html>not json</html>'),
    (async () => { throw new Error('ECONNRESET'); }) as FetchLike]) {
    await assert.rejects(readPodJson(f, url), (err: unknown) => err instanceof PodReadError && (err as PodReadError).url === url);
  }
});

test('podResourceExists asks with HEAD: true for 2xx, false only for 404 and 410, PodReadError otherwise', async () => {
  const url = 'http://css/u-eth-0123456789ab/profile/card';
  const methods: Array<string | undefined> = [];
  const seen = (status: number): FetchLike => async (_u, init) => { methods.push(init?.method); return (await reply(status)(_u, init)); };
  assert.equal(await podResourceExists(seen(200), url), true);
  assert.equal(await podResourceExists(seen(204), url), true);
  assert.equal(await podResourceExists(seen(404), url), false);
  assert.equal(await podResourceExists(seen(410), url), false);
  assert.deepEqual(methods, ['HEAD', 'HEAD', 'HEAD', 'HEAD']);
  for (const f of [reply(500), reply(502), reply(401), reply(403), (async () => { throw new Error('ECONNRESET'); }) as FetchLike]) {
    await assert.rejects(podResourceExists(f, url), (err: unknown) => err instanceof PodReadError && (err as PodReadError).url === url);
  }
});

test('listPods reads the root container, and a failed listing is an error, not an empty server', async () => {
  const root = `@prefix ldp: <http://www.w3.org/ns/ldp#> .
<> a ldp:Container ; ldp:contains <u-pk-aaa/>, <u-eth-bbb/>, <.well-known/>, <readme.md> ;
   ldp:contains <u-pk-aaa/> .`;
  assert.deepEqual(await listPods(reply(200, root), 'http://css/'), ['u-pk-aaa', 'u-eth-bbb']);
  assert.deepEqual(await listPods(reply(200, '<> a <http://www.w3.org/ns/ldp#Container> .'), 'http://css/'), []);
  await assert.rejects(listPods(reply(503), 'http://css/'), PodReadError);
});

test('listPods reads every child, whatever a name before it holds', async () => {
  // The live root on 2026-10-23: a file whose name has a '.' sorts between `markj/` and
  // every account pod, and the listing used to stop at that '.', so no `u-` pod was loaded.
  const root = `@prefix ldp: <http://www.w3.org/ns/ldp#>.
<> ldp:contains <agent/>, <markj/>, <provisional-play-admission.json>, <svc-relay-dcr/>, <u-did-6de86e8ba294/>,
    <u-eth-8f3b8e939600/>, <u-pk-f2a9c751075a/>, <odd;name/>, <u-try-play-b3b2/>.
<agent/> a ldp:Container.`;
  assert.deepEqual(await listPods(reply(200, root), 'http://css/'), [
    'agent', 'markj', 'svc-relay-dcr', 'u-did-6de86e8ba294', 'u-eth-8f3b8e939600', 'u-pk-f2a9c751075a', 'odd;name', 'u-try-play-b3b2',
  ]);
  await assert.rejects(listPods((async () => { throw new Error('ETIMEDOUT'); }) as FetchLike, 'http://css/'), PodReadError);
});

test('loadAccounts loads, skips and retries until every pod is read', async () => {
  const failuresLeft = new Map([['u-pk-slow', 2]]);
  const slept: number[] = [];
  const report = await loadAccounts({
    list: async () => ['u-pk-a', 'svc-relay', 'u-pk-slow'],
    load: async name => {
      const left = failuresLeft.get(name) ?? 0;
      if (left > 0) { failuresLeft.set(name, left - 1); throw new PodReadError(name, '502'); }
      return name.startsWith('u-');
    },
    retryDelaysMs: [10, 20, 30],
    sleep: async ms => { slept.push(ms); },
  });
  assert.deepEqual({ ...report, finishedAt: '' }, {
    listed: true, attempted: 3, loaded: 2, skipped: 1, unreadable: [], rounds: 3, finishedAt: '',
  });
  assert.deepEqual(slept, [10, 20]);
});

test('a pod that never answers is reported unreadable, never counted as skipped', async () => {
  const report = await loadAccounts({
    list: async () => ['u-pk-a', 'u-pk-down'],
    load: async name => { if (name === 'u-pk-down') throw new PodReadError(name, 'timeout'); return true; },
    retryDelaysMs: [1, 1],
    sleep: async () => {},
  });
  assert.equal(report.loaded, 1);
  assert.equal(report.skipped, 0);
  assert.deepEqual(report.unreadable, ['u-pk-down']);
  assert.equal(report.rounds, 3);
});

test('loadAccounts retries the listing, and says so when the root never lists', async () => {
  let calls = 0;
  const later = await loadAccounts({
    list: async () => { if (++calls < 3) throw new PodReadError('http://css/', '503'); return ['u-pk-a']; },
    load: async () => true,
    retryDelaysMs: [1, 1, 1],
    sleep: async () => {},
  });
  assert.equal(later.listed, true);
  assert.equal(later.loaded, 1);
  const never = await loadAccounts({
    list: async () => { throw new PodReadError('http://css/', '503'); },
    load: async () => true,
    retryDelaysMs: [1],
    sleep: async () => {},
  });
  assert.equal(never.listed, false);
  assert.equal(never.attempted, 0);
});

test('`only` retries just the named pods, without listing', async () => {
  const seen: string[] = [];
  const report = await loadAccounts({
    list: async () => { throw new Error('must not list'); },
    load: async name => { seen.push(name); return true; },
    only: ['u-pk-b', 'u-pk-c'],
    sleep: async () => {},
  });
  assert.deepEqual(seen.sort(), ['u-pk-b', 'u-pk-c']);
  assert.equal(report.loaded, 2);
});

test('concurrency caps how many pods are read at once', async () => {
  let inFlight = 0, peak = 0;
  await loadAccounts({
    list: async () => Array.from({ length: 40 }, (_, i) => `u-pk-${i}`),
    load: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
      return true;
    },
    concurrency: 4,
  });
  assert.equal(peak, 4);
});
