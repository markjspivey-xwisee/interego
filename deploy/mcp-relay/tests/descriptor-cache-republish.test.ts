#!/usr/bin/env tsx
/**
 * A same-id republish is visible to the next `get_descriptor` — not five minutes later.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 *
 * `descriptorBodyCache` keeps published `context-graphs/<slug>.ttl` and `<slug>-graph.trig`
 * bodies for five minutes on the theory that a published version never changes. It does: a
 * publish with a stable, caller-chosen `descriptor_id` rewrites the SAME two files (a same-graph
 * self-overwrite needs no `if_match`), and nothing dropped the cached bodies, so the relay kept
 * answering with the bytes it had just overwritten.
 *
 * ── WHAT THIS DRIVES ─────────────────────────────────────────────────────────
 *
 * The real `server.ts`, booted as a child process against a fake identity server and an
 * in-memory pod, spoken to over `/tool/:name` — the real publish handler, the real egress
 * wrapper that now reports writes, the real cache. `descriptor-cache-freshness.test.ts` covers
 * the alias and in-flight cases against the sliced-out functions; this file is the one that can
 * see whether the WRITERS are actually wired to it.
 *
 * Non-vacuity is asserted, not assumed: before the republish, a second `get_descriptor` must be
 * served from the cache (the pod sees no second GET), so the fresh answer afterwards can only
 * come from the cache having been invalidated.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/descriptor-cache-republish.test.ts
 */
import express from 'express';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenLoopback } from './listen-loopback.js';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); return; }
  fail++; console.log(`  FAIL  ${name}${detail ? `  :: ${detail}` : ''}`);
}

const USER_ID = 'u-pk-republish';
const DESCRIPTOR_ID = 'urn:iep:test:stable-republish-descriptor';
const GRAPH_IRI = 'https://example.test/d/stable-republish';
const graph = (marker: string): string =>
  `<https://example.test/d/thing> <https://example.test/ns#marker> "${marker}" .\n`;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => { probe.listen(0, '127.0.0.1', () => r()); });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(r => { probe.close(() => r()); });
  return port;
}

