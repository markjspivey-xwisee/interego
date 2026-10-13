/**
 * xAPI 2.0 (IEEE 9274.1.1-2023) — the Statement data model, as the single source.
 *
 * Composed into the PGSL lattice (composeSpecOntology) and projected to OWL/SHACL/JSON-LD on
 * dereference at <bridge>/ns/xapi. A statement is read into this ontology through the JSON-LD
 * context published beside it (<bridge>/ns/xapi/context, xapi-context.ts), and the SHACL shapes
 * this model publishes check that reading. The LRS checks each statement it receives with its own
 * validator (xapi-validate.ts); POST /ns/xapi/validate runs these shapes on a statement's JSON beside
 * that validator, and every result cites its shape IRI. On the statements in
 * tests/a-statement-read-as-rdf-meets-the-same-shapes.test.ts the two readings give one verdict.
 *
 * ★ SECTION NUMBERS ARE THE STANDARD'S OWN. IEEE 9274.1.1-2023 numbers the Statement in §5.2.2 of
 * its Content part (Actor §5.2.2.1 … Attachments §5.2.2.6; data types §5.2.7). This model used to
 * cite the xAPI 1.0.3 numbering (§4.1.x), which does not exist in the standard it names.
 *
 * ★ WHAT 2.0 ADDED IS MODELLED: context.contextAgents / contextGroups (each a ContextAgent /
 * ContextGroup with relevantTypes), context.statement, the interaction component lists
 * (choices / scale / source / target / steps), and the Attachment's required display.
 *
 * ★ OWL 2 DL ALL THE WAY DOWN. xsd:duration is not in the OWL 2 datatype map, and `rdf:JSON` is a
 * datatype, so it cannot be the range of an object property — both made the document not DL.
 * Durations, UUIDs and versions are now named datatypes restricting xsd:string by the pattern the
 * standard prescribes, scores are a union of decimal and double (what JSON-LD 1.1 turns a JSON
 * number into), and `extensions` points at an Extensions node. Exclusive object types are
 * disjoint, an Actor is the disjoint union of Agent and Group, and the Inverse Functional
 * Identifiers are keys.
 *
 * ★ ALIGNED TO ADL'S xAPI ONTOLOGY (https://w3id.org/xapi/ontology, prefix `xapi:`) by SKOS
 * mappings, term by term — never by owl:equivalentClass, and ADL's ontology is not imported.
 *
 * ★ exactMatch ONLY BETWEEN TERMS OF THE SAME KIND. A skos:exactMatch says two terms can be used
 * interchangeably, and OWL does not let a datatype property stand in for an object property: one
 * relates a node to literals, the other to individuals. ADL's ontology gives four constructs a
 * different kind from the one they have here — member (a datatype property there; Agents here),
 * moreInfo (an object property there, with a datatype range), usageType (a datatype property
 * there, with a class range) and version (an annotation property there) — so those four are
 * skos:closeMatch, and each says why on the mapping itself (an owl:Axiom annotation). Every target
 * is checked against what ADL's ontology declares (adl-xapi-ontology.ts), and the whole alignment
 * is published as an SSSOM mapping set at /ns/xapi/mappings, which also lists, as sssom:NoTermFound,
 * each term here that ADL's ontology has no counterpart for.
 *
 * ★ AND ONLY WHERE THE MATCH HOLDS AS OWL. Tools that merge mapping sets read skos:exactMatch as
 * owl:equivalentClass / owl:equivalentProperty and skos:broadMatch as rdfs:subClassOf. Read that
 * way, the first alignment made twelve classes here unsatisfiable, because ADL's ontology says
 * "part of" with rdfs:subClassOf — Account ⊑ Actor ⊑ Statement, ActivityType ⊑ ActivityDefinition ⊑
 * Activity ⊑ Object ⊑ Statement, ContextActivities ⊑ Context, AttachmentUsageType ⊑ Attachments, and
 * (meant, but misspelled) Score ⊑ Result — and declares Actor, Verb, Object, Context, Result,
 * Authority and Attachments pairwise disjoint. So each ADL class with parts beneath it is broader
 * than the class here (skos:broadMatch) and the parts are the exact matches; Object is a closeMatch,
 * because ADL's Object excludes the Agents and Groups that xAPI lets be an Object; and so are four
 * properties whose ADL axioms no value here could satisfy (name, duration, fileURL, extensions). Each
 * broadMatch and closeMatch says why on the mapping. A test reads the alignment that way against
 * ADL's axioms (adl-xapi-ontology.ts): nothing here becomes unsatisfiable, no subsumption appears
 * between two classes of either ontology that it did not already entail, and no use of a property
 * this ontology allows becomes inconsistent or gains a class of this ontology
 * (the-alignment-to-adl-holds-when-read-as-owl.test.ts).
 */
import { NS_ROOT, type OntologyModel } from '../spec-ontology.js';
import { ISO8601_DURATION, RFC3339_UTC_TIMESTAMP } from './patterns.js';
import { ADL_XAPI_ONTOLOGY, ADL_XAPI_NS } from './adl-xapi-ontology.js';

/** This document's version (YYYY.MM.PATCH; see ns/catalog.ts). */
const XAPI_VERSION = '2026.10.0';
/** The JSON-LD context a statement is read through (xapi-context.ts), at the version of this
 *  ontology it reads a statement into. Data cites a context by URL, and what it means must not
 *  change under it, so each version has its own context, which never changes; /ns/xapi/context
 *  answers with the current one. */
export const XAPI_CONTEXT_URL = `${NS_ROOT}xapi/context/${XAPI_VERSION}`;

/** Canonical xAPI vocabularies + lexical patterns — the SINGLE SOURCE the runtime LRS validator
 *  (xapi-validate.ts) consumes AND the published SHACL shapes render from, so what gates a
 *  statement on write is the same thing the ontology declares. */
