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

import {
  foldRoster, may, explain,
  type Roster, type RoleProfile, type Capability, type Principal, type DelegatedScope,
  type SignerResolver, type SignerFinding, type Attestation, type AttestationPolicy,
  type AttributionGrade, type ContentBinding, type FieldProvenance,
} from './roster.js';
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
 *
 * This answers about a SCOPE, which is less than a registry entry says. An entry also
 * carries `revoked`, and no scope string can express it — call {@link capabilitiesOfAgent}
 * whenever an actual agent is in hand, or a revoked one is read as live.
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

/**
 * An agent as the substrate's registry records it.
 *
 * ★ THREE IDENTIFIER FIELDS, BECAUSE THE SUBSTRATE HAS THREE SHAPES, and reading only two of
 * them made the whole signer index a no-op on the one path that matters. A pod's own
 * `AgentRegistry` row is `AuthorizedAgentData` (`@interego/core`), whose identifier is
 * `agentId` and which is the ONLY shape carrying `revoked` — the relay's projections filter
 * revoked rows out before anyone sees them and surface `id`/`did` instead. So the shape that
 * can answer "was this key withdrawn?" was exactly the shape `signerIndexFromRegistry` could
 * not index: it read `did ?? id`, found neither, and answered `null` for every real member,
 * which refuses every genuine grant while `capabilitiesOfAgent`'s revoked branch sat
 * unreachable. Same category error as range-checking a graph IRI against a storage path,
 * one file over.
 */
export interface RegisteredAgent {
  readonly did?: string;
  readonly id?: string;
  /** `AuthorizedAgentData.agentId` — the pod registry's own field name. */
  readonly agentId?: string;
  readonly scope?: string;
  /**
   * Set once the owner withdraws the delegation — `AuthorizedAgentData.revoked` in
   * `@interego/core`, which the relay tests as `!a.revoked` everywhere it surfaces an agent.
   *
   * Optional, and its absence is why leaving it out survived: the relay's own projections
   * filter revoked rows out before anyone sees them, so through that path the field never
   * arrives. A caller reading the pod's `AgentRegistry` directly, or the identity server's
   * agent list, gets the revoked rows too — and got their scope honoured.
   */
  readonly revoked?: boolean;
}

/**
 * What THIS registry entry actually carries.
 *
 * ★ A REVOKED AGENT CARRIES NOTHING, whatever scope its row still records. Revocation
 * withdraws the delegation; it does not rewrite the scope, so a revoked `ReadWrite` row is
 * still literally `ReadWrite` and deciding on the scope alone hands all six capabilities to
 * an agent the owner has already thrown out.
 *
 * The claim this restores is that the ceiling is the substrate's field — not that field
 * minus one. Two authorization systems reading the same record and disagreeing about what
 * it says is precisely how the disagreement gets discovered by whoever it lets through.
 */
