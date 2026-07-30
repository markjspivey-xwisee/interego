#!/usr/bin/env tsx
/**
 * RFC 8707 audience binding on the authorization server.
 *
 * ★ WHY. The SDK parses the `resource` indicator off /authorize and /token and hands
 * it to the provider — as `params.resource` on `authorize`, and as a trailing argument
 * on `exchangeAuthorizationCode` / `exchangeRefreshToken`. Those parameters did not
 * exist on our provider, so the value was accepted off the wire and SILENTLY DISCARDED.
 * Every token was issued with no audience, and `verifyAccessToken` never looked for one.
 *
 * Protocol revision 2026-07-28 makes this a MUST: a server must validate that a token
 * was issued for IT, and must not accept or transit any other token. The
 * resource-server half of the SDK deliberately does none of it — `verifyBearerToken`
 * checks header shape, verifier, scopes and expiry, and never reads `authInfo.resource`.
 *
 * ★ THE DESIGN POINT THIS FILE PINS: absence is tolerated, mismatch is not.
 *
 * Clients in the field today predate the revision and send no `resource`. Refusing them
 * would have locked every live connector out on deploy. So an absent indicator behaves
 * exactly as before, while a request that DOES name a resource is held to it — which
 * makes the change strictly additive on the day it ships, and lets enforcement tighten
 * as clients catch up. Both halves are asserted, because dropping either one silently
 * turns this into security theatre: enforce-on-absence locks everyone out, and
 * tolerate-on-mismatch means the binding does nothing.
 */

import { InteregoOAuthProvider, type ResolvedIdentity } from '../oauth-provider.js';
import { OAuthError } from '@modelcontextprotocol/server';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import { randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
};

