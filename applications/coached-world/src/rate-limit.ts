/**
 * The request classes this world tells apart, and which one a request falls under. The limiter
 * itself (fixed window, per client, IPv6 folded to its /56, the forwarded-hop rule) is shared:
 * `applications/_shared/http-guard`.
 */
import type { RateRule } from '../../_shared/http-guard/index.js';

/** The classes of request this world tells apart. */
export const RATE_RULES = {
  /** Asking to come in: nobody is signed in yet, and each call signs or verifies something. */
  door: { limit: 30, windowMs: 60_000 },
  /** A change to the world by a signed-in consultant. */
  write: { limit: 120, windowMs: 60_000 },
  /** Everything read: the page, the world view, the graphs. */
  read: { limit: 240, windowMs: 60_000 },
  /**
   * A paired agent's signed requests. Every chat session that reaches this world through one
   * relay arrives from that relay's address, so this is counted per client like the rest but is
   * sized for many drivers behind one address, each polling for its next mission.
   */
  driver: { limit: 600, windowMs: 60_000 },
} as const satisfies Record<string, RateRule>;

export type RateClass = keyof typeof RATE_RULES;

/** The limit a request falls under, or undefined for the one path that is never counted. */
export function rateClassFor(method: string | undefined, pathname: string): RateClass | undefined {
  if (pathname === '/health') return undefined;
  if (method === 'POST' && ['/session/challenge', '/play/grant', '/play/provisional', '/session'].includes(pathname)) return 'door';
  // Connect an agent: opening a session is a door; the page's own polling is a read; the paired
  // agent's signed requests have a limit of their own.
  if (method === 'POST' && pathname === '/agent-sessions/create') return 'door';
  if (method === 'POST' && pathname === '/agent-sessions/browser') return 'read';
  if (method === 'POST' && pathname === '/agent-sessions/driver') return 'driver';
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}
