/**
 * The Foxxi xAPI ontology's alignment to ADL's xAPI ontology holds when a tool reads it as OWL.
 *
 * ★ WHY. Tools that merge mapping sets read skos:exactMatch as owl:equivalentClass /
 * owl:equivalentProperty and skos:broadMatch as rdfs:subClassOf (SSSOM's OWL rendering, BOOMER,
 * ROBOT). An ontology review read the first alignment that way with HermiT and found twelve classes
 * here unsatisfiable: ADL's ontology says "part of a Statement" with rdfs:subClassOf (Account ⊑
 * Actor ⊑ Statement, ActivityType ⊑ ActivityDefinition ⊑ Activity ⊑ Object ⊑ Statement, …) and
 * declares Actor, Verb, Object, Context, Result, Authority and Attachments pairwise disjoint, so
 * "Verb ≡ xapi:Verb ⊑ xapi:Statement ≡ Statement" contradicts this ontology's disjointness of a
 * Statement and its parts. The alignment now uses skos:broadMatch where ADL's class is broader for
 * having parts beneath it, skos:closeMatch where ADL's axioms admit nothing here, and says why on
 * each such mapping.
 *
 * ★ WHAT HOLDS, by the conservativity principle of ontology alignment (Jiménez-Ruiz et al. 2011;
 * Solimando, Jiménez-Ruiz & Guerrini, ISWC 2014): read as OWL over both ontologies' axioms, the
 * alignment leaves every class satisfiable; entails no subsumption between two classes of either
 * ontology that it does not entail alone; and keeps every use this ontology allows — a property on a
 * class of its domain, valued in its range — possible, without adding a class of this ontology to
 * it. ADL's axioms are the transcription in adl-xapi-ontology.ts, checked term for term against the
 * published file; the reading is tests/support/owl-reading.ts.
 *
 * ★ AGAINST HermiT. The negative controls below pin what HermiT 1.4 (through the OWL API) finds on the
 * same inputs: the twelve and thirteen unsatisfiable classes, the four and six new subsumptions and
 * the eight uses that gain a class, for the first alignment; and HermiT finds the alignment itself
 * coherent, conservative on both sides and consistent in every use. The reading here is stricter on
 * two datatypes outside the OWL 2 datatype map — rdf:langString (RDF 1.1) and xsd:duration — which
 * HermiT treats as uninterpreted names: read with their RDF 1.1 / XML Schema value spaces, as here,
 * no plain string is a language-tagged string and no string is a duration.
 */
import { describe, it, expect } from 'vitest';
import { DataFactory, type Quad } from 'n3';
import { turtleQuads, OWL, RDFS } from './support/ns-graph.js';
import { readAsOwl, MATCH, type Counterpart, type Verdict } from './support/owl-reading.js';
import { renderOwl, ontologyIri } from '../src/spec-ontology.js';
import { XAPI_MODEL } from '../src/spec/xapi.model.js';
import {
  ADL_XAPI_NS, ADL_XAPI_TERMS, ADL_XAPI_SUBCLASS_OF, ADL_XAPI_MISSPELLED_SUBCLASS_OF, ADL_XAPI_DISJOINT,
  ADL_XAPI_UNIONS, ADL_XAPI_DOMAIN, ADL_XAPI_RANGE,
} from '../src/spec/adl-xapi-ontology.js';

const FX = `${ontologyIri(XAPI_MODEL)}#`;
const SKOS_CONCEPT = 'http://www.w3.org/2004/02/skos/core#Concept';
const adl = (n: string): string => n.includes(':') ? n : ADL_XAPI_NS + n;
const local = (s: string): string => s.replaceAll(FX, '').replaceAll(ADL_XAPI_NS, 'xapi:').replaceAll(SKOS_CONCEPT, 'skos:Concept');

