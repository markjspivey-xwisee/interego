/**
 * DID resolver — pluggable by method.
 *
 * Composes existing substrate machinery (ethers for did:ethr, jose for
 * key-format conversion) into a single `resolveDid(did)` entry point
 * that returns a uniform `{ id, publicKeyMultibase | publicKeyHex,
 * verificationMethod }` shape regardless of the underlying method.
 *
 * Supported methods:
 *   - did:key (Ed25519) — already in @interego/core via vc-jwt; we
 *     re-export the resolver here for uniformity
 *   - did:web — fetches `.well-known/did.json` over HTTPS, parses the
 *     verificationMethod array, picks the first Ed25519 key
 *   - did:ethr — derives the secp256k1 address from the DID's
 *     identifier; if the DID embeds a publicKey hex it's used directly,
 *     otherwise the address-only DID resolves to a stub doc with the
 *     address as identifier (proof verification then relies on
 *     `ethers.verifyMessage` recovering the same address)
 *
 * Standards reference:
 *   - W3C DID Core (https://www.w3.org/TR/did-core/)
 *   - did:key v0.7+ (https://w3c-ccg.github.io/did-method-key/)
 *   - did:web v0.0.3 (https://w3c-ccg.github.io/did-method-web/)
 *   - did:ethr (https://github.com/decentralized-identity/ethr-did-resolver)
 */

import { ethers } from 'ethers';

// Inline did:key decoder so the substrate doesn't import upward into applications/.
// did:key:z<base58btc-multikey> where the multibase payload starts with the
// multicodec prefix bytes (0xed01 for Ed25519).
function decodeDidKeyEd25519(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error(`not a did:key Ed25519: ${did}`);
  const mb = did.slice('did:key:z'.length);
  const decoded = base58Decode(mb);
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error(`did:key multicodec prefix is not Ed25519 (got 0x${(decoded[0] ?? 0).toString(16)}${(decoded[1] ?? 0).toString(16)})`);
  }
  return decoded.slice(2);
}

function base58Decode(s: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 char: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === '1') bytes.unshift(0); else break;
  }
  return Uint8Array.from(bytes);
}

export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020' | 'JsonWebKey2020' | 'EcdsaSecp256k1RecoveryMethod2020';
  controller: string;
  /** For Ed25519: multibase-encoded public key. */
  publicKeyMultibase?: string;
  /** For secp256k1 / Ethereum: blockchain account ID per CAIP-10. */
  blockchainAccountId?: string;
  publicKeyHex?: string;
}

export interface DidDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication?: string[];
  assertionMethod?: string[];
}

export interface DidResolutionResult {
  didDocument: DidDocument | null;
  didResolutionMetadata: {
    contentType: 'application/did+json';
    error?: 'invalidDid' | 'notFound' | 'methodNotSupported' | 'resolutionFailed';
    errorMessage?: string;
  };
  didDocumentMetadata: Record<string, unknown>;
}

export async function resolveDid(did: string, options: { fetch?: typeof globalThis.fetch } = {}): Promise<DidResolutionResult> {
  if (!did.startsWith('did:')) {
    return errResult('invalidDid', `DID must start with "did:" — got ${did}`);
  }
  const parts = did.split(':');
  const method = parts[1];
  if (!method) {
    return errResult('invalidDid', 'DID has no method');
  }

  try {
    switch (method) {
      case 'key':
        return resolveDidKey(did);
      case 'web':
        return await resolveDidWeb(did, options);
      case 'ethr':
        return resolveDidEthr(did);
      default:
        return errResult('methodNotSupported', `did:${method} not supported (supported: did:key, did:web, did:ethr)`);
    }
  } catch (err) {
    return errResult('resolutionFailed', (err as Error).message);
  }
}

function errResult(code: NonNullable<DidResolutionResult['didResolutionMetadata']['error']>, message: string): DidResolutionResult {
  return {
    didDocument: null,
    didResolutionMetadata: { contentType: 'application/did+json', error: code, errorMessage: message },
    didDocumentMetadata: {},
  };
}

// ── did:key (Ed25519) ─────────────────────────────────────────

function resolveDidKey(did: string): DidResolutionResult {
  const publicKey = decodeDidKeyEd25519(did);
  if (publicKey.length !== 32) {
    return errResult('invalidDid', `did:key Ed25519 key must be 32 bytes — got ${publicKey.length}`);
  }
  const fragment = did.split(':').pop()!;
  const verificationMethodId = `${did}#${fragment}`;
  return {
    didDocument: {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
      id: did,
      verificationMethod: [{
        id: verificationMethodId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase: fragment,
      }],
      authentication: [verificationMethodId],
      assertionMethod: [verificationMethodId],
    },
    didResolutionMetadata: { contentType: 'application/did+json' },
    didDocumentMetadata: {},
  };
}