export function capabilitiesOfAgent(agent: RegisteredAgent): readonly Capability[] {
  // Truthiness, matching the substrate's own `!a.revoked`, rather than `=== true`. This is
  // JSON read off somebody's pod: a value that is not the boolean the type promises must
  // not come out the live end of the branch.
  if (agent.revoked) return [];
  return capabilitiesForScope(agent.scope);
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
 *
 * A revoked agent is not one of them, so it adds nothing to the union. Union over every
 * row regardless would mean revoking a principal's only ReadWrite agent left the union
 * unchanged as long as some ReadOnly one remained — a revocation that revokes nothing, and
 * silent, because the roster fold downstream sees only the union.
 *
 * ★ AND THE UNION IS EXACTLY WHY REVOCATION CANNOT BE LEFT TO THIS FUNCTION ALONE. Where a
 * principal has a second live agent the union is unchanged by the revocation, so nothing
 * downstream of here can see it — which is how an entry signed by a withdrawn key was
 * counted as that member's content at the `attested` grade. Authority narrows here;
 * ATTRIBUTION is narrowed in {@link signerIndexFromRegistry}, and both are needed.
 */
export function scopesFromRegistry(
  registry: readonly { readonly principal: Principal; readonly agents: readonly RegisteredAgent[] }[],
): readonly DelegatedScope[] {
  return registry.map(({ principal, agents }) => ({
    principal,
    capabilities: [...new Set(agents.flatMap(a => capabilitiesOfAgent(a)))].sort(),
  }));
}

/**
 * Who does the signer on a record act for?
 *
 * An `iep:authorshipProof` names an agent DID; a roster names principals. Comparing them as
 * strings answers false for every person in every real workspace — a WebID is not a DID —
 * so an attribution check built that way withholds everything and gets turned off. The
 * mapping is the agent registry on each principal's OWN pod, which is the same record
 * {@link scopesFromRegistry} already reads, and which nobody but that principal can write.
 * That last part is what makes it evidence: a convener cannot add their own agent to
 * somebody else's registry.
 *
 * ★ A REVOKED AGENT STILL IDENTIFIES, AND NO LONGER ATTESTS. That is a deliberate weakening
 * of what this function used to claim, and the claim was wrong. The old reading —
 * "attribution is a historical fact, authority is a present one, so keep revoked rows and
 * let `disallowed` handle the authority half" — holds only when the revoked agent was the
 * principal's ONLY agent. `scopesFromRegistry` unions over the live ones, so a review signed
 * an entry with a key its owner had already thrown out, and it was counted as that member's
 * workspace content at the highest grade the system offers, with nothing downstream able to
 * recover which key wrote it. That is the compromised-key case the revocation work exists
 * for, admitted.
 *
 * So a revoked row is still INDEXED — the mapping from key to person is what makes a
 * revocation legible at all — and it comes back marked, and {@link refuseAttestation}
 * refuses it by name. What that costs is real and is not hidden: rotating a key withholds
 * everything it signed until the retired row is restored to the registry live, and the
 * entries are reported in `unattested` rather than admitted. A registry cannot tell a
 * routine rotation from a compromise, and only one of the two readings is safe when it
 * cannot.
 *
 * ★ AND A KEY TWO REGISTRIES CLAIM RESOLVES TO NEITHER. This index used to be
 * `index.set(id, principal)` with no collision detection — the same order-dependent,
 * unreported last-write-wins that `foldRoster` goes out of its way to intersect and report
 * one file over. Anyone may write their own pod's registry, so anyone could list a rival's
 * signing DID in it and take over the attribution of every record that rival ever signed,
 * with the answer flipping on the order the rows arrived in. Contested keys now come back as
 * `{acts: 'contested', claimedBy}` and refuse, naming every claimant rather than presenting
 * one of two conflicting claims as established.
 *
 * A principal also resolves to itself, for a principal that signs under its own IRI.
 */
export function signerIndexFromRegistry(
  registry: readonly { readonly principal: Principal; readonly agents: readonly RegisteredAgent[] }[],
): SignerResolver {
  const index = new Map<string, { principal: Principal; revoked: boolean }>();
  const contested = new Map<string, Principal[]>();

  const claim = (id: string, principal: Principal, revoked: boolean): void => {
    if (id.length === 0) return;
    const prior = index.get(id);
    if (prior === undefined) { index.set(id, { principal, revoked }); return; }
    if (prior.principal !== principal) {
      const claimants = contested.get(id) ?? [prior.principal];
      if (!claimants.includes(principal)) claimants.push(principal);
      contested.set(id, claimants);
      return;
    }
    // One principal listing the same key twice is ordinary — a federated composer reads one
    // registry per pod. Revoked wins over live: the safe reading of two rows that disagree
    // about whether a delegation still stands is that it does not.
    if (revoked) index.set(id, { principal, revoked: true });
  };

  for (const { principal, agents } of registry) {
    claim(principal, principal, false);
    for (const agent of agents) {
      // All three shapes, not `did ?? id`. See RegisteredAgent: the pod registry's `agentId`
      // is the only one that carries `revoked`, so missing it made the revoked branch dead.
      for (const id of [agent.did, agent.id, agent.agentId]) {
        if (id !== undefined) claim(id, principal, agent.revoked === true);
      }
    }
  }

  // null, not the signer itself, for anything unknown. Falling back to identity would make
  // an unregistered DID vouch for a principal whose IRI happens to equal it — and, worse,
  // would turn a registry this layer failed to read into a blanket "everyone is themselves".
  return (signedBy: string) => {
    const claimants = contested.get(signedBy);
    if (claimants !== undefined) return { acts: 'contested', claimedBy: [...claimants].sort() };
    const hit = index.get(signedBy);
    if (hit === undefined) return null;
    return { acts: 'for', principal: hit.principal, revoked: hit.revoked };
  };
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
  const name = actingAgent.did ?? actingAgent.id ?? actingAgent.agentId ?? 'the acting agent';
  // Revocation gets its own sentence rather than falling through to the one below. That one
  // names the scope and invites the reader to widen it, which for a revoked agent is advice
  // towards a thing that will not help — the row already says ReadWrite.
  if (actingAgent.revoked) {
    return {
      allowed: false,
      because:
        `${principal} may ${capability} in this workspace, but is acting through ${name}, whose `
        + `registry entry is REVOKED. The scope it still records (${actingAgent.scope ?? 'unresolved'}) `
        + 'is what that agent had, not what it has. Re-register it, or act through another.',
    };
  }
  const agentCaps = capabilitiesOfAgent(actingAgent);
  if (!agentCaps.includes(capability)) {
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

/** A member the composition never went to, and what that costs. */
export interface UnreadMember {
  readonly principal: Principal;
  readonly because: string;
  /**
   * Whether this member MAY do the thing the view was authorized for.
   *
   * ★ The field that decides whether an unread member is a gap or a saving, and the one
   * whose absence let a whole authorized member vanish. `notRead` used to be filtered to
   * members who may NOT act — precisely the ones `readableMembers` skips on purpose — so a
   * Contributor missing from the caller's members list (a stale roster, no `podUrl`, a
   * hand-rolled filter) appeared in no field at all and `complete` stayed `true`. A view
   * missing an entire authorized member is the strongest thing `complete` is supposed to be
   * false for, and it was the one case invisible.
   */
  readonly authorizedHere: boolean;
}

export interface AuthorizedView extends ComposedView {
  /**
   * Entries written by a member who may not append here. They exist and are theirs; they
   * are simply not workspace content. Surfaced rather than dropped so the situation is
   * diagnosable — "this member has been writing entries that do not count" is something
   * somebody needs to be told, and probably needs to fix by widening the role.
   */
  readonly disallowed: readonly { readonly entry: ComposedEntry; readonly because: string }[];
  /**
   * EVERY roster member whose stream was not among the ones composed — whether or not they
   * may act here. {@link UnreadMember.authorizedHere} is which.
   *
   * ★ This is what stops the {@link readableMembers} pre-filter deleting the report. It is
   * DERIVED — roster members set against the streams the view actually attempted — not
   * threaded in by the caller, so it holds whether they used that helper, hand-rolled the
   * same filter, or composed a subset for their own reasons. There is nothing to pass and
   * therefore nothing to forget to pass.
   *
   * It is weaker than `disallowed` in one specific way, worth keeping in view: it says
   * their entries WOULD not count, not that any exist. "This Observer has been writing"
   * requires having read their pod.
   */
  readonly notRead: readonly UnreadMember[];
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
 * people who need to know about them. `notRead` closes the same hole one step earlier, for
 * members a caller declined to read at all.
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

  // ★ A MEMBER WHOSE POD WAS NEVER READ STILL HAS TO BE NAMED.
  //
  // `readableMembers` drops members who may not append before the fan-out. That is a real
  // saving and it silently removed the half of this function that matters: an unauthorised
  // writer nobody reads contributes no entries, so `disallowed` is empty, so the view
  // reports a clean workspace when it has merely not looked. Reported here instead, from
  // the roster against the streams the composition actually attempted — a member the
  // roster knows, who may not do this, and who appears in neither `streams` nor
  // `unavailable`, was dropped upstream.
  //
  // ★ AND AN AUTHORIZED ONE IS A GAP, NOT A SAVING. The first version filtered this list to
  // members who may NOT act, which is the set `readableMembers` deliberately skips — so the
  // one member whose absence actually costs the reader content, a Contributor nobody
  // composed, was in neither `notRead` nor `disallowed` and `complete` said `true`. Every
  // unread member is listed now; `authorizedHere` separates the deliberate skip from the
  // hole, and only the hole reaches `complete`.
  const attempted = new Set([
    ...view.streams.map(s => s.member.principal),
    ...view.unavailable.map(u => u.member.principal),
  ]);
  const notRead: UnreadMember[] = roster.members
    .filter(m => !attempted.has(m.principal))
    .map(m => {
      const authorizedHere = may(roster, m.principal, capability);
      return {
        principal: m.principal,
        because: authorizedHere
          ? `${m.principal} is a member who MAY ${capability} here, and their stream was not `
            + 'among the ones composed — so any entry of theirs is missing from this view '
            + 'rather than excluded from it. Compose their stream, or say why it was skipped.'
          : explain(roster, m.principal, capability),
        authorizedHere,
      };
    });

  return {
    ...view,
    entries: allowed,
    disallowed,
    notRead,
    // `complete` stays about REACHABILITY, not authority. An entry excluded because its
    // author may not append is not a gap in the view — it is the view working. Folding the
    // two together would make a correctly-governed workspace permanently report itself
    // as incomplete, and a flag that is always false is a flag nobody reads.
    //
    // An AUTHORIZED member nobody read is the other thing entirely: it is reachability, and
    // it is the largest possible gap — a whole participant's contribution absent from a view
    // that called itself whole. `disallowed` is still excluded; only `authorizedHere` counts.
    complete: view.complete && notRead.every(m => !m.authorizedHere),
  };
}

/**
 * The members a composed view should be built from.
 *
 * Called before the fan-out so an Observer's pod is not even read. Not a security control —
 * the view would exclude their entries anyway — but reading N pods to discard one of them
 * is a real cost in a design whose catch-up is already one request per member.
 *
 * ★ WHAT THIS COSTS. An independent review was right that recommending this deleted the
 * reported half of read-time enforcement: skip the pod and the unauthorised writer produces
 * `disallowed: 0` and appears in no other field either. It no longer does —
 * {@link authorizeView} derives {@link AuthorizedView.notRead} rather than trusting the
 * caller to carry the skip forward, so a member dropped here is still named with the reason.
 *
 * What is genuinely traded away, and cannot be recovered from a roster: whether they are
 * ACTUALLY WRITING. `notRead` says the entries would not count; `disallowed` says entries
 * exist and do not. If the question is "has this Observer been writing things that do not
 * count?", pay for the reads — compose every member and let the entries be reported.
 */
export function readableMembers(
  roster: Roster,
  members: readonly ComposableMember[],
  capability: Capability = CAPS.append,
): readonly ComposableMember[] {
  return members.filter(m => may(roster, m.principal, capability));
}

export { foldRoster, may, explain };
export type {
  Roster, RoleProfile, Capability, Principal, DelegatedScope,
  SignerResolver, SignerFinding, Attestation, AttestationPolicy, AttributionGrade,
  ContentBinding, FieldProvenance,
};
