// Semantic-alignment auditor v2 — implements the three remaining
// fixes the v1 explicitly omitted:
//
//   1. Fetch + validate SHACL shapes when conformsTo resolves.
//      Mini-SHACL engine covering: sh:in, sh:hasValue, sh:minInclusive,
//      sh:maxInclusive, sh:minCount. Enough for descriptor-level
//      constraints; full SHACL needs an actual parser dep.
//   2. Per-issuer track record (pragmatic-behavior-over-time):
//      reversal count, average confidence, modal distribution, how
//      often their claims get superseded by others.
//   3. Cross-issuer independence signal: now measurable because
//      the companion publish-shape-and-claims.mjs PUTs descriptors
//      with distinct Trust.issuer values.

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;

// ── HTTP ────────────────────────────────────────────────────

async function fetchText(url, timeoutMs = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle' }, signal: ac.signal });
    return r.ok ? await r.text() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

// ── Manifest / descriptor parsing ───────────────────────────

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

function parseDescriptor(ttl) {
  const issuerM = ttl.match(/cg:TrustFacet[\s\S]*?cg:issuer\s+<([^>]+)>/);
  const modalM = ttl.match(/cg:modalStatus\s+cg:(\w+)/);
  const confM = ttl.match(/cg:epistemicConfidence\s+"([\d.]+)"/);
  const conformsToMatches = [...ttl.matchAll(/dct:conformsTo\s+<([^>]+)>/g)];
  const derivedFromMatches = [...ttl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)];
  const supersedesMatches = [...ttl.matchAll(/cg:supersedes\s+<([^>]+)>/g)];
  const describesM = ttl.match(/cg:describes\s+<([^>]+)>/);
  const validFromM = ttl.match(/cg:validFrom\s+"([^"]+)"/);
  return {
    issuer: issuerM?.[1] ?? null,
    modal: modalM?.[1] ?? null,
    confidence: confM ? parseFloat(confM[1]) : null,
    conformsTo: conformsToMatches.map(m => m[1]),
    wasDerivedFrom: derivedFromMatches.map(m => m[1]),
    supersedes: supersedesMatches.map(m => m[1]),
    describes: describesM?.[1] ?? null,
    validFrom: validFromM?.[1] ?? null,
    rawTtl: ttl,
  };
}

// ── Mini-SHACL parser + validator ───────────────────────────
//
// Shape format (the one produced by publish-shape-and-claims.mjs):
//   <iri> a sh:NodeShape ;
//     sh:targetClass cg:ContextDescriptor ;
//     sh:property [
//       sh:path cg:modalStatus ;
//       sh:in ( cg:Asserted ) ;
//       sh:message "..."
//     ] ;
//     sh:property [
//       sh:path cg:epistemicConfidence ;
//       sh:minInclusive 0.8 ;
//     ] ...
//
// Supports: sh:in (enumeration), sh:hasValue, sh:minInclusive,
// sh:maxInclusive, sh:minCount. NOT a full SHACL engine.

function parseShape(ttl) {
  const shape = { targetClass: null, properties: [] };
  const targetM = ttl.match(/sh:targetClass\s+(\S+?)\s*[;.]/);
  if (targetM) shape.targetClass = targetM[1];

  // Each `sh:property [ ... ]` block. We split on the opening
  // bracket and extract the inner body until its matching ].
  const propRe = /sh:property\s+\[([\s\S]*?)\]\s*(?:[;.])/g;
  let m;
  while ((m = propRe.exec(ttl)) !== null) {
    const body = m[1];
    const constraint = {};
    let pm;
    if ((pm = body.match(/sh:path\s+(\S+?)\s*[;\n]/))) constraint.path = pm[1];
    if ((pm = body.match(/sh:in\s+\(([^)]*)\)/))) constraint.inValues = pm[1].trim().split(/\s+/);
    if ((pm = body.match(/sh:hasValue\s+<([^>]+)>/))) constraint.hasValue = pm[1];
    if ((pm = body.match(/sh:minInclusive\s+([\d.]+)/))) constraint.minInclusive = parseFloat(pm[1]);
    if ((pm = body.match(/sh:maxInclusive\s+([\d.]+)/))) constraint.maxInclusive = parseFloat(pm[1]);
    if ((pm = body.match(/sh:minCount\s+(\d+)/))) constraint.minCount = parseInt(pm[1], 10);
    if ((pm = body.match(/sh:message\s+"([^"]+)"/))) constraint.message = pm[1];
    shape.properties.push(constraint);
  }
  return shape;
}

