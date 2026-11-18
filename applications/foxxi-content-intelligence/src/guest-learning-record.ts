/**
 * A general guest's learning record: one SEALED document on the GUEST'S OWN pod.
 *
 * Where: `<pod origin>/<u-try-guest-…>/foxxi-dashboard/learning-record.sealed.json`. The address
 * is built here from the guest's admission and checked every time (`guestRecordUrl`): it is on the
 * tenant pod's origin, its first path segment is the guest's own id, and it is never the tenant
 * pod. Nothing in a request names it.
 *
 * Who writes: the bridge, with the gate's operator bearer (the `fetch` it is given attaches it to
 * writes on the pod origin). A guest's own token cannot write here.
 *
 * ── Confidential at rest ────────────────────────────────────────────────────────────────────
 * The gate serves pod reads with no sign-in, so whoever has a guest's id can fetch this document.
 * What they fetch is ciphertext: the record is sealed in the substrate's multi-recipient envelope
 * (`createEncryptedEnvelope`, @interego/core: XSalsa20-Poly1305 under a fresh content key, the
 * content key wrapped with X25519 for each recipient). Nothing of the record is in the clear, not
 * its subject, its statements or how many there are. The outer document is
 * `{ kind: GUEST_RECORD_SEALED_KIND, version: 1, envelope }`: plain JSON to the gate, which takes
 * it as any other document an operator writes into a guest's pod. What a reader without a key
 * still learns is what any envelope shows: that a record exists for this guest id, when it was
 * last sealed (`encryptedAt`), about how large it is, and the public keys it is sealed for.
 *
 * WHO CAN DECRYPT, exactly:
 *
 *   1. The bridge: whoever holds the bridge's sealing secret (`guestRecordSealSecret`), for every
 *      guest and at any time, not only during a session. The key it opens a guest's record with is
 *      derived from that secret and the guest's DID (`guestRecordSealKey`), so one guest's key
 *      opens no other guest's record, and nothing per guest is stored anywhere.
 *   2. The guest's own browser tab: each tab that finished the door visit and sent an X25519
 *      public key of its own (`record_key`, src/dashboard-general-guest.ts) is a recipient of every
 *      version written while it is admitted. Its secret key never leaves the tab. So a guest can
 *      fetch the document from its own pod and open it without asking the bridge, and can check
 *      that the bridge sealed it (the wrapped key names the bridge's public key as its sender).
 *
 *   Nobody else: not a holder of the guest's id, not a reader at the gate, not the storage
 *   provider, not the operator bearer (which writes and could delete, but holds no key).
 *
 * WHY the bridge holds a key at all, instead of the browser alone. The bridge reads the record on
 * every step (it appends by read-modify-write, and resolves a composition from what the guest has
 * already done), so it needs to open it during a session. A key kept only for the session would
 * do for that, but a session here is a process's memory: a restart forgets every admission, and
 * the guest then returns through the door as the same guest with a NEW tab key. A tab's key dies
 * with its tab, and the guest's lasting key lives at the door's origin, which the dashboard cannot
 * use. With only tab keys as recipients the record would be unreadable to everyone, the guest
 * included, the first time the tab closed or the bridge restarted. So the bridge is a standing
 * recipient, by a derived key, and that is a bridge-held service key: the record is confidential
 * from the public and from storage, NOT from the bridge's operator.
 *
 * A tab is a recipient from the next write after it is admitted (the envelope is made again at
 * each write, for the tabs admitted then). A tab that was a recipient of one version can open that
 * version for as long as it keeps its key; it was that guest's own tab.
 *
 * A document here that is not a sealed record the bridge itself sealed for this guest (a plain
 * one, one sealed by another key, one that opens to another subject) is neither read as the
 * record nor written over.
 *
 * What the gate may answer a write with (deploy/css-gate, "What an application's bridge may write
 * into a guest's pod"), and what is done about each:
 *
 *   410  the guest is closed or expired   -> `GuestPodError.gone`: never retried here; the caller ends the session
 *   409  no open account behind the pod   -> refused, not retried here
 *   503  the gate could not read the pod's state -> unavailable; the caller may ask again
 *   413 / 507  the gate's bound for this pod is spent -> refused, not retried here
 *
 * Writes are kept small and few, well inside the gate's bound for a guest's pod (4096 writes,
 * 128 MiB, 8 MiB each, per gate process): one PUT of the whole sealed document per kept step, the
 * record at most `GUEST_RECORD_MAX_BYTES` before sealing and the document at most
 * `GUEST_RECORD_MAX_SEALED_BYTES` as written (base64 of the ciphertext, and a wrapped key per
 * recipient), at most `GUEST_RECORD_MAX_WRITES` per guest per process. A step whose statements
 * are all kept already writes nothing.
 */
