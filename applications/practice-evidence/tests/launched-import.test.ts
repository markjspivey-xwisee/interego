/**
 * Taking an attempt from an LMS launch: the statements of one cmi5 registration, read from an LRS
 * through the learner's own signed read, become an attempt a reviewer can stand behind.
 *
 * Everything here is fictional. The LRS is a fetch double that answers one signed read; the
 * profile terms are made-up IRIs handed in as the launch vocabulary; the pod is in memory. No
 * network, no environment reads.
 */
import { describe, it, expect } from 'vitest';
import { importWallet, sha256, validateAgainstShape, type Wallet } from '@interego/core';
import { createPevHandlers, LAUNCHED_JUDGMENT_TEMPLATE_HASH, type PevDeps } from '../bridge/handlers.js';
import { operatorPodFetch, readHead } from '../bridge/pod-helpers.js';
import { demoKey, demoScenarioInput, inMemoryPod } from '../demo/run.js';
import { PEV_ACTION, readShapesTurtle, toolNameOf } from '../src/ontology.js';
import { coerceScenario, rubricHash, type ScenarioSpec } from '../src/practice.js';
import { didOf, recordGraphTurtle, signEnvelope, type AttemptBody } from '../src/records.js';
import {
  launchVocabularyProblems, readLaunchedCall, VERB_INITIALIZED, VERB_LAUNCHED, VERB_SCORED, VERB_TERMINATED, type LaunchVocabulary,
} from '../src/launched-import.js';
import { buildLaunchedStatements, launchedRefusals, VERB_COMPLETED, VERB_PASSED } from '../src/projections.js';

type Out = Record<string, unknown>;
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SLOW = 240_000;
const POD = 'https://pod.example.test/practice/';
const SECRET = 'operator-pod-write-secret-for-tests';
const T0 = Date.parse('2026-10-22T09:00:00.000Z');
const key = (name: string): string => `0x${sha256(`pev-launch-test-key:${name}`)}`;
const wallet = (name: string): Wallet => importWallet(key(name), 'human', name);
const W = { platform: importWallet(demoKey('platform'), 'agent', 'pev-platform'), admin: wallet('admin'), author: wallet('author'), ana: wallet('ana'), ben: wallet('ben'), lms: wallet('lms') };

const clock = { t: T0, now(): Date { this.t += 1000; return new Date(this.t); } };
let nonceN = 0;
const nonce = (): string => `launch-nonce-${String(++nonceN).padStart(10, '0')}`;
const pod = inMemoryPod();
const TRUSTED = { addresses: new Set([W.platform.address.toLowerCase()]) };

// ── A fictional profile's terms, and a fictional LMS ────────────────────────────────────────
const P = 'https://profiles.example/roleplay';
const VOCAB: LaunchVocabulary = {
  turnVerb: `${P}/verbs/took-turn`, counterpartLineExt: `${P}/extensions/customer-line`,
  criterionKeyExt: `${P}/extensions/criterion-key`, rubricExt: `${P}/extensions/rubric`,
};
const LMS = 'https://lms.example';
const AU = `${LMS}/courses/calls/au/1`;
const REG = '6f1c2f6e-3b1a-4c53-9d2e-0a4b7c9d1e2f';
const SESSION = 'b7e1a9c4-52d3-4f60-8a17-3c5d9e0f1a2b';
const SESSION_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';
const CMI5 = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';

const SPEC: ScenarioSpec = (() => {
  const c = coerceScenario(demoScenarioInput('missed-deadline', 1));
  if (!('value' in c)) throw new Error('fixture does not coerce');
  return c.value;
})();
const RUBRIC = rubricHash(SPEC.rubric);

