/**
 * SCORM 2004 4th Edition Run-Time Environment / IEEE 1484.11.1 CMI data model — the single source.
 *
 * OWL + SHACL ontology of the SCORM 2004 4th Ed RTE book (the cmi.* data model exposed through the
 * IEEE 1484.11.2 ECMAScript API `API_1484_11`) and IEEE 1484.11.1 (Data Model for Content to LMS
 * Communication). Every cmi.* element the RTE shim implements (deploy/foxxi-scorm-player/site/
 * scorm-rte.js, the real `window.API_1484_11`) is modelled as a property of the DataModel class with
 * its datatype, read/write access (in the property comment), and enumerated vocabulary.
 *
 * Composed into the PGSL lattice (composeSpecOntology) and projected to OWL/SHACL/JSON-LD on
 * dereference at <bridge>/ns/scorm-rte. The SCORM player validates a CMI snapshot against the SHACL
 * shapes this model publishes (validateAgainstShape) — vocabularies, cmi.score.scaled ∈ [-1,1],
 * and the suspend_data ≤ 64000-char limit — and each result cites its shape IRI.
 *
 * Access keys used in property comments:
 *   [RW]  read/write   — content may Get and Set
 *   [RO]  read-only    — content may Get; SetValue → error 404 (data model element is read only)
 *   [WO]  write-only   — content may Set; GetValue → error 405
 */
import type { OntologyModel } from '../spec-ontology.js';

// SCORM 2004 4th Ed RTE characterstring limits.
const SUSPEND_DATA_MAX = 64000;   // SPM 64000 chars (RTE §4.2.27 cmi.suspend_data)
const SHORT_IDENTIFIER_SPM = 250; // SPM 250 chars (short_identifier_type — long_identifier_type is SPM 4000)
// ISO 8601 duration (RTE timeinterval (second, 10,2) profile).
const DURATION = '^P(?:\\d+(?:\\.\\d+)?Y)?(?:\\d+(?:\\.\\d+)?M)?(?:\\d+(?:\\.\\d+)?W)?(?:\\d+(?:\\.\\d+)?D)?(?:T(?:\\d+(?:\\.\\d+)?H)?(?:\\d+(?:\\.\\d+)?M)?(?:\\d+(?:\\.\\d+)?S)?)?$';
// ISO 8601 second(10,2) timestamp (interaction/comment timestamps).
const TIMESTAMP = '^\\d{4}(-\\d{2}(-\\d{2}(T\\d{2}(:\\d{2}(:\\d{2}(\\.\\d{1,2})?)?)?(Z|[+-]\\d{2}(:\\d{2})?)?)?)?)?$';

