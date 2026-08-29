/**
 * WHICH ORIGINS ARE THIS DEPLOYMENT'S OWN STORE — and the one rewrite between their spellings.
 *
 * ── ★★ WHY THIS IS A MODULE AND NOT A FOURTH ANSWER ────────────────────────────────────────
 *
 * One CSS store answers to two names here: the public write-gate that everything derived from an
 * identity yields, and the env-internal host the relay reaches it at and stamps onto a caller's
 * `subject_pod_url`. Three places in this vertical needed to know that, and each answered it in its
 * own spelling:
 *
 *   · `SAME_STORE_ORIGINS` / `sameStore` in bridge/server.ts — a whole-origin allow-list built from
 *     FOXXI_TENANT_POD_URL and FOXXI_CSS_INTERNAL_URL. Correct.
 *   · `canonicalPublicPodUrl` in bridge/server.ts — the public spelling of a pod on this store, for
 *     identifiers that get PUBLISHED. Correct, because it asks `sameStore` first.
 *   · `toAdvertisedHolonUrl` in src/foundation-persist.ts — the same question about a holon URL,
 *     asked as `u.host.includes('.internal.')`. NOT correct, and it failed in both directions at
 *     once. See that function for the measurement.
 *
 * ★ THE SUBSTRING WAS COUPLED TO A HOSTING PROVIDER, WHICH IS WHY IT ROTTED SILENTLY. Azure
 * Container Apps synthesizes an internal FQDN of the form
 * "interego-css.internal.livelysky-ID.eastus.azurecontainerapps.io", where the dotted ".internal."
 * really does appear. Railway's is "css.railway.internal:3456", where it does not — ".internal" is
 * the final label, so nothing follows the second dot. The fleet moved; the test kept passing over
 * inputs it no longer matched, and no error was raised on either side of it.
 *
 * ★ MEMBERSHIP, NEVER A SUBSTRING. Two literal origins compared by equality match nothing else. A
 * substring, prefix or suffix test over a host re-opens the lookalike ("gate.interego.xwisee.com."
 * plus an attacker suffix) that this deployment has already been bitten by twice — once in the
 * write-bearer attach, once in the `selfBoundPod` override guard.
 *
 * ── ★★ AND THE SPELLINGS ARE SUPPLIED, NOT READ OUT OF THE ENVIRONMENT HERE ─────────────────
 *
 * This module reads no environment variable at all, and that is load-bearing rather than tidy.
 * `toAdvertisedHolonUrl` used to read FOXXI_TENANT_POD_URL directly, which is exactly why nothing
 * ever tested it: applications/_shared/tests/shared-live-externals.test.ts records that name as a
 * live address NOTHING IN THE TREE SUPPLIES, and re-measures that over every tracked file — so a
 * test that set it to exercise the function would red that guard, and rightly. A decision that can
 * only be reached by writing to the process environment is a decision no test can reach.
 *
 * So the deployment edge — bridge/server.ts, the one place that already knows both names — calls
 * `configureStoreSpelling` once at start-up, and everything under src/ asks this module.
 *
 * ★ UNCONFIGURED FAILS CLOSED. With no configuration the store has exactly one known name, the
 * caller's own fallback, so nothing is ever re-spelled ONTO it and a URL from anywhere else is
 * returned untouched. That is the safe direction: the worst case is a link that names the host it
 * was written to, which is what the broken substring was already doing.
 */

/** The two names this deployment's own store answers to. */
export interface StoreSpelling {
  /** The publicly-resolvable pod URL — the spelling published identifiers and links must use. */
  readonly publicPodUrl: string;
  /** The env-internal spelling of the SAME store, when this deployment has split its ingress. */
  readonly internalPodUrl?: string | undefined;
}

let deploymentSpelling: StoreSpelling | undefined;

/**
 * Declare what this deployment's own store is called. Called once, at the edge that knows —
 * bridge/server.ts. Pass `undefined` to clear it (which is what a test that has finished with a
 * spelling should do, so the next one does not inherit it).
 */
export function configureStoreSpelling(spelling: StoreSpelling | undefined): void {
  deploymentSpelling = spelling;
}

/**
 * The configured spelling, or a single-name store built from `publicFallback` when nothing has been
 * configured. `publicFallback` is what the caller already believes the public pod URL to be.
 */
export function storeSpelling(publicFallback: string): StoreSpelling {
  return deploymentSpelling ?? { publicPodUrl: publicFallback };
}

function originOf(url: string): string {
  try {
    const o = new URL(url).origin;
    // Every non-special scheme reports "null" as its origin, so a pathological configured URL could
    // otherwise put that string into the set and make every opaque-scheme URL "this store".
    return o === 'null' || o === '' ? '' : o;
  } catch {
    return '';
  }
}

/**
 * The origins that are this store, and nothing else. Never contains an empty or opaque origin, so a
 * URL whose origin is not in this set is somebody else's.
 */
export function storeOriginsFor(spelling: StoreSpelling): ReadonlySet<string> {
  return new Set([spelling.publicPodUrl, spelling.internalPodUrl ?? ''].map(originOf).filter((o) => o !== ''));
}

/**
 * The PUBLICLY-RESOLVABLE spelling of a URL on this store — for identifiers and links that get
 * PUBLISHED, never for a fetch.
 *
 * ★ ONLY OUR STORE MOVES, AND ONLY ITS ORIGIN. A URL on any other origin is returned untouched:
 * re-spelling a foreign host onto ours is precisely the laundering that made the relay's
 * `toInternalPodUrl` an oracle — it discarded the host and pasted the path onto our own store, so a
 * caller-supplied origin became a local address. Path, query and fragment are carried through
 * unchanged, because the gate routes the same path to the same CSS resource.
 *
 * Returns the input unchanged, rather than undefined, and the difference from the relay's helper is
 * deliberate: that one answers "give me a URL on our store", where a foreign input has no safe
 * answer at all. This one answers "how should this URL be spelled to a reader", and for a URL that
 * is not ours the answer is the URL itself.
 */
export function publicSpellingOf(url: string, spelling: StoreSpelling): string {
  const publicOrigin = originOf(spelling.publicPodUrl);
  if (!publicOrigin) return url;
  const mine = storeOriginsFor(spelling);
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const origin = originOf(url);
  if (!origin || !mine.has(origin)) return url;
  // No early return for a url ALREADY on the public origin, deliberately: `canonicalPublicPodUrl`
  // in bridge/server.ts re-composes that case too, and re-composing normalises a default port and
  // drops userinfo. Returning early would be a second, invisible difference between the two.
  return `${publicOrigin}${u.pathname}${u.search}${u.hash}`;
}
