/**
 * IEEE-LER competency-assertion + credential SHACL shapes.
 *
 * The IEEE-LER / ADL-TLA vocabulary (src/ler-tla-vocab.ts) publishes the OWL
 * terms but no machine-checkable shapes. This model adds the SHACL layer, using
 * the SAME single-source OntologyModel → renderSpecShacl → validateAgainstShape
 * engine that powers /ns/xapi/validate — so a competency assertion (the real
 * output of the ELR rollup) and a credential can be validated to pass/fail with
 * a cited sh:NodeShape IRI. No new validation engine: this is data.
 *
 * The shape `path`s are the JSON field names the ELR assertion / credential
 * actually carry, so a real assembled record conforms; each shape's targetClass
 * is the published ler:/ob3: class the instance declares.
 */
import { type OntologyModel, shapesIri, type ValidationResult } from '../spec-ontology.js';
import { validateInstanceWith } from './index.js';

// ── IEEE-LER: competency assertion + evidence ───────────────────────────────
export const LER_MODEL: OntologyModel = {
  module: 'ieee-ler',
  title: 'IEEE-LER competency-assertion SHACL shapes',
  description: 'SHACL shapes for the IEEE Learning & Employment Records competency assertion and its evidence — the machine-checkable layer over the /ns/ieee-ler OWL vocabulary. A conforming instance is exactly what the Foxxi ELR rollup emits.',
  version: '1.0.0',
  spec: 'https://standards.ieee.org/ieee/2997/',
  prefixes: {
    ler: 'https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#',
    tla: 'https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#',
  },
  classes: [
    { name: 'EnterpriseLearnerRecord', label: 'Enterprise Learner Record', comment: 'The IEEE P2997 aggregate record of one subject: its conformsTo, subject identity, organisation path, competencies, and provenance raw-data-location indications.' },
    { name: 'CompetencyAssertion', label: 'Competency Assertion', comment: 'A claim that a subject holds a competency at a proficiency level, with a confidence, backed by dereferenceable evidence, produced by a published roll-up rule.', equivalentClass: ['tla:Assertion'] },
    { name: 'Evidence', label: 'Evidence', comment: 'A dereferenceable artifact presented in support of a competency assertion.' },
  ],
  properties: [
    { name: 'subject', label: 'subject', comment: 'The learner/agent the assertion is ABOUT (the record subject) — distinct from the asserting agent.', kind: 'object' },
    { name: 'aboutCompetency', label: 'about competency', comment: 'The competency definition IRI the assertion is about.', kind: 'object' },
    { name: 'proficiencyLevel', label: 'at proficiency', comment: 'The dereferenceable ler:ProficiencyLevel / tla:Level IRI claimed.', kind: 'object' },
    { name: 'confidence', label: 'confidence', comment: 'Confidence in the assertion, 0..1 (Wilson lower bound on the success rate).', kind: 'datatype' },
    { name: 'rolledUpBy', label: 'rolled up by', comment: 'The published tla:RollupRule IRI that produced the level + confidence.', kind: 'object' },
    { name: 'assertingAgent', label: 'asserting agent', comment: 'The agent making the assertion.', kind: 'object' },
    { name: 'evidence', label: 'supported by evidence', comment: 'Dereferenceable evidence IRIs.', kind: 'object' },
    { name: 'basis', label: 'basis', comment: 'The strongest evidence class: performance | credential | inferred.', kind: 'datatype' },
    { name: 'modalStatus', label: 'modal status', comment: 'Asserted (demonstrated/credentialed) or Hypothetical (inferred).', kind: 'datatype' },
  ],
  shapes: [
    {
      name: 'EnterpriseLearnerRecordShape', targetClass: 'EnterpriseLearnerRecord',
      label: 'Enterprise Learner Record shape',
      comment: 'A well-formed IEEE P2997 ELR: a dereferenceable id, a conformsTo, a subject kind + learner identity, an organisation path, and provenance raw-data-location indications (the P2997 hallmark).',
      constraints: [
        { path: 'id', minCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'A dereferenceable https record id.' },
        { path: 'conformsTo', minCount: 1, hasValue: 'https://standards.ieee.org/ieee/2997/', comment: 'Must cite the dereferenceable IEEE P2997 spec IRI.' },
        { path: 'subjectKind', minCount: 1, in: ['human', 'agent'], comment: 'human learner/performer or AI agent.' },
        { path: 'learner.did', minCount: 1, nodeKind: 'IRI', comment: 'The subject identity (a dereferenceable DID/URL).' },
        { path: 'organizationPath', minCount: 1, comment: 'P2997 organisation path.' },
        { path: 'provenance.rawDataLocations', minCount: 1, comment: 'P2997 raw-data-location indications — where each class of raw data lives.' },
      ],
    },
    {
      name: 'CompetencyAssertionShape', targetClass: 'CompetencyAssertion',
      label: 'Competency Assertion shape',
      comment: 'A well-formed IEEE-LER competency assertion: ABOUT a subject and a competency, at a dereferenceable proficiency level, with a confidence in 0..1, produced by a named roll-up rule, backed by at least one dereferenceable evidence IRI.',
      constraints: [
        { path: 'subject', minCount: 1, nodeKind: 'IRI', comment: 'The subject the assertion is about — a dereferenceable id (DID/URL), not a bare literal.' },
        { path: 'aboutCompetency', minCount: 1, maxCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'ler:aboutCompetency — a dereferenceable https competency definition IRI.' },
        { path: 'proficiencyLevel', minCount: 1, maxCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'ler:atProficiency — a dereferenceable https proficiency-level IRI.' },
        { path: 'confidence', minCount: 1, maxCount: 1, datatype: 'xsd:double', minInclusive: 0, maxInclusive: 1, comment: 'ler:successConfidence — a Wilson-lower-bound success confidence in [0,1] (a non-negative sub-range of tla:confidence [-1,1]); a JSON float → xsd:double.' },
        { path: 'rolledUpBy', minCount: 1, maxCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'The dereferenceable https tla:RollupRule IRI that produced this assertion.' },
        { path: 'assertingAgent', minCount: 1, nodeKind: 'IRI', comment: 'iep:assertingAgent — a dereferenceable agent id (DID/URL).' },
        { path: 'evidence', minCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'ler:supportedByEvidence — at least one dereferenceable https evidence IRI.' },
        { path: 'basis', minCount: 1, in: ['performance', 'credential', 'inferred'], comment: 'The evidence class.' },
        { path: 'modalStatus', minCount: 1, in: ['Asserted', 'Hypothetical'], comment: 'The modal status.' },
      ],
    },
    {
      name: 'EvidenceShape', targetClass: 'Evidence',
      label: 'Evidence shape',
      comment: 'A well-formed evidence node — a dereferenceable IRI locating the raw record.',
      constraints: [
        { path: 'id', minCount: 1, nodeKind: 'IRI', comment: 'The dereferenceable evidence location.' },
      ],
    },
  ],
};

