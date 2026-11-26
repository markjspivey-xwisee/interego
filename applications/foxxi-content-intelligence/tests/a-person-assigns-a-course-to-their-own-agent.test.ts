/**
 * A person assigns a course to their own agent, and the pair read shows recorded work's disposition.
 *
 * ★ WHY. After agents became learners two things were still out of reach of a pair in no tenant
 * directory (AGENT-COLLABORATION.md section 6, "Designed, for later", 2026-11-25):
 * - **assignment**: an agent was assigned only what its person was, by a directory admin. A person
 *   could not hand a course to their own agent;
 * - **the disposition read**: `foxxi.assess_agent_disposition` answers a directory member only, so
 *   the consult the pair read pointed at refused the very callers it was shown to.
 *
 * The record and its rules are pure and pinned here (src/own-agent-assignments.ts,
 * src/learning-beside.ts); the route's own checks are pinned against its source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OwnAgentAssignments, dueAtFrom } from '../src/own-agent-assignments.js';
import { pairStandings } from '../src/learning-beside.js';

const ANA = 'https://identity.example/users/ana#me';
const BO = 'https://identity.example/users/bo#me';
const AGENT = 'did:web:identity.example:agents:claude-ana';
const AGENT_2 = 'did:web:identity.example:agents:codex-ana';
const T0 = Date.parse('2026-11-25T12:00:00Z');

describe('the record of what a person assigned to their own agents', () => {
  it('keeps one assignment per person, agent and course, and when it was first made', () => {
    const r = new OwnAgentAssignments();
    const first = r.assign({ person: ANA, agent: AGENT, courseId: 'c1', courseTitle: 'Course one' }, T0);
    expect(first).toMatchObject({ created: true, assignment: { person: ANA, agent: AGENT, courseId: 'c1', assignedAt: '2026-11-25T12:00:00.000Z' } });
    const again = r.assign({ person: ANA, agent: AGENT, courseId: 'c1', dueAt: '2026-12-01T00:00:00.000Z' }, T0 + 60_000);
    expect(again).toMatchObject({ created: false, assignment: { assignedAt: '2026-11-25T12:00:00.000Z', dueAt: '2026-12-01T00:00:00.000Z' } });
    expect(r.size).toBe(1);
    expect(r.dirty).toBe(true);
  });

  it('does not assign a person to themselves', () => {
    expect(new OwnAgentAssignments().assign({ person: ANA, agent: ANA, courseId: 'c1' }, T0)).toHaveProperty('refused');
  });

  it('returns a person their own, and an agent only what that person assigned it', () => {
    const r = new OwnAgentAssignments();
    r.assign({ person: ANA, agent: AGENT, courseId: 'c1' }, T0);
    r.assign({ person: ANA, agent: AGENT_2, courseId: 'c2' }, T0);
    r.assign({ person: BO, agent: AGENT, courseId: 'c3' }, T0);
    expect(r.forPerson(ANA).map(a => a.courseId).sort()).toEqual(['c1', 'c2']);
    // Bo's record naming the same agent id is not Ana's, and is not shown on Ana's pair.
    expect(r.forPair(ANA, AGENT).map(a => a.courseId)).toEqual(['c1']);
    expect(r.forPair(BO, AGENT_2)).toEqual([]);
  });

  it('caps what one person may hold', () => {
    const r = new OwnAgentAssignments(10, 2);
    r.assign({ person: ANA, agent: AGENT, courseId: 'c1' }, T0);
    r.assign({ person: ANA, agent: AGENT, courseId: 'c2' }, T0);
    expect(r.assign({ person: ANA, agent: AGENT, courseId: 'c3' }, T0)).toHaveProperty('refused');
    // Changing one already held is not a new one.
    expect(r.assign({ person: ANA, agent: AGENT, courseId: 'c2', dueAt: '2026-12-01T00:00:00.000Z' }, T0)).toMatchObject({ created: false });
  });

  it('survives a restart through its durable copy, and skips what is malformed', () => {
    const a = new OwnAgentAssignments();
    a.assign({ person: ANA, agent: AGENT, courseId: 'c1' }, T0);
    const copy = JSON.parse(JSON.stringify(a));
    const b = new OwnAgentAssignments();
    expect(b.load({ ...copy, junk: { person: ANA }, self: { person: ANA, agent: ANA, courseId: 'c9', assignedAt: '2026-11-25T12:00:00.000Z' }, bad: 'x' })).toBe(1);
    expect(b.forPair(ANA, AGENT)).toHaveLength(1);
    expect(b.dirty).toBe(false);
  });

  it('files a loaded entry under what its own fields say, whatever key the copy used', () => {
    const b = new OwnAgentAssignments();
    b.load({ 'someone-elses-key': { person: ANA, agent: AGENT, courseId: 'c1', assignedAt: '2026-11-25T12:00:00.000Z' } });
    expect(b.withdraw({ person: ANA, agent: AGENT, courseId: 'c1' })).toBe(true);
  });

  it('keeps a withdrawal withdrawn when the durable copy that still holds it is merged', () => {
    const r = new OwnAgentAssignments();
    r.assign({ person: ANA, agent: AGENT, courseId: 'c1' }, T0);
    const stale = JSON.parse(JSON.stringify(r));
    expect(r.withdraw({ person: ANA, agent: AGENT, courseId: 'c1' })).toBe(true);
    expect(r.withdraw({ person: ANA, agent: AGENT, courseId: 'c1' })).toBe(false);
    // The commit reads the pod's copy before writing: that read must not bring it back.
    r.load(stale);
    expect(r.size).toBe(0);
    // Once the pod holds the withdrawal, and the person assigns it again, it is an assignment again.
    r.committed(r.pendingWithdrawals());
    expect(r.assign({ person: ANA, agent: AGENT, courseId: 'c1' }, T0)).toMatchObject({ created: true });
    r.load(stale);
    expect(r.forPair(ANA, AGENT)[0]!.assignedAt).toBe('2026-11-25T12:00:00.000Z');
  });

  it('keeps a withdrawal made while a write was in flight', () => {
    const r = new OwnAgentAssignments();
    r.assign({ person: ANA, agent: AGENT, courseId: 'c1' }, T0);
    r.assign({ person: ANA, agent: AGENT, courseId: 'c2' }, T0);
    r.withdraw({ person: ANA, agent: AGENT, courseId: 'c2' });
    // A write begins: its body, and the withdrawals that body covers, are taken now.
    const body = JSON.parse(JSON.stringify(r));
    const covered = r.pendingWithdrawals();
    // While it is in flight, c1 is withdrawn.
    r.withdraw({ person: ANA, agent: AGENT, courseId: 'c1' });
    r.committed(covered);
    // The next write reads the pod, which holds the body that was written: c1 is in it.
    r.load(body);
    expect(r.size).toBe(0);
    expect(r.pendingWithdrawals()).toHaveLength(1);
  });

  it('lets what this process holds win over the copy for the same assignment', () => {
    const r = new OwnAgentAssignments();
    r.assign({ person: ANA, agent: AGENT, courseId: 'c1', dueAt: '2026-12-01T00:00:00.000Z' }, T0);
    const stale = JSON.parse(JSON.stringify(r));
    r.assign({ person: ANA, agent: AGENT, courseId: 'c1', dueAt: '2026-12-15T00:00:00.000Z' }, T0);
    r.load(stale);
    expect(r.forPair(ANA, AGENT)[0]!.dueAt).toBe('2026-12-15T00:00:00.000Z');
  });

  it('takes a due date that is an instant, and no other', () => {
    expect(dueAtFrom(undefined)).toEqual({ ok: true });
    expect(dueAtFrom('2026-12-01T00:00:00Z')).toEqual({ ok: true, dueAt: '2026-12-01T00:00:00.000Z' });
    expect(dueAtFrom('next week')).toMatchObject({ ok: false });
    expect(dueAtFrom(5)).toMatchObject({ ok: false });
  });
});

describe('the pair, with what the person assigned their agents', () => {
  const own = [{ agent: AGENT, courseId: 'c1', courseTitle: 'Course one', assignedAt: '2026-11-25T12:00:00.000Z', dueAt: '2026-12-01T00:00:00.000Z' }];

  it('lists the course and the agent though neither has launched anything', () => {
    const [c] = pairStandings({ person: ANA, assignments: [], launches: [], ownAssignments: own });
    expect(c).toMatchObject({
      courseId: 'c1', courseTitle: 'Course one', assigned: false,
      person: { learner: ANA, launched: false },
      agents: [{ learner: AGENT, launched: false, satisfied: false, assignedByPerson: { assignedAt: '2026-11-25T12:00:00.000Z', dueAt: '2026-12-01T00:00:00.000Z' } }],
    });
  });

  it('says it on that agent and no other, and leaves the directory\'s word about the person alone', () => {
    const [c] = pairStandings({ person: ANA, agents: [AGENT_2], assignments: [{ courseId: 'c1', courseTitle: 'From the directory' }], launches: [], ownAssignments: own });
    expect(c!.assigned).toBe(true);
    expect(c!.courseTitle).toBe('From the directory');
    expect(c!.agents.find(a => a.learner === AGENT)).toHaveProperty('assignedByPerson');
    expect(c!.agents.find(a => a.learner === AGENT_2)).not.toHaveProperty('assignedByPerson');
  });

  it('ignores them for an agent with no person', () => {
    expect(pairStandings({ person: AGENT, alone: true, assignments: [], launches: [], ownAssignments: own })).toEqual([]);
  });
});

describe('the bridge', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const start = src.indexOf("app.post('/agent/learning/assign'");
  const route = src.slice(start, src.indexOf("\n});", start));

  it('limits the route before anything else runs, and verifies the signature', () => {
    expect(src).toContain("app.post('/agent/learning/assign', assignToAgentRateLimit, async (req, res) => {");
    expect(route).toContain('await verifyDelegatedCaller(req.body)');
  });

  it('assigns only to an agent whose own delegation names the signer, and in force', () => {
    // The agent is named by the request, so its pod is asked for as a named identity's is.
    expect(route).toContain('const agentPod = namedSubjectPodUrl(toAgent);');
    expect(route).toContain('readDelegationCredential(agentPod, toAgent as IRI');
    expect(route).toContain("named.toLowerCase() !== person.did.toLowerCase()");
    expect(route).toContain('Date.parse(expires) <= Date.now()');
    // The check comes before anything is changed.
    expect(route.indexOf('named.toLowerCase() !== person.did.toLowerCase()')).toBeLessThan(route.indexOf('ownAgentAssignments.assign('));
    expect(route.indexOf('named.toLowerCase() !== person.did.toLowerCase()')).toBeLessThan(route.indexOf('ownAgentAssignments.withdraw('));
  });

  it('does not let an agent reading as itself assign', () => {
    expect(route).toContain("auth.payload.learner_kind !== undefined && auth.payload.learner_kind !== 'human'");
  });

  it('writes to the pod before it answers, and says when the pod does not hold it', () => {
    expect(route).toContain('const durable = await writeOwnAssignments();');
    expect(route).toContain('assignment: made.assignment, durable,');
    // A read of the kept assignments that failed changes nothing.
    expect(route).toContain("(await reloadOwnAssignments()) === 'failed'");
  });

  it('shows an agent reading as itself only its own assignments', () => {
    expect(src).toContain("learner.kind === 'agent' ? ownAgentAssignments.forPair(person, learner.did) : ownAgentAssignments.forPerson(person)");
  });

  it('reads the disposition from recorded work alone, never from course steps', () => {
    expect(src).toContain('read: assessDisposition(recorded),');
    // Only a trajectory that names the agent: the pod's own mesh trajectory is its owner's.
    expect(src).toContain('trajectoriesRecordedApart(a, learner.podUrl).filter((t) => t.agentDid === a)');
    // One registry write at a time, and a write forgets only the withdrawals its body covered.
    expect(src).toContain('ownAssignmentsWrite = ownAssignmentsWrite.then(writeOwnAssignmentsOnce, writeOwnAssignmentsOnce);');
    expect(src).toContain('ownAgentAssignments.committed(covered)');
    expect(src).not.toContain('assessDisposition(courseSteps');
  });
});

describe('the launch the pair read offers for a course', () => {
  it('is the one that plays it', async () => {
    const { launchOffer } = await import('../src/learning-beside.js');
    expect(launchOffer({ courseId: 'c1', kind: 'cmi5', learnerKind: 'agent' }))
      .toEqual({ action: 'urn:iep:action:foxxi:cmi5-launch-signed', path: '/agent/cmi5/launch', payload: { course_id: 'c1', learner_kind: 'agent' } });
    expect(launchOffer({ courseId: 'c1', kind: 'cmi5', learnerKind: 'human' })).toMatchObject({ payload: { course_id: 'c1' } });
    // The SCORM engine's launch is another affordance, and the signer is its learner.
    expect(launchOffer({ courseId: 'AUTH-101', kind: 'scorm-engine', learnerKind: 'agent', authoredBy: 'did:ethr:0x8f' }))
      .toEqual({ action: 'urn:iep:action:foxxi:scorm-launch-signed', path: '/agent/scorm/launch', payload: { course_id: 'AUTH-101', author_did: 'did:ethr:0x8f' } });
  });

  it('is not the SCORM engine\'s launch for a person whose request an agent carries', async () => {
    // That launch's learner is whoever signs. Offered here it would start the agent's attempt
    // under an answer about the person.
    const { launchOffer } = await import('../src/learning-beside.js');
    expect(launchOffer({ courseId: 'AUTH-101', kind: 'scorm-engine', learnerKind: 'human', carriedBy: 'did:web:x:agents:a' })).toHaveProperty('none');
    // The person's own wallet, and an agent reading as itself, are each their launch's signer.
    expect(launchOffer({ courseId: 'AUTH-101', kind: 'scorm-engine', learnerKind: 'human' })).toHaveProperty('action');
    expect(launchOffer({ courseId: 'AUTH-101', kind: 'scorm-engine', learnerKind: 'agent', carriedBy: 'did:web:x:agents:a' })).toHaveProperty('action');
    // cmi5 takes the person as its learner from the delegation, so it is offered either way.
    expect(launchOffer({ courseId: 'c1', kind: 'cmi5', learnerKind: 'human', carriedBy: 'did:web:x:agents:a' })).toHaveProperty('action');
  });

  it('is absent, with the reason, for a course nothing here plays now', async () => {
    const { launchOffer } = await import('../src/learning-beside.js');
    expect(launchOffer({ courseId: 'gone', kind: 'unknown', learnerKind: 'human' })).toHaveProperty('none');
  });

  it('is what the bridge puts on each course', () => {
    const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    expect(src).toContain("? { playedBy: kind, launchWhy: offer.none }");
    expect(src).not.toContain('launch: { affordance: launchAction');
  });
});
