/**
 * A performer who records their own work has already said what the situation is. When a unit of it
 * fails, the work recorded at that competency is answered, unasked, with the plan its regime
 * implies and the admission that plan implies: offered to keep, never kept. The regime is read
 * from the trajectories kept with the work, or not at all.
 */
import { describe, expect, it } from 'vitest';
import type { WorkStep } from '../../foxxi-content-intelligence/src/learner-record.js';
import { competencyIri } from '../../foxxi-content-intelligence/src/competency-identity.js';
import { WORK_OFFER_WINDOW, offerFromWork, type WorkUnit } from '../src/work-offers.js';

const performer = { id: 'did:web:performer.example', kind: 'agent' as const };
const competency = competencyIri('refund-authority');
const base = 'https://bridge.example';
const step = (modalStatus: WorkStep['modalStatus'], granularity: WorkStep['granularity'], success?: boolean): WorkStep => ({
  modalStatus, granularity, verb: 'acted', objectId: `urn:x:${Math.random()}`, objectName: 'a step', ...(success === undefined ? {} : { result: { success } }),
});
/** Considers and drops an alternative: Emergent. */
const exploring = [step('Asserted', 'task'), step('Asserted', 'tool-call', true), step('Asserted', 'tool-call', false), step('Counterfactual', 'tool-call')];
/** Planned in tasks and subtasks, and reliable: Knowable. */
const structured = [step('Asserted', 'task'), step('Asserted', 'subtask'), step('Asserted', 'tool-call', true), step('Asserted', 'tool-call', true)];
/** Mostly failing tool calls with no structure: Turbulent. */
const flailing = [step('Asserted', 'tool-call', false), step('Asserted', 'tool-call', false), step('Asserted', 'tool-call', false), step('Asserted', 'tool-call', true)];
const unit = (n: number, success: boolean | undefined, steps?: WorkStep[], observedBy = performer.id): WorkUnit => ({
  id: `urn:uuid:unit-${n}`, timestamp: `2026-09-${String(27 - Math.min(n, 26)).padStart(2, '0')}T10:00:00Z`, observedBy,
  ...(success === undefined ? {} : { success }), ...(steps ? { steps } : {}),
});
const offerFor = (work: WorkUnit[], standing?: { kinds: string[]; because: string }) =>
  offerFromWork({ performer, competency, label: 'refund authority', work, base, ...(standing ? { standing: standing as never } : {}) });

describe('a failed unit of work is answered with the plan its work implies', () => {
  it('offers probes and reflection for Emergent work, read from the trajectories kept with it', () => {
    const answer = offerFor([unit(1, false, exploring), unit(2, true), unit(3, undefined)]);
    expect(answer.offered).toBe(true);
    const offer = (answer as { offer: Record<string, unknown> }).offer;
    expect(offer).toMatchObject({
      competency, kinds: ['reflection', 'probe'], regime: 'Emergent', forPerformer: performer.id,
      keep: { affordance: 'urn:iep:action:foxxi:content-admit-signed', target: `${base}/agent/content/admit`, method: 'POST' },
      diagnosis: { regime: 'Emergent', regimeSource: 'derived', method: 'dispositional-read' },
      plan: { selected: ['coaching', 'probe'] },
      evidence: { work: ['urn:uuid:unit-1', 'urn:uuid:unit-2', 'urn:uuid:unit-3'], failed: 1, assessed: 2, withTrajectory: 1 },
    });
    expect((offer.situation as { modalStatus: string }).modalStatus).toBe('Hypothetical');   // a self-report is a claim to measure
  });

  it('offers assessment first for Knowable work only its performer reported', () => {
    const offer = (offerFor([unit(1, false, structured)]) as { offer: Record<string, unknown> }).offer;
    expect(offer).toMatchObject({ kinds: ['assessment-item'], regime: 'Knowable', plan: { selected: ['assessment', 'no-intervention'] } });
  });

  it('offers an admission of no content for Turbulent work, since stabilising it is no content\'s job', () => {
    const offer = (offerFor([unit(1, false, flailing)]) as { offer: Record<string, unknown> }).offer;
    expect(offer).toMatchObject({ kinds: [], regime: 'Turbulent', plan: { selected: ['environmental-fix'] } });
    expect(String(offer.because)).toMatch(/which no content delivers/);
  });

  it('reads Knowable work someone else observed failing as Asserted, and so has nothing to keep', () => {
    const answer = offerFor([unit(1, false, structured, 'did:web:supervisor.example')]);
    expect(answer).toEqual({ offered: false, because: 'the plan for this Knowable work selected no intervention, so there is nothing to keep' });
  });
});

describe('and nothing is offered when there is nothing to answer, or nothing to read', () => {
  it('answers only a failure', () => {
    expect(offerFor([unit(1, true, exploring), unit(2, false, exploring)])).toMatchObject({ offered: false, because: expect.stringMatching(/did not fail/) });
    expect(offerFor([unit(1, undefined, exploring)])).toMatchObject({ offered: false, because: expect.stringMatching(/did not fail/) });
    expect(offerFor([])).toMatchObject({ offered: false, because: expect.stringMatching(/no work is recorded/) });
  });

  it('reads no regime from work kept without a trajectory, and says what would let it', () => {
    expect(offerFor([unit(1, false), unit(2, false)])).toMatchObject({ offered: false, because: expect.stringMatching(/no trajectory was kept with the work at refund authority/) });
  });

  it('reads only the latest units of work at the competency', () => {
    const older = Array.from({ length: WORK_OFFER_WINDOW }, (_, i) => unit(i + 2, false));
    const answer = offerFor([unit(1, false), ...older.slice(0, WORK_OFFER_WINDOW - 1), unit(WORK_OFFER_WINDOW + 1, false, exploring)]);
    expect(answer).toMatchObject({ offered: false, because: expect.stringMatching(/no trajectory was kept/) });
    expect(offerFor([unit(1, false), ...older.slice(0, WORK_OFFER_WINDOW - 2), unit(WORK_OFFER_WINDOW, false, exploring)]).offered).toBe(true);
  });

  it('does not offer what the performer already keeps there', () => {
    expect(offerFor([unit(1, false, exploring)], { kinds: ['reflection', 'probe'], because: 'kept earlier' })).toEqual({ offered: false, because: 'you already keep this admission at refund authority' });
    expect(offerFor([unit(1, false, exploring)], { kinds: ['probe'], because: 'kept earlier' }).offered).toBe(true);
  });
});
