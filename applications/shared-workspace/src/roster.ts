/**
 * The roster fold: who is in this workspace, and what may they actually do.
 *
 * ── WHY MEMBERSHIP IS TWO-SIDED ──────────────────────────────────────────────
 *
 * A grant lives on the convener's pod. An acceptance lives on the member's own pod. A roster
 * entry exists only where the two agree.
 *
 * That is not ceremony. The substrate has no way to make a person's pod hold a record they
 * did not write, so a one-sided roster would let a convener list participants who never
 * agreed to anything — and in a system whose whole claim is that people keep custody of what
 * they wrote, a manufactured participant is the worst possible failure. Requiring both halves
 * makes it structurally impossible rather than merely discouraged.
 *
 * ── WHY A ROLE CANNOT ESCALATE ───────────────────────────────────────────────
 *
 * Effective capability is `role.permits ∩ delegatedScope`. A role is a CEILING on an
 * authority the principal already had, never a source of one. So a Convener whose agent holds
 * a read-only delegation still cannot write, and granting a role to an agent can never widen
 * the set of things its principal is exposed to.
 *
 * This is the property that distinguishes a published roster from a membership table. In a
 * table, being an admin IS the authority. Here it is only a bound on it.
 *
 * ── WHY DIVERGENCE IS REPORTED RATHER THAN RESOLVED ──────────────────────────
 *
 * Two concurrent writes to a grant chain leave two heads. The obvious move is last-write-wins.
 * That is wrong here: on an AUTHORIZATION record, silently picking a winner can silently
 * escalate privilege, and the loser's revocation would simply vanish.
 *
 * So the fold names both heads and applies the INTERSECTION of their capabilities.
 * Under-privileging a member is an operational annoyance someone notices and fixes;
 * over-privileging one is a security failure nobody notices at all.
 *
 * This module is pure. It performs no I/O, so it can be tested exhaustively and cannot become
 * a second place where authorization quietly happens.
 */

/** A principal: a WebID for a person, a DID for an agent. No distinction is drawn between them. */
export type Principal = string;

/** A capability IRI from the workspace's published role profile. */
export type Capability = string;

/** A role IRI, and what the published profile says it permits. */
export interface RoleDefinition {
  readonly role: string;
  readonly permits: readonly Capability[];
}

/** A role profile, as published. Roles are data; this is the parsed form of that data. */
export interface RoleProfile {
  readonly profile: string;
  readonly roles: readonly RoleDefinition[];
}

/** Half a membership, from the convener's pod. `head` is the descriptor URL of this version. */
export interface Grant {
  readonly head: string;
  readonly workspace: string;
  readonly grantedTo: Principal;
  readonly role: string;
  readonly revoked?: boolean;
}

/** The other half, from the member's own pod. */
export interface Acceptance {
  readonly head: string;
  readonly workspace: string;
  readonly member: Principal;
  readonly accepts: string;
  readonly stream: string;
  readonly withdrawn?: boolean;
}

/** What a principal's own delegation already permits, independent of any workspace. */
export interface DelegatedScope {
  readonly principal: Principal;
  readonly capabilities: readonly Capability[];
}

export interface Member {
  readonly principal: Principal;
  readonly role: string;
  readonly stream: string;
  /** role.permits ∩ delegatedScope — what this principal may ACTUALLY do here. */
  readonly effective: readonly Capability[];
  /** Permitted by the role but absent from the delegation, so withheld. Explains a refusal. */
  readonly withheldByDelegation: readonly Capability[];
  /** Set when this member's grant or acceptance chain had more than one head. */
  readonly divergence?: Divergence;
}

export interface Divergence {
  readonly kind: 'grant' | 'acceptance';
  readonly heads: readonly string[];
  readonly note: string;
}

export interface Roster {
  readonly workspace: string;
  readonly members: readonly Member[];
  /** Grants nobody has accepted yet: offers, not members. Surfaced so they are not invisible. */
  readonly pendingInvitations: readonly { principal: Principal; role: string; grant: string }[];
  /** Every divergence found, so an operator can republish a clean head. */
  readonly divergences: readonly Divergence[];
}

const uniqueSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** Intersection, order-independent and duplicate-free. */
function intersect(a: readonly string[], b: readonly string[]): string[] {
  const inB = new Set(b);
  return uniqueSorted(a.filter(x => inB.has(x)));
}

/** Group by a key, preserving input order within each group. */
function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const g = m.get(k);
    if (g) g.push(x); else m.set(k, [x]);
  }
  return m;
}

/**
 * Fold grant heads and acceptance heads into a roster.
 *
 * Inputs are HEADS — the current version of each chain — not whole histories. Resolving a
 * chain to its head is the substrate's job (supersession), not this module's; conflating the
 * two would put chain-walking logic in an authorization path where it does not belong.
 */
