/**
 * A delegate that is itself the learner launches a cmi5 course as itself, beside its person.
 *
 * ★ WHY. A person brings their agents to Foxxi as delegates, to learn beside them. A delegate's
 * cmi5 launch was always the person's: registration, statements and `satisfied` were recorded for
 * the person, with the agent only as `via`. Found on the deployed bridge, 2026-11-25: a Claude
 * connector played a hosted unit and the person's own record gained two `satisfied`. The person's
 * record said they had done what their agent did, and the agent had no record to be assigned
 * from or consulted on.
 *
 * Compositions already take `learner_kind` (a wallet is a person, a delegate is an agent, either
 * may say otherwise). The cmi5 launch now takes it too (src/learning-beside.ts). An agent learner:
 * - is the actor of its statements, with its own registration, progression and `satisfied`;
 * - names its person in `context.team`, which the LMS puts in the cmi5 context template, so an
 *   AU written with no idea of agents records it; no term is minted for it;
 * - changes nothing in the person's record.
 * Without `learner_kind`, a delegate's launch is the person's, as before.
 */
import { describe, expect, it } from 'vitest';
import { besideOf, besideTeam, companionsOn, learnerFor, learnerKindFrom } from '../src/learning-beside.js';
import { buildCmi5Launch, companionsOnCourse, inspectRegistration, learnerSatisfiedAus, observeCmi5Statement } from '../src/cmi5-lms.js';
import { validateStatement } from '../src/xapi-validate.js';
import type { TenantId } from '../src/tenant-context.js';

const PERSON = 'https://identity.example/users/u-pk-1/profile#me';
const AGENT = 'did:web:identity.example:agents:claude-u-pk-1';
const HOME = 'did:web:bridge.example';

