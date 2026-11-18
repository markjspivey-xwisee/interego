/**
 * A general guest's learning record is confidential at rest (src/guest-learning-record.ts).
 *
 * WHY. The storage gate serves pod reads with no sign-in, so whoever has a guest's id can fetch
 * the document the bridge keeps for that guest. It was plain JSON. It is now the substrate's
 * multi-recipient envelope: nothing of the record is in the clear, the bridge opens it with a key
 * derived for that one guest, and the guest's own admitted browser tabs are recipients too.
 *
 * These tests hold who can open it and who cannot, that the bridge still reads and appends across
 * a restart, and that nothing is ever written in the clear.
 *
 * Everything here is synthetic.
 */
import { describe, it, expect } from 'vitest';
import { createEncryptedEnvelope, generateKeyPair, openEncryptedEnvelope, type EncryptedEnvelope } from '@interego/core';
import {
  GUEST_RECORD_KIND, GUEST_RECORD_MAX_TAB_RECIPIENTS, GUEST_RECORD_PATH, GUEST_RECORD_SEALED_KIND,
  GuestLearningRecordStore, GuestPodError, guestRecordSealKey, guestRecordSealSecret, isTabRecordKey,
  type GuestRecordFetch, type GuestRecordOwner,
} from '../src/guest-learning-record.js';

const TENANT = 'https://pods.example/foxxi/';
const HOST = 'identity.example';
const owner = (hex: string): GuestRecordOwner => {
  const userId = 'u-try-guest-' + hex.repeat(32 / hex.length);
  return { userId, guestDid: `did:web:${HOST}:users:${userId}`, podUrl: `https://pods.example/${userId}/` };
};
const OWNER = owner('0a1b2c3d');
const OTHER = owner('f');
const URL_OF = (o: GuestRecordOwner): string => `${o.podUrl}${GUEST_RECORD_PATH}`;
/** Synthetic sealing secrets: 64 hex characters that are nobody's key. */
const SECRET = '5ea1'.repeat(16);
const ANOTHER_SECRET = 'd00d'.repeat(16);

/** A pod that keeps what it is PUT. `docs` is everything a reader at the gate could fetch. */
function pod(): { fetch: GuestRecordFetch; docs: Map<string, string>; puts: string[] } {
  const docs = new Map<string, string>(), puts: string[] = [];
  const fetch: GuestRecordFetch = async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET') { const doc = docs.get(url); return { ok: doc !== undefined, status: doc !== undefined ? 200 : 404, text: async () => doc ?? '' }; }
    docs.set(url, init?.body ?? ''); puts.push(init?.body ?? '');
    return { ok: true, status: 201, text: async () => '' };
  };
  return { fetch, docs, puts };
}
const store = (fetch: GuestRecordFetch, tabKeys?: (o: GuestRecordOwner) => readonly string[], sealSecret = SECRET): GuestLearningRecordStore =>
  new GuestLearningRecordStore({ tenantPodUrl: TENANT, identityHost: HOST, sealSecret, fetch, ...(tabKeys ? { tabKeys } : {}), now: () => Date.parse('2031-03-04T09:00:00Z') });
/** A statement whose words would be recognised anywhere they appeared in the clear. */
const statement = (id: string): Record<string, unknown> => ({
  id, verb: { id: 'http://adlnet.gov/expapi/verbs/answered' }, object: { id: 'urn:example:tide-tables:question-3' },
  result: { response: 'the-spring-tide-follows-the-new-moon', success: true },
});
const unreadable = async (work: Promise<unknown>): Promise<string> => {
  try { await work; } catch (error) { if (error instanceof GuestPodError) return error.code; throw error; }
  throw new Error('expected a refusal');
};
const envelopeOf = (text: string): EncryptedEnvelope => (JSON.parse(text) as { envelope: EncryptedEnvelope }).envelope;

