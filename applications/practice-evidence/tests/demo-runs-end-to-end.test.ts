/**
 * The offline demo runs end to end, and what it reports holds up when checked from its own data.
 *
 * `runDemo` walks two real bridges over HTTP as a Path-A agent and asserts every status and code
 * itself. This module does not take its word for it: it checks the step table against the spec's
 * list, and re-checks the statements, the copies, the calibration, the results and the pod's bytes
 * from what the demo returned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { DEMO_LINES, DEMO_POD, FABRICATED_QUOTE, LIVE_MODE_NOTE, runDemo, type DemoReport } from '../demo/run.js';
import { CMI5_CATEGORY_PREFIX, PRACTICE_MARKER, statementProblems, VERB_COMPLETED, type ProjectionFormat } from '../src/projections.js';

type Out = Record<string, unknown>;
const obj = (v: unknown): Out => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Out : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v as unknown[] : []);

/** The spec's step table (§16.3), by step id: the status and, for a refusal, the code. */
const EXPECTED: readonly (readonly [string, number, string?])[] = [
  ['1a', 200], ['1b', 200], ['1c', 200], ['1d', 200], ['1e', 200],
  ['2', 403, 'not-an-admin'], ['3', 403, 'not-an-author'], ['4', 400, 'assessment-use-undeclared'],
  ['5', 200], ['6', 409, 'scenario-not-published'], ['7', 200], ['8', 200], ['9', 200],
  ['10', 403, 'ratifier-is-the-author'], ['11', 200], ['12', 200], ['13', 400, 'pass-gate-needs-knowable-work'], ['14', 200], ['15', 200],
  ['16', 400, 'coached-undeclared'], ['17', 200], ['18', 503, 'no-model-route'], ['19a', 200], ['19b', 200],
  ['20', 409, 'envelope-already-used'], ['21', 403, 'not-the-learner'], ['22', 409, 'attempt-not-ended'], ['23', 200], ['24', 200],
  ['25', 200], ['26', 200], ['27', 409, 'attempt-not-countersigned'], ['27b', 200],
  ['28', 403, 'reviewer-is-the-learner'], ['29', 409, 'unverified-criteria-need-override'], ['30', 200],
  ['31a', 403, 'reviewer-already-reviewed'], ['31b', 409, 'attempt-not-judged'], ['32a', 200], ['32b', 200], ['33', 501, 'projection-not-built'],
  ['34', 403, 'not-the-learner'], ['35', 200], ['36', 200],
  ['37a', 200], ['37b', 200], ['37c', 200], ['37d', 200], ['37e', 200], ['38a', 200], ['38b', 200],
  ['39', 403, 'reviewer-is-the-judge'], ['40', 200], ['41', 200], ['42', 200], ['43', 200], ['44', 403, 'reviewer-already-reviewed'], ['45', 200],
  ['46', 200], ['47', 200], ['47b', 200], ['48', 200], ['49', 200], ['50a', 200], ['50b', 200], ['50c', 409, 'attempt-redacted'], ['v2', 200],
];

let report: DemoReport;
beforeAll(async () => { report = await runDemo({ quiet: true }); }, 300_000);

