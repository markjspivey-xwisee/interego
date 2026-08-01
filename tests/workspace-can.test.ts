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
  capabilitiesForScope, scopesFromRegistry, canAct, can, authorizeView, readableMembers, CAPS,
  type RoleProfile,
} from '../applications/shared-workspace/src/can.js';
import { foldRoster } from '../applications/shared-workspace/src/roster.js';
import { composeWorkspace, type ComposableMember } from '../applications/shared-workspace/src/compose.js';
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

  it('★ a Convener with a ReadOnly delegation still cannot append', () => {
    // The property that distinguishes a published roster from a membership table: in a
    // table, being an admin IS the authority. Here it is only a bound on it.
    const roster = rosterOf([{ principal: alice, role: 'Convener', scope: 'ReadOnly' }]);
    expect(canAct(roster, alice, CAPS.append).allowed).toBe(false);
    expect(canAct(roster, alice, CAPS.append).because).toMatch(/ceiling, never a grant/);
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

  it('everyone permitted means nothing is disallowed', async () => {
    const roster = rosterOf([
      { principal: alice, role: 'Contributor', scope: 'ReadWrite' },
      { principal: bee, role: 'Contributor', scope: 'ReadWrite' },
    ]);
    const view = authorizeView(await composeWorkspace({ workspace: WS, members }, deps(streams)), roster);
    expect(view.entries).toHaveLength(2);
    expect(view.disallowed).toEqual([]);
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
});
