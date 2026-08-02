#!/usr/bin/env tsx
/**
 * Increment 3 against the live substrate: two members, two DIFFERENT pods, one view.
 *
 * The doubles in tests/workspace-compose.test.ts answer per-pod from a map. That proves
 * the merge logic and proves nothing about whether two real pods can be composed at all —
 * which is the entire claim this layer makes over a single-relay design. So this runs it
 * for real, and then checks the two properties a double cannot reach:
 *
 *   * a member whose pod is unreachable costs THAT MEMBER's entries and nothing else,
 *     and the view says so rather than looking complete
 *   * a citation into another vertical resolves to the real record, uncopied
 *
 * Two bearers are required, for two separate identities with two separate pods. That is not
 * ceremony: the relay's publish scope gate refuses a caller writing to someone else's pod,
 * which is the design working, and a test that routed around it would verify nothing.
 *
 * Usage:
 *   IEP_BEARER=<token-a> IEP_BEARER_B=<token-b> \
 *     npx tsx applications/shared-workspace/tools/verify-compose-live.ts [run-id]
 */

import { appendEntry, type StreamDeps } from '../src/stream.js';
import { composeWorkspace, resolveCitations, describeCoverage, type ComposableMember } from '../src/compose.js';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';

/**
 * An environment variable this script cannot run without, narrowed to `string`.
 *
 * Same correction as `verify-can-live.ts`: a bare `if (!BEARER) process.exit(2)` beside the
 * `process.env` read does not narrow inside a nested function body, so every use below stayed
 * `string | undefined`. Nothing said so until this file entered a tsconfig program.
 */
function requiredEnv(name: string, why: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`${name} is required — ${why}`);
    process.exit(2);
  }
  return value;
}
const BEARER = requiredEnv('IEP_BEARER', 'this test needs two real participants.');
// ★ TWO bearers, because there are two participants.
//
// The first version of this used one identity and `pod_name` to reach a second pod. The
// relay refused with `scope_violation` — correctly, and the refusal is the design working.
// A participant writes to their OWN pod with their OWN credentials; that is the property
// the whole layer rests on, and a test that routed around it would have verified nothing.
const BEARER_B = requiredEnv('IEP_BEARER_B', 'this test needs two real participants.');

const RUN = process.argv[2] ?? String(Date.now());
const WS = `${RELAY}/ns/maintainer/wsp-compose-${RUN}`;

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `\n         ${d}` : ''}`); }
};

let id = 200;
async function callAs(bearer: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
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

const call = (name: string, args: Record<string, unknown>) => callAs(BEARER, name, args);
const deps = (bearer: string): StreamDeps => ({
  publish: a => callAs(bearer, 'publish_context', a),
  discover: a => callAs(bearer, 'discover_context', a),
});

async function main(): Promise<void> {
  const statusA = await callAs(BEARER, 'get_pod_status', {});
  const statusB = await callAs(BEARER_B, 'get_pod_status', {});
  const podA = String(statusA.podUrl ?? statusA.pod ?? '');
  const podB = String(statusB.podUrl ?? statusB.pod ?? '');
  if (!podA || !podB) { console.error('no pod', JSON.stringify({ statusA, statusB }).slice(0, 300)); process.exit(2); }
  if (podA === podB) { console.error('both bearers resolve to the SAME pod — this proves nothing'); process.exit(2); }

  console.log(`\nworkspace: ${WS}\npod A:     ${podA}\npod B:     ${podB}\n`);

  const alice: ComposableMember = {
    principal: String(statusA.webId ?? `${WS}#alice`), stream: `${WS}/stream/alice`, podUrl: podA,
  };
  const bee: ComposableMember = {
    principal: String(statusB.webId ?? `${WS}#bee`), stream: `${WS}/stream/bee`, podUrl: podB,
  };

  // ── write to two pods, each participant using their OWN credentials ──
  console.log('1. two participants writing to their own pods');
  for (const i of [0, 1]) {
    const r = await appendEntry(
      { graphIri: alice.stream, workspace: WS, podUrl: podA },
      { body: `alice entry ${i}` }, deps(BEARER),
    );
    ok(r.outcome === 'appended', `alice entry ${i} landed on her own pod`, JSON.stringify(r).slice(0, 220));
  }

  // A citation into another record published elsewhere entirely — cited, never copied.
  const CITED = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp.ttl';
  const rb = await appendEntry(
    { graphIri: bee.stream, workspace: WS, podUrl: podB },
    { body: 'bee entry 0, citing another vertical', references: [CITED] }, deps(BEARER_B),
  );
  ok(rb.outcome === 'appended', '★ bee entry 0 landed on a DIFFERENT pod, under her own key',
    JSON.stringify(rb).slice(0, 300));

  // ── 2. compose ──
  console.log('\n2. composing the two pods into one view');
  const view = await composeWorkspace({ workspace: WS, members: [alice, bee] }, deps(BEARER));
  console.log(`   ${describeCoverage(view)}`);
  ok(view.complete, 'the view is complete — both streams read and verified');
  ok(view.entries.length === 3, `three entries across two pods (got ${view.entries.length})`);
  ok(
    new Set(view.entries.map(e => e.principal)).size === 2,
    '★ entries from BOTH members, held on different pods, in one view',
  );
  ok(
    view.entries.every((e, i) => i === 0 || (e.validFrom ?? '') >= (view.entries[i - 1]!.validFrom ?? '')),
    'the advisory merge is in non-decreasing time order',
  );
  ok(view.crossStreamOrderIsAdvisory === true, 'the view states that cross-stream order is advisory');

  // ── 3. one pod unreachable ──
  //
  // The competitive property, and the one a single-relay design cannot have: when the
  // relay is down there, everything is gone. Here it is one member's worth of gone — and
  // the view has to SAY so, or a reader sees a partial workspace as a whole one.
  console.log('\n3. one member unreachable');
  const brokenBot: ComposableMember = { ...bee, podUrl: 'https://pod-that-does-not-exist.invalid/' };
  const partial = await composeWorkspace({ workspace: WS, members: [alice, brokenBot] }, deps(BEARER));
  console.log(`   ${describeCoverage(partial)}`);
  ok(partial.entries.length === 2, `★ alice's entries survive (got ${partial.entries.length})`);
  ok(partial.unavailable.length === 1, 'the unreachable member is named');
  ok(!partial.complete, '★ and the view is NOT complete, so it cannot be rendered as whole by accident');

  // ── 4. the citation resolves, and is not a copy ──
  console.log('\n4. a citation into another vertical');
  const resolved = await resolveCitations([{ from: bee.stream, iri: CITED }], async iri => {
    const r = await fetch(iri, { headers: { Accept: 'text/turtle' } });
    if (!r.ok) return null;
    const body = await r.text();
    return { types: body.includes('owl:Ontology') ? ['http://www.w3.org/2002/07/owl#Ontology'] : [] };
  });
  ok(resolved[0]?.resolved === true, 'the cited record resolves at its own IRI', JSON.stringify(resolved[0]));
  const botEntries = view.entries.filter(e => e.principal === bee.principal);
  const payload = botEntries[0]
    ? String(((await call('get_descriptor', { url: botEntries[0].descriptorUrl })).graph as { content?: unknown })?.content ?? '')
    : '';
  ok(payload.includes('wsp:references'), 'the entry carries the citation');
  ok(
    payload.includes(CITED) && !payload.includes('owl:Ontology'),
    '★ it carries the IRI, NOT a copy of the cited record',
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
