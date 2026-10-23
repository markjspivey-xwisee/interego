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
  await purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: async () => true,
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
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: async () => true,
    fetcher: (async (input, init) => {
      if (init?.method === 'DELETE') deleted.push(String(input));
      return new Response('ldp:contains <https://css.example/victim/secret.json> .');
    }) as typeof fetch }), /foreign/);
  assert.equal(deleted.length, 0);
});
test('cleanup refuses traversal overflow before its first mutation', async () => {
  let deletions = 0;
  await assert.rejects(purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: async () => true,
    fetcher: (async (_input, init) => {
      if (init?.method === 'DELETE') deletions++;
      return new Response(`ldp:contains ${Array.from({ length: 129 }, (_, i) => `<${i}.json>`).join(', ')} .`);
    }) as typeof fetch }), /limit/);
  assert.equal(deletions, 0);
});
test('fresh credential enrollment exempts the pod even after traversal', async () => {
  let deletions = 0;
  await purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: async () => false,
    fetcher: (async (_input, init) => {
      if (init?.method === 'DELETE') deletions++;
      return new Response('ldp:contains <auth-methods.jsonld> .');
    }) as typeof fetch });
  assert.equal(deletions, 0);
});
test('cleanup never accepts non-Play owner identifiers', async () => {
  await assert.rejects(purgeProvisionalPlayPod({ userId: 'canonical-owner', cssUrl, stillUnclaimed: async () => true }), /non-Play/);
});
