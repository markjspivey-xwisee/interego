/**
 * The practice-evidence handlers end to end, driven the way a client drives them: every act is an
 * envelope signed by a generated wallet, every record lands on an in-memory pod and is read back
 * from it. One timeline, in order: roles → scenarios → drafting → ratification → conversation →
 * judging → review → contest and withdrawal → projection → the learner's copies → redaction →
 * queue, calibration, results → plumbing. Each refusal the spec names is provoked and its status
 * and code asserted.
 *
 * No network: pods are reserved `.test` hosts served by the double; model calls go to scripted
 * fixtures or a fetch double. No environment reads.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  canonicalGraphDigest, ContextDescriptor, deriveEncryptionKeyPair, importWallet, makeWalletDelegationVerifier, sha256, validateAgainstShape,
  verifySignedAuthorship, type IRI, type Wallet,
} from '@interego/core';
import { digestedGraphRegion, discover, parseAuthorshipProofFromDescriptorTurtle } from '@interego/solid';
import { createPevHandlers, describeStartup, type PevDeps } from '../bridge/handlers.js';
import {
  cappedFetch, isDeleted, isTrusted, operatorPodFetch, publishPevRecord, readChain, readHead, readRecord, readRoleRegistry, RecordNotSealable, RecordSealed,
  RecordUnreadable, PEV_COPIES_CONTAINER, PEV_RECORDS_CONTAINER,
} from '../bridge/pod-helpers.js';
import { DEMO_LINES, FABRICATED_QUOTE, demoKey, demoScenarioInput, graphUrlOf, inMemoryPod, operatorPlaintext, scriptedPracticeModel } from '../demo/run.js';
import { PEV_ACTION, readShapesTurtle, toolNameOf } from '../src/ontology.js';
import { scriptedTextModel, TextModelCallFailed, type TextModel, type TextModelRequest, type TextModelResult } from '../src/model.js';
import {
  assess, coerceScenario, creditedLevels, COUNTERPART_PROMPT_TEMPLATE_HASH, JUDGE_PROMPT_TEMPLATE_HASH,
  type JudgmentResult, type ScenarioSpec,
} from '../src/practice.js';
import { attemptIriSecret, attemptKey, modelAgentIri, recordLocal, registryIri, signEnvelope, signedRequestEnvelope } from '../src/records.js';
import { CMI5_CATEGORY_PREFIX, statementProblems, VERB_COMPLETED } from '../src/projections.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The world
// ═════════════════════════════════════════════════════════════════════════════════════════════

type Out = Record<string, unknown>;
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SLOW = 240_000;
const POD = 'https://pod.example.test/practice/';
const OTHER_POD = 'https://other-pod.example.test/practice/';
const LEARNER_POD = 'https://learner-pod.example.test/ana/';
const SECRET = 'operator-pod-write-secret-for-tests';
const BYOK_KEY = 'sk-byok-test-0123456789-SECRET';
const T0 = Date.parse('2026-10-22T09:00:00.000Z');

const key = (name: string): string => `0x${sha256(`pev-test-key:${name}`)}`;
const wallet = (name: string, type: 'human' | 'agent' = 'human'): Wallet => importWallet(key(name), type, name);
const W = {
  platform: importWallet(demoKey('platform'), 'agent', 'pev-platform'),
  admin: wallet('admin'), author: wallet('author'), coAuthor: wallet('co-author'),
  reviewer: wallet('reviewer'), reviewer2: wallet('reviewer-2'), reviewer3: wallet('reviewer-3'),
  ana: wallet('ana'), ben: wallet('ben'), stranger: wallet('stranger'),
  judgeAgent: wallet('judge-agent', 'agent'), judgePerson: wallet('judge-person'),
  agentReviewer: wallet('agent-reviewer', 'agent'), agentLearner: wallet('agent-learner', 'agent'), lateReviewer: wallet('late-reviewer'),
  newcomer: wallet('newcomer'), mallory: wallet('mallory'),
};
const TRUSTED = { addresses: new Set([W.platform.address.toLowerCase()]) };

const clock = { t: T0, now(): Date { this.t += 1000; return new Date(this.t); } };
let nonceN = 0;
const nonce = (): string => `test-nonce-${String(++nonceN).padStart(10, '0')}`;

const pod = inMemoryPod();

/** A model provider double speaking the Anthropic Messages shape, for per-request keys. */
function fakeProvider(): { fetchImpl: typeof fetch; keysSeen: string[] } {
  const keysSeen: string[] = [];
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    keysSeen.push(new Headers(init?.headers).get('x-api-key') ?? '');
    const body = JSON.parse(String(init?.body ?? '{}')) as { system?: string; messages?: { role: string; content: string }[] };
    const user = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    let text = 'I hear you, but the date stays.';
    if ((body.system ?? '').startsWith('You assess')) {
      const rubricJson = user.slice(user.indexOf('\n') + 1, user.indexOf('\n\nThe transcript:'));
      const rubric = JSON.parse(rubricJson) as { criteria: { criterionId: string; levels: { id: string }[] }[] };
      text = JSON.stringify({ criteria: rubric.criteria.map((c) => ({ criterionId: c.criterionId, level: c.levels[0]?.id, quotes: [], rationale: 'Lowest level: no quote supports more.' })) });
    }
    return new Response(JSON.stringify({ model: 'claude-test-returned', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 9 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, keysSeen };
}
const byok = fakeProvider();

const base: PevDeps = {
  platformWallet: W.platform, platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address],
  fetchFn: operatorPodFetch(POD, SECRET, pod.fetchFn), holderFetchFn: pod.fetchFn, defaultPodUrl: POD,
  deploymentUrl: 'https://bridge.example.test', byokFetch: byok.fetchImpl, now: () => clock.now(), nonce,
};
const make = (over: Partial<PevDeps> = {}): Handlers => createPevHandlers({ ...base, ...over }) as Handlers;
const H = make({ model: scriptedPracticeModel() });
const noModel = make();

const actionOf = (tool: string): string => {
  const a = Object.values(PEV_ACTION).find((x) => toolNameOf(x) === tool);
  if (!a) throw new Error(`no action for ${tool}`);
  return a;
};

async function envelopeFor(w: Wallet, tool: string, payload: Out = {}, o: { issuedAt?: string; pod?: string } = {}): Promise<{ payload: Out; signature: string }> {
  return signEnvelope(w, {
    v: 1, action: actionOf(tool), issuedAt: o.issuedAt ?? new Date(clock.t).toISOString(), nonce: nonce(), podUrl: o.pod ?? POD, ...payload,
  });
}

async function act(h: Handlers, tool: string, w: Wallet, payload: Out = {}, extra: Out = {}, o: { issuedAt?: string; pod?: string } = {}): Promise<Out> {
  return (await h[tool]!({ envelope: await envelopeFor(w, tool, payload, o), ...extra })) as Out;
}

function ok(r: Out): Out {
  expect(r['kind'], `expected success, got ${JSON.stringify(r).slice(0, 600)}`).toBeUndefined();
  return r;
}

function refused(r: Out, status: number, code: string): Out {
  expect(r['kind'], `expected refusal ${status} ${code}, got ${JSON.stringify(r).slice(0, 400)}`).toBe('refusal');
  expect([r['iep:refusalStatus'], r['iep:refusalReason']]).toEqual([status, code]);
  return r;
}

const snapshot = (): string => JSON.stringify([...pod.store].filter(([u]) => u.startsWith(POD)).sort());
const descriptorOf = (url: string): string => pod.store.get(url) ?? '';

function specOf(input: unknown): ScenarioSpec {
  const c = coerceScenario(input);
  if (!('value' in c)) throw new Error('fixture does not coerce');
  return c.value;
}

/** The record graph region a descriptor's proof covers, from the stored bytes. */
function regionOf(descriptorUrl: string): string {
  const d = descriptorOf(descriptorUrl);
  const graphUrl = descriptorUrl.replace(/\.ttl$/, '-graph.trig');
  const region = digestedGraphRegion({ descriptorTurtle: d, graphContent: pod.store.get(graphUrl) ?? null });
  if (!region.ok) throw new Error(`no region for ${descriptorUrl}`);
  return region.turtle;
}

/** Lines only these attempts use, so a redaction check can look for Ana's first attempt's lines alone. */
const LINE = {
  b1: 'Thanks for coming in, Sam. The quarterly report was due Thursday at noon.',
  oneTurn: 'The report was due on Thursday at noon and came on Friday; can we talk?',
  authorTest: 'Trying my own scenario: the report was late, so what happened?',
};

const levels = (pairs: readonly (readonly [string, string, string?])[]): Out[] =>
  pairs.map(([criterionId, levelId, why]) => ({ criterionId, levelId, ...(why !== undefined ? { why } : {}) }));

// Shared ids, filled as the story goes.
const S: Record<string, string> = {};
const R: Record<string, Out> = {};

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Roles
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('roles are changed by an admin envelope and kept as a signed registry record', () => {
  it('refuses with 503 when no admin is configured, and 403 for a non-admin', async () => {
    const none = make({ adminAddresses: [] });
    refused(await act(none, 'pev.register_role', W.admin, { address: W.author.address, role: 'author', change: 'add' }), 503, 'no-admin-configured');
    refused(await act(H, 'pev.register_role', W.stranger, { address: W.stranger.address, role: 'reviewer', change: 'add' }), 403, 'not-an-admin');
    refused(await act(H, 'pev.register_role', W.admin, { address: '0x123', role: 'author', change: 'add' }), 400, 'address-format');
    refused(await act(H, 'pev.register_role', W.admin, { address: W.author.address, role: 'boss', change: 'add' }), 400, 'role-unknown');
    refused(await act(H, 'pev.register_role', W.admin, { address: W.author.address, role: 'author', change: 'grant' }), 400, 'change-unknown');
    refused((await H['pev.register_role']!({})) as Out, 401, 'envelope-missing');
  }, SLOW);

  it('adds roles (one through the signed-request envelope form), with a shape-valid, platform-bound registry record', async () => {
    const grants: [Wallet, string][] = [
      [W.author, 'author'], [W.coAuthor, 'author'], [W.coAuthor, 'reviewer'], [W.reviewer, 'reviewer'], [W.reviewer2, 'reviewer'],
      [W.reviewer3, 'reviewer'], [W.judgeAgent, 'judge'], [W.judgeAgent, 'agent'], [W.judgePerson, 'judge'], [W.judgePerson, 'reviewer'],
      [W.agentReviewer, 'reviewer'], [W.agentReviewer, 'agent'], [W.agentLearner, 'agent'],
    ];
    const formB = await signedRequestEnvelope(W.admin, {
      v: 1, action: PEV_ACTION.registerRole, timestamp: new Date(clock.t).toISOString(), nonce: nonce(), pod_url: POD,
      address: W.author.address, role: 'author', change: 'add',
    });
    const first = ok((await H['pev.register_role']!({ ...formB })) as Out);
    expect(first['changed']).toBe(true);
    for (const [w, role] of grants.slice(1)) ok(await act(H, 'pev.register_role', W.admin, { address: w.address, role, change: 'add' }));
    const last = ok(await act(H, 'pev.register_role', W.admin, { address: W.ben.address, role: 'reviewer', change: 'add' }));
    const entries = last['entries'] as { address: string; roles: string[] }[];
    expect(entries.find((e) => e.address === W.judgeAgent.address)?.roles).toEqual(['judge', 'agent']);
    const rec = await readRecord(String(last['descriptorUrl']), TRUSTED, pod.fetchFn);
    expect(isTrusted(rec)).toBe(true);
    expect(rec.authorship.contentBinding).toBe('bound');
    expect(validateAgainstShape(rec.regionTurtle, readShapesTurtle(), { entailment: 'rdfs' }).conforms).toBe(true);
    S['registry'] = String(last['registryIri']);
  }, SLOW);

  it('re-adding a held role changes nothing and writes nothing', async () => {
    const before = snapshot();
    const r = ok(await act(H, 'pev.register_role', W.admin, { address: W.reviewer.address, role: 'reviewer', change: 'add' }));
    expect(r['changed']).toBe(false);
    expect(r).not.toHaveProperty('recorded');
    expect(snapshot()).toBe(before);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Scenarios
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('authoring: evidence-first declarations, versions, ratification, drafting', () => {
  const md1 = demoScenarioInput('missed-deadline', 1);
  const md2 = demoScenarioInput('missed-deadline', 2);
  const none = { draftAssistance: { used: false } };

  it('refuses a non-author and every undeclared choice, each with its own code', async () => {
    refused(await act(H, 'pev.author_scenario', W.ana, { scenario: md1, status: 'draft', ...none }), 403, 'not-an-author');
    refused(await act(H, 'pev.author_scenario', W.author, { scenario: md1, ...none }), 400, 'status-undeclared');
    const { assessmentUse: _u, ...noUse } = md1;
    const r = refused(await act(H, 'pev.author_scenario', W.author, { scenario: noUse, status: 'draft', ...none }), 400, 'assessment-use-undeclared');
    expect(Array.isArray(r['problems'])).toBe(true);
    const { workRegime: _w, ...noRead } = md1;
    refused(await act(H, 'pev.author_scenario', W.author, { scenario: noRead, status: 'draft', ...none }), 400, 'work-read-undeclared');
    refused(await act(H, 'pev.author_scenario', W.author, { scenario: { ...md1, workRegime: 'emergent' }, status: 'draft', ...none }), 400, 'pass-gate-needs-knowable-work');
    refused(await act(H, 'pev.author_scenario', W.author, { scenario: { ...md1, title: '' }, status: 'draft', ...none }), 400, 'scenario-shape');
    refused(await act(H, 'pev.author_scenario', W.author, { scenario: md1, status: 'draft' }), 400, 'draft-assistance-undeclared');
    refused(await act(H, 'pev.author_scenario', W.author, { scenario: md1, status: 'draft', ...none, draftReceipt: { payload: {}, signature: '0x' } }), 400, 'draft-assistance-twice');
  }, SLOW);

  it('saves a draft, publishes the same version, then a content change is a new version that supersedes it', async () => {
    const d1 = ok(await act(H, 'pev.author_scenario', W.author, { scenario: md1, status: 'draft', ...none }));
    expect([d1['version'], d1['status'], d1['modalStatus']]).toEqual([1, 'draft', 'Hypothetical']);
    S['md'] = String(d1['scenarioIri']);
    refused(await act(H, 'pev.author_scenario', W.author, { scenario: md1, status: 'published', basedOnVersion: 7, ...none }), 409, 'scenario-changed');
    const p1 = ok(await act(H, 'pev.author_scenario', W.author, { scenario: md1, status: 'published', basedOnVersion: 1, ...none }));
    expect([p1['version'], p1['status'], p1['statusChanged'], p1['rubricChanged']]).toEqual([1, 'published', true, false]);
    expect(p1['supersedes']).toBe(d1['descriptorUrl']);
    refused(await act(H, 'pev.author_scenario', W.author, { scenario: md1, status: 'draft', basedOnVersion: 1, ...none }), 409, 'scenario-already-published');
    const before = snapshot();
    const same = ok(await act(H, 'pev.author_scenario', W.author, { scenario: md1, status: 'published', basedOnVersion: 1, ...none }));
    expect(same['changed']).toBe(false);
    expect(snapshot()).toBe(before);
    const d2 = ok(await act(H, 'pev.author_scenario', W.author, { scenario: md2, status: 'draft', basedOnVersion: 1, ...none }));
    expect([d2['version'], d2['rubricChanged']]).toEqual([2, true]);
    expect(d2['rubricHash']).not.toBe(p1['rubricHash']);
    expect(d2['supersedes']).toBe(p1['descriptorUrl']);
    const p2 = ok(await act(H, 'pev.author_scenario', W.coAuthor, { scenario: md2, status: 'published', basedOnVersion: 2, ...none }));
    expect([p2['version'], p2['status']]).toEqual([2, 'published']);
    S['mdHash'] = String(p2['scenarioHash']);
    R['mdHead'] = p2;
    const draftOnly = ok(await act(H, 'pev.author_scenario', W.author, { scenario: { ...md1, scenarioKey: 'missed-deadline-draft' }, status: 'draft', ...none }));
    S['mdDraft'] = String(draftOnly['scenarioIri']);
    const oneTurn = ok(await act(H, 'pev.author_scenario', W.author, { scenario: { ...md1, scenarioKey: 'one-turn-check', turnLimit: 1 }, status: 'published', ...none }));
    S['oneTurn'] = String(oneTurn['scenarioIri']);
  }, SLOW);

  it('lists published heads with their full rubric, hides drafts unless asked, and lists every version of one scenario', async () => {
    const list = ok((await H['pev.list_scenarios']!({})) as Out);
    const views = list['scenarios'] as Out[];
    const md = views.find((v) => v['scenarioIri'] === S['md'])!;
    expect([md['version'], md['status'], md['ratified']]).toEqual([2, 'published', false]);
    expect(md['rubric']).toBeTruthy();
    expect(String(md['evidenceNote'])).toContain('once a reviewer ratifies it');
    expect(views.some((v) => v['scenarioIri'] === S['mdDraft'])).toBe(false);
    expect((list['bridge'] as Out)['counterpartRoute']).toBe('scripted');
    const withDrafts = ok((await H['pev.list_scenarios']!({ include_drafts: 'true' })) as Out);
    expect((withDrafts['scenarios'] as Out[]).some((v) => v['scenarioIri'] === S['mdDraft'])).toBe(true);
    const one = ok((await H['pev.list_scenarios']!({ scenario_iri: S['md'] })) as Out);
    expect((one['versions'] as Out[]).map((v) => `${String(v['version'])}:${String(v['status'])}`)).toEqual(['1:draft', '1:published', '2:draft', '2:published']);
    refused((await H['pev.list_scenarios']!({ scenario_iri: 'urn:pev:scenario:0000000000000000' })) as Out, 404, 'scenario-not-found');
  }, SLOW);

  it('a person who did not author the version ratifies it; authors, agents, the unregistered and stale views are refused', async () => {
    const pay = { scenarioIri: S['md'], version: 2, scenarioHash: S['mdHash'] };
    refused(await act(H, 'pev.ratify_scenario', W.author, pay), 403, 'ratifier-is-the-author');
    refused(await act(H, 'pev.ratify_scenario', W.coAuthor, pay), 403, 'ratifier-is-the-author');
    refused(await act(H, 'pev.ratify_scenario', W.agentReviewer, pay), 403, 'agent-cannot-ratify');
    refused(await act(H, 'pev.ratify_scenario', W.ana, pay), 403, 'not-a-reviewer');
    refused(await act(H, 'pev.ratify_scenario', W.reviewer, { ...pay, scenarioHash: 'f'.repeat(64) }), 409, 'scenario-revised');
    const draftHead = ok((await H['pev.list_scenarios']!({ scenario_iri: S['mdDraft'] })) as Out)['scenario'] as Out;
    refused(await act(H, 'pev.ratify_scenario', W.reviewer, { scenarioIri: S['mdDraft'], version: 1, scenarioHash: draftHead['scenarioHash'] }), 409, 'scenario-not-published');
    const r = ok(await act(H, 'pev.ratify_scenario', W.reviewer, pay));
    expect([r['status'], r['modalStatus'], r['ratifiedBy']]).toEqual(['ratified', 'Asserted', `did:ethr:${W.reviewer.address}`]);
    const d = descriptorOf(String(r['descriptorUrl']));
    expect(d).toMatch(/iep:modalStatus iep:Asserted/);
    expect(d).toMatch(/ThirdPartyAttested/);
    expect(d).toMatch(/iep:Validator/);
    expect(d).toContain(W.reviewer.address);
    refused(await act(H, 'pev.ratify_scenario', W.reviewer2, pay), 409, 'scenario-already-ratified');
  }, SLOW);

  it('drafting: a packet writes nothing; the bridge model drafts without writing; a receipt makes the assistance measured', async () => {
    refused((await H['pev.draft_scenario_packet']!({})) as Out, 400, 'brief-missing');
    const packet = ok((await H['pev.draft_scenario_packet']!({ brief: 'A client wants a launch date kept that defects now block.' })) as Out);
    expect([packet['execution'], packet['sampling_performed'], packet['writes_performed']]).toEqual(['client-required', false, false]);
    const brief = { brief: 'A project manager must tell a client sponsor that two defects block the launch date.' };
    refused(await act(H, 'pev.draft_scenario', W.ana, brief), 403, 'not-an-author');
    refused(await act(noModel, 'pev.draft_scenario', W.author, brief), 503, 'no-model-route');
    const broken = make({ model: scriptedTextModel(() => '{"title": "only a title"}') });
    const unusable = refused(await act(broken, 'pev.draft_scenario', W.author, brief), 502, 'draft-output-unusable');
    expect((unusable['problems'] as unknown[]).length).toBeGreaterThan(1);
    const before = snapshot();
    const drafted = ok(await act(H, 'pev.draft_scenario', W.author, brief));
    expect(snapshot()).toBe(before);
    expect((drafted['disclosure'] as Out)['provider']).toBe('scripted');
    const draft = drafted['draft'] as Out;
    const submitted = { ...draft, assessmentUse: 'feedback-only', workRegime: 'emergent' };
    refused(await act(H, 'pev.author_scenario', W.coAuthor, { scenario: submitted, status: 'published', draftReceipt: drafted['receipt'] }), 400, 'draft-receipt-not-verifiable');
    refused(await act(H, 'pev.author_scenario', W.author, { scenario: { ...submitted, assessmentUse: 'pass-gate' }, status: 'published', draftReceipt: drafted['receipt'] }), 400, 'pass-gate-needs-knowable-work');
    const pub = ok(await act(H, 'pev.author_scenario', W.author, { scenario: submitted, status: 'published', draftReceipt: drafted['receipt'] }));
    const da = pub['draftAssistance'] as Out;
    expect([da['used'], da['measured'], da['editedAfterDraft'], da['provider']]).toEqual([true, true, false, 'scripted']);
    expect(descriptorOf(String(pub['descriptorUrl']))).toContain(modelAgentIri('scripted', 'scripted-fixture'));
    S['rn'] = String(pub['scenarioIri']);
    S['rnHash'] = String(pub['scenarioHash']);
    const edited = ok(await act(H, 'pev.author_scenario', W.author, {
      scenario: { ...submitted, scenarioKey: 'renegotiate-edited', title: 'Renegotiating a launch date' }, status: 'draft', draftReceipt: drafted['receipt'],
    }));
    expect((edited['draftAssistance'] as Out)['editedAfterDraft']).toBe(true);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Conversation
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('practice: starting, speaking, the end proposal, packets, and what a model failure records', () => {
  it('start_attempt: coached is required, only published heads start, an author on a draft makes a test, attempt numbers count up', async () => {
    const start = (scenarioIri: string, scenarioVersion: number, extra: Out = { coached: false }): Out => ({ scenarioIri, scenarioVersion, ...extra });
    refused(await act(H, 'pev.start_attempt', W.ana, start(S['md']!, 2, {})), 400, 'coached-undeclared');
    refused(await act(H, 'pev.start_attempt', W.ana, start(S['md']!, 1)), 409, 'scenario-revised');
    refused(await act(H, 'pev.start_attempt', W.ana, start(S['mdDraft']!, 1)), 409, 'scenario-not-published');
    refused(await act(H, 'pev.start_attempt', W.ana, start('urn:pev:scenario:0000000000000000', 1)), 404, 'scenario-not-found');
    const test = ok(await act(H, 'pev.start_attempt', W.author, start(S['mdDraft']!, 1)));
    expect(test['authorTest']).toBe(true);
    S['authorTest'] = String(test['attemptIri']);
    const a1 = ok(await act(H, 'pev.start_attempt', W.ana, start(S['md']!, 2)));
    expect([a1['attemptNumber'], a1['authorTest'], a1['learnerKind'], a1['rubricRatified'], a1['state']]).toEqual([1, false, 'person', true, 'in-conversation']);
    expect((a1['turns'] as Out[])[0]?.['source']).toBe('authored-first-line');
    S['a1'] = String(a1['attemptIri']);
    // Without a record key an attempt IRI is a plain hash of the pod, the scenario and the learner's
    // address: anyone who reads the manifest and holds her address can find her attempts.
    expect(S['a1']).toBe(`urn:pev:attempt:${attemptKey(POD, S['md']!, W.ana.address)}-1`);
    const a2 = ok(await act(H, 'pev.start_attempt', W.ana, start(S['md']!, 2, { coached: true, assistance: 'My manager coached me last week.' })));
    expect(a2['attemptNumber']).toBe(2);
    S['a2'] = String(a2['attemptIri']);
    const b1 = ok(await act(H, 'pev.start_attempt', W.ben, start(S['md']!, 2)));
    expect(b1['attemptNumber']).toBe(1);
    S['b1'] = String(b1['attemptIri']);
    const ag = ok(await act(H, 'pev.start_attempt', W.agentLearner, start(S['md']!, 2)));
    expect(ag['learnerKind']).toBe('agent');
    S['ag'] = String(ag['attemptIri']);
  }, SLOW);

  it('say: the bridge model answers and is disclosed; strangers, wrong turns, replays and stale envelopes are refused', async () => {
    const r503 = refused(await act(noModel, 'pev.say', W.ana, { attemptIri: S['a1'], turnIndex: 1, text: DEMO_LINES.ana[0] }), 503, 'no-model-route');
    expect((r503['iep:resolvedBy'] as Out)['action']).toBe(PEV_ACTION.counterpartPacket);
    const t1 = ok(await act(H, 'pev.say', W.ana, { attemptIri: S['a1'], turnIndex: 1, text: DEMO_LINES.ana[0] }));
    const c2 = t1['counterpartTurn'] as Out;
    expect(c2['text']).toBe(DEMO_LINES.sam[0]);
    expect(c2['disclosure']).toMatchObject({ provider: 'scripted', model: 'scripted-fixture', keySource: 'none', route: 'scripted', promptTemplateHash: COUNTERPART_PROMPT_TEMPLATE_HASH });
    expect(t1['nextTurnIndex']).toBe(3);
    refused(await act(H, 'pev.say', W.ben, { attemptIri: S['a1'], turnIndex: 3, text: 'Not my attempt.' }), 403, 'not-the-learner');
    refused(await act(H, 'pev.say', W.ana, { attemptIri: S['a1'], turnIndex: 1, text: DEMO_LINES.ana[1] }), 409, 'turn-out-of-order');
    const envelope = await envelopeFor(W.ana, 'pev.say', { attemptIri: S['a1'], turnIndex: 3, text: DEMO_LINES.ana[1] });
    ok((await H['pev.say']!({ envelope })) as Out);
    refused((await H['pev.say']!({ envelope })) as Out, 409, 'envelope-already-used');
    const stale = new Date(clock.t - 11 * 60_000).toISOString();
    refused(await act(H, 'pev.say', W.ana, { attemptIri: S['a1'], turnIndex: 5, text: DEMO_LINES.ana[2] }, {}, { issuedAt: stale }), 401, 'envelope-expired');
    const tampered = await envelopeFor(W.ana, 'pev.say', { attemptIri: S['a1'], turnIndex: 5, text: DEMO_LINES.ana[2] });
    refused((await H['pev.say']!({ envelope: { ...tampered, payload: { ...tampered.payload, text: 'Edited after signing.' } } })) as Out, 403, 'not-the-learner');
    const t5 = ok(await act(H, 'pev.say', W.ana, { attemptIri: S['a1'], turnIndex: 5, text: DEMO_LINES.ana[2] }));
    expect([t5['state'], t5['endProposed'], (t5['counterpartTurn'] as Out)['endSignal']]).toEqual(['in-conversation', true, true]);
    expect((t5['counterpartTurn'] as Out)['text']).toBe('That works for me. Tuesday at ten.');
    const end = ok(await act(H, 'pev.end_conversation', W.ana, { attemptIri: S['a1'], turnIndex: 7 }));
    expect([end['state'], end['endedBy']]).toEqual(['ended', 'learner-confirmed-counterpart-end']);
    expect(String(end['transcriptHash'])).toMatch(/^[0-9a-f]{64}$/);
  }, SLOW);

  it('the other person may propose the end; a new learner line clears it; only the learner or the turn limit ends', async () => {
    const ender = make({ model: scriptedTextModel(() => 'Fine by me, we are done here. (end of conversation)') });
    const p = ok(await act(ender, 'pev.say', W.ana, { attemptIri: S['a2'], turnIndex: 1, text: 'Can we talk about how Thursday went for you?' }));
    expect(p['endProposed']).toBe(true);
    const q = ok(await act(H, 'pev.say', W.ana, { attemptIri: S['a2'], turnIndex: 3, text: 'One more thing before we stop: what would help next time?' }));
    expect([q['endProposed'], q['state']]).toEqual([false, 'in-conversation']);
    const e = ok(await act(H, 'pev.end_conversation', W.ana, { attemptIri: S['a2'], turnIndex: 5 }));
    expect(e['endedBy']).toBe('learner');
    refused(await act(H, 'pev.end_conversation', W.ben, { attemptIri: S['b1'], turnIndex: 1 }), 409, 'no-learner-turns');
    const after = ok(await act(H, 'pev.say', W.ben, { attemptIri: S['b1'], turnIndex: 1, text: LINE.b1, endAfter: true }));
    expect([after['state'], after['endedBy'], after['ended']]).toEqual(['ended', 'learner', true]);
    refused(await act(H, 'pev.say', W.ben, { attemptIri: S['b1'], turnIndex: 3, text: 'Too late.' }), 409, 'attempt-not-in-conversation');
    const one = ok(await act(H, 'pev.start_attempt', W.ana, { scenarioIri: S['oneTurn'], scenarioVersion: 1, coached: false }));
    S['oneTurnAttempt'] = String(one['attemptIri']);
    const lim = ok(await act(H, 'pev.say', W.ana, { attemptIri: S['oneTurnAttempt'], turnIndex: 1, text: LINE.oneTurn }));
    expect([lim['state'], lim['endedBy']]).toEqual(['ended', 'turn-limit']);
  }, SLOW);

  it('a per-request key is used once, disclosed, marks the other person as learner-model, and is stored nowhere', async () => {
    const r = ok(await act(H, 'pev.say', W.agentLearner, { attemptIri: S['ag'], turnIndex: 1, text: 'I want to talk about the report.' }, { llm_api_key: BYOK_KEY, llm_model: 'claude-test' }));
    expect((r['counterpartTurn'] as Out)['disclosure']).toMatchObject({ provider: 'anthropic', model: 'claude-test-returned', requestedModel: 'claude-test', keySource: 'per-request-byok', route: 'bridge-model', usage: { inputTokens: 40, outputTokens: 9 } });
    expect(r['counterpartControlledBy']).toBe('learner-model');
    expect(byok.keysSeen).toContain(BYOK_KEY);
    expect([...pod.store.values()].some((v) => v.includes(BYOK_KEY))).toBe(false);
    refused(await act(H, 'pev.say', W.agentLearner, { attemptIri: S['ag'], turnIndex: 3, text: 'Half a pair.' }, { llm_api_key: BYOK_KEY }), 400, 'byok-incomplete');
  }, SLOW);

  it('a failed model call records nothing; a head moved during the call answers chain-moved with the disclosure', async () => {
    const overloaded: TextModel = {
      provider: 'anthropic', requestedModel: 'claude-test', keySource: 'bridge-env', route: 'bridge-model',
      complete: async () => { throw new TextModelCallFailed('Anthropic Messages API: HTTP 529 overloaded_error', 529, 'overloaded_error', null, null); },
    };
    const before = snapshot();
    const r = refused(await act(make({ model: overloaded }), 'pev.say', W.agentLearner, { attemptIri: S['ag'], turnIndex: 3, text: 'Are you there?' }), 502, 'model-unreachable');
    expect((r['disclosure'] as Out)['provider']).toBe('anthropic');
    expect(snapshot()).toBe(before);
    const other = make({ model: scriptedPracticeModel() });
    const racing: TextModel = {
      provider: 'scripted', requestedModel: 'slow-fixture', keySource: 'none', route: 'scripted',
      complete: async (_req: TextModelRequest): Promise<TextModelResult> => {
        ok(await act(other, 'pev.say', W.agentLearner, { attemptIri: S['ag'], turnIndex: 3, text: 'A line from another bridge process.' }));
        return { text: 'Sure.', model: 'slow-fixture', stopReason: null, latencyMs: 1 };
      },
    };
    const moved = refused(await act(make({ model: racing }), 'pev.say', W.agentLearner, { attemptIri: S['ag'], turnIndex: 3, text: 'My line, raced.' }), 409, 'chain-moved');
    expect((moved['disclosure'] as Out)['model']).toBe('slow-fixture');
    const view = ok(await act(H, 'pev.get_attempt', W.agentLearner, { attemptIri: S['ag'] }));
    expect((view['turns'] as Out[]).map((t) => t['text'])).toContain('A line from another bridge process.');
    expect((view['turns'] as Out[]).map((t) => t['text'])).not.toContain('My line, raced.');
  }, SLOW);

  it('the packet route: the learner\'s own agent plays the other person, declared and recorded as such', async () => {
    const b2 = ok(await act(H, 'pev.start_attempt', W.ben, { scenarioIri: S['rn'], scenarioVersion: 1, coached: false }));
    S['b2'] = String(b2['attemptIri']);
    const packet = ok(await act(H, 'pev.counterpart_packet', W.ben, { attemptIri: S['b2'], turnIndex: 1, learnerText: DEMO_LINES.ben[0] }));
    expect([packet['execution'], packet['writes_performed']]).toEqual(['client-required', false]);
    expect(((packet['request'] as Out)['system'] as string)).toContain('Priya Raman');
    refused(await act(H, 'pev.counterpart_packet', W.ana, { attemptIri: S['b2'], turnIndex: 1, learnerText: 'x' }), 403, 'not-the-learner');
    const turn = { attemptIri: S['b2'], turnIndex: 1, learnerText: DEMO_LINES.ben[0], counterpartText: DEMO_LINES.priya[0] };
    refused(await act(H, 'pev.record_turns', W.ben, turn), 400, 'counterpart-undeclared');
    const decl = { counterpartDisclosure: { provider: 'scripted', model: 'demo-learner-agent', agent: 'Ben\'s own agent' } };
    refused(await act(H, 'pev.record_turns', W.ben, { ...turn, counterpartText: '   ', ...decl }), 400, 'counterpart-line-empty');
    const r1 = ok(await act(H, 'pev.record_turns', W.ben, { ...turn, ...decl }));
    expect(r1['counterpartControlledBy']).toBe('learner');
    expect((r1['counterpartTurn'] as Out)['disclosure']).toMatchObject({ keySource: 'mcp-client', route: 'client-packet', declaredBy: `did:ethr:${W.ben.address}` });
    const r2 = ok(await act(H, 'pev.record_turns', W.ben, {
      attemptIri: S['b2'], turnIndex: 3, learnerText: DEMO_LINES.ben[1], counterpartText: '(end of conversation)', endAfter: true, ...decl,
    }));
    expect([r2['state'], (r2['counterpartTurn'] as Out)['text'], (r2['counterpartTurn'] as Out)['endSignal']]).toEqual(['ended', '', true]);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Judging
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('judging: the platform checks every quote and computes the result; judges never do', () => {
  it('judges an ended attempt: the fabricated quote is unverified, the result is provisional and platform-computed, the target is the stored bytes', async () => {
    refused(await act(H, 'pev.judge_attempt', W.agentLearner, { attemptIri: S['ag'] }), 409, 'attempt-not-ended');
    refused(await act(H, 'pev.judge_attempt', W.stranger, { attemptIri: S['a1'] }), 403, 'not-learner-or-reviewer');
    refused(await act(noModel, 'pev.judge_attempt', W.ana, { attemptIri: S['a1'] }), 503, 'no-model-route');
    const j = ok(await act(H, 'pev.judge_attempt', W.ana, { attemptIri: S['a1'] }));
    expect([j['state'], j['modalStatus'], j['judgmentCount']]).toEqual(['judged', 'Hypothetical', 1]);
    const judgment = j['judgment'] as JudgmentResult;
    expect([judgment.judge.id, judgment.chosenBy, judgment.promptTemplateHash]).toEqual(['model:scripted/scripted-fixture', 'bridge-config', JUDGE_PROMPT_TEMPLATE_HASH]);
    const next = judgment.criteria.find((c) => c.criterionId === 'agrees-next-step')!;
    expect([next.status, next.why]).toEqual(['unverified', 'not found verbatim in any learner turn']);
    expect(next.quotes.find((q) => q.text === FABRICATED_QUOTE)?.verified).toBe(false);
    expect(judgment.unverifiedCriteria).toEqual(['agrees-next-step']);
    const spec = specOf(demoScenarioInput('missed-deadline', 2));
    expect(j['provisional']).toEqual(assess(spec, creditedLevels(spec, judgment), true));
    expect((j['provisional'] as Out)['percent']).toBe('66.7');
    expect((j['provisional'] as Out)['meetsPassRule']).toBe(false);
    expect((j['nextSteps'] as Out[]).map((x) => x['criterionId'])).toContain('agrees-next-step');
    const target = j['currentTarget'] as Out;
    expect(target['graphDigest']).toBe(canonicalGraphDigest(regionOf(String(target['descriptorUrl']))));
    const d = descriptorOf(String(j['descriptorUrl']));
    expect(d).toMatch(/iep:modalStatus iep:Hypothetical/);
    expect(d).not.toMatch(/groundTruth/);
    const second = ok(await act(H, 'pev.judge_attempt', W.ana, { attemptIri: S['a1'] }));
    expect((second['judgment'] as JudgmentResult).repeatOf).toBe(0);
    const spread = (second['agreement'] as { criterionId: string; spread: number }[]).find((x) => x.criterionId === 'asks-their-view');
    expect(spread?.spread).toBe(1);
  }, SLOW);

  it('allows at most five judgments; an unusable judge answer records nothing; a learner\'s own key makes the learner the chooser', async () => {
    for (let i = 0; i < 5; i++) ok(await act(H, 'pev.judge_attempt', W.ben, { attemptIri: S['b1'] }));
    refused(await act(H, 'pev.judge_attempt', W.ben, { attemptIri: S['b1'] }), 409, 'judgment-limit');
    const before = snapshot();
    const garbled = make({ model: scriptedTextModel(() => 'Here is my assessment: very good.') });
    const r = refused(await act(garbled, 'pev.judge_attempt', W.ana, { attemptIri: S['oneTurnAttempt'] }), 502, 'judge-output-unusable');
    expect(String(r['text'])).toContain('very good');
    expect(snapshot()).toBe(before);
    const own = ok(await act(H, 'pev.judge_attempt', W.ana, { attemptIri: S['oneTurnAttempt'] }, { llm_api_key: BYOK_KEY, llm_model: 'claude-test' }));
    const jj = own['judgment'] as JudgmentResult;
    expect([jj.chosenBy, jj.judge.id, jj.disclosure.keySource]).toEqual(['learner', 'model:anthropic/claude-test-returned', 'per-request-byok']);
  }, SLOW);

  it('an independent judge records from the packet: bound to the head it read, judge kind from the registry', async () => {
    refused(await act(H, 'pev.judge_packet', W.stranger, { attemptIri: S['b2'] }), 403, 'not-entitled');
    const pk = ok(await act(H, 'pev.judge_packet', W.judgeAgent, { attemptIri: S['b2'] }));
    const binding = pk['binding'] as Out;
    const judgment = {
      criteria: [
        { criterionId: 'names-constraint', level: 'specific', quotes: [{ text: 'two defects that block the payment flow', turnIndex: 1 }], rationale: 'Names the defects and what they block.' },
        { criterionId: 'explores-interests', level: 'one-question', quotes: [{ text: 'What matters most to the board about the 14th', turnIndex: 3 }], rationale: 'One question about what matters; following up would reach the next level.' },
      ],
    };
    const pay = { attemptIri: S['b2'], ...binding, judgment, judgeDisclosure: { provider: 'scripted', model: 'demo-judge-agent', usedPacketPrompt: true } };
    refused(await act(H, 'pev.record_judgment', W.ben, pay), 403, 'judge-is-the-learner');
    refused(await act(H, 'pev.record_judgment', W.reviewer, pay), 403, 'not-a-judge');
    refused(await act(H, 'pev.record_judgment', W.judgeAgent, { ...pay, transcriptHash: 'a'.repeat(64) }), 409, 'binding-mismatch');
    refused(await act(H, 'pev.record_judgment', W.judgeAgent, { ...pay, judgeDisclosure: { provider: 'x' } }), 400, 'judge-undeclared');
    refused(await act(H, 'pev.record_judgment', W.judgeAgent, {
      ...pay, judgment: { criteria: judgment.criteria.map((c) => ({ ...c, rationale: '' })) },
    }), 400, 'judgment-shape');
    const rec = ok(await act(H, 'pev.record_judgment', W.judgeAgent, pay));
    const ja = rec['judgment'] as JudgmentResult;
    expect([ja.judge.kind, ja.chosenBy, ja.promptTemplateHash, ja.route, ja.unverifiedCriteria.length]).toEqual(['agent', 'judge-registry', JUDGE_PROMPT_TEMPLATE_HASH, 'client-packet', 0]);
    const pk2 = ok(await act(H, 'pev.judge_packet', W.judgePerson, { attemptIri: S['b2'] }));
    const rec2 = ok(await act(H, 'pev.record_judgment', W.judgePerson, {
      ...pay, ...(pk2['binding'] as Out), judgeDisclosure: { provider: 'acme', model: 'judge-7', usedPacketPrompt: false },
    }));
    const jp = rec2['judgment'] as JudgmentResult;
    expect([jp.judge.kind, jp.promptTemplateHash, jp.repeatOf]).toEqual(['person', 'own-prompt', null]);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Review
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('review: a qualified person states every level; nothing is inferred from silence', () => {
  const asJudged = levels([['specific-observation', 'specific'], ['asks-their-view', 'first'], ['agrees-next-step', 'owner-and-date']]);
  const rnAsJudged = levels([['names-constraint', 'specific'], ['explores-interests', 'one-question']]);
  const target = async (iri: string): Promise<Out> => ok(await act(H, 'pev.get_attempt', W.reviewer, { attemptIri: iri }))['currentTarget'] as Out;

  it('refuses each conflict in order, an author test, incomplete levels, unverified quotes, differing levels and stale targets', async () => {
    const t1 = await target(S['a1']!);
    const tb2 = await target(S['b2']!);
    const pay = (iri: string, t: Out, lv: Out[]): Out => ({ attemptIri: iri, target: t, levels: lv, sawJudgeLevelsFirst: true });
    refused(await act(H, 'pev.countersign_attempt', W.reviewer, { attemptIri: S['a1'], target: t1, levels: asJudged }), 400, 'review-order-undeclared');
    refused(await act(H, 'pev.countersign_attempt', W.ana, pay(S['a1']!, t1, asJudged)), 403, 'reviewer-is-the-learner');
    refused(await act(H, 'pev.countersign_attempt', W.ben, pay(S['b2']!, tb2, rnAsJudged)), 403, 'reviewer-is-the-learner');
    refused(await act(H, 'pev.countersign_attempt', W.judgeAgent, pay(S['b2']!, tb2, rnAsJudged)), 403, 'reviewer-is-the-judge');
    refused(await act(H, 'pev.countersign_attempt', W.judgePerson, pay(S['b2']!, tb2, rnAsJudged)), 403, 'reviewer-is-the-judge');
    refused(await act(H, 'pev.countersign_attempt', W.author, pay(S['a1']!, t1, asJudged)), 403, 'not-a-reviewer');
    refused(await act(H, 'pev.countersign_attempt', W.agentReviewer, pay(S['a1']!, t1, asJudged)), 403, 'agent-cannot-countersign');
    ok(await act(H, 'pev.say', W.author, { attemptIri: S['authorTest'], turnIndex: 1, text: LINE.authorTest, endAfter: true }));
    ok(await act(H, 'pev.judge_attempt', W.author, { attemptIri: S['authorTest'] }));
    refused(await act(H, 'pev.countersign_attempt', W.reviewer, pay(S['authorTest']!, await target(S['authorTest']!), asJudged)), 409, 'author-test-attempt');
    refused(await act(H, 'pev.countersign_attempt', W.reviewer, pay(S['a1']!, t1, asJudged.slice(0, 2))), 400, 'levels-incomplete');
    const nv = refused(await act(H, 'pev.countersign_attempt', W.reviewer, pay(S['a1']!, t1, asJudged)), 409, 'unverified-criteria-need-override');
    expect((nv['iep:resolvedBy'] as Out)['action']).toBe(PEV_ACTION.overrideAttempt);
    refused(await act(H, 'pev.countersign_attempt', W.reviewer, pay(S['b2']!, tb2, levels([['names-constraint', 'vague'], ['explores-interests', 'one-question']]))), 409, 'levels-differ-from-judge');
    refused(await act(H, 'pev.countersign_attempt', W.reviewer, pay(S['b2']!, { ...tb2, graphDigest: `graph-nquads-sha256:${'0'.repeat(64)}` }, rnAsJudged)), 409, 'record-changed');
    refused(await act(H, 'pev.override_attempt', W.reviewer, pay(S['a1']!, t1, asJudged)), 400, 'override-why-missing');
    refused(await act(H, 'pev.override_attempt', W.reviewer, pay(S['b2']!, tb2, rnAsJudged)), 409, 'override-changes-nothing');
  }, SLOW);

  it('an override lists every level, supersedes the judged head as Asserted and third-party attested, and closes judging', async () => {
    const t1 = await target(S['a1']!);
    const lv = levels([['specific-observation', 'specific'], ['asks-their-view', 'first'], ['agrees-next-step', 'owner-and-date', 'Sam owns the status note and Tuesday 10am is the date; the second quote is not in the transcript.']]);
    const o = ok(await act(H, 'pev.override_attempt', W.reviewer, { attemptIri: S['a1'], target: t1, levels: lv, sawJudgeLevelsFirst: true }));
    expect([o['state'], o['modalStatus'], o['supersedes'], o['projectable'], o['outcomesRecorded']]).toEqual(['overridden', 'Asserted', t1['descriptorUrl'], true, 3]);
    expect((o['finalLevels'] as Out[]).map((f) => f['from'])).toEqual(['judge', 'judge', 'reviewer']);
    expect(o['assessment']).toMatchObject({ percent: '100.0', meetsPassRule: true, provisional: false, computedBy: 'platform' });
    const d = descriptorOf(String(o['descriptorUrl']));
    expect(d).toMatch(/iep:modalStatus iep:Asserted/);
    expect(d).toMatch(/iep:groundTruth "true"/);
    expect(d).toMatch(/ThirdPartyAttested/);
    expect(d).toMatch(/iep:Validator/);
    refused(await act(H, 'pev.countersign_attempt', W.reviewer2, { attemptIri: S['a1'], target: o['currentTarget'], levels: asJudged, sawJudgeLevelsFirst: true }), 409, 'attempt-not-judged');
    refused(await act(H, 'pev.judge_attempt', W.ana, { attemptIri: S['a1'] }), 409, 'attempt-already-reviewed');
  }, SLOW);

  it('two reviewers countersigning the same head at once: exactly one is recorded', async () => {
    const t = await target(S['b2']!);
    const pay = { attemptIri: S['b2'], target: t, levels: rnAsJudged, sawJudgeLevelsFirst: false };
    const [x, y] = await Promise.all([act(H, 'pev.countersign_attempt', W.reviewer, pay), act(H, 'pev.countersign_attempt', W.reviewer2, pay)]);
    const results = [x, y];
    expect(results.filter((r) => r['kind'] === undefined)).toHaveLength(1);
    const loser = results.find((r) => r['kind'] === 'refusal')!;
    expect(loser['iep:refusalStatus']).toBe(409);
    S['b2FirstReviewer'] = x['kind'] === undefined ? 'reviewer' : 'reviewer2';
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Contest and withdrawal
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('contest and withdrawal reopen a review; earlier reviews are kept', () => {
  const rnAsJudged = levels([['names-constraint', 'specific'], ['explores-interests', 'one-question']]);
  const head = async (iri: string, w: Wallet = W.reviewer3): Promise<Out> => ok(await act(H, 'pev.get_attempt', w, { attemptIri: iri }));

  it('the learner contests with a reason; a different reviewer re-reviews; after two contests a third is refused', async () => {
    const first = S['b2FirstReviewer'] === 'reviewer' ? W.reviewer : W.reviewer2;
    const second = S['b2FirstReviewer'] === 'reviewer' ? W.reviewer2 : W.reviewer;
    const t = (await head(S['b2']!))['currentTarget'];
    refused(await act(H, 'pev.contest_review', W.reviewer3, { attemptIri: S['b2'], target: t, why: 'I think the second criterion is higher.' }), 403, 'not-the-learner');
    refused(await act(H, 'pev.contest_review', W.ben, { attemptIri: S['b2'], target: t, why: 'short' }), 400, 'why-too-short');
    const c = ok(await act(H, 'pev.contest_review', W.ben, { attemptIri: S['b2'], target: t, why: 'I followed up on the board question in my last line.' }));
    expect([c['state'], c['modalStatus']]).toEqual(['contested', 'Hypothetical']);
    const queue = ok(await act(H, 'pev.review_queue', W.reviewer3, {}));
    const entry = (queue['entries'] as Out[]).find((e) => e['attemptIri'] === S['b2'])!;
    expect([entry['reopened'], (queue['entries'] as Out[])[0]?.['attemptIri']]).toEqual([true, S['b2']]);
    expect(entry['why']).toMatchObject({ learnerControlled: 1 });
    const firstQueue = ok(await act(H, 'pev.review_queue', first, {}));
    expect((firstQueue['entries'] as Out[]).some((e) => e['attemptIri'] === S['b2'])).toBe(false);
    expect(Number(firstQueue['excludedAsConflicted'])).toBeGreaterThanOrEqual(1);
    const t2 = c['currentTarget'];
    refused(await act(H, 'pev.countersign_attempt', first, { attemptIri: S['b2'], target: t2, levels: rnAsJudged, sawJudgeLevelsFirst: true }), 403, 'reviewer-already-reviewed');
    const re = ok(await act(H, 'pev.countersign_attempt', W.reviewer3, { attemptIri: S['b2'], target: t2, levels: rnAsJudged, sawJudgeLevelsFirst: true }));
    expect([re['state'], re['reviewIndex']]).toEqual(['countersigned', 1]);
    const c2 = ok(await act(H, 'pev.contest_review', W.ben, { attemptIri: S['b2'], target: re['currentTarget'], why: 'Asking once more: the follow-up is in turn three.' }));
    const re2 = ok(await act(H, 'pev.countersign_attempt', second, { attemptIri: S['b2'], target: c2['currentTarget'], levels: rnAsJudged, sawJudgeLevelsFirst: true }));
    expect(re2['reviewIndex']).toBe(2);
    refused(await act(H, 'pev.contest_review', W.ben, { attemptIri: S['b2'], target: re2['currentTarget'], why: 'A third time, to see the limit hold.' }), 409, 'contest-limit');
    const view = await head(S['b2']!, W.ben);
    expect((view['reviews'] as Out[]).length).toBe(3);
  }, SLOW);

  it('an admin withdraws a review for cause: Retracted for the interval it stood, rows withdrawn from calibration, back in the queue', async () => {
    const before = ok((await H['pev.calibration']!({})) as Out);
    const v = await head(S['a1']!);
    refused(await act(H, 'pev.retract_review', W.ben, { attemptIri: S['a1'], target: v['currentTarget'], why: 'Not an admin, trying anyway.' }), 403, 'not-an-admin');
    const r = ok(await act(H, 'pev.retract_review', W.admin, { attemptIri: S['a1'], target: v['currentTarget'], why: 'The reviewer was the learner\'s line manager.' }));
    expect([r['state'], r['modalStatus']]).toEqual(['review-retracted', 'Retracted']);
    const reviewedAt = String(((v['reviews'] as Out[])[0])?.['reviewedAt']);
    expect(r['validFrom']).toBe(reviewedAt);
    const d = descriptorOf(String(r['descriptorUrl']));
    expect(d).toMatch(/iep:modalStatus iep:Retracted/);
    expect(d).toMatch(/iep:groundTruth "false"/);
    expect(d).toContain(reviewedAt);
    const after = ok((await H['pev.calibration']!({})) as Out);
    expect(Number(after['outcomesRead'])).toBe(Number(before['outcomesRead']) - 6);
    const view = await head(S['a1']!, W.ana);
    expect(((view['reviews'] as Out[])[0])?.['withdrawn']).toBeTruthy();
    expect(view['standingReview']).toBeUndefined();
    const q = ok(await act(H, 'pev.review_queue', W.reviewer2, {}));
    expect((q['entries'] as Out[]).find((e) => e['attemptIri'] === S['a1'])?.['state']).toBe('review-retracted');
    refused(await act(H, 'pev.override_attempt', W.reviewer, { attemptIri: S['a1'], target: r['currentTarget'], levels: [], sawJudgeLevelsFirst: true }), 403, 'reviewer-already-reviewed');
    const lv = levels([['specific-observation', 'specific'], ['asks-their-view', 'first'], ['agrees-next-step', 'owner-and-date', 'The note by Tuesday 10am has an owner and a date; one quote was invented.']]);
    const o = ok(await act(H, 'pev.override_attempt', W.reviewer2, { attemptIri: S['a1'], target: r['currentTarget'], levels: lv, sawJudgeLevelsFirst: false }));
    expect([o['state'], o['reviewIndex']]).toEqual(['overridden', 1]);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Projection
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('projection: decided by reading the pod; every decision leaves an audit row', () => {
  it('declines before review, on an unratified rubric and for an author test, each with a skip audit; SCORM is not built', async () => {
    const skip = refused(await act(H, 'pev.project_attempt', W.ben, { attemptIri: S['b1'], format: 'xapi' }), 409, 'attempt-not-countersigned');
    const audit = await readRecord(String((skip['skipAudit'] as Out)['descriptorUrl']), TRUSTED, pod.fetchFn);
    expect(isTrusted(audit)).toBe(true);
    expect(audit.body).toMatchObject({ kind: 'projection-audit', outcome: 'skipped', skipWhy: 'attempt-not-countersigned', attemptIri: S['b1'] });
    const scorm = refused(await act(H, 'pev.project_attempt', W.ana, { attemptIri: S['a1'], format: 'scorm' }), 501, 'projection-not-built');
    expect(scorm).not.toHaveProperty('skipAudit');
    refused(await act(H, 'pev.project_attempt', W.ana, { attemptIri: S['a1'], format: 'csv' }), 400, 'format-unknown');
    refused(await act(H, 'pev.project_attempt', W.stranger, { attemptIri: S['a1'], format: 'xapi' }), 403, 'not-entitled');
    const unr = refused(await act(H, 'pev.project_attempt', W.ben, { attemptIri: S['b2'], format: 'xapi' }), 409, 'rubric-not-ratified');
    expect((unr['iep:resolvedBy'] as Out)['action']).toBe(PEV_ACTION.ratifyScenario);
    refused(await act(H, 'pev.project_attempt', W.author, { attemptIri: S['authorTest'], format: 'xapi' }), 409, 'author-test-attempt');
  }, SLOW);

  it('builds xAPI and cmi5-context statements for reviewed attempts on ratified rubrics, and records each as projected', async () => {
    ok(await act(H, 'pev.ratify_scenario', W.reviewer2, { scenarioIri: S['rn'], version: 1, scenarioHash: S['rnHash'] }));
    const fb = ok(await act(H, 'pev.project_attempt', W.ben, { attemptIri: S['b2'], format: 'xapi' }));
    const fbs = fb['statement'] as Out;
    expect(fbs['result']).not.toHaveProperty('score');
    expect(fbs['result']).not.toHaveProperty('success');
    expect(statementProblems(fbs, 'xapi', 'feedback-only')).toEqual([]);
    for (const format of ['xapi', 'cmi5'] as const) {
      const p = ok(await act(H, 'pev.project_attempt', W.ana, { attemptIri: S['a1'], format }));
      const st = p['statement'] as Out;
      expect(statementProblems(st, format, 'pass-gate')).toEqual([]);
      expect([(st['verb'] as Out)['id'], (st['result'] as Out)['success'], p['practiceEvidence']]).toEqual([VERB_COMPLETED, true, true]);
      expect(JSON.stringify(st)).not.toContain(CMI5_CATEGORY_PREFIX);
      const audit = await readRecord(String(p['auditDescriptorUrl']), TRUSTED, pod.fetchFn);
      expect(audit.body).toMatchObject({ kind: 'projection-audit', outcome: 'projected', statementId: p['statementId'] });
    }
  }, SLOW);

  it('a reviewer removed later does not strip the evidence: the role is checked as of the review', async () => {
    ok(await act(H, 'pev.register_role', W.admin, { address: W.reviewer2.address, role: 'reviewer', change: 'remove' }));
    ok(await act(H, 'pev.project_attempt', W.ana, { attemptIri: S['a1'], format: 'xapi' }));
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The learner's record
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('the learner holds their record: a copy on their pod and the exact signed bytes', () => {
  it('copies every version to the learner\'s pod with the platform proofs intact, idempotently, without the operator credential', async () => {
    refused(await act(H, 'pev.holder_copy', W.reviewer, { attemptIri: S['a1'], targetPodUrl: LEARNER_POD }), 403, 'not-the-learner');
    refused(await act(H, 'pev.holder_copy', W.ana, { attemptIri: S['a1'], targetPodUrl: POD }), 400, 'target-pod-is-served');
    refused(await act(H, 'pev.holder_copy', W.ana, { attemptIri: S['a1'], targetPodUrl: 'http://127.0.0.1:9/pod/' }), 400, 'target-pod-not-public');
    const c = ok(await act(H, 'pev.holder_copy', W.ana, { attemptIri: S['a1'], targetPodUrl: LEARNER_POD }));
    const copies = c['copies'] as Out[];
    expect(copies.length).toBeGreaterThanOrEqual(8);
    expect(c['copiesVerified']).toBe(copies.length);
    const entries = await discover(LEARNER_POD, {}, { fetch: pod.fetchFn as never });
    for (let i = 1; i < copies.length; i++) {
      const e = entries.find((x) => x.descriptorUrl === copies[i]?.['copyDescriptorUrl']);
      expect(e?.supersedes).toEqual([copies[i - 1]?.['copyDescriptorUrl']]);
    }
    const again = ok(await act(H, 'pev.holder_copy', W.ana, { attemptIri: S['a1'], targetPodUrl: LEARNER_POD }));
    expect((again['copies'] as Out[]).map((x) => x['copyDescriptorUrl'])).toEqual(copies.map((x) => x['copyDescriptorUrl']));
    const writes = pod.requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
    expect(writes.filter((r) => r.url.startsWith(LEARNER_POD)).every((r) => r.authorization === null)).toBe(true);
    expect(writes.filter((r) => r.url.startsWith(POD)).every((r) => r.authorization === `Bearer ${SECRET}`)).toBe(true);
    S['copies'] = JSON.stringify(copies.map((x) => x['copyDescriptorUrl']));
  }, SLOW);

  it('a holder pod that refuses the bridge\'s write points the learner at the export', async () => {
    const locked = make({
      holderFetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => ((init?.method ?? 'GET') === 'GET'
        ? pod.fetchFn(input, init) : new Response('no', { status: 401, statusText: 'Unauthorized' }))) as typeof fetch,
    });
    const r = refused(await act(locked, 'pev.holder_copy', W.ana, { attemptIri: S['a1'], targetPodUrl: 'https://locked-pod.example.test/ana/' }), 502, 'holder-pod-refused-write');
    expect((r['iep:resolvedBy'] as Out)['action']).toBe(PEV_ACTION.exportRecord);
  }, SLOW);

  it('exports every version\'s exact bytes, each pair verifiable offline with the substrate functions and the platform address', async () => {
    refused(await act(H, 'pev.export_record', W.reviewer, { attemptIri: S['a1'] }), 403, 'not-the-learner');
    const ex = ok(await act(H, 'pev.export_record', W.ana, { attemptIri: S['a1'] }));
    const versions = ex['versions'] as Out[];
    expect(versions.length).toBeGreaterThanOrEqual(8);
    const platforms = (ex['platformAddresses'] as string[]).map((a) => a.toLowerCase());
    for (const v of versions) {
      const descriptorTurtle = String(v['descriptorTurtle']);
      const proof = parseAuthorshipProofFromDescriptorTurtle(descriptorTurtle);
      const region = digestedGraphRegion({ descriptorTurtle, graphContent: String(v['graphTrig']) });
      expect(proof !== null && region.ok).toBe(true);
      if (!proof || !region.ok) continue;
      const verdict = await verifySignedAuthorship(proof, makeWalletDelegationVerifier(), { contentHash: canonicalGraphDigest(region.turtle) ?? '' });
      expect([verdict.valid, verdict.contentBinding, platforms.includes(proof.signerAddress.toLowerCase())]).toEqual([true, 'bound', true]);
    }
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Redaction
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('redaction removes the text from the operator pod and keeps every hash and level', () => {
  it('refuses strangers and an admin without a reason; the learner redacts; earlier graphs are deleted; copies still verify', async () => {
    const calBefore = ok((await H['pev.calibration']!({})) as Out);
    const v = ok(await act(H, 'pev.get_attempt', W.ana, { attemptIri: S['a1'] }));
    const t = v['currentTarget'];
    refused(await act(H, 'pev.redact_attempt', W.stranger, { attemptIri: S['a1'], target: t }), 403, 'not-learner-or-admin');
    refused(await act(H, 'pev.redact_attempt', W.admin, { attemptIri: S['a1'], target: t }), 400, 'why-required-for-admin');
    refused(await act(H, 'pev.redact_attempt', W.ana, { attemptIri: S['a1'], target: t, why: 'short' }), 400, 'why-too-short');
    const deletesBefore = pod.deletes.length;
    const r = ok(await act(H, 'pev.redact_attempt', W.ana, { attemptIri: S['a1'], target: t }));
    expect([r['state'], r['modalStatus'], r['changed'], r['graphsStillPresent']]).toEqual(['redacted', 'Retracted', true, []]);
    expect(Number(r['graphsDeleted'])).toBe((v['versions'] as Out[]).length);
    expect(pod.deletes.length - deletesBefore).toBe((v['versions'] as Out[]).length);
    const chain = await readChain(POD, S['a1']!, TRUSTED, pod.fetchFn);
    expect(chain.filter((x) => isDeleted(x)).length).toBe((v['versions'] as Out[]).length);
    const after = ok(await act(H, 'pev.get_attempt', W.ana, { attemptIri: S['a1'] }));
    expect((after['turns'] as Out[]).every((x) => x['text'] === undefined)).toBe(true);
    const operatorBytes = [...pod.store].filter(([u]) => u.startsWith(POD)).map(([, b]) => b).join('\n');
    for (const line of DEMO_LINES.ana) expect(operatorBytes.includes(line)).toBe(false);
    for (const url of JSON.parse(S['copies']!) as string[]) {
      const copy = await readRecord(url, TRUSTED, pod.fetchFn);
      expect([isTrusted(copy), copy.authorship.contentBinding]).toEqual([true, 'bound']);
      if (copy.body.kind === 'attempt' && copy.body.transcriptHash) expect(copy.body.transcriptHash).toBe(after['transcriptHash']);
    }
    refused(await act(H, 'pev.project_attempt', W.ana, { attemptIri: S['a1'], format: 'xapi' }), 409, 'attempt-redacted');
    const calAfter = ok((await H['pev.calibration']!({})) as Out);
    expect(calAfter['outcomesRead']).toBe(calBefore['outcomesRead']);
    const again = ok(await act(H, 'pev.redact_attempt', W.ana, { attemptIri: S['a1'], target: after['currentTarget'] }));
    expect(again['changed']).toBe(false);
  }, SLOW);

  it('a DELETE the pod does not honour is reported, not hidden', async () => {
    const stubborn = make({
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => ((init?.method ?? 'GET') === 'DELETE'
        ? new Response('no', { status: 500 }) : pod.fetchFn(input, init))) as typeof fetch,
    });
    const t = ok(await act(H, 'pev.get_attempt', W.ben, { attemptIri: S['b1'] }))['currentTarget'];
    const r = ok(await act(stubborn, 'pev.redact_attempt', W.ben, { attemptIri: S['b1'], target: t }));
    expect(r['state']).toBe('redacted');
    expect((r['graphsStillPresent'] as string[]).length).toBeGreaterThan(0);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Queue, calibration, results, reading
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('queue, calibration and results read the pod; person-judge figures stay behind an envelope', () => {
  it('the queue is for reviewers; it leaves out author tests and gives the factors with the priority', async () => {
    refused(await act(H, 'pev.review_queue', W.ana, {}), 403, 'not-a-reviewer');
    const q = ok(await act(H, 'pev.review_queue', W.reviewer3, { limit: 50 }));
    const ids = (q['entries'] as Out[]).map((e) => e['attemptIri']);
    expect(ids).toContain(S['oneTurnAttempt']);
    expect(ids).not.toContain(S['authorTest']);
    const e = (q['entries'] as Out[]).find((x) => x['attemptIri'] === S['oneTurnAttempt'])!;
    expect(Object.keys(e['why'] as Out).sort()).toEqual(['auditSample', 'cellNeed', 'disagreement', 'learnerControlled', 'nearThreshold', 'notQuoted', 'uncertainty', 'uncertaintyDeclared', 'unverified']);
    expect(typeof e['priority']).toBe('number');
  }, SLOW);

  it('calibration is agreement with the reviewer per judge, prompt, rubric version and criterion; person-judge cells are withheld', async () => {
    const c = ok((await H['pev.calibration']!({})) as Out);
    const cells = c['cells'] as Out[];
    expect(cells.some((x) => x['judgeId'] === 'model:scripted/scripted-fixture')).toBe(true);
    expect(cells.some((x) => x['judgeId'] === `did:ethr:${W.judgeAgent.address}` && x['judgeKind'] === 'agent')).toBe(true);
    expect(cells.every((x) => x['judgeKind'] !== 'person')).toBe(true);
    expect(Number(c['personJudgeCellsWithheld'])).toBeGreaterThan(0);
    const agent = cells.find((x) => x['judgeKind'] === 'agent')!;
    expect([agent['status'], (agent['standing'] as Out)['clears']]).toEqual(['Hypothetical', false]);
    expect(String(c['metricNote'])).toContain('not accuracy');
    // Unsigned, so a figure over 1 to 4 outcomes is hidden and only its count stays: with one or
    // two reviewed attempts a cell's agreement is those reviews' results read back.
    expect([c['k'], String(c['smallCountRule'])]).toEqual([5, expect.stringContaining('1 to k − 1 reviewed outcomes is hidden')]);
    const small = cells.filter((x) => Number(x['samples']) > 0 && Number(x['samples']) < 5);
    expect(small.length).toBeGreaterThan(0);
    for (const x of small) {
      expect([x['agreementRate'], x['meanBrier'], x['meanLevelDistance'], x['normalisedLevelDistance'], x['unverifiedRate'], x['ratesSuppressed']])
        .toEqual([null, null, null, null, null, true]);
    }
    for (const x of cells) {
      const hidden = (n: unknown): boolean => Number(n) > 0 && Number(n) < 5;
      if (hidden(x['blindSamples'])) expect(x['blindAgreementRate']).toBeNull();
      if (hidden(x['repeatSamples'])) expect(x['repeatAgreement']).toBeNull();
      if (hidden(x['auditSampleSamples'])) expect(x['auditSampleAgreementRate']).toBeNull();
    }
    // The same cells where nothing counts as small (k = 1) show every rate: the rule hid them, not the data.
    const whole = ok((await make({ model: scriptedPracticeModel(), resultsK: 1 })['pev.calibration']!({})) as Out);
    const same = (whole['cells'] as Out[]).filter((x) => small.some((y) => y['judgeId'] === x['judgeId'] && y['kind'] === x['kind'] && y['promptTemplateHash'] === x['promptTemplateHash']));
    expect(same.length).toBe(small.length);
    expect(same.every((x) => typeof x['agreementRate'] === 'number' && typeof x['meanLevelDistance'] === 'number' && x['ratesSuppressed'] === false)).toBe(true);
    expect(same.map((x) => x['samples'])).toEqual(small.map((x) => x['samples']));
    refused((await H['pev.calibration']!({ group_by: 'per-person' })) as Out, 400, 'group-by-unknown');
    const pooled = ok((await H['pev.calibration']!({ group_by: 'criterion-content' })) as Out);
    expect((pooled['cells'] as Out[]).every((x) => (x['standing'] as Out)['evaluated'] === false)).toBe(true);
  }, SLOW);

  it('results are for reviewers, authors and admins; small counts are suppressed; person-judge cells appear here', async () => {
    refused(await act(H, 'pev.scenario_results', W.ana, { scenarioIri: S['rn'] }), 403, 'not-entitled');
    const r = ok(await act(H, 'pev.scenario_results', W.author, { scenarioIri: S['rn'] }));
    expect((r['counts'] as Out)['attempts']).toBe(1);
    const per = (r['final'] as Out)['perCriterion'] as { levels: { suppressed: boolean; count: number | null }[] }[];
    expect(per.every((c) => c.levels.every((l) => l.count === null || l.count === 0))).toBe(true);
    expect((r['personJudgeCells'] as Out[]).some((x) => x['judgeId'] === `did:ethr:${W.judgePerson.address}`)).toBe(true);
    expect([r['reviewerChangesShown'], r['reviewerChanges']]).toEqual(['counts', []]);
    const md = ok(await act(H, 'pev.scenario_results', W.reviewer3, { scenarioIri: S['md'] }));
    expect((md['counts'] as Out)['authorTestExcluded']).toBe(0);
    expect(md['reviewerChangesShown']).toBe('each');
    const draft = ok(await act(H, 'pev.scenario_results', W.author, { scenarioIri: S['mdDraft'] }));
    expect((draft['counts'] as Out)['authorTestExcluded']).toBe(1);
  }, SLOW);

  it('get_attempt: highlights from server offsets, next steps from the rubric, the acts this caller may take', async () => {
    refused(await act(H, 'pev.get_attempt', W.stranger, { attemptIri: S['b2'] }), 403, 'not-entitled');
    const v = ok(await act(H, 'pev.get_attempt', W.ben, { attemptIri: S['b2'] }));
    expect([v['label'], v['evidenceKind'], (v['authorship'] as Out)['contentBinding']]).toEqual(['Practice evidence: rehearsal of this scenario, not a credential.', 'practice', 'bound']);
    const turns = v['turns'] as Out[];
    const judgments = v['judgments'] as JudgmentResult[];
    const highlights = v['highlights'] as Out[];
    expect(highlights.length).toBeGreaterThan(0);
    for (const h of highlights) {
      const turn = turns.find((x) => x['index'] === h['turnIndex'])!;
      const quote = judgments[Number(h['judgmentIndex'])]!.criteria.find((c) => c.criterionId === h['criterionId'])!
        .quotes.find((q) => q.turnIndex === h['turnIndex'] && q.start === h['start'])!;
      expect(String(turn['normalisedText']).slice(Number(h['start']), Number(h['end']))).toBe(quote.normalised);
    }
    expect((v['nextActions'] as Out[]).map((a) => a['toolName'])).toEqual(expect.arrayContaining(['pev.project_attempt', 'pev.export_record']));
    const judgeView = ok(await act(H, 'pev.get_attempt', W.judgeAgent, { attemptIri: S['b2'] }));
    expect(judgeView['attemptIri']).toBe(S['b2']);
    const mine = ok(await act(H, 'pev.get_attempt', W.ana, {}));
    expect((mine['attempts'] as Out[]).every((a) => a['learner'] === `did:ethr:${W.ana.address}`)).toBe(true);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Records come from the pod; plumbing
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('records come from the pod, and the pod plumbing holds', () => {
  it('a fresh handler set continues an attempt from the pod; another platform key is refused until trusted', async () => {
    const fresh = make({ model: scriptedPracticeModel() });
    const g = ok(await act(fresh, 'pev.get_attempt', W.agentLearner, { attemptIri: S['ag'] }));
    ok(await act(fresh, 'pev.say', W.agentLearner, { attemptIri: S['ag'], turnIndex: (g['turns'] as Out[]).length, text: 'Continuing from a fresh process.' }));
    const otherKey = importWallet(key('another-platform'), 'agent', 'another-platform');
    const stranger = make({ platformWallet: otherKey });
    const r = refused(await act(stranger, 'pev.get_attempt', W.agentLearner, { attemptIri: S['ag'] }), 409, 'record-not-trusted');
    expect(r['signerAddress']).toBe(W.platform.address);
    ok(await act(make({ platformWallet: otherKey, trustedPlatformAddresses: [W.platform.address] }), 'pev.get_attempt', W.agentLearner, { attemptIri: S['ag'] }));
    const startup = await describeStartup({ ...base, platformWallet: otherKey });
    expect(startup.registryTrusted).toBe(false);
    // The setting is offered only with the warning that the pod's content is no evidence the key was ours.
    expect(startup.lines.join('\n')).toContain(`If it is yours: PEV_TRUSTED_PLATFORM_ADDRESSES=${W.platform.address}.`);
    expect(startup.lines.join('\n')).toMatch(/WARNING: trust that key only if .* is an address this bridge printed as its own platform key/);
    expect(startup.lines.some((l) => l.startsWith('PEV_TRUSTED_PLATFORM_ADDRESSES='))).toBe(false);
  }, SLOW);

  it('reads and writes only served pods; a pod that refuses a write or a read is named, with the credential setting', async () => {
    refused(await act(H, 'pev.register_role', W.admin, { address: W.ana.address, role: 'author', change: 'add' }, {}, { pod: OTHER_POD }), 403, 'pod-not-served');
    refused((await H['pev.list_scenarios']!({ pod_url: OTHER_POD })) as Out, 403, 'pod-not-served');
    refused((await H['pev.calibration']!({ pod_url: OTHER_POD })) as Out, 403, 'pod-not-served');
    refused(await act(H, 'pev.get_attempt', W.ana, {}, {}, { pod: OTHER_POD }), 403, 'pod-not-served');
    // No default pod and no served pods: nothing is served until the operator says so ('*' is an explicit choice).
    const none = refused(await act(make({ defaultPodUrl: undefined }), 'pev.register_role', W.admin, { address: W.ana.address, role: 'author', change: 'add' }), 403, 'pod-not-served');
    expect(none['iep:resolvedBy']).toEqual({ env: 'PEV_SERVED_PODS' });
    // Served pods are compared after URL normalisation: an upper-case host and a default port still match.
    ok((await make({ servedPods: ['HTTPS://POD.example.test:443/practice'] })['pev.list_scenarios']!({ pod_url: POD })) as Out);
    refused(await act(H, 'pev.register_role', W.admin, { address: W.ana.address, role: 'author', change: 'add' }, { pod_url: OTHER_POD }), 400, 'pod-url-differs');
    refused((await H['pev.list_scenarios']!({ pod_url: 'http://127.0.0.1:9/' })) as Out, 400, 'pod-not-public');
    const fresh = inMemoryPod();
    const writeRefused = make({ fetchFn: (async (i: RequestInfo | URL, init?: RequestInit) => ((init?.method ?? 'GET') === 'GET' ? fresh.fetchFn(i, init) : new Response('no', { status: 401, statusText: 'Unauthorized' }))) as typeof fetch });
    const w = refused(await act(writeRefused, 'pev.register_role', W.admin, { address: W.ana.address, role: 'author', change: 'add' }), 502, 'pod-refused-write');
    expect(String(w['error'])).toContain('PEV_POD_WRITE_SECRET');
    const readRefused = make({ fetchFn: (async () => new Response('no', { status: 401, statusText: 'Unauthorized' })) as typeof fetch });
    refused((await readRefused['pev.list_scenarios']!({})) as Out, 502, 'pod-refused-read');
  }, SLOW);

  it('operatorPodFetch adds the credential to reads and writes under the operator pod only, and never follows a redirect with it', async () => {
    const seen: { url: string; auth: string | null; redirect?: RequestRedirect }[] = [];
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), ...(init?.redirect ? { redirect: init.redirect } : {}) });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const f = operatorPodFetch(POD, SECRET, spy);
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) await f(`${POD}pev/records/x.ttl`, { method });
    await f(`${POD}pev/records/x.ttl`, { method: 'GET' });
    await f('https://pod.example.test/elsewhere/x.ttl', { method: 'PUT' });
    await f('https://pod.example.test.evil.test/practice/x.ttl', { method: 'PUT' });
    await operatorPodFetch(POD, undefined, spy)(`${POD}x.ttl`, { method: 'PUT' });
    expect(seen.slice(0, 5).every((s) => s.auth === `Bearer ${SECRET}` && s.redirect === 'manual')).toBe(true);
    expect(seen.slice(5).map((s) => s.auth)).toEqual([null, null, null]);
  }, SLOW);

  it('a pod that refuses anonymous reads keeps transcripts from strangers while the bridge, with its credential, still works', async () => {
    const gated = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const read = (init?.method ?? 'GET').toUpperCase() === 'GET';
      if (read && url.startsWith(POD) && new Headers(init?.headers).get('authorization') !== `Bearer ${SECRET}`) return new Response('no', { status: 401, statusText: 'Unauthorized' });
      return pod.fetchFn(input, init);
    }) as typeof fetch;
    const transcript = [...pod.store.keys()].find((u) => u.startsWith(`${POD}pev/records/attempt-`) && u.endsWith('-graph.trig'))!;
    expect((await gated(transcript)).status).toBe(401);
    const withCredential = ok((await make({ fetchFn: operatorPodFetch(POD, SECRET, gated) })['pev.list_scenarios']!({})) as Out);
    expect((withCredential['scenarios'] as Out[]).length).toBeGreaterThan(0);
    refused((await make({ fetchFn: gated })['pev.list_scenarios']!({})) as Out, 502, 'pod-refused-read');
  }, SLOW);

  it('reads every response with a byte limit and keeps what a pod sent within it', async () => {
    const big = cappedFetch((async () => new Response('x'.repeat(64), { status: 200, headers: { etag: '"v1"' } })) as typeof fetch, 32);
    await expect(big('https://pod.example.test/practice/x.ttl')).rejects.toThrow(/limit of 32 bytes/);
    const declared = cappedFetch((async () => new Response('x', { status: 200, headers: { 'content-length': '999999999' } })) as typeof fetch, 32);
    await expect(declared('https://pod.example.test/practice/x.ttl')).rejects.toThrow(/declares 999999999 bytes/);
    const small = await cappedFetch((async () => new Response('hello', { status: 200, headers: { etag: '"v1"' } })) as typeof fetch, 32)('https://pod.example.test/practice/x.ttl');
    expect([small.status, small.headers.get('etag'), await small.text()]).toEqual([200, '"v1"', 'hello']);
    expect((await cappedFetch((async () => new Response(null, { status: 304 })) as typeof fetch, 32)('https://pod.example.test/x')).status).toBe(304);
  }, SLOW);

  it('demo signing is off unless configured; when on, its envelopes act and the record says a server-held key signed', async () => {
    refused((await H['pev.sign_as_demo_role']!({})) as Out, 404, 'demo-signing-off');
    const demoAdmin = wallet('demo-admin');
    const demo = make({ adminAddresses: [demoAdmin.address], demoSigner: { roles: [{ role: 'admin', label: 'Admin (demo key)', wallet: demoAdmin }] } });
    const list = ok((await demo['pev.sign_as_demo_role']!({})) as Out);
    expect((list['roles'] as Out[])[0]?.['address']).toBe(demoAdmin.address);
    refused((await demo['pev.sign_as_demo_role']!({ role: 'admin', payload: { action: 'urn:iep:action:other:thing' } })) as Out, 400, 'not-a-pev-action');
    refused((await demo['pev.sign_as_demo_role']!({ role: 'nobody', payload: { action: PEV_ACTION.registerRole } })) as Out, 400, 'role-unknown');
    const signed = ok((await demo['pev.sign_as_demo_role']!({ role: 'admin', payload: { action: PEV_ACTION.registerRole, address: W.stranger.address, role: 'judge', change: 'add' } })) as Out);
    const r = ok((await demo['pev.register_role']!({ envelope: signed['envelope'] })) as Out);
    const rec = await readRecord(String(r['descriptorUrl']), TRUSTED, pod.fetchFn);
    expect(rec.regionTurtle).toMatch(/pev:serverHeldDemoKey "true"/);
  }, SLOW);

  it('every record on the pod: shape-valid, platform-bound, no visibility or access facet, a slug carrying its own record id', async () => {
    const descriptors = [...pod.store.keys()].filter((u) => u.startsWith(`${POD}pev/records/`) && u.endsWith('.ttl'));
    expect(descriptors.length).toBeGreaterThan(60);
    const shapes = readShapesTurtle();
    let checked = 0;
    for (const url of descriptors) {
      const d = descriptorOf(url);
      expect(d).not.toMatch(/iep:visibility|AccessControlFacet/);
      if (!pod.store.has(url.replace(/\.ttl$/, '-graph.trig'))) continue;
      const rec = await readRecord(url, TRUSTED, pod.fetchFn);
      expect([isTrusted(rec), rec.authorship.contentBinding], url).toEqual([true, 'bound']);
      expect(validateAgainstShape(rec.regionTurtle, shapes, { entailment: 'rdfs' }).conforms, url).toBe(true);
      if (rec.body.kind !== 'projection-audit') expect(url).toContain(recordLocal(rec.recordId).slice(0, 8));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Last: a review whose reviewer did not hold the role when it was signed
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('a review is checked against the registry as it stood when it was signed', () => {
  it('a reviewer registered (by a bridge whose clock ran ahead) after their review was signed cannot carry it into evidence', async () => {
    const ahead = { t: clock.t + 3_600_000 };
    const late = make({ now: () => new Date(ahead.t += 1000) });
    ok(await act(late, 'pev.register_role', W.admin, { address: W.lateReviewer.address, role: 'reviewer', change: 'add' }, {}, { issuedAt: new Date(ahead.t).toISOString() }));
    const b3 = ok(await act(H, 'pev.start_attempt', W.ben, { scenarioIri: S['rn'], scenarioVersion: 1, coached: false }));
    const iri = String(b3['attemptIri']);
    ok(await act(H, 'pev.record_turns', W.ben, {
      attemptIri: iri, turnIndex: 1, learnerText: DEMO_LINES.ben[0], counterpartText: DEMO_LINES.priya[0], endAfter: true,
      counterpartDisclosure: { provider: 'scripted', model: 'demo-learner-agent' },
    }));
    const pk = ok(await act(H, 'pev.judge_packet', W.judgeAgent, { attemptIri: iri }));
    const j = ok(await act(H, 'pev.record_judgment', W.judgeAgent, {
      attemptIri: iri, ...(pk['binding'] as Out),
      judgment: { criteria: [
        { criterionId: 'names-constraint', level: 'specific', quotes: [{ text: 'two defects that block the payment flow' }], rationale: 'Names them.' },
        { criterionId: 'explores-interests', level: 'none', quotes: [], rationale: 'Asks nothing about what matters.' },
      ] },
      judgeDisclosure: { provider: 'scripted', model: 'demo-judge-agent', usedPacketPrompt: true },
    }));
    ok(await act(H, 'pev.countersign_attempt', W.lateReviewer, {
      attemptIri: iri, target: j['currentTarget'], levels: levels([['names-constraint', 'specific'], ['explores-interests', 'none']]), sawJudgeLevelsFirst: true,
    }));
    refused(await act(H, 'pev.project_attempt', W.ben, { attemptIri: iri, format: 'xapi' }), 409, 'countersign-not-verifiable');
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Replays, records out of place, spending limits, and who may confirm a judge they chose
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Re-publish a signed record's exact graph region, with its platform proof, as a new descriptor somewhere else. */
async function republish(region: string, proof: NonNullable<Awaited<ReturnType<typeof readRecord>>['proof']>, onPod: string, describes: string, slug: string, supersedes?: string): Promise<string> {
  const now = new Date(clock.t).toISOString();
  const b = ContextDescriptor.create(`urn:pev:test:${slug}` as IRI).describes(describes as IRI).temporal({ validFrom: now })
    .provenance({ wasAttributedTo: 'urn:pev:test:attacker' as IRI, generatedAtTime: now })
    .agent({ identity: 'urn:pev:test:attacker' as IRI, isSoftwareAgent: true }, 'Author').hypothetical().selfAsserted('urn:pev:test:attacker' as IRI);
  if (supersedes !== undefined) b.supersedes(supersedes as IRI);
  const w = await publishPevRecord({
    podUrl: onPod, descriptor: b.build(), graphTurtle: region, slug, authorshipProof: proof, shapes: false, fetchFn: pod.fetchFn,
    ...(supersedes !== undefined ? { supersedes, currentHeads: [supersedes] } : {}),
  });
  return w.descriptorUrl;
}

describe('a signed envelope acts once on any process, and a signed record counts only where it was written', () => {
  it('an admin envelope stored in the registry cannot be applied again by a restarted or second process', async () => {
    const add = await envelopeFor(W.admin, 'pev.register_role', { address: W.mallory.address, role: 'reviewer', change: 'add' });
    ok((await H['pev.register_role']!({ envelope: add })) as Out);
    ok(await act(H, 'pev.register_role', W.admin, { address: W.mallory.address, role: 'reviewer', change: 'remove' }));
    refused((await H['pev.register_role']!({ envelope: add })) as Out, 409, 'envelope-already-used');
    const restarted = make({ model: scriptedPracticeModel() });
    refused((await restarted['pev.register_role']!({ envelope: add })) as Out, 409, 'envelope-already-used');
    const roles = await readRoleRegistry(POD, TRUSTED, pod.fetchFn);
    expect(roles.roles.get(W.mallory.address.toLowerCase())).toBeUndefined();
  }, SLOW);

  it('a start, a line or a review envelope stored in an attempt cannot act again on another process', async () => {
    const start = await envelopeFor(W.newcomer, 'pev.start_attempt', { scenarioIri: S['rn'], scenarioVersion: 1, coached: false });
    const st = ok((await H['pev.start_attempt']!({ envelope: start })) as Out);
    const restarted = make({ model: scriptedPracticeModel() });
    refused((await restarted['pev.start_attempt']!({ envelope: start })) as Out, 409, 'envelope-already-used');
    const line = await envelopeFor(W.newcomer, 'pev.say', { attemptIri: st['attemptIri'], turnIndex: 1, text: 'The two defects block the payment flow, so the date moves.', endAfter: true });
    ok((await H['pev.say']!({ envelope: line })) as Out);
    refused((await restarted['pev.say']!({ envelope: line })) as Out, 409, 'envelope-already-used');
    S['newcomer'] = String(st['attemptIri']);
  }, SLOW);

  it('a reviewer who asked for the judgment, here with a model of their own choosing, cannot confirm it; another reviewer can', async () => {
    const j = ok(await act(H, 'pev.judge_attempt', W.reviewer3, { attemptIri: S['newcomer'] }, { llm_api_key: BYOK_KEY, llm_model: 'claude-test' }));
    expect((j['judgment'] as JudgmentResult).chosenBy).toBe('reviewer');
    // The provider double puts every criterion at its lowest level with no quote: nothing was checked, and the record says so.
    expect((j['judgment'] as JudgmentResult).criteria.map((c) => c.status)).toEqual(['no-quote-needed', 'no-quote-needed']);
    expect(j['unverifiedCriteria']).toEqual([]);
    const lowest = levels([['names-constraint', 'none'], ['explores-interests', 'none']]);
    const review = { attemptIri: S['newcomer'], target: j['currentTarget'], levels: lowest, sawJudgeLevelsFirst: true };
    refused(await act(H, 'pev.countersign_attempt', W.reviewer3, review), 403, 'reviewer-requested-the-judgment');
    const q = ok(await act(H, 'pev.review_queue', W.reviewer3, { limit: 100 }));
    expect((q['entries'] as Out[]).map((e) => e['attemptIri'])).not.toContain(S['newcomer']);
    const other = ok(await act(H, 'pev.review_queue', W.reviewer, { limit: 100 }));
    const entry = (other['entries'] as Out[]).find((e) => e['attemptIri'] === S['newcomer'])!;
    expect([(entry['why'] as Out)['notQuoted'], entry['mayCountersignAsIs']]).toEqual([1, true]);
    ok(await act(H, 'pev.countersign_attempt', W.reviewer, review));
  }, SLOW);

  it('a platform-signed registry copied to another pod grants nothing there, even on a bridge that serves any pod', async () => {
    const Y = 'https://attacker.example.test/mine/';
    const head = (await readHead(POD, registryIri(POD), TRUSTED, pod.fetchFn)).head!;
    expect(isTrusted(head)).toBe(true);
    await republish(head.regionTurtle, head.proof!, Y, registryIri(Y), 'transplanted-registry');
    const there = await readRoleRegistry(Y, TRUSTED, pod.fetchFn);
    expect([there.trusted, there.roles.size, there.head?.misplaced]).toEqual([false, 0, expect.stringContaining('describes another graph')]);
    const anyPod = make({ servedPods: '*' });
    const scenario = demoScenarioInput('renegotiate-scope');
    const r = refused(await act(anyPod, 'pev.author_scenario', W.author, { scenario, status: 'published', draftAssistance: { used: false } }, {}, { pod: Y }), 409, 'record-not-trusted');
    expect(String(r['error'])).toContain('signed by this platform, but not for where it sits');
    refused(await act(H, 'pev.author_scenario', W.author, { scenario, status: 'published', draftAssistance: { used: false } }, {}, { pod: Y }), 403, 'pod-not-served');
  }, SLOW);

  it('an old registry version re-published on top of a newer one is caught by its signed place in the chain', async () => {
    const Z = 'https://rollback.example.test/practice/';
    const z = make({ defaultPodUrl: Z });
    ok(await act(z, 'pev.register_role', W.admin, { address: W.author.address, role: 'author', change: 'add' }, {}, { pod: Z }));
    const granted = ok(await act(z, 'pev.register_role', W.admin, { address: W.mallory.address, role: 'reviewer', change: 'add' }, {}, { pod: Z }));
    const removed = ok(await act(z, 'pev.register_role', W.admin, { address: W.mallory.address, role: 'reviewer', change: 'remove' }, {}, { pod: Z }));
    const v2 = await readRecord(String(granted['descriptorUrl']), TRUSTED, pod.fetchFn);
    expect([v2.body.seq, v2.body.prev?.recordId !== undefined]).toEqual([2, true]);
    await republish(v2.regionTurtle, v2.proof!, Z, registryIri(Z), 'rolled-back-registry', String(removed['descriptorUrl']));
    const view = await readRoleRegistry(Z, TRUSTED, pod.fetchFn);
    expect([view.trusted, view.head?.misplaced]).toEqual([false, 'its signed body says it is version 2 of its chain, but this pod holds 4 version(s)']);
    const chain = await readChain(Z, registryIri(Z), TRUSTED, pod.fetchFn);
    expect(chain.map((v) => (isDeleted(v) ? 'deleted' : isTrusted(v)))).toEqual([true, true, true, false]);
    refused(await act(z, 'pev.register_role', W.admin, { address: W.mallory.address, role: 'reviewer', change: 'add' }, {}, { pod: Z }), 409, 'record-not-trusted');
  }, SLOW);

  it('limits this bridge\'s own model and attempt starts per signer per hour; a per-request key is not counted', async () => {
    const tight = make({ model: scriptedPracticeModel(), budgets: { modelCallsPerHour: { perSigner: 1, total: 50 }, attemptsPerHour: { perSigner: 1, total: 50 } } });
    const a = ok(await act(tight, 'pev.start_attempt', W.newcomer, { scenarioIri: S['rn'], scenarioVersion: 1, coached: true }));
    const again = refused(await act(tight, 'pev.start_attempt', W.newcomer, { scenarioIri: S['rn'], scenarioVersion: 1, coached: true }), 429, 'attempt-budget-spent');
    expect([again['scope'], (again['retryAfterSeconds'] as number) > 0]).toEqual(['signer', true]);
    ok(await act(tight, 'pev.say', W.newcomer, { attemptIri: a['attemptIri'], turnIndex: 1, text: 'The payment defects come first.' }));
    const spent = refused(await act(tight, 'pev.say', W.newcomer, { attemptIri: a['attemptIri'], turnIndex: 3, text: 'Then the date moves.' }), 429, 'model-budget-spent');
    expect(spent['iep:resolvedBy']).toMatchObject({ action: PEV_ACTION.counterpartPacket });
    ok(await act(tight, 'pev.say', W.newcomer, { attemptIri: a['attemptIri'], turnIndex: 3, text: 'Then the date moves.' }, { llm_api_key: BYOK_KEY, llm_model: 'claude-test' }));
    const total = make({ model: scriptedPracticeModel(), budgets: { modelCallsPerHour: { perSigner: 10, total: 1 } } });
    const b = ok(await act(total, 'pev.start_attempt', W.newcomer, { scenarioIri: S['rn'], scenarioVersion: 1, coached: false }));
    ok(await act(total, 'pev.say', W.newcomer, { attemptIri: b['attemptIri'], turnIndex: 1, text: 'The payment defects come first.', endAfter: true }));
    const all = refused(await act(total, 'pev.judge_attempt', W.reviewer, { attemptIri: b['attemptIri'] }), 429, 'model-budget-spent');
    expect(all['scope']).toBe('total');
  }, SLOW);

  it('a bridge that lends its model only to registered addresses refuses a stranger, who can still bring a key or a packet', async () => {
    const registered = make({ model: scriptedPracticeModel(), bridgeModelFor: 'registered' });
    const outsider = wallet('outsider');
    const a = ok(await act(registered, 'pev.start_attempt', outsider, { scenarioIri: S['rn'], scenarioVersion: 1, coached: false }));
    const r = refused(await act(registered, 'pev.say', outsider, { attemptIri: a['attemptIri'], turnIndex: 1, text: 'The payment defects come first.' }), 403, 'bridge-model-for-registered-only');
    expect(r['iep:resolvedBy']).toMatchObject({ action: PEV_ACTION.counterpartPacket });
    ok(await act(registered, 'pev.say', outsider, { attemptIri: a['attemptIri'], turnIndex: 1, text: 'The payment defects come first.' }, { llm_api_key: BYOK_KEY, llm_model: 'claude-test' }));
    ok(await act(H, 'pev.register_role', W.admin, { address: outsider.address, role: 'learner', change: 'add' }));
    ok(await act(registered, 'pev.say', outsider, { attemptIri: a['attemptIri'], turnIndex: 3, text: 'Then the date moves.' }));
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Encryption at rest: operator records sealed to the bridge's record key
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('with a record key, operator-pod records are sealed to it, still verify, and are read by no other key', () => {
  const vault = inMemoryPod();
  const SEALED = 'https://sealed-pod.example.test/practice/';
  const SEALED_HOLDER = 'https://sealed-holder.example.test/ana/';
  const RECORD_KEY = deriveEncryptionKeyPair(key('record-key'), 'pev-records');
  const OTHER_KEY = deriveEncryptionKeyPair(key('another-record-key'), 'pev-records');
  const KEYED = { ...TRUSTED, recordKey: RECORD_KEY };
  const on = { pod: SEALED };
  const sealedDeps: Partial<PevDeps> = { fetchFn: vault.fetchFn, holderFetchFn: vault.fetchFn, defaultPodUrl: SEALED };
  /** The same operator before PEV_RECORD_KEY was set. */
  const beforeKey = make(sealedDeps);
  const keyed = make({ ...sealedDeps, recordKey: RECORD_KEY, model: scriptedPracticeModel() });
  const under = (prefix: string): string[] => [...vault.store.keys()].filter((u) => u.startsWith(prefix)).sort();
  const V: Record<string, string> = {};

  it('a bridge given a key reads the plaintext registry written before it, and seals every version it writes after', async () => {
    const v1 = ok(await act(beforeKey, 'pev.register_role', W.admin, { address: W.author.address, role: 'author', change: 'add' }, {}, on));
    V['plainGraph'] = String(v1['descriptorUrl']).replace(/\.ttl$/, '-graph.trig');
    expect(vault.store.has(V['plainGraph'])).toBe(true);
    ok(await act(keyed, 'pev.register_role', W.admin, { address: W.reviewer.address, role: 'reviewer', change: 'add' }, {}, on));
    const v3 = ok(await act(keyed, 'pev.register_role', W.admin, { address: W.reviewer2.address, role: 'reviewer', change: 'add' }, {}, on));
    const sealedGraph = String(v3['descriptorUrl']).replace(/\.ttl$/, '-graph.envelope.jose.json');
    expect([vault.store.has(sealedGraph), vault.store.has(String(v3['descriptorUrl']).replace(/\.ttl$/, '-graph.trig'))]).toEqual([true, false]);
    // The descriptor stays readable and says its graph is an encrypted envelope; the graph bytes are ciphertext.
    expect(vault.store.get(String(v3['descriptorUrl']))).toMatch(/iep:encrypted true/);
    expect(JSON.parse(vault.store.get(sealedGraph)!)).toMatchObject({ algorithm: 'X25519-XSalsa20-Poly1305', wrappedKeys: [{ recipientPublicKey: RECORD_KEY.publicKey }] });
    expect(vault.store.get(sealedGraph)).not.toContain(W.reviewer2.address);
    const chain = await readChain(SEALED, registryIri(SEALED), KEYED, vault.fetchFn);
    expect(chain.map((v) => (isDeleted(v) ? 'deleted' : [isTrusted(v), v.authorship.contentBinding, v.sealed]))).toEqual([
      [true, 'bound', false], [true, 'bound', true], [true, 'bound', true],
    ]);
    const view = await readRoleRegistry(SEALED, KEYED, vault.fetchFn);
    expect([view.trusted, [...(view.roles.get(W.reviewer2.address.toLowerCase()) ?? [])]]).toEqual([true, ['reviewer']]);
    expect((await describeStartup({ ...base, ...sealedDeps, recordKey: RECORD_KEY })).registryTrusted).toBe(true);
  }, SLOW);

  it('a whole practice flow runs with the key set: author, ratify, attempt, judge, review, project; the pod holds only envelopes', async () => {
    const md = demoScenarioInput('missed-deadline', 2);
    const p = ok(await act(keyed, 'pev.author_scenario', W.author, { scenario: md, status: 'published', draftAssistance: { used: false } }, {}, on));
    V['scenario'] = String(p['scenarioIri']);
    const r = ok(await act(keyed, 'pev.ratify_scenario', W.reviewer, { scenarioIri: p['scenarioIri'], version: 1, scenarioHash: p['scenarioHash'] }, {}, on));
    expect([r['status'], r['modalStatus']]).toEqual(['ratified', 'Asserted']);
    const listed = ok((await keyed['pev.list_scenarios']!({})) as Out);
    expect([(listed['scenarios'] as Out[]).map((x) => x['scenarioIri']), listed['untrustedRecordsSkipped']]).toEqual([[p['scenarioIri']], 0]);
    const a = ok(await act(keyed, 'pev.start_attempt', W.ana, { scenarioIri: p['scenarioIri'], scenarioVersion: 1, coached: false }, {}, on));
    V['attempt'] = String(a['attemptIri']);
    for (const [k, turnIndex] of [[0, 1], [1, 3], [2, 5]] as const) {
      ok(await act(keyed, 'pev.say', W.ana, { attemptIri: V['attempt'], turnIndex, text: DEMO_LINES.ana[k] }, {}, on));
    }
    ok(await act(keyed, 'pev.end_conversation', W.ana, { attemptIri: V['attempt'], turnIndex: 7 }, {}, on));
    const j = ok(await act(keyed, 'pev.judge_attempt', W.ana, { attemptIri: V['attempt'] }, {}, on));
    expect((j['judgment'] as JudgmentResult).unverifiedCriteria).toEqual(['agrees-next-step']);
    // The review target is the digest of the opened graph, the same as on a plaintext pod.
    const target = j['currentTarget'] as Out;
    const judged = await readRecord(String(target['descriptorUrl']), KEYED, vault.fetchFn);
    expect([judged.sealed, judged.graphDigest]).toEqual([true, target['graphDigest']]);
    const lv = levels([['specific-observation', 'specific'], ['asks-their-view', 'first'], ['agrees-next-step', 'owner-and-date', 'Sam owns the status note and Tuesday 10am is the date; the second quote is not in the transcript.']]);
    const o = ok(await act(keyed, 'pev.override_attempt', W.reviewer2, { attemptIri: V['attempt'], target, levels: lv, sawJudgeLevelsFirst: true }, {}, on));
    expect([o['state'], o['modalStatus'], o['projectable']]).toEqual(['overridden', 'Asserted', true]);
    expect(vault.store.get(String(o['descriptorUrl']))).toMatch(/iep:modalStatus iep:Asserted/);
    const x = ok(await act(keyed, 'pev.project_attempt', W.ana, { attemptIri: V['attempt'], format: 'xapi' }, {}, on));
    expect(statementProblems(x['statement'], 'xapi', 'pass-gate')).toEqual([]);
    V['audit'] = String(x['auditDescriptorUrl']);

    const records = under(`${SEALED}${PEV_RECORDS_CONTAINER}`);
    const graphs = records.filter((u) => !u.endsWith('.ttl'));
    expect(graphs.length).toBeGreaterThan(12);
    // Every operator graph is an envelope, except the registry version written before the key was set.
    expect(graphs.filter((u) => !u.endsWith('-graph.envelope.jose.json'))).toEqual([V['plainGraph']]);
    const operatorBytes = [...vault.store].filter(([u]) => u.startsWith(SEALED)).map(([, b]) => b).join('\n');
    for (const line of DEMO_LINES.ana) expect(operatorBytes.includes(line)).toBe(false);
    const shapes = readShapesTurtle();
    const descriptors = records.filter((u) => u.endsWith('.ttl'));
    const plainDescriptor = V['plainGraph']!.replace(/-graph\.trig$/, '.ttl');
    for (const url of descriptors) {
      const rec = await readRecord(url, KEYED, vault.fetchFn);
      expect([isTrusted(rec), rec.authorship.contentBinding, rec.sealed], url).toEqual([true, 'bound', url !== plainDescriptor]);
      expect(validateAgainstShape(rec.regionTurtle, shapes, { entailment: 'rdfs' }).conforms, url).toBe(true);
    }
    expect(descriptors.length).toBe(graphs.length);
    V['override'] = String(o['descriptorUrl']);
  }, SLOW);

  it('no public byte on the pod names a learner or links an attempt to one: role entry, contest and a declined projection included', async () => {
    // Ana's role entry, her contest and a second request for a statement each write a record.
    ok(await act(keyed, 'pev.register_role', W.admin, { address: W.ana.address, role: 'learner', change: 'add' }, {}, on));
    const v = ok(await act(keyed, 'pev.get_attempt', W.ana, { attemptIri: V['attempt'] }, {}, on));
    const c = ok(await act(keyed, 'pev.contest_review', W.ana, { attemptIri: V['attempt'], target: v['currentTarget'], why: 'Sam agreed the date with me; please read turn five again.' }, {}, on));
    expect(c['state']).toBe('contested');
    const skip = refused(await act(keyed, 'pev.project_attempt', W.ana, { attemptIri: V['attempt'], format: 'xapi' }, {}, on), 409, 'attempt-not-countersigned');
    // Each projection audit still says, in its sealed body, who asked.
    for (const url of [V['audit']!, String((skip['skipAudit'] as Out)['descriptorUrl'])]) {
      const rec = await readRecord(url, KEYED, vault.fetchFn);
      expect([rec.sealed, rec.body.kind === 'projection-audit' ? rec.body.requestedBy.toLowerCase() : null]).toEqual([true, `did:ethr:${W.ana.address}`.toLowerCase()]);
    }
    // Everything anyone can read from the pod: every resource under it but the envelopes.
    const open = [...vault.store].filter(([u]) => u.startsWith(SEALED) && !u.endsWith('.envelope.jose.json'));
    expect(open.length).toBeGreaterThan(15);
    const text = open.map(([u, b]) => `${u}\n${b}`).join('\n').toLowerCase();
    const hex = (w: Wallet): string => w.address.slice(2).toLowerCase();
    // Neither her address nor her DID, in any case, while the people named by design still are.
    expect(text.includes(hex(W.ana))).toBe(false);
    expect([W.author, W.reviewer, W.reviewer2, W.admin].map((w) => text.includes(hex(w)))).toEqual([true, true, true, true]);
    // Her attempt's IRI is public, keyed with the record key: the plain hash of her address is nowhere.
    const keyedKey = attemptKey(SEALED, V['scenario']!, W.ana.address, attemptIriSecret(RECORD_KEY));
    expect(V['attempt']).toBe(`urn:pev:attempt:${keyedKey}-1`);
    expect(text).toContain(keyedKey);
    expect(text.includes(attemptKey(SEALED, V['scenario']!, W.ana.address))).toBe(false);
  }, SLOW);

  it('text with a lone UTF-16 surrogate is refused at input before any model call; a model\'s becomes U+FFFD; a seal failure is never the pod\'s', async () => {
    const LONE = 'Half a pair \ud800 and nothing after it.';
    let calls = 0;
    const counting = make({ ...sealedDeps, recordKey: RECORD_KEY, model: scriptedTextModel(() => { calls += 1; return 'Go on.'; }) });
    const iri = String(ok(await act(counting, 'pev.start_attempt', W.newcomer, { scenarioIri: V['scenario'], scenarioVersion: 1, coached: false }, {}, on))['attemptIri']);
    const snap = JSON.stringify([...vault.store].sort());
    const keysBefore = byok.keysSeen.length;
    const say = refused(await act(counting, 'pev.say', W.newcomer, { attemptIri: iri, turnIndex: 1, text: LONE }, {}, on), 400, 'payload-shape');
    expect(String(say['error'])).toMatch(/^text must be well-formed text/);
    refused(await act(counting, 'pev.record_turns', W.newcomer, {
      attemptIri: iri, turnIndex: 1, learnerText: 'The report came a day late.', counterpartText: LONE, counterpartDisclosure: { provider: 'own', model: 'own-model' },
    }, {}, on), 400, 'payload-shape');
    // Anywhere in a signed payload, and in a per-request model name, and in an unsigned packet's brief.
    const deep = refused(await act(counting, 'pev.author_scenario', W.author, {
      scenario: { ...(demoScenarioInput('missed-deadline', 2) as Out), title: LONE }, status: 'draft', draftAssistance: { used: false },
    }, {}, on), 400, 'payload-shape');
    expect(String(deep['error'])).toContain('payload.scenario.title');
    refused(await act(counting, 'pev.say', W.newcomer, { attemptIri: iri, turnIndex: 1, text: 'Fine.', note: LONE }, {}, on), 400, 'payload-shape');
    refused(await act(counting, 'pev.say', W.newcomer, { attemptIri: iri, turnIndex: 1, text: 'Fine.' }, { llm_api_key: BYOK_KEY, llm_model: 'model-\udc00' }, on), 400, 'payload-shape');
    refused((await counting['pev.draft_scenario_packet']!({ brief: LONE })) as Out, 400, 'payload-shape');
    expect([calls, byok.keysSeen.length - keysBefore]).toEqual([0, 0]);
    expect(JSON.stringify([...vault.store].sort())).toBe(snap);
    // What a model returns is not the caller's to fix: a lone surrogate is recorded as U+FFFD and sealed.
    const lonely = make({ ...sealedDeps, recordKey: RECORD_KEY, model: scriptedTextModel(() => 'Fine \udc00 then.') });
    const said = ok(await act(lonely, 'pev.say', W.newcomer, { attemptIri: iri, turnIndex: 1, text: 'The report came a day late.' }, {}, on));
    expect((said['counterpartTurn'] as Out)['text']).toBe('Fine � then.');
    const rec = await readRecord(String(said['descriptorUrl']), KEYED, vault.fetchFn);
    expect([isTrusted(rec), rec.sealed]).toEqual([true, true]);
    // Sealing is local: a graph that cannot be sealed is a RecordNotSealable before any request.
    const proof = (await readRecord(V['override']!, KEYED, vault.fetchFn)).proof!;
    const now = new Date(clock.t).toISOString();
    const descriptor = ContextDescriptor.create('urn:pev:test:lone' as IRI).describes('urn:pev:test:lone-graph' as IRI).temporal({ validFrom: now })
      .provenance({ wasAttributedTo: 'urn:pev:test:x' as IRI, generatedAtTime: now })
      .agent({ identity: 'urn:pev:test:x' as IRI, isSoftwareAgent: true }, 'Author').hypothetical().selfAsserted('urn:pev:test:x' as IRI).build();
    const requests = vault.requests.length;
    const seal = publishPevRecord({
      podUrl: SEALED, descriptor, graphTurtle: `<urn:pev:test:lone-graph> <urn:pev:test:says> "${LONE}" .`, slug: 'lone', authorshipProof: proof,
      shapes: false, fetchFn: vault.fetchFn, sealTo: RECORD_KEY,
    });
    await expect(seal).rejects.toBeInstanceOf(RecordNotSealable);
    expect(vault.requests.length).toBe(requests);
    // The envelope's own encoder failing (here on a descriptor value) is the same local failure, not a pod's.
    const odd = ContextDescriptor.create('urn:pev:test:lone-2' as IRI).describes('urn:pev:test:lone-graph' as IRI).temporal({ validFrom: now })
      .provenance({ wasAttributedTo: 'urn:pev:test:x\ud800' as IRI, generatedAtTime: now })
      .agent({ identity: 'urn:pev:test:x' as IRI, isSoftwareAgent: true }, 'Author').hypothetical().selfAsserted('urn:pev:test:x' as IRI).build();
    const stored = JSON.stringify([...vault.store].sort());
    const thrown = await publishPevRecord({
      podUrl: SEALED, descriptor: odd, graphTurtle: '<urn:pev:test:lone-graph> <urn:pev:test:says> "fine" .', slug: 'lone-2', authorshipProof: proof,
      shapes: false, fetchFn: vault.fetchFn, sealTo: RECORD_KEY,
    }).then(() => null, (e: unknown) => e);
    expect([thrown instanceof RecordNotSealable, String((thrown as Error).message)]).toEqual([true, expect.stringContaining('could not be encrypted')]);
    expect(JSON.stringify([...vault.store].sort())).toBe(stored);
  }, SLOW);

  it('a bridge holding another record key, or none, reports the sealed records as unreadable and writes nothing', async () => {
    const before = JSON.stringify([...vault.store].sort());
    for (const [h, hasKey] of [[make({ ...sealedDeps, recordKey: OTHER_KEY, model: scriptedPracticeModel() }), true], [make(sealedDeps), false]] as const) {
      const r = refused(await act(h, 'pev.get_attempt', W.ana, { attemptIri: V['attempt'] }, {}, on), 409, 'record-not-trusted');
      expect(r['iep:resolvedBy']).toEqual({ env: 'PEV_RECORD_KEY' });
      expect(String(r['error'])).toContain(hasKey ? 'sealed to a record key this bridge does not hold' : 'this bridge has no record key');
      refused(await act(h, 'pev.register_role', W.admin, { address: W.ben.address, role: 'learner', change: 'add' }, {}, on), 409, 'record-not-trusted');
      refused(await act(h, 'pev.say', W.ana, { attemptIri: V['attempt'], turnIndex: 9, text: 'Reading this needs the key.' }, {}, on), 409, 'record-not-trusted');
      // A listing skips the sealed scenario and counts it; it never answers as if the pod held none.
      const list = ok((await h['pev.list_scenarios']!({})) as Out);
      expect([(list['scenarios'] as Out[]).length, list['untrustedRecordsSkipped']]).toEqual([0, 1]);
      const startup = await describeStartup({ ...base, ...sealedDeps, ...(hasKey ? { recordKey: OTHER_KEY } : {}) });
      expect(startup.registryTrusted).toBe(false);
      expect(startup.lines.join('\n')).toContain('Set PEV_RECORD_KEY to the key that wrote it');
    }
    expect(JSON.stringify([...vault.store].sort())).toBe(before);
    await expect(readRecord(V['override']!, { ...TRUSTED, recordKey: OTHER_KEY }, vault.fetchFn)).rejects.toBeInstanceOf(RecordSealed);
    await expect(readRecord(V['override']!, TRUSTED, vault.fetchFn)).rejects.toThrow(/sealed, and this bridge has no record key/);
    // The plaintext version written before the key is still readable without one.
    const plain = await readRecord(V['plainGraph']!.replace(/-graph\.trig$/, '.ttl'), TRUSTED, vault.fetchFn);
    expect([isTrusted(plain), plain.sealed]).toEqual([true, false]);
  }, SLOW);

  it('holder copies stay plaintext on the learner\'s pod and verify without the key; the export gives the opened bytes', async () => {
    const c = ok(await act(keyed, 'pev.holder_copy', W.ana, { attemptIri: V['attempt'], targetPodUrl: SEALED_HOLDER }, {}, on));
    const copies = c['copies'] as Out[];
    expect(copies.length).toBeGreaterThanOrEqual(6);
    expect(c['copiesVerified']).toBe(copies.length);
    const held = under(`${SEALED_HOLDER}${PEV_COPIES_CONTAINER}`);
    expect(held.filter((u) => u.endsWith('.envelope.jose.json'))).toEqual([]);
    const heldGraphs = held.filter((u) => u.endsWith('-graph.trig'));
    expect(heldGraphs.length).toBe(copies.length);
    expect(heldGraphs.some((u) => vault.store.get(u)!.includes(DEMO_LINES.ana[0]!))).toBe(true);
    for (const x of copies) {
      const copy = await readRecord(String(x['copyDescriptorUrl']), TRUSTED, vault.fetchFn);
      expect([isTrusted(copy), copy.authorship.contentBinding, copy.sealed]).toEqual([true, 'bound', false]);
    }
    const ex = ok(await act(keyed, 'pev.export_record', W.ana, { attemptIri: V['attempt'] }, {}, on));
    const versions = ex['versions'] as Out[];
    expect(versions.length).toBe(copies.length);
    for (const v of versions) {
      const descriptorTurtle = String(v['descriptorTurtle']);
      const proof = parseAuthorshipProofFromDescriptorTurtle(descriptorTurtle);
      const region = digestedGraphRegion({ descriptorTurtle, graphContent: String(v['graphTrig']) });
      expect(proof !== null && region.ok).toBe(true);
      if (!proof || !region.ok) continue;
      const verdict = await verifySignedAuthorship(proof, makeWalletDelegationVerifier(), { contentHash: canonicalGraphDigest(region.turtle) ?? '' });
      expect([verdict.valid, verdict.contentBinding]).toEqual([true, 'bound']);
    }
  }, SLOW);

  it('a pod writer without the key who forges the manifest cannot make the bridge open another learner\'s record for anyone', async () => {
    const MANIFEST = `${SEALED}.well-known/context-graphs`;
    /** Rewrite one manifest entry property by property (`<url> a iep:ManifestEntry ; … .`). */
    const entry = (manifest: string, url: string, edit: (props: string[]) => string[]): string => {
      const at = manifest.indexOf(`<${url}> a iep:ManifestEntry`);
      expect(at, url).toBeGreaterThanOrEqual(0);
      const end = manifest.indexOf(' .\n', at);
      return `${manifest.slice(0, at)}${edit(manifest.slice(at, end).split(' ;\n')).join(' ;\n')}${manifest.slice(end)}`;
    };
    const is = (p: string, prop: string): boolean => p.trim().startsWith(prop);
    // The victim: Ana's attempt, sealed; her lines (the judge's quotes are cut from them) are the secret.
    const anaView = ok(await act(keyed, 'pev.get_attempt', W.ana, { attemptIri: V['attempt'] }, {}, on));
    const anaHead = String(anaView['headDescriptorUrl']);
    const anaGraph = graphUrlOf(vault.store, anaHead)!;
    expect(anaGraph.endsWith('-graph.envelope.jose.json')).toBe(true);
    const secrets = DEMO_LINES.ana;
    expect((anaView['turns'] as Out[]).map((t) => t['text'])).toEqual(expect.arrayContaining([...secrets]));
    // The attacker: an attempt of Mallory's own, two versions long.
    const m = ok(await act(keyed, 'pev.start_attempt', W.mallory, { scenarioIri: V['scenario'], scenarioVersion: 1, coached: false }, {}, on));
    const mIri = String(m['attemptIri']);
    const v1 = String(m['descriptorUrl']);
    const v2 = String(ok(await act(keyed, 'pev.say', W.mallory, { attemptIri: mIri, turnIndex: 1, text: 'Nothing to see here, Sam.' }, {}, on))['descriptorUrl']);
    const mView = ok(await act(keyed, 'pev.get_attempt', W.mallory, { attemptIri: mIri }, {}, on));
    const original = vault.store.get(MANIFEST)!;
    // His head chains to her head first.
    const pointAtHer = entry(original, v2, (ps) => ps.flatMap((p) => (is(p, 'iep:supersedes') ? [`    iep:supersedes <${anaHead}>`, p] : [p])));
    const forgeries: readonly [string, string][] = [
      ['a supersedes pointing at her head', pointAtHer],
      ['her head also filed under his attempt', entry(pointAtHer, anaHead, (ps) => [...ps, `    iep:describes <${mIri}>`])],
      // Filed under his attempt in place of his first version, and cut from her own chain, so the
      // chain reads through: only each version's signed body says it does not belong there.
      ['her head filed in place of his first version', entry(entry(entry(original,
        v2, (ps) => ps.map((p) => (is(p, 'iep:supersedes') ? `    iep:supersedes <${anaHead}>` : p))),
        anaHead, (ps) => [...ps.filter((p) => !is(p, 'iep:supersedes')), `    iep:describes <${mIri}>`]),
        v1, (ps) => ps.map((p) => (is(p, 'iep:describes') ? '    iep:describes <urn:pev:attempt:0000000000000000-1>' : p)))],
    ];
    try {
      for (const [what, forged] of forgeries) {
        vault.store.set(MANIFEST, forged);
        const writes = JSON.stringify([...vault.store].sort());
        const deletes = vault.deletes.length;
        const requestsBefore = vault.requests.length;
        const exported = await act(keyed, 'pev.export_record', W.mallory, { attemptIri: mIri }, {}, on);
        const read = await act(keyed, 'pev.get_attempt', W.mallory, { attemptIri: mIri }, {}, on);
        const copied = await act(keyed, 'pev.holder_copy', W.mallory, { attemptIri: mIri, targetPodUrl: 'https://mallory-pod.example.test/m/' }, {}, on);
        const redacted = await act(keyed, 'pev.redact_attempt', W.mallory, { attemptIri: mIri, target: mView['currentTarget'] }, {}, on);
        for (const a of [exported, read, copied, redacted]) {
          for (const s of secrets) expect(JSON.stringify(a).includes(s), `${what}: ${s}`).toBe(false);
        }
        for (const a of [exported, copied, redacted]) refused(a, 409, 'record-not-trusted');
        if (what.startsWith('her head filed in place')) {
          // The chain reads through, so the bridge opens her head, finds its signed body is not his,
          // and shows the version without anything read from it.
          expect(ok(read)['versions']).toEqual([
            { descriptorUrl: anaHead, recordId: expect.any(String), state: null, modalStatus: null, contentDeleted: false, trusted: false },
            { descriptorUrl: v2, recordId: expect.any(String), state: null, modalStatus: null, contentDeleted: false, trusted: false },
          ]);
          expect(String(exported['misplaced'])).toContain('its signed body describes another graph');
        } else {
          refused(read, 409, 'record-not-trusted');
          // Stopped at the manifest or at his own head: her graph is not even fetched.
          expect(vault.requests.slice(requestsBefore).filter((r) => r.url === anaGraph)).toEqual([]);
        }
        if (what.startsWith('a supersedes')) await expect(readChain(SEALED, mIri, KEYED, vault.fetchFn)).rejects.toBeInstanceOf(RecordUnreadable);
        // Nothing written, nothing deleted.
        expect([JSON.stringify([...vault.store].sort()) === writes, vault.deletes.length - deletes]).toEqual([true, 0]);
      }
    } finally {
      vault.store.set(MANIFEST, original);
    }
    // Her own reads are untouched, and so are his once the manifest is back.
    ok(await act(keyed, 'pev.export_record', W.ana, { attemptIri: V['attempt'] }, {}, on));
    expect((ok(await act(keyed, 'pev.export_record', W.mallory, { attemptIri: mIri }, {}, on))['versions'] as Out[]).length).toBe(2);
  }, SLOW);

  it('redaction deletes the sealed graphs it followed from the descriptors, and the redacted head is sealed too', async () => {
    // Searched as a key holder sees the pod (every envelope opened), her lines are there before.
    expect(DEMO_LINES.ana.every((line) => operatorPlaintext(vault.store, SEALED, RECORD_KEY).text.includes(line))).toBe(true);
    const v = ok(await act(keyed, 'pev.get_attempt', W.ana, { attemptIri: V['attempt'] }, {}, on));
    const n = (v['versions'] as Out[]).length;
    const deletesBefore = vault.deletes.length;
    const r = ok(await act(keyed, 'pev.redact_attempt', W.ana, { attemptIri: V['attempt'], target: v['currentTarget'] }, {}, on));
    expect([r['state'], r['graphsDeleted'], r['graphsStillPresent']]).toEqual(['redacted', n, []]);
    const deleted = vault.deletes.slice(deletesBefore);
    expect([deleted.length, deleted.every((u) => u.endsWith('-graph.envelope.jose.json'))]).toEqual([n, true]);
    const chain = await readChain(SEALED, V['attempt']!, KEYED, vault.fetchFn);
    const head = chain[chain.length - 1]!;
    expect([chain.filter((x) => isDeleted(x)).length, !isDeleted(head) && head.sealed && isTrusted(head)]).toEqual([n, true]);
    // ...and gone after, in the clear or encrypted, with every envelope left still opening.
    const seen = operatorPlaintext(vault.store, SEALED, RECORD_KEY);
    expect(seen.unopened).toEqual([]);
    for (const line of DEMO_LINES.ana) expect(seen.text.includes(line), line).toBe(false);
  }, SLOW);

  /** An operator pod written first without the key and then with it, on the same vault. */
  const LEGACY = 'https://legacy-pod.example.test/practice/';
  const onLegacy = { pod: LEGACY };
  const legacyDeps: Partial<PevDeps> = { fetchFn: vault.fetchFn, holderFetchFn: vault.fetchFn, defaultPodUrl: LEGACY };
  const plainL = make({ ...legacyDeps, model: scriptedPracticeModel() });
  const keyedL = make({ ...legacyDeps, recordKey: RECORD_KEY, model: scriptedPracticeModel() });

  it('attempts started before the key keep their plain IRI and stay the learner\'s; new ones are keyed and counted after them', async () => {
    for (const [who, role] of [[W.author, 'author'], [W.reviewer, 'reviewer'], [W.reviewer2, 'reviewer']] as const) {
      ok(await act(plainL, 'pev.register_role', W.admin, { address: who.address, role, change: 'add' }, {}, onLegacy));
    }
    const p = ok(await act(plainL, 'pev.author_scenario', W.author, { scenario: demoScenarioInput('missed-deadline', 2), status: 'published', draftAssistance: { used: false } }, {}, onLegacy));
    ok(await act(plainL, 'pev.ratify_scenario', W.reviewer, { scenarioIri: p['scenarioIri'], version: 1, scenarioHash: p['scenarioHash'] }, {}, onLegacy));
    const sIri = String(p['scenarioIri']);
    V['legacyScenario'] = sIri;
    // Ben starts before the key: the plain hash of his address.
    const env = await envelopeFor(W.ben, 'pev.start_attempt', { scenarioIri: sIri, scenarioVersion: 1, coached: false }, onLegacy);
    const first = ok((await plainL['pev.start_attempt']!({ envelope: env })) as Out);
    expect([first['attemptIri'], first['attemptNumber']]).toEqual([`urn:pev:attempt:${attemptKey(LEGACY, sIri, W.ben.address)}-1`, 1]);
    // The keyed bridge still finds it by its plain key: the same start envelope does not start a second attempt...
    refused((await keyedL['pev.start_attempt']!({ envelope: env })) as Out, 409, 'envelope-already-used');
    // ...and his next attempt is keyed and numbered after it.
    const second = ok(await act(keyedL, 'pev.start_attempt', W.ben, { scenarioIri: sIri, scenarioVersion: 1, coached: false }, {}, onLegacy));
    expect([second['attemptIri'], second['attemptNumber']])
      .toEqual([`urn:pev:attempt:${attemptKey(LEGACY, sIri, W.ben.address, attemptIriSecret(RECORD_KEY))}-2`, 2]);
    const mine = ok(await act(keyedL, 'pev.get_attempt', W.ben, {}, {}, onLegacy));
    expect((mine['attempts'] as Out[]).map((a) => [a['attemptIri'], a['attemptNumber']]).sort())
      .toEqual([[first['attemptIri'], 1], [second['attemptIri'], 2]].sort());
    const old = ok(await act(keyedL, 'pev.get_attempt', W.ben, { attemptIri: first['attemptIri'] }, {}, onLegacy));
    expect([old['state'], old['attemptNumber']]).toEqual(['in-conversation', 1]);
  }, SLOW);

  it('a scenario head sealed to another key is not "not ratified": the projection is refused naming PEV_RECORD_KEY and nothing is written', async () => {
    const sIri = V['legacyScenario']!;
    // Ana's attempt on the ratified, plaintext version 1, reviewed before the key was set.
    const a = ok(await act(plainL, 'pev.start_attempt', W.ana, { scenarioIri: sIri, scenarioVersion: 1, coached: false }, {}, onLegacy));
    const iri = String(a['attemptIri']);
    for (const [k, turnIndex] of [[0, 1], [1, 3], [2, 5]] as const) ok(await act(plainL, 'pev.say', W.ana, { attemptIri: iri, turnIndex, text: DEMO_LINES.ana[k] }, {}, onLegacy));
    ok(await act(plainL, 'pev.end_conversation', W.ana, { attemptIri: iri, turnIndex: 7 }, {}, onLegacy));
    const j = ok(await act(plainL, 'pev.judge_attempt', W.ana, { attemptIri: iri }, {}, onLegacy));
    const lv = levels([['specific-observation', 'specific'], ['asks-their-view', 'first'], ['agrees-next-step', 'owner-and-date', 'Sam owns the status note and Tuesday 10am is the date; the second quote is not in the transcript.']]);
    const o = ok(await act(plainL, 'pev.override_attempt', W.reviewer2, { attemptIri: iri, target: j['currentTarget'], levels: lv, sawJudgeLevelsFirst: true }, {}, onLegacy));
    expect(o['projectable']).toBe(true);
    // The author saves version 2 as a draft with the key set: the scenario's head is now sealed.
    const md = demoScenarioInput('missed-deadline', 2) as Out;
    ok(await act(keyedL, 'pev.author_scenario', W.author, { scenario: { ...md, title: `${String(md['title'])} (revised)` }, status: 'draft', basedOnVersion: 1, draftAssistance: { used: false } }, {}, onLegacy));
    const before = JSON.stringify([...vault.store].sort());
    for (const [h, hasKey] of [[make({ ...legacyDeps, recordKey: OTHER_KEY }), true], [make(legacyDeps), false]] as const) {
      const x = refused(await act(h, 'pev.project_attempt', W.ana, { attemptIri: iri, format: 'xapi' }, {}, onLegacy), 409, 'record-not-trusted');
      expect(x['iep:resolvedBy']).toEqual({ env: 'PEV_RECORD_KEY' });
      expect(String(x['error'])).toContain(hasKey ? 'sealed to a record key this bridge does not hold' : 'this bridge has no record key');
      expect(x['skipAudit']).toBeUndefined();
      // Reading the attempt says the same, rather than "rubric not ratified".
      refused(await act(h, 'pev.get_attempt', W.ana, { attemptIri: iri }, {}, onLegacy), 409, 'record-not-trusted');
    }
    expect(JSON.stringify([...vault.store].sort())).toBe(before);
    // The bridge holding the key reads the sealed head, finds version 1 ratified, and projects.
    const y = ok(await act(keyedL, 'pev.project_attempt', W.ana, { attemptIri: iri, format: 'xapi' }, {}, onLegacy));
    expect(y['practiceEvidence']).toBe(true);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Source: a success never says no
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('the handlers decline only through refuse(), and a success never reads as a decline', () => {
  it('every answer literal in handlers.ts is a refuse(…) or carries no decline word, and no key is named reason', () => {
    const file = fileURLToPath(new URL('../bridge/handlers.ts', import.meta.url));
    const src = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const DECLINE = /\b(error|reason|refused|denied|forbidden|unauthori[sz]ed|invalid|pending|rejected|conflict|unavailable)\b/i;
    const answers: ts.ObjectLiteralExpression[] = [];
    const reasonKeys: number[] = [];
    const visit = (n: ts.Node): void => {
      let e: ts.Expression | undefined;
      if (ts.isReturnStatement(n)) e = n.expression;
      else if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) e = n.body;
      while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e))) e = e.expression;
      if (e && ts.isObjectLiteralExpression(e)) answers.push(e);
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'reason') reasonKeys.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const successes = answers.filter((o) => !/refuse\s*\(/.test(o.getText(sf)));
    expect(successes.length).toBeGreaterThan(60);
    const offenders: string[] = [];
    for (const o of successes) {
      const strings: string[] = [];
      const collect = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) strings.push(n.text);
        if (ts.isTemplateExpression(n)) strings.push(n.head.text, ...n.templateSpans.map((x) => x.literal.text));
        if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) strings.push(n.name.text);
        ts.forEachChild(n, collect);
      };
      collect(o);
      const hit = strings.find((x) => DECLINE.test(x));
      if (hit !== undefined) offenders.push(`line ${sf.getLineAndCharacterOfPosition(o.getStart(sf)).line + 1}: ${hit}`);
    }
    expect(offenders).toEqual([]);
    expect(reasonKeys).toEqual([]);
    expect(src).not.toMatch(/kind:\s*'refusal'|'iep:refusalStatus'\s*:/);
  });
});
