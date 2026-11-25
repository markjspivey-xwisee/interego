/**
 * What a person and the agents learning beside them share: assignments, standings, peers, a team.
 *
 * ★ WHY. `learner_kind: "agent"` (an-agent-learns-beside-its-person.test.ts) gave a delegate its
 * own cmi5 record. Four things were still the person's alone:
 * - **assignment**: only a person in the tenant directory had assigned courses; an agent learning
 *   beside them had nothing to be launched from;
 * - **the other signed learner routes** (credentials, LTI) still read a delegate as its person;
 * - **reaching coworkers**: companions are one person's own agents, and nothing let a learner
 *   find anyone else's;
 * - **consulting**: the agent-performance tools read a team of agents, and nothing said that a
 *   person's delegates are one.
 *
 * `POST /agent/learning/beside` reads all four for the pair and writes nothing. The rules that
 * decide what it may say are pure and are pinned here (src/learning-beside.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { delegatesOf, pairStandings, peersOn, type BesideLaunch } from '../src/learning-beside.js';
import { buildCmi5Launch, delegatesLearningBeside, launchesOfPair, peersOnCourse, setPeerVisibility } from '../src/cmi5-lms.js';
import type { TenantId } from '../src/tenant-context.js';

const ANA = 'https://identity.example/users/ana#me';
const ANA_AGENT = 'did:web:identity.example:agents:claude-ana';
const ANA_AGENT_2 = 'did:web:identity.example:agents:codex-ana';
const BO = 'https://identity.example/users/bo#me';
const BO_AGENT = 'did:web:identity.example:agents:claude-bo';
const CY = 'https://identity.example/users/cy#me';

const row = (registration: string, learner: string, o: Partial<BesideLaunch> = {}): BesideLaunch =>
  ({ registration, auId: 'au-1', courseId: 'course-1', learner: { id: learner }, satisfied: false, ...o });

describe('whose agents are whose', () => {
  it('are the learners whose launches say they learn beside that person, each once', () => {
    const launches = [row('r1', ANA), row('r2', ANA_AGENT, { beside: { id: ANA } }), row('r3', ANA_AGENT, { beside: { id: ANA } }), row('r4', BO_AGENT, { beside: { id: BO } })];
    expect(delegatesOf(launches, ANA)).toEqual([ANA_AGENT]);
    expect(delegatesOf(launches, CY)).toEqual([]);
  });
});

describe('finding other learners on a course', () => {
  const launches = [
    row('a', ANA, { visibleToPeers: true }),
    row('a2', ANA_AGENT, { beside: { id: ANA }, visibleToPeers: true }),
    row('b', BO, { visibleToPeers: true, satisfied: true }),
    row('b2', BO_AGENT, { beside: { id: BO } }),
    row('c', CY),
  ];

  it('lists those who offered, with how to reach them, and nobody who did not', () => {
    expect(peersOn(launches, ANA)).toEqual([{ learner: BO, kind: 'human', satisfied: true, contact: { via: 'interego-inbox', tool: 'notify_agent', to: BO } }]);
  });

  it('shows nobody to a learner who has not offered', () => {
    expect(peersOn(launches, CY)).toEqual([]);
    expect(peersOn(launches, BO_AGENT, BO)).toEqual([]);
  });

  it('does not make a person visible by what their agent chose, or the agent by the person', () => {
    // Bo offered; Bo's agent did not, and is not listed.
    expect(peersOn(launches, ANA).map(p => p.learner)).not.toContain(BO_AGENT);
    // An agent that offered while its person did not: the agent is found, the person is not.
    const split = [row('a', ANA, { visibleToPeers: true }), row('b', BO), row('b2', BO_AGENT, { beside: { id: BO }, visibleToPeers: true })];
    expect(peersOn(split, ANA)).toEqual([{ learner: BO_AGENT, kind: 'agent', beside: BO, satisfied: false, contact: { via: 'interego-inbox', tool: 'notify_agent', to: BO_AGENT } }]);
  });

  it('leaves out the asker and their own household: those are companions', () => {
    expect(peersOn(launches, ANA).map(p => p.learner)).not.toContain(ANA_AGENT);
    expect(peersOn(launches, ANA_AGENT, ANA).map(p => p.learner)).toEqual([BO]);
  });

  it('is withdrawn by any explicit false, not kept by an older yes', () => {
    const withdrawn = [row('a', ANA, { visibleToPeers: true }), row('b', BO, { visibleToPeers: false }), row('b0', BO, { visibleToPeers: false })];
    expect(peersOn(withdrawn, ANA)).toEqual([]);
  });
});

describe('where a person and their agents stand', () => {
  const assignments = [{ courseId: 'course-1', courseTitle: 'Confined Space Entry', dueAt: '2026-12-31T00:00:00Z' }, { courseId: 'course-2', courseTitle: 'Lockout' }];
  const launches = [
    row('p', ANA),
    row('g', ANA_AGENT, { beside: { id: ANA }, satisfied: true }),
    row('x', ANA, { courseId: 'course-9' }),
    row('other', BO, { satisfied: true }),
    row('other2', BO_AGENT, { beside: { id: BO }, satisfied: true }),
  ];

  it('lists what is assigned to the person and what either has launched, each with both standings', () => {
    const s = pairStandings({ person: ANA, assignments, launches, reader: { kind: 'human', id: ANA } });
    expect(s).toEqual([
      { courseId: 'course-1', courseTitle: 'Confined Space Entry', assigned: true, dueAt: '2026-12-31T00:00:00Z', person: { learner: ANA, satisfied: false, launched: true }, agents: [{ learner: ANA_AGENT, satisfied: true, launched: true }] },
      { courseId: 'course-2', courseTitle: 'Lockout', assigned: true, person: { learner: ANA, satisfied: false, launched: false }, agents: [{ learner: ANA_AGENT, satisfied: false, launched: false }] },
      { courseId: 'course-9', assigned: false, person: { learner: ANA, satisfied: false, launched: true }, agents: [{ learner: ANA_AGENT, satisfied: false, launched: false }] },
    ]);
  });

  it('tells an agent whose assignment each one is, and lists it before it has launched anything', () => {
    const s = pairStandings({ person: ANA, agents: [ANA_AGENT_2], assignments, launches: [], reader: { kind: 'agent', id: ANA_AGENT_2 } });
    expect(s.map(c => [c.courseId, c.assignedThrough])).toEqual([['course-1', ANA], ['course-2', ANA]]);
    expect(s[0]!.agents).toEqual([{ learner: ANA_AGENT_2, satisfied: false, launched: false }]);
  });

  it('never counts another person\'s or another person\'s agent\'s progress', () => {
    const s = pairStandings({ person: ANA, assignments, launches, reader: { kind: 'human', id: ANA } });
    expect(JSON.stringify(s)).not.toContain(BO);
    expect(JSON.stringify(s)).not.toContain(BO_AGENT);
  });

  it('does not take a launch made beside someone else as the person\'s own', () => {
    const odd = [row('q', ANA, { beside: { id: BO }, satisfied: true })];
    expect(pairStandings({ person: ANA, assignments: [], launches: odd })).toEqual([]);
  });
});

describe('on the LMS\'s own records', () => {
  // ★ A signed launch is kept under the lens of the learner's own pod, so Ana and Bo are in
  // different tenants, as they are on the deployed bridge. The first version of this put them in
  // one tenant and so never saw that a search of the asker's tenant finds no coworker at all
  // (Codex, review of #1003).
  const anaTenant = 'lens:u-pk-ana' as TenantId;
  const boTenant = 'lens:u-pk-bo' as TenantId;
  const course = 'https://bridge.example/course/together';
  const base = {
    au: { id: 'https://bridge.example/au/t1', url: 'https://bridge.example/content/au/t/0', moveOn: 'Completed' as const, title: 'Unit' },
    lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
    authoritativeSource: 'did:web:bridge.example', courseId: course,
  };
  buildCmi5Launch({ ...base, tenant: anaTenant, learner: { id: ANA }, visibleToPeers: true });
  buildCmi5Launch({ ...base, tenant: anaTenant, learner: { id: ANA_AGENT }, beside: { id: ANA } });
  buildCmi5Launch({ ...base, tenant: boTenant, learner: { id: BO }, visibleToPeers: true });
  buildCmi5Launch({ ...base, tenant: boTenant, learner: { id: BO } });
  buildCmi5Launch({ ...base, tenant: boTenant, learner: { id: BO_AGENT }, beside: { id: BO } });
  buildCmi5Launch({ ...base, tenant: 'lens:u-pk-cy' as TenantId, learner: { id: CY } });

  it('reads the pair and its agents from the person\'s own partition only', () => {
    expect(launchesOfPair(anaTenant, ANA).map(l => l.learner.id).sort()).toEqual([ANA, ANA_AGENT].sort());
    expect(delegatesLearningBeside(anaTenant, ANA)).toEqual([ANA_AGENT]);
    expect(launchesOfPair(boTenant, ANA)).toEqual([]);
    expect(delegatesLearningBeside(boTenant, ANA)).toEqual([]);
  });

  it('finds a coworker who offered, though their record is kept under another pod', () => {
    expect(peersOnCourse(course, ANA).map(p => p.learner)).toEqual([BO]);
    expect(peersOnCourse(course, BO).map(p => p.learner)).toEqual([ANA]);
  });

  it('crosses the partition for nobody who did not offer, and shows nothing to an asker who did not', () => {
    const found = peersOnCourse(course, ANA).map(p => p.learner);
    expect(found).not.toContain(BO_AGENT);
    expect(found).not.toContain(CY);
    expect(peersOnCourse(course, CY)).toEqual([]);
    expect(peersOnCourse(course, ANA_AGENT, ANA)).toEqual([]);
    expect(peersOnCourse('https://bridge.example/course/other', ANA)).toEqual([]);
  });

  it('says of a peer only who they are, their kind, and whether they are through', () => {
    for (const peer of peersOnCourse(course, ANA)) {
      expect(Object.keys(peer).sort()).toEqual(['contact', 'kind', 'learner', 'satisfied']);
    }
  });

  it('withdraws every registration of a learner at once, and offers them all at once', () => {
    expect(setPeerVisibility(boTenant, course, BO, false)).toBe(1);
    expect(peersOnCourse(course, ANA)).toEqual([]);
    expect(setPeerVisibility(boTenant, course, BO, true)).toBe(2);
    expect(peersOnCourse(course, ANA).map(p => p.learner)).toEqual([BO]);
    expect(setPeerVisibility(boTenant, course, BO, true)).toBe(0);
    // A learner's say is their own partition's to change: another tenant's call changes nothing.
    expect(setPeerVisibility(anaTenant, course, BO, false)).toBe(0);
    expect(peersOnCourse(course, ANA).map(p => p.learner)).toEqual([BO]);
  });
});

describe('the routes', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (path: string): string => {
    const at = src.indexOf(`app.post('${path}',`);
    expect(at, path).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf('\n});\n', at));
  };

  it('take the learner from the signature on every signed learner route, agent or person', () => {
    for (const path of ['/agent/learning/beside', '/agent/credentials/earned', '/agent/credentials/claim', '/agent/lti/launch', '/agent/lti/gradebook', '/agent/cmi5/launch']) {
      const body = route(path);
      expect(body, path).toContain('const auth = await verifyDelegatedCaller(req.body);');
      expect(body, path).toContain('const learner = await signedLearnerOfKind(auth);');
      expect(body, path).toContain('if (!learner.ok) { res.status(learner.status).json({ error: learner.error }); return; }');
    }
  });

  it('read the pair without writing, and never name a learner from the request body', () => {
    const body = route('/agent/learning/beside');
    expect(body).not.toMatch(/setPeerVisibility|buildCmi5Launch|publish|recordLaunchedStatement/);
    expect(body).not.toMatch(/auth\.payload\.(learner|person|beside|learner_did)\b/);
    expect(body).toContain('assignmentsRead: admin !== null');
  });

  it('say in a credential that an agent took the course, and beside whom', () => {
    expect(route('/agent/credentials/claim')).toContain('taken by an AI agent learning beside ${learner.beside}');
  });

  it('limit how often the pair is read, per client, before the signature is even verified', () => {
    expect(src).toContain("const learningBesideRateLimit = forwardedRateLimit({ windowMs: 60_000, limit: 30, identifier: 'learning-beside' });");
    expect(src).toContain("app.post('/agent/learning/beside', learningBesideRateLimit, async (req, res) => {");
  });

  it('offer an agent the claim that is the agent\'s own', () => {
    expect(route('/agent/credentials/earned')).toContain("payload: { course_id: st.courseId, ...(learner.kind === 'agent' ? { learner_kind: 'agent' } : {}) }");
  });

  it('take visible_to_peers as a boolean and nothing else', () => {
    const body = route('/agent/cmi5/launch');
    expect(body).toContain("if (visible !== undefined && typeof visible !== 'boolean')");
    expect(body).toContain('if (visible !== undefined) setPeerVisibility(tenant, course.id, learner.did, visible);');
  });
});
