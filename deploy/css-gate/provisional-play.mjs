import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const REVISION = /^sha256:[a-f0-9]{64}$/;
const ETAG = /^"(sha256:[a-f0-9]{64})(?:-[a-f0-9]{16})?"$/;
const TYPE = 'application/vnd.interego.native-commit+json';
export const PROVISIONAL_BUDGET_DOCUMENT = 'play-budget.json';

function bounded(value, fallback, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error('invalid provisional play storage limit');
  return parsed;
}

export function provisionalLimits(env = process.env) {
  return Object.freeze({
    lifetimeBytes: bounded(env.PROVISIONAL_PLAY_STORAGE_BYTES, 32 * 1024 * 1024, 128 * 1024 * 1024),
    lifetimeWrites: bounded(env.PROVISIONAL_PLAY_STORAGE_WRITES, 1024, 4096),
    resourceBytes: bounded(env.PROVISIONAL_PLAY_RESOURCE_BYTES, 4 * 1024 * 1024, 4 * 1024 * 1024),
    resources: 2,
  });
}

function refusal(status, code, detail) {
  return Object.assign(new Error(detail), { status, code });
}

/** Native commands are buffered before forwarding. Bound those buffers across users and retries. */
export function createProvisionalWriteLimiter() {
  const active = new Set();
  return userId => {
    if (active.size >= 8 || active.has(userId)) throw refusal(429, 'provisional_play_write_busy', 'Temporary character storage is busy; retry the latest checkpoint.');
    active.add(userId);
    let released = false;
    return () => { if (!released) { released = true; active.delete(userId); } };
  };
}

/** Only a trusted verifier can supply this marker. A malformed marker never becomes ordinary ownership. */
export function verifiedProvisional(data, now = Date.now()) {
  if (data.provisionalPlay === undefined) return undefined;
  const marker = data.provisionalPlay;
  let audience;
  try { audience = new URL(marker?.audience); } catch { /* refused below */ }
  const expectedSuffix = `:users:${data.userId}`;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
    || !/^u-try-play-[a-f0-9]{32}$/.test(data.userId)
    || typeof data.ownerDid !== 'string' || !data.ownerDid.startsWith('did:web:') || !data.ownerDid.endsWith(expectedSuffix)
    || !/^did:web:[a-zA-Z0-9.:%-]+:users:u-try-play-[a-f0-9]{32}$/.test(data.ownerDid)
    || !audience || audience.protocol !== 'https:' || audience.origin !== marker.audience
    || !/^[A-Za-z0-9_-]{43}$/.test(marker.proofKeyThumbprint)
    || !Number.isSafeInteger(marker.expiresAt) || marker.expiresAt * 1000 <= now
    || marker.expiresAt * 1000 > now + 7 * 24 * 60 * 60 * 1000 + 60_000) {
    throw refusal(401, 'provisional_play_invalid', 'provisional play credential is invalid or expired');
  }
  return Object.freeze({ audience: marker.audience, proofKeyThumbprint: marker.proofKeyThumbprint,
    expiresAt: marker.expiresAt, userId: data.userId, ownerDid: data.ownerDid });
}

export function provisionalCheckpointPaths(claims) {
  const owner = sha256(claims.ownerDid);
  return ['player-profile', 'player-profile-index'].map(kind =>
    `/${claims.userId}/hallowmarch/checkpoints/${sha256(`urn:graph:hallowmarch:${kind}:${owner}`)}.json`);
}

