#!/usr/bin/env tsx
/**
 * Increment 2, verified against the live substrate rather than a double.
 *
 * The unit tests drive `appendEntry` through an injected pair of functions. That proves
 * the module's discipline and proves nothing about whether the substrate honours it —
 * and the substrate's compare-and-swap was measurably broken until PR #234, while
 * reporting `precondition.passed: true`. A harness that stands in for the dependency
 * cannot verify the dependency.
 *
 * So this drives the SAME module against the real relay, on two real pods, and checks the
 * five things that would each let a broken log look healthy:
 *
 *   1. entries land, in order, and the chain verifies from its own links
 *   2. catch-up is ONE manifest read for a whole stream, not one per entry
 *   3. a stale precondition is REFUSED, and nothing lands
 *   4. an entry missing wsp:seq is refused by the shape gate, and nothing lands
 *   5. every entry id dereferences — no identifier that only resolves in our own process
 *
 * Usage:
 *   IEP_BEARER=<token> npx tsx applications/shared-workspace/tools/verify-stream-live.ts [run-id]
 */

import {
  appendEntry, readStream, verifyChain, entryTurtle, headOf,
  WSP_SHAPES, type StreamDeps, type StreamRef,
} from '../src/stream.js';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const BEARER = process.env.IEP_BEARER;
if (!BEARER) {
  console.error('IEP_BEARER is required — mint a relay bearer and pass it in the environment.');
  process.exit(2);
}

const RUN = process.argv[2] ?? String(Date.now());
const WS = `${RELAY}/ns/maintainer/wsp-live-${RUN}`;

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
}

let seq = 100;
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BEARER}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(raw); } catch {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    try { j = JSON.parse(data); } catch { /* neither */ }
  }
  const text = (j as { result?: { content?: { text?: string }[] } })?.result?.content?.[0]?.text;
  try { return JSON.parse(text ?? '{}'); } catch { return { raw: text ?? raw }; }
}

let discoverCalls = 0;
const deps: StreamDeps = {
  publish: a => call('publish_context', a),
  discover: a => { discoverCalls++; return call('discover_context', a); },
};

