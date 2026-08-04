/**
 * The pod these Tier 2 / Tier 8 suites write against, and an HONEST reason when they skip.
 *
 * ★ THE DEFECT THIS REPLACES. Five test files hardcoded
 * `https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io` as their
 * default host. That host was DELIBERATELY DESTROYED when the stack moved to Railway — it
 * resolves to nothing (`curl` returns 000). Each file probed it, timed out after 8s, skipped
 * 5-of-6 and 3-of-4 tests, and reported `✓`. So the whole-tree run that gates every PR spent
 * ~16s of wall clock waiting for a DNS/TCP timeout in order to print a green tick over
 * assertions that can never run again.
 *
 * A reachability probe against a host somebody deliberately deleted is not a skip condition;
 * it is a permanently-off test wearing a checkmark. And the failure was identical in five
 * files, which is why the target now lives here rather than being repaired five times.
 *
 * ★ WHY THESE STILL SKIP WITHOUT A CREDENTIAL, AND WHY THAT IS DIFFERENT. The suites PUT to
 * the pod. The Railway css-gate — unlike the old allow-all Azure CSS these were written
 * against — requires `Authorization: Bearer <WRITE_SECRET>` on every write. So without
 * `INTEREGO_POD_WRITE_SECRET` they cannot write, and they say exactly that instead of
 * blaming an unreachable host. The distinction matters: "no credential configured" is a
 * thing a maintainer can act on, "unreachable" pointed at a dead end.
 *
 * ★ MEASURED, WITH THE CREDENTIAL SET. Against the live Railway pod:
 *   - `_shared/tests/tier2-azure-css.test.ts`                   6/6 pass
 *   - `agent-collective/tests/tier8-real-pod-end-to-end.test.ts` 4/4 pass, including the
 *     full author → attest → promote → bundle → cross-bridge chime + audit lifecycle
 * These are assertions the old default host made permanently unrunnable.
 *
 * ★ THE REMAINING THREE, AND THE EXACT ONE-LINE CHANGE EACH NEEDS. `agent-development-
 * practice`, `learner-performer-companion` and `lrs-adapter` reach a live pod now, but
 * their Tier 8 suites still cannot WRITE through their own vertical APIs: each declares its
 * own `PublishConfig` in `src/pod-publisher.ts` with no seam to carry the gate bearer, so
 * `publish()` is called with no `fetch`. `agent-collective` is the worked example — add
 * `readonly fetch?: typeof globalThis.fetch` to that vertical's `PublishConfig` and thread
 * `config.fetch ? { fetch: config.fetch } : {}` into its `publish(...)` calls, then pass
 * `podFetch` from the suite. Written down as a specific task rather than left as a skip
 * whose cause has to be rediscovered.
 */

/** The live css-gate. Override for a local CSS or an alternate gate deployment. */
export const POD_HOST = process.env['AZURE_CSS_BASE']
  ?? process.env['INTEREGO_POD_BASE']
  ?? 'https://gate.interego.xwisee.com';

/**
 * Pod container these suites read and write. Interego pod data is disposable, so this
 * container may legitimately not exist yet — that is reported as its own skip reason rather
 * than being folded into "unreachable".
 */
export const TEST_POD_BASE = `${POD_HOST}/${process.env['INTEREGO_TEST_POD'] ?? 'u-pk-6e3bc2f9723c'}/`;

/** Bearer the css-gate requires on POST/PUT/PATCH/DELETE. Absent ⇒ the suite skips. */
const WRITE_SECRET = process.env['INTEREGO_POD_WRITE_SECRET'] ?? process.env['FOXXI_POD_WRITE_SECRET'];

export function podWriteHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return WRITE_SECRET ? { ...extra, Authorization: `Bearer ${WRITE_SECRET}` } : { ...extra };
}

/**
 * A `fetch` that carries the gate bearer, for injection into `publish(..., { fetch })`.
 *
 * The credential is supplied at the CALL SITE rather than read inside `@interego/solid`:
 * the library must not learn to source a pod secret from the environment, because that is
 * an ambient authority every consumer would then inherit. `PublishOptions.fetch` is the
 * seam that already exists for exactly this.
 */
export const podFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (WRITE_SECRET) headers.set('Authorization', `Bearer ${WRITE_SECRET}`);
  return fetch(input, { ...init, headers });
};

const PROBE_TIMEOUT_MS = 5000;

export interface PodAvailability {
  readonly usable: boolean;
  /** Printed by the suite's first test, so a skip always states its cause. */
  readonly reason: string;
}

/**
 * Decide whether the pod suites can actually run, and say why not when they cannot.
 * Never throws — a probe that throws would turn a skip into a red on an unrelated PR.
 */
export async function probePod(): Promise<PodAvailability> {
  if (process.env['SKIP_AZURE_TESTS'] === '1' || process.env['SKIP_POD_TESTS'] === '1') {
    return { usable: false, reason: 'SKIP_POD_TESTS/SKIP_AZURE_TESTS is set' };
  }
  if (!WRITE_SECRET) {
    return {
      usable: false,
      reason: `no write credential: set INTEREGO_POD_WRITE_SECRET to exercise ${TEST_POD_BASE} `
        + '(the css-gate requires a bearer on every write; the old allow-all CSS these were '
        + 'written against no longer exists)',
    };
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    const r = await fetch(TEST_POD_BASE, { method: 'GET', signal: ac.signal });
    clearTimeout(timer);
    if (r.ok) return { usable: true, reason: 'pod reachable and a write credential is configured' };
    return { usable: false, reason: `pod ${TEST_POD_BASE} returned HTTP ${r.status}` };
  } catch (e) {
    return { usable: false, reason: `pod ${TEST_POD_BASE} unreachable: ${(e as Error).message}` };
  }
}
