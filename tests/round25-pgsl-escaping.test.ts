/**
 * Round-25: the PGSL Turtle serializer (packages/pgsl/src/rdf.ts) must escape
 * caller-derived atom values + provenance IRIs. A caller value flows into a
 * public-commons atom via /agent/publish-memory and is then served
 * UNAUTHENTICATED as Turtle at /agent/lattice/public-memories/holon?as=rdf, so
 * an unescaped `"` / newline in `pgsl:value "…"` or `>` in a `prov:wasAttributedTo
 * <…>` IRI broke out of the literal / IRIREF and injected forged triples
 * (prov:wasAttributedTo attribution forgery) into the graph a federated reader
 * parses. This is the 5th layer of the injection class (core rdf/serializer →
 * solid client wrapper+manifest → core delegation → solid anchors/directory →
 * PGSL atom serializer) — the missed sibling sink the round-24 audit found.
 */

import { describe, it, expect } from 'vitest';
import { createPGSL, ingest, pgslToTurtle, type IRI, type NodeProvenance } from '@interego/pgsl';

describe('round-25 — pgslToTurtle escapes injected atom values + provenance IRIs', () => {
  it('a quote/newline in an atom value cannot break out of pgsl:value "…"; a > in the provenance IRI cannot break out of <…>', () => {
    // A malicious provenance IRI (the agent DID an /agent/publish-memory body is
    // attributed to) trying to break out of the <…> IRIREF and inject a triple.
    const INJ_AGENT = 'did:ethr:0xVICTIM> <urn:evil-p> <urn:evil-o> . <urn:sink' as IRI;
    const prov: NodeProvenance = {
      wasAttributedTo: INJ_AGENT,
      generatedAtTime: '2026-07-23T00:00:00Z',
    };
    const pgsl = createPGSL(prov);

    // A malicious body value trying to break out of the "…" literal and forge an
    // attribution triple (the live-verified round-24 vector).
    const INJ_VALUE = 'pwn" .\n<urn:evil> <http://www.w3.org/ns/prov#wasAttributedTo> <did:ethr:0xVICTIM> .\n#';
    ingest(pgsl, [INJ_VALUE], prov);

    const ttl = pgslToTurtle(pgsl);

    // IRI-position injection: the '>' in the provenance IRI is percent-encoded, so
    // the injected predicate/object cannot survive as bare <…> terms.
    for (const t of ['<urn:evil-p>', '<urn:evil-o>', '<urn:sink>']) {
      expect(ttl.includes(t), t).toBe(false);
    }
    expect(ttl.includes('%3E')).toBe(true); // the injected '>' is encoded

    // LITERAL-position injection: the value's `"` is backslash-escaped and its
    // newlines are `\n`-escaped, so there is no real `"…" .` triple terminator
    // followed by a bare injected triple — the injected content stays inert text.
    expect(/pgsl:value "[^"\\]*"\s*\.\s*</.test(ttl)).toBe(false);
    expect(ttl.includes('\\"')).toBe(true);   // the value's quote is escaped
    // A raw (unescaped) newline must not appear inside the pgsl:value literal.
    expect(/pgsl:value "[^"]*\n/.test(ttl)).toBe(false);
  });
});
