/**
 * HOW FAST A CONVERSATION MOVES, WHICH IS MOSTLY THIS FILE'S DECISION.
 *
 * `pollingWatch` is how BOTH readers of a workspace notice anything: the desktop client and the
 * Discord bot. It polled at a flat 45 s, so the wall-clock of a channel conversation was dominated
 * by waiting rather than by thinking —
 *
 *     you type in Discord → gateway → pod      fast (a websocket)
 *     the desktop notices                      0–45 s   ← this poll
 *     the model turn                           3–30 s
 *     the desktop posts → pod                  fast
 *     the bot notices                          0–45 s   ← this poll again
 *
 * ~45 s of dead time on average, up to 90 s, on top of the answer. And polling is not a choice on
 * this deployment: the per-pod notification channel is unreachable in both directions and `/sse`
 * re-sends the same five entries every 2 s with no graph IRI — both measured, both documented in
 * `transport.ts`.
 *
 * ── ★★ WHY BOTH HALVES ARE NEEDED, AND WHAT THEY COST ────────────────────────
 *
 * The first attempt used change-detection alone: snap to 2 s when something moves, decay back to a
 * 45 s ceiling when it does not. That is not enough, and the test below is what showed it — a
 * quiet channel sits at its ceiling, and THE FIRST MESSAGE AFTER A SILENCE IS THE ONE SOMEBODY IS
 * WAITING ON. Change detection cannot shorten that wait, because the change is the thing it is
 * waiting to see. Measured against that version: a live exchange still took ~45 s to get going.
 *
 * So the ceiling came down to 10 s as well, and THAT IS A REAL COST, not a free win: each watcher
 * reads six times a minute while idle instead of about one and a third. Two watchers on a channel
 * is roughly twelve reads a minute against three. These tests pin both halves and the price.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { pollingWatch } from '../packages/core/src/relay/transport.js';

afterEach(() => { vi.useRealTimers(); });

/** The shared quiet ceiling, restated here so a change to it fails these tests loudly. */
const QUIET_MS = 10_000;

/**
 * ★ ONE CLOCK AT A TIME. Measured on 2026-09-21 (run 35552497204 on a loaded runner): the 300 s
 * quiet test overran the 20 s budget, and vitest moves on from a timed-out test WITHOUT stopping
 * it — its loop kept advancing the fake clock under the next test, which then counted 10 reads in
 * what it believed was 60 s and failed for a reason that had nothing to do with the cadence. Each
 * run takes a generation number and stops advancing the moment another run has begun; the steps
 * are 1 s rather than 250 ms (the shortest cadence under test is 1 s, and timers still fire in
 * order within a step), and the long test states its own budget.
 */
let generation = 0;
async function advance(mine: number, forMs: number, step = 1_000): Promise<void> {
  for (let t = 0; t < forMs && generation === mine; t += step) await vi.advanceTimersByTimeAsync(step);
}

/** Drive the watcher's timers deterministically, and count the reads it makes. */
async function run(payloads: readonly unknown[], forMs: number, ceiling = QUIET_MS): Promise<number> {
  vi.useFakeTimers();
  const mine = ++generation;
  let i = 0;
  let reads = 0;
  const stop = pollingWatch(
    async () => { const p = payloads[Math.min(i, payloads.length - 1)]; i++; reads++; return p; },
    'read_channel', {}, () => { /* events are not what these tests are about */ },
    { refetchInterval: ceiling },
  );
  await advance(mine, forMs);
  stop();
  return reads;
}

describe('the cadence follows the conversation', () => {
  it('★★ a live channel is read every couple of seconds, not every 45', async () => {
    // Every read returns something new, which is what a live conversation looks like. At the old
    // flat 45 s this was ~1 read in 60 s; what matters here is the order of magnitude.
    const reads = await run(Array.from({ length: 400 }, (_, n) => ({ entry: n })), 60_000);
    expect(reads).toBeGreaterThan(20);
  });

  it('★★ and a QUIET channel is still read within the ceiling, which is what the first message needs', async () => {
    /**
     * The half that change-detection cannot provide. Nothing is moving, so the watcher sits at its
     * ceiling — and the next thing to happen is somebody speaking into a silent channel, which is
     * precisely the message a person is waiting on. 300 s of silence at a 10 s ceiling is ~30
     * reads; at the old 45 s it was ~7, and that difference IS the responsiveness.
     */
    const reads = await run([{ same: true }], 300_000);
    expect(reads).toBeGreaterThan(20);
    expect(reads).toBeLessThan(40);
  }, 60_000);

  it('★ the price of that is stated rather than hidden: ~6 reads a minute per watcher when idle', async () => {
    // Written down as a test so the cost cannot drift without somebody deciding to change it.
    const reads = await run([{ same: true }], 60_000);
    expect(reads).toBeGreaterThanOrEqual(4);
    expect(reads).toBeLessThanOrEqual(8);
  });

  it('★ a failing relay is backed off to the ceiling, not retried every two seconds', async () => {
    vi.useFakeTimers();
    const mine = ++generation;
    let reads = 0;
    const stop = pollingWatch(
      async () => { reads++; throw new Error('relay is down'); },
      'read_channel', {}, () => { /* the error event itself is not under test */ },
      { refetchInterval: QUIET_MS },
    );
    await advance(mine, 60_000);
    stop();
    // At the ceiling, not the active cadence: a relay returning errors is not a live conversation,
    // and 30 failed reads a minute helps nobody.
    expect(reads).toBeLessThanOrEqual(8);
  });

  it('★ stopping actually stops it', async () => {
    vi.useFakeTimers();
    const mine = ++generation;
    let reads = 0;
    const stop = pollingWatch(
      async () => { reads++; return { n: reads }; },
      'read_channel', {}, () => { /* ignored */ },
      { refetchInterval: QUIET_MS },
    );
    await advance(mine, 10_000);
    const atStop = reads;
    stop();
    await advance(mine, 60_000);
    // ★ The loop reschedules itself from inside a promise callback, so "stopped" has to be checked
    // on the way out as well as on the way in. Without that a cancelled watch keeps polling
    // forever, which on a client that opens one per workspace is a leak nobody would see.
    expect(reads).toBe(atStop);
  });

  it('★ a ceiling below the active cadence is respected rather than inverted', async () => {
    // A caller asking for 1 s must not be given 2 s because the active floor is written down here.
    const reads = await run(Array.from({ length: 200 }, (_, n) => ({ n })), 10_000, 1_000);
    expect(reads).toBeGreaterThan(5);
  });
});
