/**
 * What the bridge keeps is on the pod, sealed; memory is a cache of it.
 *
 * ★ WHY. Two defects, one cause: the bridge treated a Map as a place to keep a record.
 *
 * 1. A trajectory an agent recorded, a team's probes and an evaluation's decisions were each
 *    acknowledged and then held only in the process (three of the ten gaps in
 *    docs/operations/primary-state-rollout-hold.md). A restart erased them. Their snapshot
 *    collectors were registered and never marked dirty, so nothing was ever written.
 * 2. Two registries added on 2026-11-25 and 26 were written to the pod as plain JSON, where
 *    anyone with the address can read which person assigned which course to which agent. Found by
 *    fetching them with no credentials.
 *
 * src/sealed-store.ts is the fix for both; the rules that make it safe are pinned here against a
 * pod that is a Map of bodies and can be made to fail.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveEncryptionKeyPair } from '@interego/core';
import { SealedPodMap, SealedRegistryFile, openSealed, sealJson, type SealedFetch } from '../src/sealed-store.js';
import { OwnAgentAssignments } from '../src/own-agent-assignments.js';
import { EvaluationRegistry, isEvaluationState } from '../src/agent-evaluation.js';

const KEY = deriveEncryptionKeyPair('11'.repeat(32));
const OTHER = deriveEncryptionKeyPair('22'.repeat(32));

/** A pod: bodies by address. `fail` makes a method on an address answer 500; `log` is every request. */
function pod() {
  const bodies = new Map<string, string>();
  const log: string[] = [];
  const fail = new Set<string>();
  const fetch: SealedFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    log.push(`${method} ${url}`);
    const res = (status: number, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });
    if (fail.has(`${method} ${url}`) || fail.has(`* ${url}`)) return res(500);
    if (url.endsWith('/')) return res(201);
    if (method === 'GET') return bodies.has(url) ? res(200, bodies.get(url)!) : res(404);
    if (method === 'PUT') { bodies.set(url, init?.body ?? ''); return res(201); }
    if (method === 'DELETE') return bodies.delete(url) ? res(204) : res(404);
    return res(405);
  };
  return { bodies, log, fail, fetch };
}

describe('a sealed body', () => {
  it('is opened by the key that sealed it and by no other', () => {
    const sealed = sealJson({ a: 1, who: 'did:web:someone' }, KEY);
    expect(sealed).not.toContain('did:web:someone');
    expect(openSealed(sealed, KEY)).toEqual({ ok: true, value: { a: 1, who: 'did:web:someone' } });
    expect(openSealed(sealed, OTHER)).toEqual({ ok: false });
    expect(openSealed('{"plain":"json"}', KEY)).toEqual({ ok: false });
    expect(openSealed('not json', KEY)).toEqual({ ok: false });
  });

  it('is not the bridge\'s own when someone else addressed it to the bridge', () => {
    // Sealed by another key to this one: readable in principle, and not a record this bridge wrote.
    const foreign = sealJson({ x: 1 }, OTHER).replace(/"recipientPublicKey":"[^"]+"/g, `"recipientPublicKey":"${KEY.publicKey}"`);
    expect(openSealed(foreign, KEY)).toEqual({ ok: false });
  });
});

