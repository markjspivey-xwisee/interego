/**
 * The chat route, as a live acceptance run through a real chat assistant (Claude, through the
 * Interego connector) walked it on 2026-11-10: the task-map packet, a registry read, a template, a
 * registry change and the map, each relay-signed for a chat's agent. That run passed and found what
 * this file pins:
 *
 *   - a fresh workspace has no types of task, and every task needs one: the packet says what to do
 *     then (tell the person, who adds them in the app), and offers the chat a registry change of
 *     types of task only where the read says chat agents decide here and the reader is an admin;
 *   - a chat's templates are a chat's payloads: no issuedAt (the relay adds its own time) and the
 *     nonce the copied messages teach, for every intent; a key-held template is unchanged;
 *   - a chat's read leaves out the text that is the same in every read unless asked, and can ask for
 *     the registry alone, inside the payload the relay signs (sizes measured below);
 *   - tasks come back in their process's order, and a recorded map echoes the document it keeps;
 *   - the packet's nonce wording and placeholders are the shared chat helper's, word for word.
 *
 * Handlers are called directly, on an in-memory pod; the relay's form is built as
 * deploy/mcp-relay/server.ts builds it, and the identity host is a map. No network.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalJson, importWallet, sha256Hex, signMessageRaw, type Wallet } from '@interego/core';
import { createWrdHandlers } from '../bridge/handlers.js';
import { wrdAffordances } from '../affordances.js';
import { ENVELOPE_INTENTS } from '../src/payloads.js';
import { CHAT_NONCE_RULE, chatNonce } from '../src/work.js';
import { memoryPod, demoClock, DEMO_POD } from '../demo/run.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown, what = 'a value'): Obj => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`expected ${what} to be an object, got ${JSON.stringify(v)?.slice(0, 300)}`);
  return v as Obj;
};
const arr = (v: unknown, what = 'a value'): Obj[] => {
  if (!Array.isArray(v)) throw new Error(`expected ${what} to be an array, got ${JSON.stringify(v)?.slice(0, 300)}`);
  return v.map((x) => obj(x, `an item of ${what}`));
};

/** The shared chat helpers, evaluated as chat-agent.test.ts evaluates them. */
const CHAT_JS = readFileSync(new URL('../../_shared/chat-agent/chat-agent.js', import.meta.url), 'utf8');
interface ChatAgent { actPrompt(spec: unknown): string; readonly nonceRule: string }
const A = new Function(`${CHAT_JS}\nreturn InteregoChatAgent;`)() as ChatAgent;
/** The nonce actPrompt writes into a signed step's payload for this action. */
function promptNonce(actionIri: string): string {
  const text = A.actPrompt({ affordancesUrl: 'https://wrd.example/affordances', steps: [{ say: 'A step.', actionIri, signed: true, payload: {} }] });
  const line = text.split('\n').find((l) => l.startsWith('   payload: '));
  if (!line) throw new Error('actPrompt wrote no payload line');
  return String(obj(JSON.parse(line.slice('   payload: '.length)))['nonce']);
}

const IDENTITY = 'identity.example.org';
const wallet = (id: string, type: 'human' | 'agent' = 'human'): Wallet => importWallet(`0x${sha256Hex(`wrd-chat-route:${id}`)}`, type, id);
const RELAY = wallet('relay', 'agent');
const PLATFORM = wallet('platform', 'agent');
const KEY_ADMIN = wallet('key-admin');
const USER_ID = 'u-pk-0c0d0e0f0a0b';
const LEE = `did:web:${IDENTITY}:users:${USER_ID}`;
const agentDid = (surface: string): string => `did:web:${IDENTITY}:agents:${surface}-${USER_ID}`;

