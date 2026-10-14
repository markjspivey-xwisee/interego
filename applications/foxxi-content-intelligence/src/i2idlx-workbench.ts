/**
 * I2IDL-X's optional pod-backed workspace. The pod holds author-signed documents;
 * the bridge is a verifier and conditional-write transport, never a database.
 * Private workspaces are encrypted to the owner AND a stable bridge key.
 */
import express, { type Express } from 'express';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import {
  createEncryptedEnvelope, openEncryptedEnvelope, deriveEncryptionKeyPair,
  makeWalletDelegationVerifier, type EncryptionKeyPair, type EncryptedEnvelope, type IRI,
} from '@interego/core';
import { readDelegationCredential, verifyAgentDelegation } from '@interego/solid';
import type { VerifyPrivateCaller } from './private-performance-auth.js';

export class WorkbenchError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
interface Envelope { _signed_payload: string; _signature: string }
interface RecordDocument {
  schema: 1; path: string; owner: string; actor: string; pod: string;
  document: Record<string, unknown>; proof: Envelope;
}
export interface WorkbenchConfig {
  baseUrl: string;
  sharedPodUrl?: string;
  /** Canonical own-pod identifiers admitted to this shared workbench. No user input expands this list. */
  participantIds: readonly string[];
  /** Exact cryptographically verified actor DIDs, configured by the deployment owner. */
  editorDids: readonly string[];
  /** Independently authenticated owner key bindings; never populated from unsigned pod bytes. */
  ownerAnchors?: Readonly<Record<string, string>>;
  verifyCaller: VerifyPrivateCaller;
  ownPod: (actor: string) => string;
  fetch: typeof fetch;
  encryptionKeypair: () => EncryptionKeyPair | null;
  /** Injection seam for deterministic tests; production rechecks on-pod delegation. */
  verifyAuthor?: (actor: string, signer: string, pod: string) => Promise<boolean>;
  siteDirectory?: string;
  distDirectory?: string;
}
const hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const isObject = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o);
const safeId = (s: string) => /^(?:u-pk-|u-did-|u-eth-|eth-)[a-z0-9]{8,64}$/.test(s);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Key choice is bound by the verified owner's signature, never by unsigned storage bytes. */
export function ownerKeyBinding(input: unknown): string | null {
  if (typeof input !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(input)) return null;
  const bytes = Buffer.from(input, 'base64');
  return bytes.length === 32 && bytes.some(b => b !== 0) && bytes.toString('base64') === input ? input : null;
}
function sameActor(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  return /^did:ethr:0x[0-9a-f]{40}$/i.test(a) && /^did:ethr:0x[0-9a-f]{40}$/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/** Deployment-pinned owner controls. A pod registry cannot self-assert its own trust root. */
export function workbenchOwnerAnchors(raw: string | undefined): Readonly<Record<string, string>> {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('FOXXI_I2IDLX_OWNER_ANCHORS must be a JSON object.'); }
  if (!isObject(parsed) || Object.keys(parsed).length > 1000 || Object.entries(parsed).some(([id, address]) => !safeId(id) || typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address))) {
    throw new Error('Invalid I2IDL-X pinned owner signing-address bindings.');
  }
  return parsed as Readonly<Record<string, string>>;
}
export function workbenchEncryptionKeypair(privateKey: string | undefined): EncryptionKeyPair | null {
  return privateKey && /^(0x)?[a-f0-9]{64}$/i.test(privateKey)
    ? deriveEncryptionKeyPair(privateKey, 'foxxi-i2idlx-workbench') : null;
}
/** Identity comes ONLY from the authenticated actor's own-pod resolver. */
export function workbenchUserId(pod: string): string {
  const u = new URL(pod), parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || !safeId(parts[0]!) || u.search || u.hash || u.username || u.password || u.protocol !== 'https:') {
    throw new WorkbenchError('A canonical own pod is required; shared-tenant fallback refused.', 403);
  }
  return parts[0]!;
}
function pathInfo(path: string): { kind: string; owner?: string; private: boolean } {
  const shared = /^(ballots|notes|usage)\/([^/]+)$/.exec(path);
  if (shared && safeId(shared[2]!)) return { kind: shared[1]!, owner: shared[2]!, private: false };
  if (path === 'settings/policy') return { kind: 'policy', private: false };
  const own = /^data\/users\/([^/]+)\/workspace$/.exec(path);
  if (own && safeId(own[1]!)) return { kind: 'workspace', owner: own[1]!, private: true };
  throw new WorkbenchError('Unknown workbench document path.');
}
/** Validate rather than silently truncate a signed document. */
export function validateWorkbenchDocument(path: string, input: unknown): Record<string, unknown> {
  const info = pathInfo(path);
  if (!isObject(input) || Buffer.byteLength(JSON.stringify(input), 'utf8') > 1_000_000) throw new WorkbenchError('Document must be an object no larger than 1 MB.', 413);
  if (Object.keys(input).some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new WorkbenchError('Unsafe document property.');
  const text = (x: unknown, max: number) => typeof x === 'string' && x.length <= max;
  const at = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  if (info.kind === 'policy') {
    if (Object.keys(input).some(k => k !== 'quorum') || !Number.isInteger(input.quorum) || Number(input.quorum) < 1 || Number(input.quorum) > 1000) throw new WorkbenchError('Policy requires quorum between 1 and 1000.');
  } else if (info.kind === 'workspace') {
    if (Object.keys(input).some(k => !['packs', 'stars', 'recents', 'at'].includes(k)) ||
        !Array.isArray(input.packs) || !Array.isArray(input.stars) ||
        input.packs.length > 1000 || input.stars.length > 10000 ||
        input.packs.some(p => !isObject(p) || !text(p.id, 200)) ||
        input.stars.some(s => !text(s, 200)) ||
        (input.recents !== undefined && (!Array.isArray(input.recents) || input.recents.length > 1000)) ||
        (input.at !== undefined && !at(input.at))) throw new WorkbenchError('Invalid private workspace.');
  } else {
    const field = info.kind === 'ballots' ? 'v' : info.kind === 'notes' ? 'n' : 'u';
    if (Object.keys(input).some(k => k !== field) || !isObject(input[field]) || Object.keys(input[field]).length > 10000) throw new WorkbenchError('Invalid shared document.');
    for (const [key, value] of Object.entries(input[field])) {
      if (!text(key, 240) || ['__proto__', 'constructor', 'prototype'].includes(key) || !isObject(value) || !at(value.at)) throw new WorkbenchError('Invalid document entry.');
      if (info.kind === 'ballots' && (!['for', 'against', 'abstain'].includes(String(value.vote)) || !text(value.note, 600) || Object.keys(value).some(k => !['vote', 'note', 'at'].includes(k)))) throw new WorkbenchError('Invalid ballot.');
      if (info.kind === 'notes' && (!text(value.c, 200) || !text(value.text, 2000) || Object.keys(value).some(k => !['c', 'text', 'at'].includes(k)))) throw new WorkbenchError('Invalid note.');
      if (info.kind === 'usage' && (!text(value.ctx, 140) || Object.keys(value).some(k => !['ctx', 'at'].includes(k)))) throw new WorkbenchError('Invalid usage entry.');
    }
  }
  return input;
}
function proofOf(body: unknown): Envelope {
  if (!isObject(body) || typeof body._signed_payload !== 'string' || typeof body._signature !== 'string' || body._session !== undefined) {
    throw new WorkbenchError('An owner/anchor signed request is required; ephemeral session-key proofs are not durable documents.', 401);
  }
  if (body._signed_payload.length > 1_100_000 || body._signature.length > 2000) throw new WorkbenchError('Signed request too large.', 413);
  return { _signed_payload: body._signed_payload, _signature: body._signature };
}
export class WorkbenchDocuments {
  constructor(readonly config: WorkbenchConfig) {}
  private requireShared(): string {
    if (!this.config.sharedPodUrl) throw new WorkbenchError('Shared workbench pod is not configured.', 503);
    const u = new URL(this.config.sharedPodUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new WorkbenchError('Invalid configured shared pod.', 503);
    return u.href.replace(/\/?$/, '/');
  }
  location(path: string, caller?: string): string {
    const info = pathInfo(path);
    const pod = info.private ? caller ? this.config.ownPod(caller) : '' : this.requireShared();
    if (info.private && workbenchUserId(pod) !== info.owner) throw new WorkbenchError('Private workspace belongs to another account.', 403);
    return pod.replace(/\/?$/, '/') + 'i2idlx/workbench/' + (info.private ? 'private/' : 'shared/') + hex(path) + '.json';
  }
  private async authorMatches(actor: string, signer: string, pod: string, write = true): Promise<boolean> {
    if (this.config.verifyAuthor) return this.config.verifyAuthor(actor, signer, pod);
    const direct = /^did:ethr:(0x[0-9a-f]{40})$/i.exec(actor)?.[1];
    if (direct && direct.toLowerCase() === signer.toLowerCase()) return true;
    // Credential verification and signer/scope binding must see the SAME bytes.
    // The storage provider cannot swap an unsigned second VC read into a checked chain.
    const snapshots = new Map<string, Promise<Response>>();
    const snapshotFetch: typeof fetch = async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return this.config.fetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      let response = snapshots.get(url);
      if (!response) { response = this.config.fetch(input, init); snapshots.set(url, response); }
      return (await response).clone();
    };
    const expectedOwner = this.config.ownerAnchors?.[workbenchUserId(pod)];
    if (!expectedOwner || !/^0x[0-9a-f]{40}$/i.test(expectedOwner) || signer.toLowerCase() !== expectedOwner.toLowerCase()) return false;
    const checked = await verifyAgentDelegation(actor as IRI, pod, { verifier: makeWalletDelegationVerifier(), fetch: snapshotFetch as never });
    if (!checked.valid || checked.trustLevel !== 'CryptographicallyVerified') return false;
    const vc = await readDelegationCredential(pod, actor as IRI, { fetch: snapshotFetch as never });
    return !!vc?.proof?.signerAddress && vc.proof.signerAddress.toLowerCase() === expectedOwner.toLowerCase() && vc.credentialSubject.id === actor &&
      (vc.credentialSubject.scope ?? []).includes('discover') && (!write || (vc.credentialSubject.scope ?? []).includes('publish')) &&
      vc.credentialSubject.pod.replace(/\/+$/, '') === pod.replace(/\/+$/, '');
  }
  async assertAuthor(body: unknown, caller: string, write = false): Promise<Envelope> {
    const proof = proofOf(body);
    try {
      const p: unknown = JSON.parse(proof._signed_payload);
      if (!isObject(p) || !sameActor(p.agent_id, caller)) throw new Error('actor mismatch');
      const signer = ethers.verifyMessage('sha256:' + hex(proof._signed_payload), proof._signature);
      const ownPod = this.config.ownPod(caller);
      workbenchUserId(ownPod);
      if (!await this.authorMatches(caller, signer, ownPod, write)) throw new Error('invalid author');
      return proof;
    } catch { throw new WorkbenchError('Request author signature/ownership could not be verified from a consistent delegation snapshot.', 401); }
  }
  /** Historical documents retain signatures, but are not replayed as fresh requests. */
  private async verifyRecord(raw: unknown, path: string): Promise<RecordDocument> {
    if (!isObject(raw) || raw.schema !== 1 || raw.path !== path || typeof raw.actor !== 'string' || typeof raw.pod !== 'string' || typeof raw.owner !== 'string') throw new WorkbenchError('Stored workbench document is malformed.', 503);
    try {
      const proof = proofOf(raw.proof);
      const p: unknown = JSON.parse(proof._signed_payload);
      if (!isObject(p) || !sameActor(p.agent_id, raw.actor) || p.i2idlx_operation !== 'write' || p.bridge_audience !== this.config.baseUrl.replace(/\/+$/, '') || p.doc_path !== path || !same(p.document, raw.document) || !Number.isFinite(Date.parse(String(p.timestamp)))) throw new Error('proof mismatch');
      const ownPod = this.config.ownPod(raw.actor);
      const owner = workbenchUserId(ownPod);
      const info = pathInfo(path);
      if (raw.pod !== ownPod || raw.owner !== owner || (info.owner !== undefined && info.owner !== owner)) throw new Error('owner mismatch');
      if (!info.private && !this.config.participantIds.includes(owner)) throw new Error('not a participant');
      if (info.kind === 'policy' && !this.config.editorDids.includes(raw.actor)) throw new Error('not an editor');
      const signer = ethers.verifyMessage('sha256:' + hex(proof._signed_payload), proof._signature);
      if (!await this.authorMatches(raw.actor, signer, ownPod)) throw new Error('author signature/delegation invalid');
      validateWorkbenchDocument(path, raw.document);
      return raw as unknown as RecordDocument;
    } catch { throw new WorkbenchError('Stored workbench document failed author/ownership verification.', 503); }
  }
  async read(path: string, caller?: string): Promise<{ exists: boolean; data: Record<string, unknown> | null; etag: string | null; resource_url: string }> {
    const info = pathInfo(path), url = this.location(path, caller);
    if (info.private && caller) {
      const root = await this.config.fetch(this.config.ownPod(caller), { method: 'HEAD', redirect: 'manual' });
      if (!root.ok) throw new WorkbenchError('An existing own pod is required; this workbench does not register or create accounts.', 403);
    }
    const r = await this.config.fetch(url, { headers: { Accept: 'application/json' }, redirect: 'manual' });
    if (r.status === 404 || r.status === 410) return { exists: false, data: null, etag: null, resource_url: url };
    if (!r.ok) throw new WorkbenchError('Workbench pod read is unavailable; no empty-state fallback.', 503);
    const text = await r.text();
    if (Buffer.byteLength(text) > 2_000_000) throw new WorkbenchError('Stored document exceeds capacity.', 503);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new WorkbenchError('Stored document is not JSON.', 503); }
    if (info.private) {
      const kp = this.config.encryptionKeypair();
      if (!kp) throw new WorkbenchError('Stable private-workspace encryption is unavailable.', 503);
      let plaintext: string | null = null;
      try { plaintext = openEncryptedEnvelope(raw as EncryptedEnvelope, kp); } catch { /* refusal below */ }
      if (!plaintext) throw new WorkbenchError('Private workspace cannot be decrypted; plaintext fallback refused.', 503);
      try { raw = JSON.parse(plaintext); } catch { throw new WorkbenchError('Decrypted workspace is malformed.', 503); }
    }
    const record = await this.verifyRecord(raw, path);
    if (info.private) {
      const payload = JSON.parse(record.proof._signed_payload) as Record<string, unknown>;
      const ownerKey = ownerKeyBinding(payload.owner_encryption_key);
      const parsed: unknown = JSON.parse(text);
      if (!ownerKey || !isObject(parsed) || parsed.version !== 1 || parsed.algorithm !== 'X25519-XSalsa20-Poly1305' ||
          !Array.isArray(parsed.wrappedKeys) || !parsed.wrappedKeys.some(w => isObject(w) && w.recipientPublicKey === ownerKey)) {
        throw new WorkbenchError('Private envelope does not contain the author-signed owner recipient.', 503);
      }
    }
    return { exists: true, data: record.document, etag: r.headers.get('etag'), resource_url: url };
  }
  async write(body: unknown) {
    const proof = proofOf(body);
    const auth = await this.config.verifyCaller(body, true);
    if (!auth.ok) throw new WorkbenchError(auth.error, auth.status);
    await this.assertAuthor(body, auth.callerDid, true);
    const p = auth.payload, path = typeof p.doc_path === 'string' ? p.doc_path : '';
    if (p.i2idlx_operation !== 'write' || p.bridge_audience !== this.config.baseUrl.replace(/\/+$/, '')) throw new WorkbenchError('Write proof is not bound to this workbench.', 403);
    const info = pathInfo(path), pod = this.config.ownPod(auth.callerDid), owner = workbenchUserId(pod);
    if (info.owner !== undefined && info.owner !== owner) throw new WorkbenchError('A viewer writes only their own document.', 403);
    if (!info.private && !this.config.participantIds.includes(owner)) throw new WorkbenchError('Account is not admitted to this shared workbench.', 403);
    if (info.kind === 'policy' && !this.config.editorDids.includes(auth.callerDid)) throw new WorkbenchError('Only configured verified editor identities may change policy.', 403);
    const root = await this.config.fetch(pod, { method: 'HEAD', redirect: 'manual' });
    if (!root.ok) throw new WorkbenchError('An existing own pod is required; no account provisioning is performed.', 403);
    const document = validateWorkbenchDocument(path, p.document);
    const expected = p.expected_etag === '' ? null : p.expected_etag;
    if (expected !== null && (typeof expected !== 'string' || !/^"(?:[^"\r\n]{1,200})"$/.test(expected))) throw new WorkbenchError('Signed expected_etag (strong ETag or empty string for create) is required.');
    const current = await this.read(path, auth.callerDid);
    if (current.exists && !current.etag) throw new WorkbenchError('Pod supplied no ETag; unsafe overwrite refused.', 503);
    if (expected !== current.etag || (current.exists && expected === null)) throw new WorkbenchError('Document changed on another device; read it again before signing a new write.', 409);
    const record: RecordDocument = { schema: 1, path, owner, actor: auth.callerDid, pod, document, proof };
    // Validate the EXACT retained proof too; a verifier must not rewrite or decorate its signed body.
    await this.verifyRecord(record, path);
    let stored: unknown = record;
    if (info.private) {
      const kp = this.config.encryptionKeypair(), ownerKey = ownerKeyBinding(p.owner_encryption_key);
      if (!kp || !ownerKey) throw new WorkbenchError('An author-signed owner encryption key and stable bridge encryption are required; unsigned pod keys and plaintext/bridge-only storage refused.', 503);
      stored = createEncryptedEnvelope(JSON.stringify(record), [...new Set([ownerKey, kp.publicKey])], kp);
    }
    if (!current.exists) {
      const targetPod = info.private ? pod : this.requireShared();
      for (const suffix of ['i2idlx/', 'i2idlx/workbench/', 'i2idlx/workbench/' + (info.private ? 'private/' : 'shared/')]) {
        const made = await this.config.fetch((targetPod.endsWith('/') ? targetPod : targetPod + '/') + suffix, {
          method: 'PUT', redirect: 'manual', headers: { 'Content-Type': 'text/turtle', 'If-None-Match': '*', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '',
        });
        if (!made.ok && made.status !== 412) throw new WorkbenchError('Workbench document container could not be confirmed.', 503);
      }
    }
    const r = await this.config.fetch(current.resource_url, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(expected === null ? { 'If-None-Match': '*' } : { 'If-Match': expected }) }, body: JSON.stringify(stored), redirect: 'manual' });
    if (r.status === 412) throw new WorkbenchError('Conditional pod write conflicted; read and merge before retry.', 409);
    if (!r.ok) throw new WorkbenchError('Pod did not confirm the workspace write.', 503);
    const confirmed = await this.read(path, auth.callerDid);
    if (!confirmed.exists || !same(confirmed.data, document)) throw new WorkbenchError('Workspace write could not be read back unchanged; completion unconfirmed.', 503);
    return { ok: true, durable: true, ...confirmed };
  }
  async collection(kind: string) {
    this.requireShared();
    if (!['ballots', 'notes', 'usage'].includes(kind)) throw new WorkbenchError('Unknown shared collection.');
    const docs = await Promise.all(this.config.participantIds.map(async id => ({ id, ...await this.read(kind + '/' + id) })));
    return { docs };
  }
}
export function attachWorkbenchRoutes(app: Express, config: WorkbenchConfig): void {
  if (config.participantIds.length > 1000 || config.participantIds.some(id => !safeId(id)) || new Set(config.participantIds).size !== config.participantIds.length) throw new Error('Invalid workbench participant configuration.');
  const docs = new WorkbenchDocuments(config);
  const challenges = new Map<string, number>();
  const base = config.baseUrl.replace(/\/+$/, '');
  const reply = (res: express.Response, value: unknown) => { res.set('Cache-Control', 'no-store').json(value); };
  const refuse = (res: express.Response, error: unknown) => {
    const known = error instanceof WorkbenchError;
    res.status(known ? error.status : 503).set('Cache-Control', 'no-store').json({ error: known ? error.message : 'Workbench operation unavailable.', code: known && error.status === 409 ? 'conflict' : 'unavailable' });
  };
  const binding = async (body: unknown, operation: string, write = false) => {
    const auth = await config.verifyCaller(body, write);
    if (!auth.ok) throw new WorkbenchError(auth.error, auth.status);
    await docs.assertAuthor(body, auth.callerDid, write);
    if (auth.payload.i2idlx_operation !== operation || auth.payload.bridge_audience !== base) throw new WorkbenchError('Signed request is not bound to this operation and workbench.', 403);
    return auth;
  };
  app.get('/i2idlx/challenge', (_req, res) => {
    for (const [nonce, expires] of challenges) if (expires <= Date.now()) challenges.delete(nonce);
    if (challenges.size >= 4096) { res.status(429).json({ error: 'Too many pending sign-in challenges.' }); return; }
    const nonce = randomBytes(32).toString('hex');
    const expires = Date.now() + 60000;
    challenges.set(nonce, expires);
    reply(res, { nonce, expires_at: new Date(expires).toISOString(), audience: base });
  });
  app.get('/i2idlx/capabilities', (_req, res) => reply(res, {
    audience: base, shared: !!config.sharedPodUrl, ai: { project_paid: false, subscription: 'client MCP sampling adapter', api_key: 'client memory only' },
    connection: 'Connect Interego in your AI client, or connect a browser wallet with an existing pod.',
    _affordances: [
      { action: 'urn:iep:action:foxxi:i2idlx-challenge', href: base + '/i2idlx/challenge', method: 'GET' },
      { action: 'urn:iep:action:foxxi:i2idlx-session', href: base + '/i2idlx/api/session', method: 'POST' },
      { action: 'urn:iep:action:foxxi:i2idlx-read', href: base + '/i2idlx/api/read', method: 'POST' },
      { action: 'urn:iep:action:foxxi:i2idlx-write', href: base + '/i2idlx/api/write', method: 'POST' },
    ],
  }));
  app.post('/i2idlx/api/session', async (req, res) => {
    try {
      const auth = await binding(req.body, 'session'), nonce = auth.payload.nonce;
      if (typeof nonce !== 'string' || (challenges.get(nonce) ?? 0) <= Date.now()) throw new WorkbenchError('Server-issued sign-in nonce is absent, expired or already used.', 401);
      challenges.delete(nonce);
      const own = config.ownPod(auth.callerDid), id = workbenchUserId(own);
      const root = await config.fetch(own, { method: 'HEAD', redirect: 'manual' });
      if (!root.ok) throw new WorkbenchError('Connect an existing Interego pod; this workbench does not create accounts.', 403);
      const writable = await config.verifyCaller(req.body, true);
      reply(res, { me: { id, did: auth.callerDid, name: id, canEdit: config.editorDids.includes(auth.callerDid), isOwner: false },
        canWrite: writable.ok, sharedWrite: writable.ok && config.participantIds.includes(id), privateEncryption: !!config.encryptionKeypair() && !!ownerKeyBinding(auth.payload.owner_encryption_key) });
    } catch (e) { refuse(res, e); }
  });
  app.post('/i2idlx/api/read', async (req, res) => {
    try {
      const auth = await binding(req.body, 'read'), p = auth.payload;
      if (p.collection === 'all') {
        const [ballots, notes, usage, policy] = await Promise.all([docs.collection('ballots'), docs.collection('notes'), docs.collection('usage'), docs.read('settings/policy')]);
        reply(res, { ballots, notes, usage, policy });
      } else if (typeof p.collection === 'string') reply(res, await docs.collection(p.collection));
      else if (typeof p.doc_path === 'string') reply(res, await docs.read(p.doc_path, auth.callerDid));
      else throw new WorkbenchError('collection or doc_path is required.');
    } catch (e) { refuse(res, e); }
  });
  app.post('/i2idlx/api/write', async (req, res) => { try { reply(res, await docs.write(req.body)); } catch (e) { refuse(res, e); } });
  const site = config.siteDirectory ?? fileURLToPath(new URL('../i2idlx/site-ts/', import.meta.url));
  const serve = (file: string): express.RequestHandler => (_req, res) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(file, { root: site }, e => { if (e && !res.headersSent) res.status(503).type('text').send('I2IDL-X build artifacts are not available on this deployment.'); });
  };
  app.get(['/i2idlx', '/i2idlx/', '/i2idlx/workbench'], serve('app.html'));
  app.get(['/i2idlx/reference', '/i2idlx/reference/'], serve('index.html'));
  const dist = config.distDirectory ?? fileURLToPath(new URL('../i2idlx/dist-ts/', import.meta.url));
  app.use('/i2idlx/dist', (req, res, next) => {
    if (!/\.(?:ttl|trig|json|jsonld|rq|md|zip|csv|ndjson)$/i.test(req.path)) { res.status(404).end(); return; }
    res.set('X-Content-Type-Options', 'nosniff'); next();
  }, express.static(dist, { dotfiles: 'deny', index: false, redirect: false, fallthrough: true }));
}
