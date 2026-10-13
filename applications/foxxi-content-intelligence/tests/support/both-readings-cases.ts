/**
 * Instances of the eight Foxxi documents whose JSON is read into RDF through a context generated from
 * the document's model (src/ns/model-context.ts) — SCORM CAM, SN and RTE, cmi5, the AI e-learning
 * profile, SOC 2, the EU AI Act and the NIST AI RMF — each with the verdict its shapes give it: the
 * property shapes it violates, those that warn of it, or that a JSON-LD processor in safe mode refuses
 * to read it at all.
 *
 * Two checks hold these verdicts: each-document-reads-the-same-in-json-and-rdf.test.ts, for the Foxxi
 * validator reading the JSON and the substrate's SHACL processor reading the RDF; and the Foxxi SHACL
 * agreement job (tools/shacl-agreement/, .github/workflows/foxxi-shacl-agreement.yml), for pySHACL
 * reading the same RDF.
 *
 * Each verdict is the one XML Schema 1.1 and SHACL give. Three engines have been seen to depart from
 * them, and no case here turns on those departures: the substrate's processor checks an xsd:dateTime
 * by its pattern alone (it accepts a 13th month) and refuses whitespace in an xsd:anyURI, which XML
 * Schema 1.1 allows; rdflib, under pySHACL, reads a date with no time as an xsd:dateTime at midnight.
 */

type Json = Record<string, unknown>;

/** One instance and its verdict. */
export interface ReadingCase {
  readonly name: string;
  readonly instance: Json;
  /** The property shapes (their local names in the shapes graph) whose violations it draws. */
  readonly violates?: readonly string[];
  /** The property shapes whose warnings it draws. */
  readonly warns?: readonly string[];
  /** Safe mode refuses to read it, for this reason (jsonld's error code). It has no RDF reading; the
   *  validator, reading its JSON, gives `violates`. */
  readonly refused?: string;
}

const en = (text: string) => [{ lang: 'en', text }];
const UUID = 'ec2a3c1b-0a5e-4d3c-9b2a-1f0e9d8c7b6a';
const SPM = 64000;

const MANIFEST: Json = {
  '@type': 'Manifest', id: 'https://example.org/pkg/refunds', identifier: 'com.example.refunds', version: '1.0',
  metadata: { schema: 'ADL SCORM', schemaversion: '2004 4th Edition' },
  organizations: { defaultOrganization: 'org1', organization: [{ identifier: 'org1', title: 'Refunds', item: [{ identifier: 'i1', title: 'Lesson 1', identifierref: 'r1', isvisible: true, completionThreshold: 0.8 }] }] },
  resources: { resource: [{ identifier: 'r1', type: 'webcontent', scormType: 'sco', href: 'https://example.org/pkg/index.html', file: [{ href: 'https://example.org/pkg/index.html' }] }] },
};

