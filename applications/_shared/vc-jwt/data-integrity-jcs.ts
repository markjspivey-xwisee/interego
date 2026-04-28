/**
 * W3C Data Integrity Proofs — eddsa-jcs-2022 cryptosuite.
 *
 * Closes the residual gap from Tier 5b: vc-jwt covered the JWT-encoded
 * VC path. This module covers the SECOND W3C-recognized proof format:
 * Data Integrity Proofs with the eddsa-jcs-2022 cryptosuite — JSON-LD
 * documents with embedded `proof` blocks, signed using EdDSA over a
 * JCS-canonicalized form (RFC 8785 JSON Canonicalization Scheme).
 *
 * Why eddsa-jcs-2022 specifically (out of the cryptosuite family):
 *   - eddsa-rdfc-2022: requires URDNA2015 (RDF Dataset Canonicalization);
 *     non-trivial graph-isomorphism algorithm. Substantial extra dep.
 *   - eddsa-jcs-2022: requires only JCS canonicalization (RFC 8785);
 *     ~80 lines to implement from scratch. W3C-recognized cryptosuite.
 *   - JCS variant interops with the same verifier ecosystem that needs
 *     DI Proofs but doesn't insist on RDF canonicalization specifically.
 *
 * What this provides:
 *   - canonicalizeJcs() — RFC 8785 JSON Canonicalization Scheme
 *   - issueDataIntegrityProof() — sign a JSON-LD VC with eddsa-jcs-2022
 *   - verifyDataIntegrityProof() — verify against the embedded proof
 *
 * Ecosystem position:
 *   - Open Badges 3.0 §10 lists DataIntegrityProof as a valid format
 *   - W3C VC Data Model 2.0 §5.1 specifies the proof block shape
 *   - W3C VC Data Integrity §6 specifies the cryptosuite spec
 *   - eddsa-jcs-2022 cryptosuite spec lives at:
 *     https://www.w3.org/TR/vc-di-eddsa/#eddsa-jcs-2022
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  decodeDidKeyEd25519,
  type IssuerKeyPair,
} from './index.js';

// ── JCS canonicalization (RFC 8785) ──────────────────────────────────

/**
 * Canonicalize a JSON value per RFC 8785 (JSON Canonicalization Scheme).
 *
 * Rules:
 *   - Object keys sorted lexicographically (UTF-16 code-unit order)
 *   - No insignificant whitespace
 *   - Numbers in the "shortest round-tripping form" — for our purposes,
 *     finite integers and standard decimal for floats; no NaN/Infinity
 *   - Strings: JSON-escape unicode strictly per ECMA-404, but with the
 *     specific escapes RFC 8785 mandates (lowercase hex for \uXXXX)
 *   - Arrays: preserve order (no sort)
 *   - null / true / false: literal
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: non-finite numbers are forbidden');
    // Per RFC 8785 / ECMA-262 ToString: use shortest round-trip form.
    // For integers, that's the integer text. For floats, JS's default
    // String(num) is close enough to ES "ToString" for the cases we care
    // about (no exponential below 1e-6 / above 1e21 boundary differences
    // in practical VC payloads).
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (typeof value === 'string') return jcsString(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJcs).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(jcsKeyCompare);
    const parts = keys.map(k => jcsString(k) + ':' + canonicalizeJcs(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`JCS: unsupported value type: ${typeof value}`);
}

/**
 * Sort comparator over UTF-16 code units, matching RFC 8785 §3.2.3
 * "members shall be sorted via numeric code unit value comparison".
 * JS's default string comparison already uses UTF-16 code units, so
 * a direct < / > works.
 */
function jcsKeyCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Serialize a JS string per RFC 8785 §3.2.2 + ECMA-404.
 *   - Escape: " \ \b \f \n \r \t
 *   - Escape control chars (U+0000..U+001F) as \uXXXX (lowercase hex)
 *   - All other chars passed through verbatim (no escape of /, no
 *     escape of unicode > U+007F unless it's a control char)
 */
function jcsString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';                       // "
    else if (c === 0x5c) out += '\\\\';                 // \
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += s[i];
  }
  return out + '"';
}

// ── Data Integrity Proof issuance + verification ────────────────────

export interface DataIntegrityProof {
  readonly type: 'DataIntegrityProof';
  readonly cryptosuite: 'eddsa-jcs-2022';
  readonly created: string;
  readonly verificationMethod: string;
  readonly proofPurpose: 'assertionMethod';
  readonly proofValue: string;
}

export interface VerifiableCredentialJson {
  readonly '@context': readonly string[];
  readonly type: readonly string[];
  readonly issuer: string;
  readonly validFrom: string;
  readonly validUntil?: string;
  readonly credentialSubject: Record<string, unknown>;
  readonly id?: string;
  readonly proof?: DataIntegrityProof;
}

/**
 * Sign a VC document with an embedded eddsa-jcs-2022 Data Integrity
 * Proof per W3C VC Data Integrity §6 + eddsa-jcs-2022 cryptosuite spec.
 *
 * Signing data per the cryptosuite spec:
 *   1. Canonicalize the proof options (the proof block WITHOUT proofValue)
 *      using JCS → SHA-256
 *   2. Canonicalize the unsigned credential (the document WITHOUT proof)
 *      using JCS → SHA-256
 *   3. Concatenate proofHash || credentialHash → 64 bytes
 *   4. Sign that 64-byte digest with Ed25519
 *   5. Encode signature as multibase base58btc → "z..." string
 *
 * Returns the credential with the signed proof block embedded.
 */
