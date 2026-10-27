import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { purgeProvisionalPlayPod } from '../provisional-play-cleanup.js';
const userId = `u-try-play-${'a'.repeat(32)}`;
const cssUrl = 'https://css.example/';
const root = `${cssUrl}${userId}/`;
test('cleanup removes bounded own-pod resources, with auth anchor retained until last', async () => {
  const deleted: string[] = [];
  const listings = new Map([[root, 'ldp:contains <auth-methods.jsonld>, <resources/>, <agents> .'],
    [`${root}resources/`, 'ldp:contains <checkpoint.with.dots.json> .']]);
  await purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: async () => ({ ok: true, etag: null }),
    fetcher: (async (input, init) => {
      const url = String(input);
      if (init?.method === 'DELETE') { deleted.push(url); return new Response(null, { status: 204 }); }
      return new Response(listings.get(url), { status: 200 });
    }) as typeof fetch });
  assert.ok(deleted.includes(`${root}resources/checkpoint.with.dots.json`));
  assert.deepEqual(deleted.slice(-2), [`${root}auth-methods.jsonld`, root]);
});
test('cleanup discovers foreign references and refuses all deletes', async () => {
  const deleted: string[] = [];
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: async () => ({ ok: true, etag: null }),
    fetcher: (async (input, init) => {
      if (init?.method === 'DELETE') deleted.push(String(input));
      return new Response('ldp:contains <https://css.example/victim/secret.json> .');
    }) as typeof fetch }), /foreign/);
  assert.equal(deleted.length, 0);
});
test('cleanup refuses traversal overflow before its first mutation', async () => {
  let deletions = 0;
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: async () => ({ ok: true, etag: null }),
    fetcher: (async (_input, init) => {
      if (init?.method === 'DELETE') deletions++;
      return new Response(`ldp:contains ${Array.from({ length: 129 }, (_, i) => `<${i}.json>`).join(', ')} .`);
    }) as typeof fetch }), /limit/);
  assert.equal(deletions, 0);
});
test('fresh credential enrollment exempts the pod even after traversal', async () => {
  let deletions = 0;
  await purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: async () => ({ ok: false, etag: null }),
    fetcher: (async (_input, init) => {
      if (init?.method === 'DELETE') deletions++;
      return new Response('ldp:contains <auth-methods.jsonld> .');
    }) as typeof fetch });
  assert.equal(deletions, 0);
});
test('the anchor is deleted only if it is still the record read: an enrolment since keeps the account', async () => {
  const deleted: string[] = [];
  const conditions: Array<string | null> = [];
  let enrolledSinceRead = false;
  const result = await purgeProvisionalPlayPod({ userId, cssUrl,
    stillUnclaimed: async () => ({ ok: true, etag: '"1700000000000-application/ld+json"' }),
    fetcher: (async (input, init) => {
      const url = String(input);
      if (init?.method === 'DELETE') {
        const ifMatch = new Headers(init.headers).get('if-match');
        conditions.push(ifMatch);
        // Another instance enrolled a credential after the read: the anchor's ETag moved on.
        if (url === `${root}auth-methods.jsonld`) {
          enrolledSinceRead = true;
          if (ifMatch !== '"1700000000001-application/ld+json"') return new Response(null, { status: 412 });
        }
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response(url === root ? 'ldp:contains <auth-methods.jsonld>, <checkpoint> .' : '', { status: 200 });
    }) as typeof fetch });
  assert.equal(result, 'kept');
  assert.ok(enrolledSinceRead);
  assert.ok(!deleted.includes(`${root}auth-methods.jsonld`));
  assert.ok(!deleted.includes(root), 'the container stays');
  // Only the anchor's DELETE is conditional, on the ETag the decision was read under.
  assert.deepEqual(conditions, [null, '"1700000000000-application/ld+json"']);
});
test('cleanup never accepts non-Play owner identifiers', async () => {
  await assert.rejects(purgeProvisionalPlayPod({ userId: 'canonical-owner', cssUrl, stillUnclaimed: async () => ({ ok: true, etag: null }) }), /non-Play/);
});