describe('who a signed caller is learning as', () => {
  const delegation = { person: PERSON };

  it('is itself for a wallet, which cannot learn beside anyone', () => {
    expect(learnerFor({ callerDid: 'did:ethr:0x1', direct: true, delegation: null })).toEqual({ ok: true, did: 'did:ethr:0x1', kind: 'human' });
    // Until 2026-11-25 this was a 400: "agent" was only for a delegate. An agent that holds its own
    // wallet and works for nobody then had no way to say what it is, and was recorded as a person.
    // It now learns as an agent beside no one (an-agent-with-no-person-and-a-course-record.test.ts).
    expect(learnerFor({ callerDid: 'did:ethr:0x1', direct: true, delegation: null, kind: 'agent' })).toEqual({ ok: true, did: 'did:ethr:0x1', kind: 'agent' });
  });

  it('is the person for a delegate that does not say, as before', () => {
    expect(learnerFor({ callerDid: AGENT, direct: false, delegation })).toEqual({ ok: true, did: PERSON, kind: 'human', via: AGENT });
    expect(learnerFor({ callerDid: AGENT, direct: false, delegation, kind: 'human' })).toEqual({ ok: true, did: PERSON, kind: 'human', via: AGENT });
    // As before, too: with no delegation read, the caller.
    expect(learnerFor({ callerDid: AGENT, direct: false, delegation: 'unreadable' })).toEqual({ ok: true, did: AGENT, kind: 'human', via: AGENT });
  });

  it('is the agent, beside its person, for a delegate that says it is the learner', () => {
    expect(learnerFor({ callerDid: AGENT, direct: false, delegation, kind: 'agent' })).toEqual({ ok: true, did: AGENT, kind: 'agent', beside: PERSON });
  });

  it('is nobody when the delegation cannot say who the agent learns beside', () => {
    expect(learnerFor({ callerDid: AGENT, direct: false, delegation: 'unreadable', kind: 'agent' })).toMatchObject({ ok: false, status: 503 });
    expect(learnerFor({ callerDid: AGENT, direct: false, delegation: null, kind: 'agent' })).toMatchObject({ ok: false, status: 401 });
    expect(learnerFor({ callerDid: AGENT, direct: false, delegation: { person: AGENT }, kind: 'agent' })).toMatchObject({ ok: false, status: 401 });
    expect(learnerFor({ callerDid: AGENT, direct: false, delegation: { person: PERSON, expiresAt: '2026-01-01T00:00:00Z' }, kind: 'agent', now: Date.parse('2026-06-01T00:00:00Z') })).toMatchObject({ ok: false, status: 401, error: expect.stringContaining('expired') });
    expect(learnerFor({ callerDid: AGENT, direct: false, delegation: { person: PERSON, expiresAt: '2027-01-01T00:00:00Z' }, kind: 'agent', now: Date.parse('2026-06-01T00:00:00Z') })).toMatchObject({ ok: true, beside: PERSON });
  });

  it('reads learner_kind as compositions do', () => {
    expect(learnerKindFrom({})).toBeUndefined();
    expect(learnerKindFrom({ learner_kind: 'agent' })).toBe('agent');
    expect(learnerKindFrom({ learner_kind: 'human' })).toBe('human');
    expect(learnerKindFrom({ learner_kind: 'robot' })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('an agent learner\'s launch', () => {
  const tenant = 'lens:beside-a' as TenantId;
  const course = 'https://bridge.example/course/beside';
  const au = 'https://bridge.example/au/beside-1';
  const base = {
    au: { id: au, url: 'https://bridge.example/content/au/b/0', moveOn: 'CompletedAndPassed' as const, masteryScore: 0.8, title: 'Unit' },
    lrsEndpoint: 'https://bridge.example/xapi', fetchBaseUrl: 'https://bridge.example/cmi5/fetch',
    authoritativeSource: HOME, tenant, courseId: course, learnerPod: 'https://pod.example/u-pk-1/',
  };
  const agentLaunch = buildCmi5Launch({ ...base, learner: { id: AGENT }, beside: { id: PERSON } });
  const personLaunch = buildCmi5Launch({ ...base, learner: { id: PERSON } });
  const team = besideTeam(HOME, AGENT, PERSON);

  it('names the agent as the actor and has a registration of its own', () => {
    expect(agentLaunch.actor).toEqual({ objectType: 'Agent', account: { homePage: HOME, name: AGENT } });
    expect(agentLaunch.registration).not.toBe(personLaunch.registration);
    expect(inspectRegistration(agentLaunch.registration)).toMatchObject({ learner: AGENT, learnerKind: 'agent', beside: PERSON, satisfied: false });
    expect(inspectRegistration(personLaunch.registration)).not.toHaveProperty('beside');
  });

  it('puts the two of them in the context template as the team, and in the LMS\'s launched statement', () => {
    expect((agentLaunch.launchData.contextTemplate as { team?: unknown }).team).toEqual(team);
    expect((agentLaunch.launched?.context as { team?: unknown }).team).toEqual(team);
    expect(besideOf(agentLaunch.launched)).toBe(PERSON);
    expect(personLaunch.launchData.contextTemplate).not.toHaveProperty('team');
    expect(personLaunch.launched?.context).not.toHaveProperty('team');
  });

  it('is said with nothing xAPI does not already have: the launched statement is valid xAPI', () => {
    expect(validateStatement({ ...agentLaunch.launched, id: '6f1d0c1e-8a53-4d0c-9a51-0d2a0d7f3b11' })).toEqual([]);
    expect(team).toEqual({ objectType: 'Group', member: [
      { objectType: 'Agent', account: { homePage: HOME, name: AGENT } },
      { objectType: 'Agent', account: { homePage: HOME, name: PERSON } },
    ] });
    // Anonymous: it claims no identity of its own.
    for (const ifi of ['mbox', 'mbox_sha1sum', 'openid', 'account']) expect(team).not.toHaveProperty(ifi);
  });

  it('is satisfied for the agent and not for the person, and the LMS\'s satisfied names the team', async () => {
    const context = { ...(agentLaunch.launchData.contextTemplate as Record<string, unknown>) };
    const sent = [
      { actor: agentLaunch.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: au }, result: { completion: true }, context },
      { actor: agentLaunch.actor, verb: { id: 'http://adlnet.gov/expapi/verbs/passed' }, object: { id: au }, result: { success: true, score: { scaled: 1 } }, context },
    ];
    const emitted: Record<string, unknown>[] = [];
    const deps = { statementsForRegistration: async () => sent, emit: (s: Record<string, unknown>) => { emitted.push(s); } };
    expect(await observeCmi5Statement(sent[1]!, tenant, deps)).toMatchObject({ satisfied: true, emittedSatisfied: true });
    const satisfied = emitted.find(s => (s.verb as { id?: string }).id === 'https://w3id.org/xapi/adl/verbs/satisfied' && (s.object as { id?: string }).id === au);
    expect((satisfied?.actor as { account: { name: string } }).account.name).toBe(AGENT);
    expect(besideOf(satisfied)).toBe(PERSON);
    expect(learnerSatisfiedAus(tenant, AGENT)).toContain(au);
    expect(learnerSatisfiedAus(tenant, PERSON)).not.toContain(au);
    expect(inspectRegistration(personLaunch.registration)).toMatchObject({ satisfied: false });
  });

  it('shows the person and their agents to each other on the course, and nobody else', () => {
    const stranger = buildCmi5Launch({ ...base, learner: { id: 'https://identity.example/users/u-pk-2/profile#me' } });
    const strangersAgent = buildCmi5Launch({ ...base, learner: { id: 'did:web:identity.example:agents:claude-u-pk-2' }, beside: { id: 'https://identity.example/users/u-pk-2/profile#me' } });
    const seen = companionsOnCourse(tenant, course, PERSON);
    expect(seen.map(c => [c.learner, c.kind, c.satisfied]).sort()).toEqual([[AGENT, 'agent', true], [PERSON, 'human', false]].sort());
    expect(seen.map(c => c.registration)).not.toContain(stranger.registration);
    expect(seen.map(c => c.registration)).not.toContain(strangersAgent.registration);
    expect(companionsOnCourse('lens:elsewhere' as TenantId, course, PERSON)).toEqual([]);
    expect(companionsOnCourse(tenant, 'https://bridge.example/course/other', PERSON)).toEqual([]);
  });

  it('does not continue the person\'s registration for the agent, or the agent\'s for the person', () => {
    const open = inspectRegistration(personLaunch.registration) as { registration: string };
    const again = buildCmi5Launch({ ...base, learner: { id: PERSON }, beside: { id: 'https://identity.example/users/other#me' }, resume: { registration: open.registration, newSession: true } });
    expect(again.registration).not.toBe(personLaunch.registration);
  });
});

describe('reading who a statement\'s actor learns beside', () => {
  const stmt = (team: unknown, name = AGENT) => ({ actor: { account: { homePage: HOME, name } }, context: { team } });
  it('is the second member of a two-member team whose first is the actor', () => {
    expect(besideOf(stmt(besideTeam(HOME, AGENT, PERSON)))).toBe(PERSON);
  });
  it('is nothing for any other team, or none', () => {
    expect(besideOf(stmt(undefined))).toBeUndefined();
    expect(besideOf(stmt(besideTeam(HOME, PERSON, AGENT)))).toBeUndefined();
    expect(besideOf(stmt(besideTeam(HOME, AGENT, AGENT)))).toBeUndefined();
    expect(besideOf(stmt({ objectType: 'Group', member: [...besideTeam(HOME, AGENT, PERSON).member, { objectType: 'Agent', account: { homePage: HOME, name: 'x' } }] }))).toBeUndefined();
    expect(besideOf(stmt({ objectType: 'Agent', member: besideTeam(HOME, AGENT, PERSON).member }))).toBeUndefined();
    expect(besideOf(null)).toBeUndefined();
  });
  it('keeps a person\'s own launches apart from an agent\'s beside them', () => {
    const rows = [
      { registration: 'r1', auId: 'a', learner: { id: PERSON }, satisfied: false },
      { registration: 'r2', auId: 'a', learner: { id: AGENT }, beside: { id: PERSON }, satisfied: true, satisfiedAt: '2026-11-25T00:00:00Z' },
      { registration: 'r3', auId: 'a', learner: { id: PERSON }, beside: { id: 'someone' }, satisfied: false },
    ];
    expect(companionsOn(rows, PERSON).map(c => c.registration)).toEqual(['r1', 'r2']);
  });
});
