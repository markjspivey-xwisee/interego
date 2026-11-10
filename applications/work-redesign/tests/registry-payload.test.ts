/**
 * The wrd:update-registry payload schema says what the registry handler requires, so a payload
 * built only from the schema is taken the first time.
 *
 * The schema is what an assistant builds from: it is summarised into the affordance's envelope
 * description, served whole (with a template) by wrd.envelope_template, and attached to a
 * malformed payload's refusal as expectedPayload. It used to mark an entry's softwareAgent,
 * label and personRef optional, while mergeRegistry refused an entry without them, one field per
 * signed attempt. Here every entry shape the schema publishes (a person by user DID, a person by
 * key, an agent, a removal) is built from that shape's required fields alone, and each is checked
 * against the schema and then sent, signed, to the handler; and every pod-independent rule the
 * handler applies is checked to be one the schema refuses too. The other direction is pinned as
 * well: where the schema is stricter than the handler, it is so on purpose, in the places the
 * README names.
 */
import { describe, it, expect } from 'vitest';
import { importWallet, signMessageRaw, canonicalJson, sha256Hex, type Wallet } from '@interego/core';
import { createWrdHandlers } from '../bridge/handlers.js';
import { ENVELOPE_INTENTS, payloadSchema, payloadSummary } from '../src/payloads.js';
import { ALLOCATION_LEVELS } from '../src/ontology.js';
import { memoryPod, demoClock, DEMO_POD } from '../demo/run.js';
import { schemaErrors } from './json-schema.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown, what: string): Obj => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`expected ${what} to be an object, got ${JSON.stringify(v)?.slice(0, 200)}`);
  return v as Obj;
};

const IDENTITY = 'identity.example.org';
const wallet = (id: string, type: 'human' | 'agent' = 'human'): Wallet => importWallet(`0x${sha256Hex(`wrd-registry-payload:${id}`)}`, type, id);
const ADMIN = wallet('admin');
const PLATFORM = wallet('platform', 'agent');
const ANA = wallet('ana');
const AGENT = wallet('agent', 'agent');
const OLU = `did:web:${IDENTITY}:users:u-pk-0101a0b0c0d0`;

const SCHEMA = payloadSchema('wrd:update-registry');

/** A bridge with an admin key and an identity host (so a user DID can be registered), on an empty in-memory pod. */
function bridge(): { readonly call: (fields: Obj) => Promise<Obj>; readonly payload: (fields: Obj) => Obj; readonly template: (subject?: string) => Promise<Obj> } {
  const pod = memoryPod();
  const clock = demoClock();
  const h = createWrdHandlers({
    fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), platform: { wallet: PLATFORM, keyKind: 'configured' },
    adminAddresses: [ADMIN.address],
    relayDelegation: { relayAddresses: [], identityHost: IDENTITY, fetchDidDocument: async () => { throw new Error('no DID document is read here'); } },
  });
  let n = 0;
  const payload = (fields: Obj): Obj => {
    n += 1;
    return { intent: 'wrd:update-registry', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: `registry-payload-${String(n).padStart(6, '0')}`, ...fields };
  };
  const send = async (p: Obj): Promise<Obj> => obj(await h['wrd.update_registry']!({ envelope: { payload: p, signature: await signMessageRaw(ADMIN, canonicalJson(p)) } }), 'the answer');
  return {
    payload,
    call: async (fields) => send(payload(fields)),
    template: async (subject) => obj(await h['wrd.envelope_template']!({ intent: 'wrd:update-registry', ...(subject ? { subject } : {}) }), 'the template answer'),
  };
}

