/**
 * The gate the Tier 3 LRS bodies sit behind — and the reason it now THROWS rather than skips.
 *
 * ★ WHAT WAS MEASURED. Running the three Tier 3 files on this tree:
 *
 *     npx vitest run applications/lrs-adapter/tests/tier3-real-lrs.test.ts \
 *                    applications/lrs-adapter/tests/tier3b-xapi-conformance.test.ts \
 *                    applications/lrs-adapter/tests/tier3c-scorm-cloud.test.ts
 *     Tests  2 passed | 18 skipped (20)      exit 0
 *
 * The 2 that passed asserted `typeof reachable === 'boolean'`, which is true of `false`. No
 * workflow started an LRS, and bridge-typecheck.yml runs the whole root suite — so these files
 * were COLLECTED on every pull request and had never evaluated one wire-level assertion.
 *
 * ★ THE MECHANISM, WHICH IS NOT "NO WORKFLOW STARTED IT". The old gate was a DETECTOR:
 * `try { fetch('/about') } catch { return false }` collapses Docker-not-running, wrong port,
 * container-never-healthy, rotated credential and an image that stopped advertising 2.0.0 into
 * one value — and that value routed to `ctx.skip()`, which is green. No input could make CI
 * red. Bolting a service container onto a detector would buy a green run that still proves
 * nothing the day the container fails to boot.
 *
 * So LRSQL_IT is a DECLARATION, not a detection — the same shape as PGSL_PG_IT in
 * tests/pgsl-store-pg-integration.test.ts, which .github/workflows/pgsl-store-pg.yml sets in
 * the job that stands the container up. Set, it means "a real Lrsql is supposed to be here";
 * absence then FAILS. Unset, unreachable still skips, so a laptop with no Docker — and the
 * whole-root-suite step in bridge-typecheck.yml, which has no LRS and never will — still runs
 * everything else.
 */

export const LRS_BASE = 'http://localhost:8080/xapi';
export const AUTH_HEADER = 'Basic ' + Buffer.from('testapikey:testapisecret').toString('base64');
export const XAPI_VERSION = '2.0.0';

export const COMMON_HEADERS: Record<string, string> = {
  'Authorization': AUTH_HEADER,
  'X-Experience-API-Version': XAPI_VERSION,
  'Content-Type': 'application/json',
};

/** Set only by .github/workflows/lrs-adapter-conformance.yml, which provisions the container. */
export const LRSQL_REQUIRED = process.env['LRSQL_IT'] === '1';

/**
 * Returns WHY, not just whether. The old probes returned a bare boolean, so the CI log for a
 * missing LRS was byte-identical to the log for a rotated credential — and both read "skipped".
 */
async function probe(): Promise<{ ok: boolean; why: string }> {
  // `&& !LRSQL_REQUIRED` is DIAGNOSTIC, not a verdict guard — measured by deleting it, which
  // left the run just as red. The verdict is protected further down by `!ok && LRSQL_REQUIRED`:
  // a shell that exports SKIP_LRSQL_TESTS=1 into the provisioning job cannot make it green
  // either way, because this early return still yields `ok: false`. What the clause buys is the
  // REASON: without it a run under LRSQL_IT=1 fails saying "but: SKIP_LRSQL_TESTS=1", which
  // reads as the operator's own doing and sends them to the wrong file. With it the probe is
  // actually attempted, so the failure names what really went wrong with the container.
  if (process.env['SKIP_LRSQL_TESTS'] === '1' && !LRSQL_REQUIRED) {
    return { ok: false, why: 'SKIP_LRSQL_TESTS=1' };
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    const r = await fetch(`${LRS_BASE}/about`, {
      headers: { 'Authorization': AUTH_HEADER, 'X-Experience-API-Version': XAPI_VERSION },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, why: `GET ${LRS_BASE}/about -> HTTP ${r.status}` };
    const body = await r.json() as { version?: string[] };
    // tier3b's copy of this probe checked only `r.ok`, so an LRS that had dropped xAPI 2.0
    // would have opened its gate and failed seven bodies on the wire instead of saying so
    // here. One probe, one version check.
    if (!body.version?.includes(XAPI_VERSION)) {
      return { ok: false, why: `/about advertises ${JSON.stringify(body.version)}, not xAPI ${XAPI_VERSION}` };
    }
    return { ok: true, why: 'reachable' };
  } catch (err) {
    return { ok: false, why: `GET ${LRS_BASE}/about threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Call from `beforeAll`. Under LRSQL_IT=1 a missing LRS throws, and a throw in beforeAll fails
 * every body in the file — which is the entire point: the alternative was green skips.
 */
export async function reachLrsqlOrFail(): Promise<boolean> {
  const { ok, why } = await probe();
  if (!ok && LRSQL_REQUIRED) {
    throw new Error(
      `LRSQL_IT=1 declares a real Lrsql must be serving xAPI ${XAPI_VERSION} at ${LRS_BASE}, but: ${why}. `
      + 'Refusing to skip — a skipped body is a green body, and these bodies are the only thing in '
      + 'this repo that exercises the adapter wire format against an LRS we did not write.',
    );
  }
  if (!ok) console.warn(`Lrsql at ${LRS_BASE} unavailable (${why}); Tier 3 bodies skipped (LRSQL_IT is unset)`);
  return ok;
}
