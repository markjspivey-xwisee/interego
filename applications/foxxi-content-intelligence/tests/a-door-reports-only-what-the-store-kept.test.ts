/**
 * A door that records statements reports only what the store kept, and keeps them whole or not at
 * all; and it refuses what it will refuse before it keeps anything.
 *
 * ★ WHY. storeStatementInternal answers with an id before the store's write settles, and only logs a
 * write that fails later (a file, pod or forwarding backend). The doors counted on it, each its own way:
 *   - a course completion counted a statement kept, composed and forwarded it, and answered ok,
 *     though the store never held it (Codex, on #540);
 *   - an external agent run stored its statements and set its trajectory before its
 *     evaluation-candidacy refusals, and ignored the store's refusals: a quality outside [-1, 1]
 *     cost the run its `performed` statement without a word;
 *   - an agent trajectory set the trajectory first, stored its xAPI projection unchecked, and
 *     counted every projected statement as projected;
 *   - the two record-performance doors reported the id of a statement whose write could still fail.
 *
 * keepStatementsWhole checks a door's statements by the LRS's own rule, then writes and awaits each
 * in order, and stops at the first the store does not keep. A door with one statement awaits
 * storeStatementDurably. The store here is the LRS's own, with its write made to fail where a test
 * needs it to.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStatementStore, PrimaryForwardStatementStore, resetResidentBudgetRegistryForTest, setResidentStatementBudget } from '../src/statement-store.js';
import { getStatementStore, internalRefusalOf, keepStatementsWhole, storeStatementInternal } from '../src/xapi-lrs.js';
import { buildPassedSessionTrace } from '../src/cmi5.js';
import { ingestExternalRun } from '../src/agent-run-ingest.js';
import { EvaluationRegistry, type CandidateRun } from '../src/agent-evaluation.js';

const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');

/** Each MCP handler and each HTTP route of the bridge, with its body up to its own closing. */
function doors(): Array<{ name: string; body: string }> {
  return [...server.matchAll(/^ {2}'(foxxi\.[a-z_0-9]+)': async \(|^app\.(?:get|post|put|patch|delete)\('([^']+)'/gm)].map(m => {
    const at = m.index!;
    const name = (m[1] ?? m[2])!;
    if (m[1]) {
      // A handler closes at its entry's indent.
      const end = server.indexOf('\n  },\n', at);
      return { name, body: server.slice(at, end < 0 ? server.length : end + 5) };
    }
    // A route runs to the next top-level line that is not its own closing (`});`, `}));`): the next
    // route, a function, a comment. Its closing is not always `});`, so that alone overruns.
    const next = server.slice(at + 1).search(/\n(?=[^\s}])/);
    return { name, body: server.slice(at, next < 0 ? server.length : at + 1 + next + 1) };
  });
}
const door = (name: string): string => {
  const found = doors().find(d => d.name === name);
  expect(found, `${name} is present to be checked`).toBeDefined();
  return found!.body;
};

const agent = 'did:ethr:0x2222222222222222222222222222222222222222';
const session = (durationIso = 'PT10M'): Array<Record<string, unknown> & { id: string }> => {
  const registration = randomUUID();
  return buildPassedSessionTrace({
    actor: { name: agent, account: { homePage: 'https://bridge.example', name: agent } },
    session: { registration, sessionId: registration, publisherId: 'did:web:bridge.example', auActivityId: 'https://bridge.example/course/golf', courseActivityId: 'https://bridge.example/course/golf' },
    scoreScaled: 0.9, masteryScore: 0.7, durationIso, moveOnRule: 'CompletedAndPassed',
  }).map(s => ({ ...(s as unknown as Record<string, unknown>), id: randomUUID() }));
};

/** A tenant of the LRS's own store, whose write fails from the `failFrom`-th statement on (counting from 0). */
function storeThatFails(failFrom: number): { tenant: never; writes: () => number } {
  const tenant = `store-that-fails-${randomUUID()}` as never;
  const store = getStatementStore(tenant);
  const put = store.put.bind(store);
  let n = 0;
  store.put = async rec => { if (n++ >= failFrom) throw new Error('the disk is full'); return put(rec); };
  return { tenant, writes: () => n };
}

