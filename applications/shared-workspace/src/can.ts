/**
 * `wsp.can` — may this principal do this, here, and if not, why not.
 *
 * ── WHERE AUTHORITY CAN ACTUALLY BE ENFORCED ─────────────────────────────────
 *
 * This is the honest part, and it is the part a comparable design does not have to think
 * about. A one-relay system enforces at WRITE time, because every write goes through the
 * one server: a member without permission is refused, and that is the end of it.
 *
 * Here there is no such chokepoint, and pretending otherwise would be the worst kind of
 * security theatre. **Nothing can stop a person writing to their own pod.** It is their
 * pod. An Observer who wants to put an entry in their own stream will succeed, because the
 * substrate's gate answers a different question — *is this caller the pod's owner* — and
 * the answer is yes.
 *
 * So workspace authority is enforced where it CAN be: at the FOLD. An entry written by a
 * member whose effective capability does not include `append` is not workspace content. It
 * exists, it is theirs, it is at its own URL — and it is not folded in, and the view says
 * why. Membership determines what counts, not what can be typed.
 *
 * That is a real difference in kind, not a weaker version of the same thing:
 *
 *   one relay      unauthorised writes are PREVENTED, and the relay is trusted absolutely
 *   here           unauthorised writes are POSSIBLE but INERT, and nothing must be trusted
 *                  beyond the signatures on the records themselves
 *
 * The second is auditable by anyone who can read the records — including someone who is
 * not a member, has no account, and does not trust us. The first is not auditable at all;
 * it is a promise about a server's behaviour.
 *
 * ── WHY THE CEILING IS THE SUBSTRATE'S OWN DELEGATION ────────────────────────
 *
 * A role never grants: effective capability is `role.permits ∩ delegatedScope`, and the
 * delegated scope is not something this layer invents. It is the scope the substrate's own
 * agent registry records for that agent — the same `ReadWrite` / `PublishOnly` / `ReadOnly`
 * the publish gate consults. Two authorization systems that each hold an opinion will
 * eventually disagree, and the disagreement will be discovered by whoever it lets through.
 */

import { foldRoster, may, explain, type Roster, type RoleProfile, type Capability, type Principal, type DelegatedScope } from './roster.js';
import type { ComposedView, ComposedEntry, ComposableMember } from './compose.js';

export const CAPS = {
  read: 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default#read',
  append: 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default#append',
  grant: 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default#grant',
  revoke: 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default#revoke',
  admit: 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default#admit',
  assign: 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default#assign',
} as const;

/**
 * Translate the substrate's delegation scope into workspace capabilities.
 *
 * ★ The unknown case yields NOTHING, and the default is not negotiable. A scope this layer
 * does not recognise means the substrate is saying something we cannot interpret, and the
 * safe reading of an uninterpretable authorization statement is that it authorises nothing.
 * Defaulting the other way turns every future scope name the substrate adds into a silent
 * grant of everything to everyone holding it.
 */
export function capabilitiesForScope(scope: string | null | undefined): readonly Capability[] {
  switch (scope) {
    case 'ReadWrite':
      // Full participation. Whether they may grant or revoke is still the role's business.
      return [CAPS.read, CAPS.append, CAPS.grant, CAPS.revoke, CAPS.admit, CAPS.assign];
    case 'PublishOnly':
      // May write, may not govern. Maps to contribution without membership administration.
      return [CAPS.read, CAPS.append];
    case 'ReadOnly':
      return [CAPS.read];
    default:
      return [];
  }
}

/** An agent as the substrate's registry records it. */
export interface RegisteredAgent {
  readonly did?: string;
  readonly id?: string;
  readonly scope?: string;
}

/**
 * Build the delegated scopes the roster fold intersects against, from the registry the
 * substrate already publishes for each pod.
 *
 * Where one principal has several agents, the scopes are UNIONED: the person can act
 * through any of them, so their reachable authority is the union of what their agents
 * carry. The narrowing that matters happens per-agent at the point of action, which is
 * what {@link canAct} is for — a Convener acting through a ReadOnly agent is still limited
 * to reading, whatever their other agents could have done.
 */
export function scopesFromRegistry(
  registry: readonly { readonly principal: Principal; readonly agents: readonly RegisteredAgent[] }[],
): readonly DelegatedScope[] {
  return registry.map(({ principal, agents }) => ({
    principal,
    capabilities: [...new Set(agents.flatMap(a => capabilitiesForScope(a.scope)))].sort(),
  }));
}

