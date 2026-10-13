/**
 * spec/adl-xapi-ontology.ts — what ADL's xAPI ontology declares, as the Foxxi xAPI ontology's
 * mappings are checked against it.
 *
 * The Foxxi xAPI 2.0 ontology aligns to ADL's xAPI ontology (https://w3id.org/xapi/ontology) term by
 * term, with SKOS mappings. A mapping is only as good as its target: a skos:exactMatch to a term ADL
 * never declared is a dangling claim, and one between an object property and ADL's datatype property
 * says two things are interchangeable that OWL keeps apart. So the targets are checked against this
 * record of every term ADL's ontology declares, with the OWL kind ADL gives it and the label ADL
 * gives it (by a test, and by the SSSOM mapping set, which reports each target's kind and label).
 *
 * A mapping is also only as good as what it means once a tool reads it as OWL. Merge tools read
 * skos:exactMatch as owl:equivalentClass / owl:equivalentProperty and skos:broadMatch as
 * rdfs:subClassOf, and then ADL's axioms apply to the Foxxi terms: so the class axioms, domains and
 * ranges ADL's ontology states are recorded here too, and a test reads the alignment that way against
 * them (the-alignment-to-adl-holds-when-read-as-owl.test.ts).
 *
 * ★ TRANSCRIBED, NOT COPIED. Only names, kinds, labels and axioms are recorded — facts about the
 * published ontology, not its text. They are as published (dcterms:modified 2017-08-11; read
 * 2026-10-12), including ADL's own slips: three labels differ from their terms' names, and those
 * are kept as ADL wrote them, because a mapping set reports the target's label, not a corrected one;
 * and one superclass is written with a misspelled property, kept apart (ADL_XAPI_MISSPELLED_SUBCLASS_OF).
 */

/** ADL's xAPI ontology, and the namespace of its terms. */
export const ADL_XAPI_ONTOLOGY = 'https://w3id.org/xapi/ontology';
export const ADL_XAPI_NS = `${ADL_XAPI_ONTOLOGY}#`;
/** The ontology's dcterms:modified, as last read. It carries no owl:versionIRI or owl:versionInfo. */
export const ADL_XAPI_MODIFIED = '2017-08-11';

/** An OWL entity kind, as ADL's ontology declares it (rdf:type). */
export type AdlXapiKind = 'class' | 'object' | 'datatype' | 'annotation';

/** Every term ADL's xAPI ontology declares, by local name, with its declared kind. */
export const ADL_XAPI_TERMS: Readonly<Record<string, AdlXapiKind>> = Object.freeze({
  Account: 'class', Activity: 'class', ActivityDefinition: 'class', ActivityExtension: 'class',
  ActivityProfileResource: 'class', ActivityType: 'class', Actor: 'class', Agent: 'class',
  AgentProfileResource: 'class', Attachments: 'class', AttachmentUsageType: 'class', Authority: 'object',
  category: 'object', choices: 'object', completion: 'datatype', contentType: 'datatype', Context: 'class',
  ContextActivities: 'class', ContextExtension: 'class', correctResponsesPattern: 'datatype',
  description: 'datatype', DescriptionPropertyUnion: 'class', display: 'datatype', DisplayPropertyUnion: 'class',
  DocumentResource: 'class', duration: 'datatype', Extension: 'class', extensions: 'object',
  ExtensionsUnion: 'class', fileURL: 'datatype', Group: 'class', grouping: 'object', homePage: 'datatype',
  id: 'datatype', IDUnion: 'class', InteractionComponent: 'class', interactionId: 'datatype',
  interactionType: 'datatype', length: 'datatype', mbox: 'datatype', mbox_sha1sum: 'datatype', member: 'datatype',
  MemberUnion: 'class', moreInfo: 'object', name: 'datatype', NamePropertyUnion: 'class', Object: 'class',
  objectType: 'datatype', ObjectTypeUnion: 'class', openid: 'datatype', other: 'object', parent: 'object',
  registration: 'datatype', response: 'datatype', Result: 'class', ResultExtension: 'class', scale: 'object',
  Score: 'class', sha2: 'datatype', source: 'object', Statement: 'class', StatementRef: 'class',
  StateResource: 'class', steps: 'object', stored: 'datatype', SubStatement: 'class', success: 'datatype',
  target: 'object', timeStamp: 'datatype', type: 'object', usageType: 'datatype', Verb: 'class',
  version: 'annotation',
});

/** The labels ADL gives that differ from the term's name. Every other term's rdfs:label is its name. */
const ADL_XAPI_LABEL_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  ActivityDefinition: 'Activity',
  DisplayPropertyUnion: 'NamePropertyUnion',
  interactionId: 'interactionID',
});

/** A term of ADL's ontology by IRI: its kind and label, or undefined if ADL declares no such term. */
export function adlXapiTerm(iri: string): { kind: AdlXapiKind; label: string } | undefined {
  if (!iri.startsWith(ADL_XAPI_NS)) return undefined;
  const local = iri.slice(ADL_XAPI_NS.length);
  const kind = Object.prototype.hasOwnProperty.call(ADL_XAPI_TERMS, local) ? ADL_XAPI_TERMS[local] : undefined;
  return kind ? { kind, label: ADL_XAPI_LABEL_EXCEPTIONS[local] ?? local } : undefined;
}

const SKOS_CONCEPT = 'http://www.w3.org/2004/02/skos/core#Concept';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

/** Each class's superclasses as ADL's ontology states them (rdfs:subClassOf): ADL's own by local
 *  name, SKOS's Concept by IRI. Most say "part of a Statement" — Account ⊑ Actor ⊑ Statement. */
