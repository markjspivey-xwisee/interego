/** The private representation accepts the same OAuth identity as /mcp.
 * Identity-server bearers remain supported for existing headless readers. */
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
