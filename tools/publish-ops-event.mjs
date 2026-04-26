#!/usr/bin/env node
/**
 * publish-ops-event — emit a SOC 2 evidence descriptor from the CLI.
 *
 * Usage:
 *
 *   node tools/publish-ops-event.mjs deploy \
 *     --component relay \
 *     --commit "$(git rev-parse HEAD)" \
 *     --deployer-did "did:web:identity.example#operator"
 *
 *   node tools/publish-ops-event.mjs access \
 *     --action granted --principal did:web:advisor \
 *     --system github --scope read --grantor-did <did> \
 *     --justification "onboarding"
 *
 *   node tools/publish-ops-event.mjs wallet-rotation \
 *     --retired 0x... --new 0x... \
 *     --reason scheduled --operator-did <did>
 *
 *   node tools/publish-ops-event.mjs incident \
 *     --severity sev-2 --title "Auth flake" \
 *     --summary "..." --detected-at 2026-04-25T08:00:00Z \
 *     --source pager --responder-did <did> --status open
 *
 *   node tools/publish-ops-event.mjs review \
 *     --quarter 2026-Q2 --kind access \
 *     --reviewer-did <did> --summary "..." --finding-count 0
 *
 * By default the tool PRINTS the descriptor payload (graph_iri,
 * graph_content, modal_status, compliance_framework, controls)
 * as JSON. Operators can pipe this into their MCP client to
 * publish via publish_context with compliance: true.
 *
 * If POD_URL + AGENT_BEARER are set in the environment, the tool
 * additionally POSTs the payload to <POD_URL>/_ops/publish (a
 * thin wrapper to be added to the relay) — but that path is not
 * yet wired; the print path is the supported flow today.
 *
 * Why a separate CLI rather than auto-publishing from
 * azure-deploy.sh: the deploy script runs from the operator's
 * workstation without a long-running session; we don't want
 * implicit pod writes baked into the shell script. Making it
 * an explicit second step keeps the operator in the loop and
 * works the same way for every event type (deploy / access /
 * incident / review).
 */

import { argv, exit } from 'node:process';

// Resolve the helper from compiled dist/ so we don't need a TS runtime.
let ops;
try {
  ops = await import('../dist/ops/index.js');
} catch (err) {
  console.error('Could not load dist/ops/index.js — run `npm run build` first.');
  console.error(err.message);
  exit(2);
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function requireArg(args, key, errorMsg) {
  if (!args[key]) {
    console.error(`Missing required --${key} (${errorMsg})`);
    exit(1);
  }
  return args[key];
}

const [, , kind, ...rest] = argv;
const args = parseArgs(rest);

let payload;
switch (kind) {
  case 'deploy': {
    payload = ops.buildDeployEvent({
      component: requireArg(args, 'component', 'name of deployed component'),
      commitSha: requireArg(args, 'commit', 'git SHA of deployed code'),
      deployerDid: requireArg(args, 'deployer-did', 'DID of deployer'),
      environment: args['environment'],
      rollbackPlan: args['rollback'],
    });
    break;
  }
  case 'access': {
    payload = ops.buildAccessChangeEvent({
      action: requireArg(args, 'action', 'granted | revoked | modified'),
      principal: requireArg(args, 'principal', 'DID or identifier'),
      system: requireArg(args, 'system', 'azure | github | npm | etc'),
      scope: requireArg(args, 'scope', 'role / permission scope'),
      grantorDid: requireArg(args, 'grantor-did', 'DID of operator granting/revoking'),
      justification: requireArg(args, 'justification', 'why the change was made'),
    });
    break;
  }
  case 'wallet-rotation': {
    payload = ops.buildWalletRotationEvent({
      retiredAddress: requireArg(args, 'retired', 'retired key ETH address'),
      newActiveAddress: requireArg(args, 'new', 'new active key ETH address'),
      reason: requireArg(args, 'reason', 'scheduled | compromise-response | other'),
      operatorDid: requireArg(args, 'operator-did', 'operator DID'),
      note: args['note'],
    });
    break;
  }
  case 'incident': {
    payload = ops.buildIncidentEvent({
      severity: requireArg(args, 'severity', 'sev-1 | sev-2 | sev-3 | sev-4'),
      title: requireArg(args, 'title', 'short incident title'),
      summary: requireArg(args, 'summary', 'one-line summary'),
      detectedAt: requireArg(args, 'detected-at', 'ISO 8601 detection timestamp'),
      detectionSource: requireArg(args, 'source', 'how it was detected'),
      responderDid: requireArg(args, 'responder-did', 'DID of responder'),
      status: requireArg(args, 'status', 'open | contained | resolved'),
      affectedComponents: args['components'] ? String(args['components']).split(',') : undefined,
      supersedes: args['supersedes'] ? String(args['supersedes']).split(',') : undefined,
    });
    break;
  }
  case 'review': {
    payload = ops.buildQuarterlyReviewEvent({
      quarter: requireArg(args, 'quarter', '2026-Q2 etc'),
      kind: requireArg(args, 'kind', 'access | change | risk | vendor | monitoring'),
      reviewerDid: requireArg(args, 'reviewer-did', 'DID of reviewer'),
      summary: requireArg(args, 'summary', 'what was reviewed'),
      findingCount: parseInt(requireArg(args, 'finding-count', 'integer 0+'), 10),
      findings: args['findings'] ? String(args['findings']).split('|') : undefined,
    });
    break;
  }
  default: {
    console.error(`Unknown event kind: ${kind}`);
    console.error(`Supported: deploy | access | wallet-rotation | incident | review`);
    exit(1);
  }
}

console.log(JSON.stringify(payload, null, 2));
