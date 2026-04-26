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

import {
  buildDeployEvent,
  buildAccessChangeEvent,
  buildIncidentEvent,
  buildQuarterlyReviewEvent,
  checkComplianceInputs,
  generateFrameworkReport,
  FRAMEWORK_CONTROLS,
  loadOrCreateComplianceWallet,
} from '../dist/index.js';
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
const auditable = events.map((e, i) => ({
  id: `urn:descriptor:example:${i}`,
  publishedAt: new Date().toISOString(),
  evidenceForControls: e.controls,
}));

const report = generateFrameworkReport('soc2', auditable, {
  auditPeriod: { from: '2026-04-01T00:00:00Z', to: '2026-06-30T23:59:59Z' },
});
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
for (const entry of report.entries) {
  const mark = entry.status === 'satisfied' ? '✓'
            : entry.status === 'partial' ? '~' : ' ';
  console.log(`  ${mark} ${entry.controlIri.padEnd(20)} count=${entry.evidenceCount}  status=${entry.status.padEnd(9)}  ${entry.controlLabel}`);
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
for (const c of FRAMEWORK_CONTROLS.soc2) {
  console.log(`  ${c.iri.padEnd(20)} ${c.label}`);
}
console.log();
console.log('━━ End ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('To publish for real, feed `deploy` (or any event) into');
console.log('publish_context with compliance: true on a registered pod.');
console.log('See spec/SOC2-PREPARATION.md §7 for the evidence collection plan.');