/** The schema an entry of `entries` must meet, and, by title, each shape it may take. */
const entrySchema = (): Obj => obj(obj(obj(SCHEMA['properties'], 'properties')['entries'], 'entries')['items'], 'entries.items');
function shapes(): Map<string, Obj> {
  const items = entrySchema();
  const all = Array.isArray(items['oneOf']) ? items['oneOf'].map((s) => obj(s, 'an entry shape')) : [items];
  return new Map(all.map((s) => [String(s['title'] ?? 'entry'), s]));
}
/** Only the fields `shape` requires, taken from `pool`: what a builder working from the schema alone sends. */
function fromRequired(shape: Obj, pool: Obj): Obj {
  const required = Array.isArray(shape['required']) ? shape['required'].map(String) : [];
  return Object.fromEntries(required.map((k) => {
    if (!(k in pool)) throw new Error(`the schema requires ${k}, which the test's pool does not hold`);
    return [k, pool[k]];
  }));
}

/**
 * Everything a builder could know about each member, more than any one shape needs: the schema
 * decides which fields go in. A shape absent from the schema falls back to the whole entry
 * schema, whose required fields are then what is sent.
 */
const POOL = {
  personByDid: { address: OLU, roles: ['worker'], label: 'Olu', softwareAgent: false, personRef: 'p-olu', principal: ANA.address, model: 'fixture-model' },
  personByKey: { address: ANA.address, roles: ['operator', 'approver'], label: 'Ana', softwareAgent: false, personRef: 'p-ana', principal: ANA.address, model: 'fixture-model' },
  agent: { address: AGENT.address, roles: ['agent'], label: 'Matching agent', softwareAgent: true, personRef: 'p-agent', principal: ANA.address, model: 'fixture-model' },
  removal: { address: OLU, roles: [], label: 'Olu', softwareAgent: false, personRef: 'p-olu', principal: ANA.address, model: 'fixture-model' },
} as const;
const shapeOf = (title: string): Obj => shapes().get(title) ?? entrySchema();

/** Expect the schema to take `p` and the handler to register it. */
async function accepted(b: ReturnType<typeof bridge>, fields: Obj, what: string): Promise<Obj> {
  const p = b.payload(fields);
  expect([what, schemaErrors(SCHEMA, p)]).toEqual([what, []]);
  const r = await b.call(fields);
  expect([what, r['status'], r['iep:refusalReason'] ?? null]).toEqual([what, 'registered', null]);
  return r;
}