const SOP_TITLE = 'Fictional procedure: supplier invoice intake';
const SOP = [
  SOP_TITLE,
  '1. The intake clerk saves every new supplier invoice to the intake folder each morning.',
  '2. The clerk checks that each invoice names a purchase order number.',
  '3. The clerk enters the invoice number, supplier name, amount and due date into the intake log.',
  '4. The accounts payable lead matches the invoice amount against the purchase order and the goods receipt.',
  '5. At the end of each week the clerk archives the processed invoices.',
].join('\n');
/** The five tasks of the SOP, in its order, each at the person level, filed under `kind`. */
const TASKS = (kind: string): Obj[] => [
  ['Save each new invoice', 'saves every new supplier invoice to the intake folder'],
  ['Check the purchase order number', 'checks that each invoice names a purchase order number'],
  ['Enter the invoice in the intake log', 'enters the invoice number, supplier name, amount and due date'],
  ['Match the invoice to its order and receipt', 'matches the invoice amount against the purchase order'],
  ['Archive the processed invoices', 'archives the processed invoices'],
].map(([name, quote]) => ({ name, description: `The clerk or lead ${String(quote)}.`, currentLevel: 'person', personAddress: LEE, taskKind: kind, sourceQuotes: [quote] }));
const KIND = { slug: 'invoice-intake', label: 'Invoice intake (fictional)', definition: 'Taking a supplier invoice in, from arrival to the intake log.' };

interface Bridge {
  readonly h: ReturnType<typeof createWrdHandlers>;
  /** A request signed by the relay for Lee's agent on `surface`, as act sends it: {_signed_payload, _signature}. */
  relay(surface: string, fields: Obj): Promise<Obj>;
  /** A read signed with the key admin's own key: the key-held route, unchanged by this file. */
  keyRead(): Promise<Obj>;
  /** Call a tool with a body. */
  call(tool: string, body: Obj): Promise<Obj>;
}
/** A bridge on an empty pod: a key admin registers Lee by their user DID as a process lead, with no type of task. */
async function bridge(o: { readonly chatAgentsDecide?: boolean; readonly leeIsAdmin?: boolean; readonly kinds?: boolean } = {}): Promise<Bridge> {
  const pod = memoryPod();
  const clock = demoClock();
  const docs = new Map<string, unknown>(['claude', 'chatgpt', 'work-redesign'].map((s) => [`https://${IDENTITY}/agents/${s}-${USER_ID}/did.json`, { id: agentDid(s), controller: LEE }]));
  const h = createWrdHandlers({
    fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), platform: { wallet: PLATFORM, keyKind: 'configured' },
    adminAddresses: [KEY_ADMIN.address], adminDids: o.leeIsAdmin === false ? [] : [LEE],
    relayDelegation: {
      relayAddresses: [RELAY.address], identityHost: IDENTITY, chatAgentsDecide: o.chatAgentsDecide === true,
      fetchDidDocument: async (url) => { if (!docs.has(url)) throw new Error('the identity host answered 404'); return docs.get(url); },
    },
  });
  let n = 0;
  const call = async (tool: string, body: Obj): Promise<Obj> => obj(await h[tool]!(body), `the answer of ${tool}`);
  const keyEnvelope = async (fields: Obj): Promise<Obj> => {
    n += 1;
    const payload = { podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: `chat-route-key-${String(n).padStart(6, '0')}`, ...fields };
    return { payload, signature: await signMessageRaw(KEY_ADMIN, canonicalJson(payload)) };
  };
  const registered = await call('wrd.update_registry', { envelope: await keyEnvelope({
    intent: 'wrd:update-registry', entries: [{ address: LEE, roles: ['operator', 'worker'], label: 'Lee', softwareAgent: false, personRef: 'p-lee' }],
    ...(o.kinds === true ? { taskKinds: [KIND] } : {}),
  }) });
  expect(registered['status']).toBe('registered');
  return {
    h, call,
    async relay(surface, fields) {
      n += 1;
      // The relay keeps the caller's fields, renames podUrl to pod_url, drops nothing else, and adds its own.
      const { podUrl, ...rest } = fields;
      const text = JSON.stringify({
        ...rest, pod_url: podUrl ?? DEMO_POD, ...(fields['nonce'] === undefined ? { nonce: `chat-route-relay-${String(n).padStart(6, '0')}` } : {}),
        agent_id: agentDid(surface), subject_pod_url: `https://pod.example/${USER_ID}/`, timestamp: clock.now().toISOString(),
      });
      return { _signed_payload: text, _signature: await signMessageRaw(RELAY, `sha256:${sha256Hex(text)}`) };
    },
    keyRead: async () => keyEnvelope({ intent: 'wrd:read-records' }),
  };
}
/** A placeholder nonce, as a chat makes it from the rule. */
const made = (placeholder: string, n: number): string => placeholder.replace('<turn number, or 0>', '0').replace('<16 new random letters or digits>', `Fx${String(n).padStart(14, '0')}`);
const size = (v: unknown): number => JSON.stringify(v).length;

