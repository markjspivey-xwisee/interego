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
import { webAppClients } from '../bridge/ui.js';
import { rubricHash, scenarioHash, coerceScenario, normaliseForQuote, verifyQuoteAsShown } from '../src/practice.js';
import { DEMO_LINES, demoKey, demoScenarioInput, inMemoryPod, scriptedPracticeModel } from '../demo/run.js';
import { PEV_ACTION, toolNameOf } from '../src/ontology.js';
import { signEnvelope } from '../src/records.js';
import { hashMask, maskAnswerHashes, maskReadBackQuote, maskText, quoteAsStored, quoteReadingsAsStored, STAKES_WITHHELD } from '../src/stakes.js';
import { pevAffordances, STAKES_LEFT_OUT_FOR } from '../affordances.js';
import { readFileSync } from 'node:fs';

type Out = Record<string, unknown>;
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SLOW = 240_000;
const POD = 'https://stakes-pod.example.test/practice/';
const IDH = 'identity.example.test';
const pod = inMemoryPod();
const wallet = (name: string, type: 'human' | 'agent' = 'human'): Wallet => importWallet(`0x${sha256(`pev-stakes-test:${name}`)}`, type, name);
const RELAY = wallet('relay', 'agent');
const MALLORY = wallet('mallory');
/** A person who signs with a key they hold (a wallet in the web app, or their own script), registered as a reviewer. */
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

/**
 * What the relay posts for an agent: the caller's fields (its own agent_id and client_id and underscore keys dropped),
 * then the session's: its agent, its pod and, when the session's access token names an OAuth client, that client's id
 * (`client`; `undefined`, the key left out, as on a relay that does not sign it or a request with no OAuth client).
 */
async function relayPair(agentId: string, tool: string, fields: Out = {}, by: Wallet = RELAY, client?: unknown): Promise<Out> {
  const payload: Out = { v: 1, action: actionOf(tool), nonce: nonce(), pod_url: POD, ...fields };
  const reserved = new Set(['agent_id', 'timestamp', 'subject_pod_url', 'payload', 'client_id']);
  const safe = Object.fromEntries(Object.entries(payload).filter(([k]) => !k.startsWith('_') && !reserved.has(k)));
  const sp = JSON.stringify({
    ...safe, agent_id: agentId, subject_pod_url: 'https://pods.example.test/self/', ...(client !== undefined ? { client_id: client } : {}), timestamp: new Date().toISOString(),
  });
  return { _signed_payload: sp, _signature: await signMessageRaw(by, `sha256:${sha256Hex(sp)}`) };
}
async function ract(h: Handlers, tool: string, agentId: string, fields: Out = {}, extra: Out = {}): Promise<Out> {
  return (await h[tool]!({ ...(await relayPair(agentId, tool, fields)), ...extra })) as Out;
}
/** As `ract`, by a relay that signs which OAuth client asked (`client`). */
async function cact(h: Handlers, tool: string, agentId: string, client: unknown, fields: Out = {}): Promise<Out> {
  return (await h[tool]!(await relayPair(agentId, tool, fields, RELAY, client))) as Out;
}
/** This bridge's web app's own client id: its Client ID Metadata Document on the deployment URL. */
const OWN_CLIENT = 'https://bridge.example.test/ui/oauth/client.json';
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

/** Set once a test writes a fingerprint into text; until then no answer holds one in text. */
let fingerprintsWrittenIntoText = false;

/**
 * No rubric IRI or calibration kind inside any text of an answer, while no caller has written one there: this bridge
 * writes none into text, only into the fields it keys (an answer that leaves the stakes out shows one in text with a
 * stand-in the same fingerprint in a caller's text would match, so a fingerprint the bridge wrote there would check a guess).
 */
function noFingerprintInText(r: unknown, what: string): void {
  if (fingerprintsWrittenIntoText) return;
  expect(hashesIn(r).inText, `${what}: a fingerprint this bridge wrote into text`).toEqual([]);
}

/**
 * A chat agent's answer: a success, no stake anywhere, no bare hash, and the mark that says what
 * was left out when it is about a scored scenario (`scored`), none when it is not.
 */
