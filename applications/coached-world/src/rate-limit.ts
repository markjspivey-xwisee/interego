/**
 * A fixed-window request limit per client, for a server that is plain `node:http`.
 *
 * The client is an address, never text a caller chose: an IPv4 address as it is, an IPv6 address
 * folded to its /56 (one subscriber usually holds at least that much, so counting each /128 apart
 * would give one caller as many windows as they care to ask for). Anything that does not parse
 * is counted together as `unknown`.
 *
 * Behind a proxy the socket's peer is the proxy, so the address is the LAST entry of
 * `X-Forwarded-For`: the one the nearest proxy wrote. Earlier entries are whatever the caller
 * sent. The header is read only when the server was told it sits behind a proxy; otherwise a
 * caller could name a new address on every request.
 */
import { MAX_RATE_CLIENTS, bound } from './bounded.js';

export interface RateRule { readonly limit: number; readonly windowMs: number }

/** The three classes of request this world tells apart. */
export const RATE_RULES = {
  /** Asking to come in: nobody is signed in yet, and each call signs or verifies something. */
  door: { limit: 30, windowMs: 60_000 },
  /** A change to the world by a signed-in consultant. */
  write: { limit: 120, windowMs: 60_000 },
  /** Everything read: the page, the world view, the graphs. */
  read: { limit: 240, windowMs: 60_000 },
} as const satisfies Record<string, RateRule>;

export type RateClass = keyof typeof RATE_RULES;

export type RateVerdict = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

function ipv4(text: string): string | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d{1,5})?$/.exec(text);
  if (!match) return undefined;
  const parts = match.slice(1, 5).map(Number);
  return parts.every(part => part <= 255) ? parts.join('.') : undefined;
}

/** The eight groups of an IPv6 address, or undefined. A trailing dotted quad is read as its two groups. */
function ipv6Groups(text: string): number[] | undefined {
  let rest = text;
  if (rest.includes('.')) {
    const lastColon = rest.lastIndexOf(':');
    const quad = lastColon < 0 ? undefined : /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(rest.slice(lastColon + 1));
    if (!quad) return undefined;
    const [a, b, c, d] = quad.slice(1, 5).map(Number) as [number, number, number, number];
    if (a > 255 || b > 255 || c > 255 || d > 255) return undefined;
    rest = `${rest.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return undefined;
  const parse = (half: string): number[] | undefined => {
    if (half === '') return [];
    const out: number[] = [];
    for (const group of half.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const back = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!head || !back) return undefined;
  const fixed = head.length + back.length;
  if (halves.length === 2) {
    if (fixed > 7) return undefined;
    return [...head, ...new Array<number>(8 - fixed).fill(0), ...back];
  }
  return fixed === 8 ? head : undefined;
}

/** One address as the limiter counts it: IPv4 whole, IPv6 as its /56, `unknown` for anything else. */
export function foldAddress(raw: string | undefined): string {
  if (!raw) return 'unknown';
  let text = raw.trim();
  if (text.length > 64) return 'unknown';
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) text = bracketed[1] ?? '';
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const four = ipv4(text);
  if (four) return four;
  const groups = ipv6Groups(text);
  if (!groups) return 'unknown';
  // An IPv4 address carried in IPv6 (::ffff:a.b.c.d) is that IPv4 address.
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const hex = (group: number | undefined) => (group ?? 0).toString(16);
  return `${hex(groups[0])}:${hex(groups[1])}:${hex(groups[2])}:${hex((groups[3] ?? 0) & 0xff00)}::/56`;
}

/**
 * Who is asking. With `trustProxy`, the last entry of `X-Forwarded-For`; when the header is absent
 * or `trustProxy` is off, the socket's own peer.
 */
export function clientKey(forwardedFor: string | readonly string[] | undefined, socketAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const header = Array.isArray(forwardedFor) ? forwardedFor.at(-1) : forwardedFor as string | undefined;
    const last = header?.split(',').at(-1)?.trim();
    if (last) return foldAddress(last);
  }
  return foldAddress(socketAddress);
}

/** The limit a request falls under, or undefined for the one path that is never counted. */
export function rateClassFor(method: string | undefined, pathname: string): RateClass | undefined {
  if (pathname === '/health') return undefined;
  if (method === 'POST' && ['/session/challenge', '/play/grant', '/play/provisional', '/session'].includes(pathname)) return 'door';
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxClients: number = MAX_RATE_CLIENTS,
  ) {}

  get size(): number { return this.windows.size; }

  /** Count one request. Past the limit the answer says how long until the window ends. */
  take(name: string, client: string, rule: RateRule): RateVerdict {
    const key = `${name}|${client}`;
    const at = this.now();
    const current = this.windows.get(key);
    if (!current || at - current.start >= rule.windowMs) {
      // A new window goes to the back, so the table's oldest entries are the ones longest idle,
      // and they are what `bound` drops when the table is full.
      this.windows.delete(key);
      bound(this.windows, this.maxClients - 1);
      this.windows.set(key, { start: at, count: 1 });
      return { ok: true };
    }
    if (current.count >= rule.limit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((current.start + rule.windowMs - at) / 1000)) };
    }
    current.count += 1;
    return { ok: true };
  }
}