async function main(): Promise<void> {
  const identityApp = express();
  identityApp.use(express.json());
  identityApp.post('/tokens/verify', (_q, s) => {
    s.json({ valid: true, userId: USER_ID, agentId: `mcp-client-${USER_ID}`, scope: 'ReadWrite' });
  });
  identityApp.use((_q, s) => { s.status(404).json({ error: 'not part of this fixture' }); });

  // A pod that stores what it is given and serves it back, counting reads per path so a cache
  // hit is observable as the ABSENCE of a GET.
  const stored = new Map<string, string>();
  const gets = new Map<string, number>();
  const podApp = express();
  podApp.use(express.text({ type: () => true, limit: '20mb' }));
  podApp.use((q, s) => {
    const key = decodeURIComponent(q.path);
    if (q.method === 'PUT' || q.method === 'POST' || q.method === 'PATCH') {
      if (!key.endsWith('/')) stored.set(key, typeof q.body === 'string' ? q.body : '');
      s.status(201).end();
      return;
    }
    if (q.method === 'DELETE') { stored.delete(key); s.status(205).end(); return; }
    const hit = stored.get(key);
    if (q.method === 'GET') gets.set(key, (gets.get(key) ?? 0) + 1);
    if (hit === undefined) { s.status(404).end(); return; }
    const type = key.endsWith('.trig') ? 'application/trig' : 'text/turtle';
    if (q.method === 'HEAD') { s.type(type).status(200).end(); return; }
    s.type(type).status(200).send(hit);
  });

  const identity = await listenLoopback(identityApp);
  const pod = await listenLoopback(podApp);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // Never the production default key path: a suite must not write a private key it does not own.
  const keyFile = join(tmpdir(), `descriptor-cache-republish-key-${process.pid}.json`);

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      CSS_URL: `${pod.base}/`,
      IDENTITY_URL: identity.base,
      RELAY_AGENT_KEY_FILE: keyFile,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let childErr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => { childErr = (childErr + c).slice(-1_500); });
  const killChild = (): void => { child.kill(); };
  process.once('exit', killChild);

  const tool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}/tool/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer any-token-the-fixture-accepts' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return { unparseable: text.slice(0, 300), status: res.status }; }
  };
  const publish = (marker: string, sync = true) => tool('publish_context', {
    descriptor_id: DESCRIPTOR_ID, graph_iri: GRAPH_IRI, graph_content: graph(marker),
    visibility: 'public', ...(sync ? { sync: true } : {}),
  });
  const read = (url: string) => tool('get_descriptor', { url });
  const getsOf = (url: string): number => gets.get(decodeURIComponent(new URL(url).pathname)) ?? 0;
  const storedAt = (url: string): string | undefined => stored.get(decodeURIComponent(new URL(url).pathname));

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await new Promise(r => { setTimeout(r, 250).unref(); });
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
        up = r.ok || r.status === 404;
      } catch { /* still booting */ }
    }
    ok(up, 'the relay boots against the fixtures and answers /health', `child stderr tail: ${childErr || '(none)'}`);
    if (!up) return;

    const first = await publish('first');
    const descriptorUrl = first['descriptorUrl'], graphUrl = first['graphUrl'];
    ok(first['published'] === true && typeof descriptorUrl === 'string' && typeof graphUrl === 'string',
      'the first publish under a stable descriptor_id commits', JSON.stringify(first).slice(0, 400));
    if (typeof descriptorUrl !== 'string' || typeof graphUrl !== 'string') return;
    ok(/\/context-graphs\/[^/]+\.ttl$/.test(new URL(descriptorUrl).pathname)
      && /\/context-graphs\/[^/]+-graph\.trig$/.test(new URL(graphUrl).pathname),
      'both halves live at the cacheable publication URLs', `${descriptorUrl} ${graphUrl}`);

    // Warm the cache, then prove it is warm: the second reads reach the pod zero more times.
    // (Each `get_descriptor` of the DESCRIPTOR also follows its distribution link to the graph,
    // and that follow is not a cache read — so the graph's count is taken around graph reads only.)
    const d1 = await read(descriptorUrl);
    const descGets = getsOf(descriptorUrl);
    const d1Again = await read(descriptorUrl);
    const g1 = await read(graphUrl);
    const graphGets = getsOf(graphUrl);
    const g1Again = await read(graphUrl);
    ok(typeof d1['turtle'] === 'string' && d1['turtle'] === storedAt(descriptorUrl),
      'get_descriptor returns the first descriptor body', JSON.stringify(d1).slice(0, 300));
    ok(typeof g1['content'] === 'string' && (g1['content'] as string).includes('"first"'),
      'get_descriptor returns the first graph body', JSON.stringify(g1).slice(0, 300));
    ok(getsOf(descriptorUrl) === descGets && getsOf(graphUrl) === graphGets && descGets > 0 && graphGets > 0
      && d1Again['turtle'] === d1['turtle'] && g1Again['content'] === g1['content'],
      'non-vacuity: repeat reads are served from the relay cache, not the pod',
      `descriptor GETs ${descGets}→${getsOf(descriptorUrl)}, graph GETs ${graphGets}→${getsOf(graphUrl)}`);

    const second = await publish('second');
    ok(second['published'] === true && second['descriptorUrl'] === descriptorUrl && second['graphUrl'] === graphUrl,
      'the republish under the same descriptor_id commits to the SAME two URLs',
      JSON.stringify(second).slice(0, 400));
    ok((storedAt(graphUrl) ?? '').includes('"second"') && storedAt(descriptorUrl) !== d1['turtle'],
      'non-vacuity: the pod really holds new bytes at both URLs');

    const g2 = await read(graphUrl), d2 = await read(descriptorUrl);
    ok(typeof g2['content'] === 'string' && (g2['content'] as string).includes('"second"')
      && !(g2['content'] as string).includes('"first"'),
      '★★ the next get_descriptor of the graph returns the REPUBLISHED bytes, not the cached ones',
      JSON.stringify(g2).slice(0, 300));
    ok(d2['turtle'] === storedAt(descriptorUrl) && d2['turtle'] !== d1['turtle'],
      '★★ …and so does the next get_descriptor of the descriptor itself',
      JSON.stringify(d2).slice(0, 300));

    // ── The DEFERRED publish path writes through the same wrapper ─────────────
    // Default publishes answer 202 and write in the background; that writer must retire the
    // cached bodies too. Cache is warm with "second" from the reads above.
    const g2Gets = getsOf(graphUrl);
    ok((await read(graphUrl))['content'] === g2['content'] && getsOf(graphUrl) === g2Gets,
      'non-vacuity: the graph is cached again before the deferred republish');
    const third = await publish('third', false);
    let committed = false;
    for (let i = 0; i < 120 && !committed; i++) {
      const r = await fetch(`${base}/publish/status?descriptorUrl=${encodeURIComponent(descriptorUrl)}`,
        { signal: AbortSignal.timeout(5_000) });
      committed = ((await r.json()) as { kind?: string }).kind === 'committed'
        && (storedAt(graphUrl) ?? '').includes('"third"');
      if (!committed) await new Promise(r2 => { setTimeout(r2, 250).unref(); });
    }
    ok(committed, 'the deferred republish commits', JSON.stringify(third).slice(0, 300));
    const g3 = await read(graphUrl), d3 = await read(descriptorUrl);
    ok(typeof g3['content'] === 'string' && (g3['content'] as string).includes('"third"'),
      '★★ after a DEFERRED same-id republish the next read returns the new graph bytes',
      JSON.stringify(g3).slice(0, 300));
    ok(d3['turtle'] === storedAt(descriptorUrl) && d3['turtle'] !== d2['turtle'],
      '★★ …and the new descriptor bytes', JSON.stringify(d3).slice(0, 300));
  } finally {
    child.kill();
    process.removeListener('exit', killChild);
    await identity.close();
    await pod.close();
    for (const f of [keyFile, keyFile.replace(/\.json$/, '-ecdsa.json')]) {
      try { rmSync(f, { force: true }); } catch { /* the child may never have written it */ }
    }
  }
}

main()
  .catch((err: unknown) => { ok(false, 'the suite ran to completion', err instanceof Error ? err.message : String(err)); })
  .then(() => {
    console.log(`\ndescriptor-cache-republish: ${pass} passed, ${fail} failed`);
    if (fail > 0 || pass === 0) process.exit(1);
  })
  .catch(() => process.exit(1));