describe('records kept one to a sealed resource', () => {
  const BASE = 'https://pod.example/t/foxxi-lattice/kept/trajectories/';
  const isRec = (v: unknown): v is { n: number } => !!v && typeof (v as { n?: unknown }).n === 'number';
  const store = (p: ReturnType<typeof pod>, key = KEY) => new SealedPodMap<{ n: number }>({ base: BASE, key, fetch: p.fetch, valid: isRec });

  it('survive the process: another one reads what the first one put', async () => {
    const p = pod();
    expect(await store(p).put('tenant-a', 'did:web:agent', { n: 7 })).toBe('kept');
    expect(await store(p).get('tenant-a', 'did:web:agent')).toEqual({ state: 'held', value: { n: 7 } });
  });

  it('are written sealed, at an address that names neither the tenant nor the key', async () => {
    const p = pod(), s = store(p);
    await s.put('https://pod.example/tenant-a/', 'did:web:agent-one', { n: 7 });
    const url = s.urlOf('https://pod.example/tenant-a/', 'did:web:agent-one');
    expect(url).not.toContain('tenant-a');
    expect(url).not.toContain('agent-one');
    expect(p.bodies.get(url)).not.toContain('agent-one');
    expect(p.bodies.get(url)).not.toContain('"n":7');
  });

  it('keep tenants and keys apart', async () => {
    const p = pod(), s = store(p);
    await s.put('tenant-a', 'k', { n: 1 });
    expect(await s.get('tenant-b', 'k')).toEqual({ state: 'absent' });
    expect(await s.get('tenant-a', 'other')).toEqual({ state: 'absent' });
  });

  it('say unreadable, never absent, for a record that is there and cannot be read', async () => {
    const p = pod(), s = store(p);
    await s.put('t', 'k', { n: 1 });
    const url = s.urlOf('t', 'k');
    // Another key.
    expect(await store(p, OTHER).get('t', 'k')).toEqual({ state: 'unreadable' });
    // The pod failing.
    p.fail.add(`GET ${url}`);
    expect(await s.get('t', 'k')).toEqual({ state: 'unreadable' });
    p.fail.clear();
    // A body of the wrong kind, and a body moved from another address.
    p.bodies.set(url, sealJson({ ns: 't', key: 'k', value: { n: 'not a number' } }, KEY));
    expect(await s.get('t', 'k')).toEqual({ state: 'unreadable' });
    p.bodies.set(url, sealJson({ ns: 't', key: 'someone-else', value: { n: 1 } }, KEY));
    expect(await s.get('t', 'k')).toEqual({ state: 'unreadable' });
  });

  it('say failed when the pod did not take a record, and the old one stands', async () => {
    const p = pod(), s = store(p);
    await s.put('t', 'k', { n: 1 });
    p.fail.add(`PUT ${s.urlOf('t', 'k')}`);
    expect(await s.put('t', 'k', { n: 2 })).toBe('failed');
    p.fail.clear();
    expect(await s.get('t', 'k')).toEqual({ state: 'held', value: { n: 1 } });
  });

  it('write to one key in the order asked', async () => {
    const p = pod(), s = store(p);
    await Promise.all([1, 2, 3, 4, 5].map(n => s.put('t', 'k', { n })));
    expect(await s.get('t', 'k')).toEqual({ state: 'held', value: { n: 5 } });
  });

  it('remove a record, and call one that was never there gone', async () => {
    const p = pod(), s = store(p);
    await s.put('t', 'k', { n: 1 });
    expect(await s.remove('t', 'k')).toBe('gone');
    expect(await s.get('t', 'k')).toEqual({ state: 'absent' });
    expect(await s.remove('t', 'k')).toBe('gone');
  });

  it('keep nothing, and say so, with no pod or no key', async () => {
    const p = pod();
    const none = new SealedPodMap<{ n: number }>({ base: BASE, key: null, fetch: p.fetch, valid: isRec });
    expect(none.configured).toBe(false);
    expect(await none.put('t', 'k', { n: 1 })).toBe('unconfigured');
    expect(await none.get('t', 'k')).toEqual({ state: 'unconfigured' });
    expect(p.log).toEqual([]);
  });
});