/** ADL's xAPI ontology, as the reading needs it — with its misspelled Score ⊑ Result, or without. */
function adlOntology(misspelledToo: boolean): Counterpart {
  const axioms = misspelledToo ? { ...ADL_XAPI_SUBCLASS_OF, ...ADL_XAPI_MISSPELLED_SUBCLASS_OF } : ADL_XAPI_SUBCLASS_OF;
  return {
    ns: ADL_XAPI_NS,
    classes: Object.entries(ADL_XAPI_TERMS).filter(([, k]) => k === 'class').map(([n]) => adl(n)),
    tbox: {
      sub: Object.entries(axioms).flatMap(([c, sups]) => sups.map(s => [adl(c), adl(s)] as const)),
      unions: Object.entries(ADL_XAPI_UNIONS).map(([u, ms]) => [adl(u), ms.map(adl)] as const),
      disjoint: ADL_XAPI_DISJOINT.map(d => d.map(adl)),
    },
    domain: p => (ADL_XAPI_DOMAIN[p.slice(ADL_XAPI_NS.length)] ?? []).map(adl),
    range: p => (ADL_XAPI_RANGE[p.slice(ADL_XAPI_NS.length)] ?? []).map(adl),
  };
}

const PUBLISHED = turtleQuads(renderOwl(XAPI_MODEL));
const readOf = (q: readonly Quad[], misspelledToo = false): Verdict => readAsOwl(q, FX, adlOntology(misspelledToo));
const shown = (xs: readonly string[]): string[] => xs.map(local);

/** The published alignment with some of its broad and close matches to ADL made exact again. */
const exactAgain = (pick: (term: string) => boolean): Quad[] => PUBLISHED.map(t =>
  (t.predicate.value === MATCH.broad || t.predicate.value === MATCH.close) && t.subject.value.startsWith(FX)
    && t.object.value.startsWith(ADL_XAPI_NS) && pick(t.subject.value.slice(FX.length))
    ? DataFactory.quad(t.subject, DataFactory.namedNode(MATCH.exact), t.object, t.graph) : t);

/** What ADL's ontology says of three of its classes, outside both namespaces, after xAPI Profiles,
 *  where verbs and activities are concepts: read through it, the classes here gain it too. */
const ADL_CONCEPTS = ['Activity ⊑ skos:Concept', 'ActivityDefinition ⊑ skos:Concept', 'Verb ⊑ skos:Concept'];

describe('the Foxxi xAPI ontology\'s alignment to ADL\'s, read as OWL', () => {
  for (const [title, misspelledToo] of [['ADL\'s ontology as published', false], ['ADL\'s misspelled Score ⊑ Result read as meant', true]] as const) {
    describe(title, () => {
      const v = readOf(PUBLISHED, misspelledToo);

      it('leaves every class of both ontologies satisfiable', () => {
        expect(v.unsatisfiable).toEqual({ from: [], to: [] });
      });

      it('entails no subsumption between two classes of either ontology that it does not entail alone', () => {
        expect(v.newSubsumptions).toEqual({ from: [], to: [] });
      });

      it('keeps every use of a property possible, and adds no class of this ontology to any', () => {
        expect(v.uses).toBeGreaterThan(80);
        expect(v.inconsistentUses).toEqual([]);
        expect(v.usesThatGain).toEqual([]);
      });

      it('outside both namespaces, adds only what ADL says of its own concepts', () => {
        expect(shown(v.gainedOutside)).toEqual(ADL_CONCEPTS);
      });
    });
  }

  it('uses each kind of match, and every match that is not exact says why on the mapping', () => {
    const toAdl = PUBLISHED.filter(t => Object.values(MATCH).includes(t.predicate.value as never) && t.subject.value.startsWith(FX) && t.object.value.startsWith(ADL_XAPI_NS));
    const notes = new Map<string, string>();
    for (const ax of PUBLISHED.filter(t => t.object.value === `${OWL}Axiom`).map(t => t.subject.value)) {
      const of = (p: string): string | undefined => PUBLISHED.find(t => t.subject.value === ax && t.predicate.value === p)?.object.value;
      notes.set(`${of(`${OWL}annotatedSource`)} ${of(`${OWL}annotatedProperty`)} ${of(`${OWL}annotatedTarget`)}`, of(`${RDFS}comment`)!);
    }
    const by = (m: string): string[] => toAdl.filter(t => t.predicate.value === m).map(t => t.subject.value.slice(FX.length)).sort();
    expect(by(MATCH.broad)).toEqual(['ActivityDefinition', 'Activity', 'Actor', 'Attachment', 'Context', 'Result', 'Statement'].sort());
    expect(by(MATCH.close)).toEqual(['Object', 'duration', 'extensions', 'fileUrl', 'member', 'moreInfo', 'name', 'usageType', 'version'].sort());
    expect(by(MATCH.exact).length).toBeGreaterThan(40);
    for (const t of toAdl.filter(x => x.predicate.value === MATCH.broad || x.predicate.value === MATCH.close)) {
      const note = notes.get(`${t.subject.value} ${t.predicate.value} ${t.object.value}`);
      expect(note, `${local(t.subject.value)} → ${local(t.object.value)}`).toMatch(t.predicate.value === MATCH.broad ? /^Broader there: / : /^Not an exact match/);
    }
  });
});