function chatAnswer(r: Out, what: string, scored = true): Out {
  ok(r);
  expect(stakesIn(r), what).toEqual([]);
  noBareHash(r, what);
  noFingerprintInText(r, what);
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

    // The bridge's model judges at the learner's request from their chat: the judgment's levels and quotes, no result.
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
    // A key an admin registered (a wallet in the web app, or a script of their own) is read as that person, with the bare hashes.
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
    noFingerprintInText(cal, 'calibration');
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
        // The judge who reviews judged this attempt, so their queue holds nothing scored, and says nothing was left out.
        const q = chatAnswer(await ract(H, 'pev.review_queue', chat), `queue from ${chat}`, p === P.reviewer);
        const entries = q['entries'] as Out[];
        // The judge who reviews judged this attempt, so it is not theirs to review; the reviewer's queue holds it.
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
    noFingerprintInText(cal, 'calibration after a review');
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

// ── A fingerprint a caller writes into text ─────────────────────────────────────────────────────

/** A rubric hash a caller could guess, written as text: as a rubric IRI and as a calibration kind's prefix. */
const asText = (hashes: readonly string[]): string => hashes.map((h) => `urn:pev:rubric:${h} pev/${h.slice(0, 16)}/x`).join(' ');

/**
 * The hashes in an answer, split by where they sit: `keyed`, the fields this bridge writes a hash into (`rubricHash`,
 * `scenarioHash`, `rubricIri`, a calibration `kind`), each value and its first 16 hex; `inText`, every rubric IRI's hash and
 * kind prefix inside any other string.
 */
function hashesIn(r: unknown): { keyed: Set<string>; inText: string[] } {
  const keyed = new Set<string>();
  const inText: string[] = [];
  const keep = (h: string): void => { keyed.add(h); keyed.add(h.slice(0, 16)); };
  // A calibration cell, wherever it sits: the only place this bridge writes a kind.
  const isCell = (o: Record<string, unknown>): boolean =>
    (o['grouping'] === 'rubric-version' || o['grouping'] === 'criterion-content') && typeof o['criterionContentHash'] === 'string' && typeof o['judgeId'] === 'string';
  const walk = (x: unknown, key?: string, cell = false): void => {
    if (typeof x === 'string') {
      const iri = /^urn:pev:rubric:([0-9a-f]{64})$/.exec(x);
      const kind = /^pev\/([0-9a-f]{16})\/[a-z0-9-]{1,40}$/.exec(x);
      if ((key === 'rubricHash' || key === 'scenarioHash') && /^[0-9a-f]{64}$/.test(x)) keep(x);
      else if (key === 'rubricIri' && iri) keep(iri[1]!);
      else if (key === 'kind' && kind && cell) keep(kind[1]!);
      else {
        for (const m of x.matchAll(/urn:pev:rubric:([0-9a-f]{64})/g)) inText.push(m[1]!);
        for (const m of x.matchAll(/pev\/([0-9a-f]{16})\//g)) inText.push(m[1]!);
      }
    } else if (Array.isArray(x)) x.forEach((y) => walk(y, undefined, cell));
    else if (x !== null && typeof x === 'object') {
      const here = cell || isCell(x as Record<string, unknown>);
      for (const [k, y] of Object.entries(x)) walk(y, k, here);
    }
  };
  walk(r);
  return { keyed, inText };
}

/**
 * An answer a caller who reads no stakes got back with `atLeast` hashes it wrote into text: none of them equals a value in a
 * field this bridge keyed or the first 16 hex of one, in this answer or in any of `elsewhere` (other answers the same
 * caller read), and none is a bare hash it wrote or the first 16 hex of one.
 */
function noGuessCheckable(r: Out, atLeast: number, bare: readonly string[], what: string, elsewhere: readonly unknown[] = []): void {
  ok(r);
  const { inText } = hashesIn(r);
  const keyed = new Set([r, ...elsewhere].flatMap((x) => [...hashesIn(x).keyed]));
  expect(inText.length, `${what}: the hashes written into text came back`).toBeGreaterThanOrEqual(atLeast);
  expect(inText.filter((h) => keyed.has(h) || keyed.has(h.slice(0, 16))), `${what}: a hash in text equal to a keyed one`).toEqual([]);
  expect(inText.filter((h) => bare.some((b) => b.startsWith(h) || b.startsWith(h.slice(0, 16)))), `${what}: a bare hash echoed`).toEqual([]);
}

describe('a rubric fingerprint a caller writes into text comes back as a stand-in keyed apart from the answer\'s own, never equal to it', () => {
  it('maskAnswerHashes keys the fields this bridge writes a hash into, and every other occurrence apart from them, the same way each time in one scope', () => {
    fingerprintsWrittenIntoText = true;
    const m = hashMask(Buffer.alloc(32, 7));
    const h = RAW.rubric;
    const h16 = h.slice(0, 16);
    const scope = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    const answer = {
      scenarioIri: scope.scenarioIri, version: 1, rubricHash: h, rubricIri: `urn:pev:rubric:${h}`,
      turns: [{ text: asText([h, h]) }], why: `urn:pev:rubric:${h}#criterion-x`, attempt: { kind: `pev/${h16}/x` },
      cells: [{ grouping: 'rubric-version', criterionContentHash: 'c', judgeId: 'j', rubricHash: h, kind: `pev/${h16}/asks-their-view`, criterionTitle: asText([h]) }],
    };
    const out = maskAnswerHashes(answer, m, scope) as typeof answer;
    const v = m.version(scope.scenarioIri, 1);
    const k = v.full(h);
    // The bridge's own fields: keyed for their scope, the same each time.
    expect([out.rubricHash, out.rubricIri, out.cells[0]!.rubricHash, out.cells[0]!.kind])
      .toEqual([k, `urn:pev:rubric:${k}`, m.cells.full(h), `pev/${m.cells.prefix(h16)}/asks-their-view`]);
    expect((maskAnswerHashes(answer, m, scope) as typeof answer).rubricHash).toBe(k);
    // Text, and an IRI that is not a bare rubric IRI: the stand-in in text for the scope it sits in, the same each time.
    expect(out.turns[0]!.text).toBe(asText([v.inText.full(h), v.inText.full(h)]).replace(/pev\/[0-9a-f]{16}\//g, `pev/${v.inText.prefix(h16)}/`));
    expect([out.why, out.attempt.kind]).toEqual([`urn:pev:rubric:${v.inText.full(h)}#criterion-x`, `pev/${v.inText.prefix(h16)}/x`]);
    expect(out.cells[0]!.criterionTitle).toBe(`urn:pev:rubric:${m.cells.inText.full(h)} pev/${m.cells.inText.prefix(h16)}/x`);
    expect(hashesIn(maskAnswerHashes(answer, m, scope))).toEqual(hashesIn(out));
    // No stand-in in text equals any field's value in any scope, or its first 16 hex, or the bare hash.
    const { keyed, inText } = hashesIn(out);
    expect(inText).toHaveLength(8);
    const other = m.version(scope.scenarioIri, 2);
    const fields = [k, m.cells.full(h), other.full(h), v.prefix(h16), m.cells.prefix(h16), other.prefix(h16), h];
    expect(inText.filter((x) => keyed.has(x) || keyed.has(x.slice(0, 16)) || fields.some((f) => f.startsWith(x) || f.startsWith(x.slice(0, 16))))).toEqual([]);
    // Another scope's stand-in in text is another value.
    expect([other.inText.full(h) === v.inText.full(h), m.cells.inText.full(h) === v.inText.full(h), other.inText.prefix(h16) === v.inText.prefix(h16)]).toEqual([false, false, false]);
  });

  it('a quote copied from a masked line reads back as the stored line: whole stand-ins, with or without their frame, and only of hashes the stored lines hold', () => {
    const m = hashMask(Buffer.alloc(32, 9));
    const k = m.version('urn:pev:scenario:unit', 3);
    const h = RAW.rubric;
    const stored = [`I read urn:pev:rubric:${h} and pev/${h.slice(0, 16)}/asks-their-view first.`, 'Their own line.'];
    const shown = maskText(stored[0]!, k);
    expect([shown.includes(h), shown.includes(h.slice(0, 16)), shown.length]).toEqual([false, false, stored[0]!.length]);
    const back = quoteAsStored(k, stored);
    expect(back(shown)).toBe(stored[0]);
    // Part of a line, each stand-in in it whole.
    expect(back(shown.slice(2, -7))).toBe(stored[0]!.slice(2, -7));
    // A stand-in of a hash no stored line holds, another scope's, or a cut one: left as it is.
    const elsewhere = maskText(`urn:pev:rubric:${sha256('another rubric')}`, k);
    expect(back(elsewhere)).toBe(elsewhere);
    const otherScope = maskText(stored[0]!, m.version('urn:pev:scenario:unit', 4));
    expect(back(otherScope)).toBe(otherScope);
    const cut = shown.slice(0, shown.indexOf('urn:pev:rubric:') + 40);
    expect(back(cut)).toBe(cut);
    // A stand-in's hex alone, as a quote may start or end at the ':' or '/' around it: read back too. From the hex on, from
    // `rubric:` on, a kind ending at its hex, a kind starting after `pev/`, and the kind's hex alone.
    const iriAt = shown.indexOf('urn:pev:rubric:');
    const kindAt = shown.indexOf('pev/');
    for (const [from, to] of [[iriAt + 15, -7], [iriAt + 8, -7], [2, kindAt + 20], [kindAt + 4, -7], [kindAt + 4, kindAt + 20]] as const) {
      const part = shown.slice(from, to);
      expect([part.includes(h), part.includes(h.slice(0, 16))], part).toEqual([false, false]);
      expect(back(part), part).toBe(stored[0]!.slice(from, to));
    }
    // A run of hex that stands for nothing in the stored lines is left as it is.
    const other = sha256('another rubric');
    expect(back(`${other} and ${other.slice(0, 16)}`)).toBe(`${other} and ${other.slice(0, 16)}`);
    // A line a character NFC folds into an ASCII letter starts (the Kelvin sign, which is not a word character, into K, which
    // is): the line and its normalised form, which the judge packet and normalisedText show, mask the kind the same way.
    const kelvin = `\u212Apev/${h.slice(0, 16)}/asks-their-view, I noted.`;
    const norm = normaliseForQuote(kelvin);
    expect(norm.startsWith('Kpev/')).toBe(true);
    expect([maskText(kelvin, k).includes(h.slice(0, 16)), maskText(norm, k).includes(h.slice(0, 16)), normaliseForQuote(maskText(kelvin, k))])
      .toEqual([false, false, maskText(norm, k)]);
    expect(quoteAsStored(k, [kelvin])(maskText(norm, k))).toBe(norm);
  });

  it('a quote of a line that holds a fingerprint and, written out beside it, the stand-in it is shown as reads back with the written one kept as written', () => {
    const m = hashMask(Buffer.alloc(32, 23));
    const scope = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    const k = m.version(scope.scenarioIri, scope.version);
    const h = RAW.rubric;
    const s = k.inText.full(h);
    const s16 = k.inText.prefix(h.slice(0, 16));
    // As the peer review found it: the learner copied the stand-in from an earlier view of this scenario version and wrote it out.
    const line = `So now urn:pev:rubric:${h} equals ${s} indeed, and pev/${h.slice(0, 16)}/asks-their-view is ${s16} too, I said.`;
    const turns = [{ index: 1, speaker: 'learner' as const, text: line }, { index: 2, speaker: 'counterpart' as const, text: 'Go on.' }];
    const view = maskText(line, k);
    // The view shows the fingerprint and the written stand-in alike.
    expect([view.includes(h), view.split(s).length - 1, view.split(s16).length - 1]).toEqual([false, 2, 2]);
    // How the bridge reads a judge's quote back: every reading to try, the first with every stand-in read back.
    const back = quoteReadingsAsStored(k, [line]);
    const ends = view.indexOf(', I said');
    for (const from of [view.indexOf('urn:pev:rubric:'), view.indexOf('urn:pev:rubric:') + 15, view.indexOf(' equals ') + 8, view.indexOf('pev/')]) {
      const copied = view.slice(from, ends);
      const r = verifyQuoteAsShown({ text: copied, turnIndex: 1 }, turns, back);
      // Read back with the fingerprint put back and the written stand-in kept as the learner wrote it, and checked out.
      expect([r.verified, r.readBack, r.turnIndex, r.text], copied).toEqual([true, true, 1, line.slice(from, ends)]);
      // Shown as the view shows that stretch, so a copy of it reads back again.
      const out = (maskAnswerHashes({ ...scope, attemptIri: 'urn:pev:attempt:unit', quotes: [r] }, m, scope, new Map([['urn:pev:attempt:unit', turns]])) as { quotes: { text: string }[] }).quotes[0]!;
      expect([out.text, JSON.stringify(out).includes(h)], copied).toEqual([copied, false]);
    }
    // A stand-in with nothing around it that stands for a hash in a line, as before: read back, whatever else is tried.
    const hexOnly = view.slice(view.indexOf('urn:pev:rubric:') + 15, view.indexOf(' equals '));
    expect(verifyQuoteAsShown({ text: `${hexOnly} equals`, turnIndex: 1 }, turns, back).text).toBe(`${h} equals`);
    // A quote no reading finds is saved as the reading with every stand-in read back, as before, and says why.
    const absent = verifyQuoteAsShown({ text: `${hexOnly} equals ${s} never`, turnIndex: 1 }, turns, back);
    expect([absent.verified, absent.readBack, absent.text]).toEqual([false, true, `${h} equals ${h} never`]);
  });

  it('a quote of a fingerprint and any number of its stand-in written out beside it reads back as copied: found in the line as shown, read back by its place there', () => {
    const m = hashMask(Buffer.alloc(32, 29));
    const scope = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    const k = m.version(scope.scenarioIri, scope.version);
    const h = RAW.rubric;
    const h16 = h.slice(0, 16);
    const s = k.inText.full(h);
    const s16 = k.inText.prefix(h16);
    const attemptIri = 'urn:pev:attempt:unit-many-runs';
    const words = ['then', 'and', 'so', 'again', 'also', 'still', 'yet', 'once', 'more', 'plus'];
    type Shown = { text: string; normalised?: string };
    // As the peer review found it: one framed fingerprint, then its stand-in written out, with ordinary words between: four
    // runs of hex that could each be either in all (the old limit), five (where the old reading failed), and ten.
    for (const copies of [3, 4, 9]) {
      const line = `I read urn:pev:rubric:${h} ${words.slice(0, copies).map((w) => `${w} ${s}`).join(' ')} in the notes, and pev/${h16}/asks-their-view `
        + `${words.slice(0, copies).map((w) => `${w} ${s16}`).join(' ')} before Friday.`;
      const turns = [{ index: 1, speaker: 'learner' as const, text: line }, { index: 2, speaker: 'counterpart' as const, text: 'Go on.' }];
      const back = quoteReadingsAsStored(k, turns);
      const view = maskText(line, k);
      const norm = normaliseForQuote(line);
      const iriAt = view.indexOf('urn:pev:rubric:');
      const kindAt = view.indexOf('pev/', iriAt + 15);
      const ends = [view.indexOf(' in the notes'), view.indexOf(' before Friday')];
      // The packet span beginning after the urn prefix (the peer review's quote), from inside the frame, from the kind's hex,
      // and across both kinds of run at once.
      for (const [from, to] of [[iriAt + 15, ends[0]!], [iriAt + 8, ends[0]!], [iriAt + 4, ends[1]!], [kindAt + 4, ends[1]!], [iriAt, kindAt + 20], [iriAt + 15, ends[1]!]] as const) {
        const copied = view.slice(from, to);
        const what = `${copies + 1} runs, ${copied.slice(0, 24)}…`;
        expect([copied.includes(h), copied.includes(h16)], what).toEqual([false, false]);
        const r = verifyQuoteAsShown({ text: copied, turnIndex: 1 }, turns, back);
        // Read back with the fingerprint and the kind put back, every stand-in the learner wrote out kept as written.
        expect([r.verified, r.readBack, r.turnIndex, r.text, r.declaredTurnIndex], what).toEqual([true, true, 1, line.slice(from, to), undefined]);
        // Its fingerprint, place and highlight are the stored line's, as the transcript hash reads it.
        expect([r.normalised, norm.slice(r.start!, r.end!), r.quoteSha256], what).toEqual([normaliseForQuote(line.slice(from, to)), r.normalised, sha256(r.normalised!)]);
        // Shown as the view shows that stretch, and a copy of that reads back again, as often as it is copied.
        let quote = copied;
        for (let round = 1; round <= 3; round++) {
          const again = verifyQuoteAsShown({ text: quote, turnIndex: 1 }, turns, back);
          expect([again.verified, again.text], `${what}, round ${round}`).toEqual([true, r.text]);
          const out = (maskAnswerHashes({ ...scope, attemptIri, quotes: [again] }, m, scope, new Map([[attemptIri, turns]])) as { quotes: Shown[] }).quotes[0]!;
          expect([out.text, JSON.stringify(out).includes(h), JSON.stringify(out).includes(h16)], `${what}, round ${round}`).toEqual([copied, false, false]);
          quote = out.text;
        }
      }
    }
  });

  it('a quote read back by its place in a shown line keeps to the quote rule: the turn the judge named, whole words, and the learner\'s lines only', () => {
    const m = hashMask(Buffer.alloc(32, 31));
    const k = m.version('urn:pev:scenario:unit', 1);
    const h = RAW.rubric;
    const s = k.inText.full(h);
    const runs = `${s} then ${s} then ${s} then ${s} for this step`;
    // T1 holds the fingerprint with nothing around it, which every view shows as written; T3 holds it framed, shown as the
    // stand-in. The stored words after the frame are the same in both.
    const turns = [
      { index: 1, speaker: 'learner' as const, text: `I noted ${h} then ${runs}.` },
      { index: 2, speaker: 'counterpart' as const, text: `They read urn:pev:rubric:${h} then ${runs}.` },
      { index: 3, speaker: 'learner' as const, text: `I read urn:pev:rubric:${h} then ${runs}.` },
    ];
    const back = quoteReadingsAsStored(k, turns);
    const t3 = maskText(turns[2]!.text, k);
    const copied = t3.slice(t3.indexOf('urn:pev:rubric:') + 15, -1);
    const stored = `${h} then ${runs}`;
    // The turn the judge named, where the words sit there; otherwise the first learner turn that holds them, as for any quote.
    const named = verifyQuoteAsShown({ text: copied, turnIndex: 3 }, turns, back);
    expect([named.verified, named.readBack, named.turnIndex, named.declaredTurnIndex, named.text]).toEqual([true, true, 3, undefined, stored]);
    const first = verifyQuoteAsShown({ text: copied, turnIndex: 1 }, turns, back);
    expect([first.verified, first.turnIndex, first.declaredTurnIndex, first.text]).toEqual([true, 1, undefined, stored]);
    expect(verifyQuoteAsShown({ text: copied }, turns, back).turnIndex).toBe(1);
    // A quote that starts or ends inside a run of hex the view shows cuts a word of the line: not credited, no part of the
    // fingerprint is read back into it (a whole stand-in in it is read back whole, as before), and none of it is shown. This
    // fingerprint has more hex written right after it, which the view shows as written: a quote of the stand-in alone ends
    // inside that word too.
    const later = [{ index: 5, speaker: 'learner' as const, text: `Later urn:pev:rubric:${h}abc came up, and I asked what they thought.` }];
    const backLater = quoteReadingsAsStored(k, later);
    const t5 = maskText(later[0]!.text, k);
    const at5 = t5.indexOf('urn:pev:rubric:') + 15;
    const lines5 = new Map([['urn:pev:attempt:unit-cut', later]]);
    const scope = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    expect([t5.slice(at5, at5 + 67), t5.length]).toEqual([`${s}abc`, later[0]!.text.length]);
    for (const [from, to] of [[at5 + 5, t5.indexOf(', and I')], [0, at5 + 25], [at5, at5 + 64], [at5 - 15, at5 + 64]] as const) {
      const cut = t5.slice(from, to);
      const r = verifyQuoteAsShown({ text: cut, turnIndex: 5 }, later, backLater);
      const out = JSON.stringify(maskAnswerHashes({ ...scope, attemptIri: 'urn:pev:attempt:unit-cut', quotes: [r] }, m, scope, lines5));
      const parts = [h.slice(5, 21), h.slice(24, 40), h.slice(48)];
      const partOnly = !(r.text ?? '').includes(h) && parts.some((y) => (r.text ?? '').includes(y));
      expect([r.verified, partOnly, parts.some((y) => out.includes(y))], cut).toEqual([false, false, false]);
    }
    // Whole words, more hex after the fingerprint included: read back and credited, and shown as the view shows it, with nothing
    // bare also when an answer has no line to show it from.
    for (const from of [at5 - 15, at5]) {
      const whole = t5.slice(from, t5.indexOf(', and I'));
      const r = verifyQuoteAsShown({ text: whole, turnIndex: 5 }, later, backLater);
      expect([r.verified, r.readBack, r.turnIndex, r.text], whole).toEqual([true, true, 5, later[0]!.text.slice(from, t5.indexOf(', and I'))]);
      for (const lines of [lines5, new Map()]) {
        const shown = (maskAnswerHashes({ ...scope, attemptIri: 'urn:pev:attempt:unit-cut', quotes: [r] }, m, scope, lines) as { quotes: { text: string }[] }).quotes[0]!;
        expect([JSON.stringify(shown).includes(h.slice(0, 16)), JSON.stringify(shown).includes(h.slice(48))], whole).toEqual([false, false]);
        if (lines.size > 0) expect(shown.text, whole).toBe(whole);
      }
    }
    // The other person's line is shown the same way, and a quote from it is not the learner's.
    const theirs = maskText(turns[1]!.text, k);
    const r = verifyQuoteAsShown({ text: theirs.slice(0, -1), turnIndex: 2 }, turns, back);
    expect(r.verified).toBe(false);
  });

  it('a quote copied from a line\'s own text, where a mark follows a fingerprint\'s last digit, and changed by normalising on the way, reads back by its place in the normalised line, whichever of that digit and the stand-in\'s takes the mark', () => {
    const m = hashMask(Buffer.alloc(32, 37));
    const k = m.version('urn:pev:scenario:unit', 1);
    const markFor = (d: string): string => ('ace'.includes(d) ? '\u0301' : '\u0307');
    const folds = (d: string, mark: string): boolean => `${d}${mark}`.normalize('NFC').length === 1;
    // Fictional hashes ending in hex letters and in decimal digits, which take no mark: enough that the stand-in's last digit
    // takes the mark where the fingerprint's does not, the other way round, and both.
    const hashes = Array.from({ length: 60 }, (_, i) => sha256(`a fictional rubric to fold, quoted ${i}`));
    const met = new Set<string>();
    for (const h of hashes) {
      const mark = markFor(h[63]!);
      const s = k.inText.full(h);
      // The fingerprint, a mark after its last digit, then four copies of its stand-in written out: five runs that read alike.
      const line = `Then urn:pev:rubric:${h}${mark} came up, then ${s} and ${s} and ${s} and ${s} came up too, and I asked what they thought.`;
      const turns = [{ index: 1, speaker: 'learner' as const, text: line }];
      const view = maskText(line, k);
      // Copied from the attempt's text, which shows the stand-in's 64 hex and the mark after them, and given back with a space
      // doubled, as a chat app may: so it is found only in that view normalised.
      const copied = view.slice(view.indexOf('urn:pev:rubric:') + 15, view.indexOf(', and I asked')).replace(' came up, then', '  came up,  then');
      const r = verifyQuoteAsShown({ text: copied, turnIndex: 1 }, turns, quoteReadingsAsStored(k, turns));
      const norm = normaliseForQuote(line);
      expect([r.verified, r.readBack, r.turnIndex, r.normalised, r.normalised?.split(s).length], h).toEqual([true, true, 1, norm.slice(r.start!, r.end!), 5]);
      expect(r.normalised!.startsWith(norm.slice(norm.indexOf('urn:pev:rubric:') + 15, norm.indexOf(' came up'))), h).toBe(true);
      met.add(`${folds(h[63]!, mark) ? 'fingerprint' : '-'} ${folds(s[63]!, mark) ? 'stand-in' : '-'}`);
    }
    // Every way the two last digits take the mark was met: the fingerprint's alone (the view normalised shows the stand-in's
    // digit and the mark where the normalised line shows a letter), the stand-in's alone (the other way round), both and neither.
    expect([...met].sort()).toEqual(['- -', '- stand-in', 'fingerprint -', 'fingerprint stand-in']);
  });

  it('a quote of a line where marks follow a fingerprint\'s last digit reads back from either view, copied as shown, normalised on the way, or copied again as an answer shows it, whichever last digit takes them', () => {
    const m = hashMask(Buffer.alloc(32, 39));
    const scope = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    const k = m.version(scope.scenarioIri, scope.version);
    const attemptIri = 'urn:pev:attempt:unit-either-fold';
    const folds = (d: string, marks: string): boolean => `${d}${marks}`.normalize('NFC').length < 1 + marks.length;
    const met = new Set<string>();
    // Fictional fingerprints ending in decimal digits and in hex letters; one mark, another, and two that NFC puts in order and
    // folds in part.
    for (const h of Array.from({ length: 24 }, (_, i) => sha256(`a fictional rubric, folded either way ${i}`))) {
      const s = k.inText.full(h);
      for (const marks of ['\u0301', '\u0307', '\u0307\u0323']) {
        met.add(`${folds(h[63]!, marks) ? 'fingerprint' : '-'} ${folds(s[63]!, marks) ? 'stand-in' : '-'}`);
        for (const copies of [0, 2]) {
          // As the peer review found it: the fingerprint with the marks after it, its stand-in written out, a doubled space and a
          // curly apostrophe, which the normalised line shows otherwise.
          const line = `Then  urn:pev:rubric:${h}${marks} came up${` and ${s}`.repeat(copies)}, and I’d asked what they thought.`;
          const turns = [{ index: 1, speaker: 'learner' as const, text: line }];
          const back = quoteReadingsAsStored(k, turns);
          const lines = new Map([[attemptIri, turns]]);
          const norm = normaliseForQuote(line);
          const between = (v: string): string => v.slice(v.indexOf('urn:pev:rubric:') + 15, v.indexOf(' what they'));
          const stored = between(norm);
          const packet = between(maskText(norm, k));
          const text = between(maskText(line, k));
          // From the packet (the normalised line as shown, which need not be in NFC) and from the attempt's text, each as shown,
          // straightened and NFC'd as a chat app may.
          for (const copied of [packet, packet.normalize('NFC'), text, text.replace(/\s+/g, ' ').replace('’', '\''), text.normalize('NFC')]) {
            const what = `${h.slice(-1)}/${s.slice(-1)} ${JSON.stringify(marks)} ${copies}: ${JSON.stringify(copied.slice(60, 90))}`;
            expect(copied.includes(h.slice(0, 63)), what).toBe(false);
            const r = verifyQuoteAsShown({ text: copied, turnIndex: 1 }, turns, back);
            // Read back as the stored words: the fingerprint where it was framed, every stand-in written out kept as written.
            expect([r.verified, r.readBack, r.turnIndex, r.normalised, norm.slice(r.start!, r.end!)], what).toEqual([true, true, 1, stored, stored]);
            // Shown from its line with none of the fingerprint, and each way it is shown, copied as it is or normalised on the
            // way, reads back again.
            const out = (maskAnswerHashes({ ...scope, attemptIri, quotes: [r] }, m, scope, lines) as { quotes: { text: string; normalised: string }[] }).quotes[0]!;
            expect([JSON.stringify(out).includes(h.slice(0, 16)), JSON.stringify(out).includes(h.slice(40, 63))], what).toEqual([false, false]);
            for (const again of [out.text, out.normalised, out.text.normalize('NFC'), out.normalised.normalize('NFC')]) {
              const r2 = verifyQuoteAsShown({ text: again, turnIndex: 1 }, turns, back);
              expect([r2.verified, r2.readBack, r2.normalised], `${what}, copied again`).toEqual([true, true, stored]);
            }
          }
        }
      }
    }
    // Every way the two last digits take the marks was met: the fingerprint's alone, the stand-in's alone, both and neither.
    expect([...met].sort()).toEqual(['- -', '- stand-in', 'fingerprint -', 'fingerprint stand-in']);
  });

  it('a rubric IRI whose last hex digit a combining mark follows is masked alike in a line and its normalised form, where NFC folds the two into one letter, and a quote from either reads back', () => {
    const m = hashMask(Buffer.alloc(32, 21));
    const scope = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    const k = m.version(scope.scenarioIri, scope.version);
    // A mark NFC puts together with each hex letter: an acute accent with a, c and e (á, ć, é), a dot above with b, d and f.
    const markFor = (d: string): string => ('ace'.includes(d) ? '́' : '̇');
    // Fictional hashes that end in a hex letter, enough of them that a stand-in's own last digit both takes the mark and not.
    const hashes = Array.from({ length: 400 }, (_, i) => sha256(`a fictional rubric to fold ${i}`)).filter((x) => /[a-f]$/.test(x)).slice(0, 48);
    let ownTakes = 0;
    for (const h of hashes) {
      const mark = markFor(h[63]!);
      const line = `Then urn:pev:rubric:${h}${mark} came up and I asked what they thought.`;
      const norm = normaliseForQuote(line);
      // NFC folds the last digit and the mark into one letter: the normalised form holds 63 hex and that letter.
      expect([norm.includes(h), norm.includes(h.slice(0, 63)), norm.length], h).toEqual([false, true, line.length - 1]);
      const views = { line: maskText(line, k), normalised: maskText(norm, k) };
      // Neither form shows any of the hash: not the 64 hex, not the first 63, not the first 16; and each keeps its length.
      for (const [form, v] of Object.entries(views)) {
        expect([v.includes(h.slice(0, 63)), v.includes(h.slice(0, 16)), v.length], `${form} ${h}`).toEqual([false, false, (form === 'line' ? line : norm).length]);
      }
      // The folded letter is the stand-in's own last digit with the mark, where those fold into one: the normalised form of the
      // masked line is then the masked normalised form. Otherwise it is another hex letter that takes the mark, chosen by the stand-in.
      const s = k.inText.full(h);
      const shownLetter = views.normalised.slice(views.normalised.indexOf('urn:pev:rubric:') + 15 + 63)[0]!;
      expect([views.normalised.includes(`urn:pev:rubric:${s.slice(0, 63)}`), shownLetter.normalize('NFD').slice(1)], h).toEqual([true, mark]);
      if (`${s[63]!}${mark}`.normalize('NFC').length === 1) {
        ownTakes++;
        expect(normaliseForQuote(views.line), h).toBe(views.normalised);
      }
      // The same hash written with the letter itself, as NFC writes it: masked the same way in both forms.
      const precomposed = `Then urn:pev:rubric:${h.slice(0, 63)}${`${h[63]!}${mark}`.normalize('NFC')} came up and I asked what they thought.`;
      expect([maskText(precomposed, k), maskText(normaliseForQuote(precomposed), k)], h).toEqual([views.normalised, views.normalised]);
      // A quote copied from either view, with or without `urn:pev:rubric:`, reads back as the stored words and checks out.
      const turns = [{ index: 1, speaker: 'learner' as const, text: line }];
      const back = quoteAsStored(k, [line]);
      for (const [form, v] of Object.entries(views)) {
        for (const from of [v.indexOf('urn:pev:rubric:'), v.indexOf('urn:pev:rubric:') + 15]) {
          const copied = v.slice(from, v.indexOf(' and I asked'));
          const r = verifyQuoteAsShown({ text: copied, turnIndex: 1 }, turns, back);
          expect([r.verified, r.readBack, r.turnIndex], `${form} from ${from}: ${h}`).toEqual([true, true, 1]);
          // Shown from its line, or with no line to show it from: none of the hash in its words or its normalised form.
          for (const lines of [new Map([['urn:pev:attempt:unit', turns]]), new Map()]) {
            const out = JSON.stringify(maskAnswerHashes({ ...scope, attemptIri: 'urn:pev:attempt:unit', quotes: [r] }, m, scope, lines));
            expect([out.includes(h.slice(0, 63)), out.includes(h.slice(0, 16))], `${form} from ${from}: ${h}`).toEqual([false, false]);
          }
          expect(maskReadBackQuote(r.normalised!, k).includes(h.slice(0, 16)), h).toBe(false);
        }
      }
    }
    // Both ways the folded letter is chosen were met.
    expect([ownTakes > 0, ownTakes < hashes.length, hashes.length]).toEqual([true, true, 48]);
    // A run of 16 hex with nothing around it that a mark follows, in a read-back quote with no line to show it from: a stand-in
    // in both forms too.
    const h16 = hashes[0]!.slice(0, 15) + hashes[0]![63];
    const bare = `I noted ${h16}${markFor(h16[15]!)} for this step.`;
    for (const form of [bare, normaliseForQuote(bare)]) expect(maskReadBackQuote(form, k).includes(h16.slice(0, 15)), form).toBe(false);
  });

  it('a quote read back is checked as the stored words, saved as them and marked readBack, and shown as the judge copied it', () => {
    const m = hashMask(Buffer.alloc(32, 5));
    const scope = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    const k = m.version(scope.scenarioIri, scope.version);
    const h = RAW.rubric;
    const line = `Could you check urn:pev:rubric:${h} for me and pev/${h.slice(0, 16)}/asks-their-view before Friday?`;
    const turns = [{ index: 1, speaker: 'learner' as const, text: line }];
    const shown = maskText(line, k);
    const back = quoteAsStored(k, [line]);
    const from = shown.indexOf('urn:pev:rubric:') + 15;
    const to = shown.indexOf(' and pev/');
    const hexOnly = shown.slice(from, to);
    // Not found as sent; found as read back, and kept as the stored words, saying so.
    expect(verifyQuoteAsShown({ text: hexOnly, turnIndex: 1 }, turns).verified).toBe(false);
    const r = verifyQuoteAsShown({ text: hexOnly, turnIndex: 1 }, turns, back);
    expect([r.verified, r.readBack, r.text, r.turnIndex]).toEqual([true, true, line.slice(from, to), 1]);
    // A quote found as sent is not marked.
    const plain = verifyQuoteAsShown({ text: 'asks-their-view before Friday?', turnIndex: 1 }, turns, back);
    expect([plain.verified, 'readBack' in plain]).toEqual([true, false]);
    // A read-back quote that still does not check out is marked too: its text is the stored reading, not what was sent.
    const absent = verifyQuoteAsShown({ text: `${hexOnly} on Monday`, turnIndex: 1 }, turns, back);
    expect([absent.verified, absent.readBack, absent.text]).toEqual([false, true, `${line.slice(from, to)} on Monday`]);
    // An answer that masks text shows the saved quote as the judge copied it, the hash in it nowhere.
    const out = maskAnswerHashes({ ...scope, quotes: [r, plain] }, m, scope) as { quotes: { text: string; normalised: string }[] };
    expect([out.quotes[0]!.text, out.quotes[0]!.normalised, out.quotes[1]!.text]).toEqual([hexOnly, normaliseForQuote(hexOnly), plain.text]);
    expect([JSON.stringify(out).includes(h), JSON.stringify(out).includes(h.slice(0, 16))]).toEqual([false, false]);
    expect(maskReadBackQuote(`urn:pev:rubric:${h} ${h} pev/${h.slice(0, 16)}/x ${h.slice(0, 16)}`, k))
      .toBe(`urn:pev:rubric:${k.inText.full(h)} ${k.inText.full(h)} pev/${k.inText.prefix(h.slice(0, 16))}/x ${k.inText.prefix(h.slice(0, 16))}`);
  });

  it('a turn, a judge\'s quotes and rationale, a reviewer\'s reasons, a contest, a redaction and a scored scenario\'s words: read back as a chat, a key nobody registered, or unsigned', async () => {
    // A scored scenario whose first criterion's title holds the scored scenario's rubric IRI, as an author may write it.
    const input = demoScenarioInput('missed-deadline', 2);
    const rubric = input['rubric'] as { criteria: Out[] };
    const withTitle = {
      ...input, scenarioKey: 'fingerprint-in-text', title: 'A fingerprint in the text',
      rubric: { ...rubric, criteria: [{ ...rubric.criteria[0]!, title: `Names what happened urn:pev:rubric:${RAW.rubric}` }, ...rubric.criteria.slice(1)] },
    };
    const G = coerceScenario(withTitle);
    if (!('value' in G)) throw new Error('the scenario does not coerce');
    const own = rubricHash(G.value.rubric);
    const bare = [own, scenarioHash(G.value), RAW.rubric, RAW.scenario];
    // The caller's guesses: a wrong one, the scenario's own rubric hash, and the scored scenario's.
    const wrong = sha256('a wrong guess');
    const guess = asText([wrong, own, RAW.rubric]);
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: withTitle, status: 'published', draftAssistance: { used: false } }));
    expect(pub['rubricHash']).toBe(own);
    const sc = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: sc, version: 1, scenarioHash: pub['scenarioHash'] }));

    // A key nobody registered says the guesses, and reads its attempt back.
    const fresh = ok(await kact(H, 'pev.start_attempt', FRESH, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    noGuessCheckable(ok(await kact(H, 'pev.say', FRESH, { attemptIri: fresh['attemptIri'], turnIndex: 1, text: guess })), 0, bare, 'say with a fresh key');
    noGuessCheckable(await kact(H, 'pev.get_attempt', FRESH, { attemptIri: fresh['attemptIri'] }), 7, bare, 'the turn read with a fresh key');

    // The learner's chat says them, ends, and has the bridge's model judge.
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    const a = String(start['attemptIri']);
    const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 1, text: `I want to talk about Thursday's report. ${guess}` }));
    ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: a, turnIndex: said['nextTurnIndex'] }));
    ok(await ract(H, 'pev.judge_attempt', P.learner.claude, { attemptIri: a }));
    noGuessCheckable(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: a }), 7, bare, 'the turn read from the learner\'s Claude');

    // An appointed judge's chat writes them into its quotes and rationale.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }));
    noGuessCheckable(packet, 7, bare, 'the judge packet');
    const judgment = { criteria: G.value.rubric.criteria.map((c) => ({ criterionId: c.id, level: c.levels[1]!.id, quotes: [{ text: guess, turnIndex: 1 }], rationale: `As quoted: ${guess}` })) };
    ok(await ract(H, 'pev.record_judgment', P.judge.claude, { attemptIri: a, ...(packet['binding'] as Out), judgment, judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true } }));
    noGuessCheckable(await ract(H, 'pev.get_attempt', P.judge.claude, { attemptIri: a }), 40, bare, 'the judgment read from the judge\'s Claude');

    // A reviewer's reasons, set in the web app, read back from chats and in the results and calibration.
    const view = ok(await ract(H, 'pev.get_attempt', P.reviewer2.web, { attemptIri: a }));
    const levels = G.value.rubric.criteria.map((c) => ({ criterionId: c.id, levelId: c.levels[2]!.id, why: `Raised; see urn:pev:rubric:${own}` }));
    ok(await ract(H, 'pev.override_attempt', P.reviewer2.web, { attemptIri: a, target: view['currentTarget'], levels, sawJudgeLevelsFirst: true }));
    noGuessCheckable(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: a }), 40, bare, 'the reviewed attempt from the learner\'s Claude');
    noGuessCheckable(await ract(H, 'pev.scenario_results', P.reviewer2.claude, { scenarioIri: sc }), 1, bare, 'results from a reviewer\'s Claude');
    noGuessCheckable((await H['pev.calibration']!({})) as Out, 1, bare, 'calibration, unsigned');

    // The learner's chat contests with them, and removes the transcript with them as its reason.
    const before = ok(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: a }));
    const why = `Please read it again: ${asText([wrong, own])}`;
    noGuessCheckable(await ract(H, 'pev.contest_review', P.learner.chatgpt, { attemptIri: a, target: before['currentTarget'], why }), 0, bare, 'the contest');
    noGuessCheckable(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: a }), 44, bare, 'the contested attempt from the learner\'s Claude');
    const again = ok(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: a }));
    noGuessCheckable(await ract(H, 'pev.redact_attempt', P.learner.claude, { attemptIri: a, target: again['currentTarget'], why }), 0, bare, 'the redaction');
    // The reason, once, and the criterion's title: the removal's signed request is shown without what it signed.
    noGuessCheckable(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: a }), 5, bare, 'the redacted attempt from the learner\'s Claude');

    // The author's chat edits only the scored scenario's words, keeping its stakes, and reads them back.
    const listed = ok(await ract(H, 'pev.list_scenarios', P.author.claude, { scenarioIri: sc }));
    const head = listed['scenario'] as Out;
    const sent = withoutStakes({ ...withTitle, situation: `${String(input['situation'])} ${guess}` });
    const { passGateWhy: _w, ...plain } = sent;
    const edited = ok(await ract(H, 'pev.author_scenario', P.author.claude, { scenario: plain, status: 'draft', basedOnVersion: head['version'], draftAssistance: { used: false } }));
    expect((edited['stakesKept'] as Out)['fromVersion']).toBe(1);
    noGuessCheckable(edited, 0, bare, 'the edit saved from the author\'s Claude');
    noGuessCheckable(await ract(H, 'pev.list_scenarios', P.author.claude, { scenarioIri: sc, includeDrafts: true }), 7, bare, 'the edited scenario from the author\'s Claude');
    noGuessCheckable((await H['pev.list_scenarios']!({ scenario_iri: sc })) as Out, 1, bare, 'the scenario, unsigned');
  }, SLOW);

  it('the same fingerprint written into text is one stand-in wherever that session is shown, and never a value this bridge keyed', async () => {
    const listed = ok(await ract(H, 'pev.list_scenarios', P.learner.claude, { scenarioIri: X['sc'] }));
    const head = listed['scenario'] as Out;
    expect(head['assessmentUse']).toBe('pass-gate');
    const start = ok(await kact(H, 'pev.start_attempt', FRESH, { scenarioIri: X['sc'], scenarioVersion: head['version'], coached: false }));
    const a = String(start['attemptIri']);
    // The session's own rubric hash, a right guess, written three times over two lines, as a rubric IRI and as a kind.
    const said = ok(await kact(H, 'pev.say', FRESH, { attemptIri: a, turnIndex: 1, text: `${asText([RAW.rubric])} and again urn:pev:rubric:${RAW.rubric}` }));
    const said2 = ok(await kact(H, 'pev.say', FRESH, { attemptIri: a, turnIndex: said['nextTurnIndex'], text: asText([RAW.rubric]) }));
    ok(await kact(H, 'pev.end_conversation', FRESH, { attemptIri: a, turnIndex: said2['nextTurnIndex'] }));
    const standIns = (r: unknown): { full: string[]; prefix: string[] } => {
      const t = hashesIn(r).inText;
      return { full: [...new Set(t.filter((x) => x.length === 64))], prefix: [...new Set(t.filter((x) => x.length === 16))] };
    };
    const views: [string, Out][] = [
      ['the line as said', said],
      ['the session', ok(await kact(H, 'pev.get_attempt', FRESH, { attemptIri: a }))],
      ['the session read again', ok(await kact(H, 'pev.get_attempt', FRESH, { attemptIri: a }))],
      ['a judge\'s packet', ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }))],
      ['the session from a reviewer\'s chat', ok(await ract(H, 'pev.get_attempt', P.reviewer.claude, { attemptIri: a }))],
    ];
    const first = standIns(views[0]![1]);
    expect([first.full.length, first.prefix.length]).toEqual([1, 1]);
    // One stand-in for the hash and one for its prefix, in every view of the session, to every caller who reads no stakes.
    for (const [what, r] of views) expect(standIns(r), what).toEqual(first);
    // None is a value this bridge keyed: not the session's own keyed rubric hash beside it, nor any field of what else the caller reads.
    const elsewhere = [listed, ok(await ract(H, 'pev.list_scenarios', P.learner.claude)), (await H['pev.calibration']!({})) as Out,
      ok(await ract(H, 'pev.scenario_results', P.reviewer.claude, { scenarioIri: X['sc'] }))];
    for (const [what, r] of views.slice(1)) noGuessCheckable(r, 5, [RAW.rubric, RAW.scenario], what, elsewhere);
    const keyedHere = String(((views[1]![1])['scenario'] as Out)['rubricHash']);
    expect([first.full[0] === keyedHere, first.prefix[0] === keyedHere.slice(0, 16), first.full[0]!.slice(0, 16) === keyedHere.slice(0, 16)]).toEqual([false, false, false]);
  }, SLOW);

  it('a judge\'s chat that quotes a line holding a fingerprint, copied from the judge packet or the session as shown to it, has the quote checked and its levels credited', async () => {
    // A scored scenario of its own, practised from the learner's chat.
    const input = { ...demoScenarioInput('missed-deadline', 2), scenarioKey: 'quoted-fingerprint', title: 'A quoted fingerprint' };
    const S = coerceScenario(input);
    if (!('value' in S)) throw new Error('the scenario does not coerce');
    const own = rubricHash(S.value.rubric);
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: input, status: 'published', draftAssistance: { used: false } }));
    const sc = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: sc, version: 1, scenarioHash: pub['scenarioHash'] }));
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    const a = String(start['attemptIri']);
    // As in the review's case: a learner line holding a rubric IRI and a calibration kind (here the session's own rubric's).
    const line = `Before we met I looked up urn:pev:rubric:${own} and pev/${own.slice(0, 16)}/asks-their-view, and I would like us to agree a new date for the report.`;
    const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 1, text: line }));
    ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: a, turnIndex: said['nextTurnIndex'] }));
    const cut = line.indexOf(', and I would');
    const top = S.value.rubric.criteria.map((c) => c.levels[c.levels.length - 1]!.id);
    const judgeWith = async (judge: Person, quote: string): Promise<Out> => {
      const packet = ok(await ract(H, 'pev.judge_packet', judge.claude, { attemptIri: a }));
      return ok(await ract(H, 'pev.record_judgment', judge.claude, {
        attemptIri: a, ...(packet['binding'] as Out), judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true },
        judgment: { criteria: S.value.rubric.criteria.map((c, i) => ({ criterionId: c.id, level: top[i], quotes: [{ text: quote, turnIndex: 1 }], rationale: 'The quoted line shows it.' })) },
      }));
    };
    type Saved = { criteria: { levelId: string; status: string; quotes: { text: string; verified: boolean }[] }[]; unverifiedCriteria: string[] };
    const checked = (r: Out, quote: string, what: string): void => {
      const j = r['judgment'] as Saved;
      expect(j.unverifiedCriteria, what).toEqual([]);
      expect(j.criteria.map((c) => [c.levelId, c.status, c.quotes.map((q) => [q.text, q.verified])]), what).toEqual(top.map((l) => [l, 'verified', [[quote, true]]]));
    };

    // One judge's chat copies the quote from the packet's transcript, character for character, as the packet asks.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }));
    const user = String((packet['request'] as Out)['user']);
    const shown = user.split('\n').find((l) => l.startsWith('[T1 LEARNER] '))!.slice('[T1 LEARNER] '.length);
    // The line as the packet shows it: the fingerprints replaced with stand-ins of the same length, and nothing else.
    expect([shown.includes(own), shown.includes(own.slice(0, 16)), shown.length, shown.slice(cut)]).toEqual([false, false, line.length, line.slice(cut)]);
    const fromPacket = shown.slice(0, cut);
    checked(await judgeWith(P.judge, fromPacket), fromPacket, 'a quote copied from the packet');

    // Another judge's chat copies it from the session as the attempt shows it, which is the same line.
    const view = ok(await ract(H, 'pev.get_attempt', P.judgeReviewer.claude, { attemptIri: a }));
    const t1 = String((view['turns'] as Out[]).find((t) => t['index'] === 1)!['text']);
    expect(t1).toBe(shown);
    const fromView = t1.slice(t1.indexOf('urn:pev:rubric:'), cut);
    checked(await judgeWith(P.judgeReviewer, fromView), fromView, 'a quote copied from the session');

    // Read in the web app: both judgments credit the levels as given, and keep each quote as the learner's own words.
    const web = webAnswer(await ract(H, 'pev.get_attempt', P.reviewer.web, { attemptIri: a }), 'the judged session in the web app');
    const js = web['judgments'] as { criteria: { status: string; quotes: { text: string; verified: boolean }[] }[]; unverifiedCriteria: string[]; provisional: { perCriterion: { levelId: string }[] } }[];
    expect(js.map((j) => [j.unverifiedCriteria, j.provisional.perCriterion.map((p) => p.levelId), [...new Set(j.criteria.flatMap((c) => c.quotes.map((q) => [q.text, q.verified])).map((x) => JSON.stringify(x)))]]))
      .toEqual([line.slice(0, cut), line.slice(line.indexOf('urn:pev:rubric:'), cut)].map((q) => [[], top, [JSON.stringify([q, true])]]));
    // Read from a chat: each quote as that chat's view shows the line, and every highlight on the stored line marks it.
    const chat = chatAnswer(await ract(H, 'pev.get_attempt', P.judge.claude, { attemptIri: a }), 'the judged session from a judge\'s chat');
    const norm = String((chat['turns'] as Out[]).find((t) => t['index'] === 1)!['normalisedText']);
    const marks = (chat['highlights'] as { turnIndex: number; start: number; end: number }[]).filter((h) => h.turnIndex === 1).map((h) => norm.slice(h.start, h.end));
    expect(marks.sort()).toEqual([...top.map(() => fromPacket), ...top.map(() => fromView)].sort());
  }, SLOW);

  it('a judge\'s chat that quotes a stand-in without its frame, from a line a Kelvin sign starts, has each quote read back, credited and marked', async () => {
    const input = { ...demoScenarioInput('missed-deadline', 2), scenarioKey: 'quoted-hex', title: 'A quoted stand-in without its frame' };
    const S = coerceScenario(input);
    if (!('value' in S)) throw new Error('the scenario does not coerce');
    const own = rubricHash(S.value.rubric);
    const own16 = own.slice(0, 16);
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: input, status: 'published', draftAssistance: { used: false } }));
    const sc = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: sc, version: 1, scenarioHash: pub['scenarioHash'] }));
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    const a = String(start['attemptIri']);
    // A line starting with a Kelvin sign (U+212A), which NFC folds into an ASCII K, before a kind, and holding a rubric IRI.
    const line = `\u212Apev/${own16}/asks-their-view was my note, and I checked urn:pev:rubric:${own} for me before we agreed a new date for the report.`;
    const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 1, text: line }));
    ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: a, turnIndex: said['nextTurnIndex'] }));

    // The packet shows the line normalised: the Kelvin sign is a K there, and the kind is a stand-in all the same.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }));
    const user = String((packet['request'] as Out)['user']);
    const shown = user.split('\n').find((l) => l.startsWith('[T1 LEARNER] '))!.slice('[T1 LEARNER] '.length);
    expect([shown.startsWith('Kpev/'), shown.includes(own), shown.includes(own16), shown.length]).toEqual([true, false, false, normaliseForQuote(line).length]);
    // Quotes as the review found them failing: the IRI's hex alone, a kind from the Kelvin sign, the kind's hex on; and a plain one.
    const iriHex = shown.indexOf('urn:pev:rubric:') + 15;
    const quotes = [
      [shown.slice(iriHex, shown.indexOf(' before we')), 'before we agreed a new date for the report'],
      [shown.slice(0, shown.indexOf(', and I'))],
      [shown.slice(5, shown.indexOf(' was my note'))],
    ];
    const top = S.value.rubric.criteria.map((c) => c.levels[c.levels.length - 1]!.id);
    const saved = chatAnswer(await ract(H, 'pev.record_judgment', P.judge.claude, {
      attemptIri: a, ...(packet['binding'] as Out), judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true },
      judgment: { criteria: S.value.rubric.criteria.map((c, i) => ({ criterionId: c.id, level: top[i], quotes: quotes[i]!.map((text) => ({ text, turnIndex: 1 })), rationale: 'The quoted line shows it.' })) },
    }), 'the saved judgment', false); // record_judgment's answer holds no result, so it has nothing to leave out, and no mark.
    type Q = { text: string; verified: boolean; readBack?: true };
    type J = { criteria: { levelId: string; status: string; quotes: Q[] }[]; unverifiedCriteria: string[] };
    const asSaved = (j: J): unknown => j.criteria.map((c) => [c.levelId, c.status, c.quotes.map((q) => [q.text, q.verified, q.readBack ?? null])]);
    const readBack = [[true, null], [true], [true]];
    const each = (texts: string[][]): unknown => top.map((l, i) => [l, 'verified', texts[i]!.map((t, n) => [t, true, readBack[i]![n]])]);
    // The judge's chat reads each quote back as it copied it, credited at the level given, and the read-back ones marked.
    expect([(saved['judgment'] as J).unverifiedCriteria, asSaved(saved['judgment'] as J)]).toEqual([[], each(quotes)]);
    expect([JSON.stringify(saved).includes(own), JSON.stringify(saved).includes(own16)]).toEqual([false, false]);

    // The web app reads each saved quote as the learner's words, normalised as the quote rule reads them.
    const stored = normaliseForQuote(line);
    const web = webAnswer(await ract(H, 'pev.get_attempt', P.reviewer.web, { attemptIri: a }), 'the judged session in the web app');
    const learnerWords = [
      [stored.slice(iriHex, stored.indexOf(' before we')), 'before we agreed a new date for the report'],
      [stored.slice(0, stored.indexOf(', and I'))],
      [stored.slice(5, stored.indexOf(' was my note'))],
    ];
    expect(learnerWords.flat().filter((t) => t.includes(own16)).length).toBe(3);
    expect(asSaved((web['judgments'] as J[])[0]!)).toEqual(each(learnerWords));

    // A chat reads the session as the judge's chat did: no fingerprint, the line, its normalised form and the quotes alike.
    const chat = chatAnswer(await ract(H, 'pev.get_attempt', P.judge.claude, { attemptIri: a }), 'the judged session from a judge\'s chat');
    const t1 = (chat['turns'] as Out[]).find((t) => t['index'] === 1)!;
    expect([String(t1['text']).includes(own16), String(t1['normalisedText']).includes(own16), t1['normalisedText'] === shown]).toEqual([false, false, true]);
    expect([JSON.stringify(chat).includes(own), JSON.stringify(chat).includes(own16)]).toEqual([false, false]);
    expect(asSaved((chat['judgments'] as J[])[0]!)).toEqual(each(quotes));
  }, SLOW);

  it('a quote read back from a line holding a fingerprint and an unrelated bare run of hex is shown as that line shows its stretch, normal or normalised, and a copy of it reads back again and again', () => {
    const m = hashMask(Buffer.alloc(32, 13));
    const scope = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    const k = m.version(scope.scenarioIri, scope.version);
    const h = RAW.rubric;
    const h16 = h.slice(0, 16);
    // Runs of 64 and 16 hex that are no rubric's: a fictional build and ticket reference the learner read out.
    const b = sha256('a fictional build reference');
    const b16 = sha256('a fictional ticket reference').slice(0, 16);
    // A double space and a curly apostrophe inside the stretch quoted, so the line and its normalised form differ there.
    const line = `It was urn:pev:rubric:${h} beside  build ${b}’s ticket ${b16} and pev/${h16}/asks-their-view, I said.`;
    const attemptIri = 'urn:pev:attempt:unit';
    const turns = [{ index: 1, speaker: 'learner' as const, text: line }, { index: 2, speaker: 'counterpart' as const, text: 'Go on.' }];
    const lines = new Map([[attemptIri, turns]]);
    const back = quoteAsStored(k, [line]);
    const norm = normaliseForQuote(line);
    const views = { line: maskText(line, k), normalised: maskText(norm, k) };
    // The transcript masks the fingerprints and leaves the bare runs as written.
    for (const v of Object.values(views)) expect([v.includes(h), v.includes(h16), v.includes(b), v.includes(b16)]).toEqual([false, false, true, true]);
    type Shown = { text: string; normalised?: string };
    for (const [form, view] of Object.entries(views)) {
      // From the rubric IRI's stand-in, without its frame, to the kind's stand-in, without `pev/` or the closing `/`.
      const copied = view.slice(view.indexOf('urn:pev:rubric:') + 15, view.indexOf('/asks-their-view'));
      let quote = copied;
      for (let round = 1; round <= 3; round++) {
        const what = `copied from the ${form}, round ${round}`;
        const r = verifyQuoteAsShown({ text: quote, turnIndex: 1 }, turns, back);
        expect([r.verified, r.readBack, r.turnIndex], what).toEqual([true, true, 1]);
        // Saved as the learner's words, the fingerprints in them bare, as the transcript hash and highlights read them.
        expect([r.text!.includes(h), r.normalised, norm.slice(r.start!, r.end!)], what).toEqual([true, normaliseForQuote(r.text!), r.normalised]);
        const out = (maskAnswerHashes({ ...scope, attemptIri, quotes: [r] }, m, scope, lines) as { quotes: Shown[] }).quotes[0]!;
        // Shown exactly as the view it was copied from shows that stretch of the line: the bare runs as written, nothing bare that is not.
        expect([out.text, out.normalised], what).toEqual([copied, views.normalised.slice(r.start!, r.end!)]);
        expect([JSON.stringify(out).includes(h), JSON.stringify(out).includes(h16), out.text.includes(b), out.text.includes(b16)], what).toEqual([false, false, true, true]);
        quote = out.text;
      }
      // A judge's own saved answer holds the quote without its place in the line: shown the same, found again in the line.
      const r = verifyQuoteAsShown({ text: copied, turnIndex: 1 }, turns, back);
      const saved = maskAnswerHashes({ attemptIri, ...scope, judgment: { criteria: [{ quotes: [{ text: r.text, verified: true, readBack: true }] }] } }, m, scope, lines) as { judgment: { criteria: { quotes: Shown[] }[] } };
      expect(saved.judgment.criteria[0]!.quotes[0]!.text, form).toBe(copied);
    }
    // A read-back quote that did not check out, or one shown with no line to project it from: every run of hex in it a stand-in.
    const unverified = verifyQuoteAsShown({ text: `${views.normalised.slice(views.normalised.indexOf('urn:pev:rubric:') + 15, views.normalised.indexOf(' beside'))} was never said`, turnIndex: 1 }, turns, back);
    expect([unverified.verified, unverified.readBack]).toEqual([false, true]);
    const r = verifyQuoteAsShown({ text: views.normalised.slice(views.normalised.indexOf('urn:pev:rubric:') + 15, views.normalised.indexOf('/asks-their-view')), turnIndex: 1 }, turns, back);
    for (const [q, at] of [[unverified, attemptIri], [r, 'urn:pev:attempt:not-shown']] as const) {
      const out = JSON.stringify(maskAnswerHashes({ ...scope, attemptIri: at, quotes: [q] }, m, scope, lines));
      expect([out.includes(h), out.includes(h16)]).toEqual([false, false]);
    }
  });

  it('a judge\'s chat that quotes a line holding a fingerprint and an unrelated bare run of hex sees the quote as the packet shows it, and another judge\'s copy of that checks out', async () => {
    const input = { ...demoScenarioInput('missed-deadline', 2), scenarioKey: 'quoted-mixed-hex', title: 'A quoted fingerprint beside a bare run of hex' };
    const S = coerceScenario(input);
    if (!('value' in S)) throw new Error('the scenario does not coerce');
    const own = rubricHash(S.value.rubric);
    const own16 = own.slice(0, 16);
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: input, status: 'published', draftAssistance: { used: false } }));
    const sc = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: sc, version: 1, scenarioHash: pub['scenarioHash'] }));
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    const a = String(start['attemptIri']);
    // As the peer review found it: a framed rubric IRI, and a run of 64 hex that is no rubric's (a fictional build reference).
    const build = sha256('a fictional build reference the learner read out');
    const line = `I traced urn:pev:rubric:${own} to build ${build} and I would like us to agree a new date for the report.`;
    const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 1, text: line }));
    ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: a, turnIndex: said['nextTurnIndex'] }));
    const top = S.value.rubric.criteria.map((c) => c.levels[c.levels.length - 1]!.id);
    type Q = { text: string; normalised?: string; verified: boolean; readBack?: true; why?: string };
    type J = { criteria: { levelId: string; status: string; quotes: Q[] }[]; unverifiedCriteria: string[] };
    const judgeWith = async (judge: Person, quote: string): Promise<J> => {
      const packet = ok(await ract(H, 'pev.judge_packet', judge.claude, { attemptIri: a }));
      return chatAnswer(await ract(H, 'pev.record_judgment', judge.claude, {
        attemptIri: a, ...(packet['binding'] as Out), judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true },
        judgment: { criteria: S.value.rubric.criteria.map((c, i) => ({ criterionId: c.id, level: top[i], quotes: [{ text: quote, turnIndex: 1 }], rationale: 'The quoted line shows it.' })) },
      }), `the judgment saved from ${judge.claude}`, false)['judgment'] as J;
    };
    const asSaved = (j: J): unknown => [j.unverifiedCriteria, j.criteria.map((c) => [c.levelId, c.status, c.quotes.map((q) => [q.text, q.verified, q.readBack ?? null, q.why ?? null])])];
    const credited = (quote: string): unknown => [[], top.map((l) => [l, 'verified', [[quote, true, true, null]]])];

    // The packet shows the fingerprint as a stand-in and the build reference as written.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }));
    const shown = String((packet['request'] as Out)['user']).split('\n').find((l) => l.startsWith('[T1 LEARNER] '))!.slice('[T1 LEARNER] '.length);
    expect([shown.includes(own), shown.includes(build), shown.length]).toEqual([false, true, line.length]);
    const fromPacket = shown.slice(shown.indexOf('urn:pev:rubric:'), shown.indexOf(' and I would'));

    // The first judge's chat copies it from the packet: read back, credited, and shown as the packet shows it.
    const first = await judgeWith(P.judge, fromPacket);
    expect(asSaved(first)).toEqual(credited(fromPacket));
    // A second judge's chat copies the quote as the first one's answer shows it: it reads back and checks out too.
    const copied = first.criteria[0]!.quotes[0]!.text;
    expect(asSaved(await judgeWith(P.judgeReviewer, copied))).toEqual(credited(fromPacket));

    // The web app keeps both as the learner's words.
    const web = webAnswer(await ract(H, 'pev.get_attempt', P.reviewer.web, { attemptIri: a }), 'the judged session in the web app');
    const stored = line.slice(line.indexOf('urn:pev:rubric:'), line.indexOf(' and I would'));
    for (const j of web['judgments'] as J[]) expect(asSaved(j)).toEqual(credited(stored));
    // Every chat view of the session, and the review queue, shows each quote as the packet shows that stretch of the line.
    const chat = chatAnswer(await ract(H, 'pev.get_attempt', P.judge.claude, { attemptIri: a }), 'the judged session from a judge\'s chat');
    expect((chat['turns'] as Out[]).find((t) => t['index'] === 1)!['normalisedText']).toBe(shown);
    const queue = chatAnswer(await ract(H, 'pev.review_queue', P.reviewer.claude, { limit: 100 }), 'the review queue from a reviewer\'s chat');
    const entry = (queue['entries'] as Out[]).find((e) => e['attemptIri'] === a)!;
    for (const [what, js] of [['the session', chat['judgments']], ['the review queue', entry['judgments']]] as const) {
      expect((js as J[]).map(asSaved), what).toEqual([credited(fromPacket), credited(fromPacket)]);
      expect([...new Set((js as J[]).flatMap((j) => j.criteria.flatMap((c) => c.quotes.map((q) => q.normalised))))], what).toEqual([fromPacket]);
    }
    for (const r of [chat, queue]) expect([JSON.stringify(r).includes(own), JSON.stringify(r).includes(own16)]).toEqual([false, false]);
  }, SLOW);

  it('a read-back quote whose words sit in two turns is shown from the turn it was matched in, also where an answer gives that turn alone', () => {
    const m = hashMask(Buffer.alloc(32, 17));
    const scope = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    const k = m.version(scope.scenarioIri, scope.version);
    const h16 = RAW.rubric.slice(0, 16);
    // T1 holds the kind's hex as written, with nothing around it; T3 the kind itself, which every view shows as a stand-in.
    const turns = [
      { index: 1, speaker: 'learner' as const, text: `I noted ${h16}/ for this step and we should agree a new date.` },
      { index: 2, speaker: 'counterpart' as const, text: 'Go on.' },
      { index: 3, speaker: 'learner' as const, text: `Then I read pev/${h16}/ for this step and we should agree a new date.` },
    ];
    const attemptIri = 'urn:pev:attempt:unit-two-turns';
    const shownT3 = maskText(turns[2]!.text, k);
    const copied = shownT3.slice(shownT3.indexOf('pev/') + 4, shownT3.indexOf(' and we'));
    const r = verifyQuoteAsShown({ text: copied, turnIndex: 3 }, turns, quoteAsStored(k, turns.map((t) => t.text)));
    expect([r.verified, r.readBack, r.turnIndex, r.text]).toEqual([true, true, 3, `${h16}/ for this step`]);
    const shown = (q: Out): string => (maskAnswerHashes({ ...scope, attemptIri, quotes: [q] }, m, scope, new Map([[attemptIri, turns]])) as { quotes: { text: string }[] }).quotes[0]!.text;
    // Its place in full, or its turn alone: shown as T3 shows it, never as the bare hex T1 holds.
    expect(shown({ text: r.text, verified: true, readBack: true, turnIndex: 3, start: r.start, end: r.end })).toBe(copied);
    expect(shown({ text: r.text, verified: true, readBack: true, turnIndex: 3 })).toBe(copied);
  });

  it('a judge\'s own saved answer shows a read-back quote from the turn it was matched in, as the session does, when the same words sit in another turn', async () => {
    // Version 1's rubric, so the kind's hex T1 holds as written is not the scored demo rubric's, which no chat answer holds bare.
    const input = { ...demoScenarioInput('missed-deadline', 1), scenarioKey: 'quoted-in-two-turns', title: 'The same words in two turns' };
    const S = coerceScenario(input);
    if (!('value' in S)) throw new Error('the scenario does not coerce');
    const own16 = rubricHash(S.value.rubric).slice(0, 16);
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: input, status: 'published', draftAssistance: { used: false } }));
    const sc = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: sc, version: 1, scenarioHash: pub['scenarioHash'] }));
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    const a = String(start['attemptIri']);
    // As the peer review found it: T1 holds the kind's hex as written, with nothing around it; T3 the kind itself.
    const first = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 1, text: `I noted ${own16}/ for this step and we should agree a new date.` }));
    expect(first['nextTurnIndex']).toBe(3);
    const third = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 3, text: `Then I read pev/${own16}/ for this step and we should agree a new date.` }));
    ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: a, turnIndex: third['nextTurnIndex'] }));
    // The judge's chat copies the kind's stand-in on from T3 as the packet shows it, and says it is from T3.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }));
    const t3 = String((packet['request'] as Out)['user']).split('\n').find((l) => l.startsWith('[T3 LEARNER] '))!;
    const fromPacket = t3.slice(t3.indexOf('pev/') + 4, t3.indexOf(' and we'));
    expect([fromPacket.includes(own16), fromPacket.endsWith('/ for this step')]).toEqual([false, true]);
    type Q = { text: string; verified: boolean; readBack?: true; turnIndex?: number; start?: number; end?: number };
    type J = { criteria: { quotes: Q[] }[] };
    const saved = chatAnswer(await ract(H, 'pev.record_judgment', P.judge.claude, {
      attemptIri: a, ...(packet['binding'] as Out), judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true },
      judgment: { criteria: S.value.rubric.criteria.map((c) => ({ criterionId: c.id, level: c.levels[c.levels.length - 1]!.id, quotes: [{ text: fromPacket, turnIndex: 3 }], rationale: 'The quoted line shows it.' })) },
    }), 'the judgment saved from a judge\'s chat', false);
    const session = chatAnswer(await ract(H, 'pev.get_attempt', P.judge.claude, { attemptIri: a }), 'the judged session from a judge\'s chat');
    const place = (q: Q): unknown => [q.text, q.verified, q.readBack ?? null, q.turnIndex ?? null];
    // The saved answer and the session show the quote alike: as T3 shows it, from T3, the hex it stands for nowhere.
    for (const [what, j] of [['the saved answer', saved['judgment']], ['the session', (session['judgments'] as J[])[0]]] as const) {
      expect((j as J).criteria.map((c) => c.quotes.map(place)), what).toEqual(S.value.rubric.criteria.map(() => [[fromPacket, true, true, 3]]));
    }
    const savedQuote = (saved['judgment'] as J).criteria[0]!.quotes[0]!;
    const sessionQuote = (session['judgments'] as J[])[0]!.criteria[0]!.quotes[0]!;
    expect([savedQuote.start, savedQuote.end]).toEqual([sessionQuote.start, sessionQuote.end]);
    expect(JSON.stringify(saved).includes(own16)).toBe(false);
  }, SLOW);

  it('a judge\'s chat that quotes a line holding a fingerprint and the stand-in it is shown as, written out by the learner, has the quote read back and credited', async () => {
    const input = { ...demoScenarioInput('missed-deadline', 2), scenarioKey: 'quoted-written-stand-in', title: 'A stand-in written out beside its fingerprint' };
    const S = coerceScenario(input);
    if (!('value' in S)) throw new Error('the scenario does not coerce');
    const own = rubricHash(S.value.rubric);
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: input, status: 'published', draftAssistance: { used: false } }));
    const sc = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: sc, version: 1, scenarioHash: pub['scenarioHash'] }));
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    const a = String(start['attemptIri']);
    const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 1, text: `I traced urn:pev:rubric:${own} first.` }));
    // The learner's chat reads the session, copies the stand-in its first line is shown with, and writes it out beside the fingerprint.
    const mine = chatAnswer(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: a }), 'the session from the learner\'s chat');
    const t1 = String((mine['turns'] as Out[]).find((t) => t['index'] === 1)!['text']);
    const standIn = t1.slice(t1.indexOf('urn:pev:rubric:') + 15, t1.indexOf(' first.'));
    expect([standIn.length, standIn === own]).toEqual([64, false]);
    const line = `So urn:pev:rubric:${own} equals ${standIn} and I would like us to agree a new date for the report.`;
    const third = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: said['nextTurnIndex'], text: line }));
    ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: a, turnIndex: third['nextTurnIndex'] }));
    // The packet shows both as the stand-in; the judge's chat quotes them from it.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }));
    const shown = String((packet['request'] as Out)['user']).split('\n').find((l) => l.startsWith(`[T${String(said['nextTurnIndex'])} LEARNER] `))!;
    const fromPacket = shown.slice(shown.indexOf('urn:pev:rubric:'), shown.indexOf(' and I would'));
    expect(fromPacket).toBe(`urn:pev:rubric:${standIn} equals ${standIn}`);
    type Q = { text: string; verified: boolean; readBack?: true };
    type J = { criteria: { status: string; quotes: Q[] }[]; unverifiedCriteria: string[] };
    const saved = chatAnswer(await ract(H, 'pev.record_judgment', P.judge.claude, {
      attemptIri: a, ...(packet['binding'] as Out), judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true },
      judgment: { criteria: S.value.rubric.criteria.map((c) => ({ criterionId: c.id, level: c.levels[c.levels.length - 1]!.id, quotes: [{ text: fromPacket, turnIndex: said['nextTurnIndex'] }], rationale: 'The quoted line shows it.' })) },
    }), 'the judgment saved from a judge\'s chat', false);
    const j = saved['judgment'] as J;
    expect([j.unverifiedCriteria, j.criteria.map((c) => [c.status, c.quotes.map((q) => [q.text, q.verified, q.readBack ?? null])])])
      .toEqual([[], S.value.rubric.criteria.map(() => ['verified', [[fromPacket, true, true]]])]);
    // The web app keeps it as the learner's words: the fingerprint put back, the stand-in they wrote out as they wrote it.
    const web = webAnswer(await ract(H, 'pev.get_attempt', P.reviewer.web, { attemptIri: a }), 'the judged session in the web app');
    expect((web['judgments'] as J[])[0]!.criteria[0]!.quotes[0]!.text).toBe(`urn:pev:rubric:${own} equals ${standIn}`);
  }, SLOW);

  it('a judge\'s chat that quotes, from the packet, a fingerprint and four copies of its stand-in the learner wrote out has the quote read back and credited, and so has a copy of it', async () => {
    const input = { ...demoScenarioInput('missed-deadline', 2), scenarioKey: 'quoted-many-stand-ins', title: 'A stand-in written out four times beside its fingerprint' };
    const S = coerceScenario(input);
    if (!('value' in S)) throw new Error('the scenario does not coerce');
    const own = rubricHash(S.value.rubric);
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: input, status: 'published', draftAssistance: { used: false } }));
    const sc = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: sc, version: 1, scenarioHash: pub['scenarioHash'] }));
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    const a = String(start['attemptIri']);
    const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 1, text: `I traced urn:pev:rubric:${own} first.` }));
    const mine = chatAnswer(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: a }), 'the session from the learner\'s chat');
    const t1 = String((mine['turns'] as Out[]).find((t) => t['index'] === 1)!['text']);
    const standIn = t1.slice(t1.indexOf('urn:pev:rubric:') + 15, t1.indexOf(' first.'));
    // As the peer review found it: one framed fingerprint, then four copies of its stand-in, with ordinary words between.
    const line = `So urn:pev:rubric:${own} equals ${standIn}, and ${standIn}, and ${standIn}, and ${standIn} as well, and I would like us to agree a new date for the report.`;
    const t = Number(said['nextTurnIndex']);
    const third = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: t, text: line }));
    ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: a, turnIndex: third['nextTurnIndex'] }));
    type Q = { text: string; verified: boolean; readBack?: true };
    type J = { criteria: { status: string; quotes: Q[] }[]; unverifiedCriteria: string[] };
    const judgeWith = async (judge: Person, quote: string): Promise<J> => {
      const packet = ok(await ract(H, 'pev.judge_packet', judge.claude, { attemptIri: a }));
      return chatAnswer(await ract(H, 'pev.record_judgment', judge.claude, {
        attemptIri: a, ...(packet['binding'] as Out), judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true },
        judgment: { criteria: S.value.rubric.criteria.map((c) => ({ criterionId: c.id, level: c.levels[c.levels.length - 1]!.id, quotes: [{ text: quote, turnIndex: t }], rationale: 'The quoted line shows it.' })) },
      }), `the judgment saved from ${judge.claude}`, false)['judgment'] as J;
    };
    const credited = (quote: string): unknown => [[], S.value.rubric.criteria.map(() => ['verified', [[quote, true, true]]])];
    const asSaved = (j: J): unknown => [j.unverifiedCriteria, j.criteria.map((c) => [c.status, c.quotes.map((q) => [q.text, q.verified, q.readBack ?? null])])];
    // The packet span beginning after the urn prefix: five runs of hex that read the same, one of them the fingerprint.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }));
    const shown = String((packet['request'] as Out)['user']).split('\n').find((l) => l.startsWith(`[T${t} LEARNER] `))!;
    const fromPacket = shown.slice(shown.indexOf('urn:pev:rubric:') + 15, shown.indexOf(' and I would'));
    expect(fromPacket).toBe(`${standIn} equals ${standIn}, and ${standIn}, and ${standIn}, and ${standIn} as well,`);
    const first = await judgeWith(P.judge, fromPacket);
    expect(asSaved(first)).toEqual(credited(fromPacket));
    // Another judge's chat copies the quote as the first one's answer shows it: read back and credited too.
    expect(asSaved(await judgeWith(P.judgeReviewer, first.criteria[0]!.quotes[0]!.text))).toEqual(credited(fromPacket));
    // The web app keeps both as the learner's words: the fingerprint put back where it was framed, the four they wrote out as written.
    const stored = line.slice(line.indexOf('urn:pev:rubric:') + 15, line.indexOf(' and I would'));
    expect([stored.split(own).length - 1, stored.split(standIn).length - 1]).toEqual([1, 4]);
    const web = webAnswer(await ract(H, 'pev.get_attempt', P.reviewer.web, { attemptIri: a }), 'the judged session in the web app');
    for (const j of web['judgments'] as J[]) expect(asSaved(j)).toEqual(credited(stored));
  }, SLOW);

  it('a judge\'s chat sees none of a fingerprint whose last hex digit a combining mark follows, in the packet or the session, and its quote of it is read back and credited', async () => {
    // A copy of the demo scenario whose rubric fingerprint ends in a hex letter, so that NFC folds it and a mark after it into one.
    const variant = (i: number): Out => {
      const base = demoScenarioInput('missed-deadline', 1);
      const rubric = base['rubric'] as Out;
      const criteria = (rubric['criteria'] as Out[]).map((c, j) => (j === 0 && i > 0 ? { ...c, title: `${String(c['title'])} (${i})` } : c));
      return { ...base, scenarioKey: 'quoted-folded-hex', title: 'A fingerprint a mark follows', rubric: { ...rubric, criteria } };
    };
    const i = Array.from({ length: 64 }, (_, n) => n).find((n) => { const x = coerceScenario(variant(n)); return 'value' in x && /[a-f]$/.test(rubricHash(x.value.rubric)); });
    if (i === undefined) throw new Error('no copy of the scenario has a fingerprint ending in a hex letter');
    const input = variant(i);
    const S = coerceScenario(input);
    if (!('value' in S)) throw new Error('the scenario does not coerce');
    const own = rubricHash(S.value.rubric);
    const mark = 'ace'.includes(own[63]!) ? '́' : '̇';
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: input, status: 'published', draftAssistance: { used: false } }));
    const sc = String(pub['scenarioIri']);
    ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: sc, version: 1, scenarioHash: pub['scenarioHash'] }));
    const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    const a = String(start['attemptIri']);
    const line = `I traced urn:pev:rubric:${own}${mark} and I would like us to agree a new date for the report.`;
    const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 1, text: line }));
    ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: a, turnIndex: said['nextTurnIndex'] }));
    const none = (r: unknown): unknown => [JSON.stringify(r).includes(own.slice(0, 63)), JSON.stringify(r).includes(own.slice(0, 16))];
    // The packet shows the line normalised, the last digit and the mark one letter there: none of the fingerprint, the same length.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }));
    const shown = String((packet['request'] as Out)['user']).split('\n').find((l) => l.startsWith('[T1 LEARNER] '))!.slice('[T1 LEARNER] '.length);
    expect([none(shown), shown.length]).toEqual([[false, false], normaliseForQuote(line).length]);
    // The judge's chat copies the stand-in from the packet: read back, checked out and credited.
    const fromPacket = shown.slice(shown.indexOf('urn:pev:rubric:'), shown.indexOf(' and I would'));
    type Q = { text: string; normalised?: string; verified: boolean; readBack?: true };
    type J = { criteria: { status: string; quotes: Q[] }[]; unverifiedCriteria: string[] };
    const saved = chatAnswer(await ract(H, 'pev.record_judgment', P.judge.claude, {
      attemptIri: a, ...(packet['binding'] as Out), judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true },
      judgment: { criteria: S.value.rubric.criteria.map((c) => ({ criterionId: c.id, level: c.levels[c.levels.length - 1]!.id, quotes: [{ text: fromPacket, turnIndex: 1 }], rationale: 'The quoted line shows it.' })) },
    }), 'the judgment saved from a judge\'s chat', false);
    const j = saved['judgment'] as J;
    expect([j.unverifiedCriteria, j.criteria.map((c) => [c.status, c.quotes.map((q) => [q.verified, q.readBack ?? null])])])
      .toEqual([[], S.value.rubric.criteria.map(() => ['verified', [[true, true]]])]);
    // The session as a judge's chat reads it: the line and its normalised form, the quote and its normalised form, none of it.
    const session = chatAnswer(await ract(H, 'pev.get_attempt', P.judge.claude, { attemptIri: a }), 'the judged session from a judge\'s chat');
    const t1 = (session['turns'] as Out[]).find((t) => t['index'] === 1)!;
    expect([none(t1['text']), none(t1['normalisedText']), t1['normalisedText']]).toEqual([[false, false], [false, false], shown]);
    for (const r of [packet, saved, session]) expect(none(r)).toEqual([false, false]);
  }, SLOW);

  it('a judge\'s chat that quotes a line where a mark follows a fingerprint\'s last decimal digit, which the stand-in\'s last digit takes, has the quote read back and credited: from the packet as shown, normalised on the way, and copied again', async () => {
    // As the peer review found it: a fingerprint ending in a decimal digit, which takes no mark, and a stand-in ending in a hex
    // letter, which does. The packet shows the stand-in's letter and the mark as two characters, which NFC would fold into one.
    const base = demoScenarioInput('missed-deadline', 2);
    const variant = (i: number): Out => {
      const rubric = base['rubric'] as Out;
      const criteria = (rubric['criteria'] as Out[]).map((c, j) => (j === 0 && i > 0 ? { ...c, title: `${String(c['title'])} (${i})` } : c));
      return { ...base, title: 'A fingerprint ending in a digit a mark follows', rubric: { ...rubric, criteria } };
    };
    const i = Array.from({ length: 64 }, (_, n) => n).find((n) => { const x = coerceScenario(variant(n)); return 'value' in x && /[0-9]$/.test(rubricHash(x.value.rubric)); });
    if (i === undefined) throw new Error('no copy of the scenario has a fingerprint ending in a decimal digit');
    const S = coerceScenario(variant(i));
    if (!('value' in S)) throw new Error('the scenario does not coerce');
    const own = rubricHash(S.value.rubric);
    const mark = '\u0307';
    // The stand-in is keyed to the scenario version: the first scenario of its own whose stand-in ends in a hex letter.
    let found: { a: string; standIn: string; t: number } | undefined;
    for (let n = 0; n < 24 && found === undefined; n += 1) {
      const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: { ...variant(i), scenarioKey: `quoted-digit-fold-${n}` }, status: 'published', draftAssistance: { used: false } }));
      const sc = String(pub['scenarioIri']);
      ok(await ract(H, 'pev.ratify_scenario', P.reviewer.web, { scenarioIri: sc, version: 1, scenarioHash: pub['scenarioHash'] }));
      const start = ok(await ract(H, 'pev.start_attempt', P.learner.claude, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
      const a = String(start['attemptIri']);
      const said = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: 1, text: `I traced urn:pev:rubric:${own} first.` }));
      const mine = chatAnswer(await ract(H, 'pev.get_attempt', P.learner.claude, { attemptIri: a }), 'the session from the learner\'s chat');
      const t1 = String((mine['turns'] as Out[]).find((t) => t['index'] === 1)!['text']);
      const standIn = t1.slice(t1.indexOf('urn:pev:rubric:') + 15, t1.indexOf(' first.'));
      if (/[a-f]$/.test(standIn)) found = { a, standIn, t: Number(said['nextTurnIndex']) };
    }
    if (found === undefined) throw new Error('no scenario of its own has a stand-in ending in a hex letter');
    const { a, standIn, t } = found;
    expect([`${own.slice(-1)}${mark}`.normalize('NFC').length, `${standIn.slice(-1)}${mark}`.normalize('NFC').length]).toEqual([2, 1]);
    // The fingerprint with the mark after it, its stand-in written out, and a curly apostrophe.
    const line = `So urn:pev:rubric:${own}${mark} equals ${standIn}, and I’d like us to agree a new date for the report.`;
    const third = ok(await ract(H, 'pev.say', P.learner.claude, { attemptIri: a, turnIndex: t, text: line }));
    ok(await ract(H, 'pev.end_conversation', P.learner.claude, { attemptIri: a, turnIndex: third['nextTurnIndex'] }));
    type Q = { text: string; verified: boolean; readBack?: true };
    type J = { criteria: { status: string; quotes: Q[] }[]; unverifiedCriteria: string[] };
    const judgeWith = async (judge: Person, quote: string): Promise<J> => {
      const packet = ok(await ract(H, 'pev.judge_packet', judge.claude, { attemptIri: a }));
      return chatAnswer(await ract(H, 'pev.record_judgment', judge.claude, {
        attemptIri: a, ...(packet['binding'] as Out), judgeDisclosure: { provider: 'Example', model: 'example-judge', usedPacketPrompt: true },
        judgment: { criteria: S.value.rubric.criteria.map((c) => ({ criterionId: c.id, level: c.levels[c.levels.length - 1]!.id, quotes: [{ text: quote, turnIndex: t }], rationale: 'The quoted line shows it.' })) },
      }), `the judgment saved from ${judge.claude}`, false)['judgment'] as J;
    };
    const credited = (j: J): unknown => [j.unverifiedCriteria, j.criteria.map((c) => [c.status, c.quotes.map((q) => [q.verified, q.readBack ?? null])])];
    const asCredited = [[], S.value.rubric.criteria.map(() => ['verified', [[true, true]]])];
    // The packet's line, from urn:pev:rubric: to just before " like us": the stand-in's letter and the mark as two characters.
    const packet = ok(await ract(H, 'pev.judge_packet', P.judge.claude, { attemptIri: a }));
    const shown = String((packet['request'] as Out)['user']).split('\n').find((l) => l.startsWith(`[T${t} LEARNER] `))!;
    const fromPacket = shown.slice(shown.indexOf('urn:pev:rubric:'), shown.indexOf(' like us'));
    expect(fromPacket).toBe(`urn:pev:rubric:${standIn}${mark} equals ${standIn}, and I'd`);
    const first = await judgeWith(P.judge, fromPacket);
    expect(credited(first)).toEqual(asCredited);
    // Another judge's chat copies the quote as the first one's answer shows it; then each chat's copy of the packet's stretch
    // normalised on the way, and of the session's text as a judge's chat reads it, curly apostrophe and all.
    expect(credited(await judgeWith(P.judgeReviewer, first.criteria[0]!.quotes[0]!.text))).toEqual(asCredited);
    expect(credited(await judgeWith(P.judge, fromPacket.normalize('NFC')))).toEqual(asCredited);
    const session = chatAnswer(await ract(H, 'pev.get_attempt', P.judgeReviewer.claude, { attemptIri: a }), 'the judged session from a judge\'s chat');
    const text = String((session['turns'] as Out[]).find((x) => x['index'] === t)!['text']);
    expect(credited(await judgeWith(P.judgeReviewer, text.slice(text.indexOf('urn:pev:rubric:'), text.indexOf(' like us')).normalize('NFC')))).toEqual(asCredited);
    // The web app keeps every one as the learner's words: the fingerprint put back where it was framed, the stand-in they wrote
    // out kept as written.
    const stored = normaliseForQuote(line.slice(line.indexOf('urn:pev:rubric:'), line.indexOf(' like us')));
    const web = webAnswer(await ract(H, 'pev.get_attempt', P.reviewer.web, { attemptIri: a }), 'the judged session in the web app');
    const saved = (web['judgments'] as J[]).flatMap((j) => j.criteria.flatMap((c) => c.quotes.map((q) => [normaliseForQuote(q.text), q.verified])));
    expect([saved.length, new Set(saved.map((x) => JSON.stringify(x))).size, saved[0]]).toEqual([4 * S.value.rubric.criteria.length, 1, [stored, true]]);
    expect([stored.split(own).length - 1, stored.split(standIn).length - 1]).toEqual([1, 1]);
  }, SLOW);
});

