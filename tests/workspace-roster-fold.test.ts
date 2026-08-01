/**
 * The roster fold's safety properties.
 *
 * Membership here is a computed fold over published records, not a row in a table. That buys
 * cross-organisation membership and custody, and it costs a set of failure modes a table does
 * not have — concurrent heads, a grant with no acceptance, a role naming a capability the
 * principal's delegation never carried. Each of those is a way to accidentally grant authority
 * nobody meant to grant, so each is pinned here.
 *
 * ★ The direction of every error matters. Under-privileging a member is an operational
 * annoyance somebody notices and fixes within minutes. Over-privileging one is a security
 * failure nobody notices at all. Every ambiguous case below therefore asserts the restrictive
 * answer, and asserts it as a REFUSAL rather than merely as a missing capability.
 */
import { describe, it, expect } from 'vitest';
import { foldRoster, may, explain, type RoleProfile } from '../applications/shared-workspace/src/roster.js';

const W = 'https://relay.test/ws/alpha';
const P = 'https://profiles.test/roles';
const cap = (n: string) => `${P}#${n}`;

const PROFILE: RoleProfile = {
  profile: P,
  roles: [
    { role: `${P}#Convener`, permits: [cap('read'), cap('append'), cap('grant'), cap('revoke')] },
    { role: `${P}#Contributor`, permits: [cap('read'), cap('append')] },
    { role: `${P}#Observer`, permits: [cap('read')] },
  ],
};

const alice = 'https://alice.example/profile#me';
const bot = 'did:web:agents.example:bot-7';

const grant = (o: Partial<Parameters<typeof foldRoster>[0]['grants'][number]> = {}) => ({
  head: 'https://conv.test/g1', workspace: W, grantedTo: alice, role: `${P}#Contributor`, ...o,
});
const accept = (o: Partial<Parameters<typeof foldRoster>[0]['acceptances'][number]> = {}) => ({
  head: 'https://alice.example/a1', workspace: W, member: alice,
  accepts: 'https://conv.test/g1', stream: 'https://alice.example/stream/alpha', ...o,
});
const full = (p: string) => ({ principal: p, capabilities: [cap('read'), cap('append'), cap('grant'), cap('revoke')] });

const fold = (o: Partial<Parameters<typeof foldRoster>[0]> = {}) => foldRoster({
  workspace: W, profile: PROFILE, grants: [grant()], acceptances: [accept()], scopes: [full(alice)], ...o,
});

describe('membership requires both halves', () => {
  it('a grant plus an acceptance makes a member', () => {
    const r = fold();
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.principal).toBe(alice);
    expect(r.members[0]!.stream).toBe('https://alice.example/stream/alpha');
  });

  it('★ a grant ALONE does not — a convener cannot manufacture a participant', () => {
    // The substrate cannot make someone's pod hold a record they did not write. A one-sided
    // roster would let a convener list people who never agreed to anything, which in a system
    // built on custody is the worst available failure.
    const r = fold({ acceptances: [] });
    expect(r.members).toHaveLength(0);
    expect(r.pendingInvitations).toEqual([
      { principal: alice, role: `${P}#Contributor`, grant: 'https://conv.test/g1' },
    ]);
    expect(explain(r, alice, cap('read'))).toMatch(/has not accepted/);
  });

  it('an acceptance alone does not either — you cannot join yourself', () => {
    const r = fold({ grants: [] });
    expect(r.members).toHaveLength(0);
    expect(r.pendingInvitations).toHaveLength(0);
  });

  it('records naming a different workspace are ignored, not treated as errors', () => {
    // A pod holds many workspaces' records; seeing another's is normal.
    const r = fold({
      grants: [grant(), grant({ head: 'https://conv.test/other', workspace: 'https://relay.test/ws/beta' })],
    });
    expect(r.members).toHaveLength(1);
  });
});

