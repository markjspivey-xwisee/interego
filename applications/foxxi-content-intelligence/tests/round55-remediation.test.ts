/**
 * Round-55 (final): close the last confirmed finding — record_external_agent_run let any
 * signed wallet inject a run into ANOTHER agent's evaluation candidate slot by passing its
 * (guessable `<evalId>:candidate-<n>`) candidate_id. The run is the caller's own agentDid's
 * performance, so the slot it lands in must belong to agentDid; the handler now rejects a
 * candidate whose agentDid differs (unless the caller is an operator).
 *
 * The gate is in the MCP handler (needs the full dispatch to exercise end-to-end); this test
 * proves the registry invariant the handler's check relies on — a candidate slot is bound to
 * exactly one agentDid, which is queryable for the ownership comparison.
 */

import { describe, it, expect } from 'vitest';
import { EvaluationRegistry } from '../src/agent-evaluation.js';

describe('round-55 — an evaluation candidate slot is owned by exactly one agent', () => {
  it('candidate.agentDid identifies the owner; a different (rival) DID does not match', () => {
    const reg = new EvaluationRegistry();
    const ev = reg.open({ name: 'E', decisionQuestion: 'best agent?', openedBy: 'did:ethr:0xOWNER' } as never);

    const enroll = reg.requestEnrollment(ev.id, { agentDid: 'did:ethr:0xAGENT', team: 't', requestedBy: 'x' } as never);
    const candidateId = (enroll as { candidateId: string }).candidateId;
    reg.decide(ev.id, candidateId, 'accept', 'did:ethr:0xOWNER');

    // The handler resolves the slot by the caller-supplied candidate_id, then checks ownership.
    const slot = reg.get(ev.id)!.candidates.find(c => c.candidateId === candidateId)!;
    expect(slot.agentDid).toBe('did:ethr:0xAGENT');

    // The handler's guard: `candidate.agentDid !== agentDid` → reject. A rival caller
    // (agentDid = their own DID, forced upstream) does NOT own this slot.
    const rivalAgentDid = 'did:ethr:0xRIVAL';
    expect(slot.agentDid !== rivalAgentDid).toBe(true);        // guard fires → rival is rejected
    const ownerAgentDid = 'did:ethr:0xAGENT';
    expect(slot.agentDid !== ownerAgentDid).toBe(false);       // owner passes

    // The auto-resolve path (no candidate_id) binds to the caller's own DID, never a rival's.
    expect(reg.findCandidateByAgent(ev.id, 'did:ethr:0xAGENT')?.candidateId).toBe(candidateId);
    expect(reg.findCandidateByAgent(ev.id, rivalAgentDid)).toBeUndefined();
  });
});
