/**
 * A caller cannot decide who a published descriptor says asserted it.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 *
 * `publishAgpArtifact` read `args.author?.id ?? 'urn:agp:bridge:agent'`, and `args.author.id`
 * is the `operator_did` a caller puts in the request body. This bridge authenticates NOBODY.
 * So an anonymous request chose all three identity-bearing facets of a published descriptor:
 *
 *   prov:wasAttributedTo   <whatever DID was typed>
 *   assertingAgent         identity: <the same>
 *   Trust                  trustLevel: SelfAsserted, issuer: <the same>
 *
 * `SelfAsserted` means "the subject asserted this about itself". Nobody had. A reader
 * dereferencing that descriptor saw an identity that had done nothing — and descriptors exist
 * to carry attribution, so this is the payload rather than a side effect.
 *
 * It is the shape recorded as #168 (project_credential_issuer_binding): a caller-supplied
 * `issuer_did` deciding what the substrate then states as fact. There it chose a signing key.
 *
 * ── THE FIX, AND WHY IT KEEPS THE CLAIM ──────────────────────────────────────
 *
 * The three facets name the BRIDGE, which is what actually asserted the artifact — that also
 * makes `iep:SelfAsserted` honest rather than borrowed. The caller's `operator_did` is not
 * discarded: it is published as `agp:claimedOperator`, a STRING and explicitly unverified, so
 * a reader can see a claim as a claim. Dropping it would lose real information; promoting it
 * to an identity is the defect.
 */
import { describe, it, expect } from 'vitest';
import { agpArtifactGraph, agpAttributionFacets, publishAgpArtifact } from '../bridge/pod-helpers.js';
import { asIri } from './turtle-position.js';
import type { IRI } from '@interego/core';

/** A non-resolving public host: `assertSafeFetchTarget` classifies it as non-private and its
 *  DNS lookup fails, which that guard treats as ALLOWED (guarded-fetch.ts: a host that does
 *  not resolve poses no SSRF risk). So the publisher runs end to end with no network. */
const POD = 'https://pod.example.test/me/';

/** Records every write the publisher attempts, so the BYTES it would have sent to a pod can
 *  be asserted on. Same idiom as agp-stage2.test.ts, which has driven this function all
 *  along. Never assigned to globalThis.fetch — one realm is shared across suites. */
