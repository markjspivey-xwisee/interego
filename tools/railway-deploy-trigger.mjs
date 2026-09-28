/**
 * Trigger a Railway deployment, retrying ONLY a definite refusal, and never over a deployment
 * that may already be in flight.
 *
 * ★ A REFUSED TRIGGER LEAVES A SERVICE WRITTEN BUT NOT SHIPPED. `railway-redeploy.mjs` repoints
 * a service's image (`serviceInstanceUpdate`) and then ships it (`serviceInstanceDeployV2`); the
 * first alone changes what the service's source NAMES, not what runs (see railway-pins.mjs).
 * Measured 2026-09-28: two consecutive `Auto-deploy master` runs failed at the trigger with
 * "GraphQL: Problem processing request", seconds after the repoint had succeeded, first for the
 * Discord worker and then for the relay. The relay kept serving the previous build under a source
 * that named the new one, and a plain re-run of each failed job shipped it.
 *
 * ★★ AND RE-TRIGGERING IS NOT FREE, WHICH THE FIRST VERSION OF THIS FORGOT (Codex, on #560).
 * The redeploy script's own rule is "DO NOT RETRY": re-triggering while a deploy is in flight
 * SIGTERMs the healthy container, and its successors die before logging. The first version
 * retried whatever the tolerant GraphQL helper called transient, and that included a response
 * that was lost or could not be parsed, where Railway may well have ACCEPTED the trigger. So:
 *
 *   - Only a definite refusal is retried: Railway answered, and the answer was a GraphQL error
 *     (`GraphQL: …`). A failure to get or read the answer (`network: …`) is ambiguous and fails
 *     exactly as it did before any retry existed.
 *   - Even after a definite refusal, `reconcile` is asked first whether a deployment exists that
 *     did not exist before the repoint. If one does, it is FOLLOWED, never triggered over; the
 *     caller polls it as it would its own. Only when there is none is the trigger sent again.
 */

/**
 * Call `trigger` (which throws `GraphQL: …` for an answered refusal and anything else for an
 * ambiguous failure) at most `attempts` times, with doubling waits, following a deployment
 * `reconcile` reports instead of triggering over it.
 */
export async function triggerWithRetry(trigger, {
  attempts = 4,
  baseMs = 5000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = () => {},
  reconcile = async () => undefined,
} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await trigger();
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!message.startsWith('GraphQL: ')) throw error;
      if (attempt >= attempts) throw new Error(`${message} (the deploy trigger was refused ${attempt} times)`);
      const existing = await reconcile();
      if (existing) {
        log(`  … deploy trigger refused (${message}); deployment ${existing} exists since the repoint, following it`);
        return { serviceInstanceDeployV2: existing };
      }
      const wait = baseMs * 2 ** (attempt - 1);
      log(`  … deploy trigger refused (${message}); no deployment since the repoint, retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}
