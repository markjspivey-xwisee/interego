/**
 * Fixed-window request counters, one bucket per endpoint family.
 *
 * `rateLimit()` is the per-IP middleware the auth routes use. `createLimiter()` is the
 * counter underneath it, for a route that can only name its key after it has looked at the
 * request: GET /auth-methods/me counts a signed token against the account it names, because
 * every read the relay makes on its users' behalf arrives from the relay's one address.
 *
 * In-memory, so the counts are per process. For a multi-instance deployment, replace with a
 * shared (Redis-backed) counter so limits hold across replicas.
 */

import type express from 'express';

export interface RateLimitOptions { windowMs: number; max: number }

interface RateLimitEntry { count: number; resetAt: number }

export interface Limiter {
  readonly bucketName: string;
  readonly opts: RateLimitOptions;
  /** Count one request against `key`: the seconds to wait when that is over the cap, else null. */
  hit(key: string): number | null;
}

const buckets = new Map<string, Map<string, RateLimitEntry>>();

export function createLimiter(bucketName: string, opts: RateLimitOptions): Limiter {
  if (!buckets.has(bucketName)) buckets.set(bucketName, new Map());
  const bucket = buckets.get(bucketName)!;
  const current = (key: string, now: number): RateLimitEntry | undefined => {
    const entry = bucket.get(key);
    return entry && entry.resetAt >= now ? entry : undefined;
  };
  const wait = (entry: RateLimitEntry, now: number): number => Math.ceil((entry.resetAt - now) / 1000);
  return {
    bucketName,
    opts,
    hit(key) {
      const now = Date.now();
      let entry = current(key, now);
      if (!entry) {
        entry = { count: 0, resetAt: now + opts.windowMs };
        bucket.set(key, entry);
      }
      entry.count++;
      return entry.count > opts.max ? wait(entry, now) : null;
    },
  };
}

/** The caller's address. req.ip honors trust proxy (app.set('trust proxy', 1) in server.ts). */
export function clientIp(req: express.Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** The 429 every limiter answers with. `scope` says whose budget ran out. */
export function sendRateLimited(res: express.Response, limiter: Limiter, retryAfterSec: number, scope = 'on this IP'): void {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({
    error: 'rate_limit_exceeded',
    title: 'Too many requests',
    detail: `${limiter.opts.max} requests in a ${limiter.opts.windowMs / 1000}s window for ${limiter.bucketName} ${scope}. Retry in ${retryAfterSec}s.`,
    retryAfterSeconds: retryAfterSec,
  });
}

/** Middleware: every request counts against the caller's IP. */
export function rateLimit(bucketName: string, opts: RateLimitOptions) {
  const limiter = createLimiter(bucketName, opts);
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const retryAfterSec = limiter.hit(clientIp(req));
    if (retryAfterSec !== null) { sendRateLimited(res, limiter, retryAfterSec); return; }
    next();
  };
}

// Periodic cleanup of expired entries so a long-lived process doesn't
// accumulate entries from one-off attackers. Runs every 5 minutes;
// `unref` keeps Node from holding the event loop open for it.
setInterval(() => {
  const now = Date.now();
  for (const bucket of buckets.values()) {
    for (const [key, entry] of bucket) {
      if (entry.resetAt < now) bucket.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();
