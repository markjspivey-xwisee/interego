/**
 * Provision a federation peer pod for the Context Companion demo.
 *
 *   npx tsx tools/provision-federation-peer.mjs
 *
 * The Context Companion's `scope: "interego"` pass-through federates
 * discovery across the tenant pod AND every pod in FOXXI_FEDERATION_PODS.
 * To verify that against a *real* second source, this publishes a small
 * course package — "Incident Response Basics", a topic absent from the
 * Foxxi tenant pod — to a distinct Solid manifest, using the substrate's
 * own `publishCoursePackage()`. Idempotent: re-running re-publishes.
 *
 * The peer pod is a second `.well-known/context-graphs` manifest. In
 * this single-CSS demo it lives under the same public-write account; in
 * a real federation it is a different operator's pod — the `discover()`
 * call the bridge makes is identical either way.
 */

import { publishCoursePackage } from '../src/tenant-publisher.ts';

const PEER_POD = process.env.FOXXI_FEDERATION_PEER_POD
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/federation-peer/';

// A small course on a topic the Foxxi tenant pod does not carry — so a
// federated discovery visibly reaches something the vertical alone can't.
const peerCourse = {
  packageMeta: {
    course_id: 'incident-response-basics',
    course_label: 'Incident Response',
    title: 'Incident Response Basics',
    federation_iri_base: 'https://peer-academy.example/courses/incident-response',
  },
  concepts: [
    { id: 'c-triage', label: 'incident triage', confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: ['s-triage'] },
    { id: 'c-escalation', label: 'escalation path', confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: ['s-escalation'] },
  ],
  slides: [
    {
      id: 's-triage', title: 'Triage', sequence_index: 0, concept_ids: ['c-triage'],
      transcript_combined: 'When an incident is reported, triage it within 15 minutes: assess the scope, '
        + 'assign a severity level from Sev-1 to Sev-3, and open a dedicated incident channel.',
    },
    {
      id: 's-escalation', title: 'Escalation', sequence_index: 1, concept_ids: ['c-escalation'],
      transcript_combined: 'A Sev-1 incident escalates to the on-call lead immediately and to the director '
        + 'within 30 minutes. Every action taken is logged in the incident channel as it happens.',
    },
  ],
  modifier_pairs: [],
  prereq_edges: [],
};

console.log('=== Provisioning the federation peer pod ===');
console.log(`   peer pod: ${PEER_POD}`);

const result = await publishCoursePackage(
  { courseId: 'incident-response-basics', payload: peerCourse },
  {
    podUrl: PEER_POD,
    authoritativeSource: 'did:web:peer-academy.example',
    fetch: globalThis.fetch,
    adminWebId: 'did:web:peer-academy.example',
    adminKeySeed: 'foxxi-federation-peer-demo-seed-2026',
  },
);

console.log(`   ✓ published "Incident Response Basics" course package`);
console.log(`     descriptor: ${result.descriptorUrl}`);
console.log(`     graph:      ${result.graphUrl}`);

// Verify it is discoverable back.
const manifestUrl = `${PEER_POD}.well-known/context-graphs`;
const res = await fetch(manifestUrl, { headers: { Accept: 'text/turtle' } });
const turtle = await res.text();
const entries = (turtle.match(/a cg:ManifestEntry/g) ?? []).length;
console.log(`   ✓ peer manifest reachable (HTTP ${res.status}) — ${entries} ManifestEntry`);

if (res.status !== 200 || entries < 1) {
  console.error('   ✗ peer pod manifest is not discoverable — provisioning failed');
  process.exit(1);
}
console.log('\nFederation peer is live. Set on the bridge:');
console.log(`  FOXXI_FEDERATION_PODS=${PEER_POD}`);
