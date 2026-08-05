/**
 * The competency an ELR asserts is identified by the WHOLE term that named it, and each
 * execution is one distinct TASK.
 *
 * Both properties were absent and both were exploited against production by an independent
 * reviewer, on the same afternoon, through the same public affordance:
 *
 *   - the competency was keyed on the activity type's LOCAL NAME, so submitting one
 *     performance under `https://attacker.example/totally-unrelated-scheme#EvidenceIntegrityReview`
 *     raised the confidence of the competency a convener's own
 *     `.../wsp-skills#EvidenceIntegrityReview` had earned. `competencyCount` stayed 1 and the
 *     Wilson lower bound moved to 0.676 — the exact figure for 8/8 — so the foreign term was
 *     counted, not merely tolerated.
 *   - `n` counted STATEMENTS, so resubmitting one genuine `task_id` moved 0.61 → 0.646 (the
 *     exact figures for 6/6 and 7/7). Twelve replays of one task reach Expert.
 *
 * These are the two guards. Mutating either one back — keying `draft` on `typeLocalName`, or
 * keying `performanceByTask` on the statement id — fails a case below.
 */
import { describe, it, expect } from 'vitest';
import { assembleEnterpriseLearnerRecord } from '../applications/foxxi-content-intelligence/src/learner-record.js';
import type { StoredStatement } from '../applications/foxxi-content-intelligence/src/statement-store.js';

const CONVENER_TERM = 'https://relay.interego.xwisee.com/ns/u-eth-9bf50894ff23/wsp-skills#EvidenceIntegrityReview';
const FOREIGN_TERM = 'https://attacker.example/totally-unrelated-scheme#EvidenceIntegrityReview';
const CONTEXT_KIND = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#contextKind';
const LRS = 'https://foxxi-bridge.interego.xwisee.com';

function perf(id: string, type: string, taskId: string, success = true, timestamp = '2026-08-05T00:00:00Z'): StoredStatement {
  return {
    id, stored: timestamp, voided: false,
    statement: {
      id,
      actor: { objectType: 'Agent', account: { homePage: LRS, name: 'did:web:x:agents:probe' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed' },
      object: { objectType: 'Activity', id: taskId, definition: { name: { en: 'a reviewed work item' }, type } },
      result: { success },
      context: { extensions: { [CONTEXT_KIND]: 'production' } },
      timestamp,
    },
  } as unknown as StoredStatement;
}

const assemble = (statements: readonly StoredStatement[]) => assembleEnterpriseLearnerRecord({
  learnerDid: 'did:web:x:agents:probe',
  learnerPodUrl: 'https://gate.example/probe/',
  tenantDid: 'did:web:x:tenant',
  lrsEndpoint: LRS,
  statements,
  // The CLR leg dereferences the pod; this suite is about the LRS leg only, and a real
  // network read here would make the assertions depend on a live host.
  fetch: (async () => { throw new Error('no network in this test'); }) as unknown as typeof globalThis.fetch,
});

describe('competency identity keeps the naming authority', () => {
  it('two authorities whose terms share a local name are two competencies, with disjoint evidence', async () => {
    const elr = await assemble([
      perf('a1', CONVENER_TERM, 'https://gate.example/probe/w/1.ttl'),
      perf('a2', CONVENER_TERM, 'https://gate.example/probe/w/2.ttl'),
      perf('a3', CONVENER_TERM, 'https://gate.example/probe/w/3.ttl'),
      perf('b1', FOREIGN_TERM, 'https://gate.example/probe/w/4.ttl'),
      perf('b2', FOREIGN_TERM, 'https://gate.example/probe/w/5.ttl'),
      perf('b3', FOREIGN_TERM, 'https://gate.example/probe/w/6.ttl'),
    ]);
    expect(elr.competencies).toHaveLength(2);
    const ids = elr.competencies.map(c => c.id);
    expect(new Set(ids).size).toBe(2);
    // The whole term is IN the id — a reader can recover which authority named it.
    expect(ids.some(i => i.includes(encodeURIComponent(CONVENER_TERM)))).toBe(true);
    expect(ids.some(i => i.includes(encodeURIComponent(FOREIGN_TERM)))).toBe(true);
    // ...and no execution crossed over.
    for (const c of elr.competencies) expect(c.evidenceSummary.performanceExecutions).toBe(3);
    // The per-assertion node is distinct too: it used to be slugged off the same label.
    expect(new Set(elr.competencies.map(c => c.assertionId)).size).toBe(2);
  });

  it('a foreign-namespace submission does not move the confidence of the convener\'s competency', async () => {
    const own = [1, 2, 3, 4].map(n => perf(`a${n}`, CONVENER_TERM, `https://gate.example/probe/w/${n}.ttl`));
    const before = await assemble(own);
    const after = await assemble([...own, perf('x', FOREIGN_TERM, 'https://gate.example/probe/w/9.ttl')]);
    const conv = (r: Awaited<ReturnType<typeof assemble>>) =>
      r.competencies.find(c => c.id.includes(encodeURIComponent(CONVENER_TERM)))!;
    expect(conv(after).confidence).toBe(conv(before).confidence);
    expect(conv(after).evidenceSummary.performanceExecutions).toBe(4);
  });
});

describe('an execution is a distinct task, not a statement', () => {
  it('replaying one task_id does not increase n or the confidence', async () => {
    const six = [1, 2, 3, 4, 5, 6].map(n => perf(`s${n}`, CONVENER_TERM, `https://gate.example/probe/w/${n}.ttl`));
    const before = await assemble(six);
    // The reviewer's exact move: the same task_id, a NEW statement id.
    const after = await assemble([...six, perf('replay', CONVENER_TERM, 'https://gate.example/probe/w/1.ttl')]);
    expect(before.competencies[0]!.evidenceSummary.performanceExecutions).toBe(6);
    expect(after.competencies[0]!.evidenceSummary.performanceExecutions).toBe(6);
    expect(after.competencies[0]!.confidence).toBe(before.competencies[0]!.confidence);
  });

  it('a later report of the same task CORRECTS the earlier one rather than banking both', async () => {
    const elr = await assemble([
      perf('first', CONVENER_TERM, 'https://gate.example/probe/w/1.ttl', true, '2026-08-05T00:00:00Z'),
      perf('correction', CONVENER_TERM, 'https://gate.example/probe/w/1.ttl', false, '2026-08-05T01:00:00Z'),
      perf('other', CONVENER_TERM, 'https://gate.example/probe/w/2.ttl', true, '2026-08-05T00:30:00Z'),
    ]);
    const c = elr.competencies[0]!;
    expect(c.evidenceSummary.performanceExecutions).toBe(2);
    // 1 of 2, not 2 of 3: the retracted success is gone, not averaged in.
    expect(c.evidenceSummary.performanceSuccessRate).toBe(0.5);
  });
});

describe('the evidence list carries an artifact a stranger can fetch', () => {
  it('leads with the cited task_id, which is anonymously dereferenceable, not only the auth-gated LRS URL', async () => {
    const elr = await assemble([perf('a1', CONVENER_TERM, 'https://gate.example/probe/w/1.ttl')]);
    const ev = elr.competencies[0]!.evidence;
    expect(ev[0]).toBe('https://gate.example/probe/w/1.ttl');
    // The LRS pointer is still there for an authorised reader — this adds, it does not swap.
    expect(ev.some(e => e.includes('statementId=a1'))).toBe(true);
  });
});
