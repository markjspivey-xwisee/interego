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
 * ★ SO THE CADENCE FOLLOWS THE CONVERSATION, and these tests pin the three properties that make
 * that safe: it goes fast when something moved, it settles back when nothing does, and a failing
 * relay is not hammered. A cadence regression is silent — everything still works, just slowly —
 * which is exactly the kind of thing nobody notices until a user says "why is it so slow".
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { pollingWatch } from '../packages/core/src/relay/transport.js';

afterEach(() => { vi.useRealTimers(); });

/** Drive the watcher's timers deterministically, and count the reads it makes. */
async function run(payloads: readonly unknown[], forMs: number, ceiling = 45_000): Promise<number> {
  vi.useFakeTimers();
  let i = 0;
  let reads = 0;
  const stop = pollingWatch(
    async () => { const p = payloads[Math.min(i, payloads.length - 1)]; i++; reads++; return p; },
    'read_channel', {}, () => { /* events are not what these tests are about */ },
    { refetchInterval: ceiling },
  );
  // Advance in small steps so every scheduled timer fires in order.
  for (let t = 0; t < forMs; t += 250) await vi.advanceTimersByTimeAsync(250);
  stop();
  return reads;
}

describe('the cadence follows the conversation', () => {
  it('★★ a channel that keeps changing is read within seconds, not within a minute', async () => {
    // Every read returns something new, which is what a live conversation looks like. At the old
    // flat 45 s this would be 3 reads in two minutes; the point is that it is now many more.
    const changing = Array.from({ length: 200 }, (_, n) => ({ entry: n }));
    const reads = await run(changing, 60_000);
    // 60 s at the 2 s active cadence is ~30 reads. Asserted as a floor rather than a number, so
    // this does not fail on scheduler jitter — what matters is the ORDER OF MAGNITUDE change.
    expect(reads).toBeGreaterThan(20);
  });

  it('★ a quiet channel settles back to the ceiling, so idle cost is unchanged', async () => {
    // Same payload every time: nothing is happening. The interval doubles 2 → 4 → 8 → 16 → 32 → 45
    // and stays there, so a channel nobody is using costs what it always did.
    const reads = await run([{ same: true }], 300_000);
    // 300 s of silence: about 6 backoff steps then ~45 s apart — well under twenty reads. At the
    // active cadence it would be 150.
    expect(reads).toBeLessThan(20);
    // And it never stops entirely: a channel that went silent must still notice when it wakes.
    expect(reads).toBeGreaterThan(5);
  });

  it('★ a failing relay is backed off, not hammered twenty times a minute', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const stop = pollingWatch(
      async () => { reads++; throw new Error('relay is down'); },
      'read_channel', {}, () => { /* the error event itself is not under test */ },
      { refetchInterval: 45_000 },
    );
    for (let t = 0; t < 60_000; t += 250) await vi.advanceTimersByTimeAsync(250);
    stop();
    // An error goes straight to the ceiling rather than retrying in two seconds: the fast cadence
    // exists for a live conversation, and a relay returning errors is not one.
    expect(reads).toBeLessThan(5);
    stop();
  });

  it('★ stopping actually stops it', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const stop = pollingWatch(
      async () => { reads++; return { n: reads }; },
      'read_channel', {}, () => { /* ignored */ },
      { refetchInterval: 45_000 },
    );
    for (let t = 0; t < 10_000; t += 250) await vi.advanceTimersByTimeAsync(250);
    const atStop = reads;
    stop();
    for (let t = 0; t < 60_000; t += 250) await vi.advanceTimersByTimeAsync(250);
    // ★ The loop reschedules itself from inside a promise callback, so "stopped" has to be checked
    // on the way out as well as on the way in. Without that a cancelled watch keeps polling
    // forever, which on a client that opens one per workspace is a leak nobody would see.
    expect(reads).toBe(atStop);
  });

  it('★ a ceiling below the active cadence is respected rather than inverted', async () => {
    // A caller asking for 1 s must not be given 2 s because the floor is written down here.
    const reads = await run(Array.from({ length: 200 }, (_, n) => ({ n })), 10_000, 1_000);
    expect(reads).toBeGreaterThan(5);
  });
});
