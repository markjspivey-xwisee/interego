/** A private, non-pruning ledger of separately attested LTI reconciliations.
 * This fixed native resource never publishes a manifest or changes the LMS/LRS. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalJson, deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { NativeCommitConflictError, NativeCommitStore, createNativeByteArtifact, readNativeByteArtifact } from '@interego/pgsl';
import type { OwnSubjectXapiAuthority } from './own-subject-xapi-auth.js';

export const OWN_LTI_RECONCILIATION_SCHEMA = 'foxxi.lti-reconciliation-ledger/v1';
export const OWN_LTI_RECONCILIATION_HEAD = 'foxxi/lti-reconciliation/own/head';
export const OWN_LTI_RECONCILIATION_LIMITS = Object.freeze({
  entries: 64, entryJsonBytes: 32768, jsonBytes: 768 * 1024,
  gzipBytes: 384 * 1024, encryptedBytes: 1024 * 1024,
});
const TYPE = 'application/vnd.interego.rolling-checkpoint+gzip';
const KEY_DOMAIN = 'urn:foxxi:lti-own-reconciliation-ledger:';
const HEX = /^[a-f0-9]{64}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const L = OWN_LTI_RECONCILIATION_LIMITS;

export class OwnLtiReconciliationStoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'OwnLtiReconciliationStoreError'; }
}
export interface OwnLtiReconciliationView<Entry> { revision: string | null; entries: Entry[]; }
export interface OwnLtiReconciliationStoreOptions {
  privateKey: string; fetch: typeof fetch; readOnly: boolean;
  /** Verifies the complete attestation and its independently bound owner. */
  validateEntry(value: unknown): boolean | Promise<boolean>;
  now?: () => number;
}
interface Ledger<Entry> {
  schema: string; owner: string; pod: string; head: string; writtenAt: number;
  entries: Entry[]; entryDigests: string[]; ledgerDigest: string; ledgerMac: string;
}
function fail(status: number, message: string): never { throw new OwnLtiReconciliationStoreError(status, message); }
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v), 'utf8').digest('hex');
const copy = <T>(v: T): T => JSON.parse(canonicalJson(v)) as T;
function finiteJson(v: unknown, depth = 0, active = new Set<object>(), count = { n: 0 }): boolean {
  if (++count.n > 100000 || depth > 32) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || active.has(v)) return false;
  if (!Array.isArray(v) && !plain(v)) return false;
  if (Object.getOwnPropertySymbols(v).length) return false;
  active.add(v);
  const keys = Object.keys(v);
  const valid = keys.every(k => {
    const property = Object.getOwnPropertyDescriptor(v, k);
    return !!property && 'value' in property && finiteJson(property.value, depth + 1, active, count);
  }) && (!Array.isArray(v) || keys.length === v.length);
  active.delete(v); return valid;
}

