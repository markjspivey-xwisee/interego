// Shared helpers for examples/*.mjs.
//
// Extracted to eliminate ~150 lines of copy-paste across 22+ demo
// scripts. Every helper here is dogfood-compatible: callers should
// prefer these over re-implementing fetch/parse/publish logic
// inline.
//
// Intentionally zero-dep — uses only globals (fetch, AbortController)
// and no Node-specific imports beyond what's already in Node 20.

// Default to the maintainer's deployed pods so demos are runnable
// out of the box. Override with environment variables when running
// against your own pod:
//
//   CG_DEMO_POD=https://your-pod.example/me/ \
//   CG_DEMO_POD_B=https://your-pod.example/colleague/ \
//   node examples/<demo>.mjs
//
// CG_DEMO_POD_BASE swaps the host root if you keep the same usernames.
const DEFAULT_HOST = process.env.CG_DEMO_POD_BASE
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
export const POD = process.env.CG_DEMO_POD ?? `${DEFAULT_HOST}/markj/`;
export const POD_B = process.env.CG_DEMO_POD_B ?? `${DEFAULT_HOST}/u-pk-0a7f04106a54/`;
export const MANIFEST_URL = `${POD}.well-known/context-graphs`;

// ── HTTP ────────────────────────────────────────────────────

export async function fetchText(url, timeoutMs = 6000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { Accept: 'text/turtle' },
      signal: ac.signal,
    });
    return r.ok ? await r.text() : null;
  } catch { return null; } finally { clearTimeout(to); }
}

export async function putText(url, body) {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body,
  });
  return r.ok;
}

/**
 * Parallel fetch with a bounded concurrency pool. Essential for
 * walking large manifests without saturating the pod's lock pool
 * (see CSS lock-exhaustion incident earlier in the session).
 */
export async function fetchPool(urls, poolSize = 12, timeoutMs = 5000) {
  const out = new Array(urls.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      out[i] = await fetchText(urls[i], timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: poolSize }, worker));
  return out;
}

// ── Manifest parsing ────────────────────────────────────────

export function parseManifestEntries(ttl) {
  const entries = [];
  let cur = null;
  for (const raw of ttl.split('\n')) {
    const line = raw.trim();
    const s = line.match(/^<([^>]+)>\s+a\s+cg:ManifestEntry/);
    if (s) { cur = { descriptorUrl: s[1], describes: [], conformsTo: [] }; continue; }
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

export function parseDescriptor(ttl) {
  return {
    issuer: ttl.match(/cg:TrustFacet[\s\S]*?cg:issuer\s+<([^>]+)>/)?.[1] ?? null,
    modal: ttl.match(/cg:modalStatus\s+cg:(\w+)/)?.[1] ?? null,
    confidence: parseFloat(ttl.match(/cg:epistemicConfidence\s+"([\d.]+)"/)?.[1] ?? 'NaN'),
    conformsTo: [...ttl.matchAll(/dct:conformsTo\s+<([^>]+)>/g)].map(m => m[1]),
    wasDerivedFrom: [...ttl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)].map(m => m[1]),
    supersedes: [...ttl.matchAll(/cg:supersedes\s+<([^>]+)>/g)].map(m => m[1]),
    describes: ttl.match(/cg:describes\s+<([^>]+)>/)?.[1] ?? null,
    validFrom: ttl.match(/cg:validFrom\s+"([^"]+)"/)?.[1] ?? null,
    rawTtl: ttl,
  };
}

// ── Mini-SHACL shape parser + validator ────────────────────

export function parseShape(ttl) {
  const shape = { properties: [] };
  const re = /sh:property\s+\[([\s\S]*?)\]\s*(?:[;.])/g;
  let m;
  while ((m = re.exec(ttl)) !== null) {
    const body = m[1];
    const c = {};
    let pm;
    if ((pm = body.match(/sh:path\s+(\S+?)\s*[;\n]/))) c.path = pm[1];
    if ((pm = body.match(/sh:in\s+\(([^)]*)\)/))) c.inValues = pm[1].trim().split(/\s+/);
    if ((pm = body.match(/sh:hasValue\s+<([^>]+)>/))) c.hasValue = pm[1];
    if ((pm = body.match(/sh:minInclusive\s+([\d.]+)/))) c.minInclusive = parseFloat(pm[1]);
    if ((pm = body.match(/sh:maxInclusive\s+([\d.]+)/))) c.maxInclusive = parseFloat(pm[1]);
    if ((pm = body.match(/sh:minCount\s+(\d+)/))) c.minCount = parseInt(pm[1], 10);
    if ((pm = body.match(/sh:message\s+"([^"]+)"/))) c.message = pm[1];
    shape.properties.push(c);
  }
  return shape;
}

