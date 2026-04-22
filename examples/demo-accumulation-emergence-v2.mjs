// demo-accumulation-emergence-v2.mjs — same behavior as v1, but
// dogfoods the library builder + shared `_lib` helpers.
//
// Lines of code: v1 ≈ 125, v2 ≈ 65. Same semantics, less plumbing,
// canonical authoring path via ContextDescriptor.create(...)...build()
// + toTurtle(). Future builder/serializer fixes benefit every demo
// that uses the same path.

import { POD, fetchText, putText, buildDescriptorTurtle, publishDescriptorTurtle } from './_lib.mjs';

console.log('=== Accumulation-threshold emergence (v2 — dogfooded) ===\n');

const ts = Date.now();
const hypothesisId = `urn:cg:hypothesis:${ts}`;
const hypothesisGraph = `urn:graph:hypothesis:${ts}`;
const hypothesisUrl = `${POD}context-graphs/hypothesis-${ts}.ttl`;

// ── Publish hypothesis (Hypothetical, conf=0.2) ──────────────
console.log('1. Hypothesis published (Hypothetical, conf=0.2):');
const hypTtl = await buildDescriptorTurtle({
  id: hypothesisId,
  graphIri: hypothesisGraph,
  issuer: 'urn:agent:hypothesizer',
  modal: 'Hypothetical',
  confidence: 0.2,
});
await publishDescriptorTurtle(hypothesisUrl, hypothesisGraph, hypTtl);
console.log(`   → ${hypothesisUrl.split('/').pop()}\n`);

// ── Supporters publish evidence ─────────────────────────────
console.log('2. Supporters accumulate evidence:');
const supporters = [
  { issuer: 'urn:agent:supporter:tokenizer-fix',      delta: 0.15 },
  { issuer: 'urn:agent:supporter:object-list-fix',    delta: 0.15 },
  { issuer: 'urn:agent:supporter:test-suite',         delta: 0.15 },
  { issuer: 'urn:agent:supporter:adversarial',        delta: 0.10 },
  { issuer: 'urn:agent:supporter:cross-pod-verified', delta: 0.05 },
];

let aggConf = 0.2;
const supporterUrls = [];
for (const s of supporters) {
  aggConf = Math.min(1.0, aggConf + s.delta);
  const supId = `urn:cg:supporter:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const supGraph = `urn:graph:supporter:${Date.now()}`;
  const supUrl = `${POD}context-graphs/${supId.split(':').slice(-1)[0]}.ttl`;
  const ttl = await buildDescriptorTurtle({
    id: supId,
    graphIri: supGraph,
    issuer: s.issuer,
    modal: 'Asserted',
    confidence: 0.9,
    wasDerivedFrom: [hypothesisUrl],
  });
  await publishDescriptorTurtle(supUrl, supGraph, ttl);
  supporterUrls.push(supUrl);
  console.log(`   + ${s.issuer.split(':').slice(-1)[0].padEnd(22)} +${s.delta.toFixed(2)} → agg ${aggConf.toFixed(3)}`);
}
console.log('');

// ── Emerge if threshold crossed ─────────────────────────────
const THRESHOLD = 0.8;
if (aggConf >= THRESHOLD) {
  console.log(`3. Threshold crossed (${aggConf.toFixed(3)} ≥ ${THRESHOLD}) — emerging:`);
  const emId = `urn:cg:emerged:${Date.now()}`;
  const emGraph = `urn:graph:emerged:${Date.now()}`;
  const emUrl = `${POD}context-graphs/emerged-${Date.now()}.ttl`;
  const ttl = await buildDescriptorTurtle({
    id: emId,
    graphIri: emGraph,
    issuer: 'urn:agent:emergence-resolver',
    modal: 'Asserted',
    confidence: aggConf,
    supersedes: [hypothesisUrl],
    wasDerivedFrom: supporterUrls,
  });
  await publishDescriptorTurtle(emUrl, emGraph, ttl);
  console.log(`   ✓ Asserted supersession: ${emUrl.split('/').pop()}`);
  console.log(`     cg:supersedes → hypothesis ; prov:wasDerivedFrom → ${supporterUrls.length} supporters`);
}

console.log('\n── Dogfooded: all descriptors built via ContextDescriptor.create() + toTurtle().');
console.log('   Shared helpers from examples/_lib.mjs eliminate boilerplate across demos.');
