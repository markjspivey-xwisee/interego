/**
 * Each Foxxi ontology's alignment to other vocabularies is checked against its targets, and published
 * as an SSSOM mapping set that says exactly what the ontology says.
 *
 * ★ WHY. The Foxxi xAPI ontology maps its terms to ADL's xAPI ontology one by one. Nothing checked
 * that the targets exist, or that a skos:exactMatch — a claim that the two are interchangeable — joined
 * terms of the same kind: four of them joined a datatype property to an object property (or to an
 * annotation property), which OWL keeps apart. Those four are skos:closeMatch now, each with its
 * reason annotated on the mapping axiom (and what else the alignment must be to hold when read as
 * OWL is the-alignment-to-adl-holds-when-read-as-owl.test.ts); every target is checked against the
 * record of what ADL's ontology declares; and every document with mappings publishes them at
 * <document>/mappings in
 * SSSOM 1.0, the form mapping reviewers and tools read, generated from the graph so the two cannot
 * disagree. The ontology is read back here with an independent Turtle parser (n3), the metadata
 * block with an independent YAML parser (js-yaml).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import type { Quad } from 'n3';
import { turtleQuads, OWL, RDFS, SKOS, RDF_TYPE } from './support/ns-graph.js';
import { renderOwl, ontologyGraph, ontologyIri, type OntologyModel } from '../src/spec-ontology.js';
import { SPEC_MODELS } from '../src/spec/index.js';
import { COMPLIANCE_MODELS } from '../src/spec/compliance.model.js';
import { OB3_MODEL, CLR_MODEL } from '../src/spec/ler.model.js';
import { XAPI_MODEL } from '../src/spec/xapi.model.js';
import { ADL_XAPI_NS, ADL_XAPI_ONTOLOGY, ADL_XAPI_TERMS, adlXapiTerm } from '../src/spec/adl-xapi-ontology.js';
import { renderSemOntologyTurtle, LER_DOC, TLA_DOC } from '../src/ler-tla-vocab.js';
import { renderVocabTurtle, FOXXI_VOCAB_DOC } from '../src/foxxi-vocab.js';
import { mappingSetIri, SSSOM_COLUMNS, SSSOM_MEDIA_TYPE } from '../src/ns/sssom.js';
import { MAPPING_SET_PREFIXES, SUBSTRATE_TARGETS, mappingSetModules, renderMappingSet, sendMappingSet } from '../src/ns/mapping-sets.js';

const RELATIONS = ['exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch'].map(r => SKOS + r);
const NS_ROOT = 'https://foxxi-bridge.interego.xwisee.com/ns/';

/** Every Foxxi document's Turtle, by the path it is served at. */
const TURTLE: Record<string, () => string> = {
  ...Object.fromEntries([...Object.values(SPEC_MODELS), ...Object.values(COMPLIANCE_MODELS), OB3_MODEL, CLR_MODEL]
    .map((m: OntologyModel) => [m.module, () => renderOwl(m)])),
  'ieee-ler': () => renderSemOntologyTurtle('ler'),
  'adl-tla': () => renderSemOntologyTurtle('tla'),
  foxxi: () => renderVocabTurtle(),
};
const DOC_IRI = (module: string): string => module === 'ieee-ler' ? LER_DOC : module === 'adl-tla' ? TLA_DOC : module === 'foxxi' ? FOXXI_VOCAB_DOC : `${NS_ROOT}${module}`;
const quadsOf = (module: string): Quad[] => turtleQuads(TURTLE[module]!());

/** The SKOS mapping triples a document makes from its own terms. */
function mappingTriples(module: string): Array<[string, string, string]> {
  const ns = `${DOC_IRI(module)}#`;
  return quadsOf(module)
    .filter(q => RELATIONS.includes(q.predicate.value) && q.subject.value.startsWith(ns))
    .map(q => [q.subject.value, q.predicate.value, q.object.value]);
}

const kindOf = (q: Quad[], term: string): string | undefined => {
  const types = q.filter(t => t.subject.value === term && t.predicate.value === RDF_TYPE).map(t => t.object.value);
  return types.includes(`${OWL}Class`) ? 'class' : types.includes(`${OWL}ObjectProperty`) ? 'object'
    : types.includes(`${OWL}DatatypeProperty`) ? 'datatype' : types.includes(`${OWL}AnnotationProperty`) ? 'annotation' : undefined;
};

/** The notes on mappings: (source, property, target) → the rdfs:comment of its owl:Axiom. */
function mappingNotes(q: Quad[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const ax of q.filter(t => t.predicate.value === RDF_TYPE && t.object.value === `${OWL}Axiom`).map(t => t.subject.value)) {
    const one = (p: string): string | undefined => q.find(t => t.subject.value === ax && t.predicate.value === p)?.object.value;
    out.set(`${one(`${OWL}annotatedSource`)} ${one(`${OWL}annotatedProperty`)} ${one(`${OWL}annotatedTarget`)}`, one(`${RDFS}comment`)!);
  }
  return out;
}

