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
  ?? 'https://gate.interego.xwisee.com/foxxi/federation-peer/';

// A substantial course on a topic the Foxxi tenant pod does not carry —
// so a federated discovery visibly reaches something the vertical alone
// can't, and answers from real content rather than a metadata stub.
const peerCourse = {
  packageMeta: {
    course_id: 'incident-response-basics',
    course_label: 'Incident Response',
    title: 'Incident Response Fundamentals',
    federation_iri_base: 'https://peer-academy.example/courses/incident-response',
  },
  concepts: [
    { id: 'c-triage', label: 'incident triage', confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: ['s-triage'] },
    { id: 'c-severity', label: 'severity classification', confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: ['s-severity'] },
    { id: 'c-escalation', label: 'escalation path', confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: ['s-escalation'] },
    { id: 'c-comms', label: 'incident communication', confidence: 1, tier: 2, is_free_standing: false, taught_in_slides: ['s-comms'] },
    { id: 'c-review', label: 'post-incident review', confidence: 1, tier: 2, is_free_standing: false, taught_in_slides: ['s-review'] },
  ],
  slides: [
    {
      id: 's-triage', title: 'Triage — the first fifteen minutes', sequence_index: 0, concept_ids: ['c-triage'],
      transcript_combined: 'When an incident is reported, triage it within fifteen minutes before anything '
        + 'else. Triage answers three questions: what is the observable impact, who and what is affected, and '
        + 'is the impact still spreading. Do not begin a root-cause investigation during triage — triage '
        + 'exists only to size the incident and start the response. Open a dedicated incident channel, name '
        + 'an incident commander, and record the first timestamp; every later action is measured from it.',
    },
    {
      id: 's-severity', title: 'Severity classification', sequence_index: 1, concept_ids: ['c-severity'],
      transcript_combined: 'Severity is assigned from the impact, not from the suspected cause. Sev-1 is a '
        + 'full outage or data loss affecting many customers — it pages the on-call lead immediately. Sev-2 '
        + 'is a major feature degraded, or a subset of customers affected, with a workaround available. '
        + 'Sev-3 is a minor or cosmetic issue with no customer-visible impact. Severity is re-evaluated as '
        + 'the picture changes: an incident that looks Sev-3 at triage is raised to Sev-1 the moment the '
        + 'blast radius grows.',
    },
    {
      id: 's-escalation', title: 'The escalation path', sequence_index: 2, concept_ids: ['c-escalation'],
      transcript_combined: 'Escalation is time-boxed, not discretionary. A Sev-1 escalates to the on-call '
        + 'lead immediately and to the engineering director within thirty minutes if it is not contained. A '
        + 'Sev-2 escalates to the lead within an hour. Escalate early rather than late — an escalation is a '
        + 'request for help and authority, not an admission of failure. Hand off with the facts, the current '
        + 'severity, what has been tried, and a recommendation, so the person you escalate to can act rather '
        + 'than re-investigate from scratch.',
    },
    {
      id: 's-comms', title: 'Communicating during an incident', sequence_index: 3, concept_ids: ['c-comms'],
      transcript_combined: 'During an incident the commander posts a status update on a fixed cadence — '
        + 'every thirty minutes for a Sev-1 — even when the update is "no change". Each update states what is '
        + 'known, what is being done, and when the next update will come. Keep the internal channel and the '
        + 'customer-facing status page separate but consistent. Never speculate about cause on the status '
        + 'page; report only observed impact and the next checkpoint.',
    },
    {
      id: 's-review', title: 'The post-incident review', sequence_index: 4, concept_ids: ['c-review'],
      transcript_combined: 'Within five business days of resolution, run a blameless post-incident review. '
        + 'Reconstruct the timeline from the incident channel, identify the contributing factors rather than '
        + 'a single cause, and produce action items each with an owner and a due date. The review asks how '
        + 'the system let the incident happen, and how it was detected and resolved — not who made a '
        + 'mistake. An incident is not closed until its review action items are tracked.',
    },
  ],
  modifier_pairs: [],
  prereq_edges: [
    { from: 'c-triage', to: 'c-severity' },
    { from: 'c-severity', to: 'c-escalation' },
  ],
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
const entries = (turtle.match(/a iep:ManifestEntry/g) ?? []).length;
console.log(`   ✓ peer manifest reachable (HTTP ${res.status}) — ${entries} ManifestEntry`);

if (res.status !== 200 || entries < 1) {
  console.error('   ✗ peer pod manifest is not discoverable — provisioning failed');
  process.exit(1);
}
console.log('\nFederation peer is live. Set on the bridge:');
console.log(`  FOXXI_FEDERATION_PODS=${PEER_POD}`);
