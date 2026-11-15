import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { BadRequestHttpError, HttpError, InternalServerError, type Conditions } from '@solid/community-server';
import type { LdpStore } from '../../../packages/pgsl-store/dist/ldp.js';

export const NATIVE_COMMIT_MEDIA_TYPE = 'application/vnd.interego.native-commit+json';
export const NATIVE_COMMIT_MAX_BYTES = 8 * 1024 * 1024;
export const NATIVE_COMMIT_MAX_COMMAND_BYTES = Math.ceil(NATIVE_COMMIT_MAX_BYTES / 3) * 4 + 8192;
export const NATIVE_REVISION_PREDICATE = 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#resourceRevision';
export const NATIVE_BODY_DIGEST_PREDICATE = 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#resourceBodyDigest';

export interface NativeCommitCommand {
  version: 1;
  expectedRevision: string | null;
  contentType: string;
  /** The representation itself. Exactly one of `bodyBase64` and `source` is present. */
  bodyBase64?: string;
  /**
   * Instead of the bytes: a native document in the same pod that already holds this exact
   * representation. The commit happens only if it does (digest, size and media type).
   */
  source?: NativeCommitSource;
}
export interface NativeCommitSource { path: string; bodyDigest: string; size: number; }

/**
 * Where a source may be, given the document being committed. A source is named by path alone, so
 * it is always on the target's own origin, and it must lie under the target's top-level container:
 * whoever may write the target is writing inside that pod, and gains nothing from a source there
 * that a read of it would not give. Auxiliary resources and containers are never sources.
 */
export function nativeCommitSourceResource(target: string, source: NativeCommitSource): string {
  const refuse = (): never => { throw new BadRequestHttpError('Native commit source is not a document in the same pod'); };
  const at = new URL(target), path = source.path;
  if (path.length > 2048 || !path.startsWith('/') || path.endsWith('/') || /[?#\\\s]/.test(path) || /\.(?:meta|acl|acr)$/.test(path)) refuse();
  const segments = path.split('/').slice(1);
  if (segments.length < 2 || segments.some(segment => segment === '' || segment === '.' || segment === '..' || /%2f|%5c|%2e/i.test(segment))) refuse();
  const resolved = new URL(path, at);
  if (resolved.origin !== at.origin || resolved.pathname !== path || resolved.href === at.href) refuse();
  const pod = at.pathname.split('/')[1];
  if (!pod || at.pathname.split('/').length < 3 || segments[0] !== pod) refuse();
  return resolved.href;
}
export interface NativeEngineReceipt {
  status: 'committed'; revision: string; bodyDigest: string; contentType: string;
  pod: string; path: string; size: number; updatedAt: number; topUri: string; opaqueUri: string;
}
export interface NativeCommitReceipt extends NativeEngineReceipt {
  version: 1; resource: string; expectedRevision: string | null;
}
export interface NativeCommitScope {
  readonly resource: string;
  readonly conditions?: Conditions;
  expectedRevision?: string | null;
  receipt?: NativeCommitReceipt;
}
export const nativeCommitScope = new AsyncLocalStorage<NativeCommitScope>();
export type NativeReadSnapshot = NonNullable<Awaited<ReturnType<LdpStore['readResource']>>>;
export interface NativeReadScope { readonly resource: string; snapshot?: Promise<NativeReadSnapshot | null | undefined>; }
export const nativeReadScope = new AsyncLocalStorage<NativeReadScope>();

/** The metadata and body within a GET share one immutable resource-head read. */
export async function nativeSnapshot(ldp: LdpStore, pod: string, resource: string): Promise<NativeReadSnapshot | null | undefined> {
  const scope = nativeReadScope.getStore();
  if (!scope || scope.resource !== resource || resource.endsWith('/')) return undefined;
  if (!scope.snapshot) {
    // Memoize before the first await: CSS may request metadata and data concurrently.
    scope.snapshot = (async () => {
      const stat = await ldp.stat(pod, resource);
      if (stat && stat.size > NATIVE_COMMIT_MAX_BYTES) return undefined;
      return ldp.readResource(pod, resource, NATIVE_COMMIT_MAX_BYTES);
    })();
  }
  return scope.snapshot;
}

export function isNativeCommitMediaType(value: string | undefined): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === NATIVE_COMMIT_MEDIA_TYPE;
}
export function isNativeRevision(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
export function nativeRevisionFromEtag(value: string): string | null {
  return /^"(sha256:[0-9a-f]{64})(?:-[0-9a-f]{16})?"$/.exec(value)?.[1] ?? null;
}
export function nativeRevisionEtag(revision: string, contentType: string): string {
  if (!isNativeRevision(revision)) throw new InternalServerError('Invalid native commit revision');
  const representation = createHash('sha256').update(contentType).digest('hex').slice(0, 16);
  return `"${revision}-${representation}"`;
}

export async function readNativeCommitCommand(stream: Readable): Promise<{ command: NativeCommitCommand; bytes?: Buffer }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > NATIVE_COMMIT_MAX_COMMAND_BYTES) throw new HttpError(413, 'PayloadTooLargeHttpError', 'Native commit command exceeds its size limit');
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BadRequestHttpError('Native commit command must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestHttpError('Invalid native commit command');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['version', 'expectedRevision', 'contentType', 'bodyBase64', 'source'].includes(key))
    || body.version !== 1 || !Object.hasOwn(body, 'expectedRevision')
    || !(body.expectedRevision === null || isNativeRevision(body.expectedRevision))
    || typeof body.contentType !== 'string' || body.contentType.length > 255
    || !/^[A-Za-z0-9!#$%&'*+.^_|~-]+\/[A-Za-z0-9!#$%&'*+.^_|~-]+(?:;[^\r\n]*)?$/.test(body.contentType)
    || isNativeCommitMediaType(body.contentType) || body.contentType === 'internal/container'
    || Object.hasOwn(body, 'bodyBase64') === Object.hasOwn(body, 'source')) {
    throw new BadRequestHttpError('Invalid native commit command');
  }
  if (Object.hasOwn(body, 'source')) {
    const source = body.source as Record<string, unknown> | null;
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).some(key => !['path', 'bodyDigest', 'size'].includes(key))
      || typeof source.path !== 'string' || !isNativeRevision(source.bodyDigest)
      || !Number.isSafeInteger(source.size) || (source.size as number) < 0 || (source.size as number) > NATIVE_COMMIT_MAX_BYTES) {
      throw new BadRequestHttpError('Invalid native commit command');
    }
    return { command: body as unknown as NativeCommitCommand };
  }
  if (typeof body.bodyBase64 !== 'string' || body.bodyBase64.length % 4 !== 0) throw new BadRequestHttpError('Invalid native commit command');
  // The alphabet and padding are proven by the exact re-encoding below. A pattern match over the
  // whole body said the same thing first, at many times the cost on a megabyte.
  const bytes = Buffer.from(body.bodyBase64, 'base64');
  if (bytes.length > NATIVE_COMMIT_MAX_BYTES) throw new HttpError(413, 'PayloadTooLargeHttpError', 'Native commit representation exceeds its size limit');
  if (bytes.toString('base64') !== body.bodyBase64) throw new BadRequestHttpError('Native commit body must use canonical base64');
  return { command: body as unknown as NativeCommitCommand, bytes };
}

