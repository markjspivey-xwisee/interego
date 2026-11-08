/** Service-owned encrypted connector metadata. Never stores course bodies or progress. */
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { NativeCommitStore, createNativeByteArtifact, readNativeByteArtifact } from '@interego/pgsl';
import { emptyLearningState, validateLearningState, type LearningRepository, type LearningState } from './i2idlx-learning-connections.js';

const FORMAT = 'i2idlx.learning-connections/v1';
// Atomic checkpoints use the native rolling-checkpoint envelope; the inner
// FORMAT and exact owner/pod/head bind this feature's encrypted payload.
const TYPE = 'application/vnd.interego.rolling-checkpoint+gzip';
export const LEARNING_REPOSITORY_LIMITS = Object.freeze({ jsonBytes: 2 * 1024 * 1024, gzipBytes: 320 * 1024, encryptedBytes: 1024 * 1024 });
export class LearningRepositoryError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code === 'learning_store_conflict' ? 'The learning connection changed. Refresh it before retrying.'
      : code === 'learning_store_unconfirmed' ? 'Saving this learning connection was not confirmed. Refresh before retrying.'
      : 'The encrypted learning connection store is unavailable.');
  }
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface LearningRepositoryConfig { baseUrl: string; podUrl: string; privateKey: string; fetch: typeof fetch; }

/** Public storage contains ciphertext only; confidentiality does not depend on public pod ACLs. */
export function createLearningRepository(config: LearningRepositoryConfig): LearningRepository {
  if (!/^(?:0x)?[a-f0-9]{64}$/i.test(config.privateKey)) throw new LearningRepositoryError(503, 'learning_store_unavailable');
  const base = new URL(config.baseUrl), pod = new URL(config.podUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || pod.protocol !== 'https:' || pod.username || pod.password || pod.search || pod.hash || !/^\/[A-Za-z0-9_-]+\/$/.test(pod.pathname)) {
    throw new LearningRepositoryError(503, 'learning_store_unavailable');
  }
  const partition = createHash('sha256').update(base.origin).digest('hex').slice(0, 32);
  const owner = new URL('/i2idlx/learning/service', base).href as IRI;
  const scope = { owner, pod: pod.href, headUrl: new URL('foxxi/learning-connections/' + partition + '/checkpoint', pod).href,
    artifactContainer: new URL('foxxi/learning-connections/' + partition + '/artifacts/', pod).href };
  const key = deriveEncryptionKeyPair(config.privateKey, 'urn:foxxi:i2idlx-learning-connections:v1:' + base.origin);
  const native = new NativeCommitStore({ scope, atomicCheckpoint: true, senderKeyPair: key,
    ownerPublicKey: key.publicKey, recipientPublicKeys: [key.publicKey], maxArtifactBytes: LEARNING_REPOSITORY_LIMITS.encryptedBytes,
    fetch: async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.href !== scope.headUrl || !['GET', 'HEAD', 'OPTIONS', 'PUT'].includes(method)) throw new LearningRepositoryError(503, 'learning_store_unavailable');
      return config.fetch(input, { ...init, method, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    } });
  const decode = (snapshot: Awaited<ReturnType<typeof native.readAtomicCheckpoint>>): LearningState => {
    // Native read returns absent only for an actual404. Authentication, transport,
    // decryption and integrity failures propagate instead of resetting the registry.
    if (!snapshot.artifact) return emptyLearningState();
    const artifact = readNativeByteArtifact(snapshot.artifact);
    if (artifact.owner !== owner || artifact.contentType !== TYPE || artifact.bytes.length > LEARNING_REPOSITORY_LIMITS.gzipBytes) {
      throw new LearningRepositoryError(503, 'learning_store_unavailable');
    }
    const value: unknown = JSON.parse(gunzipSync(artifact.bytes, { maxOutputLength: LEARNING_REPOSITORY_LIMITS.jsonBytes }).toString('utf8'));
    if (!plain(value) || value.format !== FORMAT || value.owner !== owner || value.pod !== scope.pod || value.head !== scope.headUrl
      || Object.keys(value).some(k => !['format', 'owner', 'pod', 'head', 'state'].includes(k))) throw new LearningRepositoryError(503, 'learning_store_unavailable');
    return validateLearningState(value.state);
  };
  return Object.freeze({
    async read() {
      try { const snapshot = await native.readAtomicCheckpoint(); return { revision: snapshot.revision, state: decode(snapshot) }; }
      catch { throw new LearningRepositoryError(503, 'learning_store_unavailable'); }
    },
    async write(expectedRevision: string | null, input: LearningState) {
      let state: LearningState;
      try { state = validateLearningState(input); } catch { throw new LearningRepositoryError(503, 'learning_store_unavailable'); }
      const body = Buffer.from(JSON.stringify({ format: FORMAT, owner, pod: scope.pod, head: scope.headUrl, state }));
      if (body.length > LEARNING_REPOSITORY_LIMITS.jsonBytes) throw new LearningRepositoryError(413, 'learning_store_capacity');
      const bytes = gzipSync(body);
      if (bytes.length > LEARNING_REPOSITORY_LIMITS.gzipBytes) throw new LearningRepositoryError(413, 'learning_store_capacity');
      const artifact = createNativeByteArtifact({ owner, contentType: TYPE, bytes });
      if (native.atomicCheckpointSize(artifact) > LEARNING_REPOSITORY_LIMITS.encryptedBytes) throw new LearningRepositoryError(413, 'learning_store_capacity');
      try {
        const result = await native.commitAtomicCheckpoint(expectedRevision, artifact, { maxEncryptedBytes: LEARNING_REPOSITORY_LIMITS.encryptedBytes });
        if (!result.revision || digest(decode(result)) !== digest(state)) throw new LearningRepositoryError(503, 'learning_store_unconfirmed');
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'NativeCommitConflictError'
          || plain(cause) && cause.status === 412) throw new LearningRepositoryError(409, 'learning_store_conflict');
        if (cause instanceof LearningRepositoryError) throw cause;
        throw new LearningRepositoryError(503, 'learning_store_unconfirmed');
      }
    },
  });
}

export const unavailableLearningRepository: LearningRepository = Object.freeze({
  async read() { throw new LearningRepositoryError(503, 'learning_store_unavailable'); },
  async write() { throw new LearningRepositoryError(503, 'learning_store_unavailable'); },
});