export interface CanResult {
  readonly allowed: boolean;
  /** A sentence a person can act on. "403" is not one. */
  readonly because: string;
}

/**
 * May this principal, acting through THIS agent, do this?
 *
 * Two ceilings apply and both must hold: the role's, and the acting agent's own delegation.
 * A Convener whose agent holds ReadOnly may not append — and the reason names the agent, so
 * the fix ("use your other agent" / "widen this one") is obvious rather than mysterious.
 */
export function canAct(
  roster: Roster,
  principal: Principal,
  capability: Capability,
  actingAgent?: RegisteredAgent,
): CanResult {
  if (!may(roster, principal, capability)) {
    return { allowed: false, because: explain(roster, principal, capability) };
  }
  if (actingAgent === undefined) {
    return { allowed: true, because: explain(roster, principal, capability) };
  }
  const agentCaps = capabilitiesForScope(actingAgent.scope);
  if (!agentCaps.includes(capability)) {
    const name = actingAgent.did ?? actingAgent.id ?? 'the acting agent';
    return {
      allowed: false,
      because:
        `${principal} may ${capability} in this workspace, but is acting through ${name}, whose `
        + `delegation is ${actingAgent.scope ?? 'unresolved'} and does not carry it. `
        + 'A role is a ceiling on authority the acting agent already had, never a source of it.',
    };
  }
  return { allowed: true, because: explain(roster, principal, capability) };
}

/** Resolve the roster and answer in one step, for callers that hold the raw records. */
export function can(
  args: Parameters<typeof foldRoster>[0] & {
    readonly principal: Principal;
    readonly capability: Capability;
    readonly actingAgent?: RegisteredAgent;
  },
): CanResult {
  return canAct(foldRoster(args), args.principal, args.capability, args.actingAgent);
}

// ── Read-time enforcement ────────────────────────────────────────────────────

export interface AuthorizedView extends ComposedView {
  /**
   * Entries written by a member who may not append here. They exist and are theirs; they
   * are simply not workspace content. Surfaced rather than dropped so the situation is
   * diagnosable — "this member has been writing entries that do not count" is something
   * somebody needs to be told, and probably needs to fix by widening the role.
   */
  readonly disallowed: readonly { readonly entry: ComposedEntry; readonly because: string }[];
}

/**
 * Apply the roster to a composed view.
 *
 * ★ THIS IS THE ENFORCEMENT POINT, and it is at READ time on purpose. In a federated
 * design nothing prevents a member writing to their own pod — so an entry from someone
 * without `append` is not blocked, it is not counted. The distinction matters: the entry
 * remains at its own URL, signed by its author, and anyone can see both that it was written
 * and that the workspace does not admit it.
 *
 * The alternative — filtering silently — would make an unauthorised writer invisible to the
 * people who need to know about them.
 */
export function authorizeView(
  view: ComposedView,
  roster: Roster,
  capability: Capability = CAPS.append,
): AuthorizedView {
  const allowed: ComposedEntry[] = [];
  const disallowed: { entry: ComposedEntry; because: string }[] = [];

  for (const entry of view.entries) {
    if (may(roster, entry.principal, capability)) allowed.push(entry);
    else disallowed.push({ entry, because: explain(roster, entry.principal, capability) });
  }

  return {
    ...view,
    entries: allowed,
    disallowed,
    // `complete` stays about REACHABILITY, not authority. An entry excluded because its
    // author may not append is not a gap in the view — it is the view working. Folding the
    // two together would make a correctly-governed workspace permanently report itself
    // as incomplete, and a flag that is always false is a flag nobody reads.
    complete: view.complete,
  };
}

/**
 * The members a composed view should be built from.
 *
 * Called before the fan-out so an Observer's pod is not even read. Not a security control —
 * the view would exclude their entries anyway — but reading N pods to discard one of them
 * is a real cost in a design whose catch-up is already one request per member.
 */
export function readableMembers(
  roster: Roster,
  members: readonly ComposableMember[],
  capability: Capability = CAPS.append,
): readonly ComposableMember[] {
  return members.filter(m => may(roster, m.principal, capability));
}

export { foldRoster, may, explain };
export type { Roster, RoleProfile, Capability, Principal, DelegatedScope };
