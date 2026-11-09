/**
 * No answer to a chat assistant carries a scored scenario's stakes: each criterion's weight, each
 * level's value, the pass rule (minPercent, requiredLevels), the author's reason for it, and every
 * result worked out from them (points, percent, meetsPassRule, unmet requirements, closeness to
 * the pass mark). The web app keeps reading them.
 *
 * Who is asking is read from what the Interego relay signed: the agent inside its signed payload,
 * which it takes from the signed-in session. This bridge's web app signs in as an OAuth client the
 * relay names `practice-evidence`, so its agent is `practice-evidence-<user>`; Claude's is
 * `claude-<user>`, ChatGPT's `chatgpt-<user>`, any other client's its own name. Every read is asked
 * twice for every role (learner, author, reviewer, admin, judge, judge and reviewer at once): from
 * the person's chat agent, which must get no stakes, and from the person's web-app agent, which
 * must. A request nobody signed gets none; nothing a caller adds to a request makes it the web app.
 *
 * The relay is played by a generated wallet signing the way its `sign_request` does (an EIP-191
 * signature over `sha256:<hex sha256 of the exact JSON text>`), dropping a caller's own `agent_id`
 * as it does. No network: the pod is an in-memory double on a reserved `.test` host, DID documents
 * come from a map, and the model is the scripted demo model.
 */
import { describe, it, expect } from 'vitest';
import { importWallet, sha256, sha256Hex, signMessageRaw, type Wallet } from '@interego/core';
import { createPevHandlers, type PevDeps } from '../bridge/handlers.js';
import { DEMO_LINES, demoKey, demoScenarioInput, inMemoryPod, scriptedPracticeModel } from '../demo/run.js';
import { PEV_ACTION, toolNameOf } from '../src/ontology.js';
import { signEnvelope } from '../src/records.js';
import { STAKES_WITHHELD } from '../src/stakes.js';

type Out = Record<string, unknown>;
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SLOW = 240_000;
const POD = 'https://stakes-pod.example.test/practice/';
const IDH = 'identity.example.test';
const pod = inMemoryPod();
const wallet = (name: string, type: 'human' | 'agent' = 'human'): Wallet => importWallet(`0x${sha256(`pev-stakes-test:${name}`)}`, type, name);
const RELAY = wallet('relay', 'agent');
const MALLORY = wallet('mallory');
/** A person who signs with a key she holds (a wallet in the web app, or her own script). */
const KEY_REVIEWER = wallet('key-reviewer');

let n = 0;
const nonce = (): string => `stakes-nonce-${String(++n).padStart(8, '0')}`;

// ── People, each with a web-app agent and chat agents, as the identity host names them ───────────

const docs = new Map<string, unknown>();
const userDid = (id: string): string => `did:web:${IDH}:users:${id}`;
const agent = (slug: string, controller: string): string => {
  const id = `did:web:${IDH}:agents:${slug}`;
  docs.set(`https://${IDH}/agents/${slug}/did.json`, { '@context': ['https://www.w3.org/ns/did/v1'], id, controller });
  return id;
};
interface Person { readonly did: string; readonly web: string; readonly claude: string; readonly chatgpt: string }
const person = (id: string): Person => {
  const did = userDid(id);
  return { did, web: agent(`practice-evidence-${id}`, did), claude: agent(`claude-${id}`, did), chatgpt: agent(`chatgpt-${id}`, did) };
};
const P = {
  admin: person('u-pk-00000000aa01'), author: person('u-pk-00000000bb02'), reviewer: person('u-pk-00000000cc03'),
  reviewer2: person('u-pk-00000000cc04'), learner: person('u-pk-00000000dd05'), judge: person('u-pk-00000000ee06'),
  judgeReviewer: person('u-pk-00000000ff07'),
};

