import * as crypto from 'node:crypto';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';

export interface StoredPasskey {
  id: string; publicKey: string; counter: number; transports?: string[];
  rpId?: string; rpOrigin?: string;
}

export type PasskeyAssertionCheck = { ok: true; newCounter: number } | { ok: false; error: Error };

/**
 * Whether `response` is an assertion by the key stored in `credential`, for this challenge and
 * relying party. Changes nothing (the caller writes the counter and RP binding, on the record as
 * the pod holds it) and never throws: a failure to verify is an answer, `ok: false`, so a caller
 * trying several holders can tell it from an error reading or writing one. A credential pinned to
 * another relying party does not verify.
 */
export async function verifyPasskeyAssertion(input: {
  credential: Readonly<StoredPasskey>; response: AuthenticationResponseJSON;
  challenge: string; rpId: string; origin: string;
}): Promise<PasskeyAssertionCheck> {
  const { credential, response, challenge, rpId, origin } = input;
  if (credential.rpId && credential.rpId !== rpId) return { ok: false, error: new Error('Credential belongs to a different relying party') };
  try {
    // Preserve identity's lazy loading: DID and wallet login never load WebAuthn.
    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId,
      requireUserVerification: true,
      credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, 'base64url'),
        counter: credential.counter, transports: [...(credential.transports ?? [])] as AuthenticatorTransportFuture[] },
    });
    if (!verification.verified) return { ok: false, error: new Error('WebAuthn assertion not verified') };
    return { ok: true, newCounter: verification.authenticationInfo.newCounter };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

// COSE curve ids (RFC 9053) for the key types the verifier accepts.
const COSE_CURVES: Readonly<Record<number, string>> = { 1: 'P-256', 2: 'P-384', 3: 'P-521', 6: 'Ed25519' };

/**
 * The key a stored passkey public key holds (its SPKI), whatever bytes it was stored in. The
 * verifier decodes the stored COSE map and reads only kty with crv/x/y, crv/x or n/e, so one key
 * has many encodings (entries in another order, labels it ignores), and with 'none' attestation
 * whoever registers a copy of another's key picks the encoding. Two records holding the same
 * key give the same answer here; bytes that do not decode to a key are compared as they are.
 */
export async function publicKeyIdentity(stored: string): Promise<string> {
  try {
    const { decodeCredentialPublicKey } = await import('@simplewebauthn/server/helpers');
    const cose = decodeCredentialPublicKey(Buffer.from(stored, 'base64url')) as unknown as Map<number, unknown>;
    const bytes = (label: number): string => {
      const v = cose.get(label);
      if (!(v instanceof Uint8Array)) throw new Error(`COSE label ${label} is not a byte string`);
      return Buffer.from(v).toString('base64url');
    };
    const kty = cose.get(1);
    const crv = COSE_CURVES[cose.get(-1) as number];
    const jwk: crypto.JsonWebKey = kty === 2 ? { kty: 'EC', crv, x: bytes(-2), y: bytes(-3) }
      : kty === 1 ? { kty: 'OKP', crv, x: bytes(-2) }
        : kty === 3 ? { kty: 'RSA', n: bytes(-1), e: bytes(-2) }
          : {};
    return `spki:${crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' }).toString('base64url')}`;
  } catch {
    return `stored:${stored}`;
  }
}
