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
 * Cross-standard identity (TLA Competency ≡ IEEE CompetencyDefinition ≡
 * CaSS Competency) is asserted with `owl:equivalentClass` /
 * `skos:exactMatch`, so the two families compose into one federated
 * layer rather than sitting side by side.
 *
 * Layer: L3 vertical vocabulary. Two scoped namespaces OUTSIDE the
 * protocol IRI space; the bridge serves both as dereferenceable linked
 * data, and production code paths actually GET them at runtime.
 */

// ── Namespace bases ──────────────────────────────────────────────────

const BRIDGE = 'https://foxxi-bridge.interego.xwisee.com';
/** IEEE Learning & Employment Records namespace. */
export const LER_NS = `${BRIDGE}/ns/ieee-ler#`;
/** ADL Total Learning Architecture namespace. */
export const TLA_NS = `${BRIDGE}/ns/adl-tla#`;
export const LER_DOC = LER_NS.replace(/#$/, '');
export const TLA_DOC = TLA_NS.replace(/#$/, '');

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
  domain?: string;
  range?: string;
  /** Cross-standard `owl:equivalentClass` targets (prefixed or absolute). */
  equivalentClass?: readonly string[];
  /** `skos:exactMatch` / `skos:closeMatch` to external published standards. */
  exactMatch?: readonly string[];
  /** Substrate primitives a composed/view/role term emerges from. */
  constructedFrom?: readonly string[];
  /** For `Concept` terms — the ConceptScheme it is `skos:inScheme`. */
  inScheme?: string;
  /** For `Concept` terms — the `skos:Collection` (MOM conformance level). */
  memberOf?: string;
}

// ── IEEE LER family ──────────────────────────────────────────────────

const LER_TERMS: readonly SemTerm[] = [
  // ── Competency core (minted — genuinely new vocabulary) ────────────
  {
    family: 'ler', name: 'CompetencyDefinition', kind: 'Class', construction: 'minted',
    label: 'Competency Definition',
    definition: 'A formal, context-neutral representation of one competency — a skill, knowledge, ability, attitude, habit of practice, or learning outcome — with a stable identity, a human-readable description, and optional structured statements.',
    source: 'IEEE 1484.20.1-2007 (RCD); IEEE 1484.20.3-2022 (SCD)',
    subClassOf: ['skos:Concept'],
    equivalentClass: ['tla:Competency'],
    exactMatch: ['https://schema.cassproject.org/0.4/Competency', 'http://purl.org/ctdlasn/terms/Competency'],
  },
  {
    family: 'ler', name: 'CompetencyStatement', kind: 'Class', construction: 'minted',
    label: 'Competency Statement',
    definition: 'A single structured assertion within a competency definition — statement text, an optional controlled-vocabulary token, and an identifier. RCD\'s decomposition of a competency into its constituent claims.',
    source: 'IEEE 1484.20.1-2007 (RCD) §definition/statement',
  },
  {
    family: 'ler', name: 'CompetencyFramework', kind: 'Class', construction: 'minted',
    label: 'Competency Framework',
    definition: 'A structured collection of competency definitions and the typed relationships between them — a blueprint of excellent performance.',
    source: 'IEEE 1484.20.3-2022 (SCD)',
    subClassOf: ['skos:ConceptScheme'],
    equivalentClass: ['tla:CompetencyFramework'],
  },
  {
    family: 'ler', name: 'CompetencyRelationship', kind: 'Class', construction: 'minted',
    label: 'Competency Relationship',
    definition: 'A typed, directed edge between two competency definitions — narrows, broadens, requires, is-enabled-by, is-equivalent-to.',
    source: 'IEEE 1484.20.3-2022 (SCD)',
    equivalentClass: ['tla:Relation'],
  },
  {
    family: 'ler', name: 'ProficiencyLevel', kind: 'Class', construction: 'minted',
    label: 'Proficiency Level',
    definition: 'An ordinal level of mastery a learner may attain on a competency — the scale an assertion is measured against.',
    source: 'IEEE 1484.20.1 (statementToken); IEEE 1484.20.3 (RubricLevel)',
    equivalentClass: ['tla:Level'],
  },
  {
    family: 'ler', name: 'Rubric', kind: 'Class', construction: 'minted',
    label: 'Rubric',
    definition: 'A structured set of evaluation criteria for assessing attainment of a competency.',
    source: 'IEEE 1484.20.3-2022 (SCD)',
  },
  {
    family: 'ler', name: 'RubricCriterion', kind: 'Class', construction: 'minted',
    label: 'Rubric Criterion',
    definition: 'A single dimension being assessed within a rubric.',
    source: 'IEEE 1484.20.3-2022 (SCD)',
  },

  // ── The Enterprise Learner Record — composed, not a content class ──
  {
    family: 'ler', name: 'EnterpriseLearnerRecord', kind: 'Class', construction: 'composed',
    label: 'Enterprise Learner Record',
    definition: 'The aggregate, enterprise-level record of one learner. P2997 defines it deliberately as a ledger / registry — it holds indications of where subordinate data lives, not the raw data. It therefore emerges as the union of its record entries, scoped to one learner, carrying provenance — not a monolithic class.',
    source: 'IEEE P2997 Part 1 (Enterprise Learner Record)',
    subClassOf: ['iep:ComposedDescriptor', 'prov:Collection'],
    constructedFrom: ['ler:RecordEntry', 'iep:ProvenanceFacet', 'iep:AgentFacet'],
    equivalentClass: ['tla:LearnerProfile'],
  },
  {
    family: 'ler', name: 'RecordEntry', kind: 'Class', construction: 'composed',
    label: 'Learner Record Entry',
    definition: 'A single record generated by one system about one learner with respect to one activity, linked to its performance evidence and aligned competency or credential. It IS an attestation — an agent asserting a claim about a learner — so it composes the substrate\'s attestation primitive rather than minting a new shape.',
    source: 'IEEE P2997 Part 1; ADL ELRR conceptual data model',
    subClassOf: ['amta:Attestation'],
    constructedFrom: ['amta:Attestation', 'iep:ProvenanceFacet'],
  },
  {
    family: 'ler', name: 'LearnerProfile', kind: 'Class', construction: 'composed',
    label: 'Learner Profile',
    definition: 'A per-learner container assembling demographics, competency and credential history, aptitudes, preferences, goals and career trajectory. A view-bearing aggregation keyed by a resolved learner identity.',
    source: 'IEEE P2997; ADL TLA Learner Management',
    subClassOf: ['iep:ComposedDescriptor'],
    constructedFrom: ['ler:EnterpriseLearnerRecord', 'iep:AgentFacet'],
  },
  {
    family: 'ler', name: 'Transcript', kind: 'Class', construction: 'view',
    label: 'Transcript',
    definition: 'The learner\'s permanent academic record — courses, dates, grades, degrees. A projection (query view) over the verified record entries of an Enterprise Learner Record, optionally re-packaged as a Comprehensive Learner Record credential.',
    source: 'IEEE P2997; 1EdTech CLR 2.0',
    constructedFrom: ['ler:EnterpriseLearnerRecord', 'iep:CompositionOperator'],
    exactMatch: ['https://purl.imsglobal.org/spec/clr/v2p0/ClrCredential'],
  },

  // ── Attestations + evidence (composed over the attestation primitive)
  {
    family: 'ler', name: 'CompetencyAssertion', kind: 'Class', construction: 'composed',
    label: 'Competency Assertion',
    definition: 'A claim, made by one party, that a learner can perform a competency at a stated proficiency level, with some confidence, backed by evidence. The same shape as a CaSS Assertion and a MOM `asserted` statement — one attestation primitive, three trust tiers.',
    source: 'IEEE P2997; ADL ELRR (Assertion)',
    subClassOf: ['amta:Attestation'],
    constructedFrom: ['amta:Attestation', 'iep:assertingAgent', 'iep:modalStatus'],
    equivalentClass: ['tla:Assertion'],
  },
  {
    family: 'ler', name: 'Evidence', kind: 'Class', construction: 'composed',
    label: 'Evidence',
    definition: 'Anything presented in support of an assertion of competency. Reuses the substrate\'s provenance entity — evidence is a prov:Entity that an assertion was derived from.',
    source: 'IEEE P2997; ADL ELRR (Evidence)',
    subClassOf: ['prov:Entity'],
    constructedFrom: ['prov:Entity', 'iep:provenanceChain'],
  },
  {
    family: 'ler', name: 'PerformanceRecord', kind: 'Class', construction: 'composed',
    label: 'Performance Record',
    definition: 'The learner-performance evidence underpinning a record entry. In practice an xAPI Statement (or a pointer to one in an LRS) — so it composes the substrate\'s event-record primitive directly.',
    source: 'IEEE P2997 (references IEEE 9274.1 xAPI)',
    subClassOf: ['hela:Statement'],
    constructedFrom: ['hela:Statement', 'hela:Trace'],
  },
  {
    family: 'ler', name: 'Credential', kind: 'Class', construction: 'composed',
    label: 'Credential',
    definition: 'An attestation of qualification, competence or authority issued by an authority. A signed attestation — i.e. a W3C Verifiable Credential whose subject carries one or more competency claims. Open Badges 3.0 and CLR 2.0 credentials are subtypes.',
    source: 'IEEE P2997; IEEE 1484.2-2024 (an LER IS a Verifiable Credential)',
    subClassOf: ['vc:VerifiableCredential', 'amta:Attestation'],
    constructedFrom: ['vc:VerifiableCredential', 'iep:verifiableCredential'],
    exactMatch: ['https://purl.imsglobal.org/spec/ob/v3p0/OpenBadgeCredential'],
  },
  {
    family: 'ler', name: 'Endorsement', kind: 'Class', construction: 'composed',
    label: 'Endorsement',
    definition: 'An attestation whose subject is itself another attestation, credential, or issuer — a party vouching for a claim or for a claimant. The attestation primitive applied reflexively.',
    source: 'IEEE P2997; Open Badges 3.0 EndorsementCredential',
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
    source: 'ADL ELRR §federated Identity Management',
    constructedFrom: ['iep:AgentFacet', 'iep:provenanceChain'],
  },

  // ── Roles (a generic Agent in a role — not a subclass of Person) ───
  {
    family: 'ler', name: 'Learner', kind: 'Class', construction: 'role',
    label: 'Learner',
    definition: 'The natural person who is the subject of a learner record and, in the LER ecosystem, curates and controls access to it. A role a prov:Agent plays — the same person is an Issuer in another record.',
    source: 'IEEE P2997; IEEE 1484.2-2024 (LER Holder)',
    subClassOf: ['prov:Agent'],
    constructedFrom: ['prov:Agent', 'iep:agentRole'],
  },
  {
    family: 'ler', name: 'Issuer', kind: 'Class', construction: 'role',
    label: 'Issuer',
    definition: 'The authority — an education, training, work-based provider or evaluator — that confers a credential or makes an assertion about a learner. A role of a prov:Agent.',
    source: 'IEEE P2997; IEEE 1484.2-2024 (LER Awarder)',
    subClassOf: ['prov:Agent'],
    constructedFrom: ['prov:Agent', 'iep:agentRole'],
  },
  {
    family: 'ler', name: 'Endorser', kind: 'Class', construction: 'role',
    label: 'Endorser',
    definition: 'A party that vouches for an issuer or for a credential. A role of a prov:Agent.',
    source: 'IEEE P2997; IEEE 1484.2-2024',
    subClassOf: ['prov:Agent'],
    constructedFrom: ['prov:Agent', 'iep:agentRole'],
  },
  {
    family: 'ler', name: 'Verifier', kind: 'Class', construction: 'role',
    label: 'Verifier',
    definition: 'A party — typically an employer — to whom a learner presents records for review. A role of a prov:Agent.',
    source: 'IEEE 1484.2-2024 (LER Reviewer)',
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
    source: 'IEEE P2997 Part 1',
    domain: 'ler:EnterpriseLearnerRecord', range: 'ler:RecordEntry',
    subPropertyOf: ['prov:hadMember'],
  },
  {
    family: 'ler', name: 'holder', kind: 'ObjectProperty', construction: 'minted',
    label: 'holder',
    definition: 'Relates an Enterprise Learner Record or credential to the Learner it is about.',
    source: 'IEEE P2997; IEEE 1484.2-2024',
    range: 'ler:Learner',
  },
  {
    family: 'ler', name: 'aboutCompetency', kind: 'ObjectProperty', construction: 'minted',
    label: 'about competency',
    definition: 'Relates a competency assertion to the competency definition it claims mastery of.',
    source: 'IEEE P2997 (Assertion)',
    domain: 'ler:CompetencyAssertion', range: 'ler:CompetencyDefinition',
  },
  {
    family: 'ler', name: 'atProficiency', kind: 'ObjectProperty', construction: 'minted',
    label: 'at proficiency',
    definition: 'Relates a competency assertion to the proficiency level claimed.',
    source: 'ADL ELRR (Proficiency)',
    domain: 'ler:CompetencyAssertion', range: 'ler:ProficiencyLevel',
  },
  {
    family: 'ler', name: 'supportedByEvidence', kind: 'ObjectProperty', construction: 'minted',
    label: 'supported by evidence',
    definition: 'Relates an assertion or record entry to the evidence presented in support of it.',
    source: 'IEEE P2997 (Evidence)',
    range: 'ler:Evidence',
    subPropertyOf: ['prov:wasDerivedFrom'],
  },
  {
    family: 'ler', name: 'issuedBy', kind: 'ObjectProperty', construction: 'minted',
    label: 'issued by',
    definition: 'Relates a credential or assertion to the Issuer that conferred it.',
    source: 'IEEE P2997',
    range: 'ler:Issuer',
  },
  {
    family: 'ler', name: 'frameworkMember', kind: 'ObjectProperty', construction: 'minted',
    label: 'framework member',
    definition: 'Relates a competency framework to a competency definition it contains.',
    source: 'IEEE 1484.20.3-2022',
    domain: 'ler:CompetencyFramework', range: 'ler:CompetencyDefinition',
  },
  {
    family: 'ler', name: 'recordStatus', kind: 'DatatypeProperty', construction: 'minted',
    label: 'record status',
    definition: 'The status of a learner record entry within the ledger — one of success, partial, failure.',
    source: 'ADL ELRR (Status)',
    domain: 'ler:RecordEntry',
  },
];

// ── ADL TLA family ───────────────────────────────────────────────────

const TLA_TERMS: readonly SemTerm[] = [
  // ── Competency pillar (CaSS model) ─────────────────────────────────
  {
    family: 'tla', name: 'Competency', kind: 'Class', construction: 'minted',
    label: 'Competency',
    definition: 'A skill, knowledge, ability, trait, or combination required to perform a task or job — the common currency that gives the four TLA data pillars a shared semantics.',
    source: 'ADL TLA Competency pillar; CaSS schema 0.4',
    subClassOf: ['skos:Concept'],
    equivalentClass: ['ler:CompetencyDefinition'],
    exactMatch: ['https://schema.cassproject.org/0.4/Competency'],
  },
  {
    family: 'tla', name: 'CompetencyFramework', kind: 'Class', construction: 'minted',
    label: 'Competency Framework',
    definition: 'A structured, directed graph of competencies with typed relations, levels and roll-up rules.',
    source: 'ADL TLA; CaSS schema 0.4 (Framework)',
    subClassOf: ['skos:ConceptScheme'],
    equivalentClass: ['ler:CompetencyFramework'],
  },
  {
    family: 'tla', name: 'Relation', kind: 'Class', construction: 'minted',
    label: 'Competency Relation',
    definition: 'A typed edge between two competencies — narrows, broadens, requires, is-related-to, is-equivalent-to — with an optional validity window.',
    source: 'CaSS schema 0.4 (Relation)',
    equivalentClass: ['ler:CompetencyRelationship'],
  },
  {
    family: 'tla', name: 'Level', kind: 'Class', construction: 'minted',
    label: 'Proficiency Level',
    definition: 'A named proficiency level or assessment criterion attached to a competency.',
    source: 'CaSS schema 0.4 (Level)',
    equivalentClass: ['ler:ProficiencyLevel'],
  },
  {
    family: 'tla', name: 'RollupRule', kind: 'Class', construction: 'minted',
    label: 'Roll-up Rule',
    definition: 'A rule for deriving a competency\'s attainment state from the states of its sub-competencies — the competency-graph analogue of cmi5 move-on logic.',
    source: 'CaSS schema 0.4 (RollupRule)',
  },
  {
    family: 'tla', name: 'MoveOnRule', kind: 'Class', construction: 'minted',
    label: 'Move-On Rule',
    definition: 'The criterion (Passed, Completed, CompletedAndPassed, CompletedOrPassed, NotApplicable) that decides whether a learner has satisfied an activity well enough to advance. TLA generalises cmi5 move-on into its Control Loop 2.',
    source: 'cmi5; ADL TLA Control Loops',
  },
  {
    family: 'tla', name: 'Assertion', kind: 'Class', construction: 'composed',
    label: 'Competency Assertion',
    definition: 'A CaSS assertion: a declaration by one party that a subject can perform a competency at a level, with a confidence in [-1,1], over a timespan, backed by evidence. The same attestation primitive as an IEEE record entry — confidence and evidence are facets, not new shapes.',
    source: 'CaSS schema 0.4 (Assertion); MOM `asserted` verb',
    subClassOf: ['amta:Attestation'],
    constructedFrom: ['amta:Attestation', 'amta:CompetenceRating', 'iep:modalStatus'],
    equivalentClass: ['ler:CompetencyAssertion'],
  },

  // ── Learning-activity-metadata pillar ──────────────────────────────
  {
    family: 'tla', name: 'LearningActivityMetadata', kind: 'Class', construction: 'composed',
    label: 'Learning Activity Metadata',
    definition: 'A typed metadata descriptor of a learning resource — course, section, activity or content object. The substrate\'s resource-descriptor primitive specialised for learning resources.',
    source: 'IEEE P2881 Learning Activity Metadata (extends IEEE 1484.12.1 LOM)',
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
    source: 'ADL Master Object Model (MOM_Spec.md)',
    subClassOf: ['iep:ContextDescriptor'],
    constructedFrom: ['hela:Statement', 'hela:Verb'],
  },
  {
    family: 'tla', name: 'LearnerProfile', kind: 'Class', construction: 'composed',
    label: 'Learner Profile / Enterprise Learner Record',
    definition: 'Each learner\'s aggregate competency level, credentials, aptitudes, preferences, goals and career trajectory. The TLA pillar that the IEEE P2997 study group grew from — equivalent to the IEEE Enterprise Learner Record.',
    source: 'ADL TLA Learner Profile pillar; ADL ELRR',
    subClassOf: ['iep:ComposedDescriptor'],
    constructedFrom: ['hela:Statement', 'iep:AgentFacet'],
    equivalentClass: ['ler:EnterpriseLearnerRecord'],
  },

  // ── The three federated LRS tiers — VIEWS, not three data stores ───
  {
    family: 'tla', name: 'NoisyLRS', kind: 'Class', construction: 'view',
    label: 'Noisy LRS',
    definition: 'The tier holding every raw xAPI statement, with data ownership retained by the activity owner. A view over the statement set — the unfiltered partition.',
    source: 'ADL TLA federated LRS layer',
    constructedFrom: ['hela:Statement', 'hela:Trace'],
  },
  {
    family: 'tla', name: 'TransactionalLRS', kind: 'Class', construction: 'view',
    label: 'Transactional LRS',
    definition: 'The tier holding only the normalised MOM roll-up verbs — the evidence base for competency inference. A restriction view over the statement set, partitioned by verb-set.',
    source: 'ADL TLA federated LRS layer',
    constructedFrom: ['hela:Statement', 'hela:Verb', 'iep:CompositionOperator'],
  },
  {
    family: 'tla', name: 'AuthoritativeLRS', kind: 'Class', construction: 'view',
    label: 'Authoritative LRS',
    definition: 'The tier holding only digitally-signed competency-assertion and career verbs, access-restricted. A restriction view partitioned by verb-set, trust tier and signature.',
    source: 'ADL TLA federated LRS layer',
    constructedFrom: ['hela:Statement', 'iep:TrustFacet', 'iep:CompositionOperator'],
  },

  // ── Learner state — VIEWS over the MOM statement stream ────────────
  {
    family: 'tla', name: 'LearnerState', kind: 'Class', construction: 'view',
    label: 'Learner State',
    definition: 'A learner\'s current state — the materialised projection of the latest MOM statement per state dimension. A function of the event log, not stored vocabulary.',
    source: 'ADL TLA / MOM learner-state machines',
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
    label: 'Competency Management Service (CaSS)',
    definition: 'The service that reads MOM statements from the Transactional LRS, joins actor to learner and object to activity-metadata-to-competency, estimates proficiency and emits signed assertions.',
    source: 'ADL TLA Competency Management (CaSS)',
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
    definition: 'Relates a CaSS assertion to the competency it asserts.',
    source: 'CaSS schema 0.4',
    domain: 'tla:Assertion', range: 'tla:Competency',
  },
  {
    family: 'tla', name: 'confidence', kind: 'DatatypeProperty', construction: 'minted',
    label: 'confidence',
    definition: 'The asserting party\'s confidence in a competency assertion, a decimal in [-1, 1].',
    source: 'CaSS schema 0.4 (Assertion.confidence); MOM context extension',
    domain: 'tla:Assertion',
  },
  {
    family: 'tla', name: 'decayFunction', kind: 'DatatypeProperty', construction: 'minted',
    label: 'decay function',
    definition: 'A function describing how the confidence of a competency assertion decays over time.',
    source: 'CaSS schema 0.4 (Assertion.decayFunction)',
    domain: 'tla:Assertion',
  },
  {
    family: 'tla', name: 'relationType', kind: 'DatatypeProperty', construction: 'minted',
    label: 'relation type',
    definition: 'The type of a competency relation — narrows, broadens, requires, isEnabledBy, isEquivalentTo.',
    source: 'CaSS schema 0.4 (Relation.relationType)',
    domain: 'tla:Relation',
  },
  {
    family: 'tla', name: 'rollupRule', kind: 'DatatypeProperty', construction: 'minted',
    label: 'roll-up rule expression',
    definition: 'The rule expression a roll-up rule evaluates against sub-competency states.',
    source: 'CaSS schema 0.4 (RollupRule.rule)',
    domain: 'tla:RollupRule',
  },
];

// ── MOM concept scheme — verbs, activity types, context extensions ──
//
// The 49 MOM verbs are not classes; they are SKOS concepts in the
// `tla:MOMVerbScheme`, grouped into five `skos:Collection` conformance
// levels. Importing them as a concept scheme — rather than a class
// hierarchy — is the correct modelling per the research finding.

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

/** Evaluate the published tla:PerformanceProficiencyRollupRule against evidence. */
export function evaluateProficiency(input: RollupInput): RollupResult {
  const { basis, executions, successes } = input;
  const q = input.avgQuality;
  const rate = executions > 0 ? successes / executions : 0;
  let name = 'Novice';
  if (basis === 'performance') {
    if (executions >= 12 && rate >= 0.9 && (q === undefined || q >= 0.85)) name = 'Expert';
    else if (executions >= 6 && rate >= 0.8 && (q === undefined || q >= 0.7)) name = 'Proficient';
    else if (executions >= 3 && rate >= 0.66) name = 'Competent';
    else if (successes >= 1) name = 'AdvancedBeginner';
    else name = 'Novice';
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

/** The human-readable rule expression published as tla:rollupRule. */
export const PERF_ROLLUP_RULE_TEXT =
  'Given production performance evidence (n executions carrying an asserted outcome, k successes, mean scored quality q in 0..1): ' +
  'Expert if n>=12 and k/n>=0.90 and (q undefined or q>=0.85); Proficient if n>=6 and k/n>=0.80 and (q undefined or q>=0.70); ' +
  'Competent if n>=3 and k/n>=0.66; Advanced Beginner if k>=1; else Novice. ' +
  'A verified credential with no production evidence maps to Competent; training completion only maps to Novice (Hypothetical). ' +
  'Confidence is the Wilson score interval lower bound (z=1.96) on k/n.';

function renderProficiencyTurtle(): string {
  const fw = `tla:PerformanceProficiencyFramework a tla:CompetencyFramework , skos:ConceptScheme ;
    rdfs:label "Foxxi Production-Performance Proficiency Framework" ;
    rdfs:comment "A published proficiency scale for on-the-job production performance, using the Dreyfus five-stage model of skill acquisition. The tla:Level individuals below are the dereferenceable scale an ELR competency assertion is measured against (ler:atProficiency)." ;
    dct:source "Dreyfus, S.E. & Dreyfus, H.L. (1980) — A Five-Stage Model of the Mental Activities Involved in Directed Skill Acquisition" ;
    ler:construction "minted" ;
    rdfs:isDefinedBy <${TLA_DOC}> .`;
  const levels = PROFICIENCY_LEVELS.map(l =>
    `tla:Level${l.name} a tla:Level , ler:ProficiencyLevel , skos:Concept ;
    rdfs:label "${esc(l.label)}" ;
    rdfs:comment "${esc(l.comment)}" ;
    skos:inScheme tla:PerformanceProficiencyFramework ;
    skos:notation "${l.rank}" ;
    ler:construction "concept" ;
    rdfs:isDefinedBy <${TLA_DOC}> .`).join('\n\n');
  const rule = `tla:PerformanceProficiencyRollupRule a tla:RollupRule ;
    rdfs:label "Production-performance proficiency roll-up rule" ;
    rdfs:comment "Maps a subject's production-performance evidence to a proficiency level in the Foxxi Production-Performance Proficiency Framework, with a confidence. Cited by every performance-basis ler:CompetencyAssertion the ELR emits." ;
    tla:rollupRule "${esc(PERF_ROLLUP_RULE_TEXT)}" ;
    skos:inScheme tla:PerformanceProficiencyFramework ;
    ler:construction "minted" ;
    rdfs:isDefinedBy <${TLA_DOC}> .`;
  return `${fw}\n\n${levels}\n\n${rule}`;
}

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

// ── Turtle rendering ─────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/** Resolve a possibly-prefixed name to a Turtle term (prefixed or <IRI>). */
function ttlRef(ref: string): string {
  if (ref.startsWith('http://') || ref.startsWith('https://')) return `<${ref}>`;
  return ref; // already prefixed (iep:, prov:, ler:, tla:, skos:, vc:, amta:, hela:)
}

function prefixHeader(): string {
  return Object.entries(PREFIXES)
    .map(([p, iri]) => `@prefix ${p}: <${iri}> .`)
    .join('\n') + '\n';
}

function renderTermTurtle(t: SemTerm): string {
  const self = `${t.family}:${t.name}`;
  const lines: string[] = [];
  const rdfType = t.kind === 'Class' ? 'owl:Class'
    : t.kind === 'ObjectProperty' ? 'owl:ObjectProperty'
    : t.kind === 'DatatypeProperty' ? 'owl:DatatypeProperty'
    : t.kind === 'Collection' ? 'skos:Collection' : 'skos:Concept';
  lines.push(`${self} a ${rdfType} ;`);
  lines.push(`    rdfs:label "${esc(t.label)}" ;`);
  lines.push(`    rdfs:comment "${esc(t.definition)}" ;`);
  lines.push(`    dct:source "${esc(t.source)}" ;`);
  // The emergent-composable facet — machine-readable.
  lines.push(`    ler:construction "${t.construction}" ;`);
  for (const sc of t.subClassOf ?? []) lines.push(`    rdfs:subClassOf ${ttlRef(sc)} ;`);
  for (const sp of t.subPropertyOf ?? []) lines.push(`    rdfs:subPropertyOf ${ttlRef(sp)} ;`);
  if (t.domain) lines.push(`    rdfs:domain ${ttlRef(t.domain)} ;`);
  if (t.range) lines.push(`    rdfs:range ${ttlRef(t.range)} ;`);
  for (const eq of t.equivalentClass ?? []) lines.push(`    owl:equivalentClass ${ttlRef(eq)} ;`);
  for (const xm of t.exactMatch ?? []) lines.push(`    skos:exactMatch ${ttlRef(xm)} ;`);
  // A composed / view / role term names the substrate primitives it
  // emerges from — the "emergent composable" claim, in RDF.
  for (const cf of t.constructedFrom ?? []) lines.push(`    iep:constructedFrom ${ttlRef(cf)} ;`);
  lines.push(`    rdfs:isDefinedBy <${t.family === 'ler' ? LER_DOC : TLA_DOC}> .`);
  return lines.join('\n');
}

function renderOntologyTurtle(family: 'ler' | 'tla'): string {
  const terms = family === 'ler' ? LER_TERMS : TLA_TERMS;
  const doc = family === 'ler' ? LER_DOC : TLA_DOC;
  const title = family === 'ler'
    ? 'IEEE Learning & Employment Records — emergent composable ontology'
    : 'ADL Total Learning Architecture — emergent composable ontology';
  const blurb = family === 'ler'
    ? 'An OWL vocabulary for the IEEE LER family (P2997 Enterprise Learner Record, 1484.20.1 RCD, 1484.20.3 SCD, 1484.2 LER Ecosystems), modelled as compositions over the Interego substrate: most concepts are aggregations, views or roles over the substrate\'s attestation, event-record, resource-descriptor and aggregation primitives, not new classes.'
    : 'An OWL vocabulary for the ADL TLA (the four data pillars, the Master Object Model, the CaSS competency model, the federated LRS tiers and the learner-state machines), modelled as compositions over the Interego substrate. The three LRS tiers and the learner-state machines are rendered as views, not stores.';
  let out = prefixHeader() + '\n';
  out += `<${doc}> a owl:Ontology ;
    rdfs:label "${esc(title)}" ;
    rdfs:comment "${esc(blurb)}" ;
    owl:imports <${PREFIXES.cg}> .\n\n`;
  // The annotation property that carries the emergent-composable facet.
  // Defined once, in the IEEE-LER ontology; the ADL-TLA ontology reuses
  // it (a dereferencing client follows it back here) — the two ontologies
  // are one composable layer, so a shared annotation is correct.
  if (family === 'ler') {
    out += `ler:construction a owl:AnnotationProperty ;
    rdfs:label "construction" ;
    rdfs:comment "How a term relates to the Interego substrate: minted (genuinely new vocabulary), composed (an aggregation over substrate primitives), view (a query projection), role (a role a generic Agent plays), or concept (a SKOS code-list value)." ;
    rdfs:isDefinedBy <${LER_DOC}> .\n\n`;
  }
  out += terms.map(renderTermTurtle).join('\n\n');
  if (family === 'tla') out += '\n\n' + renderMomTurtle() + '\n\n' + renderProficiencyTurtle();
  return out + '\n';
}

function renderMomTurtle(): string {
  const scheme = `tla:MOMVerbScheme a skos:ConceptScheme ;
    rdfs:label "ADL MOM verb scheme" ;
    rdfs:comment "The ${MOM_VERBS.length} Master Object Model xAPI verbs. Grouped here into five thematic levels — this project's own pedagogical organisation over the ADL MOM verb set (completion, session lifecycle, competency assertion, adaptive paths, career), NOT ADL-defined numbered conformance levels. Each verb skos:exactMatch-es its canonical registry IRI." ;
    rdfs:isDefinedBy <${TLA_DOC}> .`;
  const levels = [1, 2, 3, 4, 5].map(lvl =>
    `tla:MOMLevel${lvl} a skos:Collection ;
    rdfs:label "${esc(MOM_LEVEL_LABEL[lvl]!)}" ;
    skos:inScheme tla:MOMVerbScheme .`,
  ).join('\n\n');
  const concepts = MOM_CONCEPTS.map(c => {
    const lines = [`tla:${c.name} a skos:Concept ;`];
    lines.push(`    rdfs:label "${esc(c.label)}" ;`);
    lines.push(`    ler:construction "concept" ;`);
    if (c.scheme === 'verb') {
      lines.push(`    skos:inScheme tla:MOMVerbScheme ;`);
      lines.push(`    skos:exactMatch <https://w3id.org/xapi/tla/verbs/${c.label}> ;`);
      lines.push(`    skos:member tla:MOMLevel${c.level} ;`);
    } else if (c.scheme === 'activityType') {
      lines.push(`    skos:exactMatch <https://w3id.org/xapi/tla/activity-types/${c.label}> ;`);
    } else {
      lines.push(`    skos:exactMatch <https://w3id.org/xapi/tla/extensions/${c.label}> ;`);
    }
    lines.push(`    rdfs:isDefinedBy <${TLA_DOC}> .`);
    return lines.join('\n');
  }).join('\n\n');
  return `${scheme}\n\n${levels}\n\n${concepts}`;
}

// ── JSON-LD rendering ────────────────────────────────────────────────

const JSONLD_CONTEXT: Record<string, unknown> = {
  rdfs: PREFIXES.rdfs, owl: PREFIXES.owl, skos: PREFIXES.skos, dct: PREFIXES.dct,
  iep: PREFIXES.cg, prov: PREFIXES.prov, vc: PREFIXES.vc, amta: PREFIXES.amta,
  hela: PREFIXES.hela, ler: LER_NS, tla: TLA_NS,
  label: 'rdfs:label', comment: 'rdfs:comment', source: 'dct:source',
  construction: 'ler:construction',
  subClassOf: { '@id': 'rdfs:subClassOf', '@type': '@id' },
  equivalentClass: { '@id': 'owl:equivalentClass', '@type': '@id' },
  exactMatch: { '@id': 'skos:exactMatch', '@type': '@id' },
  constructedFrom: { '@id': 'iep:constructedFrom', '@type': '@id' },
  isDefinedBy: { '@id': 'rdfs:isDefinedBy', '@type': '@id' },
};

function jsonldExpand(ref: string): string {
  return ref; // JSON-LD keeps the prefixed/absolute form; the context resolves it.
}

function termJsonLd(t: SemTerm): Record<string, unknown> {
  const ns = t.family === 'ler' ? LER_NS : TLA_NS;
  const doc = t.family === 'ler' ? LER_DOC : TLA_DOC;
  const node: Record<string, unknown> = {
    '@id': `${ns}${t.name}`,
    '@type': t.kind === 'Class' ? 'owl:Class'
      : t.kind === 'ObjectProperty' ? 'owl:ObjectProperty'
      : t.kind === 'DatatypeProperty' ? 'owl:DatatypeProperty' : 'skos:Concept',
    label: t.label,
    comment: t.definition,
    source: t.source,
    construction: t.construction,
    isDefinedBy: doc,
  };
  if (t.subClassOf) node.subClassOf = t.subClassOf.map(jsonldExpand);
  if (t.equivalentClass) node.equivalentClass = t.equivalentClass.map(jsonldExpand);
  if (t.exactMatch) node.exactMatch = [...t.exactMatch];
  if (t.constructedFrom) node.constructedFrom = t.constructedFrom.map(jsonldExpand);
  node._links = { self: { href: `${doc}/term/${t.name}` }, ontology: { href: doc } };
  return node;
}

/** A whole ontology (`ler` | `tla`) as a JSON-LD document. */
export function renderSemOntologyJsonLd(family: 'ler' | 'tla'): Record<string, unknown> {
  const terms = family === 'ler' ? LER_TERMS : TLA_TERMS;
  const doc = family === 'ler' ? LER_DOC : TLA_DOC;
  const nodes = terms.map(termJsonLd);
  if (family === 'tla') {
    for (const c of MOM_CONCEPTS) {
      nodes.push({
        '@id': `${TLA_NS}${c.name}`,
        '@type': 'skos:Concept',
        label: c.label,
        construction: 'concept',
        isDefinedBy: doc,
      });
    }
    // The published proficiency framework + levels + roll-up rule.
    nodes.push({
      '@id': PERF_FRAMEWORK_IRI, '@type': ['tla:CompetencyFramework', 'skos:ConceptScheme'],
      label: 'Foxxi Production-Performance Proficiency Framework',
      comment: 'A published proficiency scale (Dreyfus five-stage model) an ELR competency assertion is measured against.',
      source: 'Dreyfus & Dreyfus (1980)', construction: 'minted', isDefinedBy: doc,
    });
    for (const l of PROFICIENCY_LEVELS) {
      nodes.push({
        '@id': proficiencyLevelIri(l.name), '@type': ['tla:Level', 'ler:ProficiencyLevel', 'skos:Concept'],
        label: l.label, comment: l.comment, construction: 'concept',
        'skos:inScheme': PERF_FRAMEWORK_IRI, 'skos:notation': String(l.rank), isDefinedBy: doc,
      });
    }
    nodes.push({
      '@id': PERF_ROLLUP_RULE_IRI, '@type': 'tla:RollupRule',
      label: 'Production-performance proficiency roll-up rule',
      comment: 'Maps production-performance evidence to a proficiency level with a Wilson-lower-bound confidence; cited by every performance-basis ler:CompetencyAssertion.',
      'tla:rollupRule': PERF_ROLLUP_RULE_TEXT, construction: 'minted', isDefinedBy: doc,
    });
  }
  return {
    '@context': JSONLD_CONTEXT,
    '@id': doc,
    '@type': 'owl:Ontology',
    label: family === 'ler'
      ? 'IEEE Learning & Employment Records — emergent composable ontology'
      : 'ADL Total Learning Architecture — emergent composable ontology',
    comment: 'Modelled as compositions over the Interego substrate — minted terms are genuinely new; composed / view / role terms carry iep:constructedFrom triples naming the primitives they emerge from.',
    termCount: nodes.length,
    terms: nodes,
    _links: {
      self: { href: doc },
      counterpart: { href: family === 'ler' ? TLA_DOC : LER_DOC },
    },
  };
}

/** A whole ontology as Turtle. */
export function renderSemOntologyTurtle(family: 'ler' | 'tla'): string {
  return renderOntologyTurtle(family);
}

/** A single term as a JSON-LD resource with HATEOAS `_links`. */
export function renderSemTermJsonLd(family: 'ler' | 'tla', name: string): Record<string, unknown> {
  const doc = family === 'ler' ? LER_DOC : TLA_DOC;
  const ns = family === 'ler' ? LER_NS : TLA_NS;
  const t = lookupSemTerm(family, name);
  if (t) return { '@context': JSONLD_CONTEXT, ...termJsonLd(t) };
  const mom = family === 'tla' ? MOM_CONCEPTS.find(c => c.name === name) : undefined;
  if (mom) {
    return {
      '@context': JSONLD_CONTEXT,
      '@id': `${ns}${name}`,
      '@type': 'skos:Concept',
      label: mom.label,
      construction: 'concept',
      isDefinedBy: doc,
      _links: { self: { href: `${doc}/term/${name}` }, ontology: { href: doc } },
    };
  }
  // The bridge owns these namespaces — an unknown fragment never 404s; it
  // resolves to a minimal record pointing back at the ontology.
  return {
    '@context': JSONLD_CONTEXT,
    '@id': `${ns}${name}`,
    '@type': 'rdfs:Resource',
    label: name,
    comment: 'A term in this ontology with no expanded definition on record — see the ontology index.',
    isDefinedBy: doc,
    _links: { self: { href: `${doc}/term/${name}` }, ontology: { href: doc } },
  };
}
