/**
 * SSRF guard for caller-supplied URLs the bridge fetches server-side.
 *
 * Several endpoints resolve a subject/pod/platform/target URL from caller input
 * and then HTTP-GET/POST it (directory + course fetch, delegation verification,
 * credential reads, second-hop descriptor/graph fetches, LTI + LRS forwarding).
 * Without a guard those are blind SSRF primitives — reach an internal service or
 * the cloud metadata endpoint (169.254.169.254), and the error/timing difference
 * is an oracle (plus a socket-holding DoS). This module rejects any target whose
 * host is a loopback / link-local / private / unspecified address — as an IP
 * literal (IPv4 dotted/decimal/hex, IPv6 including IPv4-mapped/compat/NAT64) AND
 * after DNS resolution (defeating a public hostname that resolves to a private
 * IP). Only http(s) is allowed.
 *
 * NB: without connection-level address pinning a TOCTOU DNS rebind between the
 * lookup here and the actual fetch remains a theoretical residual; blocking the
 * resolved addresses defeats the practical (IP-literal + static-DNS) cases.
 */

import { lookup } from 'node:dns/promises';

function isPrivateIpv4(a: number, b: number, _c: number, _d: number): boolean {
  if ([a, b, _c, _d].some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → unsafe
  if (a === 0 || a === 127 || a === 10) return true;          // this-network / loopback / private
  if (a === 169 && b === 254) return true;                    // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // private
  if (a === 192 && b === 168) return true;                    // private
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
  if (a >= 224) return true;                                  // multicast / reserved
  return false;
}

/** Expand an IPv6 literal (already bracket-stripped) to eight 16-bit groups, or
 *  null if it is not a valid IPv6 address. Handles `::` compression and a trailing
 *  embedded dotted-IPv4 (::ffff:1.2.3.4). */
function expandIpv6(h: string): number[] | null {
  let s = h;
  // A trailing embedded dotted-decimal IPv4 (mapped / compat / NAT64) → fold into two hex groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const q = [Number(dotted[2]), Number(dotted[3]), Number(dotted[4]), Number(dotted[5])];
    if (q.some(n => n > 255)) return null;
    s = dotted[1] + (((q[0] << 8) | q[1]).toString(16)) + ':' + (((q[2] << 8) | q[3]).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let groups: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head.map(x => parseInt(x, 16));
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head.map(x => parseInt(x || '0', 16)), ...Array(missing).fill(0), ...tail.map(x => parseInt(x || '0', 16))];
  }
  if (groups.length !== 8 || groups.some(g => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isPrivateIpv6(hRaw: string): boolean {
  const h = hRaw.toLowerCase();
  const g = expandIpv6(h);
  if (!g) return true;                                        // unparseable IPv6 literal → treat as unsafe
  if (g.slice(0, 7).every(x => x === 0)) return g[7] === 0 || g[7] === 1; // :: (unspecified) / ::1 (loopback)
  if ((g[0]! & 0xffc0) === 0xfe80) return true;               // fe80::/10 link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true;               // fc00::/7 unique-local
  if ((g[0]! & 0xff00) === 0xff00) return true;               // ff00::/8 multicast
  // IPv4-mapped ::ffff:x:x, IPv4-compatible ::x:x, NAT64 64:ff9b::x:x — the last
  // 32 bits are an embedded IPv4 that a dual-stack socket connects to.
  const mapped = g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff;
  const compat = g.slice(0, 6).every(x => x === 0);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0);
  if (mapped || compat || nat64) {
    return isPrivateIpv4((g[6]! >> 8) & 0xff, g[6]! & 0xff, (g[7]! >> 8) & 0xff, g[7]! & 0xff);
  }
  return false;
}

/** True iff a hostname is a loopback/link-local/private/unspecified literal
 *  (IPv4 dotted, or IPv6 incl. IPv4-mapped/compat/NAT64) or a local name.
 *  Synchronous — literal inspection only. The WHATWG URL parser normalizes
 *  integer/hex IPv4 (2130706433, 0x7f000001) to dotted form, so those arrive here
 *  already dotted. */
export function isPrivateHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return isPrivateIpv4(Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4]));
  if (h.includes(':')) return isPrivateIpv6(h);
  return false;
}

/**
 * Assert a caller-supplied URL is a safe server-side fetch target. Throws on
 * a non-http(s) scheme, a private/loopback/link-local host (literal), or a
 * hostname that DNS-resolves to any such address. Call it immediately before
 * fetching a caller-influenced URL.
 */
