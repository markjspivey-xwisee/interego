/**
 * @module solid/retry
 * @description Back-compat re-export shim.
 *
 * The substrate-level transient-network retry helper used to live here.
 * It is not Solid-specific and now lives in `../http/retry`. This file
 * preserves the historical import path (`@interego/core` re-exported the
 * symbols from `solid/`) so existing callers keep working.
 */

export {
  withTransientRetry,
  isTransientNetworkError,
} from '../http/retry.js';
export type { TransientRetryOptions } from '../http/retry.js';
