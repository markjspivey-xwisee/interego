/**
 * @module profiles/interego-agents
 * @description A SECOND interop profile — the pre-existing Interego agent-card
 *              shape, expressed as data over the same engine.
 *
 * This exists to make the architecture's central claim falsifiable rather than
 * rhetorical. The claim is: "a second agent-interop format can be added with DATA
 * ONLY, no engine change." A test renders one source model through both profiles
 * and asserts the engine contains no protocol branch. If someone later has to touch
 * `src/` outside `profiles/` to add a third format, that test is where the promise
 * visibly breaks.
 *
 * It is a real shape, not a strawman: it is the descriptive card Interego already
 * serves for an agent (identity + followable affordances + reachability), which is
 * why it maps cleanly without inventing fields.
 */

import type { ResolvedAffordance } from '@interego/core';
import type { AgentIdentity, Capability, Engagement, EngagementState } from '../types.js';
import type { InteropProfile } from '../profile.js';
import { availableOperations } from '../engagement.js';

const NAMES: Readonly<Record<EngagementState, string>> = {
  submitted: 'Requested',
  working: 'InProgress',
  'input-required': 'AwaitingInput',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Withdrawn',
  rejected: 'Declined',
};

const PARSE: Readonly<Record<string, EngagementState>> = Object.fromEntries(
  Object.entries(NAMES).map(([k, v]) => [v, k as EngagementState]),
) as Record<string, EngagementState>;

function renderCapability(c: Capability): Record<string, unknown> {
  // Affordance-shaped rather than skill-shaped: the same capability, projected into
  // the vocabulary this surface already speaks.
  return {
    '@id': c.id,
    '@type': 'iep:Affordance',
    'rdfs:label': c.name,
    'rdfs:comment': c.description,
    ...(c.requiresAuth ? { 'iep:requiresVerifiedCaller': true } : {}),
  };
}

export const INTEREGO_AGENTS_PROFILE: InteropProfile = {
  id: 'https://relay.interego.xwisee.com/ns/maintainer/agent-interop',
  slug: 'interego-agents',
  protocolVersion: '1.0',
  conformanceStatus: 'verified', // our own shape; nothing external to conform to
  continuationField: 'engagementId',

  card: {
    mediaType: 'application/ld+json',
    wellKnownPath: '/.well-known/interego-agents.json',
    renderCapability,
    render(identity: AgentIdentity): Record<string, unknown> {
      return {
        '@context': {
          iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
          rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
        },
        '@id': identity.id,
        '@type': 'iep:Agent',
        'rdfs:label': identity.name,
        'rdfs:comment': identity.description,
        'iep:serviceEndpoint': identity.serviceUrl,
        ...(identity.version ? { 'iep:cardVersion': identity.version } : {}),
        'iep:offers': identity.capabilities.map(renderCapability),
      };
    },
  },

  lifecycle: {
    name: (s: EngagementState): string => NAMES[s],
    parse: (n: string): EngagementState | undefined => PARSE[n],
  },

  engagement: {
    // Our own shape, so the affordances ride IN-BODY as first-class
    // iep:Affordances (the A2A profile must use Link headers instead, because its
    // body schema is normatively closed). Same primitive either way.
    affordances(e: Engagement, ctx: { serviceUrl: string; available: ReadonlyArray<string> }): ResolvedAffordance[] {
      const base = ctx.serviceUrl.replace(/\/$/, '');
      const out: ResolvedAffordance[] = [
        { action: `${base}/ns/iep/action/relay/get_engagement`, target: `${base}/interego-agents/v1/engagements/${encodeURIComponent(e.id)}`, method: 'GET' } as ResolvedAffordance,
      ];
      if (ctx.available.includes('cancel')) {
        out.push({ action: `${base}/ns/iep/action/relay/withdraw_engagement`, target: `${base}/interego-agents/v1/engagements/${encodeURIComponent(e.id)}:withdraw`, method: 'POST' } as ResolvedAffordance);
      }
      if (ctx.available.includes('appendTurn')) {
        out.push({ action: `${base}/ns/iep/action/relay/add_turn`, target: `${base}/interego-agents/v1/engagements`, method: 'POST' } as ResolvedAffordance);
      }
      return out;
    },
    render(e: Engagement, ctx: { serviceUrl: string }): Record<string, unknown> {
      const base = ctx.serviceUrl.replace(/\/$/, '');
      // Derived from the ENGINE's transition table — never a second list here that
      // could drift from what the engine will actually permit.
      const available = availableOperations(e.state);
      return {
        '@id': e.id,
        '@type': 'iep:Engagement',
        'iep:state': NAMES[e.state],
        'iep:updatedAt': e.updatedAt,
        'iep:turn': e.turns.map(t => ({
          '@id': t.id,
          'iep:role': t.role,
          ...(t.attributedTo ? { 'prov:wasAttributedTo': t.attributedTo } : {}),
        })),
        // Followable next steps, in-body — a client navigates rather than
        // reconstructing URLs from knowledge of this profile.
        'iep:affordance': INTEREGO_AGENTS_PROFILE.engagement
          .affordances(e, { serviceUrl: base, available })
          .map(a => ({
            '@type': 'iep:Affordance',
            'iep:action': a.action,
            'hydra:target': a.target,
            'hydra:method': a.method,
          })),
      };
    },
  },

  wire: [
    { operation: 'sendMessage', method: 'POST', path: '/engagements' },
    { operation: 'getEngagement', method: 'GET', path: '/engagements/{id}' },
    { operation: 'listEngagements', method: 'GET', path: '/engagements' },
    { operation: 'cancelEngagement', method: 'POST', path: '/engagements/{id}:withdraw' },
  ],

  errors: {
    unauthenticated: { status: 401, code: 'unauthenticated', message: 'Authentication required.' },
    forbidden: { status: 403, code: 'forbidden', message: 'Not permitted.' },
    notFound: { status: 404, code: 'not_found', message: 'No such engagement.' },
    badRequest: { status: 400, code: 'bad_request', message: 'The request was not valid.' },
    unsupportedOperation: { status: 501, code: 'unimplemented', message: 'Not implemented.' },
    internal: { status: 500, code: 'internal', message: 'Internal error.' },
  },
};
