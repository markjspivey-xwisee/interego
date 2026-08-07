/**
 * MEASURE WHAT A LIVE WATCH COULD ACTUALLY BE, before writing one.
 *
 * `RelayMcpTransport.watchTool()` returns null today and the desktop polls. Deciding whether to
 * implement it properly is a question about the relay, not about the client, so it is answered
 * by asking the relay — with two real bearers, on two real pods, against both endpoints that
 * could carry a push:
 *
 *   GET /sse                       — the legacy MCP-over-SSE transport
 *   GET /notifications/:podSlug    — the per-pod SolidNotifications channel
 *
 * What has to be true for a workspace watch to be worth registering: it must deliver an event
 * when a SPECIFIC graph on a SPECIFIC pod changes, and it must do so for pods the viewer does
 * NOT own — because a workspace's whole value is the other members' logs. This prints whether
 * each holds.
 *
 *   npx tsx applications/shared-workspace/tools/probe-watch-live.ts
 */

import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import { readFileSync } from 'node:fs';
import { RelayMcpTransport, WorkspaceClient, nsIri, type RelayOAuthBearer } from '@interego/workspace-client';
import { mintBearer } from './live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };

/** The relay's own slug function: first 16 hex of sha256(podUrl). Deterministic, so computable. */
const podSlug = (podUrl: string): string => createHash('sha256').update(podUrl).digest('hex').slice(0, 16);

/** Read `data:` frames off an SSE response for a bounded window and hand back what arrived. */
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
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      if (frame.trim()) { out.push(frame.trim()); log('   [' + label + ']', frame.trim().slice(0, 220)); }
      nl = buf.indexOf('\n\n');
    }
  }
  void reader.cancel().catch(() => undefined);
  return out;
}

async function run(): Promise<number> {
  const seedA = (JSON.parse(readFileSync(process.env['INTEREGO_WALLET_A'] ?? '.interego/maintainer.json', 'utf8')) as { privateKey: string }).privateKey;
  const a = new Wallet(seedA);
  log('identity A wallet      :', a.address);
  const bearerA: RelayOAuthBearer = await mintBearer(RELAY, IDENTITY, a);
  const clientA = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearerA));
  await clientA.connect();
  const stA = await clientA.podStatus();
  const podUrlA = String(stA['pod'] ?? stA['podUrl'] ?? '');
  const podA = podUrlA.replace(/\/$/, '').split('/').pop() ?? '';
  log('identity A pod         :', podA, podUrlA);

  const b = Wallet.createRandom();
  log('identity B wallet      :', b.address, '(fresh — provisions a new pod)');
  const bearerB = await mintBearer(RELAY, IDENTITY, b);
  const clientB = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearerB));
  await clientB.connect();
  const stB = await clientB.podStatus();
  const podUrlB = String(stB['pod'] ?? stB['podUrl'] ?? '');
  const podB = podUrlB.replace(/\/$/, '').split('/').pop() ?? '';
  log('identity B pod         :', podB, podUrlB);

  // ── question 1: does /notifications/:podSlug open for YOUR OWN pod? ────────
  const slugA = podSlug(podUrlA);
  log('\n── GET /notifications/<own pod slug> with A\'s bearer ──');
  log('slug(A)                :', slugA);
  const ownRes = await fetch(RELAY + '/notifications/' + slugA, {
    headers: { Authorization: 'Bearer ' + bearerA.accessToken, Accept: 'text/event-stream' },
  });
  log('status                 :', ownRes.status, ownRes.headers.get('content-type'));
  if (ownRes.ok) {
    // Write to A's own pod while the channel is open and see whether the event arrives.
    const graph = nsIri(RELAY, podA, 'watch-probe');
    const collecting = collect(ownRes, 12000, 'own');
    setTimeout(() => {
      void clientA.tool('publish_context', {
        graph_iri: graph,
        graph_content: '@prefix dct: <http://purl.org/dc/terms/> .\n<' + graph + '> dct:title "watch probe ' + new Date().toISOString() + '" .\n',
        visibility: 'public', auto_supersede_prior: true,
      }).then(() => log('   (wrote', graph + ')'), (e: unknown) => log('   (write failed:', String(e) + ')'));
    }, 1500);
    const frames = await collecting;
    log('frames                 :', frames.length);
    log('carries a graphUrl     :', frames.some((f) => f.indexOf('graphUrl') >= 0) ? 'YES' : 'no');
    log('carries the graph I wrote:', frames.some((f) => f.indexOf(graph) >= 0) ? 'YES' : 'no');
  } else {
    log('body                   :', (await ownRes.text()).slice(0, 300));
  }

  // ── question 2: can A open a channel on B's pod? (the case that matters) ──
  const slugB = podSlug(podUrlB);
  log('\n── GET /notifications/<B\'s pod slug> with A\'s bearer ──');
  const crossRes = await fetch(RELAY + '/notifications/' + slugB, {
    headers: { Authorization: 'Bearer ' + bearerA.accessToken, Accept: 'text/event-stream' },
  });
  log('status                 :', crossRes.status);
  log('body                   :', (await crossRes.text()).slice(0, 300));

  // ── question 3: what does the legacy /sse actually carry? ─────────────────
  log('\n── GET /sse with A\'s bearer ──');
  const sseRes = await fetch(RELAY + '/sse', {
    headers: { Authorization: 'Bearer ' + bearerA.accessToken, Accept: 'text/event-stream' },
  });
  log('status                 :', sseRes.status, sseRes.headers.get('content-type'));
  if (sseRes.ok) {
    const frames = await collect(sseRes, 8000, 'sse');
    log('frames                 :', frames.length);
    log('per-pod scoped         :', frames.some((f) => f.indexOf('podUrl') >= 0) ? 'events carry a podUrl' : 'no podUrl seen');
  } else {
    log('body                   :', (await sseRes.text()).slice(0, 300));
  }
  return 0;
}

void run().then((c) => process.exit(c), (e: unknown) => { log('THREW:', (e as Error)?.stack ?? String(e)); process.exit(1); });
