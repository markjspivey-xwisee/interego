/**
 * The dashboard's Work page speaks the bridge's language, end to end: work written in it is kept
 * as the bridge keeps a trajectory, a failure is answered from it by the practice's own offer, and
 * what the page sends to keep that offer is a record the bridge keeps.
 *
 * Each step is the real code: Foxxi's workStepsFrom (what record-performance keeps with a unit),
 * the performance practice's offerFromWork (what it answers a failed unit with), and Foxxi's
 * admissionRecordFrom (what foxxi.content_admit keeps). Only the page's own shaping is under test.
 */
import { describe, expect, it } from 'vitest';
import { workStepsFrom } from '../applications/foxxi-content-intelligence/src/learner-record.js';
import { admissionRecordFrom } from '../applications/foxxi-content-intelligence/src/admission-records.js';
import { competencyIri } from '../applications/foxxi-content-intelligence/src/competency-identity.js';
import { offerFromWork } from '../applications/agentic-performance-practice/src/work-offers.js';
import { answerableFailure, missingFromWork, newStep, newWork, trajectoryOf, workPayload, type StepDraft, type WorkDraft } from '../applications/foxxi-content-intelligence/dashboard-app/src/work/record.js';
import { keepArgs, keptLine, kindsLine, standing, withdrawArgs, type KeptAdmission, type WorkOffer } from '../applications/foxxi-content-intelligence/dashboard-app/src/work/offer.js';

const performer = { id: 'did:ethr:0x4444444444dd00000000000000000000000beef4', kind: 'human' as const };
const competency = competencyIri('refund-authority');
const step = (patch: Partial<StepDraft>): StepDraft => ({ ...newStep(), ...patch });

/** Work that considers and drops an alternative, written as a person writes it in the page. */
const exploring: WorkDraft = {
  ...newWork('human'), taskName: '  Refund a disputed $600 order ', outcome: 'failed', activityType: competency, quality: '-0.5', duration: 'PT25M',
  steps: [
    step({ did: 'handled', onWhat: 'the refund request', grain: 'task' }),
    step({ did: 'checked', onWhat: 'the order history', grain: 'tool-call', outcome: 'worked' }),
    step({ did: 'refunded', onWhat: 'the full amount', grain: 'tool-call', outcome: 'failed', note: 'above my limit' }),
    step({ did: 'asked', onWhat: 'the team lead', grain: 'tool-call', certainty: 'Counterfactual', revises: 2 }),
  ],
};

describe('work written in the page is kept as the bridge keeps it', () => {
  it('sends the unit as record-performance takes it, and each step as the learner record keeps it', () => {
    const payload = workPayload(exploring);
    expect(payload).toMatchObject({ task_name: 'Refund a disputed $600 order', success: false, actor_kind: 'human', activity_type: competency, quality: -0.5, duration_iso: 'PT25M' });
    const kept = workStepsFrom(payload.trajectory)!;
    expect(kept).toHaveLength(4);
    expect(kept[0]).toMatchObject({ id: 'step-1', modalStatus: 'Asserted', granularity: 'task', verb: 'handled', objectName: 'the refund request' });
    expect(kept[1]).toMatchObject({ result: { success: true } });
    expect(kept[2]).toMatchObject({ result: { success: false, note: 'above my limit' } });
    expect(kept[3]).toMatchObject({ modalStatus: 'Counterfactual', supersedesId: 'step-3' });
    expect(kept[3]).not.toHaveProperty('result');
  });

  it('leaves out what was not written, and sends no trajectory without steps', () => {
    expect(workPayload({ ...newWork('agent'), taskName: 'x', outcome: 'succeeded' })).toEqual({ task_name: 'x', success: true, actor_kind: 'agent' });
    expect(trajectoryOf([])).toBeUndefined();
    // A revision names only an earlier step.
    expect(trajectoryOf([step({ did: 'a', onWhat: 'b', revises: 0 })])!.steps[0]).not.toHaveProperty('supersedesId');
  });

  it('says what is missing before it is sent', () => {
    expect(missingFromWork(newWork())).toEqual(['Say what the work was.', 'Say whether it succeeded.']);
    const d = { ...newWork(), taskName: 'x', outcome: 'failed' as const };
    expect(missingFromWork({ ...d, activityType: 'refunds' })).toEqual(['A kind of work is an IRI, such as https://your.example/work/refunds; or leave it out.']);
    expect(missingFromWork({ ...d, quality: '2' })).toEqual(['Quality is a number from -1 to 1.']);
    expect(missingFromWork({ ...d, steps: [step({ did: 'x' })] })).toEqual(['Step 1: say what was done, and on what.']);
    expect(missingFromWork({ ...d, steps: [step({ did: 'x', onWhat: 'y'.repeat(501) })] })).toEqual(['Step 1: keep each text under 500 characters.']);
    expect(answerableFailure(d)).toBe(false);
    expect(answerableFailure(exploring)).toBe(true);
  });
});

describe('a failure answered from that work is kept, or withdrawn, as the bridge keeps it', () => {
  const unitOf = (d: WorkDraft, n: number) => ({
    id: `urn:uuid:unit-${n}`, timestamp: '2026-09-27T10:00:00Z', observedBy: performer.id,
    success: d.outcome === 'succeeded', steps: workStepsFrom(workPayload(d).trajectory),
  });
  const offerOf = (d: WorkDraft): WorkOffer => {
    const answer = offerFromWork({ performer, competency, label: 'refund authority', work: [unitOf(d, 1)], base: 'https://bridge.example' });
    if (!answer.offered) throw new Error(answer.because);
    return answer.offer as unknown as WorkOffer;
  };

  it('keeps the offer for Emergent work as the admission it names', () => {
    const offer = offerOf(exploring);
    expect(offer.regime).toBe('Emergent');
    const record = admissionRecordFrom({ ...keepArgs(offer), at: '2026-09-27T10:05:00Z' });
    expect([...(record.admission?.kinds ?? [])].sort()).toEqual([...offer.kinds].sort());
    expect(record).toMatchObject({ competency, regime: 'Emergent', admission: { because: offer.because } });
    expect(kindsLine(offer.kinds)).toBe(offer.kinds.map(k => ({ probe: 'Probe', reflection: 'Reflection' } as Record<string, string>)[k]).join(', '));
  });

  it('keeps an admission of no content, for work no content helps, and says so', () => {
    const flailing: WorkDraft = { ...exploring, steps: [0, 1, 2, 3].map(i => step({ did: 'tried', onWhat: `thing ${i}`, grain: 'tool-call', outcome: i === 3 ? 'worked' : 'failed' })) };
    const offer = offerOf(flailing);
    expect(offer.kinds).toEqual([]);
    expect(admissionRecordFrom({ ...keepArgs(offer), at: '2026-09-27T10:05:00Z' }).admission).toEqual({ kinds: [], because: offer.because });
    expect(kindsLine([])).toMatch(/no form of content/);
  });

  it('withdraws what is kept at a competency, and lists what still stands', () => {
    expect(admissionRecordFrom({ ...withdrawArgs(competency), at: '2026-09-27T10:06:00Z' }).admission).toBeNull();
    const kept: KeptAdmission[] = [
      { competency, admission: { kinds: ['probe'], because: 'b' }, at: '2026-09-27T10:05:00Z' },
      { competency: competencyIri('other'), admission: null, at: '2026-09-27T10:04:00Z' },
    ];
    expect(standing(kept).map(k => k.competency)).toEqual([competency]);
    expect(keptLine(kept[0]!)).toBe('Admits Probe');
    expect(keptLine(kept[1]!)).toMatch(/^Withdrawn/);
  });
});