describe('keepStatementsWhole', () => {
  it('keeps every statement, each write awaited, and gives back only ids the store holds', async () => {
    const { tenant, writes } = storeThatFails(Number.POSITIVE_INFINITY);
    const s = session();
    const kept = await keepStatementsWhole(s, tenant);
    expect(kept).toEqual({ status: 'whole', keptIds: s.map(x => x.id) });
    expect(writes()).toBe(s.length);
    for (const id of s.map(x => x.id)) expect(await getStatementStore(tenant).get(id)).not.toBeNull();
  });

  it('refuses them all, before writing any, when the LRS would refuse one, and names each by its verb', async () => {
    const { tenant, writes } = storeThatFails(Number.POSITIVE_INFINITY);
    const kept = await keepStatementsWhole(session('25m'), tenant);
    expect(kept).toEqual({
      status: 'refused',
      refusals: ['completed', 'passed', 'terminated'].map(v => `${v}: result.duration must be an ISO 8601 duration`),
    });
    expect(writes()).toBe(0);
  });

  it('stops at the first write the store does not keep, writes nothing after it, and says what it kept', async () => {
    const { tenant, writes } = storeThatFails(2);
    const s = session();
    const kept = await keepStatementsWhole(s, tenant);
    expect(kept).toEqual({ status: 'partial', keptIds: [s[0]!.id, s[1]!.id] });
    expect(writes()).toBe(3);
  });

  it('says what storeStatementInternal could not: that a statement it answered with an id was not written', async () => {
    const { tenant } = storeThatFails(0);
    const [first] = session();
    expect(storeStatementInternal(first!, tenant)).toBe(first!.id);   // the answer the doors counted on
    expect(await keepStatementsWhole([first!], tenant)).toEqual({ status: 'partial', keptIds: [] });
  });

  it('is not whole when the store let an earlier statement go to make room for a later one', async () => {
    // Codex, on #544: an in-memory store over the process-wide resident budget evicts its oldest
    // statement as it takes a new one, so every write can succeed and the set still not be held.
    resetResidentBudgetRegistryForTest();
    const tenant = `store-that-makes-room-${randomUUID()}` as never;
    getStatementStore(tenant);   // registered against the budget from here
    setResidentStatementBudget(1);
    try {
      const s = session().slice(0, 2);
      const kept = await keepStatementsWhole(s, tenant);
      expect(await getStatementStore(tenant).get(s[0]!.id)).toBeNull();
      expect(kept).toEqual({ status: 'partial', keptIds: [s[1]!.id] });
    } finally {
      setResidentStatementBudget();
      resetResidentBudgetRegistryForTest();
    }
  });
});

describe('a store that did not write a statement does not serve it', () => {
  // Codex, on #541: the file store indexed a statement before appending it, and the forwarding store
  // cached one before the primary had it, so a write that failed left it readable while the door
  // said it was not kept, and a retry made it twice.
  const record = () => { const [s] = session(); return { id: s!.id, statement: s!, stored: new Date().toISOString(), voided: false }; };

  it('the file store: a failed append leaves nothing to read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foxxi-file-store-'));
    mkdirSync(join(dir, 'statements.jsonl'));   // a directory where the file goes: every append fails
    const store = new FileStatementStore(dir);
    const r = record();
    await expect(store.put(r)).rejects.toThrow();
    expect(await store.get(r.id)).toBeNull();
    expect((await store.query({})).statements).toEqual([]);
  });

  it('the file store: a written statement is read, put again is a no-op, and another under its id is refused before anything is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foxxi-file-store-'));
    const store = new FileStatementStore(dir);
    const r = record();
    await store.put(r);
    await store.put(r);
    expect((await store.get(r.id))?.id).toBe(r.id);
    const lines = () => readFileSync(join(dir, 'statements.jsonl'), 'utf8').trim().split('\n');
    expect(lines()).toHaveLength(1);
    await expect(store.put({ ...r, statement: { ...r.statement, verb: { id: 'http://adlnet.gov/expapi/verbs/failed' } } })).rejects.toThrow(/already stored with different content/);
    expect(lines()).toHaveLength(1);
  });

  it('the forwarding store: a statement the primary refused is not served from its cache, and one it took is', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response('', { status: 400 })) as typeof fetch;
      const store = new PrimaryForwardStatementStore('https://primary.example/xapi', { user: 'test-user', pass: 'test-pass' });
      const r = record();
      await expect(store.put(r)).rejects.toThrow(/primary LRS rejected statement \(HTTP 400\)/);
      expect(await store.get(r.id)).toBeNull();
      globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
      await store.put(r);
      expect((await store.get(r.id))?.id).toBe(r.id);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the doors that record statements', () => {
  it('none answers with an id before the store has settled it: no door calls storeStatementInternal', () => {
    expect(doors().filter(d => d.body.includes('storeStatementInternal(')).map(d => d.name)).toEqual([]);
  });

  it('the record-performance doors await their one write, and say that nothing was recorded otherwise', () => {
    for (const name of ['foxxi.record_performance', '/agent/record-performance']) {
      expect(door(name)).toMatch(/const statementId = await storeStatementDurably\(statement, lensTenantFor\((?:perfLabel|label)\)\);\s+if \(!statementId\) \{/);
      expect(door(name)).toContain('the performance was not recorded — the LRS refused the emitted xAPI statement, or its store did not write it');
    }
  });
});

