#!/usr/bin/env tsx
/**
 * The cross-ORGANISATION claim, tested against an origin we do not operate.
 *
 * ★ WHY THIS IS DIFFERENT FROM THE CROSS-POD TEST. `verify-compose-live.ts` composes two
 * pods — but both are on our relay, behind our identity provider, running our code. That
 * proves federation between two directories we control. The README's actual claim is
 * bigger:
 *
 *     "A workspace can span organisations, because joining needs no shared server —
 *      only a WebID, a pod, and a grant."
 *
 * Calling the two-pod result "cross-org" would be exactly the overclaim this project keeps
 * catching in its own work. So the second member here lives on GITHUB PAGES: a static host
 * that has never heard of the relay, runs none of its code, shares none of its storage, and
 * cannot authenticate anybody. Its records are `docs/orgb/`, published by CI.
 *
 * If the composer folds that member in, the claim is real. If it cannot, the claim was
 * marketing — and either way this file says which.
 *
 * ★ WHAT IT DELIBERATELY DOES NOT CLAIM. The foreign member cannot WRITE: those files are
 * committed to git, so there is no runtime and no access control there. This tests the READ
 * and COMPOSE half, which is the half the composed view depends on. And the records carry no
 * `iep:authorshipProof`, so this shows where they are served from and nothing about who
 * wrote them — the same limit every other member has.
 *
 * Usage:
 *   IEP_BEARER=<token> npx tsx applications/shared-workspace/tools/verify-cross-org-live.ts
 */

import { readStream, verifyChain, appendEntry, type StreamDeps } from '../src/stream.js';
import { composeWorkspace, describeCoverage, isUnder, type ComposableMember } from '../src/compose.js';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const BEARER = process.env.IEP_BEARER;
if (!BEARER) { console.error('IEP_BEARER is required.'); process.exit(2); }

const RUN = process.argv[2] ?? String(Date.now());
const ORG_B = 'https://markjspivey-xwisee.github.io/interego/orgb/';
const WS = 'https://markjspivey-xwisee.github.io/interego/orgb/workspace';
const CAROL_STREAM = `${WS}/stream/carol`;
const CAROL = 'https://markjspivey-xwisee.github.io/interego/orgb/carol#me';

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `\n         ${d}` : ''}`); }
};

let id = 700;
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
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
const deps: StreamDeps = {
  publish: a => call('publish_context', a),
  discover: a => call('discover_context', a),
};

async function main(): Promise<void> {
  console.log(`\nOrg B (not ours): ${ORG_B}\n`);

  // ── 0. it is genuinely a different operator ──
  console.log('0. the second origin is not ours');
  const relayHost = new URL(RELAY).host;
  ok(new URL(ORG_B).host !== relayHost, `${new URL(ORG_B).host} is not ${relayHost}`);
  const manifest = await fetch(`${ORG_B}.well-known/context-graphs`);
  ok(manifest.status === 200, `its pod manifest is served (${manifest.status})`);
  ok(
    (manifest.headers.get('server') ?? '').toLowerCase().includes('github')
    || manifest.headers.has('x-github-request-id'),
    `and served by GitHub, not by us (server: ${manifest.headers.get('server') ?? 'unset'})`,
  );

  // ── 1. the relay reads a foreign pod ──
  console.log('\n1. the relay reads a pod it does not host');
  const rows = await readStream({ graphIri: CAROL_STREAM, workspace: WS, podUrl: ORG_B }, deps);
  ok(rows.length === 2, `two entries read from the foreign origin (got ${rows.length})`);

  const report = verifyChain(rows);
  ok(report.intact, '★ the chain VERIFIES — supersedes links walked, one head, no gaps');
  ok(report.heads.length === 1, `exactly one head (${report.heads.length})`);
  ok(
    rows.every(r => isUnder(r.descriptorUrl, ORG_B)),
    'every record is served from within that pod, so attribution is containable',
  );

  // ── 2. compose it with a member on OUR relay ──
  console.log('\n2. one workspace, two organisations');
  const status = await call('get_pod_status', {});
  const ourPod = String(status.pod ?? status.podUrl ?? '');
  // ★ A FRESH STREAM PER RUN, and the reason is worth recording. An earlier version of this
  // tool raw-published an UNLINKED entry to a fixed stream IRI, so each re-run added another
  // head. By the fourth run that stream had four heads, `appendEntry` correctly refused to
  // build on a chain that does not verify, and the composed view correctly withheld our
  // whole side — the tool reported a regression that was entirely its own.
  //
  // The poisoned stream is still on the pod, because nothing here deletes anything. That is
  // the custody property working, and it is why a run id is the fix rather than a cleanup.
  const ourStream = `${WS}/stream/${String(status.userId ?? 'us')}-${RUN}`;
  // ★ APPEND, do not raw-publish. The first version of this tool published an unlinked
  // entry under a fixed stream IRI, so every RE-RUN added another head: the chain stopped
  // verifying on the second run and the composed view withheld our whole side. The tool
  // passed 14/14 once and then reported a regression that was its own.
  //
  // appendEntry chains onto the verified head and waits for the deferred write to become
  // readable, so repeated runs extend ONE verified chain — which is a stronger check than
  // the original, because it exercises catch-up across runs rather than a fresh stream.
  const appended = await appendEntry(
    { graphIri: ourStream, workspace: WS, podUrl: ourPod },
    { body: 'our side of the workspace' },
    deps,
  );
  ok(
    appended.outcome === 'appended',
    'our own member appends to our own pod, chained onto its verified head',
    JSON.stringify(appended).slice(0, 200),
  );

  const members: ComposableMember[] = [
    { principal: String(status.webId), stream: ourStream, podUrl: ourPod },
    { principal: CAROL, stream: CAROL_STREAM, podUrl: ORG_B },
  ];
  const view = await composeWorkspace({ workspace: WS, members }, deps);
  console.log(`   ${describeCoverage(view)}`);

  ok(view.complete, 'the composed view is complete — both organisations read and verified');
  // Not a fixed count: our side is an append-only chain that GROWS on every run, which is
  // the point of chaining rather than republishing. What must hold is the invariant.
  const foreign = view.entries.filter(e => new URL(e.descriptorUrl).host !== new URL(ourPod).host);
  ok(foreign.length === 2, `both foreign entries are present (got ${foreign.length})`);
  ok(
    view.entries.length > foreign.length,
    `and at least one of ours alongside them (${view.entries.length} total)`,
  );
  ok(
    new Set(view.entries.map(e => new URL(e.descriptorUrl).host)).size === 2,
    '★ the entries are served by two different hosts, under two different operators',
  );
  ok(
    view.entries.some(e => e.principal === CAROL),
    '★ a member on infrastructure we do not run is IN the workspace',
  );
  ok(view.misattributed.length === 0, 'nothing was withheld as foreign-to-its-own-pod');

  // ── 3. the honest limit ──
  console.log('\n3. what this does NOT establish');
  const anyProof = await (await fetch(`${ORG_B}context-graphs/e0.ttl`)).text();
  ok(
    !anyProof.includes('authorshipProof'),
    '★ the foreign records carry NO authorship proof — provenance is unverified, as stated',
  );
  console.log('     read+compose across organisations: demonstrated.');
  console.log('     write from the foreign organisation: NOT demonstrated (static host, no runtime).');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
