/**
 * Trigger a Railway deployment, retrying the refusals Railway's API gives transiently.
 *
 * ★ A REFUSED TRIGGER LEAVES A SERVICE WRITTEN BUT NOT SHIPPED. `railway-redeploy.mjs` repoints
 * a service's image (`serviceInstanceUpdate`) and then ships it (`serviceInstanceDeployV2`); the
 * first alone changes what the service's source NAMES, not what runs (see railway-pins.mjs).
 * Measured 2026-09-28: two consecutive `Auto-deploy master` runs failed at the trigger with
 * "GraphQL: Problem processing request", seconds after the repoint had succeeded, first for the
 * Discord worker and then for the relay. The relay kept serving the previous build under a source
 * that named the new one. A plain re-run of each failed job shipped it, so the refusal was
 * transient, and the step that fails on it is the one step whose failure strands a service.
 *
 * So the trigger is retried, a bounded number of times with doubling waits, before the deploy
 * fails. Triggering again after a refusal is safe: the service is already repointed, and a second
 * trigger either starts the deployment the first did not or supersedes one it did.
 */

/**
 * Call `trigger` until it answers without `_transient` (the redeploy script's tolerant GraphQL
 * result), at most `attempts` times, waiting `baseMs`, then twice that, and so on between tries.
 * Throws with the last refusal once the attempts are spent.
 */
export async function triggerWithRetry(trigger, {
  attempts = 4,
  baseMs = 5000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  for (let attempt = 1; ; attempt++) {
    const out = await trigger();
    if (!out || typeof out !== 'object' || !('_transient' in out)) return out;
    if (attempt >= attempts) throw new Error(`GraphQL: ${out._transient} (the deploy trigger was refused ${attempt} times)`);
    const wait = baseMs * 2 ** (attempt - 1);
    log(`  … deploy trigger refused (${out._transient}); retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
}
