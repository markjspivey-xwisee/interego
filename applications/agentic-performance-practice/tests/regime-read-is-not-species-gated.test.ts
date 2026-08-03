/**
 * Trajectory signal is read whoever produced it.
 *
 * ★ WHY. `diagnose()` gated the derived-regime path on
 * `situation.performer.kind === 'agent' && trajectories.length > 0`. So a HUMAN's
 * trajectory was never read, and the situation fell through to
 * default-gap-intent → Knowable → gap-analysis → instruction.
 *
 * Confirmed against the deployed bridge via POST /performance/plan with
 * byte-identical Emergent-shaped trajectories:
 *
 *   kind: 'agent'  ->  Emergent  / derived            / ["coaching","probe"]
 *   kind: 'human'  ->  Knowable  / default-gap-intent / ["instruction"]
 *
 * This module exists to argue that the gap model fits only Knowable work — and it
 * guaranteed that a human could never be placed anywhere else. A person whose work is
 * genuinely Emergent was always told to go on a course, by the very component written
 * to prevent that. It is also the opposite of what a mixed human/agent team needs,
 * which is one read applied to both.
 *
 * Nothing in the disposition read is species-specific: exploration ratio, plan
 * revision, structural share and tool-call success are properties of the WORK.
 *
 * BEHAVIOURAL — it calls diagnose() with both performer kinds and compares.
 */
import { describe, it, expect } from 'vitest';
import { diagnose, recommendInterventions } from '../src/performance-architecture.js';
import type { AgentTrajectory } from '../src/agent-trajectory.js';

/** An Emergent-shaped run: 2 of 10 steps counterfactual (exploration 0.2 >= 0.12). */
const emergentTrajectory = (did: string): AgentTrajectory[] => [{
  agentDid: did,
  agentName: 'subject',
  steps: [
    { modalStatus: 'Asserted', granularity: 'task', verb: 'opened', objectId: 'x:1', objectName: 'an unfamiliar failure', recordedAt: '2026-07-29T00:00:00.000Z' },
    { modalStatus: 'Hypothetical', granularity: 'subtask', verb: 'considered', objectId: 'x:2', objectName: 'isolating the cache tier', recordedAt: '2026-07-29T00:01:00.000Z' },
    { modalStatus: 'Counterfactual', granularity: 'subtask', verb: 'rejected', objectId: 'x:3', objectName: 'isolating the cache tier', recordedAt: '2026-07-29T00:02:00.000Z' },
    { modalStatus: 'Hypothetical', granularity: 'subtask', verb: 'considered', objectId: 'x:4', objectName: 'shedding write traffic', recordedAt: '2026-07-29T00:03:00.000Z' },
    { modalStatus: 'Counterfactual', granularity: 'subtask', verb: 'rejected', objectId: 'x:5', objectName: 'shedding write traffic', recordedAt: '2026-07-29T00:04:00.000Z' },
    { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'probed', objectId: 'x:6', objectName: 'subsystem 1', recordedAt: '2026-07-29T00:05:00.000Z', result: { success: true } },
    { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'probed', objectId: 'x:7', objectName: 'subsystem 2', recordedAt: '2026-07-29T00:06:00.000Z', result: { success: false } },
    { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'probed', objectId: 'x:8', objectName: 'subsystem 3', recordedAt: '2026-07-29T00:07:00.000Z', result: { success: true } },
    { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'probed', objectId: 'x:9', objectName: 'subsystem 4', recordedAt: '2026-07-29T00:08:00.000Z', result: { success: true } },
    { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'probed', objectId: 'x:10', objectName: 'subsystem 5', recordedAt: '2026-07-29T00:09:00.000Z', result: { success: true } },
  ],
}] as unknown as AgentTrajectory[];

const situationFor = (kind: 'human' | 'agent') => ({
  id: `sit-${kind}`,
  performer: { id: kind === 'agent' ? 'did:ethr:0xagent' : 'did:ethr:0xhuman', kind },
  workContext: 'production incident response',
  competency: 'production-incident-command',
  observed: 'time to mitigate is rising and outcomes are less reliable',
  frequency: 'occasional' as const,
  criticality: 'high' as const,
  modalStatus: 'Asserted' as const,
  provenance: 'recorded trajectories',
});

describe('the regime read is not species-gated', () => {
  it('reads an AGENT trajectory (the path that already worked)', () => {
    const d = diagnose({ situation: situationFor('agent'), trajectories: emergentTrajectory('did:ethr:0xagent') });
    expect(d.regimeSource).toBe('derived');
    expect(d.domain).toBe('Emergent');
  });

  it('reads a HUMAN trajectory the same way', () => {
    const d = diagnose({ situation: situationFor('human'), trajectories: emergentTrajectory('did:ethr:0xhuman') });
    expect(d.regimeSource, 'a human trajectory must not fall through to the gap frame').toBe('derived');
    expect(d.domain, 'the same work shape must place in the same regime').toBe('Emergent');
  });

  it('places both performers identically from identical work', () => {
    const a = diagnose({ situation: situationFor('agent'), trajectories: emergentTrajectory('did:ethr:0xagent') });
    const h = diagnose({ situation: situationFor('human'), trajectories: emergentTrajectory('did:ethr:0xhuman') });
    expect(h.domain).toBe(a.domain);
    expect(h.regimeSource).toBe(a.regimeSource);
    expect(h.method).toBe(a.method);
  });

  it('still refuses when there is no signal of any kind', () => {
    // The fallbacks must be untouched: no trajectories and no gap-intent evidence
    // still refuses rather than defaulting into Knowable.
    const d = diagnose({ situation: situationFor('human') });
    expect(d.regimeSource).toBe('unclassified');
    expect(d.method).toBe('classify-first');
  });

  it('still honours an asserted regime over trajectory signal', () => {
    const d = diagnose({
      situation: { ...situationFor('human'), domain: 'Knowable' as const },
      trajectories: emergentTrajectory('did:ethr:0xhuman'),
    });
    expect(d.regimeSource).toBe('asserted');
    expect(d.domain).toBe('Knowable');
  });

  // ★ This assertion used to read `d.plan?.interventions ?? []`. `Diagnosis` has no `plan`
  // property and never had one — the plan is built by `recommendInterventions`, a separate
  // call. So the optional chain was always `undefined`, `selected` was always `[]`, and
  // `expect([]).not.toEqual(['instruction'])` passed without ever consulting the router. The
  // one test in this file that checks WHERE Emergent work is routed was checking nothing, and
  // vitest could not say so because it strips the types that would have.
  it('does not offer an instruction-only plan for Emergent work, for either performer', () => {
    for (const kind of ['human', 'agent'] as const) {
      const situation = situationFor(kind);
      const d = diagnose({ situation, trajectories: emergentTrajectory('did:ethr:0x1') });
      const plan = recommendInterventions({ diagnosis: d, situation });
      const selected = plan.selected.map(o => o.type);
      expect(selected.length, `${kind}: the router must actually select something`).toBeGreaterThan(0);
      expect(selected, `${kind}: Emergent work must not route to instruction alone`).not.toEqual(['instruction']);
      expect(selected, `${kind}: Emergent work must not route to instruction at all`).not.toContain('instruction');
    }
  });
});
