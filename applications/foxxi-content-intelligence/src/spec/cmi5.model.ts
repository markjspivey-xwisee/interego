/**
 * cmi5 v1.0 (IEEE 9274.2.1) — the single source.
 *
 * cmi5 is an xAPI Profile + a course-structure binding. This model captures both:
 *   · the cmi5 course structure (§13 `cmi5.xml` — courseStructure / course / block / au),
 *     with launchMethod, moveOn, masteryScore, activityType and launchParameters;
 *   · the cmi5 Profile xAPI surface — the 9 defined verbs (§9), the cmi5 + moveOn
 *     category context activities, the cmi5 context extensions (sessionid / masteryscore /
 *     launchmode / launchurl / moveon / launchparameters) and the result extensions
 *     (progress / reason).
 *
 * Composed into the PGSL lattice (composeSpecOntology) and projected to OWL/SHACL/JSON-LD
 * on dereference at <bridge>/ns/cmi5. The cmi5 reader (cmi5-course.ts) and statement
 * emitter (cmi5.ts) produce instances the SHACL shapes below validate — the AU required
 * fields, the moveOn / launchMethod vocabularies, and masteryScore ∈ [0,1].
 *
 * cmi5 reuses the xAPI 2.0 data model (Statement/Actor/Verb/Object/Result/Context); those
 * terms live in the 'xapi' module and are referenced here via the xapi: prefix.
 *
 * Reference: cmi5 v1.0 — https://github.com/AICC/CMI-5_Spec_Current
 */
import type { OntologyModel } from '../spec-ontology.js';

