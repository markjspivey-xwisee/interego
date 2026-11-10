/**
 * What a live run of a whole practice session through a real chat assistant (the Interego relay's
 * connector, on a workspace with no model of its own) found, each fixed here and kept fixed:
 *
 *   - a packet's record template said podUrl, issuedAt and any nonce, while the prompt the chat was
 *     given said pod_url, no issuedAt and a nonce of the step, the turn and 16 random letters: for a
 *     request the relay signed, the template is now the prompt's, and the bridge takes both forms;
 *   - the start-up message stops on "ended": true, and ending the conversation did not say it;
 *   - once the conversation was over, the learner's own assistant was offered the judge packet ("an
 *     independent judge agent can judge this attempt") and was answered with it in full: an
 *     assistant that acts as the learner, pointed at assessing the learner's own practice, which
 *     record_judgment then refuses (judge-is-the-learner). Now it is told to hand the session to an
 *     appointed judge, and the packet is refused to it; the web app's own hand-offs keep working;
 *   - a learner could not find out whether the workspace has a judge at all, and nobody but an admin
 *     could see roles: a signed read of a session now says the caller's own roles and whether anyone
 *     else holds the judge and reviewer roles (booleans, never who), and carries no stakes for it;
 *   - a judge not registered yet was told only that they were not entitled: now the refusal names the
 *     account an admin registers (a user DID, never the agent DID the relay signs as).
 *
 * The relay is played by a generated wallet signing the way its `sign_request` does (an EIP-191
 * signature over `sha256:<hex sha256 of the exact JSON text>`), as chat-stakes.test.ts does. No
 * network: the pod is an in-memory double on a reserved `.test` host, DID documents come from a map,
 * and there is no model, as on the live workspace. Fictional people only.
 */
import { describe, it, expect } from 'vitest';
import { importWallet, sha256, sha256Hex, signMessageRaw, type Wallet } from '@interego/core';
import { createPevHandlers, type PevDeps } from '../bridge/handlers.js';
import { demoKey, demoScenarioInput, inMemoryPod } from '../demo/run.js';
import { PEV_ACTION, toolNameOf } from '../src/ontology.js';
import { signEnvelope } from '../src/records.js';

type Out = Record<string, unknown>;
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SLOW = 240_000;
const POD = 'https://live-run-pod.example.test/practice/';
const IDH = 'identity.example.test';
const pod = inMemoryPod();
const wallet = (name: string, type: 'human' | 'agent' = 'human'): Wallet => importWallet(`0x${sha256(`pev-live-run-test:${name}`)}`, type, name);
const RELAY = wallet('relay', 'agent');
/** A learner who signs with a key they hold, registered by an admin. */
const KEY_LEARNER = wallet('key-learner');

let n = 0;
const nonce = (): string => `live-run-nonce-${String(++n).padStart(8, '0')}`;

const docs = new Map<string, unknown>();
const userDid = (id: string): string => `did:web:${IDH}:users:${id}`;
const agent = (slug: string, controller: string): string => {
  const id = `did:web:${IDH}:agents:${slug}`;
  docs.set(`https://${IDH}/agents/${slug}/did.json`, { '@context': ['https://www.w3.org/ns/did/v1'], id, controller });
  return id;
};
interface Person { readonly did: string; readonly web: string; readonly claude: string }
const person = (id: string): Person => {
  const did = userDid(id);
  return { did, web: agent(`practice-evidence-${id}`, did), claude: agent(`claude-${id}`, did) };
};
const P = {
  admin: person('u-pk-0000000011a1'), author: person('u-pk-0000000022b2'), learner: person('u-pk-0000000033c3'), judge: person('u-pk-0000000044d4'),
  reviewer: person('u-pk-0000000055e5'),
};
/** A key registered as a reviewer and as an agent: software, which cannot sign off, so it is no reviewer for a learner. */
const KEY_AGENT = wallet('key-agent', 'agent');