describe('a small registry kept whole in one sealed resource', () => {
  const R = 'https://pod.example/t/foxxi-lattice/own-agent-assignments.envelope.json';
  const LEGACY = 'https://pod.example/t/foxxi-lattice/own-agent-assignments.json';
  const file = (p: ReturnType<typeof pod>, reg: OwnAgentAssignments, key = KEY) => new SealedRegistryFile({
    resource: R, legacyResource: LEGACY, key, fetch: p.fetch, registry: reg,
    pending: () => reg.pendingWithdrawals(), committed: (c) => reg.committed(c), staleMs: 0,
  });
  const ONE = { person: 'https://id.example/ana#me', agent: 'did:web:a', courseId: 'c1' };

  it('survives the process, sealed', async () => {
    const p = pod(), a = new OwnAgentAssignments();
    a.assign(ONE, 1_000);
    expect(await file(p, a).write()).toBe(true);
    expect(p.bodies.get(R)).not.toContain('ana');
    const b = new OwnAgentAssignments();
    expect(await file(p, b).reload()).toBe('loaded');
    expect(b.forPerson(ONE.person)).toHaveLength(1);
  });

  it('reads its first, clear copy once, writes it sealed, and removes the clear one', async () => {
    const p = pod(), old = new OwnAgentAssignments();
    old.assign(ONE, 1_000);
    p.bodies.set(LEGACY, JSON.stringify(old));
    const now = new OwnAgentAssignments(), f = file(p, now);
    expect(await f.reload()).toBe('loaded');
    expect(now.forPerson(ONE.person)).toHaveLength(1);
    // Nothing else changed, and it is still written: the clear copy must not stay.
    expect(now.dirty).toBe(true);
    expect(await f.write()).toBe(true);
    expect(p.bodies.has(LEGACY)).toBe(false);
    expect(openSealed(p.bodies.get(R)!, KEY).ok).toBe(true);
  });

  it('keeps trying to remove the clear copy when the pod did not', async () => {
    const p = pod(), old = new OwnAgentAssignments();
    old.assign(ONE, 1_000);
    p.bodies.set(LEGACY, JSON.stringify(old));
    const now = new OwnAgentAssignments(), f = file(p, now);
    await f.reload();
    p.fail.add(`DELETE ${LEGACY}`);
    expect(await f.write()).toBe(true);
    expect(p.bodies.has(LEGACY)).toBe(true);
    p.fail.clear();
    now.assign({ ...ONE, courseId: 'c2' }, 2_000);
    expect(await f.write()).toBe(true);
    expect(p.bodies.has(LEGACY)).toBe(false);
  });

  it('settles at start, without anyone changing a record', async () => {
    const p = pod(), old = new OwnAgentAssignments();
    old.assign(ONE, 1_000);
    p.bodies.set(LEGACY, JSON.stringify(old));
    expect(await file(p, new OwnAgentAssignments()).settle()).toBe(true);
    expect(p.bodies.has(LEGACY)).toBe(false);
    expect(openSealed(p.bodies.get(R)!, KEY).ok).toBe(true);
  });

  it('finds and removes a clear copy left beside a sealed one by a process that stopped in between', async () => {
    // The sealed write happened; the removal did not, and that process is gone.
    const p = pod(), old = new OwnAgentAssignments();
    old.assign(ONE, 1_000);
    p.bodies.set(LEGACY, JSON.stringify(old));
    p.bodies.set(R, sealJson(old, KEY));
    const next = new OwnAgentAssignments(), f = file(p, next);
    expect(await f.settle()).toBe(true);
    expect(p.bodies.has(LEGACY)).toBe(false);
    expect(next.forPerson(ONE.person)).toHaveLength(1);
  });

  it('says it is not settled while the clear copy cannot be removed, and settles when it can', async () => {
    const p = pod(), old = new OwnAgentAssignments();
    old.assign(ONE, 1_000);
    p.bodies.set(LEGACY, JSON.stringify(old));
    const f = file(p, new OwnAgentAssignments());
    p.fail.add(`DELETE ${LEGACY}`);
    expect(await f.settle()).toBe(false);
    expect(p.bodies.has(LEGACY)).toBe(true);
    p.fail.clear();
    expect(await f.settle()).toBe(true);
    expect(p.bodies.has(LEGACY)).toBe(false);
  });

  it('stops looking for a clear copy once the pod has said there is none', async () => {
    const p = pod(), reg = new OwnAgentAssignments(), f = file(p, reg);
    await f.settle();
    p.log.length = 0;
    reg.assign(ONE, 1_000);
    await f.write();
    expect(p.log.filter(l => l.endsWith(LEGACY))).toEqual([]);
  });

  it('does not write over a copy it could not read', async () => {
    const p = pod(), other = new OwnAgentAssignments();
    other.assign({ ...ONE, courseId: 'kept-by-another-key' }, 1_000);
    p.bodies.set(R, sealJson(other, OTHER));
    const before = p.bodies.get(R);
    const mine = new OwnAgentAssignments(), f = file(p, mine);
    expect(await f.reload()).toBe('failed');
    mine.assign(ONE, 2_000);
    expect(await f.write()).toBe(false);
    expect(p.bodies.get(R)).toBe(before);
    expect(mine.dirty).toBe(true);
    // The pod answering 500 is the same.
    p.bodies.delete(R); p.fail.add(`GET ${R}`);
    expect(await f.write()).toBe(false);
    expect(p.bodies.has(R)).toBe(false);
  });

  it('merges what the pod holds before writing, so another start\'s record is not dropped', async () => {
    const p = pod(), first = new OwnAgentAssignments();
    first.assign(ONE, 1_000);
    await file(p, first).write();
    const second = new OwnAgentAssignments();
    second.assign({ ...ONE, courseId: 'c2' }, 2_000);
    expect(await file(p, second).write()).toBe(true);
    const third = new OwnAgentAssignments();
    await file(p, third).reload();
    expect(third.forPerson(ONE.person).map(a => a.courseId).sort()).toEqual(['c1', 'c2']);
  });

  it('keeps a withdrawal withdrawn across the merge its own write makes', async () => {
    const p = pod(), reg = new OwnAgentAssignments(), f = file(p, reg);
    reg.assign(ONE, 1_000);
    await f.write();
    reg.withdraw(ONE);
    expect(await f.write()).toBe(true);
    const again = new OwnAgentAssignments();
    await file(p, again).reload();
    expect(again.size).toBe(0);
  });

  it('says it kept nothing with no key, and writes nothing in the clear', async () => {
    const p = pod(), reg = new OwnAgentAssignments();
    reg.assign(ONE, 1_000);
    const f = new SealedRegistryFile({ resource: R, key: null, fetch: p.fetch, registry: reg });
    expect(await f.reload()).toBe('unconfigured');
    expect(await f.write()).toBe(false);
    expect(p.log).toEqual([]);
  });
});

