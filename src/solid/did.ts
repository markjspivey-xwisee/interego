/**
 * @module solid/did
 * @description did:web resolver per W3C DID Core specification.
 *
 * Resolves did:web identifiers to DID documents by converting
 * the DID to an HTTPS URL and fetching the document.
 *
 * Resolution rules (W3C DID Web Method):
 *   did:web:example.com           → https://example.com/.well-known/did.json
 *   did:web:example.com:users:bob → https://example.com/users/bob/did.json
 */

import type { FetchFn } from './types.js';

// ── Types ───────────────────────────────────────────────────

export interface DidDocument {
  '@context': string | string[];
  id: string;
  controller?: string;
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  service?: ServiceEndpoint[];
  alsoKnownAs?: string[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
  publicKeyJwk?: Record<string, unknown>;
}

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export interface DidResolutionResult {
  didDocument: DidDocument | null;
  didResolutionMetadata: { error?: string };
  didDocumentMetadata: Record<string, unknown>;
}

// ── Helpers ─────────────────────────────────────────────────

function getDefaultFetch(): FetchFn {
  return globalThis.fetch as unknown as FetchFn;
}

/**
 * Convert a did:web identifier to its HTTPS resolution URL.
 *
 * @example
 * didWebToUrl('did:web:example.com')
 * // → 'https://example.com/.well-known/did.json'
 *
 * @example
 * didWebToUrl('did:web:id.example.com:users:alice')
 * // → 'https://id.example.com/users/alice/did.json'
 */
export function didWebToUrl(did: string): string {
  if (!did.startsWith('did:web:')) {
    throw new Error(`Not a did:web identifier: ${did}`);
  }

  const parts = did.slice('did:web:'.length).split(':');
  const host = decodeURIComponent(parts[0]!);

  if (parts.length === 1) {
    // did:web:example.com → https://example.com/.well-known/did.json
    return `https://${host}/.well-known/did.json`;
  }

  // did:web:example.com:path:segments → https://example.com/path/segments/did.json
  const path = parts.slice(1).map(decodeURIComponent).join('/');
  return `https://${host}/${path}/did.json`;
}

/**
 * Resolve a did:web identifier to a DID Document.
 */
export async function resolveDidWeb(
  did: string,
  options: { fetch?: FetchFn } = {},
): Promise<DidResolutionResult> {
  const fetchFn = options.fetch ?? getDefaultFetch();

  try {
    const url = didWebToUrl(did);

    const response = await fetchFn(url, {
      method: 'GET',
      headers: { 'Accept': 'application/did+json, application/json' },
    });

    if (!response.ok) {
      return {
        didDocument: null,
        didResolutionMetadata: { error: `HTTP ${response.status}: ${response.statusText}` },
        didDocumentMetadata: {},
      };
    }

    const doc = await response.json() as DidDocument;

    // Basic validation: id must match the DID
    if (doc.id !== did) {
      return {
        didDocument: null,
        didResolutionMetadata: { error: `DID mismatch: document id ${doc.id} !== ${did}` },
        didDocumentMetadata: {},
      };
    }

    return {
      didDocument: doc,
      didResolutionMetadata: {},
      didDocumentMetadata: {},
    };
  } catch (err) {
    return {
      didDocument: null,
      didResolutionMetadata: { error: (err as Error).message },
      didDocumentMetadata: {},
    };
  }
}

/**
 * Extract the public key from a DID Document's verification method.
 */
export function extractPublicKey(
  doc: DidDocument,
  purpose: 'authentication' | 'assertionMethod' = 'assertionMethod',
): VerificationMethod | null {
  const refs = doc[purpose];
  if (!refs || refs.length === 0) return null;

  const firstRef = refs[0];
  if (typeof firstRef === 'object') return firstRef;

  // It's a string reference — look up in verificationMethod
  const keyId = firstRef;
  return doc.verificationMethod?.find(vm => vm.id === keyId) ?? null;
}

/**
 * Find the Solid storage endpoint from a DID Document's service array.
 */
export function findStorageEndpoint(doc: DidDocument): string | null {
  const service = doc.service?.find(
    s => s.type === 'SolidStorage' || s.type === 'solid:storage',
  );
  return service?.serviceEndpoint ?? null;
}