describe('what a reader at the gate gets', () => {
  it('ciphertext: none of the record is in the clear, not its words, its subject, its count or its own time', async () => {
    const p = pod();
    await store(p.fetch).append(OWNER, [statement('s-1'), statement('s-2')]);
    const fetched = p.docs.get(URL_OF(OWNER))!;
    for (const clear of ['the-spring-tide-follows-the-new-moon', 'tide-tables', 'answered', 's-1', OWNER.guestDid, OWNER.userId, GUEST_RECORD_KIND + '"', 'statements', 'updatedAt', '2031-03-04']) {
      expect(fetched.includes(clear), clear).toBe(false);
    }
    const doc = JSON.parse(fetched) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['envelope', 'kind', 'version']);
    expect(doc['kind']).toBe(GUEST_RECORD_SEALED_KIND);
    expect(envelopeOf(fetched).algorithm).toBe('X25519-XSalsa20-Poly1305');
    // What the envelope does show, and no more: when it was last sealed, how large it is, and its recipients' public keys.
    expect(Object.keys(envelopeOf(fetched).content).sort()).toEqual(['algorithm', 'ciphertext', 'encryptedAt', 'nonce']);
  });

  it('every write is sealed: nothing the store ever sent holds the record in the clear', async () => {
    const p = pod(), s = store(p.fetch);
    for (let i = 0; i < 5; i++) await s.append(OWNER, [statement(`s-${i}`)]);
    expect(p.puts).toHaveLength(5);
    for (const sent of p.puts) {
      expect(sent.includes('the-spring-tide-follows-the-new-moon')).toBe(false);
      expect((JSON.parse(sent) as { kind: string }).kind).toBe(GUEST_RECORD_SEALED_KIND);
    }
  });

  it('having the guest\'s id, the document and every public key in it opens nothing', async () => {
    const p = pod();
    await store(p.fetch).append(OWNER, [statement('s-1')]);
    const envelope = envelopeOf(p.docs.get(URL_OF(OWNER))!);
    // A stranger's own key; a key made from the guest's id; the public keys the envelope itself names.
    const stranger = generateKeyPair();
    expect(openEncryptedEnvelope(envelope, stranger)).toBeNull();
    for (const named of envelope.wrappedKeys) {
      expect(openEncryptedEnvelope(envelope, { ...stranger, publicKey: named.recipientPublicKey })).toBeNull();
    }
    // The bridge's key for ANOTHER guest, and a key derived from another bridge's secret for this one.
    expect(openEncryptedEnvelope(envelope, guestRecordSealKey(SECRET, OTHER.guestDid))).toBeNull();
    expect(openEncryptedEnvelope(envelope, guestRecordSealKey(ANOTHER_SECRET, OWNER.guestDid))).toBeNull();
  });
});

describe('the bridge still reads and appends', () => {
  it('within a session, and after a restart: the key is derived, not kept', async () => {
    const p = pod();
    expect(await store(p.fetch).append(OWNER, [statement('s-1')])).toEqual(['s-1']);
    // A new process: a new store over the same pod, holding only the same secret.
    const restarted = store(p.fetch);
    expect((await restarted.read(OWNER)).statements.map(x => x['id'])).toEqual(['s-1']);
    await restarted.append(OWNER, [statement('s-2')]);
    const kept = await store(p.fetch).read(OWNER);
    expect(kept).toMatchObject({ kind: GUEST_RECORD_KIND, version: 1, subject: OWNER.guestDid });
    expect(kept.statements.map(x => x['id'])).toEqual(['s-1', 's-2']);
    expect((kept.statements[0] as { result: { response: string } }).result.response).toBe('the-spring-tide-follows-the-new-moon');
  });

  it('each guest has a key of its own: one guest\'s document is not another\'s record', async () => {
    const p = pod(), s = store(p.fetch);
    await s.append(OWNER, [statement('s-1')]);
    expect(guestRecordSealKey(SECRET, OWNER.guestDid).publicKey).not.toBe(guestRecordSealKey(SECRET, OTHER.guestDid).publicKey);
    // One guest's sealed document placed on another guest's pod is not read as that guest's record.
    p.docs.set(URL_OF(OTHER), p.docs.get(URL_OF(OWNER))!);
    expect(await unreadable(s.read(OTHER))).toBe('general_guest_record_unreadable');
    expect(await unreadable(s.append(OTHER, [statement('s-9')]))).toBe('general_guest_record_unreadable');
    expect(p.puts).toHaveLength(1);
  });

  it('a bridge with another secret cannot read it, and does not write over it', async () => {
    const p = pod();
    await store(p.fetch).append(OWNER, [statement('s-1')]);
    const other = store(p.fetch, undefined, ANOTHER_SECRET);
    expect(await unreadable(other.read(OWNER))).toBe('general_guest_record_unreadable');
    expect(await unreadable(other.append(OWNER, [statement('s-2')]))).toBe('general_guest_record_unreadable');
    expect(p.puts).toHaveLength(1);
  });
});