import { createHash, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { createEncryptedEnvelope, deriveEncryptionKeyPair, openEncryptedEnvelope, type EncryptedEnvelope, type EncryptionKeyPair } from '@interego/core';
import { guardSubjectPod, type SubjectPodGuardRefusal } from './subject-pod-url.js';

export const GUEST_RECORD_PATH = 'foxxi-dashboard/learning-record.sealed.json';
/** The record itself: what is sealed. */
export const GUEST_RECORD_KIND = 'foxxi-dashboard-guest-learning-record';
/** The document on the pod: an envelope around the record. */
export const GUEST_RECORD_SEALED_KIND = 'foxxi-dashboard-guest-learning-record-sealed';
/** The record, before it is sealed. 256 KiB. */
export const GUEST_RECORD_MAX_BYTES = 256 * 1024;
/** The sealed document, as written. 384 KiB: the record in base64, and the envelope around it. */
export const GUEST_RECORD_MAX_SEALED_BYTES = 384 * 1024;
export const GUEST_RECORD_MAX_STATEMENTS = 2000;
/** Writes per guest, per bridge process. With the byte bound: at most 96 MiB per guest per process. */
export const GUEST_RECORD_MAX_WRITES = 256;
/** Browser tabs sealed for at one write: as many as one guest may hold admitted at once. */
export const GUEST_RECORD_MAX_TAB_RECIPIENTS = 4;
const MAX_TRACKED_GUESTS = 5000;

export type GuestPodErrorCode =
  | 'general_guest_gone'
  | 'general_guest_pod_not_open'
  | 'general_guest_pod_unavailable'
  | 'general_guest_storage_full'
  | 'general_guest_record_full'
  | 'general_guest_record_unreadable'
  | 'general_guest_pod_refused';

export class GuestPodError extends Error {
  constructor(readonly status: number, readonly code: GuestPodErrorCode, readonly detail?: string) { super(code); this.name = 'GuestPodError'; }
  /** The gate said the guest is closed or expired. The session ends; nothing is retried. */
  get gone(): boolean { return this.code === 'general_guest_gone'; }
}

/** The guest whose record this is: what the bridge checked at the door. */
export interface GuestRecordOwner {
  readonly userId: string;
  readonly guestDid: string;
  readonly podUrl: string;
}

export interface GuestLearningRecord {
  readonly kind: typeof GUEST_RECORD_KIND;
  readonly version: 1;
  /** The guest's DID. */
  readonly subject: string;
  readonly updatedAt: string;
  readonly statements: ReadonlyArray<Record<string, unknown>>;
}

export type GuestRecordFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: 'error' | 'manual'; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GuestRecordStoreOptions {
  readonly tenantPodUrl: string;
  /** The identity service's host, as the pod resolver is given it. */
  readonly identityHost: string;
  /**
   * The bridge's sealing secret: 64 hex characters (`guestRecordSealSecret`). Each guest's key is
   * derived from it and the guest's DID. Without a usable one the store is not built.
   */
  readonly sealSecret: string;
  /**
   * The X25519 public keys (base64) of the browser tabs admitted as this guest now. Each usable
   * one is a recipient of the next write. Absent, only the bridge is a recipient.
   */
  readonly tabKeys?: (owner: GuestRecordOwner) => readonly string[];
  /** Reads go as they are; the bridge's fetch attaches the operator bearer to writes on the pod origin. */
  readonly fetch: GuestRecordFetch;
  readonly now?: () => number;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const SEAL_SECRET = /^[0-9a-f]{64}$/;
/**
 * The bridge's sealing secret for guest records, as 64 lowercase hex characters, or undefined
 * where this bridge has none. The bridge's own private key when it is one
 * (FOXXI_BRIDGE_PRIVATE_KEY, which already seals the workbench's and the gradebook's documents);
 * else the hash of its wallet seed, as `bridgeEncryptionKeypair` reads it. Nothing is generated:
 * a key made per process could not open what the last process sealed.
 */
export function guestRecordSealSecret(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const own = (env['FOXXI_BRIDGE_PRIVATE_KEY'] ?? '').trim().toLowerCase().replace(/^0x/, '');
  if (SEAL_SECRET.test(own)) return own;
  const seed = env['FOXXI_WALLET_SEED'] || env['FOXXI_ISSUER_KEY_SEED'] || '';
  return seed ? createHash('sha256').update(seed).digest('hex') : undefined;
}

/**
 * The key the bridge seals and opens ONE guest's record with. Derived (`deriveEncryptionKeyPair`,
 * with the guest's DID as the principal), so it is the same in every process that holds the
 * secret, differs for every guest, and is stored nowhere.
 */
export function guestRecordSealKey(sealSecret: string, guestDid: string): EncryptionKeyPair {
  if (!SEAL_SECRET.test(sealSecret)) throw new Error('the guest record sealing secret is not 64 hex characters');
  return deriveEncryptionKeyPair(sealSecret, `urn:foxxi:dashboard-guest-learning-record:v1:${guestDid}`);
}

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
/**
 * Is this a usable X25519 public key, in base64 as the envelope carries one? 32 bytes, canonical
 * base64, and not a point of small order: a key wrapped for one of those is wrapped under a shared
 * secret anyone can compute, which would make the tab's own wrapped key a way in for a stranger.
 */
export function isTabRecordKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const raw = Buffer.from(value, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== value) return false;
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    // Node refuses to derive from a small-order point (the shared secret would be all zero).
    diffieHellman({ privateKey: generateKeyPairSync('x25519').privateKey, publicKey });
    return true;
  } catch { return false; }
}

