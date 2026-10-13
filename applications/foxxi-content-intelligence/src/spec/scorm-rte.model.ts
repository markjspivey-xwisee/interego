/**
 * SCORM 2004 4th Edition Run-Time Environment — the run-time data model — the single source.
 *
 * OWL + SHACL ontology of the data a SCO reads and writes through the API_1484_11 instance: the cmi
 * data model, which SCORM 2004 takes from IEEE 1484.11.1, and ADL's navigation (adl.nav) and shared
 * data (adl.data) data models. Each element is a property with its data type, its access — [RW]
 * read/write, [RO] read-only (SetValue fails with 404), [WO] write-only (GetValue fails with 405) —
 * and, where it has one, its vocabulary. Composed into the PGSL lattice (composeSpecOntology) and
 * projected to OWL/SHACL/JSON-LD at <bridge>/ns/scorm-rte; a CMI snapshot is checked against the
 * shapes at POST /ns/scorm-rte/validate, and each result cites its shape. The player's run-time
 * (deploy/foxxi-scorm-player/site/scorm-rte.js) implements the cmi elements; this ontology models
 * the data model as the standard defines it.
 *
 * ★ THE 4TH EDITION, AND THE STANDARDS UNDER IT. Modelled now: adl.nav.request with the jump
 * request and its validity, the adl.data shared data stores, and cmi.exit's logout as the
 * deprecated value ADL says it is ("should not be used"; an LMS that receives it processes an Exit
 * All navigation request). IEEE has revised the data model and API standards SCORM 2004 cites, as
 * IEEE 1484.11.1-2022 and IEEE 1484.11.2-2020; this ontology follows SCORM 2004 4th Edition, which
 * is what SCORM LMSs and content implement.
 *
 * ★ SCORM'S OWN DATA TYPES. timeinterval and time are named datatypes restricting xsd:string by
 * their SCORM forms — xsd:duration is outside the OWL 2 datatype map, and SCORM's time admits
 * partial values ("2026-10") that are not xsd:dateTime. Real numbers are the union of decimal and
 * double, which is what JSON-LD makes of a JSON number.
 *
 * ★ CITED BY ELEMENT NAME (cmi.completion_status), which identifies an element in every edition,
 * instead of section numbers of a book the repository does not hold.
 */
import type { OntologyModel } from '../spec-ontology.js';
import { SCORM_TIME, SCORM_TIMEINTERVAL } from './patterns.js';

const RTE = 'SCORM 2004 4th Edition Run-Time Environment';
/** What a JSON number becomes in RDF (JSON-LD 1.1 §8.6): an integer or a double; or a decimal. */
const NUMBER = ['xsd:integer', 'xsd:decimal', 'xsd:double'];
/** cmi.suspend_data's smallest permitted maximum (SPM): 64000 characters in the 4th Edition. */
const SUSPEND_DATA_SPM = 64000;
/** The SPM of a short_identifier_type / the learner preference language: 250 characters. */
const SHORT_SPM = 250;

const COMPLETION_STATUS = ['completed', 'incomplete', 'not attempted', 'unknown'];
const SUCCESS_STATUS = ['passed', 'failed', 'unknown'];
const EXIT = ['time-out', 'suspend', 'logout', 'normal', ''];
const ENTRY = ['ab-initio', 'resume', ''];
const MODE = ['browse', 'normal', 'review'];
const CREDIT = ['credit', 'no-credit'];
const TIME_LIMIT_ACTION = ['exit,message', 'exit,no message', 'continue,message', 'continue,no message'];
const INTERACTION_TYPE = ['true-false', 'choice', 'fill-in', 'long-fill-in', 'likert', 'matching', 'performance', 'sequencing', 'numeric', 'other'];
const VALIDITY = ['true', 'false', 'unknown'];
/** cmi.interactions.n.result: a judgement, or a real number. */
const RESULT = '^(correct|incorrect|unanticipated|neutral|-?([0-9]+(\\.[0-9]+)?|\\.[0-9]+))$';
/** adl.nav.request: a navigation request, a targeted choice or jump, or _none_. */
const NAV_REQUEST = '^(continue|previous|exit|exitAll|abandon|abandonAll|suspendAll|_none_|\\{target=[^}]+\\}(choice|jump))$';

