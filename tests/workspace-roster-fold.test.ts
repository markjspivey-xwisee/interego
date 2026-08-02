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
import {
  foldRoster, may, explain, refuseAttestation, signerIsSelf,
  type RoleProfile, type Attestation, type SignerResolver,
} from '../applications/shared-workspace/src/roster.js';

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

  it('★ but a fold with no attestation policy SAYS it did not check', () => {
    // The claim above is about where the two records live, and this function never looked.
    // Passing the test without also stating the grade is how the property was believed for
    // as long as it was — so the grade is non-omittable and the note is in words.
    const r = fold();
    expect(r.membershipGrade).toBe('asserted');
    expect(r.attributionNote).toMatch(/could have written both halves/);
    expect(r.unattested).toEqual([]);
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

describe('★ two-sidedness as a FACT: who actually signed each half', () => {
  // The defect this block exists for: an independent review wrote both halves on the
  // convener's own pod and the fold produced a member who agreed to nothing. Nothing in
  // `Grant` or `Acceptance` carried provenance, and the only cross-checks — the acceptance
  // names the grant, and repeats the principal — are both things the convener types.
  //
  // Worse, the live verifier that reported 13/13 BUILT BOTH HALVES ITSELF. The property was
  // demonstrated by construction. So these tests build the forgery first and require the
  // fold to refuse it, rather than building the honest case and watching it pass.
  const convener = 'https://conv.example/profile#me';
  const aliceAgent = 'did:web:agents.example:alice-1';
  const convenerAgent = 'did:web:agents.example:conv-1';

  /** Each principal's own pod vouches for their own agents — nobody else can write it. */
  const signerOf: SignerResolver = (s: string) =>
    ({ [aliceAgent]: alice, [convenerAgent]: convener } as Record<string, string>)[s] ?? null;

  const signed = (by: string): Attestation =>
    ({ authorshipVerified: true, signedBy: by, boundToDescriptor: true });

  const attested = (o: Partial<Parameters<typeof foldRoster>[0]> = {}) => foldRoster({
    workspace: W, profile: PROFILE, scopes: [full(alice)],
    grants: [grant({ attestation: signed(convenerAgent) })],
    acceptances: [accept({ attestation: signed(aliceAgent) })],
    attestation: { convener, signerOf },
    ...o,
  });

  it('both halves signed by the right party makes a member, and says so', () => {
    const r = attested();
    expect(r.members).toHaveLength(1);
    expect(r.membershipGrade).toBe('attested');
    expect(r.unattested).toEqual([]);
    expect(r.attributionNote).toMatch(/ATTESTED/);
  });

  it('★ THE FORGERY: the convener signs the acceptance too, and it is REFUSED', () => {
    // Both records on the convener's pod, both genuinely signed — by the convener. This is
    // the exact fold that used to produce a member.
    const r = attested({ acceptances: [accept({ attestation: signed(convenerAgent) })] });
    expect(r.members).toHaveLength(0);
    expect(r.unattested).toEqual([{
      kind: 'acceptance',
      head: 'https://alice.example/a1',
      principal: alice,
      because: expect.stringContaining(`acts for ${convener}`),
      // A forged acceptance CONFERS, so refusing it is the whole effect: nothing about it
      // still applies. The revocation test below is the other value of this field.
      restrictionStillApplied: false,
    }]);
  });

  it('★ and the refusal does not explain itself as an unanswered invitation', () => {
    // The grant survives, so alice shows as invited — which is true and describes the wrong
    // event. Left at that, whoever reads it chases alice for an answer she appears to have
    // given, and the forged record is the one thing nobody is told about.
    const r = attested({ acceptances: [accept({ attestation: signed(convenerAgent) })] });
    expect(r.pendingInvitations).toHaveLength(1);
    const why = explain(r, alice, cap('read'));
    expect(why).toMatch(/acceptance .* was refused/);
    expect(why).not.toMatch(/has not accepted/);
  });

  it('★ a grant not signed for the convener is refused too — the gate is two-sided', () => {
    // The other direction, and the one a check written only against acceptances misses: a
    // member who signs their own grant has admitted themselves.
    const r = attested({ grants: [grant({ attestation: signed(aliceAgent) })] });
    expect(r.members).toHaveLength(0);
    expect(r.pendingInvitations).toEqual([]);
    expect(r.unattested[0]).toMatchObject({ kind: 'grant', principal: alice });
  });

  it('★ a record with NO attestation is refused, not waved through as un-objected', () => {
    // The direction that decides whether any of this is worth having. An unchecked record and
    // a verified one must not reduce to the same outcome, or turning the policy on changes
    // nothing for exactly the records that were never signed.
    const r = attested({ acceptances: [accept()] });
    expect(r.members).toHaveLength(0);
    expect(r.unattested[0]!.because).toMatch(/no attestation at all/);
  });

  it('a proof that did not verify is refused, carrying the verifier\'s reason', () => {
    const r = attested({
      acceptances: [accept({
        attestation: {
          authorshipVerified: false, signedBy: aliceAgent, boundToDescriptor: true,
          reason: 'signature did not recover',
        },
      })],
    });
    expect(r.members).toHaveLength(0);
    expect(r.unattested[0]!.because).toMatch(/signature did not recover/);
  });

  it('★ a proof LIFTED out of one of the member\'s real records is refused', () => {
    // The attack that survives a signature check: the signature is genuine, the signer really
    // is alice, and the proof is about a different document. `boundToDescriptor` is the only
    // field that can tell, and refuseAttestation must consult it.
    const r = attested({
      acceptances: [accept({
        attestation: { authorshipVerified: true, signedBy: aliceAgent, boundToDescriptor: false },
      })],
    });
    expect(r.members).toHaveLength(0);
    expect(r.unattested[0]!.because).toMatch(/does not name this descriptor/);
  });

  it('★ …and the refusal does NOT state the forgery as a fact', () => {
    // `boundToDescriptor: false` has four causes and only one is a forgery — the other three
    // are a response with no turtle, a proof block with no `iep:descriptorId`, and a record
    // whose name does not follow the convention the binding is compared on (the PGSL-primary
    // path writes `holon-<hash>.ttl`). The message said "the proof was copied in from another
    // record", flatly, which is a false accusation against a record's real author in the one
    // channel operators are told to watch — and the channel then stops being believed.
    const r = attested({
      acceptances: [accept({
        attestation: {
          authorshipVerified: true, signedBy: aliceAgent, boundToDescriptor: false,
          reason: 'the proof names <urn:iep:u-alice:pgsl:sha256-9f2c1a> and the record is '
            + 'served at <https://css.test/u-alice/context-graphs/holon-9f2c1a.ttl>',
        },
      })],
    });
    const because = r.unattested[0]!.because;
    expect(because).toMatch(/either the proof was minted for another record/);
    expect(because).toMatch(/only one of them is a forgery/);
    // the diagnostic that distinguishes the four causes is carried through, not swallowed
    expect(because).toMatch(/pgsl:sha256-9f2c1a/);
  });

  it('a signer no registry vouches for attributes to nobody', () => {
    const r = attested({
      acceptances: [accept({ attestation: signed('did:web:agents.example:stranger') })],
    });
    expect(r.members).toHaveLength(0);
    expect(r.unattested[0]!.because).toMatch(/no agent registry vouches/);
  });

  it('★★ an unattestable REVOCATION STILL REMOVES — a refusal may not restore authority', () => {
    // This test used to assert the opposite, and the opposite was the worst defect in the
    // round: the gate filtered the revocation out of the grant list BEFORE the revocation
    // check, so a revocation nobody could attest was not refused — it was ERASED, and the
    // member kept everything. Turning the policy ON granted more than leaving it OFF.
    //
    // The argument for the old behaviour ("honouring an unsigned revocation lets anyone with
    // a row in `grants` evict any member") is real and is the lesser evil: it is a denial of
    // service the ASSERTED configuration already permits in full, so refusing to honour it
    // bought nothing but a stronger configuration that grants more than a weaker one.
    const args = {
      grants: [
        grant({ attestation: signed(convenerAgent) }),
        grant({ head: 'https://conv.test/g2', revoked: true, attestation: signed(aliceAgent) }),
      ],
    };
    const r = attested(args);
    expect(r.members).toHaveLength(0);
    // named, not silently applied — the operator still has to know it could not be attributed
    const named = r.unattested.find(u => u.head === 'https://conv.test/g2');
    expect(named).toBeDefined();
    expect(named!.restrictionStillApplied).toBe(true);
    // and `explain` says the revocation took effect, rather than "was refused", which would
    // send someone to re-sign a record whose re-signing removes the member all over again
    expect(explain(r, alice, cap('read'))).toMatch(/WITHDRAWS authority/);
  });

  it('★ a WITHDRAWN acceptance that cannot be attested still removes, for the same reason', () => {
    const r = attested({
      acceptances: [
        accept({ attestation: signed(aliceAgent) }),
        accept({ head: 'https://alice.example/a2', withdrawn: true }), // no attestation at all
      ],
    });
    expect(r.members).toHaveLength(0);
    expect(r.unattested.find(u => u.head === 'https://alice.example/a2')!.restrictionStillApplied)
      .toBe(true);
  });

  it('★ a refused grant head still NARROWS the intersection, so refusal cannot widen a role', () => {
    // The quieter half of the same class. Heads {Convener attested, Observer unattested}:
    // dropping the unattested head deleted the narrower of the two and handed the member the
    // wider head's capabilities outright — four with the policy on, one with it off.
    const wide = grant({ head: 'https://conv.test/g1', role: `${P}#Convener`, attestation: signed(convenerAgent) });
    const narrow = grant({ head: 'https://conv.test/g2', role: `${P}#Observer` }); // unattested
    const on = attested({ grants: [wide, narrow] });
    expect(on.members[0]!.effective).toEqual([cap('read')]);
  });

  it('the default resolver compares signer to principal directly', () => {
    // Right only where a principal signs under its own IRI — a service account, an agent that
    // IS the member. A person's principal is a WebID and their signer is an agent DID, which
    // is why a real deployment passes signerIndexFromRegistry instead.
    expect(refuseAttestation(signed(alice), alice)).toBeNull();
    expect(signerIsSelf(aliceAgent)).toBe(aliceAgent);
    expect(refuseAttestation(signed(aliceAgent), alice)).toMatch(/not for /);
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

  it('★ the same grant row twice is ONE head, not a fork', () => {
    // Counting rows rather than heads reported TWO divergences here: "2 concurrent grant
    // heads" over a heads list of length one, plus a wholly fictional acceptance fork,
    // because acceptances are re-fetched once per grant head and the duplicate pulled the
    // same acceptance in twice. Duplicate rows are ordinary — a federated composer reads the
    // convener's pod through two registries — and divergence is the one channel operators
    // are told to act on, so noise on it is worse than useless.
    const r = fold({ grants: [grant(), grant()], acceptances: [accept()] });
    expect(r.divergences).toEqual([]);
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.divergence).toBeUndefined();
    expect(r.members[0]!.effective).toEqual([cap('append'), cap('read')]);
  });

  it('the same acceptance row twice is one head too', () => {
    const r = fold({ acceptances: [accept(), accept()] });
    expect(r.divergences).toEqual([]);
    expect(r.members[0]!.stream).toBe('https://alice.example/stream/alpha');
  });

  it('a duplicate alongside a REAL fork still reports the true head count', () => {
    // Deduplicating must not mask the thing the channel exists for.
    const r = fold({
      grants: [
        grant({ head: 'https://conv.test/gA', role: `${P}#Convener` }),
        grant({ head: 'https://conv.test/gA', role: `${P}#Convener` }),
        grant({ head: 'https://conv.test/gB', role: `${P}#Observer` }),
      ],
      acceptances: [accept({ accepts: 'https://conv.test/gA' })],
    });
    expect(r.divergences).toHaveLength(1);
    expect(r.divergences[0]!.heads).toEqual(['https://conv.test/gA', 'https://conv.test/gB']);
    expect(r.divergences[0]!.note).toMatch(/^2 concurrent grant heads/);
    expect(may(r, alice, cap('grant'))).toBe(false); // still Convener ∩ Observer
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

  it('★ a divergence note may not assert a resolution that did not happen', () => {
    // The grant note was pushed BEFORE the revocation check and the acceptance note before
    // the withdrawal check, so both described an outcome for a principal who had just been
    // removed entirely: "the intersection of their capabilities applies" over an empty
    // members list, and "the member is included" for somebody who had left. An operator
    // reading either goes to repair a live member's authority, and there is no live member.
    const revokedFork = fold({
      grants: [
        grant({ head: 'https://conv.test/gA', role: `${P}#Convener` }),
        grant({ head: 'https://conv.test/gB', role: `${P}#Observer`, revoked: true }),
      ],
      acceptances: [accept({ accepts: 'https://conv.test/gA' })],
    });
    expect(revokedFork.members).toHaveLength(0);
    expect(revokedFork.divergences[0]!.note).toMatch(/No intersection applies/);
    expect(revokedFork.divergences[0]!.note).not.toMatch(/intersection of their capabilities applies/);

    const withdrawnFork = fold({
      acceptances: [
        accept({ head: 'https://alice.example/a1' }),
        accept({ head: 'https://alice.example/a2', withdrawn: true }),
      ],
    });
    expect(withdrawnFork.members).toHaveLength(0);
    expect(withdrawnFork.divergences[0]!.note).toMatch(/The member is NOT included/);
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

  it('★ names the FORK, not the role, when the grant chain has two heads', () => {
    // `member.role` is whichever head the profile declares first, so this said "holds
    // Convener, which does not permit grant" — Convener permits grant — and blamed Observer
    // when the rows arrived the other way round. An operator acting on either reason widens
    // the role, and the intersection across heads swallows the widening; the next move is to
    // widen both heads, which resolves a fork upwards on an authorization record.
    const forked = (roles: readonly string[]) => fold({
      grants: roles.map((role, i) => grant({ head: `https://conv.test/g${i}`, role })),
      acceptances: [accept({ accepts: 'https://conv.test/g0' })],
    });
    for (const order of [[`${P}#Convener`, `${P}#Observer`], [`${P}#Observer`, `${P}#Convener`]]) {
      const why = explain(forked(order), alice, cap('grant'));
      expect(why).toMatch(/2 concurrent grant heads/);
      expect(why).toMatch(/https:\/\/conv\.test\/g0, https:\/\/conv\.test\/g1/);
      expect(why).toMatch(/Republish a single clean head/);
      expect(why).not.toMatch(/does not permit/);
    }
  });

  it('★ …but NOT when the two heads name the SAME role — that fork is not the cause', () => {
    // The over-correction. The first fix took the fork branch for ANY grant fork, so two
    // heads both naming Observer produced "roles that may disagree … republish a single clean
    // head" for a refusal Observer would have produced on its own — and republishing changes
    // the answer by not one byte. The old bug named the role instead of the fork; that one
    // named the fork instead of the role. Same false cause, opposite direction.
    const r = fold({
      grants: [
        grant({ head: 'https://conv.test/g0', role: `${P}#Observer` }),
        grant({ head: 'https://conv.test/g1', role: `${P}#Observer` }),
      ],
      acceptances: [accept({ accepts: 'https://conv.test/g0' })],
    });
    expect(r.members[0]!.divergence!.kind).toBe('grant'); // the fork is still REPORTED
    const why = explain(r, alice, cap('append'));
    expect(why).not.toMatch(/Republish a single clean head/);
    expect(why).toMatch(/does not permit/);
  });

  it('an acceptance fork does NOT change the reason — there the role really is the limit', () => {
    // The ambiguity is in the stream, not the grant. Blaming it would send an operator to
    // repair a chain that is not broken, and hide a role that genuinely needs widening.
    const r = fold({
      grants: [grant({ role: `${P}#Observer` })],
      acceptances: [accept(), accept({ head: 'https://alice.example/a2' })],
    });
    expect(r.members[0]!.divergence!.kind).toBe('acceptance');
    expect(explain(r, alice, cap('append'))).toMatch(/holds .*Observer, which does not permit/);
  });

  it('a delegation ceiling still explains itself under a fork — the role there is honest', () => {
    // Both heads permit read, so naming a role is accurate; only the fall-through was wrong.
    const r = fold({
      grants: [
        grant({ head: 'https://conv.test/gA', role: `${P}#Convener` }),
        grant({ head: 'https://conv.test/gB', role: `${P}#Contributor` }),
      ],
      acceptances: [accept({ accepts: 'https://conv.test/gA' })],
      scopes: [{ principal: alice, capabilities: [] }],
    });
    expect(explain(r, alice, cap('read'))).toMatch(/ceiling, never a grant/);
  });

  it('distinguishes a non-member from an invitee', () => {
    expect(explain(fold(), 'https://nobody.test/#me', cap('read'))).toMatch(/is not a member/);
    expect(explain(fold({ acceptances: [] }), alice, cap('read'))).toMatch(/has not accepted/);
  });
});