// cmi5 §13.1.4 AU id / §13.1.2 course id — an IRI.
// masteryScore is a decimal in [0,1] (§13.1.4.4 / §9.5.1).
const MASTERY_MIN = 0;
const MASTERY_MAX = 1;
// cmi5 §3.5 session identifier / §10.1 registration — a UUID.
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export const CMI5_MODEL: OntologyModel = {
  module: 'cmi5',
  title: 'cmi5 v1.0 (IEEE 9274.2.1) — xAPI Profile + course structure',
  description: 'OWL + SHACL ontology of cmi5 v1.0 (IEEE 9274.2.1): the §13 course-structure binding (courseStructure / Course / Block / AssignableUnit with launchMethod, moveOn, masteryScore, activityType, launchParameters) and the cmi5 xAPI Profile surface — the 9 §9 defined verbs, the cmi5 + moveOn category context activities, the cmi5 context extensions (sessionid / masteryscore / launchmode / launchurl / moveon / launchparameters) and result extensions (progress / reason). Reuses the xAPI 2.0 data model from the xapi module. Composed into PGSL and projected here; the Foxxi LMS validates AUs and cmi5 statements against the shapes below.',
  version: '1.0.0',
  spec: 'https://github.com/AICC/CMI-5_Spec_Current',
  derivedFrom: 'xapi',
  prefixes: {
    xapi: 'https://w3id.org/xapi/',
    adl: 'http://adlnet.gov/expapi/verbs/',
    adlx: 'https://w3id.org/xapi/adl/verbs/',
    cmi5ext: 'https://w3id.org/xapi/cmi5/',
  },
  imports: ['xapi'],
  classes: [
    {
      name: 'CourseStructure', label: 'Course Structure',
      comment: 'The root <courseStructure> element of a cmi5.xml document: holds exactly one Course plus the top-level tree of Blocks and Assignable Units (§13.1.1).',
    },
    {
      name: 'Course', label: 'Course',
      comment: 'The cmi5 <course> — an IRI-identified course with a title and description language map (§13.1.2). The course is also an xAPI Activity referenced as contextActivities.grouping.',
    },
    {
      name: 'Block', label: 'Block',
      comment: 'A cmi5 <block> — groups Assignable Units and nested Blocks for organisation and satisfaction roll-up; an IRI-identified xAPI Activity (§13.1.3).',
    },
    {
      name: 'AssignableUnit', label: 'Assignable Unit (AU)',
      comment: 'A cmi5 <au> — the smallest launchable unit of instruction tracked by the LMS; an IRI-identified xAPI Activity with a launch url, launchMethod, moveOn rule, optional masteryScore, activityType and launchParameters (§13.1.4).',
    },
    {
      name: 'Objectives', label: 'Objectives',
      comment: 'The optional <objectives> collection of an AU or Block — a set of referenceable Objective declarations (§13.1.6).',
    },
    {
      name: 'Objective', label: 'Objective',
      comment: 'A single cmi5 <objective> — an IRI-identified learning objective with a title and description (§13.1.6).',
    },
    {
      name: 'Session', label: 'Session',
      comment: 'A single launch-to-termination interaction of one learner with one AU, identified by the cmi5 session id and bound to the xAPI registration; the scope across which the 9 cmi5 statements share state (§3.5, §10).',
    },
  ],
  properties: [
    // ── CourseStructure ──
    { name: 'course', kind: 'object', label: 'course', comment: 'The single Course of the structure (§13.1.1).', domain: 'CourseStructure', range: 'Course' },
    { name: 'structure', kind: 'object', label: 'structure', comment: 'Top-level Blocks and Assignable Units, in document (sequential) order (§13.1.1).', domain: 'CourseStructure', range: 'xapi:Object' },
    // ── shared structural identity / metadata ──
    { name: 'id', kind: 'datatype', label: 'id', comment: 'The IRI identifier of a Course / Block / AU / Objective (the @id attribute) (§13.1.2 / §13.1.3 / §13.1.4 / §13.1.6).', range: 'xsd:anyURI' },
    { name: 'title', kind: 'datatype', label: 'title', comment: 'Language-map title of a Course / Block / AU / Objective — the cmi5 <title><langstring> collection (§13.1.4.1).', range: 'rdf:langString' },
    { name: 'description', kind: 'datatype', label: 'description', comment: 'Language-map description of a Course / Block / AU / Objective — the cmi5 <description><langstring> collection (§13.1.4.2).', range: 'rdf:langString' },
    // ── Block / AU containment ──
    { name: 'block', kind: 'object', label: 'block', comment: 'A child Block nested within a CourseStructure or Block (§13.1.3).', domain: 'Block', range: 'Block' },
    { name: 'au', kind: 'object', label: 'au', comment: 'An Assignable Unit child of a CourseStructure or Block (§13.1.4).', domain: 'Block', range: 'AssignableUnit' },
    { name: 'objectives', kind: 'object', label: 'objectives', comment: 'The Objectives collection referenced by an AU or Block (§13.1.6).', range: 'Objectives' },
    { name: 'objective', kind: 'object', label: 'objective', comment: 'A member Objective of an Objectives collection (§13.1.6).', domain: 'Objectives', range: 'Objective' },
    // ── AU launch + tracking attributes ──
    { name: 'url', kind: 'datatype', label: 'url', comment: 'The AU launch URL — the relative or absolute location the LMS launches; the LMS appends the cmi5 launch query parameters (endpoint, fetch, registration, actor, activityId) (§13.1.4.3 / §8).', domain: 'AssignableUnit', range: 'xsd:anyURI' },
    { name: 'launchMethod', kind: 'datatype', label: 'launchMethod', comment: 'How the LMS launches the AU: OwnWindow (new window/frame) or AnyWindow (current). Default AnyWindow (§13.1.4.5).', domain: 'AssignableUnit', range: 'xsd:string' },
    { name: 'moveOn', kind: 'datatype', label: 'moveOn', comment: 'The criterion that, once met for this AU, marks the AU satisfied and lets the learner move on: Passed / Completed / CompletedAndPassed / CompletedOrPassed / NotApplicable (§13.1.4.4 / §10.3).', domain: 'AssignableUnit', range: 'xsd:string' },
    { name: 'masteryScore', kind: 'datatype', label: 'masteryScore', comment: 'The scaled score threshold in [0,1] the learner must reach for a passed statement; absent means the AU determines mastery itself (§13.1.4.4 / §9.5.1).', domain: 'AssignableUnit', range: 'xsd:decimal' },
    { name: 'activityType', kind: 'datatype', label: 'activityType', comment: 'The xAPI activity type IRI the LMS uses for the AU object definition.type (§13.1.4.6).', domain: 'AssignableUnit', range: 'xsd:anyURI' },
    { name: 'launchParameters', kind: 'datatype', label: 'launchParameters', comment: 'Static launch parameters passed to the AU; surfaced to the AU via the cmi5 launchParameters context extension at launch (§13.1.4.7 / §10.6).', domain: 'AssignableUnit', range: 'xsd:string' },
    // ── Session ──
    { name: 'sessionId', kind: 'datatype', label: 'sessionId', comment: 'The cmi5 session identifier carried in the sessionid context extension; unique per AU launch (§3.5 / §10.2).', domain: 'Session', range: 'xsd:string' },
    { name: 'registration', kind: 'datatype', label: 'registration', comment: 'The xAPI registration UUID the LMS assigns to the launch; the same value appears in every statement of the session (§10.1).', domain: 'Session', range: 'xsd:string' },
    { name: 'launchMode', kind: 'datatype', label: 'launchMode', comment: 'The launch mode the LMS hands the AU via the launchmode context extension: Normal / Browse / Review (§10.4).', domain: 'Session', range: 'xsd:string' },
  ],
  vocabularies: [
    {
      name: 'Cmi5Verb', label: 'cmi5 Defined Verbs',
      comment: 'The 9 verbs an AU/LMS emits across a cmi5 session, with their ADL verb IRIs (§9).',
      members: [
        { name: 'launched', label: 'launched', comment: 'http://adlnet.gov/expapi/verbs/launched — LMS launches the AU; precedes every AU-emitted statement (§9.1).' },
        { name: 'initialized', label: 'initialized', comment: 'http://adlnet.gov/expapi/verbs/initialized — AU acknowledges launch and has loaded (§9.2).' },
        { name: 'completed', label: 'completed', comment: 'http://adlnet.gov/expapi/verbs/completed — AU reports the learner met completion criteria (§9.3).' },
        { name: 'passed', label: 'passed', comment: 'http://adlnet.gov/expapi/verbs/passed — AU reports the learner met mastery criteria (with score) (§9.4).' },
        { name: 'failed', label: 'failed', comment: 'http://adlnet.gov/expapi/verbs/failed — AU reports the learner did not meet mastery criteria (§9.5).' },
        { name: 'abandoned', label: 'abandoned', comment: 'https://w3id.org/xapi/adl/verbs/abandoned — session ended abnormally (timeout / navigation away) (§9.6).' },
        { name: 'waived', label: 'waived', comment: 'https://w3id.org/xapi/adl/verbs/waived — LMS records that the AU requirement was administratively waived (§9.7).' },
        { name: 'terminated', label: 'terminated', comment: 'http://adlnet.gov/expapi/verbs/terminated — AU acknowledges session end; required after completed/passed/failed (§9.8).' },
        { name: 'satisfied', label: 'satisfied', comment: 'https://w3id.org/xapi/adl/verbs/satisfied — LMS records that all moveOn criteria for the AU (or Block/Course) were met (§9.9).' },
      ],
    },
    {
      name: 'LaunchMethod', label: 'cmi5 launchMethod values',
      comment: 'The AU launchMethod attribute vocabulary (§13.1.4.5).',
      members: [
        { name: 'OwnWindow', label: 'OwnWindow', comment: 'Launch the AU in its own new window / frame.' },
        { name: 'AnyWindow', label: 'AnyWindow', comment: 'Launch the AU in the current window (default).' },
      ],
    },
    {
      name: 'MoveOn', label: 'cmi5 moveOn values',
      comment: 'The AU moveOn attribute vocabulary; determines what satisfies the AU (§13.1.4.4 / §10.3).',
      members: [
        { name: 'Passed', label: 'Passed', comment: 'A passed statement satisfies the AU.' },
        { name: 'Completed', label: 'Completed', comment: 'A completed statement satisfies the AU.' },
        { name: 'CompletedAndPassed', label: 'CompletedAndPassed', comment: 'Both a completed and a passed statement are required.' },
        { name: 'CompletedOrPassed', label: 'CompletedOrPassed', comment: 'Either a completed or a passed statement satisfies the AU.' },
        { name: 'NotApplicable', label: 'NotApplicable', comment: 'No criterion; the AU does not gate progress (LMS may emit satisfied immediately).' },
      ],
    },
    {
      name: 'LaunchMode', label: 'cmi5 launchMode values',
      comment: 'The launchmode context-extension vocabulary the LMS sets at launch (§10.4).',
      members: [
        { name: 'Normal', label: 'Normal', comment: 'Tracked, satisfaction-affecting launch.' },
        { name: 'Browse', label: 'Browse', comment: 'Preview launch; does not affect satisfaction.' },
        { name: 'Review', label: 'Review', comment: 'Re-visit of already-satisfied content; does not affect satisfaction.' },
      ],
    },
    {
      name: 'ContextCategory', label: 'cmi5 category context activities',
      comment: 'The category contextActivities a cmi5 statement carries (§10.5).',
      members: [
        { name: 'cmi5', label: 'cmi5 category', comment: 'https://w3id.org/xapi/cmi5/context/categories/cmi5 — present on every cmi5 "defined" statement; marks it as conformant to the cmi5 profile.' },
        { name: 'moveon', label: 'moveOn category', comment: 'https://w3id.org/xapi/cmi5/context/categories/moveon — added to statements that contribute to the moveOn determination (satisfied / waived).' },
      ],
    },
    {
      name: 'ContextExtension', label: 'cmi5 context extensions',
      comment: 'IRIs of the cmi5 context.extensions keys (§10.2-§10.6).',
      members: [
        { name: 'sessionid', label: 'sessionid', comment: 'https://w3id.org/xapi/cmi5/context/extensions/sessionid — the cmi5 session identifier (§10.2).' },
        { name: 'masteryscore', label: 'masteryscore', comment: 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore — the masteryScore in effect for the AU (§10.3).' },
        { name: 'launchmode', label: 'launchmode', comment: 'https://w3id.org/xapi/cmi5/context/extensions/launchmode — Normal / Browse / Review (§10.4).' },
        { name: 'launchurl', label: 'launchurl', comment: 'https://w3id.org/xapi/cmi5/context/extensions/launchurl — the fully resolved AU launch URL (§10.5).' },
        { name: 'moveon', label: 'moveon', comment: 'https://w3id.org/xapi/cmi5/context/extensions/moveon — the moveOn criterion in effect for the AU (§10.6).' },
        { name: 'launchparameters', label: 'launchparameters', comment: 'https://w3id.org/xapi/cmi5/context/extensions/launchparameters — the AU launchParameters string (§10.7).' },
      ],
    },
    {
      name: 'ResultExtension', label: 'cmi5 result extensions',
      comment: 'IRIs of the cmi5 result.extensions keys (§9.3 / §9.6).',
      members: [
        { name: 'progress', label: 'progress', comment: 'https://w3id.org/xapi/cmi5/result/extensions/progress — integer 0..100 progress percentage (§9.3).' },
        { name: 'reason', label: 'reason', comment: 'https://w3id.org/xapi/cmi5/result/extensions/reason — human-readable reason, e.g. for an abandoned statement (§9.6).' },
      ],
    },
  ],
  shapes: [
    {
      name: 'CourseStructureShape', targetClass: 'CourseStructure', label: 'cmi5 course-structure conformance',
      comment: '§13.1.1: a courseStructure MUST contain exactly one Course and at least one top-level Block or AU.',
      constraints: [
        { path: 'course', minCount: 1, maxCount: 1, class: 'Course', comment: 'exactly one Course (§13.1.1)' },
        { path: 'structure', minCount: 1, comment: 'at least one top-level Block or AU (§13.1.1)' },
      ],
    },
    {
      name: 'CourseShape', targetClass: 'Course', label: 'cmi5 Course conformance',
      comment: '§13.1.2: a Course MUST have an IRI id and a title language map.',
      constraints: [
        { path: 'id', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'IRI id (§13.1.2)' },
        { path: 'title', minCount: 1, comment: 'title language map (§13.1.2)' },
      ],
    },
    {
      name: 'BlockShape', targetClass: 'Block', label: 'cmi5 Block conformance',
      comment: '§13.1.3: a Block MUST have an IRI id and a title language map.',
      constraints: [
        { path: 'id', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'IRI id (§13.1.3)' },
        { path: 'title', minCount: 1, comment: 'title language map (§13.1.3)' },
      ],
    },
    {
      name: 'AssignableUnitShape', targetClass: 'AssignableUnit', label: 'cmi5 AU conformance',
      comment: '§13.1.4: an AU MUST have an IRI id, a title language map, a description language map, a launch url and a moveOn rule. launchMethod (if present) is from the LaunchMethod vocabulary; moveOn is from the MoveOn vocabulary; masteryScore (if present) is a decimal in [0,1] (§9.5.1).',
      constraints: [
        { path: 'id', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'IRI id (§13.1.4)' },
        { path: 'title', minCount: 1, comment: 'title language map (§13.1.4.1)' },
        { path: 'description', minCount: 1, comment: 'description language map (§13.1.4.2)' },
        { path: 'url', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'launch url (§13.1.4.3)' },
        { path: 'moveOn', minCount: 1, maxCount: 1, in: ['Passed', 'Completed', 'CompletedAndPassed', 'CompletedOrPassed', 'NotApplicable'], comment: 'moveOn vocabulary (§13.1.4.4)' },
        { path: 'launchMethod', maxCount: 1, in: ['OwnWindow', 'AnyWindow'], comment: 'launchMethod vocabulary, default AnyWindow (§13.1.4.5)' },
        { path: 'masteryScore', maxCount: 1, datatype: 'xsd:decimal', minInclusive: MASTERY_MIN, maxInclusive: MASTERY_MAX, comment: 'masteryScore ∈ [0,1] (§9.5.1)' },
        { path: 'activityType', maxCount: 1, datatype: 'xsd:anyURI', comment: 'activity type IRI (§13.1.4.6)' },
        { path: 'launchParameters', maxCount: 1, datatype: 'xsd:string', comment: 'static launch parameters (§13.1.4.7)' },
      ],
    },
    {
      name: 'ObjectiveShape', targetClass: 'Objective', label: 'cmi5 Objective conformance',
      comment: '§13.1.6: an Objective MUST have an IRI id and a title language map.',
      constraints: [
        { path: 'id', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'IRI id (§13.1.6)' },
        { path: 'title', minCount: 1, comment: 'title language map (§13.1.6)' },
      ],
    },
    {
      name: 'SessionShape', targetClass: 'Session', label: 'cmi5 session conformance',
      comment: '§10: a cmi5 session MUST carry a registration UUID and a sessionId; launchMode (if present) is from the LaunchMode vocabulary.',
      constraints: [
        { path: 'registration', minCount: 1, maxCount: 1, pattern: UUID, comment: 'registration UUID (§10.1)' },
        { path: 'sessionId', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'cmi5 session id (§10.2)' },
        { path: 'launchMode', maxCount: 1, in: ['Normal', 'Browse', 'Review'], comment: 'launchMode vocabulary (§10.4)' },
      ],
    },
  ],
};