/** The sealed document for a record: the bridge's own key first, then each tab's. */
function seal(plain: string, key: EncryptionKeyPair, tabKeys: readonly string[]): string {
  const tabs = [...new Set(tabKeys)].filter(k => k !== key.publicKey && isTabRecordKey(k)).slice(-GUEST_RECORD_MAX_TAB_RECIPIENTS);
  return JSON.stringify({ kind: GUEST_RECORD_SEALED_KIND, version: 1, envelope: createEncryptedEnvelope(plain, [key.publicKey, ...tabs], key) });
}

/**
 * The record a sealed document holds, or undefined when it is not one this key sealed. Only a
 * wrapped key the bridge made for itself is used: a document someone else sealed TO the bridge's
 * public key is not the bridge's record, whatever it says inside.
 */
function open(text: string, key: EncryptionKeyPair): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!record(parsed) || parsed['kind'] !== GUEST_RECORD_SEALED_KIND || parsed['version'] !== 1 || !record(parsed['envelope'])) return undefined;
    const envelope = parsed['envelope'] as unknown as EncryptedEnvelope;
    if (!Array.isArray(envelope.wrappedKeys) || !record(envelope.content)) return undefined;
    const own = envelope.wrappedKeys.filter(w => record(w) && w.recipientPublicKey === key.publicKey && w.senderPublicKey === key.publicKey);
    if (!own.length) return undefined;
    return openEncryptedEnvelope({ ...envelope, wrappedKeys: own }, key) ?? undefined;
  } catch { return undefined; }
}

/**
 * The address of a guest's record, or a refusal. The pod must pass `guardSubjectPod` for this
 * guest (its own pod, on the tenant pod's origin, never the tenant pod) and be exactly
 * `<origin>/<userId>/`.
 */
