/**
 * Canonical actor identity for signed-domain application guards and receipts.
 *
 * OAuth's native MCP path already supplies a full agent IRI. The exact REST
 * executor bridge uses an identity-server bearer whose token record may carry
 * the agent's local slug instead. Application state compares actor identities
 * as exact strings, so both transports must enter the runtime in the same
 * identity space.
 *
 * The input is server-authenticated before this helper runs. It never accepts
 * a caller-supplied identity claim.
 */
export function canonicalApplicationActorId(
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
    throw new Error('authenticated application actor is not an IRI or identity-agent slug');
  }

  const base = new URL(identityBaseUrl);
  if (!base.host) throw new Error('identity base URL has no host');
  return `did:web:${base.host}:agents:${value}`;
}
