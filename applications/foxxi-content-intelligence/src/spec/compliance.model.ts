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
 * other. The acting DID of a SOC 2 evidence event is an agent with an identity, so it is stated with
 * an object property, `actingAgent`; its shape always demanded an IRI, which a datatype property
 * cannot hold. `actor`, published as a datatype property, keeps that kind, deprecated: changing a
 * published property's kind in place would make data written with it unreadable in OWL 2 DL.
 *
 * ★ A CLASS, A LIST AND A CODE NAME THE SAME THINGS, SO THEY ARE ONE. Each framework is formalized
 * three ways: a class (an obligation, a core function, a criterion), a SKOS list of the same things,
 * and for the EU AI Act and NIST a datatype property holding a code ("12", "GOVERN"). Unconnected,
 * a record that named a concept made it, by the range of the property it used, an instance of the
 * class, which then failed the class's shape for want of the code. Each concept is now typed with
 * its class and carries its code, so the three name the same things and a record naming a concept
 * meets the shapes.
 */
import { type OntologyModel, NS_ROOT } from '../spec-ontology.js';
import { sourceAt } from '../ns/catalog.js';

/** The substrate's L3 vocabularies (docs/ns). Inside a module its own name resolves to its own
 *  namespace, so the substrate's carries an `ie-` prefix here; the documents print it bare. */
/** The root of the Interego substrate's namespaces (not `IE`, which ontology-lint reads as the ie: namespace). */
const SUBSTRATE_NS = 'https://markjspivey-xwisee.github.io/interego/ns/';