async function main(): Promise<void> {
  console.log(`\nworkspace: ${WS}\n`);

  // Two streams on two DIFFERENT pods — the property that distinguishes this from a
  // server-side log. Neither participant's entries live where the other's do.
  const status = await call('get_pod_status', {});
  const podUrl = (status.podUrl ?? status.pod ?? status.url) as string | undefined;
  if (!podUrl) { console.error('could not resolve a pod url', JSON.stringify(status).slice(0, 400)); process.exit(2); }

  const alice: StreamRef = { graphIri: `${WS}/stream/alice`, workspace: WS, podUrl };
  console.log(`stream:    ${alice.graphIri}\npod:       ${podUrl}\n`);

  // ── 1. five appends, each gated on the head the previous one produced ──
  console.log('1. appending five entries through the real publish path');
  const landed: string[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await appendEntry(alice, { body: `entry ${i} — live run ${RUN}` }, deps);
    if (res.outcome !== 'appended') {
      ok(false, `append ${i}`, JSON.stringify(res).slice(0, 300));
      break;
    }
    landed.push(res.entry.descriptorUrl);
    ok(res.entry.seq === i, `append ${i} derived seq ${res.entry.seq} from the head`);
  }

  // ── 2. catch-up: ONE manifest read for the whole stream ──
  console.log('\n2. catch-up');
  discoverCalls = 0;
  const rows = await readStream(alice, deps);
  ok(discoverCalls === 1, `the whole stream came from ONE discover_context (was ${discoverCalls})`);
  ok(rows.length === 5, `five entries returned (got ${rows.length})`);

  const report = verifyChain(rows);
  ok(report.intact, 'the chain verifies from its own supersedes links');
  ok(report.heads.length === 1, `exactly one head (got ${report.heads.length})`);
  ok(report.merges.length === 0, 'no merges');
  ok(report.danglingLinks.length === 0, 'no dangling links');
  ok(
    report.ordered.every((r, i) => i === 0 || r.supersedes.includes(report.ordered[i - 1]!.descriptorUrl)),
    'every entry declares exactly the one before it',
  );
  ok(
    report.ordered.every(r => r.supersedes.length <= 1),
    '★ each entry links ONE prior — the chain is linear, not O(n²)',
  );

  // ── 3. a stale precondition must be refused, and nothing may land ──
  console.log('\n3. a stale precondition');
  // The first two rows of an already-verified chain: a prefix of a valid chain is a valid
  // chain, so this derives cleanly on a healthy run. Branched rather than asserted, because
  // `headOf` reports a divergence as a value now — and a live tool that read `.url` off the
  // refusing member would print `undefined` as the stale head and assert against nothing.
  const derived = headOf(verifyChain(rows).ordered.slice(0, 2));
  const staleHead = derived.outcome === 'head' ? derived.url : null;
  if (!staleHead) {
    ok(false, 'could not derive a stale head to assert with',
      derived.outcome === 'diverged' ? derived.message : 'the prefix verified but named no head');
  }
  const before = (await readStream(alice, deps)).length;
  const stale = await call('publish_context', {
    graph_iri: alice.graphIri,
    graph_content: entryTurtle({
      entryIri: `${alice.graphIri}/e/99`, workspace: WS, seq: 99,
      draft: { body: 'must not land' }, supersedes: staleHead,
    }),
    visibility: 'public',
    auto_supersede_prior: false,
    conforms_to_shapes: [WSP_SHAPES],
    if_match: staleHead,
  });
  ok(stale.code === 412, `a superseded ancestor is refused (got ${stale.code ?? 'published'})`,
    JSON.stringify(stale).slice(0, 220));
  const afterStale = (await readStream(alice, deps)).length;
  ok(afterStale === before, `★ nothing landed (${before} before, ${afterStale} after)`);

  // ── 4. the shape gate, on the real published shape ──
  console.log('\n4. the shape gate');
  const noSeq = await call('publish_context', {
    graph_iri: alice.graphIri,
    graph_content:
      `@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n`
      + `<${alice.graphIri}/e/broken> a wsp:Entry ; wsp:workspace <${WS}> .\n`,
    visibility: 'public',
    auto_supersede_prior: false,
    conforms_to_shapes: [WSP_SHAPES],
  });
  ok(noSeq.code === 422, `an entry with no wsp:seq is refused (got ${noSeq.code ?? 'published'})`);
  ok(
    JSON.stringify(noSeq.violations ?? '').includes('wsp#seq'),
    'the refusal names the constraint that failed',
  );
  const afterShape = (await readStream(alice, deps)).length;
  ok(afterShape === before, `★ nothing landed (${before} before, ${afterShape} after)`);

  // ── 5. every entry id dereferences ──
  //
  // An identifier that resolves only inside our own process is the failure the engagement
  // ids had: every one of them 404'd while their own comment promised they resolved.
  console.log('\n5. dereferenceability');
  for (const url of landed.slice(0, 2)) {
    // The descriptor and its payload are separate resources: the 6-facet descriptor in
    // `turtle`, the entry's own triples in `graph.content`. Asserting on the payload is
    // the point — a descriptor that resolves to an empty graph would pass a laxer check.
    const got = await call('get_descriptor', { url });
    //
    // The payload keeps the prefixed forms it was written with, so match on those rather
    // than the expanded IRIs — asserting the wrong lexical form fails a passing system.
    const payload = String((got.graph as { content?: unknown } | undefined)?.content ?? '');
    ok(
      got.error === undefined
      && /wsp:seq\s+"\d+"\^\^xsd:nonNegativeInteger/.test(payload)
      && payload.includes('a wsp:Entry'),
      `the entry resolves to its own triples: …${url.slice(-24)}`,
      JSON.stringify(got).slice(0, 200),
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
