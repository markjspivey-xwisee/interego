/** The private representation accepts the same OAuth identity as /mcp.
 * Identity-server bearers remain supported for existing headless readers. */
import type { RequestHandler } from 'express';

/** An OAuth identity is not proof that this HTTP request is authorized. Reuse
 * the MCP resource middleware for DPoP binding, expiry, scope and strict mode.
 * Only unknown OAuth credentials may continue to the identity-server path. */
export function renderOAuthGate(deps: {
  verifyToken(token: string): Promise<unknown>;
  authorize: RequestHandler;
}): RequestHandler {
  return async (req, res, next) => {
    const credential = /^(Bearer|DPoP) (\S+)$/i.exec(req.headers.authorization ?? '');
    if (!credential) { next(); return; }
    const token = credential[2]!;
    try { await deps.verifyToken(token); }
    catch { next(); return; }
    // A recognized OAuth token must pass the resource gate. Its refusal must
    // never be retried against a different credential issuer.
    try {
      await deps.authorize(req, res, error => {
        if (error) { next(error); return; }
        // The resource gate has checked a DPoP proof against THIS method and URL.
        // The identity binder below accepts the verified token as a bearer only
        // after that succeeds; the original proof is never forwarded elsewhere.
        req.headers.authorization = `Bearer ${token}`;
        next();
      });
    } catch (error) { next(error); }
  };
}

export interface RenderIdentity {
  userId?: string;
  agentId?: string;
}

export type RenderAuthResult =
  | { authenticated: true; userId: string; agentId?: string }
  | { authenticated: false; status: 401 | 403; error: string };

export interface RenderAuthDeps {
  verifyOAuth(token: string): Promise<{ scopes?: readonly string[]; extra?: RenderIdentity }>;
  verifyIdentity(header: string): Promise<RenderIdentity & { authenticated: boolean }>;
  /** Reuse the MCP resource's scope policy; this module defines no second scope list. */
  allowsOAuthRead(scopes: readonly string[] | undefined): boolean;
}

function bindIdentity(identity: RenderIdentity | undefined): RenderAuthResult {
  // Decryption is scoped to this verified pod owner. An agent-only token cannot
  // supply a caller-controlled pod or fall back to the relay's key.
  if (!identity?.userId) return { authenticated: false, status: 403, error: 'Token has no associated pod owner' };
  return { authenticated: true, userId: identity.userId,
    ...(identity.agentId ? { agentId: identity.agentId } : {}) };
}

export async function verifyRenderCaller(header: string | undefined, deps: RenderAuthDeps): Promise<RenderAuthResult> {
  if (!header?.startsWith('Bearer ') || header.length === 7) {
    return { authenticated: false, status: 401, error: 'Bearer token required' };
  }
  let oauth: Awaited<ReturnType<RenderAuthDeps['verifyOAuth']>>;
  try {
    oauth = await deps.verifyOAuth(header.slice(7));
  } catch {
    // Only an unrecognized OAuth credential reaches the existing identity
    // verifier. A recognized but insufficiently scoped token stays refused.
    try {
      const identity = await deps.verifyIdentity(header);
      if (identity.authenticated) return bindIdentity(identity);
    } catch { /* both verification paths refused */ }
    return { authenticated: false, status: 401, error: 'Invalid bearer token' };
  }
  if (!deps.allowsOAuthRead(oauth.scopes)) {
    return { authenticated: false, status: 403, error: 'insufficient_scope' };
  }
  return bindIdentity(oauth.extra);
}
