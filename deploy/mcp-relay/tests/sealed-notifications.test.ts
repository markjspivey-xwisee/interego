#!/usr/bin/env tsx
/**
 * A notification is stored sealed, and read back only by a reader that holds a key for it.
 *
 * The store serves reads to anybody, so what sits in an inbox has to be ciphertext. These checks
 * drive the module's own functions against an in-memory store with keys made here. They do not
 * boot the relay and they send nothing anywhere, so they show nothing about a deployed one.
 */

import { generateKeyPair, openEncryptedEnvelope, type EncryptedEnvelope, type FetchFn } from '@interego/core';
import {
  SEALED_OBJECT_TYPE, SEALED_UNOPENED_SUMMARY, buildNotification, deliverNotification, inboxItemFrom,
  readAllInboxItems, sealNotification, sealedEnvelopeOf, unsealedNotification,
} from '../agent-mesh.js';
import { openManagedEnvelope } from '../managed-recipient.js';

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const POD = 'http://store.test/u-pk-aaaaaaaaaaaa/';
const SECRET_SUMMARY = 'Quarterly numbers attached';
const SECRET_BODY = 'The body nobody else should read: 4417.';
const SENDER = 'did:web:identity.test:agents:claude-u-pk-bbbbbbbbbbbb';

/** An in-memory store: PUT keeps the body, GET returns it, the inbox container lists members. */
function store() {
  const docs = new Map<string, string>();
  const fetchFn = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const res = (status: number, body = '') => ({
      ok: status >= 200 && status < 300, status, statusText: String(status),
      headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body),
    });
    if (method === 'HEAD') return res(200);
    if (method === 'PUT') { docs.set(url, String(init?.body ?? '')); return res(201); }
    if (url === `${POD}inbox/`) {
      const members = [...docs.keys()].map((u) => `<${u}>`).join(', ');
      return res(200, members ? `<${url}> <http://www.w3.org/ns/ldp#contains> ${members} .` : `<${url}> a <http://www.w3.org/ns/ldp#Container> .`);
    }
    return docs.has(url) ? res(200, docs.get(url)!) : res(404);
  }) as unknown as FetchFn;
  return { docs, fetchFn };
}

const notification = (slug: string) => buildNotification({
  from: SENDER, to: 'did:web:identity.test:agents:chatgpt-u-pk-aaaaaaaaaaaa', type: 'Question',
  summary: SECRET_SUMMARY, content: SECRET_BODY, about: 'https://example.test/pull/7',
  inReplyTo: 'http://store.test/x/inbox/1.jsonld', published: '2026-11-19T06:00:00.000Z',
}, slug);

