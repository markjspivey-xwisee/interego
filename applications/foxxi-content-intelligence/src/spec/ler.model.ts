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
import { type OntologyModel, validateAgainstShape, shapesIri, type ValidationResult } from '../spec-ontology.js';

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
    { name: 'CompetencyAssertion', label: 'Competency Assertion', comment: 'A claim that a subject holds a competency at a proficiency level, with a confidence, backed by dereferenceable evidence, produced by a published roll-up rule.' },
    { name: 'Evidence', label: 'Evidence', comment: 'A dereferenceable artifact presented in support of a competency assertion.' },
  ],
  properties: [
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
      name: 'CompetencyAssertionShape', targetClass: 'CompetencyAssertion',
      label: 'Competency Assertion shape',
      comment: 'A well-formed IEEE-LER competency assertion: about a competency, at a dereferenceable proficiency level, with a confidence in 0..1, produced by a named roll-up rule, backed by at least one dereferenceable evidence IRI.',
      constraints: [
        { path: 'aboutCompetency', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'ler:aboutCompetency — the competency definition IRI.' },
        { path: 'proficiencyLevel', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'ler:atProficiency — a dereferenceable proficiency-level IRI.' },
        { path: 'confidence', minCount: 1, maxCount: 1, datatype: 'xsd:decimal', minInclusive: 0, maxInclusive: 1, comment: 'tla:confidence in [0,1].' },
        { path: 'rolledUpBy', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'The tla:RollupRule IRI that produced this assertion.' },
        { path: 'assertingAgent', minCount: 1, comment: 'iep:assertingAgent — the asserting agent id.' },
        { path: 'evidence', minCount: 1, nodeKind: 'IRI', comment: 'ler:supportedByEvidence — at least one dereferenceable evidence IRI.' },
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
      comment: 'A well-formed OB3.0 VC: a type array including VerifiableCredential, an issuer, a credentialSubject with an id, an issuance date, and a proof.',
      constraints: [
        { path: 'type', minCount: 1, comment: 'Must include VerifiableCredential + OpenBadgeCredential.' },
        { path: 'issuer', minCount: 1, comment: 'The issuer (IRI or object).' },
        { path: 'credentialSubject.id', minCount: 1, nodeKind: 'IRI', comment: 'The holder id.' },
        { path: 'credentialSubject.achievement', minCount: 1, comment: 'The achievement the badge attests.' },
        { path: 'proof', minCount: 1, comment: 'A cryptographic proof.' },
      ],
    },
  ],
};

/** Validate an instance against the LER competency-assertion / evidence shapes,
 *  routing by declared type; defaults to CompetencyAssertion (the common case). */
export function validateLerInstance(instance: Record<string, unknown>): ValidationResult {
  const raw = instance['@type'] ?? instance.assertionType ?? instance.type ?? '';
  // EXACT declared-class local-name routing (not a substring test): 'CredentialEvidence'
  // must NOT route to the id-only EvidenceShape and thereby skip every assertion check.
  const localNames = (Array.isArray(raw) ? raw : [raw]).map(t => String(t).split(/[#/]/).pop());
  const shape = localNames.includes('Evidence') ? 'EvidenceShape' : 'CompetencyAssertionShape';
  const r = validateAgainstShape(LER_MODEL, shape, instance);
  return { conforms: r.results.length === 0, results: r.results, shapesIri: shapesIri(LER_MODEL) };
}