export const READING_CASES: Readonly<Record<string, readonly ReadingCase[]>> = {
  'scorm-cam': [
    { name: 'a manifest', instance: MANIFEST },
    {
      name: 'a manifest that declares no type',
      instance: {
        identifier: 'com.example.refunds', metadata: { schema: 'ADL SCORM', schemaversion: '2004 4th Edition' },
        organizations: { organization: [{ identifier: 'org1', title: 'Refunds', item: [{ identifier: 'i1', title: 'Lesson 1' }] }] },
        resources: { resource: [{ identifier: 'r1', type: 'webcontent', scormType: 'asset' }] },
      },
    },
    {
      name: 'a manifest with every part its shapes check',
      instance: {
        '@type': 'Manifest', id: 'https://example.org/pkg/refunds', identifier: 'com.example.refunds', version: '1.0', base: 'https://example.org/pkg/',
        metadata: { schema: 'ADL SCORM', schemaversion: '2004 4th Edition', location: 'https://example.org/pkg/metadata.xml' },
        organizations: {
          defaultOrganization: 'org1',
          organization: [{
            identifier: 'org1', title: 'Refunds', structure: 'hierarchical', sharedDataGlobalToSystem: false,
            item: [{
              identifier: 'i1', title: 'Lesson 1', identifierref: 'r1', isvisible: true, parameters: '?x=1', timeLimitAction: 'continue,no message', dataFromLMS: 'abc',
              completionThreshold: 0.8, completedByMeasure: true, minProgressMeasure: 0.5, progressWeight: 1, position: 1,
              dataMap: [{ targetID: 'https://example.org/shared/notes', readSharedData: true, writeSharedData: false }],
            }],
          }],
        },
        resources: {
          base: 'https://example.org/pkg/',
          resource: [
            { identifier: 'r1', type: 'webcontent', scormType: 'sco', href: 'https://example.org/pkg/index.html', file: [{ href: 'https://example.org/pkg/index.html' }], dependency: [{ identifierref: 'common' }] },
            { identifier: 'common', type: 'webcontent', scormType: 'asset', file: [{ href: 'https://example.org/pkg/common.js', metadata: { location: 'https://example.org/pkg/common.xml' } }] },
          ],
        },
      },
    },
    {
      name: 'a manifest with a wrong schema version, an untitled item, a lesson-type resource and a threshold above 1',
      instance: {
        '@type': 'Manifest', identifier: 'com.example.refunds', metadata: { schema: 'ADL SCORM', schemaversion: '1.2' },
        organizations: { organization: [{ identifier: 'org1', title: 'Refunds', item: [{ identifier: 'i1', completionThreshold: 1.5 }] }] },
        resources: { resource: [{ identifier: 'r1', type: 'webcontent', scormType: 'lesson' }] },
      },
      violates: ['ItemShape-completionThreshold', 'ItemShape-title', 'ManifestShape-metadata-schemaversion', 'ResourceShape-scormType'],
    },
    {
      name: 'an item at position 0, and a null identifier',
      instance: {
        '@type': 'Manifest', identifier: null, metadata: { schema: 'ADL SCORM', schemaversion: 'CAM 1.3' },
        organizations: { organization: [{ identifier: 'o', title: 'O', item: [{ identifier: 'i', title: 'I', position: 0 }] }] }, resources: {},
      },
      violates: ['ItemShape-position', 'ManifestShape-identifier'],
    },
    {
      name: 'a visibility written as a string, and two metadata on a resource',
      instance: {
        '@type': 'Manifest', identifier: 'm', metadata: { schema: 'ADL SCORM', schemaversion: 'CAM 1.3' },
        organizations: { organization: [{ identifier: 'o', title: 'O', item: [{ identifier: 'i', title: 'I', isvisible: 'true' }] }] },
        resources: { resource: [{ identifier: 'r', type: 'webcontent', scormType: 'asset', metadata: [{ location: 'https://example.org/a.xml' }, { location: 'https://example.org/b.xml' }] }] },
      },
      violates: ['ItemShape-isvisible', 'ResourceShape-metadata'],
    },
    { name: 'a manifest with a key SCORM does not define', instance: { ...MANIFEST, lom: { general: 'x' } }, refused: 'invalid property' },
  ],

  'scorm-sn': [
    {
      name: 'sequencing with every part its shapes check',
      instance: {
        type: 'Sequencing', id: 'https://example.org/seq/1', seqID: 's1',
        controlMode: { choice: true, choiceExit: true, flow: true, forwardOnly: false, useCurrentAttemptObjectiveInfo: true, useCurrentAttemptProgressInfo: true },
        sequencingRules: {
          preConditionRule: [{ ruleConditions: { ruleConditionCombination: 'any', ruleCondition: [{ ruleConditionName: 'satisfied', conditionOperator: 'not' }] }, ruleAction: { ruleActionValue: 'skip' } }],
          exitConditionRule: [{ ruleConditions: { ruleCondition: [{ ruleConditionName: 'completed' }] }, ruleAction: { ruleActionValue: 'exit' } }],
          postConditionRule: [{ ruleConditions: { ruleCondition: [{ ruleConditionName: 'objectiveMeasureGreaterThan', measureThreshold: 0.5, referencedObjective: 'https://example.org/obj/1' }] }, ruleAction: { ruleActionValue: 'continue' } }],
        },
        limitConditions: { attemptLimit: 3, attemptAbsoluteDurationLimit: 'PT1H', beginTimeLimit: '2026-10-01T09:00:00Z' },
        auxiliaryResources: { auxiliaryResource: [{ auxiliaryResourceID: 'https://example.org/glossary', purpose: 'glossary' }] },
        rollupRules: {
          rollupObjectiveSatisfied: true, rollupProgressCompletion: true, objectiveMeasureWeight: 1,
          rollupRule: [{ childActivitySet: 'atLeastCount', minimumCount: 2, rollupConditions: { rollupConditionCombination: 'all', rollupCondition: [{ rollupConditionName: 'satisfied', rollupConditionOperator: 'noOp' }] }, rollupActionEl: { rollupActionValue: 'satisfied' } }],
        },
        objectives: {
          primaryObjective: { objectiveID: 'https://example.org/obj/1', satisfiedByMeasure: true, minNormalizedMeasure: 0.8, mapInfo: [{ targetObjectiveID: 'https://example.org/g/1', readSatisfiedStatus: true, writeNormalizedMeasure: false }] },
          objective: [{ objectiveID: 'https://example.org/obj/2' }],
        },
        randomizationControls: { randomizationTiming: 'once', selectCount: 2, reorderChildren: true, selectionTiming: 'once' },
        deliveryControls: { tracked: true, completionSetByContent: false, objectiveSetByContent: false },
        rollupConsiderations: { requiredForSatisfied: 'ifAttempted', measureSatisfactionIfActive: true },
        constrainedChoiceConsiderations: { preventActivation: false, constrainChoice: true },
        adlObjectives: [{ objectiveID: 'https://example.org/obj/1', adlMapInfo: [{ targetObjectiveID: 'https://example.org/g/2', readRawScore: true, writeCompletionStatus: true }] }],
      },
    },
    { name: 'sequencing that declares no type', instance: { controlMode: { flow: true }, deliveryControls: { tracked: false } } },
    { name: 'a sequencing collection', instance: { type: 'SequencingCollection', sequencing: [{ seqID: 'common', controlMode: { flow: true } }] } },
    { name: 'an item\'s presentation, which hides the LMS\'s navigation', instance: { presentation: { navigationInterface: { hideLMSUI: ['previous', 'continue'] } } } },
    {
      name: 'an unknown condition, a pre-condition that exits, a negative limit and an unknown rollup action',
      instance: {
        type: 'Sequencing',
        sequencingRules: { preConditionRule: [{ ruleConditions: { ruleCondition: [{ ruleConditionName: 'done' }] }, ruleAction: { ruleActionValue: 'exit' } }] },
        limitConditions: { attemptLimit: -1 },
        rollupRules: { rollupRule: [{ rollupConditions: { rollupCondition: [{ rollupConditionName: 'satisfied' }] }, rollupActionEl: { rollupActionValue: 'passed' } }] },
      },
      violates: ['LimitConditionsShape-attemptLimit', 'PreConditionRuleActionShape-ruleAction-ruleActionValue', 'RollupActionShape-rollupActionValue', 'RuleConditionShape-ruleConditionName'],
    },
    { name: 'a duration that is not one', instance: { type: 'Sequencing', limitConditions: { attemptAbsoluteDurationLimit: '1 hour' } }, violates: ['LimitConditionsShape-attemptAbsoluteDurationLimit'] },
  ],

  'scorm-rte': [
    {
      name: 'a run-time data model with every part its shapes check',
      instance: {
        type: 'DataModel', completionStatus: 'completed', successStatus: 'passed', credit: 'credit', entry: 'ab-initio', exit: 'normal', mode: 'normal',
        timeLimitAction: 'continue,no message', completionThreshold: 0.8, progressMeasure: 1, scaledPassingScore: 0.7, sessionTime: 'PT12M30.5S', totalTime: 'PT1H', maxTimeAllowed: 'PT2H',
        suspendData: 'bookmark=3', location: 'page-3', launchData: 'mode=a', learnerId: 'learner-7', learnerName: 'Ada', version: '1.0',
        navRequest: 'continue', navRequestValidContinue: 'true', navRequestValidPrevious: 'false',
        navRequestValidChoice: [{ requestTarget: 'sco-2', requestValidity: 'true' }], navRequestValidJump: [{ requestTarget: 'sco-3', requestValidity: 'unknown' }],
        score: { scoreScaled: 0.85, scoreRaw: 85, scoreMin: 0, scoreMax: 100 },
        interactions: [{
          interactionId: 'q1', interactionType: 'choice', weighting: 1, result: 'correct', latency: 'PT5S', interactionTimestamp: '2026-10-01T12:00:00', interactionDescription: { en: 'Pick one' },
          learnerResponse: 'a', interactionObjectives: [{ interactionObjectiveId: 'obj1' }], correctResponses: [{ correctResponsePattern: 'a' }],
        }],
        objectives: [{ objectiveId: 'obj1', objectiveSuccessStatus: 'passed', objectiveCompletionStatus: 'completed', objectiveProgressMeasure: 1, objectiveScore: { scoreScaled: 1 }, objectiveDescription: { en: 'Know the policy' } }],
        commentsFromLearner: [{ comment: { 'en-US': 'Clear' }, commentLocation: 'p2', commentTimestamp: '2026-10-01T12:00:00' }],
        commentsFromLMS: [{ comment: { en: 'Read chapter 2 first' }, commentLocation: 'p1' }],
        learnerPreference: { audioLevel: 1, deliverySpeed: 1, audioCaptioning: 0, preferenceLanguage: 'en-US' },
        sharedData: [{ sharedDataId: 'https://example.org/shared/notes', sharedDataStore: 'n=1' }],
      },
    },
    { name: 'a data model that declares no type', instance: { completionStatus: 'incomplete', score: { scoreScaled: 0.5 } } },
    { name: 'a null status and an empty list of interactions', instance: { type: 'DataModel', completionStatus: null, interactions: [] } },
    {
      name: 'an unknown status, a scaled score above 1, an unknown interaction type and a comment without a language',
      instance: { completionStatus: 'done', score: { scoreScaled: 1.5 }, interactions: [{ interactionId: 'q1', interactionType: 'essay' }], commentsFromLearner: [{ comment: 'Clear' }] },
      violates: ['CommentFromLearnerShape-comment', 'DataModelShape-completionStatus', 'InteractionShape-interactionType', 'ScoreShape-scoreScaled'],
    },
    { name: 'suspend data beyond its smallest permitted maximum', instance: { type: 'DataModel', suspendData: 'x'.repeat(SPM + 1) }, warns: ['DataModelShape-suspendData-SPM'] },
    {
      name: 'a captioning value outside -1..1 and a session time with three decimals',
      instance: { type: 'DataModel', sessionTime: 'PT1.123S', learnerPreference: { audioCaptioning: 2 } },
      violates: ['DataModelShape-sessionTime', 'LearnerPreferenceShape-audioCaptioning'],
    },
    {
      name: 'two scores, a score written as a string and a status written as a boolean',
      instance: { type: 'DataModel', successStatus: true, score: [{ scoreScaled: 0.5 }, { scoreScaled: '0.7' }] },
      violates: ['DataModelShape-score', 'DataModelShape-successStatus', 'ScoreShape-scoreScaled'],
    },
    { name: 'a score typed as an interaction', instance: { type: 'DataModel', score: { type: 'Interaction', scoreScaled: 0.5 } }, violates: ['InteractionShape-interactionId', 'InteractionShape-interactionType'] },
    { name: 'a comment whose language map is empty', instance: { type: 'DataModel', commentsFromLMS: [{ comment: {} }] }, violates: ['CommentFromLMSShape-comment'] },
    { name: 'a comment in a language that is not a language tag', instance: { type: 'DataModel', commentsFromLMS: [{ comment: { 'en_US!': 'x' } }] }, refused: 'invalid @language value', violates: ['CommentFromLMSShape-comment'] },
  ],

  cmi5: [
    {
      name: 'a course structure with every part its shapes check',
      instance: {
        type: 'CourseStructure',
        course: { id: 'https://example.org/course/refunds', title: [{ lang: 'en-US', text: 'Refunds' }], description: [{ lang: 'en-US', text: 'Handling refunds' }] },
        objective: [{ id: 'https://example.org/course/refunds/obj/1', title: en('Explain the policy'), description: en('The learner explains the refund policy') }],
        structure: [
          {
            type: 'Block', id: 'https://example.org/course/refunds/b1', title: en('Basics'), description: en('The basics'), position: 1,
            au: [{ id: 'https://example.org/course/refunds/au1', title: en('Intro'), description: en('Intro'), url: 'https://example.org/au1/index.html', moveOn: 'Completed', entitlementKey: 'abc123', objectives: ['https://example.org/course/refunds/obj/1'] }],
          },
          {
            type: 'AssignableUnit', id: 'https://example.org/course/refunds/au2', title: en('Quiz'), description: en('Quiz'), url: 'au2/index.html',
            masteryScore: 0.8, moveOn: 'Passed', launchMethod: 'OwnWindow', launchParameters: 'mode=quiz', activityType: 'https://w3id.org/xapi/cmi5/activitytype/block', position: 2,
          },
        ],
      },
    },
    {
      name: 'a course structure that declares no type',
      instance: {
        course: { id: 'https://example.org/course/c', title: en('C'), description: en('D') },
        structure: [{ type: 'AssignableUnit', id: 'https://example.org/course/c/au', title: en('AU'), description: en('AU'), url: 'https://example.org/au.html' }],
      },
    },
    {
      name: 'a course without a description, and an AU with a mastery score above 1 and an unknown moveOn',
      instance: {
        type: 'CourseStructure', course: { id: 'https://example.org/course/c', title: en('C') },
        structure: [{ type: 'AssignableUnit', id: 'https://example.org/au', title: en('AU'), description: en('AU'), url: 'https://example.org/au.html', masteryScore: 1.2, moveOn: 'Done' }],
      },
      violates: ['AssignableUnitShape-masteryScore', 'AssignableUnitShape-moveOn', 'CourseShape-description'],
    },
    {
      name: 'a course and an objective named by an IRI the document does not describe',
      instance: {
        type: 'CourseStructure', course: 'https://example.org/course/c',
        structure: [{ type: 'AssignableUnit', id: 'https://example.org/au', title: en('AU'), description: en('AU'), url: 'https://example.org/au.html', objectives: ['https://example.org/obj/9'] }],
      },
      violates: ['CourseShape-description', 'CourseShape-title', 'ObjectiveShape-description', 'ObjectiveShape-title'],
    },
    { name: 'a block at position 0', instance: { type: 'Block', id: 'https://example.org/b', title: en('B'), description: en('B'), position: 0 }, violates: ['BlockShape-position'] },
    {
      name: 'a course that is not a node',
      instance: { type: 'CourseStructure', course: 'not a course', structure: [{ type: 'AssignableUnit', id: 'https://example.org/au', title: en('AU'), description: en('AU'), url: 'https://example.org/au.html' }] },
      refused: 'relative object reference', violates: ['CourseStructureShape-course'],
    },
    {
      name: 'the launch data the Foxxi LMS stages',
      instance: {
        contextTemplate: {
          registration: UUID, contextActivities: { category: [{ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }] },
          extensions: { 'https://w3id.org/xapi/cmi5/context/extensions/sessionid': '6b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a' },
        },
        launchMode: 'Normal', moveOn: 'CompletedOrPassed', masteryScore: 0.8, launchParameters: 'mode=quiz', returnURL: 'https://lms.example.org/return',
        entitlementKey: { courseStructure: 'abc123', alternate: 'xyz' },
      },
    },
    { name: 'launch data that declares its type', instance: { type: 'LaunchData', contextTemplate: { registration: UUID }, launchMode: 'Review', moveOn: 'NotApplicable', entitlementKey: { courseStructure: 'k' } } },
    {
      name: 'launch data with an unknown launch mode and an entitlement key without its course structure key',
      instance: { contextTemplate: { registration: UUID }, launchMode: 'Practice', moveOn: 'Passed', entitlementKey: { alternate: 'x' } },
      violates: ['EntitlementKeyShape-courseStructure', 'LaunchDataShape-launchMode'],
    },
    {
      name: 'a session, with its learner as xAPI writes an Agent',
      instance: {
        type: 'Session', registration: UUID, sessionId: '6b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a', launchMode: 'Normal',
        learner: { objectType: 'Agent', account: { homePage: 'https://lms.example.org', name: 'learner-7' } },
        launchedAU: { id: 'https://example.org/course/refunds/au2', title: en('Quiz'), description: en('Quiz'), url: 'https://example.org/au2/index.html' },
      },
    },
    {
      name: 'a session whose AU has no URL',
      instance: { type: 'Session', registration: UUID, sessionId: 's-1', launchMode: 'Normal', launchedAU: { id: 'https://example.org/au', title: en('AU'), description: en('AU'), entitlementKey: 'abc' } },
      violates: ['AssignableUnitShape-url'],
    },
    { name: 'a session with a registration that is not a UUID', instance: { type: 'Session', registration: '123', sessionId: 's-1' }, violates: ['SessionShape-registration'] },
    { name: 'learner preferences', instance: { type: 'LearnerPreferences', languagePreference: 'en-US,fr', audioPreference: 'on' } },
    { name: 'learner preferences with audio that is loud', instance: { languagePreference: 'en-US', audioPreference: 'loud' }, violates: ['LearnerPreferencesShape-audioPreference'] },
  ],

  'ai-elearning': [
    {
      name: 'the signed record the AI-tutor demo validates',
      instance: { '@type': 'SignedInteractionRecord', signedEnvelope: '{"_signature":"0xabc","_signed_payload":"{}"}', signer: 'did:ethr:0x1234567890abcdef1234567890abcdef12345678', recordedAt: '2026-10-01T12:00:00.000Z' },
    },
    {
      name: 'a record with its model claim, sources and confidence proof',
      instance: {
        type: 'SignedInteractionRecord', id: 'https://example.org/rec/1', signedEnvelope: 'env', signer: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH', recordedAt: '2026-10-01T12:00:00Z', interventionEfficacy: 0.6,
        attestedModel: { modelClaimSigner: 'did:web:gateway.example.org', model: 'claude-opus', provider: 'Anthropic' },
        citedSource: [{ sourceAtom: 'urn:pgsl:atom:abc123' }],
        confidenceProof: { confidenceThreshold: 0.7, assertedConfidence: 0.9, proofVerified: true },
      },
    },
    { name: 'a record that declares no type', instance: { signedEnvelope: 'env', signer: 'did:web:tutor.example.org', recordedAt: '2026-10-01T12:00:00Z' } },
    {
      name: 'a signer that is not a DID, a source that is not an atom and a threshold above 1',
      instance: {
        type: 'SignedInteractionRecord', signedEnvelope: 'env', signer: 'https://tutor.example.org', recordedAt: '2026-10-01T12:00:00Z',
        citedSource: [{ sourceAtom: 'https://example.org/paper.pdf' }], confidenceProof: { confidenceThreshold: 1.5 },
      },
      violates: ['ConfidenceRangeProofShape-confidenceThreshold', 'ContentAddressedSourceShape-sourceAtom', 'SignedInteractionRecordShape-signer'],
    },
    {
      name: 'a model claim with no signer',
      instance: { type: 'SignedInteractionRecord', signedEnvelope: 'env', signer: 'did:web:t.example', recordedAt: '2026-10-01T12:00:00Z', attestedModel: { model: 'claude-opus' } },
      violates: ['AttestedModelClaimShape-modelClaimSigner'],
    },
    {
      name: 'the self-asserted record the demo shows rejected',
      instance: { '@type': 'SignedInteractionRecord', assertedConfidence: 0.9, model: 'claude-opus', sources: ['Roediger & Karpicke (2006)'] },
      refused: 'invalid property',
      violates: ['AttestedModelClaimShape-modelClaimSigner', 'ConfidenceRangeProofShape-confidenceThreshold', 'SignedInteractionRecordShape-recordedAt', 'SignedInteractionRecordShape-signedEnvelope', 'SignedInteractionRecordShape-signer'],
    },
  ],

  soc2: [
    { name: 'an access change', instance: { type: 'AccessChangeEvent', id: 'https://example.org/ev/1', evidences: ['CC6.2', 'CC6.3'], occurredAt: '2026-10-01T12:00:00Z', actingAgent: 'did:web:admin.example.org', signer: '0xabc' } },
    { name: 'an event that declares no type', instance: { id: 'https://example.org/ev/2', evidences: 'CC8.1', occurredAt: '2026-10-01T12:00:00+02:00', actingAgent: 'did:web:ci.example.org', signer: '0xdef' } },
    {
      name: 'an event recorded before actingAgent replaced actor',
      instance: { type: 'DeployEvent', evidences: 'CC8.1', occurredAt: '2026-10-01T12:00:00Z', actor: 'did:web:ci.example.org', signer: '0xdef' },
      violates: ['OperationalEvidenceEventShape-actingAgent'],
    },
    {
      name: 'a key rotation whose time is not a time, and with two signers',
      instance: { type: 'KeyRotationEvent', evidences: 'CC6.1', occurredAt: '1 October 2026', actingAgent: 'did:web:ops.example.org', signer: ['0x1', '0x2'] },
      violates: ['OperationalEvidenceEventShape-occurredAt', 'OperationalEvidenceEventShape-signer'],
    },
    { name: 'an incident that evidences no criterion', instance: { type: 'IncidentEvent', occurredAt: '2026-10-01T12:00:00Z', actingAgent: 'did:web:ops.example.org', signer: '0x1' }, violates: ['OperationalEvidenceEventShape-evidences'] },
    {
      name: 'an acting agent that is not an IRI',
      instance: { type: 'DeployEvent', evidences: 'CC8.1', occurredAt: '2026-10-01T12:00:00Z', actingAgent: 'ci bot', signer: '0x1' },
      refused: 'relative object reference', violates: ['OperationalEvidenceEventShape-actingAgent'],
    },
  ],

  'eu-ai-act': [
    { name: 'a record of an action offered as evidence for Article 12', instance: { id: 'https://example.org/actions/log-retention', conformsToArticle: 'Article12' } },
    { name: 'an obligation with its Article', instance: { type: 'RecordKeeping', id: 'https://example.org/obligations/logs', article: '12' } },
    { name: 'an obligation without its Article', instance: { type: 'HumanOversight', id: 'https://example.org/obligations/oversight' }, violates: ['ObligationConformanceShape-article'] },
    { name: 'an obligation with two Articles, which declares no type', instance: { id: 'https://example.org/obligations/x', article: ['13', '14'] }, violates: ['ObligationConformanceShape-article'] },
  ],

  'nist-rmf': [
    { name: 'a record of an action that addresses GOVERN', instance: { id: 'https://example.org/actions/policy', addressesFunction: 'GOVERN' } },
    { name: 'a function with its id', instance: { type: 'Measure', id: 'https://example.org/functions/measure', functionId: 'MEASURE' } },
    { name: 'a function whose id is not one of the four', instance: { type: 'Govern', id: 'https://example.org/functions/g', functionId: 'GOVERNING' }, violates: ['FunctionEvidenceShape-functionId'] },
    { name: 'a function id with no type, in the wrong case', instance: { id: 'https://example.org/functions/m', functionId: 'Map' }, violates: ['FunctionEvidenceShape-functionId'] },
  ],
};
