// Semantic-alignment auditor — tests shared semantics across agents
// with the four fixes from the protocol post-mortem:
//
//   1. Multi-round: accepts N graphs, reports per-issuer stability
//      across rounds rather than one-shot snapshots.
//   2. Independence-enforced: groups by Trust-facet `issuer` and
//      flags agreement that comes from a single issuer as fake.
//   3. Schema-resolution check: reports whether `conformsTo` targets
//      are dereferenceable (nominal vs structural validation).
//   4. Pragmatic follow-through: walks `wasDerivedFrom` chains to
//      check that validation descriptors actually cite the claim
//      they purport to validate.
//
// Honest about what it measures vs what it doesn't — see the
// per-graph report comments.

import { readFileSync, writeFileSync } from 'node:fs';

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;

// ── Fetch + parse helpers ───────────────────────────────────

async function fetchText(url, timeoutMs = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle' }, signal: ac.signal });
    return r.ok ? await r.text() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

// Walks the manifest grouping lines into entry blocks terminated by a
// `.`; picks out the fields we need per block. Regex-based because the
// shape is known and tight — matching the ontology-emitted format.
function parseManifestEntries(ttl) {
  const entries = [];
  let cur = null;
  for (const raw of ttl.split('\n')) {
    const line = raw.trim();
    const start = line.match(/^<([^>]+)>\s+a\s+cg:ManifestEntry/);
    if (start) { cur = { descriptorUrl: start[1], describes: [], conformsTo: [] }; continue; }
    if (!cur) continue;
    let m;
    if ((m = line.match(/cg:describes\s+<([^>]+)>/))) cur.describes.push(m[1]);
    if ((m = line.match(/dct:conformsTo\s+<([^>]+)>/))) cur.conformsTo.push(m[1]);
    if ((m = line.match(/cg:modalStatus\s+cg:(\w+)/))) cur.modalStatus = m[1];
    if ((m = line.match(/cg:trustLevel\s+cg:(\w+)/))) cur.trustLevel = m[1];
    if ((m = line.match(/cg:validFrom\s+"([^"]+)"/))) cur.validFrom = m[1];
    if (line.endsWith('.')) { entries.push(cur); cur = null; }
  }
  return entries;
}

// Pull issuer, modalStatus, epistemicConfidence, wasDerivedFrom from a
// descriptor's Turtle — the cleartext part, no envelope decryption.
function parseDescriptor(ttl) {
  const issuerM = ttl.match(/cg:TrustFacet[\s\S]*?cg:issuer\s+<([^>]+)>/);
  const modalM = ttl.match(/cg:modalStatus\s+cg:(\w+)/);
  const confM = ttl.match(/cg:epistemicConfidence\s+"([\d.]+)"/);
  const conformsToMatches = [...ttl.matchAll(/dct:conformsTo\s+<([^>]+)>/g)];
  const derivedFromMatches = [...ttl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)];
  const supersedesMatches = [...ttl.matchAll(/cg:supersedes\s+<([^>]+)>/g)];
  const describesM = ttl.match(/cg:describes\s+<([^>]+)>/);
  return {
    issuer: issuerM?.[1] ?? null,
    modal: modalM?.[1] ?? null,
    confidence: confM ? parseFloat(confM[1]) : null,
    conformsTo: conformsToMatches.map(m => m[1]),
    wasDerivedFrom: derivedFromMatches.map(m => m[1]),
    supersedes: supersedesMatches.map(m => m[1]),
    describes: describesM?.[1] ?? null,
  };
}

// ── The four-signal audit ───────────────────────────────────

function audit(graphIri, descriptors, allDescMap) {
  const issuers = new Set(descriptors.map(d => d.issuer).filter(Boolean));
  const modals = new Set(descriptors.map(d => d.modal).filter(Boolean));
  const conformsTos = new Set(descriptors.flatMap(d => d.conformsTo));
  const confidences = descriptors.map(d => d.confidence).filter(c => c != null);
  const confSpread = confidences.length >= 2
    ? Math.max(...confidences) - Math.min(...confidences)
    : 0;

  // Fix #4 — pragmatic follow-through: do later descriptors in the
  // chain actually cite the earlier ones? We know the IRI of each
  // descriptor's own graph via `describes`; a validation descriptor
  // should have wasDerivedFrom ↦ (some earlier descriptor's ID).
  //
  // The ID is opaque (urn:cg:markj:<timestamp>), so we check: does
  // each non-first descriptor's `wasDerivedFrom` include at least one
  // other descriptor in this graph's set?
  const descriptorIds = new Set(
    descriptors.map(d => d.descriptorUrl.split('/').pop().replace('.ttl', ''))
      .map(id => `urn:cg:markj:${id}`),
  );
  const sortedDescs = [...descriptors].sort((a, b) => (a.validFrom ?? '').localeCompare(b.validFrom ?? ''));
  const chainClosesCount = sortedDescs.slice(1).filter(d => {
    const desc = allDescMap.get(d.descriptorUrl);
    if (!desc) return false;
    return desc.wasDerivedFrom.some(iri => descriptorIds.has(iri))
        || desc.wasDerivedFrom.some(iri => graphsInSet(descriptors, iri));
  }).length;

  return {
    graphIri,
    descriptorCount: descriptors.length,
    issuerCount: issuers.size,
    modalCount: modals.size,
    conformsToCount: conformsTos.size,
    confidenceSpread: confSpread,
    derivationChainClosureCount: chainClosesCount,
    expectedChainClosures: descriptors.length - 1,
    issuers: [...issuers],
    modals: [...modals],
    conformsTos: [...conformsTos],
  };
}

// Does this graph-set include a descriptor whose described graph matches the IRI?
function graphsInSet(descriptors, iri) {
  for (const d of descriptors) {
    const desc = d.__full;
    if (desc && desc.describes === iri) return true;
  }
  return false;
}

function renderReport(a) {
  const lines = [];
  lines.push(`── Graph: ${a.graphIri}`);
  lines.push(`   Descriptors: ${a.descriptorCount}`);
  lines.push(`   Unique issuers: ${a.issuerCount}`);
  lines.push(`   Modal variants: ${a.modalCount} (${a.modals.join(', ')})`);
  lines.push(`   Vocabulary (conformsTo) variants: ${a.conformsToCount}`);
  lines.push(`   Confidence spread: ${a.confidenceSpread.toFixed(3)}`);
  lines.push(`   Derivation chain closure: ${a.derivationChainClosureCount}/${a.expectedChainClosures}`);
  lines.push('');

  // Honesty checks:
  if (a.issuerCount <= 1) {
    lines.push(`   ⚠ WARNING: all descriptors share a single issuer. Any "agreement"`);
    lines.push(`     signal here is nominal — same author can trivially produce facet`);
    lines.push(`     alignment. For a real independence test, need descriptors from`);
    lines.push(`     different Trust.issuer values.`);
  } else {
    lines.push(`   ✓ Independence check passed: ${a.issuerCount} distinct issuers.`);
  }

  if (a.modalCount === 1 && a.conformsToCount === 1) {
    lines.push(`   → Alignment shape: vocabulary-and-modal aligned.`);
  } else if (a.modalCount > 1 && a.conformsToCount === 1) {
    lines.push(`   → Alignment shape: vocabulary-aligned + modal-disputed.`);
    lines.push(`     This is SUBSTANTIVE disagreement (agents agree on what the`);
    lines.push(`     term means, disagree on its truth). Not a semantic mismatch.`);
  } else if (a.conformsToCount > 1) {
    lines.push(`   → Alignment shape: vocabulary-divergent (different lenses).`);
    lines.push(`     This is SEMANTIC mismatch — agents interpret the referent`);
    lines.push(`     under different schemas.`);
  }

  if (a.derivationChainClosureCount < a.expectedChainClosures) {
    lines.push(`   ⚠ Derivation chain incomplete — some descriptors don't cite`);
    lines.push(`     their predecessors. Pragmatic follow-through weak.`);
  }

  return lines.join('\n');
}

// ── Schema-resolution check (fix #3) ───────────────────────

async function checkSchemaResolvable(schemaUrl) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(schemaUrl, { method: 'HEAD', signal: ac.signal });
    return r.ok ? 'dereferenceable' : `http-${r.status}`;
  } catch { return 'unreachable'; } finally { clearTimeout(t); }
}

