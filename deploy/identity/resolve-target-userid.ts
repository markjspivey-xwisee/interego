/**
 * Pure mode-selection helper for the three targeted-userId branches in
 * the SIWE (/auth/siwe/verify) and WebAuthn (/auth/webauthn/register)
 * handlers:
 *
 *   (A) derive     — no bearer, no bootstrap claim. The targetUserId is
 *                    deterministically derived from the credential
 *                    material the caller is currently proving.
 *   (B) bootstrap  — bootstrapUserId + bootstrapInvite. Claims a seeded
 *                    legacy userId. Single-use; once any credential is
 *                    on file, the invite path is locked out forever.
 *   (C) add-device — bearer token already proved the caller controls an
 *                    existing account. The targetUserId is whatever the
 *                    token decoded to.
 *
 * Lives in its own file so it can be unit-tested without booting
 * server.ts (whose top-level `app.listen()` is a hard side effect) and
 * so the enumeration-safe ordering of the (B) checks is pinned by a
 * regression test instead of by a comment in the handler.
 *
 * SECURITY INVARIANT — enumeration-safety on mode (B):
 *   When the seeded user already has any credential on file AND when
 *   the invite is invalid, the helper MUST return THE SAME error body
 *   and status. Otherwise an attacker can flip the predicate on the
 *   "userId is a real seeded account" bit by comparing 409 vs 401, or
 *   by comparing two distinguishable error strings.
 *
 *   Concretely: the existing-credential guard MUST run before, and
 *   produce the same response as, the invite-verification guard.
 */
export type AuthMethodsLike = {
  walletAddresses: string[];
  webAuthnCredentials: ReadonlyArray<unknown>;
  didKeys: ReadonlyArray<unknown>;
};

export function hasAnyCredentialLike(m: AuthMethodsLike): boolean {
  return m.walletAddresses.length > 0
    || m.webAuthnCredentials.length > 0
    || m.didKeys.length > 0;
}

export type ResolveInput = {
  addDeviceUserId?: string;
  bootstrapUserId?: string;
  bootstrapInvite?: string;
  /** Mode (A) input: SIWE recovered wallet address (lowercased, no 0x). */
  recoveredAddress?: string;
  /** Mode (A) input: WebAuthn credential id (base64url). */
  credentialId?: string;
  existingAuthMethods: AuthMethodsLike;
  deriveFromAddress: (addr: string) => string;
  deriveFromCredentialId: (credId: string) => string;
  verifyInvite: (userId: string, token: string | undefined) => boolean;
};

export type ResolveOk =
  | { ok: true; mode: 'addDevice' | 'bootstrap' | 'derive'; targetUserId: string };
export type ResolveErr = { ok: false; status: 400 | 401; body: { error: string } };
export type ResolveResult = ResolveOk | ResolveErr;

const UNIFORM_BOOTSTRAP_REJECTION: ResolveErr = {
  ok: false,
  status: 401,
  body: { error: 'Bootstrap credential invalid or already consumed' },
};

export function resolveTargetUserId(input: ResolveInput): ResolveResult {
  // Mode (C): add-device — bearer already proved ownership. Verbatim.
  if (input.addDeviceUserId) {
    return { ok: true, mode: 'addDevice', targetUserId: input.addDeviceUserId };
  }

  // Mode (B): bootstrap-claim of a seeded legacy userId.
  if (input.bootstrapUserId || input.bootstrapInvite) {
    if (!input.bootstrapUserId || !input.bootstrapInvite) {
      return {
        ok: false,
        status: 400,
        body: { error: 'bootstrapUserId and bootstrapInvite must both be supplied' },
      };
    }
    // Existing-credential guard runs FIRST, with the same uniform error
    // shape as the invite-invalid guard. This is the enumeration-safety
    // invariant: an attacker probing for legitimate seeded userIds must
    // not see distinguishable responses between "userId real but locked"
    // and "userId unknown / invite wrong".
    if (hasAnyCredentialLike(input.existingAuthMethods)) {
      return UNIFORM_BOOTSTRAP_REJECTION;
    }
    if (!input.verifyInvite(input.bootstrapUserId, input.bootstrapInvite)) {
      return UNIFORM_BOOTSTRAP_REJECTION;
    }
    return { ok: true, mode: 'bootstrap', targetUserId: input.bootstrapUserId };
  }

  // Mode (A): derive from the credential being proved RIGHT NOW.
  if (input.recoveredAddress) {
    return {
      ok: true,
      mode: 'derive',
      targetUserId: input.deriveFromAddress(input.recoveredAddress),
    };
  }
  if (input.credentialId) {
    return {
      ok: true,
      mode: 'derive',
      targetUserId: input.deriveFromCredentialId(input.credentialId),
    };
  }
  // Caller logic-bug: no derive input supplied for mode (A).
  return {
    ok: false,
    status: 400,
    body: { error: 'No credential material supplied for derivation' },
  };
}
