/**
 * A guest this browser keeps.
 *
 * ★ WHY. A guest is a wallet the tab makes (session.ts, connectAsGuest), and a reload loses it:
 * the key is never written to storage, so the only way back is a recovery phrase most people do
 * not write down. This keeps the guest for as long as the deployment keeps guests, without
 * putting the key anywhere a script can read it at rest.
 *
 * How. The substrate gives a browser key a pod of its own for a bounded time (a "provisional
 * owner", deploy/identity/PROVISIONAL-PLAY.md), in which it may write two sealed documents and
 * nothing else. One of them holds the guest's recovery phrase, encrypted:
 *
 *   - A P-256 key the browser makes, its private half non-extractable, proves to identity that
 *     this browser asked. The bridge supplies the grant identity requires (/play/grant).
 *   - An X25519 key seals the phrase. Its secret is itself wrapped by a non-extractable AES key,
 *     so what IndexedDB holds can be used by this page and read by nothing.
 *   - The sealed document is written once, through the storage gate, to the one path the guest's
 *     token allows. The pod's operator stores ciphertext.
 *
 * Coming back is local: read the record, fetch the sealed document (anyone may fetch it; only
 * this browser can open it), unwrap, open. No sign-in is repeated.
 *
 * What this does not do. A script running in this page while it is open can use these keys, as it
 * can use the wallet in memory today; the keys are not a defence against that. The guest lasts
 * until the deadline identity set when it was made (`guestExpiresAt`), after which the pod is
 * cleaned up and this record is useless. Keeping the guest past that needs a passkey or wallet
 * claimed through identity, which this module does not offer. And if anything here fails, the
 * guest is the tab-only guest it always was: nothing depends on this having worked.
 */
import nacl from 'tweetnacl';

export class DurableGuestError extends Error {
  constructor(readonly code: string, detail?: string) { super(detail ?? code); }
}

/** What the browser keeps. Every field but the three keys is public or ciphertext. */
export interface StoredGuest {
  readonly version: 1;
  readonly audience: string;
  readonly identityUrl: string;
  readonly userId: string;
  readonly ownerDid: string;
  /** The guest wallet's address, to name the guest before it is opened. */
  readonly address: string;
  /** Where the sealed phrase is. */
  readonly checkpointUrl: string;
  /** ISO time after which the pod is cleaned up. */
  readonly guestExpiresAt: string;
  /** Identity's public proof that this browser key is this owner (for a later claim). */
  readonly attestation: string;
  readonly publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  /** The proof key. Its private half is non-extractable. */
  readonly proofKey: CryptoKeyPair;
  /** The X25519 public key the phrase is sealed to, base64. */
  readonly sealingPublicKey: string;
  /** The X25519 secret, AES-GCM encrypted under `wrappingKey`. */
  readonly wrappedSealingSecret: { readonly iv: Uint8Array; readonly ciphertext: Uint8Array };
  /** Non-extractable AES-GCM key. */
  readonly wrappingKey: CryptoKey;
}

export interface GuestStore {
  get(): Promise<StoredGuest | undefined>;
  put(guest: StoredGuest): Promise<void>;
  delete(): Promise<void>;
}

export type GuestFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface DurableGuestDeps {
  readonly fetch: GuestFetch;
  readonly subtle: SubtleCrypto;
  readonly store: GuestStore;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly now: () => number;
}

/** The deployment's default application namespace, where identity's marker names none (PROVISIONAL-PLAY.md). */
const DEFAULT_NAMESPACE = 'hallowmarch';
const NAMESPACE = /^[a-z][a-z0-9-]{1,31}$/;
const NATIVE_COMMIT = 'application/vnd.interego.native-commit+json';
const SEALED_KIND = 'foxxi.guest-wallet/v1';

