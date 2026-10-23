/**
 * Per-surface agents the identity server forgot, and agent ids that squat another user's.
 *
 * The relay mints one agent per user per client surface, named `<surface>-<userId>`
 * (`claude-u-pk-f2a9c751075a`, `chatgpt-u-eth-d8da6bf26964`), through ensureSurfaceAgent in
 * server.ts when the person signs in, and lists it in the person's pod agent registry
 * (`<pod>/agents`). The identity server holds agents only in memory, and the boot-time
 * rebuild from the pods restores each user plus ONE placeholder agent. Every other surface
 * agent was gone after a restart: `GET /agents/<id>/did.json` answered 404 while the relay's
 * OAuth session went on signing as that agent, and a bridge that checks a relay-signed
 * request against the agent's DID document (controller = the person) refused every act from
 * a connector that was already connected.
 *
 * The id says whose agent it would be, and the owner's registry says whether it is one, so
 * the server can serve it again on demand. An id that parses as exactly
 * `<surface>-<canonical userId>` for a user the server knows is restored as that user's
 * agent when either
 *   - that user's pod registry lists it (an anonymous lookup, such as a DID resolution), or
 *   - a token this server signed for that agent id was issued to that user.
 * Only canonical user ids (derive-userid.ts) are trusted here, because only those are a
 * function of a credential; a display alias or a `u-try-` id is not. The agent comes back
 * with the delegation scope that proof records (the registry's `iep:scope`, or the scope the
 * token was signed with), never a broader one: an id of this shape may have been registered
 * through `POST /register-agent` as `ReadOnly`, and `POST /tokens` issues tokens with the
 * scope the identity holds. The registry check is what keeps a caller from inventing
 * agents: the id alone would let anyone restore
 * `windsurf-<alice>` or `send-funds-here-<alice>` for a person who never had one, and every
 * restored agent is listed in that person's WebID profile as an authorized agent.
 *
 * The convention is only true if nobody else can register an id in it, which
 * `POST /register-agent` used to allow: once the server had forgotten
 * `claude-u-pk-<victim>`, any signed-in caller could register it under their own account, and
 * its DID document then named the caller as controller. checkAgentIdForRegistration refuses
 * that, and refuses any id that is not a plain slug, since an array, a trailing newline or a
 * space slipped past a suffix check and made ids that read as someone else's.
 *
 * Pure: no server state and no I/O (the registry read is injected), so it is tested without
 * starting server.ts.
 */

/** `u-pk-<12 hex>`, `u-eth-<12 hex>`, `u-did-<12 hex>`: the shapes derive-userid.ts produces. */
export const CANONICAL_USER_ID = /^u-(?:pk|eth|did)-[0-9a-f]{12}$/;

/**
 * The agent ids `POST /register-agent` accepts: 1 to 64 characters, lowercase letters, digits,
 * `.`, `_` and `-`, starting with a letter or digit. Nothing that a URL parser strips or
 * that a reader cannot see (whitespace, control characters), nothing that needs escaping in
 * a did:web path or in Turtle, and no case variants of a canonical id.
 */
export const AGENT_ID_SYNTAX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// A canonical user id as the last segment of an id (after `-`, `.` or `_`), or as the whole id.
const CANONICAL_SUFFIX = /(?:^|[-._])(u-(?:pk|eth|did)-[0-9a-f]{12})$/;
// A canonical user id anywhere in a slug, on segment boundaries.
const CANONICAL_INSIDE = /(?:^|-)u-(?:pk|eth|did)-[0-9a-f]{12}(?:-|$)/;
// `<surface>-<canonical userId>`. The suffix is anchored, so there is one split at most.
const SURFACE_AGENT_ID = /^([a-z0-9-]+)-(u-(?:pk|eth|did)-[0-9a-f]{12})$/;
// The relay's rule for a slugified client name (surfaceAgentFromClient in
// deploy/mcp-relay/server.ts); its fixed SURFACE_PATTERNS slugs and its `mcp-client` default
// satisfy it too...
const RELAY_SLUG = /^[a-z][a-z0-9-]{1,31}$/;
// ...in the form its slugify produces: no empty segment, so no `--` and no trailing `-`.
const SLUG_SEGMENTS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_AGENT_ID_LENGTH = 64;
// An `iep:agentIdentity` object in a registry document (the deprecated `cg:` prefix too).
const REGISTRY_AGENT_IDENTITY = /(?:iep|cg):agentIdentity\s+<([^<>\s]*)>/g;
// The `iep:scope` of a registry entry, as parseOwnerProfile in @interego/core reads it.
const REGISTRY_SCOPE = /(?:iep|cg):scope\s+(?:iep|cg):(\w+)/;
// A bare agent id in a registry: the relay's legacy short form of the agent's did:web.
const BARE_AGENT_ID = /^[A-Za-z0-9._~-]+$/;