export function validateAgainstShape(d, shape) {
  const violations = [];
  for (const c of shape.properties) {
    if (!c.path) continue;
    const value =
      c.path === 'cg:modalStatus' ? d.modal :
      c.path === 'cg:epistemicConfidence' ? d.confidence :
      c.path === 'dct:conformsTo' ? d.conformsTo :
      c.path === 'prov:wasDerivedFrom' ? d.wasDerivedFrom :
      c.path === 'cg:validFrom' ? d.validFrom :
      undefined;
    const values = Array.isArray(value) ? value : value == null || Number.isNaN(value) ? [] : [value];
    if (c.minCount > 0 && values.length === 0) {
      violations.push(c.message ?? `minCount ${c.minCount} not satisfied at ${c.path}`);
      continue;
    }
    if (c.inValues) {
      const want = c.inValues.map(x => x.replace(/^cg:/, ''));
      for (const v of values) if (!want.includes(String(v).replace(/^cg:/, ''))) {
        violations.push(c.message ?? `value '${v}' not in allowed set at ${c.path}`);
      }
    }
    if (c.hasValue) {
      if (!values.includes(c.hasValue)) {
        violations.push(c.message ?? `required value ${c.hasValue} missing at ${c.path}`);
      }
    }
    if (c.minInclusive != null) for (const v of values) {
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (Number.isFinite(n) && n < c.minInclusive) {
        violations.push(c.message ?? `${n} < minInclusive ${c.minInclusive} at ${c.path}`);
      }
    }
    if (c.maxInclusive != null) for (const v of values) {
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (Number.isFinite(n) && n > c.maxInclusive) {
        violations.push(c.message ?? `${n} > maxInclusive ${c.maxInclusive} at ${c.path}`);
      }
    }
  }
  return violations;
}

// ── Descriptor authoring (dogfoods the library builder) ───

/**
 * Produce a descriptor Turtle using `@interego/core`'s builder and
 * serializer — the canonical authoring path. Most demos use this
 * via the higher-level `publishDescriptor` below.
 *
 * For demos that can't use the builder (e.g. multi-affordance
 * descriptors where the additional cg:affordance blocks are
 * per-descriptor), authors can call `toTurtle(descriptor)` manually
 * and append their extra triples.
 */
export async function buildDescriptorTurtle({
  id, graphIri, issuer, modal = 'Asserted', confidence = 0.85,
  conformsTo, supersedes = [], wasDerivedFrom = [],
}) {
  const { ContextDescriptor, toTurtle } = await import('../dist/index.js');
  const now = new Date().toISOString();

  const builder = ContextDescriptor.create(id)
    .describes(graphIri)
    .temporal({ validFrom: now })
    .validFrom(now)
    .delegatedBy(issuer, issuer, {
      endedAt: now,
      derivedFrom: wasDerivedFrom.length > 0 ? wasDerivedFrom : undefined,
    })
    .semiotic({
      modalStatus: modal,
      epistemicConfidence: confidence,
      ...(modal === 'Asserted' ? { groundTruth: true } :
          modal === 'Counterfactual' ? { groundTruth: false } :
          {}),
    })
    .trust({ trustLevel: 'SelfAsserted', issuer })
    .federation({
      origin: POD,
      storageEndpoint: POD,
      syncProtocol: 'SolidNotifications',
    })
    .version(1);

  if (supersedes.length > 0) builder.supersedes(...supersedes);
  if (conformsTo) builder.conformsTo(conformsTo);

  return toTurtle(builder.build());
}

/**
 * PUT a descriptor Turtle to the pod and append a manifest entry.
 * Uses the library builder when ttl is generated via
 * buildDescriptorTurtle; caller can also pass raw ttl for demos
 * that need multi-affordance / custom predicates.
 */
export async function publishDescriptorTurtle(descUrl, graphIri, ttl, extraManifestPredicates = '') {
  await putText(descUrl, ttl);
  const entry = `

<${descUrl}> a cg:ManifestEntry ;
    cg:describes <${graphIri}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
${extraManifestPredicates ? `    ${extraManifestPredicates}\n` : ''}    cg:modalStatus cg:Asserted ; cg:trustLevel cg:SelfAsserted .
`;
  const cur = await fetchText(MANIFEST_URL);
  await putText(MANIFEST_URL, (cur ?? '') + entry);
  return descUrl;
}
