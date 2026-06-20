/**
 * Compliance framework ontologies — the SINGLE source, composed into the PGSL
 * lattice and projected (OWL / SHACL / JSON-LD) dereferenceably at
 * <bridge>/ns/{soc2,eu-ai-act,nist-rmf}, exactly like the standards spec
 * ontologies. These re-home the substrate's existing L3 mapping ontologies
 * (docs/ns/{soc2,eu-ai-act,nist-rmf}.ttl, emitted against by @interego/compliance
 * + @interego/ops) to a conneg + HATEOAS dereferenceable home so that when an
 * Evidence Pack cites a control (e.g. soc2:CC6.1, eu-ai-act:Article12,
 * nist-rmf:Measure) the cited IRI RESOLVES to its definition — the
 * every-IRI-dereferences principle, applied to the regulatory surface.
 *
 * Faithful to the public frameworks (AICPA SOC 2 TSC 2017, EU AI Act Reg.
 * 2024/1689, NIST AI RMF 1.0). These are descriptive ontologies: the classes are
 * the control areas / obligations, the vocabularies are the individual controls /
 * articles / functions, and the shapes validate that an agent-action evidence
 * record cites a control and carries a verifiable signer — what an audit pack must
 * prove.
 */
import { type OntologyModel, NS_ROOT } from '../spec-ontology.js';