/** The four delegation scopes (DelegationScope in @interego/core). */
export const DELEGATION_SCOPES = ['ReadWrite', 'ReadOnly', 'PublishOnly', 'DiscoverOnly'] as const;
export type DelegationScope = typeof DELEGATION_SCOPES[number];

/**
 * A delegation scope, or the least one for anything else (a missing scope, or one
 * `POST /register-agent` accepted unchecked), as ownerProfileToTurtle falls back.
 */
export function delegationScope(value: unknown): DelegationScope {
  return (DELEGATION_SCOPES as readonly unknown[]).includes(value) ? value as DelegationScope : 'DiscoverOnly';
}

export function isSurfaceSlug(surface: string): boolean {
  return RELAY_SLUG.test(surface) && SLUG_SEGMENTS.test(surface);
}

export interface SurfaceAgentId {
  readonly surface: string;
  readonly userId: string;
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
  return { surface, userId };
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
 * What a WHATWG URL parser keeps of an id written into a URL: it drops tab, LF and CR
 * wherever they are (so a DID document URL built from `cursor-<bob>` plus a newline fetches
 * Bob's agent), and strips C0 controls and spaces at either end of its input.
 */
function asUrlParserSeesIt(id: string): string {
  let kept = '';
  for (const ch of id) if (ch !== '\t' && ch !== '\n' && ch !== '\r') kept += ch;
  let start = 0;
  let end = kept.length;
  while (start < end && kept.charCodeAt(start) <= 0x20) start++;
  while (end > start && kept.charCodeAt(end - 1) <= 0x20) end--;
  return kept.slice(start, end);
}

/**
 * The canonical user id an agent id ends in, as its last segment or as the whole id, when it
 * is not `userId` itself: the id reads as that other user's agent. The id is read as written
 * and as a URL parser sees it, so trailing whitespace does not hide the suffix. Null when
 * the id ends in no canonical id, or in `userId`'s own. Whether that other user exists does
 * not matter: `u-eth-` and `u-did-` ids are derived from public material, so a namespace can
 * be squatted before its owner signs up.
 */
export function foreignCanonicalSuffix(agentId: string, userId: string): string | null {
  for (const form of [agentId, asUrlParserSeesIt(agentId)]) {
    const m = CANONICAL_SUFFIX.exec(form);
    if (m && m[1] !== userId) return m[1]!;
  }
  return null;
}

export type RegistrationCheck =
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly status: 400 | 403; readonly error: string };

/**
 * Whether `callerUserId` may register `agentId`: a string in AGENT_ID_SYNTAX (400 otherwise,
 * whatever the JSON body held: an array, an object, a number), and not ending in another
 * user's canonical id (403). The caller's own `<surface>-<their userId>` passes, and so does
 * any slug without a canonical suffix.
 */
export function checkAgentIdForRegistration(agentId: unknown, callerUserId: string): RegistrationCheck {
  if (typeof agentId !== 'string' || !AGENT_ID_SYNTAX.test(agentId)) {
    return {
      ok: false,
      status: 400,
      error: 'agentId must be a string of 1 to 64 characters from a-z, 0-9, ".", "_" and "-", starting with a letter or digit',
    };
  }
  const squatted = foreignCanonicalSuffix(agentId, callerUserId);
  if (squatted !== null) {
    return {
      ok: false,
      status: 403,
      error: `Agent id '${agentId}' ends in another user's id (${squatted}); register '<name>-${callerUserId}' or an id without a user id suffix`,
    };
  }
  return { ok: true, agentId };
}

/**
 * The agent ids an owner's pod agent registry lists, each with its delegation scope. The
 * registry is the Turtle the relay writes to `<pod>/agents` (ownerProfileToTurtle in
 * @interego/core): one `<#agent-…>` entry per authorized agent, with
 * `iep:agentIdentity <did:web:<identity host>:agents:<id>>` and `iep:scope iep:<scope>`;
 * revoked agents are not written. The entries are split as parseOwnerProfile splits them, so
 * the scope is the one the relay itself reads. `didPrefixes` are the `did:web:<host>:agents:`
 * forms this server mints. A bare id is the relay's legacy short form of the same DID.
 * Anything else (another host's DID, a WebID) is not one of this server's agents and is
 * skipped. A missing or unknown scope reads as the least one, and so does an agent listed
 * twice with different scopes (a registry can hold both forms of one agent).
 */
export function registryAgentScopes(turtle: string, didPrefixes: readonly string[]): Map<string, DelegationScope> {
  const scopes = new Map<string, DelegationScope>();
  for (const entry of turtle.split(/(?=<#agent-)/)) {
    const scope = delegationScope(REGISTRY_SCOPE.exec(entry)?.[1]);
    for (const m of entry.matchAll(REGISTRY_AGENT_IDENTITY)) {
      const value = m[1]!;
      const prefix = didPrefixes.find(p => value.startsWith(p));
      const id = prefix !== undefined ? value.slice(prefix.length) : value;
      if (!BARE_AGENT_ID.test(id)) continue;
      const seen = scopes.get(id);
      scopes.set(id, seen === undefined || seen === scope ? scope : 'DiscoverOnly');
    }
  }
  return scopes;
}

export interface RestoreLimits {
  /** Agents restored per user by anonymous lookups (each one confirmed by the registry). */
  readonly perUser: number;
}

/**
 * Only agents the owner's registry lists are restored anonymously, so a caller can neither
 * invent agents nor spend a user's allowance on made-up slugs; the map grows by at most
 * what it held before the restart. The cap is a backstop for an outsized registry: past it,
 * an agent comes back when a token for it is verified.
 */
export const DEFAULT_RESTORE_LIMITS: RestoreLimits = { perUser: 32 };

export type RestoreRefusal =
  | 'not-a-surface-agent'     // no canonical suffix, a malformed or ambiguous surface, too long
  | 'known'                   // the id is an identity here already (restored meanwhile, say)
  | 'reserved'                // an id the server treats specially (the janitor's test agents)
  | 'unknown-user'            // the user is not known, or was deleted
  | 'token-for-another-user'  // a token names this agent but was issued to someone else
  | 'not-in-registry'         // an anonymous lookup, and the owner's registry does not list it
  | 'user-limit';

export interface RestoreGranted {
  readonly restore: true;
  readonly agentId: string;
  readonly userId: string;
  readonly surface: string;
  /** The name ensureSurfaceAgent gives the same agent. */
  readonly name: string;
  /** The scope the registry lists it with, or the scope of the verified token. */
  readonly scope: DelegationScope;
  /** A verified token issued to the user, or the user's pod registry (counted). */
  readonly confirmedBy: 'token' | 'registry';
}

export type RestoreDecision = RestoreGranted | { readonly restore: false; readonly reason: RestoreRefusal };

export interface RestoreInput {
  /** An agent id the server has no identity for. */
  readonly agentId: unknown;
  /** The server's identity for an id, if any. */
  readonly lookup: (id: string) => { readonly type: string; readonly name: string } | undefined;
  /**
   * Set when a verified token names this agent: the user it was issued to. The server
   * signed that agent id for that user, so the registry is not asked and nothing is counted.
   */
  readonly tokenUserId?: string;
  /** With `tokenUserId`: the scope that token was signed with. */
  readonly tokenScope?: unknown;
  /**
   * For an anonymous lookup: the scope the user's pod agent registry lists this agent with;
   * undefined when it does not list it.
   */
  readonly registryScope?: DelegationScope;
  /** Agent ids never restored (server.ts passes the janitor's TEST_AGENT_PATTERN). */
  readonly reserved?: (agentId: string) => boolean;
  readonly restoredFor: (userId: string) => number;
  readonly limits?: RestoreLimits;
}

export function decideSurfaceAgentRestore(input: RestoreInput): RestoreDecision {
  const parsed = parseSurfaceAgentId(input.agentId);
  if (!parsed) return { restore: false, reason: 'not-a-surface-agent' };
  const agentId = input.agentId as string;
  if (input.lookup(agentId)) return { restore: false, reason: 'known' };
  if (input.reserved?.(agentId)) return { restore: false, reason: 'reserved' };
  if (input.tokenUserId !== undefined && input.tokenUserId !== parsed.userId) {
    return { restore: false, reason: 'token-for-another-user' };
  }
  const user = input.lookup(parsed.userId);
  if (!user || user.type !== 'user') return { restore: false, reason: 'unknown-user' };
  const granted = {
    restore: true,
    agentId,
    userId: parsed.userId,
    surface: parsed.surface,
    name: surfaceAgentLabel(parsed.surface, user.name),
  } as const;
  if (input.tokenUserId !== undefined) return { ...granted, scope: delegationScope(input.tokenScope), confirmedBy: 'token' };
  if (input.registryScope === undefined) return { restore: false, reason: 'not-in-registry' };
  const limits = input.limits ?? DEFAULT_RESTORE_LIMITS;
  if (input.restoredFor(parsed.userId) >= limits.perUser) return { restore: false, reason: 'user-limit' };
  return { ...granted, scope: delegationScope(input.registryScope), confirmedBy: 'registry' };
}

export interface AdmitInput extends Pick<RestoreInput, 'agentId' | 'lookup' | 'tokenUserId' | 'tokenScope' | 'reserved'> {
  /**
   * The scope `userId`'s pod agent registry lists `agentId` with, undefined when it does not
   * list it. Asked only for an anonymous lookup that every other check admits, so a refused
   * id costs no pod read. A throw counts as not listed.
   */
  readonly registryScope: (userId: string, agentId: string) => Promise<DelegationScope | undefined>;
  /**
   * Seeds the identity. Called in the same tick as the decision that admits it, so two
   * lookups racing for one id seed it once (the second is refused as `known`).
   */
  readonly seed: (granted: RestoreGranted) => void;
}

/** Restores, and the counts RestoreLimits are checked against, for the life of the process. */
export class SurfaceAgentRestores {
  private readonly perUser = new Map<string, number>();

  constructor(private readonly limits: RestoreLimits = DEFAULT_RESTORE_LIMITS) {}

  async admit(input: AdmitInput): Promise<RestoreDecision> {
    const decide = (registryScope: DelegationScope | undefined): RestoreDecision => decideSurfaceAgentRestore({
      agentId: input.agentId,
      lookup: input.lookup,
      ...(input.tokenUserId !== undefined ? { tokenUserId: input.tokenUserId, tokenScope: input.tokenScope } : {}),
      ...(input.reserved ? { reserved: input.reserved } : {}),
      ...(registryScope !== undefined ? { registryScope } : {}),
      restoredFor: userId => this.perUser.get(userId) ?? 0,
      limits: this.limits,
    });
    // Everything but the registry first (as though it listed the agent).
    let decision = decide('DiscoverOnly');
    if (decision.restore && decision.confirmedBy === 'registry') {
      const scope = await input.registryScope(decision.userId, decision.agentId).catch(() => undefined);
      // Again, on the map as it is now: the user may have been deleted, or the agent
      // restored by another lookup, while the registry was read.
      decision = decide(scope);
    }
    if (decision.restore) {
      if (decision.confirmedBy === 'registry') {
        this.perUser.set(decision.userId, (this.perUser.get(decision.userId) ?? 0) + 1);
      }
      input.seed(decision);
    }
    return decision;
  }

  /** A deleted user's agents are gone, and so is what they counted. */
  forgetUser(userId: string): void {
    this.perUser.delete(userId);
  }
}