export function createOwnLtiReconciliationStore<Entry extends { id: string } = { id: string }>(
  authority: OwnSubjectXapiAuthority, options: OwnLtiReconciliationStoreOptions,
) {
  if (!/^(?:0x)?[a-f0-9]{64}$/i.test(options.privateKey) || /^0+$/.test(options.privateKey.replace(/^0x/i, '')))
    fail(503, 'Stable reconciliation encryption key is required.');
  if (authority.ok !== true || typeof options.validateEntry !== 'function') fail(503, 'Verified reconciliation authority is required.');
  const owner = authority.subjectDid;
  const nativeOwner = /^did:web:([^:]+):users:([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/.exec(owner);
  if (!nativeOwner) fail(403, 'A verified native human owner is required.');
  let pod: URL;
  try { pod = new URL(authority.podUrl); } catch { return fail(403, 'A canonical own pod is required.'); }
  if (pod.protocol !== 'https:' || pod.username || pod.password || pod.search || pod.hash
    || pod.pathname !== '/' + nativeOwner[2] + '/') fail(403, 'The native own-pod binding is invalid.');
  const scope = { pod: pod.href, owner: owner as IRI,
    headUrl: new URL(OWN_LTI_RECONCILIATION_HEAD, pod).href,
    artifactContainer: new URL('foxxi/lti-reconciliation/own/artifacts/', pod).href };
  const key = deriveEncryptionKeyPair(options.privateKey, KEY_DOMAIN + owner);
  const macKey = Buffer.from(key.secretKey, 'base64');
  const mac = (digest: string) => createHmac('sha256', macKey).update(OWN_LTI_RECONCILIATION_SCHEMA + '\n' + digest).digest('hex');
  const clock = options.now ?? Date.now;
  function now(): number {
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0) fail(503, 'Reconciliation clock is unavailable.');
    return at;
  }
  const native = new NativeCommitStore({ scope, atomicCheckpoint: true, senderKeyPair: key,
    ownerPublicKey: authority.ownerPublicKey, recipientPublicKeys: [authority.ownerPublicKey, key.publicKey],
    maxArtifactBytes: L.encryptedBytes,
    fetch: async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.href !== scope.headUrl || !['GET', 'HEAD', 'OPTIONS', 'PUT'].includes(method)
        || options.readOnly && method === 'PUT') fail(403, 'Reconciliation transport left its fixed own resource.');
      const headers = new Headers(init.headers); headers.set('Cache-Control', 'no-cache');
      const response = await options.fetch(input, { ...init, method, headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400 || response.url && response.url !== url.href) {
        await response.body?.cancel(); fail(503, 'Reconciliation transport refused a redirect.');
      }
      return response;
    } });
  async function checkedEntry(input: unknown, stored: boolean): Promise<Entry> {
    const status = stored ? 503 : 400;
    if (!finiteJson(input) || !plain(input) || typeof input.id !== 'string' || !HEX.test(input.id)) fail(status, 'Invalid reconciliation entry.');
    const canonical = canonicalJson(input);
    if (Buffer.byteLength(canonical, 'utf8') > L.entryJsonBytes) fail(stored ? 503 : 413, 'Reconciliation entry exceeds capacity.');
    const detached = JSON.parse(canonical) as Entry;
    let valid = false;
    try { valid = await options.validateEntry(detached); } catch { /* No verifier error or source data is reflected. */ }
    if (valid !== true || canonicalJson(detached) !== canonical) fail(status, 'Reconciliation entry attestation is invalid.');
    return detached;
  }
  function body(state: Ledger<Entry>) {
    return { schema: state.schema, owner: state.owner, pod: state.pod, head: state.head,
      writtenAt: state.writtenAt, entries: state.entries, entryDigests: state.entryDigests };
  }
  function sealed(entries: Entry[], writtenAt: number): Ledger<Entry> {
    const state: Ledger<Entry> = { schema: OWN_LTI_RECONCILIATION_SCHEMA, owner, pod: scope.pod, head: scope.headUrl,
      writtenAt, entries, entryDigests: entries.map(hash), ledgerDigest: '', ledgerMac: '' };
    state.ledgerDigest = hash(body(state)); state.ledgerMac = mac(state.ledgerDigest); return state;
  }
  async function decode(selected: Awaited<ReturnType<typeof native.readAtomicCheckpoint>>): Promise<Ledger<Entry>> {
    if (!selected.artifact) {
      if (selected.revision !== null) fail(503, 'Reconciliation representation is inconsistent.');
      return sealed([], 0);
    }
    const envelope = readNativeByteArtifact(selected.artifact);
    if (envelope.owner !== owner || envelope.contentType !== TYPE || envelope.bytes.length > L.gzipBytes) fail(503, 'Reconciliation envelope is invalid.');
    const bytes = gunzipSync(envelope.bytes, { maxOutputLength: L.jsonBytes });
    const state: unknown = JSON.parse(bytes.toString('utf8'));
    const fields = ['schema', 'owner', 'pod', 'head', 'writtenAt', 'entries', 'entryDigests', 'ledgerDigest', 'ledgerMac'];
    if (!finiteJson(state) || !plain(state) || Object.keys(state).length !== fields.length || Object.keys(state).some(k => !fields.includes(k))
      || state.schema !== OWN_LTI_RECONCILIATION_SCHEMA || state.owner !== owner || state.pod !== scope.pod || state.head !== scope.headUrl
      || !Number.isSafeInteger(state.writtenAt) || Number(state.writtenAt) < 0 || Number(state.writtenAt) > now() + 5000
      || !Array.isArray(state.entries) || state.entries.length > L.entries || !Array.isArray(state.entryDigests)
      || state.entryDigests.length !== state.entries.length || typeof state.ledgerDigest !== 'string' || !HEX.test(state.ledgerDigest)
      || typeof state.ledgerMac !== 'string' || !HEX.test(state.ledgerMac)) fail(503, 'Reconciliation ledger is corrupt.');
    const ledger = state as unknown as Ledger<Entry>;
    if (hash(body(ledger)) !== ledger.ledgerDigest || !timingSafeEqual(Buffer.from(ledger.ledgerMac, 'hex'), Buffer.from(mac(ledger.ledgerDigest), 'hex')))
      fail(503, 'Reconciliation ledger integrity is invalid.');
    const ids = new Set<string>();
    for (let index = 0; index < ledger.entries.length; index++) {
      const entry = await checkedEntry(ledger.entries[index], true);
      if (ids.has(entry.id) || hash(entry) !== ledger.entryDigests[index]) fail(503, 'Reconciliation prior entries changed.');
      ids.add(entry.id);
    }
    return ledger;
  }
  function artifact(state: Ledger<Entry>) {
    const json = Buffer.from(canonicalJson(state), 'utf8');
    if (json.length > L.jsonBytes) fail(413, 'Reconciliation ledger capacity reached; confirmed entries are preserved.');
    const gzip = gzipSync(json);
    if (gzip.length > L.gzipBytes) fail(413, 'Reconciliation compressed capacity reached; confirmed entries are preserved.');
    const result = createNativeByteArtifact({ owner: scope.owner, contentType: TYPE, bytes: gzip });
    if (native.atomicCheckpointSize(result) > L.encryptedBytes) fail(413, 'Reconciliation encrypted capacity reached; confirmed entries are preserved.');
    return result;
  }
  function view(revision: string | null, state: Ledger<Entry>): OwnLtiReconciliationView<Entry> {
    return { revision, entries: copy(state.entries) };
  }
  function unavailable(error: unknown): never {
    if (error instanceof OwnLtiReconciliationStoreError) throw error;
    if (error instanceof NativeCommitConflictError) fail(409, 'Reconciliation revision changed; read the existing ledger before retrying.');
    if (error instanceof Error && 'status' in error && error.status === 413)
      fail(413, 'Reconciliation capacity reached; confirmed entries are preserved.');
    return fail(503, 'Reconciliation storage outcome is unconfirmed; read the same entry before retrying.');
  }
  return Object.freeze({
    async read(): Promise<OwnLtiReconciliationView<Entry>> {
      try { const selected = await native.readAtomicCheckpoint(); return view(selected.revision, await decode(selected)); }
      catch (error) { return unavailable(error); }
    },
    async append(expectedRevision: string | null, input: Entry): Promise<OwnLtiReconciliationView<Entry>> {
      if (options.readOnly) fail(403, 'Reconciliation scope is read-only.');
      if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !REVISION.test(expectedRevision))) fail(400, 'Invalid reconciliation revision.');
      const entry = await checkedEntry(input, false);
      try {
        const selected = await native.readAtomicCheckpoint(), state = await decode(selected);
        const prior = state.entries.find(row => row.id === entry.id);
        if (prior) {
          if (canonicalJson(prior) !== canonicalJson(entry)) fail(409, 'Reconciliation ID already has different immutable content.');
          return view(selected.revision, state); // Exact retry is only a fresh read, even after restart.
        }
        if (selected.revision !== expectedRevision) fail(409, 'Reconciliation revision changed; read before appending.');
        if (state.entries.length >= L.entries) fail(413, 'Reconciliation ledger is full; confirmed entries are never pruned.');
        const at = now(); if (at < state.writtenAt) fail(503, 'Reconciliation clock regressed.');
        const next = sealed([...state.entries, entry], at), encoded = artifact(next);
        const committed = await native.commitAtomicCheckpoint(selected.revision, encoded, { maxEncryptedBytes: L.encryptedBytes });
        if (canonicalJson(await decode(committed)) !== canonicalJson(next)) fail(503, 'Reconciliation commit readback changed.');
        const fresh = await native.readAtomicCheckpoint(), confirmed = await decode(fresh);
        if (fresh.revision !== committed.revision || canonicalJson(confirmed) !== canonicalJson(next)) fail(503, 'Reconciliation fresh readback changed; reconcile the same entry.');
        return view(fresh.revision, confirmed);
      } catch (error) { return unavailable(error); }
    },
  });
}
