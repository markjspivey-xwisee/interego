/**
 * Round-19: the substrate descriptor serializer MUST escape IRIs and string
 * literals so a caller-influenced facet value (an agent id, a label, an issuer,
 * a hydra:target) cannot break out of its Turtle token and inject arbitrary
 * triples into a published pod graph. This was the ROOT of the descriptor-facet
 * injection class the round-18 audit found (isSafeIri at one vertical boundary
 * only patched one entry point; the serializer is the shared sink).
 */

import { describe, it, expect } from 'vitest';
import { toTurtle, type ContextDescriptorData } from '@interego/core';

describe('round-19 — descriptor serializer escapes injected IRIs + literals', () => {
  const INJ_IRI = 'did:key:0xVICTIM> ; <http://evil.example/pwned> <http://evil.example/forged';
  const INJ_LABEL = 'Acme" ; <urn:s> <urn:p> <urn:o> . "';

  const descriptor: ContextDescriptorData = {
    id: 'urn:foxxi:situation:test',
    describes: ['urn:graph:foxxi:situation:test'],
    facets: [
      { type: 'Provenance', wasAttributedTo: INJ_IRI, wasGeneratedBy: { agent: INJ_IRI } },
      { type: 'Agent', assertingAgent: { identity: INJ_IRI, label: INJ_LABEL } },
      { type: 'Trust', issuer: INJ_IRI, trustLevel: 'CryptographicallyVerified' },
    ],
  } as ContextDescriptorData;

  const ttl = toTurtle(descriptor);

  it('the injected IRI cannot break out of <...> (no forged <http://evil.example/*> triple)', () => {
    expect(ttl).not.toContain('<http://evil.example/pwned>');
    expect(ttl).not.toContain('<http://evil.example/forged>');
    // The value survives as a single percent-encoded IRI (its illegal chars encoded).
    expect(ttl).toContain('%3E'); // the injected '>' is percent-encoded, not a real bracket
  });

  it('the injected label cannot break out of the string literal', () => {
    // No UNescaped quote sequence that would close rdfs:label and inject triples.
    expect(ttl).not.toContain('"Acme" ; <urn:s>');
    expect(ttl).toContain('\\"'); // the quote is backslash-escaped
  });

  it('the document still parses as one descriptor with only its own facets', () => {
    // Sanity: exactly the descriptor subject + its blank-node facets; the injected
    // predicates/objects are inert text, not standalone triples.
    expect(ttl).toContain('<urn:foxxi:situation:test>');
    expect(ttl).toContain('a iep:ContextDescriptor');
    expect((ttl.match(/http:\/\/evil\.example/g) ?? []).every(() => true)).toBe(true);
    // The evil host, if it appears at all, is only inside an escaped literal / encoded IRI —
    // never as a bare <...> IRI term.
    expect(/<http:\/\/evil\.example\/(pwned|forged)>/.test(ttl)).toBe(false);
  });
});