/** A signed request as a record keeps it, wherever an answer holds one. */
const isStoredEnvelope = (o: Out): boolean =>
  (o['form'] === 'pev-canonical' || o['form'] === 'signed-request') && typeof o['signature'] === 'string' && typeof o['payloadSha256'] === 'string';

/** An answer split in two: every stored signed request in it, and the answer with each of them taken out. */
function splitEnvelopes(r: unknown): { envelopes: Out[]; rest: unknown } {
  const envelopes: Out[] = [];
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x === null || typeof x !== 'object') return x;
    if (isStoredEnvelope(x as Out)) { envelopes.push(x as Out); return null; }
    return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
  };
  return { envelopes, rest: walk(r) };
}

describe('a signed request a record keeps is shown to a caller who reads no stakes without what it signed', () => {
  it('a key nobody registered writes the bridge\'s own field names into its contest and removal: none of it comes back keyed, to compare', async () => {
    // A scored scenario of its own. The other scored scenario (X['sc'], version 1) is never practised on here.
    const input = { ...demoScenarioInput('missed-deadline', 2), scenarioKey: 'payload-fields', title: 'Fields in a payload' };
    const S = coerceScenario(input);
    if (!('value' in S)) throw new Error('the scenario does not coerce');
    const own = rubricHash(S.value.rubric);
    const pub = ok(await ract(H, 'pev.author_scenario', P.author.web, { scenario: input, status: 'published', draftAssistance: { used: false } }));
    expect(pub['rubricHash']).toBe(own);
    const sc = String(pub['scenarioIri']);
    // Beside each act's own fields: a wrong guess and the right ones, bare, under every field name this bridge keys a hash
    // in (rubricHash, scenarioHash, rubricIri, a cell's kind), in objects naming the other scenario's version, and in
    // objects shaped like calibration cells.
    const wrong = sha256('a wrong guess');
    const extras: Out = {
      guesses: [wrong, own].map((h) => ({ rubricHash: h, scenarioHash: h, rubricIri: `urn:pev:rubric:${h}` })),
      other: [
        { scenarioIri: X['sc'], version: 1, rubricHash: RAW.rubric, scenarioHash: RAW.scenario, rubricIri: `urn:pev:rubric:${RAW.rubric}` },
        { scenario: { scenarioIri: X['sc'], version: 1 }, rubricHash: RAW.rubric },
        { scenarioIri: X['sc'], scenarioVersion: 1, items: [{ rubricHash: RAW.rubric }] },
      ],
      cells: [own, RAW.rubric].map((h) => ({
        grouping: 'rubric-version', criterionContentHash: sha256('a criterion'), judgeId: 'a-judge', rubricHash: h, kind: `pev/${h.slice(0, 16)}/asks-their-view`,
      })),
    };

    const start = ok(await kact(H, 'pev.start_attempt', FRESH, { scenarioIri: sc, scenarioVersion: 1, coached: false }));
    const a = String(start['attemptIri']);
    const said = ok(await kact(H, 'pev.say', FRESH, { attemptIri: a, turnIndex: 1, text: 'I would like us to agree a new date for the report before Friday.' }));
    ok(await kact(H, 'pev.end_conversation', FRESH, { attemptIri: a, turnIndex: said['nextTurnIndex'] }));
    ok(await kact(H, 'pev.judge_attempt', FRESH, { attemptIri: a }));
    const seen = ok(await ract(H, 'pev.get_attempt', P.reviewer2.web, { attemptIri: a }));
    const levels = S.value.rubric.criteria.map((c) => ({ criterionId: c.id, levelId: c.levels[2]!.id, why: 'Set by the reviewer, who read the whole transcript.' }));
    ok(await ract(H, 'pev.override_attempt', P.reviewer2.web, { attemptIri: a, target: seen['currentTarget'], levels, sawJudgeLevelsFirst: true }));

    // The key contests the review, and then removes the transcript, each with the fields above in its signed payload.
    const before = ok(await kact(H, 'pev.get_attempt', FRESH, { attemptIri: a }));
    const contest = ok(await kact(H, 'pev.contest_review', FRESH, { attemptIri: a, target: before['currentTarget'], why: 'The second criterion missed what I asked first.', ...extras }));
    const contested = ok(await kact(H, 'pev.get_attempt', FRESH, { attemptIri: a }));
    const queue = ok(await kact(H, 'pev.review_queue', KEY_AGENT));
    const removed = ok(await kact(H, 'pev.redact_attempt', FRESH, { attemptIri: a, target: contested['currentTarget'], why: 'I would rather this text were not kept.', ...extras }));
    const after = ok(await kact(H, 'pev.get_attempt', FRESH, { attemptIri: a }));
    const answers: [string, Out][] = [
      ['the contest', contest], ['the contested attempt', contested], ['the review queue of a key registered as an agent', queue], ['the removal', removed],
      ['the attempt after the removal', after],
      ['the scenario', ok(await kact(H, 'pev.list_scenarios', FRESH, { scenarioIri: sc }))],
      ['the other scenario', ok(await kact(H, 'pev.list_scenarios', FRESH, { scenarioIri: X['sc'] }))],
      ['every scenario', ok(await kact(H, 'pev.list_scenarios', FRESH))],
      ['calibration, unsigned', (await H['pev.calibration']!({})) as Out],
    ];
    for (const [what, r] of answers) expect(stakesIn(r), what).toEqual([]);

    // Each stored request the key reads, its own included, keeps its signature and payload hash and shows no payload.
    const reopening = ((contested['reopenings'] as Out[]).at(-1)!)['envelope'] as Out;
    const removal = (after['redaction'] as Out)['envelope'] as Out;
    for (const [what, e] of [['the contest\'s request', reopening], ['the removal\'s request', removal], ['the contest\'s own answer', (contest['reopening'] as Out)['envelope'] as Out]] as const) {
      expect([e['form'], typeof e['signature'], typeof e['payloadSha256'], 'payload' in e, 'signedPayload' in e, e['payloadLeftOut']], what)
        .toEqual(['pev-canonical', 'string', 'string', false, false, true]);
    }
    // No value this bridge keyed, in any of those answers, appears in a stored request in any of them, nor its first 16 hex.
    const keyed = new Set(answers.flatMap(([, r]) => [...hashesIn(splitEnvelopes(r).rest).keyed]));
    expect(keyed.size).toBeGreaterThan(4);
    for (const [what, r] of answers) {
      const stored = JSON.stringify(splitEnvelopes(r).envelopes);
      expect([...keyed].filter((k) => stored.includes(k)), `${what}: a keyed value in a stored request`).toEqual([]);
      noBareHash(r, what);
    }

    // The web app reads the requests as signed, the key's fields in them included.
    const web = webAnswer(await ract(H, 'pev.get_attempt', P.reviewer.web, { attemptIri: a }), 'the attempt in the web app');
    const signed = ((web['redaction'] as Out)['envelope'] as Out)['payload'] as Out;
    expect([(signed['guesses'] as Out[])[1]!['rubricHash'], (signed['other'] as Out[])[0]!['rubricHash']]).toEqual([own, RAW.rubric]);
  }, SLOW);
});

