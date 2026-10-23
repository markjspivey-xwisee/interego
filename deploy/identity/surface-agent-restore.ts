/**
 * Per-surface agents the identity server forgot, and agent ids that squat another user's.
 *
 * The relay mints one agent per user per client surface, named `<surface>-<userId>`
 * (`claude-u-pk-f2a9c751075a`, `chatgpt-u-eth-d8da6bf26964`), through ensureSurfaceAgent in
 * server.ts when the person signs in. The identity server holds agents only in memory, and
 * the boot-time rebuild from the pods restores each user plus ONE placeholder agent. Every
 * other surface agent was gone after a restart: `GET /agents/<id>/did.json` answered 404
 * while the relay's OAuth session went on signing as that agent, and a bridge that checks a
 * relay-signed request against the agent's DID document (controller = the person) refused
 * every act from a connector that was already connected.
 *
 * The id itself says whose agent it is, so the server can serve it again on demand: an id
 * that parses as exactly `<surface>-<canonical userId>` for a user the server knows is that
 * user's agent. Only canonical user ids (derive-userid.ts) are trusted here, because only
 * those are a function of a credential; a display alias or a `u-try-` id is not.
 *
 * That convention is only true if nobody else can register an id in it, which
 * `POST /register-agent` used to allow: once the server had forgotten
 * `claude-u-pk-<victim>`, any signed-in caller could register it under their own account, and
 * its DID document then named the caller as controller. registrationSquat refuses that.
 *
 * Pure: no server state, no I/O, so it is tested without starting server.ts.
 */

/** `u-pk-<12 hex>`, `u-eth-<12 hex>`, `u-did-<12 hex>`: the shapes derive-userid.ts produces. */
export const CANONICAL_USER_ID = /^u-(?:pk|eth|did)-[0-9a-f]{12}$/;

// A canonical user id as the last segments of an id, or as the whole id.
const CANONICAL_SUFFIX = /(?:^|-)(u-(?:pk|eth|did)-[0-9a-f]{12})$/;
// A canonical user id anywhere in a slug, on segment boundaries.
const CANONICAL_INSIDE = /(?:^|-)u-(?:pk|eth|did)-[0-9a-f]{12}(?:-|$)/;
// `<surface>-<canonical userId>`. The suffix is anchored, so there is one split at most.
const SURFACE_AGENT_ID = /^([a-z0-9-]+)-(u-(?:pk|eth|did)-[0-9a-f]{12})$/;
// The relay's rule for a slugified client name (surfaceAgentFromClient in
// deploy/mcp-relay/server.ts)...
const RELAY_SLUG = /^[a-z][a-z0-9-]{1,31}$/;
// ...in the form its slugify produces: no empty segment, so no `--` and no trailing `-`.
const SLUG_SEGMENTS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_AGENT_ID_LENGTH = 64;

/**
 * The slugs the relay's SURFACE_PATTERNS give known clients, plus its default
 * (`RELAY_DEFAULT_SURFACE_AGENT`, `mcp-client`). Keep in step with that list.
 */
export const FIXED_SURFACES: ReadonlySet<string> = new Set([
  'claude-code-vscode', 'claude-code', 'claude-desktop', 'claude-mobile', 'claude',
  'chatgpt', 'openai-codex', 'codex', 'openai',
  'cursor', 'windsurf', 'cline', 'zed', 'continue', 'hermes-agent', 'openclaw',
  'mcp-client',
]);

export function isSurfaceSlug(surface: string): boolean {
  return RELAY_SLUG.test(surface) && SLUG_SEGMENTS.test(surface);
}

export interface SurfaceAgentId {
  readonly surface: string;
  readonly userId: string;
  /** One of FIXED_SURFACES, as opposed to a slugified client name. */
  readonly fixed: boolean;
}

/**
 * `<surface>-<userId>` with a relay-shaped surface and a canonical user id, or null. Null
 * too when the surface itself holds a canonical user id (`x-u-pk-<a>-u-pk-<b>`): such an
 * id names two users, and the server does not guess which one it belongs to.
 */
export function parseSurfaceAgentId(agentId: unknown): SurfaceAgentId | null {
  if (typeof agentId !== 'string' || agentId.length > MAX_AGENT_ID_LENGTH) return null;
  const m = SURFACE_AGENT_ID.exec(agentId);
  if (!m) return null;
  const surface = m[1]!;
  const userId = m[2]!;
  if (!isSurfaceSlug(surface) || CANONICAL_INSIDE.test(surface)) return null;
  return { surface, userId, fixed: FIXED_SURFACES.has(surface) };
}

/** The display name ensureSurfaceAgent gives a surface agent: `Claude Code (Alice)`. */
export function surfaceAgentLabel(surface: string, displayName: string): string {
  const label = surface
    .split('-')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
  return `${label} (${displayName})`;
}