/** A mapping set read back: its metadata (YAML) and its rows, by column. */
function readSet(tsv: string): { meta: Record<string, unknown>; header: string[]; rows: Array<Record<string, string>> } {
  const lines = tsv.split('\n').filter(l => l !== '');
  const meta = loadYaml(lines.filter(l => l.startsWith('#')).map(l => l.slice(1)).join('\n')) as Record<string, unknown>;
  const table = lines.filter(l => !l.startsWith('#'));
  const header = table[0]!.split('\t');
  const rows = table.slice(1).map(l => Object.fromEntries(l.split('\t').map((v, i) => [header[i]!, v])));
  return { meta, header, rows };
}
const BUILT_IN: Record<string, string> = { skos: SKOS, sssom: 'https://w3id.org/sssom/', semapv: 'https://w3id.org/semapv/vocab/', owl: OWL };
function expand(curie: string, curieMap: Record<string, string>): string {
  const i = curie.indexOf(':');
  const ns = curieMap[curie.slice(0, i)] ?? BUILT_IN[curie.slice(0, i)];
  if (!ns) throw new Error(`${curie}: prefix not declared`);
  return ns + curie.slice(i + 1);
}

describe('the xAPI alignment is checked against what ADL\'s ontology declares', () => {
  const q = quadsOf('xapi');
  const toAdl = mappingTriples('xapi').filter(([, , o]) => o.startsWith(ADL_XAPI_NS));

  it('maps most of its terms to ADL\'s, and every target is a term ADL declares', () => {
    expect(toAdl.length).toBeGreaterThan(50);
    expect(toAdl.filter(([, , o]) => !adlXapiTerm(o)).map(([, , o]) => o)).toEqual([]);
  });

  it('an exactMatch joins two terms of the same kind; a closeMatch across kinds says why', () => {
    const notes = mappingNotes(q);
    for (const [s, p, o] of toAdl) {
      const ours = kindOf(q, s);
      const theirs = adlXapiTerm(o)!.kind;
      if (p === `${SKOS}exactMatch`) expect(`${s}: ${ours}`).toBe(`${s}: ${theirs}`);
      else if (ours !== theirs) expect(notes.get(`${s} ${p} ${o}`), `${s} ${p} ${o} carries no note`).toMatch(/^Not an exact match because of kind/);
    }
  });

  it('the four constructs ADL gives another kind are closeMatches (what holds as OWL is the-alignment-to-adl-holds-when-read-as-owl)', () => {
    const across = toAdl.filter(([s, , o]) => kindOf(q, s) !== adlXapiTerm(o)!.kind).map(([s, p]) => `${s.slice(s.indexOf('#') + 1)} ${p.slice(SKOS.length)}`);
    expect(across.sort()).toEqual(['member closeMatch', 'moreInfo closeMatch', 'usageType closeMatch', 'version closeMatch']);
  });

  it('the record of ADL\'s ontology is its full term list (73 terms), not just the targets', () => {
    expect(Object.keys(ADL_XAPI_TERMS)).toHaveLength(73);
    expect(adlXapiTerm(`${ADL_XAPI_NS}ActivityDefinition`)).toEqual({ kind: 'class', label: 'Activity' });
    expect(adlXapiTerm(`${ADL_XAPI_NS}actor`)).toBeUndefined();
  });

  it('a note on a mapping the term does not make is refused, never published', () => {
    const bad: OntologyModel = {
      ...XAPI_MODEL,
      classes: XAPI_MODEL.classes.map(c => c.name === 'Verb' ? { ...c, mappingNotes: { 'adl-xapi:Statement': 'a note on nothing' } } : c),
    };
    expect(() => ontologyGraph(bad)).toThrow(/not a mapping target/);
  });
});

