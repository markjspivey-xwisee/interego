/**
 * WebFinger (RFC 7033) helpers — pure functions, no Express imports.
 *
 * Lives in its own module so the unit test can exercise the
 * lookup/build/filter logic without the side effects of importing
 * `server.ts` (which starts an HTTP listener at module-load time).
 *
 * Wire shape:
 *   - Content-Type: application/jrd+json   (RFC 7033 §4.4)
 *   - Resource form: acct:<handle>@<host>  (RFC 7033 §4.5)
 *   - Optional repeated ?rel=<rel> filter  (RFC 7033 §4.3)
 *   - 404 responses carry an empty body    (RFC 7033 §4.2 leaves it
 *     unspecified; an empty body avoids confusing JSON-error crawlers)
 *
 * The `subject` in every successful response is the CANONICAL
 * `acct:<userId>@<host>` — never the displayName the requester sent —
 * so federation crawlers converge on one form per identity.
 */

export interface Identity {
  id: string;
  type: 'user' | 'agent';
  name: string;
  owner?: string;
  scope?: string;
  createdAt: string;
  erc8004Key?: string;
}

export type JrdLink = { rel: string; type?: string; href: string };
export type JrdResponse = { subject: string; aliases?: string[]; links?: JrdLink[] };

/**
 * Resolve a WebFinger handle to an Identity record. Accepts either:
 *   - the canonical userId/agentId (exact map key match), or
 *   - the displayName (case-insensitive match on identity.name).
 *
 * Returned identity always has `.id` set to the CANONICAL id — never the
 * displayName — so the JRD `subject` converges.
 */
export function lookupWebFingerIdentity(
  handle: string,
  store: Map<string, Identity>,
): Identity | null {
  if (!handle) return null;
  const direct = store.get(handle);
  if (direct && (direct.type === 'user' || direct.type === 'agent')) return direct;
  const needle = handle.toLowerCase();
  for (const id of store.values()) {
    if ((id.type === 'user' || id.type === 'agent')
      && typeof id.name === 'string'
      && id.name.toLowerCase() === needle) {
      return id;
    }
  }
  return null;
}

/**
 * Build the JRD body for a resolved identity. Pure — no I/O.
 *
 * For users: links cover the canonical WebID (text/turtle), the Solid
 * storage (pim:space#storage), the Solid OIDC issuer, and `self` →
 * DID document (application/did+ld+json). Aliases carry the WebID URL,
 * the did:web for the user, the pod root URL, and (if the requester
 * used the displayName form and it differs from the userId) an
 * `acct:<displayName>@<host>` alias.
 *
 * For agents: links cover the agent profile (text/turtle), `self` →
 * the agent's DID document, and `prov:actedOnBehalfOf` → the owner's
 * WebID. Aliases carry the agent profile URL and the did:web for the
 * agent.
 */
export function buildWebFingerJrd(
  identity: Identity,
  opts: { baseUrl: string; cssUrl: string; requestedHandle?: string },
): JrdResponse {
  const { baseUrl, cssUrl, requestedHandle } = opts;
  const host = new URL(baseUrl).host;
  const canonicalAcct = `acct:${identity.id}@${host}`;

  if (identity.type === 'user') {
    const webId = `${baseUrl}/users/${identity.id}/profile`;
    const didWeb = `did:web:${host}:users:${identity.id}`;
    const podUrl = `${cssUrl}${identity.id}/`;
    const aliases: string[] = [webId, didWeb, podUrl];
    if (requestedHandle
      && requestedHandle.toLowerCase() !== identity.id.toLowerCase()
      && typeof identity.name === 'string'
      && identity.name.toLowerCase() === requestedHandle.toLowerCase()) {
      aliases.push(`acct:${identity.name}@${host}`);
    }
    const links: JrdLink[] = [
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/turtle', href: webId },
      { rel: 'http://www.w3.org/ns/pim/space#storage', href: podUrl },
      { rel: 'http://www.w3.org/ns/solid/terms#oidcIssuer', href: baseUrl },
      { rel: 'self', type: 'application/did+ld+json', href: `${baseUrl}/users/${identity.id}/did.json` },
    ];
    return { subject: canonicalAcct, aliases, links };
  }

  // agent
  const agentProfile = `${baseUrl}/agents/${identity.id}/profile`;
  const agentDidDoc = `${baseUrl}/agents/${identity.id}/did.json`;
  const agentDidWeb = `did:web:${host}:agents:${identity.id}`;
  const aliases: string[] = [agentProfile, agentDidWeb];
  const links: JrdLink[] = [
    { rel: 'http://webfinger.net/rel/profile-page', type: 'text/turtle', href: agentProfile },
    { rel: 'self', type: 'application/did+ld+json', href: agentDidDoc },
  ];
  if (identity.owner) {
    links.push({
      rel: 'http://www.w3.org/ns/prov#actedOnBehalfOf',
      type: 'text/turtle',
      href: `${baseUrl}/users/${identity.owner}/profile`,
    });
  }
  if (requestedHandle
    && requestedHandle.toLowerCase() !== identity.id.toLowerCase()
    && typeof identity.name === 'string'
    && identity.name.toLowerCase() === requestedHandle.toLowerCase()) {
    aliases.push(`acct:${identity.name}@${host}`);
  }
  return { subject: canonicalAcct, aliases, links };
}

/**
 * Apply the optional ?rel=<rel> filter from RFC 7033 §4.3. Filter
 * applies to `links[]` only; `aliases` is unchanged. Repeated `rel`
 * params come in as a string[] from Express.
 */
export function applyWebFingerRelFilter(
  jrd: JrdResponse,
  rel: undefined | string | string[],
): JrdResponse {
  if (!rel) return jrd;
  const wanted = (Array.isArray(rel) ? rel : [rel]).filter(r => typeof r === 'string' && r.length > 0);
  if (wanted.length === 0) return jrd;
  const wantedSet = new Set(wanted);
  return {
    ...jrd,
    links: (jrd.links ?? []).filter(l => wantedSet.has(l.rel)),
  };
}

/**
 * Parse the `resource` parameter. Accepts:
 *   - acct:<handle>@<host>   (canonical RFC 7033)
 *   - https://<host>/users/<id>     (courtesy)
 *   - https://<host>/agents/<id>    (courtesy)
 *
 * Returns the handle (userId/agentId/displayName) to look up, or null
 * if the parameter is missing/malformed (caller should respond 400).
 */
export function parseWebFingerResource(resource: unknown): string | null {
  if (typeof resource !== 'string' || resource.length === 0) return null;
  if (resource.startsWith('acct:')) {
    const rest = resource.slice('acct:'.length);
    const at = rest.lastIndexOf('@');
    const handle = at >= 0 ? rest.slice(0, at) : rest;
    return handle.length > 0 ? handle : null;
  }
  try {
    const url = new URL(resource);
    const m = url.pathname.match(/^\/(?:users|agents)\/([^/]+)/);
    if (m && m[1]) return decodeURIComponent(m[1]);
  } catch { /* not a URL — fall through */ }
  return null;
}