describe('the reading finds what HermiT finds (negative controls)', () => {
  // ★ REVISED. These were twelve classes here and thirteen of ADL's. Statement is now disjoint from
  // Object (a Statement is never a Statement's Object), so the first alignment's subsumptions of the
  // object kinds under Statement (ADL's part-of read as subClassOf, below) make those kinds
  // unsatisfiable too: sixteen here, eighteen of ADL's — what HermiT finds on this ontology
  // (ROBOT 1.9.x, rerun 2026-10-12). The alignment as published stays coherent (above).
  it('the first alignment — every match exact where the kinds agree — makes HermiT\'s sixteen classes unsatisfiable here, and eighteen of ADL\'s', () => {
    const v = readOf(exactAgain(term => !['member', 'moreInfo', 'usageType', 'version'].includes(term)));
    expect(shown(v.unsatisfiable.from)).toEqual(['Account', 'Activity', 'ActivityDefinition', 'ActivityType', 'Actor', 'Agent', 'Attachment', 'AttachmentUsageType', 'Context', 'ContextActivities', 'Group', 'Object', 'Result', 'StatementRef', 'SubStatement', 'Verb']);
    expect(shown(v.unsatisfiable.to)).toEqual(['Account', 'Activity', 'ActivityDefinition', 'ActivityType', 'Actor', 'Agent', 'AttachmentUsageType', 'Attachments', 'Context', 'ContextActivities', 'DisplayPropertyUnion', 'Group', 'NamePropertyUnion', 'Object', 'Result', 'StatementRef', 'SubStatement', 'Verb'].map(n => `xapi:${n}`));
    // The object kinds' subsumptions under Statement are the unsatisfiabilities above now.
    expect(v.newSubsumptions.from.map(local)).toEqual([]);
    expect(v.newSubsumptions.to.map(local)).toEqual(['xapi:DescriptionPropertyUnion ⊑ xapi:InteractionComponent', 'xapi:MemberUnion ⊑ xapi:Authority']);
    // The uses that gained Statement were uses of the object kinds, which have no use now.
    expect(v.usesThatGain.map(local)).toEqual([]);
  });

  it('with name, duration, fileUrl and extensions exact again, every use of them becomes impossible', () => {
    const v = readOf(exactAgain(term => ['name', 'duration', 'fileUrl', 'extensions'].includes(term)));
    expect(v.unsatisfiable).toEqual({ from: [], to: [] });
    expect(v.inconsistentUses.map(local)).toEqual([
      // xapi:duration's range is xsd:duration (HermiT, which leaves it uninterpreted, does not find this one)
      'duration on Result = a string value',
      // xapi:extensions's domain includes xapi:ActivityDefinition ⊑ xapi:Activity ⊑ xapi:Object, disjoint from Result and Context
      'extensions on Context → Extensions',
      'extensions on Result → Extensions',
      // xapi:fileURL's range is xsd:string
      'fileUrl on Attachment = a anyURI value',
      // xapi:name's ranges, rdf:langString and xsd:string, share no value; its domain includes xapi:ActivityDefinition
      // (HermiT, which leaves rdf:langString uninterpreted, finds all but the plain name of an Activity Definition)
      'name on Account = a langString value', 'name on Account = a string value',
      'name on ActivityDefinition = a langString value', 'name on ActivityDefinition = a string value',
      'name on Actor = a langString value', 'name on Actor = a string value',
    ]);
  });
});
