/**
 * A general guest's records live on the guest's own pod, never the shared tenant pod
 * (src/guest-learning-record.ts, `resolveSubjectPodUrlGuarded` in src/subject-pod-url.ts).
 *
 * WHY. The pod resolver's last resort is the tenant pod. For a wallet that is a fallback nobody
 * should reach; for a guest it would put one visitor's learning record where every other
 * fallback lands. So a guest's DID is resolved with the identity host and then guarded, and the
 * record's address is built from the guest's admission and checked at every read and write.
 *
 * The gate answers an operator write into a guest's pod with 410 once the guest is closed or
 * expired, and with 409, 503, 413 and 507 for its other refusals (deploy/css-gate). These tests
 * hold what the bridge does about each, and that it writes little.
 *
 * Everything here is synthetic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEncryptedEnvelope, type EncryptedEnvelope } from '@interego/core';
import {
  GUEST_RECORD_KIND, GUEST_RECORD_MAX_BYTES, GUEST_RECORD_MAX_SEALED_BYTES, GUEST_RECORD_MAX_WRITES, GUEST_RECORD_PATH, GUEST_RECORD_SEALED_KIND,
  GuestLearningRecordStore, GuestPodError, guestRecordSealKey, guestRecordUrl,
  type GuestRecordFetch, type GuestRecordOwner,
} from '../src/guest-learning-record.js';
import { SubjectPodRefusedError, resolveSubjectPodUrlGuarded, resolveSubjectPodUrlPure } from '../src/subject-pod-url.js';

const TENANT = 'https://pods.example/foxxi/';
const HOST = 'identity.example';
const ID = 'u-try-guest-' + '0a1b2c3d'.repeat(4);
const DID = `did:web:${HOST}:users:${ID}`;
const POD = `https://pods.example/${ID}/`;
const OWNER: GuestRecordOwner = { userId: ID, guestDid: DID, podUrl: POD };
const safeUrl = (raw: string): string | undefined => (raw.startsWith('https://') ? raw : undefined);

/** A pod that keeps what it is PUT, or answers each write with the next of `answers`. */
function pod(answers: number[] = []): { fetch: GuestRecordFetch; calls: Array<{ method: string; url: string; body?: string; headers?: Record<string, string> }>; docs: Map<string, string> } {
  const calls: Array<{ method: string; url: string; body?: string; headers?: Record<string, string> }> = [];
  const docs = new Map<string, string>();
  const fetch: GuestRecordFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body !== undefined ? { body: init.body } : {}), ...(init?.headers ? { headers: init.headers } : {}) });
    if (method === 'GET') {
      const doc = docs.get(url);
      return { ok: doc !== undefined, status: doc !== undefined ? 200 : 404, text: async () => doc ?? '' };
    }
    const status = answers.shift() ?? 201;
    if (status < 300) docs.set(url, init?.body ?? '');
    return { ok: status < 300, status, text: async () => '' };
  };
  return { fetch, calls, docs };
}
/** A synthetic sealing secret: 64 hex characters that are nobody's key. */
const SECRET = '5ea1'.repeat(16);
const store = (fetch: GuestRecordFetch): GuestLearningRecordStore => new GuestLearningRecordStore({ tenantPodUrl: TENANT, identityHost: HOST, sealSecret: SECRET, fetch, now: () => Date.parse('2026-11-17T10:00:00Z') });
/** What the bridge sealed into a document, opened with the bridge's key for this guest. */
const opened = (text: string, did = DID): Record<string, unknown> => {
  const doc = JSON.parse(text) as { kind: string; envelope: EncryptedEnvelope };
  expect(doc.kind).toBe(GUEST_RECORD_SEALED_KIND);
  return JSON.parse(openEncryptedEnvelope(doc.envelope, guestRecordSealKey(SECRET, did))!) as Record<string, unknown>;
};
const statement = (id: string): Record<string, unknown> => ({ id, verb: { id: 'http://adlnet.gov/expapi/verbs/answered' }, object: { id: 'urn:example:lighthouse-keeping:question-1' } });
const refusal = async (work: Promise<unknown>): Promise<GuestPodError> => {
  try { await work; } catch (error) { if (error instanceof GuestPodError) return error; throw error; }
  throw new Error('expected a refusal');
};

