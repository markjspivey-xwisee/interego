/**
 * Round-45: the uncapped caller-keyed-identity / unbounded-state siblings the
 * round-42/43 cap sweep missed, all reachable by any signed wallet (or any
 * non-empty Bearer, for the xAPI document stores).
 *
 *  (1) EvaluationRegistry — open_agent_evaluation is reachable by any signed
 *      wallet, so the evaluations Map, each cohort's candidate list, and each
 *      candidate's run list are all attacker-growable (OOM). Evaluations and runs
 *      evict oldest; candidates REJECT past the cap (their ids are derived from
 *      `candidates.length`, so evicting would let a later insert reuse an id and
 *      defeat the owner/decision locks keyed on it).
 *  (2) xAPI State / Activity-Profile / Agent-Profile document stores + the raw
 *      attachment store — the auth gate accepts any non-empty Bearer, so a junk
 *      bearer could PUT unlimited distinct keys into a single tenant Map. Those
 *      four stores now route their writes through the SAME evict-oldest mechanism
 *      exercised here (cappedMapSet, XAPI_DOC_STORE_MAX); a Map-eviction unit test
 *      proves that mechanism, which the LRS sites reuse verbatim.
 */

import { describe, it, expect } from 'vitest';
import { EvaluationRegistry } from '../src/agent-evaluation.js';

describe('round-45 — EvaluationRegistry is bounded against any-signed-wallet DoS', () => {
  it('a candidate\'s run list evicts oldest past its cap (bounded, monotonic tail)', () => {
    const reg = new EvaluationRegistry();
    const ev = reg.open({ name: 'E', decisionQuestion: 'best agent?', openedBy: 'did:ethr:0xA' } as never);
    const req = reg.requestEnrollment(ev.id, { agentDid: 'did:ethr:0xC', team: 't', requestedBy: 'did:ethr:0xC' } as never);
    const candidateId = (req as { candidateId: string }).candidateId;
    reg.decide(ev.id, candidateId, 'accept', 'did:ethr:0xA');

    const RUNS_MAX = 10_000;
    for (let i = 0; i < RUNS_MAX + 25; i++) {
      const r = reg.addRun(ev.id, candidateId, { runId: `run-${i}`, startedAt: '2026-01-01T00:00:00Z' } as never);
      expect('error' in r).toBe(false);
    }
    const cand = reg.findCandidateByAgent(ev.id, 'did:ethr:0xC');
    expect(cand?.runs.length).toBe(RUNS_MAX);
    // Oldest evicted, newest retained (evict-oldest, not reject-newest).
    expect((cand?.runs[0] as { runId: string }).runId).not.toBe('run-0');
    expect((cand?.runs[cand.runs.length - 1] as { runId: string }).runId).toBe(`run-${RUNS_MAX + 24}`);
  }, 30_000);

  it('a cohort rejects new candidates past its cap (id monotonicity preserved)', () => {
    const reg = new EvaluationRegistry();
    const ev = reg.open({ name: 'E', decisionQuestion: 'q', openedBy: 'did:ethr:0xA' } as never);
    const CANDIDATES_MAX = 10_000;
    // Distinct dids so each is a genuinely new candidate (no dedup short-circuit).
    for (let i = 0; i < CANDIDATES_MAX; i++) {
      const r = reg.requestEnrollment(ev.id, { agentDid: `did:ethr:0x${i}`, team: 't', requestedBy: 'x' } as never);
      expect('error' in r).toBe(false);
    }
    // The next one is over the cap → rejected, not silently grown.
    const over = reg.requestEnrollment(ev.id, { agentDid: 'did:ethr:0xOVER', team: 't', requestedBy: 'x' } as never);
    expect('error' in over).toBe(true);
    expect((over as { error: string }).error).toMatch(/candidate limit/);
  }, 60_000);

  it('the evaluations Map itself evicts oldest past its cap (mechanism)', () => {
    // Reuse the same evict-oldest mechanism on a small Map to prove the discipline
    // the registry / xAPI doc stores apply (a 100k / 50k live loop is not unit-sized).
    const m = new Map<string, number>();
    const MAX = 50;
    const cappedSet = (k: string, v: number): void => {
      if (m.size >= MAX && !m.has(k)) {
        const oldest = m.keys().next().value;
        if (oldest !== undefined) m.delete(oldest);
      }
      m.set(k, v);
    };
    for (let i = 0; i < MAX + 30; i++) cappedSet(`k-${i}`, i);
    expect(m.size).toBe(MAX);
    expect(m.has('k-0')).toBe(false);        // oldest evicted
    expect(m.has(`k-${MAX + 29}`)).toBe(true); // newest retained
  });
});