const base: PevDeps = {
  platformWallet: importWallet(demoKey('platform'), 'agent', 'pev-platform'), platformKeyKind: 'demo-fixture',
  fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: POD, deploymentUrl: 'https://bridge.example.test',
  adminDids: [P.admin.did], nonce,
  relayDelegation: {
    relayAddresses: [RELAY.address], identityHost: IDH,
    fetchDidDocument: async (url) => { if (!docs.has(url)) throw new Error('the identity host answered HTTP 404'); return docs.get(url); },
  },
};
/** No model, as on the live workspace: the other person's lines and every assessment come from people's own assistants. */
const H = createPevHandlers(base) as Handlers;

const actionOf = (tool: string): string => {
  const a = Object.values(PEV_ACTION).find((x) => toolNameOf(x) === tool);
  if (!a) throw new Error(`no action for ${tool}`);
  return a;
};

/**
 * What the relay posts for an agent: the payload as the caller asked for it to be signed (its own agent_id and underscore
 * keys dropped, a podUrl kept as pod_url), then the session's agent, the caller's own pod and the relay's timestamp.
 * `payload` is the whole payload: nothing is added to it, so a payload filled from a template is sent as the template has it.
 */
async function relayed(agentId: string, payload: Out): Promise<Out> {
  const reserved = new Set(['agent_id', 'timestamp', 'subject_pod_url', 'payload', 'client_id']);
  const safe = Object.fromEntries(Object.entries(payload).filter(([k]) => !k.startsWith('_') && !reserved.has(k))
    .map(([k, v]) => (k === 'podUrl' ? ['pod_url', v] : [k, v])));
  const sp = JSON.stringify({ ...safe, agent_id: agentId, subject_pod_url: 'https://pods.example.test/self/', timestamp: new Date().toISOString() });
  return { _signed_payload: sp, _signature: await signMessageRaw(RELAY, `sha256:${sha256Hex(sp)}`) };
}
/** An act the relay signed for an agent, with the prompt's own fields: v, action, pod_url and a nonce, then `fields`. */
async function ract(tool: string, agentId: string, fields: Out = {}): Promise<Out> {
  return (await H[tool]!(await relayed(agentId, { v: 1, action: actionOf(tool), pod_url: POD, nonce: nonce(), ...fields }))) as Out;
}
/** An act signed with a key the person holds. */
async function kact(tool: string, w: Wallet, fields: Out = {}): Promise<Out> {
  const envelope = await signEnvelope(w, { v: 1, action: actionOf(tool), issuedAt: new Date().toISOString(), nonce: nonce(), podUrl: POD, ...fields });
  return (await H[tool]!({ envelope })) as Out;
}

function ok(r: Out): Out {
  expect(r['kind'], `expected success, got ${JSON.stringify(r).slice(0, 500)}`).toBeUndefined();
  return r;
}

function refused(r: Out, code: string, what: string): Out {
  expect([r['kind'], r['iep:refusalReason']], `${what}: ${JSON.stringify(r).slice(0, 300)}`).toEqual(['refusal', code]);
  return r;
}

/** Keys that carry a scored scenario's stakes, wherever they sit (chat-stakes.test.ts has the whole account of them). */
const STAKE_KEYS = new Set([
  'weight', 'value', 'passRule', 'minPercent', 'requiredLevels', 'passGateWhy', 'points', 'maxPoints', 'percent', 'percentTenths',
  'meetsPassRule', 'unmetRequirements', 'provisionalPercent', 'finalPercent', 'finalMeetsPassRule', 'nearThreshold', 'score', 'success',
]);
function stakesIn(v: unknown, at = '$', found: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => stakesIn(x, `${at}[${i}]`, found));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (STAKE_KEYS.has(k)) found.push(`${at}.${k}`);
      stakesIn(x, `${at}.${k}`, found);
    }
  }
  return found;
}
/** An answer to a chat: a success with no stake anywhere in it. */
function chatAnswer(r: Out, what: string): Out {
  ok(r);
  expect(stakesIn(r), what).toEqual([]);
  return r;
}
const actionsOf = (r: Out): string[] => ((r['nextActions'] ?? []) as Out[]).map((x) => String(x['toolName']));
const standing = (r: Out): Out => {
  const { roles, admin, teamBesidesYou } = r['signedAs'] as Out;
  return { roles, admin, teamBesidesYou };
};

