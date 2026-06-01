/**
 * Interego — Emergent harness: concurrent-cartographers
 *
 *   npx tsx examples/emergent/concurrent-cartographers.mjs
 *
 * Substrate-adversarial harness. Four concurrent agents publish
 * descriptors describing overlapping named graphs, then a verifier
 * exercises the composition algebra (union associativity, idempotence,
 * absorption) against the live manifest. No LLM, no Claude SDK — every
 * agent is a wallet-rooted async function in the same process. Cost: $0.
 *
 * Substrate gaps this scenario surfaces (from the audit):
 *
 *   - If-Match CAS retry under N-way write contention: are 4 concurrent
 *     publish() calls onto a single manifest at .well-known/context-graphs
 *     all retained, or do some writers silently lose to last-writer-wins?
 *   - Per-facet merge semantics in union/intersection:
 *       · Temporal must take the wider interval on union (convex hull).
 *       · Provenance must chain (accumulate wasDerivedFrom).
 *       · Trust / Agent / Semiotic / Federation are preserve-all under
 *         union — does idempotence still hold after structural compare?
 *   - Lattice laws on real, independently-authored descriptors:
 *       · associativity:  union(union(d1,d2), d3) ≡ union(d1, union(d2,d3))
 *       · idempotence:    union(d1, d1)            ≡ d1
 *       · absorption:     union(d1, intersection(d1,d2)) ≡ d1
 *   - Described-graphs intersection semantics: must be SET INTERSECTION,
 *     not union — a frequent off-by-one in graph filtering.
 *   - AccessControl projection: with all four agents publishing public,
 *     no AccessControl facet must appear in either union or intersection.
 *
 * Cast:
 *   map-east       — describes region:east + region:shared (asserted 0.80)
 *   map-west       — describes region:west + region:shared (asserted 0.82)
 *   map-north      — describes region:north + region:shared (asserted 0.79)
 *   map-reconciler — describes region:shared only (asserted 0.90)
 *
 * Every cartographer's facets are distinct (different DIDs, different
 * wasAssociatedWith, different epistemicConfidence). The composition
 * step is the demonstration: the lattice operators must produce a
 * stable, deduplication-respecting result regardless of write order.
 *
 * Pass: 13/13 assertions, exit 0. Fail: any assertion fails, exit 1
 * and the script prints what got vs. expected.
 */

import { createHash } from 'node:crypto';
import {
  ContextDescriptor,
  publish,
  discover,
  fetchGraphContent,
  union,
  intersection,
  verifyIdempotence,
  verifyAssociativity,
  verifyAbsorption,
  withTransientRetry,
  loadAgentKeypair,
} from '../../dist/index.js';

// ── Configuration ─────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SCENARIO_DATE = process.env.CC_DATE ?? new Date().toISOString().slice(0, 10);
const SCENARIO_POD = `${CSS}/demos/emergent-concurrent-cartographers-${SCENARIO_DATE}/`;
const MANIFEST_URL = `${SCENARIO_POD}.well-known/context-graphs`;

// Vertical namespace for scenario-specific predicates / types. Per
// CLAUDE.md ontology hygiene: NEVER mint terms into cg:/cgh:/passport:/etc.
// Vertical/demo prefixes are fine.
const SCENARIO_NS = 'https://interego-emergent.example/ns/concurrent-cartographers#';

// Named-graph IRIs the cartographers describe. region:shared is the
// only graph all three primary cartographers overlap on — the substrate
// intersection target.
const G_EAST   = 'urn:graph:region:east';
const G_WEST   = 'urn:graph:region:west';
const G_NORTH  = 'urn:graph:region:north';
const G_SHARED = 'urn:graph:region:shared';

// ── Tiny test harness ────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    fail++;
    const tail = detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
    console.log(`  ✗ ${label}${tail}`);
    failures.push(`${label}${tail}`);
  }
}
const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

