/**
 * SSRF guard for caller-supplied URLs the bridge fetches server-side.
 *
 * Several endpoints resolve a subject/pod/platform URL from caller input and
 * then HTTP-GET it (delegation verification, credential reads, LTI consumer
 * mode). Without a guard those are blind SSRF primitives — reach an internal
 * service or the cloud metadata endpoint (169.254.169.254), and the error/
 * timing difference is an oracle. This module rejects any target whose host is
 * a loopback / link-local / private / unspecified address, both as an IP
 * literal AND after DNS resolution (defeating a public hostname that resolves
 * to a private IP). Only http(s) is allowed.
 *
 * NB: without connection-level address pinning a TOCTOU DNS rebind between the
 * lookup here and the actual fetch remains a theoretical residual; blocking the
 * resolved addresses defeats the practical (IP-literal + static-DNS) cases.
 */

import { lookup } from 'node:dns/promises';

/** True iff a hostname is a loopback/link-local/private/unspecified literal
 *  (IPv4 or IPv6) or a local name. Synchronous — literal inspection only. */
export function isPrivateHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return isPrivateIpv4(Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4]));
  if (h.includes(':')) return isPrivateIpv6(h);
  return false;
}

function isPrivateIpv4(a: number, b: number, _c: number, _d: number): boolean {
  if ([a, b].some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → treat as unsafe
  if (a === 0 || a === 127 || a === 10) return true;          // this-network / loopback / private
  if (a === 169 && b === 254) return true;                    // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // private
  if (a === 192 && b === 168) return true;                    // private
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
  if (a >= 224) return true;                                  // multicast / reserved
  return false;
}

function isPrivateIpv6(h: string): boolean {
  if (h === '::1' || h === '::') return true;                 // loopback / unspecified
  if (h.startsWith('fe80:')) return true;                     // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true;  // unique local fc00::/7
  // IPv4-mapped (::ffff:127.0.0.1) — check the embedded v4.
  const mapped = /::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(h);
  if (mapped) return isPrivateIpv4(Number(mapped[1]), Number(mapped[2]), Number(mapped[3]), Number(mapped[4]));
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
  // If it is not an IP literal, resolve it and reject if any address is private.
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (!isIpLiteral) {
    let addrs: Array<{ address: string }>;
    try { addrs = await lookup(host, { all: true }); }
    catch { throw new Error('target host does not resolve'); }
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