export function guestRecordUrl(owner: GuestRecordOwner, tenantPodUrl: string, identityHost: string): { ok: true; url: string } | { ok: false; reason: SubjectPodGuardRefusal | 'not-a-guest' } {
  if (!/^u-try-guest-[0-9a-f]{32}$/.test(owner.userId) || !owner.guestDid.endsWith(`:users:${owner.userId}`)) return { ok: false, reason: 'not-a-guest' };
  const guard = guardSubjectPod({ subject: owner.guestDid, podUrl: owner.podUrl, tenantPodUrl, identityHost });
  if (!guard.ok) return { ok: false, reason: guard.reason };
  let origin: string;
  try { origin = new URL(tenantPodUrl).origin; } catch { return { ok: false, reason: 'pod-unreadable' }; }
  // The guard compares pod roots; the record is written under the exact root and nothing looser.
  if (owner.podUrl !== `${origin}/${owner.userId}/`) return { ok: false, reason: 'not-own-pod' };
  return { ok: true, url: `${origin}/${owner.userId}/${GUEST_RECORD_PATH}` };
}

export class GuestLearningRecordStore {
  private readonly now: () => number;
  /** One write at a time per guest: a second step waits for the first to be kept. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly writes = new Map<string, number>();

  constructor(private readonly options: GuestRecordStoreOptions) {
    this.now = options.now ?? Date.now;
    // Checked once, here: a store that could not seal must not exist to write anything in the clear.
    guestRecordSealKey(options.sealSecret, 'did:web:check.invalid:users:u-try-guest-' + '0'.repeat(32));
  }

  /** The bridge's public key for this guest's record: what a tab checks a wrapped key's sender against. */
  sealedBy(owner: GuestRecordOwner): string { return guestRecordSealKey(this.options.sealSecret, owner.guestDid).publicKey; }
  /** Where this guest's sealed record is, for the guest's own tab to fetch. */
  addressOf(owner: GuestRecordOwner): string { return this.url(owner); }

  /** How many writes this process has made for a guest. */
  writesFor(userId: string): number { return this.writes.get(userId) ?? 0; }

  private url(owner: GuestRecordOwner): string {
    const at = guestRecordUrl(owner, this.options.tenantPodUrl, this.options.identityHost);
    if (!at.ok) throw new GuestPodError(403, 'general_guest_pod_refused', at.reason);
    return at.url;
  }

  private empty(owner: GuestRecordOwner): GuestLearningRecord {
    return { kind: GUEST_RECORD_KIND, version: 1, subject: owner.guestDid, updatedAt: new Date(this.now()).toISOString(), statements: [] };
  }

  /** The guest's record. A pod with no record yet answers an empty one. */
  async read(owner: GuestRecordOwner): Promise<GuestLearningRecord> {
    const url = this.url(owner);
    let response: { ok: boolean; status: number; text(): Promise<string> };
    let body = '';
    try {
      response = await this.options.fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (response.ok) body = await response.text();
    } catch { throw new GuestPodError(503, 'general_guest_pod_unavailable'); }
    if (response.status === 404) return this.empty(owner);
    if (response.status === 410) throw new GuestPodError(410, 'general_guest_gone');
    if (!response.ok) throw new GuestPodError(503, 'general_guest_pod_unavailable', `read answered ${response.status}`);
    if (body.length > GUEST_RECORD_MAX_SEALED_BYTES * 2) throw new GuestPodError(502, 'general_guest_record_unreadable');
    // Only what the bridge sealed for THIS guest opens: a plain document, or one sealed by any
    // other key, is not read as the record and is not written over.
    const plain = open(body, guestRecordSealKey(this.options.sealSecret, owner.guestDid));
    if (plain === undefined) throw new GuestPodError(502, 'general_guest_record_unreadable');
    let parsed: unknown;
    try { parsed = JSON.parse(plain); } catch { throw new GuestPodError(502, 'general_guest_record_unreadable'); }
    // A document that is not this guest's record is not read as one, and is not written over.
    if (!record(parsed) || parsed['kind'] !== GUEST_RECORD_KIND || parsed['version'] !== 1 || parsed['subject'] !== owner.guestDid
      || !Array.isArray(parsed['statements']) || !parsed['statements'].every(record)) throw new GuestPodError(502, 'general_guest_record_unreadable');
    return { kind: GUEST_RECORD_KIND, version: 1, subject: owner.guestDid,
      updatedAt: typeof parsed['updatedAt'] === 'string' ? parsed['updatedAt'] : '', statements: parsed['statements'] as Array<Record<string, unknown>> };
  }