describe('an external agent run is refused before any of it is kept, and kept whole', () => {
  const run = door('foxxi.record_external_agent_run');
  const at = (s: string): number => { const i = run.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };

  it('asks every refusal first: the quality, the candidacy, its owner, its acceptance, and then the LRS', () => {
    const keep = at('const kept = await keepStatementsWhole(inOrder, tenant);');
    expect(at("if (typeof args.quality === 'number' && !(args.quality >= -1 && args.quality <= 1)) return invalidArguments('quality (result.score.scaled) must be in [-1,1]');"))
      .toBeLessThan(at('const ingested = ingestExternalRun(runInput);'));
    for (const refusal of ['is not enrolled as a candidate of this evaluation', "may not write into another agent\\'s candidacy", 'the candidate has not been accepted into this evaluation']) {
      expect(at(refusal)).toBeLessThan(keep);
    }
    expect(run.slice(keep)).toMatch(/^const kept = [^\n]+\n\s+if \(kept\.status === 'refused'\) \{\s+return invalidArguments\(/);
  });

  it("refuses a candidate not yet accepted, on the registry's own condition, before anything is kept", () => {
    expect(run).toMatch(/if \(candidate\.status !== 'accepted'\) \{\s+return \{\s+kind: 'refusal' as const,\s+'iep:refusalStatus': 409,/);
    expect(run).toContain("error: `candidate ${candidate.candidateId} is ${candidate.status} — accept it before recording runs`,");
    // The registry's addRun refuses on the same condition, in the same words: the door only asks it first.
    const registry = new EvaluationRegistry();
    const evaluation = registry.open({ name: 'Refunds', decisionQuestion: 'Which agent handles refunds?', openedBy: 'did:web:opener.example' });
    const requested = registry.requestEnrollment(evaluation.id, { agentDid: agent, agentName: 'refunder', team: 'ops', requestedBy: agent });
    if ('error' in requested) throw new Error(requested.error);
    expect(requested.status).toBe('requested');
    const refused = registry.addRun(evaluation.id, requested.candidateId, { success: true, recordedAt: '2026-09-27T00:00:00Z' } as unknown as CandidateRun);
    expect(refused).toEqual({ status: 409, error: `candidate ${requested.candidateId} is requested — accept it before recording runs` });
  });

  it('sets and binds nothing until the whole run is kept, keeps its performance last, and says a binding lost since', () => {
    const partial = at("if (kept.status === 'partial') {");
    expect(partial).toBeLessThan(at('agentTrajectories.set(agentDid, ingested.trajectory);'));
    expect(partial).toBeLessThan(at('evaluationRegistry.addRun('));
    expect(run).toContain('const inOrder = [...ingested.statements.filter(s => s !== ingested.performance), ingested.performance]');
    expect(run).toMatch(/if \('error' in added\) bindingRefused = added\.error;/);
    expect(run).not.toMatch(/if \('error' in added\) return/);
    expect(run).toContain('statementIds: keptIds,');
  });

  it("is refused for what the LRS would refuse of it: the run's quality, a tool call's quality, a tool call's object", () => {
    const ingest = (patch: { quality?: number; toolCalls?: Array<Record<string, unknown>> }) => ingestExternalRun({
      agentDid: agent, task: { name: 'Refund a disputed order' },
      outcome: { success: true, ...(patch.quality !== undefined ? { quality: patch.quality } : {}) },
      toolCalls: (patch.toolCalls ?? [{ tool: 'lookup' }]) as never,
    });
    const refusalsOf = (r: ReturnType<typeof ingest>) => r.statements.flatMap(s => internalRefusalOf({ ...s, id: randomUUID() }));
    expect(refusalsOf(ingest({}))).toEqual([]);
    expect(refusalsOf(ingest({ quality: 2 }))).toContain('result.score.scaled must be between -1 and 1 inclusive');
    expect(refusalsOf(ingest({ toolCalls: [{ tool: 'lookup', quality: 2 }] }))).toContain('result.score.scaled must be between -1 and 1 inclusive');
    expect(refusalsOf(ingest({ toolCalls: [{ tool: 'lookup', objectId: 'my object' }] }))).toContain('object.id must be an IRI');
    // The run's performance is named, not found by its verb: its tool calls carry the same one.
    const r = ingest({ quality: 0.5, toolCalls: [{ tool: 'lookup' }, { tool: 'refund' }] });
    expect(r.statements).toContain(r.performance);
    const verbOf = (s: Record<string, unknown>) => (s.verb as { id?: string }).id;
    expect(r.statements.filter(s => verbOf(s) === verbOf(r.performance))).toHaveLength(3);
    // It is the run's own statement: it carries the run's quality, and its object is the task, not a tool call.
    expect((r.performance.result as { score?: { scaled?: number } }).score?.scaled).toBe(0.5);
    expect(String((r.performance.object as { id?: string }).id)).not.toContain(':tool:');
  });
});

describe('an agent trajectory keeps its projection whole before the trajectory is set', () => {
  const trajectory = door('foxxi.record_agent_trajectory');
  it('checks and keeps the projection first, and counts only what was kept', () => {
    const keep = trajectory.indexOf('const kept = await keepStatementsWhole(projection.statements.map(stmt => ({ id: randomUUID(), ...stmt })), callTenant(args));');
    const set = trajectory.indexOf('agentTrajectories.set(agentDid, trajectory);');
    expect(keep).toBeGreaterThan(-1);
    expect(keep).toBeLessThan(set);
    expect(trajectory.indexOf("if (kept.status === 'refused') {")).toBeLessThan(set);
    expect(trajectory.indexOf("if (kept.status === 'partial') {")).toBeLessThan(set);
    expect(trajectory).toContain('projectedToXapi: kept.keptIds.length,');
    expect(trajectory).not.toContain('projectedToXapi: projection.statements.length');
  });
});
