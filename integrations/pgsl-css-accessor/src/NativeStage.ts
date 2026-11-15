import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { BadRequestHttpError, HttpError } from '@solid/community-server';
import { NATIVE_COMMIT_MAX_BYTES } from './NativeCommit.js';

export const NATIVE_STAGE_MEDIA_TYPE = 'application/vnd.interego.native-stage+json';
export const NATIVE_STAGE_MAX_ITEMS = 64;
/** The decoded representations of one request together; each alone has the native commit bound. */
export const NATIVE_STAGE_MAX_BYTES = NATIVE_COMMIT_MAX_BYTES;
export const NATIVE_STAGE_MAX_COMMAND_BYTES = Math.ceil(NATIVE_STAGE_MAX_BYTES / 3) * 4 + NATIVE_STAGE_MAX_ITEMS * 1024 + 8192;
/**
 * A staged name states its own content: `<label>-<sha256 of the bytes, hex>` and an optional
 * extension. Nothing else can be created through this operation, so a request authorized for a
 * container cannot name an auxiliary resource, a nested path or any document whose name is not
 * derived from the bytes it is given.
 */
const STAGED_NAME = /^[a-z][a-z0-9]{0,31}-([a-f0-9]{64})(?:\.[a-z0-9]{1,16})?$/;

export interface NativeStageItem { readonly name: string; readonly contentType: string; readonly bodyBase64: string; readonly bytes: Buffer; }
/** One per submitted item, in order. `created` is false when the identical representation was already there. */
export interface NativeStageReceipt {
  readonly name: string; readonly status: 'staged'; readonly created: boolean;
  readonly revision: string; readonly bodyDigest: string; readonly contentType: string; readonly size: number;
}

export function isNativeStageMediaType(value: string | undefined): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === NATIVE_STAGE_MEDIA_TYPE;
}

export async function readNativeStageCommand(stream: Readable): Promise<NativeStageItem[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > NATIVE_STAGE_MAX_COMMAND_BYTES) throw new HttpError(413, 'PayloadTooLargeHttpError', 'Native stage command exceeds its size limit');
    chunks.push(part);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BadRequestHttpError('Native stage command must be valid JSON'); }
  const invalid = (): never => { throw new BadRequestHttpError('Invalid native stage command'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['version', 'items'].includes(key)) || body.version !== 1
    || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > NATIVE_STAGE_MAX_ITEMS) invalid();
  const items: NativeStageItem[] = [], names = new Set<string>();
  let total = 0;
  for (const entry of body.items as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some(key => !['name', 'contentType', 'bodyBase64'].includes(key))
      || typeof item.name !== 'string' || names.has(item.name)
      || typeof item.contentType !== 'string' || item.contentType.length > 255
      || !/^[A-Za-z0-9!#$%&'*+.^_|~-]+\/[A-Za-z0-9!#$%&'*+.^_|~-]+(?:;[^\r\n]*)?$/.test(item.contentType)
      || item.contentType.split(';', 1)[0]!.trim().toLowerCase().startsWith('application/vnd.interego.native-')
      || item.contentType === 'internal/container'
      || typeof item.bodyBase64 !== 'string' || item.bodyBase64.length % 4 !== 0) invalid();
    // The alphabet and padding are proven by the exact re-encoding below. A pattern match over the
    // whole body said the same thing first, at many times the cost on a megabyte.
    const name = item.name as string, bodyBase64 = item.bodyBase64 as string, bytes = Buffer.from(bodyBase64, 'base64');
    total += bytes.length;
    if (total > NATIVE_STAGE_MAX_BYTES) throw new HttpError(413, 'PayloadTooLargeHttpError', 'Native stage representations exceed their size limit');
    if (bytes.toString('base64') !== bodyBase64) throw new BadRequestHttpError('Native stage body must use canonical base64');
    // Never an auxiliary resource (metadata or access control): those are not documents of the
    // container, and appending to a container does not grant writing them.
    if (/\.(?:meta|acl|acr)$/.test(name)) throw new BadRequestHttpError('A staged name must not be an auxiliary resource');
    if (STAGED_NAME.exec(name)?.[1] !== createHash('sha256').update(bytes).digest('hex')) {
      throw new BadRequestHttpError('A staged name must carry the SHA-256 of its representation');
    }
    names.add(name);
    items.push({ name, contentType: item.contentType as string, bodyBase64, bytes });
  }
  return items;
}