// ── Open Badges 3.0 / W3C VC credential shape ───────────────────────────────
export const OB3_MODEL: OntologyModel = {
  module: 'ob3',
  title: 'Open Badges 3.0 credential SHACL shapes',
  description: 'SHACL shapes for a 1EdTech Open Badges 3.0 / W3C Verifiable Credential carrying a competency achievement — the machine-checkable layer over the credentials the Foxxi bridge issues.',
  version: '1.0.0',
  spec: 'https://www.imsglobal.org/spec/ob/v3p0/',
  prefixes: { ob3: 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json#' },
  classes: [
    { name: 'OpenBadgeCredential', label: 'Open Badge Credential', comment: 'A W3C Verifiable Credential (Open Badges 3.0) whose credentialSubject carries an achievement.' },
    { name: 'Achievement', label: 'Achievement', comment: 'The OB3.0 achievement the badge attests (type + name required).' },
  ],
  properties: [
    { name: 'issuer', label: 'issuer', comment: 'The credential issuer.', kind: 'object' },
    { name: 'credentialSubject', label: 'credential subject', comment: 'The subject (holder + achievement).', kind: 'object' },
    { name: 'proof', label: 'proof', comment: 'The cryptographic proof.', kind: 'object' },
  ],
  shapes: [
    {
      name: 'OpenBadgeCredentialShape', targetClass: 'OpenBadgeCredential',
      label: 'Open Badge Credential shape',
      comment: 'A well-formed OB3.0 VC: a @context, a type INCLUDING VerifiableCredential + OpenBadgeCredential, an issuer, a credentialSubject with an IRI id and a typed+named achievement, a validFrom, and a typed proof.',
      constraints: [
        { path: '@context', minCount: 1, hasValue: 'https://www.w3.org/ns/credentials/v2', comment: 'The @context MUST include the W3C VC-DM 2.0 context.' },
        { path: 'type', hasValue: 'VerifiableCredential', comment: 'type MUST include VerifiableCredential.' },
        { path: 'type', hasValue: 'OpenBadgeCredential', comment: 'type MUST include OpenBadgeCredential.' },
        { path: 'issuer', minCount: 1, comment: 'The issuer (IRI or Profile object).' },
        { path: 'validFrom', minCount: 1, comment: 'OB3.0 requires validFrom.' },
        { path: 'credentialSubject.id', minCount: 1, nodeKind: 'IRI', comment: 'The holder id (IRI).' },
        { path: 'credentialSubject.achievement.type', minCount: 1, comment: 'The achievement type.' },
        { path: 'credentialSubject.achievement.name', minCount: 1, comment: 'The achievement name.' },
        { path: 'proof.type', minCount: 1, comment: 'A typed cryptographic proof.' },
      ],
    },
    {
      name: 'AchievementShape', targetClass: 'Achievement',
      label: 'Achievement shape',
      comment: 'An OB3.0 achievement: a type and a human-readable name.',
      constraints: [
        { path: 'type', minCount: 1, comment: 'The achievement type.' },
        { path: 'name', minCount: 1, comment: 'The achievement name.' },
      ],
    },
  ],
};

// ── Comprehensive Learner Record 2.0 credential shape ───────────────────────
export const CLR_MODEL: OntologyModel = {
  module: 'clr',
  title: 'Comprehensive Learner Record 2.0 credential SHACL shapes',
  description: 'SHACL shapes for a 1EdTech CLR 2.0 / W3C Verifiable Credential bundling achievement credentials. Registered as DATA — a second credential format needs no new engine.',
  version: '1.0.0',
  spec: 'https://www.imsglobal.org/spec/clr/v2p0/',
  prefixes: { clr: 'https://purl.imsglobal.org/spec/clr/v2p0/context-2.0.1.json#' },
  classes: [
    { name: 'ClrCredential', label: 'CLR Credential', comment: 'A W3C VC (CLR 2.0) whose credentialSubject (a ClrSubject) bundles verifiable credentials.' },
  ],
  properties: [
    { name: 'credentialSubject', label: 'credential subject', comment: 'The ClrSubject — holder id + verifiableCredential[].', kind: 'object' },
    { name: 'proof', label: 'proof', comment: 'The cryptographic proof.', kind: 'object' },
  ],
  shapes: [
    {
      name: 'ClrCredentialShape', targetClass: 'ClrCredential',
      label: 'CLR Credential shape',
      comment: 'A well-formed CLR 2.0 VC: @context, type INCLUDING VerifiableCredential + ClrCredential, a credentialSubject with an IRI id, and a typed proof.',
      constraints: [
        { path: '@context', minCount: 1, hasValue: 'https://www.w3.org/ns/credentials/v2', comment: 'The @context MUST include the W3C VC-DM 2.0 context.' },
        { path: 'type', hasValue: 'VerifiableCredential', comment: 'type MUST include VerifiableCredential.' },
        { path: 'type', hasValue: 'ClrCredential', comment: 'type MUST include ClrCredential.' },
        { path: 'credentialSubject.id', minCount: 1, nodeKind: 'IRI', comment: 'The holder id (IRI).' },
        { path: 'proof.type', minCount: 1, comment: 'A typed cryptographic proof.' },
      ],
    },
  ],
};

/** Validate an LER instance — DATA-DRIVEN via the generic type-dispatching engine
 *  (which reads @type / assertionType / type, array-aware, exact local-name match to a
 *  targetClass). A new assertion format is a pure OntologyModel data entry, no code edit. */
export function validateLerInstance(instance: Record<string, unknown>): ValidationResult {
  const r = validateInstanceWith(LER_MODEL, instance);
  return { conforms: r.results.length === 0, results: r.results, shapesIri: shapesIri(LER_MODEL) };
}
