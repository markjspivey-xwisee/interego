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
 *     nonce the copied messages teach, listed first in fill, for every intent; a key-held template
 *     is unchanged; a chat's malformed write points at the signed template read, which answers the
 *     chat's shape;
 *   - a chat's read leaves out the text that is the same in every read unless asked, and can ask for
 *     the registry alone, inside the payload the relay signs (sizes measured below); it keeps this
 *     pod's own AI-permission rules, and the pod policy template carries every rule the pod holds;
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
import { schemaErrors } from './json-schema.js';

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
  /** Any payload signed with the key admin's own key, as {payload, signature}. */
  keySign(payload: Obj): Promise<Obj>;
  /** Call a tool with a body. */
  call(tool: string, body: Obj): Promise<Obj>;
}
/** A bridge on an empty pod: a key admin registers Lee by their user DID as a process lead, with no type of task. */
async function bridge(o: { readonly chatAgentsDecide?: boolean; readonly leeIsAdmin?: boolean; readonly kinds?: boolean; readonly podPolicy?: Obj } = {}): Promise<Bridge> {
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
    ...(o.kinds === true ? { taskKinds: [KIND] } : {}), ...(o.podPolicy ? { podPolicy: o.podPolicy } : {}),
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
    keySign: async (payload) => ({ payload, signature: await signMessageRaw(KEY_ADMIN, canonicalJson(payload)) }),
  };
}
/** A placeholder nonce, as a chat makes it from the rule. */
const made = (placeholder: string, n: number): string => placeholder.replace('<turn number, or 0>', '0').replace('<16 new random letters or digits>', `Fx${String(n).padStart(14, '0')}`);
const size = (v: unknown): number => JSON.stringify(v).length;
/** Set the value at one of a template's fill paths (`taskKinds[0].slug`), in place. */
function setPath(root: Obj, path: string, value: unknown): void {
  const keys = path.match(/[^.[\]]+/g) ?? [];
  const last = keys.pop();
  if (last === undefined) throw new Error(`an empty path: ${path}`);
  let at: unknown = root;
  for (const k of keys) at = Array.isArray(at) ? at[Number(k)] : obj(at, path)[k];
  if (Array.isArray(at)) at[Number(last)] = value;
  else obj(at, path)[last] = value;
}

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
      // The nonce is a placeholder the chat makes anew, so it is the first path to fill, and listed once.
      const fill = (t['fill'] as unknown[]).map(String);
      expect([intent, fill[0], fill.filter((p) => p === 'nonce').length]).toEqual([intent, 'nonce', 1]);
    }
    // Key-held, and through this bridge's own web UI: issuedAt filled, a fresh nonce from the bridge, and issuedAt required.
    for (const [who, body] of [['key-held', { intent: 'wrd:record-task-map', read_envelope: await b.keyRead() }], ['the web UI', { intent: 'wrd:record-task-map', read_envelope: await b.relay('work-redesign', { intent: 'wrd:read-records' }) }]] as const) {
      const t = await b.call('wrd.read_envelope_template', body);
      const tpl = obj(t['template']);
      expect([who, typeof tpl['issuedAt'], /^[0-9a-f]{32}$/.test(String(tpl['nonce']))]).toEqual([who, 'string', true]);
      expect([who, (obj(t['schema'])['required'] as unknown[]).includes('issuedAt')]).toEqual([who, true]);
      // The bridge made this nonce: nothing to fill.
      expect([who, (t['fill'] as unknown[]).includes('nonce')]).toEqual([who, false]);
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
    // Asked for, it is all there, as before; not asked for, each field left out is named, with how to ask, and this pod's own
    // AI-permission rules stay under vocabulary (they differ from pod to pod: see the stricter pod's test below).
    expect([typeof withFixed['readExposure'], typeof withFixed['vocabulary']]).toEqual(['string', 'object']);
    const fullVocabulary = obj(withFixed['vocabulary'], 'the full vocabulary');
    expect('readExposure' in plain).toBe(false);
    expect(obj(plain['vocabulary'], 'a chat\'s vocabulary')).toEqual({ grantPolicy: fullVocabulary['grantPolicy'], podPolicy: fullVocabulary['podPolicy'] });
    const omitted = obj(plain['omitted'], 'omitted');
    expect(omitted).toEqual({ fields: expect.any(Array), include: expect.stringContaining('"fixedText": true') });
    expect(String(omitted['include'])).toContain('vocabulary keeps this pod\'s own AI-permission rules: podPolicy, and grantPolicy with it applied');
    // What is left out and what is kept are the whole of the full read, each once.
    const fields = (omitted['fields'] as unknown[]).map(String);
    expect(fields[0]).toBe('readExposure');
    expect([...fields.slice(1).map((f) => f.replace(/^vocabulary\./, '')), ...Object.keys(obj(plain['vocabulary']))].sort()).toEqual(Object.keys(fullVocabulary).sort());
    expect(fields.slice(1).every((f) => f.startsWith('vocabulary.'))).toBe(true);
    const { readExposure: _x, vocabulary: _v, ...rest } = withFixed;
    const { omitted: _o, vocabulary: _pv, ...plainRest } = plain;
    expect(plainRest).toEqual(rest);
    // The registry alone: who is registered, whether this reader is an admin, and what the bridge allows; no other section.
    expect(Object.keys(registryOnly).filter((k) => ['workflows', 'tasks', 'plans', 'valuations', 'decisions', 'grants', 'runs'].includes(k))).toEqual([]);
    expect(arr(obj(registryOnly['registry'])['taskKinds']).map((k) => k['slug'])).toEqual([KIND.slug]);
    expect(arr(obj(registryOnly['registry'])['members']).map((m) => m['address'])).toEqual([LEE]);
    expect(obj(registryOnly['reader'])).toEqual({ admin: true });
    // Measured here (characters of JSON, a bridge with no record key): the whole read of one five-task map 20,033 with the
    // fixed text and 14,405 without; the registry read 8,322 with it and 2,694 alone. A chat's read keeps this pod's own
    // AI-permission rules and names each field it leaves out, about 700 characters more than leaving all of vocabulary
    // out. The live run's bridge, which holds a record key, said more in readExposure: about 8,500 characters of fixed
    // text in every read.
    const sizes = { full: size(withFixed), chat: size(plain), registry: size(registryOnly), fullRegistry: size(await chatRead({ kind: 'registry', fixedText: true })) };
    expect(sizes.full - sizes.chat).toBeGreaterThan(5_000);
    expect(sizes.registry).toBeLessThan(sizes.fullRegistry / 3);
    expect(sizes.registry).toBeLessThan(3_000);
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
  it('on a pod with stricter AI-permission rules, a chat\'s read shows them, and the pod policy template, key-held and a chat\'s, carries every rule the pod holds, so one sent with a rule raised keeps the others', async () => {
    const STRICT = { floor: 0.97, minSamples: 60 };
    const b = await bridge({ chatAgentsDecide: true, podPolicy: STRICT });
    const chatRead = async (fields: Obj = {}): Promise<Obj> => b.call('wrd.read_records', await b.relay('claude', { intent: 'wrd:read-records', ...fields }));
    const published = obj(obj((await b.call('wrd.read_records', { envelope: await b.keyRead() }))['vocabulary'])['grantPolicy']);
    // A chat's read, whole or the registry alone, without the fixed text: the pod's policy, and the grant policy with it applied.
    for (const fields of [{}, { kind: 'registry' }]) {
      const v = obj((await chatRead(fields))['vocabulary'], 'a chat\'s vocabulary');
      const grant = obj(v['grantPolicy'], 'grantPolicy');
      expect([fields, Object.keys(v).sort(), v['podPolicy'], grant['floor'], grant['minSamples']]).toEqual([fields, ['grantPolicy', 'podPolicy'], STRICT, 0.97, 60]);
      // The counts the pod leaves alone are the published ones.
      expect([fields, grant['minHumanConfirmations'], grant['minDistinctConfirmers']]).toEqual([fields, published['minHumanConfirmations'], published['minDistinctConfirmers']]);
    }

    // The pod policy template, key-held and a chat's (under template in the read the relay signs): every rule the pod holds now.
    const policyTemplate = async (who: 'key-held' | 'a chat'): Promise<Obj> => b.call('wrd.read_envelope_template', who === 'key-held'
      ? { intent: 'wrd:update-registry', subject: 'podPolicy', read_envelope: await b.keyRead() }
      : await b.relay('claude', { intent: 'wrd:read-records', template: { intent: 'wrd:update-registry', subject: 'podPolicy' } }));
    for (const who of ['key-held', 'a chat'] as const) {
      const t = await policyTemplate(who);
      expect([who, t['status'], obj(t['template'])['podPolicy'], String(t['note'])]).toEqual([who, 'templated', STRICT, expect.stringMatching(/^What you send replaces the whole pod policy: keep each field shown/)]);
    }
    // Sent with one rule raised, the others stay: the key admin raises minSamples, then the chat, reading its template again, raises the floor.
    const keyTpl = obj((await policyTemplate('key-held'))['template']);
    const byKey = await b.call('wrd.update_registry', { envelope: await b.keySign({ ...keyTpl, podPolicy: { ...obj(keyTpl['podPolicy']), minSamples: 80 } }) });
    expect([byKey['status'], byKey['podPolicy']]).toEqual(['registered', { floor: 0.97, minSamples: 80 }]);
    const chatT = await policyTemplate('a chat');
    const chatTpl = obj(chatT['template']);
    expect([chatT['fill'], chatTpl['podPolicy']]).toEqual([['nonce'], { floor: 0.97, minSamples: 80 }]);
    const byChat = await b.call('wrd.update_registry', await b.relay('claude', { ...chatTpl, nonce: made(String(chatTpl['nonce']), 3), podPolicy: { ...obj(chatTpl['podPolicy']), floor: 0.98 } }));
    expect([byChat['status'], byChat['podPolicy']]).toEqual(['registered', { floor: 0.98, minSamples: 80 }]);
    expect(obj((await chatRead({ kind: 'registry' }))['vocabulary'])['podPolicy']).toEqual({ floor: 0.98, minSamples: 80 });
  }, 60_000);

  it('a chat\'s template filled exactly as its fill lists, nonce first, meets its schema and is taken; with no part named, or the pod policy, it still lists its nonce to fill', async () => {
    const b = await bridge({ chatAgentsDecide: true });
    const template = async (t: Obj): Promise<Obj> => b.call('wrd.read_envelope_template', await b.relay('claude', { intent: 'wrd:read-records', template: { intent: 'wrd:update-registry', ...t } }));
    const kinds = await template({ subject: 'taskKinds' });
    expect(kinds['fill']).toEqual(['nonce', 'taskKinds[0].slug', 'taskKinds[0].label', 'taskKinds[0].definition']);
    const tpl = obj(kinds['template']);
    // As it comes, the placeholder nonce is one thing the schema refuses: it is to be filled like the nulls.
    expect(schemaErrors(kinds['schema'], tpl).filter((e) => e.startsWith('$.nonce'))).toEqual(['$.nonce: does not match ^[A-Za-z0-9_-]{16,64}$']);
    const values: Readonly<Record<string, unknown>> = { nonce: made(String(tpl['nonce']), 7), 'taskKinds[0].slug': KIND.slug, 'taskKinds[0].label': KIND.label, 'taskKinds[0].definition': KIND.definition };
    for (const path of (kinds['fill'] as unknown[]).map(String)) setPath(tpl, path, values[path]);
    expect(schemaErrors(kinds['schema'], tpl)).toEqual([]);
    const sent = await b.call('wrd.update_registry', await b.relay('claude', tpl));
    expect([sent['status'], arr(sent['taskKinds']).map((k) => k['slug'])]).toEqual(['registered', [KIND.slug]]);
    for (const subject of [null, 'podPolicy']) {
      const t = await template(subject === null ? {} : { subject });
      expect([subject, t['fill']]).toEqual([subject, ['nonce']]);
    }
  }, 60_000);

  it('a chat\'s malformed write points at the signed template read, with the intent under template, which answers the chat\'s shape; a key-held one still points at the unsigned template', async () => {
    const b = await bridge({ chatAgentsDecide: true });
    const refused = await b.call('wrd.update_registry', await b.relay('claude', { intent: 'wrd:update-registry', podUrl: DEMO_POD, nonce: made(chatNonce('update-registry'), 9) }));
    expect([refused['iep:refusalStatus'], refused['error']]).toEqual([400, 'The registry change is malformed.']);
    expect(obj(refused['expectedPayload'])['required']).toEqual(['intent', 'podUrl', 'nonce']);
    const resolvedBy = obj(refused['iep:resolvedBy'], 'iep:resolvedBy');
    expect(resolvedBy).toEqual({ action: 'urn:iep:action:wrd:read-envelope-template', toolName: 'wrd.read_envelope_template', intent: 'wrd:read-records', template: { intent: 'wrd:update-registry' } });
    // Followed as it says, it answers the chat's shape: no issuedAt, the copied messages' nonce.
    const followed = await b.call(String(resolvedBy['toolName']), await b.relay('claude', { intent: resolvedBy['intent'], template: resolvedBy['template'] }));
    expect([followed['status'], 'issuedAt' in obj(followed['template']), obj(followed['template'])['nonce'], obj(followed['schema'])['required']])
      .toEqual(['templated', false, chatNonce('update-registry'), obj(refused['expectedPayload'])['required']]);
    // Key-held: the unsigned template, which answers the key-held shape.
    const issuedAt = obj((await b.keyRead())['payload'])['issuedAt'];
    const keyRefused = await b.call('wrd.update_registry', { envelope: await b.keySign({ intent: 'wrd:update-registry', podUrl: DEMO_POD, issuedAt, nonce: 'chat-route-key-malformed-1' }) });
    expect([keyRefused['iep:refusalStatus'], keyRefused['iep:resolvedBy']]).toEqual([400, { action: 'urn:iep:action:wrd:envelope-template', toolName: 'wrd.envelope_template', intent: 'wrd:update-registry' }]);
    expect(obj(keyRefused['expectedPayload'])['required']).toContain('issuedAt');
  }, 60_000);
});
