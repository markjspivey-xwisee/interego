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

import type { ResolvedAffordance } from '@interego/core';
import type { AgentIdentity, Capability, Engagement, EngagementState } from '../types.js';
import type { InteropProfile } from '../profile.js';

/**
 * Engine state -> A2A TaskState.
 *
 * These are PROTO ENUM NAMES, not lowercase words. A2A's data model is normatively
 * defined by a protobuf schema, and the HTTP+JSON binding uses proto3's canonical
 * JSON mapping, in which an enum value serialises as its declared name. So the wire
 * value is `TASK_STATE_SUBMITTED`, never `submitted`.
 *
 * The first implementation emitted the lowercase words. It looked right, it read
 * naturally, and every schema-validating test in the protocol's own conformance
 * suite rejected it — one wrong token here failed the whole ListTasks family at
 * once, because every response carrying a task carries a state. Guessing the shape
 * of someone else's data model from how it reads in prose is exactly the mistake
 * running their suite is for.
 */
const TO_A2A: Readonly<Record<EngagementState, string>> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',   // A2A spells it with one 'l'
  rejected: 'TASK_STATE_REJECTED',
};

/**
 * Inbound. Canonical proto names first; the lowercase words are kept as a tolerated
 * alias because proto3 JSON permits them and because a client written against the
 * spec's prose will send them. Postel's law applies inbound only — outbound is
 * strictly canonical.
 */