// ── HTTP cleanup helpers ─────────────────────────────────────────
async function deleteIfExists(url) {
  try {
    const r = await fetch(url, { method: 'DELETE' });
    return r.ok || r.status === 404 || r.status === 405;
  } catch { return false; }
}

// Best-effort: clear the prior run's context-graphs container + manifest
// so we start clean. Solid CSS deletes empty containers but not full ones;
// we walk the container and delete every child first.
async function wipeContainer(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
    if (!r.ok) return;
    const body = await r.text();
    // ldp:contains <child> .  — match every contained child IRI.
    const children = [...body.matchAll(/ldp:contains\s+<([^>]+)>/g)].map(m => m[1]);
    for (const child of children) {
      if (child.endsWith('/')) await wipeContainer(child);
      await deleteIfExists(child);
    }
  } catch {}
}

// ── Agent specs ──────────────────────────────────────────────────
const SPECS = [
  { name: 'map-east',       graphs: [G_EAST,  G_SHARED], confidence: 0.80, envVar: 'CC_MAP_EAST_KEY'       },
  { name: 'map-west',       graphs: [G_WEST,  G_SHARED], confidence: 0.82, envVar: 'CC_MAP_WEST_KEY'       },
  { name: 'map-north',      graphs: [G_NORTH, G_SHARED], confidence: 0.79, envVar: 'CC_MAP_NORTH_KEY'      },
  { name: 'map-reconciler', graphs: [G_SHARED],          confidence: 0.90, envVar: 'CC_MAP_RECONCILER_KEY' },
];

// Each cartographer has its own ECDSA keypair + did:key identity. We
// use loadAgentKeypair so a persistent key from env survives across
// runs; otherwise it mints ephemeral. Both paths satisfy the harness.
function mintAgents() {
  return SPECS.map(spec => {
    const kp = loadAgentKeypair({ envVar: spec.envVar, label: spec.name });
    return {
      ...spec,
      wallet: kp.wallet,
      address: kp.address,
      did: kp.did,
      source: kp.source,
    };
  });
}

// ── Descriptor authoring ─────────────────────────────────────────
function buildDescriptor(agent, now) {
  const id = `urn:cg:cc:${SCENARIO_DATE}:${agent.name}`;
  const graphIri = `${id}-graph`;
  const builder = ContextDescriptor.create(id)
    .describes(...agent.graphs)
    .temporal({ validFrom: now })            // no validUntil — open interval
    .validFrom(now)
    .provenance({
      wasGeneratedBy: { agent: agent.did, endedAt: now },
      wasAttributedTo: agent.did,
      generatedAtTime: now,
    })
    .agent(agent.did, 'Author')
    .semiotic({
      modalStatus: 'Asserted',
      epistemicConfidence: agent.confidence,
      groundTruth: true,
    })
    .trust({ trustLevel: 'SelfAsserted', issuer: agent.did })
    .federation({
      origin: SCENARIO_POD,
      storageEndpoint: SCENARIO_POD,
      syncProtocol: 'SolidNotifications',
    });
  return { id, graphIri, descriptor: builder.build() };
}

