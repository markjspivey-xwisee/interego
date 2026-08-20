#!/usr/bin/env node
/**
 * End-to-end compliance example.
 *
 * Walks through:
 *   1. Building a SOC 2 operational event (deploy) with src/ops/
 *   2. Validating the event against compliance-grade requirements
 *   3. Generating a framework conformance report from a set of events
 *   4. Optionally signing with a persisted ECDSA wallet
 *   5. Computing the descriptor URL that *would* be published
 *      (predictDescriptorUrl), so a caller could pre-sign before publish
 *
 * No live pod required. Run:
 *
 *     node examples/compliance-end-to-end.mjs
 *
 * Demonstrates the dogfood property: the protocol that customers use
 * to produce regulatory audit trails is the same one the operator
 * uses for theirs — see spec/policies/, spec/SOC2-PREPARATION.md.
 */

// ★ THESE ALL CAME FROM `../dist/index.js`, WHICH RESOLVES TO A REPO-ROOT `dist/` THAT HAS
// NEVER EXISTED — and half the names were never in one package anyway. An ESM relative specifier
// resolves against the FILE, not the cwd, so this example could not be run from anywhere:
// `node examples/compliance-end-to-end.mjs` died on ERR_MODULE_NOT_FOUND before printing a line.
// The operator event builders live in @interego/ops; the scoring and wallet live in
// @interego/compliance. Both resolve by workspace name from any cwd in the repo.
import {
  buildDeployEvent,
  buildAccessChangeEvent,
  buildIncidentEvent,
  buildQuarterlyReviewEvent,
} from '@interego/ops';
import {
  checkComplianceInputs,
  generateFrameworkReport,
  loadControlSet,
  loadOrCreateComplianceWallet,
} from '@interego/compliance';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OPERATOR_DID = 'did:web:identity.example#operator';

