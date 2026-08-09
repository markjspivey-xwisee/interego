/**
 * THE OUTAGE, AS A TEST.
 *
 * ── WHAT HAPPENED, MEASURED ──────────────────────────────────────────────────
 *
 * The bot was ready at 10:17. At 12:46 its log said, in full:
 *
 *     gateway: gateway closed (4000); reconnecting in 1000ms
 *
 * and then nothing — no reconnect, no ready line, no error — for 75 minutes, while Railway went on
 * reporting the deployment SUCCESS. Every command the maintainer tried at 13:59 failed.
 *
 * ── THE CAUSE, AND WHY NOTHING IN THE SUITE SAW IT ───────────────────────────
 *
 * The reconnect was scheduled on an `unref()`d timer. `unref` tells libuv the timer must not keep
 * the process alive, and at that instant it was the only thing that could: the heartbeat interval
 * had just been cleared, the socket was gone, and the watcher's timers are unref'd too and register
 * nothing at all until a thread is bound — which none was. So the event loop emptied, Node exited
 * ZERO, and Railway's ON_FAILURE restart policy correctly did nothing about a clean exit.
 *
 * ★ AND IT IS UNTESTABLE IN PROCESS, which is why one test here spawns a child. Inside vitest the
 * runner's own handles keep the process alive, so the bot's timers are never load-bearing and an
 * `unref` on the one that matters is completely invisible. The other tests below cover the parts
 * that ARE observable in process: that a reconnect happens, that it is bounded, that running out
 * exits rather than idling, and that a socket which never speaks is abandoned instead of held.
 */

import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DiscordGateway, HANDSHAKE_TIMEOUT_MS, MAX_RECONNECT_ATTEMPTS,
} from '../src/discord.js';

/** The same socket double the rest of the suite uses: no libuv handle, driven by hand. */
class FakeSocket {
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  private readonly handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  on(ev: string, cb: (...a: unknown[]) => void): this {
    const l = this.handlers.get(ev) ?? []; l.push(cb); this.handlers.set(ev, l); return this;
  }
  send(raw: string): void { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
  close(code = 1000): void { this.readyState = 3; for (const cb of this.handlers.get('close') ?? []) cb(code); }
}

interface Harness {
  readonly gw: DiscordGateway;
  readonly sockets: FakeSocket[];
  readonly notices: string[];
  readonly fatals: string[];
  socket(): FakeSocket;
  frame(f: unknown): void;
}

function harness(openSocket?: () => FakeSocket): Harness {
  const sockets: FakeSocket[] = [];
  const notices: string[] = [];
  const fatals: string[] = [];
  const gw = new DiscordGateway('tok', {
    onMessage: () => undefined,
    onInteraction: () => undefined,
    onAutocomplete: () => undefined,
    onNotice: (l) => notices.push(l),
    onFatal: (w) => fatals.push(w),
  }, () => { const s = openSocket ? openSocket() : new FakeSocket(); sockets.push(s); return s as unknown as never; });
  return {
    gw, sockets, notices, fatals,
    socket: () => sockets[sockets.length - 1] as FakeSocket,
    frame: (f) => { gw.onFrame(JSON.stringify(f)); },
  };
}

const HELLO = { op: 10, d: { heartbeat_interval: 41250 } };
const READY = { op: 0, t: 'READY', s: 1, d: { session_id: 'sess', resume_gateway_url: 'wss://r.example', user: { username: 'bot', id: '9' } } };

describe('★ the process survives the close that killed it', () => {
  it('is alive one second later to run the reconnect it scheduled', async () => {
    // The pre-fix code prints CONNECTS=1 here and exits 0: the reconnect was scheduled onto a timer
    // that had already stopped holding the process up. See survives-close.fixture.ts.
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = join(here, 'survives-close.fixture.ts');
    const tsx = join(here, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const run = await new Promise<{ code: number | null; out: string }>((resolve) => {
      execFile(process.execPath, [tsx, fixture], { timeout: 60_000 }, (err, stdout, stderr) => {
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, out: String(stdout) + String(stderr) });
      });
    });
    expect(run.out, 'the child did not reach the close at all').toContain('gateway closed (4000)');
    // ★ THE ASSERTION THE OUTAGE FAILED. 1 means the process died holding a scheduled reconnect.
    expect(run.out).toContain('CONNECTS=2');
    // And it did not merely reach `connect()` — it completed the handshake on the new socket.
    expect(run.out).toContain('gateway resumed');
  }, 90_000);
});

