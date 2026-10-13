/**
 * The IEEE-LER + ADL-TLA emergent, composable semantic layer.
 *
 * Two learning-and-employment-technology standards families — IEEE's
 * Learning and Employment Records (P2997 Enterprise Learner Record,
 * 1484.20.1 RCD, 1484.20.3 SCD, 1484.2 LER Ecosystems) and ADL's Total
 * Learning Architecture (the four data pillars, the Master Object Model,
 * the CaSS competency model, the federated LRS tiers, the learner-state
 * machines) — neither of which ships a published RDF namespace.
 *
 * This module fills that gap, but it does NOT just transcribe them as
 * flat class hierarchies. It models them the Interego way: *emergent and
 * composable*. The research finding behind this design is that most LER
 * and TLA concepts are not new vocabulary at all — they are compositions
 * over four primitives the substrate already provides:
 *
 *   - an Attestation  (an agent asserts a claim about a subject)
 *   - an EventRecord  (actor – verb – object, at a time)
 *   - a ResourceDescriptor (typed metadata about a thing)
 *   - an Aggregation  (a set with membership + provenance)
 *
 * So every term here carries a `construction` facet:
 *
 *   minted   — genuinely new vocabulary (Competency, Rubric, RollupRule).
 *   composed — an Aggregation / union over substrate primitives
 *              (an Enterprise Learner Record is the union of its
 *               record entries — not a monolithic content class).
 *   view     — a query / projection over a graph of primitives
 *              (an Experience Index, a Transcript, the three LRS tiers,
 *               a learner-state snapshot are all views, not stores).
 *   role     — a role a generic Agent plays (Issuer, Holder, Endorser).
 *   concept  — a SKOS concept / code-list value (the MOM verbs).
 *
 * A `composed` / `view` / `role` term is rendered with explicit
 * `iep:constructedFrom` triples pointing at the substrate primitives it
 * emerges from — the "emergent composable" claim made machine-readable.
 * The two families are aligned to each other, and to CaSS, CTDL-ASN and
 * 1EdTech, with `skos:closeMatch` — an editorial alignment between two
 * standards' notions. This used to be `owl:equivalentClass`, which tells a
 * reasoner the two classes have the SAME instances: a logical claim no one
 * is in a position to make about two independently maintained standards,
 * and one OOPS! rightly flagged as critical.
 *
 * Each family is published as one OWL 2 DL graph (`semOntologyGraph`) and
 * every representation — Turtle, RDF/XML, N-Triples, JSON-LD, HTML — is a
 * serialization of that graph (see ns/rdf.ts), with the shared document
 * header from ns/catalog.ts and MIREOT declarations of every external term.
 *
 * Layer: L3 vertical vocabulary. Two scoped namespaces OUTSIDE the
 * protocol IRI space; the bridge serves both as dereferenceable linked
 * data, and production code paths actually GET them at runtime.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
// The proficiency roll-up rule is a GRAPH parsed at runtime, not a ladder in this file — see
// `performanceProficiencyBands`. These are the substrate's own reader, used the substrate's way.
import { parseTrig, findSubjectsOfType, readStringValue, readIriValue } from '@interego/core';
import type { IRI } from '@interego/core';
// Every serialization goes through the one graph model and its serializers (ns/rdf.ts), which
// escape with the substrate's single Turtle-literal escaper.
import {
  Graph, iri, en, str, typed, RDF, RDFS, OWL, XSD, SKOS, DCT, toTurtle, toJsonLd, toNTriples, toRdfXml, parseTurtle,
  type NamedNode, type BlankNode, type JsonLdTerm,
} from './ns/rdf.js';
import { ALL_PREFIXES, addHeader, declareExternalTerms, foxxiPrefix, versionIri, alternates, type DocMeta } from './ns/catalog.js';
import { FOXXI_CONSTRUCTION, CONSTRUCTION_DEFINITION, foxxiDocMeta } from './foxxi-vocab.js';
import { renderOntologyHtml } from './ns/html.js';
import { mappingSetIri } from './ns/sssom.js';

// ── Namespace bases ──────────────────────────────────────────────────

const BRIDGE = 'https://foxxi-bridge.interego.xwisee.com';
/** IEEE Learning & Employment Records namespace. */
export const LER_NS = `${BRIDGE}/ns/ieee-ler#`;
/** ADL Total Learning Architecture namespace. */
export const TLA_NS = `${BRIDGE}/ns/adl-tla#`;
export const LER_DOC = LER_NS.replace(/#$/, '');
export const TLA_DOC = TLA_NS.replace(/#$/, '');
/** IEEE P2997, the Enterprise Learner Record project: its IEEE SA project page, the one IRI every
 *  Foxxi document and record uses for it (https://standards.ieee.org/ieee/2997/ only redirects to a
 *  search). An active PAR, not a published standard. */
export const P2997 = 'https://standards.ieee.org/ieee/2997/10632/';

/** Each document's version (YYYY.MM.PATCH; see ns/catalog.ts). */
const LER_VERSION = '2026.10.0';
const TLA_VERSION = '2026.10.0';
/** The version of the IEEE LER shapes graph (spec/ler.model.ts), which the two documents cite at its version. */
export const LER_SHAPES_VERSION = '2026.10.0';

/** Interego substrate prefixes the two ontologies compose over. */
const PREFIXES: Record<string, string> = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dct: 'http://purl.org/dc/terms/',
  prov: 'http://www.w3.org/ns/prov#',
  vc: 'https://www.w3.org/2018/credentials#',
  iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
  amta: 'https://markjspivey-xwisee.github.io/interego/ns/amta#',
  hela: 'https://markjspivey-xwisee.github.io/interego/ns/hela#',
  ler: LER_NS,
  tla: TLA_NS,
};

// ── Term model ───────────────────────────────────────────────────────

export type Construction = 'minted' | 'composed' | 'view' | 'role' | 'concept';
export type TermKind = 'Class' | 'ObjectProperty' | 'DatatypeProperty' | 'Concept' | 'Collection';

export interface SemTerm {
  /** Which family this term belongs to. */
  family: 'ler' | 'tla';
  /** Local name (the fragment after `#`). */
  name: string;
  kind: TermKind;
  label: string;
  definition: string;
  /** Originating standard + section. */
  source: string;
  /** How this term relates to the substrate — the emergent-composable facet. */
  construction: Construction;
  subClassOf?: readonly string[];
  subPropertyOf?: readonly string[];
  /** One class, or several — written as their `owl:unionOf`. */
  domain?: string | readonly string[];
  /** One class or datatype, or several (an `owl:unionOf`). For a datatype property with `oneOf`,
   *  omit it: the range is the enumeration. */
  range?: string | readonly string[];
  /** A datatype property whose values are a closed list of strings: its range is
   *  `[ a rdfs:Datatype ; owl:oneOf ( … ) ]`. */
  oneOf?: readonly string[];
  /** Declared `owl:FunctionalProperty` — the subject has at most one value. */
  functional?: boolean;
  /** `skos:closeMatch` — an alignment to a term of ANOTHER standard (or of the sibling Foxxi
   *  ontology) that names a closely related notion. Never `owl:equivalentClass`: two independently
   *  maintained standards naming similar things does not make their instances interchangeable, and
   *  a reasoner would merge both class extensions on the strength of an editorial judgement. */
  closeMatch?: readonly string[];
  /** `skos:narrowMatch` — a term of another standard that names a kind of this one (an Open Badges
   *  credential is a kind of credential). */
  narrowMatch?: readonly string[];
  /** Substrate primitives a composed/view/role term emerges from. */
  constructedFrom?: readonly string[];
  /** owl:deprecated: kept so what cites it still resolves, and dct:isReplacedBy the term to use. */
  deprecated?: boolean;
  replacedBy?: string;
  /** What changed about the term, and in which version (skos:changeNote). */
  changeNote?: string;
}

// ── IEEE LER family ──────────────────────────────────────────────────

const LER_TERMS: readonly SemTerm[] = [
  // ── Competency core (minted — genuinely new vocabulary) ────────────
  {
    family: 'ler', name: 'CompetencyDefinition', kind: 'Class', construction: 'minted',
    label: 'Competency Definition',
    definition: 'A formal, context-neutral representation of one competency — a skill, knowledge, ability, attitude, habit of practice, or learning outcome — with a stable identity, a human-readable description, and optional structured statements.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions); IEEE 1484.20.1-2007 (Reusable Competency Definitions, now inactive-reserved)',
    subClassOf: ['skos:Concept'],
    // closeMatch, not exactMatch: skos:exactMatch is transitive, so asserting it to both CaSS and
    // CTDL-ASN would also assert that those two vocabularies' classes are interchangeable — a
    // claim neither publisher makes.
    closeMatch: ['tla:Competency', 'https://schema.cassproject.org/0.4/Competency', 'https://purl.org/ctdlasn/terms/Competency'],
  },
  {
    family: 'ler', name: 'CompetencyStatement', kind: 'Class', construction: 'minted',
    label: 'Competency Statement',
    definition: 'A single structured assertion within a competency definition — statement text, an optional controlled-vocabulary token, and an identifier. RCD\'s decomposition of a competency into its constituent claims.',
    source: 'IEEE 1484.20.1-2007 (Reusable Competency Definitions), definition statements',
  },
  {
    family: 'ler', name: 'CompetencyFramework', kind: 'Class', construction: 'minted',
    label: 'Competency Framework',
    definition: 'A structured collection of competency definitions and the typed relationships between them — a blueprint of excellent performance.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
    subClassOf: ['skos:ConceptScheme'],
    closeMatch: ['tla:CompetencyFramework'],
  },
  {
    family: 'ler', name: 'CompetencyRelationship', kind: 'Class', construction: 'minted',
    label: 'Competency Relationship',
    definition: 'A typed, directed edge between two competency definitions — for example narrows, broadens, requires, is-enabled-by, is-equivalent-to — reified so that the edge itself can carry a type and provenance.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
    closeMatch: ['tla:Relation'],
  },
  {
    family: 'ler', name: 'ProficiencyLevel', kind: 'Class', construction: 'minted',
    label: 'Proficiency Level',
    definition: 'An ordinal level of mastery a learner may attain on a competency — the scale an assertion is measured against.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions); CaSS schema 0.4 (Level)',
    closeMatch: ['tla:Level'],
  },
  {
    family: 'ler', name: 'Rubric', kind: 'Class', construction: 'minted',
    label: 'Rubric',
    definition: 'A structured set of evaluation criteria for assessing attainment of a competency.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
  },
  {
    family: 'ler', name: 'RubricCriterion', kind: 'Class', construction: 'minted',
    label: 'Rubric Criterion',
    definition: 'A single dimension being assessed within a rubric.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
  },

  // ── The Enterprise Learner Record — composed, not a content class ──
  {
    family: 'ler', name: 'EnterpriseLearnerRecord', kind: 'Class', construction: 'composed',
    label: 'Enterprise Learner Record',
    definition: 'The aggregate, enterprise-level record of one learner. The P2997 project describes it as a ledger or registry: it holds indications of where subordinate data lives, not the raw data. It therefore emerges as the union of its record entries, scoped to one learner and carrying provenance — not a monolithic class.',
    source: 'IEEE P2997 (Enterprise Learner Record) — an active standards project; this term follows its published scope, not a ratified text',
    subClassOf: ['iep:ComposedDescriptor', 'prov:Collection'],
    constructedFrom: ['ler:RecordEntry', 'iep:ProvenanceFacet', 'iep:AgentFacet'],
    closeMatch: ['tla:LearnerProfile'],
  },
  {
    family: 'ler', name: 'RecordEntry', kind: 'Class', construction: 'composed',
    label: 'Learner Record Entry',
    definition: 'A single record generated by one system about one learner with respect to one activity, linked to its performance evidence and aligned competency or credential. It IS an attestation — an agent asserting a claim about a learner — so it composes the substrate\'s attestation primitive rather than minting a new shape.',
    source: 'IEEE P2997 (Enterprise Learner Record); ADL ELRR conceptual data model',
    subClassOf: ['amta:Attestation'],
    constructedFrom: ['amta:Attestation', 'iep:ProvenanceFacet'],
  },
  {
    family: 'ler', name: 'LearnerProfile', kind: 'Class', construction: 'composed',
    label: 'Learner Profile',
    definition: 'A per-learner container assembling demographics, competency and credential history, aptitudes, preferences, goals and career trajectory. A view-bearing aggregation keyed by a resolved learner identity.',
    source: 'IEEE P2997 (Enterprise Learner Record); ADL TLA Learner Profile pillar',
    subClassOf: ['iep:ComposedDescriptor'],
    constructedFrom: ['ler:EnterpriseLearnerRecord', 'iep:AgentFacet'],
    closeMatch: ['tla:LearnerProfile'],
  },
  {
    family: 'ler', name: 'Transcript', kind: 'Class', construction: 'view',
    label: 'Transcript',
    definition: 'The learner\'s permanent academic record — courses, dates, grades, degrees. A projection (query view) over the verified record entries of an Enterprise Learner Record, optionally re-packaged as a Comprehensive Learner Record credential.',
    source: 'IEEE P2997 (Enterprise Learner Record); 1EdTech Comprehensive Learner Record 2.0',
    constructedFrom: ['ler:EnterpriseLearnerRecord', 'iep:CompositionOperator'],
    // closeMatch (NOT exactMatch): a Transcript is a PROJECTION over the ELR, closely related to
    // — but not identical with — a CLR 2.0 credential, so we do not assert strict identity.
    // Target the CANONICAL, dereferenceable 1EdTech vocab IRI (the /spec/clr/v2p0/ClrCredential
    // path 404s; the class IRI the CLR 2.0 JSON-LD context resolves to is vc/clr/vocab.html#…).
    closeMatch: ['https://purl.imsglobal.org/spec/vc/clr/vocab.html#ClrCredential'],
  },

  // ── Attestations + evidence (composed over the attestation primitive)
  {
    family: 'ler', name: 'CompetencyAssertion', kind: 'Class', construction: 'composed',
    label: 'Competency Assertion',
    definition: 'A claim, made by one party, that a learner can perform a competency at a stated proficiency level, with some confidence, backed by evidence. The same shape as a CaSS Assertion and a MOM `asserted` statement — one attestation primitive, three trust tiers.',
    source: 'IEEE P2997 (Enterprise Learner Record); ADL ELRR (Assertion)',
    subClassOf: ['amta:Attestation'],
    constructedFrom: ['amta:Attestation', 'iep:assertingAgent', 'iep:modalStatus'],
    closeMatch: ['tla:Assertion', 'https://schema.cassproject.org/0.4/Assertion'],
  },
  {
    family: 'ler', name: 'Evidence', kind: 'Class', construction: 'composed',
    label: 'Evidence',
    definition: 'Anything presented in support of an assertion of competency. Reuses the substrate\'s provenance entity — evidence is a prov:Entity that an assertion was derived from.',
    source: 'IEEE P2997 (Enterprise Learner Record); ADL ELRR (Evidence)',
    subClassOf: ['prov:Entity'],
    constructedFrom: ['prov:Entity', 'iep:provenanceChain'],
  },
  {
    family: 'ler', name: 'PerformanceRecord', kind: 'Class', construction: 'composed',
    label: 'Performance Record',
    definition: 'The record of a learner\'s performance that underpins a record entry: in practice an xAPI Statement held in an LRS, or a pointer to one. The RECORD is evidence (a prov:Entity); the performance it records is the activity the substrate models as a hela:Statement, so this class is built from that primitive rather than being one.',
    source: 'IEEE P2997 (Enterprise Learner Record), referencing IEEE 9274.1.1-2023 (xAPI 2.0)',
    subClassOf: ['ler:Evidence'],
    constructedFrom: ['hela:Statement', 'hela:Trace'],
  },
  {
    family: 'ler', name: 'Credential', kind: 'Class', construction: 'composed',
    label: 'Credential',
    definition: 'An attestation of qualification, competence or authority issued by an authority, expressed as a W3C Verifiable Credential whose subject carries one or more claims. Open Badges 3.0 and CLR 2.0 credentials are kinds of it.',
    source: 'IEEE 1484.2-2024 (Learning and Employment Record Ecosystems); W3C Verifiable Credentials Data Model 2.0',
    subClassOf: ['vc:VerifiableCredential', 'amta:Attestation'],
    constructedFrom: ['vc:VerifiableCredential', 'iep:verifiableCredential'],
    // narrowMatch: an Open Badges 3.0 credential and a CLR 2.0 credential are each a KIND of this
    // broader Credential, as its definition says — not the same notion (exactMatch), and more than
    // merely close (closeMatch, which said less than the definition). Targets are the canonical,
    // dereferenceable 1EdTech vocab IRIs the OB 3.0 and CLR 2.0 JSON-LD contexts resolve to.
    narrowMatch: ['https://purl.imsglobal.org/spec/vc/ob/vocab.html#OpenBadgeCredential', 'https://purl.imsglobal.org/spec/vc/clr/vocab.html#ClrCredential'],
    changeNote: '2026.10.0: Open Badges and CLR credentials are narrower matches (kinds of a Credential), where the Open Badges one had been a close match.',
  },
  {
    family: 'ler', name: 'Endorsement', kind: 'Class', construction: 'composed',
    label: 'Endorsement',
    definition: 'An attestation whose subject is itself another attestation, credential, or issuer — a party vouching for a claim or for a claimant. The attestation primitive applied reflexively.',
    source: 'IEEE P2997 (Enterprise Learner Record); 1EdTech Open Badges 3.0 (EndorsementCredential)',
    subClassOf: ['amta:Attestation'],
    constructedFrom: ['amta:Attestation'],
  },
  {
    family: 'ler', name: 'Accreditation', kind: 'Class', construction: 'composed',
    label: 'Accreditation',
    definition: 'Official certification that a learning activity or learning source is acceptable for a specific purpose. An attestation about a course or a source.',
    source: 'ADL ELRR (Accreditation)',
    subClassOf: ['amta:Attestation'],
    constructedFrom: ['amta:Attestation'],
  },

  // ── Identity binding (a composition over sameAs/provenance) ────────
  {
    family: 'ler', name: 'LearnerIdentityBinding', kind: 'Class', construction: 'composed',
    label: 'Learner Identity Binding',
    definition: 'The resolution of a learner\'s many local account names and UUIDs across systems to one enterprise identity. Not a content class — a set of identity-equivalence assertions with provenance.',
    source: 'ADL ELRR (federated identity management)',
    constructedFrom: ['iep:AgentFacet', 'iep:provenanceChain'],
  },
  {
    family: 'ler', name: 'RawDataLocation', kind: 'Class', construction: 'minted',
    label: 'Raw Data Location',
    definition: 'An indication of where one class of the raw data behind an Enterprise Learner Record is kept — the subject\'s own pod, an LRS, a credential descriptor — so a reader can go to the source instead of trusting the summary.',
    source: 'IEEE P2997 (Enterprise Learner Record: raw data location)',
  },

  // ── Roles (a generic Agent in a role — not a subclass of Person) ───
  {
    family: 'ler', name: 'Learner', kind: 'Class', construction: 'role',
    label: 'Learner',
    definition: 'The natural person who is the subject of a learner record and, in the LER ecosystem, curates and controls access to it. A role a prov:Agent plays — the same person is an Issuer in another record.',
    source: 'IEEE P2997 (Enterprise Learner Record); IEEE 1484.2-2024 (Learning and Employment Record Ecosystems)',
    subClassOf: ['prov:Agent'],
    constructedFrom: ['prov:Agent', 'iep:agentRole'],
  },
  {
    family: 'ler', name: 'Issuer', kind: 'Class', construction: 'role',
    label: 'Issuer',
    definition: 'The authority — an education, training, work-based provider or evaluator — that confers a credential or makes an assertion about a learner. A role of a prov:Agent.',
    source: 'IEEE 1484.2-2024 (Learning and Employment Record Ecosystems); W3C Verifiable Credentials Data Model 2.0 (issuer)',
    subClassOf: ['prov:Agent'],
    constructedFrom: ['prov:Agent', 'iep:agentRole'],
  },
  {
    family: 'ler', name: 'Endorser', kind: 'Class', construction: 'role',
    label: 'Endorser',
    definition: 'A party that vouches for an issuer or for a credential. A role of a prov:Agent.',
    source: 'IEEE 1484.2-2024 (Learning and Employment Record Ecosystems); 1EdTech Open Badges 3.0 (endorsement)',
    subClassOf: ['prov:Agent'],
    constructedFrom: ['prov:Agent', 'iep:agentRole'],
  },
  {
    family: 'ler', name: 'Verifier', kind: 'Class', construction: 'role',
    label: 'Verifier',
    definition: 'A party — typically an employer — to whom a learner presents records for review. A role of a prov:Agent.',
    source: 'IEEE 1484.2-2024 (Learning and Employment Record Ecosystems); W3C Verifiable Credentials Data Model 2.0 (verifier)',
    subClassOf: ['prov:Agent'],
    constructedFrom: ['prov:Agent', 'iep:agentRole'],
  },
  {
    family: 'ler', name: 'LearningSource', kind: 'Class', construction: 'role',
    label: 'Learning Source',
    definition: 'Any source that provides a learning activity and supplies evidence and assertions about it. A role of a prov:Agent / organization.',
    source: 'ADL ELRR (Learning Source)',
    subClassOf: ['prov:Agent'],
    constructedFrom: ['prov:Agent', 'iep:agentRole'],
  },

  // ── Object properties ──────────────────────────────────────────────
  {
    family: 'ler', name: 'recordEntry', kind: 'ObjectProperty', construction: 'minted',
    label: 'record entry',
    definition: 'Relates an Enterprise Learner Record to one of the entries it aggregates.',
    source: 'IEEE P2997 (Enterprise Learner Record)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'ler:RecordEntry',
    subPropertyOf: ['prov:hadMember'],
  },
  {
    family: 'ler', name: 'holder', kind: 'ObjectProperty', construction: 'minted',
    label: 'holder',
    definition: 'Relates an Enterprise Learner Record or a credential to the Learner it is about. Deprecated: the name reads as a Verifiable Credential\'s holder, a different relation (who presents a credential, not whom it is about); about learner replaces it.',
    deprecated: true, replacedBy: 'ler:aboutLearner',
    // Kept with the axioms it was published with (its range alone), so data written with it means
    // what it meant; about learner carries the domain and the functional characteristic.
    changeNote: '2026.10.0: deprecated in favour of about learner; kept with the axioms it was published with.',
    source: 'IEEE P2997 (Enterprise Learner Record); IEEE 1484.2-2024 (Learning and Employment Record Ecosystems)',
    range: 'ler:Learner',
  },
  {
    family: 'ler', name: 'aboutLearner', kind: 'ObjectProperty', construction: 'minted',
    label: 'about learner',
    definition: 'Relates an Enterprise Learner Record or a credential to the one Learner it is about — its subject, not whoever holds or presents it.',
    source: 'IEEE P2997 (Enterprise Learner Record); IEEE 1484.2-2024 (Learning and Employment Record Ecosystems)',
    domain: ['ler:EnterpriseLearnerRecord', 'ler:Credential'], range: 'ler:Learner',
    functional: true,
  },
  {
    family: 'ler', name: 'aboutCompetency', kind: 'ObjectProperty', construction: 'minted',
    label: 'about competency',
    definition: 'Relates a competency assertion to the one competency definition it claims mastery of.',
    source: 'IEEE P2997 (Enterprise Learner Record); ADL ELRR (Assertion)',
    domain: 'ler:CompetencyAssertion', range: 'ler:CompetencyDefinition',
    functional: true,
  },
  {
    family: 'ler', name: 'atProficiency', kind: 'ObjectProperty', construction: 'minted',
    label: 'at proficiency',
    definition: 'Relates a competency assertion to the one proficiency level it claims.',
    source: 'ADL ELRR (Proficiency)',
    domain: 'ler:CompetencyAssertion', range: 'ler:ProficiencyLevel',
    functional: true,
  },
  {
    family: 'ler', name: 'supportedByEvidence', kind: 'ObjectProperty', construction: 'minted',
    label: 'supported by evidence',
    definition: 'Relates an assertion or record entry to the evidence presented in support of it.',
    source: 'IEEE P2997 (Enterprise Learner Record); ADL ELRR (Evidence)',
    domain: ['ler:CompetencyAssertion', 'ler:RecordEntry'], range: 'ler:Evidence',
    subPropertyOf: ['prov:wasDerivedFrom'],
  },
  {
    family: 'ler', name: 'issuedBy', kind: 'ObjectProperty', construction: 'minted',
    label: 'issued by',
    definition: 'Relates a credential or assertion to the Issuer that conferred it.',
    source: 'IEEE 1484.2-2024 (Learning and Employment Record Ecosystems); W3C Verifiable Credentials Data Model 2.0 (issuer)',
    domain: ['ler:Credential', 'ler:CompetencyAssertion'], range: 'ler:Issuer',
    subPropertyOf: ['prov:wasAttributedTo'],
  },
  {
    family: 'ler', name: 'frameworkMember', kind: 'ObjectProperty', construction: 'minted',
    label: 'framework member',
    definition: 'Relates a competency framework to a competency definition it contains.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
    domain: 'ler:CompetencyFramework', range: 'ler:CompetencyDefinition',
  },
  {
    family: 'ler', name: 'hasStatement', kind: 'ObjectProperty', construction: 'minted',
    label: 'has statement',
    definition: 'Relates a competency definition to one of the structured statements it is decomposed into.',
    source: 'IEEE 1484.20.1-2007 (Reusable Competency Definitions), definition statements',
    domain: 'ler:CompetencyDefinition', range: 'ler:CompetencyStatement',
  },
  {
    family: 'ler', name: 'fromCompetency', kind: 'ObjectProperty', construction: 'minted',
    label: 'from competency',
    definition: 'Relates a competency relationship to the competency definition at which the directed edge starts.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
    domain: 'ler:CompetencyRelationship', range: 'ler:CompetencyDefinition',
    functional: true,
  },
  {
    family: 'ler', name: 'toCompetency', kind: 'ObjectProperty', construction: 'minted',
    label: 'to competency',
    definition: 'Relates a competency relationship to the competency definition at which the directed edge ends.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
    domain: 'ler:CompetencyRelationship', range: 'ler:CompetencyDefinition',
    functional: true,
  },
  {
    family: 'ler', name: 'hasCriterion', kind: 'ObjectProperty', construction: 'minted',
    label: 'has criterion',
    definition: 'Relates a rubric to one of the criteria it assesses.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
    domain: 'ler:Rubric', range: 'ler:RubricCriterion',
  },
  {
    family: 'ler', name: 'criterionFor', kind: 'ObjectProperty', construction: 'minted',
    label: 'criterion for',
    definition: 'Relates a rubric criterion to the competency definition whose attainment it assesses.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
    domain: 'ler:RubricCriterion', range: 'ler:CompetencyDefinition',
  },
  {
    family: 'ler', name: 'criterionLevel', kind: 'ObjectProperty', construction: 'minted',
    label: 'criterion level',
    definition: 'Relates a rubric criterion to a proficiency level it distinguishes.',
    source: 'IEEE 1484.20.3-2022 (Shareable Competency Definitions)',
    domain: 'ler:RubricCriterion', range: 'ler:ProficiencyLevel',
  },
  {
    family: 'ler', name: 'bindsLearner', kind: 'ObjectProperty', construction: 'minted',
    label: 'binds learner',
    definition: 'Relates a learner identity binding to the one learner whose local identities it resolves.',
    source: 'ADL ELRR (federated identity management)',
    domain: 'ler:LearnerIdentityBinding', range: 'ler:Learner',
    functional: true,
  },
  {
    family: 'ler', name: 'transcriptOf', kind: 'ObjectProperty', construction: 'minted',
    label: 'transcript of',
    definition: 'Relates a transcript to the one Enterprise Learner Record it is a projection of.',
    source: 'IEEE P2997 (Enterprise Learner Record)',
    domain: 'ler:Transcript', range: 'ler:EnterpriseLearnerRecord',
    functional: true,
  },
  {
    family: 'ler', name: 'accredits', kind: 'ObjectProperty', construction: 'minted',
    label: 'accredits',
    definition: 'Relates an accreditation to what it certifies as acceptable: a learning source, or a learning activity (identified by its metadata descriptor).',
    source: 'ADL ELRR (Accreditation)',
    domain: 'ler:Accreditation', range: ['ler:LearningSource', 'tla:LearningActivityMetadata'],
  },
  {
    family: 'ler', name: 'endorses', kind: 'ObjectProperty', construction: 'minted',
    label: 'endorses',
    definition: 'Relates an endorsement to what it vouches for: another attestation (a credential or an assertion) or an issuer.',
    source: '1EdTech Open Badges 3.0 (EndorsementCredential)',
    domain: 'ler:Endorsement', range: ['amta:Attestation', 'ler:Issuer'],
  },
  {
    family: 'ler', name: 'endorser', kind: 'ObjectProperty', construction: 'minted',
    label: 'endorsed by',
    definition: 'Relates an endorsement to the party that makes it.',
    source: '1EdTech Open Badges 3.0 (EndorsementCredential)',
    domain: 'ler:Endorsement', range: 'ler:Endorser',
    subPropertyOf: ['prov:wasAttributedTo'],
  },
  {
    family: 'ler', name: 'recordStatus', kind: 'DatatypeProperty', construction: 'minted',
    label: 'record status',
    definition: 'The status of a learner record entry within the ledger — exactly one of success, partial, failure.',
    source: 'ADL ELRR (Status)',
    domain: 'ler:RecordEntry', oneOf: ['success', 'partial', 'failure'],
    functional: true,
  },

  // ── The Enterprise Learner Record as Foxxi assembles it ────────────
  // What the ELR's JSON-LD context (ELR_CONTEXT_URL) maps its fields to, and what the published
  // EnterpriseLearnerRecordShape and CompetencyAssertionShape constrain.
  {
    family: 'ler', name: 'subjectKind', kind: 'DatatypeProperty', construction: 'minted',
    label: 'subject kind',
    definition: 'Whether the subject of an Enterprise Learner Record is a human learner or performer, or an AI agent. The record has the same shape either way.',
    source: 'Foxxi extension to IEEE P2997 (whose records describe people)',
    domain: 'ler:EnterpriseLearnerRecord', oneOf: ['human', 'agent'],
    functional: true,
  },
  {
    family: 'ler', name: 'organizationPath', kind: 'ObjectProperty', construction: 'minted',
    label: 'organization path',
    definition: 'Relates an Enterprise Learner Record to a step on its organisation path: an organisation or system — one that issued a credential in it, holds an LRS it draws on, or is the tenant it was assembled for — in the role it plays for this record, at its place on the path.',
    source: 'IEEE P2997 (Enterprise Learner Record: organisation path)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'ler:OrganizationPathStep',
  },
  {
    family: 'ler', name: 'OrganizationPathStep', kind: 'Class', construction: 'minted',
    label: 'Organization Path Step',
    definition: 'One step of an Enterprise Learner Record\'s organisation path: which organisation or system, the role it plays for this record, and its place on the path. A node of its own, because the role belongs to the step, not to the organisation: the tenant of one record is the issuer in another.',
    source: 'IEEE P2997 (Enterprise Learner Record: organisation path); W3C Defining N-ary Relations on the Semantic Web (pattern 1)',
  },
  {
    family: 'ler', name: 'pathOrganization', kind: 'ObjectProperty', construction: 'minted',
    label: 'path organization',
    definition: 'The organisation or system at a step of an organisation path, identified by its DID or URL.',
    source: 'IEEE P2997 (Enterprise Learner Record: organisation path)',
    domain: 'ler:OrganizationPathStep', range: 'prov:Agent',
    functional: true,
  },
  {
    family: 'ler', name: 'pathRole', kind: 'DatatypeProperty', construction: 'minted',
    label: 'path role',
    definition: 'The role the organisation or system at a step of an organisation path plays for the record: the tenant it was assembled for, the authority of an LRS it draws on, the issuer of a credential in it.',
    source: 'IEEE P2997 (Enterprise Learner Record: organisation path)',
    domain: 'ler:OrganizationPathStep', range: 'xsd:string',
    functional: true,
  },
  {
    family: 'ler', name: 'pathPosition', kind: 'DatatypeProperty', construction: 'minted',
    label: 'path position',
    definition: 'The place of a step on its organisation path, counting from 1: the order the path is listed in, which RDF keeps no other way.',
    source: 'IEEE P2997 (Enterprise Learner Record: organisation path)',
    domain: 'ler:OrganizationPathStep', range: 'xsd:positiveInteger',
    functional: true,
  },
  {
    family: 'ler', name: 'rawDataLocation', kind: 'ObjectProperty', construction: 'minted',
    label: 'raw data location',
    definition: 'Relates an Enterprise Learner Record to an indication of where one class of its raw data is kept.',
    source: 'IEEE P2997 (Enterprise Learner Record: raw data location)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'ler:RawDataLocation',
  },
  {
    family: 'ler', name: 'rawDataKind', kind: 'DatatypeProperty', construction: 'minted',
    label: 'raw data kind',
    definition: 'Which class of raw data a location holds: the subject\'s own pod, an LRS, or a credential descriptor.',
    source: 'IEEE P2997 (Enterprise Learner Record: raw data location)',
    domain: 'ler:RawDataLocation', oneOf: ['subject-pod', 'lrs', 'credential-descriptor'],
    functional: true,
  },
  {
    family: 'ler', name: 'dataLocation', kind: 'DatatypeProperty', construction: 'minted',
    label: 'data location',
    definition: 'The URL where a class of raw data, or the raw record behind an entry, is kept.',
    source: 'IEEE P2997 (Enterprise Learner Record: raw data location)',
    domain: ['ler:RawDataLocation', 'ler:RecordEntry'], range: 'xsd:anyURI',
    functional: true,
  },
  {
    family: 'ler', name: 'hasAssertion', kind: 'ObjectProperty', construction: 'minted',
    label: 'has assertion',
    definition: 'Relates an Enterprise Learner Record to a competency assertion it carries about its subject.',
    source: 'IEEE P2997 (Enterprise Learner Record: competencies)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'ler:CompetencyAssertion',
  },
  {
    family: 'ler', name: 'assertionSubject', kind: 'ObjectProperty', construction: 'minted',
    label: 'assertion subject',
    definition: 'Relates a competency assertion to the one person or agent it is about — who need not be the agent making it.',
    source: 'IEEE P2997 (Enterprise Learner Record); ADL ELRR (Assertion)',
    domain: 'ler:CompetencyAssertion', range: 'prov:Agent',
    functional: true,
  },
  {
    family: 'ler', name: 'successConfidence', kind: 'DatatypeProperty', construction: 'minted',
    label: 'success confidence',
    definition: 'How confident the asserting party is that the subject succeeds at the competency: a number from 0 to 1, in Foxxi the Wilson lower bound on the observed success rate. A decimal, or a double, which is what JSON-LD makes of a JSON number.',
    source: 'ADL ELRR (Assertion: confidence); CaSS schema 0.4 (Assertion: confidence)',
    domain: 'ler:CompetencyAssertion', range: ['xsd:decimal', 'xsd:double'],
    functional: true,
    closeMatch: ['tla:confidence'],
  },
  {
    family: 'ler', name: 'rolledUpBy', kind: 'ObjectProperty', construction: 'minted',
    label: 'rolled up by',
    definition: 'Relates a competency assertion to the published roll-up rule whose evaluation produced its proficiency level and confidence.',
    source: 'CaSS schema 0.4 (RollupRule); ADL TLA (competency roll-up)',
    domain: 'ler:CompetencyAssertion', range: 'tla:RollupRule',
    functional: true,
  },
  {
    family: 'ler', name: 'evidenceBasis', kind: 'DatatypeProperty', construction: 'minted',
    label: 'evidence basis',
    definition: 'The strongest class of evidence a competency assertion rests on: observed performance, a held credential, or inference from learning experiences.',
    source: 'Foxxi (the three evidence classes an Enterprise Learner Record ranks)',
    domain: 'ler:CompetencyAssertion', oneOf: ['performance', 'credential', 'inferred'],
    functional: true,
  },
  // ── What a record entry says about the statement it was projected from ──
  // An entry is not the xAPI statement: it is a claim the record makes about one, so it has its own
  // terms. With the xAPI ontology's verb and timestamp, whose domain is a Statement, every entry
  // read as an xAPI Statement — and the xAPI shapes, which select what has a verb, took it for one
  // with no actor and no object.
  {
    family: 'ler', name: 'aboutActivity', kind: 'ObjectProperty', construction: 'minted',
    label: 'about activity',
    definition: 'Relates a record entry to the learning or work activity it is about — the object of the statement it was projected from — identified by an IRI.',
    source: 'IEEE P2997 (Enterprise Learner Record); IEEE 9274.1.1-2023 (xAPI 2.0) §5.2.2.3',
    domain: 'ler:RecordEntry',
    functional: true,
  },
  {
    family: 'ler', name: 'activityType', kind: 'ObjectProperty', construction: 'minted',
    label: 'activity type',
    definition: 'Relates a record entry to the type of the activity it is about (the activity\'s xAPI activity type).',
    source: 'IEEE 9274.1.1-2023 (xAPI 2.0) §5.2.2.3 (Activity Definition: type)',
    domain: 'ler:RecordEntry',
  },
  {
    family: 'ler', name: 'entryVerb', kind: 'ObjectProperty', construction: 'minted',
    label: 'entry verb',
    definition: 'Relates a record entry to the xAPI verb of the statement it was projected from, identified by the verb\'s IRI.',
    source: 'IEEE 9274.1.1-2023 (xAPI 2.0) §5.2.2.2',
    domain: 'ler:RecordEntry',
    functional: true,
  },
  {
    family: 'ler', name: 'occurredAt', kind: 'DatatypeProperty', construction: 'minted',
    label: 'occurred at',
    definition: 'When what a record entry records happened: the timestamp of the statement it was projected from.',
    source: 'IEEE 9274.1.1-2023 (xAPI 2.0) §5.2.7 (Timestamps)',
    domain: 'ler:RecordEntry', range: 'xsd:dateTime',
    functional: true,
  },
  {
    family: 'ler', name: 'succeeded', kind: 'DatatypeProperty', construction: 'minted',
    label: 'succeeded',
    definition: 'Whether the performance a record entry records succeeded: the result.success of the statement it was projected from.',
    source: 'IEEE 9274.1.1-2023 (xAPI 2.0) §5.2.2.4 (Result: success)',
    domain: 'ler:RecordEntry', range: 'xsd:boolean',
    functional: true,
  },
  // ── The rest of what a Foxxi Enterprise Learner Record says: every field that states a fact has
  // a term (the record's context maps each), so nothing in a record is left to VC 2.0's
  // undefined-terms context. Names given beside an IRI are for a reader that does not dereference it.
  {
    family: 'ler', name: 'conformsToLabel', kind: 'DatatypeProperty', construction: 'minted',
    label: 'conforms-to label',
    definition: 'The title of the standard an Enterprise Learner Record conforms to (its dct:conformsTo), given for a reader that does not dereference that IRI.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'xsd:string',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'hasCredential', kind: 'ObjectProperty', construction: 'minted',
    label: 'has credential',
    definition: 'Relates an Enterprise Learner Record to a credential conferred on its learner that the record lists. The credential itself is where its raw data location says.',
    source: 'IEEE P2997 (Enterprise Learner Record: credentials held, by indication of where they are stored)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'ler:Credential',
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'achievementName', kind: 'DatatypeProperty', construction: 'minted',
    label: 'achievement name',
    definition: 'The name of the achievement a credential confers, as the credential gives it.',
    source: '1EdTech Open Badges 3.0 (Achievement: name), as a record lists the credential',
    domain: 'ler:Credential', range: 'xsd:string',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'proofVerified', kind: 'DatatypeProperty', construction: 'minted',
    label: 'proof verified',
    definition: 'Whether the proof of a credential a record lists verified when the record was assembled.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:Credential', range: 'xsd:boolean',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'verbDisplay', kind: 'DatatypeProperty', construction: 'minted',
    label: 'verb display',
    definition: 'How the statement a record entry was projected from displays its verb, in one language.',
    source: 'IEEE 9274.1.1-2023 (xAPI 2.0) §5.2.2.2 (Verb: display), as a record entry carries it',
    domain: 'ler:RecordEntry', range: 'xsd:string',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'activityName', kind: 'DatatypeProperty', construction: 'minted',
    label: 'activity name',
    definition: 'The name of the activity or task a record entry is about, as its statement names it.',
    source: 'IEEE 9274.1.1-2023 (xAPI 2.0) §5.2.2.3 (Activity Definition: name), as a record entry carries it',
    domain: 'ler:RecordEntry', range: 'xsd:string',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'outcomeQuality', kind: 'DatatypeProperty', construction: 'minted',
    label: 'outcome quality',
    definition: 'The quality of the outcome of the work a record entry records: the scaled score of its statement, from -1 to 1. A decimal, or a double, which is what JSON-LD makes of a JSON number.',
    source: 'IEEE 9274.1.1-2023 (xAPI 2.0) §5.2.2.4 (Score: scaled), as a record entry carries it',
    domain: 'ler:RecordEntry', range: ['xsd:decimal', 'xsd:double'],
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'duration', kind: 'DatatypeProperty', construction: 'minted',
    label: 'duration',
    definition: 'How long the work a record entry records took: an ISO 8601 duration, as its statement\'s result gives it.',
    source: 'IEEE 9274.1.1-2023 (xAPI 2.0) §5.2.2.4 (Result: duration), as a record entry carries it',
    domain: 'ler:RecordEntry', range: 'xsd:string',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'costUSD', kind: 'DatatypeProperty', construction: 'minted',
    label: 'cost in US dollars',
    definition: 'What the work a record entry records cost, in US dollars, as its statement reports it. A decimal, or a double.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:RecordEntry', range: ['xsd:decimal', 'xsd:double'],
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'competencyLabel', kind: 'DatatypeProperty', construction: 'minted',
    label: 'competency label',
    definition: 'The name of the competency a competency assertion is about (ler:aboutCompetency), given for a reader that does not dereference it.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:CompetencyAssertion', range: 'xsd:string',
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'frameworkName', kind: 'DatatypeProperty', construction: 'minted',
    label: 'framework name',
    definition: 'The name of the competency framework the competency of an assertion belongs to, as the credential that aligns it names it.',
    source: '1EdTech Open Badges 3.0 (Alignment: targetFramework), as an assertion carries it',
    domain: 'ler:CompetencyAssertion', range: 'xsd:string',
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'proficiencyLabel', kind: 'DatatypeProperty', construction: 'minted',
    label: 'proficiency label',
    definition: 'The name of the proficiency level a competency assertion places its subject at (ler:atProficiency), given for a reader that does not dereference it.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:CompetencyAssertion', range: 'xsd:string',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'proficiencyRank', kind: 'DatatypeProperty', construction: 'minted',
    label: 'proficiency rank',
    definition: 'The rank of that proficiency level on its scale: 1 for the lowest.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:CompetencyAssertion', range: 'xsd:positiveInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'trainingCompletionCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'training completion count',
    definition: 'How many training completions a competency assertion rests on.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:CompetencyAssertion', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'performanceExecutionCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'performance execution count',
    definition: 'How many distinct tasks performed a competency assertion rests on.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:CompetencyAssertion', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'performanceSuccessRate', kind: 'DatatypeProperty', construction: 'minted',
    label: 'performance success rate',
    definition: 'The share of performances that asserted an outcome and succeeded, from 0 to 1: of all a record lists, or of those a competency assertion rests on. A decimal, or a double.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: ['ler:EnterpriseLearnerRecord', 'ler:CompetencyAssertion'], range: ['xsd:decimal', 'xsd:double'],
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'performanceMeanQuality', kind: 'DatatypeProperty', construction: 'minted',
    label: 'performance mean quality',
    definition: 'The mean quality of the outcomes of the performances a competency assertion rests on, where they were scored. A decimal, or a double.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:CompetencyAssertion', range: ['xsd:decimal', 'xsd:double'],
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'supersessionNote', kind: 'DatatypeProperty', construction: 'minted',
    label: 'supersession note',
    definition: 'Why a competency assertion replaces a weaker one made before it about the same competency, in words: performance evidence superseding an inference from training, say.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:CompetencyAssertion', range: 'xsd:string',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'experienceCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'experience count',
    definition: 'How many learning experiences an Enterprise Learner Record lists.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'performanceCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'performance count',
    definition: 'How many performance records an Enterprise Learner Record lists.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'credentialCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'credential count',
    definition: 'How many credentials an Enterprise Learner Record lists.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'verifiedCredentialCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'verified credential count',
    definition: 'How many of the credentials an Enterprise Learner Record lists had a proof that verified when it was assembled.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'competencyCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'competency count',
    definition: 'How many competency assertions an Enterprise Learner Record makes.',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'assertedCompetencyCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'asserted competency count',
    definition: 'How many of a record\'s competency assertions are asserted (iep:Asserted).',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'inferredCompetencyCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'inferred competency count',
    definition: 'How many of a record\'s competency assertions are hypothetical, inferred from learning experiences (iep:Hypothetical).',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
  {
    family: 'ler', name: 'performanceVerifiedCompetencyCount', kind: 'DatatypeProperty', construction: 'minted',
    label: 'performance-verified competency count',
    definition: 'How many of a record\'s competency assertions rest on observed performance (their evidence basis is performance).',
    source: 'Foxxi (the Enterprise Learner Record it assembles)',
    domain: 'ler:EnterpriseLearnerRecord', range: 'xsd:nonNegativeInteger',
    functional: true,
    changeNote: '2026.10.0: new, for a field of the record that had no term.',
  },
];

/** The JSON-LD context of a Foxxi Enterprise Learner Record, used after the W3C VC 2.0 context —
 *  at the version of the vocabulary it maps a record into. A record cites its context by URL, and
 *  what the record means must not change under it, so each version has its own context, which
 *  never changes; /ns/ieee-ler/context answers with the current one. */
export const ELR_CONTEXT_URL = `${LER_DOC}/context/${LER_VERSION}`;

/**
 * The JSON-LD 1.1 context that gives a Foxxi Enterprise Learner Record its RDF reading.
 *
 * ★ AN ELR IS JSON-LD, SO ITS CONTEXT MUST BE ONE. The record used to list the IEEE P2997 web page
 * as its second context; a JSON-LD processor fetches that, finds HTML, and stops, so no RDF reading
 * of any record existed and the shapes published for records constrained data nothing could
 * produce. This context maps the record's fields to this vocabulary (and to dct:, prov: and iep:
 * where those already name the thing) and is listed after the W3C VC 2.0
 * context, whose protected terms (id, type, name, description) it leaves alone — except inside a
 * competency assertion, where `id` names the competency and `assertionId` the assertion node (a
 * property-scoped context may do that; JSON-LD 1.1 §4.1.11).
 *
 * ★ EVERY FIELD HAS A TERM. Who the record is about, the organisations on its path, each entry's
 * activity, verb, time, outcome, quality, duration, cost and observer, each assertion's competency,
 * level, confidence, rule, agent, evidence and the figures it rests on, the credentials the record
 * lists, the record's summary counts, and where the raw data is kept: each is read into this
 * vocabulary (or into rdfs:, dct:, prov: and iep: where those already name the thing), an IRI as an
 * IRI. A review found the record's activity and task IRIs, an assertion's type and a performance's
 * success read as issuer-dependent terms (strings, for the IRIs), and an entry's verb and time read
 * with the xAPI ontology's terms — whose domain made every entry an xAPI Statement, and every entry
 * a Statement the xAPI shapes refused. A second review found the display names, the evidence
 * figures, the summary counts and every field of a listed credential still left to VC 2.0's
 * undefined-terms context; a name given beside an IRI, a count and an issuer are facts, so each has
 * a term now. The undefined-terms context stays last in a record's @context (VC 2.0 §5.2), for a
 * field a later version adds before its context does; a record this code writes leaves nothing to it.
 * `summary` and an assertion's `evidenceSummary` are nests (@nest): their figures are said of the
 * record, and of the assertion.
 *
 * ★ AN ORGANISATION PATH IS A LIST OF STEPS. Each step is a node of its own (ler:OrganizationPathStep,
 * the W3C n-ary relation pattern): its `id` names the organisation (ler:pathOrganization), and its
 * role and position belong to the step. Read the other way — `id` as the step's own IRI — a role
 * became a claim about the organisation's DID everywhere ("did:web:tenant is a tenant"), and the
 * order of the path was lost.
 *
 * ★ AN ENTRY'S `id` IS ITS STATEMENT'S UUID, NOT AN IRI. Each experience and performance record
 * carries the id of the xAPI statement it was projected from — a bare UUID, which JSON-LD reads as
 * a relative IRI reference (a verifier in safe mode refuses the record; one that is not resolves it
 * against wherever the record was fetched from). Inside those two lists `id` is the entry's
 * dct:identifier, a literal, and the entry is a node of its own. And the links projection the
 * bridge serves by default replaces the two lists with hydra:Collection references, so `hydra:`
 * is Hydra's namespace here rather than an unknown IRI scheme.
 */
/** The context as it is served and archived: indented JSON, one trailing newline. */
export const renderElrContext = (): string => `${JSON.stringify(elrJsonLdContext(), null, 2)}\n`;

export function elrJsonLdContext(): Record<string, unknown> {
  /** A record entry (an experience or a performance record): what it says about the statement it was
   *  projected from. `id` is that statement's UUID — a literal (above). */
  const entry = {
    id: 'dct:identifier',
    verb: { '@id': 'ler:entryVerb', '@type': '@id' },
    timestamp: { '@id': 'ler:occurredAt', '@type': 'xsd:dateTime' },
    activityId: { '@id': 'ler:aboutActivity', '@type': '@id' },
    taskId: { '@id': 'ler:aboutActivity', '@type': '@id' },
    taskType: { '@id': 'ler:activityType', '@type': '@id' },
    success: 'ler:succeeded',
    verbDisplay: 'ler:verbDisplay',
    activityName: 'ler:activityName',
    taskName: 'ler:activityName',
    quality: 'ler:outcomeQuality',
    durationIso: 'ler:duration',
    costUsd: 'ler:costUSD',
    observedBy: { '@id': 'prov:wasAttributedTo', '@type': '@id' },
  };
  return {
    '@context': {
      '@version': 1.1,
      '@protected': true,
      ler: LER_NS, tla: TLA_NS,
      iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
      prov: 'http://www.w3.org/ns/prov#', dct: 'http://purl.org/dc/terms/',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      xsd: 'http://www.w3.org/2001/XMLSchema#', hydra: 'http://www.w3.org/ns/hydra/core#',
      EnterpriseLearnerRecord: 'ler:EnterpriseLearnerRecord',
      CompetencyAssertion: 'ler:CompetencyAssertion',
      Asserted: 'iep:Asserted',
      Hypothetical: 'iep:Hypothetical',
      conformsTo: { '@id': 'dct:conformsTo', '@type': '@id' },
      conformsToLabel: 'ler:conformsToLabel',
      // prov:generatedAtTime, not dct:created: the Foxxi documents use dct:created as an annotation
      // property in their headers, and OWL 2 DL cannot read one IRI as two kinds of property.
      assembledAt: { '@id': 'prov:generatedAtTime', '@type': 'xsd:dateTime' },
      subjectKind: 'ler:subjectKind',
      learner: { '@id': 'ler:aboutLearner', '@context': { did: '@id' } },
      organizationPath: {
        '@id': 'ler:organizationPath', '@container': '@set',
        '@context': {
          id: { '@id': 'ler:pathOrganization', '@type': '@id' },
          role: 'ler:pathRole',
          position: { '@id': 'ler:pathPosition', '@type': 'xsd:positiveInteger' },
        },
      },
      provenance: '@nest',
      rawDataLocations: {
        '@id': 'ler:rawDataLocation', '@nest': 'provenance', '@container': '@set',
        '@context': { kind: 'ler:rawDataKind', location: { '@id': 'ler:dataLocation', '@type': 'xsd:anyURI' } },
      },
      experiences: { '@id': 'ler:recordEntry', '@container': '@set', '@context': entry },
      performanceRecords: { '@id': 'ler:recordEntry', '@container': '@set', '@context': entry },
      rawDataLocation: { '@id': 'ler:dataLocation', '@type': 'xsd:anyURI' },
      modalStatus: { '@id': 'iep:modalStatus', '@type': '@vocab' },
      // The credentials a record lists, each by its id: its issuer (an IRI), the name of the
      // achievement it confers, and whether its proof verified when the record was assembled.
      credentials: {
        '@id': 'ler:hasCredential', '@container': '@set',
        '@context': {
          issuer: { '@id': 'ler:issuedBy', '@type': '@id' },
          achievementName: 'ler:achievementName',
          verified: 'ler:proofVerified',
        },
      },
      // The summary's figures are said of the record itself.
      summary: '@nest',
      experienceCount: 'ler:experienceCount',
      performanceCount: 'ler:performanceCount',
      performanceSuccessRate: 'ler:performanceSuccessRate',
      credentialCount: 'ler:credentialCount',
      verifiedCredentialCount: 'ler:verifiedCredentialCount',
      competencyCount: 'ler:competencyCount',
      assertedCompetencies: 'ler:assertedCompetencyCount',
      inferredCompetencies: 'ler:inferredCompetencyCount',
      performanceVerifiedCompetencies: 'ler:performanceVerifiedCompetencyCount',
      competencies: {
        '@id': 'ler:hasAssertion', '@container': '@set',
        '@context': {
          assertionId: '@id',
          // The assertion's type again, for readers of the JSON that do not read @type: the same
          // rdf:type triple. (An alias of @type would collide with the @type the entry also has.)
          assertionType: { '@id': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', '@type': '@id' },
          id: { '@id': 'ler:aboutCompetency', '@type': '@id' },
          aboutCompetency: { '@id': 'ler:aboutCompetency', '@type': '@id' },
          subject: { '@id': 'ler:assertionSubject', '@type': '@id' },
          proficiencyLevel: { '@id': 'ler:atProficiency', '@type': '@id' },
          confidence: 'ler:successConfidence',
          rolledUpBy: { '@id': 'ler:rolledUpBy', '@type': '@id' },
          assertingAgent: { '@id': 'prov:wasAttributedTo', '@type': '@id' },
          evidence: { '@id': 'ler:supportedByEvidence', '@type': '@id', '@container': '@set' },
          basis: 'ler:evidenceBasis',
          // What the assertion is called: "Demonstrated: …", "Inferred: …".
          label: 'rdfs:label',
          framework: 'ler:frameworkName',
          proficiencyLabel: 'ler:proficiencyLabel',
          proficiencyRank: 'ler:proficiencyRank',
          // The evidence figures are said of the assertion itself.
          evidenceSummary: '@nest',
          trainingCompletions: 'ler:trainingCompletionCount',
          performanceExecutions: 'ler:performanceExecutionCount',
          performanceAvgQuality: 'ler:performanceMeanQuality',
          supersedes: 'ler:supersessionNote',
        },
      },
    },
  };
}

// ── ADL TLA family ───────────────────────────────────────────────────

const CASS = 'https://schema.cassproject.org/0.4/';

const TLA_TERMS: readonly SemTerm[] = [
  // ── Competency pillar (CaSS model) ─────────────────────────────────
  {
    family: 'tla', name: 'Competency', kind: 'Class', construction: 'minted',
    label: 'Competency',
    definition: 'A skill, knowledge, ability, trait, or combination required to perform a task or job — the common currency that gives the four TLA data pillars a shared semantics.',
    source: 'ADL TLA Competency pillar; CaSS schema 0.4 (Competency)',
    subClassOf: ['skos:Concept'],
    closeMatch: ['ler:CompetencyDefinition', `${CASS}Competency`],
  },
  {
    family: 'tla', name: 'CompetencyFramework', kind: 'Class', construction: 'minted',
    label: 'Competency Framework',
    definition: 'A structured, directed graph of competencies with typed relations, levels and roll-up rules.',
    source: 'ADL TLA Competency pillar; CaSS schema 0.4 (Framework)',
    subClassOf: ['skos:ConceptScheme'],
    closeMatch: ['ler:CompetencyFramework', `${CASS}Framework`],
  },
  {
    family: 'tla', name: 'Relation', kind: 'Class', construction: 'minted',
    label: 'Competency Relation',
    definition: 'A typed edge between two competencies — narrows, broadens, requires, is-related-to, is-equivalent-to — with an optional validity window.',
    source: 'CaSS schema 0.4 (Relation)',
    closeMatch: ['ler:CompetencyRelationship', `${CASS}Relation`],
  },
  {
    family: 'tla', name: 'Level', kind: 'Class', construction: 'minted',
    // CaSS's word for it; "Proficiency Level" is the IEEE LER class it closely matches, and two
    // classes of one document's import closure should not share a label.
    label: 'Competency Level',
    definition: 'A named proficiency level or assessment criterion attached to a competency.',
    source: 'CaSS schema 0.4 (Level)',
    closeMatch: ['ler:ProficiencyLevel', `${CASS}Level`],
  },
  {
    family: 'tla', name: 'ProficiencyScale', kind: 'Class', construction: 'minted',
    label: 'Proficiency Scale',
    definition: 'A published, ordered scale of proficiency levels that competency assertions are measured against — a scheme of levels, not of competencies.',
    source: 'CaSS schema 0.4 (Level); IEEE 1484.20.3-2022 (proficiency scale)',
    subClassOf: ['skos:ConceptScheme'],
  },
  {
    family: 'tla', name: 'RollupRule', kind: 'Class', construction: 'minted',
    label: 'Roll-up Rule',
    definition: 'A rule for deriving a competency\'s attainment state from the states of its sub-competencies — the competency-graph analogue of cmi5 move-on logic.',
    source: 'CaSS schema 0.4 (RollupRule)',
    closeMatch: [`${CASS}RollupRule`],
  },
  {
    family: 'tla', name: 'MoveOnRule', kind: 'Class', construction: 'minted',
    label: 'Move-On Rule',
    definition: 'The criterion (Passed, Completed, CompletedAndPassed, CompletedOrPassed, NotApplicable) that decides whether a learner has satisfied an activity well enough to advance. TLA generalises cmi5 move-on into its Control Loop 2.',
    source: 'cmi5 (Quartz) §13.1.4 (AU moveOn); ADL TLA control loops',
  },
  {
    family: 'tla', name: 'Assertion', kind: 'Class', construction: 'composed',
    label: 'Competency Assertion',
    definition: 'A CaSS assertion: a declaration by one party that a subject can perform a competency at a level, with a confidence, over a timespan, backed by evidence. The same attestation primitive as an IEEE record entry — confidence and evidence are facets, not new shapes.',
    source: 'CaSS schema 0.4 (Assertion); MOM `asserted` verb',
    subClassOf: ['amta:Attestation'],
    constructedFrom: ['amta:Attestation', 'amta:CompetenceRating', 'iep:modalStatus'],
    closeMatch: ['ler:CompetencyAssertion', `${CASS}Assertion`],
  },

  // ── Learning-activity-metadata pillar ──────────────────────────────
  {
    family: 'tla', name: 'LearningActivityMetadata', kind: 'Class', construction: 'composed',
    label: 'Learning Activity Metadata',
    definition: 'A typed metadata descriptor of a learning resource — course, section, activity or content object. The substrate\'s resource-descriptor primitive specialised for learning resources.',
    source: 'IEEE 2881-2025 (Standard for Learning Metadata Terms), the outcome of the P2881 learning-activity-metadata project, which builds on IEEE 1484.12.1 (LOM)',
    subClassOf: ['iep:ContextDescriptor'],
    constructedFrom: ['iep:ContextDescriptor', 'iep:SemioticFacet'],
  },
  {
    family: 'tla', name: 'ExperienceIndex', kind: 'Class', construction: 'view',
    label: 'Experience Index',
    definition: 'The server-side index of learning-activity metadata, federating local catalogs. Not a store of new vocabulary — a query view over Learning Activity Metadata descriptors.',
    source: 'ADL TLA Experience Index (XI)',
    constructedFrom: ['tla:LearningActivityMetadata', 'iep:CompositionOperator'],
  },
  {
    family: 'tla', name: 'EnterpriseCourseCatalog', kind: 'Class', construction: 'composed',
    label: 'Enterprise Course Catalog',
    definition: 'A network of federated course catalogs — an aggregation of learning-activity metadata descriptors across providers.',
    source: 'ADL TLA Enterprise Course Catalog (ECC)',
    subClassOf: ['iep:ComposedDescriptor'],
    constructedFrom: ['tla:LearningActivityMetadata', 'iep:FederationFacet'],
  },

  // ── Learning-performance pillar — the Master Object Model ──────────
  {
    family: 'tla', name: 'MasterObjectModel', kind: 'Class', construction: 'composed',
    label: 'Master Object Model',
    definition: 'TLA\'s xAPI profile (https://w3id.org/xapi/tla): the MOM verb set (organised in this vocabulary into five thematic levels — our own pedagogical grouping, not ADL-numbered conformance tiers), 11 activity types, three learner-state machines, and a set of context extensions. Every MOM record is an xAPI Statement.',
    source: 'ADL Master Object Model (MOM) specification',
    subClassOf: ['iep:ContextDescriptor'],
    constructedFrom: ['hela:Statement', 'hela:Verb'],
  },
  {
    family: 'tla', name: 'LearnerProfile', kind: 'Class', construction: 'composed',
    label: 'Learner Profile',
    definition: 'Each learner\'s aggregate competency level, credentials, aptitudes, preferences, goals and career trajectory. The TLA pillar from which the IEEE P2997 Enterprise Learner Record work grew, and the counterpart of that record.',
    source: 'ADL TLA Learner Profile pillar; ADL ELRR',
    subClassOf: ['iep:ComposedDescriptor'],
    constructedFrom: ['hela:Statement', 'iep:AgentFacet'],
    closeMatch: ['ler:EnterpriseLearnerRecord', 'ler:LearnerProfile'],
  },

  // ── The three federated LRS tiers — VIEWS, not three data stores ───
  {
    family: 'tla', name: 'FederatedLRSTier', kind: 'Class', construction: 'view',
    label: 'Federated LRS Tier',
    definition: 'One tier of the TLA federated LRS layer: a partition of the xAPI statement stream selected by verb set, trust tier and signature. A view over the statements, not a separate store.',
    source: 'ADL TLA federated LRS layer',
    constructedFrom: ['hela:Statement', 'iep:CompositionOperator'],
  },
  {
    family: 'tla', name: 'NoisyLRS', kind: 'Class', construction: 'view',
    label: 'Noisy LRS',
    definition: 'The tier holding every raw xAPI statement, with data ownership retained by the activity owner. A view over the statement set — the unfiltered partition.',
    source: 'ADL TLA federated LRS layer',
    subClassOf: ['tla:FederatedLRSTier'],
    constructedFrom: ['hela:Statement', 'hela:Trace'],
  },
  {
    family: 'tla', name: 'TransactionalLRS', kind: 'Class', construction: 'view',
    label: 'Transactional LRS',
    definition: 'The tier holding only the normalised MOM roll-up verbs — the evidence base for competency inference. A restriction view over the statement set, partitioned by verb set.',
    source: 'ADL TLA federated LRS layer',
    subClassOf: ['tla:FederatedLRSTier'],
    constructedFrom: ['hela:Statement', 'hela:Verb', 'iep:CompositionOperator'],
  },
  {
    family: 'tla', name: 'AuthoritativeLRS', kind: 'Class', construction: 'view',
    label: 'Authoritative LRS',
    definition: 'The tier holding only digitally-signed competency-assertion and career verbs, access-restricted. A restriction view partitioned by verb set, trust tier and signature.',
    source: 'ADL TLA federated LRS layer',
    subClassOf: ['tla:FederatedLRSTier'],
    constructedFrom: ['hela:Statement', 'iep:TrustFacet', 'iep:CompositionOperator'],
  },

  // ── Learner state — VIEWS over the MOM statement stream ────────────
  {
    family: 'tla', name: 'LearnerState', kind: 'Class', construction: 'view',
    label: 'Learner State',
    definition: 'A learner\'s current state — the materialised projection of the latest MOM statement per state dimension. A function of the event log, not stored vocabulary.',
    source: 'ADL MOM learner-state machines',
    constructedFrom: ['hela:Statement', 'iep:TemporalFacet', 'iep:supersedes'],
  },
  {
    family: 'tla', name: 'LearnerActivityState', kind: 'Class', construction: 'view',
    label: 'Learner Activity State',
    definition: 'The cmi5-aligned tactical state machine: launched → initialized → attended → suspended/resumed → completed/abandoned/terminated.',
    source: 'ADL MOM learner-state machines',
    subClassOf: ['tla:LearnerState'],
    constructedFrom: ['hela:Statement', 'iep:TemporalFacet'],
  },
  {
    family: 'tla', name: 'LearnerEventState', kind: 'Class', construction: 'view',
    label: 'Learner Event State',
    definition: 'The pre-activity / post-evidence state machine: requested → approved → scheduled → recommended, and validated / qualified / conferred / inferred.',
    source: 'ADL MOM learner-state machines',
    subClassOf: ['tla:LearnerState'],
    constructedFrom: ['hela:Statement', 'iep:TemporalFacet'],
  },
  {
    family: 'tla', name: 'LearnerCareerState', kind: 'Class', construction: 'view',
    label: 'Learner Career State',
    definition: 'The slow, strategic human-capital state machine: recruited → appraised → screened/selected → promoted → detailed → transitioned → released.',
    source: 'ADL MOM learner-state machines',
    subClassOf: ['tla:LearnerState'],
    constructedFrom: ['hela:Statement', 'iep:TemporalFacet'],
  },

  // ── TLA services (roles / components) ──────────────────────────────
  {
    family: 'tla', name: 'CompetencyManagementService', kind: 'Class', construction: 'role',
    label: 'Competency Management Service',
    definition: 'The service (CaSS, in the reference implementation) that reads MOM statements from the Transactional LRS, joins actor to learner and object to activity-metadata-to-competency, estimates proficiency and emits signed assertions.',
    source: 'ADL TLA competency management (CaSS)',
    subClassOf: ['iep:Affordance'],
    constructedFrom: ['iep:Affordance'],
  },
  {
    family: 'tla', name: 'LearningEventManager', kind: 'Class', construction: 'role',
    label: 'Learning Event Manager',
    definition: 'The service that manages xAPI statement generation per profile, bridging learning activities into the LRS layer.',
    source: 'ADL TLA Learning Event Manager (LEM)',
    subClassOf: ['iep:Affordance'],
    constructedFrom: ['iep:Affordance'],
  },

  // ── Object / datatype properties ───────────────────────────────────
  {
    family: 'tla', name: 'aboutCompetency', kind: 'ObjectProperty', construction: 'minted',
    label: 'about competency',
    definition: 'Relates a CaSS assertion to the one competency it asserts.',
    source: 'CaSS schema 0.4 (Assertion)',
    domain: 'tla:Assertion', range: 'tla:Competency',
    functional: true,
  },
  {
    family: 'tla', name: 'confidence', kind: 'DatatypeProperty', construction: 'minted',
    label: 'confidence',
    definition: 'The asserting party\'s confidence in a competency assertion, a decimal.',
    source: 'CaSS schema 0.4 (Assertion); MOM confidence context extension',
    domain: 'tla:Assertion', range: 'xsd:decimal',
    functional: true,
  },
  {
    family: 'tla', name: 'decayFunction', kind: 'DatatypeProperty', construction: 'minted',
    label: 'decay function',
    definition: 'An expression describing how the confidence of a competency assertion decays over time.',
    source: 'CaSS schema 0.4 (Assertion)',
    domain: 'tla:Assertion', range: 'xsd:string',
    functional: true,
  },
  {
    family: 'tla', name: 'relationType', kind: 'DatatypeProperty', construction: 'minted',
    label: 'relation type',
    definition: 'The type of a competency relation, as a token — for example narrows, broadens, requires, isEnabledBy, isRelatedTo, isEquivalentTo.',
    source: 'CaSS schema 0.4 (Relation)',
    domain: 'tla:Relation', range: 'xsd:string',
    functional: true,
  },
  {
    family: 'tla', name: 'rollupRule', kind: 'DatatypeProperty', construction: 'minted',
    label: 'roll-up rule expression',
    definition: 'The rule expression a roll-up rule evaluates against sub-competency states.',
    source: 'CaSS schema 0.4 (RollupRule)',
    domain: 'tla:RollupRule', range: 'xsd:string',
  },
  {
    family: 'tla', name: 'onScale', kind: 'ObjectProperty', construction: 'minted',
    label: 'on scale',
    definition: 'Relates a roll-up rule to the proficiency scale whose levels it assigns.',
    source: 'CaSS schema 0.4 (RollupRule, Level)',
    domain: 'tla:RollupRule', range: 'tla:ProficiencyScale',
    functional: true,
  },
  {
    family: 'tla', name: 'moveOnCriterion', kind: 'DatatypeProperty', construction: 'minted',
    label: 'move-on criterion',
    definition: 'The criterion a move-on rule applies — one of the five values cmi5 defines for an assignable unit\'s moveOn.',
    source: 'cmi5 (Quartz) §13.1.4 (AU moveOn)',
    domain: 'tla:MoveOnRule', oneOf: ['Passed', 'Completed', 'CompletedAndPassed', 'CompletedOrPassed', 'NotApplicable'],
    functional: true,
  },
  {
    family: 'tla', name: 'governsActivity', kind: 'ObjectProperty', construction: 'minted',
    label: 'governs activity',
    definition: 'Relates a move-on rule to the learning activity (identified by its metadata descriptor) whose satisfaction it decides.',
    source: 'cmi5 (Quartz) §13.1.4 (AU moveOn); ADL TLA control loops',
    domain: 'tla:MoveOnRule', range: 'tla:LearningActivityMetadata',
  },
  {
    family: 'tla', name: 'indexes', kind: 'ObjectProperty', construction: 'minted',
    label: 'indexes',
    definition: 'Relates an experience index or an enterprise course catalog to a learning-activity metadata descriptor it federates.',
    source: 'ADL TLA Experience Index (XI); ADL TLA Enterprise Course Catalog (ECC)',
    domain: ['tla:ExperienceIndex', 'tla:EnterpriseCourseCatalog'], range: 'tla:LearningActivityMetadata',
  },
  {
    family: 'tla', name: 'admitsVerb', kind: 'ObjectProperty', construction: 'minted',
    label: 'admits verb',
    definition: 'Relates a federated LRS tier to a MOM verb whose statements the tier admits — the verb set that defines the partition.',
    source: 'ADL TLA federated LRS layer',
    domain: 'tla:FederatedLRSTier', range: 'skos:Concept',
  },
  {
    family: 'tla', name: 'stateOf', kind: 'ObjectProperty', construction: 'minted',
    label: 'state of',
    definition: 'Relates a learner state to the one learner whose state it is.',
    source: 'ADL MOM learner-state machines',
    domain: 'tla:LearnerState', range: 'ler:Learner',
    functional: true,
  },
  {
    family: 'tla', name: 'projectedFrom', kind: 'ObjectProperty', construction: 'minted',
    label: 'projected from',
    definition: 'Relates a learner state to a MOM statement it is the projection of: the latest statement in its state dimension.',
    source: 'ADL MOM learner-state machines',
    domain: 'tla:LearnerState', range: 'hela:Statement',
  },
];

// ── MOM concept scheme — verbs, activity types, context extensions ──
//
// The MOM verbs are not classes; they are SKOS concepts in the
// `tla:MOMVerbScheme`, grouped into five `skos:Collection` THEMATIC levels
// (this project's own grouping over the ADL MOM verb set — not ADL-defined
// numbered conformance tiers). Importing them as a concept scheme — rather
// than a class hierarchy — is the correct modelling per the research finding.
// (The exact count is MOM_VERBS.length, rendered dynamically below.)

interface MomConcept { name: string; label: string; scheme: 'verb' | 'activityType' | 'extension'; level?: number; }

const MOM_LEVEL_LABEL: Record<number, string> = {
  1: 'Level 1 — Completion & Certification',
  2: 'Level 2 — Session Lifecycle (cmi5-aligned)',
  3: 'Level 3 — Competency Assertions',
  4: 'Level 4 — Adaptive Learning Paths & Goal Management',
  5: 'Level 5 — Career & Human-Capital',
};

const MOM_VERBS: readonly MomConcept[] = [
  ...['certified', 'completed', 'passed', 'failed'].map(n => ({ name: n, label: n, scheme: 'verb' as const, level: 1 })),
  ...['launched', 'initialized', 'attended', 'experienced', 'suspended', 'resumed', 'terminated', 'abandoned', 'scored', 'mastered', 'registered', 'waived', 'satisfied'].map(n => ({ name: n, label: n, scheme: 'verb' as const, level: 2 })),
  ...['assessed', 'contextualized', 'located', 'asserted', 'validated', 'inferred', 'qualified', 'verified', 'conferred'].map(n => ({ name: n, label: n, scheme: 'verb' as const, level: 3 })),
  ...['recommended', 'prioritized', 'organized', 'projected', 'planned', 'deselected', 'requested', 'approved', 'augmented', 'explored', 'clarified', 'directed', 'scheduled'].map(n => ({ name: n, label: n, scheme: 'verb' as const, level: 4 })),
  ...['recruited', 'appraised', 'detailed', 'mobilized', 'employed', 'schooled', 'promoted', 'screened', 'selected', 'transitioned', 'released', 'restricted', 'voided'].map(n => ({ name: n, label: n, scheme: 'verb' as const, level: 5 })),
];

const MOM_ACTIVITY_TYPES: readonly MomConcept[] = [
  'activity', 'assessment', 'competency', 'activity_cluster', 'career', 'badge',
  'job', 'credential', 'job_duty_gig', 'career_state', 'rank',
].map(n => ({ name: `activity-type/${n}`, label: n, scheme: 'activityType' as const }));

const MOM_EXTENSIONS: readonly MomConcept[] = [
  'learner', 'evidence', 'confidence', 'instance', 'due_date', 'location',
  'unit_identification_code', 'permanent_change_of_station', 'restriction',
  'reason', 'recommendation_order', 'expiration',
].map(n => ({ name: `extension/${n}`, label: n, scheme: 'extension' as const }));

const MOM_CONCEPTS: readonly MomConcept[] = [...MOM_VERBS, ...MOM_ACTIVITY_TYPES, ...MOM_EXTENSIONS];

/**
 * What each MOM concept records — this vocabulary's own one-line summaries, in plain words. The MOM
 * specification is authoritative; these exist so that every published concept carries a definition
 * a reader can act on, rather than a bare token.
 */
const MOM_DEFINITIONS: Readonly<Record<string, string>> = {
  // Level 1 — completion and certification
  certified: 'The learner was awarded a certification attesting to an attained competency or a completed programme.',
  completed: 'The learner finished the activity.',
  passed: 'The learner met the activity\'s success criterion, such as a passing score.',
  failed: 'The learner did not meet the activity\'s success criterion.',
  // Level 2 — session lifecycle (cmi5-aligned)
  launched: 'The activity was launched for the learner: the start of a session, before the content reports that it is running.',
  initialized: 'The launched content began reporting for the session.',
  attended: 'The learner was present for a scheduled, instructor-led or live activity.',
  experienced: 'The learner viewed, read, watched, listened to or otherwise took in the content.',
  suspended: 'The session was paused, with the intention of resuming it later.',
  resumed: 'A suspended session was continued.',
  terminated: 'The session ended normally; no further statements are expected for it.',
  abandoned: 'The session ended abnormally, without a terminated statement — for example a closed window or a lost connection.',
  scored: 'A score was recorded for the learner\'s performance on the activity.',
  mastered: 'The learner demonstrated mastery of the activity\'s content.',
  registered: 'The learner was enrolled in, or registered for, the activity.',
  waived: 'The activity\'s requirement was determined to be met by means other than its move-on criteria, and was waived.',
  satisfied: 'The learner met the move-on criteria of the activity, or of the block that contains it.',
  // Level 3 — competency assertions
  assessed: 'The learner\'s competency was assessed, by an instrument or an evaluator.',
  contextualized: 'Evidence or an assertion was related to the context — role, task or conditions — in which it was produced or applies.',
  located: 'Evidence or a resource relevant to the learner\'s competency record was found and associated with it.',
  asserted: 'A party asserted that the learner holds a competency at a level, with a confidence.',
  validated: 'An assertion or a piece of evidence was checked and confirmed as valid.',
  inferred: 'A competency state was inferred from other evidence rather than observed directly.',
  qualified: 'The learner was determined to be qualified for a role, job or duty.',
  verified: 'A credential or an assertion was verified as authentic.',
  conferred: 'A credential, rank or award was formally granted to the learner.',
  // Level 4 — adaptive learning paths and goal management
  recommended: 'An activity or a path was recommended to the learner.',
  prioritized: 'Goals or activities were ordered by priority for the learner.',
  organized: 'Activities were arranged into a structured sequence or plan for the learner.',
  projected: 'A future competency state or completion was forecast for the learner.',
  planned: 'An activity or a goal was placed on the learner\'s plan.',
  deselected: 'An activity previously selected or recommended was removed from the learner\'s plan.',
  requested: 'An activity was requested, by the learner or on the learner\'s behalf.',
  approved: 'A request for an activity was approved.',
  augmented: 'An existing plan or path was supplemented with further activities.',
  explored: 'The learner browsed or investigated the available activities or options.',
  clarified: 'A goal, a requirement or an instruction was clarified for the learner.',
  directed: 'The learner was directed — assigned by an authority — to an activity.',
  scheduled: 'An activity was scheduled for the learner at a stated time.',
  // Level 5 — career and human capital
  recruited: 'The individual was recruited into the organization.',
  appraised: 'The individual\'s performance was formally appraised.',
  detailed: 'The individual was temporarily assigned (detailed) to another unit, role or duty.',
  mobilized: 'The individual was mobilized — called to active service or deployed.',
  employed: 'The individual was employed in a job or position.',
  schooled: 'The individual was sent to formal schooling or training.',
  promoted: 'The individual was promoted in grade or rank.',
  screened: 'The individual was screened against the requirements of a role.',
  selected: 'The individual was selected for a role, position or opportunity.',
  transitioned: 'The individual moved between roles, careers or organizations.',
  released: 'The individual was released from a role, from service or from the organization.',
  restricted: 'A restriction was placed on the individual\'s eligibility or duties.',
  voided: 'A previously recorded statement was voided: retracted, as though it had not been made.',
  // Activity types
  'activity-type/activity': 'A learning activity.',
  'activity-type/assessment': 'An assessment: an instrument that measures performance or competency.',
  'activity-type/competency': 'A competency, as the object of a statement.',
  'activity-type/activity_cluster': 'A grouping of related learning activities.',
  'activity-type/career': 'A career, as the object of career-state statements.',
  'activity-type/badge': 'A digital badge.',
  'activity-type/job': 'A job or a position.',
  'activity-type/credential': 'A credential.',
  'activity-type/job_duty_gig': 'A job duty, or a short-term assignment (gig).',
  'activity-type/career_state': 'A state in a learner\'s career trajectory.',
  'activity-type/rank': 'A rank or a grade.',
  // Context extensions
  'extension/learner': 'The learner a statement concerns, where that is not its actor.',
  'extension/evidence': 'References to the evidence that supports the statement.',
  'extension/confidence': 'The confidence attached to an assertion.',
  'extension/instance': 'The particular instance — offering, cohort or occurrence — of an activity.',
  'extension/due_date': 'The date by which an activity is due.',
  'extension/location': 'Where the activity takes, or took, place.',
  'extension/unit_identification_code': 'The unit identification code (UIC) of the organizational unit associated with the learner or the activity.',
  'extension/permanent_change_of_station': 'A permanent change of station (PCS): the individual\'s relocation to a new duty station.',
  'extension/restriction': 'A restriction that applies to the statement\'s subject or activity.',
  'extension/reason': 'The reason for the action the statement records.',
  'extension/recommendation_order': 'The position of a recommendation in an ordered list of recommendations.',
  'extension/expiration': 'When the claim, credential or assignment the statement records expires.',
};

/** The words a MOM concept is published with: its token's words, qualified by what kind of term
 *  it is where a bare word would collide with a class (`Competency`) or a property (`confidence`). */
function momLabel(c: MomConcept): string {
  const words = c.label.replace(/_/g, ' ');
  return c.scheme === 'activityType' ? `${words} activity type` : c.scheme === 'extension' ? `${words} extension` : words;
}

/** The canonical xAPI verb IRI a MOM verb skos:closeMatch-es. The cmi5-DEFINED verbs
 *  (satisfied / abandoned / waived) live at w3id.org/xapi/adl/verbs — the SAME authority the
 *  Foxxi xAPI profile declares and emits them at — so the two published surfaces agree; every
 *  other MOM verb (completed/passed/failed/mastered/…) is an ADL core verb at adlnet.gov. */
const CMI5_W3ID_VERBS = new Set(['satisfied', 'abandoned', 'waived']);
// The MOM verbs that ACTUALLY have a registered counterpart at http://adlnet.gov/expapi/verbs/.
// The remaining MOM verbs (certified, asserted, inferred, recruited, …) are coined by THIS
// project — they have NO ADL-registered IRI, so emitting skos:closeMatch to a fabricated
// adlnet.gov/expapi/verbs/<label> asserted an alignment to a URL that 404s (a dressed-404 +
// everything-is-a-URL violation). Those get NO closeMatch.
const ADL_CORE_VERBS = new Set(['completed', 'passed', 'failed', 'launched', 'initialized', 'attended', 'experienced', 'suspended', 'resumed', 'terminated', 'mastered', 'registered', 'voided', 'scored']);
function momVerbMatch(label: string): string | null {
  if (CMI5_W3ID_VERBS.has(label)) return `https://w3id.org/xapi/adl/verbs/${label}`;
  if (ADL_CORE_VERBS.has(label)) return `http://adlnet.gov/expapi/verbs/${label}`;
  return null;
}

// ── Performance proficiency: a published scale + a published roll-up rule ──
//
// CaSS proficiency levels are framework-scoped (there is no fixed global band
// set), so we publish ONE real, dereferenceable proficiency framework for
// Foxxi production performance — the Dreyfus five-stage model of skill
// acquisition (Dreyfus & Dreyfus, 1980) — as tla:Level / ler:ProficiencyLevel
// individuals, plus the tla:RollupRule that maps performance evidence to a
// level with a confidence. Every ELR competency assertion cites BOTH a level
// IRI and the rule IRI, so proficiency is never a bare hardcoded band and the
// record can be audited back to the rule that produced it.

export const PERF_FRAMEWORK_IRI = `${TLA_NS}PerformanceProficiencyFramework`;
export const PERF_ROLLUP_RULE_IRI = `${TLA_NS}PerformanceProficiencyRollupRule`;

export interface ProficiencyLevelDef { name: string; rank: number; label: string; comment: string; }
/** The Dreyfus five-stage skill-acquisition scale, published as level individuals. */
export const PROFICIENCY_LEVELS: readonly ProficiencyLevelDef[] = [
  { name: 'Novice',           rank: 1, label: 'Novice',            comment: 'Rule-bound, relies on instruction. Inferred from training completion only — not yet demonstrated in production.' },
  { name: 'AdvancedBeginner', rank: 2, label: 'Advanced Beginner', comment: 'Has demonstrated the competency in production at least once with an asserted successful outcome; limited situational judgment.' },
  { name: 'Competent',        rank: 3, label: 'Competent',         comment: 'Consistent successful production performance over a meaningful sample; plans deliberately and handles the typical case.' },
  { name: 'Proficient',       rank: 4, label: 'Proficient',        comment: 'Reliable, high-quality production performance across many executions; perceives situations holistically.' },
  { name: 'Expert',           rank: 5, label: 'Expert',            comment: 'Sustained, near-flawless, high-quality production performance at scale; fluid, intuitive mastery.' },
] as const;

export function proficiencyLevelIri(name: string): string { return `${TLA_NS}Level${name}`; }
export function proficiencyLevelByName(name: string): ProficiencyLevelDef | undefined {
  return PROFICIENCY_LEVELS.find(l => l.name === name);
}

export interface RollupInput {
  basis: 'performance' | 'credential' | 'inferred';
  /** Performance executions carrying an asserted outcome (success true or false). */
  executions: number;
  successes: number;
  /** Mean of scored outcome qualities in 0..1, if any were scored. */
  avgQuality?: number;
  credentialCount?: number;
}
export interface RollupResult {
  levelName: string; levelLabel: string; levelIri: string; rank: number;
  /** 0..1 — Wilson score interval lower bound on the success rate. */
  confidence: number;
  ruleIri: string;
}

/** Wilson score interval lower bound for k successes in n trials at 95% (z=1.96).
 *  A principled confidence in a success rate that grows with the sample size —
 *  small n is penalised, so one lucky success is not high confidence. */
function wilsonLower(k: number, n: number): number {
  if (n <= 0) return 0;
  const z = 1.96, p = k / n;
  const den = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - margin) / den));
}
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

