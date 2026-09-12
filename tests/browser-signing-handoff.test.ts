import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { clientInteractionHttpHandler } from '../deploy/mcp-relay/client-interaction-http.js';
import { listenLoopback } from '../deploy/mcp-relay/tests/listen-loopback.js';
import { clientKeyId, clientSigningMessage, type ClientSigningKey } from '../integrations/application-runtime/client-authorization.js';
import { signingFixture } from './fixtures/client-interaction-fixture.js';

const origin = 'https://identity.example';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest();

/** Test-owned authenticator only: this establishes cryptographic behavior, not a human ceremony. */
function testAuthenticator() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]);
  const key: ClientSigningKey = { scheme: 'webauthn', publicKey: Buffer.from(isoCBOR.encode(cose)).toString('base64url'),
    credentialId: Buffer.from('single-prompt-test-credential').toString('base64url'), origins: [origin], rpIds: ['identity.example'] };
  const get = vi.fn(async ({ publicKey }: { publicKey: PublicKeyCredentialRequestOptions }) => {
    expect(publicKey.userVerification).toBe('required');
    expect(publicKey.rpId).toBe('identity.example');
    expect(Buffer.from(publicKey.allowCredentials![0]!.id as ArrayBuffer).toString('base64url')).toBe(key.credentialId);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin,
      challenge: Buffer.from(publicKey.challenge as ArrayBuffer).toString('base64url'), crossOrigin: false }));
    const authenticatorData = Buffer.concat([hash('identity.example'), Buffer.from([5, 0, 0, 0, 1])]);
    const signature = sign('sha256', Buffer.concat([authenticatorData, hash(clientDataJSON)]), pair.privateKey);
    return { id: key.credentialId, rawId: Buffer.from(key.credentialId!, 'base64url'), type: 'public-key',
      response: { clientDataJSON, authenticatorData, signature, userHandle: null }, getClientExtensionResults: () => ({}) };
  });
  const proof = async (message: string, challenge = hash(clientSigningMessage(message, key))) => {
    const credential = await get({ publicKey: { challenge, rpId: 'identity.example', userVerification: 'required',
      allowCredentials: [{ id: Buffer.from(key.credentialId!, 'base64url'), type: 'public-key' }] } });
    return { schema: 'interego.client-signature/v1', key, message,
      assertion: { id: credential.id, rawId: credential.rawId.toString('base64url'), type: credential.type,
        response: { clientDataJSON: credential.response.clientDataJSON.toString('base64url'),
          authenticatorData: credential.response.authenticatorData.toString('base64url'),
          signature: credential.response.signature.toString('base64url'), userHandle: null }, clientExtensionResults: {} } };
  };
  return { key, get, proof };
}

