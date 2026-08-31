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
import { agpArtifactGraph } from '../bridge/pod-helpers.js';

const AGP = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';
const VICTIM = 'did:ethr:0x8f3b8e9396003c4e25a89CA2ec4D2Bec54C679Fd';

describe('published attribution is not the caller\'s to choose', () => {
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