describe('an evaluation, kept and taken back', () => {
  it('comes back with its candidates, decisions and runs, and the owner lock still holds', () => {
    const a = new EvaluationRegistry();
    const ev = a.open({ name: 'Which harness', decisionQuestion: 'Which one do we adopt?', openedBy: 'https://id.example/ana#me' });
    const c = a.requestEnrollment(ev.id, { agentDid: 'did:web:x', agentName: 'x', team: 't', requestedBy: 'https://id.example/bo#me' });
    if ('error' in c) throw new Error(c.error);
    a.decide(ev.id, c.candidateId, 'accept', 'https://id.example/ana#me');
    const kept = JSON.parse(JSON.stringify(a.get(ev.id)));
    expect(isEvaluationState(kept)).toBe(true);
    const b = new EvaluationRegistry();
    expect(b.restore(kept)).toBe(true);
    expect(b.get(ev.id)!.candidates[0]).toMatchObject({ status: 'accepted', decidedBy: 'https://id.example/ana#me' });
    // Someone who did not open it still cannot decide, and a decision already made still stands.
    expect(b.decide(ev.id, c.candidateId, 'decline', 'https://id.example/bo#me')).toMatchObject({ status: 403 });
    expect(b.decide(ev.id, c.candidateId, 'decline', 'https://id.example/ana#me')).toMatchObject({ status: 409 });
    const second = b.requestEnrollment(ev.id, { agentDid: 'did:web:y', agentName: 'y', team: 't', requestedBy: 'https://id.example/bo#me' });
    if ('error' in second) throw new Error(second.error);
    // Candidate ids are made from how many there are: a restored cohort must not hand out one twice.
    expect(second.candidateId).not.toBe(c.candidateId);
    expect(b.decide(ev.id, second.candidateId, 'accept', 'https://id.example/bo#me')).toMatchObject({ status: 403 });
  });

  it('does not replace one already in hand, and refuses what is not an evaluation', () => {
    const a = new EvaluationRegistry();
    const ev = a.open({ name: 'n', decisionQuestion: 'q', openedBy: 'o' });
    const stale = JSON.parse(JSON.stringify(a.get(ev.id)));
    a.requestEnrollment(ev.id, { agentDid: 'did:web:x', agentName: 'x', team: 't', requestedBy: 'r' });
    expect(a.restore(stale)).toBe(false);
    expect(a.get(ev.id)!.candidates).toHaveLength(1);
    expect(a.restore({ evaluation: { id: 'x' } } as never)).toBe(false);
    expect(isEvaluationState(null)).toBe(false);
  });

  it('is forgotten when a change was not kept, so the next read takes what is', () => {
    const a = new EvaluationRegistry();
    const ev = a.open({ name: 'n', decisionQuestion: 'q', openedBy: 'o' });
    a.forget(ev.id);
    expect(a.get(ev.id)).toBeUndefined();
  });
});

