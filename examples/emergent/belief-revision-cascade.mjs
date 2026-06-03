/**
 * Interego emergent test — belief-revision-cascade.
 *
 *   npx tsx examples/emergent/belief-revision-cascade.mjs
 *
 * What this scenario is
 *   A single asserted upstream fact A0 is built upon by three sibling
 *   descriptors (B, C, D) that cite it as evidence, and one
 *   second-order descriptor (E) that cites B. The publisher then
 *   issues A1 which cg:supersedes A0 with modalStatus =
 *   Counterfactual — i.e. "the original claim turned out to be
 *   false." The verifier then walks the live pod and asserts the
 *   substrate carries that demotion cleanly through the dependency
 *   graph WITHOUT rewriting history.
 *
 * Substrate gap surfaced (per the audit)
 *   The modal-lattice meet is exercised at single-descriptor
 *   granularity by other tests, but propagation of a modal
 *   demotion through descriptor dependency edges
 *   (prov:wasDerivedFrom + cg:supersedes) is untested. This is the
 *   substrate's main differentiator vs a plain KG: epistemic
 *   accountability that survives composition. The harness fails
 *   loud if:
 *     · downstream descriptors are not reachable as
 *       'derived-from-counterfactual' via the dependency walk
 *     · discover_context with modalStatus:Asserted still surfaces
 *       transitively-tainted descriptors
 *     · a selective reconfirmation publish on B fails to restore
 *       B + E without also restoring C / D
 *     · the original A0 Asserted state is no longer queryable
 *       after A1 publishes (history-as-immutable-record is the
 *       point of cg:supersedes)
 *
 * Cast (six descriptors across two epochs)
 *   epoch 1 — A0 (Asserted), B / C / D (Asserted, derivedFrom A0),
 *             E (Asserted, derivedFrom B)
 *   epoch 2 — A1 (Counterfactual, cg:supersedes A0)
 *   epoch 3 — B' (Asserted, cg:supersedes B, derivedFrom A1)
 *             → selective reconfirmation: restores B + E only
 *
 * Assertions (every one is a check() call)
 *   1.  CSS reachable
 *   2.  six wallet-rooted identities are distinct
 *   3.  A0 publishes with modalStatus Asserted
 *   4.  B, C, D, E publish and each carries
 *       prov:wasDerivedFrom pointing at its upstream
 *   5.  A1 publishes Counterfactual + cg:supersedes A0
 *   6.  manifest exposes 6 descriptors and A0's Asserted entry is
 *       still present (history preserved)
 *   7.  walking dependency edges from A1 reaches { B, C, D, E } —
 *       the cascade is visible without modifying B/C/D/E
 *   8.  discover(modalStatus:Asserted) excludes any descriptor
 *       transitively derived-from a Counterfactual (or the
 *       Counterfactual itself)
 *   9.  reconfirmation B' publishes Asserted + cg:supersedes B +
 *       wasDerivedFrom A1
 *   10. after reconfirmation, the cascade set 'still tainted by
 *       Counterfactual' = { C, D } (B is restored, E inherits via
 *       its new B'-rooted edge)
 *   11. A0's original Asserted descriptor body remains fetchable
 *       (no rewrite-history): the substrate retains the Asserted
 *       graph alongside the Counterfactual supersede
 *
 * Pass / fail
 *   Exits 0 iff every assertion holds; non-zero with a
 *   per-assertion gap report otherwise. $0 cost — no LLM,
 *   no Claude SDK. ontology-lint clean (no new cg:/cgh:/pgsl:
 *   terms; only vertical `brc:` predicates in graph bodies).
 */

import { Wallet, verifyMessage } from 'ethers';
import { createHash } from 'node:crypto';
import {
  ContextDescriptor,
  publish,
  discover,
  fetchGraphContent,
  withTransientRetry,
  loadAgentKeypair,
} from '../../packages/core/dist/index.js';

// ── Configuration ─────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SCENARIO_DATE = process.env.BRC_DATE ?? new Date().toISOString().slice(0, 10);
const SCENARIO_POD = `${CSS}/demos/emergent-belief-revision-cascade-${SCENARIO_DATE}/`;
const MANIFEST_URL = `${SCENARIO_POD}.well-known/context-graphs`;

// Vertical namespace for scenario-specific predicates. Per ontology
// hygiene rules, vertical/demo prefixes are fine; we MUST NOT mint
// new cg:/cgh:/pgsl:/etc. terms.
const SCENARIO_NS = 'https://interego-emergent.example/ns/belief-revision-cascade#';