const RESOURCE = 'https://relay.example.invalid/';
const IDENTITY: ResolvedIdentity = {
  userId: 'u-aud', agentId: 'urn:agent:test:aud',
  ownerWebId: 'https://example.invalid/u-aud/profile#me',
  podUrl: 'https://example.invalid/u-aud/', identityToken: 'tok',
};
const CLIENT: OAuthClientInformationFull = {
  client_id: 'cid-aud', client_id_issued_at: Math.floor(Date.now() / 1000),
  redirect_uris: ['https://localhost/cb'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'], token_endpoint_auth_method: 'none',
};

function makeProvider(resourceIdentifier?: string) {
  return new InteregoOAuthProvider({
    identityUrl: 'https://identity.invalid',
    tokenTtlSec: 3600,
    initialClients: new Map([[CLIENT.client_id, CLIENT]]),
    ...(resourceIdentifier ? { resourceIdentifier } : {}),
    log: () => {},
  });
}

/** Drive the pending-authorization → code flow, optionally naming a resource. */
function issueCode(provider: InteregoOAuthProvider, resource?: string): string {
  const pendingId = randomBytes(8).toString('hex');
  // @ts-expect-error test-only seam into private state
  provider['pendingAuthorizations'].set(pendingId, {
    client: CLIENT,
    params: {
      codeChallenge: 'cc', redirectUri: CLIENT.redirect_uris![0]!, scopes: ['mcp'],
      ...(resource ? { resource: new URL(resource) } : {}),
    },
    expiresAt: Date.now() + 60_000,
  });
  const r = provider.completePendingAuthorization(pendingId, IDENTITY);
  if (!r) throw new Error('completePendingAuthorization returned null');
  return r.code;
}

console.log('\nRFC 8707: tokens are bound to the resource they were requested for');

async function run() {
  // ── The token carries the audience it was asked for ──────────────────────
  {
    const p = makeProvider(RESOURCE);
    const tokens = await p.exchangeAuthorizationCode(CLIENT, issueCode(p, RESOURCE), undefined, undefined, new URL(RESOURCE));
    const info = await p.verifyAccessToken(tokens.access_token);
    ok(info.resource?.href === RESOURCE,
      'a token requested for this resource is BOUND to it', String(info.resource?.href));
  }

  // ── Absence stays tolerated — the deployability half ─────────────────────
  {
    const p = makeProvider(RESOURCE);
    const tokens = await p.exchangeAuthorizationCode(CLIENT, issueCode(p));
    const info = await p.verifyAccessToken(tokens.access_token);
    ok(info.resource === undefined,
      'a client that names no resource still gets a token (pre-revision clients keep working)',
      String(info.resource));
  }

  // ── A resource this server is not is REFUSED ─────────────────────────────
  {
    const p = makeProvider(RESOURCE);
    try {
      await p.exchangeAuthorizationCode(
        CLIENT, issueCode(p), undefined, undefined, new URL('https://someone-else.invalid/'));
      ok(false, 'a token for a foreign resource must be refused');
    } catch (err) {
      ok(OAuthError.isInstance(err),
        'a token for a foreign resource is refused with a branded OAuthError',
        String((err as Error).message));
      ok(/invalid_target/.test(String((err as any).errorCode ?? (err as any).code)),
        '…with the RFC 8707 invalid_target code',
        String((err as any).errorCode ?? (err as any).code));
    }
  }

  // ── The exchange may not switch audience mid-flow ────────────────────────
  {
    const p = makeProvider(RESOURCE);
    // Authorized for a sub-path, then exchanged naming the parent: a different
    // audience from the one consent was given for.
    const code = issueCode(p, `${RESOURCE}scoped/`);
    try {
      await p.exchangeAuthorizationCode(CLIENT, code, undefined, undefined, new URL(RESOURCE));
      ok(false, 'an exchange may not name a different resource than the authorization');
    } catch (err) {
      ok(OAuthError.isInstance(err),
        'an exchange naming a DIFFERENT resource than the authorization is refused',
        String((err as Error).message));
    }
  }

  // ── A sub-path resource is allowed (checkResourceAllowed, not string ==) ──
  {
    const p = makeProvider(RESOURCE);
    const sub = `${RESOURCE}mcp`;
    const tokens = await p.exchangeAuthorizationCode(CLIENT, issueCode(p, sub), undefined, undefined, new URL(sub));
    const info = await p.verifyAccessToken(tokens.access_token);
    ok(info.resource?.href === sub,
      'a resource UNDER the configured one is allowed (path-prefix, not equality)',
      String(info.resource?.href));
  }

  // ── Verification refuses a token bound elsewhere ─────────────────────────
  {
    // Mint against one identifier, verify against a server that is a different one.
    const issuer = makeProvider('https://relay-a.invalid/');
    const tokens = await issuer.exchangeAuthorizationCode(
      CLIENT, issueCode(issuer, 'https://relay-a.invalid/'), undefined, undefined,
      new URL('https://relay-a.invalid/'));

    const other = makeProvider('https://relay-b.invalid/');
    // @ts-expect-error test-only seam: plant the foreign-audience token directly, which
    // is exactly the "accept or transit another server's token" case the spec forbids.
    other['accessTokens'].set(tokens.access_token, await issuer.verifyAccessToken(tokens.access_token));
    try {
      await other.verifyAccessToken(tokens.access_token);
      ok(false, 'verifyAccessToken must refuse a token bound to another resource');
    } catch (err) {
      ok(OAuthError.isInstance(err),
        'verifyAccessToken REFUSES a token issued for a different resource', String((err as Error).message));
    }
  }

  // ── Unconfigured: inert, not accidentally enforcing ──────────────────────
  {
    const p = makeProvider(); // no resourceIdentifier — local dev
    const tokens = await p.exchangeAuthorizationCode(
      CLIENT, issueCode(p, RESOURCE), undefined, undefined, new URL(RESOURCE));
    const info = await p.verifyAccessToken(tokens.access_token);
    ok(info.resource?.href === RESOURCE,
      'with no configured identifier the indicator is recorded but not enforced',
      String(info.resource?.href));
  }
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch(err => {
  console.error(`\nharness error: ${(err as Error).stack}`);
  process.exit(1);
});
