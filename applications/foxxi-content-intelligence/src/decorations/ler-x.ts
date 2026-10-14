/**
 * LER-X: the IEEE learning and employment record standards, decorated. Its parts are the records,
 * definitions and roles those standards name, each tied to the term in Foxxi's IEEE-LER ontology that
 * models it. Its controls act through Foxxi, which assembles, validates, exports, issues and
 * verifies such records. Its proposals tie each part to the I2IDL glossary and to the Foxxi
 * capability that enacts it.
 */
import type { DecorationSpec } from './kit.js';

const LTSC = 'https://sagroups.ieee.org/ltsc/active-standards/';
const I2 = 'https://id.i2idl.org/concepts/';
const LER = 'https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#';
const AS_AFFORDANCE = (urn: string): string => `as the affordance ${urn} describes`;

export const LER_X: DecorationSpec = {
  id: 'ler-x',
  title: 'LER-X',
  version: '0.1.0',
  summary: 'The IEEE learning and employment record standards, decorated: each record, definition and role they name, tied to Foxxi\'s IEEE-LER ontology; controls that assemble, validate, export, issue and verify such records through Foxxi; and proposals tying each part to the I2IDL glossary and to the Foxxi capability that enacts it.',
  decorates: {
    name: 'the IEEE learning and employment record standards',
    kind: 'specification',
    publisher: 'the IEEE and its Learning Technology Standards Committee',
    specification: { title: 'IEEE 1484.2-2024 (Learning and Employment Record Ecosystems), IEEE 1484.20.2-2022 (Defining Competencies), IEEE 1484.20.3-2022 (Shareable Competency Definitions) and IEEE P2997 (Enterprise Learner Record)', url: LTSC, rights: 'IEEE terms apply' },
  },
  parts: [
    { id: 'ecosystem', label: 'Learning and employment record ecosystem', identifier: 'IEEE 1484.2-2024', description: 'The parties around a learning and employment record (learners, issuers, verifiers, and the systems between them) and how records move among them.', cites: 'IEEE 1484.2-2024', citeUrl: LTSC },
    { id: 'enterprise-learner-record', label: 'Enterprise learner record', identifier: 'IEEE P2997', description: 'One learner\'s record, human or agent, gathered from the systems that hold its parts: what they learned, what they did, and what was attested about them.', cites: 'IEEE P2997', citeUrl: LTSC, modelledBy: `${LER}EnterpriseLearnerRecord` },
    { id: 'competency-definition', label: 'Shareable competency definition', identifier: 'IEEE 1484.20.3-2022', description: 'A competency written down so that systems can exchange it and refer to it by identifier.', cites: 'IEEE 1484.20.3-2022', citeUrl: LTSC, modelledBy: `${LER}CompetencyDefinition` },
    { id: 'defining-competencies', label: 'Defining competencies', identifier: 'IEEE 1484.20.2-2022', description: 'How a competency is stated: what a person can do, in what context, to what standard.', cites: 'IEEE 1484.20.2-2022', citeUrl: LTSC, modelledBy: `${LER}CompetencyStatement` },
    { id: 'competency-assertion', label: 'Competency assertion', description: 'A claim, by someone, that a learner holds a competency, with what it rests on.', cites: 'IEEE P2997; IEEE 1484.2-2024', citeUrl: LTSC, modelledBy: `${LER}CompetencyAssertion` },
    { id: 'credential', label: 'Credential', description: 'An issuer\'s signed attestation about a learner that a verifier can check without asking the issuer.', cites: 'IEEE 1484.2-2024', citeUrl: LTSC, modelledBy: `${LER}Credential` },
    { id: 'evidence', label: 'Evidence', description: 'What an assertion or a credential rests on: the work, the assessment, the record of performance.', cites: 'IEEE P2997', citeUrl: LTSC, modelledBy: `${LER}Evidence` },
    { id: 'transcript', label: 'Transcript', description: 'A learner\'s record as a single document for someone else to read.', cites: 'IEEE P2997', citeUrl: LTSC, modelledBy: `${LER}Transcript` },
    { id: 'issuer', label: 'Issuer', description: 'The party that makes an assertion or issues a credential.', cites: 'IEEE 1484.2-2024', citeUrl: LTSC, modelledBy: `${LER}Issuer` },
    { id: 'verifier', label: 'Verifier', description: 'The party that checks a credential or a record before relying on it.', cites: 'IEEE 1484.2-2024', citeUrl: LTSC, modelledBy: `${LER}Verifier` },
  ],
  controls: [
    { id: 'model', part: 'ecosystem', title: 'Read Foxxi\'s model of the LER standards', method: 'GET', target: '{+bridge}/ns/ieee-ler', accept: 'text/turtle', readOnly: true },
    { id: 'elr-assemble', part: 'enterprise-learner-record', title: 'Assemble a learner\'s record', method: 'POST', target: '{+bridge}/foxxi/assemble_learner_record', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:assemble-learner-record'), readOnly: true },
    { id: 'elr-review', part: 'enterprise-learner-record', title: 'Review your own record, as yourself', method: 'POST', target: '{+bridge}/agent/review-record', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:review-record'), readOnly: true },
    { id: 'elr-validate', part: 'enterprise-learner-record', title: 'Check a record against Foxxi\'s LER shapes', method: 'POST', target: '{+bridge}/ns/ieee-ler/validate', contentType: 'application/json', readOnly: true },
    { id: 'elr-shapes', part: 'enterprise-learner-record', title: 'Read the shapes a record is checked against', method: 'GET', target: '{+bridge}/ns/ieee-ler/shapes', accept: 'text/turtle', readOnly: true },
    { id: 'elr-context', part: 'enterprise-learner-record', title: 'Read the JSON-LD context a record is written in', method: 'GET', target: '{+bridge}/ns/ieee-ler/context', accept: 'application/ld+json', readOnly: true },
    { id: 'framework-export', part: 'competency-definition', title: 'Export the tenant\'s competency definitions as a CASE framework', method: 'POST', target: '{+bridge}/foxxi/export_case_framework', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:export-case-framework'), readOnly: true },
    { id: 'credential-issue', part: 'credential', title: 'Issue a completion credential', method: 'POST', target: '{+bridge}/foxxi/issue_completion_credential', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:issue-completion-credential'), readOnly: false },
    { id: 'credential-verify', part: 'verifier', title: 'Verify a credential', method: 'POST', target: '{+bridge}/foxxi/verify_credential', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:verify-credential'), readOnly: true },
    { id: 'transcript-export', part: 'transcript', title: 'Export a learner\'s record as a Comprehensive Learner Record 2.0', method: 'POST', target: '{+bridge}/foxxi/export_clr', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:export-clr'), readOnly: true },
  ],
  alignments: [
    { part: 'ecosystem', relation: 'exactMatch', target: `${I2}ieee-1484-2-2024-learning-employment-record-ecosystems`, targetLabel: 'IEEE 1484.2-2024 — Learning and Employment Record Ecosystems', rationale: 'I2IDL names the same standard.' },
    { part: 'ecosystem', relation: 'relatedMatch', target: `${I2}verifiable-learning-and-employment-record`, targetLabel: 'Verifiable learning and employment record', rationale: 'The record the ecosystem moves.' },
    { part: 'enterprise-learner-record', relation: 'exactMatch', target: `${I2}enterprise-learner-record`, targetLabel: 'Enterprise learner record', rationale: 'The same notion.' },
    { part: 'competency-definition', relation: 'exactMatch', target: `${I2}shareable-competency-definition-scd`, targetLabel: 'Shareable Competency Definition (SCD)', rationale: 'The same notion.' },
    { part: 'competency-definition', relation: 'relatedMatch', target: `${I2}ieee-1484-20-3-2022-shareable-competency-definitions`, targetLabel: 'IEEE 1484.20.3-2022 — Shareable Competency Definitions', rationale: 'The standard that defines it.' },
    { part: 'defining-competencies', relation: 'exactMatch', target: `${I2}ieee-1484-20-2-2022-defining-competencies`, targetLabel: 'IEEE 1484.20.2-2022 — Defining Competencies', rationale: 'I2IDL names the same standard.' },
    { part: 'defining-competencies', relation: 'relatedMatch', target: `${I2}competency`, targetLabel: 'Competency', rationale: 'What the standard says how to state.' },
    { part: 'credential', relation: 'closeMatch', target: `${I2}digital-credential`, targetLabel: 'Digital credential', rationale: 'A credential in these standards is digital and verifiable; I2IDL\'s term is broader in what it may attest.' },
  ],
  enactments: [
    { part: 'enterprise-learner-record', action: 'urn:iep:action:foxxi:assemble-learner-record', role: 'realizes', rationale: 'Assembles a P2997 record for a human or an agent from what the substrate holds.' },
    { part: 'enterprise-learner-record', action: 'urn:iep:action:foxxi:review-record', role: 'operationalizes', rationale: 'A learner reads their own record, as themselves.' },
    { part: 'competency-assertion', action: 'urn:iep:action:foxxi:ai-assess-competency', role: 'operationalizes', rationale: 'An AI mentor signs a Hypothetical competency assertion for a person to countersign.' },
    { part: 'credential', action: 'urn:iep:action:foxxi:issue-completion-credential', role: 'realizes', rationale: 'Issues a W3C verifiable credential (Open Badges 3.0) for a completion.' },
    { part: 'verifier', action: 'urn:iep:action:foxxi:verify-credential', role: 'implements', rationale: 'Checks a credential\'s signature and status, as a verifier does.' },
    { part: 'transcript', action: 'urn:iep:action:foxxi:export-clr', role: 'realizes', rationale: 'Exports the record as a 1EdTech Comprehensive Learner Record 2.0.' },
    { part: 'competency-definition', action: 'urn:iep:action:foxxi:export-case-framework', role: 'operationalizes', rationale: 'Exports competency definitions in 1EdTech CASE, a form other systems read.' },
  ],
  gaps: [
    { part: 'evidence', vocabulary: 'the I2IDL glossary (v0.0.86)', note: 'It has no term for evidence behind an assertion or credential.' },
    { part: 'transcript', vocabulary: 'the I2IDL glossary (v0.0.86)', note: 'It has no term for a transcript or a comprehensive learner record.' },
  ],
};
