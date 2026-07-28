/**
 * @module profile
 * @description What a wire protocol is, expressed as DATA.
 *
 * This is the contract that makes "could a SECOND agent-interop format be added
 * with data only?" answerable with yes for the card and lifecycle layers. A profile
 * declares four things and contributes no behaviour:
 *
 *   1. `card`      — a field map from the engine's AgentIdentity to the profile's
 *                    document shape (including how capabilities are rendered).
 *   2. `lifecycle` — the profile's own name for each engine state, plus which of
 *                    its names it will accept inbound.
 *   3. `wire`      — the route table: method + path template per operation.
 *   4. `errors`    — the profile's code/shape for each engine error condition.
 *
 * The honest limit, stated rather than papered over: a profile that reuses an
 * existing transport (HTTP+JSON here) is pure data, but a format needing gRPC, a
 * WebSocket, or a non-JSON encoding needs a transport adapter. A wire binding is
 * code by nature; there is no honest way to make an HTTP listener into data.
 */

import type { ResolvedAffordance } from '@interego/core';
import type { AgentIdentity, Capability, Engagement, EngagementState } from './types.js';

/** The operations the engine can serve. A profile names and routes them. */
export type InteropOperation =
  | 'sendMessage'
  | 'getEngagement'
  | 'listEngagements'
  | 'cancelEngagement';

export interface WireRoute {
  operation: InteropOperation;
  method: 'GET' | 'POST';
  /** Path template relative to the profile's mount base. `{id}` is substituted. */
  path: string;
}

export interface ErrorSpec {
  /** HTTP status to return. */
  status: number;
  /**
   * The profile's own error code. A protocol modelled on google.rpc carries the
   * NUMERIC canonical code (its clients parse this as an integer); others use their
   * own string token. Typed as the union rather than coerced, because which one is
   * correct is the profile's business, not the mount's.
   */
  code: string | number;
  /** Human-readable default. Never echoes internal detail. */
  message: string;
  /**
   * Extra members merged into the error object verbatim — for envelope formats that
   * require more than code+message (a canonical status name, a machine-readable
   * `details` array, a problem-type URI). The mount copies these without
   * interpreting them, so an error format is declared rather than coded.
   */
  extra?: Record<string, unknown>;
}

/** The engine's error conditions. Every profile must name all of them. */
export type InteropErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'notFound'
  | 'badRequest'
  | 'unsupportedOperation'
  // A protocol version the server does not implement, and a request media type it
  // cannot accept. Separate kinds rather than flavours of badRequest because a
  // protocol binds them to their own status codes and error identities — 415 for
  // the media type, a named version error for the version — and a client is
  // expected to act differently on each.
  | 'unsupportedVersion'
  | 'unsupportedMediaType'
  | 'internal';

export interface CardProjection {
  /** Media type the card is served as. */
  mediaType: string;
  /** The well-known path (absolute, from host root) the card is served at. */
  wellKnownPath: string;
  /** Render the engine's identity into the profile's document shape. Pure: no I/O,
   *  no clock, no randomness — so the same identity always yields the same bytes
   *  and the content hash is a stable version + ETag. */
  render(identity: AgentIdentity): Record<string, unknown>;
  /** Render one capability into the profile's skill/tool shape. Exposed separately
   *  so tests can assert the capability mapping independently of the envelope. */
  renderCapability(capability: Capability): Record<string, unknown>;
}

export interface LifecycleProjection {
  /** Engine state -> the profile's name for it. */
  name(state: EngagementState): string;
  /** The profile's name -> engine state, for inbound values. Unknown -> undefined. */
  parse(name: string): EngagementState | undefined;
}

export interface EngagementProjection {
  /** Render an engagement into the profile's document shape. */
  render(engagement: Engagement, ctx: { serviceUrl: string }): Record<string, unknown>;
  /**
   * The engagement's followable next steps as `iep:Affordance`s — the SUBSTRATE'S
   * OWN hypermedia primitive, not a link shape invented here.
   *
   * This is what makes a representation hypermedia rather than merely
   * resource-shaped: the client follows affordances instead of reconstructing URLs
   * from out-of-band knowledge of the protocol. Reusing `Affordance` means these
   * next steps carry the same `iep:action` / `hydra:target` / method / input-shape
   * contract as every other capability in the substrate, and are renderable by the
   * projections that already exist for it (HyperMarkdown controls, Turtle, the MCP
   * tool schema) rather than needing a new renderer.
   *
   * The set is DERIVED from the engine's own transition table, so it can never
   * advertise a step the engine would refuse, and a terminal engagement offers none.
   */
  affordances(
    engagement: Engagement,
    ctx: { serviceUrl: string; available: ReadonlyArray<'appendTurn' | 'cancel' | 'read'> },
  ): ResolvedAffordance[];
}