function captureFetch(): { fetchFn: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return new Response('', { status: 404 });
    if (typeof init?.body === 'string') bodies.push(init.body);
    return new Response('', { status: 201, headers: { location: url } });
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

const AGP = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';
const VICTIM = 'did:ethr:0x8f3b8e9396003c4e25a89CA2ec4D2Bec54C679Fd';

describe('published attribution is not the caller\'s to choose', () => {
  /**
   * ★★ THIS DRIVES `publishAgpArtifact` — THE FUNCTION THAT CHOOSES THE ATTRIBUTION.
   *
   * The first version of this file tested only `agpArtifactGraph`, a pure helper BESIDE the
   * defect, with hand-built properties. So the entire #168-shaped fix could have been reverted
   * with the suite green: nothing asserted what the PUBLISHING function puts in the provenance.
   * An adversarial audit found that, and it is the same defect as the refusal tests it also
   * found - a test placed next to the thing it protects rather than on it.
   *
   * `publishAgpArtifact` takes an injectable `fetchFn`, so it was always drivable. This captures
   * the bytes it tries to write and asserts on THOSE.
   */
  /**
   * ★★ THIS DRIVES `publishAgpArtifact` — THE FUNCTION THAT CHOOSES THE ATTRIBUTION.
   *
   * Two earlier versions of this test did not. The first asserted on `agpArtifactGraph`; an
   * audit found it, so the attribution was extracted to `agpAttributionFacets` and the second
   * version asserted on THAT — a pure helper standing beside the decision, exactly the defect
   * class the first version had. A second audit found the second version the same way, by
   * reverting the fix and watching the suite stay green.
   *
   * The reason given for not driving the publisher — "assertSafeFetchTarget does a DNS lookup
   * no offline test can satisfy" — was FALSE. That guard returns on a lookup failure by
   * design, `publishAgpArtifact` takes an injectable `fetchFn`, and the sibling suite
   * (agp-stage2.test.ts) had been driving it offline since before either version was written.
   * A justification for testing something adjacent is worth checking before it is believed.
   *
   * So: publish for real, capture the bytes, and assert on what a reader would dereference.
   */
  it('★ a caller-supplied operator reaches NO identity facet of the published descriptor', async () => {
    const { fetchFn, bodies } = captureFetch();
    await publishAgpArtifact({
      iri: 'urn:agp:capability:attribution-probe' as IRI,
      typeIri: `${AGP}Capability`,
      label: 'attribution probe',
      podUrl: POD, slug: 'attribution-probe', fetchFn,
      // The caller's claim, in the field a caller controls. Pre-fix this became the
      // published prov:wasAttributedTo / assertingAgent / Trust issuer.
      author: { id: VICTIM, kind: 'agent' as const },
      properties: [{ predicate: `${AGP}composedOf`, object: { iri: 'urn:agp:skill:probe' } }],
    });

    const written = bodies.join(String.fromCharCode(10));
    expect(written, 'the publisher wrote nothing — the assertions below would be vacuous').toContain('urn:agp:bridge:agent');

    // The publisher emits Turtle. Each identity-bearing predicate must name the BRIDGE.
    for (const predicate of ['prov:wasAttributedTo', 'iep:agentIdentity', 'iep:issuer']) {
      expect(
        written,
        `${predicate} does not name the bridge — a caller value reached an identity facet (#168)`,
      ).toContain(`${predicate} <urn:agp:bridge:agent>`);
    }

    // ★ THE DISCRIMINATING ASSERTION. The caller's DID is not absent — it is published as
    // `agp:claimedOperator`, deliberately, as a quoted STRING. What must never happen is its
    // appearance as an IDENTITY, which in Turtle means inside angle brackets. So: the victim
    // occurs, and every occurrence of it is a literal.
    expect(written, 'the caller claim was dropped entirely — that loses real information').toContain(VICTIM);
    expect(
      asIri(written, VICTIM),
      'the caller-supplied operator appears as an IRI — it was promoted from a claim to an '
        + 'identity, which is the #168 shape',
    ).toBe(false);
    expect(written, 'the claim is no longer carried as a claim').toContain(`"${VICTIM}"`);
    // SelfAsserted is only honest because the issuer is the bridge asserting about itself.
    expect(written).toContain('iep:SelfAsserted');
  });

  it('the attribution builder takes no caller-reachable parameter', () => {
    const facets = agpAttributionFacets('2026-08-31T00:00:00.000Z');
    const json = JSON.stringify(facets);
    expect(json).toContain('urn:agp:bridge:agent');
    expect(json.includes(VICTIM)).toBe(false);
    const prov = facets.find(f => (f as { type?: string }).type === 'Provenance') as unknown as Record<string, unknown>;
    const trust = facets.find(f => (f as { type?: string }).type === 'Trust') as unknown as Record<string, unknown>;
    const agent = facets.find(f => (f as { type?: string }).type === 'Agent') as unknown as Record<string, unknown>;
    expect(prov['wasAttributedTo']).toBe('urn:agp:bridge:agent');
    expect(trust['issuer']).toBe('urn:agp:bridge:agent');
    expect((agent['assertingAgent'] as Record<string, unknown>)['identity']).toBe('urn:agp:bridge:agent');
    expect(trust['trustLevel']).toBe('SelfAsserted');
  });

  it('the graph carries a caller-supplied operator as a CLAIM, not an identity', () => {
    const { graphContent } = agpArtifactGraph({
      iri: 'urn:agp:capability:test', typeIri: `${AGP}Capability`, label: 'test',
      properties: [{ predicate: `${AGP}claimedOperator`, object: { literal: VICTIM } }],
    });
    // A string literal — not an IRI, so it cannot be mistaken for an agent node.
    expect(graphContent).toContain(`"${VICTIM}"`);
    expect(
      graphContent,
      'the claimed operator was emitted as an IRI — a reader would read it as an identity',
    ).not.toContain(`<${VICTIM}>`);
  });

  it('★ the term it uses is declared in the vertical\'s own ontology', () => {
    // ontology-lint enforces this repo-wide; asserted here too because the whole point is that
    // a reader can dereference the term and learn that it is UNVERIFIED.
    const ttl = readOntology();
    expect(ttl).toContain('agp:claimedOperator');
    expect(ttl.toLowerCase(), 'the term does not say it is unverified')
      .toMatch(/did not verify|unverified/);
  });
});

function readOntology(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { dirname, join } = require('node:path') as typeof import('node:path');
  const { fileURLToPath } = require('node:url') as typeof import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', 'ontology', 'agp.ttl'), 'utf8');
}