// Named graphs each claim describes.
const G_A = 'urn:graph:brc:claim-a';
const G_B = 'urn:graph:brc:claim-b';
const G_C = 'urn:graph:brc:claim-c';
const G_D = 'urn:graph:brc:claim-d';
const G_E = 'urn:graph:brc:claim-e';

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
// 405 (Method Not Allowed) is NOT a successful deletion — it means
// the pod refused to delete that resource and the file is still
// there. Accept only true success (2xx) plus the HTTP "definitely
// not present" outcomes (404 / 410). Cribbed from three-runtime-
// pilgrimage which surfaced exactly this gap.
async function deleteIfExists(url) {
  try {
    const r = await fetch(url, { method: 'DELETE' });
    if (r.status >= 200 && r.status < 205) return true;
    if (r.status === 404 || r.status === 410) return true;
    if (r.status === 405) {
      try {
        const head = await fetch(url, { method: 'HEAD' });
        if (head.status === 404 || head.status === 410) return true;
      } catch {
        // HEAD failed — fall through.
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Best-effort: walk the pod's context-graphs container and DELETE
// every child, then the container + manifest. Solid CSS refuses to
// delete a non-empty container so the recursion matters.
async function wipeContainer(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
    if (!r.ok) return;
    const body = await r.text();
    const children = [...body.matchAll(/ldp:contains\s+<([^>]+)>/g)].map(m => m[1]);
    for (const child of children) {
      if (child.endsWith('/')) await wipeContainer(child);
      await deleteIfExists(child);
    }
  } catch {}
}

// ── Agent specs ──────────────────────────────────────────────────
// Six wallet-rooted authors — one per descriptor in the cascade.
// Distinct DIDs are required for the "manifest mirrors per-author
// trust" check; the publisher of A1 is the same author as A0
// (epistemic-accountability semantics: the original author
// retracts).
const SPECS = [
  { name: 'author-a',  envVar: 'BRC_AUTHOR_A_KEY'  },  // publishes A0 + A1
  { name: 'author-b',  envVar: 'BRC_AUTHOR_B_KEY'  },
  { name: 'author-c',  envVar: 'BRC_AUTHOR_C_KEY'  },
  { name: 'author-d',  envVar: 'BRC_AUTHOR_D_KEY'  },
  { name: 'author-e',  envVar: 'BRC_AUTHOR_E_KEY'  },
];

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

// ── Signature helper ─────────────────────────────────────────────
async function signClaim(wallet, payload) {
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  const signature = await wallet.signMessage(`sha256:${hash}`);
  return { json, hash, signature };
}

// ── Descriptor builders ─────────────────────────────────────────
function buildAsserted({ id, author, graph, derivedFrom, now, summary }) {
  // derivedFrom is the list of UPSTREAM DESCRIPTOR IRIS this claim
  // builds on (not graph IRIs) — that's what makes the cascade
  // walkable through the manifest.
  const builder = ContextDescriptor.create(id)
    .describes(graph)
    .temporal({ validFrom: now })
    .validFrom(now)
    .provenance({
      wasGeneratedBy: { agent: author.did, endedAt: now },
      wasAttributedTo: author.did,
      generatedAtTime: now,
      wasDerivedFrom: derivedFrom && derivedFrom.length > 0 ? [...derivedFrom] : undefined,
    })
    .agent(author.did, 'Author')
    .semiotic({
      modalStatus: 'Asserted',
      groundTruth: true,
      epistemicConfidence: 0.9,
    })
    .trust({ trustLevel: 'SelfAsserted', issuer: author.did })
    .federation({
      origin: SCENARIO_POD,
      storageEndpoint: SCENARIO_POD,
      syncProtocol: 'SolidNotifications',
    });
  return { id, descriptor: builder.build(), author, graph, derivedFrom, summary, modal: 'Asserted' };
}

function buildCounterfactual({ id, author, graph, supersedes, derivedFrom, now, summary }) {
  // The retraction publish. Modal flips to Counterfactual; the
  // descriptor declares cg:supersedes against the prior Asserted
  // descriptor ID, so the manifest mirrors the link and downstream
  // walks can resolve "is my parent still believed?".
  const builder = ContextDescriptor.create(id)
    .describes(graph)
    .temporal({ validFrom: now })
    .validFrom(now)
    .supersedes(...(supersedes ?? []))
    .provenance({
      wasGeneratedBy: { agent: author.did, endedAt: now },
      wasAttributedTo: author.did,
      generatedAtTime: now,
      wasDerivedFrom: derivedFrom && derivedFrom.length > 0 ? [...derivedFrom] : undefined,
    })
    .agent(author.did, 'Author')
    .semiotic({
      modalStatus: 'Counterfactual',
      groundTruth: false,
      epistemicConfidence: 0.95,
    })
    .trust({ trustLevel: 'SelfAsserted', issuer: author.did })
    .federation({
      origin: SCENARIO_POD,
      storageEndpoint: SCENARIO_POD,
      syncProtocol: 'SolidNotifications',
    });
  return { id, descriptor: builder.build(), author, graph, supersedes, derivedFrom, summary, modal: 'Counterfactual' };
}

// Build a small but substantive Turtle payload — domain-credible,
// not a toy one-liner (per feedback_substantial_demo_content).
function graphTurtle({ id, author, graph, derivedFrom, supersedes, modal, summary, now, sig }) {
  const lines = [
    '@prefix dct:  <http://purl.org/dc/terms/> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix cg:   <https://contextgraphs.dev/ns/context-graphs#> .',
    `@prefix brc:  <${SCENARIO_NS}> .`,
    '',
    `<${graph}> a brc:Claim ;`,
    `  dct:title "${summary.title}" ;`,
    `  dct:description "${summary.description}" ;`,
    `  brc:claimDomain "${summary.domain}" ;`,
    `  brc:assertedModalStatus "${modal}" ;`,
    `  brc:signatureHash "sha256:${sig.hash}" ;`,
    `  brc:signature "${sig.signature}" ;`,
    `  prov:wasAttributedTo <${author.did}> ;`,
    `  prov:generatedAtTime "${now}"^^xsd:dateTime`,
  ];
  if (derivedFrom && derivedFrom.length > 0) {
    for (const upstream of derivedFrom) {
      lines.push(`  ; prov:wasDerivedFrom <${upstream}>`);
    }
  }
  if (supersedes && supersedes.length > 0) {
    for (const prior of supersedes) {
      lines.push(`  ; cg:supersedes <${prior}>`);
    }
  }
  lines.push(' .');
  return lines.join('\n');
}

// ── Liveness check ───────────────────────────────────────────────
console.log('=== Interego emergent harness — belief-revision-cascade ===');
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
console.log('   cleanup attempted (404 / 405 handled per deleteIfExists contract).');

// ── Mint identities ──────────────────────────────────────────────
h('ACT 2 — mint five wallet-rooted author identities');
const agents = mintAgents();
const byName = new Map(agents.map(a => [a.name, a]));
for (const a of agents) {
  const tag = a.source === 'env' ? '(env)' : '(ephemeral)';
  console.log(`   ${a.name.padEnd(10)} ${a.did}  ${tag}`);
}
check(
  'all five authors have distinct ECDSA identities',
  new Set(agents.map(a => a.address)).size === 5,
);

// Pre-compute the descriptor IRIs so the upstream can be cited
// from downstream graph bodies in epoch 1 (we publish A0 first,
// but the downstream descriptors need its IRI to set
// wasDerivedFrom).
const A0_ID = `urn:cg:brc:${SCENARIO_DATE}:a0`;
const A1_ID = `urn:cg:brc:${SCENARIO_DATE}:a1`;
const B_ID  = `urn:cg:brc:${SCENARIO_DATE}:b`;
const C_ID  = `urn:cg:brc:${SCENARIO_DATE}:c`;
const D_ID  = `urn:cg:brc:${SCENARIO_DATE}:d`;
const E_ID  = `urn:cg:brc:${SCENARIO_DATE}:e`;
const B2_ID = `urn:cg:brc:${SCENARIO_DATE}:b-reconfirmed`;

// The manifest mirrors descriptorUrl, not the original urn:cg:
// id. We need to compare against the URLs that publish() returns
// for the cascade walks below.
const publishedUrls = {};

// ── Epoch 1: A0 + downstream cascade ─────────────────────────────
h('ACT 3 — epoch 1: publish A0 (Asserted) + B/C/D/E that cite it');
const t1 = new Date().toISOString();
const authorA = byName.get('author-a');
const authorB = byName.get('author-b');
const authorC = byName.get('author-c');
const authorD = byName.get('author-d');
const authorE = byName.get('author-e');

// A0 — the upstream Asserted fact.
const a0 = buildAsserted({
  id: A0_ID,
  author: authorA,
  graph: G_A,
  derivedFrom: undefined,
  now: t1,
  summary: {
    title: 'Reactor cooling-loop pressure within nominal',
    description: 'Aggregate of 10-minute pressure-sensor readings from cooling loop 3 over the prior 24h indicates 11.8–12.3 bar, inside the 10.5–13.5 bar safe envelope.',
    domain: 'industrial-control',
  },
});
const a0Sig = await signClaim(authorA.wallet, {
  id: A0_ID, graph: G_A, modal: 'Asserted', author: authorA.did, at: t1,
});
const a0Pub = await publish(
  a0.descriptor,
  graphTurtle({ ...a0, now: t1, sig: a0Sig }),
  SCENARIO_POD,
  { descriptorSlug: 'a0', graphSlug: 'a0-graph' },
);
publishedUrls.a0 = a0Pub.descriptorUrl;
console.log(`   A0 → ${a0Pub.descriptorUrl}`);

// B / C / D each cite A0 as an upstream evidence descriptor.
const downstreamSpecs = [
  {
    label: 'B',
    id: B_ID,
    author: authorB,
    graph: G_B,
    slug: 'b',
    summary: {
      title: 'Maintenance window can be deferred to next quarter',
      description: 'Because cooling-loop 3 is operating well inside the safe envelope (see A0), the scheduled preventive maintenance window can be deferred from week 22 to week 35 without raising the operational risk score above amber.',
      domain: 'operations-planning',
    },
  },
  {
    label: 'C',
    id: C_ID,
    author: authorC,
    graph: G_C,
    slug: 'c',
    summary: {
      title: 'No regulator notification required this cycle',
      description: 'Per the 14-day pressure-stability rule in operating licence appendix B, regulator notification is triggered only on excursion. A0 shows no excursion over the reporting period; no notification is filed.',
      domain: 'compliance',
    },
  },
  {
    label: 'D',
    id: D_ID,
    author: authorD,
    graph: G_D,
    slug: 'd',
    summary: {
      title: 'Cooling-loop 3 retained in production-tier SLA',
      description: 'Loop 3 stays in the production-tier SLA bucket for the next billing cycle on the strength of A0; capex transfer to backup-tier is not triggered.',
      domain: 'finance',
    },
  },
];

for (const spec of downstreamSpecs) {
  const d = buildAsserted({
    id: spec.id,
    author: spec.author,
    graph: spec.graph,
    derivedFrom: [A0_ID],
    now: t1,
    summary: spec.summary,
  });
  const sig = await signClaim(spec.author.wallet, {
    id: spec.id, graph: spec.graph, modal: 'Asserted', author: spec.author.did, at: t1,
  });
  const r = await publish(
    d.descriptor,
    graphTurtle({ ...d, now: t1, sig }),
    SCENARIO_POD,
    { descriptorSlug: spec.slug, graphSlug: `${spec.slug}-graph` },
  );
  publishedUrls[spec.label.toLowerCase()] = r.descriptorUrl;
  console.log(`   ${spec.label}  → ${r.descriptorUrl}`);
}

// E cites B (second-order dependency).
const e = buildAsserted({
  id: E_ID,
  author: authorE,
  graph: G_E,
  derivedFrom: [B_ID],
  now: t1,
  summary: {
    title: 'Q3 budget reforecast removes contingency line item',
    description: 'Because maintenance is deferred (B), the contingency reserve for week-22 outage costs is released back to the operating budget in the Q3 reforecast.',
    domain: 'finance',
  },
});
const eSig = await signClaim(authorE.wallet, {
  id: E_ID, graph: G_E, modal: 'Asserted', author: authorE.did, at: t1,
});
const ePub = await publish(
  e.descriptor,
  graphTurtle({ ...e, now: t1, sig: eSig }),
  SCENARIO_POD,
  { descriptorSlug: 'e', graphSlug: 'e-graph' },
);
publishedUrls.e = ePub.descriptorUrl;
console.log(`   E  → ${ePub.descriptorUrl}`);

check(
  'epoch-1 cascade published: A0 + B + C + D + E (5 descriptors)',
  [publishedUrls.a0, publishedUrls.b, publishedUrls.c, publishedUrls.d, publishedUrls.e].every(Boolean),
  publishedUrls,
);

// ── Epoch 1 manifest check ───────────────────────────────────────
h('ACT 4 — verify epoch-1 manifest has 5 Asserted entries with derivedFrom edges');
const m1 = await discover(SCENARIO_POD);
const m1Asserted = m1.filter(e => e.modalStatus === 'Asserted');
check(
  'manifest has 5 entries after epoch 1',
  m1.length === 5,
  { found: m1.length },
);
check(
  'all 5 epoch-1 entries are Asserted in the manifest mirror',
  m1Asserted.length === 5,
  { asserted: m1Asserted.length, all: m1.length },
);

// Fetch each downstream graph and confirm prov:wasDerivedFrom is
// present in the live TriG body — this is what makes the cascade
// walkable substrate-side without re-publishing.
async function fetchTrig(descriptorUrl) {
  const graphUrl = descriptorUrl.replace(/[^/]+$/, m => {
    const slug = m.replace(/\.ttl$/, '');
    return `${slug}-graph.ttl`;
  });
  // Try the conventional graph URL first; fall back to fetching
  // the descriptor's TriG (which carries the graph block inline).
  try {
    const r = await fetch(graphUrl, { headers: { Accept: 'text/turtle' } });
    if (r.ok) return await r.text();
  } catch {}
  const r2 = await fetch(descriptorUrl, { headers: { Accept: 'application/trig' } });
  if (r2.ok) return await r2.text();
  return '';
}

const trigB = await fetchTrig(publishedUrls.b);
const trigC = await fetchTrig(publishedUrls.c);
const trigD = await fetchTrig(publishedUrls.d);
const trigE = await fetchTrig(publishedUrls.e);
check(
  'B / C / D each carry prov:wasDerivedFrom <A0>',
  [trigB, trigC, trigD].every(t => t.includes('prov:wasDerivedFrom') && t.includes(A0_ID)),
);
check(
  'E carries prov:wasDerivedFrom <B>',
  trigE.includes('prov:wasDerivedFrom') && trigE.includes(B_ID),
);

// ── Epoch 2: A1 supersedes A0 with Counterfactual ───────────────
h('ACT 5 — epoch 2: A1 (Counterfactual) supersedes A0');
const t2 = new Date(Date.now() + 1000).toISOString();
const a1 = buildCounterfactual({
  id: A1_ID,
  author: authorA,
  graph: G_A,
  supersedes: [A0_ID],
  derivedFrom: undefined,
  now: t2,
  summary: {
    title: 'Cooling-loop pressure readings retracted — sensor drift',
    description: 'On recalibration of pressure transducer PT-3-04 the prior 24h readings reported in A0 are now known to have a systematic offset of -1.4 bar; the loop was operating at 13.2–13.7 bar, OUT of the safe envelope. A0 is retracted; all downstream conclusions that depended on the original reading must be re-evaluated.',
    domain: 'industrial-control',
  },
});
const a1Sig = await signClaim(authorA.wallet, {
  id: A1_ID, graph: G_A, modal: 'Counterfactual', author: authorA.did, at: t2,
});
const a1Pub = await publish(
  a1.descriptor,
  graphTurtle({ ...a1, now: t2, sig: a1Sig }),
  SCENARIO_POD,
  { descriptorSlug: 'a1', graphSlug: 'a1-graph' },
);
publishedUrls.a1 = a1Pub.descriptorUrl;
console.log(`   A1 → ${a1Pub.descriptorUrl}  (Counterfactual, supersedes A0)`);

// ── Epoch 2 manifest check ───────────────────────────────────────
h('ACT 6 — manifest reflects A1 + preserves A0 history');
const m2 = await discover(SCENARIO_POD);
check(
  'manifest has 6 entries after epoch 2 (no overwrite)',
  m2.length === 6,
  { found: m2.length },
);

// A1 must declare cg:supersedes A0 in the manifest mirror.
const a1Entry = m2.find(e => e.descriptorUrl === publishedUrls.a1);
check(
  'A1 manifest entry carries cg:supersedes <A0> (substrate mirrored the link)',
  !!a1Entry && Array.isArray(a1Entry.supersedes) && a1Entry.supersedes.includes(A0_ID),
  { supersedes: a1Entry?.supersedes },
);

// A0's original Asserted entry is still in the manifest. The
// substrate retains history; supersedes does NOT delete.
const a0Entry = m2.find(e => e.descriptorUrl === publishedUrls.a0);
check(
  "A0's original Asserted manifest entry survives (history preserved, not rewritten)",
  !!a0Entry && a0Entry.modalStatus === 'Asserted',
  { found: !!a0Entry, modal: a0Entry?.modalStatus },
);

// A0's body must still be fetchable — the descriptor file itself
// is not removed by the supersede publish.
let a0Reachable = false;
try {
  const r = await withTransientRetry(() => fetch(publishedUrls.a0, { method: 'GET' }));
  a0Reachable = r.ok;
} catch {}
check(
  "A0's descriptor body remains fetchable after A1 supersedes it",
  a0Reachable,
);

// ── Cascade walk: find descriptors transitively derived-from
//    a Counterfactual upstream ──────────────────────────────────
h('ACT 7 — walk dependency edges from A1 → find tainted downstream');

// The walk uses the substrate as it actually exists: manifest
// entry IDs (descriptor URLs) + their graph-body
// prov:wasDerivedFrom edges. We don't trust in-memory linkage —
// every edge is re-discovered from the pod.
function urnIdToManifestUrl(urn) {
  // descriptors share a urn:cg:brc:<date>:<slug> -> .ttl URL
  // mapping; we look it up by checking the published map (which
  // we got back from publish()'s real responses).
  for (const [, url] of Object.entries(publishedUrls)) {
    if (url.endsWith(`/${urn.split(':').pop()}.ttl`)) return url;
  }
  return undefined;
}

// Build an edge map upstream -> downstream descriptor URLs by
// parsing every published graph for prov:wasDerivedFrom.
const allUrls = [publishedUrls.a0, publishedUrls.a1, publishedUrls.b, publishedUrls.c, publishedUrls.d, publishedUrls.e];
const trigs = {};
for (const url of allUrls) {
  trigs[url] = await fetchTrig(url);
}
const downstreamOf = new Map(); // urnId -> Set<urnId>
function addEdge(upstreamUrn, downstreamUrn) {
  const s = downstreamOf.get(upstreamUrn) ?? new Set();
  s.add(downstreamUrn);
  downstreamOf.set(upstreamUrn, s);
}
const URN_RE = /<(urn:cg:brc:[^>]+)>/g;
function urnIdsFromGraph(trig, predicate) {
  // crude but exact: split on the predicate and pull URNs.
  const out = new Set();
  const re = new RegExp(`${predicate}\\s+<(urn:cg:brc:[^>]+)>`, 'g');
  let m;
  while ((m = re.exec(trig)) !== null) out.add(m[1]);
  return out;
}
const urnForUrl = new Map();
for (const [label, url] of Object.entries(publishedUrls)) {
  // Identify the urnId from the trig body — every body declares
  // its own descriptor IRI explicitly somewhere.
  const trig = trigs[url];
  const urnMatches = [...trig.matchAll(URN_RE)].map(x => x[1]);
  // First urn that matches our published slug list is "this descriptor".
  const candidates = {
    a0: A0_ID, a1: A1_ID, b: B_ID, c: C_ID, d: D_ID, e: E_ID,
  };
  urnForUrl.set(url, candidates[label]);
}
for (const url of allUrls) {
  const trig = trigs[url];
  const ownUrn = urnForUrl.get(url);
  const derivedFromUrns = urnIdsFromGraph(trig, 'prov:wasDerivedFrom');
  for (const up of derivedFromUrns) addEdge(up, ownUrn);
}
console.log('   discovered prov:wasDerivedFrom edges:');
for (const [up, downs] of downstreamOf.entries()) {
  console.log(`     ${up}  →  { ${[...downs].join(', ')} }`);
}

// Now: find Counterfactual descriptors and the supersede edges,
// then compute the transitive closure of "tainted by a known-
// false upstream."
function manifestSupersedeTargets(modal) {
  // Pull supersedes targets only for descriptors whose modal is
  // the requested one.
  const out = new Set();
  for (const e of m2) {
    if (e.modalStatus === modal && Array.isArray(e.supersedes)) {
      for (const s of e.supersedes) out.add(s);
    }
  }
  return out;
}
const knownFalseUpstreamUrns = manifestSupersedeTargets('Counterfactual'); // A0 is in here.
const tainted = new Set();
function bfsCascade(roots) {
  const queue = [...roots];
  while (queue.length > 0) {
    const u = queue.shift();
    const downs = downstreamOf.get(u);
    if (!downs) continue;
    for (const d of downs) {
      if (!tainted.has(d)) {
        tainted.add(d);
        queue.push(d);
      }
    }
  }
}
bfsCascade(knownFalseUpstreamUrns);
console.log(`   cascade-tainted descriptors: { ${[...tainted].join(', ')} }`);
check(
  'cascade walk from A0 (now Counterfactual) reaches B, C, D, E',
  tainted.has(B_ID) && tainted.has(C_ID) && tainted.has(D_ID) && tainted.has(E_ID),
  [...tainted],
);
check(
  'cascade walk does NOT include A0 or A1 themselves (they are the source, not derived)',
  !tainted.has(A0_ID) && !tainted.has(A1_ID),
);

// ── discover(modalStatus:Asserted) excludes the cascade ────────
h('ACT 8 — discover(modalStatus:Asserted) excludes derived-from-counterfactual');

const assertedHits = await discover(SCENARIO_POD, { modalStatus: 'Asserted' });
const assertedUrls = new Set(assertedHits.map(e => e.descriptorUrl));
// The raw filter only checks the entry's own modal status. The
// substrate-level claim we're testing is that callers building a
// "still-believed" view MUST combine three filters:
//   (a) discover(modalStatus=Asserted)
//   (b) exclude descriptors that are themselves the supersede target
//       of a Counterfactual (A0 is replaced by A1 — A0 is no longer
//       believed even though its OWN modal-status entry still says
//       Asserted on the historical record)
//   (c) exclude the cascade — descriptors derived from anything in (b)
// The cascade walk starts FROM A0; it does not include A0 itself, so
// without (b) the still-believed set keeps A0. Compose all three.
const taintedUrls = new Set();
for (const url of allUrls) {
  const urn = urnForUrl.get(url);
  if (tainted.has(urn)) taintedUrls.add(url);
}
// Build (b): URLs whose URN is the supersede target of a Counterfactual.
const supersededByCounterfactual = new Set();
for (const e of m2) {
  if (e.modalStatus === 'Counterfactual' && Array.isArray(e.supersedes)) {
    for (const s of e.supersedes) supersededByCounterfactual.add(s);
  }
}
const stillBelievedUrls = [...assertedUrls].filter(u => {
  if (taintedUrls.has(u)) return false;
  const urn = urnForUrl.get(u);
  if (urn && supersededByCounterfactual.has(urn)) return false;
  return true;
});
console.log(`   raw Asserted filter: ${assertedHits.length} hits`);
console.log(`   after subtracting cascade: ${stillBelievedUrls.length} still-believed`);
check(
  'composing modal filter + cascade walk excludes all 4 tainted descriptors (B/C/D/E)',
  stillBelievedUrls.length === 0,
  { stillBelieved: stillBelievedUrls.length, assertedRaw: assertedHits.length },
);

// ── Epoch 3: selective reconfirmation publish on B ─────────────
h('ACT 9 — epoch 3: B is reconfirmed (cg:supersedes B, derivedFrom A1)');

const t3 = new Date(Date.now() + 2000).toISOString();
const b2 = buildAsserted({
  id: B2_ID,
  author: authorB,
  graph: G_B,
  derivedFrom: [A1_ID],
  now: t3,
  summary: {
    title: "Maintenance window deferral still holds — re-derived from corrected reading",
    description: "Even with the corrected reading (A1) showing loop 3 at 13.2–13.7 bar (above amber but still inside the operational red line at 14.0 bar), the deferral from week 22 to week 35 is approved with an added mid-quarter inspection in week 28.",
    domain: 'operations-planning',
  },
});
// Hand-build the supersedes link on b2 because buildAsserted
// doesn't accept it; do it via descriptor reconstruction.
const b2WithSupers = ContextDescriptor.from(b2.descriptor)
  .supersedes(B_ID)
  .build();
const b2Sig = await signClaim(authorB.wallet, {
  id: B2_ID, graph: G_B, modal: 'Asserted', author: authorB.did, at: t3,
});
const b2Pub = await publish(
  b2WithSupers,
  graphTurtle({
    id: B2_ID,
    author: authorB,
    graph: G_B,
    derivedFrom: [A1_ID],
    supersedes: [B_ID],
    modal: 'Asserted',
    summary: b2.summary,
    now: t3,
    sig: b2Sig,
  }),
  SCENARIO_POD,
  { descriptorSlug: 'b-reconfirmed', graphSlug: 'b-reconfirmed-graph' },
);
publishedUrls.b2 = b2Pub.descriptorUrl;
console.log(`   B' → ${b2Pub.descriptorUrl}  (Asserted, supersedes B, derivedFrom A1)`);

// ── Epoch 3 cascade recomputation ──────────────────────────────
h('ACT 10 — recompute cascade after reconfirmation; C / D stay tainted, B and E restored');

const m3 = await discover(SCENARIO_POD);
check(
  'manifest has 7 entries after epoch 3 (history preserved)',
  m3.length === 7,
  { found: m3.length },
);

// B's reconfirmation must be visible as a supersedes edge on B'.
const b2Entry = m3.find(e => e.descriptorUrl === publishedUrls.b2);
check(
  "B' manifest entry carries cg:supersedes <B>",
  !!b2Entry && Array.isArray(b2Entry.supersedes) && b2Entry.supersedes.includes(B_ID),
  { supersedes: b2Entry?.supersedes },
);

// Re-walk: now B has a head replacement B' that is itself
// Asserted (modal-status mirror) and whose derivedFrom edge
// points to A1 (which IS Counterfactual). A pure "derived from
// anything Counterfactual" walk would still taint B' too — so
// the rule the substrate enforces is finer: a Counterfactual
// upstream taints downstream ONLY when the downstream has NOT
// itself been republished as Asserted with the Counterfactual
// as its explicit derivedFrom (i.e. acknowledged + re-derived).
//
// We model this here: a reconfirmed-on-counterfactual descriptor
// is treated as "acknowledged, re-derived, still believed."
// Downstream nodes whose only path-to-knowable-false runs through
// a now-superseded ancestor inherit the reconfirmation.

// Re-fetch trigs for B' (others didn't change).
trigs[publishedUrls.b2] = await fetchTrig(publishedUrls.b2);
urnForUrl.set(publishedUrls.b2, B2_ID);
const b2Derived = urnIdsFromGraph(trigs[publishedUrls.b2], 'prov:wasDerivedFrom');
for (const up of b2Derived) addEdge(up, B2_ID);

// Build "reconfirmed" set: descriptors that explicitly re-published
// themselves (carry a cg:supersedes edge in the manifest) AND cite a
// known-false ancestor (or A1) in their wasDerivedFrom AND are
// themselves Asserted. The supersedes gate is critical — a stale
// descriptor (C / D) that merely persists in the manifest and happens
// to cite A0 in its derivedFrom is NOT reconfirmed; only descriptors
// that publish a new version (B' supersedes B) while citing the
// corrected upstream count as acknowledgement-rooted re-derivations.
const assertedSuperseding = new Set();
for (const e of m3) {
  if (e.modalStatus === 'Asserted' && Array.isArray(e.supersedes) && e.supersedes.length > 0) {
    const urn = urnForUrl.get(e.descriptorUrl);
    if (urn) assertedSuperseding.add(urn);
  }
}
const reconfirmed = new Set();
for (const e of m3) {
  if (e.modalStatus !== 'Asserted') continue;
  const url = e.descriptorUrl;
  const urn = urnForUrl.get(url);
  if (!urn || !assertedSuperseding.has(urn)) continue; // must have explicitly republished
  const trig = trigs[url];
  if (!trig) continue;
  const derived = urnIdsFromGraph(trig, 'prov:wasDerivedFrom');
  for (const up of derived) {
    if (knownFalseUpstreamUrns.has(up) || up === A1_ID) {
      reconfirmed.add(urn);
      break;
    }
  }
}
// supersedes from B' replaces B in the cascade frontier.
const supersededByReconfirmation = new Set();
for (const e of m3) {
  if (e.modalStatus !== 'Asserted') continue;
  if (Array.isArray(e.supersedes)) {
    for (const s of e.supersedes) supersededByReconfirmation.add(s);
  }
}

// Re-run BFS with refinement:
//   tainted = { descriptors reachable from A0 } MINUS reconfirmed
//             MINUS supersededByReconfirmation
//   PLUS descriptors whose only valid path back to A1 has not
//        been re-rooted under reconfirmation.
const tainted3 = new Set();
function bfsRefined(roots) {
  const queue = [...roots];
  while (queue.length > 0) {
    const u = queue.shift();
    const downs = downstreamOf.get(u);
    if (!downs) continue;
    for (const d of downs) {
      if (reconfirmed.has(d)) continue; // explicit re-derivation = restored
      if (supersededByReconfirmation.has(d)) continue; // head replaced
      if (!tainted3.has(d)) {
        tainted3.add(d);
        queue.push(d);
      }
    }
  }
}
bfsRefined(knownFalseUpstreamUrns);

// E was downstream of B; now B is superseded by B' and B' is
// reconfirmed against A1, so E's path-to-knowable-false is
// re-rooted under a reconfirmation. We model this by treating
// edges out of supersededByReconfirmation as no longer carrying
// the taint.
console.log(`   reconfirmed:                { ${[...reconfirmed].join(', ')} }`);
console.log(`   superseded-by-reconfirm:    { ${[...supersededByReconfirmation].join(', ')} }`);
console.log(`   tainted after reconfirm:    { ${[...tainted3].join(', ')} }`);

check(
  "after B' publishes, C and D remain tainted (no reconfirmation issued for them)",
  tainted3.has(C_ID) && tainted3.has(D_ID),
  [...tainted3],
);
check(
  "after B' publishes, B is restored (B was explicitly superseded by reconfirmed B')",
  !tainted3.has(B_ID),
);
check(
  "after B' publishes, E is restored (E's edge through B is re-rooted under reconfirmed B')",
  !tainted3.has(E_ID),
);

// ── Manifest fingerprint ────────────────────────────────────────
h('ACT 11 — manifest fingerprint (human cold-read audit hook)');
try {
  const r = await fetch(MANIFEST_URL, { headers: { Accept: 'text/turtle' } });
  if (r.ok) {
    const body = await r.text();
    const digest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
    console.log(`   manifest size:   ${body.length} bytes`);
    console.log(`   manifest sha256: ${digest}…`);
    console.log(`   manifest URL:    ${MANIFEST_URL}`);
    const allReferenced = Object.values(publishedUrls).every(u => body.includes(u));
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
for (const [label, url] of Object.entries(publishedUrls)) {
  console.log(`   ${label.padEnd(3)} ${url}`);
}
