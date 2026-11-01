import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyMessage } from 'ethers';

const MAX_BYTES = 16 * 1024 * 1024;
const SIGNED_BYTES = 64 * 1024;
const WINDOW_MS = 60_000;
const FUTURE_MS = 5_000;
const AUTH_ACTION = 'urn:interego:health:authenticate';
const localQueues = new Map();
const securityQueues = new WeakMap();
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class HealthSecurityError extends Error {
  constructor(code, status = 401) { super(code); this.name = 'HealthSecurityError'; this.code = code; this.status = status; }
}
const reject = (code, status) => { throw new HealthSecurityError(code, status); };

function serviceUrl(value, label) {
  let u;
  try { u = new URL(value); } catch { reject(`${label}_invalid`, 503); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) || u.username || u.password || u.search || u.hash) reject(`${label}_invalid`, 503);
  return u;
}

async function queued(queues, key, work) {
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise(done => { release = done; });
  const current = previous.catch(() => {}).then(() => gate);
  queues.set(key, current);
  await previous.catch(() => {});
  try { return await work(); } finally { release(); if (queues.get(key) === current) queues.delete(key); }
}

async function responseJson(response, limit = MAX_BYTES) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) reject('upstream_response_too_large', 502);
  let bytes = 0;
  const chunks = [];
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) { await reader.cancel(); reject('upstream_response_too_large', 502); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  } else {
    const value = Buffer.from(await response.arrayBuffer());
    if (value.length > limit) reject('upstream_response_too_large', 502);
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject('upstream_invalid_json', 502); }
}

// The relay's OAuth credentials are accepted by /mcp. Its REST shortcut accepts
// identity-server credentials instead. Keep this challenge on the OAuth resource
// the browser authorized, and correlate the MCP answer before checking its proof.
async function signedToolResponse(response, id) {
  const message = value => {
    if (!isObject(value) || value.jsonrpc !== '2.0' || value.id !== id) return null;
    if (value.error || !isObject(value.result) || value.result.isError) reject('authentication_response_invalid', 502);
    const result = value.result;
    let envelope = result.structuredContent;
    if (!isObject(envelope)) {
      const text = Array.isArray(result.content) ? result.content.find(part => part?.type === 'text' && typeof part.text === 'string')?.text : undefined;
      try { envelope = JSON.parse(text); } catch { reject('authentication_response_invalid', 502); }
    }
    if (!isObject(envelope) || envelope.error) reject('authentication_response_invalid', 502);
    return envelope;
  };
  const type = response.headers.get('content-type') || '';
  if (/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(type)) {
    const result = message(await responseJson(response, SIGNED_BYTES));
    if (!result) reject('authentication_response_invalid', 502);
    return result;
  }
  if (!/^text\/event-stream(?:;|$)/i.test(type) || !response.body?.getReader) reject('authentication_response_invalid', 502);
  if (Number(response.headers.get('content-length')) > SIGNED_BYTES) reject('upstream_response_too_large', 502);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > SIGNED_BYTES) reject('upstream_response_too_large', 502);
      pending += decoder.decode(value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/); pending = events.pop();
      for (const event of events) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let parsed; try { parsed = JSON.parse(data); } catch { continue; }
        const result = message(parsed);
        if (result) return result;
      }
    }
    reject('authentication_response_invalid', 502);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/**
 * A server-side encrypted key/value store. Logical keys and values are encrypted together;
 * filenames are SHA-256 identifiers. The authenticated AAD binds root, logical key and path.
 * Solid writes use ETag / If-None-Match CAS. Filesystem mode is for one Node process only.
 * update(key, fn) is an atomic read/modify/write within that model and is used for replay state.
 */
