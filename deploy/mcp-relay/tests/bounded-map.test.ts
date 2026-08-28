/**
 * `mapBounded` — the ceiling that stops a boot stampeding the pod.
 *
 * ★★ THE OUTAGE. Every pod-backed store hydrated with an UNBOUNDED
 * `Promise.allSettled(urls.map(...))`. On 2026-08-28 the relay's service pod
 * held 292 federation entries and 104 refresh tokens, so one boot opened ~400
 * simultaneous reads against a single-replica CSS and EVERY read died on the
 * relay's own 15,000 ms deadline. The container listing had worked and returned
 * all 292 URLs; the reads are what failed, and a failed read is skipped, so the
 * agent directory came back EMPTY on every restart and WebFinger 404'd for
 * anyone who had not re-authenticated since.
 *
 * ★ SO THE PROPERTY UNDER TEST IS THE CEILING ITSELF, not "it visits every
 * item". A version that ran everything at once would pass a completeness check
 * and reproduce the outage exactly.
 */
import { mapBounded, POD_HYDRATE_CONCURRENCY } from '../bounded-map.js';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 1));

console.log('');
console.log('§1  the ceiling holds');
{
  for (const limit of [1, 2, 6, 25]) {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    const items = Array.from({ length: 120 }, (_, i) => i);
    await mapBounded(items, limit, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      seen.push(i);
      inFlight--;
    });
    check(`limit ${limit}: never more than ${limit} in flight (peak ${peak})`, peak <= limit,
      `peak was ${peak}`);
    check(`limit ${limit}: every one of the 120 items ran exactly once`,
      seen.length === 120 && new Set(seen).size === 120);
  }

  // ★ NON-VACUITY. If the ceiling silently did nothing, every case above still
  // passes its completeness half — so prove the peak can REACH the limit. A
  // ceiling of 6 that never ran more than 1 would be a serial loop, which is
  // correct but not what the boot budget assumes.
  let inFlight = 0; let peak = 0;
  await mapBounded(Array.from({ length: 60 }, (_, i) => i), 6, async () => {
    inFlight++; peak = Math.max(peak, inFlight); await tick(); inFlight--;
  });
  check('★ and the ceiling is actually USED — peak reaches 6, not 1', peak === 6, `peak ${peak}`);
}

console.log('');
console.log('§2  it cannot hang a boot');
{
  // ★ A ceiling below 1 would start no worker and never settle. That is a hang
  // at BOOT, which is worse than the fan-out this module exists to remove, so
  // it clamps rather than throws.
  for (const bad of [0, -3, Number.NaN]) {
    let ran = 0;
    const done = await Promise.race([
      mapBounded([1, 2, 3], bad, async () => { ran++; }).then(() => 'settled'),
      new Promise<string>(r => setTimeout(() => r('HUNG'), 2000)),
    ]);
    check(`limit ${String(bad)} settles instead of hanging`, done === 'settled');
    check(`limit ${String(bad)} still ran all 3`, ran === 3, `ran ${ran}`);
  }
  check('an empty list settles', await mapBounded([], 6, async () => {}).then(() => true));
}

console.log('');
console.log('§3  one failure does not lose the rest');
{
  // Every caller reports its own per-item failure and pushes successes into an
  // array, so a throw must be swallowed exactly as Promise.allSettled did. If
  // it propagated, ONE unreadable federation file would empty the directory —
  // which is the shape of the bug this replaces, one level down.
  const ok: number[] = [];
  await mapBounded([1, 2, 3, 4, 5, 6], 3, async (i) => {
    if (i % 2 === 0) throw new Error(`item ${i} is unreadable`);
    await tick();
    ok.push(i);
  });
  check('the odd items survive three throwing neighbours', ok.sort().join(',') === '1,3,5',
    `got ${ok.join(',')}`);
}

console.log('');
console.log('§4  the shipped ceiling');
{
  check('POD_HYDRATE_CONCURRENCY is a small positive integer',
    Number.isInteger(POD_HYDRATE_CONCURRENCY) && POD_HYDRATE_CONCURRENCY >= 1
    && POD_HYDRATE_CONCURRENCY <= 16,
    `it is ${POD_HYDRATE_CONCURRENCY}`);
  // ★ Four stores hydrate CONCURRENTLY at boot, so the real ceiling against CSS
  // is four times this one. 6 gives 24 in flight, which is the number that has
  // to stay defensible — not 6.
  check('four stores at this ceiling stay under 32 concurrent reads',
    POD_HYDRATE_CONCURRENCY * 4 <= 32);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
