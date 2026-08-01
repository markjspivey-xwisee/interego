#!/usr/bin/env tsx
/**
 * Who the interop surface accepts as a caller.
 *
 * ★ WHY THIS EXISTS. The agent card advertises this relay's OAuth authorization server
 * with `bearer: true`. A peer that followed it exactly — discovered the AS, completed
 * PKCE, got an access token — was refused 401 by every interop route, because the caller
 * check consulted only the IDENTITY server's token store and never the relay's own OAuth
 * provider, which is what `/mcp` uses.
 *
 * One relay, two notions of "a verified bearer"; the same token good on one surface and
 * worthless on another; and the instructions for getting it published by the surface that
 * rejected it. Measured live against production: 200 from `/mcp` and 401 from
 * `/a2a/v1/message:send`, same token, same second.
 *
 * ★ Mutation-checked, each applied and the suite re-run: dropping the OAuth branch fails
 * 4; dropping the identity fallback fails 4; returning a placeholder for a verified-but-
 * anonymous token fails 2; treating an OAuth throw as a refusal fails 3.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/interop-principal.test.ts
 */

import { resolveInteropPrincipal, type InteropPrincipalDeps } from '../interop-principal.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ID = 'https://identity.test';
const WEBID = (u: string) => `${ID}/users/${u}/profile#me`;

/** Neither verifier knows anything. The base case every other one overrides from. */
const NOBODY: InteropPrincipalDeps = {
  verifyOAuth: async () => { throw new Error('not an access token'); },
  verifyIdentity: async () => ({ authenticated: false }),
  identityUrl: ID,
};

const deps = (o: Partial<InteropPrincipalDeps>): InteropPrincipalDeps => ({ ...NOBODY, ...o });

async function main(): Promise<void> {
  console.log('\nthe credential the CARD advertises');

  ok(
    await resolveInteropPrincipal('Bearer oauth-tok', deps({
      verifyOAuth: async () => ({ userId: 'u-eth-abc' }),
    })) === WEBID('u-eth-abc'),
    '★ a relay OAuth access token is accepted — this is the defect being fixed',
  );

  ok(
    await resolveInteropPrincipal('Bearer oauth-tok', deps({
      verifyOAuth: async () => ({ agentId: 'did:web:agents.test:bot-7', userId: 'u-eth-abc' }),
    })) === 'did:web:agents.test:bot-7',
    'an agent DID wins over the owner WebID — attribution is to the acting agent',
  );

  console.log('\nthe credential headless callers already use');

  ok(
    await resolveInteropPrincipal('Bearer identity-tok', deps({
      verifyIdentity: async () => ({ authenticated: true, userId: 'u-eth-def' }),
    })) === WEBID('u-eth-def'),
    '★ an identity-server token still works — the fix adds a path, it removes none',
  );

  ok(
    await resolveInteropPrincipal('Bearer identity-tok', deps({
      verifyIdentity: async () => ({ authenticated: true, agentId: 'did:web:x' }),
    })) === 'did:web:x',
    'its agent id is preferred too',
  );

  console.log('\nrefusals');

  for (const [header, why] of [
    [undefined, 'no header at all'],
    ['', 'an empty header'],
    ['Basic abc', 'a non-Bearer scheme'],
    ['Bearer ', 'a Bearer with no token'],
  ] as [string | undefined, string][]) {
    ok(await resolveInteropPrincipal(header, deps({
      verifyOAuth: async () => ({ userId: 'u-should-not-be-reached' }),
      verifyIdentity: async () => ({ authenticated: true, userId: 'u-should-not-be-reached' }),
    })) === undefined, `${why} is refused without consulting any verifier`);
  }

  ok(
    await resolveInteropPrincipal('Bearer junk', NOBODY) === undefined,
    'a token neither verifier vouches for is refused',
  );

  console.log('\n★ a token that VERIFIES but carries no principal is not a caller');

  // Returning a placeholder here would drop every such caller into ONE engagement-owner
  // bucket — and owner-scoping is the entirety of this surface's authorization, so
  // everyone in that bucket could read and cancel everyone else's engagements.
  ok(
    await resolveInteropPrincipal('Bearer anon', deps({
      verifyOAuth: async () => ({}),
    })) === undefined,
    'an OAuth token with neither agentId nor userId yields undefined, not a placeholder',
  );

  ok(
    await resolveInteropPrincipal('Bearer anon', deps({
      verifyIdentity: async () => ({ authenticated: true }),
    })) === undefined,
    '...and so does an authenticated identity token with no principal',
  );

  console.log('\nthe two verifiers do not interfere');

  // ★ An OAuth THROW must not end the attempt. Treating "this is not one of mine" as a
  // refusal is precisely the bug: the identity-server token is still legitimate.
  ok(
    await resolveInteropPrincipal('Bearer identity-tok', deps({
      verifyOAuth: async () => { throw new Error('invalid_token'); },
      verifyIdentity: async () => ({ authenticated: true, userId: 'u-eth-ghi' }),
    })) === WEBID('u-eth-ghi'),
    '★ an OAuth rejection falls through to the identity server rather than refusing',
  );

  ok(
    await resolveInteropPrincipal('Bearer anon-oauth', deps({
      verifyOAuth: async () => ({}),
      verifyIdentity: async () => ({ authenticated: true, userId: 'u-eth-jkl' }),
    })) === WEBID('u-eth-jkl'),
    'a verified-but-anonymous OAuth token also falls through',
  );

  let identityCalls = 0;
  await resolveInteropPrincipal('Bearer oauth-tok', deps({
    verifyOAuth: async () => ({ userId: 'u-eth-abc' }),
    verifyIdentity: async () => { identityCalls++; return { authenticated: false }; },
  }));
  ok(identityCalls === 0, 'a successful OAuth verification does not also hit the identity server');

  // Neither verifier is consulted about the other's tokens, so order is a latency choice
  // and never an authority one. Pinned so a future reordering stays behaviour-preserving.
  ok(
    await resolveInteropPrincipal('Bearer both', deps({
      verifyOAuth: async () => ({ userId: 'from-oauth' }),
      verifyIdentity: async () => ({ authenticated: true, userId: 'from-identity' }),
    })) === WEBID('from-oauth'),
    'when both would vouch, the card-advertised credential decides',
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
