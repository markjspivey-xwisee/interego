/**
 * What a generic Interego client can do here, declared once. The HTTP routes
 * are the handlers (`externallyRouted`); the manifest is derived, not a second list.
 */
import type { IRI } from '@interego/core';
import type { Affordance } from '../_shared/affordance-mcp/index.js';

const iri = (value: string): IRI => value as IRI;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export const AFFORDANCES: readonly Affordance[] = [
  {
    action: iri('urn:iep:action:cpw:world'), toolName: 'cpw.world', title: 'Read the shared world',
    description: 'Territories, faction standings, pacts, the live feed and the leaderboard. With a guest session, also that consultant.',
    method: 'GET', targetTemplate: '{base}/world', inputs: [], externallyRouted: true, annotations: { ...READ, title: 'Read the shared world' },
  },
  {
    action: iri('urn:iep:action:cpw:join-faction'), toolName: 'cpw.join_faction', title: 'Join a faction',
    description: 'A signed-in guest picks one faction from the pack. Their first agent is a pod identity they consult for, not a unit they command.',
    method: 'POST', targetTemplate: '{base}/faction', externallyRouted: true,
    inputs: [{ name: 'factionId', type: 'string', required: true, description: 'A faction id from the world pack.' }],
    annotations: { ...WRITE, title: 'Join a faction' },
  },
  {
    action: iri('urn:iep:action:cpw:open-mission'), toolName: 'cpw.open_mission', title: 'Open a mission',
    description: 'The agent acts. The response is the statement stream. The cause is not in it.',
    method: 'POST', targetTemplate: '{base}/missions', inputs: [], externallyRouted: true, annotations: { ...WRITE, title: 'Open a mission' },
  },
  {
    action: iri('urn:iep:action:cpw:intervene'), toolName: 'cpw.intervene', title: 'Deploy an intervention',
    description: 'Name a diagnosis and an intervention from the pack. Only an intervention that addresses the cause the pack drew moves the measured score. This route never emits cmi5 passed or completed.',
    method: 'POST', targetTemplate: '{base}/missions/intervene', externallyRouted: true,
    inputs: [
      { name: 'diagnosis', type: 'string', required: true, description: 'The cause id the consultant believes they are looking at.' },
      { name: 'interventionId', type: 'string', required: true, description: 'An intervention id from the pack.' },
    ],
    annotations: { ...WRITE, title: 'Deploy an intervention' },
  },
  {
    action: iri('urn:iep:action:cpw:refresh-gate'), toolName: 'cpw.refresh_gate', title: 'Read a tier gate',
    description: 'Promote only when the LRS already holds passed and completed for this tier\'s course and this guest, sent by the course after review. This route does not write those verbs.',
    method: 'POST', targetTemplate: '{base}/gate/refresh', inputs: [], externallyRouted: true, annotations: { ...WRITE, title: 'Read a tier gate' },
  },
];
