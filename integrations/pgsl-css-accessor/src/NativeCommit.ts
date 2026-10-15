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
  bodyBase64: string;
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

export async function readNativeCommitCommand(stream: Readable): Promise<{ command: NativeCommitCommand; bytes: Buffer }> {
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
  if (Object.keys(body).some(key => !['version', 'expectedRevision', 'contentType', 'bodyBase64'].includes(key))
    || body.version !== 1 || !Object.hasOwn(body, 'expectedRevision')
    || !(body.expectedRevision === null || isNativeRevision(body.expectedRevision))
    || typeof body.contentType !== 'string' || body.contentType.length > 255
    || !/^[A-Za-z0-9!#$%&'*+.^_|~-]+\/[A-Za-z0-9!#$%&'*+.^_|~-]+(?:;[^\r\n]*)?$/.test(body.contentType)
    || isNativeCommitMediaType(body.contentType) || body.contentType === 'internal/container'
    || typeof body.bodyBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.bodyBase64)) {
    throw new BadRequestHttpError('Invalid native commit command');
  }
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
export function setNativeCommitReceipt(resource: string, command: NativeCommitCommand, bytes: Buffer, receipt: NativeEngineReceipt): void {
  const scope = nativeCommitScope.getStore();
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (!scope || scope.resource !== resource || scope.receipt || scope.expectedRevision !== command.expectedRevision
    || receipt.status !== 'committed' || receipt.path !== resource || !isNativeRevision(receipt.revision)
    || receipt.bodyDigest !== digest || receipt.contentType !== command.contentType || receipt.size !== bytes.length) {
    throw new InternalServerError('Native commit receipt did not bind the requested representation');
  }
  scope.receipt = { ...receipt, version: 1, resource, expectedRevision: command.expectedRevision };
}