/**
 * The canonical user id an agent id would register into when that id is not the caller's
 * own: the id ends in `-<canonical userId>` (or is one) of another user. Null when the
 * caller may register it. Whether that other user exists does not matter: `u-eth-` and
 * `u-did-` ids are derived from public material, so a namespace can be squatted before its
 * owner signs up.
 */
export function registrationSquat(agentId: unknown, callerUserId: string): string | null {
  if (typeof agentId !== 'string') return null;
  const m = CANONICAL_SUFFIX.exec(agentId);
  if (!m) return null;
  return m[1] === callerUserId ? null : m[1]!;
}

export interface RestoreLimits {
  /** Slugified-name agents restored per user by an anonymous lookup. */
  readonly perUser: number;
  /** Slugified-name agents restored by anonymous lookups, all users together. */
  readonly total: number;
}

/**
 * The fixed surfaces cost nothing: at most FIXED_SURFACES.size agents per known user. A
 * slugified client name is any of millions, so an anonymous caller could otherwise mint
 * agents for a known user without end; those are capped, per user and overall.
 */
export const DEFAULT_RESTORE_LIMITS: RestoreLimits = { perUser: 4, total: 1024 };

export type RestoreRefusal =
  | 'not-a-surface-agent'     // no canonical suffix, a malformed or ambiguous surface, too long
  | 'reserved'                // an id the server treats specially (the janitor's test agents)
  | 'unknown-user'            // the user is not known, or was deleted
  | 'token-for-another-user'  // a token names this agent but was issued to someone else
  | 'user-limit'
  | 'total-limit';

export type RestoreDecision =
  | {
    readonly restore: true;
    readonly agentId: string;
    readonly userId: string;
    readonly surface: string;
    /** seedIdentity's name and scope: what ensureSurfaceAgent gives the same agent. */
    readonly name: string;
    readonly scope: 'ReadWrite';
    /** Counts against RestoreLimits. */
    readonly counted: boolean;
  }
  | { readonly restore: false; readonly reason: RestoreRefusal };

export interface RestoreInput {
  /** An agent id the server has no identity for. */
  readonly agentId: unknown;
  /** The server's identity for an id, if any. */
  readonly lookup: (id: string) => { readonly type: string; readonly name: string } | undefined;
  /**
   * Set when a verified token names this agent: the user it was issued to. The server
   * signed that agent id for that user, so the restore is not counted.
   */
  readonly tokenUserId?: string;
  /** Agent ids never restored (server.ts passes the janitor's TEST_AGENT_PATTERN). */
  readonly reserved?: (agentId: string) => boolean;
  readonly restoredFor: (userId: string) => number;
  readonly restoredTotal: number;
  readonly limits?: RestoreLimits;
}

export function decideSurfaceAgentRestore(input: RestoreInput): RestoreDecision {
  const parsed = parseSurfaceAgentId(input.agentId);
  if (!parsed) return { restore: false, reason: 'not-a-surface-agent' };
  const agentId = input.agentId as string;
  if (input.reserved?.(agentId)) return { restore: false, reason: 'reserved' };
  if (input.tokenUserId !== undefined && input.tokenUserId !== parsed.userId) {
    return { restore: false, reason: 'token-for-another-user' };
  }
  const user = input.lookup(parsed.userId);
  if (!user || user.type !== 'user') return { restore: false, reason: 'unknown-user' };
  const counted = input.tokenUserId === undefined && !parsed.fixed;
  if (counted) {
    const limits = input.limits ?? DEFAULT_RESTORE_LIMITS;
    if (input.restoredFor(parsed.userId) >= limits.perUser) return { restore: false, reason: 'user-limit' };
    if (input.restoredTotal >= limits.total) return { restore: false, reason: 'total-limit' };
  }
  return {
    restore: true,
    agentId,
    userId: parsed.userId,
    surface: parsed.surface,
    name: surfaceAgentLabel(parsed.surface, user.name),
    scope: 'ReadWrite',
    counted,
  };
}

/** The counts RestoreLimits are checked against, kept for the life of the process. */
export class SurfaceAgentRestores {
  private readonly perUser = new Map<string, number>();
  private total = 0;

  constructor(private readonly limits: RestoreLimits = DEFAULT_RESTORE_LIMITS) {}

  /** Decide, and count the restore when it is one that counts. The caller seeds the identity. */
  admit(input: Omit<RestoreInput, 'restoredFor' | 'restoredTotal' | 'limits'>): RestoreDecision {
    const decision = decideSurfaceAgentRestore({
      ...input,
      restoredFor: userId => this.perUser.get(userId) ?? 0,
      restoredTotal: this.total,
      limits: this.limits,
    });
    if (decision.restore && decision.counted) {
      this.perUser.set(decision.userId, (this.perUser.get(decision.userId) ?? 0) + 1);
      this.total++;
    }
    return decision;
  }

  /** A deleted user's agents are gone, and so is what they counted. */
  forgetUser(userId: string): void {
    const n = this.perUser.get(userId) ?? 0;
    this.perUser.delete(userId);
    this.total -= n;
  }
}