// ── did:web ───────────────────────────────────────────────────

async function resolveDidWeb(did: string, options: { fetch?: typeof globalThis.fetch }): Promise<DidResolutionResult> {
  const docUrl = didWebDocumentUrl(did);
  if (!docUrl) return errResult('invalidDid', `did:web identifier malformed: ${did}`);

  const fetchFn = options.fetch ?? globalThis.fetch;
  const r = await fetchFn(docUrl, { headers: { Accept: 'application/did+json, application/json' } });
  if (!r.ok) {
    if (r.status === 404) return errResult('notFound', `did:web document not found at ${docUrl}`);
    return errResult('resolutionFailed', `GET ${docUrl}: ${r.status} ${r.statusText}`);
  }
  const doc = await r.json() as DidDocument;
  if (doc.id !== did) {
    return errResult('resolutionFailed', `did:web id mismatch — document.id=${doc.id} but caller asked for ${did}`);
  }
  return {
    didDocument: doc,
    didResolutionMetadata: { contentType: 'application/did+json' },
    didDocumentMetadata: {},
  };
}

/**
 * did:web identifier → HTTPS URL of the DID document per did:web v0.0.3.
 *   did:web:example.com           → https://example.com/.well-known/did.json
 *   did:web:example.com:user:bob  → https://example.com/user/bob/did.json
 *   did:web:example.com%3A8443    → https://example.com:8443/.well-known/did.json
 */
export function didWebDocumentUrl(did: string): string | null {
  if (!did.startsWith('did:web:')) return null;
  const rest = did.slice('did:web:'.length);
  if (!rest) return null;
  // Path-decoded segments per spec
  const segments = rest.split(':').map(s => decodeURIComponent(s));
  const [host, ...path] = segments;
  if (!host) return null;
  if (path.length === 0) {
    return `https://${host}/.well-known/did.json`;
  }
  return `https://${host}/${path.join('/')}/did.json`;
}

// ── did:ethr ──────────────────────────────────────────────────

function resolveDidEthr(did: string): DidResolutionResult {
  // did:ethr:[<chainspec>:]<ethereumAddress | publicKey>
  // For the minimal resolver: support did:ethr:<address> (no chainspec).
  // Address-only DIDs resolve to a verificationMethod whose
  // blockchainAccountId carries the EIP-155 CAIP-10 identifier; proof
  // verification then relies on ECDSA recovery (caller calls
  // ethers.verifyMessage and checks address matches).
  const rest = did.slice('did:ethr:'.length);
  const parts = rest.split(':');
  const last = parts[parts.length - 1];
  if (!last) return errResult('invalidDid', `did:ethr identifier is empty`);
  const chainId: string = parts.length > 1 && parts[0] ? parts[0] : 'eip155:1';

  // Address (0x + 40 hex) or full uncompressed/compressed pubkey hex.
  if (/^0x[a-fA-F0-9]{40}$/.test(last)) {
    const address = ethers.getAddress(last);
    const verificationMethodId = `${did}#controller`;
    return {
      didDocument: {
        '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/v3-unstable'],
        id: did,
        verificationMethod: [{
          id: verificationMethodId,
          type: 'EcdsaSecp256k1RecoveryMethod2020',
          controller: did,
          blockchainAccountId: `${chainId.startsWith('eip155:') ? chainId : 'eip155:' + chainId}:${address}`,
        }],
        authentication: [verificationMethodId],
        assertionMethod: [verificationMethodId],
      },
      didResolutionMetadata: { contentType: 'application/did+json' },
      didDocumentMetadata: {},
    };
  }
  if (/^0x[a-fA-F0-9]{66,130}$/.test(last)) {
    const verificationMethodId = `${did}#controller`;
    return {
      didDocument: {
        '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/v3-unstable'],
        id: did,
        verificationMethod: [{
          id: verificationMethodId,
          type: 'EcdsaSecp256k1RecoveryMethod2020',
          controller: did,
          publicKeyHex: last.slice(2),
        }],
        authentication: [verificationMethodId],
        assertionMethod: [verificationMethodId],
      },
      didResolutionMetadata: { contentType: 'application/did+json' },
      didDocumentMetadata: {},
    };
  }
  return errResult('invalidDid', `did:ethr identifier must be a 20-byte address or secp256k1 pubkey, got ${last}`);
}