const FROM_A2A: Readonly<Record<string, EngagementState>> = {
  TASK_STATE_SUBMITTED: 'submitted',
  TASK_STATE_WORKING: 'working',
  TASK_STATE_INPUT_REQUIRED: 'input-required',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'cancelled',
  TASK_STATE_REJECTED: 'rejected',
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
  id: 'https://relay.interego.xwisee.com/ns/eth-8f3b8e939600/a2a',
  slug: 'a2a',
  protocolVersion: '1.0',
  conformanceStatus: 'unverified',
  // A2A continues a task by sending a message that carries its id.
  continuationField: 'taskId',
  // A2A's SendMessageRequest wraps the payload: {message:{role,parts,messageId,taskId}}.
  // taskId lives INSIDE that envelope, not beside it.
  requestEnvelope: 'message',
  // WHERE A CALLER NAMES THE SKILL. Canonical first, and it is the same place
  // `engagement.render` puts it — `Message` is `additionalProperties: false` and
  // carries no `skillId` of its own, so `metadata` is the only member a schema-valid
  // peer can use, precisely as for the closed Task body below.
  //
  // The bare top-level spelling stays accepted because it is what this substrate's own
  // callers have always sent, and dropping it would break them for no gain. It is
  // tolerated inbound only; nothing emits it. See `capabilityFields` for the round-trip
  // failure that made this a declaration instead of a hardcoded member name.
  capabilityFields: ['metadata.skillId', 'skillId'],
  // Left unset — responses are plain `application/json`.
  //
  // This previously declared `application/a2a+json`, and the note here said the
  // conformance suite should settle it rather than a guess. It did, against the
  // guess: HTTP_JSON-SVC-001 requires the response Content-Type to be
  // `application/json` for this binding.
  //
  // Worth recording that the SPECIFICATION ITSELF disagrees with its suite here —
  // the §6 worked examples show `Content-Type: application/a2a+json` on HTTP+JSON
  // exchanges, while the binding's own table says "application/json for requests and
  // responses" and the suite enforces the table. Where a spec contradicts itself, the
  // executable artifact is the one that can be checked, and our published definition
  // of `conformanceStatus` names that suite specifically. Following the prose would
  // mean claiming a conformance the measurement refuses.
  //
  // wireMediaType: undefined,

  // A2A's data model is protobuf, and `SendMessage` returns a ONEOF of task-or-
  // message. A oneof has no bare-object JSON encoding: it serialises as the chosen
  // member, `{"task": {...}}`. `ListTasks` likewise wraps in `tasks`. But GET on the
  // task resource returns the task itself, unwrapped — so this is genuinely
  // per-operation, and returning one shape everywhere is wrong somewhere.
  responseEnvelope: {
    sendMessage: 'task',
    listEngagements: 'tasks',
  },

  // A2A carries its version in a request header, and a server MUST refuse a version
  // it does not implement rather than answer it anyway.
  versionHeader: { name: 'A2A-Version', supported: ['1.0'] },

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
        // REQUIRED card fields, and the conformance suite is right to insist: they
        // are what tells a peer whether it can talk to this agent at all, before it
        // spends a request finding out. Text in, text out — the substrate's parts
        // are text and structured data, and structured data rides as JSON text.
        defaultInputModes: ['text/plain', 'application/json'],
        defaultOutputModes: ['text/plain', 'application/json'],
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
    // Followable next steps as real iep:Affordances. The A2A Task body is
    // normatively fixed by a2a.proto (no invented top-level fields), so these ride
    // as RFC 8288 Link headers rather than in-body — which is how a protocol with a
    // closed body schema is still navigable without violating that schema.
    affordances(e: Engagement, ctx: { serviceUrl: string; available: ReadonlyArray<string> }): ResolvedAffordance[] {
      const base = ctx.serviceUrl.replace(/\/$/, '');
      const out: ResolvedAffordance[] = [{
        action: `${base}/ns/iep/action/relay/get_task`,
        target: `${base}/a2a/v1/tasks/${encodeURIComponent(e.id)}`,
        method: 'GET',
        mediaType: 'application/json',
      } as ResolvedAffordance];
      if (ctx.available.includes('cancel')) {
        out.push({
          action: `${base}/ns/iep/action/relay/cancel_task`,
          target: `${base}/a2a/v1/tasks/${encodeURIComponent(e.id)}:cancel`,
          method: 'POST',
          mediaType: 'application/json',
        } as ResolvedAffordance);
      }
      if (ctx.available.includes('appendTurn')) {
        out.push({
          action: `${base}/ns/iep/action/relay/send_message`,
          target: `${base}/a2a/v1/message:send`,
          method: 'POST',
          mediaType: 'application/json',
        } as ResolvedAffordance);
      }
      return out;
    },
    render(e: Engagement): Record<string, unknown> {
      return {
        id: e.id,
        // A2A groups related tasks under a contextId. When the client supplies none,
        // the server generates one — so it is derived from the engagement rather
        // than minted separately, which keeps it a dereferenceable URL like every
        // other identifier here instead of introducing an opaque handle.
        contextId: `${e.id}/context`,
        status: {
          state: TO_A2A[e.state],
          timestamp: e.updatedAt,
        },
        // Produced results. The protocol calls them artifacts; the engine calls them
        // outputs. Absent (not an empty array) until work has actually run — an empty
        // array would assert "this produced nothing", which is a different claim.
        ...(e.outputs && e.outputs.length ? {
          artifacts: e.outputs.map(o => ({
            artifactId: o.id,
            ...(o.name ? { name: o.name } : {}),
            ...(o.description ? { description: o.description } : {}),
            parts: o.parts.map(renderPart),
          })),
        } : {}),
        history: e.turns.map(t => ({
          messageId: t.foreignId ?? t.id,
          // Proto enum names, as for TaskState above — `ROLE_USER`, not `user`.
          role: t.role === 'requester' ? 'ROLE_USER' : 'ROLE_AGENT',
          parts: t.parts.map(renderPart),
        })),
        // The Task schema is CLOSED (additionalProperties: false), so the capability
        // this engagement invokes cannot ride as a top-level field however natural
        // `skillId` reads. `metadata` is the schema's own extension point, and the
        // value stays a dereferenceable action URL either way.
        //
        // ★ This member MUST agree with `capabilityFields[0]` above, or a peer echoing
        // back what we told it gets ignored — which is exactly what happened while the
        // mount read a hardcoded top-level `skillId`. A mount test asserts the closure.
        ...(e.capability ? { metadata: { skillId: e.capability } } : {}),
      };
    },
  },

  // ── Declared, and deliberately NOT implemented ──────────────────────────────
  //
  // capabilities.streaming and capabilities.pushNotifications are false on the card,
  // and these routes make that answer legible at the URL too. Before this they fell
  // through to a generic 404, which says "no such URL" when the truth is "that
  // operation exists in this protocol and this agent does not offer it" — a client
  // cannot tell that from a typo.
  //
  // NOTHING HERE IS A STUB. Each route refuses, with the protocol's own error for
  // refusing. Implementing streaming or push would mean implementing them.
  declinedRoutes: [
    {
      method: 'POST', path: '/message:stream',
      error: {
        status: 400, code: 400, message: 'Streaming is not supported by this agent.',
        extra: {
          status: 'UNIMPLEMENTED',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'UNSUPPORTED_OPERATION', domain: 'a2a-protocol.org',
          }],
        },
      },
    },
    ...(['POST /tasks/{id}/pushNotificationConfigs',
         'GET /tasks/{id}/pushNotificationConfigs',
         'GET /tasks/{id}/pushNotificationConfigs/{configId}',
         'DELETE /tasks/{id}/pushNotificationConfigs/{configId}'] as const).map(spec => {
      const [method, path] = spec.split(' ') as ['GET' | 'POST' | 'DELETE', string];
      return {
        method, path,
        error: {
          status: 400, code: 400, message: 'Push notifications are not supported by this agent.',
          extra: {
            status: 'UNIMPLEMENTED',
            details: [{
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED', domain: 'a2a-protocol.org',
            }],
          },
        },
      };
    }),
  ],

  wire: [
    { operation: 'sendMessage', method: 'POST', path: '/message:send' },
    { operation: 'getEngagement', method: 'GET', path: '/tasks/{id}' },
    { operation: 'listEngagements', method: 'GET', path: '/tasks' },
    { operation: 'cancelEngagement', method: 'POST', path: '/tasks/{id}:cancel' },
  ],

  // ── Errors, in AIP-193 form ─────────────────────────────────────────────────
  //
  // A2A's error envelope is Google's AIP-193, so `code` is the NUMERIC
  // google.rpc.Code — a client does int(error.code) and gets a TypeError on a
  // string. The first implementation emitted the readable lowercase token
  // ('not_found'), which is the same mistake as the lowercase task states: it reads
  // like the right value and is the wrong wire type.
  //
  // `details` must carry a google.rpc.ErrorInfo identified by its @type URI, and its
  // `domain` is the PROTOCOL'S, not ours. I first set it to the relay host, reasoning
  // that a domain names whoever assigned the reason so a client could tell our
  // NOT_FOUND from another hop's. Sound reasoning, wrong answer: the reason tokens
  // are the protocol's vocabulary, so the namespace that qualifies them is the
  // protocol's too. A per-deployment domain would make identical errors from two
  // conformant servers look like different errors, which is the opposite of what an
  // interop namespace is for.
  // Two SEPARATE vocabularies live in one error, and conflating them is the trap.
  // `status`/`code` are the canonical google.rpc status (NOT_FOUND / 5). `reason` is
  // A2A's OWN error vocabulary (TASK_NOT_FOUND), and only errors the protocol has
  // actually named have one. I first emitted the google.rpc name as the reason,
  // which is well-formed and still wrong: it answers "what class of failure" where
  // the protocol asked "which A2A error".
  //
  // So the ErrorInfo detail is emitted ONLY where a canonical A2A reason exists.
  // Inventing a plausible reason for the others would be worse than omitting it — a
  // client matching on reason would silently mis-handle a token no spec defines.
  errors: (() => {
    const DOMAIN = 'a2a-protocol.org';
    // In AIP-193 `error.code` is the HTTP STATUS CODE, and `error.status` is the
    // canonical google.rpc status NAME. Not the numeric google.rpc code, which is
    // what I assumed — three plausible integers are in play (HTTP status, gRPC
    // code, JSON-RPC code) and only one belongs in this field.
    const e = (status: number, _grpcCode: number, name: string, message: string, reason?: string) => ({
      status,
      code: status,
      message,
      extra: {
        status: name,
        ...(reason ? {
          details: [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason,
            domain: DOMAIN,
          }],
        } : {}),
      },
    });
    return {
      unauthenticated: e(401, 16, 'UNAUTHENTICATED', 'Authentication required.'),
      forbidden: e(403, 7, 'PERMISSION_DENIED', 'Not permitted.'),
      notFound: e(404, 5, 'NOT_FOUND', 'No such task.', 'TASK_NOT_FOUND'),
      badRequest: e(400, 3, 'INVALID_ARGUMENT', 'The request was not valid.'),
      unsupportedVersion: e(400, 12, 'UNIMPLEMENTED', 'Unsupported protocol version.', 'VERSION_NOT_SUPPORTED'),
      unsupportedMediaType: e(415, 3, 'INVALID_ARGUMENT', 'Unsupported content type.', 'CONTENT_TYPE_NOT_SUPPORTED'),
      // 400, not the 501 that reads naturally for "not implemented": A2A binds
      // UnsupportedOperationError to HTTP 400. The status is the protocol's call.
      unsupportedOperation: e(400, 12, 'UNIMPLEMENTED', 'This capability is not implemented.', 'UNSUPPORTED_OPERATION'),
      // Never echoes internal detail — the relay audit's error-leak class.
      internal: e(500, 13, 'INTERNAL', 'Internal error.'),
    };
  })(),
};
