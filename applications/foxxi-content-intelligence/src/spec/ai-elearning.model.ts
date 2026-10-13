/**
 * AI in eLearning — a VERIFIABLE interaction profile (xAPI Profile, reimagined).
 *
 * The prevailing vendor pattern records AI-tutor interactions as xAPI statements
 * whose accountability fields — a confidence number, source strings, a model name —
 * are all SELF-ASSERTED: the profile simply trusts whatever the model wrote. This
 * profile keeps that accountability intent but changes how each field becomes
 * trustworthy, and its SHACL shapes ENFORCE the difference:
 *   - a recorded interaction MUST carry a signature + a recovered signer (tamper-evident),
 *   - a cited source MUST be content-addressed to a urn:pgsl:atom (resolves to exact bytes),
 *   - a model/provider claim MUST be a signed attestation (attributable to a DID),
 *   - confidence MAY carry a range proof (committed + checkable) alongside the
 *     self-reported number, which is recorded verbatim and UNVERIFIED.
 *
 * The vocabulary this profile publishes is the one a cast of agents emergently
 * ratifies on the Interego substrate (demos/interego-microsite → /profile): fused
 * content-addressed term-atoms crossing a distinct-signer governance vote. This
 * file is the L3 INSTANTIATION — a static OntologyModel, authored by hand as data,
 * composed into PGSL and projected (OWL/SHACL/JSON-LD) dereferenceably at
 * <bridge>/ns/ai-elearning. A statement is checked against these shapes at POST
 * /ns/ai-elearning/validate (as the AI-tutor demo does), and every result cites its shape.
 *
 * HONEST: signing proves who said it and that it was not altered — not that it is
 * true. A content-addressed citation resolves to exactly the captured bytes; it does
 * not prove the cited work exists or that the model read it. A range proof binds an
 * agent to a confidence range it committed to — it is not a calibration against
 * ground truth. This profile DECLARES the two activity types its templates reference
 * (a thing the common vendor pattern omits) so its own statements validate; it makes
 * no claim about any third party's document.
 *
 * ★ A PROFILE OF xAPI, SAID IN OWL. It imports the Foxxi xAPI ontology: a signed interaction record
 * is an xAPI Statement and an AI interaction an xAPI Activity. The signer, the claim's signer and a
 * source's atom are things with identities — a DID, a urn:pgsl:atom — so they are object properties
 * (the shapes always demanded IRIs of them, which a datatype property cannot hold), and a record now
 * links to its cited sources and its confidence proof, which it had no way to name before.
 */
import type { OntologyModel } from '../spec-ontology.js';
import { XAPI_MODEL } from './xapi.model.js';

const DID = '^did:(ethr|key|web|pkh):.+';
const PGSL_ATOM = '^(urn:pgsl:atom:|https?://[^/]+/ns/pgsl/atom/).+';
/** What a JSON number becomes in RDF (JSON-LD 1.1 §8.6): an integer or a double; or a decimal. */
const NUMBER = ['xsd:integer', 'xsd:decimal', 'xsd:double'];

