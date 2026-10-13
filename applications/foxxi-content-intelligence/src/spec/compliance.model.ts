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
 *
 * ★ TIED BACK TO THE SUBSTRATE'S OWN TERMS. Each Foxxi term that names the same thing as a term of
 * the substrate vocabulary it re-homes carries a SKOS mapping to it (prefixes soc2:, eu-ai-act:,
 * nist-rmf: in the published documents), so an Evidence Pack citing either IRI can be joined to the
 * other. The acting DID of a SOC 2 evidence event is an agent with an identity, so `actor` is an
 * object property; its shape always demanded an IRI, which a datatype property cannot hold.
 */
import { type OntologyModel, NS_ROOT } from '../spec-ontology.js';

/** The substrate's L3 vocabularies (docs/ns). Inside a module its own name resolves to its own
 *  namespace, so the substrate's carries an `ie-` prefix here; the documents print it bare. */
/** The root of the Interego substrate's namespaces (not `IE`, which ontology-lint reads as the ie: namespace). */
const SUBSTRATE_NS = 'https://markjspivey-xwisee.github.io/interego/ns/';

// ── AICPA SOC 2 — Trust Services Criteria (Common Criteria, logical access) ──
export const SOC2_MODEL: OntologyModel = {
  module: 'soc2',
  title: 'AICPA SOC 2 — Trust Services Criteria (Security / Common Criteria)',
  description: 'OWL + SHACL projection of the substrate L3 SOC 2 mapping (docs/ns/soc2.ttl): the Common Criteria for logical and physical access (CC6.1–CC6.8), and the operational evidence events Interego records (@interego/ops), each an operation an auditor can sample as evidence for a criterion — an access change for CC6.2 and CC6.3, a deploy for CC8.1. Composed into PGSL and projected here so a cited control IRI dereferences.',
  version: '2026.10.0',
  spec: 'https://www.aicpa.org/resources/landing/system-and-organization-controls-soc-suite-of-services',
  standards: [
    { title: 'AICPA 2017 Trust Services Criteria for Security, Availability, Processing Integrity, Confidentiality, and Privacy (with revised points of focus, 2022)', url: 'https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022' },
  ],
  bodies: ['the AICPA'],
  seeAlso: [`${SUBSTRATE_NS}soc2`],
  prefixes: { iep: `${SUBSTRATE_NS}iep#`, 'ie-soc2': `${SUBSTRATE_NS}soc2#` },
  notes: [
    'Mapped to the Interego substrate\'s SOC 2 vocabulary (prefix soc2:, docs/ns/soc2.ttl) by SKOS mappings. Since 2026.10.0, actor is an object property.',
    'Each criterion is paraphrased and cited by its code; the AICPA\'s text governs. How Interego produces evidence for one is documented with the substrate (spec/SOC2-PREPARATION.md), not here: whether the evidence suffices is the auditor\'s judgment.',
  ],
  classes: [
    { name: 'TrustServicesCriterion', label: 'Trust Services Criterion', comment: 'A SOC 2 control objective from the AICPA Trust Services Criteria (2017, rev. 2022). The Common Criteria (CC) apply to the Security category that every SOC 2 report covers.' },
    { name: 'OperationalEvidenceEvent', label: 'Operational Evidence Event', comment: 'A signed, anchored substrate event that serves as operating-effectiveness evidence for one or more Trust Services Criteria over the audit period. Emitted by @interego/ops as a iep:ContextDescriptor.', closeMatch: ['ie-soc2:ControlEvidence'] },
    { name: 'AccessChangeEvent', label: 'Access Change Event', comment: 'An OperationalEvidenceEvent recording a grant, revoke, or modification of logical access (e.g. an agent registration or revocation). Direct operating evidence for CC6.2 (registration/authorization) and CC6.3 (modification/removal).', subClassOf: ['OperationalEvidenceEvent'], exactMatch: ['ie-soc2:AccessChangeEvent'] },
    { name: 'DeployEvent', label: 'Deploy Event', comment: 'An OperationalEvidenceEvent recording a change deployed to production. Evidence for CC8.1 (change management).', subClassOf: ['OperationalEvidenceEvent'], exactMatch: ['ie-soc2:DeployEvent'] },
    { name: 'KeyRotationEvent', label: 'Key Rotation Event', comment: 'An OperationalEvidenceEvent recording rotation of a cryptographic key / credential. Evidence for CC6.1 (logical access security measures).', subClassOf: ['OperationalEvidenceEvent'], exactMatch: ['ie-soc2:KeyRotationEvent'] },
    { name: 'IncidentEvent', label: 'Incident Event', comment: 'An OperationalEvidenceEvent recording detection and response to a security incident. Evidence for CC7.x (system operations / incident response).', subClassOf: ['OperationalEvidenceEvent'], exactMatch: ['ie-soc2:IncidentEvent'] },
  ],
  properties: [
    { name: 'evidences', kind: 'object', label: 'evidences', comment: 'Links an OperationalEvidenceEvent to the TrustServicesCriterion whose operating effectiveness it evidences.', domain: 'OperationalEvidenceEvent', range: 'TrustServicesCriterion', closeMatch: ['ie-soc2:satisfiesControl'] },
    { name: 'occurredAt', kind: 'datatype', label: 'occurredAt', comment: 'The instant the evidenced operation occurred (xsd:dateTime), inside the audit period.', domain: 'OperationalEvidenceEvent', range: 'xsd:dateTime', functional: true },
    { name: 'actor', kind: 'object', label: 'actor', comment: 'The agent or principal, identified by its DID, whose action the event records — recovered from the request signature, not asserted by the application.', domain: 'OperationalEvidenceEvent', range: 'prov:Agent', functional: true },
    { name: 'signer', kind: 'datatype', label: 'signer', comment: 'The recovered signing address proving who produced the evidence (ECDSA signature recovery).', domain: 'OperationalEvidenceEvent', range: 'xsd:string', functional: true },
  ],
  vocabularies: [
    {
      name: 'CommonCriterion', label: 'SOC 2 Common Criteria — Logical and Physical Access Controls (CC6)',
      comment: 'The eight CC6 Common Criteria, on logical and physical access controls. Each is paraphrased here and cited by its code: the criteria\'s own text is the AICPA\'s (2017 Trust Services Criteria, with revised points of focus, 2022), and it governs.',
      // The criteria have codes, not names: each label leads with its code, which is also its
      // skos:notation, followed by a short name of this document's for what the criterion is about.
      members: [
        { name: 'CC6.1', label: 'CC6.1 logical access security', comment: 'Software, infrastructure and system architecture restrict logical access to the information assets the entity protects, guarding them against security events.', exactMatch: ['ie-soc2:CC6.1'] },
        { name: 'CC6.2', label: 'CC6.2 user registration and authorization', comment: 'New internal and external users are registered and authorized before they are given credentials or access to the system.', exactMatch: ['ie-soc2:CC6.2'] },
        { name: 'CC6.3', label: 'CC6.3 role-based access changes', comment: 'Access to data, software and functions is granted, changed or removed according to roles and responsibilities, or to the system\'s design and its changes.', exactMatch: ['ie-soc2:CC6.3'] },
        { name: 'CC6.4', label: 'CC6.4 physical access restriction', comment: 'Physical access to facilities and protected assets — data centres, backup media and other sensitive locations — is limited to authorized people.' },
        { name: 'CC6.5', label: 'CC6.5 disposal of physical assets', comment: 'Protections over a physical asset are withdrawn only once the data and software on it can no longer be read or recovered, and are no longer needed.' },
        { name: 'CC6.6', label: 'CC6.6 protection against external threats', comment: 'Logical access measures protect the system against threats from sources outside its boundaries.' },
        { name: 'CC6.7', label: 'CC6.7 protection of information in transit', comment: 'Transmitting, moving and removing information is limited to authorized users and processes, and the information is protected while it moves.', exactMatch: ['ie-soc2:CC6.7'] },
        { name: 'CC6.8', label: 'CC6.8 malicious software prevention', comment: 'Controls prevent, or detect and act on, the introduction of unauthorized or malicious software.', exactMatch: ['ie-soc2:CC6.8'] },
      ],
    },
  ],
  disjoint: [['TrustServicesCriterion', 'OperationalEvidenceEvent']],
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
  description: 'OWL + SHACL projection of the substrate L3 EU AI Act mapping (docs/ns/eu-ai-act.ttl): the obligations most relevant to AI agents and tutors — for high-risk systems, risk management (Art. 9), data governance (Art. 10), record-keeping (Art. 12), transparency to deployers (Art. 13), human oversight (Art. 14) and accuracy and robustness (Art. 15); and, for any system that interacts with people, transparency to them (Art. 50). Composed into PGSL and projected here so a cited Article IRI dereferences, and an action record can name the obligation it is evidence for.',
  version: '2026.10.0',
  spec: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  standards: [
    { title: 'Regulation (EU) 2024/1689 of the European Parliament and of the Council (Artificial Intelligence Act)', url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj' },
  ],
  bodies: ['the European Union'],
  seeAlso: [`${SUBSTRATE_NS}eu-ai-act`],
  prefixes: { iep: `${SUBSTRATE_NS}iep#`, 'ie-eu-ai-act': `${SUBSTRATE_NS}eu-ai-act#` },
  notes: [
    'Mapped to the Interego substrate\'s EU AI Act vocabulary (prefix eu-ai-act:, docs/ns/eu-ai-act.ttl) by SKOS mappings: its Article individuals by exact match, and the evidence classes that realize an obligation by related match.',
    'Each obligation is defined in the Regulation\'s terms. Whether a record is sufficient evidence of meeting one is for the provider, the deployer and the authorities to judge; this document only lets the record say which obligation it concerns.',
  ],
  classes: [
    { name: 'Obligation', label: 'AI Act Obligation', comment: 'A provider or deployer obligation under the EU AI Act for high-risk AI systems. An action descriptor declaring conformsToArticle asserts it satisfies the named obligation.' },
    { name: 'RecordKeeping', label: 'Record-Keeping (Art.12)', comment: 'Art.12: high-risk AI systems shall technically allow for the automatic recording of events (logs) over their lifetime, ensuring traceability of functioning.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:LoggedAction'] },
    { name: 'HumanOversight', label: 'Human Oversight (Art.14)', comment: 'Art.14: high-risk AI systems shall be designed so they can be effectively overseen by natural persons, including the ability to intervene or interrupt.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:HumanOversightCheckpoint'] },
    { name: 'Transparency', label: 'Transparency to Deployers (Art.13)', comment: 'Art.13: high-risk AI systems shall be sufficiently transparent to enable deployers to interpret output and use it appropriately, accompanied by instructions for use.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:TransparencyDisclosure'] },
    { name: 'RiskManagement', label: 'Risk Management (Art.9)', comment: 'Art.9: a risk-management system shall be established, implemented, documented and maintained across the lifecycle of the high-risk AI system.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:RiskManagementRecord'] },
    { name: 'DataGovernance', label: 'Data & Data Governance (Art.10)', comment: 'Art.10: training, validation and testing data sets shall be subject to appropriate data-governance and management practices.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:DataGovernanceAttestation'] },
    { name: 'InteractionTransparency', label: 'Transparency to Persons (Art.50)', comment: 'Art.50: providers shall ensure that AI systems intended to interact directly with natural persons are designed so that those persons are informed that they are interacting with an AI system, unless that is obvious; and providers and deployers shall mark or disclose AI-generated or manipulated content as the Article sets out. Applies to such systems whether or not they are high-risk.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:Article50Disclosure'] },
    { name: 'AccuracyRobustness', label: 'Accuracy, Robustness, Cybersecurity (Art.15)', comment: 'Art.15: high-risk AI systems shall achieve appropriate levels of accuracy, robustness and cybersecurity, consistent throughout their lifecycle.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:AccuracyAttestation'] },
  ],
  properties: [
    { name: 'conformsToArticle', kind: 'object', label: 'conformsToArticle', comment: 'Asserts that the subject action / system satisfies the named EU AI Act Obligation, with the cited evidence.', range: 'Obligation' },
    { name: 'article', kind: 'datatype', label: 'article', comment: 'The Article number of the obligation (e.g. "12").', domain: 'Obligation', range: 'xsd:string', functional: true },
  ],
  vocabularies: [
    {
      name: 'Article', label: 'EU AI Act Articles',
      comment: 'The Articles this mapping covers — Articles 9 to 15 for high-risk AI systems, and Article 50 for systems that interact with people; each is realized as an Obligation subclass above.',
      members: [
        { name: 'Article9', label: 'Article 9 — Risk management system', comment: 'Establish/maintain a risk-management system across the lifecycle.', exactMatch: ['ie-eu-ai-act:Article9'] },
        { name: 'Article10', label: 'Article 10 — Data and data governance', comment: 'Data-governance practices for training/validation/testing data.', exactMatch: ['ie-eu-ai-act:Article10'] },
        { name: 'Article12', label: 'Article 12 — Record-keeping', comment: 'Automatic, lifetime logging ensuring traceability of functioning.', exactMatch: ['ie-eu-ai-act:Article12'] },
        { name: 'Article13', label: 'Article 13 — Transparency and provision of information to deployers', comment: 'Transparent operation + instructions for use.' },
        { name: 'Article14', label: 'Article 14 — Human oversight', comment: 'Effective human oversight, intervention and interruption.', exactMatch: ['ie-eu-ai-act:Article14'] },
        { name: 'Article15', label: 'Article 15 — Accuracy, robustness and cybersecurity', comment: 'Appropriate accuracy, robustness and cybersecurity over the lifecycle.', exactMatch: ['ie-eu-ai-act:Article15'] },
        { name: 'Article50', label: 'Article 50 — Transparency obligations for providers and deployers of certain AI systems', comment: 'Informing people that they are interacting with an AI system, and marking or disclosing AI-generated or manipulated content.' },
      ],
    },
  ],
  disjoint: [['RecordKeeping', 'HumanOversight', 'Transparency', 'RiskManagement', 'DataGovernance', 'AccuracyRobustness', 'InteractionTransparency']],
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
  description: 'OWL + SHACL projection of the substrate L3 NIST AI RMF mapping (docs/ns/nist-rmf.ttl): the four core functions (Govern / Map / Measure / Manage), so that a record of an action can name the function it contributes to. Composed into PGSL and projected here so a cited function IRI dereferences.',
  version: '2026.10.0',
  spec: 'https://www.nist.gov/itl/ai-risk-management-framework',
  standards: [
    { title: 'NIST AI 100-1 — Artificial Intelligence Risk Management Framework (AI RMF 1.0), January 2023', url: 'https://doi.org/10.6028/NIST.AI.100-1' },
  ],
  bodies: ['NIST'],
  seeAlso: [`${SUBSTRATE_NS}nist-rmf`, 'https://www.nist.gov/itl/ai-risk-management-framework'],
  prefixes: { iep: `${SUBSTRATE_NS}iep#`, 'ie-nist-rmf': `${SUBSTRATE_NS}nist-rmf#` },
  notes: ['AI RMF 1.0 is the current version of the framework; NIST\'s later publications, such as the Generative AI Profile (NIST AI 600-1, 2024), are profiles of it and keep its four functions.', 'Mapped to the Interego substrate\'s NIST AI RMF vocabulary (prefix nist-rmf:, docs/ns/nist-rmf.ttl) by SKOS mappings.'],
  classes: [
    { name: 'Function', label: 'AI RMF Core Function', comment: 'One of the four NIST AI RMF core functions. A substrate action addressing a function provides evidence toward it.' },
    { name: 'Govern', label: 'Govern', comment: 'Cultivate a culture of risk management; policies, accountability, and oversight structures are in place and applied.', subClassOf: ['Function'], closeMatch: ['ie-nist-rmf:Govern'] },
    { name: 'Map', label: 'Map', comment: 'Establish the context to frame risks; categorize the AI system and its capabilities, intended uses, and impacts.', subClassOf: ['Function'], closeMatch: ['ie-nist-rmf:Map'] },
    { name: 'Measure', label: 'Measure', comment: 'Employ quantitative, qualitative, or mixed methods to analyze, assess, benchmark, and monitor AI risk.', subClassOf: ['Function'], closeMatch: ['ie-nist-rmf:Measure'] },
    { name: 'Manage', label: 'Manage', comment: 'Allocate resources to mapped and measured risks; respond to, recover from, and communicate about incidents.', subClassOf: ['Function'], closeMatch: ['ie-nist-rmf:Manage'] },
  ],
  properties: [
    { name: 'addressesFunction', kind: 'object', label: 'addressesFunction', comment: 'Asserts the subject action / control addresses the named NIST AI RMF function.', range: 'Function', relatedMatch: ['ie-nist-rmf:contributesTo'] },
    { name: 'functionId', kind: 'datatype', label: 'functionId', comment: 'The short id of the function (GOVERN / MAP / MEASURE / MANAGE).', domain: 'Function', oneOf: ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'], functional: true },
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
  disjoint: [['Govern', 'Map', 'Measure', 'Manage']],
  shapes: [
    {
      name: 'FunctionEvidenceShape', targetClass: 'Function', label: 'AI RMF function-evidence conformance',
      comment: 'A function-evidence assertion MUST name the function id it addresses.',
      constraints: [
        { path: 'functionId', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'], comment: 'the core function id' },
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
