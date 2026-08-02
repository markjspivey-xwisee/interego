/**
 * Findings from an independent adversarial review of this layer, pinned so they stay fixed.
 *
 * Every case below was a live defect, found by a reviewer whose instructions were to
 * REFUTE the README's claims rather than confirm them. Three of them refuted a claim the
 * README stated as a property. That is the value of the exercise and the reason these
 * live in their own file: a defect found by an outside pass deserves a test that names
 * what was believed and what was actually true.
 *
 * The common shape: the existing suites' doubles could not express the failure. A double
 * that synthesises `describes` from the request cannot fail a `describes` filter; a double
 * that selects rows by pod alone cannot express "this entry is not on that pod". Coverage
 * measured against a double measures the double.
 */
import { describe, it, expect, vi } from 'vitest';
import { entryTurtle } from '../applications/shared-workspace/src/stream.js';
import {
  foldRoster, may,
  type Roster, type Grant, type Acceptance, type Attestation,
} from '../applications/shared-workspace/src/roster.js';
import { composeWorkspace, isUnder, describeCoverage, type ComposableMember } from '../applications/shared-workspace/src/compose.js';
import {
  authorizeView, scopesFromRegistry, signerIndexFromRegistry, CAPS,
  type RoleProfile, type RegisteredAgent,
} from '../applications/shared-workspace/src/can.js';
import type { StreamDeps } from '../applications/shared-workspace/src/stream.js';

const P = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default';
const WS = 'https://relay.test/ws/alpha';
const alice = 'https://alice.test/profile#me';
const bee = 'https://bee.test/profile#me';

const PROFILE: RoleProfile = {
  profile: P,
  roles: [
    { role: `${P}#Convener`, permits: [CAPS.read, CAPS.append, CAPS.grant, CAPS.revoke] },
    { role: `${P}#Contributor`, permits: [CAPS.read, CAPS.append] },
    { role: `${P}#Observer`, permits: [CAPS.read] },
  ],
};

// ── ★★ the invariant that kills the class, not the instance ──────────────────

/**
 * NO CONFIGURATION MAY GRANT MORE THAN A WEAKER ONE.
 *
 * The headline defect of the attestation round was the worst possible shape for a security
 * feature: turning the policy ON granted MORE authority than leaving it off. A revocation
 * whose attestation could not be verified was filtered out of the grant list before the
 * revocation check ran, so it was not refused — it was erased, and the member kept
 * everything. A transient `get_descriptor` failure silently reinstated a revoked member.
 *
 * A test for that one input would have passed the day after the fix and told nobody anything
 * about the next instance, and there were three more already present: a refused grant head
 * deleted the narrower half of an intersection and WIDENED a role; a refused withdrawal
 * retained a member who had left; a revoked signing key attested at the highest grade
 * because the same person had a second live agent.
 *
 * So the property is stated over the CONFIGURATION LATTICE rather than over an input, and
 * every case is enumerated. Four axes, each with an unambiguous weaker side:
 *
 *   A  attestation policy PRESENT ⊆ absent
 *   B  a signing key marked REVOKED ⊆ the same key live
 *   C  compose with verifyAuthorship TRUE ⊆ false
 *   D  requireContentBinding TRUE ⊆ false  (folded into AXIS A's lattice, not bolted beside)
 *
 * "⊆" is meant literally and is checked literally: every member of the stronger roster must
 * be a member of the weaker one, every effective capability of theirs must be present in the
 * weaker one, and every entry the stronger view admits must be admitted by the weaker one.
 * A configuration that refuses more is always fine; one that admits more is the defect,
 * whatever produced it.
 *
 * ★ WHAT THE ENUMERATION COULD NOT SEE, AND NOW CAN. Two more escalations were found by a
 * review, both invisible here for structural reasons rather than by bad luck:
 *
 *   — AXIS A generated exactly ONE acceptance per configuration. Every defect that needs two
 *     acceptance heads to disagree about was therefore unreachable, no matter how many
 *     attestation shapes were crossed. The `accepts` axis below generates zero, one and two,
 *     and the second head's attestation is varied independently of the first's.
 *   — `assertNoWiderThan` compared members, capabilities and pending invitations. It did not
 *     compare DIVERGENCES or the reported ROLE, so a stricter policy that deleted an
 *     ambiguity warning, or that widened the role LABEL while holding the capabilities, ran
 *     clean. Both are now part of the comparison: a warning is the opposite of a grant, so
 *     the stronger configuration must raise every one the weaker did, and the role it prints
 *     must not permit more than the role the weaker one printed.
 */