/**
 * ── ★★★ THE RULE IS DATA, AND THE ENGINE READS IT ───────────────────────────────────────────
 *
 * This was an `if` ladder over raw counts, with a separately hand-maintained string describing it
 * for publication. Two things were wrong with that, and the second is the one that bit.
 *
 * ★ IT WAS A HARDCODE PUBLISHING ITS OWN DESCRIPTION. The engine decided in TypeScript and a prose
 * constant claimed what the engine did — so the published rule was a MIRROR that nothing kept in
 * step, and no test exercised either. `evaluateProficiency`, `wilsonLower` and the rule text had
 * zero references in the whole test tree. This project's own stated position is a general engine
 * reading published rule DATA, never `if (x)`; the conformance work already does that. This is now
 * the same shape: the bands below ARE the rule, the evaluator walks them, and the published text is
 * GENERATED from them, so a threshold cannot change without the publication changing with it.
 *
 * ★★ AND THE LADDER WAS WRONG, IN A WAY NOBODY HAD PERTURBED FOR. Measured against the shipped
 * function, with mean quality 0.89 throughout:
 *
 *      5 executions, 5 successes  ->  rank 3 Competent,  confidence 0.566
 *      6 executions, 6 successes  ->  rank 4 Proficient, confidence 0.610
 *      6 executions, 5 successes  ->  rank 4 Proficient, confidence 0.436   <-- FAILING PROMOTED YOU
 *
 * A record that FAILED moved the subject up a rank, while the confidence attached to that very rank
 * fell. The two outputs of one function moved in opposite directions on the same new evidence.
 * The cause is that n was counted TWICE — as the sample-size term inside `wilsonLower`, and again
 * as an independent `executions >=` gate — and the comment above `buildCompetencies` asserts the
 * opposite design in as many words ("the level and the confidence together carry the sample-size
 * honesty"). The ladder did not honour the comment above it.
 *
 * ★ SO RANK IS READ OFF THE RELIABILITY TERM THAT ALREADY ENCODES SAMPLE SIZE CORRECTLY. The Wilson
 * lower bound rises with evidence and falls with failure, which is exactly the monotonicity a rank
 * needs. Thresholds are chosen to preserve EVERY existing all-success transition point — 3/3=0.438,
 * 6/6=0.610, 12/12=0.757 all promote at precisely the record they promoted at before — so an honest
 * track record is unaffected and only the perverse case changes: 6/5 scores 0.436 and stays
 * Competent, which is what it always should have done.
 *
 * ★ AND QUALITY MUST BE RECORDED TO CLAIM THE TOP BANDS. `q === undefined` used to satisfy every
 * quality gate, so twelve entirely unscored executions reached EXPERT on volume alone. A level whose
 * published definition speaks of "high-quality production performance" cannot be reachable with no
 * quality evidence at all. Quality remains a FLOOR rather than a scale — 0.71 and 1.00 still rank
 * the same, which is a real limitation and is now stated in the published text rather than implied.
 */
