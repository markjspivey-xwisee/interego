/**
 * Lightweight structured timing logger.
 *
 * Lets the identity server log per-step latency around the /auth/did
 * cold path (DID parse / signature verify / identity lookup / pod write)
 * so future operators can spot regressions without re-wiring profiling.
 *
 * Output format (single line, machine-parseable):
 *   [identity-timing] step=did-parse did=did:key:z6Mk… ms=2.4 cache=hit
 *
 * Gated by IDENTITY_TIMING env var so production builds default to
 * silent. Set IDENTITY_TIMING=1 to enable. The hot path never builds a
 * string when disabled — the guard runs before label/extras evaluation.
 */

const ENABLED = (() => {
  const v = process.env['IDENTITY_TIMING'];
  return v === '1' || v === 'true';
})();

export function timingEnabled(): boolean {
  return ENABLED;
}

/**
 * Start a timing span. Returns the start time in ms (performance.now()
 * units — monotonic, sub-ms resolution). Pair with logTiming(label, start, extras).
 */
export function startTiming(): number {
  return performance.now();
}

/**
 * Log a structured timing line. Cheap no-op when IDENTITY_TIMING is unset.
 *
 *   logTiming('did-parse', t0, { did, cache: 'hit' })
 */
export function logTiming(
  label: string,
  startMs: number,
  extras: Record<string, string | number | boolean | undefined> = {},
): void {
  if (!ENABLED) return;
  const dur = (performance.now() - startMs).toFixed(2);
  const parts: string[] = [`step=${label}`, `ms=${dur}`];
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined) continue;
    // Quote string values that contain spaces; leave numbers/bools bare.
    if (typeof v === 'string' && /\s/.test(v)) {
      parts.push(`${k}="${v.replace(/"/g, '\\"')}"`);
    } else {
      parts.push(`${k}=${v}`);
    }
  }
  // Stable prefix so log aggregators can split timings from regular logs.
  console.log(`[identity-timing] ${parts.join(' ')}`);
}
