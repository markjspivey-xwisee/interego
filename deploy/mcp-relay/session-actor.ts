/**
 * Canonical identity for authenticated attribution. Bearer introspection can
 * return a local agent slug; native MCP and signed requests supply full IRIs.
 * Input comes from the verified session, never a caller-supplied identity claim.
 */
export function canonicalSessionActorId(
  actor: string | undefined,
  identityBaseUrl: string,
): string | undefined {
  if (actor === undefined) return undefined;
  const value = actor.trim();
  if (!value) return undefined;

  // Already an absolute IRI (did:, https:, urn:, and future schemes).
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return value;

  // Identity agent ids are URL-path slugs. Refuse ambiguous/path-shaped input
  // rather than minting a different DID from it.
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error('authenticated actor is not an IRI or identity-agent slug');
  }

  const base = new URL(identityBaseUrl);
  if (!base.host) throw new Error('identity base URL has no host');
  return `did:web:${base.host}:agents:${value}`;
}
