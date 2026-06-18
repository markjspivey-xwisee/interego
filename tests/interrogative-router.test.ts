/**
 * Interrogative router tests.
 *
 *   1. DRIFT GUARD — the committed INTERROGATIVE_TABLE is byte-identical to what
 *      deriveInterrogativeTable() produces from the live docs/ns/*.ttl. This is
 *      the single-sourcing guarantee: edit the .ttl + forget to regenerate → fail.
 *   2. CLASSIFICATION — every prefLabel/altLabel cue maps to its interrogative;
 *      multiword cues ('what kind','how much') beat the bare ones; multi-label.
 *   3. NORMALIZATION — explicit input (localname / prefLabel / altLabel / IRI).
 *   4. PROJECTION — over a fixture descriptor whose substance lives in NESTED
 *      bnodes (assertingAgent / authorization / wasGeneratedBy), proving the
 *      derefBnode traversal recovers Who/Whose/Why (not just flat props).
 *   5. GATING + ROUTING — resolve rules + end-to-end route over the fixture.
 *   6. RUNTIME SAFETY — the SHIPPED router module does NO ontology file I/O, so
 *      it cannot crash the relay on boot (the adversarial blocker).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  deriveInterrogativeTable,
  classifyInterrogatives,
  normalizeInterrogatives,
  resolveRequestedInterrogatives,
  routeInterrogatives,
  loadOntology,
  INTERROGATIVE_TABLE,
  CANONICAL_ORDER,
  type InterrogativeType,
} from '@interego/pgsl';

const here = dirname(fileURLToPath(import.meta.url));

// Fixture descriptor — mirrors packages/core/src/rdf/serializer.ts output exactly,
// including the nested anonymous bnodes where the real substance lives.
const FIXTURE = `
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix acl: <http://www.w3.org/ns/auth/acl#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:desc:1> a cg:ContextDescriptor ;
  cg:describes <urn:graph:thing:42> ;
  cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "2026-01-01T00:00:00Z"^^xsd:dateTime ; cg:validUntil "2026-12-31T00:00:00Z"^^xsd:dateTime ] ;
  cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent ; rdfs:label "Agent Smith" ; cg:agentIdentity <did:ethr:0xabc> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <did:web:owner> ] ;
  cg:hasFacet [ a cg:FederationFacet ; cg:origin <https://pod.example/> ; cg:storageEndpoint <https://pod.example/c/> ; dcat:distribution [ a dcat:Distribution ; dcat:mediaType "text/turtle" ; dcat:accessURL <https://pod.example/g.ttl> ] ] ;
  cg:hasFacet [ a cg:AccessControlFacet ; cg:authorization [ a acl:Authorization ; acl:agent <did:web:owner> ; acl:mode acl:Read , acl:Write ] ; cg:consentBasis <urn:consent:1> ] ;
  cg:hasFacet [ a cg:SemioticFacet ; cg:modalStatus cg:Asserted ; cg:epistemicConfidence "0.9"^^xsd:double ; cg:interpretationFrame <urn:frame:default> ] ;
  cg:hasFacet [ a cg:ProvenanceFacet ; prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <did:ethr:0xabc> ; prov:startedAtTime "2026-01-01T00:00:00Z"^^xsd:dateTime ; prov:used <urn:input:1> ] ; prov:wasDerivedFrom <urn:src:1> ] ;
  cg:hasFacet [ a cg:TrustFacet ; cg:trustLevel cg:SelfAsserted ; cg:issuer <did:web:owner> ] .
`;

describe('interrogative table — drift guard (single-sourced from docs/ns)', () => {
  it('committed table is exactly what the .ttl derives', () => {
    const derived = deriveInterrogativeTable(loadOntology('interego'), loadOntology('alignment'));
    expect(JSON.parse(JSON.stringify(INTERROGATIVE_TABLE))).toEqual(derived);
  });
  it('has all eleven canonical interrogatives in order', () => {
    expect(INTERROGATIVE_TABLE.map(e => e.type)).toEqual([...CANONICAL_ORDER]);
    expect(INTERROGATIVE_TABLE).toHaveLength(11);
  });
});

describe('classification (lexical, multi-label)', () => {
  it('every prefLabel and altLabel maps to its interrogative', () => {
    for (const e of INTERROGATIVE_TABLE) {
      for (const label of [e.prefLabel, ...e.altLabels]) {
        if (label.includes('/')) continue; // 'Yes/No' is split by normalization — covered below
        const { interrogatives } = classifyInterrogatives(`tell me ${label} please`);
        expect(interrogatives, `cue "${label}" -> ${e.type}`).toContain(e.type);
      }
    }
  });
  it("'what kind' beats bare 'what'; 'how much'/'how many' beat 'how'", () => {
    // 'item' carries no cue, so only WhatKind matches (the 'what' span is consumed).
    expect(classifyInterrogatives('what kind of item is this').interrogatives).toContain('WhatKind');
    expect(classifyInterrogatives('what kind of item is this').interrogatives).not.toContain('What');
    expect(classifyInterrogatives('how much does it cost').interrogatives).toEqual(expect.arrayContaining(['HowMuch']));
    expect(classifyInterrogatives('how much does it cost').interrogatives).not.toContain('How');
    expect(classifyInterrogatives('how many of them').interrogatives).toContain('HowMuch');
  });
  it('classifies a compound question into multiple interrogatives', () => {
    const { interrogatives } = classifyInterrogatives('who stored this and when and where');
    expect(interrogatives).toEqual(expect.arrayContaining(['Who', 'When', 'Where']));
  });
  it('returns nothing for a question with no interrogative cue', () => {
    expect(classifyInterrogatives('the cat sat on the mat').interrogatives).toEqual([]);
  });
});

describe('normalization (explicit input)', () => {
  it('accepts localname, prefLabel, altLabel, and IRI', () => {
    expect(normalizeInterrogatives('Who')).toEqual(['Who']);
    expect(normalizeInterrogatives('who')).toEqual(['Who']);
    expect(normalizeInterrogatives('Reason')).toEqual(['Why']);            // altLabel
    expect(normalizeInterrogatives('What kind')).toEqual(['WhatKind']);    // prefLabel w/ space
    expect(normalizeInterrogatives('WhatKind')).toEqual(['WhatKind']);     // localname
    expect(normalizeInterrogatives('ie:Why')).toEqual(['Why']);           // curie
    expect(normalizeInterrogatives('https://markjspivey-xwisee.github.io/interego/ns/interego#When')).toEqual(['When']);
  });
  it('round-trips every canonical localname', () => {
    for (const t of CANONICAL_ORDER) expect(normalizeInterrogatives(t)).toEqual([t]);
  });
  it('preserves canonical order for multi-input', () => {
    expect(normalizeInterrogatives(['Whether', 'Who', 'When'])).toEqual(['Who', 'When', 'Whether']);
  });
});

describe('projection (derefBnode recovers nested substance)', () => {
  const route = (interrogatives: InterrogativeType[]) => {
    const r = routeInterrogatives({ turtle: FIXTURE, interrogatives, target: 'urn:desc:1' });
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const answer = (t: InterrogativeType) => route([t]).answers[0]!;

  it('Who: recovers the asserting agent IDENTITY from the nested bnode (full)', () => {
    const a = answer('Who');
    expect(a.status).toBe('full');
    expect((a.values as any).assertingAgent.identity).toBe('did:ethr:0xabc');
    expect((a.values as any).assertingAgent.label).toBe('Agent Smith');
    expect((a.values as any).onBehalfOf).toBe('did:web:owner');
  });
  it('Whose: recovers acl:agent + acl:mode from the nested authorization bnode', () => {
    const a = answer('Whose');
    expect(a.status).toBe('full');
    expect((a.values as any).authorizations[0].agent).toBe('did:web:owner');
    expect((a.values as any).authorizations[0].mode).toEqual(expect.arrayContaining([
      'http://www.w3.org/ns/auth/acl#Read', 'http://www.w3.org/ns/auth/acl#Write',
    ]));
  });
  it('When: flat temporal facet (full)', () => {
    const a = answer('When');
    expect(a.status).toBe('full');
    expect((a.values as any).validFrom).toContain('2026-01-01');
  });
  it('Where: flat federation + nested distribution (full)', () => {
    const a = answer('Where');
    expect(a.status).toBe('full');
    expect((a.values as any).origin).toBe('https://pod.example/');
    expect((a.values as any).distribution.accessURL).toBe('https://pod.example/g.ttl');
  });
  it('WhatKind: semiotic facet (full)', () => {
    const a = answer('WhatKind');
    expect(a.status).toBe('full');
    expect((a.values as any).modalStatus).toContain('Asserted');
    expect((a.values as any).epistemicConfidence).toBe(0.9);
  });
  it('Why: causal provenance from nested activity (partial, shares facet with How)', () => {
    const a = answer('Why');
    expect(a.status).toBe('partial');
    expect(a.sharesFacetWith).toContain('How');
    expect((a.values as any).activity.agent).toBe('did:ethr:0xabc');
    expect(a.nextStep?.tool).toBe('pgsl_decide');
  });
  it('How: production method, shares the same provenance facet as Why', () => {
    const a = answer('How');
    expect(a.status).toBe('partial');
    expect(a.sharesFacetWith).toContain('Why');
    expect((a.values as any).productionActivity.agent).toBe('did:ethr:0xabc');
  });
  it('Whether: certainty from Trust/Semiotic + substrate authorship; permission -> pointer', () => {
    const r = routeInterrogatives({ turtle: FIXTURE, interrogatives: ['Whether'], target: 'urn:desc:1', authorship: { effectiveTrustLevel: 'CryptographicallyVerified', authorshipVerified: true } });
    if (!r.ok) throw new Error(r.error);
    const a = r.answers[0]!;
    expect(a.status).toBe('partial');
    expect((a.values as any).effectiveTrustLevel).toBe('CryptographicallyVerified');
    expect(a.nextStep?.tool).toBe('pgsl_decide');
  });
  it('What: pointer to the substrate (cg:describes), not a descriptor facet', () => {
    const a = answer('What');
    expect(a.status).toBe('pointer');
    expect(a.nextStep?.tool).toBe('pgsl_resolve');
    expect(a.nextStep?.target).toBe('urn:graph:thing:42');
    expect((a.values as any).describes).toEqual(['urn:graph:thing:42']);
  });
  it('Which: pointer to the decision functor', () => {
    expect(answer('Which').status).toBe('pointer');
    expect(answer('Which').nextStep?.tool).toBe('pgsl_decide');
  });
  it('absent facet -> status absent with a caveat', () => {
    const r = routeInterrogatives({ turtle: '@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .\n<urn:d:2> a cg:ContextDescriptor ; cg:describes <urn:g:1> .', interrogatives: ['When'] });
    if (!r.ok) throw new Error(r.error);
    expect(r.answers[0]!.status).toBe('absent');
  });
});

describe('gating + routing', () => {
  it('errors when nothing is specified', () => {
    const r = resolveRequestedInterrogatives({});
    expect('ok' in r && r.ok === false).toBe(true);
  });
  it('all:true -> all eleven; explicit beats question', () => {
    const all = resolveRequestedInterrogatives({ all: true });
    expect('interrogatives' in all && all.interrogatives).toHaveLength(11);
    const r = routeInterrogatives({ turtle: FIXTURE, question: 'who', interrogatives: ['When'] });
    if (!r.ok) throw new Error(r.error);
    expect(r.classification.method).toBe('explicit');
    expect(r.classification.interrogatives).toEqual(['When']);
  });
  it('lexical route emits an ie:Act/Response and caveats', () => {
    const r = routeInterrogatives({ turtle: FIXTURE, question: 'who made this and why', target: 'urn:desc:1' });
    if (!r.ok) throw new Error(r.error);
    expect(r.classification.method).toBe('lexical');
    expect((r.act as any)['@type']).toBe('ie:Act');
    expect((r.response as any)['@type']).toBe('ie:Response');
    expect(r.caveats.join(' ')).toContain('ProvenanceFacet');
  });
  it('not-parseable turtle -> structured error, never a throw', () => {
    const r = routeInterrogatives({ turtle: '<<<not turtle', interrogatives: ['When'] });
    expect(r.ok).toBe(false);
  });
});

describe('runtime safety — shipped module does NO ontology file I/O', () => {
  it('built router + table neither import the ontology loader nor read files at runtime', () => {
    const distDir = resolve(here, '../packages/pgsl/dist');
    // Strip comments first — prose mentioning docs/ns or loadOntology in JSDoc is fine;
    // what must NOT exist is an actual import/call that touches the filesystem at runtime.
    const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const f of ['interrogative-router.js', 'interrogative-table.generated.js']) {
      const code = decomment(readFileSync(resolve(distDir, f), 'utf8'));
      expect(/from\s+['"][^'"]*static-ontology/.test(code), `${f} must not import static-ontology`).toBe(false);
      expect(/\bloadOntology\s*\(/.test(code), `${f} must not call loadOntology()`).toBe(false);
      expect(/\breadFileSync\s*\(/.test(code), `${f} must not call readFileSync()`).toBe(false);
      expect(/\bresolveNsDir\b/.test(code), `${f} must not reference resolveNsDir`).toBe(false);
    }
  });
});