export async function assertSafeFetchTarget(rawUrl: string): Promise<void> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('target URL is not a valid absolute URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('target URL scheme must be http(s)');
  const host = u.hostname.toLowerCase();
  if (isPrivateHostname(host)) throw new Error('target host is private/loopback/link-local');
  // A bracketed IPv6 literal (or a dotted-IPv4 literal) is its own address — already
  // classified above; there is nothing to resolve. Only a DNS NAME needs a lookup.
  const bare = host.replace(/^\[|\]$/g, '');
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':');
  if (!isIpLiteral) {
    let addrs: Array<{ address: string }>;
    // A host that does NOT resolve poses no SSRF risk (there is nothing to connect to; the
    // fetch simply fails), so treat a lookup failure as allowed rather than a hard error —
    // blocking it would break a legitimate pod during a transient DNS blip and needlessly
    // reject test/offline hosts. We only reject a host that resolves to a PRIVATE address.
    try { addrs = await lookup(bare, { all: true }); }
    catch { return; }
    for (const a of addrs) {
      if (isPrivateHostname(a.address)) throw new Error('target host resolves to a private/loopback/link-local address');
    }
  }
}

/** Non-throwing variant: returns `rawUrl` if it is a safe target by literal
 *  inspection (scheme + non-private host), else undefined. Synchronous — does
 *  NOT do DNS resolution; use as a cheap choke-point filter where an unsafe
 *  value should be silently ignored rather than error. */
export function safePublicUrlOrUndefined(rawUrl: string): string | undefined {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return undefined; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  if (isPrivateHostname(u.hostname.toLowerCase())) return undefined;
  return rawUrl;
}

type FetchResp = { ok: boolean; status: number; statusText: string; headers: { get(n: string): string | null }; text(): Promise<string>; json(): Promise<unknown> };
type MinimalFetch = (url: string, init?: Record<string, unknown>) => Promise<FetchResp>;

/**
 * SSRF-safe fetch. assertSafeFetchTarget alone validates only the INITIAL URL —
 * the default fetch then transparently follows a 3xx redirect to a NEW host,
 * which is never re-validated, so a public pod that passes the guard can 302 to
 * an internal address and the bridge follows it (round-26 redirect-bypass). This
 * wrapper guards EVERY hop: it disables automatic redirects (redirect:'manual')
 * and re-runs assertSafeFetchTarget on each Location before following, bounded to
 * `maxRedirects`. A redirect on a NON-GET request is refused outright (never
 * replay a mutating body/credentials to a new host). Use it wherever a
 * caller-influenced URL is fetched. Any extra init fields (body, etc.) pass
 * through unchanged.
 */
export async function safeFetch(
  url: string,
  init: Record<string, unknown> = {},
  fetchFn?: MinimalFetch,
  maxRedirects = 3,
): Promise<FetchResp> {
  const doFetch = (fetchFn ?? (globalThis.fetch as unknown as MinimalFetch));
  const method = String((init.method as string) ?? 'GET').toUpperCase();
  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeFetchTarget(target);
    const resp = await doFetch(target, { ...init, redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return resp;
      if (method !== 'GET' && method !== 'HEAD') throw new Error(`refusing to follow a redirect on a ${method} request (SSRF guard)`);
      try { target = new URL(loc, target).toString(); }
      catch { throw new Error('redirect Location is not a valid URL (SSRF guard)'); }
      continue;
    }
    return resp;
  }
  throw new Error('too many redirects (SSRF guard)');
}

/**
 * Wrap a base fetch into an SSRF-safe FetchFn — every call re-guards the target
 * and every redirect hop (via safeFetch). Pass the result as the `fetch` option
 * to substrate readers (discover / fetchGraphContent) so the MANIFEST hop and the
 * GRAPH hop are guarded too, not just the descriptor hop (round-28: the round-27
 * safeFetch sweep covered only the descriptor fetch — the choke point is the
 * fetchFn handed to the walker). The base fetch is only invoked on a
 * target already proven public, so this never blocks a legitimate public pod.
 */
export function guardedFetchFn<F>(base?: F): F {
  const b = (base as unknown as MinimalFetch) ?? (globalThis.fetch as unknown as MinimalFetch);
  return (((url: string, init?: Record<string, unknown>) => safeFetch(url, init ?? {}, b)) as unknown) as F;
}
