/**
 * agp authenticates nobody — this pins the three properties that make that SAFE.
 *
 * ── THE DECISION, AND WHY IT IS NOT "ADD AUTH" ───────────────────────────────
 *
 * This bridge is public and verifies no caller. Twice on 2026-08-31 that produced a real
 * defect: caller-aimed fetches reached 169.254.169.254 and 10.0.0.5 (SSRF), and a
 * caller-supplied `operator_did` became the published `prov:wasAttributedTo` with
 * `trustLevel: SelfAsserted` (the #168 shape). Both are fixed.
 *
 * The remaining question was whether agp must verify signed requests the way Foxxi does. It
 * must not, yet, and the reason is the substrate's own model rather than convenience:
 *
 *   1. THE BRIDGE HOLDS NO CREDENTIAL. It cannot lend authority it does not have. A caller can
 *      only ask it to write AS NOBODY.
 *   2. ATTRIBUTION IS NOT THE CALLER'S TO CHOOSE. Whatever gets written says the bridge said
 *      it — so a write that lands cannot impersonate anyone.
 *   3. THE POD'S ACL IS THE AUTHORITY. A write succeeds only where the pod's owner chose to
 *      allow it. That is what self-sovereign means here: the resource decides, not the bridge.
 *
 * Under those three, "no auth" costs a spam vector, not an integrity one. Remove ANY of them
 * and the argument collapses — property 1 turns the bridge into a confused deputy, property 2
 * restores #168, property 3 is not ours to hold. So they are asserted here rather than left as
 * a paragraph someone can invalidate without noticing. A fourth leg — that caller-supplied
 * targets are screened — is asserted alongside them, since it is what makes an unauthenticated
 * fetch surface safe to expose at all.
 *
 * Each leg drives the bridge and asserts on what it does. An earlier version grepped the
 * bridge source for two identifiers; that passed unchanged on the vulnerable code it was
 * written to guard, because the identifiers also occur in an unrelated function.
 *
 * This is a POSTURE test. It does not claim agp is secure; it claims the specific reasoning
 * that made "no auth" acceptable is still true. If it fails, revisit the decision.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agpAttributionFacets, publishAgpArtifact, fetchJson } from '../bridge/pod-helpers.js';
import { asIri } from './turtle-position.js';
import type { IRI } from '@interego/core';

const POD = 'https://pod.example.test/me/';
const AGP_NS = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';
const VICTIM = 'did:ethr:0x8f3b8e9396003c4e25a89CA2ec4D2Bec54C679Fd';

interface Captured { url: string; method: string; body: string; headers: Record<string, string> }

/** Captures what the bridge would put on the wire, so these legs assert BEHAVIOUR rather
 *  than the presence of an identifier in the source. */
