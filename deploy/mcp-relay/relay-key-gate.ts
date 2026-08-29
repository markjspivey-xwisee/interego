/**
 * MAY THIS CALLER HAVE THE RELAY'S DECRYPTION KEY FOR THIS URL?
 *
 * ── ★★ IT WAS A DECRYPTION ORACLE ───────────────────────────────────────────────────────────
 *
 * `relayAgentKey` is ONE process-wide X25519 keypair that every graph published here is encrypted
 * to. The gate deciding whether to apply it was a single line in server.ts:
 *
 *     toInternalPodUrl(target).startsWith(toInternalPodUrl(own))
 *
 * and `toInternalPodUrl` DISCARDED the host — it pasted the path onto our own store. (It now
 * returns `undefined` for anything not on a STORE_ORIGINS member, so that laundering is closed at
 * the function; this gate does not depend on that and stays.) So the
 * comparison reduced to a path-prefix test whose both sides the caller controls. A victim's
 * ciphertext is public bytes: copy it, serve it from your own host at
 * `/eth-<your-own-12hex>/anything.jose.json`, ask the relay to read it, and it decrypts somebody
 * else's private graph for you. Same class as the unauth decryption oracle closed in the round-26
 * audit, at a site that fix never reached.
 *
 * ★★★ EXTRACTED SO THE TEST TESTS THIS AND NOT A COPY OF IT. The first version of this fix lived
 * inline in `server.ts`, which starts an HTTP listener at import and therefore cannot be loaded
 * into a test process — so its test RESTATED the rule locally. A hostile reviewer reverted
 * `server.ts` to the vulnerable version and ran that suite: the headline assertion, "an
 * attacker-hosted copy of somebody else's ciphertext gets no key", PASSED. Nine of twelve
 * assertions were exercising the restatement and knew nothing about the relay. A gate whose test
 * cannot fail when the gate is removed is not a gate. This module is importable, so it is the
 * thing under test.
 *
 * ★ AND THE RAW TARGET IS SCREENED, BEFORE ANYTHING LAUNDERS IT. The first version screened the
 * output of `toInternalPodUrl` — the value AFTER the attacker's host had already been rewritten to
 * ours — so the origin check could only ever see our own origin and passed everything. A check
 * placed downstream of the laundering is not defence in depth, it is decoration.
 */

export interface RelayKeyGateInput {
  /** Exactly what the caller named. NEVER a folded, normalised or otherwise helped value. */
  readonly targetUrl: string;
  /** The caller's own pod, derived server-side from the session — never from the request. */
  readonly ownPodUrl: string;
  /** The exact origins that ARE this deployment's store: both legitimate spellings of one thing. */
  readonly storeOrigins: ReadonlySet<string>;
}

/**
 * True only when `targetUrl` names something inside the caller's OWN pod, on this store.
 *
 * Both spellings of the store are accepted on either side, because they are one store — a caller
 * addressing its pod by the PUBLIC url it was given must be able to read its own private graphs,
 * and an earlier draft that required the two origins to be equal broke exactly that.
 */
export function mayUseRelayKey(input: RelayKeyGateInput): boolean {
  const { targetUrl, ownPodUrl, storeOrigins } = input;
  if (typeof targetUrl !== 'string' || typeof ownPodUrl !== 'string') return false;
  let target: URL; let own: URL;
  try { target = new URL(targetUrl); own = new URL(ownPodUrl); } catch { return false; }

  // Not our store at all: nothing there is the caller's, whatever the path says. This is the
  // check the oracle was missing, and it is made against the RAW host.
  if (!storeOrigins.has(target.origin)) return false;
  if (!storeOrigins.has(own.origin)) return false;

  /**
   * ★ AN ENCODED SEPARATOR SURVIVES NORMALISATION AND RE-BECOMES ONE LATER. `new URL()` resolves
   * `../` and `%2E%2E/` but NOT `..%2f` — measured: `…/eth-mine/..%2feth-victim/secret.jose.json`
   * stays one long segment, passes a prefix test, and is a traversal again wherever the far end
   * decodes it. We do not know what CSS does with it and do not need to: a pod path with an
   * encoded slash or backslash is not a path we mint, so it is refused rather than reasoned about.
   */
  if (/%2f|%5c/i.test(target.pathname)) return false;

  /**
   * The boundary is a trailing slash, or `eth-abc` is a prefix of `eth-abcdef` and a different
   * principal's pod reads as the caller's own.
   */
  const ownPath = own.pathname.endsWith('/') ? own.pathname : `${own.pathname}/`;
  // A pod root with no segment is the whole store — never "the caller's own pod".
  if (ownPath === '/') return false;
  return target.pathname.startsWith(ownPath);
}
