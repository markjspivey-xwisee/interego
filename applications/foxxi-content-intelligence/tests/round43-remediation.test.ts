/**
 * Round-43: two of the caller-keyed-identity / unbounded findings.
 *  (1) Evaluation owner lock — only the agent that OPENED an evaluation may accept/decline
 *      candidates; without it any tenant co-member could self-accept its own candidate into a
 *      rival's evaluation (privilege escalation).
 *  (2) cmi5 course registry cap — POST /content/publish-course looped with fresh ids grew the
 *      per-tenant registry without limit (OOM); registerCmi5Course now evicts oldest past a cap.
 */

import { describe, it, expect } from 'vitest';
import { EvaluationRegistry } from '../src/agent-evaluation.js';
import { registerCmi5Course, listCmi5Courses } from '../src/cmi5-lms.js';
import { DEFAULT_TENANT, type TenantId } from '../src/tenant-context.js';

describe('round-43 — evaluation owner lock + cmi5 registry cap', () => {
  it('only the evaluation opener may decide candidates', () => {
    const reg = new EvaluationRegistry();
    const ev = reg.open({ name: 'E', decisionQuestion: 'best agent?', openedBy: 'did:ethr:0xA' } as never);
    const req = reg.requestEnrollment(ev.id, { agentDid: 'did:ethr:0xC', team: 'team-C' } as never);
    expect('error' in req).toBe(false);
    const candidateId = (req as { candidateId: string }).candidateId;

    // A DIFFERENT agent (B, a co-member) must NOT be able to decide.
    const bad = reg.decide(ev.id, candidateId, 'accept', 'did:ethr:0xB');
    expect('error' in bad).toBe(true);

    // The opener (A) can.
    const ok = reg.decide(ev.id, candidateId, 'accept', 'did:ethr:0xA');
    expect('error' in ok).toBe(false);
    expect((ok as { status: string }).status).toBe('accepted');
  });

  it('cmi5 course registry evicts oldest past its cap (bounded)', () => {
    const tenant = `lens:r43-cmi5-${Math.floor(1)}` as TenantId;
    for (let i = 0; i < 5010; i++) {
      registerCmi5Course(tenant, { id: `r43-course-${i}`, title: `C${i}`, blocks: [] } as never);
    }
    expect(listCmi5Courses(tenant).length).toBeLessThanOrEqual(5000);
    void DEFAULT_TENANT;
  });
});
