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
  /** The profile's own error code string. */
  code: string;
  /** Human-readable default. Never echoes internal detail. */
  message: string;
}

/** The engine's error conditions. Every profile must name all of them. */
export type InteropErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'notFound'
  | 'badRequest'
  | 'unsupportedOperation'
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
   * engagement rather than open a new one (A2A: `taskId`). Declared as data so the
   * spec-blind mount never names a protocol's field; absent means the format has no
   * multi-turn continuation and every send opens a new engagement.
   *
   * Without this the mount always called engine.open(), so a client continuing a
   * conversation silently FORKED it into a second engagement — a correctness bug,
   * not just a conformance gap.
   */
  continuationField?: string;
  card: CardProjection;
  lifecycle: LifecycleProjection;
  engagement: EngagementProjection;
  wire: WireRoute[];
  errors: Record<InteropErrorKind, ErrorSpec>;
}
