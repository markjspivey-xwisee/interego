/**
 * A learner record read only in part is not classified, or served, for anyone but its subject.
 *
 * ★ WHY. Whether a record is private (a person's) or public (an agent's) is decided from all of its
 * own work, and the gates that decide it read the record from three places, two of them
 * best-effort. During a pod outage, a person's record whose person-kind work lived only on the pod
 * read as all agent's work, was classified public, and was served to any signed caller: fail-open.
 * Each gate now asks whether it read the record whole, and refuses anyone it would have to
 * classify the record for while it did not, as a 503 that says so (src/whole-record-gate.ts says
 * why a refusal and not a private classification). The subject's own reads are served as before.
 *
 * The readers' own completeness is exercised against a stand-in pod in
 * a-record-read-in-part-is-not-read-whole.test.ts; this file is the gates' use of it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { recordNotReadWhole, servedInPart } from '../src/whole-record-gate.js';

const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');

/** Each MCP handler and each HTTP route of the bridge, with its body up to its own closing. */
function doors(): Array<{ name: string; body: string }> {
  return [...server.matchAll(/^ {2}'(foxxi\.[a-z_0-9]+)': async \(|^app\.(?:get|post|put|patch|delete)\('([^']+)'/gm)].map(m => {
    const at = m.index!;
    const name = (m[1] ?? m[2])!;
    if (m[1]) {
      const end = server.indexOf('\n  },\n', at);
      return { name, body: server.slice(at, end < 0 ? server.length : end + 5) };
    }
    const next = server.slice(at + 1).search(/\n(?=[^\s}])/);
    return { name, body: server.slice(at, next < 0 ? server.length : at + 1 + next + 1) };
  });
}

/** The privacy gates: every door that decides what kind of subject a record belongs to. */
const gates = () => doors().filter(d => d.body.includes('const subjectKind = classifySubjectKind('));

describe('whether a record read in part may be served', () => {
  it('is served to its subject, and to a reader the gate lets read it whatever it is, and to no one else', () => {
    expect(servedInPart({ isSelf: true, unconditional: false })).toBe(true);
    expect(servedInPart({ isSelf: false, unconditional: true })).toBe(true);
    expect(servedInPart({ isSelf: true, unconditional: true })).toBe(true);
    expect(servedInPart({ isSelf: false, unconditional: false })).toBe(false);
  });

  it('is refused as a 503 that says the record could not be read whole, and not as a private record', () => {
    const refusal = recordNotReadWhole();
    expect(refusal).toMatchObject({ kind: 'refusal', 'iep:refusalStatus': 503 });
    expect(refusal['iep:refusalReason']).toBe('the record could not be read whole, so whether it is private cannot be told');
    expect(refusal.error).toContain('Nothing was served.');
    expect(JSON.stringify(refusal)).not.toMatch(/human|private record|is private;/);
    // A fresh answer each time: a gate adding to one cannot change the next.
    expect(recordNotReadWhole()).not.toBe(refusal);
    expect(recordNotReadWhole()).toEqual(refusal);
  });
});

describe('every privacy gate', () => {
  it('is found: the three doors that classify a subject', () => {
    expect(gates().map(g => g.name).sort()).toEqual(['/agent/review-record', '/agent/verify-extension', 'foxxi.assemble_learner_record'].sort());
  });

  it('reads whether the record was read whole, and refuses a reader who is not its subject before it classifies or serves anything', () => {
    for (const { name, body } of gates()) {
      expect(body, `${name} reads the durable records without asking whether it read them all`).toContain('const durable = await readDurableRecordedStatementsDetailed({ podUrl: subjectPodUrl });');
      expect(body, `${name} still reads the durable records the old way`).not.toContain('await readDurableRecordedStatements({');
      const refusal = body.search(/if \(!\(durable\.complete && latticeReadWhole\(subjectLabel\)\) && !servedInPart\(\{ isSelf, unconditional: [^}]+\}\)\) \{/);
      expect(refusal, `${name} classifies a record it may have read only in part`).toBeGreaterThan(-1);
      expect(refusal).toBeGreaterThan(body.indexOf('await ensureResident('));
      // Nothing of the record is used before the refusal: the classification comes first in every
      // gate, and a gate that assembles the record assembles it after that.
      expect(refusal, `${name} classifies before it refuses`).toBeLessThan(body.indexOf('const subjectKind = classifySubjectKind('));
      const assembles = body.indexOf('assembleEnterpriseLearnerRecord(');
      if (assembles >= 0) expect(refusal, `${name} assembles before it refuses`).toBeLessThan(assembles);
      expect(body.slice(refusal)).toMatch(/^[^\n]+\n\s+(?:res\.status\(503\)\.json\(recordNotReadWhole\(\)\);\s+return;|const trace = emitAccessDecision\(\{ ctx, tool: 'foxxi\.assemble_learner_record', decision: 'deny', appliedPolicies: \['record-read-whole'\] \}\);\s+return \{ \.\.\.recordNotReadWhole\(\), accessDecision: trace \};)/);
    }
  });

  it('lets only the reader it already lets read any record read one in part: the subject everywhere, an admin where the gate has one', () => {
    const unconditional = Object.fromEntries(gates().map(g => [g.name, /!servedInPart\(\{ isSelf, unconditional: ([^}]+) \}\)/.exec(g.body)?.[1]]));
    expect(unconditional).toEqual({
      'foxxi.assemble_learner_record': "ctx.role === 'admin'",
      '/agent/review-record': 'false',
      '/agent/verify-extension': 'false',
    });
    // Each matches the gate's own rule for who may read a person's record.
    expect(gates().find(g => g.name === 'foxxi.assemble_learner_record')!.body).toContain("if (subjectKind === 'human' && ctx.role !== 'admin' && !isSelf) {");
    for (const name of ['/agent/review-record', '/agent/verify-extension']) {
      expect(gates().find(g => g.name === name)!.body).toContain("if (subjectKind === 'human' && !isSelf) {");
    }
  });

  it('decides who may read a record from the whole of it, whatever source it is served from', () => {
    const review = gates().find(g => g.name === '/agent/review-record')!.body;
    expect(review).toContain('const wholeRecord = mergeStatementsById([...latticeStmts, ...lensStatements], durable.statements, appliedVoidsOf(subjectLabel));');
    expect(review).toMatch(/const statements = p\.source === 'pgsl'\s+\? mergeStatementsById\(latticeStmts, \[\], appliedVoidsOf\(subjectLabel\)\)\s+: wholeRecord;/);
    expect(review).toContain('const subjectKind = classifySubjectKind({ isSelf, statements: wholeRecord, subjectPodUrl, actorKindHint: p.actor_kind });');
  });
});