function validateAgainstShape(descriptor, shape) {
  const violations = [];
  for (const c of shape.properties) {
    if (!c.path) continue;
    // Map sh:path IRI to what the descriptor carries in our extraction.
    const value = valueAtPath(descriptor, c.path);

    if (c.minCount && c.minCount > 0 && (value == null || (Array.isArray(value) && value.length === 0))) {
      violations.push(c.message ?? `minCount ${c.minCount} not satisfied at ${c.path}`);
      continue;
    }

    const values = Array.isArray(value) ? value : value == null ? [] : [value];

    if (c.inValues) {
      for (const v of values) {
        // values in `sh:in` come as prefixed terms like `cg:Asserted`;
        // descriptor stores modal as bare `Asserted`. Normalize both.
        const want = c.inValues.map(x => x.replace(/^cg:/, ''));
        if (!want.includes(String(v).replace(/^cg:/, ''))) {
          violations.push(c.message ?? `value '${v}' not in allowed set at ${c.path}`);
        }
      }
    }

    if (c.hasValue) {
      if (!values.includes(c.hasValue)) {
        violations.push(c.message ?? `required value ${c.hasValue} missing at ${c.path}`);
      }
    }

    if (c.minInclusive != null) {
      for (const v of values) {
        const n = typeof v === 'number' ? v : parseFloat(v);
        if (Number.isFinite(n) && n < c.minInclusive) {
          violations.push(c.message ?? `value ${n} < minInclusive ${c.minInclusive} at ${c.path}`);
        }
      }
    }

    if (c.maxInclusive != null) {
      for (const v of values) {
        const n = typeof v === 'number' ? v : parseFloat(v);
        if (Number.isFinite(n) && n > c.maxInclusive) {
          violations.push(c.message ?? `value ${n} > maxInclusive ${c.maxInclusive} at ${c.path}`);
        }
      }
    }
  }
  return violations;
}

// Map SHACL paths onto what our descriptor parse produces.
function valueAtPath(descriptor, path) {
  switch (path) {
    case 'cg:modalStatus': return descriptor.modal;
    case 'cg:epistemicConfidence': return descriptor.confidence;
    case 'dct:conformsTo': return descriptor.conformsTo;
    case 'cg:validFrom': return descriptor.validFrom;
    default: return undefined;
  }
}

// ── Per-issuer pragmatic-behavior track record ─────────────

function perIssuerTrackRecord(allDescriptors) {
  const record = new Map(); // issuer → stats
  for (const d of allDescriptors) {
    if (!d.issuer) continue;
    if (!record.has(d.issuer)) {
      record.set(d.issuer, {
        claimCount: 0,
        modalCounts: {},
        confidences: [],
        conformsToSet: new Set(),
        supersededSelf: 0,
        supersededByOthers: 0,
      });
    }
    const r = record.get(d.issuer);
    r.claimCount++;
    r.modalCounts[d.modal] = (r.modalCounts[d.modal] ?? 0) + 1;
    if (d.confidence != null) r.confidences.push(d.confidence);
    for (const s of d.conformsTo) r.conformsToSet.add(s);
  }

  // Track which descriptors supersede which. A self-supersession is a
  // pragmatic-reversal signal; being-superseded-by-others measures
  // calibration-of-peers.
  const byId = new Map();
  for (const d of allDescriptors) {
    if (d.describes) byId.set(d.describes, d);
    // also index by the descriptor's own id if available; the id comes
    // from the urn: pattern inside the describes or a direct cite.
  }
  for (const d of allDescriptors) {
    if (!d.issuer) continue;
    for (const sup of d.supersedes) {
      // Find the descriptor-of-same-graph whose IRI matches the supersedes target.
      const target = allDescriptors.find(x => x.rawTtl && x.rawTtl.includes(`<${sup}>`) && x.describes === d.describes);
      if (target && target.issuer === d.issuer) {
        record.get(d.issuer).supersededSelf++;
      } else if (target && target.issuer && target.issuer !== d.issuer) {
        const tr = record.get(target.issuer);
        if (tr) tr.supersededByOthers++;
      }
    }
  }
  return record;
}

// ── Main ────────────────────────────────────────────────────

const TARGET_GRAPHS = [
  'urn:graph:shared:cross-issuer-test:semantic-probe',
  'urn:graph:shared:sem-probe:fix-handles-session-encodings',
  'urn:graph:shared:sem-probe:fix-obviates-parser-through-2027',
];

