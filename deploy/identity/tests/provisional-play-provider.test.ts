import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { createProvisionalPlayProvider } from '../provisional-play-provider.js';
import { publicPlayKey, playKeyThumbprint, bootstrapProofPayload, PlayError } from '../provisional-play.js';

function adapterFixture(overrides: { verified?: boolean; subject?: string; canSign?: boolean; recover?: string; missingEtag?: boolean } = {}) {
  const audience = 'https://play.example';
  const client = { agentDid: 'did:web:identity.example:agents:game', podUrl: 'https://pods.example/game/' };
  const anchor = `0x${'11'.repeat(20)}`;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const documents = new Map<string, { body: string; revision: number }>();
  let issued = 0;
  let recoveredMessage = '';
  const options = {
    issuer: 'https://identity.example', cssUrl: 'https://css.internal.example/', publicPodBase: 'https://pods.example/',
    relayUrl: 'https://relay.example', signingKey: Buffer.alloc(32, 1), stableSigningKey: true,
    clientsJson: JSON.stringify({ [audience]: client }), listPods: async () => [],
    empty: c => ({ userId: c.userId, agentId: c.authenticatedAgentId }), committed: () => {},
    issueCredential: async () => { issued++; return { token: 'private-browser-credential' }; },
    recoverSigner: async (message: string) => { recoveredMessage = message; return overrides.recover ?? anchor; },
    fetcher: (async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url === 'https://relay.example/tool/verify_agent') return Response.json({
        verified: overrides.verified ?? true, subject_pod_url: overrides.subject ?? client.podUrl,
        signing: { relayAnchor: anchor, canSignDelegatedRequests: overrides.canSign ?? true },
      });
      if (init?.method === 'PUT') {
        const current = documents.get(url); const headers = init.headers as Record<string, string>;
        if ((headers['If-None-Match'] === '*' && current) || (headers['If-Match'] && headers['If-Match'] !== String(current?.revision)))
          return new Response(null, { status: 412 });
        documents.set(url, { body: String(init.body), revision: (current?.revision ?? 0) + 1 });
        return new Response(null, { status: 201 });
      }
      const current = documents.get(url);
      return current ? new Response(current.body, { headers: overrides.missingEtag ? {} : { etag: String(current.revision) } })
        : new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  const play = createProvisionalPlayProvider(options);
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyJwk = publicPlayKey(key.publicKey.export({ format: 'jwk' }));
  const now = Math.floor(Date.now() / 1000);
  const grant = { _signed_payload: JSON.stringify({ purpose: 'interego-play-provisional-v1', audience,
    publicKeyThumbprint: playKeyThumbprint(publicKeyJwk), challenge: 'a'.repeat(32), expiresAt: now + 60,
    agent_id: client.agentDid, subject_pod_url: client.podUrl, timestamp: new Date(now * 1000).toISOString() }),
    _signature: `0x${'12'.repeat(65)}` };
  const body = { playGrant: grant, publicKeyJwk, proof: crypto.sign('sha256', Buffer.from(bootstrapProofPayload(grant)), {
    key: key.privateKey, dsaEncoding: 'ieee-p1363',
  }).toString('base64url') };
  return { play, options, body, calls, documents, get issued() { return issued; }, get message() { return recoveredMessage; } };
}
test('adapter composes fixed native verification and conditional pod/admission writes before reply', async () => {
  const f = adapterFixture(); const response = await f.play.bootstrap(f.body);
  assert.equal(response.token, 'private-browser-credential'); assert.equal(f.issued, 1);
  assert.equal(f.message, `sha256:${crypto.createHash('sha256').update(f.body.playGrant._signed_payload).digest('hex')}`);
  const verification = f.calls[0]; assert.equal(verification.url, 'https://relay.example/tool/verify_agent');
  assert.deepEqual(JSON.parse(String(verification.init?.body)), { agent_id: 'did:web:identity.example:agents:game', pod_url: 'https://pods.example/game/' });
  assert.ok(f.calls.every(row => row.init?.redirect === 'error'));
  assert.ok(f.calls.some(row => row.url.endsWith('/provisional-play-admission.json') && row.init?.method === 'PUT'
    && (row.init.headers as Record<string, string>)['If-None-Match'] === '*'));
});
for (const [label, overrides] of Object.entries({ chain: { verified: false }, pod: { subject: 'https://pods.example/victim/' },
  delegation: { canSign: false }, signer: { recover: `0x${'22'.repeat(20)}` } })) {
  test(`native ${label} mismatch cannot provision or persist anything`, async () => {
    const f = adapterFixture(overrides);
    await assert.rejects(f.play.bootstrap(f.body), (error: unknown) => error instanceof PlayError && error.code === 'invalid_play_grant');
    assert.equal(f.issued, 0); assert.equal(f.documents.size, 0);
  });
}
test('configured Play cannot start under an ephemeral signing key or internal public pod URL', () => {
  const f = adapterFixture();
  assert.throws(() => createProvisionalPlayProvider({ ...f.options, stableSigningKey: false }), /stable/);
  assert.throws(() => createProvisionalPlayProvider({ ...f.options, publicPodBase: 'http://css.internal/' }), /canonical HTTPS/);
});
test('missing conditional validator fails closed on refresh', async () => {
  const f = adapterFixture({ missingEtag: true }); await f.play.bootstrap(f.body);
  await assert.rejects(f.play.bootstrap(f.body), /conditional-write validator/); assert.equal(f.issued, 1);
});