const base: PevDeps = {
  platformWallet: importWallet(demoKey('platform'), 'agent', 'pev-platform'), platformKeyKind: 'demo-fixture',
  fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: POD, deploymentUrl: 'https://bridge.example.test',
  adminDids: [P.admin.did], model: scriptedPracticeModel(), nonce,
  relayDelegation: {
    relayAddresses: [RELAY.address], identityHost: IDH,
    fetchDidDocument: async (url) => { if (!docs.has(url)) throw new Error('the identity host answered HTTP 404'); return docs.get(url); },
  },
};
const H = createPevHandlers(base) as Handlers;
/** The same bridge with PEV_CHAT_AGENTS_DECIDE=1, so a chat agent may review. */
const DECIDE = createPevHandlers({ ...base, chatAgentsDecide: true }) as Handlers;

const actionOf = (tool: string): string => {
  const a = Object.values(PEV_ACTION).find((x) => toolNameOf(x) === tool);
  if (!a) throw new Error(`no action for ${tool}`);
  return a;
};

/** What the relay posts for an agent: the caller's fields (its own agent_id and underscore keys dropped), then the session's. */
async function relayPair(agentId: string, tool: string, fields: Out = {}, by: Wallet = RELAY): Promise<Out> {
  const payload: Out = { v: 1, action: actionOf(tool), nonce: nonce(), pod_url: POD, ...fields };
  const reserved = new Set(['agent_id', 'timestamp', 'subject_pod_url', 'payload']);
  const safe = Object.fromEntries(Object.entries(payload).filter(([k]) => !k.startsWith('_') && !reserved.has(k)));
  const sp = JSON.stringify({ ...safe, agent_id: agentId, subject_pod_url: 'https://pods.example.test/self/', timestamp: new Date().toISOString() });
  return { _signed_payload: sp, _signature: await signMessageRaw(by, `sha256:${sha256Hex(sp)}`) };
}
async function ract(h: Handlers, tool: string, agentId: string, fields: Out = {}, extra: Out = {}): Promise<Out> {
  return (await h[tool]!({ ...(await relayPair(agentId, tool, fields)), ...extra })) as Out;
}
async function kact(h: Handlers, tool: string, w: Wallet, fields: Out = {}): Promise<Out> {
  const envelope = await signEnvelope(w, { v: 1, action: actionOf(tool), issuedAt: new Date().toISOString(), nonce: nonce(), podUrl: POD, ...fields });
  return (await h[tool]!({ envelope })) as Out;
}

function ok(r: Out): Out {
  expect(r['kind'], `expected success, got ${JSON.stringify(r).slice(0, 500)}`).toBeUndefined();
  return r;
}

// ── What counts as a stake ───────────────────────────────────────────────────────────────────────

/**
 * Keys that carry a stake, wherever they sit in an answer. (An assessment's `perCriterion` is caught by the weight, value
 * and points inside it; the results' `perCriterion` is level counts.)
 */
const STAKE_KEYS = new Set([
  'weight', 'value', 'passRule', 'minPercent', 'requiredLevels', 'passGateWhy', 'points', 'maxPoints', 'percent', 'percentTenths',
  'meetsPassRule', 'unmetRequirements', 'provisionalPercent', 'finalPercent', 'finalMeetsPassRule', 'nearThreshold', 'score', 'success',
]);
/** The same names inside text: a record's JSON as its graph holds it (escaped), or a JSON string an answer carries. */
const STAKE_TEXT = /weight\\?"\s*:|passRule|minPercent|requiredLevels|passGateWhy|meetsPassRule|percentTenths|maxPoints|unmetRequirements|nearThreshold/;

/** Every place in an answer that carries a stake (a key, or a stake's name inside a text value). */
function stakesIn(v: unknown, at = '$', found: string[] = []): string[] {
  if (typeof v === 'string') {
    if (STAKE_TEXT.test(v)) found.push(`${at} (in text)`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => stakesIn(x, `${at}[${i}]`, found));
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (STAKE_KEYS.has(k)) found.push(`${at}.${k}`);
      stakesIn(x, `${at}.${k}`, found);
    }
  }
  return found;
}

/** A chat agent's answer: a success, no stake anywhere, and the mark that says what was left out. */
function chatAnswer(r: Out, what: string): Out {
  ok(r);
  expect(stakesIn(r), what).toEqual([]);
  expect(r['stakesWithheld'], what).toBe(STAKES_WITHHELD);
  return r;
}