describe('the pod resolver, with the guest rule on', () => {
  const base = { tenantPodUrl: TENANT, safeUrl };

  it('a guest of this identity resolves to its own pod', () => {
    expect(resolveSubjectPodUrlGuarded({ ...base, identity: DID, guestIdentityHost: HOST })).toBe(POD);
    expect(resolveSubjectPodUrlGuarded({ ...base, identity: ` ${DID} `, guestIdentityHost: HOST })).toBe(POD);
  });

  it('a guest that would fall through to the tenant pod is refused, not answered', () => {
    const elsewhere = `did:web:identity.elsewhere.example:users:${ID}`;
    // Without the rule this is the tenant pod: the fallback the rule exists to close.
    expect(resolveSubjectPodUrlPure({ ...base, identity: elsewhere })).toBe(TENANT);
    expect(() => resolveSubjectPodUrlGuarded({ ...base, identity: elsewhere, guestIdentityHost: HOST })).toThrow(SubjectPodRefusedError);
    try { resolveSubjectPodUrlGuarded({ ...base, identity: elsewhere, guestIdentityHost: HOST }); } catch (error) {
      expect(error).toMatchObject({ status: 403, reason: 'shared-tenant-pod' });
    }
  });

  it('an explicit pod cannot move a guest to the tenant pod or to another pod', () => {
    expect(() => resolveSubjectPodUrlGuarded({ ...base, identity: DID, explicit: TENANT, guestIdentityHost: HOST })).toThrow(/shared tenant pod/);
    expect(() => resolveSubjectPodUrlGuarded({ ...base, identity: DID, explicit: 'https://pods.example/u-eth-00000000aaaa/', guestIdentityHost: HOST })).toThrow(/not its own/);
    expect(resolveSubjectPodUrlGuarded({ ...base, identity: DID, explicit: POD, guestIdentityHost: HOST })).toBe(POD);
  });

  it('every other identity is resolved as it always was, with the rule on or off', () => {
    for (const identity of ['did:ethr:0x' + 'ab'.repeat(20), '0x' + 'cd'.repeat(20), 'https://relay.example/agents/helper-u-pk-0123456789ab', `did:web:${HOST}:users:u-pk-0123456789ab`, 'someone', '', undefined]) {
      expect(resolveSubjectPodUrlGuarded({ ...base, identity, guestIdentityHost: HOST }), String(identity)).toBe(resolveSubjectPodUrlPure({ ...base, identity }));
    }
  });

  it('with the rule off, a guest resolves exactly as before it existed', () => {
    expect(resolveSubjectPodUrlGuarded({ ...base, identity: DID })).toBe(resolveSubjectPodUrlPure({ ...base, identity: DID }));
    expect(resolveSubjectPodUrlGuarded({ ...base, identity: DID, guestIdentityHost: undefined })).toBe(TENANT);
  });

  it('bridge/server.ts resolves through it, and no longer calls the unguarded resolver', () => {
    const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'server.ts'), 'utf8');
    expect(server).toContain('return resolveSubjectPodUrlGuarded({ tenantPodUrl, identity: didOrWebId, explicit, safeUrl: safePublicUrlOrUndefined, guestIdentityHost });');
    expect(server).toContain('const guestIdentityHost = dashboardGuestIdentityHost(process.env);');
    expect(server.includes('resolveSubjectPodUrlPure(')).toBe(false);
  });
});

describe('where a guest\'s record is', () => {
  it('on the guest\'s own pod, under the tenant pod\'s origin', () => {
    expect(guestRecordUrl(OWNER, TENANT, HOST)).toEqual({ ok: true, url: `${POD}${GUEST_RECORD_PATH}` });
  });

  it('never the tenant pod, another pod, another origin, or a pod for someone who is not a guest', () => {
    expect(guestRecordUrl({ ...OWNER, podUrl: TENANT }, TENANT, HOST)).toEqual({ ok: false, reason: 'shared-tenant-pod' });
    expect(guestRecordUrl({ ...OWNER, podUrl: 'https://pods.example/u-try-guest-' + 'f'.repeat(32) + '/' }, TENANT, HOST)).toEqual({ ok: false, reason: 'not-own-pod' });
    expect(guestRecordUrl({ ...OWNER, podUrl: `https://pods.elsewhere.example/${ID}/` }, TENANT, HOST)).toEqual({ ok: false, reason: 'not-own-pod' });
    expect(guestRecordUrl({ ...OWNER, podUrl: `${POD}deeper/` }, TENANT, HOST)).toEqual({ ok: false, reason: 'not-own-pod' });
    expect(guestRecordUrl({ ...OWNER, podUrl: 'not a url' }, TENANT, HOST)).toEqual({ ok: false, reason: 'pod-unreadable' });
    expect(guestRecordUrl({ userId: 'u-pk-0123456789ab', guestDid: `did:web:${HOST}:users:u-pk-0123456789ab`, podUrl: 'https://pods.example/u-pk-0123456789ab/' }, TENANT, HOST)).toEqual({ ok: false, reason: 'not-a-guest' });
    expect(guestRecordUrl({ ...OWNER, guestDid: `did:web:${HOST}:users:u-try-guest-` + 'e'.repeat(32) }, TENANT, HOST)).toEqual({ ok: false, reason: 'not-a-guest' });
  });

  it('a store asked about a pod that is not the guest\'s own touches nothing', async () => {
    const p = pod();
    const e = await refusal(store(p.fetch).append({ ...OWNER, podUrl: TENANT }, [statement('s-1')]));
    expect(e).toMatchObject({ status: 403, code: 'general_guest_pod_refused' });
    expect((await refusal(store(p.fetch).read({ ...OWNER, podUrl: TENANT }))).code).toBe('general_guest_pod_refused');
    expect(p.calls).toEqual([]);
  });
});

