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
import { agpArtifactGraph, agpAttributionFacets } from '../bridge/pod-helpers.js';

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
  it('★ the bridge is the asserting agent — no caller value reaches any identity facet', () => {
    // Driving `publishAgpArtifact` directly stops at `assertSafeFetchTarget`, which does a DNS
    // lookup no offline test can satisfy — the SSRF guard and this function's testability were
    // in tension. So the ATTRIBUTION is now a pure exported function and this asserts on it,
    // rather than on a helper standing beside the decision as the first version did.
    const facets = agpAttributionFacets('2026-08-31T00:00:00.000Z');
    const json = JSON.stringify(facets);

    expect(json, 'the facet set is empty — the assertion below would be vacuous').toContain('Provenance');
    expect(
      json.includes(VICTIM),
      'a caller-supplied operator reached an identity facet — the #168 shape',
    ).toBe(false);

    const prov = facets.find(f => (f as { type?: string }).type === 'Provenance') as unknown as Record<string, unknown>;
    const trust = facets.find(f => (f as { type?: string }).type === 'Trust') as unknown as Record<string, unknown>;
    const agent = facets.find(f => (f as { type?: string }).type === 'Agent') as unknown as Record<string, unknown>;
    expect(prov['wasAttributedTo']).toBe('urn:agp:bridge:agent');
    expect(trust['issuer']).toBe('urn:agp:bridge:agent');
    expect((agent['assertingAgent'] as Record<string, unknown>)['identity']).toBe('urn:agp:bridge:agent');
    // SelfAsserted is only honest because the issuer is the bridge asserting about itself.
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
