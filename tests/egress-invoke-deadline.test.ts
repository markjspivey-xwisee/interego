/**
 * A READ'S DEADLINE IS NOT AN INVOCATION'S DEADLINE.
 *
 * ── ★★ WHAT THIS COST, MEASURED ─────────────────────────────────────────────
 *
 * `solidFetch` applied one 15-second ceiling to everything it fetched. That is right for what it
 * was written for — a CSS host that accepts the socket and then stalls — and wrong for
 * `invoke_affordance`, which calls into another service to do real work.
 *
 * Live: a Foxxi performance review answers in about 40 seconds with a full IEEE-LER (HTTP 200,
 * measured directly against the bridge). Through the relay it died at 15,179 ms with
 * "This operation was aborted" — no status, no body, no mention that the deadline was OURS. A
 * delegate tried four times, correctly deduced "something between me and it gives up sooner", and
 * could get no further because the error gave it nothing to reason with. It then reported to its
 * human that the capability was unreachable.
 *
 * ── WHAT THIS FILE TESTS, AND WHAT IT DOES NOT ──────────────────────────────
 *
 * The unit that changed is the DEADLINE SELECTION inside `solidFetch`, and that is what is driven
 * here, against a real socket. The `guardedInvokeFetch` wrapper is deliberately NOT the entry
 * point: it requires https and refuses loopback by name — both correct, both already covered by
 * `egress-dns-screen.test.ts` — and routing around them with a self-signed TLS server would end up
 * measuring the SSRF screen rather than the ceiling. That it passes `interegoInvoke` is held by
 * the compiler and was confirmed live.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEgress } from '../deploy/mcp-relay/egress.js';

/** A server that answers only after `delayMs` — a slow endpoint, not a broken one. */
const slowServer = async (delayMs: number): Promise<{ url: string; close: () => Promise<void> }> => {
  const server: Server = createServer((_req, res) => {
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, delayMs);
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => { r(); }); });
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/review`,
    close: () => new Promise<void>((r) => { server.close(() => { r(); }); }),
  };
};

const saved = { fetchMs: process.env['NS_FETCH_TIMEOUT_MS'], invokeMs: process.env['NS_INVOKE_TIMEOUT_MS'] };
afterEach(() => {
  if (saved.fetchMs === undefined) delete process.env['NS_FETCH_TIMEOUT_MS'];
  else process.env['NS_FETCH_TIMEOUT_MS'] = saved.fetchMs;
  if (saved.invokeMs === undefined) delete process.env['NS_INVOKE_TIMEOUT_MS'];
  else process.env['NS_INVOKE_TIMEOUT_MS'] = saved.invokeMs;
});

const egressFor = (): ReturnType<typeof createEgress> =>
  createEgress({ cssUrl: 'http://127.0.0.1:1/', publicBaseUrl: '', screenAddresses: false });

describe('★★ an invocation outlives the read deadline', () => {
  it('the SAME slow target is aborted as a read and completes as an invocation', async () => {
    // The read ceiling is deliberately below what the endpoint needs and the invoke ceiling above
    // it: one target, one egress, one difference — the flag.
    process.env['NS_FETCH_TIMEOUT_MS'] = '400';
    process.env['NS_INVOKE_TIMEOUT_MS'] = '10000';
    const slow = await slowServer(1200);
    const egress = egressFor();
    try {
      // ── POSITIVE CONTROL: the read ceiling really does bite this target ────
      // Without it, the invoke assertion below could pass because the server was fast.
      await expect(egress.solidFetch(slow.url, {})).rejects.toThrow(/stopped waiting/);

      const r = await egress.solidFetch(slow.url, { interegoInvoke: true } as never);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('ok');
    } finally {
      await egress.close();
      await slow.close();
    }
  }, 30_000);

  it('★★ an abort says WHOSE deadline it was, how long, and which knob moves it', async () => {
    /**
     * "This operation was aborted" is what a delegate got four times. It cannot be told apart from
     * a refusal by the far end, and it sent an agent to the wrong conclusion — that the capability
     * did not exist. The far end being slow and this client giving up are different facts, and
     * only one of them is about the far end.
     */
    process.env['NS_INVOKE_TIMEOUT_MS'] = '300';
    const slow = await slowServer(3000);
    const egress = egressFor();
    try {
      const err = await egress.solidFetch(slow.url, { interegoInvoke: true } as never)
        .then(() => null, (e: Error) => e);
      expect(err, 'a 300 ms ceiling against a 3 s endpoint must abort').not.toBeNull();
      const m = String(err?.message);
      expect(m).toContain('this relay stopped waiting');
      expect(m).toContain('300 ms');
      // ★ NAMES THE KNOB, so the next reader does not have to find this file to move it.
      expect(m).toContain('NS_INVOKE_TIMEOUT_MS');
      // ★ AND DOES NOT BLAME THE FAR END for a deadline we chose.
      expect(m).toContain('not a refusal by the far end');
      expect(m).not.toBe('This operation was aborted');
    } finally {
      await egress.close();
      await slow.close();
    }
  }, 30_000);

  it('★ a read abort names the read knob, not the invoke one', async () => {
    process.env['NS_FETCH_TIMEOUT_MS'] = '250';
    const slow = await slowServer(3000);
    const egress = egressFor();
    try {
      const err = await egress.solidFetch(slow.url, {}).then(() => null, (e: Error) => e);
      const m = String(err?.message);
      expect(m).toContain('NS_FETCH_TIMEOUT_MS');
      expect(m).not.toContain('NS_INVOKE_TIMEOUT_MS');
    } finally {
      await egress.close();
      await slow.close();
    }
  }, 30_000);
});
