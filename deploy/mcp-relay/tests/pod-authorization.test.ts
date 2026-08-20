#!/usr/bin/env tsx
/**
 * A pod URL the relay minted is not an address a stranger proposed.
 *
 * ★★ THE BUG. `requireAuthorizedPodUrl` screened EVERY pod URL with `assertPublicPodUrl`, whose
 * job is refusing attacker-chosen addresses. `/notifications/:podSlug` takes no pod URL from the
 * caller — it reads `podSlugToUrl`, which the relay filled from `CSS_URL`
 * (`http://css.railway.internal:3456/` in production). Measured against the shipped guard:
 *
 *   assertPublicPodUrl('http://css.railway.internal:3456/u-eth-…/') -> throws "pod URL must use https"
 *
 * so the endpoint returned 400 `pod_url_rejected` to every caller — while `publish_context` handed
 * that URL out as `notifications.sse_url` and told them to open an EventSource on it.
 *
 * The public spelling failed too, further down: the owner URL is also built from `CSS_URL`, so a
 * public supplied URL cleared the screen and then lost the origin comparison with 403. Both
 * spellings of one store refused, by two different guards.
 *
 * Every case here pairs a refusal with an acceptance, because "refuses the bad one" is satisfied
 * by a function that refuses everything — which is exactly what this endpoint was doing.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/pod-authorization.test.ts
 */
import { authorizePodUrl } from '../pod-authorization.js';
import { assertPublicPodUrl } from '../url-rewrite.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};

const INTERNAL = 'http://css.railway.internal:3456';
const PUBLIC = 'https://gate.interego.xwisee.com';
const STORE = new Set([INTERNAL, PUBLIC]);
const MINE = 'u-eth-9bf50894ff23';
const THEIRS = 'u-eth-8f3b8e939600';

/** The REAL screen, not a stand-in: a harness that stands in for it cannot verify it. */
const screen = (u: string): URL => assertPublicPodUrl(u, []);

const authz = (suppliedUrl: string, ownerPodUrl: string, relayMinted: boolean) =>
  authorizePodUrl({ suppliedUrl, ownerPodUrl, storeOrigins: STORE, relayMinted, screen });

// ── 1. THE BUG: a relay-minted internal URL is authorized, not screened ──────
{
  const r = authz(`${INTERNAL}/${MINE}/`, `${INTERNAL}/${MINE}/`, true);
  ok('relay-minted internal URL is authorized', r.ok, !r.ok ? `${r.status} ${r.error}` : '');

  // And the same value, if a CALLER had proposed it, is still refused. This is the pair that
  // proves the screen was not weakened — only relocated to the values it is for.
  const s = authz(`${INTERNAL}/${MINE}/`, `${INTERNAL}/${MINE}/`, false);
  ok('the same URL from a caller is still screened', !s.ok, 'the SSRF screen stopped applying');
  ok('caller-supplied internal URL refuses with pod_url_rejected',
    !s.ok && s.error === 'pod_url_rejected', !s.ok ? s.error : '');
  ok('and refuses with the screen\'s own reason',
    !s.ok && /https/i.test(s.detail), !s.ok ? s.detail : '');
}

// ── 2. THE SECOND FAILURE: one store, two spellings ─────────────────────────
{
  // Caller holds the public spelling; the token resolves to the internal one. Before the fold this
  // cleared the screen and then lost the origin comparison.
  const r = authz(`${PUBLIC}/${MINE}/`, `${INTERNAL}/${MINE}/`, false);
  ok('public supplied vs internal owner is authorized', r.ok, !r.ok ? `${r.status} ${r.error}` : '');

  const s = authz(`${INTERNAL}/${MINE}/`, `${PUBLIC}/${MINE}/`, true);
  ok('internal minted vs public owner is authorized', s.ok, !s.ok ? `${s.status} ${s.error}` : '');
}

// ── 3. The fold must not become an ownership bypass ─────────────────────────
// This is what the origin fold could have cost, so it is asserted from both spellings.
{
  const r = authz(`${PUBLIC}/${THEIRS}/`, `${INTERNAL}/${MINE}/`, false);
  ok('another pod on the same store is refused', !r.ok && r.status === 403, !r.ok ? String(r.status) : 'authorized');

  const s = authz(`${INTERNAL}/${THEIRS}/`, `${INTERNAL}/${MINE}/`, true);
  ok('another pod, relay-minted, is still refused', !s.ok && s.status === 403, !s.ok ? String(s.status) : 'authorized');

  // A subpath of my own pod stays allowed — the prefix rule, not an equality rule.
  const t = authz(`${INTERNAL}/${MINE}/notes/`, `${INTERNAL}/${MINE}/`, true);
  ok('a subpath of my own pod is authorized', t.ok, !t.ok ? String(t.status) : '');

  // ★ A sibling whose name merely STARTS WITH mine must not pass the prefix test.
  const u = authz(`${INTERNAL}/${MINE}-evil/`, `${INTERNAL}/${MINE}/`, true);
  ok('a pod whose slug extends mine is refused', !u.ok && u.status === 403, !u.ok ? String(u.status) : 'authorized');
}

// ── 4. A foreign host is unaffected by the fold ─────────────────────────────
{
  // Not in storeOrigins, so it still needs an exact origin match with the owner.
  const r = authz('https://other.example.com/pod/', `${INTERNAL}/${MINE}/`, false);
  ok('a foreign store is refused', !r.ok, 'a non-store origin was folded in');

  const s = authz('https://other.example.com/pod/', 'https://other.example.com/pod/', false);
  ok('a foreign store matching its own owner is authorized', s.ok, !s.ok ? `${s.status} ${s.error}` : '');
}

// ── 5. relayMinted is a claim about provenance, and is still checked ────────
{
  // The flag says "this came from our state" — it does not mean "trust anything".
  const r = authz('https://attacker.example/pod/', `${INTERNAL}/${MINE}/`, true);
  ok('a relay-minted URL off our store is refused', !r.ok, 'the flag became a bypass');
  ok('and it is reported as a server-side fault, not a client error',
    !r.ok && r.status === 500 && r.error === 'pod_url_not_our_store', !r.ok ? `${r.status} ${r.error}` : '');

  const s = authz('not a url', `${INTERNAL}/${MINE}/`, true);
  ok('a malformed relay-minted URL is refused', !s.ok && s.error === 'pod_url_malformed', !s.ok ? s.error : '');
}

// ── 6. A malformed owner URL cannot authorize anything ──────────────────────
{
  const r = authz(`${INTERNAL}/${MINE}/`, 'not a url', true);
  ok('a malformed owner refuses', !r.ok && r.error === 'owner_pod_malformed', !r.ok ? r.error : '');
}

console.log(`pod-authorization: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
