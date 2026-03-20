/**
 * @module solid/webfinger
 * @description WebFinger resolution (RFC 7033) for discovering Solid pods.
 *
 * Given an acct: URI or a WebID URL, resolves the pod storage URL
 * via the .well-known/webfinger endpoint on the resource's domain.
 */

import type { FetchFn } from './types.js';

/** Result of a WebFinger resolution. */
export interface WebFingerResult {
  /** The subject from the JRD response. */
  readonly subject: string;
  /** Discovered Solid pod URL (from rel=storage link). */
  readonly podUrl?: string;
  /** Discovered WebID (from subject or rel=webid link). */
  readonly webId?: string;
  /** All links from the JRD response. */
  readonly links: readonly WebFingerLink[];
}

export interface WebFingerLink {
  readonly rel: string;
  readonly href: string;
  readonly type?: string;
}

/** Well-known link relation for Solid storage. */
const SOLID_STORAGE_REL = 'http://www.w3.org/ns/solid/terms#storage';
/** Alternative link relation used by some Solid servers. */
const SOLID_STORAGE_REL_ALT = 'http://www.w3.org/ns/pim/space#storage';
/** Link relation for WebID profile. */
const WEBID_REL = 'http://www.w3.org/ns/solid/terms#oidcIssuer';

/**
 * Resolve a WebFinger resource identifier to a Solid pod URL.
 *
 * @param resource - Either "acct:user@domain" or a full URL (WebID)
 * @param options  - Optional fetch override
 * @returns Parsed JRD with extracted pod URL
 *
 * @example
 * ```ts
 * const result = await resolveWebFinger('acct:markj@foxximediums.com');
 * console.log(result.podUrl); // "https://pod.foxximediums.com/markj/"
 * ```
 */
export async function resolveWebFinger(
  resource: string,
  options?: { fetch?: FetchFn },
): Promise<WebFingerResult> {
  const fetchFn = options?.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const domain = extractDomain(resource);

  if (!domain) {
    throw new Error(`Cannot extract domain from resource: ${resource}`);
  }

  const webfingerUrl = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;

  const resp = await fetchFn(webfingerUrl, {
    headers: { 'Accept': 'application/jrd+json' },
  });

  if (!resp.ok) {
    throw new Error(
      `WebFinger lookup failed for ${resource}: ${resp.status} ${resp.statusText} (${webfingerUrl})`,
    );
  }

  const jrd = await resp.json() as JRDResponse;

  const links: WebFingerLink[] = (jrd.links ?? []).map(l => ({
    rel: l.rel,
    href: l.href,
    type: l.type,
  }));

  // Extract pod URL from storage links
  const storageLink = links.find(
    l => l.rel === SOLID_STORAGE_REL || l.rel === SOLID_STORAGE_REL_ALT,
  );
  const podUrl = storageLink?.href;

  // Extract WebID — subject if it's a URL, or from links
  let webId: string | undefined;
  if (jrd.subject && jrd.subject.startsWith('http')) {
    webId = jrd.subject;
  }
  const webIdLink = links.find(l => l.rel === WEBID_REL || l.rel === 'self');
  if (!webId && webIdLink) {
    webId = webIdLink.href;
  }

  return {
    subject: jrd.subject ?? resource,
    podUrl,
    webId,
    links,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function extractDomain(resource: string): string | null {
  // acct:user@domain format
  if (resource.startsWith('acct:')) {
    const atIndex = resource.indexOf('@');
    if (atIndex === -1) return null;
    return resource.slice(atIndex + 1);
  }

  // URL format — extract hostname
  try {
    const url = new URL(resource);
    return url.hostname;
  } catch {
    return null;
  }
}

/** RFC 7033 JRD response shape. */
interface JRDResponse {
  subject?: string;
  aliases?: string[];
  properties?: Record<string, string>;
  links?: Array<{
    rel: string;
    href: string;
    type?: string;
    titles?: Record<string, string>;
    properties?: Record<string, string>;
  }>;
}
