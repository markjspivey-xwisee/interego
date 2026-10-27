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
/**
 * A pod with an anchor (ETag versioned) and one other resource. `enrolAfterRead` (the other
 * instance's enrolment, during a deploy's overlap) changes the anchor after stillUnclaimed read it,
 * as the first request after that read arrives.
 */
function anchoredPod(enrolAfterRead: boolean) {
  let version = 1;
  const etag = () => `"${version}-application/ld+json"`;
  const anchorUrl = `${root}auth-methods.jsonld`;
  const requests: Array<{ method: string; url: string; ifMatch: string | null; status: number }> = [];
  const present = new Set([root, anchorUrl, `${root}checkpoint`]);
  let read = false;
  let enrolled = false;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const ifMatch = new Headers(init?.headers).get('if-match');
    if (method !== 'GET' && read && enrolAfterRead && !enrolled) { enrolled = true; version++; }
    const answer = (status: number, body?: string) => { requests.push({ method, url, ifMatch, status }); return new Response(body ?? null, { status }); };
    if (method === 'GET') return answer(200, url === root ? 'ldp:contains <auth-methods.jsonld>, <checkpoint> .' : '');
    if (method === 'PUT') {
      if (ifMatch !== etag()) return answer(412);
      version++;
      return answer(205);
    }
    if (method === 'DELETE') { present.delete(url); return answer(205); }
    return answer(405);
  }) as typeof fetch;
  const stillUnclaimed = async () => { read = true; return { ok: true, etag: etag(), document: { userId, provisionalPlayAnchor: 'ipa1_x' } }; };
  return { fetcher, stillUnclaimed, requests, present, anchorUrl };
}

test('an enrolment that lands after the decision keeps the whole account: the fence comes before any deletion', async () => {
  const pod = anchoredPod(true);
  const result = await purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: pod.stillUnclaimed, fetcher: pod.fetcher });
  assert.equal(result, 'kept');
  // The anchor was written back on the ETag read, refused (412), and nothing was deleted.
  assert.deepEqual(pod.requests.filter(r => r.method !== 'GET').map(r => [r.method, r.url, r.status]),
    [['PUT', pod.anchorUrl, 412]]);
  assert.ok(pod.present.has(`${root}checkpoint`), 'the guest\'s files stay');
  assert.ok(pod.present.has(pod.anchorUrl) && pod.present.has(root));
});

test('without an enrolment, the fence lands first and then everything goes, the anchor last but the root', async () => {
  const pod = anchoredPod(false);
  const result = await purgeProvisionalPlayPod({ userId, cssUrl, stillUnclaimed: pod.stillUnclaimed, fetcher: pod.fetcher });
  assert.equal(result, 'purged');
  assert.deepEqual(pod.requests.filter(r => r.method !== 'GET').map(r => [r.method, r.url, r.ifMatch, r.status]), [
    ['PUT', pod.anchorUrl, '"1-application/ld+json"', 205],
    ['DELETE', `${root}checkpoint`, null, 205],
    ['DELETE', pod.anchorUrl, null, 205],
    ['DELETE', root, null, 205],
  ]);
});

test('cleanup never accepts non-Play owner identifiers', async () => {
  await assert.rejects(purgeProvisionalPlayPod({ userId: 'canonical-owner', cssUrl, stillUnclaimed: async () => ({ ok: true, etag: null }) }), /non-Play/);
});