describe('the bridge', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const handler = (tool: string): string => { const i = src.indexOf(`'${tool}': async (args) => {`); return src.slice(i, src.indexOf("\n  'foxxi.", i + 10)); };

  it('keeps a trajectory before it says recorded, and refuses when the pod did not take it', () => {
    const h = handler('foxxi.record_agent_trajectory');
    const keep = h.indexOf('await keepOrRefuse(keptTrajectories,');
    expect(keep).toBeGreaterThan(0);
    expect(keep).toBeLessThan(h.indexOf('recorded: true,'));
    expect(h).toContain("if ('refusal' in keptTrajectory) return keptTrajectory.refusal;");
    // The cache drops its copy when the write failed.
    expect(h).toContain('() => agentTrajectories.delete(agentDid)');
  });

  it('reads what is kept when the cache has none, for every read of a trajectory', () => {
    for (const tool of ['foxxi.get_agent_trajectory', 'foxxi.assess_agent_disposition', 'foxxi.run_performance_probe']) {
      const h = handler(tool);
      expect(h, tool).toContain('await fillTrajectories(callTenant(args),');
      expect(h.indexOf('await fillTrajectories('), tool).toBeLessThan(h.indexOf('agentTrajectories.get('));
    }
    // And the two reads outside the tool handlers.
    expect(src).toContain('await fillRecordedApart(performer.id, subjectPod);');
    expect(src).toContain('await Promise.all(agents.map((a) => fillRecordedApart(a, learner.podUrl)));');
  });

  it('keeps a probe and every change to an evaluation before answering', () => {
    expect(handler('foxxi.run_performance_probe')).toContain("if ('refusal' in keptProbe) return keptProbe.refusal;");
    expect(handler('foxxi.open_agent_evaluation')).toContain("if ('refusal' in keptOpen) return keptOpen.refusal;");
    expect(handler('foxxi.request_evaluation_enrollment')).toContain("if ('refusal' in keptRequest) return keptRequest.refusal;");
    expect(handler('foxxi.decide_evaluation_candidate')).toContain("if ('refusal' in keptDecision) return keptDecision.refusal;");
    for (const tool of ['foxxi.request_evaluation_enrollment', 'foxxi.decide_evaluation_candidate', 'foxxi.get_agent_evaluation', 'foxxi.compare_agent_evaluation']) {
      expect(handler(tool), tool).toContain('await fillEvaluation(callTenant(args), evaluationId)');
    }
  });

  it('answers a record it cannot read with a refusal, never as if there were none', () => {
    const fill = src.slice(src.indexOf('async function fillFromKept'), src.indexOf('async function keepOrRefuse'));
    expect(fill).toContain("else if (got.state === 'unreadable') unreadable = true;");
    expect(fill).toContain("return unreadable ? storageRefusal(what, 'unreadable') : null;");
  });

  it('writes the course ownership index only after reading it, and before authoring is acknowledged', () => {
    const w = src.slice(src.indexOf('async function writeCourseAuthors'), src.indexOf('const persistCourseAuthors'));
    // The read-then-write helper: a pod answering 500 is not read as an empty index and overwritten.
    expect(w).toContain('await commitDurableRegistry({');
    expect(w).toContain('if (ok) return true;');
    expect(w).toContain('...courseAuthorsDurable }');
    const author = src.slice(src.indexOf("app.post('/agent/scorm/author',"), src.indexOf("app.post('/agent/scorm/launch',"));
    expect(author.indexOf('const authorIndexKept = await writeCourseAuthors();')).toBeGreaterThan(author.indexOf('recordCourseAuthor(course.courseId, auth.callerDid);'));
    expect(author).toContain('authoredBy: auth.callerDid, authorIndexKept,');
    expect(src).not.toContain('void persistCourseAuthors();');
  });

  it('keeps what the cmi5 rollup has said, so a restart does not say it twice', () => {
    const lms = readFileSync(new URL('../src/cmi5-lms.ts', import.meta.url), 'utf8');
    const collect = lms.slice(lms.indexOf('function collectCmi5Snapshot'), lms.indexOf('async function hydrateCmi5FromPod'));
    expect(collect).toContain('rollupEmitted: [...rollupEmitted].map(([k, set]) => [k, [...set]]),');
    expect(collect).toContain('courseEnrollmentReg: [...courseEnrollmentReg],');
    const hydrate = lms.slice(lms.indexOf('async function hydrateCmi5FromPod'), lms.indexOf("registerSnapshot({ surface: 'cmi5'"));
    expect(hydrate).toContain('snap.rollupEmitted ?? []');
    // A registration already minted in this process is in statements: the kept one does not replace it.
    expect(hydrate).toContain('!courseEnrollmentReg.has(key)');
    // The rollup waits for the snapshot, and marks it when it says something new.
    expect(lms).toMatch(/await whenCmi5Ready\(\);\n  const key = `\$\{tenant\}\|\$\{course\.id\}\|\$\{learner\.id\}`;/);
    // 2026-11-27: these were `cmi5PodDirty()`, a write two seconds later that nothing waited for.
    // The rollup now waits for the write (tests/a-change-is-written-before-it-is-answered.test.ts).
    expect(lms).toContain("emitted.add(course.id); void keepSnapshot('cmi5');");
    expect(lms).toContain("courseEnrollmentReg.set(key, reg); void keepSnapshot('cmi5'); }");
  });

  it('settles each registry that was once in the clear at start, and retries', () => {
    for (const name of ['own-agent-assignments', 'package-bringers', 'cmi5-personal-links']) expect(src).toMatch(new RegExp(`settleSealed\\(\\w+, '${name}'\\);`));
    const settle = src.slice(src.indexOf('function settleSealed'), src.indexOf('/** Resolve the tenant of an affordance call'));
    expect(settle).toContain('setTimeout(attempt, wait)');
  });

  it('keeps the two registries it once wrote in the clear sealed, and removes the clear copies', () => {
    for (const name of ['own-agent-assignments', 'package-bringers']) {
      expect(src).toContain(`/foxxi-lattice/${name}.envelope.json\``);
      expect(src).toContain(`legacyResource: tenantPodUrl ? \`\${tenantPodUrl.replace(/\\/$/, '')}/foxxi-lattice/${name}.json\` : undefined,`);
    }
    expect(src).not.toMatch(/resource: [^\n]*own-agent-assignments\.json/);
  });
});