export const ADL_XAPI_SUBCLASS_OF: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Account: ['Actor'], Activity: [SKOS_CONCEPT, 'Object'], ActivityDefinition: [SKOS_CONCEPT, 'Activity'],
  ActivityExtension: ['Extension'], ActivityProfileResource: ['DocumentResource'],
  ActivityType: [SKOS_CONCEPT, 'ActivityDefinition'], Actor: ['Statement'], Agent: ['Actor'],
  AgentProfileResource: ['DocumentResource'], AttachmentUsageType: [SKOS_CONCEPT, 'Attachments'],
  Attachments: ['Statement'], Authority: ['Statement'], Context: ['Statement'], ContextActivities: ['Context'],
  ContextExtension: ['Extension'], DocumentResource: [SKOS_CONCEPT], Extension: [SKOS_CONCEPT], Group: ['Actor'],
  Object: ['Statement'], Result: ['Statement'], ResultExtension: ['Extension'], StateResource: ['DocumentResource'],
  StatementRef: ['Object'], SubStatement: ['Statement'], Verb: [SKOS_CONCEPT, 'Statement'],
});

/** The superclass ADL evidently meant and misspelled: `xapi:Score rdfs:subClassof xapi:Result`. RDFS
 *  defines no rdfs:subClassof, so no tool reads the triple as an axiom; an alignment that holds
 *  should hold once it is corrected, so the test reads the alignment with it as well. */
export const ADL_XAPI_MISSPELLED_SUBCLASS_OF: Readonly<Record<string, readonly string[]>> = Object.freeze({ Score: ['Result'] });

/** ADL's one owl:AllDisjointClasses. */
export const ADL_XAPI_DISJOINT: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['Actor', 'Verb', 'Object', 'Context', 'Result', 'Authority', 'Attachments']),
]);

/** ADL's union classes, written `X owl:unionOf (…)` on the named class — the OWL 1 form OWL tools
 *  read as X ≡ the union — each to say what the domain of one property is. */
export const ADL_XAPI_UNIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  NamePropertyUnion: ['Actor', 'Account', 'Agent', 'Group', 'ActivityDefinition', 'StatementRef'],
  DisplayPropertyUnion: ['Verb', 'Attachments'],
  DescriptionPropertyUnion: ['Object', 'ActivityDefinition', 'InteractionComponent', 'ContextActivities', 'Attachments'],
  ExtensionsUnion: ['ActivityExtension', 'ResultExtension', 'ContextExtension'],
  MemberUnion: ['Agent', 'Group', 'Authority', 'Attachments'],
  ObjectTypeUnion: ['Statement', 'Actor', 'Object', 'Authority'],
  IDUnion: ['Statement', 'StatementRef'],
});

/** Each object or datatype property's domains (rdfs:domain), by local name; two domains are their
 *  intersection. (xapi:version is an annotation property: its domain has no logical meaning.) */
export const ADL_XAPI_DOMAIN: Readonly<Record<string, readonly string[]>> = Object.freeze({
  category: ['ContextActivities'], choices: ['ActivityDefinition'], completion: ['Result'], contentType: ['Attachments'],
  correctResponsesPattern: ['ActivityDefinition'], description: ['DescriptionPropertyUnion'], display: ['DisplayPropertyUnion'],
  duration: ['Result'], extensions: ['ActivityDefinition', 'ExtensionsUnion'], fileURL: ['Attachments'],
  grouping: ['ContextActivities'], homePage: ['Account'], id: ['IDUnion'], interactionId: ['InteractionComponent'],
  interactionType: ['ActivityDefinition'], length: ['Attachments'], mbox: ['Actor'], mbox_sha1sum: ['Actor'],
  member: ['MemberUnion'], moreInfo: ['ActivityDefinition'], name: ['ActivityDefinition', 'NamePropertyUnion'],
  objectType: ['ObjectTypeUnion'], openid: ['Actor'], other: ['ContextActivities'], parent: ['ContextActivities'],
  registration: ['Context'], response: ['Result'], scale: ['ActivityDefinition'], sha2: ['Attachments'],
  source: ['ActivityDefinition'], steps: ['ActivityDefinition'], stored: ['Statement'], success: ['Result'],
  target: ['ActivityDefinition'], timeStamp: ['Statement'], type: ['ActivityDefinition'], usageType: ['Attachments'],
});

/** Each object or datatype property's ranges (rdfs:range): ADL's classes by local name, datatypes by
 *  IRI; two ranges are their intersection. (xapi:id and xapi:registration carry a datatype
 *  restriction written on the property itself, which no tool reads as a range.) */
export const ADL_XAPI_RANGE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  choices: ['InteractionComponent'], completion: [`${XSD}boolean`], correctResponsesPattern: [`${XSD}string`],
  description: [RDF_LANG_STRING], display: [RDF_LANG_STRING], duration: [`${XSD}duration`], fileURL: [`${XSD}string`],
  homePage: [`${XSD}anyURI`], interactionId: [`${XSD}string`], interactionType: [`${XSD}string`], moreInfo: [`${XSD}anyURI`],
  name: [RDF_LANG_STRING, `${XSD}string`], objectType: [`${XSD}string`], openid: [`${XSD}anyURI`], response: [`${XSD}string`],
  scale: ['InteractionComponent'], sha2: [`${XSD}string`], source: ['InteractionComponent'], steps: ['InteractionComponent'],
  stored: [`${XSD}dateTime`], success: [`${XSD}boolean`], target: ['InteractionComponent'], timeStamp: [`${XSD}dateTime`],
  type: ['ActivityType'], usageType: ['AttachmentUsageType'],
});
