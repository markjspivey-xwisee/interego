/**
 * A guest their browser keeps (dashboard-app/src/auth/durable-guest.ts, src/play-grant.ts).
 *
 * ★ WHY THIS TEST RUNS THE SERVERS' OWN CODE. No client for the substrate's provisional owners
 * existed in this repository, so a client tested against a stand-in written from its author's
 * reading of the protocol would only prove the author agrees with themselves. Here the browser
 * client and the bridge's grant service talk to:
 *
 *   - identity's real admission (deploy/identity/provisional-play.ts, ProvisionalPlay.bootstrap),
 *     configured with a second application and its namespace;
 *   - identity's real ERC-4361 reader (deploy/identity/siwe-message.ts) for the service sign-in;
 *   - the storage gate's real guest policy (deploy/css-gate/provisional-play.mjs): the marker
 *     check, the two permitted paths, the native-commit and sealed-envelope requirements.
 *
 * What is stood in for: the relay's signature (identity's verifyGrantSignature is a dependency it
 * is given, and is told here whether the grant is the relay's), the transport, and the stores.
 * Nothing live is touched.
 */
import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Readable } from 'node:stream';
import { ethers } from 'ethers';
import {
  DurableGuestError, durableGuestOffer, forgetKeptGuest, guestCheckpointUrl, indexedDbGuestStore, keepGuest, keptGuest, openKeptGuest,
  type DurableGuestDeps, type StoredGuest,
} from '../dashboard-app/src/auth/durable-guest.js';
import { connectAsGuest } from '../dashboard-app/src/auth/session.js';
import { PlayGrantError, PlayGrantService, playGrantConfig, playGrantRequestBody } from '../src/play-grant.js';
import { readFileSync } from 'node:fs';
import { parseSiweMessage } from '../../../deploy/identity/siwe-message.js';

interface GateModule {
  verifiedProvisional(data: unknown, now?: number): Record<string, unknown> | undefined;
  provisionalCheckpointPaths(claims: unknown): string[];
  checkProvisionalTarget(claims: unknown, method: string, target: URL, headers: Record<string, string | undefined>, now?: number): string | null;
  readProvisionalCommit(stream: AsyncIterable<Uint8Array>, expectedRevision: string | null, limits: unknown): Promise<{ body: Buffer; bytes: number }>;
  provisionalLimits(env: Record<string, string>): unknown;
}
// Paths the compiler does not follow. The gate is plain .mjs with no declarations, and identity's
// source is compiled under its own tsconfig, not the root check's; both are run here as they are.
const gatePath = '../../../deploy/css-gate/provisional-play.mjs';
const gate = await import(/* @vite-ignore */ gatePath) as GateModule;
interface PlayClaims { userId: string; ownerDid: string; webId: string; podUrl: string; audience: string }
interface IdentityPlay {
  bootstrap(input: unknown): Promise<Record<string, unknown>>;
  metadata(): Record<string, unknown>;
  tokenGrant(claims: PlayClaims): Record<string, unknown>;
}
interface IdentityModule {
  ProvisionalPlay: new (deps: Record<string, unknown>) => IdentityPlay;
  PlayError: new (...args: never[]) => Error & { status: number; code: string };
}
const identityPath = '../../../deploy/identity/provisional-play.js';
const { ProvisionalPlay, PlayError } = await import(/* @vite-ignore */ identityPath) as IdentityModule;

const DASHBOARD = 'https://foxxi.example';
const BRIDGE = 'https://bridge.example';
const IDENTITY = 'https://identity.example';
const RELAY = 'https://relay.example';
const PODS = 'https://pods.example/';
const SERVICE_KEY = `0x${'5'.repeat(64)}`;
const service = new ethers.Wallet(SERVICE_KEY);
const SERVICE = { userId: 'u-eth-foxxiservice', agentDid: 'did:web:identity.example:agents:mcp-client-u-eth-foxxiservice', podUrl: `${PODS}u-eth-foxxiservice/` };
const PHRASE = 'test test test test test test test test test test test junk';

