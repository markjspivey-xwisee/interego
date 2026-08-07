#!/usr/bin/env tsx
/**
 * CAN ONE AUTHENTICATED STRANGER WATCH ANOTHER POD'S WRITE ACTIVITY? Asked of the live relay,
 * with two disposable identities that have no relationship to each other or to any pod on the
 * fleet.
 *
 * ★ WHY THIS IS A MEASUREMENT AND NOT A TEST. The unit suite can prove that the relay's
 * notification reader filters by pod, and it does (see
 * `deploy/mcp-relay/tests/notification-scope.test.ts`). It cannot prove that the DEPLOYED
 * process does, because the thing being asserted is a property of one long-lived
 * process-global ring shared by every pod the relay has ever served — and a unit test builds
 * its own ring. So this program runs against the real relay, over the real OAuth surface,
 * writing to a real pod.
 *
 * ── THE TWO READERS ─────────────────────────────────────────────────────────
 *
 * `notificationLog` is one process-global array, appended by `emitNotification` for EVERY
 * pod. Two surfaces read it, and both were unscoped:
 *
 *   GET /sse                              — re-sends `slice(-5)` every 2 s to every client
 *   get_pod_status → recentNotifications  — returns `slice(-10)` on any pod status call
 *
 * Both are probed here, because fixing one and not the other leaves the same hole open under
 * a different name. A reader that only checked `/sse` would have reported this closed.
 *
 * ── THE DISCRIMINATING FIELD ────────────────────────────────────────────────
 *
 * B's pod path segment (`u-eth-<12 hex of B's address>`) appearing anywhere in a frame A
 * received. It is unique to B, freshly minted for this run, and it is the *whole* leak: it
 * names the pod, which is what turns "a write happened" into "a write happened to that
 * person's storage". A check that looked for the string "descriptorUrl" instead would pass
 * for two different reasons — the field is present in A's own events too.
 *
 * ── ★ AND THE POSITIVE CONTROL, WITHOUT WHICH THIS PROBE IS WORTHLESS ───────
 *
 * "A saw nothing" has two explanations: the scoping works, or the channel is dead. Those
 * are indistinguishable from the leak check alone, and a probe that cannot tell them apart
 * reports a green light for a `/sse` that was accidentally broken to everyone. So A ALSO
 * publishes to A's own pod inside the same window, and A's stream must name A's OWN pod.
 * Both halves must hold, or the run is inconclusive rather than passing.
 *
 * ── EXIT CODE ───────────────────────────────────────────────────────────────
 *
 *   0 — A received its own activity and none of B's. This is the post-fix expectation.
 *   1 — A received a frame naming B's pod. The finding reproduces.
 *   2 — the probe could not establish its own preconditions: a mint failed, a publish
 *       failed, or the CONTROL failed (A never saw its own write, so the absence of B's
 *       proves nothing). NOT a pass — reporting an inconclusive run as 0 is how a broken
 *       probe becomes a green light.
 *
 *   npx tsx tools/probe-notification-scope-live.ts
 */

import { Wallet } from 'ethers';
import { mintBearer } from '../applications/shared-workspace/tools/live-identity.js';

const RELAY = (process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com').replace(/\/$/, '');
const IDENTITY = (process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com').replace(/\/$/, '');
const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };

let rpcId = 0;

/** One JSON-RPC round trip to `POST /mcp` under a relay OAuth bearer. */
async function call(token: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(RELAY + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* SSE-framed */ }
  if (!body) {
    const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    try { body = JSON.parse(data) as Record<string, unknown>; } catch { throw new Error('unparseable /mcp body: ' + raw.slice(0, 200)); }
  }
  const err = body['error'] as { message?: string } | undefined;
  if (err) throw new Error('JSON-RPC error: ' + (err.message ?? JSON.stringify(err).slice(0, 200)));
  const result = (body['result'] ?? {}) as { content?: readonly { text?: string }[]; structuredContent?: unknown };
  if (result.structuredContent !== undefined) return result.structuredContent;
  const txt = result.content?.[0]?.text ?? '';
  try { return JSON.parse(txt); } catch { return txt; }
}

/** Read `data:` frames off an SSE response for a bounded window. */
async function collect(res: Response, ms: number, label: string): Promise<string[]> {
  const out: string[] = [];
  if (!res.body) return out;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const stop = Date.now() + ms;
  let buf = '';
  while (Date.now() < stop) {
    const t = setTimeout(() => { void reader.cancel().catch(() => undefined); }, Math.max(0, stop - Date.now()));
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { clearTimeout(t); break; }
    clearTimeout(t);
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let nl = buf.indexOf('\n\n');
    while (nl >= 0) {
      const frame = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 2);
      if (frame) { out.push(frame); log('   [' + label + ']', frame.slice(0, 260)); }
      nl = buf.indexOf('\n\n');
    }
  }
  void reader.cancel().catch(() => undefined);
  return out;
}

