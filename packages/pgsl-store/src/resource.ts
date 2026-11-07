/** Native resource heads and receipts over canonical PGSL content. */
import { createHash } from 'node:crypto';

export interface NativeResourceRecord {
  topUri: string;
  opaqueUri: string;
  contentType: string;
  updatedAt: number;
  size: number;
  chunkUris?: string[];
  meta?: string;
  /** Fresh per write, including equal-byte writes in the same millisecond. */
  commitNonce?: string;
  /** Authoritative heads require the explicit native CAS protocol for every write. */
  nativeManaged?: true;
  /** Digest of exact representation bytes, independent of RDF projection. */
  bodyDigest?: string;
}
export interface NativeResourceHead { record: NativeResourceRecord; revision: string; }
export interface NativeResourceReceipt {
  status: 'committed';
  pod: string;
  path: string;
  revision: string;
  topUri: string;
  opaqueUri: string;
  bodyDigest: string;
  contentType: string;
  updatedAt: number;
  size: number;
}
export interface NativeResourceConflict {
  status: 'conflict';
  /** Version observed when refusing the write; reload before retrying. */
  revision: string | null;
}
export type NativeResourceCommitResult = NativeResourceReceipt | NativeResourceConflict;
export interface NativeResourceDeleteReceipt {
  status: 'deleted';
  /** The exact revision whose head and overlays were removed. */
  revision: string;
}
export type NativeResourceDeleteResult = NativeResourceDeleteReceipt | NativeResourceConflict;
export function resourceCollection(pod: string): string { return `ldp ${pod}`; }
export function resourceRevision(pod: string, path: string, recordBytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([pod, path])).update('\0').update(recordBytes).digest('hex')}`;
}
export function representationDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
export function assertExpectedResourceRevision(expected: unknown): asserts expected is string | null {
  if (expected !== null && (typeof expected !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expected))) {
    throw new Error('native resource commit requires an explicit absent or strong revision precondition');
  }
}

export function assertDeleteResourceRevision(expected: unknown): asserts expected is string {
  if (typeof expected !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expected)) {
    throw new Error('native resource delete requires an explicit strong revision precondition');
  }
}

export class NativeResourceManagedError extends Error {
  readonly code = 'NATIVE_RESOURCE_MANAGED';
  constructor() {
    super('this resource requires an explicit native commit revision');
    this.name = 'NativeResourceManagedError';
  }
}
