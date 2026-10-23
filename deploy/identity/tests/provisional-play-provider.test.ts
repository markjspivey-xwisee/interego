import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { createProvisionalPlayProvider } from '../provisional-play-provider.js';
import { publicPlayKey, playKeyThumbprint, bootstrapProofPayload, PlayError, type PlayClaims } from '../provisional-play.js';

function adapterFixture(overrides: { verified?: boolean; subject?: string; canSign?: boolean; recover?: string;
  missingEtag?: boolean; maxPods?: number; ledgerReadStatus?: number; ledgerWriteStatus?: number } = {}) {
  const audience = 'https://play.example';
  const client = { agentDid: 'did:web:identity.example:agents:game', podUrl: 'https://pods.example/game/' };
  const anchor = `0x${'11'.repeat(20)}`;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const documents = new Map<string, { body: string; revision: number }>();
  let issued = 0;
  let recoveredMessage = '';
  let failPodWrite = false;
  const options = {
    issuer: 'https://identity.example', cssUrl: 'https://css.internal.example/', publicPodBase: 'https://pods.example/',
    relayUrl: 'https://relay.example', signingKey: Buffer.alloc(32, 1), stableSigningKey: true,
    clientsJson: JSON.stringify({ [audience]: client }), maxPods: overrides.maxPods,
    empty: (c: PlayClaims) => ({ userId: c.userId, agentId: c.authenticatedAgentId }), committed: () => {},
    issueCredential: async () => { issued++; return { token: 'private-browser-credential' }; },
    recoverSigner: async (message: string) => { recoveredMessage = message; return overrides.recover ?? anchor; },
    fetcher: (async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url === 'https://css.internal.example/') throw new Error('CSS root listing is unavailable');
      if (url === 'https://relay.example/tool/verify_agent') return Response.json({
        verified: overrides.verified ?? true, subject_pod_url: overrides.subject ?? client.podUrl,
        signing: { relayAnchor: anchor, canSignDelegatedRequests: overrides.canSign ?? true },
      });
      if (url.endsWith('/provisional-play-admission.json')) {
        const status = init?.method === 'PUT' ? overrides.ledgerWriteStatus : overrides.ledgerReadStatus;
        if (status) return new Response(null, { status });
      }
      if (init?.method === 'PUT') {
        if (failPodWrite && url.includes('/u-try-play-')) return new Response(null, { status: 503 });
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
  const freshBody = (differentKey = false) => {
    const pair = differentKey ? crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : key;
    const jwk = publicPlayKey(pair.publicKey.export({ format: 'jwk' }));
    const next = { ...grant, _signed_payload: JSON.stringify({ ...JSON.parse(grant._signed_payload),
      publicKeyThumbprint: playKeyThumbprint(jwk), challenge: crypto.randomBytes(24).toString('base64url') }) };
    return { playGrant: next, publicKeyJwk: jwk, proof: crypto.sign('sha256', Buffer.from(bootstrapProofPayload(next)), {
      key: pair.privateKey, dsaEncoding: 'ieee-p1363',
    }).toString('base64url') };
  };
  return { play, options, body, freshBody, calls, documents, failPodWrites: (value: boolean) => { failPodWrite = value; },
    get issued() { return issued; }, get message() { return recoveredMessage; } };
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
  assert.ok(f.calls.every(row => row.url !== f.options.cssUrl));
  const admissionWrite = f.calls.findIndex(row => row.url.endsWith('/provisional-play-admission.json') && row.init?.method === 'PUT');
  const podWrite = f.calls.findIndex(row => row.url.includes('/u-try-play-') && row.init?.method === 'PUT');
  assert.ok(admissionWrite >= 0 && podWrite > admissionWrite);
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

for (const failure of ['ledgerReadStatus', 'ledgerWriteStatus'] as const) {
  test(`unavailable admission ${failure} cannot create a pod or issue a credential`, async () => {
    const f = adapterFixture({ [failure]: 503 });
    await assert.rejects(f.play.bootstrap(f.body), /Provisional admission/);
    assert.equal(f.issued, 0); assert.equal(f.documents.size, 0);
    assert.ok(!f.calls.some(row => row.url.includes('/u-try-play-') && row.init?.method === 'PUT'));
  });
}

test('native lifetime cap survives provider restart and deleted owner pods without root listing', async () => {
  const f = adapterFixture({ maxPods: 1 }); const first = await f.play.bootstrap(f.body);
  for (const url of f.documents.keys()) if (url.includes('/u-try-play-')) f.documents.delete(url);
  const restarted = createProvisionalPlayProvider(f.options);
  await assert.rejects(restarted.bootstrap(f.freshBody(true)),
    (error: unknown) => error instanceof PlayError && error.code === 'provisional_play_lifetime_capacity');
  assert.equal(f.issued, 1);
  const ledger = JSON.parse(f.documents.get(`${f.options.cssUrl}provisional-play-admission.json`)!.body);
  assert.deepEqual(Object.keys(ledger.owners), [f.play.open(String(first.attestation)).userId]);
});

test('failed pod creation stays charged across restart; same key reuses original reservation', async () => {
  const f = adapterFixture({ maxPods: 1 }); f.failPodWrites(true);
  await assert.rejects(f.play.bootstrap(f.body), /Provisional pod creation unavailable/);
  assert.equal(f.issued, 0);
  const ledger = JSON.parse(f.documents.get(`${f.options.cssUrl}provisional-play-admission.json`)!.body);
  assert.equal(Object.keys(ledger.owners).length, 1);
  const restarted = createProvisionalPlayProvider(f.options); f.failPodWrites(false);
  await assert.rejects(restarted.bootstrap(f.freshBody(true)),
    (error: unknown) => error instanceof PlayError && error.code === 'provisional_play_lifetime_capacity');
  const resumed = await restarted.bootstrap(f.freshBody());
  assert.equal(resumed.attestation, Object.values(ledger.owners)[0]);
  assert.equal(f.issued, 1);
});

test('separate provider writers cannot race past one native CAS admission', async () => {
  const f = adapterFixture({ maxPods: 1 }); const other = createProvisionalPlayProvider(f.options);
  const results = await Promise.allSettled([f.play.bootstrap(f.body), other.bootstrap(f.freshBody(true))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const refused = results.find(row => row.status === 'rejected') as PromiseRejectedResult;
  assert.ok(refused.reason instanceof PlayError); assert.equal(refused.reason.code, 'provisional_play_lifetime_capacity');
  assert.equal(f.issued, 1);
  const ledger = JSON.parse(f.documents.get(`${f.options.cssUrl}provisional-play-admission.json`)!.body);
  assert.equal(Object.keys(ledger.owners).length, 1);
  const pods = f.calls.filter(row => row.url.includes('/u-try-play-') && row.url.endsWith('/') && row.init?.method === 'PUT');
  assert.equal(pods.length, 1);
});
