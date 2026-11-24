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
    description: 'Save a scenario document (title, rubric, personas, scripted replies). The body is a signed request; the signer is the author, and only that author can replace it. A pass-gate score stays provisional on the player. The seeded sample cannot be replaced. The document is a studio:Scenario record in this process, not a new protocol term.',
    method: 'POST',
    targetTemplate: '{base}/studio/scenarios',
    inputs: [
      { name: '_signed_payload', type: 'string', required: true, description: 'JSON of the request, including scenario, agent_id and timestamp. The signer is the author.' },
      { name: '_signature', type: 'string', required: true, description: 'ECDSA signature over sha256:<hex of the payload>, the same envelope as other Interego acts.' },
      { name: 'scenario', type: 'object', required: true, description: 'Inside the signed payload. scenarioKey, title, rubric.criteria and personas are required. Levels are listed from the lowest value to the highest. An xapi block is added when the document has none, using phone-roleplay profile v3.' },
    ],
    annotations: { ...write, title: 'Create a practice scenario' },
  },
  {
    action: iri('urn:iep:action:studio:start-session'),
    toolName: 'studio.start_session',
    title: 'Start a practice session',
    description: 'Open a cmi5 launch of the hosted player for the signer, who is the learner\'s LMS account. Returns launchUrl. The player writes its own statements to that launch. learnerPlace agent puts actorKind=agent and contextKind=agent-test on the launch, which the player marks and Practice Evidence will not take as a person\'s attempt.',
    method: 'POST',
    targetTemplate: '{base}/studio/sessions',
    inputs: [
      { name: '_signed_payload', type: 'string', required: true, description: 'JSON of the request, including scenarioKey, agent_id and timestamp.' },
      { name: '_signature', type: 'string', required: true, description: 'ECDSA signature over sha256:<hex of the payload>.' },
      { name: 'scenarioKey', type: 'string', required: true, description: 'Inside the signed payload. A scenarioKey from studio.list_scenarios.' },
      { name: 'personaId', type: 'string', required: false, description: 'Inside the signed payload. Which persona plays the other person. Defaults to the first.' },
      { name: 'learnerPlace', type: 'string', required: false, description: 'Inside the signed payload. person or agent. Omitted means person.', enum: ['person', 'agent'] },
    ],
    annotations: { ...write, title: 'Start a practice session' },
  },
  {
    action: iri('urn:iep:action:studio:list-progress'),
    toolName: 'studio.list_progress',
    title: 'Read a launch through Practice Evidence',
    description: 'Read one registration with Practice Evidence\'s readLaunchedCall, the function pev.import_launched_attempt runs on the statements an LRS holds. The signer must be the learner the launch was issued to. The result is that read: the player\'s own lines, times and scores, or the reasons the registration is not a conversation. This act does not write a score and does not store an attempt on the Practice Evidence pod.',
    method: 'POST',
    targetTemplate: '{base}/studio/progress',
    inputs: [
      { name: '_signed_payload', type: 'string', required: true, description: 'JSON of the request, including registration, agent_id and timestamp.' },
      { name: '_signature', type: 'string', required: true, description: 'ECDSA signature over sha256:<hex of the payload>.' },
      { name: 'registration', type: 'string', required: true, description: 'Inside the signed payload. The registration studio.start_session returned.' },
    ],
    annotations: { ...read, title: 'Read a launch through Practice Evidence' },
  },
];