// ── AICPA SOC 2 — Trust Services Criteria (Common Criteria) ──
const SOC2_VERSION = '2026.10.0';
export const SOC2_MODEL: OntologyModel = {
  selectByDomainAndRange: true,
  generatedContext: true,
  module: 'soc2',
  title: 'AICPA SOC 2 — Trust Services Criteria (Security / Common Criteria)',
  description: `OWL + SHACL projection of the Interego substrate's SOC 2 mapping (${SUBSTRATE_NS}soc2): the Common Criteria for logical and physical access (CC6.1–CC6.8), for responding to security incidents (CC7.3–CC7.5) and for change management (CC8.1), and the operational evidence events Interego records, each an operation an auditor can sample as evidence for a criterion: an access change for CC6.2 and CC6.3, a deploy for CC8.1. Composed into PGSL and projected here so a cited control IRI dereferences.`,
  version: SOC2_VERSION,
  spec: 'https://www.aicpa.org/resources/landing/system-and-organization-controls-soc-suite-of-services',
  standards: [
    { title: 'AICPA 2017 Trust Services Criteria for Security, Availability, Processing Integrity, Confidentiality, and Privacy (with revised points of focus, 2022)', url: 'https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022' },
  ],
  bodies: ['the AICPA'],
  seeAlso: [`${SUBSTRATE_NS}soc2`],
  prefixes: { iep: `${SUBSTRATE_NS}iep#`, 'ie-soc2': `${SUBSTRATE_NS}soc2#` },
  notes: [
    `Mapped to the Interego substrate's SOC 2 vocabulary (prefix soc2:, ${SUBSTRATE_NS}soc2) by SKOS mappings.`,
    `Each criterion is paraphrased and cited by its code; the AICPA's text governs. How Interego produces evidence for one is documented with the substrate (${sourceAt(SOC2_VERSION, 'spec/SOC2-PREPARATION.md')}), not here: whether the evidence suffices is the auditor's judgment.`,
    'The criteria are the concepts of one list (CommonCriterion), each a TrustServicesCriterion: the class and the list name the same criteria, so an event that cites a concept (evidences) cites a criterion.',
  ],
  classes: [
    { name: 'TrustServicesCriterion', label: 'Trust Services Criterion', comment: 'A SOC 2 control objective from the AICPA Trust Services Criteria (2017, rev. 2022). The Common Criteria (CC) apply to the Security category that every SOC 2 report covers. Its instances here are the concepts of this document\'s CommonCriterion list.' },
    { name: 'OperationalEvidenceEvent', label: 'Operational Evidence Event', comment: 'A signed, anchored substrate event that serves as operating-effectiveness evidence for one or more Trust Services Criteria over the audit period. Interego\'s operations package (@interego/ops) records each as a context descriptor (iep:ContextDescriptor).', closeMatch: ['ie-soc2:ControlEvidence'] },
    { name: 'AccessChangeEvent', label: 'Access Change Event', comment: 'An OperationalEvidenceEvent recording that logical access was granted, revoked or modified (an agent registered or revoked, say): evidence for CC6.2 (registration and authorization) and CC6.3 (changes and removal by role).', subClassOf: ['OperationalEvidenceEvent'], exactMatch: ['ie-soc2:AccessChangeEvent'] },
    { name: 'DeployEvent', label: 'Deploy Event', comment: 'An OperationalEvidenceEvent recording a change deployed to production: evidence for CC8.1 (change management).', subClassOf: ['OperationalEvidenceEvent'], exactMatch: ['ie-soc2:DeployEvent'] },
    { name: 'KeyRotationEvent', label: 'Key Rotation Event', comment: 'An OperationalEvidenceEvent recording the rotation of a signing or encryption key: evidence for CC6.1 (protecting encryption keys is among its points of focus) and, for a key that protects information in transit, CC6.7.', subClassOf: ['OperationalEvidenceEvent'], exactMatch: ['ie-soc2:KeyRotationEvent'] },
    { name: 'IncidentEvent', label: 'Incident Event', comment: 'An OperationalEvidenceEvent recording a security incident, from its detection to its resolution: evidence for CC7.3 (evaluating security events), CC7.4 (responding to incidents) and, once resolved, CC7.5 (recovery).', subClassOf: ['OperationalEvidenceEvent'], exactMatch: ['ie-soc2:IncidentEvent'] },
    { name: 'QuarterlyReviewEvent', label: 'Quarterly Review Event', comment: 'An OperationalEvidenceEvent recording that a recurring quarterly review was completed (of access, changes, risk, vendors or monitoring): evidence for the criteria the review covers, such as CC6.2 and CC6.3 for an access review or CC8.1 for a change review.', subClassOf: ['OperationalEvidenceEvent'], exactMatch: ['ie-soc2:QuarterlyReviewEvent'] },
  ],
  properties: [
    { name: 'evidences', kind: 'object', label: 'evidences', comment: 'Links an OperationalEvidenceEvent to the TrustServicesCriterion whose operating effectiveness it evidences.', domain: 'OperationalEvidenceEvent', range: 'TrustServicesCriterion', closeMatch: ['ie-soc2:satisfiesControl'] },
    { name: 'occurredAt', kind: 'datatype', label: 'occurredAt', comment: 'The instant the evidenced operation occurred (xsd:dateTime), inside the audit period.', domain: 'OperationalEvidenceEvent', range: 'xsd:dateTime', functional: true },
    { name: 'actingAgent', kind: 'object', label: 'acting agent', comment: 'The agent or principal, identified by its DID, whose action the event records — recovered from the request signature, not asserted by the application.', domain: 'OperationalEvidenceEvent', range: 'prov:Agent', functional: true, changeNote: '2026.10.0: new, in place of actor, which held the DID as a string.' },
    { name: 'actor', kind: 'datatype', label: 'actor', comment: 'The DID of the agent or principal whose action the event records, as a string. An agent with an identity is a node, not a string: use actingAgent, whose value is the DID itself.', domain: 'OperationalEvidenceEvent', range: 'xsd:anyURI', deprecated: true, replacedBy: 'actingAgent', changeNote: '2026.10.0: deprecated in favour of actingAgent; kept as the datatype property it was published as, so data that used it keeps its meaning.' },
    { name: 'signer', kind: 'datatype', label: 'signer', comment: 'The recovered signing address proving who produced the evidence (ECDSA signature recovery).', domain: 'OperationalEvidenceEvent', range: 'xsd:string', functional: true },
  ],
  vocabularies: [
    {
      name: 'CommonCriterion', label: 'SOC 2 Common Criteria',
      comment: 'The Common Criteria this document cites: the eight on logical and physical access (CC6.1–CC6.8), the three on responding to security incidents (CC7.3–CC7.5), and the one on change management (CC8.1). Each is a TrustServicesCriterion, paraphrased here and cited by its code: the criteria\'s own text is the AICPA\'s (2017 Trust Services Criteria, with revised points of focus, 2022), and it governs.',
      // The criteria have codes, not names: each label leads with its code, which is also its
      // skos:notation, followed by a short name of this document's for what the criterion is about.
      members: [
        { name: 'CC6.1', label: 'CC6.1 logical access security', comment: 'Software, infrastructure and system architecture restrict logical access to the information assets the entity protects, guarding them against security events.', exactMatch: ['ie-soc2:CC6.1'], types: ['TrustServicesCriterion'] },
        { name: 'CC6.2', label: 'CC6.2 user registration and authorization', comment: 'New internal and external users are registered and authorized before they are given credentials or access to the system.', exactMatch: ['ie-soc2:CC6.2'], types: ['TrustServicesCriterion'] },
        { name: 'CC6.3', label: 'CC6.3 role-based access changes', comment: 'Access to data, software and functions is granted, changed or removed according to roles and responsibilities, or to the system\'s design and its changes.', exactMatch: ['ie-soc2:CC6.3'], types: ['TrustServicesCriterion'] },
        { name: 'CC6.4', label: 'CC6.4 physical access restriction', comment: 'Physical access to facilities and protected assets — data centres, backup media and other sensitive locations — is limited to authorized people.', types: ['TrustServicesCriterion'] },
        { name: 'CC6.5', label: 'CC6.5 disposal of physical assets', comment: 'Protections over a physical asset are withdrawn only once the data and software on it can no longer be read or recovered, and are no longer needed.', types: ['TrustServicesCriterion'] },
        { name: 'CC6.6', label: 'CC6.6 protection against external threats', comment: 'Logical access measures protect the system against threats from sources outside its boundaries.', types: ['TrustServicesCriterion'] },
        { name: 'CC6.7', label: 'CC6.7 protection of information in transit', comment: 'Transmitting, moving and removing information is limited to authorized users and processes, and the information is protected while it moves.', exactMatch: ['ie-soc2:CC6.7'], types: ['TrustServicesCriterion'] },
        { name: 'CC6.8', label: 'CC6.8 malicious software prevention', comment: 'Controls prevent, or detect and act on, the introduction of unauthorized or malicious software.', exactMatch: ['ie-soc2:CC6.8'], types: ['TrustServicesCriterion'] },
        { name: 'CC7.3', label: 'CC7.3 security event evaluation', comment: 'Security events are evaluated to decide whether they could cause, or have caused, a failure to meet the entity\'s objectives (a security incident) and, where they could or did, action is taken to prevent or address the failure.', exactMatch: ['ie-soc2:CC7.3'], types: ['TrustServicesCriterion'] },
        { name: 'CC7.4', label: 'CC7.4 security incident response', comment: 'Identified security incidents are handled through a defined response programme that works to understand, contain, remediate and communicate them, as appropriate.', exactMatch: ['ie-soc2:CC7.4'], types: ['TrustServicesCriterion'] },
        { name: 'CC7.5', label: 'CC7.5 security incident recovery', comment: 'Activities to recover from identified security incidents are identified, developed and carried out.', exactMatch: ['ie-soc2:CC7.5'], types: ['TrustServicesCriterion'] },
        { name: 'CC8.1', label: 'CC8.1 change management', comment: 'Changes to infrastructure, data, software and procedures are authorized, designed or acquired, configured, documented, tested, approved and implemented, so that they serve the entity\'s objectives.', exactMatch: ['ie-soc2:CC8.1'], types: ['TrustServicesCriterion'] },
      ],
    },
  ],
  disjoint: [['TrustServicesCriterion', 'OperationalEvidenceEvent']],
  shapes: [
    {
      name: 'OperationalEvidenceEventShape', targetClass: 'OperationalEvidenceEvent', label: 'SOC 2 evidence-event conformance',
      comment: 'An operational evidence event cites a criterion it evidences, carries the instant it occurred, and names the acting agent and the recovered signer, so an audit pack shows who acted and which criterion the event is evidence for.',
      constraints: [
        { path: 'evidences', minCount: 1, comment: 'cite at least one Trust Services Criterion' },
        { path: 'occurredAt', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime', comment: 'one occurrence instant in the audit period' },
        { path: 'actingAgent', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'the acting agent, by its DID' },
        { path: 'signer', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the recovered signer address' },
      ],
    },
  ],
};

// ── EU AI Act (Regulation (EU) 2024/1689) — provider/deployer obligations ──
export const EU_AI_ACT_MODEL: OntologyModel = {
  selectByDomainAndRange: true,
  generatedContext: true,
  module: 'eu-ai-act',
  title: 'EU AI Act (Regulation (EU) 2024/1689) — obligation mapping',
  description: `OWL + SHACL projection of the Interego substrate's EU AI Act mapping (${SUBSTRATE_NS}eu-ai-act): the obligations most relevant to AI agents and tutors — for high-risk systems, risk management (Art. 9), data governance (Art. 10), record-keeping (Art. 12), transparency to deployers (Art. 13), human oversight (Art. 14) and accuracy and robustness (Art. 15); and, for any system that interacts with people, transparency to them (Art. 50). Composed into PGSL and projected here so a cited Article IRI dereferences, and an action record can name the obligation it is evidence for.`,
  version: '2026.10.0',
  spec: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  standards: [
    { title: 'Regulation (EU) 2024/1689 of the European Parliament and of the Council (Artificial Intelligence Act)', url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj' },
  ],
  bodies: ['the European Union'],
  seeAlso: [`${SUBSTRATE_NS}eu-ai-act`],
  prefixes: { iep: `${SUBSTRATE_NS}iep#`, 'ie-eu-ai-act': `${SUBSTRATE_NS}eu-ai-act#` },
  notes: [
    `Mapped to the Interego substrate's EU AI Act vocabulary (prefix eu-ai-act:, ${SUBSTRATE_NS}eu-ai-act) by SKOS mappings: its Article individuals by exact match, and the evidence classes that realize an obligation by related match.`,
    'Each obligation is defined in the Regulation\'s terms. A record names the obligation it is offered as evidence for (conformsToArticle); the claim is the record\'s, and whether the evidence suffices is for the provider, the deployer and the authorities to judge.',
    'The Articles are concepts of one list (Article), and each stands for the obligation its Article imposes: it is an Obligation, typed with the kind of obligation it is (RecordKeeping, HumanOversight, …), and carries its Article number. So the class, the list and the number name the same obligations, and a record that names an Article concept meets the obligation shapes.',
  ],
  classes: [
    { name: 'Obligation', label: 'AI Act Obligation', comment: 'An obligation the EU AI Act places on the providers or deployers of AI systems: for high-risk systems (Articles 9 to 15) and, whatever a system\'s risk, for systems that interact with people (Article 50). Its instances are this document\'s Article concepts, each the obligation its Article imposes.', changeNote: '2026.10.0: defined as the obligations of Articles 9 to 15 and 50, not of high-risk systems alone, and typed onto the Article concepts that name them.' },
    { name: 'RecordKeeping', label: 'Record-Keeping (Art.12)', comment: 'Art.12: high-risk AI systems shall technically allow for the automatic recording of events (logs) over their lifetime, ensuring traceability of functioning.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:LoggedAction'] },
    { name: 'HumanOversight', label: 'Human Oversight (Art.14)', comment: 'Art.14: high-risk AI systems shall be designed so they can be effectively overseen by natural persons, including the ability to intervene or interrupt.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:HumanOversightCheckpoint'] },
    { name: 'Transparency', label: 'Transparency to Deployers (Art.13)', comment: 'Art.13: high-risk AI systems shall be sufficiently transparent to enable deployers to interpret output and use it appropriately, accompanied by instructions for use.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:TransparencyDisclosure'] },
    { name: 'RiskManagement', label: 'Risk Management (Art.9)', comment: 'Art.9: a risk-management system shall be established, implemented, documented and maintained across the lifecycle of the high-risk AI system.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:RiskManagementRecord'] },
    { name: 'DataGovernance', label: 'Data & Data Governance (Art.10)', comment: 'Art.10: training, validation and testing data sets shall be subject to appropriate data-governance and management practices.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:DataGovernanceAttestation'] },
    { name: 'InteractionTransparency', label: 'Transparency to Persons (Art.50)', comment: 'Art.50: providers shall ensure that AI systems intended to interact directly with natural persons are designed so that those persons are informed that they are interacting with an AI system, unless that is obvious; and providers and deployers shall mark or disclose AI-generated or manipulated content as the Article sets out. Applies to such systems whether or not they are high-risk.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:Article50Disclosure'] },
    { name: 'AccuracyRobustness', label: 'Accuracy, Robustness, Cybersecurity (Art.15)', comment: 'Art.15: high-risk AI systems shall achieve appropriate levels of accuracy, robustness and cybersecurity, consistent throughout their lifecycle.', subClassOf: ['Obligation'], relatedMatch: ['ie-eu-ai-act:AccuracyAttestation'] },
  ],
  properties: [
    { name: 'conformsToArticle', kind: 'object', label: 'conformsToArticle', comment: 'Names the EU AI Act obligation (one of this document\'s Article concepts) that the subject, a record of an action or a system, is offered as evidence of meeting. The claim is the subject\'s; whether the evidence suffices is for the provider, the deployer and the authorities to judge.', range: 'Obligation', changeNote: '2026.10.0: a claim of evidence, not a judgment that the obligation is met.' },
    { name: 'article', kind: 'datatype', label: 'article', comment: 'The number of the Article that imposes an obligation, as the Regulation numbers it (e.g. "12").', domain: 'Obligation', range: 'xsd:string', functional: true },
  ],
  vocabularies: [
    {
      name: 'Article', label: 'EU AI Act Articles',
      comment: 'The Articles this mapping covers: Articles 9 to 15 for high-risk AI systems, and Article 50 for systems that interact with people. Each concept stands for the obligation its Article imposes, typed with the kind of obligation it is and carrying its Article number.',
      members: [
        { name: 'Article9', label: 'Article 9 — Risk management system', comment: 'Establish/maintain a risk-management system across the lifecycle.', exactMatch: ['ie-eu-ai-act:Article9'], types: ['Obligation', 'RiskManagement'], values: { article: '9' } },
        { name: 'Article10', label: 'Article 10 — Data and data governance', comment: 'Data-governance practices for training/validation/testing data.', exactMatch: ['ie-eu-ai-act:Article10'], types: ['Obligation', 'DataGovernance'], values: { article: '10' } },
        { name: 'Article12', label: 'Article 12 — Record-keeping', comment: 'Automatic, lifetime logging ensuring traceability of functioning.', exactMatch: ['ie-eu-ai-act:Article12'], types: ['Obligation', 'RecordKeeping'], values: { article: '12' } },
        { name: 'Article13', label: 'Article 13 — Transparency and provision of information to deployers', comment: 'Transparent operation + instructions for use.', types: ['Obligation', 'Transparency'], values: { article: '13' } },
        { name: 'Article14', label: 'Article 14 — Human oversight', comment: 'Effective human oversight, intervention and interruption.', exactMatch: ['ie-eu-ai-act:Article14'], types: ['Obligation', 'HumanOversight'], values: { article: '14' } },
        { name: 'Article15', label: 'Article 15 — Accuracy, robustness and cybersecurity', comment: 'Appropriate accuracy, robustness and cybersecurity over the lifecycle.', exactMatch: ['ie-eu-ai-act:Article15'], types: ['Obligation', 'AccuracyRobustness'], values: { article: '15' } },
        { name: 'Article50', label: 'Article 50 — Transparency obligations for providers and deployers of certain AI systems', comment: 'Informing people that they are interacting with an AI system, and marking or disclosing AI-generated or manipulated content.', types: ['Obligation', 'InteractionTransparency'], values: { article: '50' } },
      ],
    },
  ],
  disjoint: [['RecordKeeping', 'HumanOversight', 'Transparency', 'RiskManagement', 'DataGovernance', 'AccuracyRobustness', 'InteractionTransparency']],
  shapes: [
    {
      name: 'ObligationConformanceShape', targetClass: 'Obligation', label: 'AI Act obligation conformance',
      comment: 'An obligation names the Article that imposes it. Every Article concept of this document does; so does any obligation a record names by RDFS inference from conformsToArticle\'s range, when it is one of them.',
      constraints: [
        { path: 'article', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the Article number' },
      ],
    },
  ],
};

