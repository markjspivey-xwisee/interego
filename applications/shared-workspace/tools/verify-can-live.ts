#!/usr/bin/env tsx
/**
 * Increment 4 against the live substrate: authority, refused for real.
 *
 * Two layers refuse, and they refuse different things. Showing both together is the point,
 * because each on its own would misrepresent what this design can promise.
 *
 *   THE SUBSTRATE refuses a caller writing to someone else's pod. A hard, preventive
 *   refusal — 403 scope_violation, nothing lands.
 *
 *   THE WORKSPACE cannot refuse a member writing to their OWN pod, and does not pretend
 *   to. It is their pod. What it refuses is to COUNT the entry: an Observer's write
 *   succeeds at the substrate and is then not folded in, and the view says why.
 *
 * The second is the honest shape of authority in a federated design. Unauthorised writes
 * are not prevented; they are inert. That is auditable by anyone who can read the records,
 * including someone who is not a member and does not trust us — which a promise about a
 * server's behaviour is not.
 *
 * Usage:
 *   IEP_BEARER=<token-a> IEP_BEARER_B=<token-b> \
 *     npx tsx applications/shared-workspace/tools/verify-can-live.ts [run-id]
 */

import { appendEntry, type StreamDeps } from '../src/stream.js';
import { composeWorkspace, type ComposableMember } from '../src/compose.js';
import { authorizeView, scopesFromRegistry, canAct, CAPS, foldRoster, type RoleProfile } from '../src/can.js';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const BEARER = process.env.IEP_BEARER;
const BEARER_B = process.env.IEP_BEARER_B;
if (!BEARER || !BEARER_B) { console.error('IEP_BEARER and IEP_BEARER_B are both required.'); process.exit(2); }

const RUN = process.argv[2] ?? String(Date.now());
const WS = `${RELAY}/ns/maintainer/wsp-can-${RUN}`;
const P = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default';

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `\n         ${d}` : ''}`); }
};

let id = 400;
async function callAs(bearer: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
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
const deps = (bearer: string): StreamDeps => ({
  publish: a => callAs(bearer, 'publish_context', a),
  discover: a => callAs(bearer, 'discover_context', a),
});

const PROFILE: RoleProfile = {
  profile: P,
  roles: [
    { role: `${P}#Contributor`, permits: [CAPS.read, CAPS.append] },
    { role: `${P}#Observer`, permits: [CAPS.read] },
  ],
};

