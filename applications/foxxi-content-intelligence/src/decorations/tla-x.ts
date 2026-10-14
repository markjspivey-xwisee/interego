/**
 * TLA-X: ADL's Total Learning Architecture, decorated. Its parts are the architecture's components,
 * each tied to the term in Foxxi's ADL-TLA ontology that models it. Its controls reach each component
 * in a Foxxi deployment. Its proposals say which Foxxi capability enacts each component and tie the
 * components to the I2IDL glossary, listing the ones I2IDL has no term for.
 */
import type { DecorationSpec } from './kit.js';

const TLA = 'https://adlnet.gov/projects/tla/';
const TLA_PROFILE = 'https://w3id.org/xapi/tla';
const I2 = 'https://id.i2idl.org/concepts/';
const T = 'https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#';
const AS_AFFORDANCE = (urn: string): string => `as the affordance ${urn} describes`;
const I2IDL = 'the I2IDL glossary (v0.0.86)';

export const TLA_X: DecorationSpec = {
  id: 'tla-x',
  title: 'TLA-X',
  version: '0.1.0',
  summary: 'ADL\'s Total Learning Architecture, decorated: each component tied to Foxxi\'s ADL-TLA ontology, a control reaching it in a Foxxi deployment, and proposals saying which Foxxi capability enacts it and how it relates to the I2IDL glossary.',
  decorates: {
    name: 'the ADL Total Learning Architecture',
    kind: 'architecture',
    publisher: 'the ADL Initiative',
    specification: { title: 'ADL Total Learning Architecture (TLA), its reference implementation and service definitions', url: TLA },
  },
  parts: [
    { id: 'tla', label: 'Total Learning Architecture', description: 'A reference architecture for learning across systems: shared data about experience, competency, learners and activities, held by services that each do one job.', cites: 'ADL TLA', citeUrl: TLA },
    { id: 'experience-index', label: 'Experience Index', description: 'The view a TLA deployment reads learner experience through, across every record store that holds it.', cites: 'ADL TLA, experience data', citeUrl: TLA, modelledBy: `${T}ExperienceIndex` },
    { id: 'lrs-tiers', label: 'Federated record store tiers', description: 'The record stores experience moves through: from where activity is first captured, to where it is kept as the record of authority.', cites: 'ADL TLA, learner record stores', citeUrl: TLA, modelledBy: `${T}FederatedLRSTier` },
    { id: 'master-object-model', label: 'Master Object Model', description: 'The shared vocabulary TLA components write experience in, published as an xAPI profile.', cites: 'ADL TLA xAPI profile', citeUrl: TLA_PROFILE, modelledBy: `${T}MasterObjectModel` },
    { id: 'competency-management', label: 'Competency management', description: 'The service that keeps competency frameworks and the assertions that learners hold them.', cites: 'ADL TLA, competency data', citeUrl: TLA, modelledBy: `${T}CompetencyManagementService` },
    { id: 'learner-profile', label: 'Learner profile', description: 'What the architecture knows about a learner across systems: their competencies, preferences and history.', cites: 'ADL TLA, learner data', citeUrl: TLA, modelledBy: `${T}LearnerProfile` },
    { id: 'course-catalog', label: 'Enterprise course catalog', description: 'The catalog of learning activities a deployment offers, described so other components can find and sequence them.', cites: 'ADL TLA, activity data', citeUrl: TLA, modelledBy: `${T}EnterpriseCourseCatalog` },
    { id: 'activity-metadata', label: 'Learning activity metadata', description: 'What describes one learning activity to the rest of the architecture.', cites: 'ADL TLA, activity data', citeUrl: TLA, modelledBy: `${T}LearningActivityMetadata` },
    { id: 'learning-event-manager', label: 'Learning event manager', description: 'The role that launches learning activities and keeps track of each session.', cites: 'ADL TLA, launch and session management', citeUrl: TLA, modelledBy: `${T}LearningEventManager` },
    { id: 'learner-state', label: 'Learner state', description: 'Where a learner stands, read from their record: in an activity, in an event, in a career.', cites: 'ADL TLA xAPI profile, learner-state', citeUrl: TLA_PROFILE, modelledBy: `${T}LearnerState` },
  ],
  controls: [
    { id: 'model', part: 'tla', title: 'Read Foxxi\'s model of the TLA', method: 'GET', target: '{+bridge}/ns/adl-tla', accept: 'text/turtle', readOnly: true },
    { id: 'experience-query', part: 'experience-index', title: 'Query statements across several record stores', method: 'POST', target: '{+bridge}/foxxi/query_experience_index', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:query-experience-index'), readOnly: true },
    { id: 'lrs-about', part: 'lrs-tiers', title: 'Read what Foxxi\'s record store supports', method: 'GET', target: '{+bridge}/xapi/about', accept: 'application/json', readOnly: true },
    { id: 'mom-profile', part: 'master-object-model', title: 'Read the TLA xAPI profile', method: 'GET', target: TLA_PROFILE, accept: 'application/ld+json', readOnly: true },
    { id: 'frameworks', part: 'competency-management', title: 'Find competency frameworks across tenant pods', method: 'POST', target: '{+bridge}/foxxi/discover_framework_registry', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:discover-framework-registry'), readOnly: true },
    { id: 'aligned-competency', part: 'competency-management', title: 'Ask whether a held competency satisfies a required one', method: 'POST', target: '{+bridge}/foxxi/resolve_aligned_competency', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:resolve-aligned-competency'), readOnly: true },
    { id: 'profile-assemble', part: 'learner-profile', title: 'Assemble a learner\'s record', method: 'POST', target: '{+bridge}/foxxi/assemble_learner_record', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:assemble-learner-record'), readOnly: true },
    { id: 'courses', part: 'course-catalog', title: 'List the courses this bridge plays', method: 'GET', target: '{+bridge}/agent/scorm/courses', accept: 'application/json', readOnly: true },
    { id: 'catalogs', part: 'course-catalog', title: 'Find course catalogs across pods', method: 'POST', target: '{+bridge}/foxxi/discover_course_catalogs', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:discover-course-catalogs'), readOnly: true },
    { id: 'launch', part: 'learning-event-manager', title: 'Launch a cmi5 activity for yourself', method: 'POST', target: '{+bridge}/agent/cmi5/launch', contentType: 'application/json', auth: AS_AFFORDANCE('urn:iep:action:foxxi:cmi5-launch-signed'), readOnly: false },
  ],
  alignments: [
    { part: 'tla', relation: 'exactMatch', target: `${I2}total-learning-architecture-tla`, targetLabel: 'Total Learning Architecture (TLA)', rationale: 'I2IDL names the same architecture.' },
    { part: 'lrs-tiers', relation: 'relatedMatch', target: `${I2}learning-record-store-lrs`, targetLabel: 'Learning Record Store (LRS)', rationale: 'Each tier is a record store.' },
    { part: 'master-object-model', relation: 'relatedMatch', target: `${I2}xapi-profile`, targetLabel: 'xAPI Profile', rationale: 'The model is published as an xAPI profile.' },
    { part: 'competency-management', relation: 'relatedMatch', target: `${I2}competency`, targetLabel: 'Competency', rationale: 'What the service keeps.' },
    { part: 'learner-profile', relation: 'relatedMatch', target: `${I2}learner-model`, targetLabel: 'Learner model', rationale: 'Both describe a learner to the systems that adapt to them; a learner model is narrower, an inference for one system.' },
    { part: 'activity-metadata', relation: 'relatedMatch', target: `${I2}activity-definition`, targetLabel: 'Activity Definition', rationale: 'An xAPI activity definition is one form of an activity\'s metadata.' },
  ],
  enactments: [
    { part: 'experience-index', action: 'urn:iep:action:foxxi:query-experience-index', role: 'realizes', rationale: 'Federates one statement query across several record stores.' },
    { part: 'lrs-tiers', action: 'urn:iep:action:foxxi:discover-lrs', role: 'realizes', rationale: 'Foxxi\'s record store, found by its about resource.' },
    { part: 'lrs-tiers', action: 'urn:iep:action:foxxi:set-forwarding-targets-signed', role: 'operationalizes', rationale: 'Forwards statements on to the next store.' },
    { part: 'competency-management', action: 'urn:iep:action:foxxi:push-to-cass', role: 'implements', rationale: 'Pushes the tenant\'s framework to a CaSS server, the competency service ADL\'s reference implementation uses.' },
    { part: 'competency-management', action: 'urn:iep:action:foxxi:discover-framework-registry', role: 'realizes', rationale: 'Finds frameworks across tenant pods.' },
    { part: 'competency-management', action: 'urn:iep:action:foxxi:resolve-aligned-competency', role: 'operationalizes', rationale: 'Decides whether a held competency satisfies a required one through declared alignments.' },
    { part: 'learner-profile', action: 'urn:iep:action:foxxi:assemble-learner-record', role: 'realizes', rationale: 'Assembles the learner\'s record from what the substrate holds.' },
    { part: 'course-catalog', action: 'urn:iep:action:foxxi:discover-course-catalogs', role: 'realizes', rationale: 'Finds course catalogs across pods.' },
    { part: 'course-catalog', action: 'urn:iep:action:foxxi:publish-course-catalog-product', role: 'implements', rationale: 'Publishes the catalog as a federated data product.' },
    { part: 'learning-event-manager', action: 'urn:iep:action:foxxi:cmi5-launch-signed', role: 'realizes', rationale: 'Launches a cmi5 activity and keeps its session.' },
    { part: 'learning-event-manager', action: 'urn:iep:action:foxxi:scorm-launch-signed', role: 'realizes', rationale: 'Launches a SCORM course on the sequencing engine.' },
    { part: 'learner-state', action: 'urn:iep:action:foxxi:review-record', role: 'measures', rationale: 'A learner reads where they stand from their own record.' },
  ],
  gaps: [
    { part: 'experience-index', vocabulary: I2IDL, note: 'It has no term for an experience index.' },
    { part: 'course-catalog', vocabulary: I2IDL, note: 'It has no term for a course catalog.' },
    { part: 'learning-event-manager', vocabulary: I2IDL, note: 'It has no term for the service that launches activities and keeps sessions.' },
  ],
};