async function main(): Promise<void> {
  const relay = generateKeyPair();
  const ownKey = generateKeyPair();
  const stranger = generateKeyPair();
  const seal = (n: Readonly<Record<string, unknown>>) => sealNotification(n, [relay.publicKey, ownKey.publicKey], relay);
  const opener = (key: typeof relay) => (envelope: EncryptedEnvelope) => openEncryptedEnvelope(envelope, key);

  console.log('what is stored');
  const s = store();
  const url = await deliverNotification(POD, notification('a'), 'a', s.fetchFn, () => {}, undefined, seal);
  const raw = s.docs.get(url!)!;
  ok(url === `${POD}inbox/a.jsonld`, '★ a sealed notification is delivered to the inbox');
  ok(![SECRET_SUMMARY, SECRET_BODY, '4417', SENDER, 'Question', 'example.test/pull/7', 'inbox/1.jsonld'].some((t) => raw.includes(t)),
    '★ the stored bytes carry no sender, activity type, summary, body, subject or reply target');
  const doc = JSON.parse(raw) as Record<string, unknown>;
  ok(doc['id'] === url && doc['published'] === '2026-11-19T06:00:00.000Z' && Array.isArray(doc['to']) && doc['type'] === 'Create',
    'the outside keeps only its own URL, the recipient, the time and a fixed type');
  ok((doc['object'] as Record<string, unknown>)['type'] === SEALED_OBJECT_TYPE && doc['iep:encrypted'] === true
    && Object.keys(doc).sort().join(',') === '@context,id,iep:encrypted,object,published,to,type',
    'and says, in the existing vocabulary, that its object is an encrypted value');
  ok(sealedEnvelopeOf(doc)?.wrappedKeys.length === 2, 'the envelope is wrapped once per recipient');

  console.log('who can read it');
  const mine = await readAllInboxItems(POD, s.fetchFn, opener(relay));
  ok(mine.length === 1 && mine[0]!.summary === SECRET_SUMMARY && mine[0]!.content === SECRET_BODY
    && mine[0]!.actor === SENDER && mine[0]!.type === 'Question' && mine[0]!.about === 'https://example.test/pull/7',
    '★ a reader with the relay key reads it as it was sent');
  ok((await readAllInboxItems(POD, s.fetchFn, opener(ownKey)))[0]!.content === SECRET_BODY,
    '★ a recipient holding its own registered key reads it without the relay key');
  for (const [who, open] of [['a stranger\'s key', opener(stranger)], ['no opener at all', undefined], ['an opener that throws', () => { throw new Error('x'); }]] as const) {
    const got = await readAllInboxItems(POD, s.fetchFn, open as never);
    ok(got.length === 1 && got[0]!.summary === SEALED_UNOPENED_SUMMARY && got[0]!.content === undefined && got[0]!.actor === undefined
      && got[0]!.published === '2026-11-19T06:00:00.000Z' && got[0]!.url === url,
      `★ with ${who} it is listed as unopened, with no body and no sender`);
  }

  console.log('whom the relay opens it for');
  // The rule the relay applies to its OWN key, from managed-recipient.ts and relay-key-gate.ts:
  // the same functions read_inbox's opener calls. Sealed to the relay key alone here, so nothing
  // but that rule decides.
  const k = store();
  const kUrl = await deliverNotification(POD, notification('k'), 'k', k.fetchFn, () => {}, undefined,
    (n) => sealNotification(n, [relay.publicKey], relay));
  const contextFor = (ownPodUrl: string | undefined) => ({
    root: relay, ownPodUrl, identityUrl: 'https://identity.test', storeOrigins: new Set(['http://store.test']),
  });
  const asOwner = await readAllInboxItems(POD, k.fetchFn, (e, u) => openManagedEnvelope(contextFor(POD), e, u));
  ok(asOwner[0]?.url === kUrl && asOwner[0]?.content === SECRET_BODY, '★ the relay opens it for the authenticated owner of that pod');
  for (const [who, own] of [['another user of the same relay', 'http://store.test/u-pk-cccccccccccc/'], ['a caller with no pod', undefined]] as const) {
    const got = await readAllInboxItems(POD, k.fetchFn, (e, u) => openManagedEnvelope(contextFor(own), e, u));
    ok(got[0]?.summary === SEALED_UNOPENED_SUMMARY && got[0]?.content === undefined,
      `★ and not for ${who}, though the relay holds the key`);
  }

  console.log('what a seal may not do');
  const unsealedTo = store();
  const refused = await deliverNotification(POD, notification('b'), 'b', unsealedTo.fetchFn, () => {}, undefined,
    (n) => sealNotification(n, [], relay));
  ok(refused === null && unsealedTo.docs.size === 0, '★ a notification that cannot be sealed is not written in the clear instead');
  const forged = unsealedNotification({ id: url, to: ['x'], published: '2026-11-19T06:00:00.000Z' },
    JSON.stringify({ id: 'http://elsewhere.test/1', published: '1999-01-01T00:00:00.000Z', type: 'Offer', actor: SENDER, summary: 's', object: {} }));
  ok(forged['id'] === url && forged['published'] === '2026-11-19T06:00:00.000Z',
    '★ what was sealed cannot rename the resource it is in or move itself in time');
  ok(unsealedNotification({ id: url }, 'not json')['summary'] === SEALED_UNOPENED_SUMMARY
    && unsealedNotification({ id: url }, '[1]')['summary'] === SEALED_UNOPENED_SUMMARY,
    'plaintext that is not an object reads as unopened');

  console.log('what was there before');
  const old = store();
  await deliverNotification(POD, notification('c'), 'c', old.fetchFn);
  const plain = await readAllInboxItems(POD, old.fetchFn, opener(stranger));
  ok(plain.length === 1 && plain[0]!.content === SECRET_BODY && sealedEnvelopeOf(JSON.parse(old.docs.get(`${POD}inbox/c.jsonld`)!)) === null,
    'a notification stored before sealing still reads, and is not mistaken for a sealed one');
  ok(sealedEnvelopeOf({ object: { type: SEALED_OBJECT_TYPE, 'iep:envelope': '!!!' } }) === null
    && sealedEnvelopeOf({ object: { type: 'Note', 'iep:envelope': 'e30=' } }) === null
    && inboxItemFrom(url!, { object: { type: SEALED_OBJECT_TYPE } })?.content === undefined,
    'an object that only looks sealed is not opened');

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