describe('wrd:update-registry payload schema', () => {
  it('an entry built from its shape\'s required fields alone is valid and taken: a person by user DID, a person by key, an agent, and a removal', async () => {
    const b = bridge();
    const byKey = fromRequired(shapeOf('PersonEntry'), POOL.personByKey);
    const byDid = fromRequired(shapeOf('PersonEntry'), POOL.personByDid);
    const agent = fromRequired(shapeOf('AgentEntry'), POOL.agent);
    const removal = fromRequired(shapeOf('RemovalEntry'), POOL.removal);
    // The shapes ask for exactly what the handler reads: no more (a person names no principal or model, an agent no personRef).
    expect(byKey).toEqual({ address: ANA.address, roles: ['operator', 'approver'], label: 'Ana', softwareAgent: false, personRef: 'p-ana' });
    expect(agent).toEqual({ address: AGENT.address, roles: ['agent'], label: 'Matching agent', softwareAgent: true, principal: ANA.address, model: 'fixture-model' });
    expect(removal).toEqual({ address: OLU, roles: [] });

    await accepted(b, { entries: [byKey] }, 'a person by key');
    const withDid = await accepted(b, { entries: [byDid] }, 'a person by user DID');
    expect((withDid['members'] as Obj[]).find((m) => m['address'] === OLU)).toMatchObject({ softwareAgent: false, personRef: 'p-olu', principal: null, model: null });
    const withAgent = await accepted(b, { entries: [agent] }, 'an agent');
    expect((withAgent['members'] as Obj[]).find((m) => m['address'] === AGENT.address.toLowerCase())).toMatchObject({ softwareAgent: true, principal: ANA.address.toLowerCase(), model: 'fixture-model', personRef: null });
    const afterRemoval = await accepted(b, { entries: [removal] }, 'a removal');
    expect((afterRemoval['members'] as Obj[]).map((m) => m['address'])).not.toContain(OLU);
    // All three kinds in one change, as the web UI's People page and an assistant may send them.
    const b2 = bridge();
    await accepted(b2, { entries: [byKey, byDid, agent] }, 'a person by key, a person by user DID and their agent at once');
  });

  it('the envelope template\'s entry, asked for as the part changed (subject entries), with every path in its fill filled, is a person\'s entry the schema and the handler take', async () => {
    const b = bridge();
    const t = await b.template('entries');
    const tpl = obj(t['template'], 'template');
    expect(t['fill']).toEqual(['entries[0].address', 'entries[0].roles[0]', 'entries[0].label', 'entries[0].personRef']);
    // Each path the template leaves to the signer, filled in place, and nothing else touched.
    const values: Readonly<Record<string, unknown>> = { address: ANA.address, 'roles[0]': 'worker', label: 'Ana', personRef: 'p-ana' };
    const entry = obj((tpl['entries'] as unknown[])[0], 'the template\'s entry');
    for (const path of t['fill'] as string[]) {
      const key = path.replace(/^entries\[0\]\./, '');
      if (key === 'roles[0]') (entry['roles'] as unknown[])[0] = values[key];
      else entry[key] = values[key];
    }
    expect(entry).toEqual({ address: ANA.address, roles: ['worker'], label: 'Ana', softwareAgent: false, personRef: 'p-ana' });
    expect(schemaErrors(SCHEMA, tpl)).toEqual([]);
    const { intent: _i, podUrl: _p, issuedAt: _a, nonce: _n, ...fields } = tpl;
    await accepted(b, fields, 'the filled template');
  });

  it('the template fills no part of a change until one is named, so one filled in as it stands never changes people and roles by default; named, it is that part alone, which the schema and the handler take', async () => {
    const b = bridge();
    const parts = ['entries', 'taskKinds', 'podPolicy'];
    // No part named: no entries row, no task kinds, no pod policy, and nothing to fill; its note says to send only the part changed.
    const none = await b.template();
    const bare = obj(none['template'], 'template');
    expect(parts.filter((k) => k in bare)).toEqual([]);
    expect(none['fill']).toEqual([]);
    expect(String(none['note'])).toMatch(/^Send only the part you change, and leave the others out: entries \(people and AI agents; a change to people and roles\), taskKinds \(types of task\) or podPolicy .* Ask again with subject entries, taskKinds or podPolicy/);
    // Types of task alone: a slug, a label and a definition to fill, nothing about people. Filled and sent, the people stay as they were.
    await accepted(b, { entries: [{ address: ANA.address, roles: ['operator'], label: 'Ana', softwareAgent: false, personRef: 'p-ana' }] }, 'Ana');
    const kinds = await b.template('taskKinds');
    const tpl = obj(kinds['template'], 'template');
    expect([parts.filter((k) => k in tpl), kinds['fill']]).toEqual([['taskKinds'], ['taskKinds[0].slug', 'taskKinds[0].label', 'taskKinds[0].definition']]);
    const kind = obj((tpl['taskKinds'] as unknown[])[0], 'the template\'s type of task');
    Object.assign(kind, { slug: 'invoice-intake', label: 'Invoice intake (fictional)', definition: 'Taking a supplier invoice in, up to the intake log.' });
    expect(schemaErrors(SCHEMA, tpl)).toEqual([]);
    const { intent: _i, podUrl: _p, issuedAt: _a, nonce: _n, ...fields } = tpl;
    const r = await accepted(b, fields, 'the filled task-kinds template');
    expect((r['members'] as Obj[]).map((m) => [m['address'], m['roles']])).toEqual([[ANA.address.toLowerCase(), ['operator']]]);
    // The pod policy alone: the policy now on the pod (none yet), and a note: it replaces the whole policy, its fields, the published values.
    const policy = await b.template('podPolicy');
    expect([parts.filter((k) => k in obj(policy['template'], 'template')), obj(policy['template'], 'template')['podPolicy']]).toEqual([['podPolicy'], {}]);
    expect(String(policy['note'])).toMatch(/^What you send replaces the whole pod policy.* Its fields: maxLevel, floor, minSamples, minHumanConfirmations, minDistinctConfirmers\. Published: floor 0\.\d+, minSamples \d+, minHumanConfirmations \d+, minDistinctConfirmers \d+\.$/);
    // A part that is not one is refused.
    const unknown = await b.template('everything');
    expect([unknown['iep:refusalStatus'], unknown['error']]).toEqual([400, 'Unknown part of a registry change.']);
  });

  it('the schema refuses each entry the handler refuses for its shape alone, and a change that carries nothing', async () => {
    const b = bridge();
    const person = { address: ANA.address, roles: ['operator'], label: 'Ana', softwareAgent: false, personRef: 'p-ana' };
    // Ana is registered first, so an agent's principal is a registered person and only the entry under test is wrong.
    await accepted(b, { entries: [person] }, 'Ana');
    const agent = { address: AGENT.address, roles: ['agent'], label: 'Matching agent', softwareAgent: true, principal: ANA.address, model: 'fixture-model' };
    const without = (e: Obj, k: string): Obj => Object.fromEntries(Object.entries(e).filter(([x]) => x !== k));
    const cases: ReadonlyArray<readonly [string, Obj, RegExp]> = [
      ['a person without softwareAgent', { entries: [without(person, 'softwareAgent')] }, /softwareAgent must be true or false/],
      ['a person without personRef', { entries: [without(person, 'personRef')] }, /personRef is required/],
      ['a person without a label', { entries: [without(person, 'label')] }, /label must be 1 to 80 characters/],
      ['a blank label', { entries: [{ ...person, label: '   ' }] }, /label must be 1 to 80 characters/],
      ['a label of 81 characters', { entries: [{ ...person, label: 'a'.repeat(81) }] }, /label must be 1 to 80 characters/],
      ['a personRef with a space', { entries: [{ ...person, personRef: 'p ana' }] }, /personRef is required/],
      ['a personRef of 81 characters', { entries: [{ ...person, personRef: 'p'.repeat(81) }] }, /personRef is required/],
      ['an empty personRef', { entries: [{ ...person, personRef: '' }] }, /personRef is required/],
      ['a person naming a principal', { entries: [{ ...person, principal: ANA.address }] }, /principal and model belong to agents/],
      ['a person naming a model', { entries: [{ ...person, model: 'fixture-model' }] }, /principal and model belong to agents/],
      ['the agent role on a person', { entries: [{ ...person, roles: ['worker', 'agent'] }] }, /the agent role and softwareAgent: true go together/],
      ['an agent at a user DID', { entries: [{ ...agent, address: OLU }] }, /an agent is registered by the key it signs its runs with/],
      ['an agent without softwareAgent', { entries: [without(agent, 'softwareAgent')] }, /softwareAgent must be true or false/],
      ['an agent marked a person', { entries: [{ ...agent, softwareAgent: false }] }, /the agent role and softwareAgent: true go together/],
      ['an agent with another role', { entries: [{ ...agent, roles: ['agent', 'worker'] }] }, /an agent holds the agent role only/],
      ['an agent without a principal', { entries: [without(agent, 'principal')] }, /principal is required/],
      ['an agent without a model', { entries: [without(agent, 'model')] }, /model is required/],
      ['an agent with a blank model', { entries: [{ ...agent, model: ' ' }] }, /model is required/],
      ['an agent with a model of 121 characters', { entries: [{ ...agent, model: 'm'.repeat(121) }] }, /model is required/],
      ['an agent with a personRef', { entries: [{ ...agent, personRef: 'p-agent' }] }, /personRef belongs to people; an agent has a principal instead/],
      ['softwareAgent true on a person\'s roles', { entries: [{ ...person, softwareAgent: true, principal: ANA.address, model: 'm' }] }, /the agent role and softwareAgent: true go together/],
      ['a role that does not exist', { entries: [{ ...person, roles: ['admin'] }] }, /roles must be a list of approver, operator, worker, agent/],
      ['an address that is neither a key nor a user DID', { entries: [{ ...person, address: 'ana' }] }, /address must be a 0x address/],
      ['a change that carries nothing', {}, /a change carries at least one of entries, taskKinds or podPolicy/],
      ['a task kind with a blank label', { taskKinds: [{ slug: 'invoice-matching', label: ' ', definition: 'Match an invoice to its purchase order.' }] }, /taskKinds\[0\]\.label must be 1 to 80 characters/],
      ['a task kind defined over two lines', { taskKinds: [{ slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice.\nThen pay it.' }] }, /taskKinds\[0\]\.definition must be one sentence/],
      ['a task kind with a blank definition', { taskKinds: [{ slug: 'invoice-matching', label: 'Invoice matching', definition: '  ' }] }, /taskKinds\[0\]\.definition must be one sentence/],
      // A pod policy: every check the handler makes on one is independent of the pod.
      ['a pod policy that is a list', { podPolicy: [] }, /podPolicy must be an object or null/],
      ['a pod policy capped at a level that does not exist', { podPolicy: { maxLevel: 'bogus' } }, /podPolicy\.maxLevel must be an allocation level/],
      ['a pod policy with a field it does not have', { podPolicy: { foo: 1 } }, /podPolicy\.foo is not a pod policy field/],
      ['a pod policy floor of 0', { podPolicy: { floor: 0 } }, /podPolicy\.floor must be a number in \(0, 1\]/],
      ['a pod policy floor written as text', { podPolicy: { floor: '0.9' } }, /podPolicy\.floor must be a number in \(0, 1\]/],
      ['a pod policy floor above 1', { podPolicy: { floor: 1.5 } }, /podPolicy\.floor must be a number in \(0, 1\]/],
      ['a pod policy minSamples that is not a whole number', { podPolicy: { minSamples: 1.5 } }, /podPolicy\.minSamples must be a positive integer/],
      ['a pod policy minHumanConfirmations of 0', { podPolicy: { minHumanConfirmations: 0 } }, /podPolicy\.minHumanConfirmations must be a positive integer/],
      ['a pod policy minDistinctConfirmers above 100000', { podPolicy: { minDistinctConfirmers: 100_001 } }, /podPolicy\.minDistinctConfirmers must be a positive integer/],
    ];
    const seen: unknown[] = [];
    for (const [what, fields, why] of cases) {
      const r = await b.call(fields);
      seen.push({
        what, schemaRefuses: schemaErrors(SCHEMA, b.payload(fields)).length > 0, status: r['iep:refusalStatus'], error: r['error'],
        why: why.test(String(r['iep:refusalReason'])) ? 'as expected' : r['iep:refusalReason'],
        // The refusal carries the schema itself, so the next attempt is built from all of it.
        expectedPayload: r['expectedPayload'] === undefined ? 'missing' : JSON.stringify(r['expectedPayload']) === JSON.stringify(SCHEMA) ? 'the schema' : 'another schema',
      });
    }
    expect(seen).toEqual(cases.map(([what]) => ({ what, schemaRefuses: true, status: 400, error: 'The registry change is malformed.', why: 'as expected', expectedPayload: 'the schema' })));
  });

  it('a change that carries only a pod policy, built from the schema\'s fields, is taken; a value that loosens the published policy is the one refusal the schema cannot state, and it is not answered as malformed', async () => {
    const b = bridge();
    const policy = obj(obj(SCHEMA['properties'], 'properties')['podPolicy'], 'podPolicy');
    // The schema names every field the handler reads, and no other.
    expect(Object.keys(obj(policy['properties'], 'podPolicy.properties'))).toEqual(['maxLevel', 'floor', 'minSamples', 'minHumanConfirmations', 'minDistinctConfirmers']);
    expect(policy['additionalProperties']).toBe(false);
    // Each field at a value that tightens the published policy (floor 0.9, minSamples 20, five confirmations from five people).
    const tighter = { maxLevel: 'agent-drafts-person-decides', floor: 0.95, minSamples: 40, minHumanConfirmations: 8, minDistinctConfirmers: 6 };
    const r = await accepted(b, { podPolicy: tighter }, 'a pod policy that tightens every field');
    expect(r['podPolicy']).toEqual(tighter);
    await accepted(b, { podPolicy: { floor: 1 } }, 'a pod policy that asks every reviewed run to be accepted');
    await accepted(b, { podPolicy: null }, 'clearing the pod policy');

    const loosens = { podPolicy: { floor: 0.5 } };
    expect(schemaErrors(SCHEMA, b.payload(loosens))).toEqual([]);
    const refused = await b.call(loosens);
    expect([refused['iep:refusalStatus'], refused['error'], refused['iep:refusalReason'], refused['expectedPayload'] ?? 'none'])
      .toEqual([400, 'A pod policy can only tighten the published policy: floor.', 'podPolicy.floor is below the published value', 'none']);
  });

  it('the schema is stricter than the handler only on purpose: a repeated role, a field the handler does not read on a person or an agent, and a null label or definition for a registered task kind are refused by the schema and taken by the handler', async () => {
    const b = bridge();
    const person = { address: ANA.address, roles: ['operator'], label: 'Ana', softwareAgent: false, personRef: 'p-ana' };
    const kind = { slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice to its purchase order.' };
    await accepted(b, { entries: [person], taskKinds: [kind] }, 'Ana and a task kind');
    const agent = { address: AGENT.address, roles: ['agent'], label: 'Matching agent', softwareAgent: true, principal: ANA.address, model: 'fixture-model' };
    const cases: ReadonlyArray<readonly [string, Obj]> = [
      ['a person with a role listed twice', { entries: [{ ...person, roles: ['worker', 'worker'] }] }],
      ['a person with four roles, one of them twice', { entries: [{ ...person, roles: ['worker', 'operator', 'approver', 'worker'] }] }],
      ['an agent with the agent role twice', { entries: [{ ...agent, roles: ['agent', 'agent'] }] }],
      ['a person with a field the handler does not read', { entries: [{ ...person, note: 'met at the workshop' }] }],
      ['an agent with a field the handler does not read', { entries: [{ ...agent, note: 'pilot' }] }],
      ['a registered task kind with a null label', { taskKinds: [{ slug: kind.slug, label: null }] }],
      ['a registered task kind with a null definition', { taskKinds: [{ slug: kind.slug, definition: null }] }],
    ];
    const seen: unknown[] = [];
    const answers = new Map<string, Obj>();
    for (const [what, fields] of cases) {
      const r = await b.call(fields);
      answers.set(what, r);
      seen.push({ what, schemaRefuses: schemaErrors(SCHEMA, b.payload(fields)).length > 0, status: r['status'] ?? r['iep:refusalReason'] });
    }
    expect(seen).toEqual(cases.map(([what]) => ({ what, schemaRefuses: true, status: 'registered' })));
    // The handler reads each as the schema's stricter form would say it: each role once, nothing else kept, the kind's own label and definition.
    const member = (what: string, address: string): Obj | undefined => (answers.get(what)?.['members'] as Obj[] | undefined)?.find((m) => m['address'] === address.toLowerCase());
    expect(member('a person with a role listed twice', ANA.address)?.['roles']).toEqual(['worker']);
    expect(member('a person with four roles, one of them twice', ANA.address)?.['roles']).toEqual(['approver', 'operator', 'worker']);
    expect(member('an agent with the agent role twice', AGENT.address)?.['roles']).toEqual(['agent']);
    expect([member('a person with a field the handler does not read', ANA.address), member('an agent with a field the handler does not read', AGENT.address)].map((m) => m === undefined ? 'missing' : 'note' in m)).toEqual([false, false]);
    expect(answers.get('a registered task kind with a null definition')?.['taskKinds']).toEqual([{ ...kind, retired: false }]);
  });

  it('the test\'s schema check reads a field named like an Object.prototype member as the payload\'s own, in properties and in required', () => {
    const p = bridge().payload;
    const person = { address: ANA.address, roles: ['worker'], label: 'Ana', softwareAgent: false, personRef: 'p-ana' };
    // A person's entry has no toString field, so no shape takes it.
    expect(schemaErrors(SCHEMA, p({ entries: [{ ...person, toString: 1 }] }))).toEqual(['$.entries[0]: matches 0 of oneOf, not exactly one']);
    expect(schemaErrors(SCHEMA, p({ entries: [{ ...person, constructor: 1 }] }))).toEqual(['$.entries[0]: matches 0 of oneOf, not exactly one']);
    // A removal is read for nothing but its address and empty roles, so one carrying constructor is still a removal.
    expect(schemaErrors(SCHEMA, p({ entries: [{ address: OLU, roles: [], constructor: 1 }] }))).toEqual([]);
    // A required field is present only when the value holds it itself.
    expect(schemaErrors({ type: 'object', required: ['toString', 'constructor'] }, {})).toEqual(['$: toString is required', '$: constructor is required']);
    expect(schemaErrors({ type: 'object', required: ['toString'] }, { toString: 1 })).toEqual([]);
  });

  it('every sub-schema of every payload declares each field it requires, so a validator in strict mode compiles it (Ajv\'s strictRequired)', () => {
    const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
    const undeclared: string[] = [];
    const walk = (s: unknown, at: string): void => {
      if (!isObj(s)) return;
      const props = isObj(s['properties']) ? s['properties'] : {};
      for (const k of Array.isArray(s['required']) ? s['required'].map(String) : []) if (!Object.hasOwn(props, k)) undeclared.push(`${at}: ${k}`);
      for (const [k, v] of Object.entries(props)) walk(v, `${at}/properties/${k}`);
      if (s['items'] !== undefined) walk(s['items'], `${at}/items`);
      if (isObj(s['additionalProperties'])) walk(s['additionalProperties'], `${at}/additionalProperties`);
      for (const key of ['allOf', 'anyOf', 'oneOf']) (Array.isArray(s[key]) ? s[key] as unknown[] : []).forEach((x, i) => walk(x, `${at}/${key}/${i}`));
      if (s['not'] !== undefined) walk(s['not'], `${at}/not`);
    };
    for (const intent of ENVELOPE_INTENTS) for (const relaySigned of [false, true]) walk(payloadSchema(intent, { relaySigned }), `${intent}${relaySigned ? ' relay-signed' : ''} #`);
    expect(undeclared).toEqual([]);
    // The change that must carry one of the three still reads that way, to the summary and to a check.
    expect(obj(SCHEMA, 'the schema')['anyOf']).toEqual(['entries', 'taskKinds', 'podPolicy'].map((k) => ({ properties: { [k]: true }, required: [k] })));
    expect(schemaErrors(SCHEMA, bridge().payload({}))).toEqual(['$: matches none of anyOf']);
    expect(schemaErrors(SCHEMA, bridge().payload({ podPolicy: null }))).toEqual([]);
  });

  it('the affordance\'s one-line summary names each entry shape with its fields, none of a shape\'s required fields marked optional, and the pod policy\'s fields', () => {
    const line = payloadSummary('wrd:update-registry');
    expect(line).toContain('entries?: [PersonEntry|AgentEntry|RemovalEntry]');
    expect(line).toContain('with at least one of entries, taskKinds, podPolicy');
    expect(line).toContain('PersonEntry = {address, roles: [approver|operator|worker], label, softwareAgent: false, personRef}');
    expect(line).toContain('AgentEntry = {address, roles: ["agent"], label, softwareAgent: true, principal, model}');
    expect(line).toContain('RemovalEntry = {address, roles: []}');
    expect(line).toContain(`podPolicy?: {maxLevel?: ${ALLOCATION_LEVELS.join('|')}, floor?: number, minSamples?: integer, minHumanConfirmations?: integer, minDistinctConfirmers?: integer}|null`);
  });
});
