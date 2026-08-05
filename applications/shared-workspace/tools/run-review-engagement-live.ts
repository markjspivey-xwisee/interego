#!/usr/bin/env tsx
/**
 * A real engagement in a shared workspace: convene, grant, accept, do the work, witness it.
 *
 * ★ THIS PROGRAM KNOWS ABOUT EXACTLY ONE THING — a workspace. It convenes one, admits one
 * member, appends the member's work to the member's own stream, and appends the convener's
 * witness references to the convener's own stream. It never mentions another vertical, never
 * names an endpoint outside the relay, and never asks what the work will later be used for.
 * `tools/emergence-boundary-lint.mjs` greps for exactly that and fails the build if it slips.
 *
 * Each work item carries two triples beyond the workspace's own:
 *
 *     dct:conformsTo  <a term from the workspace's published skill scheme>
 *     iep:success     "true"^^xsd:boolean
 *
 * Both are PROTOCOL terms — Dublin Core and the Interego Protocol ontology — and neither is
 * this workspace's invention. Saying which skill an item exercised and whether it worked is
 * what makes a log of work a record of work; it is not instrumentation for anybody
 * downstream, and nothing here knows whether there is a downstream.
 *
 * The workspace's published work shape (`<convener-ns>wsp-work-shapes`) makes both mandatory
 * AT THE RELAY'S PUBLISH GATE, so an item missing either is refused 422 and never lands.
 * `--mutation-gate` proves that against the live gate rather than asserting it.
 *
 * Usage:
 *   IEP_BEARER_PERFORMER=<tok> IEP_BEARER_CONVENER=<tok> \
 *     npx tsx applications/shared-workspace/tools/run-review-engagement-live.ts --round 1
 *   ... --round 2
 *   ... --mutation-gate
 */

/* eslint-disable no-console */

import {
  appendEntry, readStream, verifyChain, type StreamDeps, type StreamRef, type EntryDraft,
} from '../src/stream.js';
import {
  workspaceTurtle, grantTurtle, acceptanceTurtle, publishMembershipRecord,
} from '../src/membership.js';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const GATE = process.env.IEP_GATE ?? 'https://gate.interego.xwisee.com';
const PERFORMER_BEARER = process.env.IEP_BEARER_PERFORMER;
const CONVENER_BEARER = process.env.IEP_BEARER_CONVENER;
if (!PERFORMER_BEARER || !CONVENER_BEARER) {
  console.error('IEP_BEARER_PERFORMER and IEP_BEARER_CONVENER are both required — two parties, two keys, two pods.');
  process.exit(2);
}

// ── The cast, by pod ─────────────────────────────────────────────────────────

const CONVENER_POD_SEGMENT = 'u-eth-9bf50894ff23';
const PERFORMER_POD_SEGMENT = 'u-eth-8f3b8e939600';
const CONVENER_NS = `${RELAY}/ns/${CONVENER_POD_SEGMENT}/`;
const PERFORMER_NS = `${RELAY}/ns/${PERFORMER_POD_SEGMENT}/`;
const CONVENER_POD = `${GATE}/${CONVENER_POD_SEGMENT}/`;
const PERFORMER_POD = `${GATE}/${PERFORMER_POD_SEGMENT}/`;
const CONVENER_DID = 'did:web:identity.interego.xwisee.com:agents:wsp-convener-u-eth-9bf50894ff23';
const PERFORMER_DID = 'did:web:identity.interego.xwisee.com:agents:wsp-performer-u-eth-8f3b8e939600';

// ── What the convener published, cited by URL ────────────────────────────────

const SKILL_TERM = `${CONVENER_NS}wsp-skills#EvidenceIntegrityReview`;
const WORK_SHAPES = `${CONVENER_NS}wsp-work-shapes`;
/** This vertical's own namespace and the protocol's — needed only by the mutation gate,
 *  which composes raw Turtle in order to express an attack the writer cannot express. */
const WSP_NS = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#';
const IEP_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const ROLE_PROFILE = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default';
const CONTRIBUTOR = `${ROLE_PROFILE}#Contributor`;

const WORKSPACE = `${CONVENER_NS}wsp-evidence-review`;
const GRANT = `${CONVENER_NS}wsp-evidence-review-grant-performer`;
const ACCEPTANCE = `${PERFORMER_NS}wsp-evidence-review-acceptance`;
const WORK_STREAM = `${PERFORMER_NS}wsp-evidence-review-work`;
const WITNESS_STREAM = `${CONVENER_NS}wsp-evidence-review-witness`;

