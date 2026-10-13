/**
 * cmi5 (Quartz) — the xAPI profile and course structure for LMS-launched content, as the single
 * source.
 *
 * cmi5 is an xAPI profile plus a course-structure binding. This model captures:
 *   · the course structure (§13.1: Course, Block, Objective, Assignable Unit, with launchMethod,
 *     moveOn, masteryScore, activityType, launchParameters and entitlementKey);
 *   · the session an LMS launches (§8.1, §9.6.1, §9.6.3.1), the LMS.LaunchData state document
 *     (§10) and the learner preferences agent-profile document (§11);
 *   · the profile's xAPI surface — the 9 verbs (§9.3), the cmi5 and moveOn category activities
 *     (§9.6.2), the context extensions (§9.6.3), the result extensions (§9.5.5) and the block and
 *     course activity types (§9.4) — as SKOS concepts mapped to the IRIs cmi5 defines.
 *
 * ★ WHAT cmi5 IS. It was developed by the AICC, is maintained by ADL, and its current edition is
 * "Quartz" (first edition June 2016, with later errata). It is being standardized as IEEE P9274.3.1
 * ("Packaging, Launch, and Run-time of xAPI in Session-based Learning"), an active project — it is
 * NOT IEEE 9274.2.1, which this model used to call it (P9274.2.1 is the JSON-LD standard for xAPI
 * application profiles). Section numbers below are the Quartz specification's own.
 *
 * cmi5 reuses the xAPI 2.0 data model; this ontology imports Foxxi's /ns/xapi and builds on it.
 *
 * Reference: https://github.com/AICC/CMI-5_Spec_Current
 */
import type { OntologyModel } from '../spec-ontology.js';
import { XAPI_MODEL } from './xapi.model.js';

const Q = 'cmi5 Quartz';
const MOVE_ON = ['Passed', 'Completed', 'CompletedAndPassed', 'CompletedOrPassed', 'NotApplicable'];
const LAUNCH_METHOD = ['OwnWindow', 'AnyWindow'];
const LAUNCH_MODE = ['Normal', 'Browse', 'Review'];
/** A cmi5 session id / registration is a UUID. */
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** A comma-separated list of RFC 5646 language tags (§11.1). */
const LANGUAGE_LIST = '^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*(,[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*)*$';
/** What a JSON number becomes in RDF; an XML xs:decimal stays xsd:decimal. */
const NUMBER = ['xsd:integer', 'xsd:decimal', 'xsd:double'] as const;

const CMI5 = 'https://w3id.org/xapi/cmi5/';
/** The session ID extension (§9.6.3.1), which the context template carries. */
const SESSION_ID_EXTENSION = `${CMI5}context/extensions/sessionid`;

