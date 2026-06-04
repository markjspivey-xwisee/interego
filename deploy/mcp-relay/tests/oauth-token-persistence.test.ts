#!/usr/bin/env tsx
/**
 * OAuth token persistence smoke test.
 *
 * Verifies the structural fix: a token issued before a relay restart
 * is still valid AFTER the restart, because the provider rehydrates
 * its access-token map from the persistent backing store at startup.
 *
 * The test stubs the network layer with an in-memory FS so it can
 * run without a live CSS pod. The persistence shape (sha256 filename,
 * JSON-LD body, sibling subcontainers under svc-relay-dcr/) is the
 * SAME shape the real store writes — the stub here is purely the
 * HTTP transport.
 *
 * Scenarios:
 *   1. Issue a token, restart (fresh provider), verifyAccessToken
 *      across the restart succeeds via the sha-keyed secondary map.
 *   2. Verify expired tokens loaded at startup are dropped (lazy GC).
 *   3. Verify the rotated-out refresh token gets removed from the
 *      backing store on a successful refresh exchange.
 *   4. Verify verifyAccessToken's expiry branch deletes from the
 *      backing store.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/oauth-token-persistence.test.ts
 */

import { createHash, randomBytes } from 'node:crypto';

import { InteregoOAuthProvider, type ResolvedIdentity } from '../oauth-provider.js';
import {
  loadAccessTokens,
  loadRefreshTokens,
  loadAccessTokenByRaw,
  persistAccessToken,
  persistRefreshToken,
  removeAccessToken,
  removeRefreshToken,
  sha256Hex,
  type OAuthTokenStoreConfig,
} from '../oauth-token-store.js';
import type { FetchFn } from '@interego/core';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

// ── tiny test harness ───────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}`); }
}

// ── In-memory pod stub ──────────────────────────────────────

interface StubFile { contentType: string; body: string; }

function makeStubPod(): { fetch: FetchFn; files: Map<string, StubFile> } {
  const files = new Map<string, StubFile>();
  const fetchFn: FetchFn = (async (url: string, init?: any) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers ?? {};
    if (method === 'PUT') {
      const ct = (headers as Record<string, string>)['Content-Type'] ?? 'text/plain';
      files.set(url, { contentType: ct, body: init?.body ?? '' });
      return { ok: true, status: 201, statusText: 'Created',
               headers: { get: () => null }, text: async () => '', json: async () => ({}) };
    }
    if (method === 'DELETE') {
      const had = files.delete(url);
      return { ok: had, status: had ? 204 : 404, statusText: had ? 'No Content' : 'Not Found',
               headers: { get: () => null }, text: async () => '', json: async () => ({}) };
    }
    if (method === 'GET') {
      // Container listing — synthesize a Turtle ldp:contains listing for any
      // URL that ends in `/`. The store's listContainer only needs the URLs.
      if (url.endsWith('/')) {
        const children = [...files.keys()].filter(k => k.startsWith(url) && k !== url);
        const turtle = children.map(c => `<> <http://www.w3.org/ns/ldp#contains> <${c}> .`).join('\n');
        return { ok: true, status: 200, statusText: 'OK',
                 headers: { get: () => 'text/turtle' },
                 text: async () => turtle, json: async () => ({}) };
      }
      const f = files.get(url);
      if (!f) return { ok: false, status: 404, statusText: 'Not Found',
                       headers: { get: () => null }, text: async () => '', json: async () => ({}) };
      return { ok: true, status: 200, statusText: 'OK',
               headers: { get: (n: string) => n.toLowerCase() === 'content-type' ? f.contentType : null },
               text: async () => f.body, json: async () => JSON.parse(f.body) };
    }
    return { ok: false, status: 405, statusText: 'Method Not Allowed',
             headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  }) as FetchFn;
  return { fetch: fetchFn, files };
}

// ── Test fixtures ───────────────────────────────────────────

