/**
 * The SOC 2, EU AI Act and NIST AI RMF formalizations meet their own shapes, read with RDFS.
 *
 * ★ WHY. Each framework was formalized three ways that did not meet: a class (an obligation, a core
 * function, a criterion), a SKOS list of the same things, and a datatype property holding a code
 * ("12", "GOVERN"). A record that named a concept — `conformsToArticle Article-Article12` — made it,
 * by the property's range, an instance of the class, whose shape then refused it for want of the
 * code: a reviewer asserted one such record of each and both failed, and without inference they
 * passed only because no shape selected anything. Each concept is now typed with its class and
 * carries its code, so the class, the list and the code name the same things.
 */
import { describe, it, expect } from 'vitest';
import { Parser, Writer, DataFactory, type Quad } from 'n3';
import { validateAgainstShape as shacl } from '@interego/core';
import { renderOwl, renderShacl, ns, shapesIri, type OntologyModel } from '../src/spec-ontology.js';
import { SOC2_MODEL, EU_AI_ACT_MODEL, NIST_RMF_MODEL } from '../src/spec/compliance.model.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const { namedNode, quad } = DataFactory;

/** The data and the ontology together, closed under RDFS's domain and range rules (rdfs2, rdfs3) and
 *  rdfs9 (an instance of a class is an instance of its superclasses), as a reader with RDFS sees them. */
function withRdfs(data: string, m: OntologyModel): string {
  const quads: Quad[] = [...new Parser({ format: 'text/turtle' }).parse(renderOwl(m)), ...new Parser({ format: 'text/turtle' }).parse(data)];
  const ranges = new Map<string, string[]>(); const domains = new Map<string, string[]>(); const supers = new Map<string, string[]>();
  for (const q of quads) {
    if (q.predicate.value === `${RDFS}range` && q.object.termType === 'NamedNode') ranges.set(q.subject.value, [...(ranges.get(q.subject.value) ?? []), q.object.value]);
    if (q.predicate.value === `${RDFS}domain` && q.object.termType === 'NamedNode') domains.set(q.subject.value, [...(domains.get(q.subject.value) ?? []), q.object.value]);
    if (q.predicate.value === `${RDFS}subClassOf` && q.object.termType === 'NamedNode') supers.set(q.subject.value, [...(supers.get(q.subject.value) ?? []), q.object.value]);
  }
  const out = new Map<string, Quad>(quads.map(q => [`${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}`, q]));
  const add = (s: string, c: string): boolean => {
    const key = `${s} ${RDF_TYPE} NamedNode:${c}`;
    if (out.has(key)) return false;
    out.set(key, quad(namedNode(s), namedNode(RDF_TYPE), namedNode(c)));
    return true;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const q of [...out.values()]) {
      if (q.subject.termType !== 'NamedNode') continue;
      for (const c of domains.get(q.predicate.value) ?? []) changed = add(q.subject.value, c) || changed;
      if (q.object.termType === 'NamedNode') for (const c of ranges.get(q.predicate.value) ?? []) changed = add(q.object.value, c) || changed;
      if (q.predicate.value === RDF_TYPE) for (const c of supers.get(q.object.value) ?? []) changed = add(q.subject.value, c) || changed;
    }
  }
  return new Writer({ format: 'N-Triples' }).quadsToString([...out.values()]);
}
const verdict = (data: string, m: OntologyModel) => shacl(withRdfs(data, m), renderShacl(m));
const violations = (r: ReturnType<typeof shacl>): string[] => [...new Set(r.results.filter(x => x.severity === 'Violation').map(x => x.sourceShape ?? '?'))].sort();

describe('each compliance ontology, read with RDFS, meets its own shapes', () => {
  for (const m of [SOC2_MODEL, EU_AI_ACT_MODEL, NIST_RMF_MODEL]) {
    it(`${m.module}: every concept it types with a class carries what that class's shape asks`, () => {
      const r = verdict('', m);
      expect(r.fullyChecked).toBe(true);
      expect(r.conforms, JSON.stringify(r.results)).toBe(true);
    });
  }
});

describe('a record that names a concept meets the shapes', () => {
  const EX = 'https://example.org/';
  it('an action offered as evidence for Article 12', () => {
    const r = verdict(`<${EX}a> <${ns(EU_AI_ACT_MODEL)}conformsToArticle> <${ns(EU_AI_ACT_MODEL)}Article-Article12> .`, EU_AI_ACT_MODEL);
    expect(r.conforms, JSON.stringify(r.results)).toBe(true);
  });
  it('an action that addresses GOVERN', () => {
    const r = verdict(`<${EX}b> <${ns(NIST_RMF_MODEL)}addressesFunction> <${ns(NIST_RMF_MODEL)}CoreFunction-GOVERN> .`, NIST_RMF_MODEL);
    expect(r.conforms, JSON.stringify(r.results)).toBe(true);
  });
  it('an access change that cites CC6.2, with its time, agent and signer', () => {
    const S = ns(SOC2_MODEL);
    const r = verdict(`<${EX}ev> a <${S}AccessChangeEvent> ; <${S}evidences> <${S}CommonCriterion-CC6.2> ;
      <${S}occurredAt> "2026-10-01T12:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
      <${S}actingAgent> <did:web:admin.example> ; <${S}signer> "0xabc" .`, SOC2_MODEL);
    expect(r.conforms, JSON.stringify(r.results)).toBe(true);
  });
  it('but an obligation the document does not define, named the same way, is refused for want of its Article', () => {
    const r = verdict(`<${EX}c> <${ns(EU_AI_ACT_MODEL)}conformsToArticle> <${EX}some-obligation> .`, EU_AI_ACT_MODEL);
    expect(violations(r)).toEqual([`${shapesIri(EU_AI_ACT_MODEL)}#ObligationConformanceShape-article`]);
  });
});
