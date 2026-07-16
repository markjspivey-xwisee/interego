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

describe('mdvault — entailment authority closure (georgio finding)', () => {
  // A rung-<=3 note must not smuggle authority via RDFS/OWL inference: a class that reaches
  // an authority class through subClassOf/equivalentClass, or a property that reaches an
  // authority predicate through subPropertyOf/equivalentProperty/sameAs, is authority-bearing.
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const OWL = 'http://www.w3.org/2002/07/owl#';
  const RA = 'https://reasoning-attack.example/';
  const ctx = JSON.stringify({ '@context': {
    '@base': RA, type: '@type', owl: OWL, rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', rdfs: RDFS,
    subClassOf: { '@id': RDFS + 'subClassOf', '@type': '@id' },
    equivalentClass: { '@id': OWL + 'equivalentClass', '@type': '@id' },
    subPropertyOf: { '@id': RDFS + 'subPropertyOf', '@type': '@id' },
    equivalentProperty: { '@id': OWL + 'equivalentProperty', '@type': '@id' },
    myTarget: { '@id': RA + 'SubpropertyTarget', '@type': '@id' },
    myAction: { '@id': RA + 'EquivalentAction', '@type': '@id' },
  } });
  const attack: VaultBundle = {
    contexts: { 'context.jsonld': ctx },
    notes: {
      'SubclassOperation.md': `---\ntype: owl:Class\nsubClassOf: ${HYDRA}Operation\n---\n`,
      'EquivalentAffordance.md': `---\ntype: owl:Class\nequivalentClass: ${IEP}Affordance\n---\n`,
      'SubpropertyTarget.md': `---\ntype: rdf:Property\nsubPropertyOf: ${HYDRA}target\n---\n`,
      'EquivalentAction.md': `---\ntype: rdf:Property\nequivalentProperty: ${IEP}action\n---\n`,
      'IndirectOperation.md': '---\ntype: "[[SubclassOperation]]"\n---\n',
      'IndirectAffordance.md': '---\ntype: "[[EquivalentAffordance]]"\n---\n',
      'IndirectTarget.md': '---\ntype: owl:Thing\nmyTarget: https://evil.example/run\n---\n',
      'IndirectAction.md': '---\ntype: owl:Thing\nmyAction: urn:evil:run\n---\n',
    },
    rootContextPath: 'context.jsonld',
  };
  const ga = ingestVault(attack, P);

  it('quarantines every axiom AND dependent note', () => {
    for (const note of Object.keys(attack.notes)) {
      expect(ga.notes.some(n => n.path === note && !!n.quarantinedReason)).toBe(true);
    }
  });
  it('leaks no authority (predicate, type, evil value, or linking axiom) into the active graph', () => {
    expect(ga.triples.length).toBe(0);
    expect(ga.triples.some(t => t.p === HYDRA + 'target' || t.p === IEP + 'action')).toBe(false);
    expect(ga.triples.some(t => t.o === HYDRA + 'Operation' || t.o === IEP + 'Affordance')).toBe(false);
    expect(ga.triples.some(t => t.o === 'https://evil.example/run' || t.o === 'urn:evil:run')).toBe(false);
    expect(ga.diagnostics.filter(d => d.code === 'rung.authority').length).toBeGreaterThanOrEqual(4);
  });
  it('expands a CURIE @id-value and catches it (secondary finding)', () => {
    const g2 = ingestVault({
      contexts: { 'context.jsonld': JSON.stringify({ '@context': { '@base': 'https://x.example/', type: '@type', owl: OWL, rdfs: RDFS, hydra: HYDRA, subClassOf: { '@id': RDFS + 'subClassOf', '@type': '@id' } } }) },
      notes: { 'C.md': '---\ntype: owl:Class\nsubClassOf: hydra:Operation\n---\n', 'I.md': '---\ntype: "[[C]]"\n---\n' },
      rootContextPath: 'context.jsonld',
    }, P);
    expect(g2.notes.some(n => n.path === 'C.md' && !!n.quarantinedReason)).toBe(true);
    expect(g2.triples.some(t => t.o === 'hydra:Operation')).toBe(false); // never emitted compact
  });

  // georgio round 2: inverseOf / domain / range / owl:Restriction(onProperty).
  it('closes inverseOf / domain / range / restriction entailments', () => {
    const RA = 'https://entailment2.example/';
    const ctx2 = JSON.stringify({ '@context': {
      '@base': RA, type: '@type', owl: OWL, rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', rdfs: RDFS,
      inverseOf: { '@id': 'owl:inverseOf', '@type': '@id' }, domain: { '@id': 'rdfs:domain', '@type': '@id' }, range: { '@id': 'rdfs:range', '@type': '@id' },
      subClassOf: { '@id': 'rdfs:subClassOf', '@type': '@id' }, onProperty: { '@id': 'owl:onProperty', '@type': '@id' }, someValuesFrom: { '@id': 'owl:someValuesFrom', '@type': '@id' },
      invTarget: { '@id': RA + 'InverseTarget', '@type': '@id' }, ranOp: { '@id': RA + 'RangeOperationProperty', '@type': '@id' }, domOp: RA + 'DomainOperationProperty',
    } });
    const g2 = ingestVault({
      contexts: { 'context.jsonld': ctx2 }, rootContextPath: 'context.jsonld',
      notes: {
        'InverseTarget.md': `---\ntype: rdf:Property\ninverseOf: ${HYDRA}target\n---\n`,
        'InverseUse.md': '---\ntype: owl:Thing\ninvTarget: https://victim.example/resource\n---\n',
        'DomainOperationProperty.md': `---\ntype: rdf:Property\ndomain: ${HYDRA}Operation\n---\n`,
        'DomainUse.md': '---\ntype: owl:Thing\ndomOp: ordinary data\n---\n',
        'RangeOperationProperty.md': `---\ntype: rdf:Property\nrange: ${HYDRA}Operation\n---\n`,
        'RangeUse.md': `---\ntype: owl:Thing\nranOp: ${RA}RangeVictim\n---\n`,
        'TargetRestriction.md': `---\ntype: owl:Class\nonProperty: ${HYDRA}target\nsomeValuesFrom: ${OWL}Thing\n---\n`,
        'RestrictedClass.md': `---\ntype: owl:Class\nsubClassOf: ${RA}TargetRestriction\n---\n`,
        'RestrictedInstance.md': '---\ntype: "[[RestrictedClass]]"\n---\n',
      },
    }, P);
    for (const note of ['InverseTarget.md', 'InverseUse.md', 'DomainOperationProperty.md', 'DomainUse.md', 'RangeOperationProperty.md', 'RangeUse.md', 'TargetRestriction.md', 'RestrictedClass.md', 'RestrictedInstance.md']) {
      expect(g2.notes.some(n => n.path === note && !!n.quarantinedReason)).toBe(true);
    }
    expect(g2.triples.length).toBe(0);
    expect(g2.triples.some(t => t.p === HYDRA + 'target' || t.o === HYDRA + 'Operation' || String(t.o).includes('victim'))).toBe(false);
  });
});