const manifestTtl = await fetchText(MANIFEST_URL);
if (!manifestTtl) { console.error('Cannot fetch manifest'); process.exit(1); }

const entries = parseManifestEntries(manifestTtl);

// Fetch all descriptors for all target graphs.
const allDescriptors = [];
const perGraph = {};
for (const graphIri of TARGET_GRAPHS) {
  const matching = entries.filter(e => e.describes.includes(graphIri));
  const descs = [];
  for (const e of matching) {
    const ttl = await fetchText(e.descriptorUrl, 8000);
    if (!ttl) continue;
    const parsed = { ...e, ...parseDescriptor(ttl) };
    descs.push(parsed);
    allDescriptors.push(parsed);
  }
  perGraph[graphIri] = descs;
}

// ── Report ──────────────────────────────────────────────────

console.log('=== Semantic-alignment audit v2 ===\n');

// Per-graph audit with shape enforcement.
const shapeCache = new Map();
for (const graphIri of TARGET_GRAPHS) {
  const descs = perGraph[graphIri];
  if (!descs.length) continue;
  console.log(`── ${graphIri}`);
  console.log(`   Descriptors: ${descs.length}`);

  const issuers = new Set(descs.map(d => d.issuer).filter(Boolean));
  const modals = new Set(descs.map(d => d.modal).filter(Boolean));
  console.log(`   Unique issuers: ${issuers.size} ${issuers.size === 1 ? '(⚠ fake-independence risk)' : '(✓ independent)'}`);
  console.log(`   Modal variants: ${modals.size} (${[...modals].join(', ')})`);

  // Per-descriptor SHACL validation.
  for (const d of descs) {
    if (d.conformsTo.length === 0) continue;
    for (const schemaIri of d.conformsTo) {
      if (!shapeCache.has(schemaIri)) {
        const shapeTtl = await fetchText(schemaIri, 5000);
        if (shapeTtl) {
          shapeCache.set(schemaIri, { shape: parseShape(shapeTtl), resolved: true });
        } else {
          shapeCache.set(schemaIri, { shape: null, resolved: false });
        }
      }
      const cached = shapeCache.get(schemaIri);
      if (!cached.resolved) continue; // schemaIri not dereferenceable
      const violations = validateAgainstShape(d, cached.shape);
      const idShort = (d.issuer ?? 'unknown').split(':').pop();
      if (violations.length > 0) {
        console.log(`   ✗ ${idShort} violates shape ${schemaIri.split('/').pop()}:`);
        for (const v of violations) console.log(`       - ${v}`);
      } else {
        console.log(`   ✓ ${idShort} conforms to shape ${schemaIri.split('/').pop()}`);
      }
    }
  }
  console.log('');
}

// Schema resolvability summary.
console.log('── Schema resolution summary:');
for (const [iri, { resolved }] of shapeCache.entries()) {
  console.log(`   ${resolved ? '✓' : '⚠'} ${iri} → ${resolved ? 'dereferenced + shape parsed' : 'not dereferenceable (nominal alignment only)'}`);
}
console.log('');

// Per-issuer track record.
console.log('── Per-issuer pragmatic-behavior track record:');
const tr = perIssuerTrackRecord(allDescriptors);
for (const [issuer, r] of tr.entries()) {
  const avgConf = r.confidences.length > 0
    ? (r.confidences.reduce((a, b) => a + b, 0) / r.confidences.length).toFixed(3)
    : 'n/a';
  const modalStr = Object.entries(r.modalCounts).map(([k, v]) => `${k}×${v}`).join(' ');
  console.log(`   ${issuer}`);
  console.log(`     claims=${r.claimCount}  avgConf=${avgConf}  modals=${modalStr}`);
  console.log(`     distinctSchemas=${r.conformsToSet.size}  selfReversals=${r.supersededSelf}  supersededByOthers=${r.supersededByOthers}`);
}
console.log('');

console.log('── Reading these signals:');
console.log('   • Issuers with claimCount=1 have no track record — reputation is untestable.');
console.log('   • High selfReversals = agent frequently revises themselves (not bad,');
console.log('     but a pragmatic-calibration signal: they learn from new evidence).');
console.log('   • High supersededByOthers = peer agents consistently disagree →');
console.log('     flagship-calibration issue that the issuer\'s stated confidences');
console.log('     do not predict. Raw disagreement ≠ wrong; pattern matters.');
console.log('   • distinctSchemas > 1 = the issuer works across multiple interpretive');
console.log('     lenses; if stable behavior across lenses, they are schema-agnostic.');
