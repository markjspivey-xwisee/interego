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
    description: 'Save a scenario document (title, rubric, personas, scripted replies). A pass-gate is left for a person to review. The seeded sample cannot be replaced. The document is a studio:Scenario record in this process, not a new protocol term.',
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
    description: 'Open a practice session for a learner on a scenario and return the role-play player URL. The learner name is filed as a pseudonym; statements do not carry the name.',
    method: 'POST',
    targetTemplate: '{base}/studio/sessions',
    inputs: [
      { name: 'scenarioKey', type: 'string', required: true, description: 'A scenarioKey from studio.list_scenarios.' },
      { name: 'learner', type: 'string', required: true, description: 'Who is practising, 1 to 80 characters. Stored as a pseudonym.' },
      { name: 'personaId', type: 'string', required: false, description: 'Which persona plays the other person. Defaults to the first.' },
    ],
    annotations: { ...write, title: 'Start a practice session' },
  },
  {
    action: iri('urn:iep:action:studio:score-attempt'),
    toolName: 'studio.score_attempt',
    title: 'Score and coach an attempt',
    description: 'Score a finished scripted session from the replies taken, in order. Returns the provisional or final score, coaching notes for replies that were not the step\'s best, and xAPI statements checked against phone-roleplay profile v3. A pass-gate sends no completed statement.',
    method: 'POST',
    targetTemplate: '{base}/studio/attempts/score',
    inputs: [
      { name: 'sessionId', type: 'string', required: true, description: 'The session id returned by studio.start_session.' },
      { name: 'choices', type: 'array', required: true, itemType: 'object', description: 'One entry per step, in order: { index, said?, confirmed? }. index is the reply taken. said is recognised speech. confirmed is tapped, matched or recognised.' },
    ],
    annotations: { ...write, title: 'Score and coach an attempt' },
  },
  {
    action: iri('urn:iep:action:studio:list-progress'),
    toolName: 'studio.list_progress',
    title: 'List a learner\'s progress',
    description: 'Attempts, pass rate, average score and per-criterion averages for one learner in this process, plus how many coaching notes each recent attempt has. Pass rates on a pass-gate are provisional until a person reviews them.',
    method: 'GET',
    targetTemplate: '{base}/studio/progress',
    inputs: [
      { name: 'learner', type: 'string', required: true, description: 'The same learner name passed to studio.start_session.' },
    ],
    annotations: { ...read, title: 'List a learner\'s progress' },
  },
];