// ── AICPA SOC 2 — Trust Services Criteria (Common Criteria, logical access) ──
export const SOC2_MODEL: OntologyModel = {
  module: 'soc2',
  title: 'AICPA SOC 2 — Trust Services Criteria (Security / Common Criteria)',
  description: 'OWL + SHACL projection of the substrate L3 SOC 2 mapping (docs/ns/soc2.ttl): the Common Criteria logical-access controls (CC6.x) plus the operational evidence event subtypes Interego emits against them (@interego/ops). Composed into PGSL and projected here so a cited control IRI dereferences. An access-control change recorded by the substrate IS the CC6.2/CC6.3 evidence; a deploy IS CC8.1 evidence — Interego is its own SOC 2 evidence substrate.',
  version: '1.0.0',
  spec: 'https://www.aicpa.org/resources/landing/system-and-organization-controls-soc-suite-of-services',
  prefixes: { cg: 'https://markjspivey-xwisee.github.io/interego/ns/cg#' },
  classes: [
    { name: 'TrustServicesCriterion', label: 'Trust Services Criterion', comment: 'A SOC 2 control objective from the AICPA Trust Services Criteria (2017, rev. 2022). The Common Criteria (CC) apply to the Security category that every SOC 2 report covers.' },
    { name: 'OperationalEvidenceEvent', label: 'Operational Evidence Event', comment: 'A signed, anchored substrate event that serves as operating-effectiveness evidence for one or more Trust Services Criteria over the audit period. Emitted by @interego/ops as a cg:ContextDescriptor.' },
    { name: 'AccessChangeEvent', label: 'Access Change Event', comment: 'An OperationalEvidenceEvent recording a grant, revoke, or modification of logical access (e.g. an agent registration or revocation). Direct operating evidence for CC6.2 (registration/authorization) and CC6.3 (modification/removal).', subClassOf: ['OperationalEvidenceEvent'] },
    { name: 'DeployEvent', label: 'Deploy Event', comment: 'An OperationalEvidenceEvent recording a change deployed to production. Evidence for CC8.1 (change management).', subClassOf: ['OperationalEvidenceEvent'] },
    { name: 'KeyRotationEvent', label: 'Key Rotation Event', comment: 'An OperationalEvidenceEvent recording rotation of a cryptographic key / credential. Evidence for CC6.1 (logical access security measures).', subClassOf: ['OperationalEvidenceEvent'] },
    { name: 'IncidentEvent', label: 'Incident Event', comment: 'An OperationalEvidenceEvent recording detection and response to a security incident. Evidence for CC7.x (system operations / incident response).', subClassOf: ['OperationalEvidenceEvent'] },
  ],
  properties: [
    { name: 'evidences', kind: 'object', label: 'evidences', comment: 'Links an OperationalEvidenceEvent to the TrustServicesCriterion whose operating effectiveness it evidences.', domain: 'OperationalEvidenceEvent', range: 'TrustServicesCriterion' },
    { name: 'occurredAt', kind: 'datatype', label: 'occurredAt', comment: 'The instant the evidenced operation occurred (xsd:dateTime), inside the audit period.', domain: 'OperationalEvidenceEvent', range: 'xsd:dateTime' },
    { name: 'actor', kind: 'datatype', label: 'actor', comment: 'The DID of the agent or principal whose action the event records — recovered from the request signature, not asserted by the application.', domain: 'OperationalEvidenceEvent', range: 'xsd:anyURI' },
    { name: 'signer', kind: 'datatype', label: 'signer', comment: 'The recovered signing address proving who produced the evidence (ECDSA signature recovery).', domain: 'OperationalEvidenceEvent', range: 'xsd:string' },
  ],
  vocabularies: [
    {
      name: 'CommonCriterion', label: 'SOC 2 Common Criteria — Logical & Physical Access (CC6)',
      comment: 'The CC6.x logical-access Common Criteria — the controls an agent-workforce audit most directly exercises.',
      members: [
        { name: 'CC6.1', label: 'CC6.1', comment: 'The entity implements logical access security software, infrastructure, and architectures over protected information assets to protect them from security events. (Interego: wallet-rooted DIDs, signed requests, E2EE.)' },
        { name: 'CC6.2', label: 'CC6.2', comment: 'Prior to issuing system credentials and granting system access, the entity registers and authorizes new internal and external users. (Interego: agent registration + delegation VC on the agent\'s own pod.)' },
        { name: 'CC6.3', label: 'CC6.3', comment: 'The entity authorizes, modifies, or removes access based on roles and responsibilities. (Interego: agent revocation emits a soc2:AccessChangeEvent.)' },
        { name: 'CC6.6', label: 'CC6.6', comment: 'The entity implements logical access security measures to protect against threats from sources outside its system boundaries. (Interego: signature-gated affordances, zero-trust storage.)' },
        { name: 'CC6.7', label: 'CC6.7', comment: 'The entity restricts the transmission, movement, and removal of information to authorized users and protects it during transmission/movement/removal. (Interego: per-recipient envelope encryption.)' },
        { name: 'CC6.8', label: 'CC6.8', comment: 'The entity implements controls to prevent or detect and act upon the introduction of unauthorized or malicious software. (Interego: signed, content-addressed artifacts.)' },
      ],
    },
  ],
  shapes: [
    {
      name: 'OperationalEvidenceEventShape', targetClass: 'OperationalEvidenceEvent', label: 'SOC 2 evidence-event conformance',
      comment: 'An operational evidence event MUST cite the criterion it evidences, carry the instant it occurred, and identify the recovered signer — so the audit pack proves WHO acted and WHICH control it evidences.',
      constraints: [
        { path: 'evidences', minCount: 1, comment: 'cite at least one Trust Services Criterion' },
        { path: 'occurredAt', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime', comment: 'one occurrence instant in the audit period' },
        { path: 'actor', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'the acting DID' },
        { path: 'signer', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the recovered signer address' },
      ],
    },
  ],
};

// ── EU AI Act (Regulation (EU) 2024/1689) — provider/deployer obligations ──
export const EU_AI_ACT_MODEL: OntologyModel = {
  module: 'eu-ai-act',
  title: 'EU AI Act (Regulation (EU) 2024/1689) — obligation mapping',
  description: 'OWL + SHACL projection of the substrate L3 EU AI Act mapping (docs/ns/eu-ai-act.ttl): the high-risk-system obligations most relevant to autonomous agent actions — record-keeping (Art.12), human oversight (Art.14), transparency to deployers (Art.13), risk management (Art.9), data governance (Art.10), accuracy/robustness (Art.15). Composed into PGSL and projected here so a cited Article IRI dereferences. An agent action with an immutable, attributable, dereferenceable log IS Article-12 record-keeping evidence.',
  version: '1.0.0',
  spec: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202401689',
  prefixes: { cg: 'https://markjspivey-xwisee.github.io/interego/ns/cg#' },
  classes: [
    { name: 'Obligation', label: 'AI Act Obligation', comment: 'A provider or deployer obligation under the EU AI Act for high-risk AI systems. An action descriptor declaring conformsToArticle asserts it satisfies the named obligation.' },
    { name: 'RecordKeeping', label: 'Record-Keeping (Art.12)', comment: 'Art.12: high-risk AI systems shall technically allow for the automatic recording of events (logs) over their lifetime, ensuring traceability of functioning. (Interego: every action is a signed, timestamped, dereferenceable descriptor.)', subClassOf: ['Obligation'] },
    { name: 'HumanOversight', label: 'Human Oversight (Art.14)', comment: 'Art.14: high-risk AI systems shall be designed so they can be effectively overseen by natural persons, including the ability to intervene or interrupt. (Interego: agent delegation is revocable; revocation is itself evidenced.)', subClassOf: ['Obligation'] },
    { name: 'Transparency', label: 'Transparency to Deployers (Art.13)', comment: 'Art.13: high-risk AI systems shall be sufficiently transparent to enable deployers to interpret output and use it appropriately, accompanied by instructions for use. (Interego: dereferenceable provenance + interrogative routing over each action.)', subClassOf: ['Obligation'] },
    { name: 'RiskManagement', label: 'Risk Management (Art.9)', comment: 'Art.9: a risk-management system shall be established, implemented, documented and maintained across the lifecycle of the high-risk AI system.', subClassOf: ['Obligation'] },
    { name: 'DataGovernance', label: 'Data & Data Governance (Art.10)', comment: 'Art.10: training, validation and testing data sets shall be subject to appropriate data-governance and management practices.', subClassOf: ['Obligation'] },
    { name: 'AccuracyRobustness', label: 'Accuracy, Robustness, Cybersecurity (Art.15)', comment: 'Art.15: high-risk AI systems shall achieve appropriate levels of accuracy, robustness and cybersecurity, consistent throughout their lifecycle.', subClassOf: ['Obligation'] },
  ],
  properties: [
    { name: 'conformsToArticle', kind: 'object', label: 'conformsToArticle', comment: 'Asserts that the subject action / system satisfies the named EU AI Act Obligation, with the cited evidence.', range: 'Obligation' },
    { name: 'article', kind: 'datatype', label: 'article', comment: 'The Article number of the obligation (e.g. "12").', domain: 'Obligation', range: 'xsd:string' },
  ],
  vocabularies: [
    {
      name: 'Article', label: 'EU AI Act Articles (high-risk obligations)',
      comment: 'The Articles this mapping covers; each is realized as an Obligation subclass above.',
      members: [
        { name: 'Article9', label: 'Article 9 — Risk management system', comment: 'Establish/maintain a risk-management system across the lifecycle.' },
        { name: 'Article10', label: 'Article 10 — Data and data governance', comment: 'Data-governance practices for training/validation/testing data.' },
        { name: 'Article12', label: 'Article 12 — Record-keeping', comment: 'Automatic, lifetime logging ensuring traceability of functioning.' },
        { name: 'Article13', label: 'Article 13 — Transparency and provision of information to deployers', comment: 'Transparent operation + instructions for use.' },
        { name: 'Article14', label: 'Article 14 — Human oversight', comment: 'Effective human oversight, intervention and interruption.' },
        { name: 'Article15', label: 'Article 15 — Accuracy, robustness and cybersecurity', comment: 'Appropriate accuracy, robustness and cybersecurity over the lifecycle.' },
      ],
    },
  ],
  shapes: [
    {
      name: 'ObligationConformanceShape', targetClass: 'Obligation', label: 'AI Act obligation conformance',
      comment: 'An obligation assertion MUST name the Article it satisfies.',
      constraints: [
        { path: 'article', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the Article number' },
      ],
    },
  ],
};

// ── NIST AI Risk Management Framework (AI RMF 1.0) — four functions ──
export const NIST_RMF_MODEL: OntologyModel = {
  module: 'nist-rmf',
  title: 'NIST AI Risk Management Framework 1.0 — function mapping',
  description: 'OWL + SHACL projection of the substrate L3 NIST AI RMF mapping (docs/ns/nist-rmf.ttl): the four core functions (Govern / Map / Measure / Manage) and how a substrate action addresses them. Composed into PGSL and projected here so a cited function IRI dereferences. Independent, cryptographically verifiable measurement of an agent\'s behaviour IS Measure-function evidence; revocable delegation + recorded response IS Manage.',
  version: '1.0.0',
  spec: 'https://www.nist.gov/itl/ai-risk-management-framework',
  prefixes: { cg: 'https://markjspivey-xwisee.github.io/interego/ns/cg#' },
  classes: [
    { name: 'Function', label: 'AI RMF Core Function', comment: 'One of the four NIST AI RMF core functions. A substrate action addressing a function provides evidence toward it.' },
    { name: 'Govern', label: 'Govern', comment: 'Cultivate a culture of risk management; policies, accountability, and oversight structures are in place and applied. (Interego: self-amending constitutional policies + attribution on every descriptor.)', subClassOf: ['Function'] },
    { name: 'Map', label: 'Map', comment: 'Establish the context to frame risks; categorize the AI system and its capabilities, intended uses, and impacts.', subClassOf: ['Function'] },
    { name: 'Measure', label: 'Measure', comment: 'Employ quantitative, qualitative, or mixed methods to analyze, assess, benchmark, and monitor AI risk. (Interego: independent, cryptographically verifiable measurement of agent behaviour from the agent\'s own records.)', subClassOf: ['Function'] },
    { name: 'Manage', label: 'Manage', comment: 'Allocate resources to mapped and measured risks; respond to, recover from, and communicate about incidents. (Interego: revocable delegation, recorded responses, dereferenceable chains of custody.)', subClassOf: ['Function'] },
  ],
  properties: [
    { name: 'addressesFunction', kind: 'object', label: 'addressesFunction', comment: 'Asserts the subject action / control addresses the named NIST AI RMF function.', range: 'Function' },
    { name: 'functionId', kind: 'datatype', label: 'functionId', comment: 'The short id of the function (GOVERN / MAP / MEASURE / MANAGE).', domain: 'Function', range: 'xsd:string' },
  ],
  vocabularies: [
    {
      name: 'CoreFunction', label: 'NIST AI RMF Core Functions',
      comment: 'The four functions of the AI RMF 1.0 core.',
      members: [
        { name: 'GOVERN', label: 'GOVERN', comment: 'Risk-management culture, policies, accountability, oversight.' },
        { name: 'MAP', label: 'MAP', comment: 'Context, categorization, capabilities, intended use, impacts.' },
        { name: 'MEASURE', label: 'MEASURE', comment: 'Analyze, assess, benchmark, monitor AI risk.' },
        { name: 'MANAGE', label: 'MANAGE', comment: 'Prioritize, respond, recover, communicate about risk.' },
      ],
    },
  ],
  shapes: [
    {
      name: 'FunctionEvidenceShape', targetClass: 'Function', label: 'AI RMF function-evidence conformance',
      comment: 'A function-evidence assertion MUST name the function id it addresses.',
      constraints: [
        { path: 'functionId', minCount: 1, maxCount: 1, in: ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'], comment: 'the core function id' },
      ],
    },
  ],
};

/** The compliance framework ontologies — composed into PGSL + served at
 *  <bridge>/ns/<module> exactly like SPEC_MODELS, but kept OUT of the LMS/LRS
 *  conformance path (they are regulatory mappings, not learning standards). */
export const COMPLIANCE_MODELS: Record<string, OntologyModel> = {
  [SOC2_MODEL.module]: SOC2_MODEL,
  [EU_AI_ACT_MODEL.module]: EU_AI_ACT_MODEL,
  [NIST_RMF_MODEL.module]: NIST_RMF_MODEL,
};

void NS_ROOT;