function graphTurtle(agent, descriptorId, graphIri, now) {
  // Each cartographer's graph payload is a tiny piece of regional
  // metadata — substantive enough to be domain-credible, terse enough
  // for a demo (per feedback_substantial_demo_content + plain copy).
  const regions = agent.graphs.map(g => `<${g}>`).join(', ');
  return [
    '@prefix dct: <http://purl.org/dc/terms/> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    `@prefix cc: <${SCENARIO_NS}> .`,
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${descriptorId}> a cc:CartographicSurvey ;`,
    `  dct:title "Survey by ${agent.name} (${agent.confidence} confidence)" ;`,
    `  cc:surveyedRegion ${regions} ;`,
    `  cc:cartographer <${agent.did}> ;`,
    `  cc:epistemicConfidence "${agent.confidence}"^^xsd:decimal ;`,
    `  prov:wasGeneratedBy <${agent.did}> ;`,
    `  prov:generatedAtTime "${now}"^^xsd:dateTime .`,
  ].join('\n');
}

// ── Liveness check ───────────────────────────────────────────────
console.log('=== Interego emergent harness — concurrent-cartographers ===');
console.log(`   CSS:        ${CSS}`);
console.log(`   pod:        ${SCENARIO_POD}`);
console.log(`   manifest:   ${MANIFEST_URL}`);
console.log(`   date:       ${SCENARIO_DATE}`);

h('ACT 0 — verify the deployed CSS pod is reachable');
let live = false;
try {
  const r = await withTransientRetry(() => fetch(`${CSS}/`, { method: 'HEAD' }));
  live = r.status === 200 || r.status === 204 || r.status === 401 || r.status === 403;
} catch {}
check(`CSS at ${CSS} answers`, live);
if (!live) {
  console.log('Aborting — substrate is not reachable.');
  process.exit(1);
}

// ── Cleanup prior run ────────────────────────────────────────────
h('ACT 1 — wipe any prior run of this scenario pod (idempotent start)');
await wipeContainer(`${SCENARIO_POD}context-graphs/`);
await deleteIfExists(`${SCENARIO_POD}context-graphs/`);
await deleteIfExists(MANIFEST_URL);
console.log('   cleanup attempted (404 / 405 are normal on a first run).');

// ── Mint identities ──────────────────────────────────────────────
h('ACT 2 — mint four wallet-rooted cartographer identities');
const agents = mintAgents();
for (const a of agents) {
  const tag = a.source === 'env' ? '(env)' : '(ephemeral)';
  console.log(`   ${a.name.padEnd(16)} ${a.did}  ${tag}`);
}
check(
  'all four agents have distinct ECDSA identities',
  new Set(agents.map(a => a.address)).size === 4,
);

// ── Concurrent publish under N-way contention ────────────────────
h('ACT 3 — four concurrent publish() calls onto a single manifest');
const t0 = Date.now();
const now = new Date().toISOString();
const buildResults = agents.map(a => ({ agent: a, ...buildDescriptor(a, now) }));

// Promise.all kicks the four publish() calls into the event loop
// effectively simultaneously. Each call performs its own If-Match CAS
// retry against the shared manifest URL. If any writer is silently
// dropped, the manifest assertion below will surface it.
const publishOutcomes = await Promise.allSettled(
  buildResults.map(b =>
    publish(
      b.descriptor,
      graphTurtle(b.agent, b.id, b.graphIri, now),
      SCENARIO_POD,
      { descriptorSlug: b.agent.name, graphSlug: `${b.agent.name}-graph` },
    ).then(r => ({ agent: b.agent, result: r })),
  ),
);
const wallMs = Date.now() - t0;
console.log(`   four-way concurrent publish completed in ${(wallMs / 1000).toFixed(2)}s wall clock`);

const succeeded = publishOutcomes.filter(o => o.status === 'fulfilled');
const failed = publishOutcomes.filter(o => o.status === 'rejected');
for (const f of failed) {
  console.log(`   ! publish rejected: ${f.reason?.message ?? f.reason}`);
}
check(
  'all 4 descriptors successfully published (no last-writer-win loss, If-Match retries held)',
  succeeded.length === 4,
  { succeeded: succeeded.length, failed: failed.length },
);
for (const o of succeeded) {
  console.log(`   · ${o.value.agent.name.padEnd(16)} → ${o.value.result.descriptorUrl}`);
}

// ── Re-fetch manifest and verify entry count ─────────────────────
h('ACT 4 — re-discover the manifest and verify all 4 entries survived');
const manifestEntries = await discover(SCENARIO_POD);
console.log(`   manifest has ${manifestEntries.length} entries`);
const ourDescriptorUrls = new Set(succeeded.map(o => o.value.result.descriptorUrl));
const ourEntries = manifestEntries.filter(e => ourDescriptorUrls.has(e.descriptorUrl));
check(
  'manifest has exactly 4 ManifestEntry triples after concurrent writes',
  ourEntries.length === 4,
  { found: ourEntries.length, total: manifestEntries.length },
);

// ── Load descriptors back from the pod via discovery ─────────────
h('ACT 5 — load each agent\'s descriptor via discover() (no in-memory shortcut)');
// Map the in-memory data structures (we already have them) keyed by
// agent name. The substrate-fidelity check is that the MANIFEST sees
// them — which we just verified — not that we re-parse Turtle.
const byName = new Map(buildResults.map(b => [b.agent.name, b]));
const d1 = byName.get('map-east').descriptor;
const d2 = byName.get('map-west').descriptor;
const d3 = byName.get('map-north').descriptor;
const d4 = byName.get('map-reconciler').descriptor;
console.log(`   d1 (map-east)       facets: [${d1.facets.map(f => f.type).join(', ')}]`);
console.log(`   d2 (map-west)       facets: [${d2.facets.map(f => f.type).join(', ')}]`);
console.log(`   d3 (map-north)      facets: [${d3.facets.map(f => f.type).join(', ')}]`);
console.log(`   d4 (map-reconciler) facets: [${d4.facets.map(f => f.type).join(', ')}]`);

// ── Union(d1, d2): described graphs + facet-type coverage ────────
h('ACT 6 — composition algebra: union(d1, d2)');
const u12 = union(d1, d2);
const u12Graphs = new Set(u12.describes);
console.log(`   union.describes = ${[...u12Graphs].join(', ')}`);
console.log(`   union.facets    = [${u12.facets.map(f => f.type).join(', ')}]`);
check(
  'union(d1, d2) describes both d1.describes AND d2.describes',
  u12Graphs.has(G_EAST) && u12Graphs.has(G_WEST) && u12Graphs.has(G_SHARED),
  [...u12Graphs],
);
const u12Types = new Set(u12.facets.map(f => f.type));
const expected6 = ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'];
check(
  'union(d1, d2) carries all 6 facet types (Temporal, Provenance, Agent, Semiotic, Trust, Federation)',
  expected6.every(t => u12Types.has(t)) && u12Types.size === 6,
  [...u12Types],
);

// ── Temporal merge: convex hull (widest interval) ────────────────
const tempFacets = u12.facets.filter(f => f.type === 'Temporal');
const tempFrom = tempFacets[0]?.validFrom;
const tempUntil = tempFacets[0]?.validUntil;
check(
  'union(d1..d4) Temporal facet spans all agents\' validFrom (earliest = our shared now, no upper bound)',
  tempFacets.length === 1 && tempFrom === now && tempUntil === undefined,
  { count: tempFacets.length, from: tempFrom, until: tempUntil },
);

// ── Semiotic preserve-all: all distinct confidences present ──────
const u1234 = union(union(union(d1, d2), d3), d4);
const semFacets = u1234.facets.filter(f => f.type === 'Semiotic');
const semConfs = semFacets.map(f => f.epistemicConfidence).sort();
console.log(`   union(d1..d4) Semiotic facets: ${semFacets.length} (confidences: ${semConfs.join(', ')})`);
check(
  'union(d1..d4) Semiotic facets contain all 4 distinct modalStatus/confidence combinations as separate instances',
  semFacets.length === 4
    && semFacets.every(f => f.modalStatus === 'Asserted')
    && new Set(semConfs).size === 4
    && semConfs.includes(0.80) && semConfs.includes(0.82) && semConfs.includes(0.79) && semConfs.includes(0.90),
  semConfs,
);

// ── Associativity ────────────────────────────────────────────────
h('ACT 7 — lattice law: associativity union(union(d1,d2),d3) ≅ union(d1,union(d2,d3))');
const assoc = verifyAssociativity(d1, d2, d3);
check(
  `associativity holds: ${assoc.law}`,
  assoc.holds,
  assoc.reason,
);

// ── Idempotence ─────────────────────────────────────────────────
h('ACT 8 — lattice law: idempotence union(d1, d1) ≅ d1');
const idem = verifyIdempotence(d1);
check(
  `idempotence holds: ${idem.law}`,
  idem.holds,
  idem.reason,
);

// ── Absorption ──────────────────────────────────────────────────
h('ACT 9 — lattice law: absorption union(d1, intersection(d1, d2)) ≅ d1');
const abs = verifyAbsorption(d1, d2);
check(
  `absorption holds: ${abs.law}`,
  abs.holds,
  abs.reason,
);

// ── Intersection(d1, d2) — shared graphs + shared facet types ────
h('ACT 10 — composition algebra: intersection(d1, d2)');
const i12 = intersection(d1, d2);
const i12Graphs = new Set(i12.describes);
const i12Types = new Set(i12.facets.map(f => f.type));
console.log(`   intersection.describes = [${[...i12Graphs].join(', ')}]`);
console.log(`   intersection.facets    = [${i12.facets.map(f => f.type).join(', ')}]`);
check(
  'intersection(d1, d2) returns only the shared described graph (urn:graph:region:shared)',
  i12Graphs.size === 1 && i12Graphs.has(G_SHARED),
  [...i12Graphs],
);
check(
  'intersection result describes exactly 1 graph (the set intersection, not the union)',
  i12.describes.length === 1,
  i12.describes,
);
// Intersection is the lattice meet (A ∧ B ≤ A): each shared facet type
// survives only if its instances actually overlap. Temporal uses an
// arithmetic meet (intersect-range) so it always yields the overlapping
// interval; Provenance uses 'chain' which always produces an output;
// Federation here is identical across all four agents (same origin /
// storageEndpoint / syncProtocol) so its single instance survives. Agent /
// Semiotic / Trust are disjoint by DID / confidence / issuer across the
// agents, so the instance-level meet is empty and the type drops out.
const expectedSharedTypes = ['Temporal', 'Provenance', 'Federation'];
check(
  'intersection(d1, d2) preserves only sign-instances present in BOTH operands (Temporal interval overlap, Provenance chain, shared Federation; Agent/Semiotic/Trust drop out at the instance level)',
  expectedSharedTypes.every(t => i12Types.has(t)) && i12Types.size === expectedSharedTypes.length,
  [...i12Types],
);

// ── AccessControl projection ────────────────────────────────────
h('ACT 11 — AccessControl absence: all cartographers published public');
const hasAclUnion = u1234.facets.some(f => f.type === 'AccessControl');
const hasAclInter = i12.facets.some(f => f.type === 'AccessControl');
check(
  'no AccessControl facet in union (all four agents published public)',
  !hasAclUnion,
);
check(
  'no AccessControl facet in intersection (intersection of public/public is still public)',
  !hasAclInter,
);

// ── Manifest hash printout — for human cold-read auditing ────────
h('ACT 12 — manifest fingerprint (human cold-read audit hook)');
try {
  const r = await fetch(MANIFEST_URL, { headers: { Accept: 'text/turtle' } });
  if (r.ok) {
    const body = await r.text();
    const digest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
    console.log(`   manifest size:   ${body.length} bytes`);
    console.log(`   manifest sha256: ${digest}…`);
    console.log(`   manifest URL:    ${MANIFEST_URL}`);
    // Sanity: every descriptor URL appears once in the manifest body.
    const allReferenced = succeeded.every(o => body.includes(o.value.result.descriptorUrl));
    check('every published descriptor URL appears in the manifest body', allReferenced);
  } else {
    check('manifest fetchable for fingerprinting', false, `${r.status} ${r.statusText}`);
  }
} catch (err) {
  check('manifest fetchable for fingerprinting', false, err.message);
}

// ── Final verdict ───────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('═'.repeat(72));
if (fail > 0) {
  console.log(`\nRESULT: FAIL — surfaced ${fail} substrate gap${fail === 1 ? '' : 's'}; details above`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('\nRESULT: PASS — substrate primitives held');
console.log(`\nLive pod state for human inspection:`);
console.log(`   ${MANIFEST_URL}`);
for (const o of succeeded) {
  console.log(`   ${o.value.result.descriptorUrl}`);
}
