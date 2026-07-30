#!/usr/bin/env tsx
/**
 * The authorization-code flow, end to end, over real HTTP.
 *
 * ★ WHY THIS FILE EXISTS. The relay's OAuth Authorization Server is the single most
 * security-critical component it has — it fronts live authentication for the claude.ai
 * and ChatGPT connectors — and NOTHING drove it end to end. `oauth-token-persistence`
 * calls the provider's methods directly; `dpop.test.ts` validates DPoP proofs in
 * isolation (its `/token` references are just `htu` strings). No test had ever mounted
 * the router and walked /register → /authorize → /token.
 *
 * That gap is the reason this exists BEFORE any attempt to internalise the AS off the
 * frozen `@modelcontextprotocol/server-legacy`. You do not rewrite a security-critical
 * component that has no end-to-end test: the test is what makes the rewrite verifiable
 * rather than hopeful. Swap the router underneath, re-run this, and the behaviour is
 * either identical or the diff is visible.
 *
 * It is also worth having on its own terms — it pins PKCE enforcement, single-use
 * codes, redirect_uri binding and client binding, none of which were asserted anywhere.
 *
 * WHAT IT MOUNTS. `mcpAuthRouter` with the REAL `InteregoOAuthProvider`, which is the
 * composition the relay ships. It does not boot the whole relay (server.ts has
 * top-level awaits on a compliance wallet and an OAuth-client load that need a
 * reachable pod, and `app.listen` sits after them). Where the relay adds middleware
 * that changes the flow, this models it — see the DPoP note below.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { interegoOAuthRouter } from '../oauth-router.js';
import { InteregoOAuthProvider, type ResolvedIdentity } from '../oauth-provider.js';

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
};

const IDENTITY: ResolvedIdentity = {
  userId: 'u-flow', agentId: 'urn:agent:test:flow',
  ownerWebId: 'https://example.invalid/u-flow/profile#me',
  podUrl: 'https://example.invalid/u-flow/', identityToken: 'identity-bearer',
};

const ISSUER = new URL('https://relay.example.invalid/');
const REDIRECT = 'https://client.example.invalid/callback';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());

const provider = new InteregoOAuthProvider({
  identityUrl: 'https://identity.invalid',
  tokenTtlSec: 3600,
  initialClients: new Map(),
  resourceIdentifier: ISSUER.href,
  log: () => {},
});

const app = express();
app.use(interegoOAuthRouter({ provider, issuerUrl: ISSUER }));
const server = app.listen(0);
await new Promise<void>(r => server.once('listening', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const postForm = (path: string, body: Record<string, string>) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(body),
    redirect: 'manual',
  });

console.log('\nAuthorization server: /register -> /authorize -> /token, end to end');

try {
  // ── Dynamic Client Registration ──────────────────────────────────────────
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'flow-test', redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none',
    }),
  });
  const client = await reg.json() as { client_id?: string };
  ok(reg.status === 201 || reg.status === 200, 'POST /register issues a client', `HTTP ${reg.status}`);
  ok(typeof client.client_id === 'string' && client.client_id.length > 0,
    '…with a client_id', JSON.stringify(client).slice(0, 120));
  const clientId = client.client_id!;

  // ── /authorize renders the passwordless picker and stashes a pending auth ─
  const authUrl = `${base}/authorize?${form({
    client_id: clientId, response_type: 'code', redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp', state: 'st-1',
    resource: ISSUER.href,
  })}`;
  const authRes = await fetch(authUrl, { redirect: 'manual' });
  const html = await authRes.text();
  ok(authRes.status === 200, 'GET /authorize serves the method picker', `HTTP ${authRes.status}`);
  // The page carries the pending id the browser posts back after proving identity.
  const pendingId = /const PENDING_ID = "([0-9a-f]+)"/.exec(html)?.[1];
  ok(!!pendingId, '…carrying a pending-authorization id', html.slice(0, 120));

  // ── PKCE is actually enforced ────────────────────────────────────────────
  // Mint a code, then exchange it with the WRONG verifier. This is the check that
  // makes the authorization code useless to anyone who intercepts it.
  {
    const r = provider.completePendingAuthorization(pendingId!, IDENTITY)!;
    const bad = await postForm('/token', {
      grant_type: 'authorization_code', code: r.code,
      code_verifier: b64url(randomBytes(32)), redirect_uri: REDIRECT, client_id: clientId,
    });
    ok(bad.status >= 400, 'a code exchanged with the WRONG PKCE verifier is refused', `HTTP ${bad.status}`);
  }

  // ── The happy path ───────────────────────────────────────────────────────
  const authRes2 = await fetch(authUrl, { redirect: 'manual' });
  const pending2 = /const PENDING_ID = "([0-9a-f]+)"/.exec(await authRes2.text())?.[1]!;
  const granted = provider.completePendingAuthorization(pending2, IDENTITY)!;
  ok(granted.state === 'st-1', 'the grant round-trips `state` (CSRF binding)', String(granted.state));
  ok(granted.redirectUri === REDIRECT, '…and redirects only to the registered URI', granted.redirectUri);

  const tokRes = await postForm('/token', {
    grant_type: 'authorization_code', code: granted.code,
    code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId,
    resource: ISSUER.href,
  });
  const tokens = await tokRes.json() as { access_token?: string; refresh_token?: string; token_type?: string; scope?: string };
  ok(tokRes.status === 200, 'POST /token exchanges the code', `HTTP ${tokRes.status}`);
  ok(typeof tokens.access_token === 'string', '…returning an access token', JSON.stringify(tokens).slice(0, 100));
  ok(typeof tokens.refresh_token === 'string', '…and a refresh token');

  // ── The token carries the identity the whole substrate authorizes on ─────
  const info = await provider.verifyAccessToken(tokens.access_token!);
  const extra = (info as { extra?: Record<string, unknown> }).extra ?? {};
  ok(extra.agentId === IDENTITY.agentId, 'the token carries the resolved agentId', String(extra.agentId));
  ok(extra.userId === IDENTITY.userId, '…and userId (every write is attributed by these)', String(extra.userId));
  ok(extra.podUrl === IDENTITY.podUrl, '…and the authoritative podUrl', String(extra.podUrl));
  ok(info.resource?.href === ISSUER.href, '…and the RFC 8707 audience', String(info.resource?.href));

  // ── An authorization code is single-use ──────────────────────────────────
  {
    const replay = await postForm('/token', {
      grant_type: 'authorization_code', code: granted.code,
      code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId,
    });
    ok(replay.status >= 400, 'replaying a spent authorization code is refused', `HTTP ${replay.status}`);
  }

  // ── Refresh ──────────────────────────────────────────────────────────────
  {
    const r = await postForm('/token', {
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: clientId,
    });
    const refreshed = await r.json() as { access_token?: string };
    ok(r.status === 200 && typeof refreshed.access_token === 'string',
      'a refresh token exchanges for a fresh access token', `HTTP ${r.status}`);
    ok(refreshed.access_token !== tokens.access_token, '…which is a DIFFERENT token', 'rotation');
  }

  // ── An unknown client cannot start a flow ────────────────────────────────
  {
    const r = await fetch(`${base}/authorize?${form({
      client_id: 'not-a-registered-client', response_type: 'code', redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: 'S256',
    })}`, { redirect: 'manual' });
    ok(r.status >= 400, 'an unregistered client_id cannot begin authorization', `HTTP ${r.status}`);
  }

  // ── A redirect_uri the client never registered is refused ────────────────
  {
    const r = await fetch(`${base}/authorize?${form({
      client_id: clientId, response_type: 'code', redirect_uri: 'https://attacker.example.invalid/steal',
      code_challenge: challenge, code_challenge_method: 'S256',
    })}`, { redirect: 'manual' });
    ok(r.status >= 400,
      'an unregistered redirect_uri is refused (the code must not be deliverable elsewhere)',
      `HTTP ${r.status}`);
  }

  // ── PKCE is mandatory, not optional ──────────────────────────────────────
  {
    const r = await fetch(`${base}/authorize?${form({
      client_id: clientId, response_type: 'code', redirect_uri: REDIRECT,
    })}`, { redirect: 'manual' });
    ok(r.status >= 400 || /error/i.test(r.headers.get('location') ?? ''),
      'an authorization request with no code_challenge is refused (PKCE is required)',
      `HTTP ${r.status} ${r.headers.get('location') ?? ''}`);
  }
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
