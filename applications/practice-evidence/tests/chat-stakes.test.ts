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
 * must. A request nobody signed gets none; nothing a caller adds to a request makes it the web app,
 * and a client that names itself after it (`practice-evidence-helper-<user>`) is not it. A key gets
 * them only once an admin registered it: anything can make a key, an AI assistant with a code tool
 * as well, so a key nobody registered reads none, not even on an attempt it started itself.
 *
 * Every answer that leaves the stakes out also keys the rubric's and the scenario's hashes: a bare
 * sha256 over a rubric whose words the answer carries would confirm a guess at its stakes offline.
 * No chat answer, refusals included, holds either hash or the rubric hash's first 16 hex digits.
 *
 * Acts that would hand a chat the stakes some other way are refused before they write anything:
 * a learning record of a scored attempt, a copy of its graphs to a pod the chat names, and a scored
 * scenario saved with stakes the chat could not have read (it keeps the version's own instead).
 *
 * The relay is played by a generated wallet signing the way its `sign_request` does (an EIP-191
 * signature over `sha256:<hex sha256 of the exact JSON text>`), dropping a caller's own `agent_id`
 * as it does. No network: the pod is an in-memory double on a reserved `.test` host, DID documents
 * come from a map, and the model is the scripted demo model.
 */
import { describe, it, expect } from 'vitest';
import { importWallet, sha256, sha256Hex, signMessageRaw, type Wallet } from '@interego/core';
import { createPevHandlers, type PevDeps } from '../bridge/handlers.js';
import { rubricHash, scenarioHash, coerceScenario } from '../src/practice.js';
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
/** A person who signs with a key she holds (a wallet in the web app, or her own script), registered as a reviewer. */
const KEY_REVIEWER = wallet('key-reviewer');
/** A key registered as a learner. */
const KEY_LEARNER = wallet('key-learner');
/** A key nobody registered: what an AI assistant with a code tool can make and sign with on its own. */
const FRESH = wallet('fresh-unregistered');
/** A key registered as an agent (and as a reviewer): an AI by registration. */
const KEY_AGENT = wallet('key-agent', 'agent');

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

function refused(r: Out, code: string, what: string): Out {
  expect([r['kind'], r['iep:refusalReason']], `${what}: ${JSON.stringify(r).slice(0, 300)}`).toEqual(['refusal', code]);
  return r;
}

// ── The scored scenario's own hashes, which a chat answer must never carry ────────────────────────

const SCORED = coerceScenario(demoScenarioInput('missed-deadline', 2));
if (!('value' in SCORED)) throw new Error('the demo scenario does not coerce');
/** sha256(canonicalJson(rubric)), sha256(canonicalJson(scenario)) and the rubric hash's first 16 hex (a calibration kind's). */
const RAW = { rubric: rubricHash(SCORED.value.rubric), scenario: scenarioHash(SCORED.value), prefix: rubricHash(SCORED.value.rubric).slice(0, 16) };

/** No bare rubric or scenario hash, or the rubric hash's prefix, anywhere in an answer. */
function noBareHash(r: unknown, what: string): void {
  const text = JSON.stringify(r);
  expect([text.includes(RAW.rubric), text.includes(RAW.scenario), text.includes(RAW.prefix)], `${what}: a bare hash`).toEqual([false, false, false]);
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

/**
 * A chat agent's answer: a success, no stake anywhere, no bare hash, and the mark that says what
 * was left out when it is about a scored scenario (`scored`), none when it is not.
 */
function chatAnswer(r: Out, what: string, scored = true): Out {
  ok(r);
  expect(stakesIn(r), what).toEqual([]);
  noBareHash(r, what);
  expect(r['stakesWithheld'], what).toBe(scored ? STAKES_WITHHELD : undefined);
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
  // A client that calls itself something with the web app's name inside it is still not the web app, nor is one
  // registered as "Practice Evidence Helper", whose agent starts with the web app's prefix.
  return [p.claude, p.chatgpt, agent(`my-practice-evidence-${id}`, p.did), agent(`practice-evidence-helper-${id}`, p.did), agent(`mcp-client-${id}`, p.did)];
};

/** The scored scenario as a chat reads it, to send back: no weight, level value or pass rule. */
function withoutStakes(input: Record<string, unknown>): Record<string, unknown> {
  const r = input['rubric'] as { criteria: Record<string, unknown>[] };
  return {
    ...input,
    rubric: { criteria: r.criteria.map(({ weight: _w, ...c }) => ({ ...c, levels: (c['levels'] as Record<string, unknown>[]).map(({ value: _v, ...l }) => l) })) },
  };
}

const actionsOf = (r: Out): string[] => ((r['nextActions'] ?? []) as Out[]).map((x) => String(x['toolName']));

const X: Record<string, string> = {};

// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('answers to a chat assistant leave out the scoring stakes; the web app reads them', () => {
  it('sets up a scored scenario, an attempt, a bridge judgment and a judge\'s own, by people signed in with Interego', async () => {
    for (const [who, role] of [[P.author, 'author'], [P.reviewer, 'reviewer'], [P.reviewer2, 'reviewer'], [P.learner, 'learner'],
      [P.judge, 'judge'], [P.judgeReviewer, 'judge'], [P.judgeReviewer, 'reviewer']] as const) {
      ok(await ract(H, 'pev.register_role', P.admin.web, { address: who.did, role, change: 'add' }));
    }
    ok(await ract(H, 'pev.register_role', P.admin.web, { address: KEY_REVIEWER.address, role: 'reviewer', change: 'add' }));
    ok(await ract(H, 'pev.register_role', P.admin.web, { address: KEY_LEARNER.address, role: 'learner', change: 'add' }));
    for (const role of ['reviewer', 'agent']) ok(await ract(H, 'pev.register_role', P.admin.web, { address: KEY_AGENT.address, role, change: 'add' }));
    const scenario = demoScenarioInput('missed-deadline', 2);
    expect(scenario['assessmentUse']).toBe('pass-gate');
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario, status: 'published', draftAssistance: { used: false } }));
    // The web app reads the bare hashes; they are the ones no chat answer below may hold.
    expect([pub['rubricHash'], pub['scenarioHash']]).toEqual([RAW.rubric, RAW.scenario]);
    X['sc'] = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: X['sc'], version: 1, scenarioHash: pub['scenarioHash'] }));

    // The learner practises from Claude: every answer on the way is about the conversation, never the stakes.
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: X['sc'], scenarioVersion: 1, coached: false }));
    noBareHash(start, 'start_attempt from Claude');
    expect(((start['scenario'] as Out)['rubricHash'] as string)).toMatch(/^[0-9a-f]{64}$/);
    X['a'] = String(start['attemptIri']);
    let turn = 1;
    for (const text of DEMO_LINES.ana) {
      const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: X['a'], turnIndex: turn, text }));
      expect(stakesIn(said)).toEqual([]);
      noBareHash(said, 'say from Claude');
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
      // The packet's binding pins the rubric with its hash keyed: the bare one beside the rubric's words would give the stakes away.
      noBareHash(packet, 'the judge packet');
      expect(packet['yourAssessment']).toBeNull();
      const user = String((packet['request'] as Out)['user']);
      const rubric = JSON.parse(user.slice(user.indexOf('\n') + 1, user.indexOf('\n\nThe transcript:'))) as { criteria: { criterionId: string; levels: { id: string }[] }[] };
      const binding = packet['binding'] as Out;
      const judgment = { criteria: rubric.criteria.map((c) => ({ criterionId: c.criterionId, level: c.levels[0]!.id, quotes: [], rationale: 'Nothing the learner said reaches a higher level.' })) };
      const disclosure = { provider: 'Anthropic', model: 'claude-test', usedPacketPrompt: true };
      // The bare rubric hash, a guess a chat could check one request at a time, is no binding from a chat: refused, and the refusal holds no bare hash.
      const bare = await ract(H, 'pev.record_judgment', judge.claude, { attemptIri: X['a'], ...binding, rubricHash: RAW.rubric, judgment, judgeDisclosure: disclosure });
      refused(bare, 'binding-mismatch', 'a save bound with the bare rubric hash');
      noBareHash(bare, 'the binding refusal');
      const saved = ok(await ract(H, 'pev.record_judgment', judge.claude, {
        attemptIri: X['a'], ...binding,
        judgment: { criteria: rubric.criteria.map((c) => ({ criterionId: c.criterionId, level: c.levels[0]!.id, quotes: [], rationale: 'Nothing the learner said reaches a higher level.' })) },
        judgeDisclosure: { provider: 'Anthropic', model: 'claude-test', usedPacketPrompt: true },
      }));
      expect([stakesIn(saved), saved['recorded']]).toEqual([[], true]);
      noBareHash(saved, 'the saved judgment');
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
    // A key an admin registered (a wallet in the web app, or a script of her own) is read as that person, with the bare hashes.
    for (const k of [KEY_REVIEWER, KEY_LEARNER]) {
      const keyed = webAnswer(await kact(H, 'pev.list_scenarios', k), `list signed with a ${k === KEY_LEARNER ? 'learner\'s' : 'reviewer\'s'} key`);
      expect(JSON.stringify(keyed).includes(RAW.rubric)).toBe(true);
    }
    // A key nobody registered, or one registered as an agent, is read as a chat is.
    chatAnswer(await kact(H, 'pev.list_scenarios', FRESH), 'list signed with a key nobody registered');
    chatAnswer(await kact(H, 'pev.list_scenarios', KEY_AGENT), 'list signed with a key registered as an agent');
    // Calibration, the other read nobody signs, holds agreement figures and no stakes to leave out.
    const cal = ok((await H['pev.calibration']!({})) as Out);
    expect([stakesIn(cal), Array.isArray(cal['cells'])]).toEqual([[], true]);
    noBareHash(cal, 'calibration');
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

  it('a key nobody registered, which anything can make, reads no stakes, not even on an attempt it started itself', async () => {
    // Enrolment is open, so the key may start an attempt; what it reads of it holds the levels and no stakes.
    const start = ok(await kact(H, 'pev.start_attempt', FRESH, { scenarioIri: X['sc'], scenarioVersion: 1, coached: false }));
    noBareHash(start, 'start_attempt with a fresh key');
    const own = chatAnswer(await kact(H, 'pev.get_attempt', FRESH, { attemptIri: start['attemptIri'] }), 'its own attempt, read with a fresh key');
    expect([(own['rubric'] as Out)['criteria'], 'passRule' in (own['rubric'] as Out)]).toEqual([expect.any(Array), false]);
    chatAnswer(await kact(H, 'pev.get_attempt', FRESH), 'its own attempts listed with a fresh key');
    // Its own record: the download says it is not the whole record, why, and what to do; nothing sends a web-app user to the web app.
    const ex = chatAnswer(await kact(H, 'pev.export_record', FRESH, { attemptIri: start['attemptIri'] }), 'its own record, with a fresh key');
    const versions = ex['versions'] as Out[];
    expect(versions.every((v) => v['graphTrig'] === null)).toBe(true);
    const left = ex['graphsLeftOut'] as Out;
    expect([left['versions'], left['remedy']]).toEqual([versions.length, 'register-address']);
    expect(String(left['why'])).toContain('ask your admin to register this address');
    expect((ex['verify'] as string[]).join(' ')).not.toContain('graphContent: graphTrig');
    const before = pod.store.size;
    for (const [tool, fields] of [['pev.project_attempt', { attemptIri: start['attemptIri'], format: 'xapi' }], ['pev.holder_copy', { attemptIri: start['attemptIri'], targetPodUrl: 'https://open-pod.example.test/anyone/' }]] as const) {
      const r = refused(await kact(H, tool, FRESH, fields), 'stakes-not-in-chat', `${tool} of its own scored session, with a fresh key`);
      expect([r['remedy'], String(r['error']).includes('ask your admin to register this address'), String(r['error']).includes('web app')], tool).toEqual(['register-address', true, false]);
    }
    expect(pod.store.size).toBe(before);
    // The same, registered as a learner by an admin: the stakes, as the web app reads them.
    const regd = ok(await kact(H, 'pev.start_attempt', KEY_LEARNER, { scenarioIri: X['sc'], scenarioVersion: 1, coached: false }));
    webAnswer(await kact(H, 'pev.get_attempt', KEY_LEARNER, { attemptIri: regd['attemptIri'] }), 'its own attempt, read with a registered learner key');
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
        // The judge who reviews judged this attempt, so her queue holds nothing scored, and says nothing was left out.
        const q = chatAnswer(await ract(H, 'pev.review_queue', chat), `queue from ${chat}`, p === P.reviewer);
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
    // A reviewer's key registered as an agent too is read as a chat.
    chatAnswer(await kact(H, 'pev.review_queue', KEY_AGENT), 'queue signed with a key registered as an agent');
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

    // The learner's statement: refused to a chat, before anything is written; and never offered to one.
    for (const chat of [P.learner.claude, P.learner.chatgpt, P.reviewer2.claude, P.admin.chatgpt]) {
      const before = pod.store.size;
      const st = refused(await ract(H, 'pev.project_attempt', chat, { attemptIri: X['a'], format: 'xapi' }), 'stakes-not-in-chat', `a statement from ${chat}`);
      expect([stakesIn(st), pod.store.size], `nothing written for ${chat}`).toEqual([[], before]);
      // A chat is sent to the web app, signed in with Interego.
      expect([st['remedy'], String(st['error']).includes('in the Practice Evidence web app, signed in with Interego')]).toEqual(['web-app', true]);
    }
    const kp = refused(await kact(H, 'pev.project_attempt', KEY_AGENT, { attemptIri: X['a'], format: 'xapi' }), 'stakes-not-in-chat', 'a statement for a key registered as an agent');
    expect(stakesIn(kp)).toEqual([]);
    expect([kp['remedy'], String(kp['error']).includes('registered as an agent')]).toEqual(['person-address', true]);
    const fromChat = chatAnswer(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: X['a'] }), 'the reviewed attempt, for its next acts');
    expect(actionsOf(fromChat).filter((t) => t === 'pev.project_attempt' || t === 'pev.holder_copy')).toEqual([]);
    expect(actionsOf(fromChat)).toContain('pev.export_record');
    const fromWeb = webAnswer(await ract(H, 'pev.get_attempt', P.learner.web, { attemptIri: X['a'] }), 'the reviewed attempt in the web app, for its next acts');
    expect(actionsOf(fromWeb)).toEqual(expect.arrayContaining(['pev.project_attempt', 'pev.holder_copy']));
    // Calibration's cells key their rubric hash, and its filter takes it as a cell shows it, never bare.
    const cal = ok((await H['pev.calibration']!({})) as Out);
    noBareHash(cal, 'calibration after a review');
    const cells = cal['cells'] as Out[];
    expect(cells.length).toBeGreaterThan(0);
    const shown = String(cells.find((c) => typeof c['rubricHash'] === 'string')!['rubricHash']);
    expect(((ok((await H['pev.calibration']!({ rubric_hash: shown })) as Out))['cells'] as Out[]).length).toBeGreaterThan(0);
    expect(((ok((await H['pev.calibration']!({ rubric_hash: RAW.rubric })) as Out))['cells'] as Out[]).length).toBe(0);
    // The learner's record: from a chat, the descriptors; from the web app, the bytes.
    for (const chat of [P.learner.claude, P.learner.chatgpt]) {
      const ex = chatAnswer(await ract(H, 'pev.export_record', chat, { attemptIri: X['a'] }), `the record from ${chat}`);
      const versions = ex['versions'] as Out[];
      expect(versions.length).toBeGreaterThan(3);
      expect(versions.every((v) => v['graphTrig'] === null && typeof v['descriptorTurtle'] === 'string')).toBe(true);
    }
    const st = webAnswer(await ract(H, 'pev.project_attempt', P.learner.web, { attemptIri: X['a'], format: 'xapi' }), 'a statement from the web app');
    expect(typeof ((st['statement'] as Out)['result'] as Out)['success']).toBe('boolean');
    const ex = webAnswer(await ract(H, 'pev.export_record', P.learner.web, { attemptIri: X['a'] }), 'the record from the web app');
    expect((ex['versions'] as Out[]).every((v) => typeof v['graphTrig'] === 'string')).toBe(true);
    // A reviewer's statement from the web app.
    webAnswer(await ract(H, 'pev.project_attempt', P.reviewer2.web, { attemptIri: X['a'], format: 'cmi5' }), 'a statement from a reviewer\'s web app');
  }, SLOW);

  it('the learner\'s other acts from a chat: a copy of a scored record refused, writing nothing; a contest and removing the transcript without stakes', async () => {
    // A copy is every version's graph, unencrypted, on a pod the chat names and can read back: refused, and nothing lands there.
    const open = 'https://open-pod.example.test/anyone/';
    for (const chat of chats(P.learner)) {
      const copy = refused(await ract(H, 'pev.holder_copy', chat, { attemptIri: X['a'], targetPodUrl: open }), 'stakes-not-in-chat', `a copy from ${chat}`);
      expect(stakesIn(copy)).toEqual([]);
    }
    expect([...pod.store.keys()].filter((u) => u.startsWith(open))).toEqual([]);
    // From the web app it is copied, stakes and all, as the learner chose.
    const copy = ok(await ract(H, 'pev.holder_copy', P.learner.web, { attemptIri: X['a'], targetPodUrl: 'https://learner-pod.example.test/me/' }));
    expect((copy['copies'] as Out[]).length).toBeGreaterThan(3);
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

  it('an author\'s chat edits a scored scenario without its stakes and keeps them; it never sends stakes it could not read', async () => {
    const input = demoScenarioInput('missed-deadline', 2);
    const sent = withoutStakes(input);
    const same = { scenario: sent, status: 'published', basedOnVersion: 1, draftAssistance: { used: false } };
    // The scenario as the chat read it, saved again: unchanged, in words.
    const again = chatAnswer(await ract(H, 'pev.author_scenario', P.author.claude, same), 'the same scenario saved from Claude');
    expect([again['changed'], again['version'], (again['stakesKept'] as Out)['fromVersion']]).toEqual([false, 1, 1]);
    // Stakes from a chat on a scored scenario are refused, right or wrong, so no answer says which a guess was.
    for (const [label, scenario] of [['its own stakes', input], ['guessed stakes', { ...input, rubric: { ...(input['rubric'] as Out), passRule: { minPercent: 50, requiredLevels: {} } } }]] as const) {
      const r = refused(await ract(H, 'pev.author_scenario', P.author.claude, { ...same, scenario }), 'stakes-not-in-chat', `a scenario with ${label} from Claude`);
      noBareHash(r, `the refusal of ${label}`);
    }
    // Other criteria cannot keep the version's stakes: refused too.
    const r0 = sent['rubric'] as { criteria: Out[] };
    const renamed = { ...sent, rubric: { criteria: [{ ...r0.criteria[0]!, id: 'names-the-miss' }, ...r0.criteria.slice(1)] } };
    refused(await ract(H, 'pev.author_scenario', P.author.claude, { ...same, scenario: renamed }), 'stakes-not-in-chat', 'other criteria from Claude');
    // A typo fixed from the chat: a new version that keeps version 1's weights, level points and pass mark.
    const fixed = { ...sent, firstLine: 'You wanted to see me? If this is about Thursday\'s report, I know.' };
    const v2 = chatAnswer(await ract(H, 'pev.author_scenario', P.author.claude, { ...same, scenario: fixed }), 'a fixed first line from Claude', false);
    expect([v2['changed'], v2['version'], v2['rubricChanged'], (v2['stakesKept'] as Out)['fromVersion']]).toEqual([true, 2, false, 1]);
    const web = webAnswer(await ract(H, 'pev.list_scenarios', P.author.web, {}, { scenario_iri: X['sc'] }), 'version 2 in the web app');
    const rubric = (web['scenario'] as Out)['rubric'] as { criteria: { weight: number }[]; passRule: Out };
    expect([(web['scenario'] as Out)['version'], (web['scenario'] as Out)['firstLine'], rubric.criteria.map((c) => c.weight), rubric.passRule])
      .toEqual([2, fixed['firstLine'], [2, 2, 2], { minPercent: 70, requiredLevels: { 'agrees-next-step': 'partial' } }]);
    expect((web['scenario'] as Out)['rubricHash']).toBe(RAW.rubric);
    // The web app still saves stakes, as before.
    const fromWeb = webAnswer(await ract(H, 'pev.author_scenario', P.author.web, { scenario: { ...input, firstLine: fixed['firstLine'] }, status: 'published', basedOnVersion: 2, draftAssistance: { used: false } }),
      'the same scenario saved from the web app');
    expect(fromWeb['changed']).toBe(false);
  }, SLOW);

  it('a reviewer\'s chat the operator lets decide approves a rubric with the hash it read, keyed; the bare hash is no use to it', async () => {
    const listed = chatAnswer(await ract(DECIDE, 'pev.list_scenarios', P.reviewer.claude, { scenarioIri: X['sc'] }), 'version 2 from a reviewer\'s Claude');
    const sc = listed['scenario'] as Out;
    expect(sc['version']).toBe(2);
    const v2 = coerceScenario({ ...demoScenarioInput('missed-deadline', 2), firstLine: sc['firstLine'] });
    if (!('value' in v2)) throw new Error('version 2 does not coerce');
    refused(await ract(DECIDE, 'pev.ratify_scenario', P.reviewer.claude, { scenarioIri: X['sc'], version: 2, scenarioHash: scenarioHash(v2.value) }),
      'scenario-revised', 'an approval with the bare scenario hash from Claude');
    const ratified = ok(await ract(DECIDE, 'pev.ratify_scenario', P.reviewer.claude, { scenarioIri: X['sc'], version: 2, scenarioHash: sc['scenarioHash'] }));
    expect([ratified['status'], ratified['version']]).toEqual(['ratified', 2]);
    noBareHash(ratified, 'the approval');
  }, SLOW);

  it('an author\'s chat that saves the scored rubric with stakes it chose reads a fingerprint matching no other scenario\'s or version\'s, its right guess included', async () => {
    const listed = chatAnswer(await ract(H, 'pev.list_scenarios', P.author.claude, { scenarioIri: X['sc'] }), 'the scored scenario from the author\'s Claude');
    const head = listed['scenario'] as Out;
    // Every fingerprint of the scored rubric the chat has read: the head's, and every version's.
    const read = new Set([String(head['rubricHash']), ...(listed['versions'] as Out[]).map((v) => String(v['rubricHash']))]);
    const input = demoScenarioInput('missed-deadline', 2);
    // A scratch scenario with the scored rubric and the stakes the chat guessed, which are the author's own: a draft, accepted.
    const scratch = ok(await ract(H, 'pev.author_scenario', P.author.claude, {
      scenario: { ...input, scenarioKey: 'scratch-copy-of-missed-deadline', title: 'A scratch copy' }, status: 'draft', draftAssistance: { used: false },
    }));
    const scratchWeb = ok(await ract(H, 'pev.list_scenarios', P.author.web, {}, { scenario_iri: scratch['scenarioIri'], include_drafts: true }));
    // It is the same rubric, stakes and all, as the web app reads it ...
    expect((scratchWeb['scenario'] as Out)['rubricHash']).toBe(RAW.rubric);
    // ... and the chat's fingerprint of it matches none it read of the scored scenario, so it says nothing about the guess.
    expect(read.has(String(scratch['rubricHash'])), 'a scratch scenario\'s fingerprint against the scored one\'s').toBe(false);
    noBareHash(scratch, 'the scratch scenario saved from the chat');
    // The scored scenario itself, made feedback-only and then scored again with the guessed stakes: a new version, keyed for it alone.
    const v = Number(head['version']);
    const sent = withoutStakes({ ...input, firstLine: head['firstLine'] });
    const { passGateWhy: _why, ...plain } = sent;
    ok(await ract(H, 'pev.author_scenario', P.author.claude, { scenario: { ...plain, assessmentUse: 'feedback-only' }, status: 'published', basedOnVersion: v, draftAssistance: { used: false } }));
    const rescored = ok(await ract(H, 'pev.author_scenario', P.author.claude, {
      scenario: { ...input, firstLine: head['firstLine'] }, status: 'published', basedOnVersion: v + 1, draftAssistance: { used: false },
    }));
    expect(rescored['version']).toBe(v + 2);
    const rescoredWeb = ok(await ract(H, 'pev.list_scenarios', P.author.web, {}, { scenario_iri: X['sc'] }));
    expect((rescoredWeb['scenario'] as Out)['rubricHash']).toBe(RAW.rubric);
    expect(read.has(String(rescored['rubricHash'])), 'a new version\'s fingerprint against an earlier one\'s').toBe(false);
    // Each version's fingerprint stays what the chat read for it: the list shows the earlier ones as they were, and the new one as saved.
    const after = chatAnswer(await ract(H, 'pev.list_scenarios', P.author.claude, { scenarioIri: X['sc'] }), 'the rescored scenario from the author\'s Claude', true);
    const byVersion = new Map((after['versions'] as Out[]).map((x) => [Number(x['version']), String(x['rubricHash'])]));
    expect([byVersion.get(v), byVersion.get(v + 2)]).toEqual([String(head['rubricHash']), String(rescored['rubricHash'])]);
  }, SLOW);

  it('every chat read keys a fingerprint the same way each time it is read', async () => {
    const fingerprints = (r: unknown): string[] => {
      const out: string[] = [];
      const walk = (x: unknown, key?: string): void => {
        if (typeof x === 'string') {
          if (key === 'rubricHash' || key === 'scenarioHash') out.push(`${key}=${x}`);
          for (const m of x.matchAll(/urn:pev:rubric:([0-9a-f]{64})/g)) out.push(`iri=${m[1]}`);
        } else if (Array.isArray(x)) x.forEach((y) => walk(y));
        else if (x !== null && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, k);
      };
      walk(r);
      return out;
    };
    // A judged attempt on the scenario's latest version, to read.
    const head = ok(await ract(H, 'pev.list_scenarios', P.learner.claude, { scenarioIri: X['sc'] }))['scenario'] as Out;
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: X['sc'], scenarioVersion: head['version'], coached: false }));
    const attempt = String(start['attemptIri']);
    let turn = 1;
    for (const text of DEMO_LINES.ana) {
      const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: attempt, turnIndex: turn, text }));
      turn = Number(said['nextTurnIndex']);
      if (said['ended'] === true) break;
    }
    const view = ok(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: attempt }));
    if (view['state'] === 'in-conversation') ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: attempt, turnIndex: turn }));
    ok(await ract(H, 'pev.judge_attempt', P.learner.claude, { attemptIri: attempt }));
    const reads: [string, () => Promise<Out>][] = [
      ['the list', async () => ract(H, 'pev.list_scenarios', P.reviewer.claude)],
      ['one scenario', async () => ract(H, 'pev.list_scenarios', P.reviewer.claude, { scenarioIri: X['sc'] })],
      ['one attempt', async () => ract(H, 'pev.get_attempt', P.reviewer.claude, { attemptIri: attempt })],
      ['the judge packet', async () => ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: attempt })],
      ['the review queue', async () => ract(H, 'pev.review_queue', P.reviewer.claude)],
      ['results', async () => ract(H, 'pev.scenario_results', P.reviewer.claude, { scenarioIri: X['sc'] })],
      ['calibration', async () => (await H['pev.calibration']!({})) as Out],
    ];
    for (const [what, read] of reads) {
      const once = fingerprints(ok(await read()));
      expect(fingerprints(ok(await read())), what).toEqual(once);
    }
    // The packet's binding is keyed for the attempt's scenario version: the one the attempt view shows.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: attempt }));
    const seen = ok(await ract(H, 'pev.get_attempt', P.reviewer.claude, { attemptIri: attempt }));
    expect((packet['binding'] as Out)['rubricHash']).toBe((seen['scenario'] as Out)['rubricHash']);
  }, SLOW);

  it('an answer about feedback-only scenarios alone says nothing was left out: there is nothing to leave out', async () => {
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: demoScenarioInput('renegotiate-scope'), status: 'published', draftAssistance: { used: false } }));
    const one = chatAnswer(await ract(H, 'pev.list_scenarios', P.learner.claude, { scenarioIri: pub['scenarioIri'] }), 'a feedback-only scenario from Claude', false);
    expect((one['scenario'] as Out)['assessmentUse']).toBe('feedback-only');
    // A list that holds a scored scenario too still says so.
    chatAnswer(await ract(H, 'pev.list_scenarios', P.learner.claude), 'the list from Claude');
  }, SLOW);
});
