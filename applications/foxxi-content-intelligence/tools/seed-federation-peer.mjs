/**
 * Seed the federation-peer pod with real foxxi:Outcome descriptors.
 *
 *   npx tsx applications/foxxi-content-intelligence/tools/seed-federation-peer.mjs
 *
 * The federation peer is treated as a separate logical pod for the
 * purposes of cross-organization calibration. We publish ~30 outcome
 * descriptors there, mimicking what a peer "Peer Academy" organization
 * would have on its own pod. After this runs, the main bridge's
 * FederationOutcomeLoader will discover() them and compose them into
 * the federated calibration profile.
 *
 * Idempotent-ish: re-running publishes new descriptors with fresh
 * UUIDs but the existing ones remain on the pod (no overwrite).
 */

import { publishFoxxiEntity, FOXXI_TYPES } from '../src/outcome-descriptor-publisher.js';
import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';

const PEER_POD = process.env.PEER_POD_URL
  ?? 'https://gate.interego.xwisee.com/foxxi/federation-peer/';
const PEER_AUTHORITATIVE_SOURCE = process.env.PEER_AUTHORITATIVE_SOURCE
  ?? 'did:web:peer-academy.example';

// Federation peer needs a real signing identity — the bridge's federation
// loader (Option D) drops any outcome whose graph doesn't carry a
// foxxi:agentSignature that verifies against prov:wasGeneratedBy. Set
// PEER_SIGNING_KEY to a stable 0x-prefixed 32-byte hex to keep the peer's
// DID stable across re-seeds; otherwise this generates an ephemeral key.
const PEER_WALLET = process.env.PEER_SIGNING_KEY && /^0x[0-9a-fA-F]{64}$/.test(process.env.PEER_SIGNING_KEY)
  ? new Wallet(process.env.PEER_SIGNING_KEY)
  : Wallet.createRandom();
const PEER_DID = `did:key:${PEER_WALLET.address.toLowerCase()}#peer-academy`;
async function signOutcome(payload) {
  const signedPayloadJson = JSON.stringify(payload);
  const hash = createHash('sha256').update(signedPayloadJson, 'utf8').digest('hex');
  return { signedPayloadJson, signature: await PEER_WALLET.signMessage(`sha256:${hash}`) };
}

// 30 outcomes spread across plausible cells. The mix is designed so the
// peer's calibration looks like a realistic L&D operator: heavy
// 'information' + 'reference' (a knowledge-management practice), some
// 'knowledgeSkill' + 'training', some 'instrumentation' work that lands
// 'no-change' (showing failure modes honestly).
const PEER_OUTCOMES = [
  // Information → reference (10 outcomes, 8 closed = 80% closure rate)
  ...Array.from({ length: 8 }, (_, i) => ({
    regime: 'Knowable', method: 'gap-analysis',
    causeFactor: 'information', intervention: 'reference', verdict: 'closed',
    source: 'peer-academy',
    evidence: `peer-academy field case ${i + 1} — reached the reference in time`,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    regime: 'Knowable', method: 'gap-analysis',
    causeFactor: 'information', intervention: 'reference', verdict: 'no-change',
    reDiagnosedCause: 'knowledgeSkill', source: 'peer-academy',
    evidence: `peer-academy field case ${i + 9} — reference not reached in time`,
  })),
  // Information → job-aid (5 outcomes)
  ...Array.from({ length: 4 }, (_, i) => ({
    regime: 'Knowable', method: 'gap-analysis',
    causeFactor: 'information', intervention: 'job-aid', verdict: 'closed',
    source: 'peer-academy',
    evidence: `peer-academy procedure case ${i + 1} — job aid sufficed`,
  })),
  {
    regime: 'Knowable', method: 'gap-analysis',
    causeFactor: 'information', intervention: 'job-aid', verdict: 'improved',
    source: 'peer-academy',
    evidence: 'peer-academy procedure case — job aid helped but did not fully close',
  },
  // Knowledge & skill → training (8 outcomes, 6 closed)
  ...Array.from({ length: 6 }, (_, i) => ({
    regime: 'Knowable', method: 'gap-analysis',
    causeFactor: 'knowledgeSkill', intervention: 'training', verdict: 'closed',
    source: 'peer-academy',
    evidence: `peer-academy skill case ${i + 1} — training closed the gap`,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    regime: 'Knowable', method: 'gap-analysis',
    causeFactor: 'knowledgeSkill', intervention: 'training', verdict: 'improved',
    source: 'peer-academy',
    evidence: `peer-academy skill case ${i + 7} — improvement, not exemplary`,
  })),
  // Instrumentation → environmental-fix (6 outcomes)
  ...Array.from({ length: 4 }, (_, i) => ({
    regime: 'Knowable', method: 'gap-analysis',
    causeFactor: 'instrumentation', intervention: 'environmental-fix', verdict: 'closed',
    source: 'peer-academy',
    evidence: `peer-academy tool case ${i + 1} — environmental fix worked`,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    regime: 'Knowable', method: 'gap-analysis',
    causeFactor: 'instrumentation', intervention: 'training', verdict: 'no-change',
    reDiagnosedCause: 'instrumentation', source: 'peer-academy',
    evidence: `peer-academy tool case ${i + 5} — training did not help; cause was tooling`,
  })),
];

const podConfig = {
  podUrl: PEER_POD,
  authoritativeSource: PEER_AUTHORITATIVE_SOURCE,
  containerPath: 'foxxi/work-products/',
};

console.log(`\n  Seeding ${PEER_OUTCOMES.length} foxxi:Outcome descriptors to peer pod:`);
console.log(`  ${PEER_POD}`);
console.log(`  authoritativeSource: ${PEER_AUTHORITATIVE_SOURCE}`);
console.log(`  signing DID: ${PEER_DID}\n`);

let ok = 0;
let fail = 0;
for (let i = 0; i < PEER_OUTCOMES.length; i++) {
  const o = PEER_OUTCOMES[i];
  try {
    const { signedPayloadJson, signature } = await signOutcome(o);
    const result = await publishFoxxiEntity({
      config: podConfig,
      slugPrefix: 'outcome',
      foxxiType: FOXXI_TYPES.Outcome,
      payload: o,
      authoredBy: { id: PEER_DID, kind: 'agent', role: 'peer-academy-publisher' },
      agentSignature: signature,
      signedPayloadJson,
      modalStatus: 'Asserted',
      source: 'peer-academy',
    });
    process.stdout.write(`  ${String(i + 1).padStart(2)}/${PEER_OUTCOMES.length}  ${o.causeFactor.padEnd(15)} → ${o.intervention.padEnd(20)} ${o.verdict.padEnd(10)} → ${result.descriptorIri}\n`);
    ok++;
  } catch (err) {
    process.stdout.write(`  ${String(i + 1).padStart(2)}/${PEER_OUTCOMES.length}  FAILED: ${err.message}\n`);
    fail++;
  }
}

console.log(`\n  ${ok} published, ${fail} failed`);
console.log('\n  The federation peer pod now carries real foxxi:Outcome descriptors.');
console.log('  Set FOXXI_FEDERATION_PODS=<peer-pod-url> on the bridge and restart;');
console.log('  the calibration profile\'s federated view will compose them via discover().\n');
