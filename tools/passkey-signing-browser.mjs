/** Browser regression: a legacy passkey logs in, pins its RP, then signs a receipt. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { authenticatePasskey, PasskeyPersistenceError } from '../deploy/identity/passkey-authentication.ts';
import { clientKeyId, verifyClientAuthorization } from '../integrations/application-runtime/client-authorization.ts';

const origin = 'https://relay.example.test';
const rpId = new URL(origin).hostname;
const requestId = 'a'.repeat(43);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.route(origin + '/register-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html>Registration fixture</html>' }));
  await page.goto(origin + '/register-fixture');
  const challenge = randomBytes(32).toString('base64url');
  const registration = await page.evaluate(async ({ challenge, rpId }) => {
    const decode = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const encode = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const c = await navigator.credentials.create({ publicKey: { challenge: decode(challenge), rp: { id: rpId, name: 'Test' },
      user: { id: new Uint8Array([1, 2, 3]), name: 'fixture', displayName: 'Fixture' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } });
    return { id: c.id, rawId: encode(c.rawId), type: c.type, response: { attestationObject: encode(c.response.attestationObject),
      clientDataJSON: encode(c.response.clientDataJSON), transports: c.response.getTransports() }, clientExtensionResults: c.getClientExtensionResults() };
  }, { challenge, rpId });
  const verified = await verifyRegistrationResponse({ response: registration, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true });
  assert.equal(verified.verified, true);
  const registered = verified.registrationInfo.credential;
  // Deliberately simulate pre-migration storage, with NO RP binding.
  const credential = { id: registered.id, publicKey: Buffer.from(registered.publicKey).toString('base64url'), counter: registered.counter };
  const original = structuredClone(credential);
  const key = () => ({ scheme: 'webauthn', credentialId: credential.id, publicKey: credential.publicKey,
    rpIds: credential.rpId ? [credential.rpId] : ['example.test', 'identity.example.test', rpId],
    origins: credential.rpOrigin ? [credential.rpOrigin] : ['https://identity.example.test', origin] });
  const fingerprint = clientKeyId(key());
  let authChallenge, assertion, persisted, receipt, committed = 0, retained;
  const html = readFileSync(new URL('../docs/client-sign.html', import.meta.url), 'utf8')
    .replace('__INTEREGO_SIGNING_CONFIG__', JSON.stringify({ identityUrl: origin, relayUrl: origin }));
  await page.route(origin + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    let result;
    try {
      if (path === '/sign-action') return await route.fulfill({ contentType: 'text/html', body: html });
      if (path === '/challenges') { authChallenge = randomBytes(32).toString('base64url'); result = { nonce: authChallenge, rpId }; }
      else if (path === '/auth/webauthn/authenticate') {
        assertion = body.response;
        await authenticatePasskey({ credential, response: assertion, challenge: authChallenge, rpId, origin,
          persist: async () => { persisted = structuredClone(credential); } });
        result = { token: 'fixture-holder-session' };
      } else if (path === '/client-interactions/' + requestId) result = { status: 'pending' };
      else if (path.endsWith('/review')) {
        receipt = JSON.stringify({ actor: 'did:example:reviewer', actionIri: 'urn:test:approve', contractDigest: 'current-contract',
          expectedHead: 'current-head', authority: { owner: 'did:example:owner' }, at: new Date().toISOString() });
        result = { status: 'reviewing', reviewId: 'fixture-review', signingRequest: { schema: 'interego.client-signing-request/v1',
          message: receipt, keys: [{ keyId: clientKeyId(key()), key: key() }], expiresAt: new Date(Date.now() + 600_000).toISOString() } };
      } else if (path.endsWith('/submit')) {
        assert.equal(body.reviewId, 'fixture-review');
        const verifiedProof = await verifyClientAuthorization(body.proof, receipt, [key()]);
        retained = verifiedProof.proof;
        assert.equal(verifiedProof.keyId, fingerprint);
        committed++; result = { status: 'completed', result: { committed: true } };
      } else throw new Error('Unexpected fixture route ' + path);
      await route.fulfill({ json: result });
    } catch (error) { await route.fulfill({ status: 400, json: { error: error.message } }); }
  });
  // An old holder session must not make the page guess a parent domain.
  await page.evaluate(() => sessionStorage.setItem('cg.token', 'fixture-holder-session'));
  await page.goto(origin + '/sign-action?request=' + requestId);
  await page.locator('#sign:not([disabled])').waitFor();
  await page.locator('#sign').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('confirm its registration domain'));
  assert.equal(committed, 0);
  assert.equal(credential.rpId, undefined);
  // Actual browser assertion verifies before legacy metadata can be repaired.
  await page.locator('#passkey-login').click();
  await page.locator('#sign:not([disabled])').waitFor();
  assert.equal(persisted.rpId, rpId);
  assert.equal(persisted.rpOrigin, origin);
  assert.equal(clientKeyId(key()), fingerprint);
  await page.locator('#sign').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Signed, verified and submitted'));
  assert.equal(committed, 1);
  assert.equal((await verifyClientAuthorization(retained, receipt)).keyId, fingerprint); // retained-proof replay
  // Failed cryptography and failed persistence must never pin legacy metadata.
  const unbound = structuredClone(original);
  await assert.rejects(authenticatePasskey({ credential: unbound, response: assertion, challenge: 'wrong', rpId, origin,
    persist: async () => { throw new Error('must not persist'); } }));
  assert.deepEqual(unbound, original);
  await assert.rejects(authenticatePasskey({ credential: unbound, response: assertion, challenge: authChallenge, rpId, origin,
    persist: async () => { throw new Error('pod unavailable'); } }), PasskeyPersistenceError);
  assert.equal(unbound.counter, original.counter);
  assert.equal(unbound.rpId, undefined);
  assert.equal(unbound.rpOrigin, undefined);
  await assert.rejects(authenticatePasskey({ credential: { ...original, rpId: 'example.test' }, response: assertion,
    challenge: authChallenge, rpId, origin, persist: async () => {} }), /different relying party/);
  console.log('PASS: Chromium WebAuthn login → legacy RP migration → receipt signing → retained proof replay; ambiguous RP, invalid assertion, conflicting binding and persistence failure refused.');
} finally { await browser.close(); }