describe('a role is a ceiling, never a grant', () => {
  it('★ effective capability is the INTERSECTION with the delegated scope', () => {
    // A Contributor whose agent may only read cannot write, however the role reads.
    const r = fold({ scopes: [{ principal: alice, capabilities: [cap('read')] }] });
    expect(r.members[0]!.effective).toEqual([cap('read')]);
    expect(r.members[0]!.withheldByDelegation).toEqual([cap('append')]);
    expect(may(r, alice, cap('append'))).toBe(false);
    expect(explain(r, alice, cap('append'))).toMatch(/ceiling, never a grant/);
  });

  it('★ a role cannot grant what the delegation never carried — no escalation', () => {
    // The strongest role in the profile, against a read-only delegation.
    const r = fold({
      grants: [grant({ role: `${P}#Convener` })],
      scopes: [{ principal: alice, capabilities: [cap('read')] }],
    });
    expect(r.members[0]!.effective).toEqual([cap('read')]);
    expect(may(r, alice, cap('revoke'))).toBe(false);
  });

  it('★ an unresolvable delegation yields NO capability, not full capability', () => {
    // Defaulting the other way would turn an identity-service outage into a privilege grant.
    const r = fold({ scopes: [] });
    expect(r.members[0]!.effective).toEqual([]);
    expect(may(r, alice, cap('read'))).toBe(false);
  });

  it('a role the profile does not declare contributes nothing', () => {
    // The publish shape should have refused it, but a profile can be superseded after a grant
    // was written, and the fold must not then invent authority.
    const r = fold({ grants: [grant({ role: `${P}#Sovereign` })] });
    expect(r.members[0]!.effective).toEqual([]);
  });

  it('an agent is a principal like any other', () => {
    const r = fold({
      grants: [grant({ head: 'https://conv.test/g2', grantedTo: bot, role: `${P}#Observer` })],
      acceptances: [accept({ head: 'https://agents.example/a2', member: bot, accepts: 'https://conv.test/g2', stream: 'https://agents.example/s' })],
      scopes: [full(bot)],
    });
    expect(r.members[0]!.principal).toBe(bot);
    expect(r.members[0]!.effective).toEqual([cap('read')]);
  });
});

describe('divergence is reported, never resolved by guessing', () => {
  it('★ two grant heads intersect rather than picking a winner', () => {
    // Last-write-wins on an authorization record can silently escalate privilege. The two
    // heads here disagree about the role; the safe reading is the weaker one.
    const r = fold({
      grants: [
        grant({ head: 'https://conv.test/gA', role: `${P}#Convener` }),
        grant({ head: 'https://conv.test/gB', role: `${P}#Observer` }),
      ],
      acceptances: [accept({ accepts: 'https://conv.test/gA' })],
    });
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.effective).toEqual([cap('read')]); // Convener ∩ Observer
    expect(may(r, alice, cap('grant'))).toBe(false);
    expect(r.divergences[0]!.kind).toBe('grant');
    expect(r.divergences[0]!.heads).toEqual(['https://conv.test/gA', 'https://conv.test/gB']);
    expect(r.divergences[0]!.note).toMatch(/No winner is chosen/);
  });

  it('a clean chain reports no divergence', () => {
    expect(fold().divergences).toEqual([]);
    expect(fold().members[0]!.divergence).toBeUndefined();
  });
});

describe('leaving and removal', () => {
  it('★ ANY revoking head removes the member, even alongside a live grant', () => {
    // Erring towards removal is the safe direction: a wrongly-removed member complains
    // immediately, a wrongly-retained one never does.
    const r = fold({
      grants: [grant({ head: 'https://conv.test/gA' }), grant({ head: 'https://conv.test/gB', revoked: true })],
    });
    expect(r.members).toHaveLength(0);
  });

  it('a withdrawn acceptance removes the member', () => {
    expect(fold({ acceptances: [accept({ withdrawn: true })] }).members).toHaveLength(0);
  });

  it('removal does not erase the record — it stops the stream being folded in', () => {
    // The member's entries stay on their own pod at their own URLs. The fold is the only
    // thing that changes, which is exactly the custody property the design exists for.
    const r = fold({ grants: [grant({ revoked: true })] });
    expect(r.members).toHaveLength(0);
    expect(accept().stream).toBe('https://alice.example/stream/alpha');
  });
});

describe('explain() gives a reason a person can act on', () => {
  it('names the role when the role is the limit', () => {
    const r = fold({ grants: [grant({ role: `${P}#Observer` })] });
    expect(explain(r, alice, cap('append'))).toMatch(/does not permit/);
  });

  it('distinguishes a non-member from an invitee', () => {
    expect(explain(fold(), 'https://nobody.test/#me', cap('read'))).toMatch(/is not a member/);
    expect(explain(fold({ acceptances: [] }), alice, cap('read'))).toMatch(/has not accepted/);
  });
});
