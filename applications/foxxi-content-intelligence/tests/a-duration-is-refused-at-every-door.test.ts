/**
 * Every door that takes a caller's duration refuses one xAPI would refuse, before anything is built,
 * kept or fetched; and a cmi5 session is kept whole, or not at all.
 *
 * ★ WHY. A caller's `duration_iso` becomes a statement's `result.duration`, which xAPI requires to be
 * an ISO 8601 duration. The LRS refuses a statement whose duration is not (storeStatementInternal
 * answers null), and each door that took one unchecked went wrong its own way:
 *   - record-performance answered 500 for the caller's own input (fixed first, with
 *     durationRefusalOf);
 *   - an external agent run lost its task-level `performed` statement, the one the learner record
 *     reads as the run, while its tool-call steps were kept without it;
 *   - emit_cmi5_session handed back completed, passed and terminated statements that every LRS
 *     refuses, and let an empty duration through `??`, so the session went without its default;
 *   - a course completion kept the statements the LRS took, composed and forwarded the ones it
 *     refused as well, and answered `passed: true` over a passed statement it never kept.
 *
 * The census below finds every door that reads `duration_iso`, so a door added later without the
 * refusal fails here, not in production.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { durationRefusalOf } from '../src/learner-record.js';
import { internalRefusalOf, storeStatementInternal } from '../src/xapi-lrs.js';
import { buildPassedSessionTrace } from '../src/cmi5.js';
import { ingestExternalRun } from '../src/agent-run-ingest.js';

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

/** What a door does that must wait for its input to be checked. */
const EFFECTS = ['storeStatementInternal(', 'storeStatementDurably(', 'keepStatementsWhole(', 'buildPassedSessionTrace(', 'ingestExternalRun(', 'bindPerformanceToEvidence(', 'composeIntoSharedLattice(', 'persistRecordedStatement('];

describe('every door that takes a duration', () => {
  it('is found: the five doors that read duration_iso', () => {
    const taking = doors().filter(d => /\b(?:args|p)\.duration_iso\b/.test(d.body)).map(d => d.name);
    expect(taking.sort()).toEqual(['/agent/record-course-completion', '/agent/record-performance', 'foxxi.emit_cmi5_session', 'foxxi.record_external_agent_run', 'foxxi.record_performance'].sort());
  });

  it('refuses a bad one, as a 400, before it reads it for anything else, and before it builds, keeps or fetches anything', () => {
    for (const d of doors().filter(x => /\b(?:args|p)\.duration_iso\b/.test(x.body))) {
      const refusal = d.body.search(/durationRefusalOf\((?:args|p)\.duration_iso\)/);
      expect(refusal, `${d.name} takes a duration without refusing a bad one`).toBeGreaterThan(-1);
      const after = d.body.slice(refusal);
      expect(after, `${d.name} refuses a bad duration as something other than a 400`)
        .toMatch(/^durationRefusalOf\((?:args|p)\.duration_iso\);\s+if \(durationRefused\) (?:return invalidArguments\(durationRefused\);|\{ res\.status\(400\)\.json\(\{ error: durationRefused \}\); return; \})/);
      const uses = [...d.body.matchAll(/\b(?:args|p)\.duration_iso\b/g)].map(m => m.index!).filter(i => !d.body.slice(0, i).endsWith('durationRefusalOf('));
      expect(Math.min(...uses), `${d.name} reads the duration before refusing a bad one`).toBeGreaterThan(refusal);
      for (const effect of EFFECTS) {
        const at = d.body.indexOf(effect);
        if (at >= 0) expect(at, `${d.name}: ${effect} comes before the duration is checked`).toBeGreaterThan(refusal);
      }
    }
  });

  it('takes an empty duration as none sent, at the door that defaulted it with ??', () => {
    const emit = doors().find(d => d.name === 'foxxi.emit_cmi5_session')!.body;
    expect(emit).toContain("durationIso: (typeof args.duration_iso === 'string' && args.duration_iso) ? args.duration_iso : 'PT5M',");
    expect(emit).not.toMatch(/duration_iso as string\) \?\?/);
    expect(durationRefusalOf('')).toBeUndefined();
  });
});