// ── Step 1: build a deploy event ─────────────────────────────
const deploy = buildDeployEvent({
  component: 'relay',
  commitSha: '0123abc456def',
  deployerDid: OPERATOR_DID,
  rollbackPlan: 'az containerapp revision activate --revision r-7',
});
console.log('━━ Step 1: deploy event ━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('graph_iri:', deploy.graph_iri);
console.log('framework:', deploy.compliance_framework);
console.log('controls cited:', deploy.controls.join(', '));
console.log('content (first 5 lines):');
console.log(deploy.graph_content.split('\n').slice(0, 8).join('\n'));
console.log();

// ── Step 2: pre-publish compliance check ────────────────────
// In real use this runs inside publish_context when compliance:true
// is set. Here we simulate: assume the descriptor was already
// signed by an ECDSA wallet (so hasSignature=true) and trust was
// upgraded to CryptographicallyVerified.
const checkResult = checkComplianceInputs({
  modalStatus: deploy.modal_status,
  trustLevel: 'CryptographicallyVerified',
  hasSignature: true,
  framework: deploy.compliance_framework,
});
console.log('━━ Step 2: pre-publish check ━━━━━━━━━━━━━━━━━━━━');
console.log('compliant:', checkResult.compliant);
console.log('violations:', checkResult.violations.length === 0 ? '<none>' : checkResult.violations);
console.log('upgraded facets:', checkResult.upgradedFacets.length === 0 ? '<none>' : checkResult.upgradedFacets);
console.log();

// What happens if we forget to sign?
const noSig = checkComplianceInputs({
  modalStatus: 'Asserted',
  trustLevel: 'SelfAsserted',
  hasSignature: false,
  framework: 'soc2',
});
console.log('━━ Step 2b: what happens if we DON\'T sign ━━━━━━');
console.log('compliant:', noSig.compliant);
console.log('violations:', noSig.violations);
console.log('(publish_context with compliance:true would refuse + return PARTIAL)');
console.log();

// ── Step 3: generate a framework conformance report ─────────
// Walk a set of events, aggregate evidence per SOC 2 control.
const events = [
  deploy,
  buildAccessChangeEvent({
    action: 'granted',
    principal: 'did:web:advisor.example',
    system: 'github',
    scope: 'PR review on main',
    grantorDid: OPERATOR_DID,
    justification: 'Independent advisor onboarding per policies/02-access-control.md §4.6',
  }),
  buildIncidentEvent({
    severity: 'sev-2',
    title: 'Brief identity flake',
    summary: 'OAuth /oauth/verify intermittently 502 for 8 minutes',
    detectedAt: '2026-04-25T11:00:00Z',
    detectionSource: 'azure-monitor',
    responderDid: OPERATOR_DID,
    status: 'resolved',
  }),
  buildQuarterlyReviewEvent({
    quarter: '2026-Q2',
    kind: 'access',
    reviewerDid: OPERATOR_DID,
    summary: 'Reviewed all 4 admin principals; no removals required',
    findingCount: 0,
  }),
];

// Convert to AuditableDescriptor shape that the report walker
// expects. In real use, descriptors come from the pod via
// discover_context; here we synthesize.
//
// ★ THE PUBLICATION TIME HAS TO FALL INSIDE THE PERIOD THE REPORT ASKS FOR.
//
// This stamped every descriptor `new Date().toISOString()` and then scored them against a fixed
// 2026-Q2 window. That was true the day it was written and quietly stopped being true on 1 July:
// from then on `inPeriod` excluded all four, and the walkthrough's headline read "0 satisfied, 0
// partial, 25 missing / overall score: 0.00" directly under a Step 1 announcing the very control
// it had just cited. Nobody saw it, because the file could not be run at all (see the imports).
//
// A real descriptor's `publishedAt` is the time the pod recorded it, which this example does not
// have: it synthesizes events rather than reading them back from a pod, and the event objects the
// builders return carry no publication time (measured — no ISO field on any of them). So these
// are SYNTHESIZED publication times, stated as such, chosen inside the quarter being reported on.
// The alternative of reaching for a plausible-looking field on the event and falling back to a
// literal would have produced the same four numbers while implying they came from the data.
const AUDIT_PERIOD = { from: '2026-04-01T00:00:00Z', to: '2026-06-30T23:59:59Z' };
const SYNTHESIZED_PUBLICATION_TIMES = [
  '2026-04-14T09:12:00Z', // deploy
  '2026-04-22T16:40:00Z', // access change
  '2026-04-25T12:05:00Z', // incident, just after the 11:00 detection above
  '2026-06-29T08:00:00Z', // quarterly review, at the close of the quarter
];
const auditable = events.map((e, i) => ({
  id: `urn:descriptor:example:${i}`,
  publishedAt: SYNTHESIZED_PUBLICATION_TIMES[i],
  evidenceForControls: e.controls,
}));

const report = generateFrameworkReport('soc2', auditable, { auditPeriod: AUDIT_PERIOD });
console.log('━━ Step 3: SOC 2 framework report ━━━━━━━━━━━━━━━');
console.log('framework:', report.framework);
console.log('audit period:', report.auditPeriod.from, '→', report.auditPeriod.to);
console.log('totals:',
  `${report.summary.satisfied} satisfied,`,
  `${report.summary.partial} partial,`,
  `${report.summary.missing} missing,`,
  `out of ${report.summary.totalControls}`);
console.log('overall score:', report.summary.overallScore.toFixed(2));
console.log();
console.log('per-control breakdown:');
// Padded to the widest IRI. `padEnd(20)` was a no-op the moment controlIri became the
// dereferenceable ~58-character URL rather than a CURIE, leaving every column ragged.
const entryWidth = Math.max(...report.entries.map(x => String(x.controlIri).length));
for (const entry of report.entries) {
  const mark = entry.status === 'satisfied' ? '✓'
            : entry.status === 'partial' ? '~' : ' ';
  console.log(`  ${mark} ${String(entry.controlIri).padEnd(entryWidth)} count=${entry.evidenceCount}  status=${entry.status.padEnd(9)}  ${entry.controlLabel}`);
}
console.log();

// ── Step 4: load (or mint) an ECDSA compliance wallet ────────
// Compliance descriptors must be ECDSA-signed for L4 conformance.
// Wallet is persisted; rotation is via rotateComplianceWallet().
console.log('━━ Step 4: compliance wallet ━━━━━━━━━━━━━━━━━━━━');
const walletPath = join(tmpdir(), `interego-example-wallet-${Date.now()}.json`);
const wallet = await loadOrCreateComplianceWallet(walletPath, 'compliance-signer-example');
console.log('wallet path :', wallet.path);
console.log('wallet addr :', wallet.wallet.address);
console.log('created at  :', wallet.createdAt);
console.log('fresh       :', wallet.fresh, wallet.fresh ? '(this run minted a new key)' : '(loaded from existing file)');
console.log('history     :', wallet.historyCount, 'retired key(s) still valid for verifying historical descriptors');
console.log();

// ── Step 5: framework controls catalog ──────────────────────
console.log('━━ Step 5: SOC 2 controls Interego knows about ━━━');
// The roster is READ FROM docs/ns/soc2.ttl at runtime, not from a table compiled into the
// package — so this prints what the project publishes about itself, and says which source it
// came from. `fallback` here would mean the ontologies were not reachable from wherever this ran.
const soc2Scope = loadControlSet('soc2');
console.log(`   scope: ${soc2Scope.scopeSource}${soc2Scope.scopeIri ? ` — ${soc2Scope.scopeIri}` : ''}`);
// Padded to the widest IRI so the table stays square now that a control is reported as the
// dereferenceable URL a reader can follow, rather than a CURIE only a prefix map resolves.
const soc2Width = Math.max(...soc2Scope.controls.map(x => String(x.iri).length));
for (const c of soc2Scope.controls) {
  console.log(`  ${String(c.iri).padEnd(soc2Width)}  ${c.label}`);
}
console.log();
console.log('━━ End ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('To publish for real, feed `deploy` (or any event) into');
console.log('publish_context with compliance: true on a registered pod.');
console.log('See spec/SOC2-PREPARATION.md §7 for the evidence collection plan.');
