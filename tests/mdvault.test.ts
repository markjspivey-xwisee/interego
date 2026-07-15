/**
 * @interego/mdvault — Vault-LD conformance + threat suite.
 *
 * Vault-LD is implemented as a rung-<=3 profile over the general Markdown-vault engine, not
 * a bespoke module. These tests are georgio's acceptance vectors (the A/B/C/D/E catalogue)
 * plus the security core: the rung authority gate, path/YAML/context hardening, §4.5
 * identity, and the end-to-end ingest/recover pipeline. The load-bearing case is A8 — an
 * authority-looking note must quarantine, never leaking an executable affordance into the
 * active graph, while its source still recovers byte-for-byte.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalizeVaultPath,
  isHttpsIdentityIri,
  escapeTurtleLiteral,
  screenAuthorityCeiling,
  canonicalizeAuthorityIri,
  parseFrontmatter,
  parseContextDocument,
  mintSubjectIri,
  ingestVault,
  recoverVault,
  VAULT_LD_PROFILE,
  VaultInputError,
  type VaultBundle,
} from '@interego/mdvault';

const P = VAULT_LD_PROFILE;
const B = 'https://example.org/data/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const CGH = 'https://markjspivey-xwisee.github.io/interego/ns/cgh#';
const IEH = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';

const CONTEXT = JSON.stringify({ '@context': {
  '@base': B, type: '@type', id: '@id',
  owl: 'http://www.w3.org/2002/07/owl#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#', hydra: HYDRA,
  label: 'rdfs:label',
  related: { '@id': 'https://example.org/related', '@type': '@id' },
  score: { '@id': 'https://example.org/score', '@type': 'xsd:integer' },
  target: { '@id': 'hydra:target', '@type': '@id' },
} });

const A1 = '---\ntype: owl:Class\nlabel: Recipe\n---\n# Recipe\n\nHuman-authored explanation.\n';
const A2 = '---\ntype: "[[Recipe]]"\nlabel: Hummus\nrelated: "[[Recipe]]"\nscore: 25\ntags: [demo]\n---\n# Hummus\n\nThis body must survive byte-for-byte.\n';
const A6 = '---\ntype: "[[MissingClass]]"\n---\nbody\n';
const A8 = '---\ntype: hydra:Operation\ntarget: "https://evil.example/run"\n---\nstill recoverable\n';

const bundle: VaultBundle = {
  contexts: { 'context.jsonld': CONTEXT },
  notes: { 'Concepts/Recipe.md': A1, 'Recipes/hummus.md': A2, 'Missing.md': A6, 'Hostile.md': A8 },
  rootContextPath: 'context.jsonld',
};

const g = ingestVault(bundle, P);
const has = (s: string, p: string, o?: string, oKind?: string): boolean =>
  g.triples.some(t => t.s === s && t.p === p && (o === undefined || t.o === o) && (oKind === undefined || t.oKind === oKind));

describe('mdvault — path + IRI hardening (A12 / A9 / serializer)', () => {
  it('refuses traversal / absolute / scheme paths', () => {
    expect(() => canonicalizeVaultPath('../escape.md')).toThrow(VaultInputError);
    expect(() => canonicalizeVaultPath('%2e%2e/x.md')).toThrow(VaultInputError);
    expect(() => canonicalizeVaultPath('/etc/passwd')).toThrow(VaultInputError);
    expect(() => canonicalizeVaultPath('C:/x.md')).toThrow(VaultInputError);
    expect(() => canonicalizeVaultPath('file:///x')).toThrow(VaultInputError);
    expect(canonicalizeVaultPath('a/./b.md')).toBe('a/b.md');
  });
  it('restricts identity IRIs to http(s)-with-host (stricter than the kernel regex)', () => {
    expect(isHttpsIdentityIri('https://example.org/x')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'file:///etc', 'urn:x:y', 'data:text/html,x', '/rel', '//host'])
      expect(isHttpsIdentityIri(bad)).toBe(false);
  });
  it('escapes a literal so it cannot terminate a Turtle "..."', () => {
    const esc = escapeTurtleLiteral('"] a hydra:Operation ; <p> <o> . <x> ');
    expect(esc.replace(/\\./g, '').includes('"')).toBe(false);
  });
});

describe('mdvault — rung-<=3 authority gate (A8 / E6 / D7)', () => {
  it('refuses authority predicates + types at rung <=3', () => {
    expect(screenAuthorityCeiling([HYDRA + 'target'], [HYDRA + 'Operation'], 3).ok).toBe(false);
    expect(screenAuthorityCeiling([IEP + 'action'], [], 3).ok).toBe(false);
    expect(screenAuthorityCeiling([], [IEP + 'Affordance'], 3).ok).toBe(false);
  });
  it('canonicalizes deprecated cg:/cgh: aliases and still refuses (D7)', () => {
    expect(canonicalizeAuthorityIri(CGH + 'Affordance')).toBe(IEH + 'Affordance');
    expect(screenAuthorityCeiling([], [CGH + 'Affordance'], 3).ok).toBe(false);
  });
  it('passes benign data, and allows authority at rung 4 (general knob)', () => {
    expect(screenAuthorityCeiling([RDFS_LABEL, 'https://example.org/related'], [OWL_CLASS], 3).ok).toBe(true);
    expect(screenAuthorityCeiling([HYDRA + 'target'], [HYDRA + 'Operation'], 4).ok).toBe(true);
  });
});

describe('mdvault — frontmatter + context hardening (E / D / A10 / A11)', () => {
  it('refuses duplicate keys, merge keys, anchors, and prototype keys', () => {
    expect(() => parseFrontmatter('type: owl:Class\ntype: owl:Thing')).toThrow(VaultInputError);
    expect(() => parseFrontmatter('<<: *a\nx: 1')).toThrow(VaultInputError);
    expect(() => parseFrontmatter('a: &x owl:Class\nb: *x')).toThrow(VaultInputError);
    expect(() => parseFrontmatter('__proto__: {p: 1}')).toThrow(VaultInputError);
    expect(Object.getPrototypeOf(parseFrontmatter('a: 1'))).toBe(null);
  });
  it('refuses duplicate JSON keys and non-http @base in a context', () => {
    expect(() => parseContextDocument('{"@context":{"label":"a","label":"b"}}', '')).toThrow(VaultInputError);
    expect(() => parseContextDocument('{"@context":{"@base":"javascript:x"}}', '')).toThrow(VaultInputError);
  });
});

describe('mdvault — §4.5 identity (B catalogue)', () => {
  it('mints instance from root base, schema from governing base', () => {
    expect(mintSubjectIri({ notePath: 'Recipes/hummus.md', expandedTypes: [B + 'Recipe'], rootBase: B, governingBase: 'https://cul.example/' }, P).subject).toBe(B + 'hummus');
    expect(mintSubjectIri({ notePath: 'Classes/Recipe.md', expandedTypes: [OWL_CLASS], rootBase: B, governingBase: 'https://cul.example/' }, P).subject).toBe('https://cul.example/Recipe');
  });
  it('honors an explicit absolute @id and refuses unsafe ones (B3/B7)', () => {
    expect(mintSubjectIri({ notePath: 'x.md', explicitId: 'https://id.example/42', expandedTypes: [] }, P).subject).toBe('https://id.example/42');
    for (const bad of ['/rel', 'javascript:x', 'urn:x', '', 'https://e/pay#control-approve'])
      expect(() => mintSubjectIri({ notePath: 'x.md', explicitId: bad, expandedTypes: [], rootBase: B }, P)).toThrow();
  });
  it('folders never enter the IRI (B4)', () => {
    const a = mintSubjectIri({ notePath: 'A/n.md', expandedTypes: [B + 'T'], rootBase: B }, P).subject;
    const b = mintSubjectIri({ notePath: 'B/C/n.md', expandedTypes: [B + 'T'], rootBase: B }, P).subject;
    expect(a).toBe(b);
  });
});

describe('mdvault — end-to-end Vault-LD acceptance (A1/A2/A6/A8/A3/A4/A5)', () => {
  it('A1: schema identity, rdf:type, label', () => {
    expect(g.notes.some(n => n.subject === B + 'Recipe' && n.participates)).toBe(true);
    expect(has(B + 'Recipe', RDF_TYPE, OWL_CLASS, 'iri')).toBe(true);
    expect(has(B + 'Recipe', RDFS_LABEL, 'Recipe', 'literal')).toBe(true);
  });
  it('A2: instance identity, wiki lift, typed literal, unmapped term', () => {
    expect(has(B + 'hummus', RDF_TYPE, B + 'Recipe', 'iri')).toBe(true);
    expect(has(B + 'hummus', 'https://example.org/related', B + 'Recipe', 'iri')).toBe(true);
    expect(g.triples.some(t => t.s === B + 'hummus' && t.p === 'https://example.org/score' && t.o === '25' && t.datatype === XSD_INT)).toBe(true);
    expect(g.diagnostics.some(d => d.code === 'unmapped-term' && d.where === 'Recipes/hummus.md')).toBe(true);
  });
  it('A6: dangling wiki-link -> diagnostic, no fabricated edge', () => {
    expect(g.diagnostics.some(d => d.code === 'wiki.dangling')).toBe(true);
    expect(has(B + 'Missing', RDF_TYPE, B + 'MissingClass')).toBe(false);
  });
  it('A8: authority-looking note is QUARANTINED, source still recovers', () => {
    expect(g.notes.some(n => n.path === 'Hostile.md' && !n.participates && !!n.quarantinedReason)).toBe(true);
    expect(g.triples.some(t => t.p === HYDRA + 'target')).toBe(false);
    expect(g.triples.some(t => t.o === HYDRA + 'Operation')).toBe(false);
    expect(g.triples.some(t => t.o === 'https://evil.example/run')).toBe(false);
    expect(g.diagnostics.some(d => d.severity === 'refuse' && d.code === 'rung.authority')).toBe(true);
    expect(recoverVault(g).files['Hostile.md']).toBe(A8);
  });
  it('A4/A5: byte-exact recovery + rootContextPath preserved', () => {
    const rec = recoverVault(g);
    expect(rec.files['Recipes/hummus.md']).toBe(A2);
    expect(rec.files['context.jsonld']).toBe(CONTEXT);
    expect(rec.rootContextPath).toBe('context.jsonld');
  });
  it('A3: deterministic re-ingest', () => {
    const g2 = ingestVault(bundle, P);
    expect(JSON.stringify(g2.triples)).toBe(JSON.stringify(g.triples));
    expect(JSON.stringify(g2.atoms)).toBe(JSON.stringify(g.atoms));
  });
  it('A13: tamper is detected on recover', () => {
    const tampered = { ...g, atoms: g.atoms.map(a => a.path === 'Hostile.md' ? { ...a, bytes: a.bytes.replace('still', 'EVIL') } : a) };
    expect(() => recoverVault(tampered)).toThrow(VaultInputError);
  });
});

describe('mdvault — A7 ambiguous wiki-link across contexts', () => {
  it('emits an ambiguous diagnostic and no edge when two notes share a stem', () => {
    const root = JSON.stringify({ '@context': { '@base': 'https://root.example/', type: '@type', owl: 'http://www.w3.org/2002/07/owl#', related: { '@id': 'https://root.example/related', '@type': '@id' } } });
    const a7: VaultBundle = {
      contexts: {
        'context.jsonld': root,
        'A/context.jsonld': JSON.stringify({ '@context': { '@base': 'https://a.example/' } }),
        'B/context.jsonld': JSON.stringify({ '@context': { '@base': 'https://b.example/' } }),
      },
      notes: {
        'A/Thing.md': '---\ntype: owl:Class\n---\nx\n',
        'B/Thing.md': '---\ntype: owl:Class\n---\ny\n',
        'Linker.md': '---\ntype: owl:Class\nrelated: "[[Thing]]"\n---\nz\n',
      },
    };
    const gg = ingestVault(a7, P);
    expect(gg.diagnostics.some(d => d.code === 'wiki.ambiguous')).toBe(true);
    expect(gg.triples.some(t => t.p === 'https://root.example/related')).toBe(false);
  });
});