describe('what is on the pod and is not the bridge\'s sealed record', () => {
  it('a plain document, even one shaped exactly as the record: neither read nor written over', async () => {
    const p = pod(), s = store(p.fetch);
    const plain = JSON.stringify({ kind: GUEST_RECORD_KIND, version: 1, subject: OWNER.guestDid, updatedAt: '2026-11-18T08:00:00.000Z', statements: [statement('planted')] });
    for (const planted of [plain, 'not json', '[]', JSON.stringify({ kind: GUEST_RECORD_SEALED_KIND, version: 1 }), JSON.stringify({ kind: GUEST_RECORD_SEALED_KIND, version: 1, envelope: { content: {}, wrappedKeys: [] } })]) {
      p.docs.set(URL_OF(OWNER), planted);
      expect(await unreadable(s.read(OWNER))).toBe('general_guest_record_unreadable');
      expect(await unreadable(s.append(OWNER, [statement('s-1')]))).toBe('general_guest_record_unreadable');
    }
    expect(p.puts).toEqual([]);
  });

  it('a record someone else sealed TO the bridge\'s public key is not the bridge\'s', async () => {
    const p = pod(), s = store(p.fetch);
    // The bridge's public key for a guest is in every document it writes, so anyone can seal to it.
    const bridgeKey = guestRecordSealKey(SECRET, OWNER.guestDid).publicKey;
    const forger = generateKeyPair();
    const forged = JSON.stringify({ kind: GUEST_RECORD_KIND, version: 1, subject: OWNER.guestDid, updatedAt: 'x', statements: [statement('forged')] });
    p.docs.set(URL_OF(OWNER), JSON.stringify({ kind: GUEST_RECORD_SEALED_KIND, version: 1, envelope: createEncryptedEnvelope(forged, [bridgeKey], forger) }));
    expect(await unreadable(s.read(OWNER))).toBe('general_guest_record_unreadable');
    expect(p.puts).toEqual([]);
  });
});

describe('the guest\'s own tab is a recipient', () => {
  it('a tab whose key is admitted opens the document from the pod itself, and can tell the bridge sealed it', async () => {
    const p = pod(), tab = generateKeyPair();
    const s = store(p.fetch, o => (o.userId === OWNER.userId ? [tab.publicKey] : []));
    await s.append(OWNER, [statement('s-1')]);
    const envelope = envelopeOf(p.docs.get(URL_OF(OWNER))!);
    const opened = JSON.parse(openEncryptedEnvelope(envelope, tab)!) as { subject: string; statements: Array<{ id: string }> };
    expect(opened.subject).toBe(OWNER.guestDid);
    expect(opened.statements.map(x => x.id)).toEqual(['s-1']);
    // The wrapped key made for the tab names the bridge's key for this guest as its sender.
    const mine = envelope.wrappedKeys.find(w => w.recipientPublicKey === tab.publicKey)!;
    expect(mine.senderPublicKey).toBe(s.sealedBy(OWNER));
    expect(s.addressOf(OWNER)).toBe(URL_OF(OWNER));
  });

  it('recipients are the tabs admitted at each write: a tab that left is not sealed for again, another guest\'s tab never is', async () => {
    const p = pod(), first = generateKeyPair(), second = generateKeyPair(), strangerTab = generateKeyPair();
    let admitted: string[] = [first.publicKey];
    const s = store(p.fetch, o => (o.userId === OWNER.userId ? admitted : [strangerTab.publicKey]));
    await s.append(OWNER, [statement('s-1')]);
    admitted = [second.publicKey];
    await s.append(OWNER, [statement('s-2')]);
    const latest = envelopeOf(p.docs.get(URL_OF(OWNER))!);
    expect(openEncryptedEnvelope(latest, second)).not.toBeNull();
    expect(openEncryptedEnvelope(latest, first)).toBeNull();
    expect(openEncryptedEnvelope(latest, strangerTab)).toBeNull();
    // The version the first tab was sealed for stays openable by it: it was that guest's own tab.
    expect(openEncryptedEnvelope(envelopeOf(p.puts[0]!), first)).not.toBeNull();
  });

  it('with no tab admitted, the bridge alone is a recipient', async () => {
    const p = pod(), s = store(p.fetch);
    await s.append(OWNER, [statement('s-1')]);
    const envelope = envelopeOf(p.docs.get(URL_OF(OWNER))!);
    expect(envelope.wrappedKeys.map(w => w.recipientPublicKey)).toEqual([s.sealedBy(OWNER)]);
  });

  it('at most a few tabs, each once, and never a key that is not a usable one', async () => {
    const p = pod(), tabs = Array.from({ length: GUEST_RECORD_MAX_TAB_RECIPIENTS + 3 }, () => generateKeyPair().publicKey);
    const zero = Buffer.alloc(32).toString('base64'), one = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString('base64');
    const s = store(p.fetch, () => [zero, one, 'not-a-key', tabs[0]!, ...tabs]);
    await s.append(OWNER, [statement('s-1')]);
    const recipients = envelopeOf(p.docs.get(URL_OF(OWNER))!).wrappedKeys.map(w => w.recipientPublicKey);
    expect(recipients).toEqual([s.sealedBy(OWNER), ...tabs.slice(-GUEST_RECORD_MAX_TAB_RECIPIENTS)]);
  });

  it('a tab list that cannot be read costs the tabs their copy, never the write or its sealing', async () => {
    const p = pod(), s = store(p.fetch, () => { throw new Error('no admissions table'); });
    expect(await s.append(OWNER, [statement('s-1')])).toEqual(['s-1']);
    expect((JSON.parse(p.puts[0]!) as { kind: string }).kind).toBe(GUEST_RECORD_SEALED_KIND);
    expect((await s.read(OWNER)).statements).toHaveLength(1);
  });
});

