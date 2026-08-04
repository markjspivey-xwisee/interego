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

// The only import this module has. `screeningEgressLookup` (bottom of the file)
// hands `dns.lookup` to undici as the CONNECT-TIME resolver, which is what removes
// the window between "we checked an address" and "we dialled an address".
import { lookup as dnsLookup } from 'node:dns';

// Match `https://interego-css.livelysky-<hex>.eastus.azurecontainerapps.io`
// at the start of the URL, followed by `/` or end-of-string.
//
// ★ THE DEPLOYMENT ID IS CAPTURED **AND KEPT**. It used to be captured and then
// discarded: the replacement was a hard-coded
// `interego-css.internal.livelysky-8b81abb0...` literal, so EVERY deployment ID
// matching the pattern normalised to that one host and two genuinely different
// URLs compared equal. The comment that stood here claimed the opposite
// guarantee — that a future re-deployment with a different ID would not
// silently rewrite to the wrong host — which is precisely what it did.
//
// Two live consequences, both from the SAME collapse:
//
//   - `supersessionFrontier` is handed this function as its `normalize`. A
//     descriptor from deployment A citing `iep:supersedes` compared equal to a
//     descriptor from deployment B, so a write that never touched B's chain
//     retired B's head — invalidating a CAS token held by a writer doing
//     nothing wrong, and (on the write path) admitting a stale one.
//
//   - `solidFetch` normalises before fetching, WITH the relay's CSS
//     credentials. A caller-supplied `interego-css.livelysky-<anything>` URL
//     was rewritten onto our real pod host and fetched as us: the caller
//     chooses a host, the relay silently substitutes its own.
//
// Latent today — current infra is Railway, and no URL with any other ID exists
// in the tree — but the collapse is real, so keep the ID and let the rewrite be
// the one thing it says it is: insert the `.internal.` label, change nothing else.
//
// Group 1 is the prefix the rewrite splits on; group 2 exists to NAME the span
// that must survive untouched (nothing substitutes it — that was the bug); the
// trailing `(\/|$)` is load-bearing, or `…azurecontainerapps.io.evil.example`
// prefix-matches and an attacker-registered host gets rewritten onto ours.
//
// The negative lookahead `(?!internal\.)` is belt-and-braces. Idempotence
// actually comes from the literal `livelysky-` that follows it: in the internal
// form the label after `interego-css.` is `internal.`, which cannot match, so a
// second pass is already a no-op and cannot produce `internal.internal.…`.
const OLD_CSS_PUBLIC_HOST_RE =
  /^(https:\/\/interego-css\.)(?!internal\.)(livelysky-[0-9a-f]+\.eastus\.azurecontainerapps\.io)(\/|$)/;

/** The label the migration inserts. The rest of the host is the caller's, preserved. */
const CSS_INTERNAL_LABEL = 'internal.';

/**
 * Translate a legacy public-host CSS URL to the canonical internal-FQDN
 * form. Non-CSS URLs pass through unchanged. URN / non-https inputs also
 * pass through (the regex anchors on `https://interego-css.livelysky-`).
 */
export function normalizeCssUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  const m = url.match(OLD_CSS_PUBLIC_HOST_RE);
  if (!m) return url;
  // Splice, don't substitute. `m[1]` is `https://interego-css.`; everything from
  // there on — deployment ID, region, the trailing `/` and the whole path — is
  // the caller's URL and is carried through byte-for-byte.
  const scheme = m[1]!;
  return scheme + CSS_INTERNAL_LABEL + url.slice(scheme.length);
}

