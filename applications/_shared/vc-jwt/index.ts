/**
 * W3C Verifiable Credentials — vc-jwt issuance + verification.
 *
 * Closes the cryptosuite-interop gap: Interego's native ECDSA/keccak256
 * signing is not directly compatible with the W3C VC ecosystem's
 * canonical cryptosuites. This module provides a real W3C-conformant
 * issuance + verification path using EdDSA (Ed25519) over JWS, which
 * is the format Open Badges 3.0 and IMS CLR 2.0 explicitly recognize
 * (vc-jwt encoding per W3C VC Data Model 2.0 §6.3).
 *
 * Why vc-jwt rather than Data Integrity Proofs:
 *   - vc-jwt requires only base64url + JWS canonical encoding (no RDF
 *     Dataset Canonicalization). Implementable with zero RDF deps.
 *   - The `jose` library (zero runtime deps itself) is the de-facto
 *     standard for JWS verification across the JS / TS ecosystem,
 *     so Interego-issued VCs verify cross-stack out of the box.
 *   - Open Badges 3.0 ties to JWT explicitly: §10 lists JWT as one of
 *     the recognized proof formats.
 *
 * What this provides:
 *   - generateDidKeyEd25519() — fresh did:key with Ed25519 backing
 *   - issueVcJwt() — sign a VC payload as a vc-jwt
 *   - verifyVcJwt() — verify a vc-jwt and return parsed payload
 *
 * Used by lpc:Credential to back the descriptor's Trust facet with a
 * real W3C VC proof block consumable by any vc-jwt verifier.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { SignJWT, jwtVerify, importJWK, exportJWK, type JWK } from 'jose';

// ── did:key helpers (Ed25519 multibase encoding) ─────────────────────

const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58encode(bytes: Uint8Array): string {
  // Count leading zeros
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b !== 0) break;
    leadingZeros++;
  }

  // Convert to base58
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

  let result = '';
  for (let i = 0; i < leadingZeros; i++) result += '1';
  for (let i = digits.length - 1; i >= 0; i--) result += BASE58_ALPHABET[digits[i]!];
  return result;
}

function base58decode(str: string): Uint8Array {
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch !== '1') break;
    leadingZeros++;
  }

  const bytes: number[] = [0];
  for (let i = leadingZeros; i < str.length; i++) {
    const charIndex = BASE58_ALPHABET.indexOf(str[i]!);
    if (charIndex < 0) throw new Error(`Invalid base58 character: ${str[i]}`);
    let carry = charIndex;
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
  for (let i = 0; i < leadingZeros; i++) out[i] = 0;
  for (let i = 0; i < bytes.length; i++) out[leadingZeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

/**
 * Encode an Ed25519 public key as a did:key per W3C did:key spec.
 *
 *   did:key:z<base58btc(0xed01 || raw-pubkey)>
 *
 * The 'z' prefix is multibase 'base58btc'; 0xed01 is the multicodec
 * varint for Ed25519 public keys.
 */
function encodeDidKeyEd25519(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error(`Ed25519 pubkey must be 32 bytes; got ${publicKey.length}`);
  const buf = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  buf.set(ED25519_MULTICODEC_PREFIX, 0);
  buf.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return `did:key:z${base58encode(buf)}`;
}

/**
 * Decode the public key from a did:key string. Inverse of
 * encodeDidKeyEd25519. Throws on malformed input.
 */
export function decodeDidKeyEd25519(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error(`Not a did:key: ${did}`);
  const fragment = did.split('#')[0]!.slice('did:key:z'.length);
  const decoded = base58decode(fragment);
  if (decoded.length < 2 + 32) throw new Error(`did:key payload too short`);
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error(`did:key is not Ed25519 (multicodec 0x${decoded[0]?.toString(16)}${decoded[1]?.toString(16)})`);
  }
  return decoded.slice(2, 2 + 32);
}

// ── Key generation ────────────────────────────────────────────────────

export interface IssuerKeyPair {
  /** did:key URL for the issuer (use as `iss` in JWT). */
  readonly did: string;
  /** Verification method ID (`did:key:...#z...`) for the JWT `kid`. */
  readonly kid: string;
  /** Raw Ed25519 private key (32 bytes). */
  readonly privateKey: Uint8Array;
  /** Raw Ed25519 public key (32 bytes). */
  readonly publicKey: Uint8Array;
  /** JWK form (used by jose). */
  readonly privateJwk: JWK;
  readonly publicJwk: JWK;
}

/**
 * Generate a fresh Ed25519 keypair + did:key identifier. Caller is
 * responsible for persisting `privateKey` if they want the credential
 * issuer identity to survive process restart.
 */
export async function generateDidKeyEd25519(): Promise<IssuerKeyPair> {
  // Use @noble/curves Ed25519 for key material
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);

  return wrapKeyPair(privateKey, publicKey);
}

/**
 * Import an existing Ed25519 keypair (e.g., loaded from disk). The
 * 32-byte privateKey is the seed (raw secret); publicKey is derived.
 */
export async function importDidKeyEd25519(privateKey: Uint8Array): Promise<IssuerKeyPair> {
  if (privateKey.length !== 32) throw new Error(`Ed25519 secret must be 32 bytes; got ${privateKey.length}`);
  const publicKey = ed25519.getPublicKey(privateKey);
  return wrapKeyPair(privateKey, publicKey);
}

