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
  /**
   * W3C DID Core `keyAgreement` — references to verification methods
   * usable for ECDH key agreement (envelope-recipient keys). Per the
   * X25519 Key Agreement 2020 suite, entries point at
   * `X25519KeyAgreementKey2020` verification methods.
   */
  keyAgreement?: (string | VerificationMethod)[];
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

// ── X25519 key-agreement extraction ──────────────────────────
//
// Per W3C "X25519 Key Agreement 2020" + multibase, an X25519 public key
// in a DID doc is `publicKeyMultibase: 'z' + base58btc(0xec 0x01 || raw)`
// where `raw` is the 32-byte X25519 public key. We decode that back to
// raw bytes and return it base64-encoded so it matches the recipient-key
// shape that the rest of the sharing stack uses
// (`agentEncryptionKeys`, envelope `wrappedKeys` recipients — all base64
// of raw 32-byte X25519 pubkeys).
//
// This is the FIX 6 fast-path for `share_with: ['did:web:…:agents:…']`:
// resolveRecipient can read the encryption key directly from the DID doc
// instead of always fetching the owner pod's agent registry, decoupling
// cross-pod sharing from owner-pod-side registry presence.

const X25519_MULTICODEC_BYTE_0 = 0xec;
const X25519_MULTICODEC_BYTE_1 = 0x01;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcDecode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === BASE58_ALPHABET[0]) zeros++;
  const buf: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error(`invalid base58 character '${ch}'`);
    let carry = digit;
    for (let j = 0; j < buf.length; j++) {
      const v = buf[j]! * 58 + carry;
      buf[j] = v & 0xff;
      carry = v >> 8;
    }
    while (carry > 0) {
      buf.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + buf.length);
  for (let i = 0; i < buf.length; i++) out[zeros + i] = buf[buf.length - 1 - i]!;
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  // Browser fallback.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  // eslint-disable-next-line no-undef
  return btoa(binary);
}

/**
 * Resolve a verification-method reference (either a string id or an
 * inline object) against the document's `verificationMethod` array.
 */
function resolveVerificationMethod(
  doc: DidDocument,
  ref: string | VerificationMethod,
): VerificationMethod | null {
  if (typeof ref === 'object') return ref;
  return doc.verificationMethod?.find(vm => vm.id === ref) ?? null;
}

/**
 * Find the first X25519 key-agreement public key in a DID Document.
 *
 * Reads `keyAgreement`, dereferences against `verificationMethod` if the
 * entry is a string reference, and decodes the `publicKeyMultibase`
 * (`'z' + base58btc(0xec 0x01 || raw32)`) back to a 32-byte raw key,
 * returned base64-encoded.
 *
 * Returns `null` when:
 *   - no `keyAgreement` entry exists
 *   - the referenced verification method isn't X25519
 *   - the multibase value is malformed or doesn't decode to 32 bytes
 */
export function findKeyAgreementKey(doc: DidDocument): string | null {
  const refs = doc.keyAgreement;
  if (!refs || refs.length === 0) return null;
  for (const ref of refs) {
    const vm = resolveVerificationMethod(doc, ref);
    if (!vm) continue;
    if (vm.type !== 'X25519KeyAgreementKey2020') continue;
    const mb = vm.publicKeyMultibase;
    if (typeof mb !== 'string' || !mb.startsWith('z')) continue;
    try {
      const decoded = base58btcDecode(mb.slice(1));
      // Accept either the multicodec-prefixed form (0xec 0x01 || raw)
      // or a bare 32-byte raw key. Spec-compliant docs emit the
      // prefixed form; the bare form keeps us forward-compatible with
      // resolvers that strip the codec.
      let raw: Uint8Array;
      if (decoded.length === 34
        && decoded[0] === X25519_MULTICODEC_BYTE_0
        && decoded[1] === X25519_MULTICODEC_BYTE_1) {
        raw = decoded.subarray(2);
      } else if (decoded.length === 32) {
        raw = decoded;
      } else {
        continue;
      }
      return bytesToBase64(raw);
    } catch {
      continue;
    }
  }
  return null;
}