// IPv4 literals that must never appear as an SSRF target on a
// user-supplied URL: loopback, link-local (incl. Azure / AWS / GCP IMDS
// at 169.254.169.254), RFC1918 private ranges, CGNAT, broadcast, and
// the unspecified 0.0.0.0/8.
const PRIVATE_IPV4_RE = /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|255\.255\.255\.255$|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
// IPv6 literals that must never appear: loopback (::1), unspecified (::),
// link-local (fe80::/10), unique-local (fc00::/7).
//
// These are matched against the BARE address — see `bareAddressHost`. They used
// to be matched against `URL.hostname` directly, which is the bug below.
const PRIVATE_IPV6_RE = /^(?:::1?$|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/i;

/**
 * The address form the IP screens can actually match.
 *
 * ★ `URL.hostname` returns the WHATWG-NORMALISED host, not the text the caller
 * typed, and for an IPv6 literal that means SQUARE BRACKETS ARE PART OF THE
 * STRING: `new URL('https://[fd00::1]/').hostname === '[fd00::1]'`. Every IPv6
 * regex here is `^`-anchored, so a leading `[` made all of them unmatchable and
 * `assertPublicPodUrl` accepted EVERY IPv6 literal — ::1, ::, fd00::1, fe80::1,
 * and (measured, connection landed on 127.0.0.1) ::ffff:127.0.0.1. The one place
 * that got this right was server.ts's `assertInvokeTargetAllowed`, one layer
 * above; the function that OWNS the screen never stripped them.
 */
export function bareAddressHost(host: string): string {
  return host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
}

/**
 * Decode an IPv4 address embedded in an IPv6 literal, in BOTH spellings.
 *
 * ★ The second branch is why this function exists. The old check was
 * `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` — DEAD CODE, because `URL.hostname`
 * COMPRESSES a v4-mapped literal into hextets and never emits a dotted quad
 * inside brackets: `https://[::ffff:169.254.169.254]/` arrives as
 * `[::ffff:a9fe:a9fe]`. So the IPv4 blocklist — the only list that knows about
 * IMDS and RFC1918 — was unreachable via the `::ffff:` spelling, and re-spelling
 * a private IPv4 as v4-mapped IPv6 reached the same host.
 *
 * The dotted branch is still needed: `dns.lookup` results and hand-written
 * strings (screened by `screeningEgressLookup`) use it.
 */
function embeddedIpv4(bare: string): string | null {
  const dotted = bare.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted) return dotted[1]!;
  const hextet = bare.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hextet) return null;
  const hi = parseInt(hextet[1]!, 16);
  const lo = parseInt(hextet[2]!, 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * The SINGLE address screen. Returns a human-readable reason if `host` is a
 * private/loopback/link-local/IMDS address in any spelling, else null.
 *
 * Takes a host or a bare address, so the same predicate screens a URL's
 * `hostname` (syntactic) and every address `dns.lookup` returns for that
 * hostname (resolved). One implementation, so the two can never disagree —
 * they already did: server.ts caught `[::1]` while this file did not.
 */
export function privateAddressReason(host: string): string | null {
  const bare = bareAddressHost(host);
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) {
    return PRIVATE_IPV4_RE.test(bare) ? `private/loopback IPv4 address: ${bare}` : null;
  }
  if (!bare.includes(':')) return null;
  if (PRIVATE_IPV6_RE.test(bare)) return `private/loopback IPv6 address: ${bare}`;
  const v4 = embeddedIpv4(bare);
  if (v4 && PRIVATE_IPV4_RE.test(v4)) return `private IPv4-in-IPv6 address: ${bare} (= ${v4})`;
  return null;
}

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
 * URL on behalf of an authenticated caller.
 *
 * ★ THIS IS A SYNTACTIC CHECK AND IT IS NOT SUFFICIENT ON ITS OWN. The
 * paragraph that stood here said an attacker "can still RACE a hostname's
 * A-record", which understated it: NO RACE IS REQUIRED. A name is not an
 * address, so a static, publicly-resolvable name that simply IS an A record
 * for private space defeats this function outright — measured:
 * `10-0-0-5.nip.io` -> 10.0.0.5 and `localtest.me` -> 127.0.0.1 both returned
 * ACCEPTED here AND from server.ts's full invoke egress guard.
 *
 * It also named an out-of-repo egress firewall as the mitigation, and nothing
 * in the tree asserted that firewall exists. The mitigation is now IN TREE:
 * `screeningEgressLookup` below re-applies `privateAddressReason` to every
 * address DNS returns, AT CONNECT TIME, as the resolver undici actually uses —
 * so the address screened is the address dialed and there is no window between
 * them. Keep BOTH: this function rejects a bad literal before a socket is
 * opened at all; the lookup rejects a bad resolution.
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
  // Bracket + zone stripped HERE, once, before any screen runs. Screening
  // `parsed.hostname` directly is what let every IPv6 literal through.
  const bareHost = bareAddressHost(parsed.hostname);
  const addrReason = privateAddressReason(bareHost);
  if (addrReason) {
    throw new Error(`pod URL host is a ${addrReason}`);
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

/**
 * A `dns.lookup` drop-in that refuses to hand back a private address.
 *
 * ★ WHY IT IS A LOOKUP AND NOT A PRE-CHECK. Resolving the hostname ourselves and
 * then calling `fetch` leaves a real window: `fetch` resolves AGAIN, and a TTL-0
 * record can differ between the two. Handing this function to undici as the
 * connect-time resolver removes the window entirely — the addresses screened are
 * the addresses the socket is opened to, because there is only one resolution.
 *
 * Wired ONLY onto the guarded-egress dispatcher in server.ts, never onto the
 * global one: the relay's own CSS and identity hosts resolve to private
 * addresses BY DESIGN and must not be screened. See `guardedEgressAgent`.
 */
export function screeningEgressLookup(
  hostname: string,
  options: Record<string, unknown>,
  callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
): void {
  // `all: true` unconditionally — a hostname with ONE public and one private
  // address must be rejected, and a non-`all` lookup would only ever see the
  // first. The caller's requested shape is restored below.
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) { callback(err); return; }
    const list = addresses as unknown as { address: string; family: number }[];
    if (!list || list.length === 0) {
      callback(Object.assign(new Error(`egress: ${hostname} resolved to no addresses`), { code: 'ENOTFOUND' }));
      return;
    }
    for (const a of list) {
      const reason = privateAddressReason(a.address);
      if (reason) {
        callback(Object.assign(
          new Error(`egress blocked: ${hostname} resolves to a ${reason}`),
          { code: 'ERR_EGRESS_PRIVATE_ADDRESS' },
        ));
        return;
      }
    }
    if (options['all']) { callback(null, list); return; }
    callback(null, list[0]!.address, list[0]!.family);
  });
}
