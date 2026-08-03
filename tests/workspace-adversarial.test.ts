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
  foldRoster, may, explain, refuseConvenerAuthority, refuseRoleProfileAuthority,
  refuseEvidenceProvenance,
  type Roster, type Grant, type Acceptance, type Attestation,
  type WorkspaceRecord, type ConvenerEvidence,
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
 * every case is enumerated. Six policy axes, each with an unambiguous weaker side, plus one
 * that asserts an INVARIANCE rather than an ordering:
 *
 *   A  attestation policy PRESENT ⊆ absent
 *   B  a signing key marked REVOKED ⊆ the same key live
 *   C  compose with verifyAuthorship TRUE ⊆ false
 *   D  requireContentBinding TRUE ⊆ false  (folded into AXIS A's lattice, not bolted beside)
 *   E  requireFieldBinding TRUE ⊆ requireContentBinding TRUE ⊆ …  (folded in the same way)
 *   F  the descriptor-binding BASIS changes nothing, at any rung  (`basisShapes`)
 *   G  the convener the WORKSPACE declares ⊆ the convener the CALLER named
 *   H  the role profile the WORKSPACE declares ⊆ the profile the CALLER folded against
 *   I  the record the workspace DEREFERENCES TO ⊆ a record about it the caller was handed
 *
 * ★ G AND H RIDE THE SAME EVIDENCE AND ARE STILL TWO AXES. One `wsp:Workspace` record answers
 * both questions — who may grant, and what a granted role permits — so there is no separate
 * policy flag to turn H on. What makes it an axis is the GENERATOR: `conveneShapes` moves the
 * declared convener and the declared profile ONE AT A TIME, so each field's verdict is
 * observed while the other agrees. Both must be crossed against the whole lattice, because a
 * refusal that fires at one rung and not another is exactly what the eleven-shape table below
 * found for the convener.
 *
 * ★ AXIS I IS THE ONE UNDER ALL OF THEM, AND IT HAS ITS OWN FLAG BECAUSE IT IS NOT A QUESTION
 * ABOUT THE RECORD. G and H both read a `wsp:Workspace` and compare a field; I asks whether
 * that record is the one `<WS>` DEREFERENCES TO. Measured live: a `wsp:Workspace` for alice's
 * workspace IRI, published by BEE on BEE'S pod naming herself convener, satisfies G and H
 * completely under a policy that names bee — the subject is a triple she chose. `sourceShapes`
 * generates the four states evidence can arrive in, three of them forged, so the rung has
 * something to refuse as well as something to admit; per-shape counters after the enumeration
 * assert each forgery actually took a member away.
 *
 * ★ AXIS F IS NOT AN ORDERING, AND THAT IS DELIBERATE. `exact-url` and `slug-only` are not a
 * strong and a weak policy — they are two answers the substrate gives about the SAME record,
 * and the decision this file pins is that no policy refuses on the difference. Requiring
 * `exact-url` would fail closed on 100% of honest records, because every `descriptor_id` the
 * relay mints is a `urn:`. Enumerated so that a future change gating on it goes red here,
 * naming the configuration, rather than being discovered by the first honest record refused.
 *
 * ★ AXIS E IS THE FIELD-BINDING RUNG, and it needed a second generator axis to be reachable
 * at all: a row either carries a `fieldProvenance` or it does not, and every configuration
 * the 6,400-case version produced carried none — so `requireFieldBinding: true` would have
 * refused everything and passed 6,400 vacuous subset checks. `provenanceShapes` below
 * generates the four states a row can be in (absent, matching, mismatched, unrecognised
 * source) so the rung has something to admit as well as something to refuse, and the
 * non-vacuity case after the enumeration asserts it really does admit.
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

  /**
   * ★ THE AXIS AXIS E NEEDED TO EXIST AT ALL. `fieldProvenance` is the only evidence
   * `requireFieldBinding` reads, and every row the previous enumeration built had none — so
   * the new rung would have refused all 6,400 configurations and every subset check would
   * have held on an empty set. These are the four states a row can arrive in: no provenance
   * (every hand-built caller), provenance naming this record (what `readGrantRecord`
   * produces), provenance naming a DIFFERENT record (a composer attaching one document's
   * parsed fields to another's row), and a source value the type says is impossible but JSON
   * can carry.
   */
  /**
   * ★ THE AXIS ADDED WITH `Attestation.descriptorBindingBasis`, AND IT ENUMERATES A DECISION
   * RATHER THAN A DEFECT.
   *
   * `proofBindsToDescriptorUrl` returns `{bound, basis}`; `stream.ts` used to collapse that to
   * `.bound` and throw the basis away, so `exact-url` (host, pod, container and name all
   * compared) and `slug-only` (one path segment compared, host never looked at) read
   * identically to everything downstream. The basis now travels with the boolean.
   *
   * The decision recorded here is that NO POLICY REFUSES ON IT — requiring `exact-url` would
   * fail closed on 100% of honest records, because every `descriptor_id` the relay mints is a
   * `urn:`. That is a claim about the fold's behaviour under every configuration, so it is
   * asserted under every configuration: the basis must make no difference to any roster, at
   * any rung. If a future change gates on it, this axis goes red and the change is made
   * deliberately rather than discovered by whichever record it refused.
   *
   * `undefined` is in the list because a hand-built {@link Attestation} carries no basis, and
   * absent must behave as the weak one rather than as the strong one.
   */
  const basisShapes = [undefined, 'slug-only', 'exact-url'] as const;

  const provenanceShapes = ['none', 'self', 'other-record', 'unknown-source'] as const;
  const provenanceOf = (shape: typeof provenanceShapes[number], head: string) => {
    switch (shape) {
      case 'none': return {};
      case 'self': return { fieldProvenance: { source: 'payload' as const, descriptor: head } };
      case 'other-record': return { fieldProvenance: { source: 'payload' as const, descriptor: 'https://elsewhere.test/x.ttl' } };
      case 'unknown-source': return { fieldProvenance: { source: 'trust-me' } as never };
    }
  };

  // ── ★ AXIS G — the convener the WORKSPACE declares ──────────────────────────

  const WS_RECORD = 'https://conv.test/workspace.ttl';
  const contentBound = (by: string): Attestation =>
    ({ authorshipVerified: true, signedBy: by, boundToDescriptor: true, contentBinding: 'bound' });

  /** A workspace record good enough to survive every rung, declaring whoever is named. */
  const workspaceRecord = (
    convener: string, signer: string,
    over: Partial<WorkspaceRecord> = {},
  ): WorkspaceRecord => ({
    head: WS_RECORD, workspace: WS, convener, roleProfile: P,
    attestation: contentBound(signer),
    fieldProvenance: { source: 'payload', descriptor: WS_RECORD },
    ...over,
  });

  /**
   * ★ THE GENERATOR AXIS THE CONVENER RUNG NEEDED, and it is AXIS E's lesson applied a second
   * time. A rung whose generated rows all AGREE with it refuses nothing and passes every
   * subset check on an untouched set; a rung whose rows all DISAGREE refuses everything and
   * passes every subset check on an empty one. Either way the assertions hold and the rung is
   * inert. So the declared convener varies, and both directions are counted during the
   * enumeration and asserted non-zero after it.
   *
   * ★★ `'names-another'` NAMES `alice`, AND THAT CHOICE IS THE WHOLE TEST. The obvious
   * implementation of this feature is `convener = workspaceRecord.convener ?? policy.convener`
   * — read the convener from the workspace and use it. Under that implementation, a policy
   * naming CONV plus a workspace naming ALICE would attest grants against ALICE, so every
   * configuration with `grant=signed-by-alice` would gain a member the same policy refuses
   * WITHOUT the evidence. Supplying evidence would grant more than withholding it, which is
   * the exact inversion this file exists to catch — and `attestations` already generates
   * `signed-by-alice`, so `assertNoWiderThan(onConvened, onFields)` reaches it. Naming a
   * principal no attestation is signed by would make the axis look complete and test nothing.
   *
   * The record itself is beyond reproach in both shapes — content-bound, self-provenanced,
   * signed by an agent the declared convener's own registry vouches for. Only the
   * disagreement refuses, which is the sharp version.
   */
  /**
   * ★★ AND THE THIRD SHAPE IS AXIS H — THE ROLE PROFILE, ONE FIELD OVER ON THE SAME RECORD.
   *
   * `wspsh:WorkspaceShape` requires a `wsp:roleProfile` beside the `wsp:convener`, and
   * `foldRoster` used to take its {@link RoleProfile} from its caller and never look. Measured
   * before the check existed: a roster reporting `convenerBinding: 'bound'`,
   * `recordFieldBinding: 'bound'` and an empty `unattested` gave an `#Observer` the `grant` and
   * `revoke` capabilities, because the caller folded against a profile document the workspace
   * never declared.
   *
   * ★ THE GENERATOR IS THE POINT, AND IT IS AXIS E'S AND AXIS G'S LESSON A THIRD TIME. Every
   * workspace record the two shapes above generate declares `P`, and the fold is always handed
   * `PROFILE` whose `.profile` is `P` — so a role-profile rung crossed against only those
   * shapes AGREES at all 76,800 points, refuses nothing, and passes vacuously. That has
   * happened twice in this file. `'declares-another-profile'` is what gives the rung something
   * to refuse, and `profileRefused` below counts that it did.
   *
   * ★★ AND EACH SHAPE MOVES EXACTLY ONE FIELD, WHICH IS WHAT MAKES THE TABLE AN ASSERTION
   * ABOUT INDEPENDENCE RATHER THAN A LIST OF REFUSALS. `'names-another'` keeps the declared
   * profile correct, so it must refuse the CONVENER and report the profile as `'bound'`;
   * `'declares-another-profile'` keeps the convener correct, so it must do the opposite. A
   * fold that answered one question with the other's verdict — the failure this file complains
   * about in every diagnostic it has ever fixed — cannot satisfy both rows.
   */
  const OTHER_PROFILE = 'https://rival.test/roles';
  const conveneShapes = ['agrees', 'names-another', 'declares-another-profile'] as const;
  const conveneEvidence: Record<typeof conveneShapes[number], ConvenerEvidence> = {
    agrees: { kind: 'declared', record: workspaceRecord(CONV, CONV_KEY) },
    'names-another': { kind: 'declared', record: workspaceRecord(alice, ALICE_KEY) },
    'declares-another-profile': {
      kind: 'declared', record: workspaceRecord(CONV, CONV_KEY, { roleProfile: OTHER_PROFILE }),
    },
  };
  /**
   * What each shape must produce, as `[convenerBinding, roleProfileBinding]`.
   *
   * ★ `'names-another'` IS `['refused','refused']` AND USED TO BE `['refused','bound']`. The
   * pair was a real reading — the record declares the profile the fold used — and it was
   * asserting something an unauthorised party controlled. A stranger's self-consistent record
   * naming the true `wsp:roleProfile` produced `roleProfileBinding: 'bound'`, whose contract is
   * "the governance these capabilities were computed under is the governance the workspace
   * publishes", and nothing about it had held up. No capability moved — both refusals sit in
   * the same `??` chain — so it was a claim to fix, not a hole.
   *
   * ★★ AND THE TABLE STILL DISCRIMINATES, which is the property it exists for and the one this
   * change had to be checked against rather than assumed past. `'declares-another-profile'` is
   * `['bound','refused']`, so a fold that answered both questions with the convener's verdict
   * gives `['bound','bound']` there and fails; one that answered both with the profile's gives
   * `['refused','refused']` there and fails. What is no longer distinguishable is
   * convener-wrong from convener-and-profile-wrong, and that is deliberate: when the record
   * came from the wrong party its profile IRI is not consulted at all.
   */
  const conveneVerdicts: Record<typeof conveneShapes[number], readonly ['bound' | 'refused', 'bound' | 'refused']> = {
    agrees: ['bound', 'bound'],
    'names-another': ['refused', 'refused'],
    'declares-another-profile': ['bound', 'refused'],
  };

  // ── ★ AXIS I — where the workspace evidence itself came from ────────────────

  /**
   * ★ THE GENERATOR RESIDUAL GAP 9 NEEDED, and it is AXIS E's, G's and H's lesson a FOURTH
   * time. `requireEvidenceProvenance` refuses evidence that is not the record `<WS>`
   * dereferences to. Crossed only against evidence that carries an honest
   * {@link EvidenceProvenance}, the rung agrees at all 76,800 points, refuses nothing, and
   * passes vacuously — which has now happened three times in this file, and the last time it
   * was caught only by a counter asserted after the loop. So the axis generates FORGED
   * provenance as well as honest, and `sourceRefused` below counts that each forgery actually
   * took a member away.
   *
   * The four shapes are the four states evidence can arrive in:
   *
   *   `none`          the residual-gap-9 shape itself, and the state EVERY caller written
   *                   before this flag is in — a record found at a descriptor URL the caller
   *                   chose. Measured live: bee's own `wsp:Workspace` for alice's workspace
   *                   IRI, on bee's pod, and the fold reported the convener as bound.
   *   `honest`        what `dereferenceWorkspaceRecord` produces: this workspace was
   *                   dereferenced and it resolved to this record.
   *   `other-iri`     a federated composer holding one workspace record per workspace it has
   *                   met, attaching the one it fetched for somewhere else to this roster.
   *                   Genuine record, genuine dereference, wrong workspace.
   *   `other-record`  the dereference resolved to one document and a different one was handed
   *                   in — the same shape `provenanceShapes`' `other-record` is one layer down,
   *                   which is the only mismatch here that is not self-certifying.
   */
  const sourceShapes = ['none', 'honest', 'other-iri', 'other-record'] as const;
  const sourcedEvidence = (shape: typeof sourceShapes[number]): ConvenerEvidence => {
    const record = workspaceRecord(CONV, CONV_KEY);
    switch (shape) {
      case 'none': return { kind: 'declared', record };
      case 'honest': return { kind: 'declared', record, provenance: { dereferenced: WS, resolvedTo: WS_RECORD } };
      case 'other-iri': return { kind: 'declared', record, provenance: { dereferenced: 'https://other.test/ws', resolvedTo: WS_RECORD } };
      case 'other-record': return { kind: 'declared', record, provenance: { dereferenced: WS, resolvedTo: 'https://elsewhere.test/x.ttl' } };
    }
  };

  /**
   * Everything a roster DECIDES, with the two fields that are supposed to differ left out.
   * Used to assert that agreeing evidence changes the REPORT and nothing else — the other
   * half of non-vacuity, and the half that catches a rung which quietly fails closed on
   * honest data.
   */
  const decisions = (r: Roster): string => JSON.stringify({
    members: r.members, pending: r.pendingInvitations,
    divergences: r.divergences, unattested: r.unattested,
  });

  /**
   * ★★ THE ENUMERATION BELOW BLOCKED THE WORKER AND TOOK THE WHOLE SUITE DOWN, AND THIS IS
   * WHY IT NOW AWAITS.
   *
   * AXIS A was a fully synchronous `it()`. Measured on this file alone: 66,847 ms in one
   * uninterrupted turn of the worker thread's event loop. vitest's worker talks to the main
   * process over birpc, whose request deadline is 60 s — `DEFAULT_TIMEOUT = 6e4` in
   * `vitest/dist/chunks/index.B521nVV-.js:3`. `onTaskUpdate` is a REQUEST, not one of the
   * three fire-and-forget `eventNames` in `chunks/rpc.-pEldfrD.js:41`, so the main process's
   * reply sat unread in the worker's message queue for the whole 66.8 s while the deadline
   * expired underneath it:
   *
   *   Error: [vitest-worker]: Timeout calling "onTaskUpdate"
   *     at Object.onTimeoutError node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
   *     at Timeout._onTimeout node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
   *
   * `vitest.config.ts` pins `singleThread`/`singleFork`, so all 185 files share that one
   * worker. Killing it mid-run produced the worst signal this repo has a name for:
   *
   *   Test Files  2 passed (185)
   *   Tests       169 passed (169)
   *
   * — 183 files never ran, 2,400-odd tests never executed, and the summary said "passed".
   * The same class of dead signal `tools/lint-gate.mjs` exists for (`eslint` exits 0 when it
   * lints nothing), reached from the other end: not a gate that never fires, a suite that
   * never runs.
   *
   * ★ AND IT IS A RACE, WHICH IS WHY THE FIX IS NOT "MAKE IT FASTER". The same command on the
   * same tree also passed clean at 181/185 on a quieter box — 66.8 s is close enough to the
   * 60 s deadline that machine load decides. A guard that reports the whole suite green or
   * one percent of it depending on what else is running is worse than one that always fails.
   *
   * ★ THE ENUMERATION IS NOT TRIMMED, AND THE 60 s DEADLINE IS NOT RAISED. Sampling the
   * lattice is how the 1,296-case version missed two escalations; buying responsiveness with
   * coverage is the trade the whole file exists to refuse. And raising the deadline would fix
   * this one test while leaving every future long synchronous loop free to do it again.
   * Yielding fixes the actual fault: a worker that cannot answer is a worker nobody can hear.
   *
   * {@link YIELD_EVERY} configurations per turn puts 300 yields across the lattice and keeps
   * the longest uninterrupted block between roughly 475 ms and 660 ms — measured, not budgeted,
   * and quoted as a RANGE because two runs of the same tree on the same box came in at 142,475
   * ms and 196,693 ms. Over 300 chunks that is 475 ms and 656 ms. Up from ~220 ms when there
   * were ten folds per configuration rather than eighteen. Against the 60 s deadline the worse
   * of the two still leaves a 91x margin on a single 256-case chunk, so this holds on a CI
   * runner far slower than this box rather than only on a fast one. The single figure that
   * stood here was the faster run, and this file's own rule about numbers that cannot be
   * distinguished from the noise applies to its own measurements first.
   *
   * ★ AND THAT MARGIN IS WHAT A NEW AXIS SPENDS, so it is written down in the same units the
   * next one will need. Adding a rung inside this loop multiplies the chunk, not the total: the
   * yield count is fixed at `cases / YIELD_EVERY`, so eighteen folds per configuration is
   * eighteen folds inside one uninterrupted turn. Lower {@link YIELD_EVERY} before the chunk
   * approaches the deadline; do not raise the deadline, and do not trim the lattice.
   *
   * The overhead is not quoted, because it could not be measured apart from the noise: three
   * runs of this file came in at 66.8 s (before), 72.4 s and 55.0 s (after). 300 returns
   * through the timers phase is arithmetically sub-second; run-to-run variance here is tens of
   * seconds, and a number that cannot be distinguished from the noise should not be written
   * down as if it had been.
   */
  const YIELD_EVERY = 256;

  /**
   * A MACROTASK, and a microtask will not do. `await Promise.resolve()` drains the microtask
   * queue without ever leaving the current turn, so the worker's port message — the reply
   * this test was killed for failing to read — is still not delivered. `setTimeout` returns
   * through the timers phase, which means the poll phase ran and the message queue drained.
   */
  const yieldToEventLoop = (): Promise<void> =>
    new Promise<void>(resolve => { setTimeout(resolve, 0); });

  it('★ AXIS A — enumerating every grant × acceptance × revoked × withdrawn × second grant head × acceptance count × field provenance × descriptor-binding basis × declared convener × declared role profile × evidence provenance', async () => {
    let cases = 0;
    // AXIS G's and AXIS H's non-vacuity counters. See the assertions after the loop.
    let conveneCases = 0, agreeAdmitted = 0, disagreeRefused = 0, profileRefused = 0;
    // AXIS I's, and they are counted PER FORGED SHAPE rather than in one total. A single
    // counter is satisfied by one shape doing all the refusing while the other two ride the
    // lattice untested — which is the vacuity this file keeps re-finding, one level finer.
    let sourceCases = 0, sourceAdmitted = 0;
    const sourceRefused: Record<string, number> = { none: 0, 'other-iri': 0, 'other-record': 0 };
    for (const gAtt of attKeys) {
      for (const aAtt of attKeys) {
        for (const revoked of [false, true]) {
          for (const withdrawn of [false, true]) {
            for (const second of ['none', 'narrower-head', 'wider-head', 'revoking-head'] as const) {
              for (const accepts of acceptShapes) {
              for (const prov of provenanceShapes) {
              for (const basis of basisShapes) {
              /** Every attestation in this configuration, re-stamped with the basis under test. */
              const at = (a: Attestation | undefined): Attestation | undefined =>
                (a === undefined || basis === undefined ? a : { ...a, descriptorBindingBasis: basis });
              const grants: Grant[] = [{
                head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
                role: `${P}#Contributor`, revoked, attestation: at(attestations[gAtt]),
                ...provenanceOf(prov, 'https://conv.test/g1'),
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
                withdrawn, attestation: at(attestations[aAtt]),
                ...provenanceOf(prov, 'https://alice.test/a1'),
              }];
              if (accepts === 'two-second-refusable' || accepts === 'two-second-bound') {
                acceptances.push({
                  head: 'https://alice.test/a2', workspace: WS, member: alice,
                  accepts: 'https://conv.test/g1',
                  // Always self-bound, so the second head can survive AXIS E while the first
                  // is refused by it — which is the pairing that makes the stream re-pick,
                  // the divergence report and the role label observable at this rung too.
                  fieldProvenance: { source: 'payload', descriptor: 'https://alice.test/a2' },
                  // A DIFFERENT stream, so re-picking the head is observable at all.
                  stream: 'https://alice.test/s2',
                  // Refusable = signed by a stranger, so every policy drops it and only the
                  // no-policy fold sees it. Bound = the shape every policy keeps. Between
                  // them the two heads change places under each rung of the ladder.
                  attestation: at(accepts === 'two-second-refusable'
                    ? verified(STRANGER_KEY)
                    : { authorshipVerified: true, signedBy: ALICE_KEY, boundToDescriptor: true, contentBinding: 'bound' }),
                });
              }
              const args = { workspace: WS, profile: PROFILE, grants, acceptances, scopes };
              const label = `grant=${gAtt} accept=${aAtt} revoked=${revoked} withdrawn=${withdrawn} second=${second} accepts=${accepts} prov=${prov} basis=${basis ?? 'absent'}`;

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
              // ★ AXIS E, the fourth rung, folded in the same way and for the same reason.
              // `requireFieldBinding` forces content binding on inside the fold, so this is
              // strictly above `onBound` on the ladder and the chain that must hold at every
              // point of the lattice is now fields ⊆ bound ⊆ attested ⊆ asserted.
              const onFields = foldRoster({
                ...args,
                attestation: {
                  convener: CONV,
                  signerOf: signerIndexFromRegistry(registry(false)),
                  requireFieldBinding: true,
                },
              });
              expect(off.membershipGrade).toBe('asserted');
              expect(on.membershipGrade).toBe('attested');
              // The report must track the enforcement at every rung, not just at the two the
              // dedicated cases sample.
              expect(off.recordFieldBinding).toBe('unbound');
              expect(onBound.recordFieldBinding).toBe('unbound');
              expect(onFields.recordFieldBinding).toBe('bound');
              // …and asking for fields must never leave content binding unreported as
              // enforced, because the fold turns it on regardless of what the caller passed.
              expect(onFields.recordContentBinding).toBe('bound');
              // ★ NONE OF THE FOUR RUNGS ABOVE PASSES WORKSPACE EVIDENCE, so all four must say
              // so. `'unchecked'` is not a default that can be reached by accident here: it is
              // the honest report that the convener every one of these rungs attested against
              // is a value this test typed, and a rung that started reporting `'bound'` off the
              // back of nothing would be the substrate's own substitution one layer up.
              for (const r of [off, on, onBound, onFields]) {
                expect(r.convenerBinding).toBe('unchecked');
                // The same rule at the newest field, and it is the one most likely to be got
                // wrong by accident: `profile` is always PRESENT — every rung above folds
                // against it — so a fold that reported the profile as checked merely because
                // it had one would read `'bound'` here, off the back of nothing compared.
                expect(r.roleProfileBinding).toBe('unchecked');
                // …and at the newest one of all. `'unchecked'` here is the residual-gap-9
                // state and it is what every caller written before the flag gets: nobody asked
                // whether the workspace record was the one the workspace answers with.
                expect(r.evidenceProvenanceBinding).toBe('unchecked');
              }
              assertNoWiderThan(on, off, label);
              assertNoWiderThan(onBound, on, `require-binding ${label}`);
              assertNoWiderThan(onBound, off, `require-binding vs off ${label}`);
              assertNoWiderThan(onFields, onBound, `require-fields ${label}`);
              assertNoWiderThan(onFields, on, `require-fields vs attested ${label}`);
              assertNoWiderThan(onFields, off, `require-fields vs off ${label}`);

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
              for (const strict of [on, onBound, onFields]) {
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
              // ★ AND THE BASIS CHANGES NOTHING, AT EVERY RUNG. This is the decision recorded
              // at `basisShapes`, asserted rather than argued: `slug-only` IS sufficient for
              // field binding, because requiring `exact-url` would fail closed on every record
              // the substrate mints. The roster under this configuration's basis must be
              // identical to the roster with no basis at all. A future change that gates on it
              // fails here — deliberately, with the exact configuration named — instead of
              // being discovered by whichever honest record it started refusing.
              if (basis !== undefined) {
                const strip = <T extends { attestation?: Attestation }>(rows: readonly T[]): T[] =>
                  rows.map(r => (r.attestation === undefined ? r : {
                    ...r,
                    attestation: Object.fromEntries(
                      Object.entries(r.attestation).filter(([k]) => k !== 'descriptorBindingBasis'),
                    ) as Attestation,
                  }));
                const bare = { ...args, grants: strip(grants), acceptances: strip(acceptances) };
                for (const [name, policy] of [
                  ['attested', { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)) }],
                  ['require-fields', { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)), requireFieldBinding: true }],
                ] as const) {
                  expect(
                    JSON.stringify(foldRoster({ ...bare, attestation: policy })),
                    `${label}: the descriptor-binding BASIS changed the ${name} roster. No policy `
                    + 'reads it — see `basisShapes` for why `exact-url` is not demanded — so if '
                    + 'that has deliberately changed, extend this axis rather than deleting it',
                  ).toBe(JSON.stringify(foldRoster({ ...args, attestation: policy })));
                }
              }

              // ★ AXIS G, THE FIFTH AND SIXTH RUNGS: the same field-bound policy, plus what the WORKSPACE
              // says about who convenes it. Built on top of `onFields` rather than beside it
              // because that is where it sits on the ladder — evidence can only ever refuse
              // more — so the chain the lattice must satisfy at every point is now
              // convened ⊆ fields ⊆ bound ⊆ attested ⊆ asserted.
              for (const convene of conveneShapes) {
                const onConvened = foldRoster({
                  ...args,
                  attestation: {
                    convener: CONV,
                    signerOf: signerIndexFromRegistry(registry(false)),
                    requireFieldBinding: true,
                    workspaceEvidence: conveneEvidence[convene],
                  },
                });
                const glabel = `convener=${convene} ${label}`;
                // ★ BOTH VERDICTS, EVERY TIME, AND THE TABLE IS WHAT MAKES THEM SEPARATE
                // FACTS. Asserting only the one a shape was written to move would let the
                // other drift onto it — a profile disagreement reported as a convener fault
                // sends an operator to republish a workspace record that names the right
                // convener, which changes nothing.
                expect(onConvened.convenerBinding, `${glabel}: convenerBinding`).toBe(conveneVerdicts[convene][0]);
                expect(onConvened.roleProfileBinding, `${glabel}: roleProfileBinding`).toBe(conveneVerdicts[convene][1]);
                // ★ AND PASSING EVIDENCE DOES NOT ANSWER THE THIRD QUESTION. This is the
                // distinction residual gap 9 is made of: `'unchecked'` here means nobody asked
                // where the record came from, and it must not become `'bound'` merely because
                // a record was supplied. Every one of these three shapes carries no
                // `EvidenceProvenance` at all, and two of the three are otherwise beyond
                // reproach — exactly the state bee's forged record arrives in.
                expect(onConvened.evidenceProvenanceBinding, `${glabel}: evidenceProvenanceBinding`).toBe('unchecked');
                assertNoWiderThan(onConvened, onFields, glabel);
                assertNoWiderThan(onConvened, off, `${glabel} vs off`);
                if (convene === 'agrees') {
                  // ★ THE OTHER HALF OF NON-VACUITY, AND THE ONE A SUBSET CHECK CANNOT SEE.
                  // A rung that refused everything would satisfy every ⊆ assertion above on an
                  // empty set — which is precisely how the 6,400-case version of AXIS E would
                  // have passed. Agreeing evidence must change the REPORT and nothing else, so
                  // the decisions are compared whole: same members, same invitations, same
                  // divergences, same refusals.
                  expect(decisions(onConvened), `${glabel}: agreeing evidence changed a decision`)
                    .toBe(decisions(onFields));
                  agreeAdmitted += onConvened.members.length;
                } else {
                  // A disagreement removes the power to make members — on EITHER field, since
                  // both refusals sit in the grant filter's `??` chain and nowhere else. It
                  // does NOT remove the records: see the revocation and withdrawal cases below
                  // the enumeration, which exist twice for that reason.
                  expect(onConvened.members, `${glabel}: a disagreeing ${convene} still conferred`).toHaveLength(0);
                  expect(onConvened.pendingInvitations, `${glabel}: a disagreeing ${convene} still invited`).toHaveLength(0);
                  if (onFields.members.length > 0) {
                    if (convene === 'declares-another-profile') profileRefused++; else disagreeRefused++;
                  }
                }
                conveneCases++;
              }

              // ★ AXIS I, THE SEVENTH RUNG: the same field-bound policy, the same agreeing
              // workspace record, and the question of whether that record is the one <WS>
              // DEREFERENCES TO. It sits above AXIS G and H on the ladder — evidence provenance
              // can only ever refuse more — so the chain the lattice must satisfy at every
              // point is now sourced ⊆ convened ⊆ fields ⊆ bound ⊆ attested ⊆ asserted.
              //
              // ★★ THE RECORD IS THE AGREEING ONE IN ALL FOUR SHAPES, AND ONLY ITS PROVENANCE
              // MOVES. That is what makes the two assertions below an independence claim rather
              // than three more refusals: the convener and profile answers must stay `'bound'`
              // while this one goes to `'refused'`. A fold that let a provenance refusal print
              // as a convener fault would send an operator to republish a workspace record that
              // is already correct — the standing complaint this file makes about every
              // diagnostic it has had to fix.
              for (const source of sourceShapes) {
                const onSourced = foldRoster({
                  ...args,
                  attestation: {
                    convener: CONV,
                    signerOf: signerIndexFromRegistry(registry(false)),
                    requireFieldBinding: true,
                    workspaceEvidence: sourcedEvidence(source),
                    requireEvidenceProvenance: true,
                  },
                });
                const slabel = `source=${source} ${label}`;
                expect(onSourced.evidenceProvenanceBinding, `${slabel}: evidenceProvenanceBinding`)
                  .toBe(source === 'honest' ? 'bound' : 'refused');
                expect(onSourced.convenerBinding, `${slabel}: a provenance verdict leaked into convenerBinding`).toBe('bound');
                expect(onSourced.roleProfileBinding, `${slabel}: a provenance verdict leaked into roleProfileBinding`).toBe('bound');
                assertNoWiderThan(onSourced, onFields, slabel);
                assertNoWiderThan(onSourced, off, `${slabel} vs off`);
                if (source === 'honest') {
                  // The half a subset check cannot see, for the reason AXIS G states it: a rung
                  // that refused everything satisfies every ⊆ assertion on an empty set. Honest
                  // provenance must change the REPORT and nothing else.
                  expect(decisions(onSourced), `${slabel}: honest provenance changed a decision`)
                    .toBe(decisions(onFields));
                  sourceAdmitted += onSourced.members.length;
                } else {
                  expect(onSourced.members, `${slabel}: forged provenance still conferred`).toHaveLength(0);
                  expect(onSourced.pendingInvitations, `${slabel}: forged provenance still invited`).toHaveLength(0);
                  if (onFields.members.length > 0) sourceRefused[source] = (sourceRefused[source] ?? 0) + 1;
                }
                sourceCases++;
              }
              cases++;
              // Hand the turn back so the worker can answer the main process. See
              // `YIELD_EVERY` above: without this the run reported 2 of 185 files as a pass.
              if (cases % YIELD_EVERY === 0) await yieldToEventLoop();
              }
              }
              }
            }
          }
        }
      }
    }
    // Guard the guard: an enumeration that silently stopped generating would pass vacuously.
    expect(cases).toBe(
      attKeys.length * attKeys.length * 2 * 2 * 4
      * acceptShapes.length * provenanceShapes.length * basisShapes.length,
    );
    expect(conveneCases).toBe(cases * conveneShapes.length);
    // ★ AND AXIS G IS NOT VACUOUS, COUNTED OVER THE WHOLE LATTICE RATHER THAN SAMPLED.
    //
    // Both numbers have to be non-zero or the 230,400 convener comparisons above establish
    // nothing. (230,400 = 76,800 × the three `conveneShapes`; the figure read 153,600 while
    // there were two, and stayed there when the third landed.)
    // `agreeAdmitted === 0` would mean the rung fails closed on every honest configuration —
    // a security feature that refuses everything passes every subset check ever written.
    // `disagreeRefused === 0` would mean no configuration ever had a member for the
    // disagreement to take away, so nothing was refused and the axis is decoration.
    expect(
      agreeAdmitted,
      'AXIS G admitted no member anywhere: agreeing workspace evidence refused every '
      + 'configuration in the lattice, so every subset assertion above held on an empty set',
    ).toBeGreaterThan(0);
    expect(
      disagreeRefused,
      'AXIS G refused nothing anywhere: no configuration had a member for a disagreeing '
      + 'convener to withhold, so the rung was never exercised in the refusing direction',
    ).toBeGreaterThan(0);
    // ★ AND AXIS H'S OWN COUNTER, WHICH IS THE WHOLE REASON `'declares-another-profile'`
    // EXISTS. `agreeAdmitted` already covers the admitting direction for both fields, because
    // `'agrees'` declares the profile the fold uses. Without this second counter a role-profile
    // rung whose generator only ever produced agreement would refuse nothing and still pass
    // every assertion in this test — which is exactly how AXIS E would have passed at 6,400
    // cases, and it is recorded here so a third instance is not written.
    expect(
      profileRefused,
      'AXIS H refused nothing anywhere: no configuration had a member for a disagreeing ROLE '
      + 'PROFILE to withhold, so the rung rode the whole lattice without ever being exercised '
      + 'in the refusing direction',
    ).toBeGreaterThan(0);
    // ★ AND AXIS I'S, WHICH ARE THE SHARPEST OF THE FOUR BECAUSE THE FORGERY IS THE POINT.
    //
    // `requireEvidenceProvenance` is satisfied by an `EvidenceProvenance` naming this workspace
    // and this record, so a generator that only ever produced honest ones would agree at all
    // 76,800 points and refuse nothing — the fourth instance of the shape this file has now
    // caught three times. `sourceAdmitted` says the rung does not fail closed on the honest
    // case; the three per-shape counters say each FORGERY actually took a member away, and are
    // separate because one shape doing all the refusing would leave the other two riding the
    // lattice untested behind a single non-zero total.
    expect(sourceCases).toBe(cases * sourceShapes.length);
    expect(
      sourceAdmitted,
      'AXIS I admitted no member anywhere: honest evidence provenance refused every '
      + 'configuration, so every subset assertion above held on an empty set',
    ).toBeGreaterThan(0);
    for (const shape of ['none', 'other-iri', 'other-record'] as const) {
      expect(
        sourceRefused[shape],
        `AXIS I shape '${shape}' refused nothing anywhere: no configuration had a member for `
        + 'this forged provenance to withhold, so the generator produced it and the rung never '
        + 'saw it. A shape that cannot refuse is decoration',
      ).toBeGreaterThan(0);
    }
    // 76,800 configurations × 18 subset comparisons (6 on the four original rungs, 2 more on
    // each of the three workspace-evidence shapes, 2 more on each of the four evidence-
    // provenance shapes), plus 2 basis-invariance comparisons on each of the two thirds that
    // carry a basis. The timeout is raised rather than the enumeration trimmed: every axis here
    // was added because a defect was unreachable without it, and sampling the lattice is how
    // the 1296-case version missed two escalations. A few minutes of CI is the cheaper side of
    // that trade — AXIS G's, H's and I's generators exist because a rung crossed against rows
    // that all agree with it is a rung that refuses nothing.
    //
    // ★ A FOURTH `conveneShape` (both fields wrong at once) IS DELIBERATELY NOT HERE. It would
    // multiply the lattice by a third again for one property — that the constant refusals
    // compose and that the convener is the one reported — and that property does not vary with
    // any axis this loop crosses. It is pinned once, below, in `both fields disagree`. AXIS I's
    // four shapes ride the lattice for the opposite reason: `requireEvidenceProvenance` is a
    // POLICY FLAG, so its interaction with every rung of the ladder is exactly the thing a
    // separate case would have to guess at.
  }, 600_000);

  it('★ AXIS E is not vacuous — field binding really does admit and really does refuse', () => {
    // A subset assertion over a rung that refuses EVERYTHING holds trivially, and that is
    // precisely the shape the 6,400-case version would have had: no row it generated carried
    // a `fieldProvenance`, so `requireFieldBinding: true` would have emptied every roster and
    // passed. Both directions are named here so a future change that makes the axis inert
    // fails on this case rather than passing 76,800 comparisons against an empty set.
    const bound = (by: string): Attestation =>
      ({ authorshipVerified: true, signedBy: by, boundToDescriptor: true, contentBinding: 'bound' });
    const base = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
        role: `${P}#Contributor`, attestation: bound(CONV_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://conv.test/g1' },
      }],
    };
    const acceptance = {
      head: 'https://alice.test/a1', workspace: WS, member: alice,
      accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
      attestation: bound(ALICE_KEY),
    };
    const policy = {
      convener: CONV, signerOf: signerIndexFromRegistry(registry(false)), requireFieldBinding: true,
    };

    // ADMITS: both halves parsed from their own records.
    const admitted = foldRoster({
      ...base,
      acceptances: [{ ...acceptance, fieldProvenance: { source: 'payload' as const, descriptor: acceptance.head } }],
      attestation: policy,
    });
    expect(admitted.members).toHaveLength(1);
    expect(admitted.recordFieldBinding).toBe('bound');

    // REFUSES: the identical membership with the acceptance's fields typed by the caller —
    // which is every acceptance that existed before `membership.ts`.
    const refused = foldRoster({ ...base, acceptances: [acceptance], attestation: policy });
    expect(refused.members).toHaveLength(0);
    expect(refused.unattested[0]!.because).toMatch(/typed by whoever called this fold/);

    // …and the rung below still admits it, so the difference is AXIS E's and nothing else's.
    expect(foldRoster({
      ...base, acceptances: [acceptance],
      attestation: { convener: CONV, signerOf: policy.signerOf, requireContentBinding: true },
    }).members).toHaveLength(1);
  });

  it('★ AXIS G is not vacuous — the declared convener really does admit and really does refuse', () => {
    // The AXIS E case one question further in. Two assertions and a control: agreeing evidence
    // must ADMIT, disagreeing evidence must REFUSE, and the rung below must admit both — or
    // the difference belongs to something other than the convener.
    const base = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
        role: `${P}#Contributor`, attestation: contentBound(CONV_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://conv.test/g1' },
      }],
      acceptances: [{
        head: 'https://alice.test/a1', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
        attestation: contentBound(ALICE_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://alice.test/a1' },
      }],
    };
    const policy = {
      convener: CONV, signerOf: signerIndexFromRegistry(registry(false)), requireFieldBinding: true,
    };

    // ADMITS: the workspace names the principal this policy names.
    const admitted = foldRoster({ ...base, attestation: { ...policy, workspaceEvidence: conveneEvidence.agrees } });
    expect(admitted.members).toHaveLength(1);
    expect(admitted.convenerBinding).toBe('bound');
    expect(admitted.attributionNote).toMatch(/CONVENER was checked against the workspace/);

    // REFUSES: the identical membership, with the workspace naming somebody else.
    const refused = foldRoster({ ...base, attestation: { ...policy, workspaceEvidence: conveneEvidence['names-another'] } });
    expect(refused.members).toHaveLength(0);
    expect(refused.convenerBinding).toBe('refused');
    expect(refused.unattested[0]!.because).toMatch(/The two disagree/);
    // …and the refusal explains itself as a policy fault rather than as an unanswered offer.
    expect(explain(refused, alice, CAPS.read)).toMatch(/disagree/);

    // …and the rung below still admits it, so the difference is AXIS G's and nothing else's.
    expect(foldRoster({ ...base, attestation: policy }).members).toHaveLength(1);
    expect(foldRoster({ ...base, attestation: policy }).convenerBinding).toBe('unchecked');
  });

  // ── ★ AXIS H, on its own, one question over from AXIS G ─────────────────────

  /** The genuine article at the strictest rung: both halves parsed, signed and content-bound. */
  const honestArgs = () => ({
    workspace: WS, profile: PROFILE, scopes,
    grants: [{
      head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
      role: `${P}#Contributor`, attestation: contentBound(CONV_KEY),
      fieldProvenance: { source: 'payload' as const, descriptor: 'https://conv.test/g1' },
    }],
    acceptances: [{
      head: 'https://alice.test/a1', workspace: WS, member: alice,
      accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
      attestation: contentBound(ALICE_KEY),
      fieldProvenance: { source: 'payload' as const, descriptor: 'https://alice.test/a1' },
    }],
  });
  const fieldBound = () => ({
    convener: CONV, signerOf: signerIndexFromRegistry(registry(false)), requireFieldBinding: true,
  });

  it('★ AXIS H is not vacuous — the declared role profile really does admit and really does refuse', () => {
    // AXIS G's case one field over, with the same three parts: agreeing evidence must ADMIT,
    // disagreeing evidence must REFUSE, and the rung below must admit both — or the difference
    // belongs to something other than the profile.
    const base = honestArgs();
    const policy = fieldBound();

    const admitted = foldRoster({ ...base, attestation: { ...policy, workspaceEvidence: conveneEvidence.agrees } });
    expect(admitted.members).toHaveLength(1);
    expect(admitted.roleProfileBinding).toBe('bound');
    expect(admitted.attributionNote).toMatch(/ROLE PROFILE was checked against the workspace/);

    const refused = foldRoster({
      ...base,
      attestation: { ...policy, workspaceEvidence: conveneEvidence['declares-another-profile'] },
    });
    expect(refused.members).toHaveLength(0);
    expect(refused.roleProfileBinding).toBe('refused');
    expect(refused.unattested[0]!.because).toMatch(/The two disagree/);
    expect(refused.unattested[0]!.because).toMatch(/rival\.test/);
    // ★ AND THE CONVENER IS STILL REPORTED AS BOUND, which is the half a table of refusals
    // cannot show. This record names the right convener; only the profile moved. A fold that
    // answered one question with the other's verdict would fail here and pass everything else.
    expect(refused.convenerBinding).toBe('bound');
    // …and the refusal explains itself as a governance fault rather than an unanswered offer.
    expect(explain(refused, alice, CAPS.read)).toMatch(/role profile/);

    // …and the rung below still admits it, so the difference is AXIS H's and nothing else's.
    const below = foldRoster({ ...base, attestation: policy });
    expect(below.members).toHaveLength(1);
    expect(below.roleProfileBinding).toBe('unchecked');
    expect(below.attributionNote).toMatch(/nothing checked that the role profile/);
  });

  it('★ AXIS H is the ESCALATION it looks like: the rogue profile grants what the declared one does not', () => {
    // ★ WHAT WAS ACTUALLY REACHABLE, measured before the check existed rather than argued from
    // the shape of the code. `permitsOf` is built from `args.profile`, so the caller's document
    // decides every capability in the roster — and the role IRIs are just strings, so a rival
    // profile can redeclare the DECLARED profile's own `#Observer` with `grant` and `revoke` on
    // it. The roster then reported `convenerBinding: 'bound'`, `recordFieldBinding: 'bound'`
    // and an empty `unattested` over an Observer who could revoke.
    const ROGUE: RoleProfile = {
      profile: OTHER_PROFILE,
      roles: [{ role: `${P}#Observer`, permits: [CAPS.read, CAPS.append, CAPS.grant, CAPS.revoke] }],
    };
    const args = {
      ...honestArgs(),
      profile: ROGUE,
      grants: [{ ...honestArgs().grants[0]!, role: `${P}#Observer` }],
    };
    const policy = fieldBound();

    // The escalation itself, still reachable with no evidence — which is the honest report,
    // because `roleProfileBinding: 'unchecked'` is what that roster says about itself.
    const unchecked = foldRoster({ ...args, attestation: policy });
    expect(unchecked.members[0]!.effective).toContain(CAPS.revoke);
    expect(unchecked.roleProfileBinding).toBe('unchecked');

    // …and gone the moment the workspace's own record is consulted.
    const checked = foldRoster({
      ...args, attestation: { ...policy, workspaceEvidence: conveneEvidence.agrees },
    });
    expect(checked.members).toHaveLength(0);
    expect(checked.roleProfileBinding).toBe('refused');
    expect(may(checked, alice, CAPS.revoke)).toBe(false);
  });

  it('★ two blanks do not agree — an unstated profile on either side refuses', () => {
    // ★ THE GUARD THAT HAS TO SIT ABOVE THE EQUALITY TEST. `readWorkspaceRecord` carries `''`
    // when the record stated no readable `wsp:roleProfile` (it is a `problem`, not a refusal,
    // because a workspace record's conferring field is its convener) — and a caller that
    // assembled a `RoleProfile` without a `profile` IRI arrives as `''` too. Left to `!==`,
    // those two blanks MATCH, and the fold would report the governance as bound because
    // neither side named any. Both directions, because only one of them is fail-closed by
    // accident.
    const base = honestArgs();
    const policy = fieldBound();
    const blankRecord: ConvenerEvidence = {
      kind: 'declared', record: workspaceRecord(CONV, CONV_KEY, { roleProfile: '' }),
    };

    const bothBlank = foldRoster({
      ...base,
      profile: { profile: '', roles: PROFILE.roles },
      attestation: { ...policy, workspaceEvidence: blankRecord },
    });
    expect(bothBlank.roleProfileBinding).toBe('refused');
    expect(bothBlank.members).toHaveLength(0);
    expect(bothBlank.unattested[0]!.because).toMatch(/states no readable wsp:roleProfile/);

    // The record states one and the caller does not.
    const callerBlank = foldRoster({
      ...base,
      profile: { profile: '', roles: PROFILE.roles },
      attestation: { ...policy, workspaceEvidence: conveneEvidence.agrees },
    });
    expect(callerBlank.roleProfileBinding).toBe('refused');
    expect(callerBlank.unattested[0]!.because).toMatch(/names no profile IRI at all/);

    // …and the control: neither guard fails closed on a record and a caller that both name one.
    expect(foldRoster({
      ...base, attestation: { ...policy, workspaceEvidence: conveneEvidence.agrees },
    }).roleProfileBinding).toBe('bound');
  });

  it('★ both fields disagree — the convener is reported first, and both bindings say so', () => {
    // The composition the lattice deliberately does not cross, pinned once. Two constant
    // refusals sit in the same `??` chain; the per-record `because` can only carry one, and it
    // must be the convener's — who may grant at all is the fault whose repair comes first, and
    // re-folding against the declared profile would still confer nothing until it is settled.
    // The verdicts do NOT collapse into one another: both fields report `'refused'`.
    const bothWrong: ConvenerEvidence = {
      kind: 'declared', record: workspaceRecord(alice, ALICE_KEY, { roleProfile: OTHER_PROFILE }),
    };
    const r = foldRoster({
      ...honestArgs(), attestation: { ...fieldBound(), workspaceEvidence: bothWrong },
    });
    expect(r.convenerBinding).toBe('refused');
    expect(r.roleProfileBinding).toBe('refused');
    expect(r.members).toHaveLength(0);
    expect(r.unattested[0]!.because).toMatch(/entitled to grant/);
    expect(r.unattested[0]!.because).not.toMatch(/rival\.test/);
    // Both faults are still reachable in words at roster scope, which is where a policy fault
    // belongs — `unattested` carries one per record, `attributionNote` carries both once.
    expect(r.attributionNote).toMatch(/CONVENER was checked against the workspace and did NOT agree/);
    expect(r.attributionNote).toMatch(/ROLE PROFILE was checked against the workspace and did NOT agree/);
  });

  it('★ a disagreeing role profile refuses to CONFER and does not erase a revocation', () => {
    // ★ THE TWO-TRACK RULE AT THE NEWEST GATE, WRITTEN OUT A SECOND TIME RATHER THAN ASSUMED
    // FROM THE CONVENER'S. Round 3 filtered refused rows out of the grant list BEFORE the
    // revocation check, so a revocation nobody could attest was not refused, it was ERASED. A
    // policy-level refusal has the same hazard with a wider blast radius: implemented against
    // `inWorkspaceGrants` rather than the conferring track, it would delete a principal's whole
    // history — the revocation, the fork report and the `unattested` row saying the revocation
    // still bit. `members` alone cannot see that, so what is asserted is what erasure WOULD
    // change.
    const revoking: Grant[] = [
      {
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`,
        attestation: contentBound(CONV_KEY),
        fieldProvenance: { source: 'payload', descriptor: 'https://conv.test/g1' },
      },
      {
        head: 'https://conv.test/g2', workspace: WS, grantedTo: alice, role: `${P}#Observer`,
        revoked: true, attestation: contentBound(CONV_KEY),
        fieldProvenance: { source: 'payload', descriptor: 'https://conv.test/g2' },
      },
    ];
    const args = { ...honestArgs(), grants: revoking };
    const agreeing = foldRoster({
      ...args, attestation: { ...fieldBound(), workspaceEvidence: conveneEvidence.agrees },
    });
    const disagreeing = foldRoster({
      ...args,
      attestation: { ...fieldBound(), workspaceEvidence: conveneEvidence['declares-another-profile'] },
    });

    expect(agreeing.members).toHaveLength(0);
    expect(disagreeing.members).toHaveLength(0);
    const stillApplied = disagreeing.unattested.find(u => u.head === 'https://conv.test/g2');
    expect(stillApplied, 'the revoking grant vanished from `unattested` — it was erased, not refused').toBeDefined();
    expect(stillApplied!.restrictionStillApplied).toBe(true);
    // The fork report is a warning, and a stricter configuration must never buy silence.
    expect(disagreeing.divergences.filter(d => d.kind === 'grant')).toHaveLength(1);
    expect(disagreeing.divergences.find(d => d.kind === 'grant')!.note).toMatch(/REVOKES/);
    expect(disagreeing.pendingInvitations).toHaveLength(0);
    assertNoWiderThan(disagreeing, agreeing, 'disagreeing profile vs agreeing under a revocation');
  });

  it('★ a disagreeing role profile does not erase a WITHDRAWAL either', () => {
    // The member's side of the same rule. A withdrawal that stopped applying because the fold
    // was handed the wrong GOVERNANCE would retain someone who had left, under the
    // configuration carrying the most evidence.
    const args = {
      ...honestArgs(),
      acceptances: [{ ...honestArgs().acceptances[0]!, withdrawn: true }],
    };
    const disagreeing = foldRoster({
      ...args,
      attestation: { ...fieldBound(), workspaceEvidence: conveneEvidence['declares-another-profile'] },
    });
    expect(disagreeing.members).toHaveLength(0);
    // Without the withdrawal reaching the restricting track alice would be rendered as a
    // principal who never answered — and there is no invitation either, because the profile
    // disagreement removed the conferring grant the invitation would have been raised under.
    expect(disagreeing.pendingInvitations).toHaveLength(0);
    // ★ AND THE ACCEPTANCE WAS NOT BLAMED. The profile refusal is in the grant chain only, so
    // no member is accused of a fault on the convener's side of the record.
    expect(disagreeing.unattested.filter(u => u.kind === 'acceptance')).toHaveLength(0);
  });

  it('★ roleProfileBinding is never `bound` off a record a stranger wrote', () => {
    // ★ A DIAGNOSTIC-INTEGRITY DEFECT, REPRODUCED BEFORE IT WAS FIXED, AND NOT AN ESCALATION —
    // which is exactly why it needed its own case rather than being folded into the pair table.
    // `refuseConvenerAuthority` reaches its authorship check only AFTER proving
    // `ws.convener === policy.convener`, so the record must have come from the policy's own
    // convener. `refuseRoleProfileAuthority` had no such precondition: it validated the record
    // against `ws.convener` — the value the record declares ABOUT ITSELF — so a stranger's
    // self-consistent record naming the TRUE `wsp:roleProfile`, signed by that stranger's own
    // registered agent, produced `roleProfileBinding: 'bound'`.
    //
    // Measured, live and through the real reader: `convenerBinding: 'refused'` beside
    // `roleProfileBinding: 'bound'`, with the note reading "the ROLE PROFILE was checked
    // against the workspace … which is the profile these capabilities were computed from".
    // Nothing had held up. No capability moved — both refusals sit in the same `??` chain, so
    // conferral needs both null and the convener answer is `'refused'` on every input that
    // reaches this — so what was wrong was the CLAIM, in a non-omittable security output.
    const r = foldRoster({
      ...honestArgs(),
      attestation: { ...fieldBound(), workspaceEvidence: conveneEvidence['names-another'] },
    });
    expect(r.convenerBinding).toBe('refused');
    expect(r.roleProfileBinding).toBe('refused');
    expect(r.members).toHaveLength(0);
    // …and the roster does not go on to assert the governance in words either, which is where
    // the false claim was actually read from.
    expect(r.attributionNote).not.toMatch(/ROLE PROFILE was checked against the workspace: /);
    expect(r.attributionNote).toMatch(/ROLE PROFILE was checked against the workspace and did NOT agree/);

    // ★★ AND THE PAIR STILL DISCRIMINATES, which is the property this fix had to preserve
    // rather than the one it had to produce. A fold that answered both questions with the
    // convener's verdict would report `['bound','bound']` on the row below; one that answered
    // both with the profile's would report `['refused','refused']`. Neither can satisfy both
    // rows, so the two verdicts are still separate facts.
    const profileOnly = foldRoster({
      ...honestArgs(),
      attestation: { ...fieldBound(), workspaceEvidence: conveneEvidence['declares-another-profile'] },
    });
    expect([profileOnly.convenerBinding, profileOnly.roleProfileBinding]).toEqual(['bound', 'refused']);
    expect([r.convenerBinding, r.roleProfileBinding]).toEqual(['refused', 'refused']);
  });

  // ── ★ AXIS I on its own — where the evidence itself came from ───────────────

  /** The evidence shapes AXIS I rides, reachable outside the enumeration. */
  const sourced = (shape: typeof sourceShapes[number]): ConvenerEvidence => sourcedEvidence(shape);
  const sourcePolicy = () => ({ ...fieldBound(), requireEvidenceProvenance: true });

  it('★ AXIS I is not vacuous — evidence provenance really does admit and really does refuse', () => {
    // AXIS H's case one question further out, with the same three parts: honest provenance must
    // ADMIT, each forged one must REFUSE, and the rung below must admit them all — or the
    // difference belongs to something other than where the evidence came from.
    const base = honestArgs();

    const admitted = foldRoster({
      ...base, attestation: { ...sourcePolicy(), workspaceEvidence: sourced('honest') },
    });
    expect(admitted.members).toHaveLength(1);
    expect(admitted.evidenceProvenanceBinding).toBe('bound');
    expect(admitted.attributionNote).toMatch(/EVIDENCE ITSELF was checked/);

    // ★ THE RESIDUAL-GAP-9 SHAPE ITSELF: a record that answers every other question correctly
    // and says nothing about where it came from. This is bee's forged workspace record, and it
    // is also every honest caller that was handed a descriptor URL — the fold cannot tell them
    // apart, which is the whole reason the answer is "refuse" rather than "guess".
    const noProvenance = foldRoster({
      ...base, attestation: { ...sourcePolicy(), workspaceEvidence: sourced('none') },
    });
    expect(noProvenance.members).toHaveLength(0);
    expect(noProvenance.evidenceProvenanceBinding).toBe('refused');
    expect(noProvenance.unattested[0]!.because).toMatch(/no statement of where it came from/);
    // …and the two questions it DOES answer are still answered, and answered correctly.
    expect(noProvenance.convenerBinding).toBe('bound');
    expect(noProvenance.roleProfileBinding).toBe('bound');

    const wrongIri = foldRoster({
      ...base, attestation: { ...sourcePolicy(), workspaceEvidence: sourced('other-iri') },
    });
    expect(wrongIri.members).toHaveLength(0);
    expect(wrongIri.unattested[0]!.because).toMatch(/obtained by dereferencing <https:\/\/other\.test\/ws>/);

    const wrongRecord = foldRoster({
      ...base, attestation: { ...sourcePolicy(), workspaceEvidence: sourced('other-record') },
    });
    expect(wrongRecord.members).toHaveLength(0);
    expect(wrongRecord.unattested[0]!.because).toMatch(/answered with one document and this fold was handed a different one/);

    // ★ AND A POLICY THAT DEMANDS PROVENANCE AND PASSES NO EVIDENCE IS REFUSED, not quietly
    // downgraded. The flag would otherwise be silently inert whenever the field beside it was
    // forgotten, which is the strictest configuration behaving as the weakest.
    const noEvidence = foldRoster({ ...base, attestation: sourcePolicy() });
    expect(noEvidence.members).toHaveLength(0);
    expect(noEvidence.evidenceProvenanceBinding).toBe('refused');
    expect(noEvidence.unattested[0]!.because).toMatch(/was passed no `workspaceEvidence` at all/);
    // …and the two questions nobody supplied evidence for still read `'unchecked'`, because
    // this refusal is about the demand, not about a record.
    expect(noEvidence.convenerBinding).toBe('unchecked');

    // …and the rung below admits every one of them, so the difference is AXIS I's alone.
    for (const shape of sourceShapes) {
      const below = foldRoster({
        ...base, attestation: { ...fieldBound(), workspaceEvidence: sourced(shape) },
      });
      expect(below.members, `rung below refused '${shape}'`).toHaveLength(1);
      expect(below.evidenceProvenanceBinding).toBe('unchecked');
      expect(below.attributionNote).toMatch(/RESIDUAL, and it is the one the two sentences above rest on/);
    }
  });

  it('★★ AXIS I closes RESIDUAL GAP 9: a record bee wrote for alice\'s workspace confers nothing', () => {
    // ★ THE ATTACK, IN THE SHAPE IT WAS MEASURED IN AGAINST PRODUCTION. Bee published a
    // `wsp:Workspace` whose SUBJECT is alice's workspace IRI, on her own pod, naming herself
    // convener and declaring the true role profile. It published, it parsed with no problems,
    // it content-bound, and it is genuinely her own signed record — so `refuseAttestation`,
    // `refuseFieldBinding`, the subject check and the convener comparison all pass, because a
    // policy that names BEE as convener agrees with it exactly. The fold that refuses her
    // self-convened membership against alice's record reported `convenerBinding: 'bound'` and
    // admitted her, `members: 1`.
    //
    // What bee cannot do is be what <WS> dereferences to: the `/ns/<owner>/<slug>` owner segment
    // selects a POD, and writing to alice's is refused `403 scope_violation`. So the fold asks
    // for the record the workspace answers with, and this one does not claim to be it.
    const BEE = alice; // a second principal with her own registered signing key
    const beesOwnRecord: WorkspaceRecord = {
      head: 'https://bee.test/c/ws.ttl', workspace: WS, convener: BEE, roleProfile: P,
      attestation: contentBound(ALICE_KEY),
      fieldProvenance: { source: 'payload', descriptor: 'https://bee.test/c/ws.ttl' },
    };
    const selfConvened = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://bee.test/g1', workspace: WS, grantedTo: BEE, role: `${P}#Contributor`,
        attestation: contentBound(ALICE_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://bee.test/g1' },
      }],
      acceptances: [{
        head: 'https://bee.test/a1', workspace: WS, member: BEE,
        accepts: 'https://bee.test/g1', stream: 'https://bee.test/s',
        attestation: contentBound(ALICE_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://bee.test/a1' },
      }],
    };
    const policy = {
      convener: BEE, signerOf: signerIndexFromRegistry(registry(false)), requireFieldBinding: true,
    };

    // THE GAP, at full strength — every guard this layer had before AXIS I passes.
    const open = foldRoster({
      ...selfConvened,
      attestation: { ...policy, workspaceEvidence: { kind: 'declared', record: beesOwnRecord } },
    });
    expect(open.members).toHaveLength(1);
    expect(open.convenerBinding).toBe('bound');
    expect(open.roleProfileBinding).toBe('bound');
    // …and the roster says the gap is open, in the field that exists to say so.
    expect(open.evidenceProvenanceBinding).toBe('unchecked');

    // AND CLOSED. Same records, same policy, one flag — and the record still carries no
    // statement of having been dereferenced, because there is no honest way for bee to make one.
    const closed = foldRoster({
      ...selfConvened,
      attestation: {
        ...policy, requireEvidenceProvenance: true,
        workspaceEvidence: { kind: 'declared', record: beesOwnRecord },
      },
    });
    expect(closed.members).toHaveLength(0);
    expect(closed.evidenceProvenanceBinding).toBe('refused');
    expect(closed.unattested[0]!.because).toMatch(/no statement of where it came from/);
    // ★ AND THE CONTROL, WITHOUT WHICH THE LINE ABOVE IS SATISFIED BY A FOLD THAT REFUSES
    // EVERYTHING. The identical attack, with the record obtained by dereferencing the workspace
    // — which for bee's own pod it never is, but the fold must admit it when it is.
    const honestlySourced = foldRoster({
      ...selfConvened,
      attestation: {
        ...policy, requireEvidenceProvenance: true,
        workspaceEvidence: {
          kind: 'declared', record: beesOwnRecord,
          provenance: { dereferenced: WS, resolvedTo: beesOwnRecord.head },
        },
      },
    });
    expect(honestlySourced.members).toHaveLength(1);
    expect(honestlySourced.evidenceProvenanceBinding).toBe('bound');
  });

  it('★ a refused evidence provenance does not erase a revocation or a withdrawal', () => {
    // ★ THE TWO-TRACK RULE AT THE NEWEST GATE, WRITTEN OUT A THIRD TIME RATHER THAN INHERITED
    // FROM THE CONVENER'S AND THE PROFILE'S. This refusal is constant across every row, so
    // implementing it against `inWorkspaceGrants` instead of the conferring track would delete
    // a principal's whole history — the revocation, the fork report, and the `unattested` row
    // that says the revocation still bit. `members` alone cannot see the difference, so what is
    // asserted is what erasure WOULD change.
    const revoking: Grant[] = [
      honestArgs().grants[0]!,
      {
        head: 'https://conv.test/g2', workspace: WS, grantedTo: alice, role: `${P}#Observer`,
        revoked: true, attestation: contentBound(CONV_KEY),
        fieldProvenance: { source: 'payload', descriptor: 'https://conv.test/g2' },
      },
    ];
    const refused = foldRoster({
      ...honestArgs(), grants: revoking,
      attestation: { ...sourcePolicy(), workspaceEvidence: sourced('none') },
    });
    const stillApplied = refused.unattested.find(u => u.head === 'https://conv.test/g2');
    expect(stillApplied, 'the revoking grant vanished from `unattested` — it was erased, not refused').toBeDefined();
    expect(stillApplied!.restrictionStillApplied).toBe(true);
    expect(refused.divergences.filter(d => d.kind === 'grant')).toHaveLength(1);
    expect(refused.pendingInvitations).toHaveLength(0);

    // The member's side of the same rule: a withdrawal must not stop applying because the fold
    // was handed a record from the wrong place.
    const withdrawn = foldRoster({
      ...honestArgs(),
      acceptances: [{ ...honestArgs().acceptances[0]!, withdrawn: true }],
      attestation: { ...sourcePolicy(), workspaceEvidence: sourced('other-iri') },
    });
    expect(withdrawn.members).toHaveLength(0);
    expect(withdrawn.pendingInvitations).toHaveLength(0);
    // ★ AND THE ACCEPTANCE WAS NOT BLAMED: this refusal is in the grant chain only, so no
    // member is accused of a fault in how somebody else assembled the fold.
    expect(withdrawn.unattested.filter(u => u.kind === 'acceptance')).toHaveLength(0);
  });

  it('★ refuseEvidenceProvenance carries the same JSON-shape guards as its two siblings', () => {
    // The duplication is pinned rather than assumed, exactly as it is for the profile refusal.
    // `ConvenerEvidence` is exported through `can.ts` for federated composers, so it arrives
    // parsed from somebody else's bytes and the compiler has guaranteed nothing: a third tag,
    // a `'declared'` with no record, and an absent evidence field are all reachable, and each
    // one used to be a way for a checked-looking roster to be checked against nothing.
    const at = (evidence: ConvenerEvidence | undefined): string | null => refuseEvidenceProvenance({
      evidence, workspace: WS, requireEvidenceProvenance: true,
    });
    expect(at(undefined)).toMatch(/passed no `workspaceEvidence` at all/);
    expect(at({ kind: 'whatever' } as unknown as ConvenerEvidence)).toMatch(/tagged 'whatever'/);
    expect(at({ kind: 'declared' } as unknown as ConvenerEvidence)).toMatch(/carries no record/);
    expect(at({ kind: 'unreadable', why: 'the pod was down' })).toMatch(/could not be read/);
    expect(at(sourced('none'))).toMatch(/no statement of where it came from/);
    // …and the control, without which every line above is satisfied by a function that refuses
    // everything — including the first line of all, which is what makes the check opt-in.
    expect(at(sourced('honest'))).toBeNull();
    expect(refuseEvidenceProvenance({ evidence: sourced('none'), workspace: WS })).toBeNull();
  });

  it('★★ THE INVERSION: supplying evidence must never admit what the policy alone refuses', () => {
    // ★ THE DEFECT THIS AXIS EXISTS TO MAKE UNWRITABLE, stated as its own case because it is
    // the one a reasonable person would ship. Reading the convener from the workspace and
    // USING it is the obvious implementation, and it turns evidence into a source of
    // authority: a policy that names the wrong principal, handed a workspace that names the
    // right one, starts admitting every grant it was refusing a moment earlier.
    //
    // Here the policy names a STRANGER as convener and the workspace names CONV, who signed
    // the grant. Under the substituting implementation this roster has a member. Under this
    // one it has none, and it has none for the ORIGINAL reason as well as the new one.
    const stranger = 'https://stranger.test/profile#me';
    const args = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
        role: `${P}#Contributor`, attestation: contentBound(CONV_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://conv.test/g1' },
      }],
      acceptances: [{
        head: 'https://alice.test/a1', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
        attestation: contentBound(ALICE_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://alice.test/a1' },
      }],
    };
    const signerOf = signerIndexFromRegistry(registry(false));
    const withoutEvidence = foldRoster({
      ...args, attestation: { convener: stranger, signerOf, requireFieldBinding: true },
    });
    const withEvidence = foldRoster({
      ...args,
      attestation: {
        convener: stranger, signerOf, requireFieldBinding: true,
        workspaceEvidence: conveneEvidence.agrees,
      },
    });
    expect(withoutEvidence.members).toHaveLength(0);
    expect(withEvidence.members).toHaveLength(0);
    assertNoWiderThan(withEvidence, withoutEvidence, 'evidence must not supply a convener');
    // The workspace's convener is not adopted: the roster still reports the disagreement.
    expect(withEvidence.convenerBinding).toBe('refused');
    expect(withEvidence.attributionNote).toMatch(/CONVENER was checked against the workspace and did NOT agree/);

    // ★ AND THE PER-RECORD REASON IS THE ATTESTATION FAULT, NOT THE CONVENER ONE, WHICH IS THE
    // ORDER THIS FOLD DELIBERATELY CHOSE. `refuseConvenerAuthority` is last in the `??` chain
    // because it is CONSTANT: first, it would overwrite every row's own diagnosis with one
    // repeated sentence, and an operator who fixed the policy would only then discover the
    // record faults that were there all along. Pinned as an assertion rather than left in a
    // comment, because it is exactly the kind of line a later edit reorders for tidiness.
    expect(withEvidence.unattested[0]!.because).toMatch(/who acts for .* — not for/);
    // The convener refusal is still reachable in words — it is what `convenerBinding` above is
    // reporting — so the wording is pinned where it is produced.
    expect(refuseConvenerAuthority({
      evidence: conveneEvidence.agrees, workspace: WS, convener: stranger, signerOf,
    })).toMatch(/not replaced by the workspace/);
  });

  it('★ a disagreeing convener refuses to CONFER and does not erase a revocation', () => {
    // ★ THE OTHER HALF OF THE TWO-TRACK RULE, at the newest gate. Round 3 filtered refused rows
    // out of the grant list BEFORE the revocation check, so a revocation nobody could attest
    // was not refused, it was ERASED. A policy-level refusal is the same hazard with a wider
    // blast radius: it fires on EVERY grant at once, so implementing it against
    // `inWorkspaceGrants` instead of the conferring track would delete a principal's whole
    // history from the fold — the revocation, the fork report and the `unattested` row that
    // says the revocation still bit.
    //
    // `members` alone cannot see that: with no conferring grant the principal is absent either
    // way. So what is asserted here is what erasure WOULD change — the divergence and the
    // refusal record.
    const revoking: Grant[] = [
      {
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`,
        attestation: contentBound(CONV_KEY),
        fieldProvenance: { source: 'payload', descriptor: 'https://conv.test/g1' },
      },
      {
        head: 'https://conv.test/g2', workspace: WS, grantedTo: alice, role: `${P}#Observer`,
        revoked: true, attestation: contentBound(CONV_KEY),
        fieldProvenance: { source: 'payload', descriptor: 'https://conv.test/g2' },
      },
    ];
    const args = {
      workspace: WS, profile: PROFILE, scopes, grants: revoking,
      acceptances: [{
        head: 'https://alice.test/a1', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
        attestation: contentBound(ALICE_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://alice.test/a1' },
      }],
    };
    const signerOf = signerIndexFromRegistry(registry(false));
    const agreeing = foldRoster({
      ...args,
      attestation: { convener: CONV, signerOf, requireFieldBinding: true, workspaceEvidence: conveneEvidence.agrees },
    });
    const disagreeing = foldRoster({
      ...args,
      attestation: { convener: CONV, signerOf, requireFieldBinding: true, workspaceEvidence: conveneEvidence['names-another'] },
    });

    // The revocation removes alice under BOTH, which is the point: the disagreement takes away
    // the power to make a member, not the record that unmade one.
    expect(agreeing.members).toHaveLength(0);
    expect(disagreeing.members).toHaveLength(0);
    // ★ AND THE REVOCATION IS STILL THERE, still reported as having taken effect. Erasing it
    // would leave this row absent, or present with `restrictionStillApplied: false`.
    const stillApplied = disagreeing.unattested.find(u => u.head === 'https://conv.test/g2');
    expect(stillApplied, 'the revoking grant vanished from `unattested` — it was erased, not refused').toBeDefined();
    expect(stillApplied!.restrictionStillApplied).toBe(true);
    // ★ AND THE FORK IS STILL REPORTED. A warning is the opposite of a grant, so a stricter
    // configuration must never buy silence with it.
    expect(disagreeing.divergences.filter(d => d.kind === 'grant')).toHaveLength(1);
    expect(disagreeing.divergences.find(d => d.kind === 'grant')!.note).toMatch(/REVOKES/);
    // …and nobody is left rendered as merely invited, which would send the convener chasing
    // a reply from somebody they had already removed.
    expect(disagreeing.pendingInvitations).toHaveLength(0);
    assertNoWiderThan(disagreeing, agreeing, 'disagreeing vs agreeing under a revocation');
  });

  it('★ a disagreeing convener does not erase a WITHDRAWAL either', () => {
    // Same rule on the member's side of the record. A withdrawal that stopped applying because
    // the POLICY named the wrong convener would retain someone who had left, under the
    // configuration with the most evidence — the failure direction this whole area keeps
    // producing.
    const args = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`,
        attestation: contentBound(CONV_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://conv.test/g1' },
      }],
      acceptances: [{
        head: 'https://alice.test/a1', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s', withdrawn: true,
        attestation: contentBound(ALICE_KEY),
        fieldProvenance: { source: 'payload' as const, descriptor: 'https://alice.test/a1' },
      }],
    };
    const signerOf = signerIndexFromRegistry(registry(false));
    const disagreeing = foldRoster({
      ...args,
      attestation: { convener: CONV, signerOf, requireFieldBinding: true, workspaceEvidence: conveneEvidence['names-another'] },
    });
    expect(disagreeing.members).toHaveLength(0);
    // The withdrawal is what keeps alice out of `pendingInvitations`: without it reaching the
    // restricting track she would be rendered as a principal who never answered.
    expect(disagreeing.pendingInvitations).toHaveLength(0);
  });

  it('★ every shape a workspace record can arrive in, against every rung', () => {
    // ★ THE SHAPES AXIS A CANNOT AFFORD TO CROSS. Three workspace-evidence shapes ride the full
    // 76,800-case lattice; these eleven do not, because each one multiplies it. They are
    // crossed here against the axes they actually interact with — the RUNG, which decides how
    // hard the workspace record's own authorship and provenance are checked, and the grant and
    // acceptance attestations, which decide whether there was a member to withhold.
    //
    // The table is the assertion. Three of these shapes are `'bound'` at one rung and
    // `'refused'` at a higher one, which is what makes it a table rather than a list of
    // refusals: a record whose content binding was never checked is evidence under a policy
    // that never asked for content binding, and stops being evidence under one that did.
    //
    // ★ EACH CELL IS A PAIR — `[convenerBinding, roleProfileBinding]` — AND THE PAIRS THAT
    // DIFFER ARE THE POINT. One record answers two questions, and every damage a record can
    // take damages both answers EXCEPT the two that move a single declared value. Writing the
    // table with one column per rung and one verdict per cell would have let the newer field
    // be answered by the older one's verdict everywhere, undetected.
    type Verdict = 'bound' | 'refused';
    const other = 'https://other.test/ws';
    const shapes: Record<string, {
      evidence: ConvenerEvidence;
      attested: readonly [Verdict, Verdict];
      content: readonly [Verdict, Verdict];
      fields: readonly [Verdict, Verdict];
    }> = {
      agrees: { evidence: conveneEvidence.agrees, attested: ['bound', 'bound'], content: ['bound', 'bound'], fields: ['bound', 'bound'] },
      // ★ ONE FIELD MOVED AND BOTH VERDICTS MOVE, WHICH IS A CORRECTION. This row read
      // `['refused','bound']` — the declared profile is still `P`, so the profile answer looked
      // untouched — and that was `roleProfileBinding` asserting "the governance these
      // capabilities were computed under is the governance the workspace publishes" over a
      // record a STRANGER wrote. The profile IRI on a record from the wrong party is not
      // compared at all now, so the pair is `['refused','refused']`. What still makes this a
      // table rather than a list is the row below, which no fold that answers one question
      // with the other's verdict can satisfy alongside this one.
      'names-another': { evidence: conveneEvidence['names-another'], attested: ['refused', 'refused'], content: ['refused', 'refused'], fields: ['refused', 'refused'] },
      // …and the mirror of it, which is the row a fold that conflated the two cannot satisfy
      // at the same time as the row above.
      'declares-another-profile': {
        evidence: conveneEvidence['declares-another-profile'],
        attested: ['bound', 'refused'], content: ['bound', 'refused'], fields: ['bound', 'refused'],
      },
      // The record states no readable `wsp:roleProfile` at all — what `readWorkspaceRecord`
      // carries as `''`, since a workspace record's conferring field is its convener and an
      // unreadable profile is reported rather than fatal. It must never compare equal to
      // anything, including a caller who also named none.
      'declares-no-profile': {
        evidence: { kind: 'declared', record: workspaceRecord(CONV, CONV_KEY, { roleProfile: '' }) },
        attested: ['bound', 'refused'], content: ['bound', 'refused'], fields: ['bound', 'refused'],
      },
      'about-another-workspace': {
        evidence: { kind: 'declared', record: workspaceRecord(CONV, CONV_KEY, { workspace: other }) },
        attested: ['refused', 'refused'], content: ['refused', 'refused'], fields: ['refused', 'refused'],
      },
      'signed-by-stranger': {
        evidence: { kind: 'declared', record: workspaceRecord(CONV, STRANGER_KEY) },
        attested: ['refused', 'refused'], content: ['refused', 'refused'], fields: ['refused', 'refused'],
      },
      unattested: {
        evidence: { kind: 'declared', record: workspaceRecord(CONV, CONV_KEY, { attestation: undefined }) },
        attested: ['refused', 'refused'], content: ['refused', 'refused'], fields: ['refused', 'refused'],
      },
      'content-unbound': {
        evidence: { kind: 'declared', record: workspaceRecord(CONV, CONV_KEY, { attestation: verified(CONV_KEY) }) },
        // Evidence under a policy that never asked about content, and not under one that did.
        attested: ['bound', 'bound'], content: ['refused', 'refused'], fields: ['refused', 'refused'],
      },
      'no-provenance': {
        evidence: { kind: 'declared', record: workspaceRecord(CONV, CONV_KEY, { fieldProvenance: undefined }) },
        attested: ['bound', 'bound'], content: ['bound', 'bound'], fields: ['refused', 'refused'],
      },
      'provenance-elsewhere': {
        evidence: {
          kind: 'declared',
          record: workspaceRecord(CONV, CONV_KEY, {
            fieldProvenance: { source: 'payload', descriptor: 'https://elsewhere.test/x.ttl' },
          }),
        },
        attested: ['bound', 'bound'], content: ['bound', 'bound'], fields: ['refused', 'refused'],
      },
      unreadable: {
        evidence: { kind: 'unreadable', why: 'get_descriptor failed' },
        attested: ['refused', 'refused'], content: ['refused', 'refused'], fields: ['refused', 'refused'],
      },
    };
    const signerOf = signerIndexFromRegistry(registry(false));
    let crossed = 0, admitted = 0, withheld = 0;
    for (const [name, shape] of Object.entries(shapes)) {
      for (const gAtt of attKeys) {
        for (const aAtt of attKeys) {
          for (const revoked of [false, true]) {
            for (const withdrawn of [false, true]) {
              const grants: Grant[] = [{
                head: 'https://conv.test/g1', workspace: WS, grantedTo: alice,
                role: `${P}#Contributor`, revoked, attestation: attestations[gAtt],
                fieldProvenance: { source: 'payload', descriptor: 'https://conv.test/g1' },
              }];
              const acceptances: Acceptance[] = [{
                head: 'https://alice.test/a1', workspace: WS, member: alice,
                accepts: 'https://conv.test/g1', stream: 'https://alice.test/s', withdrawn,
                attestation: attestations[aAtt],
                fieldProvenance: { source: 'payload', descriptor: 'https://alice.test/a1' },
              }];
              const args = { workspace: WS, profile: PROFILE, grants, acceptances, scopes };
              const label = `ws=${name} grant=${gAtt} accept=${aAtt} revoked=${revoked} withdrawn=${withdrawn}`;
              for (const [rung, extra, expected] of [
                ['attested', {}, shape.attested],
                ['content', { requireContentBinding: true }, shape.content],
                ['fields', { requireFieldBinding: true }, shape.fields],
              ] as const) {
                const without = foldRoster({ ...args, attestation: { convener: CONV, signerOf, ...extra } });
                const withIt = foldRoster({
                  ...args,
                  attestation: { convener: CONV, signerOf, ...extra, workspaceEvidence: shape.evidence },
                });
                expect(withIt.convenerBinding, `${label} rung=${rung}: convener`).toBe(expected[0]);
                expect(withIt.roleProfileBinding, `${label} rung=${rung}: role profile`).toBe(expected[1]);
                expect(without.convenerBinding, `${label} rung=${rung}: no evidence must read as unchecked`).toBe('unchecked');
                expect(without.roleProfileBinding, `${label} rung=${rung}: no evidence must read as unchecked`).toBe('unchecked');
                // Whatever the shape, supplying it can only ever refuse more.
                assertNoWiderThan(withIt, without, `${label} rung=${rung}`);
                // Counted only where BOTH answers came back bound, because either refusal
                // empties the roster: crediting a half-bound shape here would let the
                // non-vacuity assertion below pass on rows that conferred nothing.
                if (expected[0] === 'bound' && expected[1] === 'bound') admitted += withIt.members.length;
                else if (without.members.length > 0) withheld++;
                crossed++;
              }
            }
          }
        }
      }
    }
    expect(crossed).toBe(Object.keys(shapes).length * attKeys.length * attKeys.length * 2 * 2 * 3);
    // Both directions reached, for the same reason as AXIS G's counters in the enumeration.
    expect(admitted, 'no shape admitted a member at any rung — the table is all refusals').toBeGreaterThan(0);
    expect(withheld, 'no shape withheld a member at any rung — the table refuses nothing').toBeGreaterThan(0);
  }, 300_000);

  it('the fold reports the convener check as ENFORCED, never as merely available', () => {
    // ★ The rule `recordContentBinding` and `recordFieldBinding` already follow, at the newest
    // field. A policy that did not pass evidence did not get the check, and a roster that read
    // `'bound'` because evidence happened to be lying around would be data standing in for a
    // guarantee — the substitution this whole layer exists to stop making.
    const args = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`,
        attestation: contentBound(CONV_KEY),
      }],
      acceptances: [{
        head: 'https://alice.test/a1', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
        attestation: contentBound(ALICE_KEY),
      }],
    };
    const signerOf = signerIndexFromRegistry(registry(false));
    expect(foldRoster(args).convenerBinding).toBe('unchecked');
    expect(foldRoster({ ...args, attestation: { convener: CONV, signerOf } }).convenerBinding).toBe('unchecked');
    const checked = foldRoster({
      ...args, attestation: { convener: CONV, signerOf, workspaceEvidence: conveneEvidence.agrees },
    });
    expect(checked.convenerBinding).toBe('bound');
    // …and the unchecked roster says so in words, because a three-valued enum is easy to not
    // branch on and this is the value that means "nobody checked".
    expect(foldRoster({ ...args, attestation: { convener: CONV, signerOf } }).attributionNote)
      .toMatch(/is the workspace's convener/);
  });

  // ── ★ the two shapes `ConvenerEvidence` cannot have and JSON can ────────────
  //
  // `ConvenerEvidence` is exported through `can.ts` for federated composers, which means it
  // arrives parsed from somebody else's bytes and the compiler has guaranteed nothing about
  // it. The dispatch in `refuseConvenerAuthority` was `kind === 'unreadable'` → refuse and
  // EVERYTHING ELSE → treat as declared, which is the same "a value the type says is
  // impossible must not come out the admitting end" that `refuseFieldBinding` guards with its
  // own `!== 'payload'` test one function above. Both were reproduced before being fixed.
  //
  // Cast through `unknown` deliberately: writing these shapes is the whole point, and the
  // cast is the test saying out loud that the type forbids what the wire permits.
  describe('★ evidence in a shape the union forbids', () => {
    const evidenceArgs = {
      workspace: WS, profile: PROFILE, scopes,
      grants: [{
        head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`,
        attestation: contentBound(CONV_KEY),
      }],
      acceptances: [{
        head: 'https://alice.test/a1', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
        attestation: contentBound(ALICE_KEY),
      }],
    };
    const foldWith = (evidence: ConvenerEvidence): Roster => foldRoster({
      ...evidenceArgs,
      attestation: {
        convener: CONV, signerOf: signerIndexFromRegistry(registry(false)),
        workspaceEvidence: evidence,
      },
    });

    it('★ an UNRECOGNISED kind is refused, and does not report the convener as bound', () => {
      // Was: `convenerBinding: 'bound'` with alice a member. The union has exactly two members
      // so that "asked and got silence" cannot masquerade as an answer; a third tag
      // masqueraded instead, which is the same lie one value over.
      const r = foldWith({ kind: 'i-did-not-ask', record: workspaceRecord(CONV, CONV_KEY) } as unknown as ConvenerEvidence);
      expect(r.convenerBinding).toBe('refused');
      expect(r.members).toHaveLength(0);
      expect(r.unattested.some(u => /tagged 'i-did-not-ask'/.test(u.because))).toBe(true);
    });

    it("★ a 'declared' evidence carrying NO record refuses instead of killing the fold", () => {
      // Was: `TypeError: Cannot read properties of undefined (reading 'workspace')` thrown out
      // of the authorization path. A refusal names a fault; a throw returns no roster at all,
      // so nothing downstream can even report that authorization failed.
      const evidence = { kind: 'declared' } as unknown as ConvenerEvidence;
      expect(() => foldWith(evidence)).not.toThrow();
      const r = foldWith(evidence);
      expect(r.convenerBinding).toBe('refused');
      expect(r.members).toHaveLength(0);
      expect(r.unattested.some(u => /carries no record/.test(u.because))).toBe(true);
    });

    it('…and the control still admits: neither guard fails closed on honest evidence', () => {
      // Without this the two cases above are satisfied by a function that refuses everything.
      const r = foldWith(conveneEvidence.agrees);
      expect(r.convenerBinding).toBe('bound');
      expect(r.members).toHaveLength(1);
    });

    it('refuseConvenerAuthority refuses both shapes directly, not only through the fold', () => {
      // The function is exported and callable on its own, so the guard has to be in the
      // function rather than in whatever the fold happens to do with its answer.
      const at = (evidence: ConvenerEvidence): string | null => refuseConvenerAuthority({
        evidence, workspace: WS, convener: CONV,
        // Needed only by the honest control: without a resolver the signing DID cannot be
        // mapped to the principal it acts for, so `refuseAttestation` refuses the good record
        // too and all three cases pass for the wrong reason.
        signerOf: signerIndexFromRegistry(registry(false)),
      });
      expect(at({ kind: 'whatever' } as unknown as ConvenerEvidence)).toMatch(/tagged 'whatever'/);
      expect(at({ kind: 'declared' } as unknown as ConvenerEvidence)).toMatch(/carries no record/);
      expect(at({ kind: 'declared', record: workspaceRecord(CONV, CONV_KEY) })).toBeNull();
    });

    it('★ refuseRoleProfileAuthority carries the SAME two guards, and is checked for it', () => {
      // ★ THE DUPLICATION IS PINNED, NOT ASSUMED. The tag and record guards exist twice — once
      // in each refusal — because sharing them would mean editing the convener function, whose
      // branch order is load-bearing and pinned by three other assertions. Two copies of a
      // guard drift; this case is what turns a drift into a failing test instead of a silent
      // hole in whichever copy was not updated. Both were reproduced against the new function
      // before it was written: an unrecognised tag reported `roleProfileBinding: 'bound'`, and
      // `{kind: 'declared'}` with no record threw out of the authorization path.
      const at = (evidence: ConvenerEvidence, profile = P): string | null => refuseRoleProfileAuthority({
        evidence, workspace: WS, profile, convener: CONV,
        signerOf: signerIndexFromRegistry(registry(false)),
      });
      expect(at({ kind: 'whatever' } as unknown as ConvenerEvidence)).toMatch(/tagged 'whatever'/);
      expect(at({ kind: 'declared' } as unknown as ConvenerEvidence)).toMatch(/carries no record/);
      expect(at({ kind: 'unreadable', why: 'the pod was down' })).toMatch(/could not be read/);
      // …the comparison itself, in both directions…
      expect(at(conveneEvidence['declares-another-profile'])).toMatch(/The two disagree/);
      expect(at(conveneEvidence.agrees, '')).toMatch(/names no profile IRI at all/);
      expect(at({ kind: 'declared', record: workspaceRecord(CONV, CONV_KEY, { roleProfile: '' }) }))
        .toMatch(/states no readable wsp:roleProfile/);
      // ★ AND THE CONVENER PRECONDITION, WHICH IS A GUARD ON THIS FUNCTION AND NOT A BORROWED
      // VERDICT. A record naming a stranger as convener and the TRUE profile used to answer
      // `null` here — so `roleProfileBinding` read `'bound'` off a record nobody with authority
      // over the workspace wrote, which is what its contract says the value never means. The
      // refusal must name the CONVENER question, or an operator is sent to reconcile two
      // governance documents that never disagreed.
      expect(at(conveneEvidence['names-another'])).toMatch(/as convener and this policy treats/);
      expect(at(conveneEvidence['names-another'])).not.toMatch(/The two disagree/);
      // …and the control, without which every line above is satisfied by a function that
      // refuses everything.
      expect(at(conveneEvidence.agrees)).toBeNull();
    });

    it('★ a workspace record with a non-string roleProfile refuses rather than comparing', () => {
      // The same "a value the type says is impossible must not come out the admitting end"
      // rule `refuseFieldBinding` applies to its own `source`. `WorkspaceRecord` arrives as
      // JSON through `can.ts` in a federated composer, so `roleProfile` can be a number, a
      // null or an array — and `!==` against a string is true for all of them, which happens
      // to refuse. Happens-to is not a guard: the branch is explicit and typed on it, so a
      // later edit that normalises before comparing cannot silently admit `['<P>']`.
      for (const bad of [null, 42, [P], { iri: P }]) {
        const record = { ...workspaceRecord(CONV, CONV_KEY), roleProfile: bad } as unknown as WorkspaceRecord;
        expect(refuseRoleProfileAuthority({
          evidence: { kind: 'declared', record }, workspace: WS, profile: P, convener: CONV,
          signerOf: signerIndexFromRegistry(registry(false)),
        }), `roleProfile = ${JSON.stringify(bad)}`).toMatch(/states no readable wsp:roleProfile/);
      }
    });
  });

  // ── ★ the divergence NOTE, which the enumeration cannot see ─────────────────
  //
  // `divergenceKeys` compares `kind|heads`. That is right for what it is for — proving a
  // stricter policy did not DELETE a warning — and it means the 230,400 comparisons above are
  // blind to a warning whose TEXT was replaced with a false one. `roster.ts` states the rule
  // itself: this channel must never assert an outcome that did not happen.
  //
  // It was asserting three. Measured on a workspace where every record is honest and only the
  // policy and the workspace disagree about who convenes, the acceptance note said the member
  // was "listed as invited instead" with `pendingInvitations` EMPTY, and that "`unattested`
  // says why each answer was refused" with `unattested` holding one grant row and no
  // acceptance rows. Both acceptances were signed, content-bound and field-bound. The members
  // were told off for the convener's fault.
  //
  // So the note is checked against the roster that emitted it, clause by clause, over a cross
  // that reaches every branch.
  describe('★ an acceptance divergence note never asserts an outcome that did not happen', () => {
    /** Two honest heads on different streams — the only way to raise the note at all. */
    const twoHeads = (over: Partial<Acceptance> = {}): Acceptance[] => ['a1', 'a2'].map(n => ({
      head: `https://alice.test/${n}`, workspace: WS, member: alice,
      accepts: 'https://conv.test/g1', stream: `https://alice.test/s-${n}`,
      attestation: contentBound(ALICE_KEY),
      fieldProvenance: { source: 'payload' as const, descriptor: `https://alice.test/${n}` },
      ...over,
    }));
    const oneGrant: Grant[] = [{
      head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`,
      attestation: contentBound(CONV_KEY),
      fieldProvenance: { source: 'payload', descriptor: 'https://conv.test/g1' },
    }];

    /**
     * Each clause the note can print, paired with what the roster must actually show for it to
     * be true. A clause with no predicate here is a clause nobody is checking, so new wording
     * belongs in this table rather than only in `roster.ts`.
     */
    const CLAUSES: readonly [RegExp, (r: Roster) => boolean, string][] = [
      [/listed as invited instead/, r => r.pendingInvitations.some(p => p.principal === alice),
        'said the member was invited instead, and pendingInvitations does not name them'],
      [/says why each answer was refused/, r => r.unattested.some(u => u.kind === 'acceptance'),
        'sent the reader to `unattested` for the refused answers, and it holds no acceptance row'],
      [/The member is included/, r => r.members.some(m => m.principal === alice),
        'said the member is included, and they are not in `members`'],
      [/member is NOT included|member is absent/, r => !r.members.some(m => m.principal === alice),
        'said the member is not included, and they are in `members`'],
    ];

    const check = (r: Roster, label: string): string => {
      const note = r.divergences.find(d => d.kind === 'acceptance')?.note;
      expect(note, `${label}: no acceptance divergence was raised, so this case tests nothing`)
        .toBeDefined();
      for (const [clause, holds, complaint] of CLAUSES) {
        if (!clause.test(note!)) continue;
        expect(holds(r), `${label}: the note ${complaint} — ${note!}`).toBe(true);
      }
      return note!;
    };

    const foldNote = (over: {
      acceptances?: Acceptance[];
      evidence?: ConvenerEvidence;
      requireFieldBinding?: boolean;
    }): Roster => foldRoster({
      workspace: WS, profile: PROFILE, scopes, grants: oneGrant,
      acceptances: over.acceptances ?? twoHeads(),
      attestation: {
        convener: CONV, signerOf: signerIndexFromRegistry(registry(false)),
        requireFieldBinding: over.requireFieldBinding ?? true,
        workspaceEvidence: over.evidence,
      },
    });

    it('★ a DISAGREEING convener does not make the note blame the members', () => {
      const r = foldNote({ evidence: conveneEvidence['names-another'] });
      const note = check(r, 'disagreeing convener');
      // The positive half: the fork is still reported, and the note says whose fault it is not.
      expect(note).toMatch(/no grant to them CONFERS/);
      expect(r.members).toHaveLength(0);
      expect(r.pendingInvitations).toHaveLength(0);
      expect(r.unattested.every(u => u.kind === 'grant')).toBe(true);
    });

    it('…and the note that WAS accurate still is: genuinely refused acceptances', () => {
      // Without this the branch above could have been reached by weakening the true case.
      const r = foldNote({
        acceptances: twoHeads({ attestation: contentBound(STRANGER_KEY) }),
        requireFieldBinding: false,
      });
      const note = check(r, 'refused acceptances');
      expect(note).toMatch(/listed as invited instead/);
      expect(r.pendingInvitations.map(p => p.principal)).toContain(alice);
      expect(r.unattested.filter(u => u.kind === 'acceptance')).toHaveLength(2);
    });

    it('…and so do the admitted and the withdrawn branches', () => {
      const admitted = foldNote({ evidence: conveneEvidence.agrees });
      expect(check(admitted, 'agreeing convener')).toMatch(/The member is included/);
      expect(admitted.members).toHaveLength(1);

      const [first, second] = twoHeads();
      const withdrawn = foldNote({ acceptances: [first!, { ...second!, withdrawn: true }] });
      expect(check(withdrawn, 'withdrawn head')).toMatch(/WITHDRAWS/);
      expect(withdrawn.members).toHaveLength(0);
    });
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
