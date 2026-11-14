/**
 * What a public HTTP surface needs before any of its own routes run, with no framework in it:
 * a per-client request limit, a ceiling for tables callers can fill, the check that a configured
 * public URL is an origin, and the `/health` body the deploy verifier reads.
 */
export { bound } from './bounded.js';
export { healthBody, type HealthBody, type HealthInput } from './health.js';
export { PublicUrlError, publicOrigin } from './public-origin.js';
export {
  DEFAULT_MAX_RATE_CLIENTS, RateLimiter, clientKey, foldAddress,
  type RateRule, type RateVerdict,
} from './rate-limit.js';
