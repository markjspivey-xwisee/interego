/**
 * What an agent can do with the practice studio. The bridge derives the manifest,
 * the MCP tools and the HTTP routes from this list.
 */
import type { IRI } from '@interego/core';
import type { Affordance } from '../_shared/affordance-mcp/index.js';

const iri = (value: string): IRI => value as IRI;
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export const studioAffordances: readonly Affordance[] = [
  {
    action: iri('urn:iep:action:studio:list-scenarios'),
    toolName: 'studio.list_scenarios',
    title: 'List practice scenarios',
    description: 'The scenario library: the seeded phone role-play and any scenario an author has saved in this process. Each entry names its criteria and the URL of the scenario document the player reads.',
    method: 'GET',
    targetTemplate: '{base}/studio/scenarios',
    inputs: [],
    annotations: { ...read, title: 'List practice scenarios' },
  },
  {
    action: iri('urn:iep:action:studio:create-scenario'),
    toolName: 'studio.create_scenario',
    title: 'Create a practice scenario',
    description: 'Save a scenario document (title, rubric, personas, scripted replies). A pass-gate score stays provisional. The seeded sample cannot be replaced. The document is a studio:Scenario record in this process, not a new protocol term.',
    method: 'POST',
    targetTemplate: '{base}/studio/scenarios',
    inputs: [
      { name: 'scenario', type: 'object', required: true, description: 'The scenario document. scenarioKey, title, rubric.criteria and personas are required. An xapi block is added when the document has none, using phone-roleplay profile v3.' },
    ],
    annotations: { ...write, title: 'Create a practice scenario' },
  },
  {
    action: iri('urn:iep:action:studio:start-session'),
    toolName: 'studio.start_session',
    title: 'Start a practice session',
    description: 'Open a practice session for a learner label on a scenario and return the hosted player URL for that persona and the scenario revision stored with the session. The frame is a preview unless a course launches the player; this act does not record the call.',
    method: 'POST',
    targetTemplate: '{base}/studio/sessions',
    inputs: [
      { name: 'scenarioKey', type: 'string', required: true, description: 'A scenarioKey from studio.list_scenarios.' },
      { name: 'learner', type: 'string', required: true, description: 'A label you choose, 1 to 80 characters. Kept in this process as you sent it. Not a keyed pseudonym.' },
      { name: 'personaId', type: 'string', required: false, description: 'Which persona plays the other person. Defaults to the first.' },
    ],
    annotations: { ...write, title: 'Start a practice session' },
  },
  {
    action: iri('urn:iep:action:studio:score-attempt'),
    toolName: 'studio.score_attempt',
    title: 'Score and coach an attempt',
    description: 'Score choice indexes the caller declares, against the scenario revision and persona the session was opened with. This is not a played session and writes no xAPI. actorKind defaults to agent. personaId, when sent, must be the session persona. Returns the scripted score and coaching notes.',
    method: 'POST',
    targetTemplate: '{base}/studio/attempts/score',
    inputs: [
      { name: 'sessionId', type: 'string', required: true, description: 'The session id returned by studio.start_session.' },
      { name: 'actorKind', type: 'string', required: false, description: 'agent or person. Omitted means agent, so a tool call is not stored as a person\'s attempt.', enum: ['agent', 'person'] },
      { name: 'personaId', type: 'string', required: false, description: 'Must be the persona this session was opened with, when sent.' },
      { name: 'choices', type: 'array', required: true, itemType: 'object', description: 'One declared reply per step, in order: { index }. index is the reply the caller says was taken. The player did not report it.' },
    ],
    annotations: { ...write, title: 'Score and coach an attempt' },
  },
  {
    action: iri('urn:iep:action:studio:list-progress'),
    toolName: 'studio.list_progress',
    title: 'List a learner\'s progress',
    description: 'Declared-choice scores for one learner label in this process: attempts, pass rate, average and per-criterion average. These are not the hosted player\'s records and are not reviewed attempts.',
    method: 'GET',
    targetTemplate: '{base}/studio/progress',
    inputs: [
      { name: 'learner', type: 'string', required: true, description: 'The same learner label passed to studio.start_session.' },
    ],
    annotations: { ...read, title: 'List a learner\'s progress' },
  },
];