describe('★★ MONOTONICITY: no configuration grants more than a weaker one', () => {
  const CONV = 'https://conv.test/profile#me';
  const CONV_KEY = 'did:web:agents.test:conv-1';
  const ALICE_KEY = 'did:web:agents.test:alice-1';
  const STRANGER_KEY = 'did:web:agents.test:stranger';

  const registry = (aliceRevoked: boolean): { principal: string; agents: RegisteredAgent[] }[] => [
    { principal: CONV, agents: [{ did: CONV_KEY, scope: 'ReadWrite' }] },
    { principal: alice, agents: [
      { did: ALICE_KEY, scope: 'ReadWrite', revoked: aliceRevoked },
      // A SECOND, LIVE agent — without it the union narrows and the revocation is visible
      // through `scopesFromRegistry` alone. With it, the revoked key is the only evidence,
      // which is the shape that was admitted at the `attested` grade.
      { did: 'did:web:agents.test:alice-phone', scope: 'ReadWrite' },
    ] },
  ];
  const scopes = scopesFromRegistry(registry(false));

  const verified = (by: string): Attestation =>
    ({ authorshipVerified: true, signedBy: by, boundToDescriptor: true });

  /** Every shape an `Attestation` field can arrive in, including the ones that refuse. */
  const attestations: Record<string, Attestation | undefined> = {
    'signed-by-convener': verified(CONV_KEY),
    'signed-by-alice': verified(ALICE_KEY),
    'signed-by-stranger': verified(STRANGER_KEY),
    'no-attestation': undefined,
    'proof-did-not-verify': { authorshipVerified: false, signedBy: CONV_KEY, boundToDescriptor: true, reason: 'x' },
    'proof-not-bound': { authorshipVerified: true, signedBy: CONV_KEY, boundToDescriptor: false },
    // ── the content-binding axis ────────────────────────────────────────────
    // `verified()` above leaves `contentBinding` ABSENT, which is what an older relay
    // returns, so the six shapes above already cover the unreported case. These add the
    // four values the substrate can actually report, on a signer the convener policy
    // accepts — otherwise the signer check would refuse them first and the binding axis
    // would never be reached.
    'convener-content-bound': { authorshipVerified: true, signedBy: CONV_KEY, boundToDescriptor: true, contentBinding: 'bound' },
    'convener-content-declared': { authorshipVerified: true, signedBy: CONV_KEY, boundToDescriptor: true, contentBinding: 'declared' },
    'convener-content-unbound': { authorshipVerified: true, signedBy: CONV_KEY, boundToDescriptor: true, contentBinding: 'unbound' },
    // `mismatched` arrives with `authorshipVerified: false` and nothing else: a recomputed
    // digest that did not match also fails the signature-level verdict, so this is the shape
    // `readAttestation` actually produces. Enumerated with the real shape rather than a
    // convenient one, because a value that can only reach the fold alongside a false
    // `authorshipVerified` must be shown never to confer under ANY rung of the ladder.
    'convener-content-mismatched': { authorshipVerified: false, signedBy: CONV_KEY, boundToDescriptor: false, contentBinding: 'mismatched', reason: 'digest differs' },
  };
  const attKeys = Object.keys(attestations);

  const capsOf = (r: Roster): Map<string, Set<string>> =>
    new Map(r.members.map(m => [m.principal, new Set(m.effective)]));

  /** What the profile permits at a role — used to compare two role LABELS for width. */
  const permitCount = (role: string | undefined): number =>
    role === undefined ? -1 : (PROFILE.roles.find(r => r.role === role)?.permits.length ?? 0);

  /**
   * A divergence's identity for comparison purposes: its kind and the heads it names.
   * Compared as a set, so a warning cannot be silently swapped for a different one.
   */
  const divergenceKeys = (r: Roster): Set<string> =>
    new Set(r.divergences.map(d => `${d.kind}|${[...d.heads].sort().join(',')}`));

  /** `strong` must admit nothing `weak` withholds. The direction is the whole test. */
  const assertNoWiderThan = (strong: Roster, weak: Roster, label: string): void => {
    const weakCaps = capsOf(weak);
    for (const [principal, strongSet] of capsOf(strong)) {
      const weakSet = weakCaps.get(principal);
      expect(
        weakSet,
        `${label}: <${principal}> is a MEMBER under the stronger configuration and not under `
        + 'the weaker one — the stronger configuration granted membership the weaker withheld',
      ).toBeDefined();
      for (const capability of strongSet) {
        expect(
          weakSet!.has(capability),
          `${label}: <${principal}> has ${capability} under the stronger configuration and not `
          + 'under the weaker one — the stronger configuration granted a capability the weaker withheld',
        ).toBe(true);
      }
    }
    // A pending invitation confers nothing, but it must still have a source in the weaker
    // reading: a principal the weaker configuration has never heard of must not appear.
    const weakKnows = new Set([
      ...weak.members.map(m => m.principal),
      ...weak.pendingInvitations.map(p => p.principal),
    ]);
    for (const p of strong.pendingInvitations) {
      expect(weakKnows.has(p.principal), `${label}: <${p.principal}> is invited only under the stronger configuration`).toBe(true);
    }

    // ★ A WARNING IS THE OPPOSITE OF A GRANT, so it moves the other way: the stronger
    // configuration must not go quiet about a principal it still reports. Counting acceptance
    // heads off the conferring track let `requireContentBinding: true` DELETE the note that
    // a member's stream was ambiguous — while naming a different stream than the weaker
    // configuration had. Silence is the one thing a stricter setting must never buy.
    //
    // Scoped to principals both configurations still name. A principal whose every grant was
    // refused disappears from the stronger roster altogether and is accounted for in
    // `unattested`; warnings about a principal who is no longer there are not silence, and
    // demanding them would be demanding a report about nobody.
    const weakMembers = new Map(weak.members.map(m => [m.principal, m]));
    for (const m of strong.members) {
      const w = weakMembers.get(m.principal);
      if (w?.divergence === undefined) continue;
      expect(
        m.divergence !== undefined
        && m.divergence.kind === w.divergence.kind
        && [...m.divergence.heads].sort().join(',') === [...w.divergence.heads].sort().join(','),
        `${label}: <${m.principal}> carries divergence [${w.divergence.kind}|`
        + `${[...w.divergence.heads].sort().join(',')}] under the weaker configuration and `
        + `[${m.divergence ? `${m.divergence.kind}|${[...m.divergence.heads].sort().join(',')}` : 'none'}] `
        + 'under the stronger one — a stricter policy deleted or replaced a warning',
      ).toBe(true);
    }
    // The same rule at roster scope, and UNCONDITIONAL. Divergence reporting is a function
    // of the restricting track only, which no policy changes, so the two rosters must raise
    // the identical set — not merely a superset. Stated as a superset anyway, because that
    // is the direction that matters and it survives a future divergence kind that legitimately
    // depends on what was admitted.
    const strongDiv = divergenceKeys(strong);
    for (const d of divergenceKeys(weak)) {
      expect(
        strongDiv.has(d),
        `${label}: the weaker configuration reported divergence [${d}] and the stronger one `
        + 'did not — a stricter policy bought silence',
      ).toBe(true);
    }

    // ★ THE ROLE LABEL IS PART OF THE SECURITY OUTPUT. Capabilities can hold while the word
    // beside them escalates: heads {Observer, Convener} with the Observer head refused
    // reported `role: Convener` and `effective: [read]`. Nobody gained a permission and the
    // report still said the wrong thing, in the field a person reads first.
    const weakRole = new Map(weak.members.map(m => [m.principal, m.role]));
    for (const m of strong.members) {
      const weaker = weakRole.get(m.principal);
      if (weaker === undefined) continue; // membership itself is covered above
      expect(
        permitCount(m.role) <= permitCount(weaker),
        `${label}: <${m.principal}> is reported as ${m.role} under the stronger configuration `
        + `and ${weaker} under the weaker one — the stricter policy widened the role LABEL`,
      ).toBe(true);
    }
  };

  // ★ THE AXIS THE 1296-CONFIGURATION VERSION DID NOT HAVE. It generated exactly one
  // acceptance, so no amount of crossing attestation shapes could reach a defect that needs
  // two acceptance heads to disagree about — which is what re-picking `accepted[0]` and
  // deleting the ambiguity warning both were. `second` above adds a second GRANT; this adds
  // a second ACCEPTANCE, on its own stream, with its own attestation.
  const acceptShapes = ['one', 'none', 'two-second-refusable', 'two-second-bound'] as const;

  it('★ AXIS A — enumerating every grant × acceptance × revoked × withdrawn × second grant head × acceptance count', () => {
    let cases = 0;
    for (const gAtt of attKeys) {
      for (const aAtt of attKeys) {
        for (const revoked of [false, true]) {
          for (const withdrawn of [false, true]) {
            for (const second of ['none', 'narrower-head', 'wider-head', 'revoking-head'] as const) {
              for (const accepts of acceptShapes) {
              const grants: Grant[] = [{
                head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
                role: `${P}#Contributor`, revoked, attestation: attestations[gAtt],
              }];
              if (second !== 'none') {
                grants.push({
                  head: 'https://conv.test/g2', workspace: WS, grantedTo: alice,
                  role: second === 'wider-head' ? `${P}#Convener` : `${P}#Observer`,
                  ...(second === 'revoking-head' ? { revoked: true } : {}),
                  // The second head is deliberately UNATTESTED: refusing it is exactly the
                  // move that used to delete the narrower side of the intersection.
                });
              }
              const acceptances: Acceptance[] = accepts === 'none' ? [] : [{
                head: 'https://alice.test/a1', workspace: WS, member: alice,
                accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
                withdrawn, attestation: attestations[aAtt],
              }];
              if (accepts === 'two-second-refusable' || accepts === 'two-second-bound') {
                acceptances.push({
                  head: 'https://alice.test/a2', workspace: WS, member: alice,
                  accepts: 'https://conv.test/g1',
                  // A DIFFERENT stream, so re-picking the head is observable at all.
                  stream: 'https://alice.test/s2',
                  // Refusable = signed by a stranger, so every policy drops it and only the
                  // no-policy fold sees it. Bound = the shape every policy keeps. Between
                  // them the two heads change places under each rung of the ladder.
                  attestation: accepts === 'two-second-refusable'
                    ? verified(STRANGER_KEY)
                    : { authorshipVerified: true, signedBy: ALICE_KEY, boundToDescriptor: true, contentBinding: 'bound' },
                });
              }
              const args = { workspace: WS, profile: PROFILE, grants, acceptances, scopes };
              const label = `grant=${gAtt} accept=${aAtt} revoked=${revoked} withdrawn=${withdrawn} second=${second} accepts=${accepts}`;

              const off = foldRoster(args);
              const on = foldRoster({
                ...args,
                attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)) },
              });
              // ★ AXIS D, folded into the same enumeration rather than bolted on beside it:
              // requiring content binding is a THIRD rung on the same ladder, and the chain
              // bound ⊆ attested ⊆ asserted has to hold at every point of the lattice, not
              // just at the ones a separate test would have thought to sample.
              const onBound = foldRoster({
                ...args,
                attestation: {
                  convener: CONV,
                  signerOf: signerIndexFromRegistry(registry(false)),
                  requireContentBinding: true,
                },
              });
              expect(off.membershipGrade).toBe('asserted');
              expect(on.membershipGrade).toBe('attested');
              assertNoWiderThan(on, off, label);
              assertNoWiderThan(onBound, on, `require-binding ${label}`);
              assertNoWiderThan(onBound, off, `require-binding vs off ${label}`);

              // ★ A DIFFERENT STREAM IS ALLOWED; A SILENT ONE IS NOT. Naming the stream is a
              // conferring act, so a refused acceptance must not choose it — which means a
              // stricter policy CAN legitimately name a different stream than a weaker one.
              // What it may never do is name a different stream without saying the choice
              // was ambiguous. Asserted here rather than left to the prose, because the
              // divergence check above only proves the warning was not deleted, not that it
              // fires wherever the stream actually moves.
              // Read off the roster's own divergence list rather than `Member.divergence`,
              // which holds only ONE — `grantDivergence ?? acceptanceDivergence` — so a
              // principal with a forked grant AND a forked acceptance shows the grant and
              // hides the acceptance. Every configuration here concerns one principal, so
              // "the roster raised an acceptance divergence" is the same statement.
              const saysAmbiguous = (r: Roster): boolean => r.divergences.some(d => d.kind === 'acceptance');
              for (const strict of [on, onBound]) {
                for (const m of strict.members) {
                  const loose = off.members.find(x => x.principal === m.principal);
                  if (loose === undefined || loose.stream === m.stream) continue;
                  expect(
                    saysAmbiguous(strict) && saysAmbiguous(off),
                    `${label}: <${m.principal}> is given stream ${m.stream} under the stricter `
                    + `configuration and ${loose.stream} under the weaker one, and at least one `
                    + 'of the two did not report the choice as ambiguous',
                  ).toBe(true);
                }
              }
              cases++;
              }
            }
          }
        }
      }
    }
    // Guard the guard: an enumeration that silently stopped generating would pass vacuously.
    expect(cases).toBe(attKeys.length * attKeys.length * 2 * 2 * 4 * acceptShapes.length);
  });

  // A lattice assertion passes trivially where the rungs never differ. These name the two
  // configurations the acceptance-count axis exists to reach, and assert the differences are
  // the ones the fold is supposed to have — so a future change that makes the axis inert
  // fails here rather than passing 5184 vacuous subset checks.
  it('★ the acceptance-count axis is not vacuous — two heads really do change the outcome', () => {
    const args = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
        role: `${P}#Contributor`, attestation: verified(CONV_KEY),
      }],
      acceptances: [
        // First head refusable under any policy, second head good — so the conferring track
        // sees BOTH without a policy and only the SECOND with one.
        { head: 'https://alice.test/a1', workspace: WS, member: alice, accepts: 'https://conv.test/g1', stream: 'https://alice.test/s1', attestation: verified(STRANGER_KEY) },
        { head: 'https://alice.test/a2', workspace: WS, member: alice, accepts: 'https://conv.test/g1', stream: 'https://alice.test/s2', attestation: verified(ALICE_KEY) },
      ],
    };
    const off = foldRoster(args);
    const on = foldRoster({ ...args, attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)) } });

    // The stream really does move — this is the case the reviewer reproduced.
    expect(off.members[0]!.stream).toBe('https://alice.test/s1');
    expect(on.members[0]!.stream).toBe('https://alice.test/s2');
    // …and BOTH sides now say the choice was ambiguous. Before, the stricter side went
    // silent: `acceptanceHeads` was counted off the conferring track, so refusing a head
    // removed the evidence that there had ever been two.
    expect(off.divergences.filter(d => d.kind === 'acceptance')).toHaveLength(1);
    expect(on.divergences.filter(d => d.kind === 'acceptance')).toHaveLength(1);
    expect(on.divergences.find(d => d.kind === 'acceptance')!.heads)
      .toEqual(['https://alice.test/a1', 'https://alice.test/a2']);
  });

  it('★ the reported ROLE does not widen when a head is refused', () => {
    const args = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [
        // Observer head unattested-for-binding, Convener head fully bound. Requiring binding
        // refuses the Observer head — and used to promote the LABEL to Convener while the
        // capability intersection stayed at the Observer's `[read]`.
        { head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Observer`, attestation: { authorshipVerified: true, signedBy: CONV_KEY, boundToDescriptor: true, contentBinding: 'unbound' as const } },
        { head: 'https://conv.test/g2', workspace: WS, grantedTo: alice, role: `${P}#Convener`, attestation: { authorshipVerified: true, signedBy: CONV_KEY, boundToDescriptor: true, contentBinding: 'bound' as const } },
      ],
      acceptances: [{
        head: 'https://alice.test/a1', workspace: WS, member: alice,
        // Accepts the head that SURVIVES the binding policy, so the member exists under both
        // configurations and the comparison is about the label rather than about membership.
        accepts: 'https://conv.test/g2', stream: 'https://alice.test/s',
        attestation: { authorshipVerified: true, signedBy: ALICE_KEY, boundToDescriptor: true, contentBinding: 'bound' as const },
      }],
    };
    const loose = foldRoster({ ...args, attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)) } });
    const strict = foldRoster({ ...args, attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)), requireContentBinding: true } });
    expect(loose.members[0]!.role).toBe(`${P}#Observer`);
    expect(strict.members[0]!.role).toBe(`${P}#Observer`);
    // The capabilities were always right; it was the word beside them that escalated.
    expect(strict.members[0]!.effective).toEqual(loose.members[0]!.effective);
  });

  it('★ AXIS B — marking a signing key REVOKED never widens anything', () => {
    for (const gAtt of attKeys) {
      for (const aAtt of attKeys) {
        const args = {
          workspace: WS, profile: PROFILE, scopes,
          grants: [{
            head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
            role: `${P}#Contributor`, attestation: attestations[gAtt],
          }],
          acceptances: [{
            head: 'https://alice.test/a1', workspace: WS, member: alice,
            accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
            attestation: attestations[aAtt],
          }],
        };
        const live = foldRoster({ ...args, attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)) } });
        const dead = foldRoster({ ...args, attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(true)) } });
        assertNoWiderThan(dead, live, `revoked-key grant=${gAtt} accept=${aAtt}`);
      }
    }
  });

  it('★ AXIS B is not vacuous — the revoked key really does change an outcome', () => {
    // A subset assertion passes trivially if the two sides are always identical. This is the
    // case where they are not: alice's acceptance signed by the key that was withdrawn.
    const args = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
        role: `${P}#Contributor`, attestation: verified(CONV_KEY),
      }],
      acceptances: [{
        head: 'https://alice.test/a1', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
        attestation: verified(ALICE_KEY),
      }],
    };
    expect(foldRoster({ ...args, attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)) } }).members).toHaveLength(1);
    const dead = foldRoster({ ...args, attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(true)) } });
    expect(dead.members).toHaveLength(0);
    expect(dead.unattested[0]!.because).toMatch(/REVOKED/);
  });

  it('★ AXIS C — verifyAuthorship: true admits no entry that `false` withholds', async () => {
    const url = 'https://alice.test/c/1.ttl';
    const members: ComposableMember[] = [
      { principal: alice, stream: 'https://alice.test/s', podUrl: 'https://alice.test/' },
    ];
    const rows = { 'https://alice.test/': [{ url, at: '2026-08-01T10:00:00Z' }] };
    // Every answer `get_descriptor` can give, including the ones that should withhold.
    const descriptors: Record<string, Record<string, unknown>> = {
      'signed-and-bound': { url, turtle: '<> iep:authorshipProof [ iep:descriptorId <urn:iep:u-alice:1> ] .', authorship: { authorshipVerified: true, signedBy: ALICE_KEY } },
      'signed-by-someone-else': { url, turtle: '<> iep:authorshipProof [ iep:descriptorId <urn:iep:u-alice:1> ] .', authorship: { authorshipVerified: true, signedBy: CONV_KEY } },
      'proof-lifted': { url, turtle: '<> iep:authorshipProof [ iep:descriptorId <urn:iep:u-alice:999> ] .', authorship: { authorshipVerified: true, signedBy: ALICE_KEY } },
      'did-not-verify': { url, authorship: { authorshipVerified: false, signedBy: ALICE_KEY, reason: 'no' } },
      'no-authorship-block': { url, turtle: '<> a <urn:x> .' },
      'read-failed': { error: 'descriptor could not be retrieved' },
    };
    for (const [name, res] of Object.entries(descriptors)) {
      const d: StreamDeps = { ...deps(rows), getDescriptor: vi.fn(async () => res) };
      const off = await composeWorkspace({ workspace: WS, members }, d);
      const on = await composeWorkspace({
        workspace: WS, members, verifyAuthorship: true,
        signerOf: signerIndexFromRegistry(registry(false)),
      }, d);
      const admitted = new Set(off.entries.map(e => e.descriptorUrl));
      for (const e of on.entries) {
        expect(admitted.has(e.descriptorUrl), `${name}: verifyAuthorship admitted an entry the cheap read withheld`).toBe(true);
      }
      // and nothing may simply vanish: withheld entries are named, always
      expect(on.entries.length + on.unattested.reduce((n, u) => n + u.entries.length, 0))
        .toBe(off.entries.length);
    }
  });

  it('★ and the same at the enforcement point: authorizeView under the stronger roster', async () => {
    // The roster feeds `may()`, so a roster that granted more would admit more entries even
    // with the composition unchanged. Checked end to end rather than inferred from the fold.
    const url = 'https://alice.test/c/1.ttl';
    const d = deps({ 'https://alice.test/': [{ url, at: '2026-08-01T10:00:00Z' }] });
    const view = await composeWorkspace({ workspace: WS, members: [
      { principal: alice, stream: 'https://alice.test/s', podUrl: 'https://alice.test/' },
    ] }, d);
    const args = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`,
        attestation: verified(CONV_KEY),
      }],
      // an unattested revocation: erased by the old gate, honoured now
      acceptances: [
        { head: 'https://alice.test/a1', workspace: WS, member: alice, accepts: 'https://conv.test/g1', stream: 'https://alice.test/s', attestation: verified(ALICE_KEY) },
        { head: 'https://alice.test/a2', workspace: WS, member: alice, accepts: 'https://conv.test/g1', stream: 'https://alice.test/s', withdrawn: true },
      ],
    };
    const off = authorizeView(view, foldRoster(args));
    const on = authorizeView(view, foldRoster({
      ...args, attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)) },
    }));
    expect(off.entries).toHaveLength(0); // withdrawn, so nothing counts
    expect(on.entries).toHaveLength(0);  // and turning the policy on must not resurrect it
    expect(on.disallowed).toHaveLength(1);
  });

  it('★★ CONTENT BINDING DOES NOT NARROW THE MANUFACTURED PARTICIPANT, and the fold says so', () => {
    // ★ THE CLAIM MOST AT RISK OF BEING OVER-READ once binding exists. Every field of Grant
    // and Acceptance is typed by the CALLER, and the proof covers none of them. A review
    // handed the fold one of a member's ordinary signed log entries as their acceptance and
    // got an attested member who had never heard of the workspace.
    //
    // Requiring content binding does not touch that attack, and this case is built to prove
    // it rather than to assert it: alice's record is marked `contentBinding: 'bound'`,
    // because it genuinely IS her unmodified record — the strongest attestation the
    // substrate can produce — and she still becomes a member of a workspace she never
    // joined. Binding the bytes cannot help when the lie is in which record was submitted.
    const contentBound = (by: string): Attestation =>
      ({ authorshipVerified: true, signedBy: by, boundToDescriptor: true, contentBinding: 'bound' });
    const r = foldRoster({
      workspace: WS, profile: PROFILE, scopes,
      grants: [{ head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`, attestation: contentBound(CONV_KEY) }],
      acceptances: [{
        // ★ NOT an acceptance. One of alice's ordinary published entries, genuinely signed,
        // genuinely bound to its own descriptor, and now genuinely content-bound as well.
        head: 'https://alice.test/c/some-ordinary-entry.ttl', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s', attestation: contentBound(ALICE_KEY),
      }],
      attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)), requireContentBinding: true },
    });
    expect(r.members).toHaveLength(1);              // the strictest policy still permits it
    expect(r.recordContentBinding).toBe('bound');   // the bytes really were verified...
    expect(r.recordFieldBinding).toBe('unbound');   // ...and the fields still were not
    expect(r.attributionNote).toMatch(/CALLER TYPED IT/);
    expect(r.attributionNote).toMatch(/content binding does not reduce it/);
  });

  it('the fold reports content binding as ENFORCED, never as merely observed', () => {
    // ★ `recordContentBinding` is a statement about the CHECK, not about the inputs. Records
    // that happen to arrive bound under a policy that never demanded it were not verified by
    // this fold, and reporting 'bound' off the back of them would be the same substitution
    // — data standing in for a guarantee — that the substrate was making.
    const bound = (by: string): Attestation =>
      ({ authorshipVerified: true, signedBy: by, boundToDescriptor: true, contentBinding: 'bound' });
    const args = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{ head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`, attestation: bound(CONV_KEY) }],
      acceptances: [{
        head: 'https://alice.test/a1', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s', attestation: bound(ALICE_KEY),
      }],
    };
    const signerOf = signerIndexFromRegistry(registry(false));
    expect(foldRoster({ ...args, attestation: { convener: CONV, signerOf } }).recordContentBinding).toBe('unbound');
    expect(foldRoster({ ...args, attestation: { convener: CONV, signerOf, requireContentBinding: true } }).recordContentBinding).toBe('bound');
    expect(foldRoster(args).recordContentBinding).toBe('unbound');
  });

  it('★ an UNBOUND or DECLARED record is refused when binding is required — and not called a forgery', () => {
    const shapes: [string, Attestation, RegExp][] = [
      ['unbound', { authorshipVerified: true, signedBy: ALICE_KEY, boundToDescriptor: true, contentBinding: 'unbound' }, /no content digest at all/],
      ['declared', { authorshipVerified: true, signedBy: ALICE_KEY, boundToDescriptor: true, contentBinding: 'declared' }, /nothing was checked against it/],
      // A relay too old to report the field must not pass the gate by omission.
      ['absent', { authorshipVerified: true, signedBy: ALICE_KEY, boundToDescriptor: true }, /no content digest at all/],
    ];
    for (const [label, att, why] of shapes) {
      const r = foldRoster({
        workspace: WS, profile: PROFILE, scopes,
        grants: [{ head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`, attestation: { authorshipVerified: true, signedBy: CONV_KEY, boundToDescriptor: true, contentBinding: 'bound' } }],
        acceptances: [{ head: 'https://alice.test/a1', workspace: WS, member: alice, accepts: 'https://conv.test/g1', stream: 'https://alice.test/s', attestation: att }],
        attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)), requireContentBinding: true },
      });
      expect(r.members, `${label} must not confer membership`).toHaveLength(0);
      const refusal = r.unattested.find(u => u.kind === 'acceptance');
      expect(refusal, `${label} must be listed, never silently dropped`).toBeDefined();
      expect(refusal!.because).toMatch(why);
      // ★ The refusal must not read as an ACCUSATION: the overwhelming majority of these
      // are records that predate content binding, not tampering, and the sibling branch
      // above this one in `refuseAttestation` had to be rewritten once already for calling
      // a record's real author a forger in the one channel operators are told to watch.
      // Asserting the absence of the words would be satisfied by a bare "refused", so what
      // is pinned is the presence of the exculpation.
      expect(refusal!.because).not.toMatch(/\bforg(?:ed|ery)\b|\bwas tampered\b/i);
      expect(refusal!.because).toMatch(/not evidence|it is intact|says nothing about/i);
    }
  });
});

