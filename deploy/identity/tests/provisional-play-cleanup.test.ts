import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { purgeProvisionalPlayPod } from '../provisional-play-cleanup.js';
const userId = `u-try-play-${'a'.repeat(32)}`;
const cssUrl = 'https://css.example/';
const root = `${cssUrl}${userId}/`;
const anchor = `${root}auth-methods.jsonld`;
test('cleanup closes the account once the tree is checked, then removes the other resources; the record and its container stay', async () => {
  const events: string[] = [];
  const listings = new Map([[root, 'ldp:contains <auth-methods.jsonld>, <resources/>, <agents> .'],
    [`${root}resources/`, 'ldp:contains <checkpoint.with.dots.json> .']]);
  const result = await purgeProvisionalPlayPod({ userId, cssUrl, close: async () => { events.push('close'); return 'purge'; },
    fetcher: (async (input, init) => {
      const url = String(input);
      events.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(listings.get(url), { status: 200 });
    }) as typeof fetch });
  assert.deepEqual(result, { outcome: 'purged', retained: [] });
  const closedAt = events.indexOf('close');
  assert.ok(closedAt > 0 && events.slice(0, closedAt).every(e => e.startsWith('GET ')), `the tree is listed, and nothing changed, before the account is closed: ${events}`);
  const deleted = events.filter(e => e.startsWith('DELETE ')).map(e => e.slice('DELETE '.length));
  assert.deepEqual(deleted, [`${root}resources/checkpoint.with.dots.json`, `${root}resources/`, `${root}agents`], 'children before their containers');
  assert.ok(events.indexOf(`DELETE ${deleted[0]}`) > closedAt, 'every deletion follows the close');
  // The record stays, as the tombstone close() wrote: a write still pending from before the purge
  // is conditional on its ETag, which CSS 7.2 would apply to a missing document. It used to be
  // deleted last but the root.
  assert.equal(deleted.includes(anchor), false);
  assert.equal(deleted.includes(root), false);
});
test('cleanup discovers foreign references and refuses all deletes', async () => {
  const deleted: string[] = [];
  let closed = 0;
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, close: async () => { closed++; return 'purge'; },
    fetcher: (async (input, init) => {
      if (init?.method === 'DELETE') deleted.push(String(input));
      return new Response('ldp:contains <https://css.example/victim/secret.json> .');
    }) as typeof fetch }), /foreign/);
  assert.equal(deleted.length, 0);
  assert.equal(closed, 0, 'the account is not closed either');
});
test('cleanup refuses traversal overflow before its first mutation', async () => {
  let deletions = 0;
  let closed = 0;
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, close: async () => { closed++; return 'purge'; },
    fetcher: (async (_input, init) => {
      if (init?.method === 'DELETE') deletions++;
      return new Response(`ldp:contains ${Array.from({ length: 129 }, (_, i) => `<${i}.json>`).join(', ')} .`);
    }) as typeof fetch }), /limit/);
  assert.equal(deletions, 0);
  assert.equal(closed, 0);
});
test('an account close() keeps (an enrolment landed, or its anchor has not expired) keeps every resource', async () => {
  let deletions = 0;
  const result = await purgeProvisionalPlayPod({ userId, cssUrl, close: async () => 'kept',
    fetcher: (async (_input, init) => {
      if (init?.method === 'DELETE') deletions++;
      return new Response('ldp:contains <auth-methods.jsonld>, <checkpoint> .');
    }) as typeof fetch });
  assert.deepEqual(result, { outcome: 'kept', retained: [] });
  assert.equal(deletions, 0);
});
test('a record that is a tombstone no purge marked (a deletion\'s, whose owner may be provisioned again) keeps every resource', async () => {
  // The other instance's provisioning does not wait for this server's lock, and may put the owner
  // back over a deletion's tombstone until its guest deadline: deleting now could delete the
  // resources of an owner provisioned again meanwhile. It used to be purged like any other.
  let deletions = 0;
  const result = await purgeProvisionalPlayPod({ userId, cssUrl, close: async () => 'closed',
    fetcher: (async (_input, init) => {
      if (init?.method === 'DELETE') deletions++;
      return new Response('ldp:contains <auth-methods.jsonld>, <checkpoint> .');
    }) as typeof fetch });
  assert.deepEqual(result, { outcome: 'closed', retained: [] });
  assert.equal(deletions, 0);
});
test('a deletion that fails after the close throws, so its caller keeps the purge for another pass, and one sent again finishes it', async () => {
  const deleted: string[] = [];
  let failing = 1;
  const run = () => purgeProvisionalPlayPod({ userId, cssUrl, close: async () => 'purge',
    fetcher: (async (input, init) => {
      if (init?.method !== 'DELETE') return new Response('ldp:contains <auth-methods.jsonld>, <checkpoint>, <agents> .');
      if (String(input).endsWith('/checkpoint') && failing-- > 0) return new Response(null, { status: 500 });
      deleted.push(String(input));
      return new Response(null, { status: deleted.length > 1 ? 404 : 205 });
    }) as typeof fetch });
  await assert.rejects(run(), /deletion incomplete/);
  assert.deepEqual(deleted, []);
  assert.equal((await run()).outcome, 'purged');
  assert.deepEqual(deleted, [`${root}checkpoint`, `${root}agents`]);
});
test('a document the pod refuses to delete with 409 (a native-committed head) is kept, the containers that hold it are not asked, and the purge finishes', async () => {
  // A guest's game save and write budget, as the production store keeps them: native heads, whose
  // every plain DELETE is a 409, and whose containers are not empty while they stay. The purge used
  // to throw at the first such 409, so it never finished, and was sent again at every pass.
  const save = `${root}hallowmarch/checkpoints/${'b'.repeat(64)}.json`;
  const budget = `${root}play-budget.json`;
  const listings = new Map([
    [root, 'ldp:contains <agents>, <auth-methods.jsonld>, <hallowmarch/>, <play-budget.json>, <profile/> .'],
    [`${root}hallowmarch/`, 'ldp:contains <checkpoints/> .'],
    [`${root}hallowmarch/checkpoints/`, `ldp:contains <${'b'.repeat(64)}.json> .`],
    [`${root}profile/`, 'ldp:contains <card> .'],
  ]);
  const deletes: Array<[string, number]> = [];
  const result = await purgeProvisionalPlayPod({ userId, cssUrl, close: async () => 'purge',
    fetcher: (async (input, init) => {
      const url = String(input);
      if (init?.method !== 'DELETE') return new Response(listings.get(url) ?? '', { status: listings.has(url) ? 200 : 404 });
      const status = url === save || url === budget || url.startsWith(`${root}hallowmarch/`) ? 409 : 205;
      deletes.push([url, status]);
      return new Response(null, { status });
    }) as typeof fetch });
  assert.deepEqual(result, { outcome: 'purged', retained: [save, budget] });
  assert.deepEqual(deletes, [[`${root}agents`, 205], [save, 409], [budget, 409], [`${root}profile/card`, 205], [`${root}profile/`, 205]],
    'every other resource is deleted, an emptied container included; the containers of a kept head are not sent a DELETE');
});
test('a 409 on a container that holds nothing kept fails the pass, as any refused deletion does', async () => {
  // Something written in it since the listing: the next pass lists it again.
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, close: async () => 'purge',
    fetcher: (async (input, init) => {
      const url = String(input);
      if (init?.method === 'DELETE') return new Response(null, { status: url.endsWith('/') ? 409 : 205 });
      return new Response(url === root ? 'ldp:contains <auth-methods.jsonld>, <resources/> .' : 'ldp:contains <a.json> .');
    }) as typeof fetch }), /deletion incomplete/);
});
test('a close that fails changes nothing more', async () => {
  let deletions = 0;
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, close: async () => { throw new Error('pod unavailable'); },
    fetcher: (async (_input, init) => {
      if (init?.method === 'DELETE') deletions++;
      return new Response('ldp:contains <auth-methods.jsonld>, <checkpoint> .');
    }) as typeof fetch }), /pod unavailable/);
  assert.equal(deletions, 0);
});
test('cleanup never accepts non-Play owner identifiers', async () => {
  await assert.rejects(purgeProvisionalPlayPod({ userId: 'canonical-owner', cssUrl, close: async () => 'purge' }), /non-Play/);
});