describe('keeping a guest\'s record', () => {
  it('a pod with no record yet reads as an empty one, about the guest', async () => {
    const p = pod();
    expect(await store(p.fetch).read(OWNER)).toEqual({ kind: GUEST_RECORD_KIND, version: 1, subject: DID, updatedAt: '2026-11-17T10:00:00.000Z', statements: [] });
  });

  it('a step is one write of one sealed JSON document to the guest\'s own pod', async () => {
    const p = pod(), s = store(p.fetch);
    expect(await s.append(OWNER, [statement('s-1'), statement('s-2')])).toEqual(['s-1', 's-2']);
    const writes = p.calls.filter(c => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'PUT', url: `${POD}${GUEST_RECORD_PATH}`, headers: { 'Content-Type': 'application/json' } });
    // No credential is attached here: the bridge's own fetch adds the operator bearer to a write on the pod origin.
    expect(Object.keys(writes[0]!.headers ?? {})).toEqual(['Content-Type']);
    expect(p.calls.every(c => c.url === `${POD}${GUEST_RECORD_PATH}`)).toBe(true);
    const doc = opened(p.docs.get(`${POD}${GUEST_RECORD_PATH}`)!);
    expect(doc).toMatchObject({ kind: GUEST_RECORD_KIND, version: 1, subject: DID });
    expect((doc.statements as Array<{ id: string }>).map(x => x.id)).toEqual(['s-1', 's-2']);
    expect((await s.read(OWNER)).statements).toHaveLength(2);
  });

  it('keeping the same step again writes nothing', async () => {
    const p = pod(), s = store(p.fetch);
    await s.append(OWNER, [statement('s-1')]);
    expect(await s.append(OWNER, [statement('s-1')])).toEqual(['s-1']);
    expect(p.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
    expect(s.writesFor(ID)).toBe(1);
  });

  it('two steps at once are kept one after the other, and neither is lost', async () => {
    const p = pod(), s = store(p.fetch);
    await Promise.all([s.append(OWNER, [statement('s-1')]), s.append(OWNER, [statement('s-2')]), s.append(OWNER, [statement('s-3')])]);
    expect((await s.read(OWNER)).statements.map(x => x['id'])).toEqual(['s-1', 's-2', 's-3']);
  });

  it('a statement with no id is not kept', async () => {
    const p = pod();
    expect((await refusal(store(p.fetch).append(OWNER, [{ verb: {} }]))).status).toBe(400);
    expect(p.calls).toEqual([]);
  });

  it('a document that is not this guest\'s record is neither read as one nor written over', async () => {
    const p = pod(), s = store(p.fetch);
    for (const other of ['not json', '[]', JSON.stringify({ kind: GUEST_RECORD_KIND, version: 1, subject: `did:web:${HOST}:users:u-try-guest-` + 'e'.repeat(32), statements: [] }), JSON.stringify({ kind: 'something-else', version: 1, subject: DID, statements: [] })]) {
      p.docs.set(`${POD}${GUEST_RECORD_PATH}`, other);
      expect((await refusal(s.read(OWNER))).code).toBe('general_guest_record_unreadable');
      expect((await refusal(s.append(OWNER, [statement('s-9')]))).code).toBe('general_guest_record_unreadable');
    }
    expect(p.calls.filter(c => c.method === 'PUT')).toEqual([]);
  });
});