// ── Multi-round stability (fix #1) ──────────────────────────

// If issuer I participates across >1 graph in the audit set with
// consistent (modal, conformsTo) pairing, that's a stability signal:
// their interpretive lens holds across topics.
function crossRoundStability(perGraphDescriptors) {
  const issuerBehaviors = new Map(); // issuer → [{graph, modal, conformsTo}, ...]
  for (const [graphIri, descs] of Object.entries(perGraphDescriptors)) {
    for (const d of descs) {
      if (!d.issuer) continue;
      if (!issuerBehaviors.has(d.issuer)) issuerBehaviors.set(d.issuer, []);
      issuerBehaviors.get(d.issuer).push({ graph: graphIri, modal: d.modal, conformsTo: d.conformsTo });
    }
  }

  const lines = ['── Multi-round stability (per issuer):'];
  for (const [issuer, behaviors] of issuerBehaviors.entries()) {
    const graphs = new Set(behaviors.map(b => b.graph));
    if (graphs.size < 2) continue;
    const modalsUsed = new Set(behaviors.map(b => b.modal));
    const schemasUsed = new Set(behaviors.flatMap(b => b.conformsTo));
    lines.push(`   ${issuer.slice(0, 60)}…`);
    lines.push(`     appeared across ${graphs.size} graphs`);
    lines.push(`     modals used: ${[...modalsUsed].join(', ')}`);
    lines.push(`     schemas used: ${[...schemasUsed].length}`);
  }
  if (lines.length === 1) lines.push('   (no issuer appeared in 2+ graphs)');
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────

const TARGET_GRAPHS = [
  'urn:graph:shared:sem-probe:fix-handles-session-encodings',
  'urn:graph:shared:sem-probe:fix-obviates-parser-through-2027',
];

const manifestTtl = await fetchText(MANIFEST_URL);
if (!manifestTtl) { console.error('Cannot fetch manifest'); process.exit(1); }

const entries = parseManifestEntries(manifestTtl);
const perGraph = {};
const allDescMap = new Map();

for (const graphIri of TARGET_GRAPHS) {
  const matching = entries.filter(e => e.describes.includes(graphIri));
  const enriched = [];
  for (const e of matching) {
    const descTtl = await fetchText(e.descriptorUrl, 8000);
    if (!descTtl) continue;
    const parsed = parseDescriptor(descTtl);
    enriched.push({ ...e, ...parsed, __full: parsed });
    allDescMap.set(e.descriptorUrl, parsed);
  }
  perGraph[graphIri] = enriched;
}

console.log('=== Semantic-alignment audit ===');
console.log(`Target graphs: ${TARGET_GRAPHS.length}`);
console.log(`Manifest URL:  ${MANIFEST_URL}\n`);

for (const graphIri of TARGET_GRAPHS) {
  const descs = perGraph[graphIri];
  const a = audit(graphIri, descs, allDescMap);
  console.log(renderReport(a));
  console.log('');
}

// Schema-resolution check
const allConformsTo = new Set();
for (const descs of Object.values(perGraph)) {
  for (const d of descs) for (const s of d.conformsTo) allConformsTo.add(s);
}
console.log('── Schema-resolution check (fix #3):');
for (const schema of allConformsTo) {
  const status = await checkSchemaResolvable(schema);
  const tag = status === 'dereferenceable' ? '✓' : '⚠';
  console.log(`   ${tag} ${schema} → ${status}`);
  if (status !== 'dereferenceable') {
    console.log(`       alignment on this schema is NOMINAL only — no structural`);
    console.log(`       validation (SHACL shape) can be applied.`);
  }
}
console.log('');

console.log(crossRoundStability(perGraph));
console.log('');

console.log('── Overall honesty check:');
console.log('   This auditor reports STRUCTURE — it cannot verify that');
console.log('   agents actually mean the same thing under a shared schema,');
console.log('   only that they nominally agree on the schema handle.');
console.log('   Positive alignment here = necessary-but-not-sufficient for');
console.log('   shared semantics. Keep probing.');
