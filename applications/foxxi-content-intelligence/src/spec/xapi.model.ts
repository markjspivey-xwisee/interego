/**
 * xAPI 2.0 (IEEE 9274.1.1-2023) §4 data model — the single source.
 *
 * Composed into the PGSL lattice (composeSpecOntology) and projected to OWL/SHACL/
 * JSON-LD on dereference at <bridge>/ns/xapi. The LRS validates statements against
 * the SHACL shapes this model publishes (validateAgainstShape) — so a statement is
 * checked against THIS ontology, and every conformance result cites its shape IRI.
 */
import type { OntologyModel } from '../spec-ontology.js';

// Case-insensitive hex (RFC 4122/9562) — this is the pattern the StatementShape `id` constraint
// uses under the case-SENSITIVE SHACL engine, so the char class must carry both cases or a
// spec-valid uppercase-hex UUID is false-rejected while the LRS ingest ('i' flag) accepts it.
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** Canonical xAPI vocabularies + lexical patterns — the SINGLE SOURCE the runtime
 *  LRS validator (xapi-validate.ts) consumes AND the published SHACL shapes render
 *  from, so what gates a statement on write is the same thing the ontology declares.
 *  (UUID matched case-insensitively per the LRS's accepted behavior.) */
export const XAPI_INTERACTION_TYPES = ['true-false', 'choice', 'fill-in', 'long-fill-in', 'matching', 'performance', 'sequencing', 'likert', 'numeric', 'other'] as const;
// UUID hex is case-INSENSITIVE per RFC 4122/9562 — the char class carries BOTH cases so the
// pattern matches identically whether an engine applies the 'i' flag (the LRS ingest validator)
// or not (the SHACL `new RegExp(pattern)` engine). Previously `[0-9a-f]` + an 'i'-only-on-ingest
// mismatch made the SHACL oracle false-reject a spec-valid uppercase-hex UUID the LRS accepted.
export const XAPI_PATTERNS = { uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', version: '^(1\\.0(\\.\\d+)?|2\\.0(\\.\\d+)?)$' } as const;
const VERSION = '^(1\\.0(\\.\\d+)?|2\\.0(\\.\\d+)?)$';
// RFC 3339 dateTime (T/t/space separator; optional fractional seconds; offset or Z).
const TIMESTAMP = '^\\d{4}-\\d{2}-\\d{2}[Tt ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?$';
const DURATION = '^P(?:\\d+(?:\\.\\d+)?Y)?(?:\\d+(?:\\.\\d+)?M)?(?:\\d+(?:\\.\\d+)?W)?(?:\\d+(?:\\.\\d+)?D)?(?:T(?:\\d+(?:\\.\\d+)?H)?(?:\\d+(?:\\.\\d+)?M)?(?:\\d+(?:\\.\\d+)?S)?)?$';

export const XAPI_MODEL: OntologyModel = {
  module: 'xapi',
  title: 'xAPI 2.0 — Experience API data model',
  description: 'OWL + SHACL ontology of the IEEE 9274.1.1-2023 (xAPI 2.0) §4 Statement data model: Statement, Actor (Agent/Group), Verb, Object (Activity/StatementRef/SubStatement), Result, Score, Context, ContextActivities, Attachment. Composed into PGSL and projected here; the Foxxi LRS validates statements against the shapes below.',
  version: '2.0.0',
  spec: 'https://opensource.ieee.org/xapi/xapi-base-standard-documentation',
  classes: [
    { name: 'Statement', label: 'Statement', comment: 'A single xAPI Statement asserting that an Actor did something (§4.1).' },
    { name: 'SubStatement', label: 'SubStatement', comment: 'A Statement included as the object of another Statement; not itself stored/queried independently (§4.1.4.2.3).', subClassOf: ['Object'] },
    { name: 'Actor', label: 'Actor', comment: 'The Agent or Group the Statement is about (§4.1.2).' },
    { name: 'Agent', label: 'Agent', comment: 'A single person or system, identified by exactly one Inverse Functional Identifier (§4.1.2.1).', subClassOf: ['Actor'] },
    { name: 'Group', label: 'Group', comment: 'A collection of Agents — identified (with one IFI) or anonymous (member list) (§4.1.2.2).', subClassOf: ['Actor'] },
    { name: 'Account', label: 'Account', comment: 'An account on a system, identified by homePage + name (§4.1.2.3).' },
    { name: 'Verb', label: 'Verb', comment: 'The action of the Statement, an IRI with a language-map display (§4.1.3).' },
    { name: 'Object', label: 'Object', comment: 'What the Actor interacted with: an Activity, Agent/Group, StatementRef, or SubStatement (§4.1.4).' },
    { name: 'Activity', label: 'Activity', comment: 'An IRI-identified unit of instruction/experience (§4.1.4.1).', subClassOf: ['Object'] },
    { name: 'ActivityDefinition', label: 'Activity Definition', comment: 'Optional metadata for an Activity: name, description, type, interaction model (§4.1.4.1).' },
    { name: 'InteractionComponent', label: 'Interaction Component', comment: 'A choice/scale/source/target/step component of a cmi-interaction Activity (§4.1.4.1).' },
    { name: 'StatementRef', label: 'Statement Reference', comment: 'A pointer to another Statement by UUID (§4.1.4.3).', subClassOf: ['Object'] },
    { name: 'Result', label: 'Result', comment: 'A measured outcome of the Statement (§4.1.5).' },
    { name: 'Score', label: 'Score', comment: 'The score within a Result: scaled / raw / min / max (§4.1.5.1).' },
    { name: 'Context', label: 'Context', comment: 'The circumstances the Statement occurred in (§4.1.6).' },
    { name: 'ContextActivities', label: 'Context Activities', comment: 'parent / grouping / category / other Activities of the Context (§4.1.6.2).' },
    { name: 'Attachment', label: 'Attachment', comment: 'A digital artifact attached to the Statement (§4.1.11).' },
  ],
  properties: [
    { name: 'id', kind: 'datatype', label: 'id', comment: 'UUID of the Statement (§4.1.1).', domain: 'Statement', range: 'xsd:string' },
    { name: 'actor', kind: 'object', label: 'actor', comment: 'The Agent or Group the Statement is about (§4.1.2).', domain: 'Statement', range: 'Actor' },
    { name: 'verb', kind: 'object', label: 'verb', comment: 'The action of the Statement (§4.1.3).', domain: 'Statement', range: 'Verb' },
    { name: 'object', kind: 'object', label: 'object', comment: 'What the Statement is about (§4.1.4).', domain: 'Statement', range: 'Object' },
    { name: 'result', kind: 'object', label: 'result', comment: 'Measured outcome (§4.1.5).', domain: 'Statement', range: 'Result' },
    { name: 'context', kind: 'object', label: 'context', comment: 'Circumstances of the Statement (§4.1.6).', domain: 'Statement', range: 'Context' },
    { name: 'timestamp', kind: 'datatype', label: 'timestamp', comment: 'When the experience occurred — RFC 3339 (§4.1.7).', domain: 'Statement', range: 'xsd:dateTime' },
    { name: 'stored', kind: 'datatype', label: 'stored', comment: 'When the LRS stored the Statement (§4.1.8).', domain: 'Statement', range: 'xsd:dateTime' },
    { name: 'authority', kind: 'object', label: 'authority', comment: 'The Agent/Group asserting this Statement is true (§4.1.9).', domain: 'Statement', range: 'Actor' },
    { name: 'version', kind: 'datatype', label: 'version', comment: 'xAPI version (§4.1.10).', domain: 'Statement', range: 'xsd:string' },
    { name: 'attachments', kind: 'object', label: 'attachments', comment: 'Attachments (§4.1.11).', domain: 'Statement', range: 'Attachment' },
    // Actor / Agent / Group
    { name: 'objectType', kind: 'datatype', label: 'objectType', comment: 'Agent | Group | Activity | StatementRef | SubStatement.', range: 'xsd:string' },
    { name: 'name', kind: 'datatype', label: 'name', comment: 'Full name of the Agent/Group, or account name.', range: 'xsd:string' },
    { name: 'mbox', kind: 'datatype', label: 'mbox', comment: 'An mailto: IRI — an Inverse Functional Identifier (§4.1.2.1).', domain: 'Agent', range: 'xsd:string' },
    { name: 'mbox_sha1sum', kind: 'datatype', label: 'mbox_sha1sum', comment: 'Hex SHA1 of a mailto: IRI — an IFI.', domain: 'Agent', range: 'xsd:string' },
    { name: 'openid', kind: 'datatype', label: 'openid', comment: 'An OpenID URI — an IFI.', domain: 'Agent', range: 'xsd:string' },
    { name: 'account', kind: 'object', label: 'account', comment: 'A system account — an IFI (§4.1.2.3).', domain: 'Agent', range: 'Account' },
    { name: 'member', kind: 'object', label: 'member', comment: 'Members of a Group (§4.1.2.2).', domain: 'Group', range: 'Agent' },
    { name: 'homePage', kind: 'datatype', label: 'homePage', comment: 'The home page of the account system (IRI).', domain: 'Account', range: 'xsd:string' },
    // Verb
    { name: 'display', kind: 'datatype', label: 'display', comment: 'Human-readable language-map of the verb/attachment (§4.1.3).', range: 'rdf:langString' },
    // Activity
    { name: 'definition', kind: 'object', label: 'definition', comment: 'Activity metadata (§4.1.4.1).', domain: 'Activity', range: 'ActivityDefinition' },
    { name: 'description', kind: 'datatype', label: 'description', comment: 'Language-map description.', range: 'rdf:langString' },
    { name: 'type', kind: 'datatype', label: 'type', comment: 'Activity type IRI (§4.1.4.1).', domain: 'ActivityDefinition', range: 'xsd:anyURI' },
    { name: 'moreInfo', kind: 'datatype', label: 'moreInfo', comment: 'IRI to a human-readable description of the Activity.', domain: 'ActivityDefinition', range: 'xsd:anyURI' },
    { name: 'interactionType', kind: 'datatype', label: 'interactionType', comment: 'cmi interaction type (§4.1.4.1).', domain: 'ActivityDefinition', range: 'xsd:string' },
    { name: 'correctResponsesPattern', kind: 'datatype', label: 'correctResponsesPattern', comment: 'Pattern(s) of the correct response (§4.1.4.1).', domain: 'ActivityDefinition', range: 'xsd:string' },
    // Result / Score
    { name: 'score', kind: 'object', label: 'score', comment: 'The score (§4.1.5.1).', domain: 'Result', range: 'Score' },
    { name: 'success', kind: 'datatype', label: 'success', comment: 'Whether the attempt was successful (§4.1.5).', domain: 'Result', range: 'xsd:boolean' },
    { name: 'completion', kind: 'datatype', label: 'completion', comment: 'Whether the Activity was completed (§4.1.5).', domain: 'Result', range: 'xsd:boolean' },
    { name: 'response', kind: 'datatype', label: 'response', comment: 'The response for the interaction (§4.1.5).', domain: 'Result', range: 'xsd:string' },
    { name: 'duration', kind: 'datatype', label: 'duration', comment: 'ISO 8601 duration of the experience (§4.1.5).', domain: 'Result', range: 'xsd:duration' },
    { name: 'scaled', kind: 'datatype', label: 'scaled', comment: 'Score normalized to -1..1 (§4.1.5.1).', domain: 'Score', range: 'xsd:decimal' },
    { name: 'raw', kind: 'datatype', label: 'raw', comment: 'Raw score between min and max (§4.1.5.1).', domain: 'Score', range: 'xsd:decimal' },
    { name: 'min', kind: 'datatype', label: 'min', comment: 'Lowest possible score (§4.1.5.1).', domain: 'Score', range: 'xsd:decimal' },
    { name: 'max', kind: 'datatype', label: 'max', comment: 'Highest possible score (§4.1.5.1).', domain: 'Score', range: 'xsd:decimal' },
    // Context
    { name: 'registration', kind: 'datatype', label: 'registration', comment: 'UUID grouping a set of experiences (§4.1.6).', domain: 'Context', range: 'xsd:string' },
    { name: 'instructor', kind: 'object', label: 'instructor', comment: 'Instructor Agent/Group (§4.1.6).', domain: 'Context', range: 'Actor' },
    { name: 'team', kind: 'object', label: 'team', comment: 'The Group the Actor is acting within (§4.1.6).', domain: 'Context', range: 'Group' },
    { name: 'contextActivities', kind: 'object', label: 'contextActivities', comment: 'Related Activities (§4.1.6.2).', domain: 'Context', range: 'ContextActivities' },
    { name: 'revision', kind: 'datatype', label: 'revision', comment: 'Revision of the Activity (§4.1.6).', domain: 'Context', range: 'xsd:string' },
    { name: 'platform', kind: 'datatype', label: 'platform', comment: 'Platform the experience occurred on (§4.1.6).', domain: 'Context', range: 'xsd:string' },
    { name: 'language', kind: 'datatype', label: 'language', comment: 'RFC 5646 language tag of the experience (§4.1.6).', domain: 'Context', range: 'xsd:language' },
    { name: 'parent', kind: 'object', label: 'parent', comment: 'Direct parent Activities (§4.1.6.2).', domain: 'ContextActivities', range: 'Activity' },
    { name: 'grouping', kind: 'object', label: 'grouping', comment: 'Grouping Activities (§4.1.6.2).', domain: 'ContextActivities', range: 'Activity' },
    { name: 'category', kind: 'object', label: 'category', comment: 'Category Activities — e.g. a Profile (§4.1.6.2).', domain: 'ContextActivities', range: 'Activity' },
    { name: 'other', kind: 'object', label: 'other', comment: 'Other related Activities (§4.1.6.2).', domain: 'ContextActivities', range: 'Activity' },
    // Attachment
    { name: 'usageType', kind: 'datatype', label: 'usageType', comment: 'IRI describing the attachment usage (§4.1.11).', domain: 'Attachment', range: 'xsd:anyURI' },
    { name: 'contentType', kind: 'datatype', label: 'contentType', comment: 'Internet Media Type of the attachment (§4.1.11).', domain: 'Attachment', range: 'xsd:string' },
    { name: 'length', kind: 'datatype', label: 'length', comment: 'Octet length of the attachment (§4.1.11).', domain: 'Attachment', range: 'xsd:integer' },
    { name: 'sha2', kind: 'datatype', label: 'sha2', comment: 'SHA-2 hash of the attachment (§4.1.11).', domain: 'Attachment', range: 'xsd:string' },
    { name: 'fileUrl', kind: 'datatype', label: 'fileUrl', comment: 'IRI the attachment can be retrieved from (§4.1.11).', domain: 'Attachment', range: 'xsd:anyURI' },
    { name: 'extensions', kind: 'object', label: 'extensions', comment: 'Map of IRI→value extension data (§4.1.4.1/§4.1.5/§4.1.6).', range: 'rdf:JSON' },
  ],
  vocabularies: [
    {
      name: 'InteractionType', label: 'cmi Interaction Types', comment: 'The interactionType vocabulary for cmi-interaction Activities (§4.1.4.1).',
      members: [
        { name: 'true-false', label: 'true-false' }, { name: 'choice', label: 'choice' }, { name: 'fill-in', label: 'fill-in' },
        { name: 'long-fill-in', label: 'long-fill-in' }, { name: 'matching', label: 'matching' }, { name: 'performance', label: 'performance' },
        { name: 'sequencing', label: 'sequencing' }, { name: 'likert', label: 'likert' }, { name: 'numeric', label: 'numeric' }, { name: 'other', label: 'other' },
      ],
    },
  ],
  shapes: [
    {
      name: 'StatementShape', targetClass: 'Statement', label: 'xAPI Statement conformance',
      comment: 'IEEE 9274.1.1 §4.1: a Statement MUST have actor, verb, object; id (if present) is a UUID; timestamps are RFC 3339; version matches the xAPI version grammar.',
      constraints: [
        { path: 'actor', minCount: 1, maxCount: 1, comment: 'exactly one Actor (§4.1.2)' },
        { path: 'verb', minCount: 1, maxCount: 1, comment: 'exactly one Verb (§4.1.3)' },
        { path: 'object', minCount: 1, maxCount: 1, comment: 'exactly one Object (§4.1.4)' },
        { path: 'id', maxCount: 1, pattern: UUID, comment: 'UUID (§4.1.1)' },
        { path: 'timestamp', maxCount: 1, pattern: TIMESTAMP, comment: 'RFC 3339 (§4.1.7)' },
        { path: 'stored', maxCount: 1, pattern: TIMESTAMP, comment: 'RFC 3339 (§4.1.8)' },
        { path: 'version', maxCount: 1, pattern: VERSION, comment: 'xAPI version grammar (§4.1.10)' },
        { path: 'authority', maxCount: 1, comment: 'one authority Actor (§4.1.9)' },
      ],
    },
    {
      name: 'VerbShape', targetClass: 'Verb', label: 'Verb conformance',
      comment: '§4.1.3: a Verb MUST have an IRI id.',
      constraints: [{ path: 'id', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'IRI (§4.1.3)' }],
    },
    {
      name: 'ActivityShape', targetClass: 'Activity', label: 'Activity conformance',
      comment: '§4.1.4.1: an Activity MUST have an IRI id; interactionType (if present) is from the cmi vocabulary.',
      constraints: [{ path: 'id', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'IRI (§4.1.4.1)' }],
    },
    {
      name: 'InteractionDefinitionShape', targetClass: 'ActivityDefinition', label: 'Interaction definition conformance',
      comment: '§4.1.4.1: interactionType MUST be one of the cmi interaction types.',
      constraints: [{ path: 'interactionType', maxCount: 1, in: ['true-false', 'choice', 'fill-in', 'long-fill-in', 'matching', 'performance', 'sequencing', 'likert', 'numeric', 'other'], comment: 'cmi interaction vocabulary (§4.1.4.1)' }],
    },
    {
      name: 'ScoreShape', targetClass: 'Score', label: 'Score conformance',
      comment: '§4.1.5.1: scaled is within -1..1; raw/min/max are numbers.',
      constraints: [
        { path: 'scaled', maxCount: 1, datatype: 'xsd:decimal', minInclusive: -1, maxInclusive: 1, comment: 'scaled ∈ [-1,1] (§4.1.5.1)' },
        { path: 'raw', maxCount: 1, datatype: 'xsd:decimal' },
        { path: 'min', maxCount: 1, datatype: 'xsd:decimal' },
        { path: 'max', maxCount: 1, datatype: 'xsd:decimal' },
      ],
    },
    {
      name: 'ResultShape', targetClass: 'Result', label: 'Result conformance',
      comment: '§4.1.5: success/completion are booleans; duration is an ISO 8601 duration.',
      constraints: [
        { path: 'success', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'completion', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'duration', maxCount: 1, pattern: DURATION, comment: 'ISO 8601 duration (§4.1.5)' },
      ],
    },
    {
      name: 'AgentShape', targetClass: 'Agent', label: 'Agent conformance',
      comment: '§4.1.2.1: an Agent is identified by EXACTLY ONE Inverse Functional Identifier (mbox / mbox_sha1sum / openid / account) — rendered as sh:xone below and enforced by the validator.',
      constraints: [{ path: 'objectType', maxCount: 1, in: ['Agent'] }],
      exactlyOneOf: { paths: ['mbox', 'mbox_sha1sum', 'openid', 'account'], comment: 'exactly one IFI (§4.1.2.1)' },
    },
    {
      name: 'GroupShape', targetClass: 'Group', label: 'Group conformance',
      comment: '§4.1.2.2: an Identified Group has exactly one IFI; an Anonymous Group has a member list and NO IFI. The anonymous-vs-identified disjunction is enforced by the LRS validator (validateXapiStatement).',
      constraints: [{ path: 'objectType', maxCount: 1, in: ['Group'] }],
    },
    {
      name: 'AttachmentShape', targetClass: 'Attachment', label: 'Attachment conformance',
      comment: '§4.1.11: usageType (IRI), display (langmap), contentType, length, sha2 are required.',
      constraints: [
        { path: 'usageType', minCount: 1, maxCount: 1, nodeKind: 'IRI' },
        { path: 'contentType', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'length', minCount: 1, maxCount: 1, datatype: 'xsd:integer' },
        { path: 'sha2', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      ],
    },
  ],
};