describe('a reconnect is visible, bounded, and gives up loudly', () => {
  it('actually reconnects when the timer fires, and says which attempt it is', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.gw.connect();
      h.frame(HELLO);
      h.frame(READY);
      h.socket().close(4000);
      expect(h.notices.some((n) => n.includes('gateway closed (4000)'))).toBe(true);
      // ★ THE ATTEMPT IS NUMBERED. "reconnecting in 1000ms" on its own is what the outage printed,
      // and it is indistinguishable from the same line printed by a process about to die. A counter
      // that climbs is a reconnect loop anyone can see in the log; a single line is not.
      expect(h.notices.some((n) => n.includes('attempt 1 of ' + MAX_RECONNECT_ATTEMPTS))).toBe(true);
      expect(h.sockets).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(h.sockets, 'the scheduled reconnect never opened a socket').toHaveLength(2);
      h.gw.stop();
    } finally { vi.useRealTimers(); }
  });

  it('resumes on the new socket, because the session survived the close', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.gw.connect();
      h.frame(HELLO);
      h.frame(READY);
      h.socket().close(4000);
      vi.advanceTimersByTime(1000);
      h.frame(HELLO);
      expect(h.socket().sent.find((f) => f['op'] === 6), 'it re-identified instead of resuming').toBeTruthy();
      h.gw.stop();
    } finally { vi.useRealTimers(); }
  });

  it('★ gives up after a bounded number of attempts rather than retrying in silence forever', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.gw.connect();
      // Every socket closes the moment it is opened: the gateway is refusing, and no HELLO ever
      // arrives, so nothing ever resets the counter.
      for (let i = 0; i < MAX_RECONNECT_ATTEMPTS + 2; i++) {
        h.socket().close(4000);
        vi.advanceTimersByTime(120_000);              // past the 60s backoff ceiling
      }
      // ★ A WORKER THAT CANNOT DO ITS JOB MUST SAY SO. Retrying forever and being dead look
      // identical from outside the container, and the platform believes both are healthy.
      expect(h.fatals, 'it never gave up, so nothing would ever restart it').toHaveLength(1);
      expect(h.fatals[0]).toContain('could not be re-established');
      expect(h.fatals[0]).toContain(String(MAX_RECONNECT_ATTEMPTS));
      h.gw.stop();
    } finally { vi.useRealTimers(); }
  });

  it('a reconnect that works resets the budget, so a bot up for weeks never runs out', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.gw.connect();
      h.frame(HELLO);
      // One short of the budget, then a success. Without the reset, a long-lived bot would
      // accumulate unrelated blips over days and eventually exit on a gateway that is perfectly
      // fine. `advanceTimersToNextTimer` fires the pending reconnect and nothing else, and the
      // HELLO that follows disarms the new socket's handshake watchdog — which would otherwise
      // count as a further failed attempt and is a different test's subject.
      const blip = (): void => {
        h.socket().close(4000);
        vi.advanceTimersToNextTimer();
        h.frame(HELLO);
      };
      for (let i = 0; i < MAX_RECONNECT_ATTEMPTS - 1; i++) blip();
      expect(h.fatals).toHaveLength(0);
      h.frame(READY);
      for (let i = 0; i < MAX_RECONNECT_ATTEMPTS - 1; i++) blip();
      expect(h.fatals, 'the budget did not reset on a successful READY').toHaveLength(0);
      h.gw.stop();
    } finally { vi.useRealTimers(); }
  });

  it('stop() cancels a pending reconnect, so shutting down does not open another socket', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.gw.connect();
      h.socket().close(4000);
      h.gw.stop();
      vi.advanceTimersByTime(120_000);
      // The reconnect timer is deliberately ref'd now, so a cancel that did not work would also
      // keep a shut-down process alive forever.
      expect(h.sockets).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('a socket that never speaks', () => {
  it('★ is abandoned instead of held open forever, because `ws` has no default handshake timeout', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.gw.connect();
      // No HELLO. A real `ws` socket stalled in the TLS upgrade emits neither 'error' nor 'close',
      // and nothing in the library ever times it out — the bot would hang here with no log line.
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + 1);
      expect(h.notices.some((n) => n.includes('no HELLO'))).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(h.sockets, 'the stalled socket was not replaced').toHaveLength(2);
      h.gw.stop();
    } finally { vi.useRealTimers(); }
  });

  it('is disarmed by HELLO, so a healthy connection is never torn down mid-life', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.gw.connect();
      h.frame(HELLO);
      h.frame(READY);
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 3);
      expect(h.notices.some((n) => n.includes('no HELLO'))).toBe(false);
      expect(h.sockets).toHaveLength(1);
      h.gw.stop();
    } finally { vi.useRealTimers(); }
  });

  it('★ cannot drive a second reconnect once it has been abandoned', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.gw.connect();
      const stalled = h.socket();
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + 1);
      vi.advanceTimersToNextTimer();                  // the reconnect, and only it
      expect(h.sockets).toHaveLength(2);
      h.frame(HELLO);                                 // the replacement is healthy
      // The abandoned socket finally notices it is dead and fires its close, late. Acting on it
      // would schedule a reconnect on top of the live one — two sockets racing, each closing the
      // other, which reads in the log as a storm and never settles.
      stalled.close(1006);
      // Under one heartbeat interval, so this window contains nothing but the reconnect a late
      // close would have scheduled.
      vi.advanceTimersByTime(10_000);
      expect(h.sockets, 'a late close from an abandoned socket started a second reconnect').toHaveLength(2);
      h.gw.stop();
    } finally { vi.useRealTimers(); }
  });

  it('a socket constructor that throws is retried and named, not thrown into a timer callback', () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const h = harness(() => {
        if (fail) { fail = false; throw new Error('getaddrinfo ENOTFOUND r.example'); }
        return new FakeSocket();
      });
      // ★ This used to escape as an uncaught exception, because `connect` runs inside a timer
      // callback and nothing above it catches. A bad `resume_gateway_url` is the realistic source.
      expect(() => { h.gw.connect(); }).not.toThrow();
      expect(h.notices.some((n) => n.includes('ENOTFOUND'))).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(h.sockets).toHaveLength(1);            // the retry got a socket
      h.gw.stop();
    } finally { vi.useRealTimers(); }
  });
});
