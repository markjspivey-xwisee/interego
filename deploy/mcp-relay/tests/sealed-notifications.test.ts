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
import { currentRegistryKeys, inboxRecipientKey, openInboxEnvelope, openManagedEnvelope } from '../managed-recipient.js';

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
    if (url.endsWith('/inbox/')) {
      const members = [...docs.keys()].filter((u) => u.startsWith(url)).map((u) => `<${u}>`).join(', ');
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
  // The relay's own rule, from managed-recipient.ts: the same function read_inbox's opener calls.
  // Sealed to the POD's inbox key alone here, so nothing but that rule decides.
  const ORIGINS = new Set(['http://store.test']);
  const VICTIM_POD = 'u-pk-aaaaaaaaaaaa';
  const ATTACKER = 'http://store.test/u-pk-cccccccccccc/';
  const podKey = inboxRecipientKey(relay, VICTIM_POD);
  const k = store();
  const kUrl = await deliverNotification(POD, notification('k'), 'k', k.fetchFn, () => {}, undefined,
    (n) => sealNotification(n, [podKey.publicKey], relay));
  const readAs = (inboxOf: string, ownPodUrl: string | undefined) => readAllInboxItems(inboxOf, k.fetchFn,
    (e, u) => openInboxEnvelope({ root: relay, ownPodUrl, storeOrigins: ORIGINS }, e, u));
  const asOwner = await readAs(POD, POD);
  ok(asOwner[0]?.url === kUrl && asOwner[0]?.content === SECRET_BODY, '★ the relay opens it for the authenticated owner of that pod');
  for (const [who, own] of [['another user of the same relay', ATTACKER], ['a caller with no pod', undefined], ['a caller whose pod is on another store', 'http://elsewhere.test/u-pk-aaaaaaaaaaaa/']] as const) {
    const got = await readAs(POD, own);
    ok(got[0]?.summary === SEALED_UNOPENED_SUMMARY && got[0]?.content === undefined,
      `★ and not for ${who}, though the relay holds the root key`);
  }
  ok(inboxRecipientKey(relay, VICTIM_POD).publicKey === podKey.publicKey
    && inboxRecipientKey(relay, 'u-pk-cccccccccccc').publicKey !== podKey.publicKey
    && podKey.publicKey !== relay.publicKey,
    'a pod\'s inbox key is stable, is its own, and is not the relay\'s one key');

  console.log('a copy does not open');
  // ★★ THE DEFECT FOUND IN REVIEW, REPRODUCED. The first version sealed to the relay's one key
  // and let the URL an envelope was fetched from decide who it was opened for. An envelope does
  // not know where it is stored: a user copied another's sealed notification into their own
  // inbox, rewrote the outside to match, and the relay read it back to them.
  const stolen = JSON.parse(k.docs.get(kUrl!)!) as Record<string, unknown>;
  const copyUrl = `${ATTACKER}inbox/k.jsonld`;
  k.docs.set(copyUrl, JSON.stringify({ ...stolen, id: copyUrl, to: ['did:web:identity.test:agents:x-u-pk-cccccccccccc'] }));
  const copied = await readAs(ATTACKER, ATTACKER);
  ok(copied.length === 1 && copied[0]!.summary === SEALED_UNOPENED_SUMMARY && copied[0]!.content === undefined && copied[0]!.actor === undefined,
    '★★ a sealed notification copied into another user\'s inbox does not open for that user');
  ok(openManagedEnvelope({ root: relay, ownPodUrl: ATTACKER, identityUrl: 'https://identity.test', storeOrigins: ORIGINS },
    sealedEnvelopeOf(stolen)!, copyUrl) === null
    && openEncryptedEnvelope(sealedEnvelopeOf(stolen)!, relay) === null,
    '★★ and not through the relay\'s one key either: the envelope was never wrapped to it');
  // The version that WAS vulnerable, kept as the control: sealed to the relay's one key, the same
  // copy opens under the old rule. So the two checks above are measuring the fix.
  const fleetSealed = sealNotification({ ...notification('v'), id: `${POD}inbox/v.jsonld` }, [relay.publicKey], relay);
  ok(openManagedEnvelope({ root: relay, ownPodUrl: ATTACKER, identityUrl: 'https://identity.test', storeOrigins: ORIGINS },
    sealedEnvelopeOf(fleetSealed)!, `${ATTACKER}inbox/v.jsonld`) !== null,
    'control: an envelope wrapped to the relay\'s one key does open for whoever holds the copy');
  // Moved or renamed inside the owner's own pod: the key opens it, the sealed id does not match.
  k.docs.set(`${POD}inbox/renamed.jsonld`, JSON.stringify({ ...stolen, id: `${POD}inbox/renamed.jsonld` }));
  const renamed = (await readAs(POD, POD)).find((i) => i.url.endsWith('renamed.jsonld'));
  ok(renamed?.summary === SEALED_UNOPENED_SUMMARY && renamed?.content === undefined,
    '★ a sealed notification renamed inside its own pod reads as unopened');
  ok(openInboxEnvelope({ root: relay, ownPodUrl: POD, storeOrigins: ORIGINS }, sealedEnvelopeOf(stolen)!, `${POD}context-graphs/k.jsonld`) === null
    && openInboxEnvelope({ root: relay, ownPodUrl: POD, storeOrigins: ORIGINS }, sealedEnvelopeOf(stolen)!, `${POD}inbox/sub/k.jsonld`) === null,
    'the pod key opens only what was fetched from that pod\'s inbox');

  console.log('what a seal may not do');
  const unsealedTo = store();
  const refused = await deliverNotification(POD, notification('b'), 'b', unsealedTo.fetchFn, () => {}, undefined,
    (n) => sealNotification(n, [], relay));
  ok(refused === null && unsealedTo.docs.size === 0, '★ a notification that cannot be sealed is not written in the clear instead');
  const forged = unsealedNotification({ id: url, to: ['x'], published: '2026-11-19T06:00:00.000Z' },
    JSON.stringify({ id: 'http://elsewhere.test/1', published: '1999-01-01T00:00:00.000Z', type: 'Offer', actor: SENDER, summary: 's', object: {} }));
  ok(unsealedNotification({ id: url }, JSON.stringify({ id: 'http://elsewhere.test/x/1.jsonld', summary: 's' }), url!)['summary'] === SEALED_UNOPENED_SUMMARY
    && unsealedNotification({ id: url }, JSON.stringify({ summary: 's' }), url!)['summary'] === SEALED_UNOPENED_SUMMARY
    && unsealedNotification({ id: url }, JSON.stringify({ id: url!.replace('http://store.test', 'https://public.test'), summary: 's' }), url!)['summary'] === 's',
    '★ what was sealed for another resource, or for none, reads as unopened; another spelling of the store does not matter');
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

  console.log('which registry keys are recipients');
  // ★★ THE SECOND DEFECT FOUND IN REVIEW, REPRODUCED. The seal asked only whether a registry row
  // was revoked, so a delegation that ended in 2021 and one not due to begin until 2099 both had
  // new notifications wrapped to their keys, and both keys opened them.
  const NOW = new Date('2026-11-19T12:00:00.000Z');
  const current = generateKeyPair();
  const expired = generateKeyPair();
  const future = generateKeyPair();
  const revoked = generateKeyPair();
  const undated = generateKeyPair();
  const garbled = generateKeyPair();
  const openEnded = generateKeyPair();
  const rows = [
    { encryptionPublicKey: current.publicKey, validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z' },
    { encryptionPublicKey: openEnded.publicKey, validFrom: '2026-01-01T00:00:00.000Z' },
    { encryptionPublicKey: expired.publicKey, validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2021-01-01T00:00:00.000Z' },
    { encryptionPublicKey: future.publicKey, validFrom: '2099-01-01T00:00:00.000Z' },
    { encryptionPublicKey: revoked.publicKey, validFrom: '2026-01-01T00:00:00.000Z', revoked: true },
    { encryptionPublicKey: undated.publicKey },
    { encryptionPublicKey: garbled.publicKey, validFrom: '2026-01-01T00:00:00.000Z', validUntil: 'next spring' },
    { encryptionPublicKey: relay.publicKey, validFrom: '2026-01-01T00:00:00.000Z' },
    { validFrom: '2026-01-01T00:00:00.000Z' },
    { encryptionPublicKey: current.publicKey, validFrom: '2026-06-01T00:00:00.000Z' },
  ];
  const chosen = currentRegistryKeys(rows, NOW, relay.publicKey);
  ok(chosen.length === 2 && chosen.includes(current.publicKey) && chosen.includes(openEnded.publicKey),
    '★★ only rows in force now are recipients: unrevoked, begun, not ended, and each key once',
    JSON.stringify(chosen.length));
  const sealedNow = sealNotification({ ...notification('r'), id: `${POD}inbox/r.jsonld` }, [podKey.publicKey, ...chosen], relay);
  const env = sealedEnvelopeOf(sealedNow)!;
  ok(openEncryptedEnvelope(env, current) !== null && openEncryptedEnvelope(env, openEnded) !== null,
    'a current key and an open-ended current key open what is sealed now');
  for (const [who, key] of [['an expired', expired], ['a not-yet-valid', future], ['a revoked', revoked], ['an undated', undated], ['an unreadably dated', garbled]] as const) {
    ok(openEncryptedEnvelope(env, key) === null, `★★ ${who} row's key does not open what is sealed now`);
  }
  ok(openEncryptedEnvelope(env, relay) === null, 'and the fleet key is not a recipient even when a row lists it');
  const one = [rows[0]!];
  ok(currentRegistryKeys(one, new Date('2026-01-01T00:00:00.000Z'), relay.publicKey).includes(current.publicKey)
    && !currentRegistryKeys(one, new Date('2027-01-01T00:00:00.000Z'), relay.publicKey).includes(current.publicKey)
    && !currentRegistryKeys(one, new Date('2025-12-31T23:59:59.999Z'), relay.publicKey).includes(current.publicKey),
    'a row is in force from its start and stops at its end, not after it');
  // Control: the rule this replaces — unrevoked and keyed — admits the expired and future rows.
  const before = rows.filter((r) => !r.revoked && r.encryptionPublicKey && r.encryptionPublicKey !== relay.publicKey).map((r) => r.encryptionPublicKey);
  ok(before.includes(expired.publicKey) && before.includes(future.publicKey),
    'control: the rule this replaces did choose the expired and the not-yet-valid row');

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