  /**
   * Keep these statements in the guest's record and answer their ids. Each needs a string `id`;
   * one already in the record is not added twice, so keeping the same step again is harmless and
   * writes nothing. Throws `GuestPodError`; nothing is retried here.
   */
  append(owner: GuestRecordOwner, statements: ReadonlyArray<Record<string, unknown>>): Promise<string[]> {
    const ids = statements.map(s => s['id']);
    if (!ids.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128)) return Promise.reject(new GuestPodError(400, 'general_guest_record_unreadable', 'a statement has no id'));
    const run = (this.queues.get(owner.userId) ?? Promise.resolve()).catch(() => undefined).then(() => this.appendNow(owner, statements, ids));
    this.queues.set(owner.userId, run);
    void run.catch(() => undefined).finally(() => { if (this.queues.get(owner.userId) === run) this.queues.delete(owner.userId); });
    return run;
  }

  private async appendNow(owner: GuestRecordOwner, statements: ReadonlyArray<Record<string, unknown>>, ids: string[]): Promise<string[]> {
    const url = this.url(owner);
    const current = await this.read(owner);
    const have = new Set(current.statements.map(s => s['id']));
    const added = statements.filter(s => !have.has(s['id']));
    if (!added.length) return ids;
    const next: GuestLearningRecord = { kind: GUEST_RECORD_KIND, version: 1, subject: owner.guestDid,
      updatedAt: new Date(this.now()).toISOString(), statements: [...current.statements, ...added] };
    const plain = JSON.stringify(next);
    if (next.statements.length > GUEST_RECORD_MAX_STATEMENTS || Buffer.byteLength(plain, 'utf8') > GUEST_RECORD_MAX_BYTES) throw new GuestPodError(507, 'general_guest_record_full');
    // Sealed for the bridge and for the tabs admitted as this guest now. Never sent in the clear.
    let tabs: readonly string[] = [];
    try { tabs = this.options.tabKeys?.(owner) ?? []; } catch { tabs = []; }
    const body = seal(plain, guestRecordSealKey(this.options.sealSecret, owner.guestDid), tabs);
    if (Buffer.byteLength(body, 'utf8') > GUEST_RECORD_MAX_SEALED_BYTES) throw new GuestPodError(507, 'general_guest_record_full');
    const made = this.writes.get(owner.userId) ?? 0;
    if (made >= GUEST_RECORD_MAX_WRITES) throw new GuestPodError(507, 'general_guest_record_full', 'write allowance spent');
    if (!this.writes.has(owner.userId) && this.writes.size >= MAX_TRACKED_GUESTS) {
      const oldest = this.writes.keys().next().value;
      if (oldest !== undefined) this.writes.delete(oldest);
    }
    // Counted before it is sent: a write that failed at the gate may still have been counted there.
    this.writes.set(owner.userId, made + 1);
    let response: { ok: boolean; status: number; text(): Promise<string> };
    try {
      response = await this.options.fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch { throw new GuestPodError(503, 'general_guest_pod_unavailable'); }
    if (response.ok) return ids;
    switch (response.status) {
      case 410: throw new GuestPodError(410, 'general_guest_gone');
      case 409: throw new GuestPodError(409, 'general_guest_pod_not_open');
      case 413: case 507: throw new GuestPodError(507, 'general_guest_storage_full');
      default: throw new GuestPodError(503, 'general_guest_pod_unavailable', `write answered ${response.status}`);
    }
  }
}