type Init = { method?: string; headers?: Record<string, string>; body?: string };
const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status,
  json: async () => typeof body === 'string' ? JSON.parse(body) as unknown : body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });

/** A deployment: identity, the relay's signing, the gate and the Foxxi bridge, with the browser's fetch over all of them. */
function deployment(options: { namespace?: string; relaySigns?: boolean; serviceAccount?: boolean; grantsEnabled?: boolean; terms?: boolean } = {}) {
  let now = Date.parse('2026-11-12T10:00:00Z');
  const stored = new Map<string, Buffer>();                    // the pod, by path
  const guests = new Map<string, PlayClaims>();                // identity's tokens
  const requests: string[] = [];
  let relaySigned: string | undefined;

  const identity = new ProvisionalPlay({
    issuer: IDENTITY, publicPodBase: PODS, signingKey: Buffer.alloc(32, 9), now: () => Math.floor(now / 1000),
    clients: new Map([[DASHBOARD, { agentDid: SERVICE.agentDid, podUrl: SERVICE.podUrl, ...(options.namespace ? { namespace: options.namespace } : {}) }]]),
    ttlSeconds: 86400, maxPods: 10,
    ...(options.terms ? { hostedTerms: { version: '2026-11-06-r2', termsUrl: 'https://identity.example/terms' } } : {}),
    // The relay's signature is the one thing stood in for: true only for a payload this relay signed.
    verifyGrantSignature: async (grant: { _signed_payload: string }) => options.relaySigns !== false && grant._signed_payload === relaySigned,
    readAnchor: async () => null,
    provision: async (_claims: PlayClaims, attestation: string) => attestation,
    issueCredential: async (claims: PlayClaims) => {
      const token = `cg2_${claims.userId}`;
      guests.set(token, claims);
      return { token, userId: claims.userId, did: claims.ownerDid, webId: claims.webId, podUrl: claims.podUrl };
    },
  });

  /** The relay and identity as the bridge's service reaches them. */
  const serviceFetch = async (url: string, init: Init = {}) => {
    requests.push(`service ${init.method ?? 'GET'} ${url}`);
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (url === `${IDENTITY}/challenges`) return answer(200, { nonce: 'n'.repeat(32) });
    if (url === `${IDENTITY}/auth/siwe`) {
      const parsed = parseSiweMessage(String(body['message']));
      if (parsed.ok === false) return answer(400, { error: `not ERC-4361: ${parsed.reason}` });
      const signer = ethers.verifyMessage(String(body['message']), String(body['signature']));
      if (signer !== service.address || parsed.fields.address !== service.address || parsed.fields.nonce !== body['nonce']
        || body['existingOnly'] !== true) return answer(401, { error: 'bad sign-in' });
      if (options.serviceAccount === false) return answer(401, { error: 'Invalid credentials' });
      return answer(200, { token: 'cg2_service', userId: SERVICE.userId, agentDid: SERVICE.agentDid, podUrl: SERVICE.podUrl,
        expiresAt: new Date(now + 86_400_000).toISOString() });
    }
    if (url === `${RELAY}/tool/sign_request`) {
      if (init.headers?.['Authorization'] !== 'Bearer cg2_service') return answer(401, { error: 'unauthenticated' });
      relaySigned = JSON.stringify({ ...body, agent_id: SERVICE.agentDid, subject_pod_url: SERVICE.podUrl, timestamp: new Date(now).toISOString() });
      return answer(200, { '@context': {}, _signature: `0x${'12'.repeat(65)}`, _signed_payload: relaySigned, signatureAuthority: 'relay' });
    }
    if (url === `${RELAY}/tool/verify_agent`) {
      return answer(200, { verified: true, subject_pod_url: body['pod_url'], signing: { relayAnchor: `0x${'11'.repeat(20)}`, canSignDelegatedRequests: true } });
    }
    return answer(404, {});
  };
  const config = options.grantsEnabled === false ? null
    : playGrantConfig({ FOXXI_PLAY_SERVICE_PRIVATE_KEY: SERVICE_KEY, FOXXI_PLAY_AUDIENCE: DASHBOARD, INTEREGO_IDENTITY_URL: IDENTITY, INTEREGO_RELAY_URL: RELAY });
  const grants = config ? new PlayGrantService(config, { fetch: serviceFetch, now: () => now }) : null;

  /** Everything the browser reaches. */
  const browserFetch: DurableGuestDeps['fetch'] = async (url, init: Init = {}) => {
    requests.push(`browser ${init.method ?? 'GET'} ${url}`);
    const body = init.body && init.headers?.['Content-Type'] === 'application/json' ? JSON.parse(init.body) as unknown : undefined;
    if (url === `${BRIDGE}/play/guest`) return answer(200, config ? { enabled: true, audience: config.audience, identityUrl: config.identityUrl } : { enabled: false });
    if (url === `${BRIDGE}/play/grant`) {
      if (!grants) return answer(404, { error: 'durable_guest_disabled' });
      try { return answer(200, await grants.grant(body)); }
      catch (error) { return answer((error as PlayGrantError).status, { error: (error as PlayGrantError).code }); }
    }
    if (url === `${IDENTITY}/.well-known/play-provisional`) return answer(200, identity.metadata());
    if (url === `${IDENTITY}/play/provisional`) {
      try { return answer(200, await identity.bootstrap(body)); }
      catch (error) { return answer(error instanceof PlayError ? error.status : 500, { valid: false, error: error instanceof PlayError ? error.code : 'error' }); }
    }
    if (url === `${IDENTITY}/me`) {
      const claims = guests.get((init.headers?.['Authorization'] ?? '').replace('Bearer ', ''));
      return claims ? answer(200, { userId: claims.userId, provisionalPlay: identity.tokenGrant(claims) }) : answer(401, {});
    }
    // The storage gate: its own policy decides, as server.mjs applies it to a guest's write.
    const target = new URL(url);
    if (target.origin === new URL(PODS).origin) {
      if ((init.method ?? 'GET') === 'GET') {
        const found = stored.get(target.pathname);
        return found ? answer(200, found.toString('utf8')) : answer(404, {});
      }
      const claims = guests.get((init.headers?.['Authorization'] ?? '').replace('Bearer ', ''));
      if (!claims) return answer(401, {});
      try {
        const verified = gate.verifiedProvisional({ userId: claims.userId, ownerDid: claims.ownerDid, provisionalPlay: identity.tokenGrant(claims) }, now);
        const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        // The deployment's clock, not the machine's: without it this passed until the wall clock
        // reached the guest's expiry (2026-11-13T10:00Z) and then answered 401 for every run.
        const expected = gate.checkProvisionalTarget(verified, init.method ?? 'GET', target, headers, now);
        const commit = await gate.readProvisionalCommit(Readable.from([Buffer.from(init.body ?? '')]), expected, gate.provisionalLimits({}));
        const command = JSON.parse(commit.body.toString('utf8')) as { bodyBase64: string };
        stored.set(target.pathname, Buffer.from(command.bodyBase64, 'base64'));
        return answer(201, { status: 'committed' });
      } catch (error) { return answer((error as { status?: number }).status ?? 500, { error: (error as { code?: string }).code }); }
    }
    return answer(404, {});
  };

  let kept: StoredGuest | undefined;
  const deps: DurableGuestDeps = {
    fetch: browserFetch, subtle: webcrypto.subtle as unknown as SubtleCrypto, now: () => now,
    randomBytes: length => webcrypto.getRandomValues(new Uint8Array(length)),
    store: { get: async () => kept, put: async guest => { kept = guest; }, delete: async () => { kept = undefined; } },
  };
  return { deps, stored, requests, identity, grants, gate, get kept() { return kept; }, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}

const guestWallet = ethers.Wallet.fromPhrase(PHRASE);
const keep = async (d: ReturnType<typeof deployment>, acceptedTermsVersion?: string) => {
  const offer = await durableGuestOffer(BRIDGE, d.deps);
  if (!offer) throw new Error('no offer');
  return keepGuest({ bridgeUrl: BRIDGE, offer, phrase: PHRASE, address: guestWallet.address, ...(acceptedTermsVersion ? { acceptedTermsVersion } : {}) }, d.deps);
};

describe('a guest their browser keeps', () => {
  it('is admitted by identity on the bridge\'s grant, writes one sealed document where the gate allows, and opens it again', async () => {
    const d = deployment({ namespace: 'foxxi' });
    const guest = await keep(d);
    expect(guest.userId).toMatch(/^u-try-play-[a-f0-9]{32}$/);
    expect(guest.address).toBe(guestWallet.address);

    // The one path written is the first of the two the gate derives for this application's guest.
    const paths = d.gate.provisionalCheckpointPaths({ userId: guest.userId, ownerDid: guest.ownerDid, namespace: 'foxxi' });
    expect(new URL(guest.checkpointUrl).pathname).toBe(paths[0]);
    expect(paths[0]).toContain(`/${guest.userId}/foxxi/checkpoints/`);
    expect([...d.stored.keys()]).toEqual([paths[0]]);

    // What the pod holds is ciphertext: neither the phrase nor the guest's address is in it.
    const atRest = d.stored.get(paths[0]!)!.toString('utf8');
    expect(atRest).not.toContain('junk');
    expect(atRest).not.toContain(guestWallet.address);
    expect(JSON.parse(atRest)).toMatchObject({ version: 1, algorithm: 'X25519-XSalsa20-Poly1305' });

    // What the browser keeps holds no phrase and no exportable key.
    expect(JSON.stringify({ ...d.kept, proofKey: undefined, wrappingKey: undefined })).not.toContain('junk');
    expect(d.kept!.proofKey.privateKey.extractable).toBe(false);
    expect(d.kept!.wrappingKey.extractable).toBe(false);
    await expect(webcrypto.subtle.exportKey('jwk', d.kept!.proofKey.privateKey as never)).rejects.toThrow();

    // Coming back: no sign-in is repeated, and the same identity is the result.
    d.requests.length = 0;
    expect(await keptGuest(d.deps)).toEqual({ address: guestWallet.address, guestExpiresAt: guest.guestExpiresAt });
    const opened = await openKeptGuest(d.deps);
    expect(opened).toEqual({ phrase: PHRASE, address: guestWallet.address });
    expect(d.requests).toEqual([`browser GET ${guest.checkpointUrl}`]);
    const session = await connectAsGuest('https://pod.example/tenant/', () => ethers.Wallet.fromPhrase(opened.phrase));
    expect(session.webId).toBe(`did:ethr:${guestWallet.address}`);
  });

  it('writes under the default application\'s directory where identity names no namespace', async () => {
    const d = deployment();
    const guest = await keep(d);
    expect(new URL(guest.checkpointUrl).pathname).toContain(`/${guest.userId}/hallowmarch/checkpoints/`);
    expect(await openKeptGuest(d.deps)).toEqual({ phrase: PHRASE, address: guestWallet.address });
  });

  it('the gate refuses the same token anywhere else, so nothing but the one document can be written', async () => {
    const d = deployment({ namespace: 'foxxi' });
    const guest = await keep(d);
    const token = `cg2_${guest.userId}`;
    const put = (url: string) => d.deps.fetch(url, { method: 'PUT', body: '{}',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.interego.native-commit+json', 'If-None-Match': '*' } });
    const elsewhere = await guestCheckpointUrl(d.deps.subtle, `${PODS}${guest.userId}/`, guest.ownerDid, 'hallowmarch');
    for (const url of [elsewhere, `${PODS}${guest.userId}/foxxi/notes.json`, `${PODS}${guest.userId}/auth-methods.jsonld`,
      guest.checkpointUrl.replace(guest.userId, `u-try-play-${'b'.repeat(32)}`)]) {
      expect((await put(url)).status, url).toBe(403);
    }
    expect(d.stored.size).toBe(1);
  });

  it('is not kept, and leaves no record, when identity does not take the grant as the relay\'s', async () => {
    const d = deployment({ namespace: 'foxxi', relaySigns: false });
    await expect(keep(d)).rejects.toMatchObject({ code: 'guest_not_admitted' });
    expect(d.kept).toBeUndefined();
    expect(d.stored.size).toBe(0);
    expect(await keptGuest(d.deps)).toBeNull();
  });

  it('is not kept when the bridge issues no grants, or its service has no account: the offer is absent or the grant refused', async () => {
    expect(await durableGuestOffer(BRIDGE, deployment({ grantsEnabled: false }).deps)).toBeNull();
    const d = deployment({ serviceAccount: false });
    await expect(keep(d)).rejects.toMatchObject({ code: 'guest_grant_refused' });
    expect(d.kept).toBeUndefined();
  });

  it('where the deployment has terms, is kept only with the version the guest agreed to, inside the signed proof', async () => {
    const d = deployment({ namespace: 'foxxi', terms: true });
    const offer = await durableGuestOffer(BRIDGE, d.deps);
    expect(offer?.terms).toEqual({ version: '2026-11-06-r2', url: 'https://identity.example/terms', privacyUrl: expect.any(String) as string });
    await expect(keep(d)).rejects.toMatchObject({ code: 'guest_terms_required' });
    await expect(keep(d, '2020-01-01')).rejects.toMatchObject({ code: 'guest_terms_required' });
    expect(d.requests.some(line => line.includes('/play/grant'))).toBe(false);   // nothing was asked for without the agreement
    expect((await keep(d, '2026-11-06-r2')).userId).toMatch(/^u-try-play-/);
  });

  it('is forgotten once its deadline has passed, or its document is gone, or the browser is told to forget it', async () => {
    const expired = deployment({ namespace: 'foxxi' });
    await keep(expired);
    expired.advance(86_400_000 + 1000);
    expect(await keptGuest(expired.deps)).toBeNull();
    expect(expired.kept).toBeUndefined();

    const gone = deployment({ namespace: 'foxxi' });
    await keep(gone);
    gone.stored.clear();
    await expect(openKeptGuest(gone.deps)).rejects.toMatchObject({ code: 'guest_gone' });
    expect(gone.kept).toBeUndefined();

    const told = deployment({ namespace: 'foxxi' });
    await keep(told);
    await forgetKeptGuest(told.deps);
    expect(await keptGuest(told.deps)).toBeNull();
    await expect(openKeptGuest(told.deps)).rejects.toBeInstanceOf(DurableGuestError);
  });

  it('a document someone swapped for another does not open, and the record is dropped', async () => {
    const d = deployment({ namespace: 'foxxi' });
    const guest = await keep(d);
    const other = deployment({ namespace: 'foxxi' });
    await keep(other);
    d.stored.set(new URL(guest.checkpointUrl).pathname, [...other.stored.values()][0]!);
    await expect(openKeptGuest(d.deps)).rejects.toMatchObject({ code: 'guest_unreadable' });
    expect(d.kept).toBeUndefined();
  });
});

describe('the bridge\'s grant service', () => {
  it('is off unless both the service key and the audience are set, and refuses a half or malformed configuration at start', () => {
    expect(playGrantConfig({})).toBeNull();
    expect(() => playGrantConfig({ FOXXI_PLAY_AUDIENCE: DASHBOARD })).toThrow(/both/);
    expect(() => playGrantConfig({ FOXXI_PLAY_SERVICE_PRIVATE_KEY: SERVICE_KEY })).toThrow(/both/);
    expect(() => playGrantConfig({ FOXXI_PLAY_SERVICE_PRIVATE_KEY: 'not-a-key', FOXXI_PLAY_AUDIENCE: DASHBOARD })).toThrow(/hex private key/);
    expect(() => playGrantConfig({ FOXXI_PLAY_SERVICE_PRIVATE_KEY: SERVICE_KEY, FOXXI_PLAY_AUDIENCE: `${DASHBOARD}/app` })).toThrow(/HTTPS origin/);
    expect(() => playGrantConfig({ FOXXI_PLAY_SERVICE_PRIVATE_KEY: SERVICE_KEY, FOXXI_PLAY_AUDIENCE: 'http://foxxi.example' })).toThrow(/HTTPS origin/);
    expect(playGrantConfig({ FOXXI_PLAY_SERVICE_PRIVATE_KEY: SERVICE_KEY, FOXXI_PLAY_AUDIENCE: DASHBOARD })?.audience).toBe(DASHBOARD);
  });

  it('signs only what it can check the shape of, under its own configured audience, and signs in once for many grants', async () => {
    const d = deployment({ namespace: 'foxxi' });
    const thumbprint = 'A'.repeat(43), challenge = 'c'.repeat(32);
    const first = await d.grants!.grant({ publicKeyThumbprint: thumbprint, challenge });
    const signed = JSON.parse(first.playGrant._signed_payload) as Record<string, unknown>;
    expect(signed).toMatchObject({ purpose: 'interego-play-provisional-v1', audience: DASHBOARD, publicKeyThumbprint: thumbprint, challenge,
      agent_id: SERVICE.agentDid, subject_pod_url: SERVICE.podUrl });
    expect(Number(signed['expiresAt']) - Math.floor(d.now / 1000)).toBeLessThanOrEqual(120);
    await d.grants!.grant({ publicKeyThumbprint: thumbprint, challenge: 'd'.repeat(32) });
    expect(d.requests.filter(line => line.endsWith('/auth/siwe'))).toHaveLength(1);

    for (const bad of [{}, { publicKeyThumbprint: thumbprint }, { publicKeyThumbprint: 'short', challenge }, { publicKeyThumbprint: thumbprint, challenge: 'x' },
      { publicKeyThumbprint: thumbprint, challenge, audience: 'https://evil.example' }, { publicKeyThumbprint: thumbprint, challenge, purpose: 'other' }, null, 'text']) {
      await expect(d.grants!.grant(bad), JSON.stringify(bad)).rejects.toMatchObject({ status: 400, code: 'invalid_play_grant_request' });
    }
  });

  it('never returns its key or its token: in a grant, in its status, or in an error', async () => {
    const d = deployment({ namespace: 'foxxi' });
    const granted = JSON.stringify(await d.grants!.grant({ publicKeyThumbprint: 'A'.repeat(43), challenge: 'c'.repeat(32) }));
    const status = await d.grants!.status();
    expect(status).toMatchObject({ enabled: true, ready: true, audience: DASHBOARD, serviceWallet: service.address,
      service: { userId: SERVICE.userId, agentDid: SERVICE.agentDid, podUrl: SERVICE.podUrl, asSignedByRelay: true } });
    const refused = deployment({ serviceAccount: false });
    const refusedStatus = await refused.grants!.status();
    expect(refusedStatus).toMatchObject({ enabled: true, ready: false, service: null });
    for (const out of [granted, JSON.stringify(status), JSON.stringify(refusedStatus)]) {
      expect(out).not.toContain(SERVICE_KEY);
      expect(out).not.toContain(SERVICE_KEY.slice(2));
      expect(out).not.toContain('cg2_service');
    }
  });
});

describe('the grant route, as the bridge hands it a request', () => {
  /**
   * Found on the first run against the live services (2026-11-12): every browser's grant request
   * was answered 400. The bridge's request middleware adds `__client_ip` to each JSON body, and
   * `grant` refuses a body with any key but its two. The tests above call `grant` directly, so none
   * of them carried what the route really receives.
   */
  it('grants a body that carries the bridge\'s own additions, and still refuses anything else a caller adds', async () => {
    const d = deployment({ namespace: 'foxxi' });
    const asked = { publicKeyThumbprint: 'A'.repeat(43), challenge: 'c'.repeat(32) };
    const asRouted = { ...asked, __client_ip: '203.0.113.7', __caller_token: 'whatever-the-client-sent' };
    await expect(d.grants!.grant(asRouted)).rejects.toMatchObject({ status: 400 });            // the defect, reproduced
    const granted = await d.grants!.grant(playGrantRequestBody(asRouted));
    expect(JSON.parse(granted.playGrant._signed_payload)).toMatchObject(asked);
    expect(granted.playGrant._signed_payload).not.toContain('203.0.113.7');
    expect(granted.playGrant._signed_payload).not.toContain('whatever-the-client-sent');
    for (const extra of [{ audience: 'https://evil.example' }, { __proto_ip: 'x' }, { _client_ip: 'x' }, { client_ip: 'x' }]) {
      await expect(d.grants!.grant(playGrantRequestBody({ ...asRouted, ...extra })), JSON.stringify(extra)).rejects.toMatchObject({ status: 400 });
    }
    for (const notAnObject of [null, 'text', ['a'], 7]) expect(playGrantRequestBody(notAnObject)).toBe(notAnObject);
  });

  it('the route passes the body through that step, and the middleware still adds exactly those two names', () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    expect(server).toContain('playGrants.grant(playGrantRequestBody(req.body))');
    expect(server).not.toContain('playGrants.grant(req.body)');
    // If the middleware starts adding another name, this fails and the helper must learn it.
    const added = [...server.matchAll(/bodyRec\.(__[a-z_]+)\s*=/g)].map(match => match[1]).sort();
    expect(added).toEqual(['__caller_token', '__client_ip']);
  });
});

describe('the browser\'s record', () => {
  /**
   * An IndexedDB whose one transaction settles as `outcome` says, after its request has succeeded:
   * the order a real one keeps (the request's success event comes before the commit).
   */
  function indexedDb(outcome: 'complete' | 'abort') {
    const events: string[] = [];
    const held = new Map<string, unknown>();
    const factory = {
      open: () => {
        const open: Record<string, unknown> = {};
        const database = {
          createObjectStore: () => undefined, close: () => { events.push('close'); },
          transaction: () => {
            const transaction: Record<string, unknown> = { error: outcome === 'abort' ? new Error('QuotaExceededError') : null };
            const request: Record<string, unknown> = { result: undefined, error: null };
            const settle = (act: () => void) => {
              queueMicrotask(() => {
                act(); events.push('request success');
                (request['onsuccess'] as (() => void) | undefined)?.();
                queueMicrotask(() => {
                  events.push(`transaction ${outcome}`);
                  (transaction[outcome === 'complete' ? 'oncomplete' : 'onabort'] as (() => void) | undefined)?.();
                });
              });
              return request;
            };
            transaction['objectStore'] = () => ({
              get: (key: string) => settle(() => { request['result'] = held.get(key); }),
              put: (value: unknown, key: string) => settle(() => { if (outcome === 'complete') held.set(key, value); }),
              delete: (key: string) => settle(() => { if (outcome === 'complete') held.delete(key); }),
            });
            return transaction;
          },
        };
        queueMicrotask(() => { open['result'] = database; (open['onsuccess'] as (() => void) | undefined)?.(); });
        return open;
      },
    } as unknown as IDBFactory;
    return { factory, events, held };
  }
  const guest = { version: 1, address: '0xabc' } as unknown as StoredGuest;

  it('is stored only once its transaction has committed, and read back after one', async () => {
    const db = indexedDb('complete');
    const store = indexedDbGuestStore(db.factory);
    await store.put(guest);
    expect(db.events.slice(0, 2)).toEqual(['request success', 'transaction complete']);
    expect(await store.get()).toEqual(guest);
    await store.delete();
    expect(await store.get()).toBeUndefined();
  });

  it('a write whose request succeeded but whose transaction aborted is a failure, so no guest is told they are kept', async () => {
    const db = indexedDb('abort');
    await expect(indexedDbGuestStore(db.factory).put(guest)).rejects.toThrow(/QuotaExceededError/);
    expect(db.events).toEqual(['request success', 'transaction abort', 'close']);
    expect(db.held.size).toBe(0);

    // And keeping a guest on such a browser fails as a whole: keepGuest throws, the caller signs in the tab-only guest.
    const d = deployment({ namespace: 'foxxi' });
    const offer = await durableGuestOffer(BRIDGE, d.deps);
    await expect(keepGuest({ bridgeUrl: BRIDGE, offer: offer!, phrase: PHRASE, address: guestWallet.address },
      { ...d.deps, store: indexedDbGuestStore(db.factory) })).rejects.toThrow(/QuotaExceededError/);
  });
});