describe('a relay that signs which OAuth client asked: only this bridge\'s own client is its web app', () => {
  it('the web app\'s own client id with its agent reads the stakes and decides; any other client id is a chat, whatever its agent is called', async () => {
    const id = P.reviewer.did.slice(P.reviewer.did.lastIndexOf(':') + 1);
    // This bridge's own client (its Client ID Metadata Document), with the web app's agent: the web app.
    webAnswer(await cact(H, 'pev.list_scenarios', P.reviewer.web, OWN_CLIENT), 'the list from the web app\'s own client');
    ok(await cact(H, 'pev.register_role', P.admin.web, OWN_CLIENT, { address: userDid('u-pk-00000000ab10'), role: 'learner', change: 'add' }));
    // Any other client with the web app's agent name: another app that registered as "Practice Evidence", a dynamically
    // registered client, the web app of another deployment, and a client id that is not a usable one.
    const others: unknown[] = ['0123456789abcdef0123456789abcdef', 'https://other-app.example.test/client.json', 'https://bridge.example.test/ui/oauth/client.json#x',
      'https://bridge.example.test.evil.example/ui/oauth/client.json', '', null, 42];
    for (const client of others) {
      chatAnswer(await cact(H, 'pev.list_scenarios', P.reviewer.web, client), `the list from client ${JSON.stringify(client)}`);
      const decided = refused(await cact(H, 'pev.register_role', P.admin.web, client, { address: userDid('u-pk-00000000ab11'), role: 'learner', change: 'add' }),
        'chat-agent-may-not-decide', `a decisive act from client ${JSON.stringify(client)}`);
      if (typeof client === 'string') expect(decided['clientId']).toBe(client);
    }
    // The web app's own client with another agent: both must hold, so a relay that signed a caller's own client_id
    // (before the relay reserved it) reads no wider than the agent rule.
    for (const chat of [P.reviewer.claude, agent(`practice-evidence-helper-${id}`, P.reviewer.did)]) {
      chatAnswer(await cact(H, 'pev.list_scenarios', chat, OWN_CLIENT), `the list from ${chat} with the web app's client id`);
    }
    // A relay that does not say which client asked: the agent rule, as before.
    webAnswer(await ract(H, 'pev.list_scenarios', P.reviewer.web), 'the list from the web app\'s agent, no client id');
    chatAnswer(await ract(H, 'pev.list_scenarios', P.reviewer.claude), 'the list from Claude, no client id');
    // A signed payload that carries a client id is read as any other: the person is the agent's controller.
    const listed = ok(await cact(H, 'pev.get_attempt', P.learner.web, OWN_CLIENT));
    expect(listed['signedAs']).toMatchObject({ principal: P.learner.did });
  }, SLOW);

  it('an id the web app registered by dynamic registration is its own on the bridge that registered it, and only there', async () => {
    const registered = webAppClients('http://127.0.0.1:6110');
    const H2 = createPevHandlers({ ...base, deploymentUrl: 'http://127.0.0.1:6110', isWebAppClient: registered.has }) as Handlers;
    const dcr = 'fedcba9876543210fedcba9876543210';
    chatAnswer(await cact(H2, 'pev.list_scenarios', P.reviewer.web, dcr), 'the list before the bridge registered that id');
    registered.add(dcr);
    webAnswer(await cact(H2, 'pev.list_scenarios', P.reviewer.web, dcr), 'the list from the id it registered');
    // Its metadata document's URL on its own deployment is its own too; the https bridge's is not.
    webAnswer(await cact(H2, 'pev.list_scenarios', P.reviewer.web, 'http://127.0.0.1:6110/ui/oauth/client.json'), 'its own CIMD URL');
    chatAnswer(await cact(H2, 'pev.list_scenarios', P.reviewer.web, OWN_CLIENT), 'another deployment\'s CIMD URL');
    // Another process (a restart, a replica) that has not registered it reads it as a chat until the person signs in again.
    chatAnswer(await cact(H, 'pev.list_scenarios', P.reviewer.web, dcr), 'the id another bridge registered');
  }, SLOW);
});