/** A template's `<...>` placeholders replaced: the nonce as the prompt composes it, the rest from `values`. */
function filled(template: Out, values: Out): Out {
  const out: Out = { ...template, ...values };
  const nonceRule = template['nonce'];
  if (typeof nonceRule === 'string' && nonceRule.endsWith('-<16 new random letters or digits>')) {
    out['nonce'] = `${nonceRule.slice(0, -'<16 new random letters or digits>'.length)}${sha256(`random:${nonce()}`).slice(0, 16)}`;
  }
  return out;
}

const X: Record<string, string> = {};

describe('a whole session through a chat assistant, as the live run had it', () => {
  it('sets up a workspace: roles from the web app, a scored scenario published', async () => {
    // No judge and no reviewer yet, as on the live workspace: the hand-off below says so.
    for (const [who, role] of [[P.author.did, 'author'], [P.learner.did, 'learner'], [KEY_LEARNER.address, 'learner']] as const) {
      ok(await ract('pev.register_role', P.admin.web, { address: who, role, change: 'add' }));
    }
    const scenario = demoScenarioInput('missed-deadline', 2);
    expect(scenario['assessmentUse']).toBe('pass-gate');
    const pub = ok(await ract('pev.author_scenario', P.author.web, { scenario, status: 'published', draftAssistance: { used: false } }));
    X['sc'] = String(pub['scenarioIri']);
  }, SLOW);

  it('a packet\'s record template is the one the chat\'s prompt shows: pod_url, no issuedAt, the step-turn nonce; filled in, it is taken', async () => {
    const start = ok(await ract('pev.start_attempt', P.learner.claude, { scenarioIri: X['sc'], scenarioVersion: 1, coached: false }));
    X['a'] = String(start['attemptIri']);
    let turn = Number(start['nextTurnIndex']);
    expect(turn).toBe(1);
    const lines = ['Thanks for coming in. The report reached me on Friday afternoon.', 'What got in the way this time?'];
    for (const [i, line] of lines.entries()) {
      const packet = ok(await ract('pev.counterpart_packet', P.learner.claude, { attemptIri: X['a'], turnIndex: turn, learnerText: line }));
      const template = (packet['recordWith'] as Out)['payloadTemplate'] as Out;
      expect(Object.keys(template)).toEqual(['v', 'action', 'pod_url', 'attemptIri', 'turnIndex', 'learnerText', 'counterpartText', 'counterpartDisclosure', 'nonce']);
      expect([template['pod_url'], template['action'], template['nonce']]).toEqual([POD, PEV_ACTION.recordTurns, `record-turns-${turn}-<16 new random letters or digits>`]);
      expect(template).not.toHaveProperty('issuedAt');
      expect(template).not.toHaveProperty('podUrl');
      // Filled in as a chat fills it in, and sent to the relay as it stands: taken.
      const payload = filled(template, {
        counterpartText: i === 0 ? 'The finance feed was late again.' : 'Twice this month. (end of conversation)',
        counterpartDisclosure: { provider: 'Example AI', model: 'not shown' },
      });
      expect(String(payload['nonce'])).toMatch(new RegExp(`^record-turns-${turn}-[0-9a-f]{16}$`));
      const saved = ok((await H['pev.record_turns']!(await relayed(P.learner.claude, payload))) as Out);
      turn = Number(saved['nextTurnIndex']);
    }
    // The key-held form, which this template used to be, is still taken through the relay: podUrl (the relay keeps it as
    // pod_url), a caller's own issuedAt (never read: the relay's timestamp is) and any nonce of 16 to 128 characters.
    const packet = ok(await ract('pev.counterpart_packet', P.learner.claude, { attemptIri: X['a'], turnIndex: turn, learnerText: 'So what do we change?' }));
    const template = (packet['recordWith'] as Out)['payloadTemplate'] as Out;
    const { pod_url: _pod, nonce: _n, ...rest } = template;
    const old = ok((await H['pev.record_turns']!(await relayed(P.learner.claude, {
      ...rest, podUrl: POD, issuedAt: '2020-01-01T00:00:00.000Z', nonce: nonce(),
      counterpartText: 'Flag it on Wednesday next time.', counterpartDisclosure: { provider: 'Example AI', model: 'not shown' },
    }))) as Out);
    X['turn'] = String(old['nextTurnIndex']);
  }, SLOW);

  it('a key-held caller gets the key-held template, podUrl, issuedAt and any nonce, as before, and it is taken', async () => {
    const start = ok(await kact('pev.start_attempt', KEY_LEARNER, { scenarioIri: X['sc'], scenarioVersion: 1, coached: false }));
    const iri = String(start['attemptIri']);
    const packet = ok(await kact('pev.counterpart_packet', KEY_LEARNER, { attemptIri: iri, turnIndex: 1, learnerText: 'Thanks for coming in.' }));
    const template = (packet['recordWith'] as Out)['payloadTemplate'] as Out;
    expect(Object.keys(template)).toEqual(['v', 'action', 'podUrl', 'attemptIri', 'turnIndex', 'learnerText', 'counterpartText', 'counterpartDisclosure', 'issuedAt', 'nonce']);
    expect([template['podUrl'], template['issuedAt'], template['nonce']]).toEqual([POD, '<now, ISO 8601>', '<16 to 128 letters, digits, - or _>']);
    const envelope = await signEnvelope(KEY_LEARNER, {
      ...template, issuedAt: new Date().toISOString(), nonce: nonce(), counterpartText: 'Yes?', counterpartDisclosure: { provider: 'Example AI', model: 'not shown' },
    });
    ok((await H['pev.record_turns']!({ envelope })) as Out);
    X['keyAttempt'] = iri;
  }, SLOW);

  it('ending the conversation says ended: true, and hands the learner\'s own assistant to an appointed judge, of whom there is none yet', async () => {
    const end = chatAnswer(await ract('pev.end_conversation', P.learner.claude, { attemptIri: X['a'], turnIndex: Number(X['turn']) }), 'end_conversation from Claude');
    expect([end['state'], end['ended'], end['endedBy']]).toEqual(['ended', true, 'learner']);
    // Not offered the judge packet: the next step is the learner's, a hand-off, not an act of their own assistant.
    expect(actionsOf(end)).not.toContain('pev.judge_packet');
    const handOff = end['handOff'] as Out;
    expect([handOff['to'], handOff['judgeBesidesYou'], handOff['sessionPage']])
      .toEqual(['appointed-judge', false, `https://bridge.example.test/ui#/attempt/${encodeURIComponent(X['a']!)}`]);
    const words = String(handOff['words']);
    for (const says of ['Your own assistant does not assess your own practice: an appointed judge does', 'Send to your judge',
      'No one in this workspace is registered as a judge yet, so ask your admin to register your judge first',
      `(did:web:${IDH}:users:…), never the ID of an assistant that acts for them (did:web:${IDH}:agents:…)`]) expect(words, says).toContain(says);
    // A save that ends it says so the same way.
    const k = ok(await kact('pev.record_turns', KEY_LEARNER, {
      attemptIri: X['keyAttempt'], turnIndex: 3, learnerText: 'That is all from me.', counterpartText: 'Thanks.', counterpartDisclosure: { provider: 'Example AI', model: 'not shown' }, endAfter: true,
    }));
    expect([k['state'], k['ended']]).toEqual(['ended', true]);
    // A key the learner holds is not a chat: no hand-off note, and the judge packet is still offered (the web app's hand-off
    // on a workspace without Interego sign-in fetches it with the learner's key).
    expect([k['handOff'], actionsOf(k).includes('pev.judge_packet')]).toEqual([undefined, true]);
  }, SLOW);

  it('the judge packet is refused to the learner\'s own assistant, with the hand-off; the web app and a key the learner holds still fetch it', async () => {
    const r = refused(await ract('pev.judge_packet', P.learner.claude, { attemptIri: X['a'] }), 'hand-off-to-judge', 'judge_packet from the learner\'s Claude');
    expect([r['iep:refusalStatus'], r['remedy'], r['judgeBesidesYou'], r['sessionPage']])
      .toEqual([403, 'send-to-judge', false, `https://bridge.example.test/ui#/attempt/${encodeURIComponent(X['a']!)}`]);
    expect(String(r['error'])).toContain('This is your own practice session, so your own assistant does not fetch its judge packet');
    expect(stakesIn(r)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('"request"');
    // Read through the relay as the web app's own agent: Send to your judge is offered, and no hand-off note (the page says it).
    const web = ok(await ract('pev.get_attempt', P.learner.web, { attemptIri: X['a'] }));
    expect([actionsOf(web).includes('pev.judge_packet'), web['handOff']]).toEqual([true, undefined]);
    ok(await ract('pev.judge_packet', P.learner.web, { attemptIri: X['a'] }));
    // A key the learner holds fetches it, as the web app's hand-off without Interego sign-in does.
    ok(await kact('pev.judge_packet', KEY_LEARNER, { attemptIri: X['keyAttempt'] }));
    // Reading the session from the chat: no judge packet offered, the same hand-off, and the learner's standing.
    const read = chatAnswer(await ract('pev.get_attempt', P.learner.claude, { attemptIri: X['a'] }), 'get_attempt from the learner\'s Claude');
    expect(actionsOf(read)).not.toContain('pev.judge_packet');
    expect((read['handOff'] as Out)['judgeBesidesYou']).toBe(false);
    expect(standing(read)).toEqual({ roles: ['learner'], admin: false, teamBesidesYou: { judge: false, reviewer: false } });
  }, SLOW);

  it('a signed read says the caller\'s own roles and whether anyone else is a judge or a reviewer: booleans, never who, and no stakes', async () => {
    // A judge nobody registered yet is told which ID an admin registers: their own account's, not their assistant's.
    const no = refused(await ract('pev.judge_packet', P.judge.claude, { attemptIri: X['a'] }), 'not-entitled', 'judge_packet from a judge not registered yet');
    expect(String(no['error'])).toContain(`You are signed in as ${P.judge.did}, which holds no judge role on this workspace: to assess sessions here, ask an admin to register that Member ID as a judge.`);
    expect(String(no['error'])).toContain(`never the ID of the assistant that signs for them (${P.judge.claude})`);
    expect(no['principal']).toBe(P.judge.did);
    // register_role takes no agent DID, as the refusal says.
    refused(await ract('pev.register_role', P.admin.web, { address: P.judge.claude, role: 'judge', change: 'add' }), 'address-format', 'an agent DID as a judge');
    // A reviewer registered as an agent is software: it cannot sign off, so it is no reviewer for the learner.
    for (const role of ['reviewer', 'agent']) ok(await ract('pev.register_role', P.admin.web, { address: KEY_AGENT.address, role, change: 'add' }));
    expect((ok(await ract('pev.get_attempt', P.learner.claude))['signedAs'] as Out)['teamBesidesYou']).toEqual({ judge: false, reviewer: false });
    ok(await ract('pev.register_role', P.admin.web, { address: P.judge.did, role: 'judge', change: 'add' }));
    ok(await ract('pev.register_role', P.admin.web, { address: P.reviewer.did, role: 'reviewer', change: 'add' }));
    // The learner, from the chat and from the web app alike: the same standing, in the list read and the session read.
    for (const a of [P.learner.claude, P.learner.web]) {
      const list = ok(await ract('pev.get_attempt', a));
      expect(standing(list), a).toEqual({ roles: ['learner'], admin: false, teamBesidesYou: { judge: true, reviewer: true } });
      expect(standing(ok(await ract('pev.get_attempt', a, { attemptIri: X['a'] }))), a).toEqual(standing(list));
    }
    const read = chatAnswer(await ract('pev.get_attempt', P.learner.claude, { attemptIri: X['a'] }), 'the session from Claude, with a judge');
    const handOff = read['handOff'] as Out;
    expect([handOff['judgeBesidesYou'], String(handOff['words']).includes('No one in this workspace')]).toEqual([true, false]);
    // The only judge is not "anyone else" to themself; nor is the only reviewer. Their own roles say what they hold.
    expect(standing(ok(await ract('pev.get_attempt', P.judge.claude)))).toEqual({ roles: ['judge'], admin: false, teamBesidesYou: { judge: false, reviewer: true } });
    expect(standing(ok(await ract('pev.get_attempt', P.reviewer.claude)))).toEqual({ roles: ['reviewer'], admin: false, teamBesidesYou: { judge: true, reviewer: false } });
    expect(standing(ok(await ract('pev.get_attempt', P.admin.claude)))).toEqual({ roles: [], admin: true, teamBesidesYou: { judge: true, reviewer: true } });
    // A key reads its own standing too.
    expect(standing(ok(await kact('pev.get_attempt', KEY_LEARNER)))).toEqual({ roles: ['learner'], admin: false, teamBesidesYou: { judge: true, reviewer: true } });
    // Never who: no other member of the registry, by address or DID, anywhere in the learner's answer.
    const text = JSON.stringify(read);
    for (const other of [P.judge.did, P.reviewer.did, KEY_AGENT.address, KEY_AGENT.address.toLowerCase()]) expect(text, other).not.toContain(other);
    expect(Object.keys((read['signedAs'] as Out)['teamBesidesYou'] as Out).sort()).toEqual(['judge', 'reviewer']);
  }, SLOW);

  it('the judge packet\'s record template follows the judge\'s signing too: a chat\'s, at turn 0, filled in and taken', async () => {
    const packet = ok(await ract('pev.judge_packet', P.judge.claude, { attemptIri: X['a'] }));
    const template = (packet['recordWith'] as Out)['payloadTemplate'] as Out;
    expect(Object.keys(template)).toEqual(['v', 'action', 'pod_url', 'attemptIri', 'attemptHeadUrl', 'transcriptHash', 'rubricHash', 'judgment', 'judgeDisclosure', 'nonce']);
    expect([template['pod_url'], template['nonce']]).toEqual([POD, 'record-judgment-0-<16 new random letters or digits>']);
    expect(template).not.toHaveProperty('issuedAt');
    // The binding in the template is the packet's own.
    const binding = packet['binding'] as Out;
    expect([template['attemptHeadUrl'], template['transcriptHash'], template['rubricHash']]).toEqual([binding['attemptHeadUrl'], binding['transcriptHash'], binding['rubricHash']]);
    const user = String((packet['request'] as Out)['user']);
    const rubric = JSON.parse(user.slice(user.indexOf('\n') + 1, user.indexOf('\n\nThe transcript:'))) as { criteria: { criterionId: string; levels: { id: string }[] }[] };
    const payload = filled(template, {
      judgment: { criteria: rubric.criteria.map((c) => ({ criterionId: c.criterionId, level: c.levels[0]!.id, quotes: [], rationale: 'Nothing the learner said reaches a higher level.' })) },
      judgeDisclosure: { provider: 'Example AI', model: 'not shown', usedPacketPrompt: true },
    });
    const saved = ok((await H['pev.record_judgment']!(await relayed(P.judge.claude, payload))) as Out);
    expect(saved['recorded']).toBe(true);
    // Judged, with room for another judgment: the learner's assistant is still handed off, never offered the packet.
    const after = chatAnswer(await ract('pev.get_attempt', P.learner.claude, { attemptIri: X['a'] }), 'the judged session from Claude');
    expect([after['state'], actionsOf(after).includes('pev.judge_packet'), (after['handOff'] as Out)['judgeBesidesYou']]).toEqual(['judged', false, true]);
    refused(await ract('pev.judge_packet', P.learner.claude, { attemptIri: X['a'] }), 'hand-off-to-judge', 'judge_packet from the learner\'s Claude, once judged');
    // A key-held judge's packet would have the key-held template: the same packet code, the caller's form (engines.test.ts).
  }, SLOW);
});
