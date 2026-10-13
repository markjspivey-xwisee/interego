/**
 * IEEE-LER record and competency-assertion shapes, and the Open Badges 3.0 / CLR 2.0 credential
 * profiles.
 *
 * The IEEE-LER / ADL-TLA vocabulary (src/ler-tla-vocab.ts) publishes the OWL terms; this file adds
 * the SHACL layer, using the SAME single-source OntologyModel → renderSpecShacl →
 * validateAgainstShape engine that powers /ns/xapi/validate — so a competency assertion (the real
 * output of the ELR rollup) and a credential validate to pass/fail with a cited sh:NodeShape IRI.
 *
 * ★ EACH CONSTRAINT HAS TWO READINGS, AND BOTH ARE REAL. `path` is the JSON field the Foxxi
 * validator reads; `rdfPath` is the predicate a SHACL processor reads in the document's RDF — the
 * one its JSON-LD context maps that field to. The shapes used to name module-local predicates
 * (foxxi-ob3:type, foxxi-ieee-ler:confidence, …) that no ontology declared and no context produced,
 * so a SHACL processor handed a real credential or record found nothing to check. Now an ELR is
 * read through its own context (ELR_CONTEXT_URL, published with the IEEE-LER vocabulary) and its
 * shapes constrain the IEEE-LER, PROV, Dublin Core and Interego terms that context maps it to; an
 * Open Badge or CLR is read through 1EdTech's and the W3C's contexts, so its shapes target 1EdTech's
 * own classes (ob:OpenBadgeCredential, clr:ClrCredential) and the VC 2.0 predicates. The classes
 * and properties these documents had minted for the same things are deprecated in their favour.
 */
import { type OntologyModel, type OntReference, shapesIri, type ValidationResult } from '../spec-ontology.js';
import { validateInstanceWith } from './index.js';
import { semDocMeta, P2997 } from '../ler-tla-vocab.js';

/** What a JSON number becomes in RDF (JSON-LD 1.1 §8.6): an integer or a double; or a decimal. */
const NUMBER = ['xsd:integer', 'xsd:decimal', 'xsd:double'];
const VC2 = { title: 'W3C Verifiable Credentials Data Model v2.0 (W3C Recommendation, 15 May 2025)', url: 'https://www.w3.org/TR/vc-data-model-2.0/' };
const VC_VOCAB = 'https://www.w3.org/2018/credentials#';
const OB_VOCAB = 'https://purl.imsglobal.org/spec/vc/ob/vocab.html';
const CLR_VOCAB = 'https://purl.imsglobal.org/spec/vc/clr/vocab.html';
/** The VC 2.0 terms a credential profile constrains. */
const VC_REFERENCES: OntReference[] = [
  { term: 'vc:VerifiableCredential', kind: 'class', label: 'Verifiable credential', definedBy: VC_VOCAB },
  { term: 'vc:credentialSubject', kind: 'object', label: 'credential subject', definedBy: VC_VOCAB },
];

