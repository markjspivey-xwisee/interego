/**
 * `wsp.can` — and the honest question of where authority can be enforced at all.
 *
 * A one-relay system enforces at write time: every write passes through one server, so an
 * unauthorised one is refused and that is the end of it. Here there is no such chokepoint.
 * Nothing can stop a person writing to their own pod — it is their pod, and the substrate's
 * gate answers a different question ("is this the owner?") to which the answer is yes.
 *
 * So the tests below pin a different property: an unauthorised entry is not PREVENTED, it
 * is INERT. It exists, it is signed by its author, it is at its own URL — and it is not
 * workspace content, and the view says so out loud rather than quietly filtering it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  capabilitiesForScope, capabilitiesOfAgent, scopesFromRegistry, signerIndexFromRegistry,
  canAct, can, authorizeView, readableMembers, CAPS,
  type RoleProfile,
} from '../applications/shared-workspace/src/can.js';
import { foldRoster, refuseAttestation } from '../applications/shared-workspace/src/roster.js';
import { composeWorkspace, describeCoverage, type ComposableMember } from '../applications/shared-workspace/src/compose.js';
import type { StreamDeps } from '../applications/shared-workspace/src/stream.js';

const P = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default';
const WS = 'https://relay.test/ws/alpha';
const alice = 'https://alice.test/profile#me';
const bee = 'https://bee.test/profile#me';

const PROFILE: RoleProfile = {
  profile: P,
  roles: [
    { role: `${P}#Convener`, permits: [CAPS.read, CAPS.append, CAPS.grant, CAPS.revoke, CAPS.admit, CAPS.assign] },
    { role: `${P}#Contributor`, permits: [CAPS.read, CAPS.append] },
    { role: `${P}#Observer`, permits: [CAPS.read] },
  ],
};

const member = (principal: string, role: string) => ({
  grant: { head: `https://conv.test/g-${principal}`, workspace: WS, grantedTo: principal, role: `${P}#${role}` },
  acceptance: {
    head: `https://acc.test/a-${principal}`, workspace: WS, member: principal,
    accepts: `https://conv.test/g-${principal}`, stream: `${principal}/stream`,
  },
});

const rosterOf = (spec: { principal: string; role: string; scope: string }[]) => foldRoster({
  workspace: WS,
  profile: PROFILE,
  grants: spec.map(s => member(s.principal, s.role).grant),
  acceptances: spec.map(s => member(s.principal, s.role).acceptance),
  scopes: scopesFromRegistry(spec.map(s => ({ principal: s.principal, agents: [{ did: `did:web:${s.principal}`, scope: s.scope }] }))),
});

describe('the substrate\'s delegation scope IS the ceiling', () => {
  it('maps the three scopes the registry actually records', () => {
    expect(capabilitiesForScope('ReadWrite')).toContain(CAPS.grant);
    expect(capabilitiesForScope('PublishOnly')).toEqual([CAPS.read, CAPS.append]);
    expect(capabilitiesForScope('ReadOnly')).toEqual([CAPS.read]);
  });

  it('★ an unrecognised scope grants NOTHING', () => {
    // A scope this layer cannot interpret means the substrate said something we do not
    // understand, and the safe reading of an uninterpretable authorization statement is
    // that it authorises nothing. Defaulting the other way would turn every scope name the
    // substrate adds in future into a silent grant of everything to everyone holding it.
    expect(capabilitiesForScope('SuperAdmin')).toEqual([]);
    expect(capabilitiesForScope(undefined)).toEqual([]);
    expect(capabilitiesForScope(null)).toEqual([]);
  });

  it('several agents for one principal union their scopes', () => {
    // The person can act through any of them, so their reachable authority is the union.
    // The per-action narrowing is canAct's job, not this one's.
    const [scope] = scopesFromRegistry([{
      principal: alice,
      agents: [{ did: 'did:a', scope: 'ReadOnly' }, { did: 'did:b', scope: 'PublishOnly' }],
    }]);
    expect(scope!.capabilities).toEqual([CAPS.append, CAPS.read].sort());
  });

  it('★ a REVOKED agent carries nothing, whatever scope its row still records', () => {
    // Revocation withdraws the delegation without rewriting the scope, so the row still
    // literally says ReadWrite and switching on the scope alone hands all six capabilities
    // to an agent the owner has already thrown out. The relay tests `!a.revoked` everywhere
    // it surfaces an agent — reading the same record and disagreeing about what it says is
    // exactly how two authorization systems get found out by whoever they let through.
    expect(capabilitiesOfAgent({ did: 'did:web:live', scope: 'ReadWrite' })).toHaveLength(6);
    expect(capabilitiesOfAgent({ did: 'did:web:gone', scope: 'ReadWrite', revoked: true })).toEqual([]);
    expect(capabilitiesOfAgent({ did: 'did:web:gone', scope: 'ReadOnly', revoked: true })).toEqual([]);
  });

  it('★ revoking the only ReadWrite agent actually narrows the union', () => {
    // The failure this prevents is a revocation that revokes nothing. Union over every row
    // regardless of `revoked` leaves the union unchanged for as long as one live agent
    // remains, and the fold downstream sees only the union — so nothing reports it.
    const [scope] = scopesFromRegistry([{
      principal: alice,
      agents: [{ did: 'did:a', scope: 'ReadWrite', revoked: true }, { did: 'did:b', scope: 'ReadOnly' }],
    }]);
    expect(scope!.capabilities).toEqual([CAPS.read]);
  });

  it('★ a Convener whose only agent is revoked may do nothing at all', () => {
    // The strongest role in the profile, intersected against an empty delegation. A role is
    // a ceiling, so there is nothing left under it.
    const m = member(alice, 'Convener');
    const roster = foldRoster({
      workspace: WS, profile: PROFILE, grants: [m.grant], acceptances: [m.acceptance],
      scopes: scopesFromRegistry([{
        principal: alice, agents: [{ did: 'did:web:gone', scope: 'ReadWrite', revoked: true }],
      }]),
    });
    expect(canAct(roster, alice, CAPS.append).allowed).toBe(false);
    expect(canAct(roster, alice, CAPS.read).allowed).toBe(false);
  });

  it('★ a Convener with a ReadOnly delegation still cannot append', () => {
    // The property that distinguishes a published roster from a membership table: in a
    // table, being an admin IS the authority. Here it is only a bound on it.
    const roster = rosterOf([{ principal: alice, role: 'Convener', scope: 'ReadOnly' }]);
    expect(canAct(roster, alice, CAPS.append).allowed).toBe(false);
    expect(canAct(roster, alice, CAPS.append).because).toMatch(/ceiling, never a grant/);
  });
});

describe('★ signerIndexFromRegistry — a signature names an agent, a roster names a principal', () => {
  // Comparing a proof's `signedBy` against a workspace principal as strings answers false for
  // every person in every real workspace: a WebID is not a DID. An attribution check built
  // that way withholds everything and gets turned off, so the mapping has to exist — and it
  // has to come from the registry on each principal's OWN pod, which nobody else can write.
  const registry = [
    { principal: alice, agents: [{ did: 'did:web:alice-laptop', scope: 'ReadWrite' }, { id: 'did:web:alice-phone' }] },
    { principal: bee, agents: [{ did: 'did:web:bee-bot', scope: 'ReadOnly' }] },
  ];

  it('maps every one of a principal\'s agents to that principal', () => {
    const signerOf = signerIndexFromRegistry(registry);
    expect(signerOf('did:web:alice-laptop')).toEqual({ acts: 'for', principal: alice, revoked: false });
    // `id` counts as well as `did`
    expect(signerOf('did:web:alice-phone')).toEqual({ acts: 'for', principal: alice, revoked: false });
    expect(signerOf('did:web:bee-bot')).toEqual({ acts: 'for', principal: bee, revoked: false });
  });

  it('★ the pod registry\'s own `agentId` is indexed too — the shape that carries `revoked`', () => {
    // The one shape that can answer "was this key withdrawn?" is a pod's own AgentRegistry
    // row (`AuthorizedAgentData`), whose identifier field is `agentId` — the relay's
    // projections use `id`/`did` and filter revoked rows out before anyone sees them. Reading
    // only `did ?? id` therefore indexed NOTHING on the only path where revocation arrives:
    // every genuine grant was refused with "no agent registry vouches for that signer", and
    // the revoked branch downstream was unreachable. Invisible to a suite that builds its own
    // literals, which is exactly why it is pinned here with the real field name.
    const signerOf = signerIndexFromRegistry([
      { principal: alice, agents: [{ agentId: 'did:web:relay:agents:alice-1', scope: 'ReadWrite' }] },
    ]);
    expect(signerOf('did:web:relay:agents:alice-1')).toEqual({ acts: 'for', principal: alice, revoked: false });
  });

  it('a principal signing under its own IRI resolves to itself', () => {
    expect(signerIndexFromRegistry(registry)(alice)).toEqual({ acts: 'for', principal: alice, revoked: false });
  });

  it('★ an unknown signer resolves to NULL, not to itself', () => {
    // Falling back to identity would make an unregistered DID vouch for a principal whose IRI
    // happens to equal it — and would turn a registry this layer failed to read into a
    // blanket "everyone is themselves", which admits every record in the workspace.
    expect(signerIndexFromRegistry(registry)('did:web:stranger')).toBeNull();
    expect(signerIndexFromRegistry([])('did:web:alice-laptop')).toBeNull();
  });

  it('★ a REVOKED agent still identifies, and comes back MARKED so it cannot attest', () => {
    // The old reading — keep revoked rows so key rotation does not un-author a member's
    // history, and let `disallowed` handle the authority half — holds only when the revoked
    // agent was the principal's ONLY agent. `scopesFromRegistry` unions over the live ones,
    // so an entry signed by a key its owner had already thrown out was counted as that
    // member's workspace content at the `attested` grade, with nothing downstream able to
    // recover which key wrote it. That is the compromised-key case, admitted.
    const signerOf = signerIndexFromRegistry([
      { principal: alice, agents: [{ did: 'did:web:retired', scope: 'ReadWrite', revoked: true }] },
    ]);
    expect(signerOf('did:web:retired')).toEqual({ acts: 'for', principal: alice, revoked: true });
    expect(scopesFromRegistry([
      { principal: alice, agents: [{ did: 'did:web:retired', scope: 'ReadWrite', revoked: true }] },
    ])[0]!.capabilities).toEqual([]);
  });

  it('★ a revoked key does NOT attest even when the principal has a live agent beside it', () => {
    // The exact shape that was admitted: one compromised ReadWrite row, one live one. The
    // union hides the revocation completely, so nothing else in the pipeline can catch it.
    const signerOf = signerIndexFromRegistry([
      { principal: bee, agents: [
        { did: 'did:web:bee-COMPROMISED', scope: 'ReadWrite', revoked: true },
        { did: 'did:web:bee-live', scope: 'ReadWrite' },
      ] },
    ]);
    const proof = { authorshipVerified: true, signedBy: 'did:web:bee-COMPROMISED', boundToDescriptor: true };
    expect(refuseAttestation(proof, bee, signerOf)).toMatch(/REVOKED/);
    // and the live one still works, so this is a narrowing and not a shutdown
    expect(refuseAttestation({ ...proof, signedBy: 'did:web:bee-live' }, bee, signerOf)).toBeNull();
  });

  it('★ a key TWO registries claim attributes to neither, and names both claimants', () => {
    // Anyone may write their own pod's registry, so anyone can list a rival's signing DID in
    // it. `index.set(id, principal)` with no collision detection let the later row win: the
    // victim's own verified grants were then refused as "signed by … who acts for mallory",
    // and the answer flipped on the order the rows arrived in — the same order-dependent,
    // unreported last-write-wins `foldRoster` intersects and reports one file over.
    const contested = [
      { principal: alice, agents: [{ did: 'did:web:contested', scope: 'ReadWrite' }] },
      { principal: bee, agents: [{ did: 'did:web:contested', scope: 'ReadWrite' }] },
    ];
    const forward = signerIndexFromRegistry(contested)('did:web:contested');
    const reversed = signerIndexFromRegistry([...contested].reverse())('did:web:contested');
    expect(forward).toEqual({ acts: 'contested', claimedBy: [alice, bee].sort() });
    expect(reversed).toEqual(forward); // order-independent, which is the whole point
    expect(refuseAttestation(
      { authorshipVerified: true, signedBy: 'did:web:contested', boundToDescriptor: true },
      alice,
      signerIndexFromRegistry(contested),
    )).toMatch(/registries claim that signer/);
  });

  it('one principal listing the same key twice is not contested — and revoked wins', () => {
    // A federated composer reads one registry per pod, so a duplicate row for one person is
    // ordinary. Two rows disagreeing about whether the delegation stands resolve to "it does
    // not", the same direction every other ambiguity in this layer resolves.
    const signerOf = signerIndexFromRegistry([
      { principal: alice, agents: [
        { did: 'did:web:dup', scope: 'ReadWrite' },
        { did: 'did:web:dup', scope: 'ReadWrite', revoked: true },
      ] },
    ]);
    expect(signerOf('did:web:dup')).toEqual({ acts: 'for', principal: alice, revoked: true });
  });
});

describe('canAct — the acting agent is a second ceiling', () => {
  it('★ the strongest role, exercised through a read-only agent, is refused', () => {
    // The principal's OTHER agents may be ReadWrite. What matters is the one in their hand.
    const roster = rosterOf([{ principal: alice, role: 'Convener', scope: 'ReadWrite' }]);
    const res = canAct(roster, alice, CAPS.append, { did: 'did:web:laptop', scope: 'ReadOnly' });
    expect(res.allowed).toBe(false);
    expect(res.because).toContain('did:web:laptop');
    expect(res.because).toMatch(/ReadOnly/);
  });

  it('the reason names the agent, so the fix is obvious rather than mysterious', () => {
    const roster = rosterOf([{ principal: alice, role: 'Contributor', scope: 'ReadWrite' }]);
    const res = canAct(roster, alice, CAPS.append, { did: 'did:web:ci-bot', scope: 'ReadOnly' });
    expect(res.because).toMatch(/acting through did:web:ci-bot/);
  });

  it('the same principal and agent, for a capability both carry, is allowed', () => {
    const roster = rosterOf([{ principal: alice, role: 'Contributor', scope: 'ReadWrite' }]);
    expect(canAct(roster, alice, CAPS.append, { did: 'did:web:laptop', scope: 'ReadWrite' }).allowed).toBe(true);
  });

  it('★ a revoked acting agent is refused, and is not described as merely too narrow', () => {
    // Falling through to the scope message would name ReadWrite and invite the reader to
    // widen a scope that is already as wide as it goes. The row is not too narrow; it is
    // withdrawn, and the two need different fixes.
    const roster = rosterOf([{ principal: alice, role: 'Convener', scope: 'ReadWrite' }]);
    const res = canAct(roster, alice, CAPS.append, { did: 'did:web:laptop', scope: 'ReadWrite', revoked: true });
    expect(res.allowed).toBe(false);
    expect(res.because).toMatch(/REVOKED/);
    expect(res.because).not.toMatch(/does not carry it/);
  });

  it('an agent with an unresolvable scope is refused, not waved through', () => {
    const roster = rosterOf([{ principal: alice, role: 'Convener', scope: 'ReadWrite' }]);
    expect(canAct(roster, alice, CAPS.read, { did: 'did:web:x' }).allowed).toBe(false);
  });

  it('can() folds and answers in one step for callers holding raw records', () => {
    const m = member(alice, 'Observer');
    const res = can({
      workspace: WS, profile: PROFILE, grants: [m.grant], acceptances: [m.acceptance],
      scopes: scopesFromRegistry([{ principal: alice, agents: [{ scope: 'ReadWrite' }] }]),
      principal: alice, capability: CAPS.append,
    });
    expect(res.allowed).toBe(false);
    expect(res.because).toMatch(/does not permit/);
  });
});

// ── Read-time enforcement ───────────────────────────────────────────────────

const mem = (principal: string, pod: string): ComposableMember => ({
  principal, stream: `${principal}/stream`, podUrl: pod,
});

function deps(byPod: Record<string, { url: string; at: string; prior?: string }[]>): StreamDeps {
  return {
    publish: vi.fn(),
    discover: vi.fn(async (args: Record<string, unknown>) => ({
      entries: (byPod[String(args.pod_url)] ?? []).map(e => ({
        descriptorUrl: e.url, cid: `cid${e.url.slice(-6)}`, validFrom: e.at,
        supersedes: e.prior ? [e.prior] : [],
        describes: [String(args.graph_iri)],
      })),
    })),
  };
}

describe('★ enforcement happens at the FOLD, because it cannot happen at the write', () => {
  const members = [mem(alice, 'https://alice.test/'), mem(bee, 'https://bee.test/')];
  const streams = {
    'https://alice.test/': [{ url: 'https://alice.test/c/1.ttl', at: '2026-08-01T10:00:00Z' }],
    'https://bee.test/': [{ url: 'https://bee.test/c/1.ttl', at: '2026-08-01T11:00:00Z' }],
  };

  it('an Observer\'s entries are excluded from the workspace view', async () => {
    // Nothing stopped bee writing this — it is her pod. What the roster decides is whether
    // it counts, and it does not.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    const view = authorizeView(await composeWorkspace({ workspace: WS, members }, deps(streams)), roster);
    expect(view.entries.map(e => e.principal)).toEqual([alice]);
  });

  it('★ but they are REPORTED, with the reason — never silently filtered', async () => {
    // "This member has been writing entries that do not count" is something somebody needs
    // to be told, and probably needs to fix by widening the role. Silent filtering makes an
    // unauthorised writer invisible to exactly the people responsible for them.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    const view = authorizeView(await composeWorkspace({ workspace: WS, members }, deps(streams)), roster);
    expect(view.disallowed).toHaveLength(1);
    expect(view.disallowed[0]!.entry.principal).toBe(bee);
    expect(view.disallowed[0]!.because).toMatch(/does not permit/);
  });

  it('★ a non-member\'s entries are excluded too, and the reason says so', async () => {
    // The pod is reachable and the stream verifies. Being readable is not being admitted.
    const roster = rosterOf([{ principal: alice, role: 'Contributor', scope: 'ReadWrite' }]);
    const view = authorizeView(await composeWorkspace({ workspace: WS, members }, deps(streams)), roster);
    expect(view.disallowed[0]!.because).toMatch(/is not a member/);
  });

  it('★ a revoked member\'s PAST entries stop counting, and the records survive', async () => {
    // Revocation is an append, not a deletion. The entries stay on bee's pod at their own
    // URLs — which is the custody property the whole design exists for — and the fold is
    // the only thing that changes.
    const m = member(bee, 'Contributor');
    const roster = foldRoster({
      workspace: WS, profile: PROFILE,
      grants: [member(alice, 'Contributor').grant, { ...m.grant, revoked: true }],
      acceptances: [member(alice, 'Contributor').acceptance, m.acceptance],
      scopes: scopesFromRegistry([alice, bee].map(p => ({ principal: p, agents: [{ scope: 'ReadWrite' }] }))),
    });
    const view = authorizeView(await composeWorkspace({ workspace: WS, members }, deps(streams)), roster);
    expect(view.entries.map(e => e.principal)).toEqual([alice]);
    expect(view.disallowed[0]!.entry.descriptorUrl).toBe('https://bee.test/c/1.ttl');
  });

  it('★ `complete` stays about REACHABILITY, not authority', async () => {
    // Folding the two together would make a correctly-governed workspace permanently
    // report itself as incomplete, and a flag that is always false is a flag nobody reads.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    const view = authorizeView(await composeWorkspace({ workspace: WS, members }, deps(streams)), roster);
    expect(view.complete).toBe(true);
    expect(view.disallowed).toHaveLength(1);
  });

  it('★ `notRead` and `disallowed` are complementary, never both and never neither', async () => {
    // Read bee's pod and her entry is reported as disallowed; skip it and she is reported
    // as notRead. Exactly one, so the same problem cannot be double-counted or vanish
    // depending on an optimisation the reader was never told had run.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    const view = authorizeView(await composeWorkspace({ workspace: WS, members }, deps(streams)), roster);
    expect(view.disallowed.map(d => d.entry.principal)).toEqual([bee]);
    expect(view.notRead).toEqual([]);
  });

  it('an unauthorised member whose pod was UNREACHABLE is not miscounted as unread', async () => {
    // "We did not look" and "we looked and could not reach it" are different facts, and the
    // second already has a field. Reporting both would send an operator after a pre-filter
    // that never ran while the actual outage sat in `unavailable` next to it.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    const dead: StreamDeps = {
      publish: vi.fn(),
      discover: vi.fn(async (args: Record<string, unknown>) => (
        String(args.pod_url) === 'https://bee.test/' ? { error: 'fetch failed' } : { entries: [] }
      )),
    };
    const view = authorizeView(await composeWorkspace({ workspace: WS, members }, dead), roster);
    expect(view.unavailable.map(u => u.member.principal)).toEqual([bee]);
    expect(view.notRead).toEqual([]);
  });

  it('everyone permitted means nothing is disallowed', async () => {
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Contributor', scope: 'ReadWrite' },
    ]);
    const view = authorizeView(await composeWorkspace({ workspace: WS, members }, deps(streams)), roster);
    expect(view.entries).toHaveLength(2);
    expect(view.disallowed).toEqual([]);
  });

  it('★★ an AUTHORIZED member nobody read is a gap: named, and `complete` is FALSE', async () => {
    // `notRead` was filtered to members who may NOT act — precisely the set `readableMembers`
    // skips on purpose. So the one member whose absence actually costs the reader content, a
    // Contributor missing from the caller's members list (a stale roster, no podUrl, a
    // hand-rolled filter), appeared in NO field and `complete` said `true`. A view missing an
    // entire authorized participant is the strongest thing `complete` exists to be false for,
    // and it was the single case that was invisible.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Contributor', scope: 'ReadWrite' },
    ]);
    const onlyAlice = await composeWorkspace(
      { workspace: WS, members: [mem(alice, 'https://alice.test/')] },
      deps({ 'https://alice.test/': [{ url: 'https://alice.test/c/1.ttl', at: '2026-08-01T10:00:00Z' }] }),
    );
    expect(onlyAlice.complete).toBe(true); // the composition itself reached everything it tried
    const view = authorizeView(onlyAlice, roster);
    expect(view.notRead.map(u => u.principal)).toEqual([bee]);
    expect(view.notRead[0]!.authorizedHere).toBe(true);
    expect(view.notRead[0]!.because).toMatch(/missing from this view rather than excluded/);
    expect(view.complete).toBe(false);
  });

  it('★ …and an unread member who may NOT act still leaves `complete` true', async () => {
    // The other half, and the reason the two are not folded together: making `complete` false
    // for a deliberately-skipped Observer would make every correctly-governed workspace
    // permanently incomplete, and a flag that is always false is a flag nobody reads.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    const view = authorizeView(
      await composeWorkspace(
        { workspace: WS, members: [mem(alice, 'https://alice.test/')] },
        deps({ 'https://alice.test/': [{ url: 'https://alice.test/c/1.ttl', at: '2026-08-01T10:00:00Z' }] }),
      ),
      roster,
    );
    expect(view.notRead[0]!.authorizedHere).toBe(false);
    expect(view.complete).toBe(true);
  });

  it('★ describeCoverage names `disallowed` and `notRead`, which it used to silently drop', async () => {
    // Typed on ComposedView, it dropped both from every AuthorizedView — which is assignable,
    // and which both live verifiers pipe straight in. So the one function whose stated job is
    // that a view can describe its own gaps rendered a workspace with a member writing
    // entries that do not count as "1 entries from 2 of 2 streams", with no hint at all.
    //
    // ★ AND THE VIEW IS COMPOSED, NOT HAND-ROLLED, WHICH IS THE WHOLE POINT.
    // This test built `roster` and then never read it, standing up an `as unknown as` object
    // literal in place of the pipeline instead. What it therefore asserted was that
    // describeCoverage can render two fields somebody typed out by hand — true, and
    // unfalsifiable by anything that could actually break. authorizeView could stop
    // populating `disallowed`, stop setting `authorizedHere`, or stop producing `notRead`
    // altogether, and this test would still pass. Reading bee (an Observer, so her entries
    // do not count) while never reading alice (a Contributor, so her absence is a hole)
    // makes the composition produce one of each, for real.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    const view = authorizeView(
      await composeWorkspace(
        { workspace: WS, members: [mem(bee, 'https://bee.test/')] },
        deps({ 'https://bee.test/': [{ url: 'https://bee.test/c/1.ttl', at: '2026-08-01T11:00:00Z' }] }),
      ),
      roster,
    );
    // Pinned before rendering: if these are empty the sentence assertions below pass
    // vacuously against a describeCoverage that simply omitted both clauses.
    expect(view.disallowed.map(d => d.entry.principal)).toEqual([bee]);
    expect(view.notRead.map(u => u.principal)).toEqual([alice]);
    expect(view.notRead[0]!.authorizedHere).toBe(true);

    const line = describeCoverage(view);
    expect(line).toMatch(/NOT counted as workspace content/);
    expect(line).toContain(bee);
    expect(line).toMatch(/AUTHORIZED member\(s\) never read/);
    expect(line).toContain(alice);
  });
});

describe('readableMembers — not reading a pod you would discard', () => {
  it('drops members who may not append before the fan-out', () => {
    // Catch-up already costs one request per member. Paying for one you will throw away is
    // a real cost, though it is an optimisation and not a control: the view would exclude
    // their entries regardless.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    expect(readableMembers(roster, [mem(alice, 'a'), mem(bee, 'b')]).map(m => m.principal)).toEqual([alice]);
  });

  it('★ a member dropped here is still REPORTED by the view, not deleted from it', async () => {
    // The property this whole layer exists for is that an unauthorised writer is surfaced
    // rather than silently filtered. Pre-filtering removed exactly that: bee's pod is never
    // read, so she contributes no entries, so `disallowed` is empty — and the view reports
    // a clean workspace it has merely not looked at. The optimisation deleted the report
    // the same file argues for.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    const all = [mem(alice, 'https://alice.test/'), mem(bee, 'https://bee.test/')];
    const view = authorizeView(
      await composeWorkspace(
        { workspace: WS, members: readableMembers(roster, all) },
        deps({
          'https://alice.test/': [{ url: 'https://alice.test/c/1.ttl', at: '2026-08-01T10:00:00Z' }],
          'https://bee.test/': [{ url: 'https://bee.test/c/1.ttl', at: '2026-08-01T11:00:00Z' }],
        }),
      ),
      roster,
    );
    expect(view.disallowed).toEqual([]);
    expect(view.notRead.map(u => u.principal)).toEqual([bee]);
    expect(view.notRead[0]!.because).toMatch(/does not permit/);
  });

  it('★ the report is derived, so hand-rolling the same filter cannot lose it either', () => {
    // Recovered from the roster against the streams actually attempted, not threaded in by
    // the caller. A caller who never touches readableMembers — composing a subset for their
    // own reasons — gets the same report, because there is nothing to pass and therefore
    // nothing to forget to pass.
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Observer', scope: 'ReadWrite' },
    ]);
    const onlyAlice = {
      workspace: WS, entries: [], streams: [{ member: mem(alice, 'a'), rows: 0, report: { intact: true, ordered: [] } }],
      unavailable: [], unverified: [], misattributed: [], complete: true, crossStreamOrderIsAdvisory: true,
    } as unknown as Parameters<typeof authorizeView>[0];
    expect(authorizeView(onlyAlice, roster).notRead.map(u => u.principal)).toEqual([bee]);
  });
});