// ── The work ─────────────────────────────────────────────────────────────────

interface WorkItem { readonly body: string; readonly success: boolean; readonly finding: string }

/**
 * Twelve reviews, in the order they were done. Two failed — and they are IN the record for
 * the same reason the successes are: a log that only records what went well is not evidence,
 * it is advertising, and any rate computed off it is a fabrication.
 */
const ROUND_1: readonly WorkItem[] = [
  { body: 'Reviewed the onboarding attestation for supplier ACC-8841: authorship proof verifies against the served payload, the cited invoice resolves, supersession chain is linear at depth 3.', success: true, finding: 'accepted' },
  { body: 'Reviewed incident record INC-2026-0417: the postmortem cites a log bundle that 404s, so the claim "root cause identified" rests on evidence nobody can now read.', success: false, finding: 'rejected — dangling evidence pointer' },
  { body: 'Reviewed the quarterly access-recertification bundle for the payments group: 41 attestations, every one signed by a reviewer distinct from the subject, no self-attestation.', success: true, finding: 'accepted' },
  { body: 'Reviewed change record CHG-11204: the approval is content-bound to the diff it approves, and the diff hash matches what was deployed.', success: true, finding: 'accepted' },
  { body: 'Reviewed vendor SOC 2 bridge letter for Q2: the letter is signed, in date, and names the same subservice organisations as the report it bridges from.', success: true, finding: 'accepted' },
  { body: 'Reviewed the data-retention exception for the archived claims store: the exception is signed by an approver whose delegation had already been revoked when they signed it.', success: false, finding: 'rejected — approver authority lapsed before signature' },
  { body: 'Reviewed the encryption-at-rest evidence for the reporting replica: the configuration snapshot is timestamped inside the audit window and its authorship proof binds to its own content.', success: true, finding: 'accepted' },
  { body: 'Reviewed backup-restore test record BRT-0091: the restore log, the checksum manifest and the sign-off all name the same backup set identifier.', success: true, finding: 'accepted' },
];

const ROUND_2: readonly WorkItem[] = [
  { body: 'Reviewed the privileged-access break-glass record for the 2026-07-28 outage: every elevation is bounded, expired on schedule, and is countersigned by an on-call engineer who was not the requester.', success: true, finding: 'accepted' },
  { body: 'Reviewed sub-processor change notification SPC-014: the notice predates the change by 34 days, and the DPA amendment it cites resolves and is executed by both parties.', success: true, finding: 'accepted' },
  { body: 'Reviewed the penetration-test remediation evidence for finding PT-2026-03: each closed item cites a merged change whose commit is reachable and whose test run is green.', success: true, finding: 'accepted' },
  { body: 'Reviewed the annual disaster-recovery exercise report: the RTO figure in the summary is the figure the timeline supports, and the two participants who signed it were both present in the timeline.', success: true, finding: 'accepted' },
];

// ── Wiring ───────────────────────────────────────────────────────────────────

let id = 900;
function makeCall(bearer: string) {
  return async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch(`${RELAY}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const raw = await r.text();
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(raw) as Record<string, unknown>; } catch {
      const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      try { j = JSON.parse(data) as Record<string, unknown>; } catch { /* neither */ }
    }
    const text = (j as { result?: { content?: { text?: string }[] } } | null)?.result?.content?.[0]?.text;
    try { return JSON.parse(text ?? '{}') as Record<string, unknown>; } catch { return { raw: text ?? raw }; }
  };
}
// `getDescriptor` is not optional for the membership half: `publishMembershipRecord` refuses
// to call a record published until it has READ IT BACK, because returning at acceptance
// reports a record nobody can read as published — which is how three live assertions in this
// repo once passed vacuously.
const performerDeps: StreamDeps = {
  publish: a => makeCall(PERFORMER_BEARER!)('publish_context', a),
  discover: a => makeCall(PERFORMER_BEARER!)('discover_context', a),
  getDescriptor: a => makeCall(PERFORMER_BEARER!)('get_descriptor', a),
};
const convenerDeps: StreamDeps = {
  publish: a => makeCall(CONVENER_BEARER!)('publish_context', a),
  discover: a => makeCall(CONVENER_BEARER!)('discover_context', a),
  getDescriptor: a => makeCall(CONVENER_BEARER!)('get_descriptor', a),
};

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, d = ''): void => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `\n         ${d}` : ''}`); }
};

/** The two protocol triples every work item carries, rendered for `EntryDraft.extraTriples`. */
function workTriples(success: boolean): readonly string[] {
  return [
    `dct:conformsTo <${SKILL_TERM}>`,
    `iep:success "${success ? 'true' : 'false'}"^^xsd:boolean`,
  ];
}