// ── NIST AI Risk Management Framework (AI RMF 1.0) — four functions ──
export const NIST_RMF_MODEL: OntologyModel = {
  selectByDomainAndRange: true,
  generatedContext: true,
  module: 'nist-rmf',
  title: 'NIST AI Risk Management Framework 1.0 — function mapping',
  description: `OWL + SHACL projection of the Interego substrate's NIST AI RMF mapping (${SUBSTRATE_NS}nist-rmf): the four core functions (Govern / Map / Measure / Manage), so that a record of an action can name the function it contributes to. Composed into PGSL and projected here so a cited function IRI dereferences.`,
  version: '2026.10.0',
  spec: 'https://www.nist.gov/itl/ai-risk-management-framework',
  standards: [
    { title: 'NIST AI 100-1 — Artificial Intelligence Risk Management Framework (AI RMF 1.0), January 2023', url: 'https://doi.org/10.6028/NIST.AI.100-1' },
  ],
  bodies: ['NIST'],
  seeAlso: [`${SUBSTRATE_NS}nist-rmf`, 'https://www.nist.gov/itl/ai-risk-management-framework'],
  prefixes: { iep: `${SUBSTRATE_NS}iep#`, 'ie-nist-rmf': `${SUBSTRATE_NS}nist-rmf#` },
  notes: [
    'AI RMF 1.0 is the current version of the framework; NIST\'s later publications, such as the Generative AI Profile (NIST AI 600-1, 2024), are profiles of it and keep its four functions.',
    `Mapped to the Interego substrate's NIST AI RMF vocabulary (prefix nist-rmf:, ${SUBSTRATE_NS}nist-rmf) by SKOS mappings.`,
    'The four functions are the concepts of one list (CoreFunction). Each is a Function, typed with its own class (Govern, Map, Measure, Manage), and carries its id: the class, the list and the id name the same four functions, and a record that names a CoreFunction concept meets the function shape.',
  ],
  classes: [
    { name: 'Function', label: 'AI RMF Core Function', comment: 'One of the four functions of the NIST AI RMF 1.0 core. Its instances are the four concepts of this document\'s CoreFunction list. A record of an action that addresses a function (addressesFunction) is evidence toward it.', changeNote: '2026.10.0: typed onto the CoreFunction concepts that name the functions.' },
    { name: 'Govern', label: 'Govern', comment: 'Cultivate a culture of risk management; policies, accountability, and oversight structures are in place and applied. Its one instance is the concept GOVERN; the class is kept to match the substrate\'s nist-rmf:Govern.', subClassOf: ['Function'], closeMatch: ['ie-nist-rmf:Govern'] },
    { name: 'Map', label: 'Map', comment: 'Establish the context to frame risks; categorize the AI system and its capabilities, intended uses, and impacts. Its one instance is the concept MAP; the class is kept to match the substrate\'s nist-rmf:Map.', subClassOf: ['Function'], closeMatch: ['ie-nist-rmf:Map'] },
    { name: 'Measure', label: 'Measure', comment: 'Employ quantitative, qualitative, or mixed methods to analyze, assess, benchmark, and monitor AI risk. Its one instance is the concept MEASURE; the class is kept to match the substrate\'s nist-rmf:Measure.', subClassOf: ['Function'], closeMatch: ['ie-nist-rmf:Measure'] },
    { name: 'Manage', label: 'Manage', comment: 'Allocate resources to mapped and measured risks; respond to, recover from, and communicate about incidents. Its one instance is the concept MANAGE; the class is kept to match the substrate\'s nist-rmf:Manage.', subClassOf: ['Function'], closeMatch: ['ie-nist-rmf:Manage'] },
  ],
  properties: [
    { name: 'addressesFunction', kind: 'object', label: 'addressesFunction', comment: 'Names the AI RMF core function (one of this document\'s CoreFunction concepts) that the subject, a record of an action or a control, contributes to.', range: 'Function', relatedMatch: ['ie-nist-rmf:contributesTo'] },
    { name: 'functionId', kind: 'datatype', label: 'functionId', comment: 'The id of a core function, as the AI RMF names it in capitals: GOVERN, MAP, MEASURE or MANAGE.', domain: 'Function', oneOf: ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'], functional: true },
  ],
  vocabularies: [
    {
      name: 'CoreFunction', label: 'NIST AI RMF Core Functions',
      comment: 'The four functions of the AI RMF 1.0 core.',
      members: [
        { name: 'GOVERN', label: 'GOVERN', comment: 'Risk-management culture, policies, accountability, oversight.', types: ['Function', 'Govern'], values: { functionId: 'GOVERN' } },
        { name: 'MAP', label: 'MAP', comment: 'Context, categorization, capabilities, intended use, impacts.', types: ['Function', 'Map'], values: { functionId: 'MAP' } },
        { name: 'MEASURE', label: 'MEASURE', comment: 'Analyze, assess, benchmark, monitor AI risk.', types: ['Function', 'Measure'], values: { functionId: 'MEASURE' } },
        { name: 'MANAGE', label: 'MANAGE', comment: 'Prioritize, respond, recover, communicate about risk.', types: ['Function', 'Manage'], values: { functionId: 'MANAGE' } },
      ],
    },
  ],
  disjoint: [['Govern', 'Map', 'Measure', 'Manage']],
  shapes: [
    {
      name: 'FunctionEvidenceShape', targetClass: 'Function', label: 'AI RMF function-evidence conformance',
      comment: 'A core function carries its id. Every CoreFunction concept of this document does; so does any function a record names by RDFS inference from addressesFunction\'s range, when it is one of them.',
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