/** The pod path segment out of a pod URL — `u-eth-1234abcd5678` — the field that names a pod. */
function podSegment(podUrl: string): string {
  return podUrl.replace(/\/$/, '').split('/').pop() ?? '';
}

async function run(): Promise<number> {
  // Two fresh wallets. Neither has ever been seen by this relay, so neither has any
  // relationship to the other's pod that could excuse a delivery. The maintainer pod is
  // deliberately not involved.
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  log('identity A (the stranger) :', a.address);
  log('identity B (the victim)   :', b.address);

  const bearerA = await mintBearer(RELAY, IDENTITY, a);
  const bearerB = await mintBearer(RELAY, IDENTITY, b);

  const stA = await call(bearerA.accessToken, 'get_pod_status', {}) as Record<string, unknown>;
  const stB = await call(bearerB.accessToken, 'get_pod_status', {}) as Record<string, unknown>;
  const podUrlA = String(stA['pod'] ?? stA['podUrl'] ?? '');
  const podUrlB = String(stB['pod'] ?? stB['podUrl'] ?? '');
  const podA = podSegment(podUrlA);
  const podB = podSegment(podUrlB);
  log('pod A                     :', podA, podUrlA);
  log('pod B                     :', podB, podUrlB);
  if (!podA || !podB || podA === podB) {
    log('\nPRECONDITION FAILED: the two identities did not land on two distinct pods.');
    return 2;
  }

  // Distinctive graph names so neither write can be confused with anything else in flight
  // on the fleet.
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const graphB = RELAY + '/ns/' + podB + '/scope-probe-' + nonce;
  const graphA = RELAY + '/ns/' + podA + '/scope-probe-own-' + nonce;

  const publish = async (token: string, graph: string): Promise<void> => {
    await call(token, 'publish_context', {
      graph_iri: graph,
      graph_content: '@prefix dct: <http://purl.org/dc/terms/> .\n<' + graph
        + '> dct:title "notification scope probe ' + new Date().toISOString() + '" .\n',
      visibility: 'private',
      auto_supersede_prior: true,
    });
  };

  log('\n── A opens GET /sse; B publishes to B\'s pod, then A publishes to A\'s own ──');
  const sseRes = await fetch(RELAY + '/sse', {
    headers: { Authorization: 'Bearer ' + bearerA.accessToken, Accept: 'text/event-stream' },
  });
  log('GET /sse (A\'s bearer)     :', sseRes.status, sseRes.headers.get('content-type'));
  if (!sseRes.ok) {
    log('body                      :', (await sseRes.text()).slice(0, 300));
    log('\nPRECONDITION FAILED: A could not open /sse at all, so nothing was measured.');
    return 2;
  }

  const collecting = collect(sseRes, 20000, 'A/sse');
  let publishedB = false;
  let publishedA = false;
  setTimeout(() => {
    void publish(bearerB.accessToken, graphB).then(
      () => { publishedB = true; log('   (B published', graphB + ')'); },
      (e: unknown) => log('   (B\'s publish FAILED:', String(e) + ')'),
    );
  }, 2000);
  // The control write, deliberately AFTER B's: if the ring were still global and merely
  // reordered, A's own event arriving would not explain B's absence.
  setTimeout(() => {
    void publish(bearerA.accessToken, graphA).then(
      () => { publishedA = true; log('   (A published its own', graphA + ')'); },
      (e: unknown) => log('   (A\'s publish FAILED:', String(e) + ')'),
    );
  }, 6000);
  const frames = await collecting;

  if (!publishedB || !publishedA) {
    log('\nPRECONDITION FAILED: publishes did not both land (B=' + publishedB + ' A=' + publishedA
      + '), so neither an empty nor a full result would prove anything.');
    return 2;
  }

  // ── verdict 1: /sse ────────────────────────────────────────────────────────
  const sseNamesB = frames.filter((f) => f.includes(podB));
  const sseNamesGraph = frames.filter((f) => f.includes(nonce));
  const sseNamesA = frames.filter((f) => f.includes(podA));
  log('\nframes A received         :', frames.length);
  log('frames naming A\'s OWN pod :', sseNamesA.length, '(control — must be > 0)');
  log('frames naming B\'s pod     :', sseNamesB.length);
  log('frames naming B\'s graph   :', sseNamesGraph.length);
  // Printed IN FULL, not truncated. This line is the evidence the finding rests on, and a
  // 400-char slice cut it off exactly where the third-party pod names begin — the run that
  // first reproduced this reported "3 frames naming B's pod" above a sample in which B's pod
  // was not visible, which is an unverifiable claim dressed as a quotation.
  for (const f of sseNamesB.slice(0, 2)) log('   LEAKED >>', f);

  // ── verdict 2: get_pod_status.recentNotifications ─────────────────────────
  // The SECOND reader of the same ring. A asks for A's OWN pod status; whatever
  // `recentNotifications` carries is what a caller gets simply by asking how their pod is.
  log('\n── A re-reads its OWN get_pod_status ──');
  const stA2 = await call(bearerA.accessToken, 'get_pod_status', {}) as Record<string, unknown>;
  const recent = JSON.stringify(stA2['recentNotifications'] ?? []);
  const statusNamesB = recent.includes(podB);
  const statusNamesGraph = recent.includes(nonce);
  const statusNamesA = recent.includes(podA);
  log('recentNotifications       :', recent.slice(0, 500));
  log('names A\'s OWN pod         :', statusNamesA ? 'YES (control)' : 'no');
  log('names B\'s pod             :', statusNamesB ? 'YES' : 'no');
  log('names B\'s graph           :', statusNamesGraph ? 'YES' : 'no');

  // ── ★ A THIRD READER, ADDED BECAUSE KEYING ALONE WOULD NOT HAVE CLOSED IT ──
  // `get_pod_status` is not own-pod gated — a caller may legitimately name someone else's
  // pod — so A asks about B's pod directly. A store keyed by pod would answer this
  // CORRECTLY KEYED and still hand over B's activity.
  log('\n── A asks get_pod_status ABOUT B\'S POD ──');
  const stAonB = await call(bearerA.accessToken, 'get_pod_status', { pod_url: podUrlB }) as Record<string, unknown>;
  const hasField = Object.prototype.hasOwnProperty.call(stAonB, 'recentNotifications');
  const crossRecent = JSON.stringify(stAonB['recentNotifications'] ?? []);
  log('field present             :', hasField ? 'YES' : 'no (absent)');
  log('value                     :', crossRecent.slice(0, 300));
  const crossLeaks = crossRecent.includes(podB) || crossRecent.includes(nonce);
  log('names B\'s activity        :', crossLeaks ? 'YES' : 'no');

  // ── the control has to hold before any verdict is meaningful ───────────────
  const controlHeld = sseNamesA.length > 0 || statusNamesA;
  if (!controlHeld) {
    log('\n════════════════════════════════════════════════════════════');
    log('INCONCLUSIVE: A never observed its OWN write either.');
    log('  Neither reader delivered A\'s own activity, so "B\'s is absent" is not evidence');
    log('  of scoping — the channel may simply be delivering nothing to anyone.');
    log('  /sse frames naming A       :', sseNamesA.length);
    log('  get_pod_status names A     :', statusNamesA);
    return 2;
  }

  const leaked = sseNamesB.length > 0 || sseNamesGraph.length > 0
    || statusNamesB || statusNamesGraph || crossLeaks;
  log('\n════════════════════════════════════════════════════════════');
  if (leaked) {
    log('REPRODUCED: an authenticated stranger observed another pod\'s write activity.');
    log('  /sse                              :', sseNamesB.length > 0 || sseNamesGraph.length > 0 ? 'LEAKS' : 'clean');
    log('  get_pod_status (own pod)          :', statusNamesB || statusNamesGraph ? 'LEAKS' : 'clean');
    log('  get_pod_status (naming B\'s pod)   :', crossLeaks ? 'LEAKS' : 'clean');
    return 1;
  }
  log('NOT REPRODUCED, and the control held:');
  log('  A DID observe its own write        : /sse frames=' + sseNamesA.length + ', get_pod_status=' + statusNamesA);
  log('  A observed NONE of B\'s             : across /sse, own get_pod_status, and');
  log('                                       get_pod_status explicitly naming B\'s pod');
  log('  B did publish inside the window (precondition held).');
  return 0;
}

void run().then((c) => process.exit(c), (e: unknown) => { log('THREW:', (e as Error)?.stack ?? String(e)); process.exit(2); });