/** Bytes over a buffer of their own, which is what WebCrypto takes (tweetnacl's may view a shared one). */
type Bytes = Uint8Array<ArrayBuffer>;
const own = (bytes: Uint8Array): Bytes => new Uint8Array(bytes);
const utf8 = (value: string): Bytes => own(new TextEncoder().encode(value));
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const toBase64Url = (bytes: Uint8Array): string => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256(subtle: SubtleCrypto, value: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', utf8(value)));
}
async function sha256Hex(subtle: SubtleCrypto, value: string): Promise<string> {
  return [...await sha256(subtle, value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const base = (url: string): string => url.replace(/\/+$/, '');

/** The RFC 7638 thumbprint identity computes for a P-256 key (deploy/identity/provisional-play.ts playKeyThumbprint). */
export async function proofKeyThumbprint(subtle: SubtleCrypto, jwk: { crv: string; kty: string; x: string; y: string }): Promise<string> {
  return toBase64Url(await sha256(subtle, JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

/**
 * The one document a guest of `namespace` may write that this module uses, as the storage gate
 * derives it (deploy/css-gate/provisional-play.mjs provisionalCheckpointPaths, kind `player-profile`).
 */
export async function guestCheckpointUrl(subtle: SubtleCrypto, podUrl: string, ownerDid: string, namespace: string): Promise<string> {
  if (!NAMESPACE.test(namespace)) throw new DurableGuestError('guest_namespace_invalid');
  const graph = `urn:graph:${namespace}:player-profile:${await sha256Hex(subtle, ownerDid)}`;
  return `${base(podUrl)}/${namespace}/checkpoints/${await sha256Hex(subtle, graph)}.json`;
}

interface SealedEnvelope {
  version: 1;
  algorithm: 'X25519-XSalsa20-Poly1305';
  content: { ciphertext: string; nonce: string; algorithm: 'XSalsa20-Poly1305'; encryptedAt: string };
  wrappedKeys: { recipientPublicKey: string; wrappedKey: string; nonce: string; senderPublicKey: string }[];
}

/**
 * Seal `plaintext` to one X25519 key, its own sender, in the envelope the substrate uses
 * (packages/core/src/crypto/encryption.ts createEncryptedEnvelope) and the gate requires of a
 * guest: one wrapped key, sender and recipient the same.
 */
function seal(plaintext: string, keys: { publicKey: Uint8Array; secretKey: Uint8Array }, deps: Pick<DurableGuestDeps, 'randomBytes' | 'now'>): SealedEnvelope {
  const contentKey = deps.randomBytes(nacl.secretbox.keyLength);
  const contentNonce = deps.randomBytes(nacl.secretbox.nonceLength);
  const keyNonce = deps.randomBytes(nacl.box.nonceLength);
  const publicKey = toBase64(keys.publicKey);
  return {
    version: 1, algorithm: 'X25519-XSalsa20-Poly1305',
    content: { ciphertext: toBase64(nacl.secretbox(utf8(plaintext), contentNonce, contentKey)), nonce: toBase64(contentNonce),
      algorithm: 'XSalsa20-Poly1305', encryptedAt: new Date(deps.now()).toISOString() },
    wrappedKeys: [{ recipientPublicKey: publicKey, senderPublicKey: publicKey, nonce: toBase64(keyNonce),
      wrappedKey: toBase64(nacl.box(contentKey, keyNonce, keys.publicKey, keys.secretKey)) }],
  };
}

function open(envelope: unknown, keys: { publicKey: Uint8Array; secretKey: Uint8Array }): string | null {
  const e = record(envelope), content = record(e['content']);
  const wrapped = Array.isArray(e['wrappedKeys']) ? record(e['wrappedKeys'][0]) : {};
  const publicKey = toBase64(keys.publicKey);
  if (e['version'] !== 1 || e['algorithm'] !== 'X25519-XSalsa20-Poly1305' || wrapped['recipientPublicKey'] !== publicKey
    || wrapped['senderPublicKey'] !== publicKey) return null;
  try {
    const contentKey = nacl.box.open(fromBase64(String(wrapped['wrappedKey'])), fromBase64(String(wrapped['nonce'])), keys.publicKey, keys.secretKey);
    if (!contentKey) return null;
    const plain = nacl.secretbox.open(fromBase64(String(content['ciphertext'])), fromBase64(String(content['nonce'])), contentKey);
    return plain ? new TextDecoder().decode(plain) : null;
  } catch { return null; }
}

async function getJson(deps: DurableGuestDeps, url: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let response;
  try { response = await deps.fetch(url, { headers: { Accept: 'application/json', ...headers } }); }
  catch { throw new DurableGuestError('guest_service_unreachable', new URL(url).host); }
  let parsed: unknown;
  try { parsed = await response.json(); } catch { parsed = {}; }
  return { ok: response.ok, status: response.status, body: record(parsed) };
}
async function postJson(deps: DurableGuestDeps, url: string, body: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let response;
  try { response = await deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new DurableGuestError('guest_service_unreachable', new URL(url).host); }
  let parsed: unknown;
  try { parsed = await response.json(); } catch { parsed = {}; }
  return { ok: response.ok, status: response.status, body: record(parsed) };
}

export interface DurableGuestOffer {
  /** The terms a new guest must agree to before identity makes it an owner, when the deployment has any. */
  readonly terms?: { readonly version: string; readonly url: string; readonly privacyUrl?: string };
  /** How long identity keeps a guest, in seconds. */
  readonly ttlSeconds?: number;
  readonly audience: string;
  readonly identityUrl: string;
}

/**
 * Whether this deployment keeps guests, and on what terms: the bridge says whether it issues
 * grants (GET /play/guest) and identity says whether it admits owners. Null when either does not,
 * or cannot be asked; the sign-in page then offers the tab-only guest alone.
 */
export async function durableGuestOffer(bridgeUrl: string, deps: Pick<DurableGuestDeps, 'fetch'> & Partial<DurableGuestDeps>): Promise<DurableGuestOffer | null> {
  try {
    const asked = deps as DurableGuestDeps;
    const bridge = await getJson(asked, `${base(bridgeUrl)}/play/guest`);
    const audience = text(bridge.body['audience']), identityUrl = text(bridge.body['identityUrl']);
    if (!bridge.ok || bridge.body['enabled'] !== true || !audience || !identityUrl) return null;
    const identity = await getJson(asked, `${base(identityUrl)}/.well-known/play-provisional`);
    if (!identity.ok || identity.body['enabled'] !== true) return null;
    const terms = record(identity.body['terms']);
    const version = text(terms['version']), url = text(terms['url']), privacyUrl = text(terms['privacyUrl']);
    const ttl = identity.body['ttlSeconds'];
    return { audience, identityUrl: base(identityUrl),
      ...(version && url ? { terms: { version, url, ...(privacyUrl ? { privacyUrl } : {}) } } : {}),
      ...(typeof ttl === 'number' ? { ttlSeconds: ttl } : {}) };
  } catch { return null; }
}

/**
 * Make this guest one the browser keeps: ask identity for an owner on this browser's key, seal the
 * recovery phrase, write it to the owner's pod, and remember where. Throws DurableGuestError and
 * leaves no record when any step fails; the caller's guest is then the tab-only guest.
 *
 * `acceptedTermsVersion`: the terms version the guest agreed to on the sign-in page, required
 * when the offer names terms. It is sent to identity inside the signed proof, never assumed.
 */
export async function keepGuest(input: {
  readonly bridgeUrl: string; readonly offer: DurableGuestOffer;
  readonly phrase: string; readonly address: string; readonly acceptedTermsVersion?: string;
}, deps: DurableGuestDeps): Promise<StoredGuest> {
  const { offer } = input;
  if (offer.terms && input.acceptedTermsVersion !== offer.terms.version) throw new DurableGuestError('guest_terms_required');
  const termsVersion = offer.terms?.version;

  // 1. The proof key. Its private half cannot be exported, by this page or anything else.
  const proofKey = await deps.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const exported = await deps.subtle.exportKey('jwk', proofKey.publicKey);
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || !exported.x || !exported.y) throw new DurableGuestError('guest_key_unsupported');
  const publicKeyJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: exported.x, y: exported.y };
  const thumbprint = await proofKeyThumbprint(deps.subtle, publicKeyJwk);

  // 2. The application's grant for exactly this key.
  const granted = await postJson(deps, `${base(input.bridgeUrl)}/play/grant`, { publicKeyThumbprint: thumbprint, challenge: toBase64Url(deps.randomBytes(32)) });
  const grant = record(granted.body['playGrant']);
  const signedPayload = text(grant['_signed_payload']), signature = text(grant['_signature']);
  if (!granted.ok || !signedPayload || !signature) throw new DurableGuestError('guest_grant_refused', text(granted.body['error']) ?? String(granted.status));

  // 3. Identity makes the owner, on proof that this browser holds the key the grant names.
  const proofPayload = `interego-play-provisional-v1\n${signedPayload}\n${signature}` + (termsVersion ? `\nHosted-Interego-Terms: ${termsVersion}` : '');
  const proof = toBase64Url(new Uint8Array(await deps.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, proofKey.privateKey, utf8(proofPayload))));
  const admitted = await postJson(deps, `${offer.identityUrl}/play/provisional`, {
    playGrant: { _signed_payload: signedPayload, _signature: signature }, publicKeyJwk, proof, ...(termsVersion ? { termsVersion } : {}) });
  const token = text(admitted.body['token']), userId = text(admitted.body['userId']), ownerDid = text(admitted.body['did']);
  const podUrl = text(admitted.body['podUrl']), attestation = text(admitted.body['attestation']), guestExpiresAt = text(admitted.body['guestExpiresAt']);
  if (!admitted.ok || admitted.body['provisional'] !== true || !token || !userId || !ownerDid || !podUrl || !attestation || !guestExpiresAt
    || !Number.isFinite(Date.parse(guestExpiresAt))) {
    throw new DurableGuestError(admitted.status === 428 ? 'guest_terms_required' : 'guest_not_admitted', text(admitted.body['error']) ?? String(admitted.status));
  }

  // 4. Which directory this application's guests write to: identity's word, read with the token.
  const me = await getJson(deps, `${offer.identityUrl}/me`, { Authorization: `Bearer ${token}` });
  const marker = record(me.body['provisionalPlay']);
  if (!me.ok || text(marker['audience']) !== offer.audience) throw new DurableGuestError('guest_not_admitted', 'identity did not confirm the guest');
  const namespace = marker['namespace'] === undefined ? DEFAULT_NAMESPACE : String(marker['namespace']);
  const checkpointUrl = await guestCheckpointUrl(deps.subtle, podUrl, ownerDid, namespace);

  // 5. Seal the phrase to a key whose secret only a non-extractable key of this browser unwraps.
  const sealing = nacl.box.keyPair.fromSecretKey(deps.randomBytes(nacl.box.secretKeyLength));
  const wrappingKey = await deps.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
  const iv = own(deps.randomBytes(12));
  const wrappedSecret = new Uint8Array(await deps.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, own(sealing.secretKey)));
  const envelope = seal(JSON.stringify({ kind: SEALED_KIND, phrase: input.phrase, address: input.address }), sealing, deps);
  sealing.secretKey.fill(0);

  // 6. Write it, once, as the gate requires of a guest: a native commit, created only if absent.
  let written;
  try {
    written = await deps.fetch(checkpointUrl, { method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': NATIVE_COMMIT, 'If-None-Match': '*' },
      body: JSON.stringify({ version: 1, expectedRevision: null, contentType: 'application/json', bodyBase64: toBase64(utf8(JSON.stringify(envelope))) }) });
  } catch { throw new DurableGuestError('guest_service_unreachable', new URL(checkpointUrl).host); }
  if (!written.ok) throw new DurableGuestError('guest_not_stored', String(written.status));

  const guest: StoredGuest = { version: 1, audience: offer.audience, identityUrl: offer.identityUrl, userId, ownerDid, address: input.address,
    checkpointUrl, guestExpiresAt, attestation, publicKeyJwk, proofKey, sealingPublicKey: toBase64(sealing.publicKey),
    wrappedSealingSecret: { iv, ciphertext: wrappedSecret }, wrappingKey };
  await deps.store.put(guest);
  return guest;
}

/** The guest this browser keeps, before it is opened: who it is and until when. Null when there is none, or it has expired (and is forgotten). */
export async function keptGuest(deps: Pick<DurableGuestDeps, 'store' | 'now'>): Promise<Pick<StoredGuest, 'address' | 'guestExpiresAt'> | null> {
  let guest: StoredGuest | undefined;
  try { guest = await deps.store.get(); } catch { return null; }
  if (!guest || guest.version !== 1) return null;
  if (!(Date.parse(guest.guestExpiresAt) > deps.now())) { await deps.store.delete().catch(() => undefined); return null; }
  return { address: guest.address, guestExpiresAt: guest.guestExpiresAt };
}

/**
 * Open the kept guest: its recovery phrase, from the sealed document, with keys only this browser
 * can use. Throws DurableGuestError when the document is gone (the pod was cleaned up, or the
 * guest deleted it) or does not open; the record is forgotten then, since it can never open again.
 */
export async function openKeptGuest(deps: DurableGuestDeps): Promise<{ phrase: string; address: string }> {
  const guest = await deps.store.get();
  if (!guest || guest.version !== 1 || !(Date.parse(guest.guestExpiresAt) > deps.now())) {
    await deps.store.delete().catch(() => undefined);
    throw new DurableGuestError('guest_expired');
  }
  let response;
  try { response = await deps.fetch(guest.checkpointUrl, { headers: { Accept: 'application/json' } }); }
  catch { throw new DurableGuestError('guest_service_unreachable', new URL(guest.checkpointUrl).host); }
  if (response.status === 404 || response.status === 410) { await deps.store.delete().catch(() => undefined); throw new DurableGuestError('guest_gone'); }
  if (!response.ok) throw new DurableGuestError('guest_service_unreachable', String(response.status));
  let envelope: unknown;
  try { envelope = JSON.parse(await response.text()); } catch { envelope = null; }
  const secretKey = new Uint8Array(await deps.subtle.decrypt({ name: 'AES-GCM', iv: own(guest.wrappedSealingSecret.iv) }, guest.wrappingKey, own(guest.wrappedSealingSecret.ciphertext)));
  const opened = open(envelope, { publicKey: fromBase64(guest.sealingPublicKey), secretKey });
  secretKey.fill(0);
  const sealed = record(opened === null ? null : JSON.parse(opened));
  const phrase = text(sealed['phrase']), address = text(sealed['address']);
  if (sealed['kind'] !== SEALED_KIND || !phrase || address !== guest.address) {
    await deps.store.delete().catch(() => undefined);
    throw new DurableGuestError('guest_unreadable');
  }
  return { phrase, address };
}

/** Forget the kept guest on this browser. The sealed document stays in the pod until its deadline; nothing can open it any more. */
export async function forgetKeptGuest(deps: Pick<DurableGuestDeps, 'store'>): Promise<void> {
  await deps.store.delete();
}

/** IndexedDB, one record. CryptoKey objects are stored as they are: structured clone keeps them non-extractable. */
export function indexedDbGuestStore(factory: IDBFactory = indexedDB): GuestStore {
  const DB = 'foxxi-durable-guest', STORE = 'guest', KEY = 'current';
  const db = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const request = factory.open(DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is unavailable'));
  });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const database = await db();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = work(database.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      });
    } finally { database.close(); }
  };
  return {
    get: () => run<StoredGuest | undefined>('readonly', store => store.get(KEY) as IDBRequest<StoredGuest | undefined>),
    put: async guest => { await run('readwrite', store => store.put(guest, KEY)); },
    delete: async () => { await run('readwrite', store => store.delete(KEY)); },
  };
}

/** The browser's own dependencies. */
export function browserGuestDeps(): DurableGuestDeps {
  return {
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
    subtle: crypto.subtle, store: indexedDbGuestStore(),
    randomBytes: length => crypto.getRandomValues(new Uint8Array(length)), now: Date.now,
  };
}