/** A web-app answer: a success that carries stakes, and no mark. */
function webAnswer(r: Out, what: string): Out {
  ok(r);
  expect(stakesIn(r).length, `${what}: the web app reads the stakes`).toBeGreaterThan(0);
  expect(r['stakesWithheld'], what).toBeUndefined();
  return r;
}

/** Every chat agent of a person: Claude, ChatGPT, and any other client the relay names after itself. */
const chats = (p: Person): string[] => {
  const id = p.did.slice(p.did.lastIndexOf(':') + 1);
  // A client that calls itself something with the web app's name inside it is still not the web app.
  return [p.claude, p.chatgpt, agent(`my-practice-evidence-${id}`, p.did), agent(`mcp-client-${id}`, p.did)];
};

const X: Record<string, string> = {};

// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('answers to a chat assistant leave out the scoring stakes; the web app reads them', () => {
  it('sets up a scored scenario, an attempt, a bridge judgment and a judge\'s own, by people signed in with Interego', async () => {
    for (const [who, role] of [[P.author, 'author'], [P.reviewer, 'reviewer'], [P.reviewer2, 'reviewer'], [P.learner, 'learner'],
      [P.judge, 'judge'], [P.judgeReviewer, 'judge'], [P.judgeReviewer, 'reviewer']] as const) {
      ok(await ract(H, 'pev.register_role', P.admin.web, { address: who.did, role, change: 'add' }));
    }
    ok(await ract(H, 'pev.register_role', P.admin.web, { address: KEY_REVIEWER.address, role: 'reviewer', change: 'add' }));
    const scenario = demoScenarioInput('missed-deadline', 2);
    expect(scenario['assessmentUse']).toBe('pass-gate');
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario, status: 'published', draftAssistance: { used: false } }));
    X['sc'] = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: X['sc'], version: 1, scenarioHash: pub['scenarioHash'] }));

    // The learner practises from Claude: every answer on the way is about the conversation, never the stakes.
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: X['sc'], scenarioVersion: 1, coached: false }));
    X['a'] = String(start['attemptIri']);
    let turn = 1;
    for (const text of DEMO_LINES.ana) {
      const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: X['a'], turnIndex: turn, text }));
      expect(stakesIn(said)).toEqual([]);
      turn = Number(said['nextTurnIndex']);
      if (said['ended'] === true) break;
    }
    const view = ok(await ract(H, 'pev.get_attempt', P.learner.web, { attemptIri: X['a'] }));
    if (view['state'] === 'in-conversation') ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: X['a'], turnIndex: turn }));

    // The bridge's model judges at the learner's request from her chat: the judgment's levels and quotes, no result.
    const judged = chatAnswer(await ract(H, 'pev.judge_attempt', P.learner.claude, { attemptIri: X['a'] }), 'judge_attempt from Claude');
    const counted = judged['provisional'] as Out;
    expect([counted['use'], Array.isArray(counted['levels'])]).toEqual(['pass-gate', true]);
    expect(((judged['judgment'] as Out)['criteria'] as Out[]).every((c) => typeof c['levelId'] === 'string' && Array.isArray(c['quotes']))).toBe(true);

    // An appointed judge's own assistant, as the copied judge message has it do: the packet, then the save.
    for (const judge of [P.judge, P.judgeReviewer]) {
      const packet = ok(await ract(H, 'pev.judge_packet', judge.claude, { attemptIri: X['a'] }));
      expect(stakesIn(packet), 'the judge packet').toEqual([]);
      expect(packet['yourAssessment']).toBeNull();
      const user = String((packet['request'] as Out)['user']);
      const rubric = JSON.parse(user.slice(user.indexOf('\n') + 1, user.indexOf('\n\nThe transcript:'))) as { criteria: { criterionId: string; levels: { id: string }[] }[] };
      const binding = packet['binding'] as Out;
      const saved = ok(await ract(H, 'pev.record_judgment', judge.claude, {
        attemptIri: X['a'], ...binding,
        judgment: { criteria: rubric.criteria.map((c) => ({ criterionId: c.criterionId, level: c.levels[0]!.id, quotes: [], rationale: 'Nothing the learner said reaches a higher level.' })) },
        judgeDisclosure: { provider: 'Anthropic', model: 'claude-test', usedPacketPrompt: true },
      }));
      expect([stakesIn(saved), saved['recorded']]).toEqual([[], true]);
      expect(ok(await ract(H, 'pev.judge_packet', judge.claude, { attemptIri: X['a'] }))['yourAssessment']).toMatchObject({ saved: true });
    }
  }, SLOW);

  it('the scenario list: unsigned or from any chat agent of any role, the rubric in words; from the web app or a key a person holds, the stakes', async () => {
    const plain = chatAnswer((await H['pev.list_scenarios']!({})) as Out, 'unsigned list');
    const listed = (plain['scenarios'] as Out[]).find((s) => s['scenarioIri'] === X['sc'])!;
    // What a chat still gets: whether it is scored, and every criterion and level by name, with its words.
    expect(listed['assessmentUse']).toBe('pass-gate');
    const rubric = listed['rubric'] as { criteria: { id: string; title: string; levels: { id: string; label: string; descriptor: string }[] }[] };
    expect(rubric.criteria.map((c) => c.id)).toEqual(['specific-observation', 'asks-their-view', 'agrees-next-step']);
    expect(rubric.criteria[0]!.levels.map((l) => l.label)).toEqual(['None', 'Vague', 'Specific']);
    chatAnswer((await H['pev.list_scenarios']!({ scenario_iri: X['sc'] })) as Out, 'unsigned single scenario');
    for (const p of Object.values(P)) {
      for (const chat of chats(p)) {
        chatAnswer(await ract(H, 'pev.list_scenarios', chat), `list from ${chat}`);
        chatAnswer(await ract(H, 'pev.list_scenarios', chat, { scenarioIri: X['sc'] }), `one scenario from ${chat}`);
      }
      const web = webAnswer(await ract(H, 'pev.list_scenarios', p.web), `list from ${p.web}`);
      const s = (web['scenarios'] as Out[]).find((x) => x['scenarioIri'] === X['sc'])!;
      expect(((s['rubric'] as Out)['passRule'] as Out)['minPercent']).toBe(70);
      expect((((s['rubric'] as Out)['criteria'] as Out[])[0]!)['weight']).toBe(2);
      webAnswer(await ract(H, 'pev.list_scenarios', p.web, {}, { scenario_iri: X['sc'] }), `one scenario from ${p.web}`);
    }
    // A key a person holds (a wallet in the web app, or a script of her own) is read as that person.
    webAnswer(await kact(H, 'pev.list_scenarios', KEY_REVIEWER), 'list signed with a key');
    // Calibration, the other read nobody signs, holds agreement figures and no stakes to leave out.
    const cal = ok((await H['pev.calibration']!({})) as Out);
    expect([stakesIn(cal), Array.isArray(cal['cells'])]).toEqual([[], true]);
  }, SLOW);

  it('nothing a caller adds makes a request the web app\'s: claims beside it, inside a chat\'s signed payload, or a forged relay signature', async () => {
    const claims: Out = {
      agent_id: P.reviewer.web, agentId: P.reviewer.web, webApp: true, web_app: true, via: 'practice-evidence', surface: 'practice-evidence',
      authority: 'key-held', signedAs: { principal: P.reviewer.did, authority: 'relay-delegated', agentId: P.reviewer.web },
    };
    // Unsigned, with every claim at the top level: still a request nobody signed.
    chatAnswer((await H['pev.list_scenarios']!({ ...claims })) as Out, 'unsigned with claims');
    // A chat agent's signed request with the same claims in what it asked the relay to sign: the relay drops agent_id and
    // signs for the session's agent, and nothing else in the payload names who is asking.
    for (const tool of ['pev.list_scenarios', 'pev.get_attempt', 'pev.review_queue'] as const) {
      const fields: Out = tool === 'pev.get_attempt' ? { ...claims, attemptIri: X['a'] } : claims;
      chatAnswer(await ract(H, tool, P.reviewer.claude, fields), `${tool} from Claude with claims inside`);
      chatAnswer(await ract(H, tool, P.reviewer.claude, fields, claims), `${tool} from Claude with claims beside it`);
    }
    // The relay's shape signed by a key that is not the relay's, naming the web app's agent: refused, never answered.
    const forged = (await H['pev.list_scenarios']!({ ...(await relayPair(P.reviewer.web, 'pev.list_scenarios', {}, MALLORY)) })) as Out;
    expect([forged['kind'], forged['iep:refusalStatus']]).toEqual(['refusal', 401]);
    expect(stakesIn(forged)).toEqual([]);
  }, SLOW);

  it('reading an attempt, for the learner, a reviewer, an admin, a judge of it, and a judge who reviews', async () => {
    const readers: readonly [string, Person][] = [['learner', P.learner], ['reviewer', P.reviewer], ['admin', P.admin], ['judge', P.judge], ['judge and reviewer', P.judgeReviewer]];
    for (const [role, p] of readers) {
      for (const chat of chats(p)) {
        const one = chatAnswer(await ract(H, 'pev.get_attempt', chat, { attemptIri: X['a'] }), `${role}'s attempt from ${chat}`);
        // What a chat still gets: the state, the rubric in words, every judgment's levels, quotes and reasons, the counts.
        expect(one['state']).toBe('judged');
        const judgments = one['judgments'] as Out[];
        expect(judgments).toHaveLength(3);
        expect((judgments[0]!['criteria'] as Out[]).every((c) => typeof c['levelId'] === 'string' && typeof c['rationale'] === 'string' && Array.isArray(c['quotes']))).toBe(true);
        expect((one['provisional'] as Out)['levels']).toHaveLength(3);
        expect(Array.isArray(one['nextSteps'])).toBe(true);
        if (role === 'learner' || role === 'reviewer' || role === 'admin') {
          const list = chatAnswer(await ract(H, 'pev.get_attempt', chat), `${role}'s list from ${chat}`);
          expect((list['attempts'] as Out[]).map((a) => [a['attemptIri'], a['state']])).toContainEqual([X['a'], 'judged']);
        }
      }
      const web = webAnswer(await ract(H, 'pev.get_attempt', p.web, { attemptIri: X['a'] }), `${role}'s attempt from the web app`);
      expect(typeof (web['provisional'] as Out)['percent']).toBe('string');
      expect(((web['rubric'] as Out)['passRule'] as Out)['minPercent']).toBe(70);
      if (role === 'learner' || role === 'reviewer' || role === 'admin') {
        const list = webAnswer(await ract(H, 'pev.get_attempt', p.web), `${role}'s list from the web app`);
        expect((list['attempts'] as Out[]).find((a) => a['attemptIri'] === X['a'])!['provisionalPercent']).toBeDefined();
      }
    }
    webAnswer(await kact(H, 'pev.get_attempt', KEY_REVIEWER, { attemptIri: X['a'] }), 'an attempt signed with a key');
  }, SLOW);

  it('the review queue, for a reviewer and a judge who reviews: ranked without closeness to the pass mark', async () => {
    for (const p of [P.reviewer, P.judgeReviewer]) {
      for (const chat of chats(p)) {
        const q = chatAnswer(await ract(H, 'pev.review_queue', chat), `queue from ${chat}`);
        const entries = q['entries'] as Out[];
        // The judge who reviews judged this attempt, so it is not hers to review; the reviewer's queue holds it.
        if (p === P.reviewer) {
          const e = entries.find((x) => x['attemptIri'] === X['a'])!;
          expect(e['state']).toBe('judged');
          expect((e['rubric'] as Out)['criteria']).toHaveLength(3);
          expect((e['agreement'] as Out[]).map((x) => (x['levels'] as string[]).length)).toEqual([3, 3, 3]);
          // The priority is the sum of the factors it shows, times the weights it shows: none of them is the pass mark.
          const why = e['why'] as Record<string, number>;
          const weights = q['weights'] as Record<string, number>;
          const sum = Object.entries(weights).reduce((t, [k, w]) => t + w * (why[k] ?? 0), 0);
          expect(Number(e['priority'])).toBeCloseTo(sum, 3);
        } else {
          expect(entries.map((x) => x['attemptIri'])).not.toContain(X['a']);
        }
      }
      const web = webAnswer(await ract(H, 'pev.review_queue', p.web), `queue from ${p.web}`);
      expect((web['weights'] as Out)['nearThreshold']).toBe(0.15);
    }
    const keyQueue = webAnswer(await kact(H, 'pev.review_queue', KEY_REVIEWER), 'queue signed with a key');
    expect((keyQueue['entries'] as Out[]).find((x) => x['attemptIri'] === X['a'])!['provisional']).toMatchObject({ use: 'pass-gate', minPercent: 70 });
  }, SLOW);

  it('a review from a chat agent the operator lets decide answers with the levels it set, not the result', async () => {
    const view = ok(await ract(H, 'pev.get_attempt', P.reviewer.web, { attemptIri: X['a'] }));
    const primary = (view['judgments'] as { criteria: { criterionId: string; levelId: string }[] }[])[0]!;
    const rubric = view['rubric'] as { criteria: { id: string; levels: { id: string }[] }[] };
    const levels = rubric.criteria.map((c, i) => {
      const was = primary.criteria.find((x) => x.criterionId === c.id)!.levelId;
      return { criterionId: c.id, levelId: i === 0 ? c.levels.find((l) => l.id !== was)!.id : was, why: 'Set by the reviewer, who read the whole transcript.' };
    });
    const o = chatAnswer(await ract(DECIDE, 'pev.override_attempt', P.reviewer.chatgpt, { attemptIri: X['a'], target: view['currentTarget'], levels, sawJudgeLevelsFirst: true }),
      'an override from ChatGPT');
    expect(o['state']).toBe('overridden');
    expect((o['assessment'] as Out)['levels']).toEqual(levels.map((l) => ({ criterionId: l.criterionId, levelId: l.levelId, levelIndex: expect.any(Number) as number })));
    expect(o['finalLevels']).toHaveLength(3);
  }, SLOW);

  it('after the review: the result, results, the statement and the record leave out the stakes for every chat, and carry them for the web app', async () => {
    for (const [role, p] of [['learner', P.learner], ['reviewer', P.reviewer2], ['admin', P.admin], ['judge', P.judge], ['judge and reviewer', P.judgeReviewer]] as const) {
      for (const chat of chats(p)) {
        const one = chatAnswer(await ract(H, 'pev.get_attempt', chat, { attemptIri: X['a'] }), `${role}'s reviewed attempt from ${chat}`);
        expect([one['state'], (one['finalAssessment'] as Out)['levels']]).toEqual(['overridden', expect.any(Array)]);
        expect((one['reviews'] as Out[])[0]!['finalLevels']).toHaveLength(3);
      }
      const web = webAnswer(await ract(H, 'pev.get_attempt', p.web, { attemptIri: X['a'] }), `${role}'s reviewed attempt from the web app`);
      expect(typeof (web['finalAssessment'] as Out)['meetsPassRule']).toBe('boolean');
    }
    for (const chat of chats(P.learner)) {
      const list = chatAnswer(await ract(H, 'pev.get_attempt', chat), `the learner's list from ${chat}`);
      expect((list['attempts'] as Out[]).find((a) => a['attemptIri'] === X['a'])!['state']).toBe('overridden');
    }
    const webList = webAnswer(await ract(H, 'pev.get_attempt', P.learner.web), 'the learner\'s list from the web app');
    expect(typeof (webList['attempts'] as Out[]).find((a) => a['attemptIri'] === X['a'])!['finalMeetsPassRule']).toBe('boolean');

    // Results, for an author, a reviewer, an admin and a judge who reviews: level counts, never how many met the pass mark.
    for (const p of [P.author, P.reviewer2, P.admin, P.judgeReviewer]) {
      for (const chat of chats(p)) {
        const r = chatAnswer(await ract(H, 'pev.scenario_results', chat, { scenarioIri: X['sc'] }), `results from ${chat}`);
        expect([(r['final'] as Out)['reviewedAttempts'], 'meetsPassRule' in (r['final'] as Out)]).toEqual([1, false]);
        expect(((r['final'] as Out)['perCriterion'] as Out[]).map((c) => c['criterionId'])).toEqual(['specific-observation', 'asks-their-view', 'agrees-next-step']);
      }
      const web = webAnswer(await ract(H, 'pev.scenario_results', p.web, { scenarioIri: X['sc'] }), `results from ${p.web}`);
      expect((web['final'] as Out)['meetsPassRule']).toMatchObject({ of: 1 });
    }

    // The learner's statement and record: from a chat, where they were recorded; from the web app, the bytes.
    for (const chat of [P.learner.claude, P.learner.chatgpt]) {
      const st = chatAnswer(await ract(H, 'pev.project_attempt', chat, { attemptIri: X['a'], format: 'xapi' }), `a statement from ${chat}`);
      expect([st['statement'], typeof st['statementId'], typeof st['auditDescriptorUrl']]).toEqual([null, 'string', 'string']);
      const ex = chatAnswer(await ract(H, 'pev.export_record', chat, { attemptIri: X['a'] }), `the record from ${chat}`);
      const versions = ex['versions'] as Out[];
      expect(versions.length).toBeGreaterThan(3);
      expect(versions.every((v) => v['graphTrig'] === null && typeof v['descriptorTurtle'] === 'string')).toBe(true);
    }
    const st = webAnswer(await ract(H, 'pev.project_attempt', P.learner.web, { attemptIri: X['a'], format: 'xapi' }), 'a statement from the web app');
    expect(typeof ((st['statement'] as Out)['result'] as Out)['success']).toBe('boolean');
    const ex = webAnswer(await ract(H, 'pev.export_record', P.learner.web, { attemptIri: X['a'] }), 'the record from the web app');
    expect((ex['versions'] as Out[]).every((v) => typeof v['graphTrig'] === 'string')).toBe(true);
    // A reviewer's and an admin's statement too.
    chatAnswer(await ract(H, 'pev.project_attempt', P.reviewer2.claude, { attemptIri: X['a'], format: 'cmi5' }), 'a statement from a reviewer\'s Claude');
    chatAnswer(await ract(H, 'pev.project_attempt', P.admin.chatgpt, { attemptIri: X['a'], format: 'xapi' }), 'a statement from an admin\'s ChatGPT');
  }, SLOW);

  it('the learner\'s other acts from a chat answer without stakes: a copy to her own pod, a contest, removing the transcript', async () => {
    const copy = ok(await ract(H, 'pev.holder_copy', P.learner.claude, { attemptIri: X['a'], targetPodUrl: 'https://learner-pod.example.test/me/' }));
    expect([stakesIn(copy), (copy['copies'] as Out[]).length > 3]).toEqual([[], true]);
    const view = ok(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: X['a'] }));
    const contest = ok(await ract(H, 'pev.contest_review', P.learner.chatgpt, { attemptIri: X['a'], target: view['currentTarget'], why: 'The second criterion missed what I asked first.' }));
    expect([stakesIn(contest), contest['state']]).toEqual([[], 'contested']);
    const again = ok(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: X['a'] }));
    const gone = ok(await ract(H, 'pev.redact_attempt', P.learner.claude, { attemptIri: X['a'], target: again['currentTarget'] }));
    expect([stakesIn(gone), gone['state']]).toEqual([[], 'redacted']);
    // Redacted, the attempt keeps its levels, and a chat still reads them without the stakes.
    const kept = chatAnswer(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: X['a'] }), 'the redacted attempt from Claude');
    expect(kept['state']).toBe('redacted');
  }, SLOW);

  it('an author saving the same scenario again from a chat gets it back in words; from the web app, whole', async () => {
    const same = { scenario: demoScenarioInput('missed-deadline', 2), status: 'published', basedOnVersion: 1, draftAssistance: { used: false } };
    const fromChat = chatAnswer(await ract(H, 'pev.author_scenario', P.author.claude, same), 'the same scenario saved from Claude');
    expect([fromChat['changed'], (fromChat['rubric'] as Out)['criteria']]).toEqual([false, expect.any(Array)]);
    const fromWeb = webAnswer(await ract(H, 'pev.author_scenario', P.author.web, same), 'the same scenario saved from the web app');
    expect(fromWeb['changed']).toBe(false);
  }, SLOW);
});