export const CMI5_MODEL: OntologyModel = {
  // The course structure's langstrings are written, after its XML, as lists of {lang, text}.
  jsonLanguageStrings: 'list',
  // Read through its generated JSON-LD context (ns/model-context.ts): a node a property reaches is
  // selected by that property as well as by its class.
  selectByDomainAndRange: true,
  generatedContext: true,
  module: 'cmi5',
  title: 'cmi5 (Quartz) — xAPI profile and course structure',
  description: 'An OWL 2 DL ontology and SHACL shapes for cmi5, the xAPI profile for content launched by a learning management system (Quartz edition): the course structure of §13 (Course, Block, Objective, Assignable Unit), the launch session, the LMS.LaunchData state document (§10) and the learner-preferences document (§11), and the profile\'s xAPI surface — its 9 verbs, category activities, context and result extensions and activity types — as SKOS concepts mapped to the IRIs cmi5 defines. Builds on, and imports, the Foxxi xAPI 2.0 ontology.',
  version: '2026.10.0',
  created: '2026-06-19',
  spec: 'https://github.com/AICC/CMI-5_Spec_Current',
  standards: [
    { title: 'cmi5 specification, Quartz edition (AICC; maintained by ADL)', url: 'https://github.com/AICC/CMI-5_Spec_Current' },
    { title: 'IEEE P9274.3.1 — Standard for Packaging, Launch, and Run-time of xAPI in Session-based Learning (active project standardizing cmi5)', url: 'https://standards.ieee.org/ieee/9274.3.1/11183/' },
  ],
  bodies: ['ADL', 'the AICC', 'IEEE'],
  prefixes: {
    adl: 'http://adlnet.gov/expapi/verbs/',
    'adl-w3id': 'https://w3id.org/xapi/adl/verbs/',
  },
  // By version IRI: a released version keeps the xAPI ontology it was built on.
  imports: [`xapi/${XAPI_MODEL.version}`],
  // The session ID extension's IRI is the predicate an xAPI context's extensions give the session ID
  // when read as RDF, and the launch data shape's path ends in it.
  references: [{ term: SESSION_ID_EXTENSION, kind: 'datatype', label: 'session ID (cmi5 context extension)', definedBy: 'https://github.com/AICC/CMI-5_Spec_Current' }],
  notes: [
    'cmi5 terms the specification itself names by IRI (its verbs, categories, extensions and activity types) are not re-minted as classes or properties: each is a SKOS concept here with a skos:exactMatch to the cmi5 IRI, which is the identifier a statement carries.',
  ],
  classes: [
    { name: 'CourseStructure', label: 'Course Structure', comment: 'The root of a cmi5 course structure document (cmi5.xml): the one Course, the objectives it declares, and the tree of Blocks and Assignable Units in sequence.', source: `${Q} §13.1; §14 (CourseStructure.xsd)` },
    { name: 'Course', label: 'Course', comment: 'The course as its publisher identifies it, by a globally unique IRI (the publisher ID), with a title and a description. In statements it appears through its publisher ID as a grouping activity, and the LMS represents it by a generated activity of type course.', source: `${Q} §13.1.1`, subClassOf: ['foxxi-xapi:Activity'] },
    { name: 'Block', label: 'Block', comment: 'A grouping of Assignable Units and nested Blocks, identified by an IRI unique within the course structure, with a title, a description and optional objective references. A block is satisfied when all of its members are.', source: `${Q} §13.1.2`, subClassOf: ['foxxi-xapi:Activity'] },
    { name: 'Objective', label: 'Objective', comment: 'A learning objective, identified by an IRI unique within the course structure, with a title and a description. Blocks and Assignable Units reference objectives.', source: `${Q} §13.1.3` },
    { name: 'AssignableUnit', label: 'Assignable Unit', comment: 'The smallest launchable unit of content that the LMS tracks: identified by an IRI, with a title, a description and a launch URL, and optionally a launch method, a moveOn criterion, a mastery score, an activity type, launch parameters, an entitlement key and objective references.', source: `${Q} §13.1.4`, subClassOf: ['foxxi-xapi:Activity'] },
    { name: 'Session', label: 'Session', comment: 'One launch of one Assignable Unit for one learner, from the LMS\'s launched statement to the terminated (or abandoned) statement, identified by the session ID the LMS generates and bound to the course registration.', source: `${Q} §3 (Definitions: session); §9.6.3.1` },
    { name: 'LaunchData', label: 'Launch Data', comment: 'The LMS.LaunchData state document the LMS writes before launching an Assignable Unit: the context template, launch mode, moveOn, and when defined the mastery score, launch parameters, return URL and entitlement key.', source: `${Q} §10` },
    { name: 'EntitlementKey', label: 'Entitlement Key', comment: 'The entitlement data in the launch data: the key from the course structure, and optionally an alternate key agreed between the LMS and the content provider.', source: `${Q} §10.2.7` },
    { name: 'LearnerPreferences', label: 'Learner Preferences', comment: 'The cmi5LearnerPreferences agent-profile document: the learner\'s ordered language preferences and audio preference.', source: `${Q} §11` },
    // Deprecated in 2026.10.0. Kept so data that used it still resolves.
    { name: 'Objectives', label: 'Objectives', comment: 'Formerly a container of the objectives a Block or Assignable Unit references. A Block or Assignable Unit now references each Objective directly, with the property objectiveReference.', deprecated: true, replacedBy: 'objectiveReference' },
  ],
  datatypes: [
    { name: 'MasteryScore', label: 'Mastery score', comment: 'A scaled decimal between 0 and 1 inclusive (with up to 4 decimal places). Admits xsd:double as well, for the JSON launch data.', base: 'xsd:decimal', alsoBases: ['xsd:double'], minInclusive: 0, maxInclusive: 1, source: `${Q} §13.1.4; §10.2.4` },
    { name: 'LanguagePreferenceList', label: 'Language preference list', comment: 'A comma-separated list of RFC 5646 language tags, in order of preference.', base: 'xsd:string', pattern: LANGUAGE_LIST, source: `${Q} §11.1` },
  ],
  properties: [
    // ── Course structure ──
    { name: 'course', kind: 'object', label: 'course', comment: 'The one Course of a course structure.', domain: 'CourseStructure', range: 'Course', functional: true, source: `${Q} §13.1` },
    { name: 'structure', kind: 'object', label: 'structure', comment: 'A top-level Block or Assignable Unit of a course structure. Their sequence is the order of their positions.', domain: 'CourseStructure', range: ['Block', 'AssignableUnit'], source: `${Q} §13.1` },
    { name: 'block', kind: 'object', label: 'block', comment: 'A Block contained in a course structure or in another Block.', domain: ['CourseStructure', 'Block'], range: 'Block', source: `${Q} §13.1.2` },
    { name: 'au', kind: 'object', label: 'assignable unit', comment: 'An Assignable Unit contained in a course structure or in a Block.', domain: ['CourseStructure', 'Block'], range: 'AssignableUnit', source: `${Q} §13.1.4`, notation: 'au' },
    // Document order is cmi5's sequence (§13.1), and RDF keeps no order of its own, so a reading states it.
    { name: 'position', kind: 'datatype', label: 'position', comment: 'The position of a Block or Assignable Unit among the members of its course structure or parent Block, counting from 1 in document order: the sequence cmi5 implies (§13.1). An RDF reading of a course structure states it, since RDF keeps no order of its own.', domain: ['Block', 'AssignableUnit'], range: 'xsd:positiveInteger', functional: true, source: `${Q} §13.1` },
    // ★ NO DOMAIN, AS PUBLISHED. objective was published with the domain Objectives, a container this
    // ontology no longer has; a course structure declares its objectives with it now. Its domain is not
    // replaced by CourseStructure, so that data written with the container stays consistent.
    { name: 'objective', kind: 'object', label: 'objective', comment: 'An objective a course structure declares, for its Blocks and Assignable Units to reference. (Before 2026.10.0, a member of the deprecated Objectives container.)', range: 'Objective', source: `${Q} §13.1.3; §14 (CourseStructure.xsd)`, changeNote: '2026.10.0: its domain, the Objectives container, is removed: a course structure declares its objectives with it. Not replaced by the course structure, so that data written with the container stays consistent.' },
    // ★ A NEW IRI FOR A NEW RELATION. objectives was published to relate a Block or AU to an Objectives
    // container; a Block or AU now references each objective itself, which is a different relation.
    // The JSON key is unchanged: the context reads "objectives" into objectiveReference.
    { name: 'objectiveReference', kind: 'object', label: 'objective reference', notation: 'objectiveReference', comment: 'An objective a Block or an Assignable Unit references, by the objective\'s idref. (In a course structure\'s JSON, an entry of its "objectives".)', domain: ['Block', 'AssignableUnit'], range: 'Objective', source: `${Q} §13.1.2; §13.1.4`, changeNote: '2026.10.0: new, in place of objectives, which related a Block or AU to an Objectives container.' },
    { name: 'objectives', kind: 'object', label: 'objectives', comment: 'Formerly the Objectives container a Block or AU references. A Block or AU now references each objective with objectiveReference.', range: 'Objectives', deprecated: true, replacedBy: 'objectiveReference', changeNote: '2026.10.0: deprecated in favour of objectiveReference; kept as it was published, with the range Objectives.' },
    { name: 'title', kind: 'datatype', label: 'title', comment: 'The descriptive title of a Course, Block, Objective or Assignable Unit, as language strings.', domain: ['Course', 'Block', 'Objective', 'AssignableUnit'], range: 'rdf:langString', source: `${Q} §13.1.1–§13.1.4` },
    { name: 'description', kind: 'datatype', label: 'description', comment: 'The detailed description of a Course, Block, Objective or Assignable Unit, as language strings.', domain: ['Course', 'Block', 'Objective', 'AssignableUnit'], range: 'rdf:langString', source: `${Q} §13.1.1–§13.1.4` },
    // ── Assignable Unit metadata ──
    { name: 'url', kind: 'datatype', label: 'URL', comment: 'A relative or fully qualified URL referencing the launch point of the Assignable Unit; the LMS merges any query string it carries with the cmi5 launch parameters.', domain: 'AssignableUnit', range: 'xsd:anyURI', functional: true, source: `${Q} §13.1.4; §8.1` },
    { name: 'launchMethod', kind: 'datatype', label: 'launch method', comment: 'Whether the Assignable Unit requires its own window (OwnWindow) or accepts any window context (AnyWindow, the default).', domain: 'AssignableUnit', oneOf: LAUNCH_METHOD, functional: true, source: `${Q} §13.1.4`, notation: 'launchMethod' },
    { name: 'moveOn', kind: 'datatype', label: 'move on', comment: 'What satisfies the Assignable Unit: Passed, Completed, CompletedAndPassed, CompletedOrPassed, or NotApplicable (the default, under which the LMS considers it satisfied). In the launch data, the value the LMS applies.', domain: ['AssignableUnit', 'LaunchData'], oneOf: MOVE_ON, functional: true, source: `${Q} §13.1.4; §10.2.5`, notation: 'moveOn' },
    { name: 'masteryScore', kind: 'datatype', label: 'mastery score', comment: 'The scaled score at or above which a judged attempt passes; passed and failed statements are based on it when it is given.', domain: ['AssignableUnit', 'LaunchData'], range: 'MasteryScore', functional: true, source: `${Q} §13.1.4; §10.2.4`, notation: 'masteryScore' },
    // ★ A NEW IRI FOR A NEW KIND, as for the xAPI ontology's activityType: published as a datatype
    // property with an xsd:anyURI range, the activity type is the value of an object property now.
    { name: 'auActivityType', kind: 'object', label: 'activity type', comment: 'The activity type the LMS can show for the Assignable Unit before it is first started. (In a course structure\'s JSON, the AU\'s "activityType".)', domain: 'AssignableUnit', range: 'foxxi-xapi:ActivityType', functional: true, source: `${Q} §13.1.4`, notation: 'activityType', changeNote: '2026.10.0: new, in place of the datatype property activityType: an activity type is an IRI naming a concept, so it is the value of an object property.' },
    { name: 'activityType', kind: 'datatype', label: 'activity type', comment: 'Formerly the activity type of an Assignable Unit, as an xsd:anyURI literal. Use auActivityType, whose value is the activity type itself.', domain: 'AssignableUnit', range: 'xsd:anyURI', deprecated: true, replacedBy: 'auActivityType', changeNote: '2026.10.0: deprecated in favour of auActivityType; kept as the datatype property it was published as.' },
    { name: 'launchParameters', kind: 'datatype', label: 'launch parameters', comment: 'Static launch parameters the course designer defines; in the launch data, the value the LMS passes (which may differ).', domain: ['AssignableUnit', 'LaunchData'], range: 'xsd:string', functional: true, source: `${Q} §13.1.4; §10.2.3`, notation: 'launchParameters' },
    { name: 'entitlementKey', kind: 'datatype', label: 'entitlement key', comment: 'Data the Assignable Unit uses to decide whether the launching LMS is entitled to use it, defined by the content provider.', domain: 'AssignableUnit', range: 'xsd:string', functional: true, source: `${Q} §13.1.4`, notation: 'entitlementKey' },
    // ── Session ──
    { name: 'sessionId', kind: 'datatype', label: 'session ID', comment: 'The unique identifier the LMS generates for one launch session, carried in every cmi5 defined and cmi5 allowed statement as the session ID context extension.', domain: 'Session', range: 'xsd:string', functional: true, source: `${Q} §9.6.3.1` },
    { name: 'registration', kind: 'datatype', label: 'registration', comment: 'The registration UUID of the learner\'s enrolment in the course, which the LMS passes at launch and every statement of the session carries.', domain: 'Session', range: 'foxxi-xapi:UUID', functional: true, source: `${Q} §9.6.1; §8.1.4` },
    { name: 'launchMode', kind: 'datatype', label: 'launch mode', comment: 'How the Assignable Unit was launched: Normal (satisfaction-related data is recorded), Browse or Review (it is not).', domain: ['Session', 'LaunchData'], oneOf: LAUNCH_MODE, functional: true, source: `${Q} §10.2.2; §9.6.3.3`, notation: 'launchMode' },
    { name: 'launchedAU', kind: 'object', label: 'launched AU', comment: 'The Assignable Unit a session is a launch of.', domain: 'Session', range: 'AssignableUnit', functional: true, source: `${Q} §8.1.5 (activityId)` },
    { name: 'learner', kind: 'object', label: 'learner', comment: 'The learner a session is for: the actor the LMS passes at launch.', domain: 'Session', range: 'foxxi-xapi:Agent', functional: true, source: `${Q} §8.1.3 (actor)` },
    // ── LMS.LaunchData ──
    { name: 'contextTemplate', kind: 'object', label: 'context template', comment: 'The xAPI context the Assignable Unit must use as the template for the context of every statement it sends; it carries the session ID extension and the publisher ID grouping activity.', domain: 'LaunchData', range: 'foxxi-xapi:Context', functional: true, source: `${Q} §10.2.1` },
    { name: 'returnURL', kind: 'datatype', label: 'return URL', comment: 'Where the Assignable Unit redirects the learner when it is terminated, if the LMS gives one.', domain: 'LaunchData', range: 'xsd:anyURI', functional: true, source: `${Q} §10.2.6`, notation: 'returnURL' },
    { name: 'launchEntitlementKey', kind: 'object', label: 'launch entitlement key', comment: 'The entitlement data in the launch data. (In the document, its "entitlementKey" object.)', domain: 'LaunchData', range: 'EntitlementKey', functional: true, source: `${Q} §10.2.7`, notation: 'entitlementKey' },
    { name: 'courseStructureKey', kind: 'datatype', label: 'course structure key', comment: 'The entitlement key from the course structure. (In the document, "courseStructure".)', domain: 'EntitlementKey', range: 'xsd:string', functional: true, source: `${Q} §10.2.7.1`, notation: 'courseStructure' },
    { name: 'alternateKey', kind: 'datatype', label: 'alternate key', comment: 'Entitlement data from another source agreed between the LMS and the content provider. (In the document, "alternate".)', domain: 'EntitlementKey', range: 'xsd:string', functional: true, source: `${Q} §10.2.7.2`, notation: 'alternate' },
    // ── Learner preferences ──
    { name: 'languagePreference', kind: 'datatype', label: 'language preference', comment: 'The learner\'s languages, most preferred first.', domain: 'LearnerPreferences', range: 'LanguagePreferenceList', functional: true, source: `${Q} §11.1`, notation: 'languagePreference' },
    { name: 'audioPreference', kind: 'datatype', label: 'audio preference', comment: 'Whether audio should be on or off at start-up.', domain: 'LearnerPreferences', oneOf: ['on', 'off'], functional: true, source: `${Q} §11.2`, notation: 'audioPreference' },
    // Deprecated in 2026.10.0. Kept so data that used it still resolves.
    { name: 'id', kind: 'datatype', label: 'id', comment: 'Formerly the IRI of a Course, Block, Assignable Unit or Objective, as a literal. In RDF that IRI identifies the node itself, so no property carries it and nothing replaces this one.', range: 'xsd:anyURI', deprecated: true, changeNote: '2026.10.0: deprecated; kept with the axioms it was published with.' },
  ],
  vocabularies: [
    {
      name: 'Cmi5Verb', label: 'cmi5 defined verbs',
      comment: 'The verbs cmi5 defines, each mapped to the verb IRI a cmi5 defined statement carries.',
      members: [
        { name: 'launched', label: 'launched', comment: 'The LMS launched the Assignable Unit. Recorded by the LMS before launch, once per session.', exactMatch: ['adl:launched'] },
        { name: 'initialized', label: 'initialized', comment: 'The Assignable Unit has fully initialized. The first statement of any kind the AU sends in a session.', exactMatch: ['adl:initialized'] },
        { name: 'completed', label: 'completed', comment: 'The learner viewed or did all the relevant activities of the Assignable Unit (progress 100%). At most once per registration.', exactMatch: ['adl:completed'] },
        { name: 'passed', label: 'passed', comment: 'The learner attempted and succeeded in a judged activity of the Assignable Unit; a scaled score, if given, is at or above the mastery score. At most once per registration.', exactMatch: ['adl:passed'] },
        { name: 'failed', label: 'failed', comment: 'The learner attempted and failed a judged activity of the Assignable Unit; a scaled score, if given, is below the mastery score.', exactMatch: ['adl:failed'] },
        { name: 'abandoned', label: 'abandoned', comment: 'The session was terminated abnormally, by the learner\'s action or a system failure. Recorded by the LMS on the AU\'s behalf.', exactMatch: ['adl-w3id:abandoned'] },
        { name: 'waived', label: 'waived', comment: 'The LMS determined that the Assignable Unit\'s requirements were met by means other than its moveOn criteria. Carries a reason.', exactMatch: ['adl-w3id:waived'] },
        { name: 'terminated', label: 'terminated', comment: 'The learner ended the session and the Assignable Unit will send no more statements for it. The last statement the AU sends.', exactMatch: ['adl:terminated'] },
        { name: 'satisfied', label: 'satisfied', comment: 'The LMS determined that the learner met the moveOn criteria of all the Assignable Units in a Block, or in the course.', exactMatch: ['adl-w3id:satisfied'] },
      ],
    },
    {
      name: 'LaunchMethod', label: 'cmi5 launch methods',
      comment: 'The values of an Assignable Unit\'s launchMethod.',
      members: [
        { name: 'OwnWindow', label: 'OwnWindow', comment: 'Launch the Assignable Unit in a new browser window, or by redirecting the current one.' },
        { name: 'AnyWindow', label: 'AnyWindow', comment: 'Any window context is acceptable — a frameset, a new window, a redirect. The default.' },
      ],
    },
    {
      name: 'MoveOn', label: 'cmi5 moveOn criteria',
      comment: 'The values of an Assignable Unit\'s moveOn: what satisfies the AU.',
      members: [
        { name: 'Passed', label: 'Passed', comment: 'A passed statement satisfies the Assignable Unit.' },
        { name: 'Completed', label: 'Completed', comment: 'A completed statement satisfies the Assignable Unit.' },
        { name: 'CompletedAndPassed', label: 'CompletedAndPassed', comment: 'Both a completed and a passed statement are required.' },
        { name: 'CompletedOrPassed', label: 'CompletedOrPassed', comment: 'Either a completed or a passed statement satisfies the Assignable Unit.' },
        { name: 'NotApplicable', label: 'NotApplicable', comment: 'The LMS considers the Assignable Unit satisfied. The default when no moveOn is given.' },
      ],
    },
    {
      name: 'LaunchMode', label: 'cmi5 launch modes',
      comment: 'The values of launchMode in the launch data.',
      members: [
        { name: 'Normal', label: 'Normal', comment: 'Satisfaction-related data must be recorded.' },
        { name: 'Browse', label: 'Browse', comment: 'Satisfaction-related data must not be recorded; the learner looks around without judgement.' },
        { name: 'Review', label: 'Review', comment: 'Satisfaction-related data must not be recorded; the learner revisits material already completed.' },
      ],
    },
    {
      name: 'ContextCategory', label: 'cmi5 category activities',
      comment: 'The activities cmi5 statements carry in contextActivities.category.',
      members: [
        { name: 'cmi5', label: 'cmi5 category', comment: 'Marks a statement as a cmi5 defined statement.', exactMatch: [`${CMI5}context/categories/cmi5`] },
        { name: 'moveon', label: 'moveOn category', comment: 'On cmi5 defined statements whose result includes success or completion; on no other statement.', exactMatch: [`${CMI5}context/categories/moveon`] },
      ],
    },
    {
      name: 'ContextExtension', label: 'cmi5 context extensions',
      comment: 'The context extensions cmi5 defines. (§9.6.3.5, publisherId, was withdrawn in favour of the publisher ID grouping activity of §9.6.2.3.)',
      members: [
        { name: 'sessionid', label: 'session ID', notation: 'sessionid', comment: 'The session ID, on every cmi5 defined and cmi5 allowed statement.', exactMatch: [`${CMI5}context/extensions/sessionid`] },
        { name: 'masteryscore', label: 'mastery score', notation: 'masteryscore', comment: 'The mastery score from the launch data, on launched statements and on the passed or failed statements based on it.', exactMatch: [`${CMI5}context/extensions/masteryscore`] },
        { name: 'launchmode', label: 'launch mode', notation: 'launchmode', comment: 'The launch mode the LMS used, on launched statements.', exactMatch: [`${CMI5}context/extensions/launchmode`] },
        { name: 'launchurl', label: 'launch URL', notation: 'launchurl', comment: 'The fully qualified URL the LMS used to launch the Assignable Unit, without the launch parameters, on launched statements.', exactMatch: [`${CMI5}context/extensions/launchurl`] },
        { name: 'moveon', label: 'moveOn', notation: 'moveon', comment: 'The moveOn value from the launch data, on launched statements.', exactMatch: [`${CMI5}context/extensions/moveon`] },
        { name: 'launchparameters', label: 'launch parameters', notation: 'launchparameters', comment: 'The launch parameters from the launch data, on launched statements when present.', exactMatch: [`${CMI5}context/extensions/launchparameters`] },
      ],
    },
    {
      name: 'ResultExtension', label: 'cmi5 result extensions',
      comment: 'The result extensions cmi5 defines.',
      members: [
        { name: 'progress', label: 'progress', comment: 'An integer from 0 to 100 inclusive: the completion of the Assignable Unit as a percentage.', exactMatch: [`${CMI5}result/extensions/progress`] },
        { name: 'reason', label: 'reason', comment: 'The reason for the statement, required on a waived statement.', exactMatch: [`${CMI5}result/extensions/reason`] },
      ],
    },
    {
      name: 'ActivityType', label: 'cmi5 activity types',
      comment: 'The activity types of the objects the LMS generates for a Block and for the course in satisfied statements.',
      members: [
        { name: 'block', label: 'block', comment: 'The type of the LMS-generated activity representing a Block.', exactMatch: [`${CMI5}activitytype/block`] },
        { name: 'course', label: 'course', comment: 'The type of the LMS-generated activity representing the course.', exactMatch: [`${CMI5}activitytype/course`] },
      ],
    },
  ],
  disjoint: [
    ['CourseStructure', 'Course', 'Block', 'Objective', 'AssignableUnit', 'Session', 'LaunchData', 'EntitlementKey', 'LearnerPreferences'],
  ],
  shapes: [
    {
      name: 'CourseStructureShape', targetClass: 'CourseStructure', label: 'cmi5 course structure conformance',
      comment: `${Q} §13.1: a course structure contains exactly one Course and at least one top-level Block or Assignable Unit.`,
      constraints: [
        { path: 'course', minCount: 1, maxCount: 1, class: 'Course', comment: 'exactly one Course (§13.1)' },
        { path: 'structure', minCount: 1, comment: 'at least one top-level Block or AU (§13.1)' },
      ],
    },
    {
      name: 'CourseShape', targetClass: 'Course', label: 'cmi5 Course conformance',
      comment: `${Q} §13.1.1: a Course is identified by an IRI and has a title and a description.`,
      constraints: [
        { path: 'id', identifies: true, minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'a globally unique IRI (§13.1.1)' },
        { path: 'title', minCount: 1, comment: 'title (§13.1.1)' },
        { path: 'description', minCount: 1, comment: 'description (§13.1.1)' },
      ],
    },
    {
      name: 'BlockShape', targetClass: 'Block', label: 'cmi5 Block conformance',
      comment: `${Q} §13.1.2: a Block is identified by an IRI and has a title and a description.`,
      constraints: [
        { path: 'id', identifies: true, minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'an IRI unique within the course structure (§13.1.2)' },
        { path: 'title', minCount: 1, comment: 'title (§13.1.2)' },
        { path: 'description', minCount: 1, comment: 'description (§13.1.2)' },
        { path: 'position', maxCount: 1, datatype: 'xsd:positiveInteger', minInclusive: 1, comment: 'its place in the sequence (§13.1)' },
        { path: 'objectives', rdfPath: 'objectiveReference', class: 'Objective', comment: 'each objective it references (§13.1.2)' },
      ],
    },
    {
      name: 'AssignableUnitShape', targetClass: 'AssignableUnit', label: 'cmi5 Assignable Unit conformance',
      comment: `${Q} §13.1.4: an AU is identified by an IRI and has a title, a description and a launch URL. moveOn (default NotApplicable) and launchMethod (default AnyWindow) take their vocabularies; masteryScore is a decimal in [0, 1].`,
      constraints: [
        { path: 'id', identifies: true, minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'an IRI unique within the course structure (§13.1.4)' },
        { path: 'title', minCount: 1, comment: 'title (§13.1.4)' },
        { path: 'description', minCount: 1, comment: 'description (§13.1.4)' },
        { path: 'position', maxCount: 1, datatype: 'xsd:positiveInteger', minInclusive: 1, comment: 'its place in the sequence (§13.1)' },
        { path: 'url', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'launch URL (§13.1.4)' },
        { path: 'moveOn', maxCount: 1, in: MOVE_ON, comment: 'moveOn vocabulary; NotApplicable when absent (§13.1.4)' },
        { path: 'launchMethod', maxCount: 1, in: LAUNCH_METHOD, comment: 'launchMethod vocabulary; AnyWindow when absent (§13.1.4)' },
        { path: 'masteryScore', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'masteryScore ∈ [0, 1] (§13.1.4)' },
        { path: 'activityType', rdfPath: 'auActivityType', maxCount: 1, nodeKind: 'IRI', comment: 'activity type IRI (§13.1.4)' },
        { path: 'objectives', rdfPath: 'objectiveReference', class: 'Objective', comment: 'each objective it references (§13.1.4)' },
        { path: 'launchParameters', maxCount: 1, datatype: 'xsd:string', comment: 'static launch parameters (§13.1.4)' },
        { path: 'entitlementKey', maxCount: 1, datatype: 'xsd:string', comment: 'entitlement key (§13.1.4)' },
      ],
    },
    {
      name: 'ObjectiveShape', targetClass: 'Objective', label: 'cmi5 Objective conformance',
      comment: `${Q} §13.1.3: an Objective is identified by an IRI and has a title and a description.`,
      constraints: [
        { path: 'id', identifies: true, minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'an IRI unique within the course structure (§13.1.3)' },
        { path: 'title', minCount: 1, comment: 'title (§13.1.3)' },
        { path: 'description', minCount: 1, comment: 'description (§13.1.3)' },
      ],
    },
    {
      name: 'SessionShape', targetClass: 'Session', label: 'cmi5 session conformance',
      comment: `${Q} §9.6.1, §9.6.3.1, §10.2.2: a session carries a registration UUID and a session ID; launchMode takes its vocabulary.`,
      constraints: [
        { path: 'registration', minCount: 1, maxCount: 1, pattern: UUID, comment: 'registration UUID (§9.6.1)' },
        { path: 'sessionId', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'session ID (§9.6.3.1)' },
        { path: 'launchMode', maxCount: 1, in: LAUNCH_MODE, comment: 'launchMode vocabulary (§10.2.2)' },
        { path: 'launchedAU', maxCount: 1, comment: 'the one AU it is a launch of' },
        { path: 'learner', maxCount: 1, node: 'LearnerShape', comment: 'the one learner it is for: an Agent with an account (§9.2)' },
      ],
    },
    {
      name: 'LaunchDataShape', targetClass: 'LaunchData', label: 'cmi5 LMS.LaunchData conformance',
      comment: `${Q} §10.2: the launch data has a context template, a launch mode and a moveOn; a mastery score is a decimal in [0, 1].`,
      constraints: [
        { path: 'contextTemplate', minCount: 1, maxCount: 1, comment: 'context template (§10.2.1)' },
        { path: 'launchMode', minCount: 1, maxCount: 1, in: LAUNCH_MODE, comment: 'launch mode (§10.2.2)' },
        { path: 'moveOn', minCount: 1, maxCount: 1, in: MOVE_ON, comment: 'moveOn (§10.2.5)' },
        { path: 'masteryScore', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'masteryScore ∈ [0, 1] (§10.2.4)' },
        { path: 'launchParameters', maxCount: 1, datatype: 'xsd:string', comment: 'launch parameters (§10.2.3)' },
        { path: 'returnURL', maxCount: 1, datatype: 'xsd:anyURI', comment: 'return URL (§10.2.6)' },
        { path: 'entitlementKey', jsonPath: 'entitlementKey', rdfPath: 'launchEntitlementKey', maxCount: 1, comment: 'entitlement key object (§10.2.7)' },
        // The context template is an xAPI Context, read through the xAPI context: these paths step
        // into it. The session ID is the extension §9.6.3.1 defines; the publisher ID activity is in
        // the grouping list (§9.6.2.3), whose id the launch data alone cannot check against the AU.
        {
          path: 'contextTemplate.extensions.sessionid', name: 'contextTemplate-sessionid',
          jsonSegments: ['contextTemplate', 'extensions', SESSION_ID_EXTENSION], rdfPath: ['contextTemplate', 'foxxi-xapi:extensions', SESSION_ID_EXTENSION],
          minCount: 1, maxCount: 1, comment: 'the session ID, in the context template\'s extensions (§10.2.1, §9.6.3.1)',
        },
        {
          path: 'contextTemplate.contextActivities.grouping', name: 'contextTemplate-publisher',
          rdfPath: ['contextTemplate', 'foxxi-xapi:contextActivities', 'foxxi-xapi:grouping'],
          minCount: 1, comment: 'the publisher ID activity, in the context template\'s grouping list (§10.2.1, §9.6.2.3)',
        },
      ],
    },
    {
      name: 'EntitlementKeyShape', targetClass: 'EntitlementKey', label: 'cmi5 entitlement key conformance',
      comment: `${Q} §10.2.7: the entitlement key in the launch data carries the key from the course structure, which the LMS must provide, and may carry an alternate key; each is a string. The document names them "courseStructure" and "alternate".`,
      constraints: [
        { path: 'courseStructure', rdfPath: 'courseStructureKey', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the key from the course structure (§10.2.7.1)' },
        { path: 'alternate', rdfPath: 'alternateKey', maxCount: 1, datatype: 'xsd:string', comment: 'an alternate key (§10.2.7.2)' },
      ],
    },
    {
      // No target of its own: what a session's learner must be, where SessionShape reaches it.
      name: 'LearnerShape', label: 'cmi5 learner',
      comment: `${Q} §9.2: the actor of a cmi5 session is an Agent, not a Group, identified by an account; an xAPI Agent written as xAPI writes one, read through /ns/xapi/context.`,
      constraints: [
        { path: 'account', rdfPath: 'foxxi-xapi:account', minCount: 1, comment: 'identified by an account (§9.2)' },
        { path: 'objectType', rdfPath: 'rdf:type', notHasValue: 'Group', notHasIri: 'foxxi-xapi:Group', comment: 'an Agent, not a Group (§9.2)' },
      ],
    },
    {
      name: 'LearnerPreferencesShape', targetClass: 'LearnerPreferences', label: 'cmi5 learner preferences conformance',
      comment: `${Q} §11: languagePreference is a comma-separated list of RFC 5646 tags; audioPreference is "on" or "off".`,
      constraints: [
        { path: 'languagePreference', maxCount: 1, datatype: 'xsd:string', pattern: LANGUAGE_LIST, comment: 'RFC 5646 tags, most preferred first (§11.1)' },
        { path: 'audioPreference', maxCount: 1, in: ['on', 'off'], comment: '"on" or "off" (§11.2)' },
      ],
    },
  ],
};