/** The body predicate and HTTP condition must assert the same state before the atomic engine runs. */
export function requireNativeCommitScope(resource: string, command: NativeCommitCommand): NativeCommitScope {
  const scope = nativeCommitScope.getStore();
  if (!scope || scope.resource !== resource || resource.endsWith('/')) throw new BadRequestHttpError('Native commits require the standard document PUT operation');
  const matches = scope.conditions?.matchesETag;
  const absent = scope.conditions?.notMatchesETag;
  const consistent = command.expectedRevision === null
    ? !matches && absent?.length === 1 && absent[0] === '*'
    : !absent && matches?.length === 1 && nativeRevisionFromEtag(matches[0]!) === command.expectedRevision;
  if (!consistent) throw new BadRequestHttpError('Native commit expectedRevision must match the HTTP conditional header');
  scope.expectedRevision = command.expectedRevision;
  return scope;
}

/** Only the requested document's actual engine commit can populate this request's receipt. */
export function setNativeCommitReceipt(resource: string, command: NativeCommitCommand, bytes: Buffer | { bodyDigest: string; size: number }, receipt: NativeEngineReceipt): void {
  const scope = nativeCommitScope.getStore();
  // Bound to the bytes submitted, or, for a commit from a source, to the digest and size the
  // caller stated and the engine found the source to hold.
  const digest = Buffer.isBuffer(bytes) ? `sha256:${createHash('sha256').update(bytes).digest('hex')}` : bytes.bodyDigest;
  const length = Buffer.isBuffer(bytes) ? bytes.length : bytes.size;
  if (!scope || scope.resource !== resource || scope.receipt || scope.expectedRevision !== command.expectedRevision
    || receipt.status !== 'committed' || receipt.path !== resource || !isNativeRevision(receipt.revision)
    || receipt.bodyDigest !== digest || receipt.contentType !== command.contentType || receipt.size !== length) {
    throw new InternalServerError('Native commit receipt did not bind the requested representation');
  }
  scope.receipt = { ...receipt, version: 1, resource, expectedRevision: command.expectedRevision };
}