describe('what the gate answers a write with', () => {
  it('410: the guest is gone. It is said so, and the write is not tried again', async () => {
    for (const status of [410]) {
      const p = pod([status]), s = store(p.fetch);
      const e = await refusal(s.append(OWNER, [statement('s-1')]));
      expect(e).toMatchObject({ status: 410, code: 'general_guest_gone', gone: true });
      expect(p.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
    }
  });

  it('409, 503, 413 and 507 are refusals of their own, none of them "gone", none retried here', async () => {
    const expected: Array<[number, number, string]> = [
      [409, 409, 'general_guest_pod_not_open'], [503, 503, 'general_guest_pod_unavailable'],
      [413, 507, 'general_guest_storage_full'], [507, 507, 'general_guest_storage_full'], [500, 503, 'general_guest_pod_unavailable'], [401, 503, 'general_guest_pod_unavailable'],
    ];
    for (const [answered, status, code] of expected) {
      const p = pod([answered]), s = store(p.fetch);
      const e = await refusal(s.append(OWNER, [statement('s-1')]));
      expect(e, String(answered)).toMatchObject({ status, code, gone: false });
      expect(p.calls.filter(c => c.method === 'PUT'), String(answered)).toHaveLength(1);
      // Nothing was kept, so the same step can be kept later.
      expect((await s.read(OWNER)).statements).toEqual([]);
    }
  });

  it('a pod that cannot be reached is unavailable, not gone', async () => {
    const s = store(async () => { throw new Error('socket hang up'); });
    expect(await refusal(s.read(OWNER))).toMatchObject({ status: 503, code: 'general_guest_pod_unavailable', gone: false });
  });
});

describe('writes are small and few', () => {
  it('the bounds sit well inside the gate\'s for a guest\'s pod (4096 writes, 128 MiB, 8 MiB each)', () => {
    expect(GUEST_RECORD_MAX_BYTES).toBeLessThanOrEqual(1024 * 1024);
    expect(GUEST_RECORD_MAX_WRITES).toBeLessThanOrEqual(1024);
    // What is written is the SEALED document, larger than the record it holds; it is the one bounded against the gate.
    expect(GUEST_RECORD_MAX_SEALED_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(GUEST_RECORD_MAX_WRITES * GUEST_RECORD_MAX_SEALED_BYTES).toBeLessThan(128 * 1024 * 1024);
    expect(GUEST_RECORD_MAX_WRITES).toBeLessThan(4096);
  });

  it('a record at its size bound still fits the sealed document\'s bound, with every tab a recipient', async () => {
    const p = pod(), s = store(p.fetch);
    const base = JSON.stringify({ kind: GUEST_RECORD_KIND, version: 1, subject: DID, updatedAt: '2026-11-17T10:00:00.000Z', statements: [{ ...statement('s-big'), note: '' }] }).length;
    await s.append(OWNER, [{ ...statement('s-big'), note: 'x'.repeat(GUEST_RECORD_MAX_BYTES - base) }]);
    const written = p.calls.find(c => c.method === 'PUT')!.body!;
    expect(Buffer.byteLength(written, 'utf8')).toBeLessThanOrEqual(GUEST_RECORD_MAX_SEALED_BYTES);
    expect(Buffer.byteLength(written, 'utf8')).toBeGreaterThan(GUEST_RECORD_MAX_BYTES);
  });

  it('a record that would pass its size is refused before anything is sent', async () => {
    const p = pod(), s = store(p.fetch);
    const e = await refusal(s.append(OWNER, [{ ...statement('s-big'), note: 'x'.repeat(GUEST_RECORD_MAX_BYTES) }]));
    expect(e).toMatchObject({ status: 507, code: 'general_guest_record_full' });
    expect(p.calls.filter(c => c.method === 'PUT')).toEqual([]);
  });

  it('a guest\'s write allowance for this process ends', async () => {
    const p = pod(), s = store(p.fetch);
    // Each write replaces the document; the pod here keeps only the last, so the record stays small.
    for (let i = 0; i < GUEST_RECORD_MAX_WRITES; i++) { p.docs.clear(); await s.append(OWNER, [statement(`s-${i}`)]); }
    p.docs.clear();
    expect(await refusal(s.append(OWNER, [statement('s-last')]))).toMatchObject({ status: 507, code: 'general_guest_record_full' });
    expect(p.calls.filter(c => c.method === 'PUT')).toHaveLength(GUEST_RECORD_MAX_WRITES);
    // Another guest's allowance is its own.
    const otherId = 'u-try-guest-' + '9'.repeat(32);
    await s.append({ userId: otherId, guestDid: `did:web:${HOST}:users:${otherId}`, podUrl: `https://pods.example/${otherId}/` }, [statement('s-1')]);
    expect(s.writesFor(otherId)).toBe(1);
  });
});