export function createEncryptedStore({ keyHex, rootUrl, fetch: fetchImpl = globalThis.fetch, directory, authorization } = {}) {
  if (typeof keyHex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(keyHex)) reject('storage_key_must_be_32_bytes', 503);
  if (Boolean(rootUrl) === Boolean(directory)) reject('configure_one_storage_backend', 503);
  if (authorization !== undefined && (typeof authorization !== 'string' || !authorization || /[\r\n]/.test(authorization))) reject('storage_authorization_invalid', 503);
  const key = Buffer.from(keyHex, 'hex');
  const root = rootUrl ? serviceUrl(rootUrl, 'storage_root') : null;
  if (root && !root.pathname.endsWith('/')) reject('storage_root_requires_trailing_slash', 503);
  const dir = directory ? resolve(directory) : null;
  const namespace = root?.href ?? `file:${dir}`;
  const knownVersions = new Map();
  const ensureKey = logical => { if (typeof logical !== 'string' || !logical || logical.length > 2048 || /[\u0000-\u001f]/.test(logical)) reject('storage_key_invalid', 400); return hash(logical); };
  const aad = (logical, digest) => Buffer.from(`interego-health:v1\0${namespace}\0${digest}\0${logical}`, 'utf8');
  const encode = (logical, value) => {
    if (value === undefined) reject('storage_value_not_serializable', 400);
    let plain;
    try { plain = Buffer.from(JSON.stringify({ key: logical, value }), 'utf8'); } catch { reject('storage_value_not_serializable', 400); }
    if (plain.length > MAX_BYTES / 2) reject('storage_value_too_large', 413);
    const digest = ensureKey(logical), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(logical, digest));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.from(JSON.stringify({ v: 1, alg: 'A256GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
  };
  const decode = (logical, encoded) => {
    try {
      const envelope = typeof encoded === 'object' && !Buffer.isBuffer(encoded) ? encoded : JSON.parse(encoded.toString('utf8'));
      if (!isObject(envelope) || envelope.v !== 1 || envelope.alg !== 'A256GCM') throw new Error();
      const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16 || typeof envelope.ciphertext !== 'string') throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad(logical, ensureKey(logical))); decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      const data = JSON.parse(plain.toString('utf8'));
      if (!isObject(data) || data.key !== logical || !Object.hasOwn(data, 'value')) throw new Error();
      return data.value;
    } catch { reject('storage_integrity_failure', 503); }
  };
  const headers = extra => ({ Accept: 'application/json', ...(authorization ? { Authorization: authorization } : {}), ...extra });
  const request = async (logical, options = {}) => {
    const url = new URL(`${ensureKey(logical)}.json`, root).href;
    try { return await fetchImpl(url, { ...options, headers: headers(options.headers), redirect: 'error', signal: AbortSignal.timeout(10_000) }); } catch { reject('storage_unavailable', 503); }
  };
  const read = async logical => {
    const digest = ensureKey(logical);
    if (root) {
      const response = await request(logical);
      if (response.status === 404) return { value: null, version: null };
      if (!response.ok) reject('storage_read_failed', 503);
      const version = response.headers.get('etag');
      if (!version || version.startsWith('W/')) reject('storage_strong_etag_required', 503);
      return { value: decode(logical, await responseJson(response)), version };
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(resolve(dir, `${digest}.json`), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) reject('storage_file_invalid', 503);
      const encoded = await handle.readFile();
      return { value: decode(logical, encoded), version: hash(encoded.toString('utf8')) };
    } catch (error) {
      if (error.code === 'ENOENT') return { value: null, version: null };
      if (error instanceof HealthSecurityError) throw error;
      reject('storage_read_failed', 503);
    } finally { await handle?.close(); }
  };
  const write = async (logical, value, version) => {
    const encoded = encode(logical, value);
    if (root) {
      const response = await request(logical, { method: 'PUT', body: encoded, headers: { 'Content-Type': 'application/json', ...(version === null ? { 'If-None-Match': '*' } : { 'If-Match': version }) } });
      if (response.status === 412 || response.status === 409) reject('storage_conflict', 409);
      if (!response.ok) reject('storage_write_failed', 503);
      knownVersions.delete(logical); return;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const destination = resolve(dir, `${ensureKey(logical)}.json`);
    const temp = resolve(dir, `.${ensureKey(logical)}.${randomBytes(8).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600); await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
      await rename(temp, destination);
    } catch (error) {
      if (error instanceof HealthSecurityError) throw error;
      reject('storage_write_failed', 503);
    } finally { await handle?.close(); await unlink(temp).catch(() => {}); }
  };
  const lock = (logical, fn) => queued(localQueues, `${namespace}\0${ensureKey(logical)}`, fn);
  return {
    async get(logical) { return lock(logical, async () => { const found = await read(logical); knownVersions.set(logical, found.version); return found.value; }); },
    async put(logical, value) { return lock(logical, async () => { const version = knownVersions.has(logical) ? knownVersions.get(logical) : (await read(logical)).version; await write(logical, value, version); knownVersions.delete(logical); }); },
    async remove(logical) { return lock(logical, async () => {
      const found = await read(logical); if (found.version === null) return;
      if (root) {
        const response = await request(logical, { method: 'DELETE', headers: { 'If-Match': found.version } });
        if (response.status === 412) reject('storage_conflict', 409);
        if (!response.ok && response.status !== 404) reject('storage_delete_failed', 503);
      } else await unlink(resolve(dir, `${ensureKey(logical)}.json`));
      knownVersions.delete(logical);
    }); },
    async update(logical, transform) { return lock(logical, async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const found = await read(logical); const next = await transform(found.value);
        try { await write(logical, next, found.version); knownVersions.delete(logical); return next; } catch (error) {
          if (!root || error.code !== 'storage_conflict' || attempt === 3) throw error;
        }
      }
    }); },
  };
}

/**
 * Authentication trusts the configured relay signer and identity host. It establishes an
 * Interego principal, NOT patient consent or authority over another patient's record.
 * Callers must separately enforce owner/resource permissions and use returned .payload.
 */
export function createSecurity({ relayUrl, identityHost, trustedRelayAddresses, store, targetOrigin, now = Date.now, fetch: fetchImpl = globalThis.fetch } = {}) {
  const relay = serviceUrl(relayUrl, 'relay');
  if (typeof identityHost !== 'string' || !/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(identityHost)) reject('identity_host_invalid', 503);
  const trusted = new Set((trustedRelayAddresses ?? []).map(x => String(x).toLowerCase()));
  if (!trusted.size || [...trusted].some(x => !/^0x[0-9a-f]{40}$/.test(x))) reject('trusted_relay_required', 503);
  if (!store?.get || !store?.put) reject('durable_security_store_required', 503);
  const bridgeOrigin = targetOrigin ? serviceUrl(targetOrigin, 'target').origin : null;
  const didCache = new Map();
  let replayQueue = securityQueues.get(store); if (!replayQueue) { replayQueue = new Map(); securityQueues.set(store, replayQueue); }
  const fetchResponse = async (url, options = {}) => {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) }); } catch { reject('authentication_upstream_unavailable', 503); }
    if (!response.ok) reject(response.status === 401 || response.status === 403 ? 'authentication_required' : 'authentication_upstream_unavailable', response.status === 401 || response.status === 403 ? 401 : 503);
    return response;
  };
  const fetchJson = async (url, options = {}, max = SIGNED_BYTES) => responseJson(await fetchResponse(url, options), max);
  const claimReplay = async (agentId, nonce, timestamp) => {
    const replayKey = hash(`${agentId}\0${nonce}`), t = now();
    const transform = current => {
      if (current !== null && (!isObject(current) || current.v !== 1 || !isObject(current.entries))) reject('replay_store_invalid', 503);
      const entries = Object.fromEntries(Object.entries(current?.entries ?? {}).filter(([, expiry]) => Number.isFinite(expiry) && expiry > t));
      if (Object.hasOwn(entries, replayKey)) reject('signed_request_replayed', 409);
      if (Object.keys(entries).length >= 4096) reject('authentication_capacity_reached', 429);
      entries[replayKey] = timestamp + WINDOW_MS + 1;
      return { v: 1, entries };
    };
    if (store.update) await store.update('security/replay-ledger', transform);
    else await queued(replayQueue, 'ledger', async () => { const next = transform(await store.get('security/replay-ledger')); await store.put('security/replay-ledger', next); });
  };
  async function authenticateSigned(envelope, expectedAction, target) {
    if (!isObject(envelope) || typeof envelope._signed_payload !== 'string' || Buffer.byteLength(envelope._signed_payload) > SIGNED_BYTES || !/^0x[0-9a-fA-F]{130}$/.test(envelope._signature ?? '')) reject('signed_envelope_invalid');
    let payload;
    try { payload = JSON.parse(envelope._signed_payload); } catch { reject('signed_payload_invalid'); }
    if (!isObject(payload)) reject('signed_payload_invalid');
    const origin = serviceUrl(target, 'target').origin;
    if (typeof expectedAction !== 'string' || !expectedAction || payload.action !== expectedAction) reject('signed_action_mismatch', 403);
    if (payload.target !== origin && payload.target !== `${origin}/`) reject('signed_target_mismatch', 403);
    if (typeof payload.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(payload.timestamp)) reject('signed_timestamp_invalid');
    const stamp = Date.parse(payload.timestamp), t = now();
    if (!Number.isFinite(stamp) || stamp < t - WINDOW_MS || stamp > t + FUTURE_MS) reject('signed_timestamp_stale');
    if (typeof payload.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce)) reject('signed_nonce_invalid');
    let signer;
    try { signer = verifyMessage(`sha256:${hash(envelope._signed_payload)}`, envelope._signature).toLowerCase(); } catch { reject('signed_signature_invalid'); }
    if (!trusted.has(signer)) reject('signed_relay_untrusted');
    const prefix = `did:web:${identityHost}:agents:`;
    if (typeof payload.agent_id !== 'string' || !payload.agent_id.startsWith(prefix)) reject('signed_agent_invalid');
    const slug = payload.agent_id.slice(prefix.length);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(slug)) reject('signed_agent_invalid');
    let document = didCache.get(payload.agent_id);
    if (!document || document.expires <= t) {
      const data = await fetchJson(`https://${identityHost}/agents/${encodeURIComponent(slug)}/did.json`, { headers: { Accept: 'application/did+json, application/json' } });
      document = { data, expires: t + 60_000 };
      if (didCache.size >= 1024) didCache.delete(didCache.keys().next().value);
      didCache.set(payload.agent_id, document);
    }
    const doc = document.data, userPrefix = `did:web:${identityHost}:users:`;
    if (!isObject(doc) || doc.id !== payload.agent_id || typeof doc.controller !== 'string' || !doc.controller.startsWith(userPrefix)) reject('signed_agent_controller_invalid');
    const userId = doc.controller.slice(userPrefix.length);
    if (!/^u-(?:pk|eth|did)-[0-9a-f]{12}$/.test(userId) || !slug.endsWith(`-${userId}`)) reject('signed_agent_controller_mismatch');
    let pod;
    try { pod = serviceUrl(payload.subject_pod_url, 'subject_pod'); } catch { reject('signed_subject_pod_invalid'); }
    if (pod.protocol !== 'https:' || !pod.pathname.endsWith(`/${userId}/`)) reject('signed_subject_pod_mismatch');
    await claimReplay(payload.agent_id, payload.nonce, stamp);
    return { userId, principal: doc.controller, agentId: payload.agent_id, podUrl: pod.href, scopes: [], authentication: 'relay-delegated', capabilities: ['relay:sign_request'], payload };
  }
  async function authenticateBearer(authorization) {
    if (typeof authorization !== 'string' || authorization.length > 8192 || !/^Bearer [A-Za-z0-9._~+\/-]+=*$/.test(authorization)) reject('authentication_required');
    if (!bridgeOrigin) reject('target_origin_required_for_bearer', 503);
    const nonce = randomBytes(24).toString('base64url');
    const id = randomBytes(16).toString('hex');
    const response = await fetchResponse(`${relay.href.replace(/\/$/, '')}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', Authorization: authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'sign_request', arguments: { payload: { action: AUTH_ACTION, target: bridgeOrigin, nonce } } } }),
    });
    const result = await signedToolResponse(response, id);
    const actor = await authenticateSigned(result, AUTH_ACTION, bridgeOrigin);
    if (actor.payload.nonce !== nonce) reject('authentication_challenge_mismatch');
    return actor;
  }
  return { authenticateBearer, authenticateSigned };
}