async function wrapKeyPair(privateKey: Uint8Array, publicKey: Uint8Array): Promise<IssuerKeyPair> {
  const did = encodeDidKeyEd25519(publicKey);
  // Per did:key spec, the verificationMethod fragment IS the multibase
  // encoding (the same z... part used in the DID identifier).
  const fragment = did.split(':').pop()!;
  const kid = `${did}#${fragment}`;

  // Construct JWK forms for jose
  const privateJwk: JWK = {
    kty: 'OKP',
    crv: 'Ed25519',
    d: bytesToBase64url(privateKey),
    x: bytesToBase64url(publicKey),
  };
  const publicJwk: JWK = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: bytesToBase64url(publicKey),
  };

  return { did, kid, privateKey, publicKey, privateJwk, publicJwk };
}

function bytesToBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

// ── VC issuance + verification ───────────────────────────────────────

export interface VcPayload {
  /** Canonical W3C VC fields. */
  readonly '@context': readonly string[];
  readonly type: readonly string[];
  readonly issuer: string;
  readonly validFrom: string;
  readonly validUntil?: string;
  readonly credentialSubject: Record<string, unknown>;
  readonly id?: string;
}

/**
 * Issue a vc-jwt — a W3C VC encoded as a JWS using the EdDSA algorithm.
 * Per W3C VC Data Model 2.0 §6.3, the encoded JWT is itself the proof
 * (no separate `proof` block in the payload).
 */
export async function issueVcJwt(payload: VcPayload, issuer: IssuerKeyPair): Promise<string> {
  if (payload.issuer !== issuer.did) {
    throw new Error(`payload.issuer (${payload.issuer}) must match issuer.did (${issuer.did})`);
  }

  const privateKey = await importJWK(issuer.privateJwk, 'EdDSA');

  // JWT claims include both VC payload (under `vc`) and shortcut top-level
  // claims for compatibility with verifiers that read iss/sub/iat directly.
  const subjectId = (payload.credentialSubject as { id?: string }).id;
  const now = Math.floor(Date.parse(payload.validFrom) / 1000);
  const exp = payload.validUntil ? Math.floor(Date.parse(payload.validUntil) / 1000) : undefined;

  let jwt = new SignJWT({
    vc: payload,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: issuer.kid })
    .setIssuer(issuer.did)
    .setIssuedAt(now);

  if (subjectId) jwt = jwt.setSubject(subjectId);
  if (exp) jwt = jwt.setExpirationTime(exp);
  if (payload.id) jwt = jwt.setJti(payload.id);

  return await jwt.sign(privateKey);
}

export interface VerifiedVc {
  /** Original VC payload. */
  readonly payload: VcPayload;
  /** Issuer DID resolved from the JWT (same as payload.issuer if conformant). */
  readonly issuerDid: string;
  /** Verification method (kid) that signed the JWT. */
  readonly kid: string;
}

/**
 * Verify a vc-jwt:
 *   1. Extract the `kid` from the JWT header
 *   2. Resolve the issuer's public key from the did:key
 *   3. Verify the JWS signature using the resolved key
 *   4. Confirm `iss` claim matches the issuer DID
 *   5. Return the decoded VC payload
 *
 * Throws on any verification failure (signature invalid, issuer mismatch,
 * malformed JWT, unsupported algorithm).
 */
export async function verifyVcJwt(jwt: string): Promise<VerifiedVc> {
  // Extract kid from header WITHOUT trusting the signature yet
  const headerB64 = jwt.split('.')[0]!;
  const headerStr = Buffer.from(headerB64, 'base64url').toString('utf8');
  const header = JSON.parse(headerStr) as { alg?: string; kid?: string };
  if (header.alg !== 'EdDSA') throw new Error(`Expected alg=EdDSA; got ${header.alg ?? '<missing>'}`);
  if (!header.kid) throw new Error('JWT header missing kid');

  const did = header.kid.split('#')[0]!;
  const publicKey = decodeDidKeyEd25519(did);
  const publicJwk: JWK = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: bytesToBase64url(publicKey),
  };

  const importedKey = await importJWK(publicJwk, 'EdDSA');
  const { payload: jwtPayload } = await jwtVerify(jwt, importedKey, {
    algorithms: ['EdDSA'],
  });

  if (typeof jwtPayload.iss !== 'string') throw new Error('JWT missing iss claim');
  if (jwtPayload.iss !== did) {
    throw new Error(`Issuer mismatch: kid resolves to ${did} but iss claims ${jwtPayload.iss}`);
  }

  const vc = jwtPayload['vc'] as VcPayload | undefined;
  if (!vc) throw new Error('JWT missing vc claim');
  if (!Array.isArray(vc['@context']) || vc['@context'].length === 0) {
    throw new Error('VC missing or invalid @context');
  }
  if (!Array.isArray(vc.type) || !vc.type.includes('VerifiableCredential')) {
    throw new Error('VC type must include VerifiableCredential');
  }
  if (!vc.credentialSubject) throw new Error('VC missing credentialSubject');
  if (vc.issuer !== did) {
    throw new Error(`VC issuer (${vc.issuer}) must match JWT iss (${did})`);
  }

  return {
    payload: vc,
    issuerDid: did,
    kid: header.kid,
  };
}

// ── Re-exports for tests ─────────────────────────────────────────────

export { encodeDidKeyEd25519, exportJWK };
