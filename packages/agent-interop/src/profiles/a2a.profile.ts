/**
 * @module profiles/a2a
 * @description The A2A (Agent2Agent) protocol expressed as PROFILE DATA.
 *
 * This is the ONLY file in the package permitted to name A2A. Everything under
 * `src/` outside `src/profiles/` is spec-blind, and a drift-guard test greps for it.
 * If you find yourself wanting to add an `if (a2a)` to the engine, the mapping
 * belongs here instead.
 *
 * Naming note: A2A is an open standard (Linux Foundation), so it keeps its own
 * name — the house rule against adopting a borrowed framework's name exempts open
 * standards, exactly as it does for W3C/IEEE/ADL vocabularies elsewhere here.
 *
 * CONFORMANCE HONESTY: `conformanceStatus` is 'unverified' and the rendered card
 * carries NO conformance claim. It flips only when the protocol's own test suite
 * (a2a-tck, MUST tier) is green in CI. Increment 1 is deliberately a non-streaming,
 * non-push, HTTP+JSON-only agent: the optional capabilities are declared FALSE and
 * are genuinely absent, which is the conformant way to not implement them.
 */

import type { AgentIdentity, Capability, Engagement, EngagementState } from '../types.js';
import type { InteropProfile } from '../profile.js';

/** Engine state -> A2A TaskState. */
const TO_A2A: Readonly<Record<EngagementState, string>> = {
  submitted: 'submitted',
  working: 'working',
  'input-required': 'input-required',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'canceled',   // A2A spells it with one 'l'
  rejected: 'rejected',
};

const FROM_A2A: Readonly<Record<string, EngagementState>> = {
  submitted: 'submitted',
  working: 'working',
  'input-required': 'input-required',
  completed: 'completed',
  failed: 'failed',
  canceled: 'cancelled',
  cancelled: 'cancelled',  // tolerate the two-'l' spelling inbound
  rejected: 'rejected',
};

/** Engine Part -> A2A Part. The JSON member name is the discriminator (the `kind`
 *  field was removed in A2A v1.0.0), so this emits exactly one member per part. */
function renderPart(p: { kind: string; text?: string; data?: Record<string, unknown>; url?: string; mediaType?: string }): Record<string, unknown> {
  if (p.kind === 'text') return { text: p.text ?? '' };
  if (p.kind === 'data') return { data: p.data ?? {} };
  return { url: p.url ?? '', ...(p.mediaType ? { mediaType: p.mediaType } : {}) };
}

function renderCapability(c: Capability): Record<string, unknown> {
  return {
    // The skill id IS the affordance's dereferenceable action URL — it resolves to
    // the capability's own description through the live /ns/iep/action resolver.
    // No new identifier scheme, and nothing that could be a urn:.
    id: c.id,
    name: c.name,
    description: c.description,
    ...(c.tags && c.tags.length ? { tags: c.tags } : {}),
    ...(c.outputMediaTypes && c.outputMediaTypes.length ? { outputModes: c.outputMediaTypes } : {}),
  };
}

export const A2A_PROFILE: InteropProfile = {
  id: 'https://relay.interego.xwisee.com/ns/maintainer/a2a',
  slug: 'a2a',
  protocolVersion: '1.0',
  conformanceStatus: 'unverified',

  card: {
    mediaType: 'application/json',
    // The IANA-registered well-known path for an A2A Agent Card.
    wellKnownPath: '/.well-known/agent-card.json',
    renderCapability,
    render(identity: AgentIdentity): Record<string, unknown> {
      const base = identity.serviceUrl.replace(/\/$/, '');
      const securitySchemes: Record<string, unknown> = {};
      const security: Array<Record<string, string[]>> = [];
      if (identity.auth?.oauth2) {
        securitySchemes['oauth2'] = {
          type: 'oauth2',
          oauth2MetadataUrl: identity.auth.oauth2.metadataUrl,
          pkceRequired: identity.auth.oauth2.pkceRequired,
        };
        security.push({ oauth2: [] });
      }
      if (identity.auth?.bearer) {
        securitySchemes['bearer'] = { type: 'http', scheme: 'bearer' };
        security.push({ bearer: [] });
      }
      return {
        protocolVersion: '1.0',
        name: identity.name,
        description: identity.description,
        // The agent's OWN version: a content hash of the projected card, so it
        // changes exactly when capability changes and doubles as the ETag.
        version: identity.version ?? '0',
        ...(identity.provider ? { provider: identity.provider } : {}),
        ...(identity.documentationUrl ? { documentationUrl: identity.documentationUrl } : {}),
        // Ordered; first entry is preferred. `tenant` is A2A's own answer to one
        // host serving many agents: an opaque server-defined routing id clients echo.
        supportedInterfaces: [
          {
            url: `${base}/a2a/v1`,
            protocolBinding: 'HTTP+JSON',
            protocolVersion: '1.0',
            ...(identity.tenant ? { tenant: identity.tenant } : {}),
          },
        ],
        // Increment 1 implements none of these, and says so. Per the spec, refusing
        // an undeclared capability is the conformant behaviour — declaring false is
        // honest, not partial.
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        skills: identity.capabilities.map(renderCapability),
        ...(Object.keys(securitySchemes).length ? { securitySchemes, security } : {}),
      };
    },
  },

  lifecycle: {
    name: (s: EngagementState): string => TO_A2A[s],
    parse: (n: string): EngagementState | undefined => FROM_A2A[n],
  },

  engagement: {
    render(e: Engagement): Record<string, unknown> {
      return {
        id: e.id,
        status: {
          state: TO_A2A[e.state],
          timestamp: e.updatedAt,
        },
        history: e.turns.map(t => ({
          messageId: t.foreignId ?? t.id,
          role: t.role === 'requester' ? 'user' : 'agent',
          parts: t.parts.map(renderPart),
        })),
        ...(e.capability ? { skillId: e.capability } : {}),
      };
    },
  },

  wire: [
    { operation: 'sendMessage', method: 'POST', path: '/message:send' },
    { operation: 'getEngagement', method: 'GET', path: '/tasks/{id}' },
    { operation: 'listEngagements', method: 'GET', path: '/tasks' },
    { operation: 'cancelEngagement', method: 'POST', path: '/tasks/{id}:cancel' },
  ],

  errors: {
    unauthenticated: { status: 401, code: 'unauthenticated', message: 'Authentication required.' },
    forbidden: { status: 403, code: 'permission_denied', message: 'Not permitted.' },
    notFound: { status: 404, code: 'not_found', message: 'No such task.' },
    badRequest: { status: 400, code: 'invalid_argument', message: 'The request was not valid.' },
    unsupportedOperation: { status: 501, code: 'unimplemented', message: 'This capability is not implemented.' },
    // Never echoes internal detail — the relay audit's error-leak class.
    internal: { status: 500, code: 'internal', message: 'Internal error.' },
  },
};
