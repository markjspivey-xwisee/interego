/**
 * The dashboard's Work page speaks the bridge's language, end to end: work written in it is kept
 * as the bridge keeps a trajectory, a failure is answered from it by the practice's own offer, and
 * what the page sends to keep that offer is a record the bridge keeps.
 *
 * Each step is the real code: Foxxi's workStepsFrom (what record-performance keeps with a unit),
 * the performance practice's offerFromWork (what it answers a failed unit with), and Foxxi's
 * admissionRecordFrom (what foxxi.content_admit keeps). Only the page's own shaping is under test.
 *
 * What the page stops before sending is what the bridge would refuse, by the same rules: a step's
 * texts by the record's own limits, a duration by the statement validator's. And recording as an
 * agent, which can make the performer's whole record public, is sent only once they say they know.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WORK_STEP_LIMITS, durationRefusalOf, workStepsFrom } from '../applications/foxxi-content-intelligence/src/learner-record.js';
import { validateStatement } from '../applications/foxxi-content-intelligence/src/xapi-validate.js';
import { admissionRecordFrom } from '../applications/foxxi-content-intelligence/src/admission-records.js';
import { competencyIri } from '../applications/foxxi-content-intelligence/src/competency-identity.js';
import { offerFromWork } from '../applications/agentic-performance-practice/src/work-offers.js';
import {
  AGENT_RECORD_IS_PUBLIC, afterRecording, answerableFailure, doneBy, missingFromWork, newStep, newWork, trajectoryOf, workPayload,
  type StepDraft, type WorkDraft,
} from '../applications/foxxi-content-intelligence/dashboard-app/src/work/record.js';
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
    expect(answerableFailure(d)).toBe(false);
    expect(answerableFailure(exploring)).toBe(true);
  });

  it("holds a step's texts to what the learner record keeps, measured as they are sent", () => {
    const d = { ...newWork(), taskName: 'x', outcome: 'failed' as const };
    const tooLong = [`Step 1: keep each text to ${WORK_STEP_LIMITS.text} characters or fewer.`];
    const onWhat = (text: string): WorkDraft => ({ ...d, steps: [step({ did: 'x', onWhat: text })] });
    // The longest text the record keeps passes the page, spaces around it aside, and the bridge keeps it.
    const longest = onWhat(`  ${'y'.repeat(WORK_STEP_LIMITS.text)}  `);
    expect(missingFromWork(longest)).toEqual([]);
    expect(workStepsFrom(workPayload(longest).trajectory)![0]!.objectName).toHaveLength(WORK_STEP_LIMITS.text);
    // One more is refused by both, and the page says so before anything is sent.
    const over = onWhat('y'.repeat(WORK_STEP_LIMITS.text + 1));
    expect(missingFromWork(over)).toEqual(tooLong);
    expect(() => workStepsFrom(workPayload(over).trajectory)).toThrow(/objectName is longer than/);
    const noted: WorkDraft = { ...d, steps: [step({ did: 'x', onWhat: 'y', note: 'n'.repeat(WORK_STEP_LIMITS.text + 1) })] };
    expect(missingFromWork(noted)).toEqual(tooLong);
    expect(() => workStepsFrom(workPayload(noted).trajectory)).toThrow(/result\.note must be a string of at most/);
    const did: WorkDraft = { ...d, steps: [step({ did: 'd'.repeat(WORK_STEP_LIMITS.text + 1), onWhat: 'y' })] };
    expect(missingFromWork(did)).toEqual(tooLong);
    expect(() => workStepsFrom(workPayload(did).trajectory)).toThrow(/verb is longer than/);
  });
});

describe('a duration is taken only as xAPI takes one', () => {
  const d: WorkDraft = { ...newWork(), taskName: 'x', outcome: 'succeeded' };
  const line = 'A duration is written as ISO 8601, such as PT25M for 25 minutes or PT1H30M; or leave it out.';
  const statementWith = (duration: unknown) => ({
    actor: { objectType: 'Agent', account: { homePage: 'https://bridge.example', name: performer.id } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/completed' },
    object: { objectType: 'Activity', id: 'https://bridge.example/task/1' },
    result: { duration },
  });

  it('is refused by the page when the statement validator would refuse it, and sent when it would not', () => {
    for (const bad of ['25m', 'PT', 'P1W2D', '25 minutes']) {
      expect(missingFromWork({ ...d, duration: bad })).toEqual([line]);
      expect(validateStatement(statementWith(bad))).toContain('result.duration must be an ISO 8601 duration');
    }
    for (const good of ['PT25M', ' PT1H30M ', 'P1W', 'PT0.5S']) {
      expect(missingFromWork({ ...d, duration: good })).toEqual([]);
      expect(validateStatement(statementWith(workPayload({ ...d, duration: good }).duration_iso))).toEqual([]);
    }
  });

  it("is refused by the bridge as the caller's own mistake, named, and nothing sent is refused for being absent", () => {
    for (const absent of [undefined, null, '']) expect(durationRefusalOf(absent)).toBeUndefined();
    expect(durationRefusalOf('PT25M')).toBeUndefined();
    expect(durationRefusalOf('25m')).toMatch(/^duration_iso must be an ISO 8601 duration, such as PT25M .* Received "25m"\.$/);
    expect(durationRefusalOf(25)).toMatch(/Received a number\.$/);
    expect(durationRefusalOf('x'.repeat(500))).toContain(`Received "${'x'.repeat(80)}".`);
  });

  it('is checked at both record-performance doors, as a 400, before anything is fetched or kept', () => {
    const server = readFileSync(new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8');
    const route = server.slice(server.indexOf("app.post('/agent/record-performance'"), server.indexOf("app.get('/agent/ingest-course/affordance'"));
    const atRoute = route.indexOf('const durationRefused = durationRefusalOf(p.duration_iso);');
    expect(atRoute).toBeGreaterThan(-1);
    expect(route.slice(atRoute)).toMatch(/^const durationRefused = durationRefusalOf\(p\.duration_iso\);\s+if \(durationRefused\) \{ res\.status\(400\)\.json\(\{ error: durationRefused \}\); return; \}/);
    expect(atRoute).toBeLessThan(route.indexOf('await bindPerformanceToEvidence('));
    expect(route).toContain("...(typeof p.duration_iso === 'string' && p.duration_iso ? { duration: p.duration_iso } : {}),");
    const start = server.indexOf("'foxxi.record_performance': async");
    const mcp = server.slice(start, server.indexOf('await bindPerformanceToEvidence(', start));
    expect(mcp).toMatch(/const durationRefused = durationRefusalOf\(args\.duration_iso\);\s+if \(durationRefused\) return invalidArguments\(durationRefused\);/);
  });
});

describe("recording work as an agent's is chosen knowing what it does to the record", () => {
  const d: WorkDraft = { ...newWork(), taskName: 'x', outcome: 'succeeded' };
  const line = "Say that you understand recording it as an agent's work can make your record public, or say a person did it.";

  it('is not sent until the performer says they understand, and a change of mind is asked about again', () => {
    const asAgent = doneBy(d, 'agent');
    expect(missingFromWork(asAgent)).toEqual([line]);
    expect(missingFromWork({ ...asAgent, publicAsAgent: true })).toEqual([]);
    expect(missingFromWork(d)).toEqual([]);
    expect(doneBy(doneBy({ ...asAgent, publicAsAgent: true }, 'human'), 'agent').publicAsAgent).toBe(false);
    // The next unit, done by the same kind, keeps what was confirmed for it; the rest starts again.
    expect(afterRecording({ ...asAgent, publicAsAgent: true, activityType: competency, duration: 'PT5M', steps: [step({ did: 'a', onWhat: 'b' })] }))
      .toEqual({ ...newWork('agent'), activityType: competency, publicAsAgent: true });
    expect(afterRecording(d)).toEqual(newWork('human'));
  });

  it("says what the bridge decides, and shows the bridge's own word on the record it answers with", () => {
    const server = readFileSync(new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8');
    // A record is an agent's only when all of its own work says so; an agent's record is public.
    expect(server).toContain("return declared.has('agent') && !declared.has('human') ? 'agent' : 'human';");
    expect(AGENT_RECORD_IS_PUBLIC).toContain('unless your record already holds work recorded as done by a person');
    expect(AGENT_RECORD_IS_PUBLIC).toContain("An agent's record is public");
    const panel = readFileSync(new URL('../applications/foxxi-content-intelligence/dashboard-app/src/components/WorkPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toMatch(/\{draft\.forKind === 'agent' && \(\s+<div role="note"[^>]*>\s+<div>\{AGENT_RECORD_IS_PUBLIC\}<\/div>/);
    expect(panel).toContain('onChange={() => { setDraft(d => doneBy(d, k)); setError(null); }}');
    expect(panel).toContain('setDraft(afterRecording);');
    expect(panel).toMatch(/\{recorded\.recordVisibility && <div role="note"[^>]*>\{recorded\.recordVisibility\.note\}<\/div>\}/);
    expect(panel).toMatch(/\{recorded\.samePrincipalAlsoHolds && <div[^>]*>\{recorded\.samePrincipalAlsoHolds\.note\}<\/div>\}/);
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