describe('every document with mappings publishes them as an SSSOM 1.0 mapping set', () => {
  const withMappings = Object.keys(TURTLE).filter(m => mappingTriples(m).length > 0);

  it('exactly the documents that map terms publish a set, and their headers point at it', () => {
    expect(mappingSetModules().sort()).toEqual([...withMappings].sort());
    expect(withMappings.sort()).toEqual(['adl-tla', 'cmi5', 'eu-ai-act', 'foxxi', 'ieee-ler', 'nist-rmf', 'soc2', 'xapi']);
    for (const m of Object.keys(TURTLE)) {
      const seeAlso = quadsOf(m).filter(t => t.subject.value === DOC_IRI(m) && t.predicate.value === `${RDFS}seeAlso`).map(t => t.object.value);
      if (withMappings.includes(m)) expect(seeAlso, m).toContain(mappingSetIri(DOC_IRI(m)));
      else {
        expect(seeAlso, m).not.toContain(mappingSetIri(DOC_IRI(m)));
        expect(renderMappingSet(m), m).toBeNull();
      }
    }
  });

  for (const module of ['xapi', 'cmi5', 'soc2', 'eu-ai-act', 'nist-rmf', 'ieee-ler', 'adl-tla', 'foxxi']) {
    describe(module, () => {
      const tsv = renderMappingSet(module)!;
      const { meta, header, rows } = readSet(tsv);
      const curieMap = meta.curie_map as Record<string, string>;

      it('carries the metadata SSSOM 1.0 requires and recommends', () => {
        expect(meta.mapping_set_id).toBe(`${DOC_IRI(module)}/mappings`);
        expect(meta.license).toBe('https://opensource.org/licenses/MIT');
        expect(meta.mapping_set_version).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
        expect(meta.creator_label).toEqual(['Mark Spivey']);
        expect(meta.mapping_provider).toBe(DOC_IRI(module));
        expect(expand(meta.subject_source as string, curieMap)).toBe(DOC_IRI(module));
        expect(String(meta.comment)).toMatch(/Mark Spivey \(Foxxi Mediums Inc\.\)/);
        expect(header).toEqual([...SSSOM_COLUMNS]);
      });

      it('declares each prefix it uses, once, in a form the SSSOM toolkit reads', () => {
        for (const p of Object.keys(curieMap)) expect(p).toMatch(/^[A-Za-z0-9_.]+$/);
        expect(new Set(Object.values(curieMap)).size).toBe(Object.keys(curieMap).length);
        for (const r of rows) {
          for (const c of ['subject_id', 'predicate_id', 'object_id', 'mapping_justification', 'object_source'] as const) {
            if (r[c]) expect(() => expand(r[c]!, curieMap), `${c} ${r[c]}`).not.toThrow();
          }
        }
        for (const [p, ns] of Object.entries(curieMap)) expect(MAPPING_SET_PREFIXES[p]).toBe(ns);
      });

      it('has one row for each mapping the ontology makes, and no other', () => {
        const fromRows = rows.filter(r => r.object_id !== 'sssom:NoTermFound')
          .map(r => `${expand(r.subject_id!, curieMap)} ${expand(r.predicate_id!, curieMap)} ${expand(r.object_id!, curieMap)}`);
        const fromGraph = mappingTriples(module).map(t => t.join(' '));
        expect(fromRows.sort()).toEqual(fromGraph.sort());
        expect(rows.every(r => r.mapping_justification === 'semapv:ManualMappingCuration')).toBe(true);
      });

      it('carries each mapping\'s note as its comment, and is written the same way every time', () => {
        const notes = mappingNotes(quadsOf(module));
        for (const r of rows.filter(x => x.object_id !== 'sssom:NoTermFound')) {
          const key = `${expand(r.subject_id!, curieMap)} ${expand(r.predicate_id!, curieMap)} ${expand(r.object_id!, curieMap)}`;
          expect(r.comment ?? '', key).toBe(notes.get(key) ?? '');
        }
        expect(renderMappingSet(module)).toBe(tsv);
        const keys = rows.map(r => `${r.subject_id}\u0000${r.predicate_id}\u0000${r.object_id}`);
        expect(keys).toEqual([...keys].sort());
      });
    });
  }

  it('the xAPI set lists each term with no counterpart in ADL\'s ontology as sssom:NoTermFound', () => {
    const { meta, rows } = readSet(renderMappingSet('xapi')!);
    const curieMap = meta.curie_map as Record<string, string>;
    const q = quadsOf('xapi');
    const ns = `${NS_ROOT}xapi#`;
    const declared = new Set(q.filter(t => t.predicate.value === RDF_TYPE && t.subject.value.startsWith(ns)
      && [`${OWL}Class`, `${OWL}ObjectProperty`, `${OWL}DatatypeProperty`, `${RDFS}Datatype`, `${SKOS}Concept`].includes(t.object.value))
      .map(t => t.subject.value));
    const mappedToAdl = new Set(mappingTriples('xapi').filter(([, , o]) => o.startsWith(ADL_XAPI_NS)).map(([s]) => s));
    const gaps = rows.filter(r => r.object_id === 'sssom:NoTermFound');
    expect(gaps.map(r => expand(r.subject_id!, curieMap)).sort()).toEqual([...declared].filter(s => !mappedToAdl.has(s)).sort());
    expect(gaps.length).toBeGreaterThan(20);
    for (const r of gaps) {
      expect(r.predicate_id).toBe('skos:exactMatch');
      expect(expand(r.object_source!, curieMap)).toBe(ADL_XAPI_ONTOLOGY);
    }
    // ADL's ontology has no property linking a Statement to its parts, and no Score properties.
    expect(gaps.map(r => r.subject_id)).toEqual(expect.arrayContaining(['foxxi_xapi:actor', 'foxxi_xapi:verb', 'foxxi_xapi:raw', 'foxxi_xapi:scaled']));
    // A mapped term is never also listed as a gap.
    expect(gaps.map(r => r.subject_id)).not.toContain('foxxi_xapi:member');
  });

  it('a target\'s label and kind come from its publisher\'s record, or are left empty', () => {
    const xapi = readSet(renderMappingSet('xapi')!).rows;
    expect(xapi.find(r => r.subject_id === 'foxxi_xapi:member')).toMatchObject({ object_label: 'member', object_type: 'owl data property', subject_type: 'owl object property' });
    const homePageFoaf = xapi.find(r => r.subject_id === 'foxxi_xapi:homePage' && r.object_id === 'foaf:accountServiceHomepage')!;
    expect(homePageFoaf.object_label ?? '').toBe('');
    expect(homePageFoaf.object_type ?? '').toBe('');
    const soc2 = readSet(renderMappingSet('soc2')!).rows;
    expect(soc2.find(r => r.object_id === 'soc2:CC6.1')).toMatchObject({ object_type: 'owl named individual', subject_type: 'skos concept' });
    const tla = readSet(renderMappingSet('adl-tla')!).rows;
    expect(tla.find(r => r.object_id === 'foxxi_ieee_ler:CompetencyAssertion')).toMatchObject({ object_label: 'Competency Assertion', object_type: 'owl class' });
  });
});

