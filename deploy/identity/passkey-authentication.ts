import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';

export interface StoredPasskey {
  id: string; publicKey: string; counter: number; transports?: string[];
  rpId?: string; rpOrigin?: string;
}

export class PasskeyPersistenceError extends Error {}

/** Pin legacy credentials only to the RP proven by a verified assertion. */
export async function authenticatePasskey(input: {
  credential: StoredPasskey; response: AuthenticationResponseJSON;
  challenge: string; rpId: string; origin: string; persist: () => Promise<void>;
}): Promise<void> {
  const { credential, response, challenge, rpId, origin, persist } = input;
  if (credential.rpId && credential.rpId !== rpId) throw new Error('Credential belongs to a different relying party');
  // Preserve identity's lazy loading: DID and wallet login never load WebAuthn.
  const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
  const verification = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId,
    requireUserVerification: true,
    credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, 'base64url'),
      counter: credential.counter, transports: (credential.transports ?? []) as AuthenticatorTransportFuture[] },
  });
  if (!verification.verified) throw new Error('WebAuthn assertion not verified');
  const previous = { counter: credential.counter, rpId: credential.rpId, rpOrigin: credential.rpOrigin };
  credential.counter = verification.authenticationInfo.newCounter;
  credential.rpId = rpId;
  credential.rpOrigin ??= origin;
  try { await persist(); }
  catch {
    Object.assign(credential, previous);
    throw new PasskeyPersistenceError('transient: failed to persist passkey counter and RP binding; retry');
  }
}
