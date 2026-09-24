/**
 * Credentials earned from evidence: mastery read from the learner's statements, the decision a
 * claim gets, where each assigned course stands, and the checks a verifier makes beyond the proof.
 */
import { describe, expect, it } from 'vitest';
import { aboutCourse, actorIdentifiers, claimDecision, courseStandings, credentialInForce, masteryEvidence, verifyCredentialChecks, type HeldCredential, type StatementRecord } from '../src/earned-credentials.js';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';

const ADL = 'http://adlnet.gov/expapi/verbs/';
const LEARNER = 'https://gate.example/u-eth-1/profile/card#me';
const COURSE = { courseId: 'golf-explained', courseIris: ['https://bridge.example/agent/scorm/course/golf-explained', 'https://pod.example/t/courses/golf-explained#package'], masteryScore: 0.7 };
const NOW = new Date('2026-09-24T12:00:00.000Z');

const stmt = (id: string, verb: string, object: string, extra: Record<string, unknown> = {}, actor: unknown = { account: { homePage: 'https://bridge.example', name: LEARNER } }): StatementRecord => ({
  id, voided: false,
  statement: { id, actor, verb: { id: verb }, object: { id: object, objectType: 'Activity' }, timestamp: '2026-09-20T10:00:00.000Z', ...extra },
});

describe('what counts as being about the course, and whose statement it is', () => {
  it('matches the course by any of its IRIs, under them, or as the parent or grouping', () => {
    expect(aboutCourse(stmt('a', `${ADL}completed`, COURSE.courseIris[0]!).statement, COURSE)).toBe(true);
    expect(aboutCourse(stmt('b', `${ADL}completed`, `${COURSE.courseIris[1]}`).statement, COURSE)).toBe(true);
    expect(aboutCourse(stmt('c', `${ADL}completed`, `${COURSE.courseIris[0]}/au/1`).statement, COURSE)).toBe(true);
    expect(aboutCourse(stmt('d', `${ADL}completed`, 'https://elsewhere.example/au', { context: { contextActivities: { parent: [{ id: COURSE.courseIris[0] }] } } }).statement, COURSE)).toBe(true);
    expect(aboutCourse(stmt('e', `${ADL}completed`, 'https://bridge.example/agent/scorm/course/golf-explained-2').statement, COURSE)).toBe(false);
  });
  it('reads every identifier an actor carries', () => {
    expect(actorIdentifiers({ mbox: 'mailto:a@b', account: { homePage: 'https://h', name: 'n' } })).toEqual(['mailto:a@b', 'https://h', 'n']);
    expect(actorIdentifiers('nope')).toEqual([]);
  });
});