describe('the offline demo runs end to end', () => {
  it('reports ok, and quietly writes no report file', () => {
    const failing = report.steps.filter((s) => !s.ok).map((s) => `${s.id} ${s.name}: ${s.note}`);
    expect(failing).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.reportPath).toBeUndefined();
  });

  it('every step of the spec\'s table ran, with the status and code the spec names', () => {
    expect(report.steps.map((s) => s.id)).toEqual(EXPECTED.map(([id]) => id));
    for (const [id, status, code] of EXPECTED) {
      const s = report.steps.find((x) => x.id === id);
      expect([id, s?.gotStatus, s?.gotCode ?? undefined, s?.ok]).toEqual([id, status, code, true]);
    }
    const numbered = new Set(EXPECTED.map(([id]) => Number.parseInt(id, 10)).filter((x) => Number.isInteger(x)));
    for (let i = 1; i <= 50; i++) expect(numbered.has(i), `step ${i}`).toBe(true);
  });

  it('the fabricated quote is unverified with its reason; the result before review is provisional and does not meet the rule', () => {
    expect(report.fabricatedQuote).toMatchObject({ text: FABRICATED_QUOTE, verified: false, why: 'not found verbatim in any learner turn' });
    const ana = obj(report.attempts[0]);
    expect(obj(ana['provisional'])).toMatchObject({ use: 'pass-gate', provisional: true, percent: '66.7', meetsPassRule: false, computedBy: 'platform' });
    expect(ana['provisionalLabel']).toBe('provisional, not reviewed');
    expect(obj(ana['finalAssessment'])).toMatchObject({ provisional: false, percent: '100.0', meetsPassRule: true });
  });

  it('every statement passes the checks, says practice and completed, and none carries a cmi5 category; feedback-only has no score', () => {
    const cases: readonly [unknown, ProjectionFormat, 'pass-gate' | 'feedback-only'][] = [
      [report.statements.xapi, 'xapi', 'pass-gate'], [report.statements.cmi5, 'cmi5', 'pass-gate'], [report.statements.feedbackOnly, 'xapi', 'feedback-only'],
    ];
    for (const [st, format, use] of cases) {
      expect(statementProblems(st, format, use)).toEqual([]);
      const s = obj(st);
      expect(obj(s['verb'])['id']).toBe(VERB_COMPLETED);
      expect(obj(obj(s['context'])['extensions'])[PRACTICE_MARKER]).toBe(true);
      const categories = arr(obj(obj(s['context'])['contextActivities'])['category']).map((c) => String(obj(c)['id']));
      expect(categories.filter((c) => c.startsWith(CMI5_CATEGORY_PREFIX))).toEqual([]);
    }
    const feedback = obj(obj(report.statements.feedbackOnly)['result']);
    expect(['score' in feedback, 'success' in feedback]).toEqual([false, false]);
    expect(obj(obj(report.statements.xapi)['result'])['success']).toBe(true);
  });

  it('the learner\'s copy and export: eight versions each, every one verified', () => {
    expect(report.copies).toMatchObject({ copies: 8, copiesVerified: 8 });
    expect(report.export).toMatchObject({ versions: 8, verifiedOffline: 8 });
  });

  it('calibration cells are Hypothetical with the pre-check reason; small final counts are suppressed and the author test is left out', () => {
    const cells = arr(report.calibration).map(obj);
    expect(cells.length).toBe(5);
    expect(cells.every((c) => c['status'] === 'Hypothetical')).toBe(true);
    const agent = cells.filter((c) => String(c['judgeId']).startsWith('did:ethr:'));
    expect(agent.map((c) => obj(c['standing'])['why'])).toEqual(agent.map(() => expect.stringMatching(/^1 outcome\(s\) of pev\/[0-9a-f]{16}\/[a-z0-9-]+, below 20$/)));
    const results = obj(report.results);
    expect(obj(results['counts'])['authorTestExcluded']).toBe(1);
    const levels = arr(obj(results['final'])['perCriterion']).flatMap((c) => arr(obj(c)['levels']).map(obj));
    expect(levels.filter((l) => l['suppressed'] !== true && l['count'] !== 0)).toEqual([]);
  });

  it('after the redaction no line of the first attempt remains anywhere on the operator pod, and the timings were measured', () => {
    const operator = [...report.pod.store].filter(([url]) => url.startsWith(DEMO_POD));
    expect(operator.length).toBeGreaterThan(20);
    for (const line of DEMO_LINES.ana) expect(operator.filter(([, body]) => body.includes(line)).map(([url]) => url)).toEqual([]);
    const redacted = obj(report.attempts[1]);
    expect(redacted['state']).toBe('redacted');
    expect(arr(redacted['turns']).every((t) => !('text' in obj(t)) && typeof obj(t)['textSha256'] === 'string')).toBe(true);
    expect(report.turnLatencyMs).toHaveLength(5);
    expect(report.turnLatencyMs.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
  });

  it('has no live mode, and says what to run instead', async () => {
    await expect(runDemo({ live: true, quiet: true })).rejects.toThrow(LIVE_MODE_NOTE);
  });
});
