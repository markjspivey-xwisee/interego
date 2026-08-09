/**
 * A REAL PROCESS, DRIVEN THROUGH A REAL GATEWAY CLOSE. Run as a child by
 * `tests/gateway-liveness.test.ts`; not a `*.test.ts`, so vitest does not collect it.
 *
 * ★ WHY A SUBPROCESS AND NOT AN ASSERTION. The property under test is not "was a reconnect
 * scheduled" — the old code scheduled one perfectly and printed that it had. It is "is this process
 * still alive one second later to RUN it", and that is a fact about libuv's handle count that no
 * in-process assertion can observe: a test runner's own event loop is full of ref'd handles, so the
 * bot's timers are never what keeps the process up and the bug is invisible from inside. Measured
 * against the pre-fix code, this fixture prints `CONNECTS=1` and exits 0 — a silent death.
 *
 * The socket holds no handle on purpose. That is not a simplification of production, it IS
 * production: the deployed bot has no bound threads, so `pollingWatch` has registered no interval,
 * the watcher's own sweep is unref'd, and the gateway heartbeat — cleared on close, immediately
 * before the reconnect is scheduled — was the only ref'd handle in the whole container.
 */

import { DiscordGateway } from '../src/discord.js';

class FakeSocket {
  readyState = 1;
  private readonly handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  on(ev: string, cb: (...a: unknown[]) => void): this {
    const l = this.handlers.get(ev) ?? []; l.push(cb); this.handlers.set(ev, l); return this;
  }
  send(): void { /* discarded */ }
  close(code = 1000): void { this.readyState = 3; for (const cb of this.handlers.get('close') ?? []) cb(code); }
}

let connects = 0;
const gw: DiscordGateway = new DiscordGateway('tok', {
  onMessage: () => undefined,
  onInteraction: () => undefined,
  onAutocomplete: () => undefined,
  onNotice: (l) => { process.stdout.write('notice: ' + l + '\n'); },
  onFatal: (w) => { process.stdout.write('fatal: ' + w + '\n'); },
}, () => {
  connects++;
  const s = new FakeSocket();
  // The SECOND socket is the one that only exists if the process survived. Completing its handshake
  // proves the recovery end to end rather than just that `connect()` was reached, and `stop()`
  // lets the fixture exit instead of holding the loop open forever, which is now correct behaviour.
  if (connects === 2) {
    setTimeout(() => {
      gw.onFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
      gw.onFrame(JSON.stringify({ op: 0, t: 'RESUMED', s: 2, d: {} }));
      gw.stop();
    }, 0);
  }
  return s as unknown as never;
});

// Printed from an `exit` hook so it is emitted however the process leaves — including the silent
// natural exit this fixture exists to catch.
process.on('exit', () => { process.stdout.write('CONNECTS=' + connects + '\n'); });

gw.connect();
gw.onFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
gw.onFrame(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's', resume_gateway_url: 'wss://r.example', user: { username: 'bot', id: '1' } } }));

// Exactly what happened at 12:46 in the outage: the gateway went away and the class turned it into
// a close(4000) plus a scheduled reconnect. Everything after this depends on the process living.
gw.onFrame(JSON.stringify({ op: 7 }));
