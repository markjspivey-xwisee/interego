/**
 * Who is calling the interop surface?
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────
 *
 * ★ THE INTEROP SURFACE REFUSED THE CREDENTIAL ITS OWN CARD TOLD PEERS TO GET.
 *
 * The agent card advertises `oauth2.metadataUrl` pointing at this relay's authorization
 * server, with `bearer: true`. A peer that follows it exactly — discovers the AS,
 * completes the PKCE flow, receives an access token — was refused 401 by every interop
 * route, because the caller check consulted only the IDENTITY server's token store and
 * never the relay's own OAuth provider, which is what `/mcp` uses.
 *
 * So one relay had two notions of "a verified bearer", the same token was good on one
 * surface and worthless on another, and the instructions for obtaining it were published
 * by the surface that rejected it. Measured live: a token returning 200 from `/mcp`
 * returned 401 from `/a2a/v1/message:send` in the same second.
 *
 * Both credentials are the relay's own and both are legitimate. The one the card
 * advertises is tried first; the identity-server token headless callers already use is
 * tried second. Neither is a weaker notion of identity — the second was simply the only
 * one wired.
 *
 * It lives here rather than inline because `server.ts` starts a listener on import, so
 * anything defined inside it cannot be tested. An auth decision with no coverage is the
 * one place that is least acceptable.
 */

/** What a verifier reports. Shapes differ upstream; this is the part that matters. */
export interface VerifiedPrincipalParts {
  readonly agentId?: string | undefined;
  readonly userId?: string | undefined;
}

export interface InteropPrincipalDeps {
  /** The relay's own OAuth AS — the credential the card advertises. Throws when invalid. */
  readonly verifyOAuth: (token: string) => Promise<VerifiedPrincipalParts | undefined>;
  /** The identity server's token store — what headless callers already use. */
  readonly verifyIdentity: (authHeader: string) => Promise<
    { authenticated: boolean; agentId?: string | undefined; userId?: string | undefined }
  >;
  /** Base for deriving a WebID from a bare userId. */
  readonly identityUrl: string;
}

const webIdFor = (identityUrl: string, userId: string): string =>
  `${identityUrl}/users/${userId}/profile#me`;

/**
 * Resolve the verified principal, or `undefined`.
 *
 * ★ A TOKEN THAT VERIFIES BUT CARRIES NO PRINCIPAL IS NOT A CALLER. Returning some
 * placeholder would drop every such caller into ONE engagement-owner bucket, and
 * owner-scoping is the entirety of this surface's authorization — everyone in that bucket
 * could read and cancel everyone else's engagements. `undefined` is the only safe answer.
 *
 * ★ The order matters only for latency, never for authority: a token is accepted because
 * a verifier vouched for it, and neither verifier is consulted about the other's tokens.
 * The card's credential goes first because it is the one a conformant peer will present.
 */
export async function resolveInteropPrincipal(
  authHeader: string | undefined,
  deps: InteropPrincipalDeps,
): Promise<string | undefined> {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  const token = authHeader.slice(7);
  if (token.length === 0) return undefined;

  try {
    const info = await deps.verifyOAuth(token);
    const principal = info?.agentId ?? (info?.userId ? webIdFor(deps.identityUrl, info.userId) : undefined);
    if (principal) return principal;
    // Verified but anonymous — fall through rather than inventing an identity.
  } catch {
    // Not an OAuth access token. Not a refusal: the other credential is still legitimate,
    // and refusing here is exactly the bug this module exists to fix.
  }

  const auth = await deps.verifyIdentity(authHeader);
  if (!auth.authenticated) return undefined;
  return auth.agentId ?? (auth.userId ? webIdFor(deps.identityUrl, auth.userId) : undefined);
}
