/**
 * Browser-facing protection for a bridge bound to a loopback address.
 *
 * `hostAllowlistGuard` refuses (421) any request whose Host header is not one of the names this
 * bridge is served under. A loopback bridge that holds a signing key — and, in demo mode, role
 * keys — would otherwise answer a page on another site that rebinds its own DNS name to
 * 127.0.0.1. Cross-site POSTs are already blocked by the JSON-only body parser and the absence of
 * CORS headers; this closes the rebinding path.
 */
import type { NextFunction, Request, Response } from 'express';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';

/** Refuse any request whose Host header (lowercased) is not in `allowed`. */
export function hostAllowlistGuard(allowed: readonly string[]): (req: Request, res: Response, next: NextFunction) => void {
  const names = new Set(allowed.map((h) => h.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (names.has(host)) { next(); return; }
    res.status(421).json(refuse(421, 'This bridge does not answer for that host name.', 'host-not-served'));
  };
}
