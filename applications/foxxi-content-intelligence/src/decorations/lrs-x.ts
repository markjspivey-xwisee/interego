/**
 * LRS-X: any xAPI 2.0 Learning Record Store an organization already runs, decorated. Bound to an
 * instance by its xAPI endpoint, it gives an agent a control for each of the LRS's resources, the
 * headers and credentials each asks for, and proposals tying each resource to the I2IDL glossary,
 * to Foxxi's xAPI ontology and to the Foxxi capabilities that read and write it.
 */
import type { DecorationSpec } from './kit.js';

const XAPI = 'https://opensource.ieee.org/xapi/xapi-base-standard-documentation';
const I2 = 'https://id.i2idl.org/concepts/';
const FX = 'https://foxxi-bridge.interego.xwisee.com/ns/xapi#';
const VERSION_HEADER = { 'X-Experience-API-Version': '2.0.0' } as const;
const AUTH = 'Basic credentials or an OAuth token the LRS issues';
const PRECONDITION = 'Send If-Match with the document\'s ETag to change it, or If-None-Match: * to create it; the LRS refuses a PUT that names neither when the document already exists.';

export const LRS_X: DecorationSpec = {
  id: 'lrs-x',
  title: 'LRS-X',
  version: '0.1.0',
  summary: 'Any xAPI 2.0 Learning Record Store, decorated for agents: a control for each of its resources, bound to the instance by its endpoint, and proposals tying each resource to the I2IDL glossary, to Foxxi\'s xAPI ontology and to the Foxxi capabilities that read and write it.',
  decorates: {
    name: 'an xAPI 2.0 Learning Record Store',
    kind: 'instance',
    publisher: 'the IEEE',
    alsoNotEndorsedBy: 'the vendor of any LRS it is bound to',
    specification: { title: 'IEEE 9274.1.1-2023, Experience API (xAPI) Base Standard', url: XAPI, version: 'xAPI 2.0', rights: 'Apache 2.0' },
    bindings: { endpoint: { description: 'the LRS\'s xAPI endpoint, the base every resource hangs off.', example: 'https://lrs.example.com/xapi' } },
  },
  parts: [
    { id: 'lrs', label: 'Learning Record Store', description: 'The service that receives, keeps and answers for xAPI statements and the documents beside them.', cites: 'xAPI Base Standard, LRS requirements', citeUrl: XAPI },
    { id: 'about', label: 'About resource', identifier: 'about', description: 'What the LRS supports: its xAPI versions and its extensions. The one resource a client may read with no credentials and no version header.', cites: 'xAPI Base Standard, About Resource', citeUrl: XAPI },
    { id: 'statements', label: 'Statement resource', identifier: 'statements', description: 'The statements the LRS keeps: stored, queried and fetched by id. A stored statement never changes; it is withdrawn only by a voiding statement.', cites: 'xAPI Base Standard, Statement Resource', citeUrl: XAPI, modelledBy: `${FX}Statement` },
    { id: 'voided', label: 'Voided statements', identifier: 'voidedStatementId', description: 'A statement another statement voided: fetched only by asking for it as voided, and left out of every other query.', cites: 'xAPI Base Standard, Voided Statements', citeUrl: XAPI },
    { id: 'state', label: 'State resource', identifier: 'activities/state', description: 'Documents an activity keeps for one learner, and optionally one registration: the activity\'s own working space, such as a bookmark.', cites: 'xAPI Base Standard, State Resource', citeUrl: XAPI },
    { id: 'activity-profile', label: 'Activity Profile resource', identifier: 'activities/profile', description: 'Documents about an activity in general, not about any one learner.', cites: 'xAPI Base Standard, Activity Profile Resource', citeUrl: XAPI },
    { id: 'agent-profile', label: 'Agent Profile resource', identifier: 'agents/profile', description: 'Documents about a learner in general, not about any one activity.', cites: 'xAPI Base Standard, Agent Profile Resource', citeUrl: XAPI },
    { id: 'activities', label: 'Activities resource', identifier: 'activities', description: 'The LRS\'s definition of one activity, by its id.', cites: 'xAPI Base Standard, Activities Resource', citeUrl: XAPI, modelledBy: `${FX}ActivityDefinition` },
    { id: 'agents', label: 'Agents resource', identifier: 'agents', description: 'One person as the LRS knows them: every identifier it holds for the agent it is asked about.', cites: 'xAPI Base Standard, Agents Resource', citeUrl: XAPI, modelledBy: `${FX}Agent` },
    { id: 'version-header', label: 'Version header', identifier: 'X-Experience-API-Version', description: 'The header every request but one names the xAPI version in; an LRS refuses a request without it.', cites: 'xAPI Base Standard, Versioning', citeUrl: XAPI },
    { id: 'concurrency', label: 'Concurrency control', identifier: 'ETag', description: 'Documents carry an ETag; a client that changes one says which version it changes, and the LRS refuses a change to a version that is gone.', cites: 'xAPI Base Standard, Concurrency', citeUrl: XAPI },
  ],
  controls: [
    { id: 'about', part: 'about', title: 'Read what the LRS supports', method: 'GET', target: '{+endpoint}/about', accept: 'application/json', readOnly: true, cites: 'About Resource' },
    { id: 'statements-query', part: 'statements', title: 'Query statements', method: 'GET', target: '{+endpoint}/statements{?statementId,agent,verb,activity,registration,related_activities,related_agents,since,until,limit,format,attachments,ascending}', accept: 'application/json', headers: VERSION_HEADER, auth: AUTH, readOnly: true, cites: 'Statement Resource, GET' },
    { id: 'statements-store', part: 'statements', title: 'Store statements', method: 'POST', target: '{+endpoint}/statements', contentType: 'application/json', headers: VERSION_HEADER, auth: AUTH, readOnly: false, cites: 'Statement Resource, POST' },
    { id: 'statement-put', part: 'statements', title: 'Store one statement under the id the caller chose', method: 'PUT', target: '{+endpoint}/statements{?statementId}', required: ['statementId'], contentType: 'application/json', headers: VERSION_HEADER, auth: AUTH, readOnly: false, cites: 'Statement Resource, PUT' },
    { id: 'voided-read', part: 'voided', title: 'Fetch a voided statement', method: 'GET', target: '{+endpoint}/statements{?voidedStatementId,format,attachments}', required: ['voidedStatementId'], accept: 'application/json', headers: VERSION_HEADER, auth: AUTH, readOnly: true, cites: 'Voided Statements' },
    { id: 'state-read', part: 'state', title: 'Read a state document, or list their ids', method: 'GET', target: '{+endpoint}/activities/state{?activityId,agent,registration,stateId,since}', required: ['activityId', 'agent'], headers: VERSION_HEADER, auth: AUTH, readOnly: true, cites: 'State Resource, GET' },
    { id: 'state-put', part: 'state', title: 'Write a state document', method: 'PUT', target: '{+endpoint}/activities/state{?activityId,agent,registration,stateId}', required: ['activityId', 'agent', 'stateId'], headers: VERSION_HEADER, auth: AUTH, readOnly: false, cites: 'State Resource, PUT' },
    { id: 'state-post', part: 'state', title: 'Merge into a JSON state document', method: 'POST', target: '{+endpoint}/activities/state{?activityId,agent,registration,stateId}', required: ['activityId', 'agent', 'stateId'], contentType: 'application/json', headers: VERSION_HEADER, auth: AUTH, readOnly: false, cites: 'State Resource, POST' },
    { id: 'state-delete', part: 'state', title: 'Delete a state document, or all of an activity\'s for a learner', method: 'DELETE', target: '{+endpoint}/activities/state{?activityId,agent,registration,stateId}', required: ['activityId', 'agent'], headers: VERSION_HEADER, auth: AUTH, readOnly: false, cites: 'State Resource, DELETE' },
    { id: 'activity-profile-read', part: 'activity-profile', title: 'Read an activity profile document, or list their ids', method: 'GET', target: '{+endpoint}/activities/profile{?activityId,profileId,since}', required: ['activityId'], headers: VERSION_HEADER, auth: AUTH, readOnly: true, cites: 'Activity Profile Resource, GET' },
    { id: 'activity-profile-put', part: 'activity-profile', title: 'Write an activity profile document', method: 'PUT', target: '{+endpoint}/activities/profile{?activityId,profileId}', required: ['activityId', 'profileId'], headers: VERSION_HEADER, auth: AUTH, note: PRECONDITION, readOnly: false, cites: 'Activity Profile Resource, PUT' },
    { id: 'activity-profile-post', part: 'activity-profile', title: 'Merge into a JSON activity profile document', method: 'POST', target: '{+endpoint}/activities/profile{?activityId,profileId}', required: ['activityId', 'profileId'], contentType: 'application/json', headers: VERSION_HEADER, auth: AUTH, readOnly: false, cites: 'Activity Profile Resource, POST' },
    { id: 'activity-profile-delete', part: 'activity-profile', title: 'Delete an activity profile document', method: 'DELETE', target: '{+endpoint}/activities/profile{?activityId,profileId}', required: ['activityId', 'profileId'], headers: VERSION_HEADER, auth: AUTH, readOnly: false, cites: 'Activity Profile Resource, DELETE' },
    { id: 'agent-profile-read', part: 'agent-profile', title: 'Read an agent profile document, or list their ids', method: 'GET', target: '{+endpoint}/agents/profile{?agent,profileId,since}', required: ['agent'], headers: VERSION_HEADER, auth: AUTH, readOnly: true, cites: 'Agent Profile Resource, GET' },
    { id: 'agent-profile-put', part: 'agent-profile', title: 'Write an agent profile document', method: 'PUT', target: '{+endpoint}/agents/profile{?agent,profileId}', required: ['agent', 'profileId'], headers: VERSION_HEADER, auth: AUTH, note: PRECONDITION, readOnly: false, cites: 'Agent Profile Resource, PUT' },
    { id: 'agent-profile-post', part: 'agent-profile', title: 'Merge into a JSON agent profile document', method: 'POST', target: '{+endpoint}/agents/profile{?agent,profileId}', required: ['agent', 'profileId'], contentType: 'application/json', headers: VERSION_HEADER, auth: AUTH, readOnly: false, cites: 'Agent Profile Resource, POST' },
    { id: 'agent-profile-delete', part: 'agent-profile', title: 'Delete an agent profile document', method: 'DELETE', target: '{+endpoint}/agents/profile{?agent,profileId}', required: ['agent', 'profileId'], headers: VERSION_HEADER, auth: AUTH, readOnly: false, cites: 'Agent Profile Resource, DELETE' },
    { id: 'activities-read', part: 'activities', title: 'Read an activity\'s definition', method: 'GET', target: '{+endpoint}/activities{?activityId}', required: ['activityId'], accept: 'application/json', headers: VERSION_HEADER, auth: AUTH, readOnly: true, cites: 'Activities Resource' },
    { id: 'agents-read', part: 'agents', title: 'Read everything the LRS knows identifies an agent', method: 'GET', target: '{+endpoint}/agents{?agent}', required: ['agent'], accept: 'application/json', headers: VERSION_HEADER, auth: AUTH, readOnly: true, cites: 'Agents Resource' },
  ],
  alignments: [
    { part: 'lrs', relation: 'exactMatch', target: `${I2}learning-record-store-lrs`, targetLabel: 'Learning Record Store (LRS)', rationale: 'The same thing: the store xAPI records are sent to and read from.' },
    { part: 'about', relation: 'exactMatch', target: `${I2}about-resource`, targetLabel: 'About Resource', rationale: 'I2IDL names the same xAPI resource.' },
    { part: 'statements', relation: 'exactMatch', target: `${I2}statement-resource`, targetLabel: 'Statement Resource', rationale: 'I2IDL names the same xAPI resource.' },
    { part: 'statements', relation: 'relatedMatch', target: `${I2}statement-immutability`, targetLabel: 'Statement immutability', rationale: 'The resource keeps statements unchanged once stored.' },
    { part: 'statements', relation: 'closeMatch', target: `${FX}Statement`, targetLabel: 'Statement', rationale: 'The resource holds statements; Foxxi\'s ontology models the statement itself.' },
    { part: 'voided', relation: 'exactMatch', target: `${I2}voided-statement`, targetLabel: 'Voided Statement', rationale: 'The same notion: a statement withdrawn by another.' },
    { part: 'state', relation: 'exactMatch', target: `${I2}state-resource`, targetLabel: 'State Resource', rationale: 'I2IDL names the same xAPI resource.' },
    { part: 'activity-profile', relation: 'exactMatch', target: `${I2}activity-profile-resource`, targetLabel: 'Activity Profile Resource', rationale: 'I2IDL names the same xAPI resource.' },
    { part: 'agent-profile', relation: 'exactMatch', target: `${I2}agent-profile-resource`, targetLabel: 'Agent Profile Resource', rationale: 'I2IDL names the same xAPI resource.' },
    { part: 'activities', relation: 'relatedMatch', target: `${I2}activity-definition`, targetLabel: 'Activity Definition', rationale: 'The resource answers with an activity\'s definition.' },
    { part: 'agents', relation: 'relatedMatch', target: `${I2}xapi-agent`, targetLabel: 'xAPI Agent', rationale: 'The resource answers with what identifies an agent.' },
    { part: 'version-header', relation: 'exactMatch', target: `${I2}x-experience-api-version`, targetLabel: 'X-Experience-API-Version', rationale: 'The same header.' },
    { part: 'concurrency', relation: 'exactMatch', target: `${I2}xapi-concurrency-control`, targetLabel: 'xAPI concurrency control', rationale: 'The same mechanism.' },
  ],
  enactments: [
    { part: 'about', action: 'urn:iep:action:foxxi:discover-lrs', role: 'realizes', rationale: 'Foxxi\'s own LRS answers the about resource, and the affordance reads it.' },
    { part: 'statements', action: 'urn:iep:action:foxxi:read-xapi-statements-signed', role: 'implements', rationale: 'Reads a signed caller\'s own statements from Foxxi\'s LRS.' },
    { part: 'statements', action: 'urn:iep:action:foxxi:write-xapi-statements-signed', role: 'implements', rationale: 'Stores a signed caller\'s own statements in Foxxi\'s LRS.' },
    { part: 'statements', action: 'urn:iep:action:foxxi:set-forwarding-targets-signed', role: 'operationalizes', rationale: 'Forwards a caller\'s statements on to an LRS they already run: how a Foxxi record reaches this one.' },
    { part: 'lrs', action: 'urn:iep:action:foxxi:set-inbound-credentials-signed', role: 'operationalizes', rationale: 'Issues the credentials an LRS or tool uses to forward statements into Foxxi.' },
  ],
};