export interface ProficiencyBand {
  readonly name: string;
  readonly rank: number;
  /** Wilson lower bound on the success rate that this band requires. */
  readonly minReliability: number;
  /** Mean-quality floor, or undefined when the band asks nothing of quality. */
  readonly minQuality?: number;
  /** Must quality have been RECORDED at all? A band describing quality may not be won without it. */
  readonly requiresQuality: boolean;
}

/**
 * ★★★ THE BANDS ARE PARSED FROM `docs/ns/adl-tla-proficiency.ttl` AT RUNTIME. That file IS the
 * rule; this module evaluates it and publishes it. A threshold change is an edit to a graph, not a
 * code change — which is the difference between a rule that is modelled and a rule that is baked.
 *
 * Loaded once and memoised: it is read on the first judgement and reused, so a container serves one
 * consistent rule for its lifetime rather than re-reading mid-flight and ranking two subjects by two
 * versions of it.
 *
 * ★ AND IT FAILS LOUDLY. If the graph cannot be read or parses to nothing, this THROWS rather than
 * quietly falling back to a built-in ladder. A silent fallback would recreate exactly the thing this
 * change removes — a hidden rule in the code that nobody can see is in force — and every silent
 * fallback in this system has cost a defect that survived because the caller got a plausible answer.
 */