function captureFetch(redirectTo?: string): { fetchFn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : '', headers });
    if (redirectTo) return new Response('', { status: 302, headers: { location: redirectTo } });
    if (method === 'GET' || method === 'HEAD') return new Response('', { status: 404 });
    return new Response('', { status: 201, headers: { location: url } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const BRIDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge');

function bridgeSource(): string {
  return readdirSync(BRIDGE_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => readFileSync(join(BRIDGE_DIR, f), 'utf8'))
    // Strip line comments so the long rationale above a guard cannot satisfy a check — the
    // exact way one of today's gates matched its own documentation and could never fail.
    .map(t => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'))
    .join('\n');
}

describe('the posture that makes an unauthenticated agp acceptable', () => {
  it('reads real bridge source — an empty read would pass every assertion below', () => {
    const src = bridgeSource();
    expect(src.length).toBeGreaterThan(2000);
    expect(src, 'not reading the handlers').toContain('createAgpHandlers');
  });

  it('★ 1. the bridge holds NO credential — it has no authority to lend', () => {
    const src = bridgeSource();
    // A credential here would make an unauthenticated caller a confused deputy: it could
    // direct the bridge to act with power the caller does not have.
    for (const marker of ['Authorization', 'Bearer ', '_signed_payload', 'WALLET_SEED',
                          'PRIVATE_KEY', 'ISSUER_KEY']) {
      expect(
        src.includes(marker),
        `agp's bridge now references ${marker}. If it carries a credential, "authenticates `
          + `nobody" stops being safe — an anonymous caller would be directing an authorised `
          + `writer. Add caller verification before adding a credential.`,
      ).toBe(false);
    }
  });

  it('★ 2. attribution is fixed to the bridge, not chosen by the caller', async () => {
    // Asserted on the BYTES the publisher writes. An earlier version of this leg called
    // `agpAttributionFacets` and checked its arity — which stayed green through a full revert
    // of the fix, because the reverted publisher simply stopped calling the helper.
    const { fetchFn, calls } = captureFetch();
    await publishAgpArtifact({
      iri: 'urn:agp:capability:posture-probe' as IRI, typeIri: `${AGP_NS}Capability`,
      label: 'posture probe', podUrl: POD, slug: 'posture-probe', fetchFn,
      author: { id: VICTIM, kind: 'agent' as const },
      properties: [{ predicate: `${AGP_NS}composedOf`, object: { iri: 'urn:agp:skill:probe' } }],
    });
    const written = calls.filter(c => c.method !== 'GET').map(c => c.body).join(String.fromCharCode(10));
    expect(written, 'nothing was written — the assertion below would be vacuous').toContain('urn:agp:bridge:agent');
    for (const predicate of ['prov:wasAttributedTo', 'iep:agentIdentity', 'iep:issuer']) {
      expect(
        written,
        `${predicate} no longer names the bridge — #168 is back, and with it the reason an `
          + 'unauthenticated bridge was acceptable',
      ).toContain(`${predicate} <urn:agp:bridge:agent>`);
    }
    // The caller's claim is kept as a quoted literal; promoted to an IRI it becomes an identity.
    expect(
      asIri(written, VICTIM),
      'the caller-supplied operator appears as an IRI rather than a claim',
    ).toBe(false);

    // Cheap secondary: the builder must stay caller-unreachable.
    expect(agpAttributionFacets.length, 'agpAttributionFacets gained a parameter').toBe(1);
  });

  it('★ 3. the POD decides — the bridge sends no credential on a pod write', async () => {
    // The leg the docblock names and the previous version never asserted: a write succeeds
    // only where the pod owner allowed it. That holds precisely because the bridge presents
    // no authority of its own, so assert it on the REQUEST, where the pod would see it.
    const { fetchFn, calls } = captureFetch();
    await publishAgpArtifact({
      iri: 'urn:agp:capability:acl-probe' as IRI, typeIri: `${AGP_NS}Capability`,
      label: 'acl probe', podUrl: POD, slug: 'acl-probe', fetchFn,
      properties: [{ predicate: `${AGP_NS}composedOf`, object: { iri: 'urn:agp:skill:probe' } }],
    });
    expect(calls.length, 'no request was made — nothing to inspect').toBeGreaterThan(0);
    for (const c of calls) {
      for (const h of ['authorization', 'cookie', 'dpop', 'x-api-key']) {
        expect(
          c.headers[h] === undefined,
          `the bridge sent ${h} to ${c.url}. If it carries authority, the pod's ACL stops `
            + 'being the decider and an anonymous caller is directing an authorised writer.',
        ).toBe(true);
      }
    }
  });

  it('★ 4. a caller-supplied target is screened — including across a redirect', async () => {
    // ── THE INSTRUMENT, AND WHY THE OBVIOUS ONE DOES NOT WORK ──────────────────────────────
    //
    // This leg began as a `toContain` over the concatenated bridge source, so the import line
    // alone satisfied it and it stayed green with every guard call site deleted. The first
    // rewrite drove `fetchJson` but asserted only that the result was NULL — which a raw,
    // unguarded fetch also produces, because the mock throws and `fetchJson` catches. Two
    // routes to the same green is evidence for neither, and that version passed on the
    // reverted code too. MEASURED both times.
    //
    // So assert on whether the private address was REACHED, with a mock that reaches it: a
    // real fetch follows redirects, and the guard's whole job on the second hop is that it
    // does not. The mock therefore honours `redirect: 'manual'` (what safeFetch sets) and
    // otherwise follows, exactly as the platform would.
    const PRIVATE = 'http://169.254.169.254/latest/meta-data/';
    const reached: string[] = [];
    const followingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      reached.push(url);
      if (url === PRIVATE) return new Response('{"secret":"leaked"}', { status: 200 });
      const res = new Response('', { status: 302, headers: { location: PRIVATE } });
      if (init?.redirect === 'manual') return res;
      // A raw fetch would follow. Emulate that, or the mutant cannot be detected.
      reached.push(PRIVATE);
      return new Response('{"secret":"leaked"}', { status: 200 });
    }) as unknown as typeof fetch;

    // 1. A directly private target must be refused before a socket opens.
    const direct = await fetchJson(PRIVATE, POD, followingFetch);
    expect(reached, 'the pre-connect screen did not run — a link-local target was fetched').toEqual([]);
    expect(direct, 'a link-local target returned a body').toBeNull();

    // 2. The redirect chain is part of the target: a PUBLIC first hop that 302s to a private
    //    address must not be followed. This is the hop a pre-check alone does not cover.
    reached.length = 0;
    const viaRedirect = await fetchJson('https://public.example.test/thing.json', POD, followingFetch);
    expect(
      reached.filter(u => u.includes('169.254.169.254')),
      'the fetch followed a redirect into link-local space and read what it found there',
    ).toEqual([]);
    expect(viaRedirect, 'a redirect to a link-local address produced a body').toBeNull();
  });
});
