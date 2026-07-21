#!/usr/bin/env node
// Publish a Foxxi OutcomeRecord describing a relay deploy outcome.
//
// Closes the Tier-1.B loop from the harness/RSI synthesis: every
// successful relay revision becomes a measured "performance" the
// reflexive calibration profile can learn from. Over time the profile
// reports which kinds of substrate changes (instrumentation vs
// knowledgeSkill vs environment) close findings vs don't change them.
//
// This is the substrate dogfooding its own dev: the same calibration
// machinery Foxxi uses for human L&D and for A2A teaching outcomes
// now also observes Interego development.
//
// Env vars expected (set by GitHub Actions / azure-deploy.sh):
//   CI_OUTCOME_WALLET_KEY  — hex private key for the signing wallet
//                            (generates a did:ethr signer)
//   CI_OUTCOME_BRIDGE_URL  — Foxxi bridge base URL
//                            (default: deployed Azure FQDN)
//   CI_OUTCOME_REVISION    — relay revision name (e.g. interego-relay--0000194)
//   CI_OUTCOME_VERDICT     — 'closed' | 'no-change' | 'regressed'
//   CI_OUTCOME_CAUSE       — 'knowledgeSkill' | 'instrumentation'
//                          | 'environment' | 'motivation' | 'capacity'
//                            (default: 'knowledgeSkill')
//   CI_OUTCOME_NOTE        — short free-text describing the change
//
// Behavior: if CI_OUTCOME_WALLET_KEY is unset OR the bridge POST fails,
// this script logs a warning and exits 0 — deploy MUST NOT fail because
// the introspection layer can't write. The substrate has the deploy
// already; calibration is observability ON TOP.

import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';

const KEY = process.env.CI_OUTCOME_WALLET_KEY;
if (!KEY || KEY.trim().length === 0) {
  console.log('[deploy-outcome] CI_OUTCOME_WALLET_KEY not set; skipping (calibration profile will not see this deploy)');
  process.exit(0);
}

const BRIDGE = (process.env.CI_OUTCOME_BRIDGE_URL || 'https://foxxi-bridge.interego.xwisee.com').replace(/\/$/, '');
const REVISION = process.env.CI_OUTCOME_REVISION || 'unknown';
const VERDICT = (process.env.CI_OUTCOME_VERDICT || 'closed').trim();
const CAUSE = (process.env.CI_OUTCOME_CAUSE || 'knowledgeSkill').trim();
const NOTE = (process.env.CI_OUTCOME_NOTE || `relay rev ${REVISION} deployed`).trim();

// Restrict to the values the bridge accepts for OutcomeRecord fields.
const validVerdict = ['closed', 'no-change', 'regressed'].includes(VERDICT) ? VERDICT : 'closed';
const validCause = ['knowledgeSkill', 'instrumentation', 'environment', 'motivation', 'capacity'].includes(CAUSE) ? CAUSE : 'knowledgeSkill';

let wallet;
try {
  wallet = new Wallet(KEY.startsWith('0x') ? KEY : `0x${KEY}`);
} catch (err) {
  console.log(`[deploy-outcome] CI_OUTCOME_WALLET_KEY is not a valid ECDSA private key: ${err.message}`);
  process.exit(0);
}
const authorDid = `did:ethr:${wallet.address}`;

// OutcomeRecord shape — matches applications/foxxi-content-intelligence
// /src/performance-calibration.ts. regime=Knowable for substrate dev
// (the change is knowledge/skill-domain, gap-analysis methodology).
const outcome = {
  regime: 'Knowable',
  method: 'gap-analysis',
  causeFactor: validCause,
  intervention: 'instruction',
  verdict: validVerdict,
  source: `relay-deploy:${REVISION}`,
  evidence: NOTE,
};

const signedPayload = JSON.stringify(outcome);
const hash = createHash('sha256').update(signedPayload, 'utf8').digest('hex');

(async () => {
  const signature = await wallet.signMessage(`sha256:${hash}`);
  const body = {
    author: { id: authorDid, kind: 'agent' },
    signature,
    signedPayload,
  };
  try {
    const resp = await fetch(`${BRIDGE}/performance/outcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.log(`[deploy-outcome] HTTP ${resp.status}: ${text.slice(0, 400)}`);
      process.exit(0); // do not fail the deploy
    }
    console.log(`[deploy-outcome] published OutcomeRecord for ${REVISION}: verdict=${validVerdict} cause=${validCause}`);
    try {
      const j = JSON.parse(text);
      const samples = j.body?.totalSamples ?? j.totalSamples;
      if (samples !== undefined) console.log(`[deploy-outcome] calibration profile now has ${samples} total samples`);
    } catch { /* ignore */ }
  } catch (err) {
    console.log(`[deploy-outcome] POST failed: ${err.message}`);
    process.exit(0);
  }
})();