async function appendWork(
  ref: StreamRef, deps: StreamDeps, draft: EntryDraft, label: string,
): Promise<string | null> {
  const res = await appendEntry(ref, draft, deps);
  if (res.outcome !== 'appended') {
    ok(false, label, JSON.stringify(res).slice(0, 400));
    return null;
  }
  // ★ `signing` is read, not assumed. The relay catches a signing failure, warns, and
  // publishes anyway — and an entry written unsigned can never acquire a proof afterwards,
  // because the bytes are immutable and the key moves on.
  ok(res.signing === 'signed', `${label} — seq ${res.entry.seq}, signed, visible after ${res.visibleAfterMs}ms`, res.signingNote);
  return res.entry.descriptorUrl;
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function convene(): Promise<void> {
  console.log('\n1. the convener convenes the workspace and offers a place in it');
  const ws = await publishMembershipRecord({
    graphIri: WORKSPACE,
    graphContent: workspaceTurtle({
      workspaceIri: WORKSPACE, convener: CONVENER_DID, roleProfile: ROLE_PROFILE,
      title: 'Evidence-integrity review — 2026 Q3',
    }),
    agentDid: CONVENER_DID,
    shapes: [WORK_SHAPES],
  }, convenerDeps);
  ok(ws.outcome === 'published', `workspace record published (${WORKSPACE})`, JSON.stringify(ws).slice(0, 300));
  if (ws.outcome !== 'published') return;

  const grant = await publishMembershipRecord({
    graphIri: GRANT,
    graphContent: grantTurtle({
      grantIri: GRANT, workspace: WORKSPACE, grantedTo: PERFORMER_DID, role: CONTRIBUTOR,
      title: 'Contributor — evidence-integrity review',
    }),
    agentDid: CONVENER_DID,
    shapes: [WORK_SHAPES],
  }, convenerDeps);
  ok(grant.outcome === 'published', 'grant published on the CONVENER\'s pod', JSON.stringify(grant).slice(0, 300));
  if (grant.outcome !== 'published') return;

  // ★ THE OTHER HALF, ON THE OTHER POD, UNDER THE OTHER KEY. A grant alone is an unanswered
  // offer: without this the convener would be manufacturing a participant.
  const acceptance = await publishMembershipRecord({
    graphIri: ACCEPTANCE,
    graphContent: acceptanceTurtle({
      acceptanceIri: ACCEPTANCE, workspace: WORKSPACE, member: PERFORMER_DID,
      accepts: grant.descriptorUrl, stream: WORK_STREAM,
      title: 'Acceptance — evidence-integrity review',
    }),
    agentDid: PERFORMER_DID,
    shapes: [WORK_SHAPES],
  }, performerDeps);
  ok(acceptance.outcome === 'published', 'acceptance published on the PERFORMER\'s own pod, under their own key', JSON.stringify(acceptance).slice(0, 300));
  console.log(`       grant      ${grant.descriptorUrl}`);
  console.log(`       acceptance ${acceptance.outcome === 'published' ? acceptance.descriptorUrl : 'n/a'}`);
}

async function doRound(items: readonly WorkItem[], roundLabel: string): Promise<void> {
  console.log(`\n2. ${roundLabel}: the member does the work, on their own pod`);
  const workRef: StreamRef = { graphIri: WORK_STREAM, workspace: WORKSPACE, podUrl: PERFORMER_POD, agentDid: PERFORMER_DID };
  const witnessRef: StreamRef = { graphIri: WITNESS_STREAM, workspace: WORKSPACE, podUrl: CONVENER_POD, agentDid: CONVENER_DID };

  for (const item of items) {
    const url = await appendWork(workRef, performerDeps, {
      body: item.body,
      extraTriples: workTriples(item.success),
      shapes: [WORK_SHAPES],
    }, `work item (${item.success ? 'succeeded' : 'FAILED'}: ${item.finding})`);
    if (!url) continue;

    // ★ THE WITNESS IS A DIFFERENT PARTY WRITING TO A DIFFERENT POD UNDER A DIFFERENT KEY,
    // and it is an AUDITABLE check rather than an enforced one. Nothing downstream consults
    // it; the outcome that travels is the performer's own attestation. What this buys a
    // reader is that the two records exist independently, are separately signed, and can be
    // compared — not that anything compared them.
    await appendWork(witnessRef, convenerDeps, {
      body: `Witnessed: ${item.body}`,
      references: [url],
      extraTriples: workTriples(item.success),
      shapes: [WORK_SHAPES],
    }, `  witnessed by the convener → ${url.split('/').pop()}`);
  }

  const rows = await readStream(workRef, performerDeps);
  const report = verifyChain(rows);
  ok(report.intact, `the member's chain verifies — ${rows.length} entries, ${report.heads.length} head(s)`,
    JSON.stringify({ heads: report.heads.length, merges: report.merges.length, dangling: report.danglingLinks.length }));
  ok(report.heads.length === 1, `exactly one head (${report.heads.length})`);
  console.log(`       declaredSeqChecked: ${report.declaredSeqChecked}`);
  for (const r of report.ordered) console.log(`       ${r.descriptorUrl}`);
}

/**
 * ★ THE GATE, PROVEN AGAINST THE LIVE RELAY. An item that names the skill but asserts no
 * outcome must be REFUSED, not stored and flagged. Asserting this against a double would
 * prove only that the double refuses; the whole value is that the RELAY's general shape gate,
 * running a shape the convener published and nobody in this program wrote, does it.
 */
async function mutationGate(): Promise<void> {
  console.log('\n★ mutation gate: an item that asserts no outcome must never land');
  const ref: StreamRef = { graphIri: `${PERFORMER_NS}wsp-evidence-review-mutant`, workspace: WORKSPACE, podUrl: PERFORMER_POD, agentDid: PERFORMER_DID };
  const res = await appendEntry(ref, {
    body: 'An item with a skill and no outcome.',
    extraTriples: [`dct:conformsTo <${SKILL_TERM}>`],
    shapes: [WORK_SHAPES],
  }, performerDeps);
  ok(res.outcome === 'refused', `refused (outcome ${res.outcome})`, JSON.stringify(res).slice(0, 300));
  if (res.outcome !== 'refused') return;
  ok(res.code === 422, `with code 422 (got ${res.code})`);
  // ★ READ THE CONSTRAINT, NOT THE STATUS. A 422 also comes back when the gate could not
  // FETCH the shape at all — same code, opposite meaning, and a run that concluded from the
  // number alone would report "the gate refused my malformed item" when the truth was "the
  // gate never read your contract".
  const cited = (res.violations ?? []).filter(v => (v.path ?? '').endsWith('#success'));
  ok(cited.length === 1, 'and the violation names iep:success, so a shape was actually run',
    JSON.stringify(res.violations ?? []).slice(0, 400));
  ok(
    cited[0]?.constraint === 'http://www.w3.org/ns/shacl#MinCountConstraintComponent',
    `by sh:minCount (${cited[0]?.constraint ?? 'none'})`,
  );

  console.log('\n★ mutation gate: an item naming a skill outside the published scheme');
  const ref2: StreamRef = { ...ref, graphIri: `${PERFORMER_NS}wsp-evidence-review-mutant-2` };
  const res2 = await appendEntry(ref2, {
    body: 'An item naming a skill this workspace never published.',
    extraTriples: ['dct:conformsTo <https://example.org/a-skill-nobody-agreed-to>', 'iep:success "true"^^xsd:boolean'],
    shapes: [WORK_SHAPES],
  }, performerDeps);
  ok(res2.outcome === 'refused' && res2.code === 422, `refused 422 (outcome ${res2.outcome})`, JSON.stringify(res2).slice(0, 300));
  if (res2.outcome !== 'refused') return;
  const inViolation = (res2.violations ?? []).filter(v => v.constraint.endsWith('InConstraintComponent'));
  ok(inViolation.length === 1, 'by sh:in against the convener\'s scheme — the performer cannot name their own skill',
    JSON.stringify(res2.violations ?? []).slice(0, 400));

  // ★ THE ATTACK THAT EMPTIED THIS GATE, RUN AS A LEG OF IT.
  //
  // The work shape used to be `sh:targetClass wsp:Entry`. A reviewer published the SAME
  // graph twice, once with `a wsp:Entry` and once without, both declaring both shapes: the
  // typed one was refused 422 on sh:in and the untyped one PUBLISHED and still resolves,
  // because a target class is something a record can simply decline to declare. The
  // shape now targets `sh:targetSubjectsOf dct:conformsTo` — which is what the reader
  // requires in order to see a record at all — and makes the type an ordinary constraint.
  // Written with raw content rather than `appendEntry`, because `appendEntry` always emits
  // the type and could not express the attack.
  console.log('\n★ mutation gate: a work item that deletes its own rdf:type to escape the contract');
  const untypedIri = `${PERFORMER_NS}wsp-evidence-review-mutant-3`;
  const untyped = await publishMembershipRecord({
    graphIri: untypedIri,
    graphContent: `@prefix wsp: <${WSP_NS}> .
@prefix iep: <${IEP_NS}> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${untypedIri}/e/0>
  wsp:workspace <${WORKSPACE}> ;
  wsp:seq "0"^^xsd:nonNegativeInteger ;
  dct:description "An item with no rdf:type, naming a skill this workspace never published." ;
  dct:conformsTo <https://example.org/a-skill-nobody-agreed-to> ;
  iep:success "true"^^xsd:boolean .
`,
    agentDid: PERFORMER_DID,
    shapes: [WORK_SHAPES],
  }, performerDeps);
  ok(untyped.outcome === 'refused', `refused (outcome ${untyped.outcome})`, JSON.stringify(untyped).slice(0, 400));
  if (untyped.outcome === 'refused') {
    const paths = (untyped.violations ?? []).map(v => v.path ?? '');
    ok(paths.some(p => p.endsWith('22-rdf-syntax-ns#type')),
      'and the violation names rdf:type — so dropping the type is now a violation, not an escape',
      JSON.stringify(untyped.violations ?? []).slice(0, 400));
    ok(paths.some(p => p.endsWith('/conformsTo')),
      'AND the sh:in constraint still fires on the same record — the shape found it without the type',
      JSON.stringify(untyped.violations ?? []).slice(0, 400));
  }

  // ★ THE MEMBERSHIP HALF OF THE SAME PARAMETER, EXERCISED RATHER THAN THREADED. The
  // workspace's own shapes say in their own message that an undeclared role is NOT refused
  // here; the engagement's shape closes that at the gate. Without a check that actually
  // fires, `publishMembershipRecord`'s `shapes` would be a parameter nobody could tell was
  // connected to anything.
  console.log('\n★ mutation gate: a grant naming a role the declared profile does not publish');
  const rogue = await publishMembershipRecord({
    graphIri: `${CONVENER_NS}wsp-evidence-review-grant-mutant`,
    graphContent: grantTurtle({
      grantIri: `${CONVENER_NS}wsp-evidence-review-grant-mutant`,
      workspace: WORKSPACE, grantedTo: PERFORMER_DID,
      role: `${ROLE_PROFILE}#Superuser`,
      title: 'A role nobody published',
    }),
    agentDid: CONVENER_DID,
    shapes: [WORK_SHAPES],
  }, convenerDeps);
  ok(rogue.outcome === 'refused', `refused (outcome ${rogue.outcome})`, JSON.stringify(rogue).slice(0, 400));
  ok(rogue.outcome === 'refused' && rogue.code === 422, `with code 422 (got ${rogue.outcome === 'refused' ? rogue.code : 'n/a'})`);

  // CONTROL: the same publish WITHOUT the engagement's shape must be accepted, because the
  // workspace's own shapes deliberately do not check the role against the profile. Without
  // this leg a refusal proves nothing about which shape did the refusing.
  const control = await publishMembershipRecord({
    graphIri: `${CONVENER_NS}wsp-evidence-review-grant-mutant-control`,
    graphContent: grantTurtle({
      grantIri: `${CONVENER_NS}wsp-evidence-review-grant-mutant-control`,
      workspace: WORKSPACE, grantedTo: PERFORMER_DID,
      role: `${ROLE_PROFILE}#Superuser`,
      title: 'A role nobody published, with only the workspace-generic shapes',
    }),
    agentDid: CONVENER_DID,
  }, convenerDeps);
  ok(control.outcome === 'published',
    '★ and the SAME grant publishes without it — so the refusal is the engagement\'s shape, not the workspace\'s',
    JSON.stringify(control).slice(0, 300));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const round = argv.includes('--round') ? argv[argv.indexOf('--round') + 1] : null;
  console.log(`\nworkspace: ${WORKSPACE}`);
  console.log(`skill:     ${SKILL_TERM}`);
  console.log(`work shape:${WORK_SHAPES}`);

  // `--convene` is separable from `--round 1` on purpose: the work stream is append-only and
  // re-running a round to retry the membership half would duplicate every work item in it.
  if (argv.includes('--mutation-gate')) { await mutationGate(); }
  else if (argv.includes('--convene')) { await convene(); }
  else if (round === '1') { await convene(); await doRound(ROUND_1, 'round 1'); }
  else if (round === '2') { await doRound(ROUND_2, 'round 2'); }
  else { console.error('pass --convene, --round 1, --round 2, or --mutation-gate'); process.exit(2); }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