describe('what the descriptions and the README say about who reads the stakes', () => {
  it('every description that names the stakes left out names every caller they are left out for, in one phrase', () => {
    // showsStakes leaves them out for a chat agent, a key no admin registered, a key registered as an agent, and a request nobody signed.
    expect(STAKES_LEFT_OUT_FOR).toBe('a chat assistant the Interego relay signs for, a key no admin registered or one registered as an agent, or a request nobody signed');
    const naming = pevAffordances.filter((a) => /stakesWithheld|stakes-not-in-chat|scoring stakes|without the score/.test(JSON.stringify(a)));
    expect(naming.map((a) => a.toolName).sort()).toEqual([
      'pev.author_scenario', 'pev.countersign_attempt', 'pev.export_record', 'pev.get_attempt', 'pev.holder_copy', 'pev.judge_attempt', 'pev.list_scenarios',
      'pev.override_attempt', 'pev.project_attempt', 'pev.review_queue', 'pev.scenario_results',
    ]);
    for (const a of naming) {
      expect(JSON.stringify(a), a.toolName).toContain(STAKES_LEFT_OUT_FOR);
      // Never a narrower name for the same callers.
      expect(JSON.stringify(a), a.toolName).not.toMatch(/a key not registered here|for a chat assistant:|to a chat assistant,|(?:Read|Asked) from a chat assistant/);
    }
    // The answers' own mark names the same callers.
    expect(STAKES_WITHHELD).toContain(STAKES_LEFT_OUT_FOR);
    // Calibration's filter takes calibration's own fingerprints, which match none shown elsewhere.
    const cal = pevAffordances.find((a) => a.toolName === 'pev.calibration')!;
    expect(JSON.stringify(cal)).toContain('keyed for calibration, so it matches no rubric fingerprint shown with a scenario, an attempt or a judgment');
  });

  it('the README says a key change makes fingerprints handed out before stop matching, and that a judge\'s signed binding is keyed; and speaks of a person as they', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('changing `PEV_PLATFORM_KEY`, or setting or changing `PEV_RECORD_KEY`, keys every hash anew, so a fingerprint handed out before');
    expect(readme).toContain('so it can be checked against the record\'s `pev:rubricHash` only by this bridge, not by an offline reader of the record');
    // A hash a caller writes into text comes back as a stand-in keyed apart, a quote copied from it checks out, and the README,
    // the answers' own mark and the descriptions say so; none still says such a quote fails or that the value is random.
    expect(readme).toContain('inside any text, is replaced with a stand-in keyed apart from those fields');
    expect(readme).toContain('a judge who copies a quote from any of them has it read back as the stored line');
    expect(STAKES_WITHHELD).toContain('one written into any text is replaced with a stand-in keyed apart from them, so none can be checked against a guess');
    const judged = pevAffordances.find((a) => a.toolName === 'pev.record_judgment')!;
    expect(judged.description).toContain('a fingerprint in a line included, is checked against the learner\'s words as stored');
    for (const text of [readme, STAKES_WITHHELD, JSON.stringify(pevAffordances)]) {
      expect(text).not.toMatch(/random value|quotes a value the transcript does not hold|that quote does not check out/);
    }
    // No named character appears in the README, so every person in it is they.
    expect(readme.match(/\b(she|her|hers|herself|he|him|his|himself)\b/gi)).toBeNull();
  });

  it('a stand-in is said to be the same only for the same scenario version, and the review queue is named for its quotes, not lines', () => {
    const list = pevAffordances.find((a) => a.toolName === 'pev.list_scenarios')!;
    expect(list.description).toContain('the same wherever it is shown for the same scenario version (a scenario\'s results and calibration show stand-ins of their own)');
    expect(list.description).not.toContain('the same wherever that text is shown');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('the review queue shows the judges\' quotes from it the same way (it shows no lines)');
    expect(readme).not.toMatch(/view of a session's transcript \([^)]*review queue/);
    // As said: the same title holds another stand-in in an answer with no scenario version (each its own) and in calibration's cells.
    const m = hashMask(Buffer.alloc(32, 3));
    const title = { title: `Names it urn:pev:rubric:${RAW.rubric}` };
    const shownFor = (scope: Parameters<typeof maskAnswerHashes>[2]): string => (maskAnswerHashes(title, m, scope) as { title: string }).title;
    const v = { scenarioIri: 'urn:pev:scenario:unit', version: 1 };
    expect(new Set([shownFor(v), shownFor(v)]).size).toBe(1);
    expect(new Set([shownFor(v), shownFor(null), shownFor(null), shownFor('cells')]).size).toBe(4);
  });
});
