/**
 * What a live run of a whole practice session through a real chat assistant (the Interego relay's
 * connector, on a workspace with no model of its own) found, each fixed here and kept fixed:
 *
 *   - a packet's record template said podUrl, issuedAt and any nonce, while the prompt the chat was
 *     given said pod_url, no issuedAt and a nonce of the step, the turn and 16 random letters: for a
 *     request the relay signed, the template is now the prompt's, and the bridge takes both forms;
 *   - the start-up message stops on "ended": true, and ending the conversation did not say it.
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
const P = { admin: person('u-pk-0000000011a1'), author: person('u-pk-0000000022b2'), learner: person('u-pk-0000000033c3'), judge: person('u-pk-0000000044d4') };

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
    for (const [who, role] of [[P.author.did, 'author'], [P.learner.did, 'learner'], [KEY_LEARNER.address, 'learner'], [P.judge.did, 'judge']] as const) {
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

  it('ending the conversation says ended: true, as the start-up message\'s stop rule reads it', async () => {
    const end = ok(await ract('pev.end_conversation', P.learner.claude, { attemptIri: X['a'], turnIndex: Number(X['turn']) }));
    expect([end['state'], end['ended'], end['endedBy']]).toEqual(['ended', true, 'learner']);
    // A save that ends it says so the same way.
    const k = ok(await kact('pev.record_turns', KEY_LEARNER, {
      attemptIri: X['keyAttempt'], turnIndex: 3, learnerText: 'That is all from me.', counterpartText: 'Thanks.', counterpartDisclosure: { provider: 'Example AI', model: 'not shown' }, endAfter: true,
    }));
    expect([k['state'], k['ended']]).toEqual(['ended', true]);
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
    // A key-held judge's packet would have the key-held template: the same packet code, the caller's form (engines.test.ts).
  }, SLOW);
});