describe('mastery evidence', () => {
  it('is a passed, completed, mastered, satisfied or waived statement with success not false and a score at the threshold', () => {
    const statements = [
      stmt('s1', `${ADL}launched`, COURSE.courseIris[0]!),
      stmt('s2', `${ADL}passed`, COURSE.courseIris[0]!, { result: { success: true, score: { scaled: 0.8 } } }),
      stmt('s3', `${ADL}completed`, COURSE.courseIris[0]!, { result: { success: false } }),
      stmt('s4', `${ADL}passed`, COURSE.courseIris[0]!, { result: { score: { scaled: 0.5 } } }),
      stmt('s5', 'https://w3id.org/xapi/adl/verbs/satisfied', COURSE.courseIris[0]!),
      stmt('s6', `${ADL}passed`, COURSE.courseIris[0]!, { result: { success: true } }, { account: { homePage: 'https://bridge.example', name: 'https://gate.example/u-eth-2/profile/card#me' } }),
    ];
    const ev = masteryEvidence(COURSE, statements, LEARNER);
    expect(ev.statements.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(ev.mastery.map((s) => s.id)).toEqual(['s2', 's5']);
    expect(ev.earned).toBe(true);
    expect(ev.statements[1]).toMatchObject({ scoreScaled: 0.8, success: true, mastery: true, timestamp: '2026-09-20T10:00:00.000Z' });
    expect(masteryEvidence(COURSE, [statements[0]!, statements[3]!], LEARNER).earned).toBe(false);
    expect(masteryEvidence(COURSE, [{ ...statements[1]!, voided: true }], LEARNER).statements).toEqual([]);
  });
  it('counts a mastery-shaped statement only when the attested rule says the bridge graded it', () => {
    const tagged = stmt('t1', `${ADL}passed`, COURSE.courseIris[0]!, { result: { success: true }, context: { extensions: { tag: 'ok' } } });
    const own = stmt('t2', `${ADL}passed`, COURSE.courseIris[0]!, { result: { success: true } });
    const attested = (st: Record<string, unknown>): boolean => ((st['context'] as { extensions?: { tag?: string } } | undefined)?.extensions?.tag === 'ok');
    const ev = masteryEvidence(COURSE, [tagged, own], LEARNER, attested);
    expect(ev.statements.map((e) => [e.id, e.graded, e.mastery])).toEqual([['t1', true, true], ['t2', false, false]]);
    expect(ev).toMatchObject({ unattested: 1, earned: true });
    const onlyOwn = claimDecision(masteryEvidence(COURSE, [own], LEARNER, attested), [], { achievementId: 'urn:a', validityDays: 1 }, NOW);
    expect(onlyOwn.decision === 'not-earned' ? onlyOwn.missing : '').toMatch(/1 mastery statement\(s\) about the course that this bridge did not grade/);
  });
  it('takes every statement when no learner is named, since a lens is already the subject\'s', () => {
    expect(masteryEvidence(COURSE, [stmt('x', `${ADL}completed`, COURSE.courseIris[0]!, {}, { mbox: 'mailto:someone@example' })]).earned).toBe(true);
  });
});

const held = (over: Partial<HeldCredential> = {}): HeldCredential => ({ id: 'urn:cred:1', descriptorUrl: 'https://pod.example/w/1.ttl', achievementId: 'urn:foxxi:achievement:t:golf-explained', issuer: 'did:key:z6MkTenant', validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', verified: true, ...over });

describe('a claim', () => {
  const policy = { achievementId: 'urn:foxxi:achievement:t:golf-explained', validityDays: 365 };
  const earned = masteryEvidence(COURSE, [stmt('s2', `${ADL}passed`, COURSE.courseIris[0]!, { result: { success: true } })], LEARNER);
  it('gets the credential already in force, else a new one for a year from its mastery evidence, else what is missing', () => {
    expect(claimDecision(earned, [held()], policy, NOW)).toMatchObject({ decision: 'already-held', credential: { id: 'urn:cred:1' } });
    const issue = claimDecision(earned, [held({ validUntil: '2026-09-01T00:00:00.000Z' }), held({ verified: false, id: 'urn:cred:2' }), held({ achievementId: 'urn:foxxi:achievement:t:other', id: 'urn:cred:3' })], policy, NOW);
    expect(issue).toMatchObject({ decision: 'issue', validUntil: '2027-09-24T12:00:00.000Z' });
    expect(issue.decision === 'issue' ? issue.evidence.map((e) => e.id) : []).toEqual(['s2']);
    const none = claimDecision(masteryEvidence(COURSE, [], LEARNER), [], policy, NOW);
    expect(none).toMatchObject({ decision: 'not-earned', statements: 0 });
    expect(none.decision === 'not-earned' ? none.missing : '').toMatch(/no statement of the learner about the course/);
    const some = claimDecision(masteryEvidence(COURSE, [stmt('s1', `${ADL}launched`, COURSE.courseIris[0]!)], LEARNER), [], policy, NOW);
    expect(some).toMatchObject({ decision: 'not-earned', statements: 1 });
  });
  it('a held credential is in force only when its proof verified and it has not expired', () => {
    expect(credentialInForce(held(), NOW)).toBe(true);
    expect(credentialInForce(held({ verified: false }), NOW)).toBe(false);
    expect(credentialInForce(held({ validUntil: '2026-09-24T11:59:59.000Z' }), NOW)).toBe(false);
    expect(credentialInForce(held({ validUntil: undefined }), NOW)).toBe(true);
  });
});

describe('where every assigned course stands', () => {
  it('is credentialed, claimable, in progress or not started, the claimable first, with a lapsed credential named', () => {
    const enrollments = [
      { courseId: 'done', courseTitle: 'Done', dueAt: '2026-10-01T00:00:00.000Z' },
      { courseId: 'golf-explained', courseTitle: 'Golf', dueAt: '2026-10-02T00:00:00.000Z' },
      { courseId: 'started', courseTitle: 'Started', dueAt: '2026-10-03T00:00:00.000Z' },
      { courseId: 'fresh', courseTitle: 'Fresh' },
    ];
    const evidence = new Map([
      ['golf-explained', masteryEvidence(COURSE, [stmt('s2', `${ADL}passed`, COURSE.courseIris[0]!, { result: { success: true } })], LEARNER)],
      ['started', masteryEvidence({ courseId: 'started', courseIris: ['https://c/started'] }, [stmt('s7', `${ADL}launched`, 'https://c/started')], LEARNER)],
    ]);
    const creds = [held({ achievementId: 'urn:a:done' }), held({ id: 'urn:cred:old', achievementId: 'urn:a:golf-explained', validUntil: '2026-01-01T00:00:00.000Z' })];
    const standings = courseStandings(enrollments, evidence, creds, (id) => `urn:a:${id}`, NOW);
    expect(standings.map((s) => [s.courseId, s.state])).toEqual([['golf-explained', 'claimable'], ['started', 'in-progress'], ['fresh', 'not-started'], ['done', 'credentialed']]);
    expect(standings[0]).toMatchObject({ lapsed: { id: 'urn:cred:old' }, statements: 1, mastery: 1 });
    expect(standings[3]).toMatchObject({ credential: { id: 'urn:cred:1' }, statements: 0 });
  });
});

describe('verifying a credential', () => {
  const credential = { issuer: 'did:key:z6MkTenant', validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', credentialSubject: { id: LEARNER, achievement: { id: 'urn:a:golf', name: 'Golf' } } };
  const good = { verified: true, issuerDid: 'did:key:z6MkTenant' };
  it('passes when the proof verifies, the window holds, the issuer is trusted and a subject is named', () => {
    const v = verifyCredentialChecks(credential, good, ['did:key:z6MkTenant'], NOW);
    expect(v).toMatchObject({ valid: true, issuer: 'did:key:z6MkTenant', subject: LEARNER, achievement: { id: 'urn:a:golf', name: 'Golf' }, notes: [] });
    expect(v.checks).toEqual({ signature: true, notExpired: true, inForce: true, issuerTrusted: true, subjectBound: true });
  });
  it('names each failed check in words', () => {
    expect(verifyCredentialChecks(credential, { verified: false, reason: 'bad signature bytes' }, ['did:key:z6MkTenant'], NOW)).toMatchObject({ valid: false, checks: { signature: false }, notes: ['the proof did not verify: bad signature bytes'] });
    expect(verifyCredentialChecks(credential, { verified: true, issuerDid: 'did:key:z6MkOther' }, ['did:key:z6MkTenant'], NOW).notes[0]).toMatch(/made by did:key:z6MkOther, not the stated issuer/);
    expect(verifyCredentialChecks({ ...credential, validUntil: '2026-09-01T00:00:00.000Z' }, good, ['did:key:z6MkTenant'], NOW)).toMatchObject({ valid: false, checks: { notExpired: false } });
    expect(verifyCredentialChecks({ ...credential, validFrom: '2026-12-01T00:00:00.000Z' }, good, ['did:key:z6MkTenant'], NOW)).toMatchObject({ valid: false, checks: { inForce: false } });
    expect(verifyCredentialChecks(credential, good, [], NOW)).toMatchObject({ valid: false, checks: { issuerTrusted: false } });
    expect(verifyCredentialChecks({ ...credential, credentialSubject: {} }, good, ['did:key:z6MkTenant'], NOW)).toMatchObject({ valid: false, checks: { subjectBound: false } });
    expect(verifyCredentialChecks({ ...credential, issuer: { id: 'did:key:z6MkTenant' } }, good, ['did:key:z6MkTenant'], NOW).valid).toBe(true);
  });
});

describe('the affordances', () => {
  it('are on the learner surface, disjoint from the admin surface, and say what they return', () => {
    const names = ['foxxi.earned_credentials', 'foxxi.claim_credential', 'foxxi.verify_credential'];
    for (const n of names) {
      const a = foxxiAffordances.find((x) => x.toolName === n);
      expect(a, n).toBeDefined();
      expect(a?.outputs?.properties, n).toBeDefined();
      expect(foxxiAdminAffordances.some((x) => x.toolName === n)).toBe(false);
    }
    expect(foxxiAffordances.find((x) => x.toolName === 'foxxi.claim_credential')?.inputs.find((i) => i.name === 'course_id')?.required).toBe(true);
    expect(foxxiAffordances.find((x) => x.toolName === 'foxxi.verify_credential')?.inputs).toEqual([expect.objectContaining({ name: 'credential', type: 'object', required: true })]);
  });
});
