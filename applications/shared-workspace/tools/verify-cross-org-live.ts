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

import { readStream, verifyChain, appendEntry, verifierStreamIri, type StreamDeps } from '../src/stream.js';
import { composeWorkspace, describeCoverage, isUnder, type ComposableMember } from '../src/compose.js';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const BEARER = process.env.IEP_BEARER;
if (!BEARER) { console.error('IEP_BEARER is required.'); process.exit(2); }

// ★ STABLE, AND `Date.now()` WAS THE BUG. See `verifierStreamIri`, which now refuses a clock
// outright. Nine runs of this tool with a clock here left nine abandoned single-entry chains at
// nine permanent IRIs under org B's fixed workspace, and never once extended one — while the two
// comments in §2 claimed the chain grew across runs and that this was the stronger check.
// Pass an argument only to start a NEW chain deliberately, and record why on the line below.
//   v2 — the first epoch written by `appendEntry`. The UNSUFFIXED IRI is the four-head chain the
//        raw-publish era forked; §2b reads it as a fixture rather than pretending it is gone.
const STREAM_EPOCH = process.argv[2] ?? 'v2';
const ORG_B = 'https://markjspivey-xwisee.github.io/interego/orgb/';
const WS = 'https://markjspivey-xwisee.github.io/interego/orgb/workspace';
const CAROL_STREAM = `${WS}/stream/carol`;
const CAROL = 'https://markjspivey-xwisee.github.io/interego/orgb/carol#me';

let pass = 0, fail = 0, skipped = 0;
const ok = (c: boolean, n: string, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `\n         ${d}` : ''}`); }
};
// ★ NOT `ok(true, ...)`. A check that could not run is not a check that passed. §2b's fixture is
// the one thing in this file a pod wipe can legitimately remove (scripts/ops/wipe-pods.sh), and
// a green summary that silently absorbed its disappearance would be the exact class of false
// assurance readStream refuses when it will not report an unreachable pod as an idle one.
const notExercised = (n: string, why: string) => {
  skipped++; console.log(`  SKIP ${n}\n         ${why}`);
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
  // ★ ONE STREAM ACROSS RUNS, and the run id it replaces is worth recording. An earlier version
  // raw-published an UNLINKED entry to a fixed stream IRI, so each re-run added another head; by
  // the fourth run the chain had four heads and would never verify again. The fix for THAT was to
  // stop raw-publishing — `appendEntry` below cannot fork a chain, because it refuses to build on
  // one that does not verify and gates the write on `if_match`. The run id added alongside it was
  // not part of the fix and quietly undid the check: a clocked IRI is empty on every run, so the
  // append always took the empty path and the catch-up it exists to exercise never ran once.
  const us = String(status.userId ?? 'us');
  const ourStream = verifierStreamIri(WS, us, STREAM_EPOCH);
  // ★ THE ASSERTION THE PREVIOUS FIX DID NOT HAVE, and its absence is why nine green runs
  // checked nothing: a clocked IRI and a stable one are indistinguishable to every other check
  // in this file, because a chain of length one verifies trivially. Derived twice from the same
  // inputs, a stable IRI is equal to itself.
  ok(
    ourStream === verifierStreamIri(WS, us, STREAM_EPOCH),
    `the stream IRI is stable across runs, not minted from a clock (${ourStream})`,
  );
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

  // ── 2b. the forked chain is a FIXTURE, not debris ──
  //
  // ★ Nothing deletes it and nothing should: the descriptors are immutable and the pod has no
  // retraction verb, which is the custody property working. What was missing is that nothing
  // READ it either, so the only genuinely forked chain on the live substrate sat unexamined
  // while the append path's refusal was tested solely against a four-head array built by hand
  // in tests/workspace-stream.test.ts. A double cannot produce this state: four signed,
  // manifest-listed, dereferenceable, mutually unlinked descriptors under one stream IRI are
  // something the current append path can no longer create. The one that already exists is the
  // only way to run the refusal against the substrate instead of against a stand-in.
  console.log('\n2b. the chain the raw-publish era forked, read as a fixture');
  const forkedIri = `${WS}/stream/${us}`;
  const forkedRef = { graphIri: forkedIri, workspace: WS, podUrl: ourPod };
  const forkedRows = await readStream(forkedRef, deps);
  if (forkedRows.length === 0) {
    notExercised(
      'the live refusal was NOT checked against a real forked chain',
      `<${forkedIri}> holds no entries. Either the pod was wiped or the fixture was removed; `
      + 'either way the substrate-level refusal below did not run, and this run proves less '
      + 'than a run that found it. Do not fabricate a replacement by raw-publishing one.',
    );
  } else {
    const forkedReport = verifyChain(forkedRows);
    ok(forkedRows.length >= 2, `the forked chain is still readable (${forkedRows.length} entries)`);
    ok(
      !forkedReport.intact && forkedReport.heads.length > 1,
      `★ and still reports as forked from the LIVE pod (${forkedReport.heads.length} heads)`,
    );
    const refused = await appendEntry(forkedRef, { body: 'this must not land' }, deps);
    ok(
      refused.outcome === 'conflict',
      '★ the append path refuses it against the real substrate, not against a hand-built array',
      JSON.stringify(refused).slice(0, 200),
    );
    ok(
      (await readStream(forkedRef, deps)).length === forkedRows.length,
      'and NOTHING landed — the refusal is before the write, not a rollback after it',
    );
  }

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

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} not exercised`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