export const SCORM_RTE_MODEL: OntologyModel = {
  // Read through its generated JSON-LD context (ns/model-context.ts): a node a property reaches is
  // selected by that property as well as by its class.
  selectByDomainAndRange: true,
  generatedContext: true,
  module: 'scorm-rte',
  title: 'SCORM 2004 4th Edition — Run-Time Environment data model (cmi, adl.nav, adl.data)',
  description:
    'An OWL 2 DL ontology and SHACL shapes for the run-time data model of SCORM 2004 4th Edition: the cmi data model a SCO reads and writes through API_1484_11 — status, score, time, location, suspend data, learner preferences, comments, interactions and objectives — with each element\'s data type, access and vocabulary, and ADL\'s navigation (adl.nav, including the 4th Edition\'s jump request) and shared data (adl.data) data models. The shapes check the vocabularies, the ranges of scores and measures, SCORM\'s time formats and the suspend data limit; a CMI snapshot is checked against them at /ns/scorm-rte/validate.',
  version: '2026.10.0',
  spec: 'https://adlnet.gov/past-projects/scorm',
  standards: [
    { title: 'SCORM 2004 4th Edition (ADL, 2009): Run-Time Environment', url: 'https://adlnet.gov/past-projects/scorm' },
    { title: 'IEEE 1484.11.1-2022 — Data Model for Content Object Communication (revises IEEE 1484.11.1-2004, which SCORM 2004 cites)', url: 'https://standards.ieee.org/ieee/1484.11.1/10324/' },
    { title: 'IEEE 1484.11.2-2020 — ECMAScript Application Programming Interface for Content to Runtime Services Communication', url: 'https://standards.ieee.org/ieee/1484.11.2/7698/' },
  ],
  bodies: ['ADL', 'IEEE'],
  notes: [
    'Element names in dotted notation (cmi.completion_status, adl.nav.request) are each property\'s skos:notation; n and m stand for the index of an entry in a collection.',
    'SPM is a smallest permitted maximum: the length every LMS must accept. A longer value is allowed, but only an LMS that supports more keeps it whole, so the shapes report one beyond its SPM as a sh:Warning, not a sh:Violation.',
    'The shapes select nodes by class (sh:targetClass): an RDF producer types the nodes it describes with this ontology\'s classes. A parsed instance as JSON is checked against the same shapes at POST /ns/scorm-rte/validate, which routes it by its declared type; every result cites its shape.',
  ],
  classes: [
    { name: 'DataModel', label: 'Run-time data', comment: 'The run-time data of one learner attempt on a SCO, which the SCO reads and writes through API_1484_11: the cmi data model, and ADL\'s navigation (adl.nav) and shared data (adl.data) data models.', source: `${RTE}: cmi; adl.nav; adl.data` },
    { name: 'Comment', label: 'Comment', comment: 'A comment on a SCO, with the location in the SCO it applies to and when it was made: from the learner, or from the LMS.', disjointUnionOf: ['CommentFromLearner', 'CommentFromLMS'], source: `${RTE}: cmi.comments_from_learner, cmi.comments_from_lms` },
    { name: 'CommentFromLearner', label: 'Comment from learner', notation: 'cmi.comments_from_learner.n', comment: 'A comment the learner makes on the SCO. [RW]', subClassOf: ['Comment'], source: `${RTE}: cmi.comments_from_learner` },
    { name: 'CommentFromLMS', label: 'Comment from LMS', notation: 'cmi.comments_from_lms.n', comment: 'A comment the LMS gives the SCO to show the learner. [RO]', subClassOf: ['Comment'], source: `${RTE}: cmi.comments_from_lms` },
    { name: 'LearnerPreference', label: 'Learner preference', notation: 'cmi.learner_preference', comment: 'The learner\'s preferences for the SCO: audio level, language, delivery speed and audio captioning. [RW]', source: `${RTE}: cmi.learner_preference` },
    { name: 'Interaction', label: 'Interaction', notation: 'cmi.interactions.n', comment: 'A recognized interaction the learner responded to, such as a question: its ID, type, objectives, timestamp, correct responses, weighting, learner response, result, latency and description.', source: `${RTE}: cmi.interactions` },
    { name: 'InteractionObjective', label: 'Interaction objective', notation: 'cmi.interactions.n.objectives.m', comment: 'An objective an interaction is associated with, by the objective\'s ID.', source: `${RTE}: cmi.interactions.n.objectives` },
    { name: 'CorrectResponse', label: 'Correct response', notation: 'cmi.interactions.n.correct_responses.m', comment: 'A correct response to an interaction, as a pattern whose form depends on the interaction type.', source: `${RTE}: cmi.interactions.n.correct_responses` },
    { name: 'Objective', label: 'Objective', notation: 'cmi.objectives.n', comment: 'A learning objective the SCO tracks: its ID, score, success status, completion status, progress measure and description.', source: `${RTE}: cmi.objectives` },
    { name: 'Score', label: 'Score', comment: 'A score: scaled, raw, minimum and maximum — of the SCO (cmi.score) or of an objective (cmi.objectives.n.score).', source: `${RTE}: cmi.score, cmi.objectives.n.score` },
    { name: 'TargetedRequestValidity', label: 'Targeted request validity', comment: 'Whether a choice or jump navigation request to a target activity would be valid now: the target\'s activity identifier, and true, false or unknown. [RO]', source: `${RTE}: adl.nav.request_valid.choice, adl.nav.request_valid.jump` },
    { name: 'SharedData', label: 'Shared data store', notation: 'adl.data.n', comment: 'A shared data store the SCO has access to, as its item\'s adlcp:map in the content package grants: its ID, and its content, which the SCO may read or write as the map allows. Added in the 4th Edition.', source: `${RTE}: adl.data` },
  ],
  datatypes: [
    { name: 'TimeInterval', label: 'Time interval', comment: 'SCORM\'s timeinterval (second,10,2): an ISO 8601 duration P[yY][mM][dD][T[hH][nM][s[.s]S]], with integer components and the seconds to a hundredth; at least one component. Defined on xsd:string because xsd:duration is outside the OWL 2 datatype map.', base: 'xsd:string', pattern: SCORM_TIMEINTERVAL, source: `${RTE}: timeinterval (second,10,2)` },
    { name: 'Time', label: 'Time', comment: 'SCORM\'s time (second,10,0): an ISO 8601 point in time, YYYY[-MM[-DD[Thh[:mm[:ss[.s[TZD]]]]]]], to a hundredth of a second, any trailing part omitted. Defined on xsd:string because its partial forms are not xsd:dateTime values.', base: 'xsd:string', pattern: SCORM_TIME, source: `${RTE}: time (second,10,0)` },
    { name: 'Real', label: 'Real number', comment: 'SCORM\'s real (10,7): a decimal, or a double, which is what JSON-LD 1.1 (§8.6) makes of a JSON number with a fraction.', base: 'xsd:decimal', alsoBases: ['xsd:double'], source: `${RTE}: real (10,7)` },
    { name: 'ScaledReal', label: 'Scaled real number', comment: 'A real (10,7) from -1 to 1.', base: 'xsd:decimal', alsoBases: ['xsd:double'], minInclusive: -1, maxInclusive: 1, source: `${RTE}: cmi.score.scaled, cmi.scaled_passing_score` },
    { name: 'UnitInterval', label: 'Unit interval', comment: 'A real (10,7) from 0 to 1.', base: 'xsd:decimal', alsoBases: ['xsd:double'], minInclusive: 0, maxInclusive: 1, source: `${RTE}: cmi.progress_measure, cmi.completion_threshold` },
    { name: 'NonNegativeReal', label: 'Non-negative real number', comment: 'A real (10,7) of 0 or more.', base: 'xsd:decimal', alsoBases: ['xsd:double'], minInclusive: 0, source: `${RTE}: cmi.learner_preference.audio_level, cmi.learner_preference.delivery_speed` },
  ],
  properties: [
    // ── cmi: scalar elements ──
    { name: 'version', kind: 'datatype', label: 'data model version', notation: 'cmi._version', comment: '[RO] The version of the data model the LMS supports: "1.0".', domain: 'DataModel', range: 'xsd:string', functional: true, source: `${RTE}: cmi._version` },
    { name: 'completionStatus', kind: 'datatype', label: 'completion status', notation: 'cmi.completion_status', comment: '[RW] Whether the learner has completed the SCO: completed, incomplete, not attempted or unknown.', domain: 'DataModel', oneOf: COMPLETION_STATUS, functional: true, source: `${RTE}: cmi.completion_status` },
    { name: 'completionThreshold', kind: 'datatype', label: 'completion threshold', notation: 'cmi.completion_threshold', comment: '[RO] The progress measure, from 0 to 1, at or above which the SCO is complete — the item\'s minimum progress measure in the content package (adlcp:completionThreshold).', domain: 'DataModel', range: 'UnitInterval', functional: true, source: `${RTE}: cmi.completion_threshold` },
    { name: 'credit', kind: 'datatype', label: 'credit', notation: 'cmi.credit', comment: '[RO] Whether the learner is credited for performance in the SCO: credit or no-credit.', domain: 'DataModel', oneOf: CREDIT, functional: true, source: `${RTE}: cmi.credit` },
    { name: 'entry', kind: 'datatype', label: 'entry', notation: 'cmi.entry', comment: '[RO] Whether the learner has been in the SCO before in this attempt: ab-initio (first time), resume (after a suspension), or empty.', domain: 'DataModel', oneOf: ENTRY, functional: true, source: `${RTE}: cmi.entry` },
    { name: 'exit', kind: 'datatype', label: 'exit', notation: 'cmi.exit', comment: '[WO] How or why the learner left the SCO: time-out, suspend, normal, empty, or the deprecated logout. Anything but suspend ends the attempt.', domain: 'DataModel', oneOf: EXIT, functional: true, source: `${RTE}: cmi.exit` },
    { name: 'launchData', kind: 'datatype', label: 'launch data', notation: 'cmi.launch_data', comment: '[RO] Data the SCO needs to start, from its item\'s adlcp:dataFromLMS in the content package; characterstring, SPM 4000.', domain: 'DataModel', range: 'xsd:string', functional: true, source: `${RTE}: cmi.launch_data` },
    { name: 'learnerId', kind: 'datatype', label: 'learner ID', notation: 'cmi.learner_id', comment: '[RO] The learner\'s identifier; long_identifier_type, SPM 4000.', domain: 'DataModel', range: 'xsd:string', functional: true, source: `${RTE}: cmi.learner_id` },
    { name: 'learnerName', kind: 'datatype', label: 'learner name', notation: 'cmi.learner_name', comment: '[RO] The learner\'s name; localized_string_type, SPM 250.', domain: 'DataModel', range: ['xsd:string', 'rdf:langString'], functional: true, source: `${RTE}: cmi.learner_name` },
    { name: 'learnerPreference', kind: 'object', label: 'learner preference', notation: 'cmi.learner_preference', comment: 'The learner\'s preferences for the SCO.', domain: 'DataModel', range: 'LearnerPreference', functional: true, source: `${RTE}: cmi.learner_preference` },
    { name: 'location', kind: 'datatype', label: 'location', notation: 'cmi.location', comment: '[RW] Where in the SCO the learner is, as the SCO records it, for resuming; characterstring, SPM 1000.', domain: 'DataModel', range: 'xsd:string', functional: true, source: `${RTE}: cmi.location` },
    { name: 'maxTimeAllowed', kind: 'datatype', label: 'maximum time allowed', notation: 'cmi.max_time_allowed', comment: '[RO] How much time the learner has in the attempt — from the activity\'s attempt absolute duration limit; timeinterval (second,10,2).', domain: 'DataModel', range: 'TimeInterval', functional: true, source: `${RTE}: cmi.max_time_allowed` },
    { name: 'mode', kind: 'datatype', label: 'mode', notation: 'cmi.mode', comment: '[RO] How the SCO is presented: browse, normal or review.', domain: 'DataModel', oneOf: MODE, functional: true, source: `${RTE}: cmi.mode` },
    { name: 'progressMeasure', kind: 'datatype', label: 'progress measure', notation: 'cmi.progress_measure', comment: '[RW] How far the learner has got towards completing the SCO, from 0 to 1.', domain: 'DataModel', range: 'UnitInterval', functional: true, source: `${RTE}: cmi.progress_measure` },
    { name: 'scaledPassingScore', kind: 'datatype', label: 'scaled passing score', notation: 'cmi.scaled_passing_score', comment: '[RO] The scaled score, from -1 to 1, the learner must reach to pass the SCO.', domain: 'DataModel', range: 'ScaledReal', functional: true, source: `${RTE}: cmi.scaled_passing_score` },
    { name: 'score', kind: 'object', label: 'score', notation: 'cmi.score', comment: 'The learner\'s score in the SCO.', domain: 'DataModel', range: 'Score', functional: true, source: `${RTE}: cmi.score` },
    { name: 'sessionTime', kind: 'datatype', label: 'session time', notation: 'cmi.session_time', comment: '[WO] How long the learner spent in the SCO in this session; timeinterval (second,10,2).', domain: 'DataModel', range: 'TimeInterval', functional: true, source: `${RTE}: cmi.session_time` },
    { name: 'successStatus', kind: 'datatype', label: 'success status', notation: 'cmi.success_status', comment: '[RW] Whether the learner has mastered the SCO: passed, failed or unknown.', domain: 'DataModel', oneOf: SUCCESS_STATUS, functional: true, source: `${RTE}: cmi.success_status` },
    { name: 'suspendData', kind: 'datatype', label: 'suspend data', notation: 'cmi.suspend_data', comment: `[RW] Data the SCO keeps between sessions; characterstring, SPM ${SUSPEND_DATA_SPM} in the 4th Edition.`, domain: 'DataModel', range: 'xsd:string', functional: true, source: `${RTE}: cmi.suspend_data` },
    { name: 'timeLimitAction', kind: 'datatype', label: 'time limit action', notation: 'cmi.time_limit_action', comment: '[RO] What the SCO should do when the maximum time allowed is exceeded — from its item\'s adlcp:timeLimitAction in the content package.', domain: 'DataModel', oneOf: TIME_LIMIT_ACTION, functional: true, source: `${RTE}: cmi.time_limit_action` },
    { name: 'totalTime', kind: 'datatype', label: 'total time', notation: 'cmi.total_time', comment: '[RO] How long the learner has spent in the SCO in the attempt, over all sessions; timeinterval (second,10,2).', domain: 'DataModel', range: 'TimeInterval', functional: true, source: `${RTE}: cmi.total_time` },
    // ── cmi: collections ──
    { name: 'commentsFromLearner', kind: 'object', label: 'comment from learner', notation: 'cmi.comments_from_learner', comment: '[RW] A comment from the learner; the collection is ordered.', domain: 'DataModel', range: 'CommentFromLearner', source: `${RTE}: cmi.comments_from_learner` },
    { name: 'commentsFromLMS', kind: 'object', label: 'comment from LMS', notation: 'cmi.comments_from_lms', comment: '[RO] A comment from the LMS; the collection is ordered.', domain: 'DataModel', range: 'CommentFromLMS', source: `${RTE}: cmi.comments_from_lms` },
    { name: 'interactions', kind: 'object', label: 'interaction', notation: 'cmi.interactions', comment: '[RW] An interaction; the collection is ordered.', domain: 'DataModel', range: 'Interaction', source: `${RTE}: cmi.interactions` },
    { name: 'objectives', kind: 'object', label: 'objective', notation: 'cmi.objectives', comment: '[RW] An objective; the collection is ordered.', domain: 'DataModel', range: 'Objective', source: `${RTE}: cmi.objectives` },
    // ── Comment ──
    { name: 'comment', kind: 'datatype', label: 'comment text', notation: 'comment', comment: '[RW from the learner, RO from the LMS] The text of a comment; localized_string_type, SPM 4000.', domain: 'Comment', range: 'rdf:langString', functional: true, source: `${RTE}: cmi.comments_from_learner.n.comment, cmi.comments_from_lms.n.comment` },
    { name: 'commentLocation', kind: 'datatype', label: 'comment location', notation: 'location', comment: '[RW from the learner, RO from the LMS] Where in the SCO a comment applies; characterstring, SPM 250.', domain: 'Comment', range: 'xsd:string', functional: true, source: `${RTE}: cmi.comments_from_learner.n.location, cmi.comments_from_lms.n.location` },
    { name: 'commentTimestamp', kind: 'datatype', label: 'comment timestamp', notation: 'timestamp', comment: '[RW from the learner, RO from the LMS] When a comment was made; time (second,10,0).', domain: 'Comment', range: 'Time', functional: true, source: `${RTE}: cmi.comments_from_learner.n.timestamp, cmi.comments_from_lms.n.timestamp` },
    // ── Learner preference ──
    { name: 'audioLevel', kind: 'datatype', label: 'audio level', notation: 'cmi.learner_preference.audio_level', comment: '[RW] How loud the SCO\'s audio should be, as a multiple of its normal level (1); 0 or more.', domain: 'LearnerPreference', range: 'NonNegativeReal', functional: true, source: `${RTE}: cmi.learner_preference.audio_level` },
    { name: 'preferenceLanguage', kind: 'datatype', label: 'preferred language', notation: 'cmi.learner_preference.language', comment: '[RW] The language the learner prefers for the SCO, as a language tag; characterstring, SPM 250.', domain: 'LearnerPreference', range: 'xsd:string', functional: true, source: `${RTE}: cmi.learner_preference.language` },
    { name: 'deliverySpeed', kind: 'datatype', label: 'delivery speed', notation: 'cmi.learner_preference.delivery_speed', comment: '[RW] How fast the SCO should deliver content, as a multiple of its normal speed (1); 0 or more.', domain: 'LearnerPreference', range: 'NonNegativeReal', functional: true, source: `${RTE}: cmi.learner_preference.delivery_speed` },
    { name: 'audioCaptioning', kind: 'datatype', label: 'audio captioning', notation: 'cmi.learner_preference.audio_captioning', comment: '[RW] Whether captions accompany the SCO\'s audio: -1 off, 0 no change, 1 on.', domain: 'LearnerPreference', range: 'xsd:integer', functional: true, source: `${RTE}: cmi.learner_preference.audio_captioning` },
    // ── Interaction ──
    { name: 'interactionId', kind: 'datatype', label: 'interaction ID', notation: 'cmi.interactions.n.id', comment: '[RW] The interaction\'s identifier; long_identifier_type, SPM 4000.', domain: 'Interaction', range: 'xsd:string', functional: true, source: `${RTE}: cmi.interactions.n.id` },
    { name: 'interactionType', kind: 'datatype', label: 'interaction type', notation: 'cmi.interactions.n.type', comment: '[RW] The kind of interaction: true-false, choice, fill-in, long-fill-in, likert, matching, performance, sequencing, numeric or other.', domain: 'Interaction', oneOf: INTERACTION_TYPE, functional: true, source: `${RTE}: cmi.interactions.n.type` },
    { name: 'interactionObjectives', kind: 'object', label: 'interaction objective', notation: 'cmi.interactions.n.objectives', comment: '[RW] An objective the interaction is associated with.', domain: 'Interaction', range: 'InteractionObjective', source: `${RTE}: cmi.interactions.n.objectives` },
    { name: 'interactionTimestamp', kind: 'datatype', label: 'interaction timestamp', notation: 'cmi.interactions.n.timestamp', comment: '[RW] When the interaction was first made available to the learner; time (second,10,0).', domain: 'Interaction', range: 'Time', functional: true, source: `${RTE}: cmi.interactions.n.timestamp` },
    { name: 'correctResponses', kind: 'object', label: 'correct response', notation: 'cmi.interactions.n.correct_responses', comment: '[RW] A correct response to the interaction.', domain: 'Interaction', range: 'CorrectResponse', source: `${RTE}: cmi.interactions.n.correct_responses` },
    { name: 'weighting', kind: 'datatype', label: 'weighting', notation: 'cmi.interactions.n.weighting', comment: '[RW] How much the interaction counts relative to the others; real (10,7).', domain: 'Interaction', range: 'Real', functional: true, source: `${RTE}: cmi.interactions.n.weighting` },
    { name: 'learnerResponse', kind: 'datatype', label: 'learner response', notation: 'cmi.interactions.n.learner_response', comment: '[RW] The learner\'s response, in the form the interaction type prescribes.', domain: 'Interaction', range: 'xsd:string', functional: true, source: `${RTE}: cmi.interactions.n.learner_response` },
    { name: 'result', kind: 'datatype', label: 'result', notation: 'cmi.interactions.n.result', comment: '[RW] How the learner\'s response was judged: correct, incorrect, unanticipated, neutral, or a real number.', domain: 'Interaction', range: 'xsd:string', functional: true, source: `${RTE}: cmi.interactions.n.result` },
    { name: 'latency', kind: 'datatype', label: 'latency', notation: 'cmi.interactions.n.latency', comment: '[RW] How long the learner took to respond, from when the interaction was made available; timeinterval (second,10,2).', domain: 'Interaction', range: 'TimeInterval', functional: true, source: `${RTE}: cmi.interactions.n.latency` },
    { name: 'interactionDescription', kind: 'datatype', label: 'interaction description', notation: 'cmi.interactions.n.description', comment: '[RW] A description of the interaction; localized_string_type, SPM 250.', domain: 'Interaction', range: 'rdf:langString', functional: true, source: `${RTE}: cmi.interactions.n.description` },
    { name: 'interactionObjectiveId', kind: 'datatype', label: 'interaction objective ID', notation: 'cmi.interactions.n.objectives.m.id', comment: '[RW] The identifier of an objective the interaction is associated with; long_identifier_type, SPM 4000.', domain: 'InteractionObjective', range: 'xsd:string', functional: true, source: `${RTE}: cmi.interactions.n.objectives.m.id` },
    { name: 'correctResponsePattern', kind: 'datatype', label: 'correct response pattern', notation: 'cmi.interactions.n.correct_responses.m.pattern', comment: '[RW] A correct response, in the form the interaction type prescribes.', domain: 'CorrectResponse', range: 'xsd:string', functional: true, source: `${RTE}: cmi.interactions.n.correct_responses.m.pattern` },
    // ── Objective ──
    { name: 'objectiveId', kind: 'datatype', label: 'objective ID', notation: 'cmi.objectives.n.id', comment: '[RW] The objective\'s identifier; long_identifier_type, SPM 4000.', domain: 'Objective', range: 'xsd:string', functional: true, source: `${RTE}: cmi.objectives.n.id` },
    { name: 'objectiveScore', kind: 'object', label: 'objective score', notation: 'cmi.objectives.n.score', comment: '[RW] The learner\'s score on the objective.', domain: 'Objective', range: 'Score', functional: true, source: `${RTE}: cmi.objectives.n.score` },
    { name: 'objectiveSuccessStatus', kind: 'datatype', label: 'objective success status', notation: 'cmi.objectives.n.success_status', comment: '[RW] Whether the learner has mastered the objective: passed, failed or unknown.', domain: 'Objective', oneOf: SUCCESS_STATUS, functional: true, source: `${RTE}: cmi.objectives.n.success_status` },
    { name: 'objectiveCompletionStatus', kind: 'datatype', label: 'objective completion status', notation: 'cmi.objectives.n.completion_status', comment: '[RW] Whether the learner has completed the objective: completed, incomplete, not attempted or unknown.', domain: 'Objective', oneOf: COMPLETION_STATUS, functional: true, source: `${RTE}: cmi.objectives.n.completion_status` },
    { name: 'objectiveProgressMeasure', kind: 'datatype', label: 'objective progress measure', notation: 'cmi.objectives.n.progress_measure', comment: '[RW] How far the learner has got towards completing the objective, from 0 to 1.', domain: 'Objective', range: 'UnitInterval', functional: true, source: `${RTE}: cmi.objectives.n.progress_measure` },
    { name: 'objectiveDescription', kind: 'datatype', label: 'objective description', notation: 'cmi.objectives.n.description', comment: '[RW] A description of the objective; localized_string_type, SPM 250.', domain: 'Objective', range: 'rdf:langString', functional: true, source: `${RTE}: cmi.objectives.n.description` },
    // ── Score ──
    { name: 'scoreScaled', kind: 'datatype', label: 'scaled score', notation: 'score.scaled', comment: '[RW] The score normalized to the range -1 to 1.', domain: 'Score', range: 'ScaledReal', functional: true, source: `${RTE}: cmi.score.scaled` },
    { name: 'scoreRaw', kind: 'datatype', label: 'raw score', notation: 'score.raw', comment: '[RW] The score, between the minimum and the maximum; real (10,7).', domain: 'Score', range: 'Real', functional: true, source: `${RTE}: cmi.score.raw` },
    { name: 'scoreMin', kind: 'datatype', label: 'minimum score', notation: 'score.min', comment: '[RW] The lowest possible score; real (10,7).', domain: 'Score', range: 'Real', functional: true, source: `${RTE}: cmi.score.min` },
    { name: 'scoreMax', kind: 'datatype', label: 'maximum score', notation: 'score.max', comment: '[RW] The highest possible score; real (10,7).', domain: 'Score', range: 'Real', functional: true, source: `${RTE}: cmi.score.max` },
    // ── adl.nav: the navigation data model ──
    { name: 'navRequest', kind: 'datatype', label: 'navigation request', notation: 'adl.nav.request', comment: '[RW] The navigation request the SCO wants processed when it ends: continue, previous, {target=ID}choice, {target=ID}jump (4th Edition), exit, exitAll, abandon, abandonAll, suspendAll, or _none_ (the default).', domain: 'DataModel', range: 'xsd:string', functional: true, source: `${RTE}: adl.nav.request` },
    { name: 'navRequestValidContinue', kind: 'datatype', label: 'continue request valid', notation: 'adl.nav.request_valid.continue', comment: '[RO] Whether a continue request would be valid now: true, false or unknown.', domain: 'DataModel', oneOf: VALIDITY, functional: true, source: `${RTE}: adl.nav.request_valid.continue` },
    { name: 'navRequestValidPrevious', kind: 'datatype', label: 'previous request valid', notation: 'adl.nav.request_valid.previous', comment: '[RO] Whether a previous request would be valid now: true, false or unknown.', domain: 'DataModel', oneOf: VALIDITY, functional: true, source: `${RTE}: adl.nav.request_valid.previous` },
    { name: 'navRequestValidChoice', kind: 'object', label: 'choice request valid', notation: 'adl.nav.request_valid.choice', comment: '[RO] Whether a choice request for a target activity would be valid now, one entry per target asked about.', domain: 'DataModel', range: 'TargetedRequestValidity', source: `${RTE}: adl.nav.request_valid.choice` },
    { name: 'navRequestValidJump', kind: 'object', label: 'jump request valid', notation: 'adl.nav.request_valid.jump', comment: '[RO] Whether a jump request to a target activity would be valid now, one entry per target asked about. Added in the 4th Edition.', domain: 'DataModel', range: 'TargetedRequestValidity', source: `${RTE}: adl.nav.request_valid.jump` },
    { name: 'requestTarget', kind: 'datatype', label: 'request target', notation: 'target', comment: 'The identifier of the target activity of a choice or jump request.', domain: 'TargetedRequestValidity', range: 'xsd:string', functional: true, source: `${RTE}: adl.nav.request_valid.choice.{target=}, adl.nav.request_valid.jump.{target=}` },
    { name: 'requestValidity', kind: 'datatype', label: 'request validity', comment: 'Whether the request would be valid: true, false or unknown.', domain: 'TargetedRequestValidity', oneOf: VALIDITY, functional: true, source: `${RTE}: adl.nav.request_valid` },
    // ── adl.data: shared data ──
    { name: 'sharedData', kind: 'object', label: 'shared data', notation: 'adl.data', comment: 'A shared data store the SCO has access to; the collection is ordered. Added in the 4th Edition.', domain: 'DataModel', range: 'SharedData', source: `${RTE}: adl.data` },
    { name: 'sharedDataId', kind: 'datatype', label: 'shared data ID', notation: 'adl.data.n.id', comment: '[RO] The identifier of the store: the target ID of the item\'s adlcp:map; long_identifier_type.', domain: 'SharedData', range: 'xsd:string', functional: true, source: `${RTE}: adl.data.n.id` },
    { name: 'sharedDataStore', kind: 'datatype', label: 'shared data content', notation: 'adl.data.n.store', comment: `[RW, as the map allows] The content of the store; characterstring, SPM ${SUSPEND_DATA_SPM}.`, domain: 'SharedData', range: 'xsd:string', functional: true, source: `${RTE}: adl.data.n.store` },
  ],
  vocabularies: [
    {
      name: 'CompletionStatus', label: 'Completion statuses', comment: 'The values of cmi.completion_status and cmi.objectives.n.completion_status.',
      members: [
        { name: 'completed', label: 'completed', comment: 'The learner has completed it.' },
        { name: 'incomplete', label: 'incomplete', comment: 'The learner has started but not completed it.' },
        { name: 'not attempted', label: 'not attempted', comment: 'The learner has not started it.' },
        { name: 'unknown', label: 'unknown', comment: 'Whether it is completed is not known.' },
      ],
    },
    {
      name: 'SuccessStatus', label: 'Success statuses', comment: 'The values of cmi.success_status and cmi.objectives.n.success_status.',
      members: [
        { name: 'passed', label: 'passed', comment: 'The learner has mastered it.' },
        { name: 'failed', label: 'failed', comment: 'The learner has not mastered it.' },
        { name: 'unknown', label: 'unknown', comment: 'Whether the learner has mastered it is not known.' },
      ],
    },
    {
      name: 'Credit', label: 'Credit values', comment: 'The values of cmi.credit.',
      members: [
        { name: 'credit', label: 'credit', comment: 'The learner is credited for performance in the SCO.' },
        { name: 'no-credit', label: 'no credit', notation: 'no-credit', comment: 'The learner is not credited for performance in the SCO.' },
      ],
    },
    {
      name: 'Entry', label: 'Entry values', comment: 'The values of cmi.entry.',
      members: [
        { name: 'ab-initio', label: 'ab initio', notation: 'ab-initio', comment: 'The learner enters the SCO for the first time in the attempt.' },
        { name: 'resume', label: 'resume', comment: 'The learner resumes a suspended attempt.' },
        { name: '', label: '(empty)', comment: 'Neither: an attempt that is not new and was not suspended.' },
      ],
    },
    {
      name: 'Exit', label: 'Exit values', comment: 'The values of cmi.exit. Every value but suspend ends the attempt.',
      members: [
        { name: 'time-out', label: 'time out', notation: 'time-out', comment: 'The SCO ended because the maximum time allowed was exceeded.' },
        { name: 'suspend', label: 'suspend', comment: 'The learner suspended the attempt, to resume it later.' },
        { name: 'logout', label: 'logout', comment: 'A value ADL has deprecated for a SCO to set: a SCO should not use it. An LMS that receives it processes an Exit All navigation request when the SCO is taken away.', changeNote: '2026.10.0: no longer marked owl:deprecated. ADL deprecated the token for a SCO to set, but an LMS must still process it, so the value is not obsolete; its comment says how it is deprecated.' },
        { name: 'normal', label: 'normal', comment: 'The SCO ended normally.' },
        { name: '', label: '(empty)', comment: 'No exit condition was set: the default.' },
      ],
    },
    {
      name: 'Mode', label: 'Modes', comment: 'The values of cmi.mode.',
      members: [
        { name: 'browse', label: 'browse', comment: 'The learner looks at the SCO without credit.' },
        { name: 'normal', label: 'normal', comment: 'The SCO is presented normally, for credit as cmi.credit says.' },
        { name: 'review', label: 'review', comment: 'The learner reviews a SCO already experienced.' },
      ],
    },
    {
      name: 'TimeLimitAction', label: 'Time limit actions', comment: 'The values of cmi.time_limit_action.',
      members: [
        { name: 'exit,message', label: 'exit with a message', notation: 'exit,message', comment: 'Leave the SCO, and tell the learner why.' },
        { name: 'exit,no message', label: 'exit without a message', notation: 'exit,no message', comment: 'Leave the SCO without telling the learner.' },
        { name: 'continue,message', label: 'continue with a message', notation: 'continue,message', comment: 'Stay in the SCO, and tell the learner the time is up.' },
        { name: 'continue,no message', label: 'continue without a message', notation: 'continue,no message', comment: 'Stay in the SCO without telling the learner.' },
      ],
    },
    {
      name: 'InteractionType', label: 'Interaction types', comment: 'The values of cmi.interactions.n.type.',
      members: [
        { name: 'true-false', label: 'true or false', notation: 'true-false', comment: 'The learner judges a statement true or false.' },
        { name: 'choice', label: 'choice', comment: 'The learner chooses one or more options.' },
        { name: 'fill-in', label: 'fill in', notation: 'fill-in', comment: 'The learner enters one or more short texts.' },
        { name: 'long-fill-in', label: 'long fill in', notation: 'long-fill-in', comment: 'The learner enters a long text.' },
        { name: 'likert', label: 'Likert', notation: 'likert', comment: 'The learner chooses a point on a scale.' },
        { name: 'matching', label: 'matching', comment: 'The learner matches sources to targets.' },
        { name: 'performance', label: 'performance', comment: 'The learner carries out a task in steps.' },
        { name: 'sequencing', label: 'sequencing', comment: 'The learner puts items in order.' },
        { name: 'numeric', label: 'numeric', comment: 'The learner enters a number.' },
        { name: 'other', label: 'other', comment: 'Any other kind of interaction.' },
      ],
    },
    {
      name: 'InteractionResult', label: 'Interaction results', comment: 'The judgements cmi.interactions.n.result may take; a real number is also allowed.',
      members: [
        { name: 'correct', label: 'correct', comment: 'The response was correct.' },
        { name: 'incorrect', label: 'incorrect', comment: 'The response was incorrect.' },
        { name: 'unanticipated', label: 'unanticipated', comment: 'The response was not one the SCO anticipated.' },
        { name: 'neutral', label: 'neutral', comment: 'The response is neither correct nor incorrect.' },
      ],
    },
    {
      name: 'AudioCaptioning', label: 'Audio captioning values', comment: 'The values of cmi.learner_preference.audio_captioning.',
      members: [
        { name: '-1', label: 'off', notation: '-1', comment: 'Captioning is off.' },
        { name: '0', label: 'no change', notation: '0', comment: 'No change from the SCO\'s own setting.' },
        { name: '1', label: 'on', notation: '1', comment: 'Captioning is on.' },
      ],
    },
    {
      name: 'NavigationRequestType', label: 'Navigation requests', comment: 'The navigation requests adl.nav.request may hold. A choice or jump request names its target: {target=ID}choice, {target=ID}jump.',
      members: [
        { name: 'continue', label: 'continue', comment: 'Go to the next activity in flow.' },
        { name: 'previous', label: 'previous', comment: 'Go to the previous activity in flow.' },
        { name: 'choice', label: 'choice', comment: 'Go to the target activity, as if the learner had chosen it.' },
        { name: 'jump', label: 'jump', comment: 'Go to the target activity, regardless of the learner\'s navigation controls. Added in the 4th Edition.' },
        { name: 'exit', label: 'exit', comment: 'End the current activity.' },
        { name: 'exitAll', label: 'exit all', notation: 'exitAll', comment: 'End the whole activity tree.' },
        { name: 'abandon', label: 'abandon', comment: 'Abandon the current activity.' },
        { name: 'abandonAll', label: 'abandon all', notation: 'abandonAll', comment: 'Abandon the whole activity tree.' },
        { name: 'suspendAll', label: 'suspend all', notation: 'suspendAll', comment: 'Suspend the whole activity tree, to resume later.' },
        { name: '_none_', label: 'none', notation: '_none_', comment: 'No request: the default.' },
      ],
    },
    {
      name: 'RequestValidity', label: 'Request validities', comment: 'The values of adl.nav.request_valid.',
      members: [
        { name: 'true', label: 'true', comment: 'The request would be valid.' },
        { name: 'false', label: 'false', comment: 'The request would not be valid.' },
        { name: 'unknown', label: 'unknown', comment: 'Whether the request would be valid cannot be determined now.' },
      ],
    },
  ],
  disjoint: [
    ['DataModel', 'Comment', 'LearnerPreference', 'Interaction', 'InteractionObjective', 'CorrectResponse', 'Objective', 'Score', 'TargetedRequestValidity', 'SharedData'],
  ],
  shapes: [
    {
      name: 'DataModelShape', targetClass: 'DataModel', label: 'Run-time data conformance',
      comment: `Every element has at most one value; the statuses, credit, entry, exit, mode and time limit action are from their vocabularies; measures and scores are in range; the times are timeintervals; suspend data beyond its SPM is reported as a warning; the navigation request is a navigation request (${RTE}).`,
      constraints: [
        { path: 'completionStatus', maxCount: 1, datatype: 'xsd:string', in: COMPLETION_STATUS, comment: 'cmi.completion_status' },
        { path: 'successStatus', maxCount: 1, datatype: 'xsd:string', in: SUCCESS_STATUS, comment: 'cmi.success_status' },
        { path: 'credit', maxCount: 1, datatype: 'xsd:string', in: CREDIT, comment: 'cmi.credit' },
        { path: 'entry', maxCount: 1, datatype: 'xsd:string', in: ENTRY, comment: 'cmi.entry' },
        { path: 'exit', maxCount: 1, datatype: 'xsd:string', in: EXIT, comment: 'cmi.exit (logout is deprecated)' },
        { path: 'mode', maxCount: 1, datatype: 'xsd:string', in: MODE, comment: 'cmi.mode' },
        { path: 'timeLimitAction', maxCount: 1, datatype: 'xsd:string', in: TIME_LIMIT_ACTION, comment: 'cmi.time_limit_action' },
        { path: 'completionThreshold', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'cmi.completion_threshold, from 0 to 1' },
        { path: 'progressMeasure', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'cmi.progress_measure, from 0 to 1' },
        { path: 'scaledPassingScore', maxCount: 1, datatype: NUMBER, minInclusive: -1, maxInclusive: 1, comment: 'cmi.scaled_passing_score, from -1 to 1' },
        { path: 'sessionTime', maxCount: 1, datatype: 'xsd:string', pattern: SCORM_TIMEINTERVAL, comment: 'cmi.session_time, timeinterval (second,10,2)' },
        { path: 'totalTime', maxCount: 1, datatype: 'xsd:string', pattern: SCORM_TIMEINTERVAL, comment: 'cmi.total_time, timeinterval (second,10,2)' },
        { path: 'maxTimeAllowed', maxCount: 1, datatype: 'xsd:string', pattern: SCORM_TIMEINTERVAL, comment: 'cmi.max_time_allowed, timeinterval (second,10,2)' },
        { path: 'suspendData', maxCount: 1, datatype: 'xsd:string', comment: 'cmi.suspend_data' },
        { path: 'suspendData', name: 'suspendData-SPM', pattern: `^[\\s\\S]{0,${SUSPEND_DATA_SPM}}$`, severity: 'Warning', comment: `cmi.suspend_data, within its SPM of ${SUSPEND_DATA_SPM} characters to be portable` },
        { path: 'navRequest', maxCount: 1, datatype: 'xsd:string', pattern: NAV_REQUEST, comment: 'adl.nav.request' },
        { path: 'navRequestValidContinue', maxCount: 1, datatype: 'xsd:string', in: VALIDITY, comment: 'adl.nav.request_valid.continue' },
        { path: 'navRequestValidPrevious', maxCount: 1, datatype: 'xsd:string', in: VALIDITY, comment: 'adl.nav.request_valid.previous' },
        // ★ The elements below are single-valued (owl:FunctionalProperty), and the shape said so in
        // its description without constraining them.
        { path: 'version', maxCount: 1, datatype: 'xsd:string', comment: 'cmi._version' },
        { path: 'launchData', maxCount: 1, datatype: 'xsd:string', comment: 'cmi.launch_data' },
        { path: 'learnerId', maxCount: 1, datatype: 'xsd:string', comment: 'cmi.learner_id' },
        { path: 'learnerName', maxCount: 1, comment: 'cmi.learner_name, localized_string_type' },
        { path: 'location', maxCount: 1, datatype: 'xsd:string', comment: 'cmi.location' },
        { path: 'score', maxCount: 1, comment: 'cmi.score' },
        { path: 'learnerPreference', maxCount: 1, comment: 'cmi.learner_preference' },
      ],
    },
    {
      name: 'ScoreShape', targetClass: 'Score', label: 'Score conformance',
      comment: `A scaled score is from -1 to 1; raw, minimum and maximum are real numbers (${RTE}: cmi.score).`,
      constraints: [
        { path: 'scoreScaled', maxCount: 1, datatype: NUMBER, minInclusive: -1, maxInclusive: 1, comment: 'score.scaled, from -1 to 1' },
        { path: 'scoreRaw', maxCount: 1, datatype: NUMBER, comment: 'score.raw, real (10,7)' },
        { path: 'scoreMin', maxCount: 1, datatype: NUMBER, comment: 'score.min, real (10,7)' },
        { path: 'scoreMax', maxCount: 1, datatype: NUMBER, comment: 'score.max, real (10,7)' },
      ],
    },
    {
      name: 'InteractionShape', targetClass: 'Interaction', label: 'Interaction conformance',
      comment: `An interaction has an ID and a type from the vocabulary; its weighting is a real number, its result a judgement or a number, its latency a timeinterval and its timestamp a SCORM time (${RTE}: cmi.interactions).`,
      constraints: [
        { path: 'interactionId', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'cmi.interactions.n.id, required' },
        { path: 'interactionType', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: INTERACTION_TYPE, comment: 'cmi.interactions.n.type' },
        { path: 'weighting', maxCount: 1, datatype: NUMBER, comment: 'cmi.interactions.n.weighting, real (10,7)' },
        { path: 'result', maxCount: 1, datatype: 'xsd:string', pattern: RESULT, comment: 'cmi.interactions.n.result: correct, incorrect, unanticipated, neutral, or a number' },
        { path: 'latency', maxCount: 1, datatype: 'xsd:string', pattern: SCORM_TIMEINTERVAL, comment: 'cmi.interactions.n.latency, timeinterval (second,10,2)' },
        { path: 'interactionTimestamp', maxCount: 1, datatype: 'xsd:string', pattern: SCORM_TIME, comment: 'cmi.interactions.n.timestamp, time (second,10,0)' },
        { path: 'interactionDescription', maxCount: 1, datatype: 'rdf:langString', comment: 'cmi.interactions.n.description, localized_string_type' },
        { path: 'learnerResponse', maxCount: 1, datatype: 'xsd:string', comment: 'cmi.interactions.n.learner_response' },
      ],
    },
    {
      name: 'ObjectiveShape', targetClass: 'Objective', label: 'Objective conformance',
      comment: `An objective has an ID; its statuses are from their vocabularies; its progress measure is from 0 to 1 (${RTE}: cmi.objectives).`,
      constraints: [
        { path: 'objectiveId', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'cmi.objectives.n.id, required' },
        { path: 'objectiveSuccessStatus', maxCount: 1, datatype: 'xsd:string', in: SUCCESS_STATUS, comment: 'cmi.objectives.n.success_status' },
        { path: 'objectiveCompletionStatus', maxCount: 1, datatype: 'xsd:string', in: COMPLETION_STATUS, comment: 'cmi.objectives.n.completion_status' },
        { path: 'objectiveProgressMeasure', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'cmi.objectives.n.progress_measure, from 0 to 1' },
        { path: 'objectiveScore', maxCount: 1, comment: 'cmi.objectives.n.score' },
        { path: 'objectiveDescription', maxCount: 1, datatype: 'rdf:langString', comment: 'cmi.objectives.n.description, localized_string_type' },
      ],
    },
    {
      name: 'LearnerPreferenceShape', targetClass: 'LearnerPreference', label: 'Learner preference conformance',
      comment: `The audio level and delivery speed are 0 or more; audio captioning is -1, 0 or 1; a language beyond its SPM is reported as a warning (${RTE}: cmi.learner_preference).`,
      constraints: [
        { path: 'audioLevel', maxCount: 1, datatype: NUMBER, minInclusive: 0, comment: 'audio_level, 0 or more' },
        { path: 'deliverySpeed', maxCount: 1, datatype: NUMBER, minInclusive: 0, comment: 'delivery_speed, 0 or more' },
        { path: 'audioCaptioning', maxCount: 1, datatype: 'xsd:integer', minInclusive: -1, maxInclusive: 1, comment: 'audio_captioning: -1, 0 or 1' },
        { path: 'preferenceLanguage', maxCount: 1, datatype: 'xsd:string', comment: 'cmi.learner_preference.language' },
        { path: 'preferenceLanguage', name: 'preferenceLanguage-SPM', pattern: `^[\\s\\S]{0,${SHORT_SPM}}$`, severity: 'Warning', comment: `language, within its SPM of ${SHORT_SPM} characters to be portable` },
      ],
    },
    {
      name: 'CommentFromLearnerShape', targetClass: 'CommentFromLearner', label: 'Comment from learner conformance',
      comment: `A learner's comment has its text, and at most one location and one SCORM time (${RTE}: cmi.comments_from_learner).`,
      constraints: [
        { path: 'comment', minCount: 1, maxCount: 1, datatype: 'rdf:langString', comment: 'cmi.comments_from_learner.n.comment' },
        { path: 'commentLocation', maxCount: 1, datatype: 'xsd:string', comment: 'cmi.comments_from_learner.n.location' },
        { path: 'commentTimestamp', maxCount: 1, datatype: 'xsd:string', pattern: SCORM_TIME, comment: 'cmi.comments_from_learner.n.timestamp, time (second,10,0)' },
      ],
    },
    {
      name: 'CommentFromLMSShape', targetClass: 'CommentFromLMS', label: 'Comment from LMS conformance',
      comment: `An LMS comment has its text, and at most one location and one SCORM time (${RTE}: cmi.comments_from_lms).`,
      constraints: [
        { path: 'comment', minCount: 1, maxCount: 1, datatype: 'rdf:langString', comment: 'cmi.comments_from_lms.n.comment' },
        { path: 'commentLocation', maxCount: 1, datatype: 'xsd:string', comment: 'cmi.comments_from_lms.n.location' },
        { path: 'commentTimestamp', maxCount: 1, datatype: 'xsd:string', pattern: SCORM_TIME, comment: 'cmi.comments_from_lms.n.timestamp, time (second,10,0)' },
      ],
    },
    {
      name: 'InteractionObjectiveShape', targetClass: 'InteractionObjective', label: 'Interaction objective conformance',
      comment: `An interaction's objective has an ID (${RTE}: cmi.interactions.n.objectives).`,
      constraints: [
        { path: 'interactionObjectiveId', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'cmi.interactions.n.objectives.m.id, required' },
      ],
    },
    {
      name: 'CorrectResponseShape', targetClass: 'CorrectResponse', label: 'Correct response conformance',
      comment: `A correct response has a pattern (${RTE}: cmi.interactions.n.correct_responses).`,
      constraints: [
        { path: 'correctResponsePattern', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'cmi.interactions.n.correct_responses.m.pattern, required' },
      ],
    },
    {
      name: 'TargetedRequestValidityShape', targetClass: 'TargetedRequestValidity', label: 'Targeted request validity conformance',
      comment: `A targeted request validity names its target and is true, false or unknown (${RTE}: adl.nav.request_valid).`,
      constraints: [
        { path: 'requestTarget', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'the target activity\'s identifier' },
        { path: 'requestValidity', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: VALIDITY, comment: 'true, false or unknown' },
      ],
    },
    {
      name: 'SharedDataShape', targetClass: 'SharedData', label: 'Shared data conformance',
      comment: `A shared data store has an ID; content beyond its SPM is reported as a warning (${RTE}: adl.data).`,
      constraints: [
        { path: 'sharedDataId', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'adl.data.n.id' },
        { path: 'sharedDataStore', maxCount: 1, datatype: 'xsd:string', comment: 'adl.data.n.store' },
        { path: 'sharedDataStore', name: 'sharedDataStore-SPM', pattern: `^[\\s\\S]{0,${SUSPEND_DATA_SPM}}$`, severity: 'Warning', comment: `adl.data.n.store, within its SPM of ${SUSPEND_DATA_SPM} characters to be portable` },
      ],
    },
  ],
};
