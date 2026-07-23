/**
 * Round-27: the PGSL projection serializer (packages/pgsl/src/projection.ts) must
 * escape the caller-derived provenance IRI. projectHolon() builds an
 * iep:ContextDescriptor by string interpolation; node.provenance.wasAttributedTo
 * is caller-derived (the DELEGATED /agent/publish-memory path returns the signed
 * agent_id verbatim), so an unescaped `>` in that id broke out of the `<…>` IRIREF
 * and injected forged triples into a descriptor served UNAUTH via the public
 * commons (the 6th layer of the hand-built-RDF injection class).
 */

import { describe, it, expect } from 'vitest';
import { createPGSL, ingest, projectHolon, type IRI, type NodeProvenance } from '@interego/pgsl';

describe('round-27 — projectHolon escapes the injected provenance IRI', () => {
  it('a > in provenance.wasAttributedTo cannot break out of <…> (plain + typedFacets)', () => {
    const INJ = 'did:ethr:0xVICTIM> <urn:evil-p> <urn:evil-o> . <urn:sink' as IRI;
    const prov: NodeProvenance = { wasAttributedTo: INJ, generatedAtTime: '2026-07-23T00:00:00Z' };
    const pgsl = createPGSL(prov);
    const uri = ingest(pgsl, ['a memory body'], prov);
    const node = pgsl.nodes.get(uri)!;

    for (const typedFacets of [false, true]) {
      const { descriptorTurtle } = projectHolon(node, pgsl, {
        descriptorBase: 'https://foxxi-bridge.example/desc',
        typedFacets,
        contentType: 'foxxi:Memory',
      });
      for (const t of ['<urn:evil-p>', '<urn:evil-o>', '<urn:sink>']) {
        expect(descriptorTurtle.includes(t), `${t} (typedFacets=${typedFacets})`).toBe(false);
      }
      // The injected '>' is percent-encoded, so wasAttributedTo stays a single IRIREF.
      expect(descriptorTurtle.includes('%3E'), `%3E (typedFacets=${typedFacets})`).toBe(true);
      // No bare injected triple terminator survives after the prov IRI.
      expect(/prov:wasAttributedTo <[^>]*> \. </.test(descriptorTurtle), `no breakout (typedFacets=${typedFacets})`).toBe(false);
    }
  });
});
