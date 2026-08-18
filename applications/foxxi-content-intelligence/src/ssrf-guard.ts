/**
 * The SSRF screen — now the substrate's, re-exported here.
 *
 * ── ★★ WHY THIS FILE IS A SHIM AND NOT A DELETION ───────────────────────────────────────────
 *
 * The implementation moved to `@interego/core` (`net/guarded-fetch.ts`) because it was never one
 * vertical's problem: a system audit found the same screen independently re-implemented at the relay
 * and ABSENT from a third vertical that fetches caller-supplied source URLs. A guard that ships
 * inside one application is a guard the next application does not get.
 *
 * ★ THE SHIM IS THE POINT OF THE MOVE, not laziness about it. Twenty-odd modules in this vertical
 * import `./ssrf-guard.js`, and rewriting every import in the same change as relocating a SECURITY
 * primitive would put the risky edit and the noisy edit in one diff, where a missed call site reads
 * as churn rather than as a hole. One line here keeps every caller on the shared screen; the imports
 * can be straightened later, or never — they resolve to the same function either way.
 */
export {
  isPrivateHostname,
  assertSafeFetchTarget,
  safePublicUrlOrUndefined,
  safeFetch,
  guardedFetchFn,
} from '@interego/core';