describe('★ extraTriples was raw-interpolated below a docstring promising it was escaped', () => {
  // The reviewer produced a well-formed document carrying a top-level
  // `<victim> acl:agent <did:web:attacker> .` through extraTriples. It parsed, so the
  // publish shape gate accepted it — an authorization triple about a third party,
  // written by string concatenation, inside somebody's workspace entry.
  const attack = 'dct:source <https://x.test/a> .\n<https://victim.test/#me> '
    + '<http://www.w3.org/ns/auth/acl#agent> <did:web:attacker>';

  it('a fragment carrying a statement terminator is REFUSED', () => {
    expect(() => entryTurtle({
      entryIri: `${WS}/s/e/0`, workspace: WS, seq: 0, draft: { extraTriples: [attack] },
    })).toThrow(/more than one line/);
  });

  it('...and so is a trailing terminator, which ends the subject just as effectively', () => {
    expect(() => entryTurtle({
      entryIri: `${WS}/s/e/0`, workspace: WS, seq: 0, draft: { extraTriples: ['dct:source <https://x.test/a> .'] },
    })).toThrow();
  });

  it('...and a @prefix directive', () => {
    expect(() => entryTurtle({
      entryIri: `${WS}/s/e/0`, workspace: WS, seq: 0, draft: { extraTriples: ['@prefix evil: <https://x.test/> '] },
    })).toThrow();
  });

  it('but an ordinary predicate-object pair still works — the point of the field', () => {
    const ttl = entryTurtle({
      entryIri: `${WS}/s/e/0`, workspace: WS, seq: 0,
      draft: { extraTriples: ['dct:source <https://foxxi.test/course/9>'] },
    });
    expect(ttl).toContain('dct:source <https://foxxi.test/course/9>');
    // Exactly one statement in the document: the entry's own.
    expect(ttl.split('\n').filter(l => /^<https/.test(l))).toHaveLength(1);
  });
});

