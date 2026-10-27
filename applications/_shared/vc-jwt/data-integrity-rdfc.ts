/**
 * eddsa-rdfc-2022 Data Integrity cryptosuite — RDF canonicalization
 * (URDNA2015) + Ed25519 signature.
 *
 * Complements data-integrity-jcs.ts (which signs over JCS-canonicalized
 * JSON). Some verifier ecosystems require eddsa-rdfc-2022 because it
 * canonicalizes the RDF *graph* rather than the JSON serialization —
 * meaning two semantically-equivalent credentials with different key
 * orders or different `@context` arrangements yield the same signature
 * input.
 *
 * Pipeline per W3C VC Data Integrity §6 + eddsa-rdfc-2022 spec:
 *   1. JSON-LD expand the unsigned credential
 *   2. Convert to N-Quads
 *   3. URDNA2015 canonicalization → canonical N-Quads
 *   4. SHA-256(canonical) — the "credential hash"
 *   5. Canonicalize the proof options (same pipeline) → "proof hash"
 *   6. Sign proofHash || credentialHash with Ed25519
 *   7. Encode signature as multibase base58btc
 *
 * Standards reference:
 *   - W3C VC Data Integrity 1.0 (https://www.w3.org/TR/vc-data-integrity/)
 *   - eddsa-rdfc-2022 (https://www.w3.org/TR/vc-di-eddsa/#eddsa-rdfc-2022)
 *   - URDNA2015 (https://www.w3.org/TR/rdf-canon/)
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import jsonld from 'jsonld';
import rdfCanonize from 'rdf-canonize';
import type { IssuerKeyPair } from './index.js';
import type { VerifiableCredentialJson } from './data-integrity-jcs.js';

function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (bytes.length === 0) return '';
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    const r = n % 58n;
    out = ALPHABET[Number(r)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out; else break;
  }
  return out;
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

export interface DataIntegrityRdfcProof {
  readonly type: 'DataIntegrityProof';
  readonly cryptosuite: 'eddsa-rdfc-2022';
  readonly created: string;
  readonly verificationMethod: string;
  readonly proofPurpose: 'assertionMethod';
  readonly proofValue: string;
}

export interface VerifiableCredentialRdfc extends Omit<VerifiableCredentialJson, 'proof'> {
  readonly proof?: DataIntegrityRdfcProof;
}

/**
 * Canonicalize a JSON-LD document to URDNA2015 N-Quads.
 */
async function canonicalize(doc: unknown): Promise<string> {
  // Step 1: JSON-LD expand (uses default document loader)
  const expanded = await jsonld.expand(doc as jsonld.JsonLdDocument);
  // Step 2: to N-Quads
  const nquads = await jsonld.toRDF(expanded, { format: 'application/n-quads' }) as string;
  // Step 3: URDNA2015 canonicalization
  const canonical = await rdfCanonize.canonize(nquads, { algorithm: 'URDNA2015', inputFormat: 'application/n-quads', format: 'application/n-quads' });
  return canonical as string;
}

/**
 * Sign an unsigned credential with eddsa-rdfc-2022 DataIntegrityProof.
 */
export async function issueDataIntegrityRdfcProof(
  unsigned: VerifiableCredentialJson,
  issuer: IssuerKeyPair,
  options?: { created?: string },
): Promise<VerifiableCredentialRdfc> {
  if (unsigned.proof) throw new Error('input must not already have a proof');
  if (unsigned.issuer !== issuer.did) throw new Error(`issuer mismatch: ${unsigned.issuer} vs ${issuer.did}`);

  const proofOptions = {
    '@context': unsigned['@context'], // proof options must share the context
    type: 'DataIntegrityProof' as const,
    cryptosuite: 'eddsa-rdfc-2022' as const,
    created: options?.created ?? new Date().toISOString(),
    verificationMethod: issuer.kid,
    proofPurpose: 'assertionMethod' as const,
  };

  const credentialCanonical = await canonicalize(unsigned);
  const proofCanonical = await canonicalize(proofOptions);

  const credentialHash = sha256(new TextEncoder().encode(credentialCanonical));
  const proofHash = sha256(new TextEncoder().encode(proofCanonical));

  const dataToSign = new Uint8Array(proofHash.length + credentialHash.length);
  dataToSign.set(proofHash, 0);
  dataToSign.set(credentialHash, proofHash.length);

  const sig = ed25519.sign(dataToSign, issuer.privateKey);
  const proofValue = 'z' + base58Encode(sig);

  const { '@context': _omit, ...emitProof } = proofOptions;
  return {
    ...unsigned,
    proof: { ...emitProof, proofValue },
  };
}

export interface VerifyResult {
  verified: boolean;
  reason?: string;
}

export async function verifyDataIntegrityRdfcProof(signed: VerifiableCredentialRdfc): Promise<VerifyResult> {
  const { proof } = signed;
  if (!proof) return { verified: false, reason: 'no proof' };
  if (proof.type !== 'DataIntegrityProof') return { verified: false, reason: `wrong proof type ${proof.type}` };
  if (proof.cryptosuite !== 'eddsa-rdfc-2022') return { verified: false, reason: `wrong cryptosuite ${proof.cryptosuite}` };

  const { proof: _omit, ...unsignedCredential } = signed;
  const proofOptions = {
    '@context': signed['@context'],
    type: proof.type,
    cryptosuite: proof.cryptosuite,
    created: proof.created,
    verificationMethod: proof.verificationMethod,
    proofPurpose: proof.proofPurpose,
  };

  let credentialCanonical: string;
  let proofCanonical: string;
  try {
    credentialCanonical = await canonicalize(unsignedCredential);
    proofCanonical = await canonicalize(proofOptions);
  } catch (err) {
    return { verified: false, reason: `canonicalize failed: ${(err as Error).message}` };
  }

  const credentialHash = sha256(new TextEncoder().encode(credentialCanonical));
  const proofHash = sha256(new TextEncoder().encode(proofCanonical));
  const dataToVerify = new Uint8Array(proofHash.length + credentialHash.length);
  dataToVerify.set(proofHash, 0);
  dataToVerify.set(credentialHash, proofHash.length);

  if (!proof.proofValue.startsWith('z')) return { verified: false, reason: 'proofValue not multibase base58btc (no z prefix)' };
  const sig = base58Decode(proof.proofValue.slice(1));

  // Recover public key from did:key in verificationMethod
  const did = proof.verificationMethod.split('#')[0] ?? '';
  if (!did.startsWith('did:key:')) {
    return { verified: false, reason: 'verifier only supports did:key issuers' };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { decodeDidKeyEd25519 } = await import('./index.js');
  const pubkey = decodeDidKeyEd25519(did);

  const ok = ed25519.verify(sig, dataToVerify, pubkey);
  return ok ? { verified: true } : { verified: false, reason: 'signature did not verify' };
}