describe('a tab\'s record key', () => {
  it('is a 32-byte X25519 public key in canonical base64', () => {
    expect(isTabRecordKey(generateKeyPair().publicKey)).toBe(true);
    for (const bad of [undefined, null, 7, '', 'AAAA', generateKeyPair().publicKey.slice(0, 40), generateKeyPair().publicKey + 'A', Buffer.alloc(31, 5).toString('base64'), Buffer.alloc(33, 5).toString('base64'), generateKeyPair().publicKey.replace(/=$/, '-')]) {
      expect(isTabRecordKey(bad), String(bad)).toBe(false);
    }
  });

  it('is never a point of small order: a key wrapped for one is wrapped for everybody', () => {
    const zero = Buffer.alloc(32), one = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
    // The order-8 point every X25519 text lists (e0eb7a7c…b800), in the bytes it is written with.
    const low = Buffer.from('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', 'hex');
    for (const point of [zero, one, low]) expect(isTabRecordKey(point.toString('base64')), point.toString('hex')).toBe(false);
  });
});

describe('the bridge\'s sealing secret', () => {
  it('is the bridge\'s own private key when it is one, else the hash of its wallet seed, else there is none', () => {
    expect(guestRecordSealSecret({ FOXXI_BRIDGE_PRIVATE_KEY: '0x' + SECRET.toUpperCase() })).toBe(SECRET);
    expect(guestRecordSealSecret({ FOXXI_BRIDGE_PRIVATE_KEY: SECRET, FOXXI_WALLET_SEED: 'a synthetic seed' })).toBe(SECRET);
    const fromSeed = guestRecordSealSecret({ FOXXI_BRIDGE_PRIVATE_KEY: 'not hex', FOXXI_WALLET_SEED: 'a synthetic seed' });
    expect(fromSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(guestRecordSealSecret({ FOXXI_WALLET_SEED: 'a synthetic seed' })).toBe(fromSeed);
    expect(guestRecordSealSecret({ FOXXI_ISSUER_KEY_SEED: 'another synthetic seed' })).not.toBe(fromSeed);
    expect(guestRecordSealSecret({})).toBeUndefined();
    expect(guestRecordSealSecret({ FOXXI_BRIDGE_PRIVATE_KEY: '' })).toBeUndefined();
  });

  it('a store with nothing to seal with is not built, so it can write nothing in the clear', () => {
    const p = pod();
    for (const bad of ['', 'short', SECRET.toUpperCase(), '0x' + SECRET]) expect(() => store(p.fetch, undefined, bad), bad).toThrow();
    expect(() => guestRecordSealKey('', OWNER.guestDid)).toThrow();
  });

  it('the same secret and guest give the same key in any process; nothing is random', () => {
    expect(guestRecordSealKey(SECRET, OWNER.guestDid)).toEqual(guestRecordSealKey(SECRET, OWNER.guestDid));
  });
});