let idN = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++idN).padStart(12, '0')}`;
const at = (s: number): string => new Date(T0 - 3_600_000 + s * 1000).toISOString();

interface Opt { actor?: string; registration?: string; session?: string; rubric?: string }
function stmt(verb: string, second: number, more: Out = {}, o: Opt = {}): Out {
  const { object: obj, result, contextExt, categories, ...rest } = more as { object?: Out; result?: Out; contextExt?: Out; categories?: string[] };
  return {
    id: uuid(), version: '2.0.0', timestamp: at(second),
    actor: { objectType: 'Agent', account: { homePage: LMS, name: o.actor ?? didOf(W.ana.address) } },
    verb: { id: verb },
    object: obj ?? { objectType: 'Activity', id: AU },
    ...(result ? { result } : {}),
    context: {
      registration: o.registration ?? REG,
      contextActivities: {
        grouping: [{ objectType: 'Activity', id: `${LMS}/courses/calls` }],
        category: [{ objectType: 'Activity', id: `${P}/v/3` }, ...(categories ?? []).map((id) => ({ objectType: 'Activity', id }))],
      },
      extensions: { [SESSION_EXT]: o.session ?? SESSION, [`${P}/extensions/scenario`]: 'https://scenarios.example/refund', ...(contextExt ?? {}) },
    },
    ...rest,
  };
}
const turn = (second: number, line: string, answer: string, o: Opt = {}): Out => stmt(VOCAB.turnVerb, second, {
  object: { objectType: 'Activity', id: `${AU}/turn/${second}`, definition: { extensions: { [VOCAB.counterpartLineExt]: line } } },
  result: { response: answer },
}, o);
const scored = (second: number, criterion: string, raw: number, o: Opt = {}, note?: string): Out => stmt(VERB_SCORED, second, {
  object: { objectType: 'Activity', id: `${AU}/criterion/${criterion}`, definition: { extensions: { [VOCAB.criterionKeyExt]: criterion } } },
  result: { score: { raw, min: 0, max: 100 }, ...(note !== undefined ? { response: note } : {}) },
  contextExt: { [VOCAB.rubricExt]: o.rubric ?? RUBRIC },
}, o);

/** One whole call: a session, two exchanges, a score for each of the three criteria, and the end. */
function call(o: Opt = {}): Out[] {
  return [
    stmt(VERB_INITIALIZED, 0, { categories: [CMI5], object: { objectType: 'Activity', id: AU, definition: { type: `${P}/activity-types/roleplay-scenario` } } }, o),
    turn(10, 'You wanted to see me? If this is about the report, I already know.', 'The quarterly report was due Thursday at noon and reached me on Friday afternoon.', o),
    turn(20, 'The finance feed was late twice this month.', 'What got in the way on your side, and what would help next time?', o),
    scored(30, 'specific-observation', 100, o, 'Named the report, Thursday noon and Friday afternoon at the first exchange.'),
    scored(31, 'asks-their-view', 50, o),
    scored(32, 'agrees-next-step', 100, o),
    stmt(VERB_TERMINATED, 40, { categories: [CMI5] }, o),
  ];
}
const LAUNCH_MODE_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/launchmode';
/** The LMS's own statement that it launched the unit, which says in which mode. */
const launchedBy = (mode: string, o: Opt = {}): Out => stmt(VERB_LAUNCHED, -1, { contextExt: { [LAUNCH_MODE_EXT]: mode } }, o);
const INPUT = { registration: REG, spec: SPEC, rubricHash: RUBRIC, vocabulary: VOCAB, endpoint: `${LMS}/xapi` };
const problemsOf = (statements: Out[]): readonly string[] => {
  const r = readLaunchedCall(statements, INPUT);
  return 'problems' in r ? r.problems : [];
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Reading a registration (pure)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('a registration read as a conversation', () => {
  it('gives the launch, the lines in order and the unit\'s score for each criterion', () => {
    const shuffled = [...call()].reverse();
    const r = readLaunchedCall(shuffled, INPUT);
    if (!('call' in r)) throw new Error(`not read: ${r.problems.join('; ')}`);
    const c = r.call;
    expect(c.launch).toMatchObject({
      registration: REG, sessionId: SESSION, activityId: AU, actor: { homePage: LMS, name: didOf(W.ana.address) }, endpoint: `${LMS}/xapi`, launchMode: 'Normal',
    });
    expect(c.launchModeFrom).toBe('assumed');
    expect(c.launch.activityDefinition).toEqual({ type: `${P}/activity-types/roleplay-scenario` });
    // What the unit put on its first statement is carried: its grouping, the profile category (not the cmi5 one), its extensions (not the session id).
    const template = c.launch.contextTemplate as { contextActivities: { grouping: unknown[]; category: { id: string }[] }; extensions: Out };
    expect(template.contextActivities.category.map((x) => x.id)).toEqual([`${P}/v/3`]);
    expect(template.contextActivities.grouping).toHaveLength(1);
    expect(template.extensions[SESSION_EXT]).toBeUndefined();
    expect(template.extensions[`${P}/extensions/scenario`]).toBe('https://scenarios.example/refund');
    expect(c.turns.map((t) => t.speaker)).toEqual(['counterpart', 'learner', 'counterpart', 'learner']);
    expect(c.turns[1]!.text).toContain('due Thursday at noon');
    expect(c.turns[0]!.statementId).toBe(c.turns[1]!.statementId);
    expect(c.scores.map((s) => [s.criterionId, s.levelId])).toEqual([['specific-observation', 'specific'], ['asks-their-view', 'late'], ['agrees-next-step', 'owner-and-date']]);
    expect(c.scores[0]!.note).toContain('Named the report');
    expect(c.statementIds).toHaveLength(7);
    expect(c.unitSent).toEqual([]);
    expect([c.startedAt, c.endedAt]).toEqual([at(0), at(40)]);
  });

  it('takes the launch mode and the masteryScore from the LMS\'s launched statement when the read returned it', () => {
    const launched = stmt(VERB_LAUNCHED, -1, { contextExt: { 'https://w3id.org/xapi/cmi5/context/extensions/launchmode': 'Review', 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore': 0.8 } });
    const r = readLaunchedCall([launched, ...call()], INPUT);
    if (!('call' in r)) throw new Error(r.problems.join('; '));
    expect([r.call.launch.launchMode, r.call.launchModeFrom, r.call.launch.masteryScore]).toEqual(['Review', 'launched-statement', 0.8]);
    // A launched statement for another session, or another unit, of the same registration says nothing about this conversation.
    const modeOf = (extra: Out[]): unknown[] => {
      const x = readLaunchedCall([...extra, ...call()], INPUT);
      if (!('call' in x)) throw new Error(x.problems.join('; '));
      return [x.call.launch.launchMode, x.call.launchModeFrom, x.call.launch.masteryScore];
    };
    const ext = (mode: unknown, mastery?: number): Out => ({ contextExt: { [LAUNCH_MODE_EXT]: mode, ...(mastery !== undefined ? { 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore': mastery } : {}) } });
    expect(modeOf([stmt(VERB_LAUNCHED, -1, ext('Normal', 0.9), { session: 'aaaaaaaa-0000-4000-8000-000000000001' })])).toEqual(['Normal', 'assumed', undefined]);
    expect(modeOf([stmt(VERB_LAUNCHED, -1, { ...ext('Normal', 0.9), object: { objectType: 'Activity', id: `${LMS}/courses/calls/au/2` } })])).toEqual(['Normal', 'assumed', undefined]);
    // Two for this session that disagree, or one that names no mode, leave it unknown too.
    expect(modeOf([launchedBy('Normal'), launchedBy('Review')])).toEqual(['Normal', 'assumed', undefined]);
    expect(modeOf([stmt(VERB_LAUNCHED, -1, ext('normal'))])).toEqual(['Normal', 'assumed', undefined]);
    // Two for this session that agree on Normal and disagree on the masteryScore: in either order the mode is not
    // known, so which came first cannot decide whether a result may be called passed.
    const m8 = stmt(VERB_LAUNCHED, -1, ext('Normal', 0.8));
    const m5 = stmt(VERB_LAUNCHED, -2, ext('Normal', 0.5));
    const none = stmt(VERB_LAUNCHED, -3, ext('Normal'));
    expect(modeOf([m8, m5])).toEqual(['Normal', 'assumed', undefined]);
    expect(modeOf([m5, m8])).toEqual(['Normal', 'assumed', undefined]);
    expect(modeOf([m8, none])).toEqual(['Normal', 'assumed', undefined]);
    // Two that agree on both are one piece of evidence said twice.
    expect(modeOf([m8, stmt(VERB_LAUNCHED, -4, ext('Normal', 0.8))])).toEqual(['Normal', 'launched-statement', 0.8]);
    expect(modeOf([launchedBy('Normal'), stmt(VERB_LAUNCHED, -2, ext('Review'), { session: 'aaaaaaaa-0000-4000-8000-000000000001' })])).toEqual(['Normal', 'launched-statement', undefined]);
  });

  it('says every reason a registration is not one whole conversation against the rubric', () => {
    expect(problemsOf([])).toEqual(['the LRS returned no statement for this registration']);
    expect(problemsOf(call().slice(1))).toEqual(['the registration has no initialized statement: no session was started']);
    expect(problemsOf(call().slice(0, -1))).toEqual(['the session of the conversation has no terminated statement: it is still open']);
    expect(problemsOf(call().filter((s) => (s['verb'] as Out)['id'] !== VOCAB.turnVerb))).toEqual(['the session has no exchange: there is nothing to review']);
    const c = call();
    expect(problemsOf(c.filter((_, i) => i !== 4))).toEqual(['criterion asks-their-view was not scored']);
    expect(problemsOf([...c, scored(33, 'asks-their-view', 0)])).toEqual(['criterion asks-their-view was scored 2 times']);
    expect(problemsOf([...c, scored(33, 'charm', 100)])).toEqual(['criteria scored that the rubric does not have: charm']);
    expect(problemsOf([...c.slice(0, 4), scored(31, 'asks-their-view', 75), ...c.slice(5)])).toEqual(['the score 75 for asks-their-view is not the value of exactly one level']);
    expect(problemsOf([...c.slice(0, 4), scored(31, 'asks-their-view', 50, { rubric: 'f'.repeat(64) }), ...c.slice(5)])[0]).toContain('do not name this scenario version\'s rubric');
    expect(problemsOf([...c, stmt(VERB_INITIALIZED, 50, {}, { registration: '11111111-1111-4111-8111-111111111111' })])[0]).toContain('belongs to another registration');
    expect(problemsOf([...c, turn(25, 'Extra.', 'From someone else.', { actor: didOf(W.ben.address) })])).toContain('the statements name more than one actor');
    const noAnswer = turn(15, 'A line.', 'x'); delete (noAnswer['result'] as Out)['response'];
    expect(problemsOf([...c, noAnswer])[0]).toContain('carries no answer from the learner in result.response');
    // A pass gate the unit closed itself leaves nothing for a review to decide.
    expect(problemsOf([...c.slice(0, -1), stmt(VERB_PASSED, 35, { categories: [CMI5] }), c[c.length - 1]!])[0]).toContain('the unit already sent passed');
    // Thirteen exchanges are over the scenario's limit of twelve.
    const long = [c[0]!, ...Array.from({ length: 13 }, (_, i) => turn(1 + i, `Line ${i}.`, `Answer ${i}.`)), ...c.slice(3)];
    expect(problemsOf(long)).toEqual(['the session has 13 exchanges, over the scenario\'s limit of 12']);
  });

  it('checks a launch vocabulary before a bridge starts with it', () => {
    expect(launchVocabularyProblems(VOCAB)).toEqual([]);
    expect(launchVocabularyProblems(null)).toEqual(['the launch vocabulary is not an object']);
    expect(launchVocabularyProblems({ ...VOCAB, turnVerb: 'took-turn' })).toEqual(['turnVerb must be an absolute IRI']);
    expect(launchVocabularyProblems({ turnVerb: VOCAB.turnVerb, extra: 1 })).toEqual([
      'counterpartLineExt must be an absolute IRI', 'criterionKeyExt must be an absolute IRI', 'rubricExt must be an absolute IRI', 'unknown keys: extra',
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The act
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** A stand-in for the LRS's signed-read route: it answers what the test put there, and keeps what it was sent. */
const lrs = {
  answer: (): { status: number; body: unknown } => ({ status: 200, body: { statements: [launchedBy('Normal'), ...call()] } }),
  seen: [] as { url: string; body: Out }[],
  fetchFn: (async (u: RequestInfo | URL, init?: RequestInit) => {
    lrs.seen.push({ url: String(u), body: JSON.parse(String(init?.body)) as Out });
    const a = lrs.answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch,
};

const base: PevDeps = {
  platformWallet: W.platform, platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address],
  fetchFn: operatorPodFetch(POD, SECRET, pod.fetchFn), holderFetchFn: pod.fetchFn, defaultPodUrl: POD,
  deploymentUrl: 'https://bridge.example.test', now: () => clock.now(), nonce,
};
const H = createPevHandlers({ ...base, launchImport: { readUrl: `${LMS}/agent/xapi-statements/read`, endpoint: `${LMS}/xapi`, vocabulary: VOCAB, fetchFn: lrs.fetchFn } }) as Handlers;
const unconfigured = createPevHandlers(base) as Handlers;

const actionOf = (tool: string): string => Object.values(PEV_ACTION).find((x) => toolNameOf(x) === tool)!;
async function act(h: Handlers, tool: string, w: Wallet, payload: Out = {}, extra: Out = {}): Promise<Out> {
  const envelope = await signEnvelope(w, { v: 1, action: actionOf(tool), issuedAt: new Date(clock.t).toISOString(), nonce: nonce(), podUrl: POD, ...payload });
  return (await h[tool]!({ envelope, ...extra })) as Out;
}
function ok(r: Out): Out {
  expect(r['kind'], `expected success, got ${JSON.stringify(r).slice(0, 700)}`).toBeUndefined();
  return r;
}
function refused(r: Out, status: number, code: string): Out {
  expect(r['kind'], `expected refusal ${status} ${code}, got ${JSON.stringify(r).slice(0, 500)}`).toBe('refusal');
  expect([r['iep:refusalStatus'], r['iep:refusalReason']]).toEqual([status, code]);
  return r;
}
/** The learner's own signed read, as the LRS's route takes it. Its signature is the LRS's to check, not this bridge's. */
const readOf = (registration: string, more: Out = {}): Out => ({
  lrs_read: { _signed_payload: JSON.stringify({ query: { registration, ...more }, timestamp: new Date(clock.t).toISOString() }), _signature: `0x${'ab'.repeat(65)}` },
});

describe('pev.import_launched_attempt', () => {
  const S: Record<string, string> = {};
  const pay = (over: Out = {}): Out => ({ scenarioIri: S['scenario'], scenarioVersion: 1, registration: REG, coached: false, ...over });

  it('sets up: an author publishes the scenario', async () => {
    ok(await act(H, 'pev.register_role', W.admin, { address: W.author.address, role: 'author', change: 'add' }));
    const p = ok(await act(H, 'pev.author_scenario', W.author, { scenario: demoScenarioInput('missed-deadline', 1), status: 'published', draftAssistance: { used: false } }));
    S['scenario'] = String(p['scenarioIri']);
    S['scenarioHash'] = String(p['scenarioHash']);
    expect(p['version']).toBe(1);
  }, SLOW);

  it('is refused where the bridge is not set up for it, and for each thing missing from the request', async () => {
    refused(await act(unconfigured, 'pev.import_launched_attempt', W.ana, pay(), readOf(REG)), 501, 'launch-import-not-configured');
    refused(await act(H, 'pev.import_launched_attempt', W.ana, pay({ coached: undefined }), readOf(REG)), 400, 'coached-undeclared');
    refused(await act(H, 'pev.import_launched_attempt', W.ana, pay({ registration: 'the-call-on-tuesday' }), readOf(REG)), 400, 'registration-not-a-uuid');
    refused(await act(H, 'pev.import_launched_attempt', W.ana, pay()), 400, 'lrs-read-missing');
    refused(await act(H, 'pev.import_launched_attempt', W.ana, pay(), readOf('11111111-1111-4111-8111-111111111111')), 400, 'lrs-read-other-registration');
    refused(await act(H, 'pev.import_launched_attempt', W.ana, pay(), readOf(REG, { cursor: 'page-2' })), 400, 'lrs-read-other-registration');
    refused(await act(H, 'pev.import_launched_attempt', W.ana, pay({ scenarioVersion: 2 }), readOf(REG)), 409, 'scenario-revised');
    refused(await act(H, 'pev.import_launched_attempt', W.ana, pay({ scenarioIri: `${S['scenario']}-other` }), readOf(REG)), 404, 'scenario-not-found');
    expect(lrs.seen).toEqual([]);
  }, SLOW);

  it('records nothing when the LRS refuses, answers something else, or holds more than one read', async () => {
    const before = pod.store.size;
    lrs.answer = () => ({ status: 401, body: { error: 'signature expired' } });
    expect(refused(await act(H, 'pev.import_launched_attempt', W.ana, pay(), readOf(REG)), 502, 'lrs-read-refused')['lrsStatus']).toBe(401);
    lrs.answer = () => ({ status: 200, body: { ok: true } });
    refused(await act(H, 'pev.import_launched_attempt', W.ana, pay(), readOf(REG)), 502, 'lrs-answer-unusable');
    lrs.answer = () => ({ status: 200, body: { statements: call(), more: '/xapi/statements?cursor=abc' } });
    refused(await act(H, 'pev.import_launched_attempt', W.ana, pay(), readOf(REG)), 409, 'registration-too-large');
    lrs.answer = () => ({ status: 200, body: { statements: call().slice(0, -1) } });
    const r = refused(await act(H, 'pev.import_launched_attempt', W.ana, pay(), readOf(REG)), 422, 'registration-not-a-conversation');
    expect(r['problems']).toEqual(['the session of the conversation has no terminated statement: it is still open']);
    // Ben signs, but the LRS answered with Ana's statements: a learner takes only their own conversation.
    lrs.answer = () => ({ status: 200, body: { statements: [launchedBy('Normal'), ...call()] } });
    refused(await act(H, 'pev.import_launched_attempt', W.ben, pay(), readOf(REG)), 403, 'not-your-registration');
    expect(pod.store.size).toBe(before);
    // The learner's signed read went to the configured route, unchanged, and nowhere else.
    expect(new Set(lrs.seen.map((x) => x.url))).toEqual(new Set([`${LMS}/agent/xapi-statements/read`]));
    expect(Object.keys(lrs.seen[0]!.body).sort()).toEqual(['_signature', '_signed_payload']);
  }, SLOW);

  it('writes the conversation as a judged attempt on the LMS\'s registration, with the unit\'s lines and scores as read', async () => {
    lrs.answer = () => ({ status: 200, body: { statements: [launchedBy('Normal'), ...call()] } });
    const r = ok(await act(H, 'pev.import_launched_attempt', W.ana, pay({ coached: true }), readOf(REG)));
    S['attempt'] = String(r['attemptIri']);
    expect(r).toMatchObject({
      state: 'judged', coached: true, registration: REG, lmsSessionId: SESSION, launchMode: 'Normal', launchModeFrom: 'launched-statement',
      turnsRead: 4, statementsRead: 8, counterpartControlledBy: 'assignable-unit', recorded: true,
    });
    expect((r['unitJudgment'] as Out)['route']).toBe('scripted');
    expect((r['taken'] as Out)['fromLrs']).toBe(`${LMS}/xapi`);

    const head = (await readHead(POD, S['attempt']!, TRUSTED, pod.fetchFn)).head!;
    const a = head.body as AttemptBody;
    expect(a.lmsLaunch).toMatchObject({ registration: REG, sessionId: SESSION, activityId: AU, launchMode: 'Normal', launchModeFrom: 'launched-statement', unitSent: [] });
    expect(a.lmsLaunch!.statementIds).toHaveLength(8);
    expect([a.startedAt, a.endedAt, a.endedBy]).toEqual([at(0), at(40), 'learner']);
    expect(a.turns.map((t) => [t.index, t.speaker, t.source])).toEqual([
      [0, 'counterpart', 'lrs-statement'], [1, 'learner', 'lrs-statement'], [2, 'counterpart', 'lrs-statement'], [3, 'learner', 'lrs-statement'],
    ]);
    expect(a.turns.every((t) => typeof t.statementId === 'string')).toBe(true);
    const j = a.judgments[0]!;
    expect(j).toMatchObject({
      route: 'scripted', chosenBy: 'learner', promptTemplateHash: LAUNCHED_JUDGMENT_TEMPLATE_HASH,
      judge: { id: `unit:${AU}`, kind: 'agent' }, disclosure: { provider: 'assignable-unit', model: AU, keySource: 'none' },
    });
    expect(j.criteria.map((c) => c.levelId)).toEqual(['specific', 'late', 'owner-and-date']);
    // The unit gave no quote, so every level above the lowest waits on a person.
    expect(j.unverifiedCriteria).toEqual(['specific-observation', 'asks-their-view', 'agrees-next-step']);
    // The learner's signed read is not kept: it is not in the record.
    expect(JSON.stringify(a)).not.toContain('_signed_payload');
    expect(validateAgainstShape(recordGraphTurtle(a), readShapesTurtle(), { entailment: 'rdfs' }).conforms).toBe(true);
    // Not reviewed yet, so nothing may be built for the unit to send.
    expect(launchedRefusals(a)).toEqual(['the attempt has no standing review']);
  }, SLOW);

  it('takes a registration once, whatever scenario it is taken against, and once when two imports race', async () => {
    const r = refused(await act(H, 'pev.import_launched_attempt', W.ana, pay(), readOf(REG)), 409, 'registration-already-imported');
    expect(r['attemptIri']).toBe(S['attempt']);
    // A second scenario with the same rubric: the same call cannot become a second attempt there.
    const twin = ok(await act(H, 'pev.author_scenario', W.author, {
      scenario: { ...demoScenarioInput('missed-deadline', 1), scenarioKey: 'missed-deadline-twin' }, status: 'published', draftAssistance: { used: false },
    }));
    S['twin'] = String(twin['scenarioIri']);
    const again = refused(await act(H, 'pev.import_launched_attempt', W.ana, pay({ scenarioIri: S['twin'] }), readOf(REG)), 409, 'registration-already-imported');
    expect(again['scenarioIri']).toBe(S['scenario']);
    // Two imports of one new registration at once, one against each scenario: exactly one is written.
    const REG2 = '7a2d3f7f-4c2b-4d64-8e3f-1b5c8d0e2f3a';
    const SESSION2 = 'd8f2b0d5-63e4-4a71-9b28-4d6e0f1a2b3c';
    lrs.answer = () => ({ status: 200, body: { statements: [launchedBy('Normal', { registration: REG2, session: SESSION2 }), ...call({ registration: REG2, session: SESSION2 })] } });
    const both = await Promise.all([
      act(H, 'pev.import_launched_attempt', W.ana, pay({ registration: REG2 }), readOf(REG2)),
      act(H, 'pev.import_launched_attempt', W.ana, pay({ registration: REG2, scenarioIri: S['twin'] }), readOf(REG2)),
    ]);
    expect(both.filter((x) => x['kind'] === undefined)).toHaveLength(1);
    refused(both.find((x) => x['kind'] !== undefined)!, 409, 'registration-already-imported');
  }, SLOW);

  it('builds nothing for the unit where the launch mode is only assumed', async () => {
    // Ben's own call, read from an LRS that returned no launched statement.
    const REG3 = '8b3e4a80-5d3c-4e75-9f40-2c6d9e1f3a4b';
    const SESSION3 = 'e9a3c1e6-74f5-4b82-8c39-5e7f1a2b3c4d';
    const ben = { actor: didOf(W.ben.address), registration: REG3, session: SESSION3 };
    lrs.answer = () => ({ status: 200, body: { statements: call(ben) } });
    const r = ok(await act(H, 'pev.import_launched_attempt', W.ben, pay({ registration: REG3 }), readOf(REG3)));
    expect(r['launchModeFrom']).toBe('assumed');
    const a = (await readHead(POD, String(r['attemptIri']), TRUSTED, pod.fetchFn)).head!.body as AttemptBody;
    // It can be reviewed like any attempt; what it cannot have is a cmi5 passed, failed or completed.
    expect(launchedRefusals(a)).toEqual([
      'the launch mode is not known: the LRS returned no launched statement from the LMS, and cmi5 allows passed, failed and completed only in a Normal launch',
      'the attempt has no standing review',
    ]);
  }, SLOW);

  it('lets a reviewer decide the levels, after which the statements for the unit can be built', async () => {
    ok(await act(H, 'pev.register_role', W.admin, { address: W.ben.address, role: 'reviewer', change: 'add' }));
    const seen = ok(await act(H, 'pev.get_attempt', W.ben, { attemptIri: S['attempt'] }));
    const levels = [['specific-observation', 'specific'], ['asks-their-view', 'late'], ['agrees-next-step', 'owner-and-date']]
      .map(([criterionId, levelId]) => ({ criterionId, levelId, why: 'Read against the two exchanges.' }));
    ok(await act(H, 'pev.override_attempt', W.ben, { attemptIri: S['attempt'], target: seen['currentTarget'], levels, sawJudgeLevelsFirst: true }));
    const head = (await readHead(POD, S['attempt']!, TRUSTED, pod.fetchFn)).head!;
    const a = head.body as AttemptBody;
    expect(launchedRefusals(a)).toEqual([]);
    const later = { sessionId: 'c0ffee00-1111-4222-8333-444455556666' };
    const out = buildLaunchedStatements({ attempt: a, headDescriptorUrl: head.descriptorUrl, homePage: 'https://bridge.example.test', ratifiedBy: didOf(W.ben.address) }, later);
    expect(out.map((s) => (s['verb'] as Out)['id'])).toEqual([VERB_PASSED, VERB_COMPLETED]);
    const ctx = out[0]!['context'] as { registration: string; contextActivities: { category: { id: string }[] }; extensions: Out };
    expect(ctx.registration).toBe(REG);
    expect(ctx.extensions[SESSION_EXT]).toBe(later.sessionId);
    // The profile category the unit used rides along with the two cmi5 ones.
    expect(ctx.contextActivities.category.map((c) => c.id)).toEqual([`${P}/v/3`, CMI5, 'https://w3id.org/xapi/cmi5/context/categories/moveon']);
    expect((out[0]!['actor'] as { account: Out }).account).toEqual({ homePage: LMS, name: didOf(W.ana.address) });
    // The activity keeps the definition the unit gave it, so a profile that selects on its type still matches.
    expect(out.map((x) => x['object'])).toEqual([0, 1].map(() => ({ objectType: 'Activity', id: AU, definition: { type: `${P}/activity-types/roleplay-scenario` } })));
  }, SLOW);
  it('hands the reviewed statements to the learner, fixed the first time, and to no one else', async () => {
    const A = 'c0ffee00-1111-4222-8333-444455556666';
    const B = 'c0ffee00-1111-4222-8333-777788889999';
    // A key reads a scored session's result only once an admin registered it.
    ok(await act(H, 'pev.register_role', W.admin, { address: W.ana.address, role: 'learner', change: 'add' }));
    // Reviewed, but the rubric is not ratified yet: nothing is handed out, and nothing is written.
    const before = pod.store.size;
    const early = await act(H, 'pev.launched_statements', W.ana, { attemptIri: S['attempt'], sessionId: A });
    expect([early['kind'], early['iep:refusalStatus']]).toEqual(['refusal', 409]);
    expect(pod.store.size).toBe(before);
    ok(await act(H, 'pev.ratify_scenario', W.ben, { scenarioIri: S['scenario'], version: 1, scenarioHash: S['scenarioHash'] }));
    // The reviewer is not the learner.
    refused(await act(H, 'pev.launched_statements', W.ben, { attemptIri: S['attempt'], sessionId: A }), 403, 'not-the-learner');
    refused(await act(H, 'pev.launched_statements', W.ana, { attemptIri: S['attempt'] }), 400, 'payload-shape');

    // The session has to be one the LMS opened for this unit and this learner, still open, with nothing sent yet.
    const ask = (sessionId: string, extra: Out = readOf(REG)): Promise<Out> => act(H, 'pev.launched_statements', W.ana, { attemptIri: S['attempt'], sessionId }, extra);
    const held = [launchedBy('Normal'), ...call()];
    const notOne = async (statements: Out[], sessionId: string): Promise<unknown> => {
      lrs.answer = () => ({ status: 200, body: { statements } });
      return refused(await ask(sessionId), 409, 'not-a-sending-session')['problems'];
    };
    const untouched = pod.store.size;
    refused(await ask(A, {}), 400, 'lrs-read-missing');
    expect((await notOne(held, A) as string[])[0]).toContain('holds no launched statement from the LMS for this unit and this session');
    expect(await notOne(held, 'a-session-typed-wrong')).toHaveLength(1);
    // The session of the conversation itself was launched, and has ended.
    expect(await notOne(held, SESSION)).toEqual(['the session has already ended: a statement cannot be sent in it']);
    expect(await notOne([...held, launchedBy('Review', { session: A })], A)).toEqual(['the session was not launched in Normal mode: cmi5 allows passed, failed and completed only in a Normal launch']);
    expect(await notOne([...held, launchedBy('Normal', { session: A, actor: didOf(W.ben.address) })], A)).toEqual(['the session was launched for another actor']);
    expect(await notOne([...held, stmt(VERB_LAUNCHED, 50, { contextExt: { [LAUNCH_MODE_EXT]: 'Normal' }, object: { objectType: 'Activity', id: `${LMS}/courses/calls/au/2` } }, { session: A })], A)).toHaveLength(1);
    expect(await notOne([...held, launchedBy('Normal', { session: A }), stmt(VERB_TERMINATED, 60, {}, { session: A })], A)).toEqual(['the session has already ended: a statement cannot be sent in it']);
    expect(await notOne([...held, launchedBy('Normal', { session: A }), stmt(VERB_COMPLETED, 60, {}, { session: A })], A)).toEqual(['the registration already holds a passed, failed or completed statement: cmi5 allows one of each']);
    expect(pod.store.size).toBe(untouched);

    lrs.answer = () => ({ status: 200, body: { statements: [...held, launchedBy('Normal', { session: A })] } });
    const first = ok(await ask(A));
    const statements = first['statements'] as Out[];
    expect(statements.map((x) => (x['verb'] as Out)['id'])).toEqual([VERB_PASSED, VERB_COMPLETED]);
    expect([first['again'], first['recorded'], first['sessionId'], first['usableInSession']]).toEqual([false, true, A, true]);
    expect((first['forUnit'] as Out)['registration']).toBe(REG);
    expect(((statements[0]!['context'] as { extensions: Out }).extensions)[SESSION_EXT]).toBe(A);

    // Asked again for another session: the same documents, byte for byte, and nothing new is written.
    const size = pod.store.size;
    // No read of the LRS is needed or made for what is already fixed.
    const reads = lrs.seen.length;
    const second = ok(await ask(B, {}));
    expect(second['statements']).toEqual(statements);
    expect([second['again'], second['recorded'], second['sessionId'], second['handedOutAt']]).toEqual([true, false, A, first['handedOutAt']]);
    // In another session they are a copy to compare with what the LRS holds, not something to send.
    expect([second['usableInSession'], second['usableOnlyIn']]).toEqual([false, A]);
    expect(String(second['sessionNote'])).toContain('not for sending');
    const third = ok(await ask(A, {}));
    expect([third['again'], third['usableInSession'], third['sessionNote']]).toEqual([true, true, undefined]);
    expect(third['statements']).toEqual(statements);
    expect(pod.store.size).toBe(size);
    expect(lrs.seen.length).toBe(reads);

    // What was handed out is on the attempt, which still conforms to the published shapes.
    const a = (await readHead(POD, S['attempt']!, TRUSTED, pod.fetchFn)).head!.body as AttemptBody;
    expect(a.lmsLaunch!.handedOut).toMatchObject({ sessionId: A, to: didOf(W.ana.address), at: first['handedOutAt'] });
    expect(a.lmsLaunch!.handedOut!.statements).toEqual(statements);
    expect(a.state).toBe('overridden');
    expect(validateAgainstShape(recordGraphTurtle(a), readShapesTurtle(), { entailment: 'rdfs' }).conforms).toBe(true);
  }, SLOW);

  it('hands out nothing for an attempt no LMS launched, or one whose launch mode was only assumed', async () => {
    const started = ok(await act(H, 'pev.start_attempt', W.ana, { scenarioIri: S['scenario'], scenarioVersion: 1, coached: false }));
    refused(await act(H, 'pev.launched_statements', W.ana, { attemptIri: started['attemptIri'], sessionId: 'any-session' }), 409, 'no-lms-launch');
  }, SLOW);
  it('lets the LMS that launched an attempt take its statements by registration, on its own word for the session', async () => {
    // Another call of Ana's, taken and reviewed.
    const REG4 = '9c4f5b91-6e4d-4f86-8a51-3d7e0f2a4b5c';
    const SESSION4 = 'f0b4d2f7-85a6-4c93-9d4a-6f8a2b3c4d5e';
    const o = { registration: REG4, session: SESSION4 };
    lrs.answer = () => ({ status: 200, body: { statements: [launchedBy('Normal', o), ...call(o)] } });
    const taken = ok(await act(H, 'pev.import_launched_attempt', W.ana, { scenarioIri: S['scenario'], scenarioVersion: 1, registration: REG4, coached: false }, readOf(REG4)));
    const seen = ok(await act(H, 'pev.get_attempt', W.ben, { attemptIri: taken['attemptIri'] }));
    const levels = [['specific-observation', 'specific'], ['asks-their-view', 'late'], ['agrees-next-step', 'owner-and-date']]
      .map(([criterionId, levelId]) => ({ criterionId, levelId, why: 'Read against the two exchanges.' }));
    ok(await act(H, 'pev.override_attempt', W.ben, { attemptIri: taken['attemptIri'], target: seen['currentTarget'], levels, sawJudgeLevelsFirst: true }));

    const NEXT = 'a1b2c3d4-0000-4000-8000-00000000abcd';
    // Asking by registration is the LMS's alone: a learner, a reviewer and a stranger are all refused the same way.
    for (const w of [W.ana, W.ben, W.author]) {
      refused(await act(H, 'pev.launched_statements', w, { registration: REG4, sessionId: NEXT }), 403, 'not-the-lms');
    }
    ok(await act(H, 'pev.register_role', W.admin, { address: W.lms.address, role: 'lms', change: 'add' }));
    refused(await act(H, 'pev.launched_statements', W.lms, { registration: 'not-a-registration', sessionId: NEXT }), 400, 'registration-not-a-uuid');
    refused(await act(H, 'pev.launched_statements', W.lms, { registration: '11111111-1111-4111-8111-111111111111', sessionId: NEXT }), 404, 'registration-not-taken');
    // A bridge that reads no LMS registers none to ask.
    refused(await act(unconfigured, 'pev.launched_statements', W.lms, { registration: REG4, sessionId: NEXT }), 501, 'launch-import-not-configured');

    // The LMS opened the session, so no read of the LRS is made: its signed word is recorded as its word.
    const reads = lrs.seen.length;
    const out = ok(await act(H, 'pev.launched_statements', W.lms, { registration: REG4, sessionId: NEXT }));
    expect(lrs.seen.length).toBe(reads);
    const statements = out['statements'] as Out[];
    expect(statements.map((x) => (x['verb'] as Out)['id'])).toEqual([VERB_PASSED, VERB_COMPLETED]);
    expect([out['attemptIri'], out['again'], out['usableInSession']]).toEqual([taken['attemptIri'], false, true]);
    expect((statements[0]!['context'] as { registration: string; extensions: Out }).registration).toBe(REG4);
    expect(((statements[0]!['context'] as { extensions: Out }).extensions)[SESSION_EXT]).toBe(NEXT);
    const a = (await readHead(POD, String(taken['attemptIri']), TRUSTED, pod.fetchFn)).head!.body as AttemptBody;
    expect(a.lmsLaunch!.handedOut).toMatchObject({ sessionId: NEXT, to: didOf(W.lms.address), sessionVouchedBy: 'lms' });
    expect(validateAgainstShape(recordGraphTurtle(a), readShapesTurtle(), { entailment: 'rdfs' }).conforms).toBe(true);

    // The learner asking afterwards gets the same documents; so does the LMS asking again.
    const mine = ok(await act(H, 'pev.launched_statements', W.ana, { attemptIri: taken['attemptIri'], sessionId: NEXT }));
    expect([mine['again'], mine['statements']]).toEqual([true, statements]);
    const again = ok(await act(H, 'pev.launched_statements', W.lms, { registration: REG4, sessionId: 'another-session' }));
    expect([again['again'], again['usableInSession'], again['statements']]).toEqual([true, false, statements]);
    // What the learner's own read vouched for stays recorded as that.
    const first = (await readHead(POD, S['attempt']!, TRUSTED, pod.fetchFn)).head!.body as AttemptBody;
    expect(first.lmsLaunch!.handedOut!.sessionVouchedBy).toBe('lrs-read');

    // The role is for this and nothing else: the LMS reviews nothing and reads no attempt.
    refused(await act(H, 'pev.override_attempt', W.lms, { attemptIri: S['attempt'], target: seen['currentTarget'], levels, sawJudgeLevelsFirst: true }), 403, 'not-a-reviewer');
  }, SLOW);
});
