/**
 * The judgment kit: the rendering primitives every judgment-publishing vertical shares, and
 * the scoring arithmetic. jev-harness's own tests pin that its output did not change when
 * these were extracted; this file pins the kit's contract on its own terms.
 */
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import {
  brierScore, controlLines, documentHeadLines, hmdDocument, payloadPrefixes, rankHits, renderDescriptorTrig,
  attributionLines, lit, dbl, int, iri, HMD_PROFILE, type Control,
} from '../judgment-kit/index.js';

const NS = 'https://example.test/ns/vert#';
const control: Control = {
  id: 'urn:control:vert:j1:confirm', name: 'confirm', title: 'Confirm the answer', action: 'urn:iep:action:vert:confirm',
  method: 'POST', arguments: { judgment_iri: 'urn:graph:vert:j1' }, scopeNote: 'A person confirms.', declarative: true,
};

function payload(): string {
  const S = iri('urn:vert:judgment:j1');
  const P = (l: string): string => `vert:${l}`;
  return [
    ...documentHeadLines(S, { types: [P('Judgment')], title: 'A judgment', prose: '# A judgment\n\nSaid "so".' }),
    `${S} ${P('confidence')} ${dbl(0.42)} .`,
    `${S} ${P('samples')} ${int(3.7)} .`,
    ...attributionLines(S, 'urn:agent:vert', '2026-09-21T02:00:00.000Z'),
    ...controlLines(S, [control], P),
  ].join('\n') + '\n';
}

describe('the payload primitives', () => {
  it('escape literals, truncate integers, and refuse an IRI that is not one', () => {
    expect(lit('a "quoted"\nline')).toBe('"a \\"quoted\\"\\nline"');
    expect(int(3.7)).toBe('"3"^^xsd:integer');
    expect(dbl(Number.NaN)).toBe('"0"^^xsd:double');
    expect(() => iri('not an iri')).toThrow(TypeError);
  });
  it('declare the shared prefixes and then the vertical\'s own', () => {
    const p = payloadPrefixes(NS, 'vert');
    expect(p.split('\n').at(-1)).toBe(`@prefix vert: <${NS}> .`);
    expect(p).toContain('@prefix hmd: ');
    expect(p).toContain('@prefix schema: ');
  });
  it('the head, the attribution and the controls parse as Turtle and carry what the viewer reads', () => {
    const body = payload();
    const quads = new Parser().parse(`${payloadPrefixes(NS, 'vert')}\n\n${body}`);
    const preds = new Set(quads.map((q) => q.predicate.value));
    expect(preds).toContain('https://schema.org/text');
    expect(preds).toContain('http://purl.org/dc/terms/created');
    expect(preds).toContain(`${NS}argumentsJson`);
    expect(body).toContain(`dct:conformsTo <${HMD_PROFILE}>`);
    expect(body).toContain('<urn:control:vert:j1:confirm> a hmd:Control, iep:Affordance, hydra:Operation .');
    expect(body).toContain('<urn:control:vert:j1:confirm> vert:declarative "true"^^xsd:boolean .');
    expect(body).not.toContain('hydra:target');
  });
});

describe('the descriptor', () => {
  const spec = {
    descriptorIri: 'urn:iep:vert:judgment:j1', graphIri: 'urn:graph:vert:j1', status: 'Hypothetical' as const, confidence: 0.42,
    createdAt: '2026-09-21T02:00:00.000Z', model: 'jev-1.13.0', agentId: 'urn:agent:vert', ownerWebId: 'https://id.example/u/1#me',
    base: 'https://vert.example', conformsTo: [`${NS}JudgmentShape`, HMD_PROFILE], payloadUrl: 'https://vert.example/j/j1.trig',
    payloadMediaType: 'application/trig', prefixes: payloadPrefixes(NS, 'vert'), payloadBody: payload(),
  };
  it('renders seven facets, the fetch affordance and the payload graph as TriG that parses', () => {
    const trig = renderDescriptorTrig(spec);
    const quads = new Parser({ format: 'TriG' }).parse(trig);
    const facets = quads.filter((q) => q.predicate.value === 'https://markjspivey-xwisee.github.io/interego/ns/iep#hasFacet');
    expect(facets).toHaveLength(6);
    expect(trig).toContain('iep:modalStatus iep:Hypothetical');
    expect(trig).not.toContain('iep:groundTruth');
    expect(trig).toContain('iep:onBehalfOf <https://id.example/u/1#me>');
    expect(trig).toContain('prov:used <urn:typesafe:model:jev-1.13.0>');
    expect(trig).toContain('hydra:target <https://vert.example/j/j1.trig>');
    expect(trig).toContain('dcat:mediaType "application/trig"');
    expect(quads.some((q) => q.graph.value === 'urn:graph:vert:j1' && q.predicate.value === 'https://schema.org/text')).toBe(true);
  });
  it('an Asserted descriptor carries groundTruth and what it supersedes; without an owner the agent issues', () => {
    const { ownerWebId: _o, ...noOwner } = spec;
    const trig = renderDescriptorTrig({ ...noOwner, status: 'Asserted', supersedes: ['https://vert.example/j/j0.trig'] });
    expect(trig).toContain('iep:groundTruth "true"^^xsd:boolean');
    expect(trig).toContain('iep:supersedes <https://vert.example/j/j0.trig>');
    expect(trig).toContain('iep:issuer <urn:agent:vert>');
    expect(trig).not.toContain('iep:onBehalfOf');
  });
});

describe('the HyperMarkdown projection', () => {
  it('fronts the document with its identity and renders one control block per control', () => {
    const md = hmdDocument({ url: 'https://vert.example/j/j1', nsPrefix: 'vert', ns: NS, payloadType: 'Judgment', state: 'hypothetical', graphIri: 'urn:graph:vert:j1', prose: '# A judgment', controls: [control] });
    expect(md.startsWith('---\n"@context":')).toBe(true);
    expect(md).toContain('"@type": ["vert:Judgment", "hmd:Document"]');
    expect(md).toContain('descriptorUrl: "https://vert.example/j/j1.trig"');
    expect(md).toContain('state: "hypothetical"');
    expect(md).toContain('_Hypothetical judgment — its controls are below.');
    expect(md).toContain(':::control confirm\n');
    expect(md).toContain('declarative: true');
    expect(md).toContain('arguments: {"judgment_iri":"urn:graph:vert:j1"}');
  });
});

describe('scoring', () => {
  it('hits at 1 and at 3 against the observed truths, null without any, normalising separators', () => {
    expect(rankHits(['a.ts', 'b.ts', 'c.ts', 'd.ts'], new Set(['./c.ts']))).toEqual({ hitAt1: false, hitAt3: true });
    expect(rankHits(['src\\a.ts'], new Set(['src/a.ts']))).toEqual({ hitAt1: true, hitAt3: true });
    expect(rankHits(['a.ts'], new Set())).toEqual({ hitAt1: null, hitAt3: null });
  });
  it('the Brier score is the mean squared distance to the truths over the candidates', () => {
    expect(brierScore([{ key: 'a', probability: 0.5 }, { key: 'b', probability: 0.5 }], new Set(['a']))).toBe(0.25);
    expect(brierScore([{ key: 'a', probability: 1 }], new Set(['a']))).toBe(0);
    expect(brierScore([], new Set(['a']))).toBeNull();
    expect(brierScore([{ key: 'a', probability: 1 }], new Set())).toBeNull();
  });
});