export function checkProvisionalTarget(claims, method, target, headers) {
  if (claims.expiresAt * 1000 <= Date.now()) throw refusal(401, 'provisional_play_expired', 'Keep your character to continue saving after the temporary session expires');
  if (method !== 'PUT' || target.search || !provisionalCheckpointPaths(claims).includes(target.pathname)) {
    throw refusal(403, 'provisional_play_scope', 'temporary play permits only its own bounded native character checkpoints');
  }
  if (String(headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== TYPE
    || headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
    throw refusal(415, 'provisional_play_native_required', 'temporary checkpoints require the native commit representation');
  }
  const initial = headers['if-none-match'] === '*' && !headers['if-match'];
  const expected = !headers['if-none-match'] && ETAG.exec(String(headers['if-match'] ?? ''))?.[1];
  if (!initial && !expected) throw refusal(428, 'provisional_play_conditional_required', 'temporary checkpoints require an exact native revision or initial absence');
  return initial ? null : expected;
}

export async function readProvisionalCommit(stream, expectedRevision, limits) {
  const maxWrapper = Math.ceil(limits.resourceBytes / 3) * 4 + 2048;
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxWrapper) throw refusal(413, 'provisional_play_resource_limit', 'temporary character checkpoint exceeds its size limit');
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  let command;
  try { command = JSON.parse(body.toString('utf8')); } catch { throw refusal(400, 'provisional_play_bad_commit', 'invalid native checkpoint command'); }
  if (!command || Array.isArray(command) || command.version !== 1 || command.expectedRevision !== expectedRevision
    || command.contentType !== 'application/json' || typeof command.bodyBase64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(command.bodyBase64)
    || Object.keys(command).some(key => !['version', 'expectedRevision', 'contentType', 'bodyBase64'].includes(key))) {
    throw refusal(400, 'provisional_play_bad_commit', 'native checkpoint command does not bind its conditional request');
  }
  const decoded = Buffer.from(command.bodyBase64, 'base64');
  if (decoded.length > limits.resourceBytes) throw refusal(413, 'provisional_play_resource_limit', 'temporary character checkpoint exceeds its size limit');
  let envelope;
  try { envelope = JSON.parse(decoded.toString('utf8')); } catch { /* refused below */ }
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'X25519-XSalsa20-Poly1305'
    || envelope.content?.algorithm !== 'XSalsa20-Poly1305' || !Array.isArray(envelope.wrappedKeys) || envelope.wrappedKeys.length !== 1) {
    throw refusal(400, 'provisional_play_encrypted_required', 'temporary character checkpoints must use the owner encrypted envelope');
  }
  return { body, bytes: decoded.length };
}

/** Reservations are native CAS writes in the guest pod. Restarts, new OAuth tokens and replicas share one budget. */
export async function reserveProvisionalWrite(claims, bytes, limits, storage) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limits.resourceBytes) {
    throw refusal(413, 'provisional_play_resource_limit', 'temporary character checkpoint exceeds its size limit');
  }
  const path = `/${claims.userId}/${PROVISIONAL_BUDGET_DOCUMENT}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (claims.expiresAt * 1000 <= Date.now()) throw refusal(401, 'provisional_play_expired', 'temporary play credential expired');
    const current = await storage.read(path);
    const record = current?.value ?? { version: 1, userId: claims.userId, ownerDid: claims.ownerDid,
      audience: claims.audience, proofKeyThumbprint: claims.proofKeyThumbprint, expiresAt: claims.expiresAt, bytes: 0, writes: 0 };
    if (record.version !== 1 || record.userId !== claims.userId || record.ownerDid !== claims.ownerDid
      || record.audience !== claims.audience || record.proofKeyThumbprint !== claims.proofKeyThumbprint || record.expiresAt !== claims.expiresAt
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !Number.isSafeInteger(record.writes) || record.writes < 0
      || current && !REVISION.test(current.revision)) {
      throw refusal(503, 'provisional_play_budget_unavailable', 'temporary character storage budget could not be verified');
    }
    if (record.bytes + bytes > limits.lifetimeBytes || record.writes + 1 > limits.lifetimeWrites) {
      const error = refusal(507, 'provisional_play_storage_limit', 'Temporary character storage is full. Keep your character to continue saving; your previous checkpoint is preserved.');
      error.remaining = remainingProvisional(record, limits);
      throw error;
    }
    const next = { ...record, bytes: record.bytes + bytes, writes: record.writes + 1 };
    if (await storage.compareAndSet(path, current?.revision ?? null, next)) return remainingProvisional(next, limits);
  }
  throw refusal(503, 'provisional_play_budget_busy', 'temporary character storage is busy; retry the latest checkpoint');
}

export function remainingProvisional(record, limits) {
  return { bytesRemaining: Math.max(0, limits.lifetimeBytes - record.bytes),
    writesRemaining: Math.max(0, limits.lifetimeWrites - record.writes), expiresAt: record.expiresAt };
}