describe('what the refusals prevent', () => {
  const actor = { name: 'did:ethr:0x2222222222222222222222222222222222222222', account: { homePage: 'https://bridge.example', name: 'did:ethr:0x2222222222222222222222222222222222222222' } };
  const session = (registration: string = randomUUID()) => ({
    registration, sessionId: registration, publisherId: 'did:web:bridge.example',
    auActivityId: 'https://bridge.example/course/golf', courseActivityId: 'https://bridge.example/course/golf',
  });
  const trace = (durationIso: string, registration?: string): Array<Record<string, unknown> & { id: string }> =>
    buildPassedSessionTrace({ actor, session: session(registration), scoreScaled: 0.9, masteryScore: 0.7, durationIso, moveOnRule: 'CompletedAndPassed' })
      .map(s => ({ ...(s as unknown as Record<string, unknown>), id: randomUUID() }));
  const verb = (s: Record<string, unknown>) => String((s.verb as { id?: string }).id).split(/[/#]/).pop();

  it("says what the LRS would refuse, as the LRS refuses it, without keeping anything", () => {
    for (const s of trace('PT25M')) {
      expect(internalRefusalOf(s)).toEqual([]);
      expect(storeStatementInternal(s, 'a-duration-is-refused')).toBe(s.id);
    }
    const bad = trace('25m');
    const refused = bad.filter(s => internalRefusalOf(s).length > 0);
    expect(refused.map(verb)).toEqual(['completed', 'passed', 'terminated']);
    for (const s of refused) {
      expect(internalRefusalOf(s)).toContain('result.duration must be an ISO 8601 duration');
      expect(storeStatementInternal(s, 'a-duration-is-refused')).toBeNull();
    }
    // An empty duration is none: the builder leaves it off, which is why the door gives the session its default.
    expect(trace('').every(s => internalRefusalOf(s).length === 0 && (s.result as { duration?: string } | undefined)?.duration === undefined)).toBe(true);
  });

  it('refuses a whole session for what the caller sent that is not a duration, too', () => {
    // A registration that is not a UUID makes every statement of the session one the LRS refuses.
    expect(trace('PT25M', 'not-a-uuid').every(s => internalRefusalOf(s).length > 0)).toBe(true);
  });

  it("keeps an external run's performance with its steps, where a bad duration cost it", () => {
    const run = (durationIso?: string) => ingestExternalRun({
      agentDid: actor.name, task: { name: 'Refund a disputed order' },
      outcome: { success: true, ...(durationIso !== undefined ? { durationIso } : {}) },
      toolCalls: [{ tool: 'lookup', objectName: 'the order' }],
    });
    const performedOf = (r: ReturnType<typeof run>) => r.statements[0] as Record<string, unknown>;
    expect(verb(performedOf(run('25m')))).toBe('performed');
    expect(internalRefusalOf(performedOf(run('25m')))).toContain('result.duration must be an ISO 8601 duration');
    expect(internalRefusalOf(performedOf(run('PT25M')))).toEqual([]);
    expect(internalRefusalOf(performedOf(run('')))).toEqual([]);
  });
});

describe('a course completion keeps its cmi5 session whole, or not at all', () => {
  const route = doors().find(d => d.name === '/agent/record-course-completion')!.body;

  it('checks the whole session by the LRS\'s own rule before keeping any of it, and refuses it as the caller\'s', () => {
    const keep = route.indexOf('const kept = await keepStatementsWhole(session, lensTenantFor(label));');
    expect(keep).toBeGreaterThan(-1);
    expect(route.slice(keep)).toMatch(/^const kept = [^\n]+\n\s+if \(kept\.status === 'refused'\) \{\s+res\.status\(400\)\.json\(\{ error: 'the completion was not recorded: the LRS would refuse part of its cmi5 session, so none of it was kept', violations: kept\.refusals\.slice\(0, 20\) \}\);\s+return;/);
    // Nothing is written by the route itself: keepStatementsWhole checks, then writes and awaits each.
    expect(route).not.toContain('storeStatementInternal(');
    expect(route).not.toContain('storeStatementDurably(');
  });

  it('composes and forwards only a session the store kept whole, and says passed only of a passed statement it kept', () => {
    const partial = route.indexOf("if (kept.status === 'partial') {");
    expect(partial).toBeGreaterThan(route.indexOf('const kept = await keepStatementsWhole('));
    expect(partial).toBeLessThan(route.indexOf('composeIntoSharedLattice('));
    expect(partial).toBeLessThan(route.indexOf('forwardToTargets('));
    expect(route.slice(partial)).toMatch(/^if \(kept\.status === 'partial'\) \{[\s\S]*?res\.status\(503\)\.json\(\{\s+ok: false,[\s\S]*?\}\);\s+return;\s+\}/);
    expect(route).not.toMatch(/\bpassed: true\s*[,}]/);   // as code; the comment quotes the old answer
    expect(route).toContain("passedKept: keptPart.some(s => verbOf(s) === 'passed')");
    expect(route).toContain("passed: session.some(s => verbOf(s) === 'passed'), statementCount: kept.keptIds.length");
  });
});
