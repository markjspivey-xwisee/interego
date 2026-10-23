import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { ProvisionalPlay, PlayError, publicPlayKey, playKeyThumbprint, bootstrapProofPayload, playProofPayload,
  parsePlayClients, type PlayClaims, type PlayGrant } from '../provisional-play.js';
import { provisionPlayAnchor, type PlayAnchorDocument } from '../provisional-play-store.js';
import { reservePlayAdmission, type PlayAdmissionLedger } from '../provisional-play-admission.js';

const audience = 'https://play.example';
const issuer = 'https://identity.example';
const service = { agentDid: 'did:web:identity.example:agents:game-service', podUrl: 'https://pods.example/game/' };
const keyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const sign = (key: crypto.KeyObject, value: string) => crypto.sign('sha256', Buffer.from(value), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const errorCode = (code: string) => (error: unknown) => error instanceof PlayError && error.code === code;
function fixture(options: { max?: number; ttl?: number } = {}) {
  let now = 1800000000;
  let sequence = 0;
  let credentials = 0;
  const docs = new Map<string, { document: PlayAnchorDocument; revision: number }>();
  let ledger: { ledger: PlayAdmissionLedger; revision: number } | null = null;
  let grantValid = true;
  let failWrite = false;
  let play: ProvisionalPlay;
  const copy = <T>(value: T): T => structuredClone(value);
  const reserve = (claims: PlayClaims, anchor: string, limit: number) => reservePlayAdmission({
    read: async () => ledger ? { ledger: copy(ledger.ledger), etag: String(ledger.revision) } : null,
    write: async (next, etag) => {
      if ((ledger ? String(ledger.revision) : null) !== etag) return false;
      ledger = { ledger: copy(next), revision: (ledger?.revision ?? 0) + 1 }; return true;
    },
    validate: value => play.open(value),
  }, claims, anchor, limit);
  const make = () => new ProvisionalPlay({ issuer, publicPodBase: 'https://pods.example/',
    signingKey: Buffer.alloc(32, 7), clients: new Map([[audience, service]]), now: () => now,
    ttlSeconds: options.ttl ?? 86400, maxPods: options.max ?? 100,
    verifyGrantSignature: async () => grantValid,
    readAnchor: async id => docs.get(id)?.document.provisionalPlayAnchor ?? null,
    provision: (claims, anchor, limit, receipt) => provisionPlayAnchor({
      read: async id => {
        const row = docs.get(id); return row ? { document: copy(row.document), etag: String(row.revision) } : null;
      },
      write: async (id, document, etag) => {
        if (failWrite) throw new Error('unavailable');
        const old = docs.get(id);
        if ((old ? String(old.revision) : null) !== etag) return false;
        docs.set(id, { document: copy(document), revision: (old?.revision ?? 0) + 1 }); return true;
      },
      reserveAdmission: reserve, empty: c => ({ userId: c.userId }), validate: value => play.open(value),
      committed: () => {}, now: () => now,
    }, claims, anchor, limit, receipt),
    issueCredential: async c => { credentials++; return { token: `private-${credentials}`, userId: c.userId,
      expiresAt: new Date(Math.min(now + 86400, c.expiresAt) * 1000).toISOString() }; },
  });
  play = make();
  const pair = keyPair();
  const jwk = publicPlayKey(pair.publicKey.export({ format: 'jwk' }));
  const grant = (overrides: Record<string, unknown> = {}): PlayGrant => ({ _signature: `0x${'12'.repeat(65)}`,
    _signed_payload: JSON.stringify({ purpose: 'interego-play-provisional-v1', audience,
      publicKeyThumbprint: playKeyThumbprint(jwk), challenge: Buffer.from(`challenge-${++sequence}-${now}`).toString('base64url'),
      expiresAt: now + 120, agent_id: service.agentDid, subject_pod_url: service.podUrl,
      timestamp: new Date(now * 1000).toISOString(), ...overrides }) });
  const bootstrap = (g = grant(), key = pair.privateKey) => play.bootstrap({ playGrant: g, publicKeyJwk: jwk,
    proof: sign(key, bootstrapProofPayload(g)) });
  const verify = (attestation: string, challenge = 'a'.repeat(32), proofKey = pair.privateKey) => play.verify({
    attestation, audience, challenge, proof: sign(proofKey, playProofPayload(attestation, audience, challenge)),
  });
  return { get play() { return play; }, grant, bootstrap, verify, jwk, pair, docs,
    setTime: (value: number) => { now = value; }, get now() { return now; },
    restart: () => { play = make(); }, get credentials() { return credentials; },
    get ledger() { return ledger?.ledger; }, invalidGrant: () => { grantValid = false; },
    breakWrites: () => { failWrite = true; } };
}

test('WebCrypto nonextractable P-256 private key proves browser possession', async () => {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await assert.rejects(crypto.webcrypto.subtle.exportKey('jwk', pair.privateKey));
  const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const f = fixture();
  const g = f.grant({ publicKeyThumbprint: playKeyThumbprint(publicPlayKey(publicKeyJwk)) });
  const proof = Buffer.from(await crypto.webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
    Buffer.from(bootstrapProofPayload(g)))).toString('base64url');
  const result = await f.play.bootstrap({ playGrant: g, publicKeyJwk, proof });
  assert.equal(result.provisional, true);
  assert.equal(f.credentials, 1);
});
test('native bootstrap persists its own owner and bounded receipt before issuing credentials', async () => {
  const f = fixture(); const result = await f.bootstrap();
  assert.match(String(result.userId), /^u-try-play-[a-f0-9]{32}$/);
  assert.equal(f.docs.size, 1); assert.equal(Object.keys(f.ledger!.owners).length, 1);
  assert.equal(f.docs.get(String(result.userId))!.document.provisionalPlayReceipts!.length, 1);
  const verified = await f.verify(String(result.attestation));
  assert.equal(verified.ownerDid, `did:web:identity.example:users:${result.userId}`);
  assert.equal(verified.podUrl, `https://pods.example/${result.userId}/`);
  assert.deepEqual(verified.capabilities, ['human-play', 'own-pod-checkpoint']);
  assert.ok(!Object.hasOwn(verified, 'token'));
});
test('same grant replay is refused durably across provider restart', async () => {
  const f = fixture(); const g = f.grant(); await f.bootstrap(g); f.restart();
  await assert.rejects(f.bootstrap(g), errorCode('play_grant_already_used')); assert.equal(f.credentials, 1);
});
test('fresh grant with same key resumes exact owner and original deadline', async () => {
  const f = fixture(); const first = await f.bootstrap(); f.setTime(f.now + 100); f.restart();
  const next = await f.bootstrap(); assert.equal(next.userId, first.userId);
  assert.equal(next.attestation, first.attestation); assert.equal(next.guestExpiresAt, first.guestExpiresAt);
  assert.equal(f.docs.size, 1); assert.equal(Object.keys(f.ledger!.owners).length, 1);
});
test('same grant concurrent requests have one durable effect and one credential', async () => {
  const f = fixture(); const g = f.grant(); const results = await Promise.allSettled([f.bootstrap(g), f.bootstrap(g)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.credentials, 1);
});
test('wrong browser key cannot bootstrap an allowed service grant', async () => {
  const f = fixture(); await assert.rejects(f.bootstrap(f.grant(), keyPair().privateKey), errorCode('invalid_browser_proof'));
  assert.equal(f.docs.size, 0); assert.equal(f.credentials, 0);
});
for (const [name, overrides] of Object.entries({ wrongAudience: { audience: 'https://other.example' },
  wrongPrincipal: { agent_id: 'did:web:identity.example:agents:other' }, wrongPod: { subject_pod_url: 'https://pods.example/other/' },
  wrongKey: { publicKeyThumbprint: 'x'.repeat(43) }, expired: { expiresAt: 1799999999 },
  future: { timestamp: new Date(1800000300 * 1000).toISOString() }, wrongPurpose: { purpose: 'other' },
  longExpiry: { expiresAt: 1800009999 } })) {
  test(`rejects ${name} native grant before provisioning`, async () => {
    const f = fixture(); await assert.rejects(f.bootstrap(f.grant(overrides)), errorCode('invalid_play_grant'));
    assert.equal(f.docs.size, 0); assert.equal(f.credentials, 0);
  });
}
test('unverified native signature cannot create an owner', async () => {
  const f = fixture(); f.invalidGrant(); await assert.rejects(f.bootstrap(), errorCode('invalid_play_grant'));
  assert.equal(f.docs.size, 0);
});
test('public proof binds exact audience, challenge, attestation and original private key', async () => {
  const f = fixture(); const result = await f.bootstrap(); const attestation = String(result.attestation);
  await assert.rejects(f.verify(attestation, 'b'.repeat(32), keyPair().privateKey), errorCode('invalid_browser_proof'));
  await assert.rejects(f.play.verify({ attestation, audience, challenge: 'c'.repeat(32),
    proof: sign(f.pair.privateKey, playProofPayload(attestation, audience, 'd'.repeat(32))) }), errorCode('invalid_browser_proof'));
  await assert.rejects(f.verify(attestation.slice(0, -1) + (attestation.endsWith('a') ? 'b' : 'a')), errorCode('invalid_attestation'));
});
test('source attestation remains usable after an explicit same-owner credential enrollment', async () => {
  const f = fixture(); const result = await f.bootstrap();
  f.docs.get(String(result.userId))!.document.webAuthnCredentials = [{ id: 'new-passkey' }]; f.restart();
  assert.equal((await f.verify(String(result.attestation))).valid, true);
});
test('deleted or unavailable canonical anchor never validates a public source proof', async () => {
  const f = fixture(); const result = await f.bootstrap(); f.docs.delete(String(result.userId));
  await assert.rejects(f.verify(String(result.attestation)), errorCode('provisional_owner_unavailable'));
});
test('expired owner cannot refresh, even after pod deletion or provider restart', async () => {
  const f = fixture(); const result = await f.bootstrap(); f.setTime(f.now + 86401); f.docs.clear(); f.restart();
  await assert.rejects(f.bootstrap(), errorCode('provisional_owner_expired'));
  assert.equal(f.credentials, 1); assert.equal(Object.keys(f.ledger!.owners).length, 1);
  await assert.rejects(f.verify(String(result.attestation)), errorCode('provisional_owner_expired'));
});
test('lifetime cap survives expired/deleted pods and is not reset by a fresh browser key', async () => {
  const f = fixture({ max: 1 }); const result = await f.bootstrap(); f.docs.clear(); f.restart();
  const pair = keyPair(); const key = publicPlayKey(pair.publicKey.export({ format: 'jwk' }));
  const g = f.grant({ publicKeyThumbprint: playKeyThumbprint(key) });
  await assert.rejects(f.play.bootstrap({ playGrant: g, publicKeyJwk: key, proof: sign(pair.privateKey, bootstrapProofPayload(g)) }),
    errorCode('provisional_play_lifetime_capacity'));
  assert.ok(f.ledger!.owners[String(result.userId)]); assert.equal(f.credentials, 1);
});
test('failed durable persistence does not issue a credential', async () => {
  const f = fixture(); f.breakWrites(); await assert.rejects(f.bootstrap(), /unavailable/); assert.equal(f.credentials, 0);
});
test('bounded receipt set refuses flooding and prunes only expired grant receipts', async () => {
  const f = fixture(); for (let i = 0; i < 16; i++) await f.bootstrap();
  await assert.rejects(f.bootstrap(), errorCode('play_grant_receipt_capacity')); f.setTime(f.now + 121);
  await f.bootstrap(); assert.equal([...f.docs.values()][0].document.provisionalPlayReceipts!.length, 1);
});
test('private JWK, unsupported curve and invalid public point are refused', () => {
  const f = fixture(); assert.throws(() => publicPlayKey({ ...f.jwk, d: 'private' }), errorCode('invalid_public_key'));
  assert.throws(() => publicPlayKey({ ...f.jwk, crv: 'P-384' }), errorCode('invalid_public_key'));
  assert.throws(() => publicPlayKey({ ...f.jwk, x: Buffer.alloc(32).toString('base64url'), y: Buffer.alloc(32).toString('base64url') }), errorCode('invalid_public_key'));
});
test('client allowlist fails closed and limits remain bounded', () => {
  assert.equal(parsePlayClients(undefined).size, 0);
  assert.throws(() => parsePlayClients(JSON.stringify({ 'https://play.example/path': service })));
  assert.throws(() => parsePlayClients(JSON.stringify({ [audience]: { ...service, podUrl: 'http://internal/' } })));
  const f = fixture({ ttl: 99999999, max: 99999999 }); assert.equal(f.play.ttlSeconds, 604800); assert.equal(f.play.maxPods, 1000);
});
