/**
 * URL rewrites at the relay's HTTP boundary.
 *
 * The CSS pod's public hostname migrated from
 *   https://interego-css.livelysky-<id>.eastus.azurecontainerapps.io
 * to its canonical internal-FQDN form
 *   https://interego-css.internal.livelysky-<id>.eastus.azurecontainerapps.io
 *
 * (note the extra `.internal.` subdomain). A non-trivial number of LIVE
 * descriptors on the markj pod, plus external caches / wallet snapshots /
 * search indexes, still carry the OLD public-host URL in `iep:origin` /
 * `descriptorUrl` / `dcat:accessURL` positions. Dereferencing those would
 * 404 against the now-internal-only host.
 *
 * This module exposes a single, pure, side-effect-free function the relay
 * calls at every URL-receiving entry point (kernel.dereference,
 * get_descriptor, kernel.act, invoke_affordance, verify_agent) AND
 * wraps around the low-level `solidFetch` so the rewrite happens at
 * the HTTP layer regardless of how the URL got there.
 *
 * Migration guarantee: the pod content itself (signed descriptors,
 * envelope payloads) is byte-identical — this rewrite only changes the
 * HTTP target the relay fetches against; it never mutates the bytes
 * served. Signatures over the original URL still verify.
 *
 * Idempotent: a URL already on the internal host (note the `.internal.`
 * subdomain) does NOT match the OLD-host regex, so a second call is a
 * no-op.
 */

// Match `https://interego-css.livelysky-<hex>.eastus.azurecontainerapps.io`
// at the start of the URL, followed by `/` or end-of-string. The
// `livelysky-<hex>` deployment ID is captured in the regex so a future
// re-deployment with a different ID does not silently rewrite to the wrong
// host — only the specific deployment whose canonical form is
// `interego-css.internal.livelysky-8b81abb0...` is rewritten.
//
// NOTE the negative lookahead `(?!internal\.)`: a URL ALREADY on the
// internal-FQDN host (`interego-css.internal.livelysky-...`) MUST NOT
// match. Without this guard the regex would treat the leading
// `interego-css.` of the internal form as the OLD pattern and rewrite
// to `internal.internal.livelysky-...` on a second pass — corrupting
// the URL into a non-existent host.
const OLD_CSS_PUBLIC_HOST_RE =
  /^https:\/\/interego-css\.(?!internal\.)livelysky-[0-9a-f]+\.eastus\.azurecontainerapps\.io(\/|$)/;

const CANONICAL_CSS_INTERNAL_HOST =
  'https://interego-css.internal.livelysky-8b81abb0.eastus.azurecontainerapps.io';

/**
 * Translate a legacy public-host CSS URL to the canonical internal-FQDN
 * form. Non-CSS URLs pass through unchanged. URN / non-https inputs also
 * pass through (the regex anchors on `https://interego-css.livelysky-`).
 */
export function normalizeCssUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  const m = url.match(OLD_CSS_PUBLIC_HOST_RE);
  if (!m) return url;
  // m[0] is the matched prefix INCLUDING the trailing `/` (or empty
  // string at end-of-input). The trailing slash belongs to the path,
  // so keep it; everything before it is the host to swap out.
  const trailing = m[1] ?? '';
  const hostLen = m[0].length - trailing.length;
  return CANONICAL_CSS_INTERNAL_HOST + url.slice(hostLen);
}

// IPv4 literals that must never appear as an SSRF target on a
// user-supplied URL: loopback, link-local (incl. Azure / AWS / GCP IMDS
// at 169.254.169.254), RFC1918 private ranges, CGNAT, broadcast, and
// the unspecified 0.0.0.0/8.
const PRIVATE_IPV4_RE = /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|255\.255\.255\.255$|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
// IPv6 literals that must never appear: loopback (::1), unspecified (::),
// link-local (fe80::/10), unique-local (fc00::/7).
const PRIVATE_IPV6_RE = /^(?:::1?$|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/i;

/**
 * Reject URLs that an unauthenticated attacker could use to coerce the
 * relay into fetching internal-network targets (Azure/AWS IMDS, RFC1918
 * pods, loopback admin endpoints, the internal-only CSS host, etc.).
 *
 * Allowed: https://<host>/... where host is a public DNS name AND, if
 * `allowedHostSuffixes` is non-empty, host ends with one of the listed
 * suffixes (e.g. the deployed CSS pod's public domain). Any non-https
 * scheme, IP literal, RFC1918 / link-local / loopback host, or host
 * outside the allowlist throws.
 *
 * Used at every endpoint that fetches a user-supplied pod / descriptor
 * URL on behalf of an authenticated caller. This is a SYNTACTIC check —
 * it does not resolve DNS — so attackers can still race a hostname's
 * A-record to a private IP between this call and the underlying fetch.
 * Defence in depth: the deployment's egress firewall should also block
 * outbound traffic to private ranges + IMDS.
 */
export function assertPublicPodUrl(
  url: string,
  allowedHostSuffixes: readonly string[] = [],
): URL {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('pod URL must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`pod URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`pod URL scheme not allowed: ${parsed.protocol}`);
  }
  if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('pod URL must use https');
  }
  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/%.*$/, ''); // strip IPv6 zone identifier
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bareHost) && PRIVATE_IPV4_RE.test(bareHost)) {
    throw new Error(`pod URL host is a private/loopback IPv4 address: ${bareHost}`);
  }
  if (bareHost.includes(':') && PRIVATE_IPV6_RE.test(bareHost)) {
    throw new Error(`pod URL host is a private/loopback IPv6 address: ${bareHost}`);
  }
  const v4Mapped = bareHost.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped && PRIVATE_IPV4_RE.test(v4Mapped[1]!)) {
    throw new Error(`pod URL host is a private IPv4-mapped IPv6 address: ${bareHost}`);
  }
  if (bareHost === 'localhost' && parsed.protocol === 'https:') {
    throw new Error('pod URL must not target localhost');
  }
  if (bareHost === 'metadata.google.internal' || bareHost.endsWith('.internal')) {
    throw new Error(`pod URL host is internal-only: ${bareHost}`);
  }
  if (allowedHostSuffixes.length > 0) {
    const ok = allowedHostSuffixes.some(suffix => {
      const s = suffix.toLowerCase();
      return bareHost === s || bareHost.endsWith(`.${s}`);
    });
    if (!ok) {
      throw new Error(`pod URL host not in allowlist: ${bareHost}`);
    }
  }
  return parsed;
}