describe('the record of the substrate\'s compliance terms is the substrate\'s own', () => {
  const DOCS_NS = new URL('../../../docs/ns/', import.meta.url);
  const IE = 'https://markjspivey-xwisee.github.io/interego/ns/';
  const TYPE: Record<string, string> = {
    [`${OWL}Class`]: 'owl class', [`${OWL}ObjectProperty`]: 'owl object property', [`${OWL}NamedIndividual`]: 'owl named individual',
  };

  it('each transcribed label and kind is what docs/ns says', () => {
    for (const [term, info] of Object.entries(SUBSTRATE_TARGETS)) {
      const file = term.slice(IE.length, term.indexOf('#'));
      const q = turtleQuads(readFileSync(new URL(`${file}.ttl`, DOCS_NS), 'utf8'));
      expect(q.filter(t => t.subject.value === term && t.predicate.value === `${RDFS}label`).map(t => t.object.value), term).toEqual([info.label]);
      const kinds = q.filter(t => t.subject.value === term && t.predicate.value === RDF_TYPE).map(t => TYPE[t.object.value]).filter(Boolean);
      expect(kinds, term).toEqual([info.type]);
    }
  });

  it('every mapping into the substrate\'s compliance vocabularies has a record', () => {
    const targets = ['soc2', 'eu-ai-act', 'nist-rmf'].flatMap(m => mappingTriples(m).map(([, , o]) => o)).filter(o => o.startsWith(IE));
    expect(targets.length).toBeGreaterThan(20);
    expect(targets.filter(o => !SUBSTRATE_TARGETS[o])).toEqual([]);
  });
});

describe('GET <document>/mappings', () => {
  interface Sent { status: number; headers: Record<string, string>; type?: string; body?: string }
  const call = (module: string, accept?: string): Sent => {
    const sent: Sent = { status: 200, headers: {} };
    const res = {
      setHeader(name: string, value: string) { sent.headers[name.toLowerCase()] = value; return res; },
      status(code: number) { sent.status = code; return res; },
      type(t: string) { sent.type = t; return res; },
      send(body: string) { sent.body = body; return res; },
    };
    sendMappingSet({ headers: accept === undefined ? {} : { accept } }, res, module);
    return sent;
  };

  it('answers SSSOM/TSV, negotiated, pointing back at its ontology', () => {
    const r = call('xapi', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(r.status).toBe(200);
    expect(r.type).toBe(SSSOM_MEDIA_TYPE);
    expect(r.body).toBe(renderMappingSet('xapi'));
    expect(r.headers.vary).toBe('Accept');
    expect(r.headers.link).toContain(`<${ontologyIri(XAPI_MODEL)}>; rel="related"`);
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });

  it('406 for a client that accepts nothing it offers; 404 for a document that maps no terms', () => {
    expect(call('xapi', 'application/json').status).toBe(406);
    const none = call('scorm-cam');
    expect(none.status).toBe(404);
    expect(JSON.parse(none.body!).error).toMatch(/publishes no mapping set/);
  });
});
