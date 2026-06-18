/**
 * projectHolon typed-facet enrichment → interrogative-router round-trip.
 *
 * The load-bearing integration test the adversarial review found MISSING: nothing
 * else exercises projectHolon's descriptor OUTPUT against the router (the router's
 * own test feeds a hand-written fixture). This builds a real holon, projects it with
 * typedFacets:true, and routes over the EXACT bytes — so the demo can't silently
 * regress to all-`absent`. Also pins the default-OFF isolation + descriptorUrl
 * invariance (the content-address contract).
 */
import { describe, it, expect } from 'vitest';
import type { IRI } from '@interego/core';
import { createPGSL, ingest, projectHolon, routeInterrogatives, type InterrogativeType } from '@interego/pgsl';

const CG = 'https://markjspivey-xwisee.github.io/interego/ns/cg#';
const prov = { wasAttributedTo: 'did:ethr:0xabc' as IRI, generatedAtTime: '2026-06-18T00:00:00.000Z' };
const base = 'https://pod.example/foxxi-lattice/';

function build() {
  const pgsl = createPGSL(prov);
  const uri = ingest(pgsl, ['alpha', 'beta', 'gamma'], prov);
  const node = pgsl.nodes.get(uri);
  if (!node) throw new Error('no node');
  return { pgsl, node };
}
function answer(turtle: string, t: InterrogativeType) {
  const r = routeInterrogatives({ turtle, interrogatives: [t] });
  if (!r.ok) throw new Error(r.error);
  return r.answers[0]!;
}

describe('projectHolon typedFacets → interrogative router', () => {
  it('lights up Who/When/WhatKind = full, Why/How/Whether = partial', () => {
    const { pgsl, node } = build();
    const ttl = projectHolon(node, pgsl, { descriptorBase: base, typedFacets: true, contentType: 'foxxi:Verification' }).descriptorTurtle;

    const who = answer(ttl, 'Who');
    expect(who.status).toBe('full');
    expect((who.values as any).assertingAgent.identity).toBe('did:ethr:0xabc');

    const when = answer(ttl, 'When');
    expect(when.status).toBe('full');
    expect((when.values as any).validFrom).toBe('2026-06-18T00:00:00.000Z');

    const wk = answer(ttl, 'WhatKind');
    expect(wk.status).toBe('full');
    expect((wk.values as any).interpretationFrame).toBe('urn:cg:contenttype:foxxi%3AVerification');

    expect(answer(ttl, 'Why').status).toBe('partial');
    expect(answer(ttl, 'How').status).toBe('partial');

    const whether = answer(ttl, 'Whether');
    expect(whether.status).toBe('partial');
    // Demo holons are unsigned → SelfAsserted, NEVER CryptographicallyVerified.
    expect((whether.values as any).trustLevel).toBe(`${CG}SelfAsserted`);
  });

  it('default OFF → no typed facets, manifest unchanged, descriptorUrl invariant', () => {
    const { pgsl, node } = build();
    const off = projectHolon(node, pgsl, { descriptorBase: base });
    const on = projectHolon(node, pgsl, { descriptorBase: base, typedFacets: true, contentType: 'foxxi:Verification' });

    expect(off.descriptorTurtle).toContain('cg:hasFacetType cg:Projection');
    expect(off.descriptorTurtle).not.toContain('cg:hasFacet ');
    expect(off.manifestEntry.facetTypes).toEqual(['Projection']);
    // The slug is content-addressed from node.uri, independent of body bytes.
    expect(on.descriptorUrl).toBe(off.descriptorUrl);
    // Enriched descriptor still carries the back-compat Projection marker.
    expect(on.descriptorTurtle).toContain('cg:hasFacetType cg:Projection');
    expect(on.descriptorTurtle).toContain('a cg:AgentFacet');
  });

  it('default OFF → router returns absent (proves the enrichment is what lights it up)', () => {
    const { pgsl, node } = build();
    const off = projectHolon(node, pgsl, { descriptorBase: base }).descriptorTurtle;
    expect(answer(off, 'Who').status).toBe('absent');
    expect(answer(off, 'When').status).toBe('absent');
  });
});