export function foldRoster(args: {
  readonly workspace: string;
  readonly profile: RoleProfile;
  readonly grants: readonly Grant[];
  readonly acceptances: readonly Acceptance[];
  readonly scopes: readonly DelegatedScope[];
}): Roster {
  const { workspace, profile, grants, acceptances, scopes } = args;

  const permitsOf = new Map(profile.roles.map(r => [r.role, uniqueSorted([...r.permits])]));
  const scopeOf = new Map(scopes.map(s => [s.principal, uniqueSorted([...s.capabilities])]));

  // Records naming a different workspace are not ours to interpret. Dropping them silently
  // is correct: a pod holds many workspaces' records and seeing another's is not an error.
  const ourGrants = grants.filter(g => g.workspace === workspace);
  const ourAcceptances = acceptances.filter(a => a.workspace === workspace);

  const divergences: Divergence[] = [];
  const members: Member[] = [];
  const pending: { principal: Principal; role: string; grant: string }[] = [];

  const grantsByPrincipal = groupBy(ourGrants, g => g.grantedTo);
  const acceptancesByGrant = groupBy(ourAcceptances, a => a.accepts);

  for (const [principal, gs] of [...grantsByPrincipal].sort((x, y) => x[0].localeCompare(y[0]))) {
    // ── grant side ──
    let grantDivergence: Divergence | undefined;
    if (gs.length > 1) {
      grantDivergence = {
        kind: 'grant',
        heads: uniqueSorted(gs.map(g => g.head)),
        note:
          `${gs.length} concurrent grant heads for ${principal}. No winner is chosen: the `
          + 'intersection of their capabilities applies. Last-write-wins on an authorization '
          + 'record can silently escalate privilege, so this is reported instead.',
      };
      divergences.push(grantDivergence);
    }

    // Revocation is decisive in either direction: if ANY live head revokes, the member is out.
    // Erring towards removal is the safe direction — a wrongly-removed member complains, a
    // wrongly-retained one does not.
    if (gs.some(g => g.revoked === true)) continue;

    // Under divergence the role's capabilities are intersected across heads.
    const roleCaps = gs
      .map(g => permitsOf.get(g.role) ?? [])
      .reduce((acc, caps) => (acc === null ? [...caps] : intersect(acc, caps)), null as string[] | null)
      ?? [];

    // A grant naming a role the profile does not declare contributes nothing. The publish
    // shape should already have refused it; this is the second line, because a profile can
    // be superseded after a grant was written and the fold must not then invent authority.
    const knownRole = gs.find(g => permitsOf.has(g.role))?.role;

    const accepted = gs
      .flatMap(g => acceptancesByGrant.get(g.head) ?? [])
      .filter(a => a.member === principal);

    if (accepted.length === 0) {
      for (const g of gs) pending.push({ principal, role: g.role, grant: g.head });
      continue;
    }

    let acceptanceDivergence: Divergence | undefined;
    if (accepted.length > 1) {
      acceptanceDivergence = {
        kind: 'acceptance',
        heads: uniqueSorted(accepted.map(a => a.head)),
        note:
          `${accepted.length} concurrent acceptance heads for ${principal}. The member is `
          + 'included, but their stream is ambiguous until one head is republished cleanly.',
      };
      divergences.push(acceptanceDivergence);
    }

    if (accepted.some(a => a.withdrawn === true)) continue;

    const scope = scopeOf.get(principal);
    // ★ NO SCOPE MEANS NO CAPABILITY, not full capability. A principal whose delegation could
    // not be resolved is unauthenticated as far as this fold is concerned. Defaulting the
    // other way would make an outage into a privilege grant.
    const effective = scope === undefined ? [] : intersect(roleCaps, scope);
    const withheld = scope === undefined ? uniqueSorted(roleCaps) : roleCaps.filter(c => !scope.includes(c));

    members.push({
      principal,
      role: knownRole ?? gs[0]!.role,
      stream: accepted[0]!.stream,
      effective,
      withheldByDelegation: uniqueSorted(withheld),
      ...(grantDivergence ?? acceptanceDivergence
        ? { divergence: grantDivergence ?? acceptanceDivergence! }
        : {}),
    });
  }

  return {
    workspace,
    members,
    pendingInvitations: pending.sort((a, b) => a.principal.localeCompare(b.principal)),
    divergences,
  };
}

/**
 * May this principal do this, here?
 *
 * The only question an authorization check should ask, and it reads off the fold rather than
 * recomputing anything — so there is exactly one place where the intersection happens.
 */
export function may(roster: Roster, principal: Principal, capability: Capability): boolean {
  const m = roster.members.find(x => x.principal === principal);
  return m !== undefined && m.effective.includes(capability);
}

/**
 * Why was that allowed or refused? Returned to callers so a refusal is explainable rather
 * than merely final — "you are an Editor but your agent's delegation is read-only" is
 * actionable, "403" is not.
 */
export function explain(roster: Roster, principal: Principal, capability: Capability): string {
  const m = roster.members.find(x => x.principal === principal);
  if (!m) {
    const invited = roster.pendingInvitations.find(p => p.principal === principal);
    return invited
      ? `${principal} was offered ${invited.role} but has not accepted, so is not yet a member.`
      : `${principal} is not a member of ${roster.workspace}.`;
  }
  if (m.effective.includes(capability)) {
    return `${principal} holds ${m.role}, which permits ${capability}, and their delegation carries it.`;
  }
  if (m.withheldByDelegation.includes(capability)) {
    return `${principal} holds ${m.role}, which permits ${capability} — but their own delegated `
      + 'scope does not carry it, so it is withheld. A role is a ceiling, never a grant.';
  }
  return `${principal} holds ${m.role}, which does not permit ${capability}.`;
}
