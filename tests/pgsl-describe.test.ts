/**
 * describeNode — the shared node-description model both the pgsl-browser and the
 * Foxxi bridge resolver render. These tests pin the facets that matter: the
 * downward structure (a triple's items), the upward context (reuse), and the
 * paradigm (source/target at a position, computed from usage).
 */
import { describe, it, expect } from 'vitest';
import { createPGSL, ingest, describeNode, pgslCanonicalUrl, type IRI } from '@interego/pgsl';

const prov = { wasAttributedTo: 'https://example.test/agent' as IRI, generatedAtTime: '2026-07-17T00:00:00Z' };
const href = (u: IRI) => `/node/${encodeURIComponent(u)}`;

/** Nine triples, three subjects sharing predicate/object — real overlap. */
function nineTripleLattice() {
  const P = 'https://p.test/', F = 'https://foaf.test/', A = 'https://rdf.test/type';
  const triples: Array<[string, string, string]> = [
    [P + 'alice', A, F + 'Person'], [P + 'alice', F + 'name', 'Alice'], [P + 'alice', F + 'knows', P + 'bob'],
    [P + 'bob', A, F + 'Person'], [P + 'bob', F + 'name', 'Bob'], [P + 'bob', F + 'knows', P + 'carol'],
    [P + 'carol', A, F + 'Person'], [P + 'carol', F + 'name', 'Carol'], [P + 'carol', F + 'knows', P + 'alice'],
  ];
  const pgsl = createPGSL(prov as never);
  const tripleUris = triples.map(t => ingest(pgsl, [...t] as never, prov as never));
  return { pgsl, triples, tripleUris, A, F, P };
}

describe('describeNode', () => {
  it('returns null for a uri absent from the lattice', () => {
    const { pgsl } = nineTripleLattice();
    expect(describeNode(pgsl, 'urn:pgsl:atom:deadbeef' as IRI, { hrefFor: href })).toBeNull();
  });

  it('describes a triple fragment: downward items resolve to S, P, O', () => {
    const { pgsl, tripleUris, triples } = nineTripleLattice();
    const d = describeNode(pgsl, tripleUris[0]! as IRI, { hrefFor: href })!;
    expect(d.kind).toBe('Fragment');
    expect(d.level).toBe(3);
    expect(d._structure.items).toHaveLength(3);
    // items are in S,P,O order and carry a followable href each
    expect(d._structure.items!.map(i => i.resolved)).toEqual(triples[0]);
    for (const item of d._structure.items!) expect(item.href).toBe(href(item.uri));
    // a level-3 fragment has two overlapping constituents
    expect(d._structure.leftConstituent).toBeDefined();
    expect(d._structure.rightConstituent).toBeDefined();
  });

  it('describes an atom: the shared predicate is ONE node reused by many fragments', () => {
    const { pgsl, A } = nineTripleLattice();
    // find the rdf:type atom by value
    const typeUri = [...pgsl.atoms.entries()].find(([v]) => v === A)?.[1] as IRI;
    expect(typeUri).toBeDefined();
    const d = describeNode(pgsl, typeUri, { hrefFor: href })!;
    expect(d.kind).toBe('Atom');
    expect(d.value).toBe(A);
    // rdf:type is used by all 3 type-triples, so it appears in multiple fragments —
    // this IS the reuse, and every container is a followable url.
    expect(d._context.containers.length).toBeGreaterThan(1);
    for (const c of d._context.containers) expect(c.href).toBe(href(c.uri));
  });

  it('paradigm is computed from EVERY position a node occupies, not a declared role', () => {
    const { pgsl, P, A, F } = nineTripleLattice();
    const aliceUri = [...pgsl.atoms.entries()].find(([v]) => v === P + 'alice')?.[1] as IRI;
    const d = describeNode(pgsl, aliceUri, { hrefFor: href })!;
    // alice is a SUBJECT in three triples -> her targets are the predicates that
    // follow her: rdf:type, foaf:name, foaf:knows.
    const targets = d._paradigm.targetOptions.map(t => t.resolved).sort();
    expect(targets).toEqual([F + 'knows', F + 'name', A].sort());
    // ...and alice is ALSO the OBJECT of "carol foaf:knows alice", so foaf:knows
    // precedes her there. The paradigm reflects usage, so her source is foaf:knows —
    // it does not pretend she is "only a subject".
    expect(d._paradigm.sourceOptions.map(s => s.resolved)).toEqual([F + 'knows']);
  });

  it('every node carries a location-independent canonical URL identity', () => {
    const { pgsl, tripleUris } = nineTripleLattice();
    const d = describeNode(pgsl, tripleUris[0]! as IRI, { hrefFor: href })!;
    // canonical is a URL (honors "every id is a URL"), derived deterministically from
    // the urn, and DISTINCT from href (the location-dependent resolver link).
    expect(d.canonical).toMatch(/^https:\/\//);
    expect(d.canonical).toBe(pgslCanonicalUrl(String(d.uri)));
    expect(d.canonical).not.toBe(d.href);
    // Location-independent: derived purely from the content hash, no host of a copy.
    expect(d.canonical).toContain(String(d.uri).split(':').pop());
  });

  it('pgslCanonicalUrl is deterministic + idempotent', () => {
    const urn = 'urn:pgsl:atom:abc123' as string;
    const once = pgslCanonicalUrl(urn);
    expect(once).toMatch(/#atom-abc123$/);
    // same input -> same output (federation overlap preserved across pods)
    expect(pgslCanonicalUrl(urn)).toBe(once);
    // idempotent: an already-canonical https id is unchanged (never double-wrapped)
    expect(pgslCanonicalUrl(once)).toBe(once);
  });

  it('maxNeighbors caps the fan-out', () => {
    const { pgsl, A } = nineTripleLattice();
    const typeUri = [...pgsl.atoms.entries()].find(([v]) => v === A)?.[1] as IRI;
    const capped = describeNode(pgsl, typeUri, { hrefFor: href, maxNeighbors: 1 })!;
    expect(capped._context.containers.length).toBeLessThanOrEqual(1);
    expect(capped._paradigm.sourceOptions.length).toBeLessThanOrEqual(1);
    expect(capped._paradigm.targetOptions.length).toBeLessThanOrEqual(1);
  });
});