/**
 * A route the profile KNOWS ABOUT and deliberately does not implement.
 *
 * There is a real difference between "that URL does not exist" and "that operation
 * exists in this protocol and this agent does not offer it", and a bare 404 tells a
 * client the first when the truth is the second — indistinguishable from a typo.
 * Declaring the refusal is more honest than silence, and it is what the protocol's
 * own error taxonomy is for.
 *
 * The ErrorSpec is INLINE rather than an `InteropErrorKind`, on purpose: a condition
 * only one protocol names (a push-notification family it does not implement) must not
 * become a concept in the shared engine. Declining is data.
 *
 * NOTE this is a refusal, never a stub. Nothing here pretends the capability exists.
 */
export interface DeclinedRoute {
  method: 'GET' | 'POST' | 'DELETE';
  /** Path template relative to the mount base; `{id}` and friends become captures. */
  path: string;
  /** What to answer with. */
  error: ErrorSpec;
}

export interface InteropProfile {
  /** Stable profile id (a dereferenceable URL to its published description). */
  id: string;
  /** Short slug used in mount paths and logs. */
  slug: string;
  /** The protocol version this profile targets, as the protocol spells it. */
  protocolVersion: string;
  /**
   * Whether this profile's conformance has been VERIFIED against the protocol's
   * own test suite. Ships 'unverified' and stays there until the suite is green in
   * CI — the card must carry no conformance claim while this is 'unverified'.
   */
  conformanceStatus: 'unverified' | 'verified';
  /**
   * The request-body member this wire format uses to CONTINUE an existing
   * engagement rather than open a new one (e.g. a task/run id). Declared as data so the
   * spec-blind mount never names a protocol's field; absent means the format has no
   * multi-turn continuation and every send opens a new engagement.
   *
   * Without this the mount always called engine.open(), so a client continuing a
   * conversation silently FORKED it into a second engagement — a correctness bug,
   * not just a conformance gap.
   */
  continuationField?: string;
  /**
   * The body member the request payload nests under, when this format wraps it —
   * a protocol whose request is a schema'd envelope rather than the payload itself.
   * Absent means the body IS the payload.
   *
   * The mount resolves EVERY declared body member through this — content parts and
   * the continuation id alike — so it can never find one at a different level than
   * the other. It previously did exactly that: parts were read from a hardcoded
   * nested member while the continuation id was read from the top level, so a
   * nesting protocol's continuations were invisible and every one silently forked a
   * new engagement.
   */
  requestEnvelope?: string;
  /**
   * Operations this profile declares and this agent does not implement. Registered
   * alongside the wire routes so they answer with the protocol's own error instead
   * of falling through to a generic 404.
   */
  declinedRoutes?: DeclinedRoute[];
  /**
   * Media type for WIRE operation responses (distinct from `card.mediaType`, which
   * types the discovery document). A protocol with its own registered media type
   * declares it here; absent falls back to plain JSON.
   */
  wireMediaType?: string;
  /**
   * Per-operation response ENVELOPE: the member name the rendered engagement is
   * nested under, for operations whose response is a wrapper rather than the
   * resource itself. Absent for an operation means the resource is returned bare.
   *
   * This exists because a single profile can need BOTH shapes. A protocol defined
   * by a protobuf schema will model "returns a task or a message" as a oneof, which
   * has no bare-object JSON encoding — it serialises as `{"task": {...}}` — while
   * the same protocol's GET on the task resource returns the task itself. Rendering
   * one shape for every operation is wrong for one of them either way.
   *
   * Declared as DATA so the engine and the mount stay spec-blind: the mount reads a
   * member name it never interprets, rather than learning that some protocol has a
   * oneof.
   */
  responseEnvelope?: Partial<Record<InteropOperation, string>>;
  /**
   * The request header carrying the protocol version, and the versions this profile
   * will serve. Declared as data so the mount enforces a version contract it never
   * has to name: it compares a header value against a list.
   *
   * A server that silently serves a version it does not implement is worse than one
   * that refuses: the client gets a response shaped by rules it is not following.
   */
  versionHeader?: { name: string; supported: string[] };
  card: CardProjection;
  lifecycle: LifecycleProjection;
  engagement: EngagementProjection;
  wire: WireRoute[];
  errors: Record<InteropErrorKind, ErrorSpec>;
}