export function issueDataIntegrityProof(
  unsigned: VerifiableCredentialJson,
  issuer: IssuerKeyPair,
  options?: { created?: string },
): VerifiableCredentialJson {
  if (unsigned.proof) {
    throw new Error('issueDataIntegrityProof: input must not already have a proof');
  }
  if (unsigned.issuer !== issuer.did) {
    throw new Error(`issuer.did (${issuer.did}) must match payload.issuer (${unsigned.issuer})`);
  }

  const proofOptions = {
    type: 'DataIntegrityProof' as const,
    cryptosuite: 'eddsa-jcs-2022' as const,
    created: options?.created ?? new Date().toISOString(),
    verificationMethod: issuer.kid,
    proofPurpose: 'assertionMethod' as const,
  };

  const proofHash = sha256(new TextEncoder().encode(canonicalizeJcs(proofOptions)));
  const credentialHash = sha256(new TextEncoder().encode(canonicalizeJcs(unsigned)));

  const dataToSign = new Uint8Array(proofHash.length + credentialHash.length);
  dataToSign.set(proofHash, 0);
  dataToSign.set(credentialHash, proofHash.length);

  const signatureBytes = ed25519.sign(dataToSign, issuer.privateKey);
  const proofValue = 'z' + base58Encode(signatureBytes);

  return {
    ...unsigned,
    proof: { ...proofOptions, proofValue },
  };
}

export interface VerifyResult {
  readonly verified: boolean;
  readonly issuerDid?: string;
  readonly verificationMethod?: string;
  readonly reason?: string;
}

/**
 * Verify a VC with an embedded eddsa-jcs-2022 proof. Returns
 * `{ verified: false, reason: '...' }` on any failure (does NOT throw).
 */
export function verifyDataIntegrityProof(signed: VerifiableCredentialJson): VerifyResult {
  if (!signed.proof) return { verified: false, reason: 'missing proof block' };
  if (signed.proof.type !== 'DataIntegrityProof') {
    return { verified: false, reason: `unsupported proof.type: ${signed.proof.type}` };
  }
  if (signed.proof.cryptosuite !== 'eddsa-jcs-2022') {
    return { verified: false, reason: `unsupported cryptosuite: ${signed.proof.cryptosuite}` };
  }
  if (!signed.proof.proofValue?.startsWith('z')) {
    return { verified: false, reason: 'proofValue must be multibase base58btc (starts with z)' };
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base58Decode(signed.proof.proofValue.slice(1));
  } catch (e) {
    return { verified: false, reason: `proofValue base58 decode failed: ${(e as Error).message}` };
  }
  if (signatureBytes.length !== 64) {
    return { verified: false, reason: `Ed25519 signature must be 64 bytes; got ${signatureBytes.length}` };
  }

  // Resolve verification key from the verificationMethod (did:key fragment)
  const did = signed.proof.verificationMethod.split('#')[0]!;
  let publicKey: Uint8Array;
  try {
    publicKey = decodeDidKeyEd25519(did);
  } catch (e) {
    return { verified: false, reason: `verificationMethod resolution failed: ${(e as Error).message}` };
  }

  if (signed.issuer !== did) {
    return {
      verified: false,
      reason: `issuer mismatch: VC issuer (${signed.issuer}) does not match resolved verificationMethod DID (${did})`,
    };
  }

  // Reconstruct the signed data: proofHash || credentialHash
  const { proof, ...unsignedDoc } = signed;
  const { proofValue: _v, ...proofOptions } = proof;
  const proofHash = sha256(new TextEncoder().encode(canonicalizeJcs(proofOptions)));
  const credentialHash = sha256(new TextEncoder().encode(canonicalizeJcs(unsignedDoc)));

  const dataToVerify = new Uint8Array(proofHash.length + credentialHash.length);
  dataToVerify.set(proofHash, 0);
  dataToVerify.set(credentialHash, proofHash.length);

  let valid: boolean;
  try {
    valid = ed25519.verify(signatureBytes, dataToVerify, publicKey);
  } catch (e) {
    return { verified: false, reason: `Ed25519 verify threw: ${(e as Error).message}` };
  }

  if (!valid) return { verified: false, reason: 'Ed25519 signature verification failed' };

  return {
    verified: true,
    issuerDid: did,
    verificationMethod: signed.proof.verificationMethod,
  };
}

// ── base58btc (Bitcoin alphabet, not Ripple) ────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b !== 0) break;
    leadingZeros++;
  }
  const digits: number[] = [0];
  for (let i = leadingZeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < leadingZeros; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

function base58Decode(str: string): Uint8Array {
  let leadingZeros = 0;
  for (const ch of str) { if (ch !== '1') break; leadingZeros++; }
  const bytes: number[] = [0];
  for (let i = leadingZeros; i < str.length; i++) {
    const idx = BASE58_ALPHABET.indexOf(str[i]!);
    if (idx < 0) throw new Error(`invalid base58 char: ${str[i]}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[leadingZeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}
