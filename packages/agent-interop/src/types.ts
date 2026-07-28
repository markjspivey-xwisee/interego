/**
 * @module types
 * @description The engine's own vocabulary — deliberately SPEC-BLIND.
 *
 * Nothing in this file (or anywhere in `src/` outside `src/profiles/`) may name a
 * wire protocol. The drift guard in tests/agent-interop.test.ts greps this directory
 * for protocol names and fails the build on a hit — including in comments, because a
 * constraint documented only in prose rots. That is the whole point: the substrate
 * gains a general capability, and a protocol is DATA.
 *
 * The domain model is an ENGAGEMENT — a durable, agent-attributed record of work
 * requested of an agent — carrying an ordered list of TURNs, each of which carries
 * ordered PARTs. Protocols that call these Task/Message/Part, or Job/Event/Chunk,
 * or Exchange/Act/Body all project onto the same three nouns; the differences live
 * in a profile's field map and lifecycle table.
 */

/** A single content element of a turn. `kind` is the engine's own discriminator;
 *  a profile maps it to whatever member name its wire format uses. */
export interface Part {
  kind: 'text' | 'data' | 'url';
  /** Present for kind==='text'. */
  text?: string;
  /** Present for kind==='data' — a structured payload. */
  data?: Record<string, unknown>;
  /** Present for kind==='url' — a dereferenceable URL. Raw bytes are written to a
   *  pod resource and referenced here, so inboxes stay small and bytes stay
   *  dereferenceable (everything-is-a-URL). */
  url?: string;
  /** Optional media type for `url` / `data`. */
  mediaType?: string;
}

/** Who produced a turn. Derived from the verified caller — never client-asserted. */
export type TurnRole = 'requester' | 'responder';

export interface Turn {
  /** Dereferenceable URL id. */
  id: string;
  role: TurnRole;
  parts: Part[];
  /** ISO-8601. */
  at: string;
  /** The verified identity this turn is attributed to (a DID or WebID). */
  attributedTo?: string;
  /** A sender-minted opaque id, preserved verbatim for correlation when a wire
   *  protocol requires echoing it. Recorded as an alias of `id`, never used as one. */
  foreignId?: string;
}

/**
 * The engine's lifecycle states. A profile maps these to its own state names and
 * declares which are terminal — it does NOT get to invent new ones, because the
 * engine's transition legality is defined over exactly this set.
 */
export type EngagementState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export const TERMINAL_STATES: ReadonlySet<EngagementState> =
  new Set<EngagementState>(['completed', 'failed', 'cancelled', 'rejected']);

export interface Engagement {
  /** Dereferenceable URL id — never a urn:. */
  id: string;
  state: EngagementState;
  /** The verified identity that opened it. Ownership for every read/mutation. */
  openedBy: string;
  /** The capability (an iep:Affordance action URL) this engagement exercises. */
  capability?: string;
  turns: Turn[];
  createdAt: string;
  updatedAt: string;
  /** Free-form, profile-visible annotations. Never trusted for authorization. */
  meta?: Record<string, unknown>;
}

/** A capability the agent offers, in the engine's terms. Projected FROM an
 *  iep:Affordance — the id is the affordance's dereferenceable action URL. */
export interface Capability {
  /** Dereferenceable action URL. Becomes the wire format's skill/tool id. */
  id: string;
  name: string;
  description: string;
  tags?: string[];
  /** Response media types this capability can produce. */
  outputMediaTypes?: string[];
  /** True when invoking it requires a verified caller. */
  requiresAuth?: boolean;
}

/** Everything a card projection needs, in engine terms. A profile turns this into
 *  its own document shape; the engine never knows what that shape is called. */
export interface AgentIdentity {
  /** Dereferenceable agent id. */
  id: string;
  name: string;
  description: string;
  /** Absolute base URL this agent is served from. */
  serviceUrl: string;
  /** Opaque per-agent routing id, when one host serves many agents. */
  tenant?: string;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  capabilities: Capability[];
  /** Declarative auth description, profile-rendered. */
  auth?: {
    oauth2?: { metadataUrl: string; pkceRequired: boolean };
    bearer?: boolean;
  };
  /** Content-addressed version of the projected card — changes iff capability
   *  changes, and doubles as the ETag. */
  version?: string;
}