async function main(): Promise<void> {
  const sa = await callAs(BEARER, 'get_pod_status', {});
  const sb = await callAs(BEARER_B, 'get_pod_status', {});
  const podA = String(sa.pod ?? sa.podUrl ?? '');
  const podB = String(sb.pod ?? sb.podUrl ?? '');
  const alice = String(sa.webId);
  const bee = String(sb.webId);
  if (podA === podB) { console.error('same pod — proves nothing'); process.exit(2); }

  console.log(`\nworkspace: ${WS}\nalice: ${alice}\n  pod: ${podA}\nbee:   ${bee}\n  pod: ${podB}\n`);

  // ── the real registry supplies the ceiling, not this test ──
  console.log('1. the delegated scope comes from the substrate\'s own agent registry');
  const agentsA = (sa.agents ?? []) as { did?: string; scope?: string }[];
  const agentsB = (sb.agents ?? []) as { did?: string; scope?: string }[];
  ok(agentsA.length > 0 && agentsB.length > 0, 'both principals have registered agents with scopes');
  const scopes = scopesFromRegistry([
    { principal: alice, agents: agentsA },
    { principal: bee, agents: agentsB },
  ]);
  ok(
    scopes.every(s => s.capabilities.length > 0),
    `scopes resolved live: ${agentsA[0]?.scope} / ${agentsB[0]?.scope}`,
  );

  // ── bee is an OBSERVER: the role permits read only ──
  const g = (p: string, role: string) => ({ head: `${WS}/grant/${encodeURIComponent(p)}`, workspace: WS, grantedTo: p, role: `${P}#${role}` });
  const a = (p: string) => ({
    head: `${WS}/accept/${encodeURIComponent(p)}`, workspace: WS, member: p,
    accepts: `${WS}/grant/${encodeURIComponent(p)}`, stream: `${WS}/stream/${p === alice ? 'alice' : 'bee'}`,
  });
  const roster = foldRoster({
    workspace: WS, profile: PROFILE,
    grants: [g(alice, 'Contributor'), g(bee, 'Observer')],
    acceptances: [a(alice), a(bee)],
    scopes,
  });
  ok(roster.members.length === 2, 'both are members');
  ok(!canAct(roster, bee, CAPS.append).allowed, '★ bee is an Observer, so wsp.can refuses append');
  console.log(`     because: ${canAct(roster, bee, CAPS.append).because.slice(0, 120)}…`);

  // ── 2. the substrate's refusal: writing to SOMEONE ELSE'S pod ──
  console.log('\n2. the substrate refuses a write to another principal\'s pod');
  const crossPod = await callAs(BEARER_B, 'publish_context', {
    graph_iri: `${WS}/stream/alice`,
    graph_content: `<${WS}/stream/alice/e/0> <http://purl.org/dc/terms/description> "bee writing into alice's pod" .`,
    visibility: 'public', auto_supersede_prior: false, pod_name: podA.replace(/.*\/([^/]+)\/$/, '$1'),
  });
  ok(
    crossPod.code === 403 || crossPod.error !== undefined,
    `★ refused, and nothing landed (${crossPod.code ?? crossPod.error ?? 'ALLOWED — that would be a hole'})`,
    JSON.stringify(crossPod).slice(0, 200),
  );

  // ── 3. what the substrate CANNOT refuse: bee writing to her OWN pod ──
  console.log('\n3. bee writes to her OWN pod — and it succeeds, because it is her pod');
  const alicePut = await appendEntry(
    { graphIri: `${WS}/stream/alice`, workspace: WS, podUrl: podA }, { body: 'alice, a Contributor' }, deps(BEARER),
  );
  ok(alicePut.outcome === 'appended', 'alice appends to her own stream', JSON.stringify(alicePut).slice(0, 200));

  const beePut = await appendEntry(
    { graphIri: `${WS}/stream/bee`, workspace: WS, podUrl: podB }, { body: 'bee, an Observer, writing anyway' }, deps(BEARER_B),
  );
  ok(
    beePut.outcome === 'appended',
    '★ bee\'s write SUCCEEDS at the substrate — no chokepoint can stop it, and the design says so',
    JSON.stringify(beePut).slice(0, 200),
  );

  // ── 4. and the fold refuses to count it ──
  console.log('\n4. the fold refuses to COUNT it — enforcement where it can actually happen');
  const members: ComposableMember[] = [
    { principal: alice, stream: `${WS}/stream/alice`, podUrl: podA },
    { principal: bee, stream: `${WS}/stream/bee`, podUrl: podB },
  ];
  const raw = await composeWorkspace({ workspace: WS, members }, deps(BEARER));
  ok(raw.entries.length === 2, `both entries are readable on the pods (${raw.entries.length})`);

  const view = authorizeView(raw, roster);
  ok(view.entries.length === 1, `★ only one is workspace content (${view.entries.length})`);
  ok(view.entries[0]?.principal === alice, '★ and it is the Contributor\'s');
  ok(view.disallowed.length === 1, 'the Observer\'s entry is REPORTED, not silently filtered');
  ok(view.disallowed[0]?.because.includes('does not permit'), 'with a reason a person can act on');
  console.log(`     ${view.disallowed[0]?.because.slice(0, 150)}…`);

  // ── 5. the excluded entry is still THERE, at its own URL ──
  console.log('\n5. the excluded entry still exists, signed, at its own URL');
  const url = view.disallowed[0]!.entry.descriptorUrl;
  const got = await callAs(BEARER, 'get_descriptor', { url });
  ok(
    got.error === undefined && String((got.graph as { content?: unknown })?.content ?? '').includes('Observer, writing anyway'),
    '★ custody is intact — being excluded is not being deleted',
    JSON.stringify(got).slice(0, 160),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