export const AI_ELEARNING_MODEL: OntologyModel = {
  module: 'ai-elearning',
  title: 'AI in eLearning — verifiable interaction profile',
  description:
    'An OWL 2 DL ontology and SHACL shapes for recording learner ↔ AI-tutor interactions as VERIFIABLE xAPI, reimagining the self-asserted vendor pattern. Three interaction verbs (interacted-with-ai, answered-ai-question, gave-ai-feedback) over three declared activity types (ai-interaction, ai-question, ai-feedback). The accountability fields are upgraded from self-asserted values to enforced provenance: a signed envelope + recovered signer on every recorded interaction, content-addressed sources, signed model/provider attestation, and an optional confidence range proof recorded beside the verbatim (unverified) self-reported confidence. Composed into PGSL and projected here; a statement is checked against the shapes at /ns/ai-elearning/validate.',
  version: '2026.10.0',
  spec: 'https://github.com/adlnet/xapi-profiles',
  standards: [
    { title: 'IEEE 9274.1.1-2023 (xAPI 2.0), whose statements this profile constrains', url: 'https://standards.ieee.org/ieee/9274.1.1/7321/' },
    { title: 'xAPI Profiles (ADL), the profile model this profile follows in intent', url: 'https://github.com/adlnet/xapi-profiles' },
  ],
  bodies: ['ADL', 'IEEE'],
  // A profile of xAPI of Foxxi's own design, not a formalization of a published standard, so the
  // generated "where this and the standard differ" notice would be about nothing.
  notice: 'An original profile of xAPI 2.0 by Mark Spivey (Foxxi Mediums Inc.), not a formalization of a published standard. Not affiliated with or endorsed by ADL or IEEE. Its statements are xAPI 2.0 statements, and where this profile and xAPI 2.0 (IEEE 9274.1.1-2023) differ, xAPI 2.0 governs.',
  // By version IRI: a released version keeps the xAPI ontology it was built on.
  imports: [`xapi/${XAPI_MODEL.version}`],
  profileOf: ['https://standards.ieee.org/ieee/9274.1.1/7321/'],
  notes: [
    'Since 2026.10.0, signer, modelClaimSigner and sourceAtom are object properties: their values were always required to be IRIs (a DID, a urn:pgsl:atom), which a datatype property cannot have.',
  ],
  prefixes: { iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#' },
  classes: [
    { name: 'AiInteraction', label: 'AI interaction', comment: 'A recorded interaction between a learner and an AI tutor or assistant — the activity type the interacted-with-ai template references. DECLARED here so statements using it validate (the common vendor pattern references it from a template but omits the concept).', subClassOf: ['foxxi-xapi:Activity'] },
    { name: 'AiQuestion', label: 'AI-generated question', comment: 'A question dynamically generated by an AI system, the object of an answered-ai-question statement.', subClassOf: ['AiInteraction'] },
    { name: 'AiFeedback', label: 'AI feedback', comment: 'Feedback an AI tutor produced after evaluating a learner response — the activity type the gave-ai-feedback template references. DECLARED here for the same reason as AiInteraction.', subClassOf: ['AiInteraction'] },
    { name: 'SignedInteractionRecord', label: 'Signed interaction record', comment: 'An xAPI statement about an AI interaction carried in a rev-196 signed envelope. Altering the statement breaks the signature; the signer is recovered, not asserted by the application — this is what turns an "audit trail" of claims into tamper-evident evidence.', subClassOf: ['foxxi-xapi:Statement'] },
    { name: 'AttestedModelClaim', label: 'Attested model claim', comment: 'A signed assertion by the serving party (gateway) of which model/provider it called, attributable to its DID. Replaces a free-text model name the spec would simply trust.' },
    { name: 'ContentAddressedSource', label: 'Content-addressed source', comment: 'A source the AI tutor cited, minted to a urn:pgsl:atom so it resolves to exactly the bytes captured at use. Replaces a bare source string. (Does not prove the cited work exists in the world.)' },
    { name: 'ConfidenceRangeProof', label: 'Confidence range proof', comment: 'A proof that the AI\'s confidence was ≥ a stated threshold, committed and checkable without revealing the exact value — recorded BESIDE the verbatim self-reported number. Not a calibration against ground truth.' },
  ],
  datatypes: [
    { name: 'UnitInterval', label: 'Unit interval', comment: 'A number from 0 to 1 inclusive: a decimal, or a double, which is what JSON-LD 1.1 (§8.6) makes of a JSON number with a fraction.', base: 'xsd:decimal', alsoBases: ['xsd:double'], minInclusive: 0, maxInclusive: 1 },
  ],
  properties: [
    { name: 'signedEnvelope', kind: 'datatype', label: 'signed envelope', comment: 'The rev-196 signed envelope ({_signature,_signed_payload}, message = sha256:<hex(payload)>) carrying the statement. Tamper-evident.', domain: 'SignedInteractionRecord', range: 'xsd:string', functional: true },
    { name: 'signer', kind: 'object', label: 'recovered signer', comment: 'The agent, identified by a DID, recovered from the statement signature (secp256k1 recovery) — proves WHO recorded it, not asserted by the application.', domain: 'SignedInteractionRecord', range: 'prov:Agent', functional: true },
    { name: 'recordedAt', kind: 'datatype', label: 'recorded at', comment: 'The instant the interaction was signed (xsd:dateTime); backdating is detectable against the LRS stored time.', domain: 'SignedInteractionRecord', range: 'xsd:dateTime', functional: true },
    { name: 'attestedModel', kind: 'object', label: 'attested model', comment: 'Links a record to the signed model/provider attestation for the call.', domain: 'SignedInteractionRecord', range: 'AttestedModelClaim' },
    { name: 'citedSource', kind: 'object', label: 'cited source', comment: 'A source the AI cited in the interaction, as a content-addressed source.', domain: 'SignedInteractionRecord', range: 'ContentAddressedSource' },
    { name: 'confidenceProof', kind: 'object', label: 'confidence proof', comment: 'The range proof of the AI\'s confidence in the interaction.', domain: 'SignedInteractionRecord', range: 'ConfidenceRangeProof', functional: true },
    { name: 'modelClaimSigner', kind: 'object', label: 'model-claim signer', comment: 'The gateway, identified by a DID, that signed the model/provider claim.', domain: 'AttestedModelClaim', range: 'prov:Agent', functional: true },
    { name: 'model', kind: 'datatype', label: 'model', comment: 'The model the gateway attests it called (e.g. claude-opus-4-8) — bound to modelClaimSigner, not free-floating text.', domain: 'AttestedModelClaim', range: 'xsd:string', functional: true },
    { name: 'provider', kind: 'datatype', label: 'provider', comment: 'The provider the gateway attests (e.g. Anthropic).', domain: 'AttestedModelClaim', range: 'xsd:string', functional: true },
    { name: 'sourceAtom', kind: 'object', label: 'source atom', comment: 'The PGSL atom content-addressing a cited source — it resolves to exactly the captured bytes.', domain: 'ContentAddressedSource', range: 'pgsl:Atom', functional: true },
    { name: 'assertedConfidence', kind: 'datatype', label: 'asserted confidence', comment: 'The AI\'s self-reported confidence (0..1), recorded VERBATIM and UNVERIFIED — kept for transparency, not trusted as truth.', domain: 'ConfidenceRangeProof', range: 'UnitInterval', functional: true },
    { name: 'confidenceThreshold', kind: 'datatype', label: 'confidence threshold', comment: 'The threshold (0..1) the range proof clears — the proof shows confidence ≥ this without revealing the exact value.', domain: 'ConfidenceRangeProof', range: 'UnitInterval', functional: true },
    { name: 'proofVerified', kind: 'datatype', label: 'proof verified', comment: 'Whether the range proof verified against its hash chain. The proof is checkable by anyone; this is not a claim about answer correctness.', domain: 'ConfidenceRangeProof', range: 'xsd:boolean', functional: true },
    { name: 'interventionEfficacy', kind: 'datatype', label: 'intervention efficacy', comment: 'A SEPARATE, independently-signed efficacy rate (closed/samples) aggregated across distinct keys on the Foxxi vertical — recorded beside the confidence, NOT reconciled with it and NOT a calibration of the number.', domain: 'SignedInteractionRecord', range: 'UnitInterval', functional: true },
  ],
  vocabularies: [
    {
      name: 'Verb', label: 'AI-interaction verbs',
      comment: 'The three interaction verbs. Reused intent from the prevailing pattern; what differs is the enforced provenance on the statements that carry them.',
      members: [
        { name: 'interacted-with-ai', label: 'interacted with AI', comment: 'The learner interacted with an AI tutor or assistant.' },
        { name: 'answered-ai-question', label: 'answered AI question', comment: 'The learner answered a question generated by an AI system.' },
        { name: 'gave-ai-feedback', label: 'gave AI feedback', comment: 'The AI produced feedback after evaluating the learner\'s response.' },
      ],
    },
    {
      name: 'ActivityType', label: 'AI-interaction activity types',
      comment: 'All three activity types the templates reference are DECLARED here — including ai-interaction and ai-feedback — so a statement using them validates against this profile.',
      members: [
        { name: 'ai-interaction', label: 'AI interaction', comment: 'Object type for interacted-with-ai.' },
        { name: 'ai-question', label: 'AI-generated question', comment: 'Object type for answered-ai-question.' },
        { name: 'ai-feedback', label: 'AI feedback', comment: 'Object type for gave-ai-feedback.' },
      ],
    },
  ],
  disjoint: [
    ['SignedInteractionRecord', 'AttestedModelClaim', 'ContentAddressedSource', 'ConfidenceRangeProof', 'AiInteraction'],
  ],
  shapes: [
    {
      name: 'SignedInteractionRecordShape', targetClass: 'SignedInteractionRecord', label: 'Verifiable AI-interaction record conformance',
      comment: 'A recorded AI interaction MUST carry a signature and a recovered signer and a record time — so the "audit trail" is tamper-evident evidence, not self-asserted text. This is the constraint the self-asserted vendor pattern lacks.',
      constraints: [
        { path: 'signedEnvelope', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the rev-196 signed envelope carrying the statement' },
        { path: 'signer', minCount: 1, maxCount: 1, nodeKind: 'IRI', pattern: DID, comment: 'the recovered signer DID — proves who recorded it' },
        { path: 'recordedAt', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime', comment: 'the signing instant (backdating detectable)' },
        { path: 'interventionEfficacy', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'optional separate efficacy rate (not a calibration)' },
        { path: 'confidenceProof', maxCount: 1, comment: 'at most one confidence range proof' },
      ],
    },
    {
      name: 'AttestedModelClaimShape', targetClass: 'AttestedModelClaim', label: 'Attested model/provider conformance',
      comment: 'A model/provider claim MUST be signed — attributable to the gateway that made the call — rather than free text the spec trusts.',
      constraints: [
        { path: 'modelClaimSigner', minCount: 1, maxCount: 1, nodeKind: 'IRI', pattern: DID, comment: 'the gateway DID that signed the claim' },
        { path: 'model', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the attested model' },
        { path: 'provider', maxCount: 1, datatype: 'xsd:string', comment: 'the attested provider' },
      ],
    },
    {
      name: 'ContentAddressedSourceShape', targetClass: 'ContentAddressedSource', label: 'Content-addressed source conformance',
      comment: 'A cited source MUST be content-addressed to a urn:pgsl:atom so it resolves to exactly the bytes used — replacing a bare source string.',
      constraints: [
        { path: 'sourceAtom', minCount: 1, maxCount: 1, nodeKind: 'IRI', pattern: PGSL_ATOM, comment: 'a urn:pgsl:atom content-address' },
      ],
    },
    {
      name: 'ConfidenceRangeProofShape', targetClass: 'ConfidenceRangeProof', label: 'Confidence range-proof conformance',
      comment: 'Confidence is recorded as a committed range proof (≥ threshold) beside the verbatim self-reported number. The threshold is required; the asserted value is optional and explicitly unverified.',
      constraints: [
        { path: 'confidenceThreshold', minCount: 1, maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'the proven lower bound (0..1)' },
        { path: 'assertedConfidence', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'verbatim self-report (0..1), unverified' },
        { path: 'proofVerified', maxCount: 1, datatype: 'xsd:boolean', comment: 'whether the proof checked out' },
      ],
    },
  ],
};