async function httpFixture() {
  const authenticator = testAuthenticator();
  const f = await signingFixture({ signingKeys: { alice: [authenticator.key] } });
  const pending = (await f.create())!;
  const id = String(pending['id']);
  const verifyHolder = vi.fn(async (authorization: string | undefined) => authorization === 'Bearer holder-alice' ? 'alice' : undefined);
  const app = express(); app.use(express.json());
  app.use('/client-interactions', clientInteractionHttpHandler({ interactions: f.broker, verifyHolder }));
  const http = await listenLoopback(app);
  const post = (operation: string, body: unknown = {}, headers: Record<string, string> = {}, requestId = id) =>
    fetch(`${http.base}/client-interactions/${requestId}/${operation}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
  const open = () => f.broker.openSigning(id, f.owners['alice']!);
  const exchange = async () => {
    const launch = await open();
    const code = new URL(String(launch['signingUrl'])).hash.slice('#launch='.length);
    const response = await post('exchange', { code });
    expect(response.status).toBe(200);
    const session = await response.json() as { credential: string; expiresAt: string };
    return { launch, code, session, headers: { 'X-Interego-Browser-Signing': session.credential } };
  };
  return { ...f, authenticator, pending, id, verifyHolder, post, open, exchange, http };
}

describe('single-prompt browser signing over the production HTTP boundary', () => {
  it('opens a fresh browser with no login and commits one real WebAuthn signature over the exact receipt', async () => {
    const f = await httpFixture(); let dom: JSDOM | undefined;
    const requests: Array<{ path: string; method?: string; headers: Headers }> = [];
    let reviewedMessage = ''; let submittedProof: Record<string, unknown> | undefined;
    try {
      const launch = await f.open();
      const launchUrl = String(launch['signingUrl']);
      const code = new URL(launchUrl).hash.slice('#launch='.length);
      const html = readFileSync(new URL('../docs/client-sign.html', import.meta.url), 'utf8')
        .replace('__INTEREGO_SIGNING_CONFIG__', JSON.stringify({ identityUrl: origin, relayUrl: 'https://relay.example' }));
      dom = new JSDOM(html, { url: launchUrl, runScripts: 'dangerously', beforeParse(window) {
        Object.defineProperty(window, 'crypto', { value: globalThis.crypto });
        Object.defineProperty(window.navigator, 'credentials', { value: { get: f.authenticator.get } });
        for (const storage of ['localStorage', 'sessionStorage']) Object.defineProperty(window, storage, {
          get: () => { throw new Error(`The request-scoped signing page must not access ${storage}`); },
        });
        Object.assign(window, { TextEncoder, TextDecoder,
          fetch: async (url: string, options: RequestInit) => {
            expect(window.location.hash).toBe(''); // The launch is stripped before the first network operation.
            expect(options.credentials).toBe('omit'); expect(options.cache).toBe('no-store');
            const endpoint = new URL(url); const headers = new Headers(options.headers);
            expect(endpoint.origin).toBe('https://relay.example');
            expect(headers.has('Authorization')).toBe(false);
            expect(headers.has('Cookie')).toBe(false);
            expect(options.method).toBe('POST');
            requests.push({ path: endpoint.pathname, method: options.method, headers });
            const operation = endpoint.pathname.split('/').at(-1)!;
            expect(['exchange', 'status', 'review', 'submit']).toContain(operation);
            const body = JSON.parse(String(options.body));
            if (operation === 'exchange') { expect(body).toEqual({ code }); expect(headers.has('X-Interego-Browser-Signing')).toBe(false); }
            else expect(headers.get('X-Interego-Browser-Signing')).toMatch(/^[a-zA-Z0-9_-]{43}$/);
            if (operation === 'submit') submittedProof = body.proof;
            // Browsers supply Origin themselves. Exercise the actual server header, not a body-origin surrogate.
            headers.set('Origin', window.location.origin);
            const response = await fetch(f.http.base + endpoint.pathname, { ...options, headers });
            if (operation === 'review') reviewedMessage = (await response.clone().json()).signingRequest.message;
            return response;
          },
        });
      } });
      const button = dom.window.document.getElementById('sign') as HTMLButtonElement;
      await vi.waitFor(() => expect(button.disabled, dom!.window.document.getElementById('status')!.textContent!).toBe(false));
      expect(f.authenticator.get).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      for (const id of ['passkey-login', 'wallet-login', 'cancel', 'origin-recovery', 'scoped-signing'])
        expect((dom.window.document.getElementById(id) as HTMLElement).hidden).toBe(true);
      await button.onclick!(new dom.window.MouseEvent('click') as unknown as PointerEvent);
      expect(dom.window.document.getElementById('status')!.textContent).toContain('Signed, verified and submitted');
      expect(f.authenticator.get).toHaveBeenCalledTimes(1);
      const challenge = f.authenticator.get.mock.calls[0]![0].publicKey.challenge;
      expect(Buffer.from(challenge as ArrayBuffer)).toEqual(hash(clientSigningMessage(reviewedMessage, f.authenticator.key)));
      expect(submittedProof?.['message']).toBe(reviewedMessage);
      expect(JSON.parse(reviewedMessage)).toMatchObject({ actor: f.owners['alice']!.principal,
        contractDigest: f.initial.activeContractEnvelope.declaredDigest, expectedHead: f.initial.stateDescriptor.cid });
      expect(f.publish).toHaveBeenCalledTimes(1);
      const current = await f.store.resolve();
      expect(current.replay.complete).toBe(true);
      expect(current.state.data['approvals']).toEqual([expect.objectContaining({ approver: f.owners['alice']!.principal,
        keyId: clientKeyId(f.authenticator.key), verified: true })]);
      expect(requests.map(r => r.path.split('/').at(-1))).toEqual(['exchange', 'status', 'review', 'submit']);
      expect(f.verifyHolder).not.toHaveBeenCalled();
      expect((dom.window.document.getElementById('proof') as HTMLTextAreaElement).value).toBe('');
      expect(dom.window.document.documentElement.outerHTML).not.toContain(code);
      const sessionCredential = requests[1]!.headers.get('X-Interego-Browser-Signing')!;
      expect(dom.window.document.documentElement.outerHTML).not.toContain(sessionCredential);
      expect(JSON.stringify(f.storage.records.get(f.id)!.record)).not.toContain(sessionCredential);
      expect(JSON.stringify(f.storage.records.get(f.id)!.record)).not.toContain(code);
      expect(f.storage.records.get(f.id)!.record.credential).toBe(''); // No callback or expiry read is needed to erase OAuth authority.
      const terminal = await f.post('status', {}, { 'X-Interego-Browser-Signing': sessionCredential });
      expect(terminal.status).toBe(200);
      expect(await terminal.json()).toEqual({ id: f.id, status: 'completed', expiresAt: expect.any(String),
        result: { status: 'committed', committed: true } });
      f.advance(5 * 60_000 + 1);
      expect((await f.post('status', {}, { 'X-Interego-Browser-Signing': sessionCredential })).status).toBeGreaterThanOrEqual(400);
    } finally { dom?.window.close(); await f.http.close(); }
  });

  it('refuses missing, guessed, cross-request, wrong-Origin, expired and replayed launch codes', async () => {
    const f = await httpFixture();
    try {
      const launch = await f.open(); const code = new URL(String(launch['signingUrl'])).hash.slice('#launch='.length);
      expect((await f.post('exchange', {})).status).toBeGreaterThanOrEqual(400);
      expect((await f.post('exchange', { code: 'x'.repeat(43) })).status).toBeGreaterThanOrEqual(400);
      expect((await f.post('exchange', { code }, { Origin: 'https://evil.example' })).status).toBeGreaterThanOrEqual(400);
      const other = (await f.create('bob'))!;
      expect((await f.post('exchange', { code }, {}, String(other['id']))).status).toBeGreaterThanOrEqual(400);
      expect((await f.post('exchange', { code })).status).toBe(200);
      expect((await f.post('exchange', { code })).status).toBeGreaterThanOrEqual(400);
      const again = await f.open(); const expired = new URL(String(again['signingUrl'])).hash.slice('#launch='.length);
      f.advance(120_001);
      expect((await f.post('exchange', { code: expired })).status).toBeGreaterThanOrEqual(400);
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.verifyHolder).not.toHaveBeenCalled();
    } finally { await f.http.close(); }
  });

  it('requires the real Origin header and refuses a body, forwarded header, or bearer fallback', async () => {
    const f = await httpFixture();
    try {
      const { headers } = await f.exchange();
      for (const extra of [{}, { Authorization: 'Bearer holder-alice' }] as Record<string, string>[]) {
        const response = await fetch(`${f.http.base}/client-interactions/${f.id}/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...headers, ...extra,
            'X-Forwarded-Origin': origin, Referer: origin + '/sign-action' }, body: JSON.stringify({ origin }),
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      expect((await f.post('status', {}, { ...headers, Origin: 'null' })).status).toBeGreaterThanOrEqual(400);
      expect((await f.post('status', {}, { ...headers, Origin: 'https://evil.example' })).status).toBeGreaterThanOrEqual(400);
      expect(f.verifyHolder).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    } finally { await f.http.close(); }
  });

  it('does not use a scoped browser credential to exchange even a valid new launch code', async () => {
    const f = await httpFixture();
    try {
      const { headers } = await f.exchange();
      const newLaunch = await f.open();
      const code = new URL(String(newLaunch['signingUrl'])).hash.slice('#launch='.length);
      expect((await f.post('exchange', { code }, { ...headers, Authorization: 'Bearer holder-alice' })).status).toBe(403);
      // Rejecting the mixed request must not consume the fresh launch code.
      expect((await f.post('exchange', { code })).status).toBe(200);
      expect(f.verifyHolder).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
    } finally { await f.http.close(); }
  });

  it('confines browser sessions to their request and read/review/submit operations, even alongside a valid holder bearer', async () => {
    const f = await httpFixture();
    try {
      const { headers } = await f.exchange();
      const other = (await f.create('bob'))!;
      expect((await f.post('status', {}, headers, String(other['id']))).status).toBeGreaterThanOrEqual(400);
      for (const operation of ['cancel', 'grant', 'pending', 'renew', 'renew-authorization', 'open-signing-page', 'exchange']) {
        for (const extra of [{}, { Authorization: 'Bearer holder-alice' }] as Record<string, string>[])
          expect((await f.post(operation, {}, { ...headers, ...extra })).status).toBeGreaterThanOrEqual(400);
      }
      expect((await fetch(`${f.http.base}/client-interactions/${f.id}`, { headers: { ...headers, Origin: origin } })).status)
        .toBeGreaterThanOrEqual(400);
      expect(f.verifyHolder).not.toHaveBeenCalled();
      expect((await f.post('status')).status).toBeGreaterThanOrEqual(400);
      expect(f.verifyHolder).toHaveBeenCalledExactlyOnceWith(undefined);
      f.verifyHolder.mockClear();
      const status = await (await f.post('status', {}, headers)).json();
      expect(status).toMatchObject({ id: f.id, status: 'pending' });
      expect(status).not.toHaveProperty('signingRequest'); expect(status).not.toHaveProperty('owner');
      expect(f.verifyHolder).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    } finally { await f.http.close(); }
  });

  it('invalidates browser authority on expiry, owner-grant revocation and a fresh launch', async () => {
    const f = await httpFixture();
    try {
      const first = await f.exchange();
      await f.open();
      expect((await f.post('status', {}, first.headers)).status).toBeGreaterThanOrEqual(400);
      const second = await f.exchange(); f.revoked.add('alice');
      expect((await f.post('review', {}, second.headers)).status).toBeGreaterThanOrEqual(400);
      f.revoked.clear(); f.advance(5 * 60_000 + 1);
      expect((await f.post('status', {}, second.headers)).status).toBeGreaterThanOrEqual(400);
      expect(f.publish).not.toHaveBeenCalled();
    } finally { await f.http.close(); }
  });

  it('a launch grants no signing authority: altered receipt challenges and another registered holder fail before publication', async () => {
    const f = await httpFixture();
    try {
      const { headers } = await f.exchange();
      const reviewed = await (await f.post('review', {}, headers)).json();
      const wrongChallenge = await f.authenticator.proof(reviewed.signingRequest.message, hash('unrelated login challenge'));
      expect((await f.post('submit', { reviewId: reviewed.reviewId, proof: wrongChallenge }, headers)).status).toBeGreaterThanOrEqual(400);
      const wrongHolder = await f.sign(reviewed.signingRequest, 'bob');
      expect((await f.post('submit', { reviewId: reviewed.reviewId, proof: wrongHolder }, headers)).status).toBeGreaterThanOrEqual(400);
      expect(f.publish).not.toHaveBeenCalled();
      expect((await f.broker.status(f.id, f.owners['alice']!)).status).toBe('reviewing');
    } finally { await f.http.close(); }
  });

  it.each([
    { fragment: '#launch=invalid', extraQuery: '', pageOrigin: origin },
    { fragment: '#launch=' + 'a'.repeat(43) + '&token=leak', extraQuery: '', pageOrigin: origin },
    { fragment: '#launch=' + 'a'.repeat(43), extraQuery: '&returnTo=https://evil.example', pageOrigin: origin },
    { fragment: '#launch=' + 'a'.repeat(43), extraQuery: '', pageOrigin: 'https://evil.example' },
  ])('strips and rejects malformed launch URLs without login, network, or storage: %j', async ({ fragment, extraQuery, pageOrigin }) => {
    const f = await httpFixture(); let dom: JSDOM | undefined;
    const network = vi.fn(); const storage = vi.fn(() => { throw Error('no storage'); });
    try {
      const html = readFileSync(new URL('../docs/client-sign.html', import.meta.url), 'utf8')
        .replace('__INTEREGO_SIGNING_CONFIG__', JSON.stringify({ identityUrl: origin, relayUrl: 'https://relay.example' }));
      dom = new JSDOM(html, { url: `${pageOrigin}/sign-action?request=${f.id}${extraQuery}${fragment}`, runScripts: 'dangerously', beforeParse(window) {
        Object.assign(window, { TextEncoder, TextDecoder, fetch: network });
        Object.defineProperty(window, 'sessionStorage', { get: storage });
      } });
      await vi.waitFor(() => expect(dom!.window.document.getElementById('status')!.textContent).toContain('invalid, expired or already used'));
      expect(dom.window.location.hash).toBe(''); expect(network).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
      expect((dom.window.document.getElementById('sign') as HTMLButtonElement).disabled).toBe(true);
    } finally { dom?.window.close(); await f.http.close(); }
  });
});
