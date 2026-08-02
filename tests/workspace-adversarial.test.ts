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
 * every case is enumerated. Three axes, each with an unambiguous weaker side:
 *
 *   A  attestation policy PRESENT ⊆ absent
 *   B  a signing key marked REVOKED ⊆ the same key live
 *   C  compose with verifyAuthorship TRUE ⊆ false
 *
 * "⊆" is meant literally and is checked literally: every member of the stronger roster must
 * be a member of the weaker one, every effective capability of theirs must be present in the
 * weaker one, and every entry the stronger view admits must be admitted by the weaker one.
 * A configuration that refuses more is always fine; one that admits more is the defect,
 * whatever produced it.
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
  };
  const attKeys = Object.keys(attestations);

  const capsOf = (r: Roster): Map<string, Set<string>> =>
    new Map(r.members.map(m => [m.principal, new Set(m.effective)]));

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
  };

  it('★ AXIS A — enumerating every grant × acceptance × revoked × withdrawn × second head', () => {
    let cases = 0;
    for (const gAtt of attKeys) {
      for (const aAtt of attKeys) {
        for (const revoked of [false, true]) {
          for (const withdrawn of [false, true]) {
            for (const second of ['none', 'narrower-head', 'wider-head', 'revoking-head'] as const) {
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
              const acceptances: Acceptance[] = [{
                head: 'https://alice.test/a1', workspace: WS, member: alice,
                accepts: 'https://conv.test/g1', stream: 'https://alice.test/s',
                withdrawn, attestation: attestations[aAtt],
              }];
              const args = { workspace: WS, profile: PROFILE, grants, acceptances, scopes };
              const label = `grant=${gAtt} accept=${aAtt} revoked=${revoked} withdrawn=${withdrawn} second=${second}`;

              const off = foldRoster(args);
              const on = foldRoster({
                ...args,
                attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)) },
              });
              expect(off.membershipGrade).toBe('asserted');
              expect(on.membershipGrade).toBe('attested');
              assertNoWiderThan(on, off, label);
              cases++;
            }
          }
        }
      }
    }
    // Guard the guard: an enumeration that silently stopped generating would pass vacuously.
    expect(cases).toBe(attKeys.length * attKeys.length * 2 * 2 * 4);
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

  it('★ the fold states that its records\' CONTENT is unbound, and cannot say otherwise', () => {
    // The gate binds a SIGNER TO A URL. Every field of Grant and Acceptance is typed by the
    // caller and none is covered by the proof, so an attested membership establishes "a
    // record at this URL was signed by this party" and NOT "this party agreed to this". A
    // review handed the fold one of a member's ordinary signed log entries as their
    // acceptance and got an attested member who had never heard of the workspace.
    const r = foldRoster({
      workspace: WS, profile: PROFILE, scopes,
      grants: [{ head: 'https://conv.test/g1', workspace: WS, grantedTo: alice, role: `${P}#Contributor`, attestation: verified(CONV_KEY) }],
      acceptances: [{
        // ★ NOT an acceptance. One of alice's ordinary published entries, genuinely signed,
        // genuinely bound to its own descriptor, genuinely naming alice.
        head: 'https://alice.test/c/some-ordinary-entry.ttl', workspace: WS, member: alice,
        accepts: 'https://conv.test/g1', stream: 'https://alice.test/s', attestation: verified(ALICE_KEY),
      }],
      attestation: { convener: CONV, signerOf: signerIndexFromRegistry(registry(false)) },
    });
    expect(r.members).toHaveLength(1);            // this is what the gate actually permits
    expect(r.recordContentBinding).toBe('unbound'); // ...and the field that says so
    expect(r.attributionNote).toMatch(/WHO SIGNED A URL/);
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