export const SCORM_RTE_MODEL: OntologyModel = {
  module: 'scorm-rte',
  title: 'SCORM 2004 4th Ed RTE — IEEE 1484.11.1 CMI data model',
  description:
    'OWL + SHACL ontology of the SCORM 2004 4th Edition Run-Time Environment cmi.* data model (IEEE 1484.11.1 / exposed via the IEEE 1484.11.2 API_1484_11). Models the DataModel and its sub-objects — comments_from_learner, comments_from_lms, learner_preference, interactions (+ objectives, correct_responses), objectives, score — with the datatype, read/write access, and vocabulary of every element, plus SHACL shapes for the enumerated vocabularies, cmi.score.scaled ∈ [-1,1], and the suspend_data 64000-char SPM. Composed into PGSL and projected here; the Foxxi SCORM player validates a CMI snapshot against these shapes.',
  version: '4.0.0',
  spec: 'https://adlnet.gov/projects/scorm-2004-4th-edition/',
  derivedFrom: 'IEEE 1484.11.1-2004 (Data Model for Content to Learning Management System Communication)',
  classes: [
    { name: 'DataModel', label: 'CMI Data Model', comment: 'The cmi runtime data model an SCO communicates with through API_1484_11 GetValue/SetValue. Root of every cmi.* element (RTE §4.2).' },
    { name: 'Comment', label: 'Comment', comment: 'A free-text comment with an optional location and timestamp — base of comments_from_learner.n and comments_from_lms.n (RTE §4.2.2 / §4.2.3).' },
    { name: 'CommentFromLearner', label: 'Comment From Learner', comment: 'cmi.comments_from_learner.n — a comment the learner authored against the SCO; read/write, ordered collection (RTE §4.2.2).', subClassOf: ['Comment'] },
    { name: 'CommentFromLMS', label: 'Comment From LMS', comment: 'cmi.comments_from_lms.n — a comment the LMS provides to the SCO; read-only, ordered collection (RTE §4.2.3).', subClassOf: ['Comment'] },
    { name: 'LearnerPreference', label: 'Learner Preference', comment: 'cmi.learner_preference — the learner UI preferences (audio level, language, delivery speed, audio captioning); read/write (RTE §4.2.16).' },
    { name: 'Interaction', label: 'Interaction', comment: 'cmi.interactions.n — a recognized assessment interaction the learner responded to: id, type, objectives, timestamp, correct_responses, weighting, learner_response, result, latency, description (RTE §4.2.14).' },
    { name: 'InteractionObjective', label: 'Interaction Objective', comment: 'cmi.interactions.n.objectives.m — an objective identifier associated with an interaction (RTE §4.2.14).' },
    { name: 'CorrectResponse', label: 'Correct Response', comment: 'cmi.interactions.n.correct_responses.m — a correct response pattern for an interaction; format depends on the interaction type (RTE §4.2.14 / IEEE 1484.11.1 correct response patterns).' },
    { name: 'Objective', label: 'Objective', comment: 'cmi.objectives.n — a learning objective the SCO tracks: id, score, success_status, completion_status, progress_measure, description (RTE §4.2.22).' },
    { name: 'Score', label: 'Score', comment: 'A score object with scaled / raw / min / max — used by cmi.score and cmi.objectives.n.score (RTE §4.2.26 / §4.2.22).' },
  ],
  properties: [
    // ── DataModel scalar elements ──
    { name: 'version', kind: 'datatype', label: 'cmi._version', comment: '[RO] cmi._version — the version of the data model supported by the LMS (RTE §4.2.1).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'completionStatus', kind: 'datatype', label: 'cmi.completion_status', comment: '[RW] cmi.completion_status — whether the learner has completed the SCO: completed | incomplete | not attempted | unknown (RTE §4.2.4).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'completionThreshold', kind: 'datatype', label: 'cmi.completion_threshold', comment: '[RO] cmi.completion_threshold — the value (0..1) against which progress_measure is compared to set completion_status; real(10,7) (RTE §4.2.5).', domain: 'DataModel', range: 'xsd:decimal' },
    { name: 'credit', kind: 'datatype', label: 'cmi.credit', comment: '[RO] cmi.credit — whether the learner will be credited for performance: credit | no-credit (RTE §4.2.6).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'entry', kind: 'datatype', label: 'cmi.entry', comment: "[RO] cmi.entry — whether the learner has previously accessed the SCO: ab-initio | resume | '' (empty) (RTE §4.2.7).", domain: 'DataModel', range: 'xsd:string' },
    { name: 'exit', kind: 'datatype', label: 'cmi.exit', comment: "[WO] cmi.exit — how/why the learner left the SCO: time-out | suspend | logout | normal | '' (empty) (RTE §4.2.8).", domain: 'DataModel', range: 'xsd:string' },
    { name: 'launchData', kind: 'datatype', label: 'cmi.launch_data', comment: '[RO] cmi.launch_data — data provided to the SCO at launch (from the manifest <adlcp:dataFromLMS>); characterstring SPM 4000 (RTE §4.2.9).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'learnerId', kind: 'datatype', label: 'cmi.learner_id', comment: '[RO] cmi.learner_id — unique identifier for the learner; long_identifier_type SPM 4000 (RTE §4.2.10).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'learnerName', kind: 'datatype', label: 'cmi.learner_name', comment: '[RO] cmi.learner_name — name of the learner; localized_string_type SPM 250 (RTE §4.2.11).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'learnerPreference', kind: 'object', label: 'cmi.learner_preference', comment: 'cmi.learner_preference — the learner preference sub-object (RTE §4.2.16).', domain: 'DataModel', range: 'LearnerPreference' },
    { name: 'location', kind: 'datatype', label: 'cmi.location', comment: '[RW] cmi.location — the SCO-defined bookmark/resume point; characterstring SPM 1000 (RTE §4.2.17).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'maxTimeAllowed', kind: 'datatype', label: 'cmi.max_time_allowed', comment: '[RO] cmi.max_time_allowed — the amount of accumulated time the learner is allowed in the current attempt; timeinterval second(10,2) (RTE §4.2.18).', domain: 'DataModel', range: 'xsd:duration' },
    { name: 'mode', kind: 'datatype', label: 'cmi.mode', comment: '[RO] cmi.mode — the mode the SCO is presented in: browse | normal | review (RTE §4.2.19).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'progressMeasure', kind: 'datatype', label: 'cmi.progress_measure', comment: '[RW] cmi.progress_measure — measure of progress toward completion (0..1); real(10,7) (RTE §4.2.23).', domain: 'DataModel', range: 'xsd:decimal' },
    { name: 'scaledPassingScore', kind: 'datatype', label: 'cmi.scaled_passing_score', comment: '[RO] cmi.scaled_passing_score — the scaled passing score (-1..1) the SCO must meet/exceed to be passed; real(10,7) (RTE §4.2.25).', domain: 'DataModel', range: 'xsd:decimal' },
    { name: 'score', kind: 'object', label: 'cmi.score', comment: 'cmi.score — the learner score for the SCO (scaled/raw/min/max) (RTE §4.2.26).', domain: 'DataModel', range: 'Score' },
    { name: 'sessionTime', kind: 'datatype', label: 'cmi.session_time', comment: '[WO] cmi.session_time — the accumulated time of the current learner session; timeinterval second(10,2) (RTE §4.2.27).', domain: 'DataModel', range: 'xsd:duration' },
    { name: 'successStatus', kind: 'datatype', label: 'cmi.success_status', comment: '[RW] cmi.success_status — whether the learner has mastered the SCO: passed | failed | unknown (RTE §4.2.28).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'suspendData', kind: 'datatype', label: 'cmi.suspend_data', comment: '[RW] cmi.suspend_data — SCO-provided data persisted across sessions; characterstring SPM 64000 in SCORM 2004 4th Ed (RTE §4.2.29).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'timeLimitAction', kind: 'datatype', label: 'cmi.time_limit_action', comment: '[RO] cmi.time_limit_action — what the SCO should do when max_time_allowed is exceeded: exit,message | exit,no message | continue,message | continue,no message (RTE §4.2.30).', domain: 'DataModel', range: 'xsd:string' },
    { name: 'totalTime', kind: 'datatype', label: 'cmi.total_time', comment: '[RO] cmi.total_time — accumulated time of all the learner sessions for the SCO; timeinterval second(10,2) (RTE §4.2.31).', domain: 'DataModel', range: 'xsd:duration' },
    // ── DataModel collections ──
    { name: 'commentsFromLearner', kind: 'object', label: 'cmi.comments_from_learner', comment: '[RW] cmi.comments_from_learner.n — ordered collection of learner comments (RTE §4.2.2).', domain: 'DataModel', range: 'CommentFromLearner' },
    { name: 'commentsFromLMS', kind: 'object', label: 'cmi.comments_from_lms', comment: '[RO] cmi.comments_from_lms.n — ordered collection of LMS comments (RTE §4.2.3).', domain: 'DataModel', range: 'CommentFromLMS' },
    { name: 'interactions', kind: 'object', label: 'cmi.interactions', comment: '[RW] cmi.interactions.n — ordered collection of recognized interactions (RTE §4.2.14).', domain: 'DataModel', range: 'Interaction' },
    { name: 'objectives', kind: 'object', label: 'cmi.objectives', comment: '[RW] cmi.objectives.n — ordered collection of objectives (RTE §4.2.22).', domain: 'DataModel', range: 'Objective' },
    // ── Comment fields (comments_from_learner.n / comments_from_lms.n) ──
    { name: 'comment', kind: 'datatype', label: 'comment', comment: '[RW for learner / RO for lms] .comment — the textual comment; localized_string_type SPM 4000 (RTE §4.2.2.1 / §4.2.3.1).', domain: 'Comment', range: 'rdf:langString' },
    { name: 'commentLocation', kind: 'datatype', label: 'location', comment: '[RW for learner / RO for lms] .location — the SCO location the comment pertains to; characterstring SPM 250 (RTE §4.2.2.2 / §4.2.3.2).', domain: 'Comment', range: 'xsd:string' },
    { name: 'commentTimestamp', kind: 'datatype', label: 'timestamp', comment: '[RW for learner / RO for lms] .timestamp — when the comment was created; ISO 8601 second(10,2) (RTE §4.2.2.3 / §4.2.3.3).', domain: 'Comment', range: 'xsd:dateTime' },
    // ── LearnerPreference fields ──
    { name: 'audioLevel', kind: 'datatype', label: 'cmi.learner_preference.audio_level', comment: '[RW] audio_level — multiplier for the SCO audio volume (≥ 0; 1 = nominal); real(10,7) (RTE §4.2.16.1).', domain: 'LearnerPreference', range: 'xsd:decimal' },
    { name: 'preferenceLanguage', kind: 'datatype', label: 'cmi.learner_preference.language', comment: '[RW] language — the preferred language for the SCO (RFC 3066/5646 language tag); characterstring SPM 250 (RTE §4.2.16.2).', domain: 'LearnerPreference', range: 'xsd:string' },
    { name: 'deliverySpeed', kind: 'datatype', label: 'cmi.learner_preference.delivery_speed', comment: '[RW] delivery_speed — multiplier for the SCO content delivery speed (≥ 0; 1 = nominal); real(10,7) (RTE §4.2.16.3).', domain: 'LearnerPreference', range: 'xsd:decimal' },
    { name: 'audioCaptioning', kind: 'datatype', label: 'cmi.learner_preference.audio_captioning', comment: '[RW] audio_captioning — captioning preference: -1 (off) | 0 (no change / default) | 1 (on) (RTE §4.2.16.4).', domain: 'LearnerPreference', range: 'xsd:integer' },
    // ── Interaction fields ──
    { name: 'interactionId', kind: 'datatype', label: 'cmi.interactions.n.id', comment: '[RW] .id — unique label for the interaction; long_identifier_type SPM 4000 (RTE §4.2.14.1).', domain: 'Interaction', range: 'xsd:string' },
    { name: 'interactionType', kind: 'datatype', label: 'cmi.interactions.n.type', comment: '[RW] .type — the interaction type: true-false | choice | fill-in | long-fill-in | likert | matching | performance | sequencing | numeric | other (RTE §4.2.14.2).', domain: 'Interaction', range: 'xsd:string' },
    { name: 'interactionObjectives', kind: 'object', label: 'cmi.interactions.n.objectives', comment: '[RW] .objectives.m — objective ids associated with the interaction (RTE §4.2.14.3).', domain: 'Interaction', range: 'InteractionObjective' },
    { name: 'interactionTimestamp', kind: 'datatype', label: 'cmi.interactions.n.timestamp', comment: '[RW] .timestamp — when the interaction was first made available; ISO 8601 second(10,2) (RTE §4.2.14.4).', domain: 'Interaction', range: 'xsd:dateTime' },
    { name: 'correctResponses', kind: 'object', label: 'cmi.interactions.n.correct_responses', comment: '[RW] .correct_responses.m — the correct response pattern(s) for the interaction (RTE §4.2.14.5).', domain: 'Interaction', range: 'CorrectResponse' },
    { name: 'weighting', kind: 'datatype', label: 'cmi.interactions.n.weighting', comment: '[RW] .weighting — the weight of the interaction relative to others; real(10,7) (RTE §4.2.14.6).', domain: 'Interaction', range: 'xsd:decimal' },
    { name: 'learnerResponse', kind: 'datatype', label: 'cmi.interactions.n.learner_response', comment: '[RW] .learner_response — the learner response; format depends on the interaction type (RTE §4.2.14.7).', domain: 'Interaction', range: 'xsd:string' },
    { name: 'result', kind: 'datatype', label: 'cmi.interactions.n.result', comment: '[RW] .result — judgement of the response: correct | incorrect | unanticipated | neutral | a real number (RTE §4.2.14.8).', domain: 'Interaction', range: 'xsd:string' },
    { name: 'latency', kind: 'datatype', label: 'cmi.interactions.n.latency', comment: '[RW] .latency — time from making the interaction available to the first response; timeinterval second(10,2) (RTE §4.2.14.9).', domain: 'Interaction', range: 'xsd:duration' },
    { name: 'interactionDescription', kind: 'datatype', label: 'cmi.interactions.n.description', comment: '[RW] .description — a brief description of the interaction; localized_string_type SPM 250 (RTE §4.2.14.10).', domain: 'Interaction', range: 'rdf:langString' },
    // ── InteractionObjective / CorrectResponse fields ──
    { name: 'interactionObjectiveId', kind: 'datatype', label: 'cmi.interactions.n.objectives.m.id', comment: '[RW] .objectives.m.id — the objective identifier; long_identifier_type SPM 4000 (RTE §4.2.14.3.1).', domain: 'InteractionObjective', range: 'xsd:string' },
    { name: 'correctResponsePattern', kind: 'datatype', label: 'cmi.interactions.n.correct_responses.m.pattern', comment: '[RW] .correct_responses.m.pattern — a correct response pattern; format depends on the interaction type (RTE §4.2.14.5.1).', domain: 'CorrectResponse', range: 'xsd:string' },
    // ── Objective fields ──
    { name: 'objectiveId', kind: 'datatype', label: 'cmi.objectives.n.id', comment: '[RW] .id — unique label for the objective; long_identifier_type SPM 4000 (RTE §4.2.22.1).', domain: 'Objective', range: 'xsd:string' },
    { name: 'objectiveScore', kind: 'object', label: 'cmi.objectives.n.score', comment: '[RW] .score — the objective score object (scaled/raw/min/max) (RTE §4.2.22.2).', domain: 'Objective', range: 'Score' },
    { name: 'objectiveSuccessStatus', kind: 'datatype', label: 'cmi.objectives.n.success_status', comment: '[RW] .success_status — passed | failed | unknown (RTE §4.2.22.3).', domain: 'Objective', range: 'xsd:string' },
    { name: 'objectiveCompletionStatus', kind: 'datatype', label: 'cmi.objectives.n.completion_status', comment: '[RW] .completion_status — completed | incomplete | not attempted | unknown (RTE §4.2.22.4).', domain: 'Objective', range: 'xsd:string' },
    { name: 'objectiveProgressMeasure', kind: 'datatype', label: 'cmi.objectives.n.progress_measure', comment: '[RW] .progress_measure — progress toward completion (0..1); real(10,7) (RTE §4.2.22.5).', domain: 'Objective', range: 'xsd:decimal' },
    { name: 'objectiveDescription', kind: 'datatype', label: 'cmi.objectives.n.description', comment: '[RW] .description — a brief description of the objective; localized_string_type SPM 250 (RTE §4.2.22.6).', domain: 'Objective', range: 'rdf:langString' },
    // ── Score fields ──
    { name: 'scoreScaled', kind: 'datatype', label: 'score.scaled', comment: '[RW] .score.scaled — a number reflecting performance, normalized to -1..1; real(10,7) (RTE §4.2.26.1).', domain: 'Score', range: 'xsd:decimal' },
    { name: 'scoreRaw', kind: 'datatype', label: 'score.raw', comment: '[RW] .score.raw — the raw score, between min and max; real(10,7) (RTE §4.2.26.2).', domain: 'Score', range: 'xsd:decimal' },
    { name: 'scoreMin', kind: 'datatype', label: 'score.min', comment: '[RW] .score.min — the minimum possible score; real(10,7) (RTE §4.2.26.3).', domain: 'Score', range: 'xsd:decimal' },
    { name: 'scoreMax', kind: 'datatype', label: 'score.max', comment: '[RW] .score.max — the maximum possible score; real(10,7) (RTE §4.2.26.4).', domain: 'Score', range: 'xsd:decimal' },
  ],
  vocabularies: [
    {
      name: 'CompletionStatus', label: 'cmi.completion_status vocabulary', comment: 'Allowed values of cmi.completion_status and cmi.objectives.n.completion_status (RTE §4.2.4).',
      members: [
        { name: 'completed', label: 'completed', comment: 'The learner has completed the SCO.' },
        { name: 'incomplete', label: 'incomplete', comment: 'The learner has not completed the SCO.' },
        { name: 'not attempted', label: 'not attempted', comment: 'The learner has not attempted the SCO.' },
        { name: 'unknown', label: 'unknown', comment: 'Completion status cannot be determined.' },
      ],
    },
    {
      name: 'SuccessStatus', label: 'cmi.success_status vocabulary', comment: 'Allowed values of cmi.success_status and cmi.objectives.n.success_status (RTE §4.2.28).',
      members: [
        { name: 'passed', label: 'passed', comment: 'The learner has mastered the SCO.' },
        { name: 'failed', label: 'failed', comment: 'The learner has not mastered the SCO.' },
        { name: 'unknown', label: 'unknown', comment: 'Success status cannot be determined.' },
      ],
    },
    {
      name: 'Credit', label: 'cmi.credit vocabulary', comment: 'Allowed values of cmi.credit (RTE §4.2.6).',
      members: [
        { name: 'credit', label: 'credit', comment: 'The learner will be credited for performance.' },
        { name: 'no-credit', label: 'no-credit', comment: 'The learner will not be credited for performance.' },
      ],
    },
    {
      name: 'Entry', label: 'cmi.entry vocabulary', comment: "Allowed values of cmi.entry (RTE §4.2.7). '' (empty) indicates an attempt that is neither ab-initio nor resume.",
      members: [
        { name: 'ab-initio', label: 'ab-initio', comment: 'The first time the learner has accessed the SCO in the attempt.' },
        { name: 'resume', label: 'resume', comment: 'The learner is resuming a suspended attempt.' },
        { name: '', label: '(empty)', comment: 'Neither ab-initio nor resume.' },
      ],
    },
    {
      name: 'Exit', label: 'cmi.exit vocabulary', comment: "Allowed values of cmi.exit (RTE §4.2.8). '' (empty) is the default.",
      members: [
        { name: 'time-out', label: 'time-out', comment: 'The SCO ended because max_time_allowed was exceeded.' },
        { name: 'suspend', label: 'suspend', comment: 'The learner suspended the attempt, intending to resume.' },
        { name: 'logout', label: 'logout', comment: 'The learner logged out (treated as suspend in SCORM 2004 4th Ed).' },
        { name: 'normal', label: 'normal', comment: 'The SCO ended normally; the attempt is ended.' },
        { name: '', label: '(empty)', comment: 'No exit condition specified.' },
      ],
    },
    {
      name: 'Mode', label: 'cmi.mode vocabulary', comment: 'Allowed values of cmi.mode (RTE §4.2.19).',
      members: [
        { name: 'browse', label: 'browse', comment: 'The SCO is being browsed (no credit).' },
        { name: 'normal', label: 'normal', comment: 'The SCO is presented for normal credit.' },
        { name: 'review', label: 'review', comment: 'The learner is reviewing a previously experienced SCO.' },
      ],
    },
    {
      name: 'TimeLimitAction', label: 'cmi.time_limit_action vocabulary', comment: 'Allowed values of cmi.time_limit_action (RTE §4.2.30).',
      members: [
        { name: 'exit,message', label: 'exit,message', comment: 'Exit the SCO and display a message when the time limit is exceeded.' },
        { name: 'exit,no message', label: 'exit,no message', comment: 'Exit the SCO without a message when the time limit is exceeded.' },
        { name: 'continue,message', label: 'continue,message', comment: 'Continue the SCO and display a message when the time limit is exceeded.' },
        { name: 'continue,no message', label: 'continue,no message', comment: 'Continue the SCO without a message when the time limit is exceeded.' },
      ],
    },
    {
      name: 'InteractionType', label: 'cmi.interactions.n.type vocabulary', comment: 'Allowed values of cmi.interactions.n.type (RTE §4.2.14.2 / IEEE 1484.11.1).',
      members: [
        { name: 'true-false', label: 'true-false', comment: 'A statement the learner judges true or false.' },
        { name: 'choice', label: 'choice', comment: 'A single- or multiple-choice selection.' },
        { name: 'fill-in', label: 'fill-in', comment: 'One or more short text/number entries.' },
        { name: 'long-fill-in', label: 'long-fill-in', comment: 'A long free-text entry.' },
        { name: 'likert', label: 'likert', comment: 'A selection on a rating scale.' },
        { name: 'matching', label: 'matching', comment: 'Matching source items to target items.' },
        { name: 'performance', label: 'performance', comment: 'A complex task with steps and arbitrary responses.' },
        { name: 'sequencing', label: 'sequencing', comment: 'Ordering a set of items.' },
        { name: 'numeric', label: 'numeric', comment: 'A numeric answer.' },
        { name: 'other', label: 'other', comment: 'Any interaction not otherwise classified.' },
      ],
    },
    {
      name: 'InteractionResult', label: 'cmi.interactions.n.result vocabulary', comment: 'Allowed keyword values of cmi.interactions.n.result; a real(10,7) number is also permitted (RTE §4.2.14.8).',
      members: [
        { name: 'correct', label: 'correct', comment: 'The learner response was correct.' },
        { name: 'incorrect', label: 'incorrect', comment: 'The learner response was incorrect.' },
        { name: 'unanticipated', label: 'unanticipated', comment: 'The learner response was not anticipated.' },
        { name: 'neutral', label: 'neutral', comment: 'The response is recorded but not judged correct/incorrect.' },
      ],
    },
    {
      name: 'AudioCaptioning', label: 'cmi.learner_preference.audio_captioning vocabulary', comment: 'Allowed values of cmi.learner_preference.audio_captioning (RTE §4.2.16.4).',
      members: [
        { name: '-1', label: 'off', comment: 'Captioning is off.' },
        { name: '0', label: 'no change', comment: 'Use the SCO default; no change requested.' },
        { name: '1', label: 'on', comment: 'Captioning is on.' },
      ],
    },
  ],
  shapes: [
    {
      name: 'DataModelShape', targetClass: 'DataModel', label: 'CMI data model conformance',
      comment: 'IEEE 1484.11.1 / RTE §4.2: the enumerated cmi.* scalar elements are constrained to their vocabularies, score.scaled-related real fields are bounded, and suspend_data is at most 64000 characters.',
      constraints: [
        { path: 'completionStatus', maxCount: 1, in: ['completed', 'incomplete', 'not attempted', 'unknown'], comment: 'cmi.completion_status vocabulary (RTE §4.2.4)' },
        { path: 'successStatus', maxCount: 1, in: ['passed', 'failed', 'unknown'], comment: 'cmi.success_status vocabulary (RTE §4.2.28)' },
        { path: 'credit', maxCount: 1, in: ['credit', 'no-credit'], comment: 'cmi.credit vocabulary (RTE §4.2.6)' },
        { path: 'entry', maxCount: 1, in: ['ab-initio', 'resume', ''], comment: 'cmi.entry vocabulary (RTE §4.2.7)' },
        { path: 'exit', maxCount: 1, in: ['time-out', 'suspend', 'logout', 'normal', ''], comment: 'cmi.exit vocabulary (RTE §4.2.8)' },
        { path: 'mode', maxCount: 1, in: ['browse', 'normal', 'review'], comment: 'cmi.mode vocabulary (RTE §4.2.19)' },
        { path: 'timeLimitAction', maxCount: 1, in: ['exit,message', 'exit,no message', 'continue,message', 'continue,no message'], comment: 'cmi.time_limit_action vocabulary (RTE §4.2.30)' },
        { path: 'completionThreshold', maxCount: 1, datatype: 'xsd:decimal', minInclusive: 0, maxInclusive: 1, comment: 'cmi.completion_threshold ∈ [0,1] (RTE §4.2.5)' },
        { path: 'progressMeasure', maxCount: 1, datatype: 'xsd:decimal', minInclusive: 0, maxInclusive: 1, comment: 'cmi.progress_measure ∈ [0,1] (RTE §4.2.23)' },
        { path: 'scaledPassingScore', maxCount: 1, datatype: 'xsd:decimal', minInclusive: -1, maxInclusive: 1, comment: 'cmi.scaled_passing_score ∈ [-1,1] (RTE §4.2.25)' },
        { path: 'sessionTime', maxCount: 1, pattern: DURATION, comment: 'cmi.session_time ISO 8601 timeinterval (RTE §4.2.27)' },
        { path: 'totalTime', maxCount: 1, pattern: DURATION, comment: 'cmi.total_time ISO 8601 timeinterval (RTE §4.2.31)' },
        { path: 'maxTimeAllowed', maxCount: 1, pattern: DURATION, comment: 'cmi.max_time_allowed ISO 8601 timeinterval (RTE §4.2.18)' },
        { path: 'suspendData', maxCount: 1, datatype: 'xsd:string', pattern: `^[\\s\\S]{0,${SUSPEND_DATA_MAX}}$`, comment: `cmi.suspend_data ≤ ${SUSPEND_DATA_MAX} chars SPM in SCORM 2004 4th Ed (RTE §4.2.29)` },
      ],
    },
    {
      name: 'ScoreShape', targetClass: 'Score', label: 'Score conformance',
      comment: 'RTE §4.2.26: score.scaled is a real normalized to [-1,1]; raw/min/max are real(10,7) numbers.',
      constraints: [
        { path: 'scoreScaled', maxCount: 1, datatype: 'xsd:decimal', minInclusive: -1, maxInclusive: 1, comment: 'score.scaled ∈ [-1,1] (RTE §4.2.26.1)' },
        { path: 'scoreRaw', maxCount: 1, datatype: 'xsd:decimal', comment: 'score.raw real(10,7) (RTE §4.2.26.2)' },
        { path: 'scoreMin', maxCount: 1, datatype: 'xsd:decimal', comment: 'score.min real(10,7) (RTE §4.2.26.3)' },
        { path: 'scoreMax', maxCount: 1, datatype: 'xsd:decimal', comment: 'score.max real(10,7) (RTE §4.2.26.4)' },
      ],
    },
    {
      name: 'InteractionShape', targetClass: 'Interaction', label: 'Interaction conformance',
      comment: 'RTE §4.2.14: an interaction MUST have an id and type; type is from the interaction vocabulary; latency is an ISO 8601 timeinterval; timestamp is ISO 8601 second(10,2).',
      constraints: [
        { path: 'interactionId', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'cmi.interactions.n.id required (RTE §4.2.14.1)' },
        { path: 'interactionType', minCount: 1, maxCount: 1, in: ['true-false', 'choice', 'fill-in', 'long-fill-in', 'likert', 'matching', 'performance', 'sequencing', 'numeric', 'other'], comment: 'cmi.interactions.n.type vocabulary (RTE §4.2.14.2)' },
        { path: 'weighting', maxCount: 1, datatype: 'xsd:decimal', comment: 'cmi.interactions.n.weighting real(10,7) (RTE §4.2.14.6)' },
        { path: 'latency', maxCount: 1, pattern: DURATION, comment: 'cmi.interactions.n.latency ISO 8601 timeinterval (RTE §4.2.14.9)' },
        { path: 'interactionTimestamp', maxCount: 1, pattern: TIMESTAMP, comment: 'cmi.interactions.n.timestamp ISO 8601 second(10,2) (RTE §4.2.14.4)' },
        { path: 'interactionDescription', maxCount: 1, comment: 'cmi.interactions.n.description localized_string SPM 250 (RTE §4.2.14.10)' },
      ],
    },
    {
      name: 'ObjectiveShape', targetClass: 'Objective', label: 'Objective conformance',
      comment: 'RTE §4.2.22: an objective MUST have an id; success_status/completion_status are from their vocabularies; progress_measure ∈ [0,1].',
      constraints: [
        { path: 'objectiveId', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'cmi.objectives.n.id required (RTE §4.2.22.1)' },
        { path: 'objectiveSuccessStatus', maxCount: 1, in: ['passed', 'failed', 'unknown'], comment: 'cmi.objectives.n.success_status vocabulary (RTE §4.2.22.3)' },
        { path: 'objectiveCompletionStatus', maxCount: 1, in: ['completed', 'incomplete', 'not attempted', 'unknown'], comment: 'cmi.objectives.n.completion_status vocabulary (RTE §4.2.22.4)' },
        { path: 'objectiveProgressMeasure', maxCount: 1, datatype: 'xsd:decimal', minInclusive: 0, maxInclusive: 1, comment: 'cmi.objectives.n.progress_measure ∈ [0,1] (RTE §4.2.22.5)' },
      ],
    },
    {
      name: 'LearnerPreferenceShape', targetClass: 'LearnerPreference', label: 'Learner preference conformance',
      comment: 'RTE §4.2.16: audio_level/delivery_speed are non-negative reals; audio_captioning ∈ {-1,0,1}.',
      constraints: [
        { path: 'audioLevel', maxCount: 1, datatype: 'xsd:decimal', minInclusive: 0, comment: 'audio_level ≥ 0 (RTE §4.2.16.1)' },
        { path: 'deliverySpeed', maxCount: 1, datatype: 'xsd:decimal', minInclusive: 0, comment: 'delivery_speed ≥ 0 (RTE §4.2.16.3)' },
        { path: 'audioCaptioning', maxCount: 1, datatype: 'xsd:integer', minInclusive: -1, maxInclusive: 1, comment: 'audio_captioning ∈ {-1,0,1} (RTE §4.2.16.4)' },
        { path: 'preferenceLanguage', maxCount: 1, datatype: 'xsd:string', pattern: `^[\\s\\S]{0,${SHORT_IDENTIFIER_SPM}}$`, comment: `language SPM ${SHORT_IDENTIFIER_SPM} chars (RTE §4.2.16.2)` },
      ],
    },
    {
      name: 'CommentFromLearnerShape', targetClass: 'CommentFromLearner', label: 'Comment-from-learner conformance',
      comment: 'RTE §4.2.2: a learner comment has a comment text, optional location, and ISO 8601 timestamp.',
      constraints: [
        { path: 'comment', minCount: 1, maxCount: 1, comment: 'comments_from_learner.n.comment required (RTE §4.2.2.1)' },
        { path: 'commentLocation', maxCount: 1, datatype: 'xsd:string', comment: 'comments_from_learner.n.location (RTE §4.2.2.2)' },
        { path: 'commentTimestamp', maxCount: 1, pattern: TIMESTAMP, comment: 'comments_from_learner.n.timestamp ISO 8601 second(10,2) (RTE §4.2.2.3)' },
      ],
    },
    {
      name: 'CommentFromLMSShape', targetClass: 'CommentFromLMS', label: 'Comment-from-LMS conformance',
      comment: 'RTE §4.2.3: an LMS comment has a comment text, optional location, and ISO 8601 timestamp; read-only to the SCO.',
      constraints: [
        { path: 'comment', minCount: 1, maxCount: 1, comment: 'comments_from_lms.n.comment required (RTE §4.2.3.1)' },
        { path: 'commentLocation', maxCount: 1, datatype: 'xsd:string', comment: 'comments_from_lms.n.location (RTE §4.2.3.2)' },
        { path: 'commentTimestamp', maxCount: 1, pattern: TIMESTAMP, comment: 'comments_from_lms.n.timestamp ISO 8601 second(10,2) (RTE §4.2.3.3)' },
      ],
    },
    {
      name: 'InteractionObjectiveShape', targetClass: 'InteractionObjective', label: 'Interaction-objective conformance',
      comment: 'RTE §4.2.14.3: an interaction objective MUST have an id.',
      constraints: [
        { path: 'interactionObjectiveId', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'cmi.interactions.n.objectives.m.id required (RTE §4.2.14.3.1)' },
      ],
    },
    {
      name: 'CorrectResponseShape', targetClass: 'CorrectResponse', label: 'Correct-response conformance',
      comment: 'RTE §4.2.14.5: a correct response MUST have a pattern.',
      constraints: [
        { path: 'correctResponsePattern', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'cmi.interactions.n.correct_responses.m.pattern required (RTE §4.2.14.5.1)' },
      ],
    },
  ],
};