describe('★ a duplicate delegated scope silently last-won — order decided authority', () => {
  // Through the documented builder: [{alice, ReadOnly}, {alice, ReadWrite}] gave alice
  // append AND revoke; reversed, neither; divergences empty both times. Two rows for one
  // principal is not exotic — a federated composer reads one registry per pod, so it
  // produces one row per (principal, pod).
  const rosterWith = (order: ('ReadOnly' | 'ReadWrite')[]) => foldRoster({
    workspace: WS, profile: PROFILE,
    grants: [{ head: 'https://c.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Convener` }],
    acceptances: [{
      head: 'https://alice.test/a1', workspace: WS, member: alice,
      accepts: 'https://c.test/g1', stream: 'https://alice.test/s',
    }],
    scopes: scopesFromRegistry(order.map(scope => ({ principal: alice, agents: [{ scope }] }))),
  });

  it('★ the INTERSECTION applies, whichever order the rows arrive in', () => {
    for (const order of [['ReadOnly', 'ReadWrite'], ['ReadWrite', 'ReadOnly']] as const) {
      const r = rosterWith([...order]);
      expect(may(r, alice, CAPS.append)).toBe(false);
      expect(may(r, alice, CAPS.revoke)).toBe(false);
      expect(may(r, alice, CAPS.read)).toBe(true);
    }
  });

  it('★ and the duplicate is REPORTED, so it can be resolved rather than tolerated', () => {
    const r = rosterWith(['ReadOnly', 'ReadWrite']);
    expect(r.divergences.some(d => d.kind === 'scope')).toBe(true);
    expect(r.divergences.find(d => d.kind === 'scope')!.note).toMatch(/INTERSECTION/);
  });

  it('a single row is unaffected — the union WITHIN a row still holds', () => {
    const [s] = scopesFromRegistry([{
      principal: alice, agents: [{ scope: 'ReadOnly' }, { scope: 'PublishOnly' }],
    }]);
    expect(s!.capabilities).toContain(CAPS.append);
  });
});

describe('★ the SAME defect two lines above the fix: a role declared twice in a profile', () => {
  // `const permitsOf = new Map(profile.roles.map(...))` sat directly above the intersect-and-
  // report loop built for the scope rows, and silently last-won in exactly the same way. A
  // profile declaring `#Observer` narrow then wide gave the Observer append, grant AND
  // revoke; reversed, none of the three; `divergences` was empty both ways and `explain()`
  // affirmed whichever answer came out. Order-dependent privilege in a PUBLISHED governance
  // document, decided by which triple a parser happened to emit last — and roles being data
  // is the property this whole layer is built on.
  const dup = (order: 'narrow-first' | 'wide-first'): RoleProfile => {
    const narrow = { role: `${P}#Observer`, permits: [CAPS.read] };
    const wide = { role: `${P}#Observer`, permits: [CAPS.read, CAPS.append, CAPS.grant, CAPS.revoke] };
    return { profile: P, roles: order === 'narrow-first' ? [narrow, wide] : [wide, narrow] };
  };
  const rosterWith = (order: 'narrow-first' | 'wide-first') => foldRoster({
    workspace: WS, profile: dup(order),
    grants: [{ head: 'https://c.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Observer` }],
    acceptances: [{
      head: 'https://alice.test/a1', workspace: WS, member: alice,
      accepts: 'https://c.test/g1', stream: 'https://alice.test/s',
    }],
    scopes: scopesFromRegistry([{ principal: alice, agents: [{ scope: 'ReadWrite' }] }]),
  });

  it('★ the INTERSECTION applies, whichever order the declarations arrive in', () => {
    for (const order of ['narrow-first', 'wide-first'] as const) {
      const r = rosterWith(order);
      expect(r.members[0]!.effective).toEqual([CAPS.read]);
      expect(may(r, alice, CAPS.revoke)).toBe(false);
    }
  });

  it('★ and the duplicate declaration is REPORTED against the profile that carries it', () => {
    const r = rosterWith('narrow-first');
    const d = r.divergences.find(x => x.kind === 'role');
    expect(d).toBeDefined();
    expect(d!.heads).toEqual([P]); // the profile IRI: where the operator has to go and fix it
    expect(d!.note).toMatch(/declared more than once/);
  });
});

// ── attribution ─────────────────────────────────────────────────────────────

const deps = (byPod: Record<string, { url: string; at: string }[]>): StreamDeps => ({
  publish: vi.fn(),
  discover: vi.fn(async (args: Record<string, unknown>) => ({
    entries: (byPod[String(args.pod_url)] ?? []).map(e => ({
      descriptorUrl: e.url, cid: `c${e.url.slice(-8)}`, validFrom: e.at,
      supersedes: [], describes: [String(args.graph_iri)],
    })),
  })),
});

describe('★ entry.principal was a LABEL, not a fact about who wrote the entry', () => {
  // The escalation the reviewer built: a member's acceptance names their stream IRI, and
  // nothing required that IRI to be under their own authority. Point it at somebody
  // else's pod and their entries were folded in ATTRIBUTED TO YOU — an Observer's writes
  // laundered into a Contributor's, and with the recommended pre-filter the Observer's
  // own pod is never read, so nothing was even reported as disallowed.
  const roster = foldRoster({
    workspace: WS, profile: PROFILE,
    grants: [
      { head: 'https://c.test/ga', workspace: WS, grantedTo: alice, role: `${P}#Contributor` },
      { head: 'https://c.test/gb', workspace: WS, grantedTo: bee, role: `${P}#Observer` },
    ],
    acceptances: [
      // ★ alice's acceptance names a stream on BEE's pod.
      { head: 'https://alice.test/a', workspace: WS, member: alice, accepts: 'https://c.test/ga', stream: 'https://bee.test/ws/stream' },
      { head: 'https://bee.test/a', workspace: WS, member: bee, accepts: 'https://c.test/gb', stream: 'https://bee.test/ws/stream' },
    ],
    scopes: scopesFromRegistry([alice, bee].map(p => ({ principal: p, agents: [{ scope: 'ReadWrite' }] }))),
  });

  // alice's pod established INDEPENDENTLY — from what is known of her, not from the
  // stream she claimed. That independence is the whole basis of the check.
  const honest: ComposableMember[] = [
    { principal: alice, stream: 'https://bee.test/ws/stream', podUrl: 'https://alice.test/' },
    { principal: bee, stream: 'https://bee.test/ws/stream', podUrl: 'https://bee.test/' },
  ];
  const beeWrote = {
    'https://bee.test/': [{ url: 'https://bee.test/c/observer-wrote-this.ttl', at: '2026-08-01T10:00:00Z' }],
  };

  it('★ an entry served from another pod is WITHHELD, not attributed', async () => {
    // alice's pod is established independently, so reading bee's stream IRI against
    // alice's pod returns bee's record — which is not under alice's pod, and so is not
    // alice's entry however her acceptance was written.
    const view = await composeWorkspace({ workspace: WS, members: [honest[0]!] }, deps({
      'https://alice.test/': [{ url: 'https://bee.test/c/observer-wrote-this.ttl', at: '2026-08-01T10:00:00Z' }],
    }));
    expect(view.entries).toHaveLength(0);
    expect(view.misattributed).toHaveLength(1);
    expect(view.misattributed[0]!.descriptorUrls).toEqual(['https://bee.test/c/observer-wrote-this.ttl']);
    expect(view.complete).toBe(false);
    // "the member's own pod" is the claim; "the pod URL supplied for that member" is the
    // check. They are not the same sentence and the difference is the whole of H1.
    expect(describeCoverage(view)).toMatch(/outside the pod URL supplied for that member/);
  });

  it('the Observer write is no longer laundered into a Contributor entry', async () => {
    const view = authorizeView(await composeWorkspace({ workspace: WS, members: honest }, deps({
      'https://alice.test/': [{ url: 'https://bee.test/c/observer-wrote-this.ttl', at: '2026-08-01T10:00:00Z' }],
      'https://bee.test/': [{ url: 'https://bee.test/c/observer-wrote-this.ttl', at: '2026-08-01T10:00:00Z' }],
    })), roster);
    // bee wrote it and bee is an Observer, so it is not workspace content — and crucially
    // it is NOT simultaneously admitted under alice, which was the actual defect.
    expect(view.entries).toHaveLength(0);
  });

  it('★ a stream IRI is a logical name, so it is NOT range-checked against the pod', async () => {
    // The first attempt at this defence required member.stream to be under member.podUrl
    // and rejected every real member on the first live run: a graph IRI lives under the
    // relay's naming authority while its entries are stored on a pod. Conflating them is
    // a category error. Pinned so the wrong check does not come back.
    const view = await composeWorkspace({ workspace: WS, members: [
      { principal: alice, stream: 'https://relay.test/ns/o/ws/stream/alice', podUrl: 'https://alice.test/' },
    ] }, deps({ 'https://alice.test/': [{ url: 'https://alice.test/c/1.ttl', at: '2026-08-01T10:00:00Z' }] }));
    expect(view.entries).toHaveLength(1);
    expect(view.complete).toBe(true);
  });

  it('★ deriving the pod FROM the member\'s own claim is a tautology — containment cannot help', async () => {
    // If the caller asks the attacker where the attacker lives, containment answers yes. This
    // is the residue the pod check structurally cannot reach, and it stays pinned as the
    // reason the check below has to exist rather than being a nicety on top of it.
    const circular: ComposableMember[] = [
      { principal: alice, stream: 'https://bee.test/ws/stream', podUrl: 'https://bee.test/' },
    ];
    const view = await composeWorkspace({ workspace: WS, members: circular }, deps(beeWrote));
    expect(view.entries).toHaveLength(1);
    // ...and the view says the name on that entry is a label, not a fact.
    expect(view.attributionGrade).toBe('asserted');
  });

  it('★ and verifying authorship DOES reach it — the record names its own author', async () => {
    // The same tautological members list, one addition: the descriptor's own
    // iep:authorshipProof is read back and the signer traced. bee published it, bee's pod
    // serves it, bee's registry vouches for the signer — so it is not alice's entry however
    // the members list was assembled, and no pod URL was needed to find that out.
    const circular: ComposableMember[] = [
      { principal: alice, stream: 'https://bee.test/ws/stream', podUrl: 'https://bee.test/' },
    ];
    const url = 'https://bee.test/c/observer-wrote-this.ttl';
    const view = await composeWorkspace(
      {
        workspace: WS, members: circular, verifyAuthorship: true,
        signerOf: (s: string) => (s === 'did:web:bee-bot' ? bee : null),
      },
      {
        ...deps(beeWrote),
        getDescriptor: vi.fn(async () => ({
          url,
          turtle: '<> iep:authorshipProof [ iep:descriptorId <urn:iep:u-bee:observer-wrote-this> ] .',
          authorship: { authorshipVerified: true, signedBy: 'did:web:bee-bot' },
        })),
      },
    );
    expect(view.entries).toHaveLength(0);
    expect(view.unattested[0]!.entries[0]!.because).toMatch(new RegExp(`acts for ${bee}`));
    expect(view.complete).toBe(false);
  });

  it('a member\'s own entries on their own pod are unaffected', async () => {
    const own: ComposableMember = { principal: alice, stream: 'https://alice.test/s', podUrl: 'https://alice.test/' };
    const view = await composeWorkspace({ workspace: WS, members: [own] }, deps({
      'https://alice.test/': [{ url: 'https://alice.test/c/1.ttl', at: '2026-08-01T10:00:00Z' }],
    }));
    expect(view.entries).toHaveLength(1);
    expect(view.misattributed).toHaveLength(0);
    expect(view.complete).toBe(true);
  });
});

describe('isUnder — containment, not just origin', () => {
  it('★ shared-host pods do NOT contain each other', () => {
    // Every pod on this deployment is served by one CSS, so origin-only containment would
    // let any member claim any other member's entries. That is the same defect one level
    // weaker, and it is the version that would have survived a careless fix.
    expect(isUnder('https://css.test/u-bee/c/1.ttl', 'https://css.test/u-alice/')).toBe(false);
    expect(isUnder('https://css.test/u-alice/c/1.ttl', 'https://css.test/u-alice/')).toBe(true);
  });

  it('a missing trailing slash is not a bypass', () => {
    expect(isUnder('https://css.test/u-alice/c/1.ttl', 'https://css.test/u-alice')).toBe(true);
  });

  it('a prefix that is not a path segment does not count', () => {
    expect(isUnder('https://css.test/u-alice-evil/c/1.ttl', 'https://css.test/u-alice/')).toBe(false);
  });

  it('a different origin never contains', () => {
    expect(isUnder('https://elsewhere.test/u-alice/c/1.ttl', 'https://css.test/u-alice/')).toBe(false);
  });

  it('an unparseable URL is under nothing — refusing is the safe direction', () => {
    expect(isUnder('not a url', 'https://css.test/u-alice/')).toBe(false);
  });
});