describe('the chat route after a live run', () => {
  it('teaches the shared chat helper\'s nonce rule word for word, and writes each signed step\'s nonce as the copied messages do', () => {
    expect(CHAT_NONCE_RULE).toBe(A.nonceRule);
    for (const step of ['read-records', 'update-registry', 'record-task-map']) expect(chatNonce(step)).toBe(promptNonce(`urn:iep:action:wrd:${step}`));
  });

  it('the packet\'s chat route: one nonce wording, a read of the registry alone, what to do on a workspace with no type of task, and the capture table\'s fields grouped with its own route', async () => {
    const b = await bridge();
    const packet = await b.call('wrd.task_map_packet', { document_title: SOP_TITLE, document_text: SOP, pod_url: DEMO_POD });
    const next = obj(packet['next'], 'next');
    // Two routes, each with its own fields: nothing for the capture table beside the chat's.
    expect(Object.keys(next).sort()).toEqual(['relaySigned', 'review']);
    expect(obj(next['review'])).toEqual({
      instructions: expect.stringMatching(/capture table.*These fields are for the capture table only; a chat follows next\.relaySigned\.$/),
      toolName: 'wrd.record_task_map', action: 'urn:iep:action:wrd:record-task-map', sendAlso: 'document_text', podUrl: DEMO_POD,
    });
    const chat = obj(next['relaySigned']);
    expect(chat['nonceRule']).toBe(A.nonceRule);
    const read = obj(obj(chat['readRegistry'])['payload']);
    expect(read).toEqual({ intent: 'wrd:read-records', podUrl: DEMO_POD, kind: 'registry', nonce: promptNonce('urn:iep:action:wrd:read-records') });
    expect(obj(chat['payloadTemplate'])['nonce']).toBe(promptNonce('urn:iep:action:wrd:record-task-map'));
    // No type of task: say so, the person adds them in the app; never invent a slug.
    const how = String(chat['instructions']);
    for (const s of ['If the read lists no types of task, or none fits a task, tell the person and ask them to add the types in Work Redesign (People & roles, Types of task, where an admin adds them), then read again; never invent a slug.',
      'Offer to add the types they name yourself only as addTaskKinds.onlyWhen says.', 'Make each nonce as nonceRule says, and send no issuedAt.']) expect(how).toContain(s);
    const add = obj(chat['addTaskKinds']);
    expect(add['action']).toBe('urn:iep:action:wrd:update-registry');
    expect(add['onlyWhen']).toBe('readRegistry shows bridge.relayDelegation.chatAgentsDecide and reader.admin true, and the person confirmed each slug, label and definition; taskKinds only, never people, roles or rules');
    const addPayload = obj(add['payload']);
    expect(Object.keys(addPayload).sort()).toEqual(['intent', 'nonce', 'podUrl', 'taskKinds']);
    expect(addPayload['nonce']).toBe(promptNonce('urn:iep:action:wrd:update-registry'));
    expect(arr(addPayload['taskKinds']).map((k) => Object.keys(k).sort())).toEqual([['definition', 'label', 'slug']]);
    // Nothing in the packet's chat route carries an issuedAt or the old nonce wording.
    expect(JSON.stringify(chat)).not.toMatch(/"issuedAt"|16 to 64 letters/);
  });

  it('on a fresh workspace the registry read lists no type of task, and the packet\'s registry change adds the ones the person named where chat agents decide and the reader is an admin, and is refused where they do not', async () => {
    for (const [decide, admin, expected] of [[true, true, 'registered'], [false, true, 403], [true, false, 403]] as const) {
      const b = await bridge({ chatAgentsDecide: decide, leeIsAdmin: admin });
      const packet = await b.call('wrd.task_map_packet', { document_title: SOP_TITLE, document_text: SOP, pod_url: DEMO_POD });
      const chat = obj(obj(packet['next'])['relaySigned']);
      const readPayload = obj(obj(chat['readRegistry'])['payload']);
      const read = await b.call('wrd.read_records', await b.relay('claude', { ...readPayload, nonce: made(String(readPayload['nonce']), 1) }));
      expect([decide, admin, read['status'], arr(obj(read['registry'])['taskKinds'])]).toEqual([decide, admin, 'listed', []]);
      // What the packet's rule reads: whether chat agents decide here, and whether this reader is an admin.
      expect([obj(obj(read['bridge'])['relayDelegation'])['chatAgentsDecide'], obj(read['reader'])['admin']]).toEqual([decide, admin]);
      const add = obj(obj(chat['addTaskKinds'])['payload']);
      const answer = await b.call('wrd.update_registry', await b.relay('claude', { ...add, nonce: made(String(add['nonce']), 2), taskKinds: [KIND] }));
      if (expected === 'registered') {
        expect(answer['status']).toBe('registered');
        // Types of task only: the people and roles stay as they were.
        expect(arr(answer['members']).map((m) => [m['address'], m['roles']])).toEqual([[LEE, ['operator', 'worker']]]);
        expect(arr(answer['taskKinds']).map((k) => k['slug'])).toEqual([KIND.slug]);
      } else {
        expect([decide, admin, answer['iep:refusalStatus']]).toEqual([decide, admin, expected]);
      }
    }
  }, 60_000);

  it('a chat\'s template, for every intent, carries no issuedAt and the copied messages\' nonce; the key-held template and the web UI\'s are unchanged', async () => {
    const b = await bridge({ kinds: true });
    const actionOf = new Map(wrdAffordances.map((a) => [a.toolName, String(a.action)]));
    for (const intent of ENVELOPE_INTENTS) {
      const t = await b.call('wrd.read_envelope_template', await b.relay('claude', { intent: 'wrd:read-records', template: { intent, ...(intent === 'wrd:update-registry' ? { subject: 'taskKinds' } : {}) } }));
      expect([intent, t['status']]).toEqual([intent, 'templated']);
      const tpl = obj(t['template']);
      const schema = obj(t['schema']);
      const action = actionOf.get(String(t['toolName']));
      if (!action) throw new Error(`no action for ${String(t['toolName'])}`);
      expect([intent, 'issuedAt' in tpl, tpl['nonce']]).toEqual([intent, false, promptNonce(action)]);
      expect([intent, (schema['required'] as unknown[]).includes('issuedAt'), 'issuedAt' in obj(schema['properties'])]).toEqual([intent, false, false]);
      expect([intent, String(obj(obj(schema['properties'])['nonce'])['description'])]).toEqual([intent, expect.stringContaining(A.nonceRule)]);
      expect([intent, String(t['signing'])]).toEqual([intent, expect.stringContaining(`The nonce: ${A.nonceRule}`)]);
      expect([intent, String(t['signing'])]).toEqual([intent, expect.stringContaining('It carries no issuedAt: the relay adds its own time')]);
    }
    // Key-held, and through this bridge's own web UI: issuedAt filled, a fresh nonce from the bridge, and issuedAt required.
    for (const [who, body] of [['key-held', { intent: 'wrd:record-task-map', read_envelope: await b.keyRead() }], ['the web UI', { intent: 'wrd:record-task-map', read_envelope: await b.relay('work-redesign', { intent: 'wrd:read-records' }) }]] as const) {
      const t = await b.call('wrd.read_envelope_template', body);
      const tpl = obj(t['template']);
      expect([who, typeof tpl['issuedAt'], /^[0-9a-f]{32}$/.test(String(tpl['nonce']))]).toEqual([who, 'string', true]);
      expect([who, (obj(t['schema'])['required'] as unknown[]).includes('issuedAt')]).toEqual([who, true]);
    }
  }, 60_000);

  it('a chat\'s read leaves out the text that is the same in every read unless asked, and reads the registry alone when it asks, all inside the payload the relay signs', async () => {
    const b = await bridge({ kinds: true });
    const chatRead = async (fields: Obj = {}): Promise<Obj> => b.call('wrd.read_records', await b.relay('claude', { intent: 'wrd:read-records', ...fields }));
    // A map on the pod, so the full read has workflows and tasks to carry, as the live run's confirming read had.
    const recorded = await b.call('wrd.record_task_map', await b.relay('claude', {
      intent: 'wrd:record-task-map', workflow: { title: 'Supplier invoice intake (fictional)', unitLabel: 'invoice' }, tasks: TASKS(KIND.slug),
      document: { title: SOP_TITLE, sha256: sha256Hex(SOP), storeText: true }, document_text: SOP, draftedBy: { kind: 'agent', agent: 'test fixture standing in for a chat app', model: 'not-declared' },
    }));
    expect(recorded['status']).toBe('captured');

    const withFixed = await chatRead({ fixedText: true });
    const plain = await chatRead();
    const registryOnly = await chatRead({ kind: 'registry' });
    // Asked for, it is all there, as before; not asked for, it is named, with how to ask.
    expect([typeof withFixed['readExposure'], typeof withFixed['vocabulary']]).toEqual(['string', 'object']);
    expect(['readExposure' in plain, 'vocabulary' in plain]).toEqual([false, false]);
    expect(obj(plain['omitted'])).toEqual({ fields: ['readExposure', 'vocabulary'], include: expect.stringContaining('"fixedText": true') });
    const { readExposure: _x, vocabulary: _v, ...rest } = withFixed;
    const { omitted: _o, ...plainRest } = plain;
    expect(plainRest).toEqual(rest);
    // The registry alone: who is registered, whether this reader is an admin, and what the bridge allows; no other section.
    expect(Object.keys(registryOnly).filter((k) => ['workflows', 'tasks', 'plans', 'valuations', 'decisions', 'grants', 'runs'].includes(k))).toEqual([]);
    expect(arr(obj(registryOnly['registry'])['taskKinds']).map((k) => k['slug'])).toEqual([KIND.slug]);
    expect(arr(obj(registryOnly['registry'])['members']).map((m) => m['address'])).toEqual([LEE]);
    expect(obj(registryOnly['reader'])).toEqual({ admin: true });
    // Measured here (characters of JSON, a bridge with no record key): the whole read of one five-task map 20,033 with the
    // fixed text and 13,696 without; the registry read 8,322 with it and 1,985 alone. The live run's bridge, which holds a
    // record key, said more in readExposure: about 8,500 characters of fixed text in every read.
    const sizes = { full: size(withFixed), chat: size(plain), registry: size(registryOnly), fullRegistry: size(await chatRead({ kind: 'registry', fixedText: true })) };
    expect(sizes.full - sizes.chat).toBeGreaterThan(6_000);
    expect(sizes.registry).toBeLessThan(sizes.fullRegistry / 3);
    expect(sizes.registry).toBeLessThan(2_500);
    // A kind it does not know is refused, inside the signed payload as beside it.
    expect(obj(await chatRead({ kind: 'everything' }))).toMatchObject({ 'iep:refusalStatus': 400, error: 'Unknown kind.' });
    // The key-held read and the web UI's are unchanged: the fixed text stays, whatever they sign.
    for (const [who, body] of [['key-held', { envelope: await b.keyRead() }], ['the web UI', await b.relay('work-redesign', { intent: 'wrd:read-records' })]] as const) {
      const r = await b.call('wrd.read_records', body);
      expect([who, typeof r['readExposure'], typeof r['vocabulary'], 'omitted' in r]).toEqual([who, 'string', 'object', false]);
    }
  }, 60_000);

  it('tasks come back in their process\'s order, not their IRIs\', and a recorded map echoes the document it keeps', async () => {
    const b = await bridge({ kinds: true });
    const record = async (title: string, tasks: Obj[]): Promise<Obj> => b.call('wrd.record_task_map', await b.relay('claude', {
      intent: 'wrd:record-task-map', workflow: { title, unitLabel: 'invoice' }, tasks,
      document: { title: SOP_TITLE, sha256: sha256Hex(SOP), storeText: true }, document_text: SOP, draftedBy: { kind: 'agent', agent: 'test fixture standing in for a chat app', model: 'not-declared' },
    }));
    const first = await record('Supplier invoice intake (fictional)', TASKS(KIND.slug));
    // The answer says which text the record keeps, and that it keeps it.
    expect(obj(first['document'])).toEqual({ sha256: sha256Hex(SOP), chars: SOP.length, textStored: true });
    const second = await record('Invoice intake, reversed (fictional)', [...TASKS(KIND.slug)].reverse());
    const read = await b.call('wrd.read_records', await b.relay('claude', { intent: 'wrd:read-records' }));
    const workflows = arr(read['workflows']).map((w) => [String(w['workflowIri']), (w['taskIris'] as string[])] as const);
    expect(workflows.map(([iri]) => iri).sort()).toEqual([String(first['workflowIri']), String(second['workflowIri'])].sort());
    const expected = workflows.flatMap(([, iris]) => iris);
    const got = arr(read['tasks']).map((t) => String(t['taskIri']));
    expect(got).toEqual(expected);
    // Not the IRIs' own order, or this would show nothing.
    expect([...got].sort()).not.toEqual(got);
  }, 60_000);
});