const POD = 'https://example.invalid/svc-relay-dcr/';
const IDENTITY: ResolvedIdentity = {
  userId: 'u-test-123',
  agentId: 'urn:agent:test:mcp-test',
  ownerWebId: 'https://example.invalid/u-test-123/profile#me',
  podUrl: 'https://example.invalid/u-test-123/',
  identityToken: 'fake-identity-bearer-token',
};
const CLIENT: OAuthClientInformationFull = {
  client_id: 'cid-abc',
  client_id_issued_at: Math.floor(Date.now() / 1000),
  redirect_uris: ['https://localhost/cb'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

function makeProvider(pod: ReturnType<typeof makeStubPod>, initialAccess?: Map<string, any>, initialRefresh?: Map<string, any>) {
  const cfg: OAuthTokenStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
  return new InteregoOAuthProvider({
    identityUrl: 'https://identity.invalid',
    tokenTtlSec: 3600,
    initialClients: new Map([[CLIENT.client_id, CLIENT]]),
    initialAccessTokensBySha: initialAccess,
    initialRefreshTokensBySha: initialRefresh,
    persistAccessToken: (token, info) => persistAccessToken(token, info, cfg),
    persistRefreshToken: (rt, rec) => persistRefreshToken(rt, rec, cfg),
    removeAccessToken: (sha) => removeAccessToken(sha, cfg),
    removeRefreshToken: (sha) => removeRefreshToken(sha, cfg),
    lookupAccessTokenByRaw: (token) => loadAccessTokenByRaw(token, cfg),
    log: () => {},
  });
}

async function issueToken(provider: InteregoOAuthProvider): Promise<{ access: string; refresh: string }> {
  // Direct-issue path: there's no public `mintForTest` so we drive the
  // pending-authorization → code-exchange flow used by the real server.
  const pendingId = randomBytes(8).toString('hex');
  // @ts-expect-error reach into private state — test-only seam.
  provider['pendingAuthorizations'].set(pendingId, {
    client: CLIENT,
    params: { codeChallenge: 'cc', redirectUri: CLIENT.redirect_uris![0]!, scopes: ['mcp'], state: undefined },
    expiresAt: Date.now() + 60_000,
  });
  const r = provider.completePendingAuthorization(pendingId, IDENTITY);
  if (!r) throw new Error('completePendingAuthorization returned null');
  const tokens = await provider.exchangeAuthorizationCode(CLIENT, r.code);
  return { access: tokens.access_token, refresh: tokens.refresh_token! };
}

// Give fire-and-forget persistence promises a chance to settle.
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

// ── Tests ───────────────────────────────────────────────────

async function run() {
  // 1. Issue → restart → verify
  {
    const pod = makeStubPod();
    const cfg: OAuthTokenStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    const provider1 = makeProvider(pod);
    const { access, refresh } = await issueToken(provider1);
    await flush();
    ok(pod.files.size >= 2, 'issuance writes access + refresh files to backing store');
    const accessUrl = `${POD}tokens/${sha256Hex(access)}.jsonld`;
    const refreshUrl = `${POD}tokens-refresh/${sha256Hex(refresh)}.jsonld`;
    ok(pod.files.has(accessUrl), 'access token file lives at tokens/<sha>.jsonld');
    ok(pod.files.has(refreshUrl), 'refresh token file lives at tokens-refresh/<sha>.jsonld');
    ok(!pod.files.get(accessUrl)!.body.includes(access), 'raw access token does NOT appear in persisted file');

    // Simulate restart — load from pod into a fresh provider.
    const initialAccess = await loadAccessTokens(cfg);
    const initialRefresh = await loadRefreshTokens(cfg);
    ok(initialAccess.size === 1, 'loadAccessTokens recovers 1 token after restart');
    ok(initialRefresh.size === 1, 'loadRefreshTokens recovers 1 token after restart');
    const provider2 = makeProvider(pod, initialAccess, initialRefresh);
    const info = await provider2.verifyAccessToken(access);
    ok(info.clientId === CLIENT.client_id, 'verifyAccessToken hits across restart via sha-keyed secondary map');
    ok((info as any).extra?.userId === IDENTITY.userId, 'identity (userId) survives restart');
  }

  // 2. Expired tokens are lazy-GCed at load
  {
    const pod = makeStubPod();
    const cfg: OAuthTokenStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    // Manually write a long-expired access token.
    const fakeToken = randomBytes(16).toString('hex');
    const sha = sha256Hex(fakeToken);
    await persistAccessToken(fakeToken, {
      token: fakeToken,
      clientId: CLIENT.client_id,
      scopes: ['mcp'],
      expiresAt: Math.floor(Date.now() / 1000) - 3600, // 1h ago
      extra: { agentId: IDENTITY.agentId, ownerWebId: IDENTITY.ownerWebId, userId: IDENTITY.userId,
               podUrl: IDENTITY.podUrl, identityToken: IDENTITY.identityToken },
    } as any, cfg);
    ok(pod.files.size === 1, 'manual persistAccessToken wrote one file');
    const loaded = await loadAccessTokens(cfg);
    ok(loaded.size === 0, 'expired token excluded from loadAccessTokens result');
    await flush();
    ok(pod.files.size === 0, 'expired token file deleted by lazy GC during load');
  }

  // 3. Rotated-out refresh token gets removed from the backing store
  {
    const pod = makeStubPod();
    const provider = makeProvider(pod);
    const { refresh: oldRefresh } = await issueToken(provider);
    await flush();
    const oldRefreshUrl = `${POD}tokens-refresh/${sha256Hex(oldRefresh)}.jsonld`;
    ok(pod.files.has(oldRefreshUrl), 'old refresh file present after issuance');
    const refreshed = await provider.exchangeRefreshToken(CLIENT, oldRefresh);
    await flush();
    ok(!pod.files.has(oldRefreshUrl), 'old refresh file removed after rotation');
    const newRefreshUrl = `${POD}tokens-refresh/${sha256Hex(refreshed.refresh_token!)}.jsonld`;
    ok(pod.files.has(newRefreshUrl), 'new refresh file written after rotation');
  }

  // 4. verifyAccessToken expiry branch drops the file
  {
    const pod = makeStubPod();
    const cfg: OAuthTokenStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    const provider = makeProvider(pod);
    const { access } = await issueToken(provider);
    await flush();
    // Tamper with in-memory expiry so verify trips the expired branch.
    // @ts-expect-error test seam
    const info = provider['accessTokens'].get(access);
    info.expiresAt = Math.floor(Date.now() / 1000) - 10;
    try {
      await provider.verifyAccessToken(access);
      ok(false, 'verifyAccessToken should throw on expired token');
    } catch (err: any) {
      ok(err?.message?.toLowerCase().includes('expired'), 'verifyAccessToken throws "expired" on expired token');
    }
    await flush();
    const accessUrl = `${POD}tokens/${sha256Hex(access)}.jsonld`;
    ok(!pod.files.has(accessUrl), 'expired-on-verify deletes the backing-store file');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exit(1);
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