export const XAPI_INTERACTION_TYPES = ['true-false', 'choice', 'fill-in', 'long-fill-in', 'matching', 'performance', 'sequencing', 'likert', 'numeric', 'other'] as const;
// UUID hex is case-INSENSITIVE per RFC 4122/9562 — the char class carries BOTH cases so the
// pattern matches identically whether an engine applies the 'i' flag (the LRS ingest validator)
// or not (the SHACL `new RegExp(pattern)` engine). Previously `[0-9a-f]` + an 'i'-only-on-ingest
// mismatch made the SHACL oracle false-reject a spec-valid uppercase-hex UUID the LRS accepted.
// Both are written in the subset XML Schema, XPath, JavaScript and Python read alike (patterns.ts).
export const XAPI_PATTERNS = { uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', version: '^(1\\.0(\\.[0-9]+)?|2\\.0(\\.[0-9]+)?)$' } as const;
const UUID = XAPI_PATTERNS.uuid;
const VERSION = XAPI_PATTERNS.version;
// An RFC 3339 date-time in UTC, as a statement states it and the LRS stores it (patterns.ts).
const TIMESTAMP = RFC3339_UTC_TIMESTAMP;
// ISO 8601:2004 §4.4.3.2 duration (the format §5.2.7 requires; the alternative format of
// §4.4.3.3 is excluded by the standard, and by this pattern): at least one component, and the
// week form alone — what the LRS's own check (xapi-duration.ts) accepts.
const DURATION = ISO8601_DURATION;
const SHA1_HEX = '^[0-9a-fA-F]{40}$';
/** The verb that voids a Statement (§5.2.5). */
const VOIDED = 'http://adlnet.gov/expapi/verbs/voided';
const MEDIA_TYPE = '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(\\s*;.*)?$';
/** What a JSON number becomes in RDF (JSON-LD 1.1 §8.6): an integer, or a double. */
const NUMBER = ['xsd:integer', 'xsd:decimal', 'xsd:double'] as const;

const S = 'IEEE 9274.1.1-2023';

/** The note on a mapping to a class of ADL's that is broader than the class here because ADL's
 *  ontology places parts of the construct under it by rdfs:subClassOf. */
const PARTS_UNDER = (adl: string, parts: string, here: string): string =>
  `Broader there: ADL's ontology places ${parts} under xapi:${adl} by rdfs:subClassOf, so its instances include them; here ${here}.`;

export const XAPI_MODEL: OntologyModel = {
  module: 'xapi',
  title: 'xAPI 2.0 (IEEE 9274.1.1-2023) — Statement data model',
  description: 'An OWL 2 DL ontology and SHACL shapes for the Statement data model of xAPI 2.0, IEEE 9274.1.1-2023 (Content part, §5.2): Statement, Actor (Agent, Group, Account), Verb, Object (Activity, StatementRef, SubStatement), Result and Score, Context with its context activities, context agents and context groups, and Attachments, with the data types of §5.2.7. Each term is aligned to ADL\'s xAPI ontology by a SKOS mapping. A statement is read into the ontology through the JSON-LD 1.1 context published with it (/ns/xapi/context), and the shapes check that reading.',
  version: XAPI_VERSION,
  created: '2026-06-19',
  spec: 'https://standards.ieee.org/ieee/9274.1.1/7321/',
  standards: [
    { title: 'IEEE 9274.1.1-2023 — Standard for Learning Technology: JSON Data Model Format and RESTful Web Service for Learner Experience Data Tracking and Access (xAPI 2.0)', url: 'https://standards.ieee.org/ieee/9274.1.1/7321/' },
    { title: 'xAPI 2.0 base standard documentation (Content part), IEEE open source repository', url: 'https://opensource.ieee.org/xapi/xapi-base-standard-documentation' },
  ],
  bodies: ['IEEE', 'ADL'],
  // `adl-xapi:` is ADL's xAPI ontology. Inside this model a bare `xapi:` token would name THIS
  // module (the module name always resolves to its own namespace), so the alignment targets
  // need a prefix of their own; in the published documents they print as `xapi:`.
  prefixes: { 'adl-xapi': 'https://w3id.org/xapi/ontology#' },
  seeAlso: [ADL_XAPI_ONTOLOGY, XAPI_CONTEXT_URL],
  // Every term here is accounted for against ADL's ontology in the mapping set: mapped, or listed
  // as having no counterpart there.
  counterpart: { iri: ADL_XAPI_ONTOLOGY, namespace: ADL_XAPI_NS },
  notes: [
    'Alignment to ADL\'s xAPI ontology (prefix xapi:) is by SKOS mappings chosen to hold when a tool reads them as OWL (skos:exactMatch as equivalence, skos:broadMatch as subsumption): skos:exactMatch where both name the same construct of the Statement data model and ADL\'s axioms for it agree with this ontology\'s; skos:broadMatch where ADL\'s class is broader, because its ontology places parts of the construct under it by rdfs:subClassOf (xapi:Statement, xapi:Actor, xapi:Activity, xapi:ActivityDefinition, xapi:Result, xapi:Context, xapi:Attachments); and skos:closeMatch where ADL declares a different kind of OWL entity (member, moreInfo, usageType, version) or gives axioms no use here could satisfy (Object, name, duration, fileURL, extensions). Each broadMatch and closeMatch carries its reason as an annotation on the mapping axiom. ADL\'s ontology is not imported, and none of its axioms is asserted here.',
    'The alignment is also published as an SSSOM 1.0 mapping set (/ns/xapi/mappings), which lists the terms with no counterpart in ADL\'s ontology as mappings to sssom:NoTermFound.',
    'Language maps (display, name, description) are rdf:langString values: one language-tagged string per entry of the map.',
    `A statement is read into this ontology through the JSON-LD 1.1 context at ${XAPI_CONTEXT_URL}: objectType is read as rdf:type, a Statement\'s and a Statement Reference\'s id as the xapi:id UUID, an Activity\'s and a Verb\'s id as the node\'s IRI. The shapes select what that reading produces — by class where xAPI types a node, and by the property that reaches it (sh:targetObjectsOf, sh:targetSubjectsOf) where xAPI leaves it untyped: a Statement, a Verb, a Result, a Context, an Agent whose objectType is left out.`,
  ],
  classes: [
    { name: 'Statement', label: 'Statement', comment: 'An immutable record that an Actor did something: the Actor, the Verb, the Object, and optionally a Result, a Context, a timestamp and Attachments.', source: `${S} §5.2.2`, broadMatch: ['adl-xapi:Statement'],
      mappingNotes: { 'adl-xapi:Statement': PARTS_UNDER('Statement', 'the parts of a Statement (Actor, Verb, Object, Context, Result, Authority, Attachments) and the Sub-Statement', 'a Statement is the record alone, and disjoint from its parts') } },
    { name: 'SubStatement', label: 'Sub-Statement', comment: 'A Statement nested as the Object of another Statement: an actor, verb and object (with optional result, context, timestamp and attachments), but no id, stored, version or authority, and never itself containing a Sub-Statement.', source: `${S} §5.2.2.3 (Object as Sub-Statement)`, subClassOf: ['Object'], exactMatch: ['adl-xapi:SubStatement'] },
    { name: 'Actor', label: 'Actor', comment: 'Whom a Statement is about: an Agent or a Group, and never both.', source: `${S} §5.2.2.1`, disjointUnionOf: ['Agent', 'Group'], hasKey: [['mbox'], ['mbox_sha1sum'], ['openid'], ['account']], broadMatch: ['adl-xapi:Actor'],
      mappingNotes: { 'adl-xapi:Actor': PARTS_UNDER('Actor', 'Accounts (xapi:Account)', 'an Account is not an Actor') } },
    { name: 'Agent', label: 'Agent', comment: 'A single person or system, identified by exactly one Inverse Functional Identifier: mbox, mbox_sha1sum, openid or account.', source: `${S} §5.2.2.1 (Actor as Agent)`, subClassOf: ['Actor'], exactMatch: ['adl-xapi:Agent'] },
    { name: 'Group', label: 'Group', comment: 'A collection of Agents. An Identified Group carries exactly one Inverse Functional Identifier and may list members; an Anonymous Group carries none and must list its members.', source: `${S} §5.2.2.1 (Actor as Anonymous Group; Actor as Identified Group)`, subClassOf: ['Actor'], exactMatch: ['adl-xapi:Group'] },
    { name: 'Account', label: 'Account', comment: 'A user account on an existing system, such as an LMS or an intranet, identified by the system\'s home page and the account\'s name together.', source: `${S} §5.2.2.1 (Account)`, hasKey: [['homePage', 'name']], exactMatch: ['adl-xapi:Account'] },
    { name: 'Verb', label: 'Verb', comment: 'The action of a Statement: an IRI that names the meaning (not the word), with a language map giving its display form.', source: `${S} §5.2.2.2`, exactMatch: ['adl-xapi:Verb'] },
    { name: 'Object', label: 'Object', comment: 'What the Actor interacted with: an Activity, an Agent or Group, a Statement Reference, or a Sub-Statement — told apart by objectType.', source: `${S} §5.2.2.3`, unionOf: ['Activity', 'Agent', 'Group', 'StatementRef', 'SubStatement'], closeMatch: ['adl-xapi:Object'],
      mappingNotes: { 'adl-xapi:Object': 'Not an exact match: ADL\'s ontology makes xapi:Object disjoint from xapi:Actor (owl:AllDisjointClasses), so an Agent or Group is never an Object there, while xAPI 2.0 lets either be the Object of a Statement (§5.2.2.3) and here Object includes them; and it places Activity Definitions and activity types under xapi:Object, through xapi:Activity. Read as an equivalence, every Agent or Group here would be unsatisfiable.' } },
    { name: 'Activity', label: 'Activity', comment: 'A unit of instruction, experience or performance that is tracked, identified by an IRI.', source: `${S} §5.2.2.3 (Object as Activity)`, subClassOf: ['Object'], broadMatch: ['adl-xapi:Activity'],
      mappingNotes: { 'adl-xapi:Activity': PARTS_UNDER('Activity', 'Activity Definitions and activity types (xapi:ActivityDefinition, and under it xapi:ActivityType)', 'an Activity\'s definition and its type are not Activities') } },
    { name: 'ActivityDefinition', label: 'Activity Definition', comment: 'Metadata about an Activity: name, description, type, more information, interaction details and extensions.', source: `${S} §5.2.2.3 (Activity Definition)`, broadMatch: ['adl-xapi:ActivityDefinition'],
      mappingNotes: { 'adl-xapi:ActivityDefinition': `${PARTS_UNDER('ActivityDefinition', 'activity types (xapi:ActivityType)', 'an activity type is not an Activity Definition')} ADL\'s ontology also labels the class Activity, the label of its Activity class; it is the Activity Definition.` } },
    { name: 'InteractionComponent', label: 'Interaction Component', comment: 'One element of an interaction component list (a choice, a point on a scale, a source or target to match, or a step), with an id and an optional description.', source: `${S} §5.2.2.3 (Interaction Components)`, exactMatch: ['adl-xapi:InteractionComponent'] },
    { name: 'StatementRef', label: 'Statement Reference', comment: 'A pointer to another Statement, by its UUID.', source: `${S} §5.2.2.3 (Object as Statement)`, subClassOf: ['Object'], exactMatch: ['adl-xapi:StatementRef'] },
    { name: 'Result', label: 'Result', comment: 'A measured outcome of the experience a Statement records: score, success, completion, response, duration and extensions.', source: `${S} §5.2.2.4`, broadMatch: ['adl-xapi:Result'],
      mappingNotes: { 'adl-xapi:Result': 'Broader there: ADL\'s ontology places xapi:Score under xapi:Result — with rdfs:subClassof, a property RDFS does not define, so no tool reads the triple as an axiom; read as intended, a Result there includes its Score, and here a Score is not a Result. Mapped as broader so that the alignment holds when that triple is corrected.' } },
    { name: 'Score', label: 'Score', comment: 'The outcome of a graded Activity: a scaled score, and the raw score with its minimum and maximum.', source: `${S} §5.2.2.4 (Score)`, exactMatch: ['adl-xapi:Score'] },
    { name: 'Context', label: 'Context', comment: 'Information that gives a Statement more meaning: its registration, context activities, context agents and groups, revision, platform, language, a related Statement and extensions.', source: `${S} §5.2.2.5`, broadMatch: ['adl-xapi:Context'],
      mappingNotes: { 'adl-xapi:Context': PARTS_UNDER('Context', 'context activities (xapi:ContextActivities)', 'a Context\'s context activities are not a Context') } },
    { name: 'ContextActivities', label: 'Context Activities', comment: 'The Activities a Statement is related to, by kind of relation: parent, grouping, category and other.', source: `${S} §5.2.2.5 (contextActivities)`, exactMatch: ['adl-xapi:ContextActivities'] },
    { name: 'ContextAgent', label: 'Context Agent', comment: 'A relationship, limited to one Statement, between that Statement and one Agent, characterized by zero or more relevant types.', source: `${S} §5.2.2.5 (Context Agents)` },
    { name: 'ContextGroup', label: 'Context Group', comment: 'A relationship, limited to one Statement, between that Statement and one Group, characterized by zero or more relevant types.', source: `${S} §5.2.2.5 (Context Groups)` },
    { name: 'Attachment', label: 'Attachment', comment: 'A digital artifact logically part of a Statement — an essay, a video, a certificate image, or the JSON Web Signature of a signed Statement — described by its usage type, display name, content type, length and SHA-2 hash.', source: `${S} §5.2.2.6`, broadMatch: ['adl-xapi:Attachments'],
      mappingNotes: { 'adl-xapi:Attachments': `${PARTS_UNDER('Attachments', 'attachment usage types (xapi:AttachmentUsageType)', 'an Attachment\'s usage type is not an Attachment')} ADL names the class in the plural, after the Statement\'s attachments property; its instances are the Attachment objects.` } },
    { name: 'Extensions', label: 'Extensions', comment: 'An extensions map: a node whose properties are extension IRIs, each valued with any JSON value. The meaning and structure of a value are defined by whoever controls its IRI.', source: `${S} §5.2.7 (Extensions)`, relatedMatch: ['adl-xapi:Extension'],
      mappingNotes: { 'adl-xapi:Extension': 'Related, not the same: ADL\'s Extension classifies an extension\'s IRI (a SKOS concept, as an activity type is); this class is the map that carries extension values, keyed by those IRIs.' } },
    { name: 'ActivityType', label: 'Activity Type', comment: 'A kind of Activity, named by an IRI in an Activity Definition\'s type.', source: `${S} §5.2.2.3 (Activity Definition)`, subClassOf: ['skos:Concept'], exactMatch: ['adl-xapi:ActivityType'] },
    { name: 'AttachmentUsageType', label: 'Attachment Usage Type', comment: 'A kind of use of an Attachment, named by an IRI coined for that use (for example a completion certificate, or a Statement signature).', source: `${S} §5.2.2.6`, subClassOf: ['skos:Concept'], exactMatch: ['adl-xapi:AttachmentUsageType'] },
  ],
  datatypes: [
    { name: 'UUID', label: 'UUID', comment: 'A UUID in its standard string form (RFC 4122 / RFC 9562), hexadecimal digits in either case.', base: 'xsd:string', pattern: UUID, source: `${S} §5.2.7 (UUIDs)` },
    { name: 'Duration', label: 'Duration', comment: 'An ISO 8601:2004 duration in the format of its §4.4.3.2 (PnYnMnDTnHnMnS, weeks as PnW). The alternative format of §4.4.3.3 is not allowed. Defined on xsd:string because xsd:duration is outside the OWL 2 datatype map.', base: 'xsd:string', pattern: DURATION, source: `${S} §5.2.7 (Duration)` },
    { name: 'Version', label: 'Version', comment: 'An xAPI version in Semantic Versioning 1.0.0 form: 1.0.x or 2.0.x.', base: 'xsd:string', pattern: VERSION, source: `${S} §5.2.2` },
    { name: 'SHA1Hex', label: 'SHA-1 hex', comment: 'A hexadecimal SHA-1 digest (40 hex digits).', base: 'xsd:string', pattern: SHA1_HEX, source: `${S} §5.2.2.1 (mbox_sha1sum)` },
    { name: 'MediaType', label: 'Internet media type', comment: 'An Internet Media Type (RFC 6838), with optional parameters.', base: 'xsd:string', pattern: MEDIA_TYPE, source: `${S} §5.2.2.6 (contentType)` },
    { name: 'Number', label: 'Number', comment: 'A JSON number as RDF carries it: xsd:integer for an integer, xsd:double otherwise (JSON-LD 1.1 §8.6), or an xsd:decimal.', base: 'xsd:decimal', alsoBases: ['xsd:double'], source: `${S} §5.2.2.4 (Score)` },
    { name: 'ScaledScore', label: 'Scaled score', comment: 'A Number between -1 and 1, inclusive.', base: 'xsd:decimal', alsoBases: ['xsd:double'], minInclusive: -1, maxInclusive: 1, source: `${S} §5.2.2.4 (Score: scaled)` },
  ],
  properties: [
    // Statement
    { name: 'id', kind: 'datatype', label: 'id', comment: 'A UUID: the identifier of a Statement, or of the Statement a Statement Reference points at.', domain: ['Statement', 'StatementRef'], range: 'UUID', functional: true, source: `${S} §5.2.2; §5.2.2.3 (Object as Statement)`, exactMatch: ['adl-xapi:id'] },
    { name: 'actor', kind: 'object', label: 'actor', comment: 'Whom the Statement is about, as an Agent or a Group.', domain: ['Statement', 'SubStatement'], range: 'Actor', functional: true, source: `${S} §5.2.2` },
    { name: 'verb', kind: 'object', label: 'verb', comment: 'The action taken by the Actor.', domain: ['Statement', 'SubStatement'], range: 'Verb', functional: true, source: `${S} §5.2.2` },
    { name: 'object', kind: 'object', label: 'object', comment: 'The Activity, Agent, Group or Statement that is the object of the Statement.', domain: ['Statement', 'SubStatement'], range: 'Object', functional: true, source: `${S} §5.2.2` },
    { name: 'result', kind: 'object', label: 'result', comment: 'The measured outcome of the experience.', domain: ['Statement', 'SubStatement'], range: 'Result', functional: true, source: `${S} §5.2.2` },
    { name: 'context', kind: 'object', label: 'context', comment: 'The context that gives the Statement more meaning.', domain: ['Statement', 'SubStatement'], range: 'Context', functional: true, source: `${S} §5.2.2` },
    { name: 'timestamp', kind: 'datatype', label: 'timestamp', comment: 'When the events the Statement describes occurred: an RFC 3339 timestamp in UTC, set by the LRS when not provided.', domain: ['Statement', 'SubStatement'], range: 'xsd:dateTime', functional: true, source: `${S} §5.2.2; §5.2.7 (Timestamps)`, exactMatch: ['adl-xapi:timeStamp'] },
    { name: 'stored', kind: 'datatype', label: 'stored', comment: 'When the LRS recorded the Statement. Set by the LRS.', domain: 'Statement', range: 'xsd:dateTime', functional: true, source: `${S} §5.2.2`, exactMatch: ['adl-xapi:stored'] },
    { name: 'authority', kind: 'object', label: 'authority', comment: 'The Agent or Group asserting that the Statement is true, verified by the LRS from authentication.', domain: 'Statement', range: 'Actor', functional: true, source: `${S} §5.2.2`, exactMatch: ['adl-xapi:Authority'],
      mappingNotes: { 'adl-xapi:Authority': 'ADL declares xapi:Authority an owl:ObjectProperty, as this is; its ontology also uses the IRI as a class (a subclass of xapi:Statement, and one of its disjoint classes).' } },
    { name: 'version', kind: 'datatype', label: 'version', comment: 'The xAPI version the Statement is associated with. Not recommended for a Learning Record Provider to set.', domain: 'Statement', range: 'Version', functional: true, source: `${S} §5.2.2`, closeMatch: ['adl-xapi:version'],
      mappingNotes: { 'adl-xapi:version': 'Not an exact match because of kind: ADL declares xapi:version an owl:AnnotationProperty, which no class axiom or shape can constrain; here it is a datatype property whose values are xAPI version numbers.' } },
    { name: 'attachments', kind: 'object', label: 'attachments', comment: 'The headers of the Attachments to the Statement.', domain: ['Statement', 'SubStatement'], range: 'Attachment', source: `${S} §5.2.2` },
    // Actor / Agent / Group / Account
    { name: 'objectType', kind: 'datatype', label: 'object type', comment: 'Which kind of object a node is. Required for a Group, a Statement Reference, a Sub-Statement, a context agent and a context group, and for an Agent used as a Statement\'s object.', domain: ['Agent', 'Group', 'Activity', 'StatementRef', 'SubStatement', 'ContextAgent', 'ContextGroup'], oneOf: ['Agent', 'Group', 'Activity', 'StatementRef', 'SubStatement', 'contextAgent', 'contextGroup'], functional: true, source: `${S} §5.2.2.1; §5.2.2.3; §5.2.2.5`, notation: 'objectType', exactMatch: ['adl-xapi:objectType'] },
    { name: 'name', kind: 'datatype', label: 'name', comment: 'A name: the full name of an Agent or Group, the unique id or login name of an Account, or the human-readable name of an Activity (a language map).', domain: ['Actor', 'Account', 'ActivityDefinition'], range: ['xsd:string', 'rdf:langString'], source: `${S} §5.2.2.1; §5.2.2.3`, closeMatch: ['adl-xapi:name'],
      mappingNotes: { 'adl-xapi:name': 'Not an exact match: ADL\'s ontology gives xapi:name two ranges, rdf:langString and xsd:string, whose value spaces are disjoint, so no value is in both; and two domains, one of them xapi:ActivityDefinition, so whatever has a name would be an Activity Definition. Read as an equivalence, every name here — of an Agent, a Group, an Account or an Activity — would be inconsistent.' } },
    { name: 'mbox', kind: 'datatype', label: 'mbox', comment: 'A mailto IRI — "mailto:" followed by an email address uniquely assigned to the Agent or Group. An Inverse Functional Identifier.', domain: 'Actor', range: 'xsd:anyURI', functional: true, source: `${S} §5.2.2.1`, notation: 'mbox', exactMatch: ['adl-xapi:mbox'] },
    { name: 'mbox_sha1sum', kind: 'datatype', label: 'mbox SHA-1 sum', comment: 'The hex-encoded SHA-1 hash of a mailto IRI (the value of an mbox). An Inverse Functional Identifier.', domain: 'Actor', range: 'SHA1Hex', functional: true, source: `${S} §5.2.2.1`, notation: 'mbox_sha1sum', exactMatch: ['adl-xapi:mbox_sha1sum'] },
    { name: 'openid', kind: 'datatype', label: 'OpenID', comment: 'An OpenID URI that uniquely identifies the Agent or Group. An Inverse Functional Identifier.', domain: 'Actor', range: 'xsd:anyURI', functional: true, source: `${S} §5.2.2.1`, exactMatch: ['adl-xapi:openid'] },
    // An Inverse Functional Identifier, and an object property, so OWL 2 DL lets it say so: one
    // account node identifies one Actor, named or not (owl:hasKey, above, binds only named ones).
    { name: 'account', kind: 'object', label: 'account', comment: 'A user account on an existing system. An Inverse Functional Identifier.', domain: 'Actor', range: 'Account', functional: true, inverseFunctional: true, source: `${S} §5.2.2.1` },
    { name: 'member', kind: 'object', label: 'member', comment: 'An Agent that is a member of the Group (an unordered list).', domain: 'Group', range: 'Agent', source: `${S} §5.2.2.1`, closeMatch: ['adl-xapi:member'],
      mappingNotes: { 'adl-xapi:member': 'Not an exact match because of kind: ADL declares xapi:member an owl:DatatypeProperty, whose values are literals; a Group\'s members are Agents, individuals, so here it is an object property.' } },
    { name: 'homePage', kind: 'datatype', label: 'home page', comment: 'The canonical home page of the system an Account is on (an IRL), after FOAF\'s accountServiceHomePage.', domain: 'Account', range: 'xsd:anyURI', functional: true, source: `${S} §5.2.2.1 (Account)`, closeMatch: ['http://xmlns.com/foaf/0.1/accountServiceHomepage'], exactMatch: ['adl-xapi:homePage'] },
    // Verb
    { name: 'display', kind: 'datatype', label: 'display', comment: 'The human-readable representation, in one or more languages, of a Verb (it does not change the Verb\'s meaning) or the display name of an Attachment.', domain: ['Verb', 'Attachment'], range: 'rdf:langString', source: `${S} §5.2.2.2; §5.2.2.6`, exactMatch: ['adl-xapi:display'] },
    // Activity / Activity Definition
    { name: 'definition', kind: 'object', label: 'definition', comment: 'The metadata of an Activity.', domain: 'Activity', range: 'ActivityDefinition', functional: true, source: `${S} §5.2.2.3 (Object as Activity)` },
    { name: 'description', kind: 'datatype', label: 'description', comment: 'A description, as a language map, of an Activity, an interaction component or an Attachment.', domain: ['ActivityDefinition', 'InteractionComponent', 'Attachment'], range: 'rdf:langString', source: `${S} §5.2.2.3; §5.2.2.6`, exactMatch: ['adl-xapi:description'] },
    { name: 'type', kind: 'object', label: 'type', comment: 'The type of the Activity, an IRI.', domain: 'ActivityDefinition', range: 'ActivityType', functional: true, source: `${S} §5.2.2.3 (Activity Definition)`, exactMatch: ['adl-xapi:type'] },
    { name: 'moreInfo', kind: 'datatype', label: 'more info', comment: 'An IRL resolving to a document with human-readable information about the Activity, which may include a way to launch it.', domain: 'ActivityDefinition', range: 'xsd:anyURI', functional: true, source: `${S} §5.2.2.3 (Activity Definition)`, closeMatch: ['adl-xapi:moreInfo'],
      mappingNotes: { 'adl-xapi:moreInfo': 'Not an exact match because of kind: ADL declares xapi:moreInfo an owl:ObjectProperty with the datatype range xsd:anyURI, which OWL 2 DL does not allow; the value is an IRL, a literal, so here it is a datatype property.' } },
    { name: 'interactionType', kind: 'datatype', label: 'interaction type', comment: 'The type of interaction, from the controlled vocabulary of interaction types.', domain: 'ActivityDefinition', oneOf: [...XAPI_INTERACTION_TYPES], functional: true, source: `${S} §5.2.2.3 (Interaction Activities)`, exactMatch: ['adl-xapi:interactionType'] },
    { name: 'correctResponsesPattern', kind: 'datatype', label: 'correct responses pattern', comment: 'A pattern a learner\'s response is correct if it matches; a response is correct if it matches any pattern in the list. The structure depends on the interaction type.', domain: 'ActivityDefinition', range: 'xsd:string', source: `${S} §5.2.2.3 (Interaction Activities)`, exactMatch: ['adl-xapi:correctResponsesPattern'] },
    { name: 'choices', kind: 'object', label: 'choices', comment: 'The options available for selection or ordering in a choice or sequencing interaction.', domain: 'ActivityDefinition', range: 'InteractionComponent', source: `${S} §5.2.2.3 (Interaction Components)`, exactMatch: ['adl-xapi:choices'] },
    { name: 'scale', kind: 'object', label: 'scale', comment: 'The options on the scale of a likert interaction.', domain: 'ActivityDefinition', range: 'InteractionComponent', source: `${S} §5.2.2.3 (Interaction Components)`, exactMatch: ['adl-xapi:scale'] },
    { name: 'source', kind: 'object', label: 'source', comment: 'The sources to be matched in a matching interaction.', domain: 'ActivityDefinition', range: 'InteractionComponent', source: `${S} §5.2.2.3 (Interaction Components)`, exactMatch: ['adl-xapi:source'] },
    { name: 'target', kind: 'object', label: 'target', comment: 'The targets to be matched in a matching interaction.', domain: 'ActivityDefinition', range: 'InteractionComponent', source: `${S} §5.2.2.3 (Interaction Components)`, exactMatch: ['adl-xapi:target'] },
    { name: 'steps', kind: 'object', label: 'steps', comment: 'The elements making up a performance interaction.', domain: 'ActivityDefinition', range: 'InteractionComponent', source: `${S} §5.2.2.3 (Interaction Components)`, exactMatch: ['adl-xapi:steps'] },
    { name: 'componentId', kind: 'datatype', label: 'component id', comment: 'The id of an interaction component, unique within its list. (In JSON, the component\'s "id".)', domain: 'InteractionComponent', range: 'xsd:string', functional: true, source: `${S} §5.2.2.3 (Interaction Components)`, notation: 'id', exactMatch: ['adl-xapi:interactionId'] },
    // Result / Score
    { name: 'score', kind: 'object', label: 'score', comment: 'The score of the Agent in relation to the success or quality of the experience.', domain: 'Result', range: 'Score', functional: true, source: `${S} §5.2.2.4` },
    { name: 'success', kind: 'datatype', label: 'success', comment: 'Whether the attempt on the Activity was successful.', domain: 'Result', range: 'xsd:boolean', functional: true, source: `${S} §5.2.2.4`, exactMatch: ['adl-xapi:success'] },
    { name: 'completion', kind: 'datatype', label: 'completion', comment: 'Whether the Activity was completed.', domain: 'Result', range: 'xsd:boolean', functional: true, source: `${S} §5.2.2.4`, exactMatch: ['adl-xapi:completion'] },
    { name: 'response', kind: 'datatype', label: 'response', comment: 'A response, formatted for the given Activity.', domain: 'Result', range: 'xsd:string', functional: true, source: `${S} §5.2.2.4`, exactMatch: ['adl-xapi:response'] },
    { name: 'duration', kind: 'datatype', label: 'duration', comment: 'The period of time over which the Statement occurred.', domain: 'Result', range: 'Duration', functional: true, source: `${S} §5.2.2.4; §5.2.7 (Duration)`, closeMatch: ['adl-xapi:duration'],
      mappingNotes: { 'adl-xapi:duration': 'Not an exact match: ADL\'s ontology gives xapi:duration the range xsd:duration, which is outside the OWL 2 datatype map, whose values are not strings, and whose lexical space has no weeks (PnW), which xAPI allows; here a duration is the ISO 8601 string the standard prescribes. Read as an equivalence, every duration here would be inconsistent.' } },
    { name: 'scaled', kind: 'datatype', label: 'scaled', comment: 'The score as modified by scaling or normalization, between -1 and 1 inclusive.', domain: 'Score', range: 'ScaledScore', functional: true, source: `${S} §5.2.2.4 (Score)` },
    { name: 'raw', kind: 'datatype', label: 'raw', comment: 'The score achieved, unmodified by scaling or normalization; between min and max (inclusive) when they are present.', domain: 'Score', range: 'Number', functional: true, source: `${S} §5.2.2.4 (Score)` },
    { name: 'min', kind: 'datatype', label: 'min', comment: 'The lowest possible score for the experience; less than max when it is present.', domain: 'Score', range: 'Number', functional: true, source: `${S} §5.2.2.4 (Score)` },
    { name: 'max', kind: 'datatype', label: 'max', comment: 'The highest possible score for the experience; greater than min when it is present.', domain: 'Score', range: 'Number', functional: true, source: `${S} §5.2.2.4 (Score)` },
    // Context
    { name: 'registration', kind: 'datatype', label: 'registration', comment: 'The UUID of the registration the Statement is associated with.', domain: 'Context', range: 'UUID', functional: true, source: `${S} §5.2.2.5`, exactMatch: ['adl-xapi:registration'] },
    { name: 'instructor', kind: 'object', label: 'instructor', comment: 'The instructor the Statement relates to, when not its Actor. Not recommended in xAPI 2.0, which supersedes it with contextAgents.', domain: 'Context', range: 'Actor', functional: true, source: `${S} §5.2.2.5` },
    { name: 'team', kind: 'object', label: 'team', comment: 'The team the Statement relates to, when not its Actor. Not recommended in xAPI 2.0, which supersedes it with contextGroups.', domain: 'Context', range: 'Group', functional: true, source: `${S} §5.2.2.5` },
    { name: 'contextActivities', kind: 'object', label: 'context activities', comment: 'The Activities the Statement is related to, by kind of relation.', domain: 'Context', range: 'ContextActivities', functional: true, source: `${S} §5.2.2.5` },
    { name: 'contextAgents', kind: 'object', label: 'context agents', comment: 'Statement-specific relationships between the Statement and Agents.', domain: 'Context', range: 'ContextAgent', source: `${S} §5.2.2.5 (Context Agents)` },
    { name: 'contextGroups', kind: 'object', label: 'context groups', comment: 'Statement-specific relationships between the Statement and Groups.', domain: 'Context', range: 'ContextGroup', source: `${S} §5.2.2.5 (Context Groups)` },
    { name: 'revision', kind: 'datatype', label: 'revision', comment: 'The revision of the learning activity associated with the Statement, in a free format.', domain: 'Context', range: 'xsd:string', functional: true, source: `${S} §5.2.2.5` },
    { name: 'platform', kind: 'datatype', label: 'platform', comment: 'The platform used in the experience.', domain: 'Context', range: 'xsd:string', functional: true, source: `${S} §5.2.2.5` },
    { name: 'language', kind: 'datatype', label: 'language', comment: 'The RFC 5646 code of the language the experience mainly occurred in.', domain: 'Context', range: 'xsd:language', functional: true, source: `${S} §5.2.2.5` },
    { name: 'statement', kind: 'object', label: 'statement', comment: 'Another Statement to be considered as context for this one.', domain: 'Context', range: 'StatementRef', functional: true, source: `${S} §5.2.2.5` },
    { name: 'parent', kind: 'object', label: 'parent', comment: 'An Activity that is a direct parent of the Activity of the Statement.', domain: 'ContextActivities', range: 'Activity', source: `${S} §5.2.2.5 (contextActivities)`, exactMatch: ['adl-xapi:parent'] },
    { name: 'grouping', kind: 'object', label: 'grouping', comment: 'An Activity with an indirect relation to the Activity of the Statement.', domain: 'ContextActivities', range: 'Activity', source: `${S} §5.2.2.5 (contextActivities)`, exactMatch: ['adl-xapi:grouping'] },
    { name: 'category', kind: 'object', label: 'category', comment: 'An Activity used to categorize the Statement — for example the xAPI Profile it conforms to.', domain: 'ContextActivities', range: 'Activity', source: `${S} §5.2.2.5 (contextActivities)`, exactMatch: ['adl-xapi:category'] },
    { name: 'other', kind: 'object', label: 'other', comment: 'An Activity related to the Statement in another way.', domain: 'ContextActivities', range: 'Activity', source: `${S} §5.2.2.5 (contextActivities)`, exactMatch: ['adl-xapi:other'] },
    { name: 'agent', kind: 'object', label: 'agent', comment: 'The one Agent a context agent relationship is defined for.', domain: 'ContextAgent', range: 'Agent', functional: true, source: `${S} §5.2.2.5 (Context Agents)` },
    { name: 'group', kind: 'object', label: 'group', comment: 'The one Group a context group relationship is defined for.', domain: 'ContextGroup', range: 'Group', functional: true, source: `${S} §5.2.2.5 (Context Groups)` },
    { name: 'relevantTypes', kind: 'object', label: 'relevant types', comment: 'A type IRI characterizing the relationship between the Statement and the Agent or Group. Without any, only a generic relationship is intended (not recommended).', domain: ['ContextAgent', 'ContextGroup'], range: 'skos:Concept', source: `${S} §5.2.2.5 (Context Agents; Context Groups)` },
    // Attachment
    { name: 'usageType', kind: 'object', label: 'usage type', comment: 'The usage of the Attachment, an IRI coined for that use.', domain: 'Attachment', range: 'AttachmentUsageType', functional: true, source: `${S} §5.2.2.6`, closeMatch: ['adl-xapi:usageType'],
      mappingNotes: { 'adl-xapi:usageType': 'Not an exact match because of kind: ADL declares xapi:usageType an owl:DatatypeProperty with the class range xapi:AttachmentUsageType, which OWL 2 DL does not allow; a usage type is an IRI naming a concept, so here it is an object property.' } },
    { name: 'contentType', kind: 'datatype', label: 'content type', comment: 'The Internet Media Type of the Attachment.', domain: 'Attachment', range: 'MediaType', functional: true, source: `${S} §5.2.2.6`, exactMatch: ['adl-xapi:contentType'] },
    { name: 'length', kind: 'datatype', label: 'length', comment: 'The length of the Attachment data, in octets.', domain: 'Attachment', range: 'xsd:nonNegativeInteger', functional: true, source: `${S} §5.2.2.6`, exactMatch: ['adl-xapi:length'] },
    { name: 'sha2', kind: 'datatype', label: 'SHA-2', comment: 'The SHA-2 hash of the Attachment data; required even when fileUrl is given.', domain: 'Attachment', range: 'xsd:string', functional: true, source: `${S} §5.2.2.6`, exactMatch: ['adl-xapi:sha2'] },
    { name: 'fileUrl', kind: 'datatype', label: 'file URL', comment: 'An IRL from which the Attachment data can be, or could once be, retrieved.', domain: 'Attachment', range: 'xsd:anyURI', functional: true, source: `${S} §5.2.2.6`, closeMatch: ['adl-xapi:fileURL'],
      mappingNotes: { 'adl-xapi:fileURL': 'Not an exact match: ADL\'s ontology gives xapi:fileURL the range xsd:string, and here a file URL is an xsd:anyURI (an IRL); OWL 2 keeps the two value spaces apart, so read as an equivalence every file URL here would be inconsistent.' } },
    // Extensions
    { name: 'extensions', kind: 'object', label: 'extensions', comment: 'A map of further properties keyed by IRI, on an Activity Definition, a Result or a Context.', domain: ['ActivityDefinition', 'Result', 'Context'], range: 'Extensions', functional: true, source: `${S} §5.2.7 (Extensions)`, closeMatch: ['adl-xapi:extensions'],
      mappingNotes: { 'adl-xapi:extensions': 'Not an exact match: ADL\'s ontology gives xapi:extensions two domains, xapi:ActivityDefinition and the union of its extension concepts, so whatever has extensions would be an Activity Definition — and so an Activity and an Object, which a Result or a Context cannot be there; and its extensions point at extension concepts, where here they point at the map that carries the values. Read as an equivalence, every Result or Context with extensions would be inconsistent.' } },
  ],
  vocabularies: [
    {
      name: 'InteractionType', label: 'Interaction types', comment: 'The controlled vocabulary of interaction types for interaction Activities. Each value fixes the format of the correct responses pattern and the learner\'s response.',
      members: [
        { name: 'true-false', label: 'true or false', comment: 'An interaction with two possible responses: true or false.' },
        { name: 'choice', label: 'choice', comment: 'An interaction with a number of possible choices from which the learner selects one or several.' },
        { name: 'fill-in', label: 'fill in', comment: 'An interaction requiring a short response of one or more strings of characters (normally 250 characters or fewer).' },
        { name: 'long-fill-in', label: 'long fill in', comment: 'An interaction requiring a long response (normally more than 250 characters).' },
        { name: 'matching', label: 'matching', comment: 'An interaction in which the learner matches items in a source set to items in a target set.' },
        { name: 'performance', label: 'performance', comment: 'An interaction requiring the learner to perform a task of several steps.' },
        { name: 'sequencing', label: 'sequencing', comment: 'An interaction in which the learner orders items in a set.' },
        { name: 'likert', label: 'Likert', comment: 'An interaction in which the learner selects from a discrete set of choices on a scale.' },
        { name: 'numeric', label: 'numeric', comment: 'An interaction requiring a numeric response.' },
        { name: 'other', label: 'other', comment: 'An interaction that fits none of the other types.' },
      ],
    },
  ],
  disjoint: [
    // objectType is exclusive: one node is one kind of object.
    ['Activity', 'Agent', 'Group', 'StatementRef', 'SubStatement'],
    // A Statement is never the Object of a Statement — a Sub-Statement or a Statement Reference is.
    ['Statement', 'Object'],
    // The parts of a Statement are different kinds of thing.
    ['Statement', 'Verb', 'Result', 'Score', 'Context', 'ContextActivities', 'ContextAgent', 'ContextGroup', 'Attachment', 'Account', 'ActivityDefinition', 'InteractionComponent', 'Extensions'],
  ],
  shapes: [
    {
      name: 'StatementShape', targetClass: 'Statement', targetSubjectsOf: ['actor', 'verb', 'object'], label: 'xAPI Statement conformance',
      comment: `${S} §5.2.2: a Statement has exactly one actor, verb and object; its id (if present) is a UUID; its timestamps are RFC 3339 in UTC; its version follows the xAPI version grammar. Read through /ns/xapi/context a statement is untyped, as xAPI leaves it, so the shape also selects whatever has an actor, a verb or an object — a Statement, or a Sub-Statement, which the Sub-Statement shape further restricts.`,
      constraints: [
        { path: 'actor', minCount: 1, maxCount: 1, comment: 'exactly one Actor (§5.2.2)' },
        { path: 'verb', minCount: 1, maxCount: 1, comment: 'exactly one Verb (§5.2.2)' },
        { path: 'object', minCount: 1, maxCount: 1, comment: 'exactly one Object (§5.2.2)' },
        { path: 'id', maxCount: 1, datatype: 'xsd:string', pattern: UUID, comment: 'a UUID (§5.2.2, §5.2.7)' },
        { path: 'result', maxCount: 1, comment: 'at most one Result (§5.2.2)' },
        { path: 'context', maxCount: 1, comment: 'at most one Context (§5.2.2)' },
        { path: 'timestamp', maxCount: 1, datatype: 'xsd:dateTime', pattern: TIMESTAMP, comment: 'RFC 3339, in UTC (§5.2.7)' },
        { path: 'stored', maxCount: 1, datatype: 'xsd:dateTime', pattern: TIMESTAMP, comment: 'RFC 3339, in UTC (§5.2.7)' },
        { path: 'version', maxCount: 1, datatype: 'xsd:string', pattern: VERSION, comment: 'xAPI version grammar (§5.2.2)' },
        { path: 'authority', maxCount: 1, comment: 'one authority Actor (§5.2.2)' },
      ],
      atLeastOneOf: { alternatives: [{ shape: 'NotVoidingShape' }, { shape: 'VoidingShape' }], comment: 'a voiding Statement\'s object is a Statement Reference (§5.2.5)' },
    },
    {
      name: 'NotVoidingShape', label: 'Not a voiding Statement',
      comment: `${S} §5.2.5: a Statement whose verb is not voided. Referred to by the Statement shape; it selects nothing itself.`,
      constraints: [
        { path: 'verb.id', rdfPath: 'verb', notHasValue: VOIDED, notHasIri: VOIDED, comment: 'the verb is not voided' },
      ],
    },
    {
      name: 'VoidingShape', label: 'Voiding Statement',
      comment: `${S} §5.2.5: a Statement that voids another names it by a Statement Reference. Referred to by the Statement shape; it selects nothing itself.`,
      constraints: [
        { path: 'object.objectType', rdfPath: ['object', 'rdf:type'], hasValue: 'StatementRef', hasIri: 'StatementRef', comment: 'the object is a Statement Reference (§5.2.5)' },
      ],
    },
    {
      name: 'ActorShape', targetObjectsOf: ['actor', 'authority', 'instructor'], label: 'Actor conformance',
      comment: `${S} §5.2.2.1: an Actor is a Group — which says so (objectType Group) — or else an Agent; read through /ns/xapi/context an Agent whose objectType is left out is untyped, so this shape holds whatever is an actor, an authority or an instructor to the Agent shape unless it is a Group.`,
      constraints: [],
      atLeastOneOf: { alternatives: [{ class: 'Group' }, { shape: 'AgentShape' }], comment: 'a Group, or an Agent (§5.2.2.1)' },
    },
    {
      name: 'AgentShape', targetClass: 'Agent', targetObjectsOf: ['member', 'agent'], label: 'Agent conformance',
      comment: `${S} §5.2.2.1: an Agent is identified by EXACTLY ONE Inverse Functional Identifier (mbox / mbox_sha1sum / openid / account) — rendered as sh:xone below and enforced by the validator.`,
      constraints: [
        { path: 'objectType', rdfPath: null, maxCount: 1, in: ['Agent'], comment: 'Agent, when present (§5.2.2.1); read as rdf:type' },
        { path: 'mbox', maxCount: 1, datatype: 'xsd:anyURI', pattern: '^mailto:', comment: 'a mailto IRI (§5.2.2.1)' },
        { path: 'mbox_sha1sum', maxCount: 1, datatype: 'xsd:string', pattern: SHA1_HEX, comment: 'hex SHA-1 (§5.2.2.1)' },
        { path: 'openid', maxCount: 1, datatype: 'xsd:anyURI', comment: 'an OpenID URI (§5.2.2.1)' },
        { path: 'account', maxCount: 1, comment: 'one account (§5.2.2.1)' },
      ],
      exactlyOneOf: { paths: ['mbox', 'mbox_sha1sum', 'openid', 'account'], comment: 'exactly one IFI (§5.2.2.1)' },
    },
    {
      name: 'GroupShape', targetClass: 'Group', label: 'Group conformance',
      comment: `${S} §5.2.2.1: a Group is an Identified Group, with exactly one IFI (and members if it lists them), or an Anonymous Group, with members and no IFI.`,
      constraints: [
        { path: 'objectType', rdfPath: null, minCount: 1, maxCount: 1, in: ['Group'], comment: 'Group (§5.2.2.1); read as rdf:type' },
        { path: 'mbox', maxCount: 1, datatype: 'xsd:anyURI', pattern: '^mailto:', comment: 'a mailto IRI (§5.2.2.1)' },
        { path: 'mbox_sha1sum', maxCount: 1, datatype: 'xsd:string', pattern: SHA1_HEX, comment: 'hex SHA-1 (§5.2.2.1)' },
      ],
      atLeastOneOf: { alternatives: [{ shape: 'IdentifiedGroupShape' }, { shape: 'AnonymousGroupShape' }], comment: 'an Identified Group or an Anonymous Group (§5.2.2.1)' },
    },
    {
      name: 'IdentifiedGroupShape', label: 'Identified Group',
      comment: `${S} §5.2.2.1 (Actor as Identified Group): exactly one Inverse Functional Identifier. Referred to by the Group shape; it selects nothing itself.`,
      constraints: [],
      exactlyOneOf: { paths: ['mbox', 'mbox_sha1sum', 'openid', 'account'], comment: 'exactly one IFI (§5.2.2.1)' },
    },
    {
      name: 'AnonymousGroupShape', label: 'Anonymous Group',
      comment: `${S} §5.2.2.1 (Actor as Anonymous Group): a member list, and no Inverse Functional Identifier. Referred to by the Group shape; it selects nothing itself.`,
      constraints: [
        { path: 'member', minCount: 1, comment: 'the Agents in the Group (§5.2.2.1)' },
        { path: 'mbox', maxCount: 0 }, { path: 'mbox_sha1sum', maxCount: 0 }, { path: 'openid', maxCount: 0 }, { path: 'account', maxCount: 0 },
      ],
    },
    {
      name: 'AccountShape', targetClass: 'Account', targetObjectsOf: ['account'], label: 'Account conformance',
      comment: `${S} §5.2.2.1: an Account has exactly one homePage (an IRL) and exactly one name.`,
      constraints: [
        { path: 'homePage', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'the system home page (§5.2.2.1)' },
        { path: 'name', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the account name (§5.2.2.1)' },
      ],
    },
    {
      name: 'VerbShape', targetClass: 'Verb', targetObjectsOf: ['verb'], label: 'Verb conformance',
      comment: `${S} §5.2.2.2: a Verb is identified by an IRI; its display is a language map.`,
      constraints: [
        { path: 'id', identifies: true, minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'the Verb IRI (§5.2.2.2)' },
        { path: 'display', datatype: 'rdf:langString', comment: 'a language map (§5.2.2.2)' },
      ],
    },
    {
      name: 'ObjectShape', targetObjectsOf: ['object'], label: 'Object conformance',
      comment: `${S} §5.2.2.3: the Object of a Statement is an Agent, a Group, a Statement Reference or a Sub-Statement — each of which says so (objectType) — or else an Activity.`,
      constraints: [],
      atLeastOneOf: {
        alternatives: [{ class: 'Agent' }, { class: 'Group' }, { class: 'StatementRef' }, { class: 'SubStatement' }, { shape: 'ActivityShape' }],
        comment: 'an Agent, a Group, a Statement Reference or a Sub-Statement, or else an Activity (§5.2.2.3)',
      },
    },
    {
      name: 'ActivityShape', targetClass: 'Activity', targetObjectsOf: ['parent', 'grouping', 'category', 'other'], label: 'Activity conformance',
      comment: `${S} §5.2.2.3: an Activity is identified by an IRI and has at most one definition.`,
      constraints: [
        { path: 'id', identifies: true, minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'the Activity IRI (§5.2.2.3)' },
        { path: 'objectType', rdfPath: null, maxCount: 1, in: ['Activity'], comment: 'Activity, when present (§5.2.2.3); read as rdf:type' },
        { path: 'definition', maxCount: 1, comment: 'at most one Activity Definition (§5.2.2.3)' },
      ],
    },
    {
      name: 'InteractionDefinitionShape', targetClass: 'ActivityDefinition', targetObjectsOf: ['definition'], label: 'Activity Definition conformance',
      comment: `${S} §5.2.2.3: interactionType is one of the interaction types; type is an IRI.`,
      constraints: [
        { path: 'interactionType', maxCount: 1, in: [...XAPI_INTERACTION_TYPES], comment: 'interaction type vocabulary (§5.2.2.3)' },
        { path: 'type', maxCount: 1, nodeKind: 'IRI', comment: 'the Activity type IRI (§5.2.2.3)' },
        { path: 'moreInfo', maxCount: 1, datatype: 'xsd:anyURI', comment: 'an IRL (§5.2.2.3)' },
        { path: 'name', datatype: 'rdf:langString', comment: 'a language map (§5.2.2.3)' },
        { path: 'description', datatype: 'rdf:langString', comment: 'a language map (§5.2.2.3)' },
      ],
    },
    {
      name: 'InteractionComponentShape', targetClass: 'InteractionComponent', targetObjectsOf: ['choices', 'scale', 'source', 'target', 'steps'], label: 'Interaction component conformance',
      comment: `${S} §5.2.2.3 (Interaction Components): a component has one id, unique within its list, and a description that is a language map.`,
      constraints: [
        { path: 'componentId', jsonPath: 'id', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the component id (§5.2.2.3)' },
        { path: 'description', datatype: 'rdf:langString', comment: 'a language map (§5.2.2.3)' },
      ],
    },
    {
      name: 'ResultShape', targetClass: 'Result', targetObjectsOf: ['result'], label: 'Result conformance',
      comment: `${S} §5.2.2.4: success and completion are booleans; duration is an ISO 8601 duration.`,
      constraints: [
        { path: 'success', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'completion', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'response', maxCount: 1, datatype: 'xsd:string' },
        { path: 'duration', maxCount: 1, datatype: 'xsd:string', pattern: DURATION, comment: 'ISO 8601:2004 §4.4.3.2 duration (§5.2.7)' },
        { path: 'score', maxCount: 1, comment: 'at most one Score (§5.2.2.4)' },
      ],
    },
    {
      name: 'ScoreShape', targetClass: 'Score', targetObjectsOf: ['score'], label: 'Score conformance',
      comment: `${S} §5.2.2.4: scaled is a number in [-1, 1]; raw, min and max are numbers, min less than max, and raw between them.`,
      constraints: [
        { path: 'scaled', maxCount: 1, datatype: NUMBER, minInclusive: -1, maxInclusive: 1, comment: 'scaled ∈ [-1, 1] (§5.2.2.4)' },
        { path: 'raw', maxCount: 1, datatype: NUMBER, lessThanOrEquals: 'max', comment: 'a number, at most max (§5.2.2.4)' },
        { path: 'min', maxCount: 1, datatype: NUMBER, lessThan: 'max', lessThanOrEquals: 'raw', comment: 'a number, less than max and at most raw (§5.2.2.4)' },
        { path: 'max', maxCount: 1, datatype: NUMBER, comment: 'a number (§5.2.2.4)' },
      ],
    },
    {
      name: 'StatementRefShape', targetClass: 'StatementRef', label: 'Statement Reference conformance',
      comment: `${S} §5.2.2.3: a Statement Reference has objectType StatementRef and the UUID of a Statement.`,
      constraints: [
        { path: 'objectType', rdfPath: null, minCount: 1, maxCount: 1, in: ['StatementRef'], comment: 'StatementRef (§5.2.2.3); read as rdf:type' },
        { path: 'id', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: UUID, comment: 'a UUID (§5.2.2.3)' },
      ],
    },
    {
      name: 'SubStatementShape', targetClass: 'SubStatement', label: 'Sub-Statement conformance',
      comment: `${S} §5.2.2.3: a Sub-Statement has objectType SubStatement and exactly one actor, verb and object; it has no id, stored, version or authority, and its object is not a Sub-Statement.`,
      constraints: [
        { path: 'objectType', rdfPath: null, minCount: 1, maxCount: 1, in: ['SubStatement'], comment: 'SubStatement (§5.2.2.3); read as rdf:type' },
        { path: 'actor', minCount: 1, maxCount: 1 },
        { path: 'verb', minCount: 1, maxCount: 1 },
        { path: 'object', minCount: 1, maxCount: 1 },
        { path: 'id', maxCount: 0, comment: 'a Sub-Statement has no id (§5.2.2.3)' },
        { path: 'stored', maxCount: 0, comment: 'a Sub-Statement has no stored (§5.2.2.3)' },
        { path: 'version', maxCount: 0, comment: 'a Sub-Statement has no version (§5.2.2.3)' },
        { path: 'authority', maxCount: 0, comment: 'a Sub-Statement has no authority (§5.2.2.3)' },
        { path: 'object.objectType', rdfPath: ['object', 'rdf:type'], notHasValue: 'SubStatement', notHasIri: 'SubStatement', comment: 'a Sub-Statement does not nest another (§5.2.2.3)' },
      ],
    },
    {
      name: 'ContextShape', targetClass: 'Context', targetObjectsOf: ['context'], label: 'Context conformance',
      comment: `${S} §5.2.2.5: registration is a UUID; language is an RFC 5646 tag; statement is a Statement Reference; team is a Group.`,
      constraints: [
        { path: 'registration', maxCount: 1, datatype: 'xsd:string', pattern: UUID, comment: 'a UUID (§5.2.2.5)' },
        { path: 'language', maxCount: 1, datatype: 'xsd:language', comment: 'an RFC 5646 language tag (§5.2.2.5)' },
        { path: 'statement', maxCount: 1, class: 'StatementRef', comment: 'one Statement Reference (§5.2.2.5)' },
        { path: 'team', maxCount: 1, class: 'Group', comment: 'one Group (§5.2.2.5)' },
        { path: 'instructor', maxCount: 1, comment: 'one Agent or Group (§5.2.2.5)' },
        { path: 'contextActivities', maxCount: 1 },
      ],
    },
    {
      name: 'ContextAgentShape', targetClass: 'ContextAgent', label: 'Context agent conformance',
      comment: `${S} §5.2.2.5: a context agent has objectType contextAgent, exactly one Agent, and relevant types that are IRIs.`,
      constraints: [
        { path: 'objectType', rdfPath: null, minCount: 1, maxCount: 1, in: ['contextAgent'], comment: 'contextAgent (§5.2.2.5); read as rdf:type' },
        { path: 'agent', minCount: 1, maxCount: 1 },
        { path: 'relevantTypes', nodeKind: 'IRI', comment: 'type IRIs (§5.2.2.5)' },
      ],
    },
    {
      name: 'ContextGroupShape', targetClass: 'ContextGroup', label: 'Context group conformance',
      comment: `${S} §5.2.2.5: a context group has objectType contextGroup, exactly one Group, and relevant types that are IRIs.`,
      constraints: [
        { path: 'objectType', rdfPath: null, minCount: 1, maxCount: 1, in: ['contextGroup'], comment: 'contextGroup (§5.2.2.5); read as rdf:type' },
        { path: 'group', minCount: 1, maxCount: 1, class: 'Group' },
        { path: 'relevantTypes', nodeKind: 'IRI', comment: 'type IRIs (§5.2.2.5)' },
      ],
    },
    {
      name: 'AttachmentShape', targetClass: 'Attachment', targetObjectsOf: ['attachments'], label: 'Attachment conformance',
      comment: `${S} §5.2.2.6: usageType (an IRI), display (a language map), contentType, length and sha2 are required.`,
      constraints: [
        { path: 'usageType', minCount: 1, maxCount: 1, nodeKind: 'IRI' },
        { path: 'display', minCount: 1, datatype: 'rdf:langString', comment: 'a language map, required in xAPI 2.0 (§5.2.2.6)' },
        { path: 'description', datatype: 'rdf:langString', comment: 'a language map (§5.2.2.6)' },
        { path: 'contentType', minCount: 1, maxCount: 1, datatype: 'xsd:string', pattern: MEDIA_TYPE },
        { path: 'length', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 0, comment: 'octets (§5.2.2.6)' },
        { path: 'sha2', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'fileUrl', maxCount: 1, datatype: 'xsd:anyURI' },
      ],
    },
  ],
};
