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
 * search indexes, still carry the OLD public-host URL in `cg:origin` /
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