let _bands: readonly ProficiencyBand[] | undefined;

/** Walk up for `docs/ns`, the same way `@interego/pgsl`'s static-ontology loader does. */
function resolveNsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolvePath(dir, 'docs', 'ns');
    if (existsSync(candidate)) return candidate;
    const parent = resolvePath(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'ns');
}

const BAND_TTL = 'adl-tla-proficiency.ttl';

/** Read the rule graph. Exported so the publication path serves the SAME bytes the engine ran. */
export function loadProficiencyRuleTurtle(): string {
  return readFileSync(resolvePath(resolveNsDir(), BAND_TTL), 'utf8');
}

/** Parse the bands out of the rule graph, highest rank first. */
export function parseProficiencyBands(turtle: string): readonly ProficiencyBand[] {
  const doc = parseTrig(turtle);
  const num = (s: string | undefined): number | undefined => {
    if (s === undefined) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  const bands: ProficiencyBand[] = [];
  for (const subj of findSubjectsOfType(doc, `${TLA_NS}ProficiencyBand` as IRI)) {
    const levelIri = readIriValue(subj, `${TLA_NS}awardsLevel` as IRI);
    const minReliability = num(readStringValue(subj, `${TLA_NS}minReliability` as IRI));
    if (!levelIri || minReliability === undefined) continue;
    const name = String(levelIri).replace(TLA_NS, '').replace(/^Level/, '');
    const def = proficiencyLevelByName(name);
    if (!def) continue;
    const minQuality = num(readStringValue(subj, `${TLA_NS}minQuality` as IRI));
    bands.push({
      name,
      rank: def.rank,
      minReliability,
      ...(minQuality !== undefined ? { minQuality } : {}),
      requiresQuality: readStringValue(subj, `${TLA_NS}requiresQuality` as IRI) === 'true',
    });
  }
  return Object.freeze(bands.sort((a, b) => b.rank - a.rank));
}

/** The bands in force, from the published graph. Throws rather than guessing — see above. */
export function performanceProficiencyBands(): readonly ProficiencyBand[] {
  if (_bands) return _bands;
  const parsed = parseProficiencyBands(loadProficiencyRuleTurtle());
  if (parsed.length === 0) {
    throw new Error(
      `${BAND_TTL} parsed to zero tla:ProficiencyBand nodes — the proficiency rule is DATA and the `
      + 'data is unreadable. Refusing to rank rather than fall back to a hidden built-in ladder.',
    );
  }
  _bands = parsed;
  return _bands;
}

/** Does this evidence satisfy this band? The whole of the rule's per-band logic, in one place. */
function bandSatisfied(band: ProficiencyBand, reliability: number, avgQuality: number | undefined): boolean {
  if (reliability < band.minReliability) return false;
  if (band.requiresQuality && avgQuality === undefined) return false;
  if (band.minQuality !== undefined && avgQuality !== undefined && avgQuality < band.minQuality) return false;
  return true;
}

/** Evaluate the published tla:PerformanceProficiencyRollupRule against evidence. */
export function evaluateProficiency(input: RollupInput): RollupResult {
  const { basis, executions, successes } = input;
  const q = input.avgQuality;
  let name = 'Novice';
  if (basis === 'performance') {
    // The SAME reliability term the result reports as `confidence` — one number, not two notions
    // of sample size that can disagree.
    const reliability = round3(wilsonLower(successes, executions));
    const band = performanceProficiencyBands().find(b => bandSatisfied(b, reliability, q));
    name = band ? band.name : (successes >= 1 ? 'AdvancedBeginner' : 'Novice');
  } else if (basis === 'credential') {
    name = 'Competent'; // a verified credential attests demonstrated competence
  } else {
    name = 'Novice';    // training-inferred only
  }
  const def = proficiencyLevelByName(name)!;
  const confidence = basis === 'performance'
    ? round3(wilsonLower(successes, executions))
    : basis === 'credential'
      ? round3(Math.min(0.9, 0.6 + 0.1 * (input.credentialCount ?? 1)))
      : 0.2;
  return { levelName: name, levelLabel: def.label, levelIri: proficiencyLevelIri(name), rank: def.rank, confidence, ruleIri: PERF_ROLLUP_RULE_IRI };
}

/**
 * The human-readable rule expression published as `tla:rollupRule` — RENDERED FROM THE BANDS.
 *
 * ★★ IT USED TO BE A HAND-MAINTAINED STRING BESIDE AN `if` LADDER, and nothing kept the two in
 * step: two sources for one fact, no test touching either, and a published sentence that was
 * accurate only for as long as somebody remembered. It is now generated from the same triples the
 * evaluator walks, so the document and the behaviour cannot disagree — the drift is not policed,
 * it is impossible.
 */
export function perfRollupRuleText(): string {
  const bands = performanceProficiencyBands();
  const clause = (b: ProficiencyBand): string => {
    const q = b.requiresQuality
      ? ` and mean quality q is recorded and q>=${b.minQuality ?? 0}`
      : '';
    return `${proficiencyLevelByName(b.name)?.label ?? b.name} if reliability>=${b.minReliability}${q}`;
  };
  return 'Given production performance evidence (n executions carrying an asserted outcome, k successes, '
    + 'mean scored quality q in 0..1): reliability is the Wilson score interval lower bound (z=1.96) on k/n, '
    + 'which rises with evidence and FALLS when a failure is added — so it carries both how often the work '
    + 'succeeded and how much of it there is, and no separate execution count is gated on. '
    + `${bands.map(clause).join('; ')}; Advanced Beginner if k>=1; else Novice. `
    + 'Quality is a FLOOR, not a scale: every value at or above a band\'s floor ranks alike. '
    + 'A verified credential with no production evidence maps to Competent; training completion only maps to '
    + 'Novice (Hypothetical). The reported confidence IS the reliability above. '
    + 'This rule is data: its bands are the tla:ProficiencyBand individuals of this document (tla:hasBand), '
    + 'which the evaluator reads as they are published, and this sentence is generated from the same triples.';
}

// Proficiency framework + roll-up-rule metadata — shared verbatim by the Turtle
// and JSON-LD projections so the two serializations of /ns/adl-tla stay
// triple-isomorphic (the Level/RollupRule nodes previously drifted between them).
const PROF_FRAMEWORK_LABEL = 'Foxxi Production-Performance Proficiency Framework';
const PROF_FRAMEWORK_COMMENT = 'A published proficiency scale for on-the-job production performance, using the Dreyfus five-stage model of skill acquisition. The tla:Level individuals below are the dereferenceable scale an ELR competency assertion is measured against (ler:atProficiency).';
const PROF_FRAMEWORK_SOURCE = 'Dreyfus, S.E. & Dreyfus, H.L. (1980) — A Five-Stage Model of the Mental Activities Involved in Directed Skill Acquisition';
const PROF_ROLLUP_LABEL = 'Production-performance proficiency roll-up rule';
const PROF_ROLLUP_COMMENT = "Maps a subject's production-performance evidence to a proficiency level in the Foxxi Production-Performance Proficiency Framework, with a confidence. Cited by every performance-basis ler:CompetencyAssertion the ELR emits.";

// ── Indexes + public accessors ───────────────────────────────────────

const ALL_TERMS: readonly SemTerm[] = [...LER_TERMS, ...TLA_TERMS];
const TERM_INDEX = new Map(ALL_TERMS.map(t => [`${t.family}:${t.name}`, t]));

export function lookupSemTerm(family: 'ler' | 'tla', name: string): SemTerm | undefined {
  return TERM_INDEX.get(`${family}:${name}`);
}

/** Every term IRI the layer declares — what a dereferencing client can verify. */
export function declaredSemIris(): string[] {
  return [
    ...LER_TERMS.map(t => `${LER_NS}${t.name}`),
    ...TLA_TERMS.map(t => `${TLA_NS}${t.name}`),
    ...MOM_CONCEPTS.map(c => `${TLA_NS}${c.name}`),
    PERF_FRAMEWORK_IRI,
    ...PROFICIENCY_LEVELS.map(l => proficiencyLevelIri(l.name)),
    PERF_ROLLUP_RULE_IRI,
  ];
}

/** Summary counts — used by the conformance / health surface. */
export function semLayerStats(): {
  lerTerms: number; tlaTerms: number; momConcepts: number;
  minted: number; composed: number; views: number; roles: number;
} {
  const by = (c: Construction): number => ALL_TERMS.filter(t => t.construction === c).length;
  return {
    lerTerms: LER_TERMS.length,
    tlaTerms: TLA_TERMS.length,
    momConcepts: MOM_CONCEPTS.length,
    minted: by('minted'),
    composed: by('composed'),
    views: by('view'),
    roles: by('role'),
  };
}

// ── The two ontologies as graphs ─────────────────────────────────────

/** Token prefixes the term data above is written with (`ler:X`, `iep:Y`, …). Output prefixes are
 *  the catalog's (`foxxi-ieee-ler:`, `foxxi-adl-tla:`, …) — see ns/catalog.ts. */
const TOKEN_PREFIXES: Record<string, string> = { ...ALL_PREFIXES, ler: LER_NS, tla: TLA_NS, ...PREFIXES };
function abs(ref: string): string {
  if (/^https?:\/\//.test(ref)) return ref;
  const m = /^([a-z][\w-]*):(.+)$/i.exec(ref);
  const base = m ? TOKEN_PREFIXES[m[1]!] : undefined;
  if (m && base !== undefined) return base + m[2]!;
  throw new Error(`ler-tla-vocab: unresolvable term reference ${JSON.stringify(ref)}`);
}

/** Ontology-level title, abstract and publication record for each family. */
export function semDocMeta(family: 'ler' | 'tla'): DocMeta {
  return family === 'ler'
    ? {
        iri: LER_DOC, ns: LER_NS, prefix: foxxiPrefix('ieee-ler'),
        title: 'IEEE Learning and Employment Records (LER) — Foxxi composable ontology',
        description: 'An OWL 2 DL vocabulary for the IEEE learning-and-employment-record family — the IEEE P2997 Enterprise Learner Record (active PAR), IEEE 1484.20.3-2022 Shareable Competency Definitions, IEEE 1484.2-2024 LER Ecosystems and the earlier IEEE 1484.20.1-2007 Reusable Competency Definitions (now inactive-reserved) — modelled as compositions over the Interego substrate: most concepts are aggregations, views or roles over the substrate\'s attestation, event-record, resource-descriptor and aggregation primitives, not new classes. Each term records how it is built (foxxi:construction, an annotation of the Foxxi vocabulary) and from which substrate primitives (iep:constructedFrom, the Interego substrate\'s own relation).',
        version: LER_VERSION, created: '2026-05-20', modified: '2026-10-12', issued: '2026-10-12',
        standards: [
          { title: 'IEEE P2997 — Standard for Enterprise Learner Record (active PAR)', url: P2997 },
          { title: 'IEEE 1484.20.3-2022 — Data Model for Shareable Competency Definitions', url: 'https://standards.ieee.org/ieee/1484.20.3/10749/' },
          { title: 'IEEE 1484.2-2024 — Recommended Practice for Learning and Employment Record (LER) Ecosystems', url: 'https://standards.ieee.org/ieee/1484.2/11164/' },
          { title: 'IEEE 1484.20.1-2007 — Data Model for Reusable Competency Definitions (inactive-reserved)', url: 'https://standards.ieee.org/ieee/1484.20.1/4012/' },
        ],
        bodies: ['IEEE', 'ADL', '1EdTech'],
        // Its own shapes and mapping set at the versions released with it; the other document at its
        // document IRI.
        seeAlso: [TLA_DOC, `${LER_DOC}/shapes/${LER_SHAPES_VERSION}`, `${mappingSetIri(LER_DOC)}/${LER_VERSION}`, 'https://markjspivey-xwisee.github.io/interego/ns/iep#'],
        sourceCode: ['applications/foxxi-content-intelligence/src/ler-tla-vocab.ts'],
        notes: [
          `Cross-standard alignments to the ADL TLA ontology and to CaSS, CTDL-ASN, Open Badges and CLR are SKOS mapping relations (closeMatch and narrowMatch), never owl:equivalentClass: they record that two standards name closely related notions, or that one names a kind of the other, not that their instances are interchangeable. They are also published as an SSSOM mapping set at ${mappingSetIri(LER_DOC)}.`,
          'Interego substrate terms (iep:, amta:, hela:) are referenced, not imported: the substrate ontologies are declared here term by term so this document is self-contained OWL 2 DL and loads without network access to them.',
          `A Foxxi Enterprise Learner Record is JSON-LD read through the W3C VC 2.0 context and the record context published at ${ELR_CONTEXT_URL}, which maps its fields to this vocabulary; the shapes at ${LER_DOC}/shapes constrain that RDF reading.`,
        ],
      }
    : {
        iri: TLA_DOC, ns: TLA_NS, prefix: foxxiPrefix('adl-tla'),
        title: 'ADL Total Learning Architecture (TLA) — Foxxi composable ontology',
        description: 'An OWL 2 DL vocabulary for the ADL Total Learning Architecture: the four data pillars (competency, learning-activity metadata, learning performance, learner profile), the Master Object Model (MOM) xAPI vocabulary, the CaSS competency model, the federated LRS tiers and the learner-state machines — modelled as compositions over the Interego substrate. The three LRS tiers and the learner-state machines are views over the statement stream, not stores. Also publishes the Foxxi production-performance proficiency framework (Dreyfus) and the roll-up rule, whose bands are data the evaluator reads.',
        version: TLA_VERSION, created: '2026-05-20', modified: '2026-10-12', issued: '2026-10-12',
        standards: [
          { title: 'ADL Total Learning Architecture (TLA) — reference implementation and service definitions', url: 'https://adlnet.gov/projects/tla/' },
          { title: 'IEEE 2881-2025 — Standard for Learning Metadata Terms', url: 'https://standards.ieee.org/ieee/2881/11719/' },
          { title: 'CaSS competency schema 0.4', url: 'https://schema.cassproject.org/0.4/' },
        ],
        bodies: ['ADL', 'IEEE', 'the CaSS project'],
        seeAlso: [LER_DOC, `${LER_DOC}/shapes/${LER_SHAPES_VERSION}`, `${mappingSetIri(TLA_DOC)}/${TLA_VERSION}`, 'https://markjspivey-xwisee.github.io/interego/ns/iep#'],
        sourceCode: ['applications/foxxi-content-intelligence/src/ler-tla-vocab.ts', 'docs/ns/adl-tla-proficiency.ttl'],
        notes: [
          `Cross-standard alignments to the IEEE LER ontology, CaSS and the ADL xAPI verb registry are SKOS mapping relations, never owl:equivalentClass. They are also published as an SSSOM mapping set at ${mappingSetIri(TLA_DOC)}.`,
          'The proficiency roll-up rule is DATA: its bands (foxxi-adl-tla:ProficiencyBand) are published here and parsed at runtime from the same triples by the evaluator; the human-readable rule text is generated from them.',
        ],
      };
}

const KIND_TYPE: Record<TermKind, string> = {
  Class: OWL + 'Class', ObjectProperty: OWL + 'ObjectProperty', DatatypeProperty: OWL + 'DatatypeProperty',
  Concept: SKOS + 'Concept', Collection: SKOS + 'Collection',
};
const IEP_CONSTRUCTED_FROM = 'https://markjspivey-xwisee.github.io/interego/ns/iep#constructedFrom';
/** The construction annotation every term carries: the Foxxi vocabulary's (foxxi:construction). The
 *  LER document's own, which both documents' terms used to carry, is kept there, deprecated. */
const CONSTRUCTION = FOXXI_CONSTRUCTION;
const LER_CONSTRUCTION = `${LER_NS}construction`;

function addTerm(g: Graph, t: SemTerm, O: NamedNode): void {
  const S = iri((t.family === 'ler' ? LER_NS : TLA_NS) + t.name);
  const A = iri(RDF + 'type');
  g.add(S, A, iri(KIND_TYPE[t.kind]));
  if (t.functional) g.add(S, A, iri(OWL + 'FunctionalProperty'));
  // A deprecated term's label begins "obsolete " (the OBO Foundry convention ROBOT checks).
  g.add(S, iri(RDFS + 'label'), en(t.deprecated ? `obsolete ${t.label}` : t.label));
  // The definition as skos:definition and as rdfs:comment, the same string, as in every Foxxi document.
  g.add(S, iri(RDFS + 'comment'), en(t.definition)).add(S, iri(SKOS + 'definition'), en(t.definition));
  g.add(S, iri(DCT + 'source'), str(t.source));
  // The emergent-composable facet — machine-readable.
  g.add(S, iri(CONSTRUCTION), str(t.construction));
  for (const sc of t.subClassOf ?? []) g.add(S, iri(RDFS + 'subClassOf'), iri(abs(sc)));
  for (const sp of t.subPropertyOf ?? []) g.add(S, iri(RDFS + 'subPropertyOf'), iri(abs(sp)));
  // One reference, or the union of several. A datatype property's range is a DATA range
  // (rdfs:Datatype), never an owl:Class — OWL 2 DL keeps the two strictly apart.
  const expr = (refs: string | readonly string[], data: boolean): NamedNode | BlankNode => {
    const list = typeof refs === 'string' ? [refs] : [...refs];
    if (list.length === 1) return iri(abs(list[0]!));
    const u = g.bnode();
    g.add(u, A, iri(data ? RDFS + 'Datatype' : OWL + 'Class'));
    g.add(u, iri(OWL + 'unionOf'), g.list(list.map(x => iri(abs(x)))));
    return u;
  };
  if (t.domain) g.add(S, iri(RDFS + 'domain'), expr(t.domain, false));
  if (t.oneOf) {
    const e = g.bnode();
    g.add(e, A, iri(RDFS + 'Datatype')).add(e, iri(OWL + 'oneOf'), g.list(t.oneOf.map(v => str(v))));
    g.add(S, iri(RDFS + 'range'), e);
  } else if (t.range) {
    g.add(S, iri(RDFS + 'range'), expr(t.range, t.kind === 'DatatypeProperty'));
  }
  for (const cm of t.closeMatch ?? []) g.add(S, iri(SKOS + 'closeMatch'), iri(abs(cm)));
  for (const nm of t.narrowMatch ?? []) g.add(S, iri(SKOS + 'narrowMatch'), iri(abs(nm)));
  if (t.changeNote) g.add(S, iri(SKOS + 'changeNote'), en(t.changeNote));
  // A composed / view / role term names the substrate primitives it
  // emerges from — the "emergent composable" claim, in RDF.
  for (const cf of t.constructedFrom ?? []) g.add(S, iri(IEP_CONSTRUCTED_FROM), iri(abs(cf)));
  if (t.deprecated) {
    g.add(S, iri(OWL + 'deprecated'), typed('true', XSD + 'boolean'));
    if (t.replacedBy) g.add(S, iri(DCT + 'isReplacedBy'), iri(abs(t.replacedBy)));
  }
  g.add(S, iri(RDFS + 'isDefinedBy'), O);
}

/**
 * Classes whose extensions cannot overlap, stated so a reasoner can catch a record typed as two
 * of them. Chosen narrowly: the agent ROLES are deliberately absent (one person is a Learner in
 * one record and an Issuer in another), as are the attestation kinds a credential can package
 * (an Open Badge can carry a competency assertion; an endorsement can itself be a credential).
 */
const DISJOINT: Readonly<Record<'ler' | 'tla', readonly (readonly string[])[]>> = {
  ler: [[
    'ler:CompetencyDefinition', 'ler:CompetencyStatement', 'ler:CompetencyFramework', 'ler:CompetencyRelationship',
    'ler:ProficiencyLevel', 'ler:Rubric', 'ler:RubricCriterion', 'ler:CompetencyAssertion',
    'ler:EnterpriseLearnerRecord', 'ler:LearnerIdentityBinding', 'ler:RawDataLocation',
  ]],
  tla: [
    ['tla:Competency', 'tla:CompetencyFramework', 'tla:ProficiencyScale', 'tla:Relation', 'tla:Level', 'tla:RollupRule', 'tla:MoveOnRule',
      'tla:Assertion', 'tla:ProficiencyBand'],
    ['tla:NoisyLRS', 'tla:TransactionalLRS', 'tla:AuthoritativeLRS'],
    ['tla:LearnerActivityState', 'tla:LearnerEventState', 'tla:LearnerCareerState'],
  ],
};

function addDisjointness(g: Graph, family: 'ler' | 'tla'): void {
  for (const set of DISJOINT[family]) {
    const d = g.bnode();
    g.add(d, iri(RDF + 'type'), iri(OWL + 'AllDisjointClasses'));
    g.add(d, iri(OWL + 'members'), g.list(set.map(c => iri(abs(c)))));
  }
}

// The MOM verb ConceptScheme comment.
const MOM_SCHEME_COMMENT = `The ${MOM_VERBS.length} performance verbs of the ADL TLA Master Object Model (MOM), grouped into five thematic levels (this project's own pedagogical organisation, NOT ADL-defined numbered conformance levels). A verb that is a registered verb of ADL's vocabulary — an ADL core verb at adlnet.gov/expapi/verbs, or a cmi5 verb at w3id.org/xapi/adl/verbs — is an exact match of it and names it as its source. Every other verb has an IRI of this vocabulary's, and says so in an editorial note; none is mapped to an IRI that was not found registered. ADL's TLA xAPI profile (w3id.org/xapi/tla) may give some of them IRIs of its own, and has not been checked here.`;

/** The definition of a MOM level collection. */
const momLevelDefinition = (lvl: number): string =>
  `The MOM verbs this vocabulary groups under "${MOM_LEVEL_LABEL[lvl]!.replace(/^Level \d — /, '')}". A thematic grouping of this project, not an ADL-defined conformance level.`;

function addMom(g: Graph, O: NamedNode): void {
  const A = iri(RDF + 'type');
  const scheme = iri(`${TLA_NS}MOMVerbScheme`);
  g.add(scheme, A, iri(SKOS + 'ConceptScheme'))
    .add(scheme, iri(RDFS + 'label'), en('MOM performance verb scheme'))
    .add(scheme, iri(SKOS + 'prefLabel'), en('MOM performance verb scheme'))
    .add(scheme, iri(RDFS + 'comment'), en(MOM_SCHEME_COMMENT)).add(scheme, iri(SKOS + 'definition'), en(MOM_SCHEME_COMMENT))
    .add(scheme, iri(RDFS + 'isDefinedBy'), O);
  for (const kind of ['activityType', 'extension'] as const) {
    const s = iri(`${TLA_NS}${kind === 'activityType' ? 'MOMActivityTypeScheme' : 'MOMExtensionScheme'}`);
    const label = kind === 'activityType' ? 'MOM activity types' : 'MOM context extensions';
    const definition = kind === 'activityType'
      ? 'The activity types the Master Object Model names, as project-coined concepts. None asserts an external alignment: the MOM does not register them under an ADL namespace.'
      : 'The context-extension keys the Master Object Model names, as project-coined concepts with no external alignment.';
    g.add(s, A, iri(SKOS + 'ConceptScheme')).add(s, iri(RDFS + 'label'), en(label)).add(s, iri(SKOS + 'prefLabel'), en(label))
      .add(s, iri(RDFS + 'comment'), en(definition)).add(s, iri(SKOS + 'definition'), en(definition))
      .add(s, iri(RDFS + 'isDefinedBy'), O);
  }
  // skos:member relates a Collection TO its members (domain skos:Collection), so the level
  // Collection carries its verbs — NOT each verb pointing back at the level.
  for (const lvl of [1, 2, 3, 4, 5]) {
    const L = iri(`${TLA_NS}MOMLevel${lvl}`);
    g.add(L, A, iri(SKOS + 'Collection')).add(L, iri(RDFS + 'label'), en(MOM_LEVEL_LABEL[lvl]!))
      .add(L, iri(SKOS + 'prefLabel'), en(MOM_LEVEL_LABEL[lvl]!))
      .add(L, iri(RDFS + 'comment'), en(momLevelDefinition(lvl))).add(L, iri(SKOS + 'definition'), en(momLevelDefinition(lvl)));
    for (const c of MOM_CONCEPTS.filter(x => x.scheme === 'verb' && x.level === lvl)) g.add(L, iri(SKOS + 'member'), iri(TLA_NS + c.name));
    g.add(L, iri(RDFS + 'isDefinedBy'), O);
  }
  for (const c of MOM_CONCEPTS) {
    const C = iri(TLA_NS + c.name);
    const s = c.scheme === 'verb' ? scheme : iri(`${TLA_NS}${c.scheme === 'activityType' ? 'MOMActivityTypeScheme' : 'MOMExtensionScheme'}`);
    const definition = MOM_DEFINITIONS[c.name];
    if (!definition) throw new Error(`ler-tla-vocab: MOM concept ${c.name} has no definition`);
    g.add(C, A, iri(SKOS + 'Concept'))
      .add(C, iri(RDFS + 'label'), en(momLabel(c))).add(C, iri(SKOS + 'prefLabel'), en(momLabel(c)))
      .add(C, iri(SKOS + 'definition'), en(definition)).add(C, iri(RDFS + 'comment'), en(definition))
      .add(C, iri(SKOS + 'notation'), str(c.label))
      .add(C, iri(SKOS + 'inScheme'), s).add(C, iri(SKOS + 'topConceptOf'), s).add(s, iri(SKOS + 'hasTopConcept'), C)
      .add(C, iri(CONSTRUCTION), str('concept'));
    if (c.scheme === 'verb') {
      // A MOM verb that is a registered xAPI verb IS that verb — a statement carries its IRI — so it
      // is an exact match, as the cmi5 ontology maps the same verbs. A verb with no registered
      // counterpart says it was coined here; no IRI is ever fabricated for one.
      const registered = momVerbMatch(c.label);
      if (registered) g.add(C, iri(SKOS + 'exactMatch'), iri(registered)).add(C, iri(DCT + 'source'), iri(registered));
      else g.add(C, iri(SKOS + 'editorialNote'), en('The IRI is this vocabulary\'s: the verb is one of the MOM\'s, and no verb of ADL\'s vocabulary (adlnet.gov/expapi/verbs) or of cmi5\'s (w3id.org/xapi/adl/verbs) has its meaning. ADL\'s TLA xAPI profile (w3id.org/xapi/tla) may give it an IRI of its own; that profile has not been checked here.'));
    }
    g.add(C, iri(RDFS + 'isDefinedBy'), O);
  }
}

/** The proficiency framework, its levels, the roll-up rule — and the rule's BANDS, as data. */
function addProficiency(g: Graph, O: NamedNode): void {
  const A = iri(RDF + 'type');
  const FW = iri(PERF_FRAMEWORK_IRI);
  // A scale of proficiency levels, not a framework of competencies (it holds no competency).
  g.add(FW, A, iri(`${TLA_NS}ProficiencyScale`)).add(FW, A, iri(SKOS + 'ConceptScheme'))
    .add(FW, iri(RDFS + 'label'), en(PROF_FRAMEWORK_LABEL)).add(FW, iri(SKOS + 'prefLabel'), en(PROF_FRAMEWORK_LABEL))
    .add(FW, iri(RDFS + 'comment'), en(PROF_FRAMEWORK_COMMENT)).add(FW, iri(SKOS + 'definition'), en(PROF_FRAMEWORK_COMMENT))
    .add(FW, iri(DCT + 'source'), str(PROF_FRAMEWORK_SOURCE))
    .add(FW, iri(CONSTRUCTION), str('minted'))
    .add(FW, iri(RDFS + 'isDefinedBy'), O);
  for (const l of PROFICIENCY_LEVELS) {
    const L = iri(proficiencyLevelIri(l.name));
    g.add(L, A, iri(`${TLA_NS}Level`)).add(L, A, iri(`${LER_NS}ProficiencyLevel`)).add(L, A, iri(SKOS + 'Concept'))
      .add(L, iri(RDFS + 'label'), en(l.label)).add(L, iri(SKOS + 'prefLabel'), en(l.label))
      .add(L, iri(RDFS + 'comment'), en(l.comment)).add(L, iri(SKOS + 'definition'), en(l.comment))
      .add(L, iri(SKOS + 'inScheme'), FW).add(L, iri(SKOS + 'topConceptOf'), FW).add(FW, iri(SKOS + 'hasTopConcept'), L)
      .add(L, iri(SKOS + 'notation'), str(String(l.rank)))
      .add(L, iri(CONSTRUCTION), str('concept'))
      .add(L, iri(RDFS + 'isDefinedBy'), O);
  }
  const R = iri(PERF_ROLLUP_RULE_IRI);
  g.add(R, A, iri(`${TLA_NS}RollupRule`))
    .add(R, iri(RDFS + 'label'), en(PROF_ROLLUP_LABEL))
    .add(R, iri(RDFS + 'comment'), en(PROF_ROLLUP_COMMENT)).add(R, iri(SKOS + 'definition'), en(PROF_ROLLUP_COMMENT))
    .add(R, iri(`${TLA_NS}rollupRule`), str(perfRollupRuleText()))
    // The scale whose levels it assigns. Not skos:inScheme: a rule is not one of the scale's concepts.
    .add(R, iri(`${TLA_NS}onScale`), FW)
    .add(R, iri(CONSTRUCTION), str('minted'))
    .add(R, iri(RDFS + 'isDefinedBy'), O);
  // ★ THE BANDS ARE THE RULE, AND THEY ARE PUBLISHED AS THE RULE FILE'S OWN TRIPLES. The graph
  // `evaluateProficiency` walks is merged in verbatim — band thresholds, their comments, and the
  // declarations of the band vocabulary — so what /ns/adl-tla publishes cannot differ from what the
  // engine ran. Re-describing the bands here from the parsed numbers would be a second copy.
  // (The rollupRule SENTENCE above is generated from the same triples, for the same reason.)
  const rule = parseTurtle(loadProficiencyRuleTurtle());
  g.merge(rule);
  for (const t of rule.triples) {
    if (t.s.termType === 'NamedNode' && t.s.value.startsWith(TLA_NS)) g.add(t.s, iri(RDFS + 'isDefinedBy'), O);
  }
}

/**
 * The construction annotation. ★ A NOTION OF THE VERTICAL'S, NOT OF A STANDARD'S: it was a term of the
 * IEEE LER document, and the ADL TLA document's terms carried it too — a term of one standard's
 * formalization annotating another's. It is the Foxxi vocabulary's now (foxxi:construction); each
 * document declares it with MIREOT's minimum, and the LER document keeps its own, deprecated, so
 * what cites that still resolves.
 */
function addConstructionProperty(g: Graph, O: NamedNode, family: 'ler' | 'tla'): void {
  const C = iri(CONSTRUCTION);
  g.add(C, iri(RDF + 'type'), iri(OWL + 'AnnotationProperty'))
    .add(C, iri(RDFS + 'label'), en('construction'))
    .add(C, iri(RDFS + 'comment'), en(CONSTRUCTION_DEFINITION))
    .add(C, iri(RDFS + 'isDefinedBy'), iri(foxxiDocMeta().iri));
  if (family !== 'ler') return;
  const L = iri(LER_CONSTRUCTION);
  g.add(L, iri(RDF + 'type'), iri(OWL + 'AnnotationProperty'))
    .add(L, iri(RDFS + 'label'), en('obsolete construction'))
    .add(L, iri(RDFS + 'comment'), en(`${CONSTRUCTION_DEFINITION} Deprecated: the Foxxi vocabulary's construction (foxxi:construction) replaces it.`))
    .add(L, iri(SKOS + 'definition'), en(`${CONSTRUCTION_DEFINITION} Deprecated: the Foxxi vocabulary's construction (foxxi:construction) replaces it.`))
    // Kept with the axioms it was published with: none.
    .add(L, iri(OWL + 'deprecated'), typed('true', XSD + 'boolean'))
    .add(L, iri(DCT + 'isReplacedBy'), C)
    .add(L, iri(SKOS + 'changeNote'), en('2026.10.0: deprecated in favour of the Foxxi vocabulary\'s construction.'))
    .add(L, iri(RDFS + 'isDefinedBy'), O);
}

const _graphs = new Map<'ler' | 'tla', Graph>();

/** The complete OWL 2 DL ontology of one family. Built once per process: its inputs — the term
 *  data above and the memoised proficiency rule — do not change while it runs. Treat the result
 *  as read-only. */
export function semOntologyGraph(family: 'ler' | 'tla'): Graph {
  const hit = _graphs.get(family);
  if (hit) return hit;
  const g = buildSemOntologyGraph(family);
  _graphs.set(family, g);
  return g;
}

function buildSemOntologyGraph(family: 'ler' | 'tla'): Graph {
  const g = new Graph();
  const O = addHeader(g, semDocMeta(family));
  addConstructionProperty(g, O, family);
  for (const t of family === 'ler' ? LER_TERMS : TLA_TERMS) addTerm(g, t, O);
  if (family === 'tla') { addMom(g, O); addProficiency(g, O); }
  addDisjointness(g, family);
  const declared = declareExternalTerms(g, [family === 'ler' ? LER_NS : TLA_NS]);
  // The sibling document's terms this one uses get MIREOT's minimum here as other external terms do:
  // their label and the document that defines them. They were bare declarations.
  const sibling = family === 'ler' ? 'tla' : 'ler';
  const siblingNs = sibling === 'ler' ? LER_NS : TLA_NS;
  for (const u of [...declared.classes, ...declared.object, ...declared.datatype, ...declared.annotation]) {
    if (!u.startsWith(siblingNs)) continue;
    const local = u.slice(siblingNs.length);
    const label = TERM_INDEX.get(`${sibling}:${local}`)?.label;
    if (!label) throw new Error(`ler-tla-vocab: ${u} is used in /ns/${family === 'ler' ? 'ieee-ler' : 'adl-tla'} but defined nowhere`);
    if (!g.objects(iri(u), RDFS + 'label').length) g.add(iri(u), iri(RDFS + 'label'), en(label));
    g.add(iri(u), iri(RDFS + 'isDefinedBy'), iri(sibling === 'ler' ? LER_DOC : TLA_DOC));
  }
  return g;
}

// ── Serializations ───────────────────────────────────────────────────

/** Short keys the JSON-LD has always used for these documents (kept for JS consumers). */
const JSONLD_TERMS: Record<string, JsonLdTerm> = {
  label: { '@id': RDFS + 'label', '@language': 'en' },
  comment: { '@id': RDFS + 'comment', '@language': 'en' },
  source: { '@id': DCT + 'source' },
  construction: { '@id': CONSTRUCTION },
  subClassOf: { '@id': RDFS + 'subClassOf', '@type': '@id' },
  equivalentClass: { '@id': OWL + 'equivalentClass', '@type': '@id' },
  exactMatch: { '@id': SKOS + 'exactMatch', '@type': '@id' },
  closeMatch: { '@id': SKOS + 'closeMatch', '@type': '@id' },
  domain: { '@id': RDFS + 'domain', '@type': '@id' },
  range: { '@id': RDFS + 'range', '@type': '@id' },
  subPropertyOf: { '@id': RDFS + 'subPropertyOf', '@type': '@id' },
  inScheme: { '@id': SKOS + 'inScheme', '@type': '@id' },
  constructedFrom: { '@id': IEP_CONSTRUCTED_FROM, '@type': '@id' },
  isDefinedBy: { '@id': RDFS + 'isDefinedBy', '@type': '@id' },
  imports: { '@id': OWL + 'imports', '@type': '@id' },
  member: { '@id': SKOS + 'member', '@type': '@id' },
};
const docOf = (family: 'ler' | 'tla'): string => family === 'ler' ? LER_DOC : TLA_DOC;
const turtleHeader = (m: DocMeta): string[] => [
  `${m.title} — version ${m.version}`,
  `${m.iri}  (this version: ${versionIri(m)})`,
  'Generated from the Foxxi single-source term model; served with content negotiation as Turtle, RDF/XML, N-Triples, JSON-LD and HTML.',
];

/** A whole ontology as Turtle. */
export function renderSemOntologyTurtle(family: 'ler' | 'tla'): string {
  return toTurtle(semOntologyGraph(family), ALL_PREFIXES, { header: turtleHeader(semDocMeta(family)) });
}
export function renderSemOntologyNTriples(family: 'ler' | 'tla'): string { return toNTriples(semOntologyGraph(family)); }
export function renderSemOntologyRdfXml(family: 'ler' | 'tla'): string { return toRdfXml(semOntologyGraph(family), ALL_PREFIXES); }

/** A whole ontology (`ler` | `tla`) as a flat JSON-LD document — the same graph as the Turtle. */
export function renderSemOntologyJsonLd(family: 'ler' | 'tla'): Record<string, unknown> {
  // No HAL `_links` beside the @graph: JSON-LD drops them, so a processor in safe mode refused the
  // document. The response's Link header and the header triples (owl:versionIRI, rdfs:seeAlso the
  // counterpart family and the shapes) carry the same links.
  return toJsonLd(semOntologyGraph(family), ALL_PREFIXES, { terms: JSONLD_TERMS, first: [docOf(family)] });
}

/** Human-readable documentation (content negotiation: Accept: text/html). */
export function renderSemOntologyHtml(family: 'ler' | 'tla'): string {
  const meta = semDocMeta(family);
  return renderOntologyHtml({
    graph: semOntologyGraph(family), meta, prefixes: ALL_PREFIXES,
    links: [...alternates(meta.iri), { label: 'SHACL shapes', href: `${LER_DOC}/shapes`, type: 'text/turtle' }, { label: `this version (${meta.version})`, href: versionIri(meta) }],
  });
}

/** One term's triples (and the blank nodes they reach), or null for an unknown name. */
export function semTermGraph(family: 'ler' | 'tla', name: string): Graph | null {
  const full = (family === 'ler' ? LER_NS : TLA_NS) + name;
  const g = semOntologyGraph(family);
  if (!g.triples.some(t => t.s.termType === 'NamedNode' && t.s.value === full)) return null;
  const out = new Graph();
  const visit = (s: NamedNode | BlankNode, seen: Set<string>): void => {
    for (const t of g.triples) {
      if (t.s.termType !== s.termType || t.s.value !== s.value) continue;
      out.add(t.s, t.p, t.o);
      if (t.o.termType === 'BlankNode' && !seen.has(t.o.value)) { seen.add(t.o.value); visit(t.o, seen); }
    }
  };
  visit(iri(full), new Set());
  return out;
}

/** A single term as a JSON-LD resource (null → the route 404s); the route links it to its document
 *  in the Link header. Owning the namespace is not a licence to fabricate an rdfs:Resource for any
 *  string. */
export function renderSemTermJsonLd(family: 'ler' | 'tla', name: string): Record<string, unknown> | null {
  const tg = semTermGraph(family, name);
  if (!tg) return null;
  const full = (family === 'ler' ? LER_NS : TLA_NS) + name;
  const j = toJsonLd(tg, ALL_PREFIXES, { terms: JSONLD_TERMS, first: [full] });
  const [node, ...rest] = j['@graph'] as Array<Record<string, unknown>>;
  return { '@context': j['@context'], ...node!, '@id': full, ...(rest.length ? { '@included': rest } : {}) };
}