// ── IEEE-LER: the Enterprise Learner Record, its competency assertions and their evidence ──────
export const LER_MODEL: OntologyModel = {
  module: 'ieee-ler',
  title: 'IEEE LER — Enterprise Learner Record and competency assertion shapes',
  description: 'SHACL shapes for the IEEE P2997 Enterprise Learner Record as Foxxi assembles it, its competency assertions and their evidence — the machine-checkable layer over the /ns/ieee-ler vocabulary. A record is read through the W3C VC 2.0 context and the record context published with the vocabulary; the shapes constrain that reading, and the Foxxi validator checks the same requirements on the JSON.',
  version: '2026.10.0',
  // The vocabulary these shapes constrain is the IEEE LER ontology at /ns/ieee-ler, a document of its
  // own: the shapes graph imports it at its version.
  ontologyVersion: semDocMeta('ler').version,
  spec: P2997,
  standards: [
    { title: 'IEEE P2997 — Standard for Enterprise Learner Record (active PAR)', url: P2997 },
  ],
  bodies: ['IEEE', 'ADL'],
  prefixes: {
    ler: 'https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#',
    tla: 'https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#',
  },
  // These classes only route an instance to its shape; the vocabulary that defines them is the
  // IEEE-LER ontology at /ns/ieee-ler, which this shapes graph imports.
  classes: [
    { name: 'EnterpriseLearnerRecord', label: 'Enterprise Learner Record', comment: 'The IEEE P2997 aggregate record of one subject.' },
    { name: 'CompetencyAssertion', label: 'Competency Assertion', comment: 'A claim that a subject holds a competency at a proficiency level, with a confidence, backed by evidence, produced by a published roll-up rule.', closeMatch: ['tla:Assertion'] },
    { name: 'Evidence', label: 'Evidence', comment: 'An artifact presented in support of a competency assertion.' },
  ],
  properties: [],
  shapes: [
    {
      name: 'EnterpriseLearnerRecordShape', targetClass: 'EnterpriseLearnerRecord',
      label: 'Enterprise Learner Record shape',
      comment: 'An Enterprise Learner Record as Foxxi assembles it (IEEE P2997): identified by an http(s) IRI; conforming to IEEE P2997; saying whether its subject is a human or an agent; held for one subject, identified by a DID or URL; with an organisation path and at least one indication of where its raw data is kept.',
      constraints: [
        { path: 'id', identifies: true, minCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'the record is identified by an http(s) IRI' },
        { path: 'conformsTo', rdfPath: 'dct:conformsTo', minCount: 1, hasValue: P2997, hasIri: P2997, comment: 'conforms to IEEE P2997' },
        { path: 'subjectKind', rdfPath: 'ler:subjectKind', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: ['human', 'agent'], comment: 'a human learner or performer, or an AI agent' },
        { path: 'learner.did', rdfPath: 'ler:aboutLearner', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'the subject the record is about, identified by a DID or URL' },
        { path: 'organizationPath', rdfPath: 'ler:organizationPath', minCount: 1, comment: 'the organisation path (P2997), each step checked by the organisation path step shape' },
        { path: 'provenance.rawDataLocations', rdfPath: 'ler:rawDataLocation', minCount: 1, comment: 'where each class of raw data is kept (P2997)' },
      ],
    },
    {
      name: 'CompetencyAssertionShape', targetClass: 'CompetencyAssertion',
      label: 'Competency Assertion shape',
      comment: 'A competency assertion: about one subject and one competency, at one proficiency level identified by an http(s) IRI, with a success confidence from 0 to 1, produced by a named roll-up rule, attributed to the agent making it, backed by at least one evidence IRI, with an evidence basis and a modal status.',
      constraints: [
        { path: 'subject', rdfPath: 'ler:assertionSubject', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'the subject the assertion is about, identified by a DID or URL' },
        { path: 'aboutCompetency', rdfPath: 'ler:aboutCompetency', minCount: 1, maxCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'the competency definition, an http(s) IRI' },
        { path: 'proficiencyLevel', rdfPath: 'ler:atProficiency', minCount: 1, maxCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'the proficiency level, an http(s) IRI from the published framework' },
        { path: 'confidence', rdfPath: 'ler:successConfidence', minCount: 1, maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'a success confidence from 0 to 1 (the Wilson lower bound on the success rate)' },
        { path: 'rolledUpBy', rdfPath: 'ler:rolledUpBy', minCount: 1, maxCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'the roll-up rule that produced it, an http(s) IRI' },
        { path: 'assertingAgent', rdfPath: 'prov:wasAttributedTo', minCount: 1, nodeKind: 'IRI', comment: 'the agent making the assertion, identified by a DID or URL' },
        // ★ THIS IS A SYNTACTIC CHECK. `sh:pattern "^https?://"` says the value LOOKS like a URL;
        // it does not fetch it. `conforms: true` is compatible with an evidence list no third party
        // can read — LRS statement URLs answer 401 to an anonymous GET, correctly, because xAPI
        // requires auth on every resource. The assembler therefore puts the anonymously-fetchable
        // pod artifact FIRST in the list; this comment says what the shape does and does not
        // establish.
        { path: 'evidence', rdfPath: 'ler:supportedByEvidence', minCount: 1, nodeKind: 'IRI', pattern: '^https?://', comment: 'at least one evidence IRI whose SYNTAX is an http(s) URL. Nothing is dereferenced: conformance means the pointer is well-formed, not that it resolves or that a reader may fetch it. An LRS statement URL here answers 401 anonymously, so the assembler also lists the pod-side artifact the performance cited, which does not.' },
        { path: 'basis', rdfPath: 'ler:evidenceBasis', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: ['performance', 'credential', 'inferred'], comment: 'the evidence basis' },
        { path: 'modalStatus', rdfPath: 'iep:modalStatus', minCount: 1, maxCount: 1, in: ['Asserted', 'Hypothetical'], inIris: ['iep:Asserted', 'iep:Hypothetical'], comment: 'Asserted (demonstrated or credentialed) or Hypothetical (inferred)' },
      ],
    },
    {
      name: 'OrganizationPathStepShape', targetObjectsOf: ['ler:organizationPath'], jsonKeys: ['organizationPath'],
      label: 'Organization path step shape',
      comment: 'A step of an Enterprise Learner Record\'s organisation path (P2997): one organisation or system, identified by a DID or URL; the role it plays for the record; and its place on the path, counting from 1.',
      constraints: [
        { path: 'id', rdfPath: 'ler:pathOrganization', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'the organisation or system, by its DID or URL' },
        { path: 'role', rdfPath: 'ler:pathRole', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the role it plays for this record' },
        { path: 'position', rdfPath: 'ler:pathPosition', minCount: 1, maxCount: 1, datatype: 'xsd:positiveInteger', minInclusive: 1, comment: 'its place on the path, from 1' },
      ],
    },
    {
      name: 'EvidenceShape', targetClass: 'Evidence',
      label: 'Evidence shape',
      comment: 'An evidence node is identified by an IRI locating the raw record.',
      constraints: [
        { path: 'id', identifies: true, minCount: 1, nodeKind: 'IRI', comment: 'the evidence location' },
      ],
    },
  ],
};

// ── What 1EdTech's credentials share ─────────────────────────────────────────────────────────
const VC2_CONTEXT = 'https://www.w3.org/ns/credentials/v2';
/** A pattern matching exactly this URL (portable: `.` is the only character in it to escape). */
const only = (url: string): string => `^${url.replace(/\./g, '\\.')}$`;
/** The OB 3.0 and CLR 2.0 JSON-LD contexts, any revision of either — what 1EdTech's JSON Schemas
 *  accept in those positions (a credential issued under OB 3.0's context-3.0.2.json stays OB 3.0). */
const OB_CONTEXT = '^https://purl\\.imsglobal\\.org/spec/ob/v3p0/context(-3\\.[0-9]+\\.[0-9]+)?\\.json$';
const CLR_CONTEXT = '^https://purl\\.imsglobal\\.org/spec/clr/v2p0/context(-2\\.[0-9]+\\.[0-9]+)?\\.json$';
/** DateTimeZ (OB 3.0 and CLR 2.0 derived types): a date-time with its time zone stated — the
 *  dateTimeStamp VC 2.0 §4.9 requires of validFrom — written as XML Schema writes it (T and Z upper case). */
const DATETIME_Z = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$';
const OB3 = 'Open Badges 3.0';
const CLR2 = 'CLR 2.0';
/** What every credential profile here requires of a VC 2.0 credential, in OB 3.0's and CLR 2.0's words. */
const CREDENTIAL_CORE = (spec: string) => [
  { path: 'id', identifies: true, minCount: 1, nodeKind: 'IRI' as const, comment: `an unambiguous reference to the credential (${spec}: id [1])` },
  { path: 'type', rdfPath: 'rdf:type', hasValue: 'VerifiableCredential', hasIri: 'vc:VerifiableCredential', comment: 'a VerifiableCredential (VC 2.0 §4.5)' },
  { path: 'issuer', rdfPath: 'vc:issuer', minCount: 1, maxCount: 1, nodeKind: 'IRI' as const, comment: `one issuer: an IRI, or a Profile identified by one (${spec}: issuer [1] ProfileRef)` },
  { path: 'validFrom', rdfPath: 'vc:validFrom', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime', pattern: DATETIME_Z, comment: `when the credential becomes valid, with its time zone (${spec}: validFrom [1] DateTimeZ)` },
  { path: 'credentialSubject', rdfPath: 'vc:credentialSubject', minCount: 1, maxCount: 1, comment: `one subject (${spec}: credentialSubject [1])` },
];
const NO_PROOF_NEEDED = 'A proof is optional: a credential secured by an enveloping proof (VC-JOSE-COSE, VC-JWT) carries none, and an embedded proof is a graph of its own, which Data Integrity verification checks rather than these shapes.';
/** The subject's identification, as OB 3.0 and CLR 2.0 both require it: an id, or at least one identifier. */
const IDENTIFIED = (identifier: string) => ({
  alternatives: [{ path: 'id', identifies: true }, { path: 'identifier', rdfPath: identifier }],
  comment: 'the subject is identified by its id, or by at least one identifier',
});

// ── Open Badges 3.0: a profile of 1EdTech's vocabulary and VC 2.0 ───────────────────────────
export const OB3_MODEL: OntologyModel = {
  module: 'ob3',
  title: 'Open Badges 3.0 — credential SHACL profile',
  description: 'SHACL shapes for a 1EdTech Open Badges 3.0 credential — a W3C Verifiable Credential (VC Data Model 2.0) whose subject carries an achievement — the checks Foxxi applies to the credentials it issues and accepts. A profile of Open Badges 3.0: the shapes target 1EdTech\'s own classes and constrain the predicates the OB 3.0 and VC 2.0 JSON-LD contexts map a credential to, and each requirement is OB 3.0\'s (its data model, Appendix B).',
  version: '2026.10.0',
  spec: 'https://www.imsglobal.org/spec/ob/v3p0/',
  standards: [
    { title: '1EdTech Open Badges 3.0 (JSON-LD context 3.0.3)', url: 'https://www.imsglobal.org/spec/ob/v3p0/' },
    VC2,
  ],
  bodies: ['1EdTech', 'W3C'],
  profileOf: ['https://www.imsglobal.org/spec/ob/v3p0/'],
  notes: [
    'Since 2026.10.0 the shapes target 1EdTech\'s classes and the VC 2.0 predicates; the classes and properties this document had minted for them are deprecated.',
    'A credential typed AchievementCredential is an OpenBadgeCredential here: OB 3.0\'s context maps both names to ob:OpenBadgeCredential.',
    'Achievement criteria are read with ob:Criteria, the IRI OB 3.0\'s context maps the criteria property to (the vocabulary\'s Criteria class has the same IRI).',
  ],
  references: [
    { term: 'ob:OpenBadgeCredential', kind: 'class', label: 'Open Badge credential', definedBy: OB_VOCAB },
    { term: 'ob:AchievementSubject', kind: 'class', label: 'Achievement subject', definedBy: OB_VOCAB },
    { term: 'ob:Achievement', kind: 'class', label: 'Achievement', definedBy: OB_VOCAB },
    { term: 'ob:IdentityObject', kind: 'class', label: 'Identity object', definedBy: OB_VOCAB },
    { term: 'ob:Profile', kind: 'class', label: 'Open Badges profile', definedBy: OB_VOCAB },
    { term: 'ob:achievement', kind: 'object', label: 'achievement', definedBy: OB_VOCAB },
    { term: 'ob:identifier', kind: 'object', label: 'identifier', definedBy: OB_VOCAB },
    { term: 'ob:Criteria', kind: 'object', label: 'criteria', definedBy: OB_VOCAB },
    { term: 'ob:hashed', kind: 'datatype', label: 'hashed', definedBy: OB_VOCAB },
    { term: 'ob:identityHash', kind: 'datatype', label: 'identity hash', definedBy: OB_VOCAB },
    { term: 'ob:identityType', kind: 'datatype', label: 'identity type', definedBy: OB_VOCAB },
    ...VC_REFERENCES,
    { term: 'vc:issuer', kind: 'object', label: 'issuer', definedBy: VC_VOCAB },
    { term: 'vc:validFrom', kind: 'datatype', label: 'valid from', definedBy: VC_VOCAB },
    { term: 'schema:name', kind: 'datatype', label: 'name', definedBy: 'https://schema.org/' },
    { term: 'schema:description', kind: 'datatype', label: 'description', definedBy: 'https://schema.org/' },
  ],
  classes: [
    { name: 'OpenBadgeCredential', label: 'Open Badge Credential', comment: 'Formerly this document\'s own name for an Open Badges 3.0 credential; 1EdTech\'s class, which a credential\'s JSON-LD context maps it to, replaces it.', deprecated: true, replacedBy: 'ob:OpenBadgeCredential' },
    { name: 'Achievement', label: 'Achievement', comment: 'Formerly this document\'s own name for an Open Badges 3.0 achievement; 1EdTech\'s class replaces it.', deprecated: true, replacedBy: 'ob:Achievement' },
  ],
  properties: [
    { name: 'issuer', label: 'issuer', comment: 'Formerly this document\'s own name for a credential\'s issuer; the VC 2.0 issuer replaces it.', kind: 'object', deprecated: true, replacedBy: 'vc:issuer' },
    { name: 'credentialSubject', label: 'credential subject', comment: 'Formerly this document\'s own name for a credential\'s subject; the VC 2.0 credentialSubject replaces it.', kind: 'object', deprecated: true, replacedBy: 'vc:credentialSubject' },
    { name: 'proof', label: 'proof', comment: 'Formerly this document\'s own name for a credential\'s proof; the Data Integrity proof (sec:proof) replaces it.', kind: 'object', deprecated: true, replacedBy: 'sec:proof' },
  ],
  shapes: [
    {
      name: 'OpenBadgeCredentialShape', targetClass: 'ob:OpenBadgeCredential', jsonTypes: ['OpenBadgeCredential', 'AchievementCredential'],
      label: 'Open Badge credential shape',
      comment: `An ${OB3} credential (OB 3.0 B.1.2, AchievementCredential): its @context begins with the W3C VC 2.0 context and the OB 3.0 context; it is identified by an IRI; it is a VerifiableCredential; it has one issuer, identified by an IRI, one validFrom date-time with its time zone, and one subject, an AchievementSubject. ${NO_PROOF_NEEDED}`,
      constraints: [
        { path: '@context', minCount: 2, leading: [only(VC2_CONTEXT), OB_CONTEXT], comment: 'the W3C VC 2.0 context first (VC 2.0 §4.1), then the OB 3.0 context (OB 3.0: @context [2..*])' },
        ...CREDENTIAL_CORE('OB 3.0'),
        { path: 'credentialSubject.type', rdfPath: ['vc:credentialSubject', 'rdf:type'], hasValue: 'AchievementSubject', hasIri: 'ob:AchievementSubject', comment: 'the subject is an AchievementSubject (OB 3.0: credentialSubject AchievementSubject)' },
      ],
    },
    {
      name: 'AchievementSubjectShape', targetClass: 'ob:AchievementSubject',
      label: 'Achievement subject shape',
      comment: `The recipient of an ${OB3} achievement (OB 3.0 B.1.3, AchievementSubject): identified by its id or by at least one identifier, with an achievement, an Achievement.`,
      constraints: [
        // At least one, and no maximum: in RDF the subject is the learner, whom every credential
        // about them names, so a graph holding two of their badges — a CLR — gives one node two
        // achievements. OB 3.0's [1] is one achievement object per credential, as its JSON Schema has it.
        { path: 'achievement', rdfPath: 'ob:achievement', minCount: 1, comment: 'the achievement being awarded (achievement [1])' },
        { path: 'achievement.type', rdfPath: ['ob:achievement', 'rdf:type'], hasValue: 'Achievement', hasIri: 'ob:Achievement', comment: 'an Achievement (its type MUST include Achievement)' },
      ],
      atLeastOneOf: IDENTIFIED('ob:identifier'),
    },
    {
      name: 'AchievementShape', targetClass: 'ob:Achievement',
      label: 'Achievement shape',
      comment: `An ${OB3} achievement (OB 3.0 B.1.1, Achievement): identified by an IRI, with a name, a description and criteria.`,
      constraints: [
        { path: 'id', identifies: true, minCount: 1, nodeKind: 'IRI', comment: 'a unique URI for the achievement (id [1])' },
        { path: 'name', rdfPath: 'schema:name', minCount: 1, comment: 'the achievement\'s name (name [1]; several values are one name in several languages)' },
        { path: 'description', rdfPath: 'schema:description', minCount: 1, comment: 'a short description (description [1])' },
        // At least one, and no maximum: criteria are anonymous nodes, so a graph that describes one
        // achievement twice — a CLR bundling a badge it also lists — gives it two.
        { path: 'criteria', rdfPath: 'ob:Criteria', minCount: 1, comment: 'how to earn it (criteria [1])' },
      ],
    },
    {
      name: 'IdentityObjectShape', targetClass: 'ob:IdentityObject',
      label: 'Identity object shape',
      comment: `An identifier of an ${OB3} recipient (OB 3.0 B.1.12, IdentityObject): whether it is hashed, the hash or plain value, and the kind of identity.`,
      constraints: [
        // OB 3.0.3's context types hashed with https://www.w3.org/2001/XMLSchema#boolean — XML Schema's
        // boolean under the https scheme, which is not XML Schema's IRI — so the reading of a real badge
        // carries that datatype; either is accepted.
        { path: 'hashed', rdfPath: 'ob:hashed', minCount: 1, maxCount: 1, datatype: ['xsd:boolean', 'https://www.w3.org/2001/XMLSchema#boolean'], comment: 'whether identityHash is hashed (hashed [1] Boolean)' },
        { path: 'identityHash', rdfPath: 'ob:identityHash', minCount: 1, maxCount: 1, comment: 'the hash or the plain value (identityHash [1])' },
        { path: 'identityType', rdfPath: 'ob:identityType', minCount: 1, maxCount: 1, comment: 'the kind of identity (identityType [1])' },
      ],
    },
    {
      name: 'ProfileShape', targetClass: 'ob:Profile',
      label: 'Profile shape',
      comment: `An ${OB3} profile — an issuer, a creator, an endorser (OB 3.0 B.1.14, Profile): identified by an IRI.`,
      constraints: [
        { path: 'id', identifies: true, minCount: 1, nodeKind: 'IRI', comment: 'a unique URI for the profile (id [1])' },
      ],
    },
  ],
};

// ── Comprehensive Learner Record 2.0: a profile of 1EdTech's vocabulary and VC 2.0 ────────────
export const CLR_MODEL: OntologyModel = {
  module: 'clr',
  title: 'Comprehensive Learner Record 2.0 — credential SHACL profile',
  description: 'SHACL shapes for a 1EdTech Comprehensive Learner Record 2.0 — a W3C Verifiable Credential (VC Data Model 2.0) whose subject bundles achievement credentials. A profile of CLR 2.0: the shapes target 1EdTech\'s ClrCredential and ClrSubject classes and constrain the predicates the CLR 2.0, OB 3.0 and VC 2.0 JSON-LD contexts map a credential to, and each requirement is CLR 2.0\'s (its data model, Appendix B). The credentials a CLR bundles are Open Badges 3.0 credentials, which the Open Badges 3.0 profile checks. Registered as data — a second credential format needs no new engine.',
  version: '2026.10.0',
  spec: 'https://www.imsglobal.org/spec/clr/v2p0/',
  standards: [
    { title: '1EdTech Comprehensive Learner Record 2.0 (JSON-LD context 2.0.1)', url: 'https://www.imsglobal.org/spec/clr/v2p0/' },
    VC2,
  ],
  bodies: ['1EdTech', 'W3C'],
  profileOf: ['https://www.imsglobal.org/spec/clr/v2p0/'],
  notes: ['Since 2026.10.0 the shapes target 1EdTech\'s ClrCredential and ClrSubject classes and the VC 2.0 predicates; the class and properties this document had minted for them are deprecated.'],
  // Inside this model `clr:` is the module itself, so 1EdTech's CLR vocabulary has its own prefix
  // here; the documents print it as clr:.
  prefixes: { 'clr-vocab': `${CLR_VOCAB}#` },
  references: [
    { term: 'clr-vocab:ClrCredential', kind: 'class', label: 'CLR credential', definedBy: CLR_VOCAB },
    { term: 'clr-vocab:ClrSubject', kind: 'class', label: 'CLR subject', definedBy: CLR_VOCAB },
    { term: 'clr-vocab:verifiableCredential', kind: 'object', label: 'verifiable credential', definedBy: CLR_VOCAB },
    { term: 'clr-vocab:identifier-1', kind: 'object', label: 'identifier', definedBy: CLR_VOCAB },
    ...VC_REFERENCES,
    { term: 'vc:issuer', kind: 'object', label: 'issuer', definedBy: VC_VOCAB },
    { term: 'vc:validFrom', kind: 'datatype', label: 'valid from', definedBy: VC_VOCAB },
    { term: 'schema:name', kind: 'datatype', label: 'name', definedBy: 'https://schema.org/' },
  ],
  classes: [
    { name: 'ClrCredential', label: 'CLR Credential', comment: 'Formerly this document\'s own name for a CLR 2.0 credential; 1EdTech\'s class, which a credential\'s JSON-LD context maps it to, replaces it.', deprecated: true, replacedBy: 'clr-vocab:ClrCredential' },
  ],
  properties: [
    { name: 'credentialSubject', label: 'credential subject', comment: 'Formerly this document\'s own name for a credential\'s subject; the VC 2.0 credentialSubject replaces it.', kind: 'object', deprecated: true, replacedBy: 'vc:credentialSubject' },
    { name: 'proof', label: 'proof', comment: 'Formerly this document\'s own name for a credential\'s proof; the Data Integrity proof (sec:proof) replaces it.', kind: 'object', deprecated: true, replacedBy: 'sec:proof' },
  ],
  shapes: [
    {
      name: 'ClrCredentialShape', targetClass: 'clr-vocab:ClrCredential',
      label: 'CLR credential shape',
      comment: `A ${CLR2} credential (CLR 2.0 B.1.1, ClrCredential): its @context begins with the W3C VC 2.0, CLR 2.0 and OB 3.0 contexts; it is identified by an IRI; it is a VerifiableCredential; it has a name, one issuer identified by an IRI, one validFrom date-time with its time zone, and one subject, a ClrSubject. ${NO_PROOF_NEEDED}`,
      constraints: [
        { path: '@context', minCount: 3, leading: [only(VC2_CONTEXT), CLR_CONTEXT, OB_CONTEXT], comment: 'the W3C VC 2.0, CLR 2.0 and OB 3.0 contexts, in that order (CLR 2.0: @context [3..*])' },
        ...CREDENTIAL_CORE('CLR 2.0'),
        { path: 'name', rdfPath: 'schema:name', minCount: 1, comment: 'the name of the CLR (name [1]; several values are one name in several languages)' },
        { path: 'credentialSubject.type', rdfPath: ['vc:credentialSubject', 'rdf:type'], hasValue: 'ClrSubject', hasIri: 'clr-vocab:ClrSubject', comment: 'the subject is a ClrSubject (CLR 2.0: credentialSubject ClrSubject)' },
      ],
    },
    {
      name: 'ClrSubjectShape', targetClass: 'clr-vocab:ClrSubject',
      label: 'CLR subject shape',
      comment: `The learner a ${CLR2} credential is about (CLR 2.0 B.1.2, ClrSubject): identified by its id or by at least one identifier, with the credentials the learner has been awarded.`,
      constraints: [
        { path: 'verifiableCredential', rdfPath: 'clr-vocab:verifiableCredential', minCount: 1, comment: 'the credentials the learner has been awarded (verifiableCredential [1..*])' },
      ],
      atLeastOneOf: IDENTIFIED('clr-vocab:identifier-1'),
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
