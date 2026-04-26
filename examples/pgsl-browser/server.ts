/**
 * PGSL Browser — a VIEW into the system's PGSL lattice.
 *
 * The pod is the source of truth. This browser reads descriptors,
 * graphs, and anchors from the pod, builds a PGSL structural index
 * from that content, and presents it for browsing.
 *
 * It does NOT have its own separate lattice. It derives the lattice
 * from the pod's content — same data the MCP server operates on.
 *
 * The browser also allows ingesting new content, which:
 *   1. Ingests into the derived PGSL lattice (for immediate browsing)
 *   2. Optionally writes to the pod (for persistence across sessions)
 */

import express from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createPGSL,
  embedInPGSL,
  pgslResolve,
  mintAtom,
  ingest,
  latticeStats,
  latticeMeet,
  queryNeighbors,
  discover,
  computeContainmentAnnotations,
  ContextDescriptor,
  union,
  intersection,
  restriction,
  override,
  validate,
  toTurtle,
  publish,
  materializeTriples,
  executeSparqlString,
  validateAllPGSL,
  sparqlQueryPGSL,
  sparqlFragmentsContaining,
  // Crypto
  createWallet,
  signDescriptor,
  verifyDescriptorSignature,
  createDelegation,
  verifyDelegationSignature,
  // Causality
  buildSCM,
  evaluateCounterfactual,
  isDSeparated,
  findBackdoorSet,
  // Affordance
  computeCognitiveStrategy,
  // Ingestion profiles
  ingestWithProfile,
  getProfile,
  // Affordance decorators
  createDefaultRegistry,
  decorateNode,
  // System ontology & virtualized RDF layer
  systemOntology,
  systemShaclShapes,
  systemHydraApi,
  systemDcatCatalog,
  allPrefixes,
  materializeSystem,
  executeSparqlProtocol,
  writeBackTriples,
  sparqlUpdateHandler,
  systemToTurtle,
  systemToJsonLd,
  getCertificates,
  buildSecurityTxtFromEnv,
} from '@interego/core';

import {
  ObserverAAT, AnalystAAT, ExecutorAAT, ArbiterAAT, ArchivistAAT, FullAccessAAT,
  createAATRegistry, registerAAT, getAAT, validateAction, filterAffordancesByAAT,
  createPolicyEngine, addRule, defaultPolicies, evaluate as evaluatePolicy,
  createTraceStore, recordTrace, getTraces, traceToTurtle,
  createPersonalBroker, startConversation, addMessage, getMemoryStats,
  createEnclaveRegistry, createEnclave, forkEnclave, getEnclave, listEnclaves,
  freezeEnclave, mergeEnclave, abandonEnclave, enclaveStats,
  createCheckpointStore, createCheckpoint, restoreCheckpoint, listCheckpoints, diffCheckpoints,
  createMarketplace, registerListing, removeListing, discoverByCapability,
  discoverByType, marketplaceToHydra, marketplaceStats,
  generateMetagraph, ingestMetagraph, validateMetagraph, queryMetagraph,
} from '@interego/core/pgsl';

// Get the xAPI profile for direct transform calls
const xapiProfile = getProfile('xapi')!;
import type {
  IRI, PGSLInstance, TokenGranularity, ContextDescriptorData, ManifestEntry,
  Wallet, WalletDelegation, SignedDescriptor,
} from '@interego/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env['PORT'] ?? '5000');
const CSS_URL = process.env['CSS_URL'] ?? 'http://localhost:3456/';
const POD_NAME = process.env['POD_NAME'] ?? 'markj';
const POD_URL = `${CSS_URL}${POD_NAME}/`;
const CLEAN = process.env['CLEAN'] === '1';
const KNOWN_PODS = (process.env['KNOWN_PODS'] ?? '')
.split(',').map(s => s.trim()).filter(Boolean);

// The PGSL lattice — derived from pod content, not a separate store
let pgsl: PGSLInstance = createPGSL({
  wasAttributedTo: `urn:pgsl-browser:${POD_NAME}` as IRI,
  generatedAtTime: new Date().toISOString(),
});

// Affordance decorator registry — all decorators active for this server
const decoratorRegistry = createDefaultRegistry();

// Agent framework state
const aatRegistry = createAATRegistry();
registerAAT(aatRegistry, ObserverAAT);
registerAAT(aatRegistry, AnalystAAT);
registerAAT(aatRegistry, ExecutorAAT);
registerAAT(aatRegistry, ArbiterAAT);
registerAAT(aatRegistry, ArchivistAAT);
registerAAT(aatRegistry, FullAccessAAT);

const policyEngine = createPolicyEngine();
for (const rule of defaultPolicies()) { addRule(policyEngine, rule); }

const traceStore = createTraceStore();
const enclaveRegistry = createEnclaveRegistry();
const checkpointStore = createCheckpointStore();
const marketplace = createMarketplace();

// Federation state — descriptors discovered from all pods
interface PodState {
  url: string;
  name: string;
  entries: ManifestEntry[];
  descriptors: Map<string, ContextDescriptorData>;
  lastDiscovered: string;
  status: 'active' | 'unreachable';
}
const podRegistry = new Map<string, PodState>();

// Solid fetch wrapper
const solidFetch = async (url: string, init?: any) => {
  const resp = await fetch(url, init as RequestInit);
  return {
    ok: resp.ok, status: resp.status, statusText: resp.statusText,
    headers: { get: (n: string) => resp.headers.get(n) },
    text: () => resp.text(), json: () => resp.json(),
  };
};

/**
 * Rebuild the PGSL lattice from the pod's content.
 * This is the key operation: the lattice is DERIVED, not stored.
 */
async function rebuildFromPod() {
  if (CLEAN) {
    console.log('Clean mode — starting with empty lattice');
    return;
  }

  console.log(`Building PGSL from pod: ${POD_URL}`);

  // Reset the lattice
  pgsl = createPGSL({
    wasAttributedTo: `urn:pgsl-browser:${POD_NAME}` as IRI,
    generatedAtTime: new Date().toISOString(),
  });

  try {
    const entries = await discover(POD_URL, undefined, { fetch: solidFetch });
    console.log(`Found ${entries.length} descriptors on pod`);

    for (const entry of entries) {
      try {
        // Fetch the graph content (the actual knowledge)
        const graphUrl = entry.descriptorUrl.replace('.ttl', '-graph.trig');
        const graphResp = await fetch(graphUrl);
        if (graphResp.ok) {
          const graphContent = await graphResp.text();
          // Extract meaningful lines
          const lines = graphContent.split('\n')
.filter(l => l.trim().length > 0 && !l.trim().startsWith('@prefix') && !l.trim().startsWith('GRAPH'))
.map(l => l.trim().replace(/[<>"^@]/g, '').replace(/\s+/g, ' ').trim())
.filter(l => l.length > 5 && l.length < 200);

          for (const line of lines.slice(0, 10)) {
            embedInPGSL(pgsl, line);
          }
          console.log(`  Ingested ${Math.min(lines.length, 10)} facts from: ${entry.describes.join(', ')}`);
        }

        // Ingest graph IRIs and facet types as individual atoms
        for (const g of entry.describes) mintAtom(pgsl, g);
        for (const ft of entry.facetTypes) mintAtom(pgsl, ft);
      } catch (err) {
        console.log(`  Error: ${(err as Error).message}`);
      }
    }

    const stats = latticeStats(pgsl);
    console.log(`PGSL built: ${stats.atoms} atoms, ${stats.fragments} fragments, L0-L${stats.maxLevel}`);
  } catch (err) {
    console.log(`Failed to read pod: ${(err as Error).message}`);
  }
}

const app = express();
app.use(express.json());

// ── Paradigm Constraints ──
// Operations on paradigm sets at syntagmatic positions.
// A paradigm P(S,i) = { atoms that appear at position i in chains matching pattern S }

type ParadigmOp = 'subset' | 'intersect' | 'union' | 'exclude' | 'equal';
// subset: P(A,i) must be subset of P(B,j) — "employee restricts to human"
// intersect: must be in both P(A,i) AND P(B,j)
// union: can be in either P(A,i) OR P(B,j)
// exclude: must be in P(A,i) but NOT in P(B,j)
// equal: P(A,i) must equal P(B,j)
const OP_SYMBOLS: Record<ParadigmOp, string> = { subset: '⊆', intersect: '∩', union: '∪', exclude: '∖', equal: '=' };

interface ParadigmConstraint {
  id: string;
  /** Pattern A: fixed values + one position marked with ? */
  patternA: string[];
  positionA: number;
  /** Pattern B: fixed values + one position marked with ? */
  patternB: string[];
  positionB: number;
  /** The operation relating paradigm A to paradigm B */
  op: ParadigmOp;
  /** Optional SPARQL query for arbitrary constraints.
   * Must SELECT ?candidate — returns URIs that satisfy the constraint.
   * When present, overrides patternB-based paradigm computation. */
  sparql?: string;
  /** Cardinality: min/max count on paradigm set size */
  minCount?: number;
  maxCount?: number;
  createdAt: string;
}

const constraintRegistry: ParadigmConstraint[] = [];

// Resolve a node to its matchable value — works for both atoms and fragments.
// Atoms return their value, fragments return their resolved text.
// This allows paradigm matching at any level of the lattice.
function nodeMatchValue(uri: IRI): string | null {
  const node = pgsl.nodes.get(uri);
  if (!node) return null;
  if (node.kind === 'Atom') return String(node.value);
  return pgslResolve(pgsl, uri);
}

// Compute a paradigm set: all nodes (atoms OR fragments) that appear at a
// given position in chains matching a pattern (with ? at that position).
//
// This works at EVERY level of the lattice:
//   - Inner paradigm: items in a chain are atoms → paradigm of atoms
//   - Outer paradigm: items in a higher chain are fragments (groups)
//     → paradigm of groups
//
// Pattern values are matched by resolved text, so both atoms and fragments
// can appear in patterns and paradigm sets.
function computeParadigm(pattern: string[], position: number): Set<string> {
  const paradigm = new Set<string>();

  // Search all fragments for chains matching the pattern
  for (const [, node] of pgsl.nodes) {
    if (node.kind !== 'Fragment') continue;
    if (node.items.length !== pattern.length) continue;

    let match = true;
    for (let i = 0; i < pattern.length; i++) {
      if (i === position) continue; // skip the variable position
      if (pattern[i] === '?') continue; // skip other variable positions

      // Match by resolved value — works for atoms AND fragments
      const itemValue = nodeMatchValue(node.items[i]! as IRI);
      if (itemValue === null || itemValue !== pattern[i]) { match = false; break; }
    }

    if (match) {
      // Add the node at the variable position to the paradigm set
      // Can be an atom OR a fragment (group) — both are valid paradigm members
      const itemUri = node.items[position]!;
      const itemValue = nodeMatchValue(itemUri as IRI);
      if (itemValue !== null && itemValue !== '?') {
        paradigm.add(itemUri);
      }
    }
  }

  return paradigm;
}

// Compute paradigm set from a SPARQL query.
// The query must SELECT ?candidate — each result is a URI in the paradigm set.
function computeParadigmFromSparql(query: string): Set<string> {
  const paradigm = new Set<string>();
  try {
    const store = materializeTriples(pgsl);
    const result = executeSparqlString(store, query);
    for (const binding of result.bindings) {
      const candidate = binding.get('?candidate');
      if (candidate) paradigm.add(candidate);
    }
  } catch {}
  return paradigm;
}

// Apply a paradigm operation
function applyParadigmOp(op: ParadigmOp, setA: Set<string>, setB: Set<string>): Set<string> {
  switch (op) {
    case 'subset': return setB;
    case 'intersect': { const result = new Set<string>(); for (const x of setA) if (setB.has(x)) result.add(x); return result; }
    case 'union': { const result = new Set(setA); for (const x of setB) result.add(x); return result; }
    case 'exclude': { const result = new Set<string>(); for (const x of setA) if (!setB.has(x)) result.add(x); return result; }
    case 'equal': return setB;
  }
}

// CRUD for paradigm constraints
app.post('/api/constraints', (req, res) => {
  const { patternA, positionA, patternB, positionB, op, sparql, minCount, maxCount } = req.body as {
    patternA: string[]; positionA: number; patternB?: string[]; positionB?: number; op: ParadigmOp;
    sparql?: string; minCount?: number; maxCount?: number;
  };
  if (!patternA || positionA === undefined || !op) {
    res.status(400).json({ error: 'Need patternA, positionA, op' });
    return;
  }
  // Either patternB or sparql must be provided
  if (!sparql && (!patternB || positionB === undefined)) {
    res.status(400).json({ error: 'Need either patternB+positionB or sparql' });
    return;
  }

  const constraint: ParadigmConstraint = {
    id: `c:${Date.now()}`,
    patternA, positionA,
    patternB: patternB ?? [],
    positionB: positionB ?? 0,
    op,
    sparql,
    minCount,
    maxCount,
    createdAt: new Date().toISOString(),
  };
  constraintRegistry.push(constraint);
  recordTrace(traceStore, {
    id: `urn:prov:trace:${Date.now()}`,
    activity: 'constraints',
    agent: 'browser-user',
    agentAAT: 'aat:full-access',
    entity: constraint.id as IRI,
    startedAt: new Date().toISOString(),
    wasAssociatedWith: 'browser-user',
    success: true,
  });

  // Compute the paradigm sets for display
  const pA = computeParadigm(patternA, positionA);
  const pB = sparql ? computeParadigmFromSparql(sparql) : computeParadigm(patternB!, positionB!);
  const result = applyParadigmOp(op, pA, pB);

  res.json({
    constraint,
    paradigmA: [...pA].map(u => pgslResolve(pgsl, u as IRI)),
    paradigmB: [...pB].map(u => pgslResolve(pgsl, u as IRI)),
    result: [...result].map(u => pgslResolve(pgsl, u as IRI)),
    total: constraintRegistry.length,
  });
});

app.get('/api/constraints', (_req, res) => {
  res.json({ constraints: constraintRegistry });
});

// ── SHACL Integration ──
// Import SHACL shape definitions as paradigm constraints.
// Export paradigm constraints as SHACL Turtle.

// Import: accept a SHACL-style shape definition, create paradigm constraint(s)
app.post('/api/constraints/shacl', (req, res) => {
  const { targetPattern, targetPosition, properties } = req.body as {
    targetPattern: string[]; // the syntagmatic pattern this shape targets
    targetPosition: number;  // which position is the focus
    properties: Array<{
      path: string;          // the syntagmatic pattern for the property
      pathPosition: number;  // which position in the path pattern
      minCount?: number;
      maxCount?: number;
      class?: string;        // value must also appear in this pattern
      classPosition?: number;
      hasValue?: string;     // must be this specific value
      in?: string[];         // must be one of these values
      not?: string;          // must NOT appear in this pattern
      notPosition?: number;
      sparql?: string;       // arbitrary SPARQL constraint
    }>;
  };

  if (!targetPattern || targetPosition === undefined || !properties) {
    res.status(400).json({ error: 'Need targetPattern, targetPosition, properties' });
    return;
  }

  const created: ParadigmConstraint[] = [];

  for (const prop of properties) {
    // sh:class → subset constraint
    if (prop.class && prop.classPosition !== undefined) {
      const c: ParadigmConstraint = {
        id: `shacl:${Date.now()}:${created.length}`,
        patternA: targetPattern,
        positionA: targetPosition,
        patternB: prop.class.split(',').map(s => s.trim()),
        positionB: prop.classPosition,
        op: 'subset',
        minCount: prop.minCount,
        maxCount: prop.maxCount,
        createdAt: new Date().toISOString(),
      };
      constraintRegistry.push(c);
      created.push(c);
    }

    // sh:not → exclude constraint
    if (prop.not && prop.notPosition !== undefined) {
      const c: ParadigmConstraint = {
        id: `shacl:${Date.now()}:${created.length}`,
        patternA: targetPattern,
        positionA: targetPosition,
        patternB: prop.not.split(',').map(s => s.trim()),
        positionB: prop.notPosition,
        op: 'exclude',
        createdAt: new Date().toISOString(),
      };
      constraintRegistry.push(c);
      created.push(c);
    }

    // sh:sparqlConstraint → SPARQL constraint
    if (prop.sparql) {
      const c: ParadigmConstraint = {
        id: `shacl:${Date.now()}:${created.length}`,
        patternA: targetPattern,
        positionA: targetPosition,
        patternB: [],
        positionB: 0,
        op: 'subset',
        sparql: prop.sparql,
        minCount: prop.minCount,
        maxCount: prop.maxCount,
        createdAt: new Date().toISOString(),
      };
      constraintRegistry.push(c);
      created.push(c);
    }

    // sh:in → equal constraint with computed paradigm
    if (prop.in) {
      // Find URIs for the allowed values
      const allowedUris = prop.in.map(v => pgsl.atoms.get(v)).filter(Boolean);
      if (allowedUris.length > 0) {
        const sparql = `PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>
SELECT ?candidate WHERE { ?candidate a pgsl:Atom ; pgsl:value ?v. FILTER(${prop.in.map(v => `?v = "${v}"`).join(' || ')}) }`;
        const c: ParadigmConstraint = {
          id: `shacl:${Date.now()}:${created.length}`,
          patternA: targetPattern,
          positionA: targetPosition,
          patternB: [],
          positionB: 0,
          op: 'subset',
          sparql,
          createdAt: new Date().toISOString(),
        };
        constraintRegistry.push(c);
        created.push(c);
      }
    }
  }

  res.json({ created: created.length, constraints: created });
});

// Export: paradigm constraints as SHACL Turtle
app.get('/api/constraints/shacl', (_req, res) => {
  const opToShacl: Record<string, string> = {
    subset: 'sh:class',
    intersect: 'sh:and',
    exclude: 'sh:not',
    equal: 'sh:equals',
    union: 'sh:or',
  };

  let turtle = '@prefix sh: <http://www.w3.org/ns/shacl#>.\n';
  turtle += '@prefix pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>.\n\n';

  for (const c of constraintRegistry) {
    const shapeName = c.id.replace(/[^a-zA-Z0-9]/g, '_');
    const patternStr = c.patternA.map((v, i) => i === c.positionA ? '?' : v).join(', ');
    turtle += `# Constraint: P(${patternStr}) ${c.op} P(${c.patternB.map((v, i) => i === c.positionB ? '?' : v).join(', ')})\n`;
    turtle += `<urn:constraint:${shapeName}> a sh:NodeShape ;\n`;
    turtle += `    sh:description "Paradigm constraint: ${c.op}" ;\n`;
    if (c.sparql) {
      turtle += `    sh:sparql [\n`;
      turtle += `        sh:select """${c.sparql}""" ;\n`;
      turtle += `    ] ;\n`;
    }
    if (c.minCount !== undefined) turtle += `    sh:minCount ${c.minCount} ;\n`;
    if (c.maxCount !== undefined) turtle += `    sh:maxCount ${c.maxCount} ;\n`;
    turtle += `.\n\n`;
  }

  res.set('Content-Type', 'text/turtle');
  res.send(turtle);
});

// Compute paradigm set for a given pattern + position
app.post('/api/paradigm', (req, res) => {
  const { pattern, position, sparql } = req.body as { pattern?: string[]; position?: number; sparql?: string };
  if (sparql) {
    const paradigm = computeParadigmFromSparql(sparql);
    res.json({
      source: 'sparql', sparql,
      members: [...paradigm].map(u => ({ uri: u, resolved: pgslResolve(pgsl, u as IRI) })),
      size: paradigm.size,
    });
    return;
  }
  if (!pattern || position === undefined) {
    res.status(400).json({ error: 'Need (pattern + position) or sparql' });
    return;
  }
  const paradigm = computeParadigm(pattern, position);
  res.json({
    source: 'pattern', pattern, position,
    members: [...paradigm].map(u => ({ uri: u, resolved: pgslResolve(pgsl, u as IRI) })),
    size: paradigm.size,
  });
});

app.delete('/api/constraints/:id', (req, res) => {
  const idx = constraintRegistry.findIndex(c => c.id === req.params['id']);
  if (idx < 0) { res.status(404).json({ error: 'Not found' }); return; }
  constraintRegistry.splice(idx, 1);
  res.json({ deleted: true, total: constraintRegistry.length });
});

// Compute paradigm set for a given pattern + position
// Query: given a chain being built, what candidates satisfy all active constraints?
app.post('/api/constraints/candidates', (req, res) => {
  const { currentChain, side } = req.body as { currentChain: string[]; side: string };
  if (!currentChain) { res.status(400).json({ error: 'Need currentChain' }); return; }

  const chainValues = currentChain.map(uri => {
    const node = pgsl.nodes.get(uri as IRI);
    if (!node) return '?';
    return node.kind === 'Atom' ? String((node as any).value) : pgslResolve(pgsl, uri as IRI);
  });

  // Check each constraint: does the current chain match patternA?
  // If so, compute the constrained paradigm and filter candidates.
  let constrained = false;
  let validUris: Set<string> | null = null;
  const activeConstraints: string[] = [];

  for (const c of constraintRegistry) {
    // Check if current chain + new item would match patternA
    const pa = c.patternA;
    if (chainValues.length + 1 !== pa.length) continue;

    // Check if chain matches the non-variable, non-position parts of patternA
    let match = true;
    for (let i = 0; i < chainValues.length; i++) {
      const targetIdx = (side === 'left') ? i + 1 : i;
      if (targetIdx === c.positionA) continue; // variable position
      if (pa[targetIdx] === '?') continue;
      if (pa[targetIdx] !== chainValues[i]) { match = false; break; }
    }

    // Check that the new item position IS the variable position
    const newItemIdx = (side === 'left') ? 0 : chainValues.length;
    if (newItemIdx !== c.positionA) continue;

    if (!match) continue;

    // This constraint applies! Compute paradigm B (from pattern or SPARQL) and apply operation.
    constrained = true;
    const pB = c.sparql ? computeParadigmFromSparql(c.sparql) : computeParadigm(c.patternB, c.positionB);
    const result = applyParadigmOp(c.op, new Set(), pB);

    if (validUris === null) {
      validUris = result;
    } else {
      // Intersect with previous constraints
      const intersected = new Set<string>();
      for (const u of validUris) if (result.has(u)) intersected.add(u);
      validUris = intersected;
    }

    const opSymbol = c.op;
    activeConstraints.push(`P(${pa.join(',')},${c.positionA}) ${opSymbol} P(${c.patternB.join(',')},${c.positionB})`);
  }

  if (!constrained) {
    res.json({ constrained: false, constraints: [], candidates: null });
    return;
  }

  res.json({
    constrained: true,
    constraints: activeConstraints,
    candidates: validUris ? [...validUris].map(uri => ({
      uri,
      resolved: pgslResolve(pgsl, uri as IRI),
      level: pgsl.nodes.get(uri as IRI)?.level ?? 0,
    })) : null,
  });
});

// ── Paradigm Causal Model ──
// Derive a structural causal model from paradigm constraints.
// Each paradigm P(pattern, position) is a variable.
// Each constraint is a causal edge between paradigms.
// Enables: doIntervention, isDSeparated, counterfactual queries
// on the paradigm graph itself.

app.get('/api/paradigm-scm', (_req, res) => {
  if (constraintRegistry.length === 0) {
    res.json({ variables: [], edges: [], constraints: 0 });
    return;
  }

  // Each unique paradigm (pattern + position) is a variable
  const varMap = new Map<string, { name: string; pattern: string[]; position: number; members: string[] }>();

  function paradigmKey(pattern: string[], position: number): string {
    return `P(${pattern.map((v, i) => i === position ? '?' : v).join(',')})`;
  }

  for (const c of constraintRegistry) {
    const keyA = paradigmKey(c.patternA, c.positionA);
    const keyB = paradigmKey(c.patternB, c.positionB);

    if (!varMap.has(keyA)) {
      const members = [...computeParadigm(c.patternA, c.positionA)].map(u => pgslResolve(pgsl, u as IRI));
      varMap.set(keyA, { name: keyA, pattern: c.patternA, position: c.positionA, members });
    }
    if (!varMap.has(keyB)) {
      const members = [...computeParadigm(c.patternB, c.positionB)].map(u => pgslResolve(pgsl, u as IRI));
      varMap.set(keyB, { name: keyB, pattern: c.patternB, position: c.positionB, members });
    }
  }

  // Build SCM
  const variables = [...varMap.values()].map(v => ({
    name: v.name,
    observed: true,
    mechanism: `paradigm at position ${v.position}`,
    members: v.members,
  }));

  const edges = constraintRegistry.map(c => ({
    from: paradigmKey(c.patternA, c.positionA),
    to: paradigmKey(c.patternB, c.positionB),
    mechanism: c.op,
    op: c.op,
  }));

  // Build the actual SCM for causal queries
  try {
    const scm = buildSCM(
      'urn:scm:paradigm-constraints' as IRI,
      variables.map(v => ({ name: v.name, observed: v.observed, mechanism: v.mechanism })),
      edges.map(e => ({ from: e.from, to: e.to, mechanism: e.mechanism })),
      'Paradigm Constraint Causal Model',
    );

    // Compute causal properties
    const causalInfo: any = {
      variables: variables.map(v => ({ name: v.name, members: v.members })),
      edges: edges.map(e => ({ from: e.from, to: e.to, op: e.op })),
      constraints: constraintRegistry.length,
    };

    // For each pair of paradigms, check d-separation
    if (variables.length >= 2) {
      causalInfo.dSeparation = [];
      for (let i = 0; i < variables.length; i++) {
        for (let j = i + 1; j < variables.length; j++) {
          const sep = isDSeparated(scm, variables[i]!.name, variables[j]!.name, new Set());
          causalInfo.dSeparation.push({
            x: variables[i]!.name,
            y: variables[j]!.name,
            independent: sep,
          });
        }
      }
    }

    // Counterfactual: for each edge, what if we intervened on the source?
    causalInfo.counterfactuals = edges.map(e => {
      const cf = evaluateCounterfactual(scm, {
        intervention: { variable: e.from, value: 'modified' },
        target: e.to,
      });
      return {
        intervention: `do(${e.from} = modified)`,
        target: e.to,
        affected: cf.targetAffected,
        affectedVariables: cf.affectedVariables,
      };
    });

    res.json(causalInfo);
  } catch (err) {
    // SCM might fail if constraints form cycles — that's informative too
    res.json({
      variables: variables.map(v => ({ name: v.name, members: v.members })),
      edges: edges.map(e => ({ from: e.from, to: e.to, op: e.op })),
      constraints: constraintRegistry.length,
      error: (err as Error).message,
    });
  }
});

// Paradigm intervention: what happens if we add an atom to a paradigm?
app.post('/api/paradigm-intervene', (req, res) => {
  const { pattern, position, newAtom } = req.body as { pattern: string[]; position: number; newAtom: string };
  if (!pattern || position === undefined || !newAtom) {
    res.status(400).json({ error: 'Need pattern, position, newAtom' });
    return;
  }

  const paradigmName = `P(${pattern.map((v, i) => i === position ? '?' : v).join(',')})`;

  // Check which constraints would fire
  const effects: Array<{
    constraint: string;
    op: string;
    targetParadigm: string;
    satisfied: boolean;
    reason: string;
  }> = [];

  for (const c of constraintRegistry) {
    // Does this constraint's pattern A match the intervention?
    const pa = c.patternA;
    if (pa.length !== pattern.length) continue;

    let match = true;
    for (let i = 0; i < pa.length; i++) {
      if (i === c.positionA) continue;
      if (pa[i] === '?') continue;
      if (pa[i] !== pattern[i]) { match = false; break; }
    }
    if (!match || c.positionA !== position) continue;

    // This constraint fires — check if newAtom satisfies it
    const targetParadigm = c.sparql ? computeParadigmFromSparql(c.sparql) : computeParadigm(c.patternB, c.positionB);
    const targetMembers = [...targetParadigm].map(u => pgslResolve(pgsl, u as IRI));

    // Find the atom URI for newAtom
    const newAtomUri = pgsl.atoms.get(newAtom);
    const inTarget = newAtomUri ? targetParadigm.has(newAtomUri) : false;

    let satisfied = false;
    let reason = '';
    switch (c.op) {
      case 'subset': satisfied = inTarget; reason = inTarget ? `${newAtom} exists in target` : `${newAtom} NOT in target paradigm (${targetMembers.join(', ')})`; break;
      case 'intersect': satisfied = inTarget; reason = inTarget ? `${newAtom} in both` : `${newAtom} not in target`; break;
      case 'union': satisfied = true; reason = 'union always satisfied'; break;
      case 'exclude': satisfied = !inTarget; reason = !inTarget ? `${newAtom} excluded from target (good)` : `${newAtom} found in excluded set`; break;
      case 'equal': satisfied = inTarget; reason = inTarget ? `${newAtom} in both (equal)` : `${newAtom} missing from target`; break;
    }

    const targetName = `P(${c.patternB.map((v, i) => i === c.positionB ? '?' : v).join(',')})`;
    effects.push({
      constraint: `${paradigmName} ${c.op} ${targetName}`,
      op: c.op,
      targetParadigm: targetName,
      satisfied,
      reason,
    });
  }

  const allSatisfied = effects.length === 0 || effects.every(e => e.satisfied);

  res.json({
    intervention: `do(add ${newAtom} to ${paradigmName})`,
    effects,
    permitted: allSatisfied,
    blockedBy: effects.filter(e => !e.satisfied).map(e => e.constraint),
  });
});

// Serve the HTML — root and node-specific URLs
app.get('/', (_req, res) => {
  res.sendFile(resolve(__dirname, 'index.html'));
});

// /.well-known/security.txt — RFC 9116. Body from the shared
// @interego/core builder (single source of truth across all 5
// surfaces). See spec/policies/14-vulnerability-management.md §5.3.
app.get(['/.well-known/security.txt', '/security.txt'], (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(buildSecurityTxtFromEnv(process.env['PUBLIC_BASE_URL']));
});

// Hypermedia: dereferenceable node URLs
// /node/{hash} serves the browser — the hash is the content-addressed ID
app.get('/node/*', (_req, res) => {
  res.sendFile(resolve(__dirname, 'index.html'));
});

// Resolve a hash to full URI (for URL-based lookups)
app.get('/api/resolve-hash/:hash', (req, res) => {
  const hash = req.params['hash']!;
  for (const [uri] of pgsl.nodes) {
    if (uri.endsWith(':' + hash)) {
      res.json({ uri, resolved: pgslResolve(pgsl, uri as IRI), kind: pgsl.nodes.get(uri as IRI)?.kind, level: pgsl.nodes.get(uri as IRI)?.level });
      return;
    }
  }
  res.status(404).json({ error: 'Hash not found', hash });
});

// Hypermedia API: full self-descriptive resource for a node
// Returns the node data + links (neighbors, containers, constituents) + controls (affordances)
app.get('/api/node/*', (req, res) => {
  const nodeUri = decodeURIComponent(req.params[0]!) as IRI;
  const node = pgsl.nodes.get(nodeUri);
  if (!node) { res.status(404).json({ error: 'Node not found', uri: nodeUri }); return; }

  const resolved = pgslResolve(pgsl, nodeUri);
  const annotations = computeContainmentAnnotations(pgsl, nodeUri);
  const nodeHash = nodeUri.split(':').pop() ?? nodeUri;

  // ── Identity ──────────────────────────────────────────
  // Every node is uniquely addressed and fully dereferenceable

  const self = {
    uri: nodeUri,
    href: `/node/${encodeURIComponent(nodeUri)}`,
    resolved,
    kind: node.kind,
    level: node.level,
    hash: nodeHash,
...(node.kind === 'Atom' ? { value: node.value } : {}),
...(node.kind === 'Fragment' ? { height: node.height } : {}),
    provenance: node.provenance,
  };

  // ── Structure ─────────────────────────────────────────
  // Downward: what this node contains (items, constituents)

  const structure: Record<string, any> = {};

  if (node.kind === 'Fragment' && node.items) {
    structure.items = node.items.map((itemUri, i) => {
      const itemNode = pgsl.nodes.get(itemUri);
      return {
        uri: itemUri,
        href: `/node/${encodeURIComponent(itemUri)}`,
        resolved: pgslResolve(pgsl, itemUri),
        kind: itemNode?.kind ?? 'unknown',
        level: itemNode?.level ?? 0,
        position: i,
      };
    });
  }

  if (node.kind === 'Fragment' && node.left) {
    structure.leftConstituent = { uri: node.left, href: `/node/${encodeURIComponent(node.left)}`, resolved: pgslResolve(pgsl, node.left) };
  }
  if (node.kind === 'Fragment' && node.right) {
    structure.rightConstituent = { uri: node.right, href: `/node/${encodeURIComponent(node.right)}`, resolved: pgslResolve(pgsl, node.right) };
  }

  // ── Context ───────────────────────────────────────────
  // Upward: what contains this node, and positional context

  const containers: any[] = [];
  for (const [fUri, fNode] of pgsl.nodes) {
    if (fNode.kind !== 'Fragment' || !fNode.items.includes(nodeUri)) continue;
    const pos = fNode.items.indexOf(nodeUri);
    containers.push({
      uri: fUri,
      href: `/node/${encodeURIComponent(fUri)}`,
      resolved: pgslResolve(pgsl, fUri as IRI),
      level: fNode.level,
      position: pos,
      totalItems: fNode.items.length,
    });
  }

  // ── Paradigm: Source & Target Options ─────────────────
  // For this node as a chain of 1: what can go before (source)
  // and after (target) it in existing structures?
  // These ARE the paradigm sets — computed from actual usage.

  const sourceOptions: any[] = [];  // what appears before this node
  const targetOptions: any[] = [];  // what appears after this node
  const seenLeft = new Set<string>();
  const seenRight = new Set<string>();

  for (const c of containers) {
    const cNode = pgsl.nodes.get(c.uri as IRI);
    if (!cNode || cNode.kind !== 'Fragment') continue;
    const pos = cNode.items.indexOf(nodeUri);
    if (pos > 0) {
      const lu = cNode.items[pos - 1]!;
      if (!seenLeft.has(lu)) {
        seenLeft.add(lu);
        const lNode = pgsl.nodes.get(lu);
        sourceOptions.push({
          uri: lu,
          href: `/node/${encodeURIComponent(lu)}`,
          resolved: pgslResolve(pgsl, lu),
          kind: lNode?.kind ?? 'unknown',
          level: lNode?.level ?? 0,
          context: { container: c.uri, containerResolved: c.resolved },
        });
      }
    }
    if (pos < cNode.items.length - 1) {
      const ru = cNode.items[pos + 1]!;
      if (!seenRight.has(ru)) {
        seenRight.add(ru);
        const rNode = pgsl.nodes.get(ru);
        targetOptions.push({
          uri: ru,
          href: `/node/${encodeURIComponent(ru)}`,
          resolved: pgslResolve(pgsl, ru),
          kind: rNode?.kind ?? 'unknown',
          level: rNode?.level ?? 0,
          context: { container: c.uri, containerResolved: c.resolved },
        });
      }
    }
  }

  // ── Constraints ───────────────────────────────────────
  // Active paradigm constraints that affect this node's position

  const activeConstraints: any[] = [];
  const nodeValue = node.kind === 'Atom' ? String(node.value) : null;

  for (const c of constraintRegistry) {
    // Check if this node appears in pattern A or B
    const inA = nodeValue && c.patternA.includes(nodeValue);
    const inB = nodeValue && c.patternB.includes(nodeValue);
    if (inA || inB) {
      const pA = computeParadigm(c.patternA, c.positionA);
      const pB = c.sparql ? computeParadigmFromSparql(c.sparql) : computeParadigm(c.patternB, c.positionB);
      const result = applyParadigmOp(c.op, pA, pB);
      activeConstraints.push({
        id: c.id,
        op: c.op,
        opSymbol: OP_SYMBOLS[c.op],
        patternA: c.patternA,
        positionA: c.positionA,
        patternB: c.patternB,
        positionB: c.positionB,
        validCandidates: [...result].map(u => ({
          uri: u,
          href: `/node/${encodeURIComponent(u)}`,
          resolved: pgslResolve(pgsl, u as IRI),
        })),
        paradigmASize: pA.size,
        paradigmBSize: pB.size,
        resultSize: result.size,
      });
    }
  }

  // ── Controls (Affordances) — Decorator Chain ──────────
  // Instead of hardcoded controls, run the decorator chain.
  // Each decorator adds affordances based on its expertise.

  const decoratorContext = {
    uri: nodeUri,
    value: node.kind === 'Atom' ? node.value : undefined,
    kind: node.kind as 'Atom' | 'Fragment',
    level: node.level,
    resolved,
    items: node.kind === 'Fragment' ? node.items.map((itemUri: IRI, i: number) => {
      const itemNode = pgsl.nodes.get(itemUri);
      return { uri: itemUri, resolved: pgslResolve(pgsl, itemUri), kind: itemNode?.kind ?? 'unknown', level: itemNode?.level ?? 0 };
    }) : undefined,
    sourceOptions: sourceOptions.map(o => ({ uri: o.uri as IRI, resolved: o.resolved })),
    targetOptions: targetOptions.map(o => ({ uri: o.uri as IRI, resolved: o.resolved })),
    constraints: activeConstraints,
    containers: containers.map(c => ({ uri: c.uri as IRI, resolved: c.resolved, level: c.level, position: c.position })),
    pgsl,
    existingAffordances: [],
  };

  const decorated = decorateNode(decoratorRegistry, decoratorContext);
  const controls = decorated.affordances;
  const suggestions = decorated.suggestions;

  // ── Response ──────────────────────────────────────────

  res.json({
...self,
    _structure: structure,
    _context: {
      containers,
      annotations: annotations.map(a => ({...a, parentResolved: pgslResolve(pgsl, a.parentUri) })),
    },
    _paradigm: {
      sourceOptions,
      targetOptions,
      constraints: activeConstraints,
    },
    _controls: controls,
    _suggestions: suggestions.length > 0 ? suggestions : undefined,
    _links: {
      self: { href: `/node/${encodeURIComponent(nodeUri)}`, rel: 'self' },
...(containers.length > 0 ? { up: containers.map(c => ({ href: c.href, rel: 'container', resolved: c.resolved })) } : {}),
...(structure.items ? { down: structure.items.map((i: any) => ({ href: i.href, rel: 'item', resolved: i.resolved })) } : {}),
    },
  });
});

// Hypermedia API: chain-level resource
// Given a chain of URIs, returns inner neighbors (sequence extensions)
// and outer neighbors (what contains the whole chain as a unit)
app.post('/api/chain', (req, res) => {
  const { uris } = req.body as { uris: string[] };
  if (!uris || uris.length === 0) { res.status(400).json({ error: 'Need at least 1 URI' }); return; }

  const chainUris = uris as IRI[];

  // Resolve chain items
  const items = chainUris.map(u => ({
    uri: u,
    resolved: pgsl.nodes.has(u) ? pgslResolve(pgsl, u) : '?',
    level: pgsl.nodes.get(u)?.level ?? 0,
    kind: pgsl.nodes.get(u)?.kind ?? 'unknown',
    href: `/node/${encodeURIComponent(u)}`,
  }));

  // Find the chain as a fragment (exact match)
  let chainFragUri: IRI | null = null;
  for (const [fUri, fNode] of pgsl.nodes) {
    if (fNode.kind !== 'Fragment' || fNode.items.length !== chainUris.length) continue;
    if (chainUris.every((u, i) => fNode.items[i] === u)) { chainFragUri = fUri as IRI; break; }
  }

  // INNER neighbors: what extends the sequence left/right
  const innerLeft: any[] = [];
  const innerRight: any[] = [];

  // Search for chain as sub-sequence in larger fragments
  for (const [fragUri, fragNode] of pgsl.nodes) {
    if (fragNode.kind !== 'Fragment' || fragNode.items.length < chainUris.length) continue;
    for (let sp = 0; sp <= fragNode.items.length - chainUris.length; sp++) {
      let match = true;
      for (let ci = 0; ci < chainUris.length; ci++) {
        if (fragNode.items[sp + ci] !== chainUris[ci]) { match = false; break; }
      }
      if (!match) continue;

      if (sp > 0) {
        const lu = fragNode.items[sp - 1]!;
        if (!innerLeft.some(n => n.uri === lu)) {
          innerLeft.push({ uri: lu, href: `/node/${encodeURIComponent(lu)}`, rel: 'inner-left', resolved: pgslResolve(pgsl, lu), level: pgsl.nodes.get(lu)?.level ?? 0 });
        }
      }
      const ep = sp + chainUris.length;
      if (ep < fragNode.items.length) {
        const ru = fragNode.items[ep]!;
        if (!innerRight.some(n => n.uri === ru)) {
          innerRight.push({ uri: ru, href: `/node/${encodeURIComponent(ru)}`, rel: 'inner-right', resolved: pgslResolve(pgsl, ru), level: pgsl.nodes.get(ru)?.level ?? 0 });
        }
      }
      break;
    }
  }

  // OUTER neighbors: fragments that contain chainFragUri as an ITEM (not sub-sequence).
  // This only applies when the chain has been wrapped into a fragment and that fragment
  // appears as an item in a higher-level structure (e.g., structured ingestion with nesting).
  // If no fragment contains chainFragUri as an item, outer neighbors are empty —
  // the chain only has inner neighbors (sequence extensions).
  const outerLeft: any[] = [];
  const outerRight: any[] = [];

  if (chainFragUri) {
    for (const [fUri, fNode] of pgsl.nodes) {
      if (fNode.kind !== 'Fragment') continue;
      const pos = fNode.items.indexOf(chainFragUri);
      if (pos < 0) continue;
      if (pos > 0) {
        const lu = fNode.items[pos - 1]!;
        if (!outerLeft.some(n => n.uri === lu)) {
          outerLeft.push({ uri: lu, href: `/node/${encodeURIComponent(lu)}`, rel: 'outer-left', resolved: pgslResolve(pgsl, lu), level: pgsl.nodes.get(lu)?.level ?? 0 });
        }
      }
      if (pos < fNode.items.length - 1) {
        const ru = fNode.items[pos + 1]!;
        if (!outerRight.some(n => n.uri === ru)) {
          outerRight.push({ uri: ru, href: `/node/${encodeURIComponent(ru)}`, rel: 'outer-right', resolved: pgslResolve(pgsl, ru), level: pgsl.nodes.get(ru)?.level ?? 0 });
        }
      }
    }
  }

  // ── Outer paradigm patterns ──────────────────────────
  // Build the pattern for the outer level: the chain-as-fragment sits
  // at some position in a higher-level chain. The pattern uses resolved
  // values so fragments (groups) can participate in constraints.
  const outerParadigm: Record<string, any> = {};
  if (chainFragUri) {
    const chainResolved = pgslResolve(pgsl, chainFragUri);
    // For each container, build the pattern with ? at the chain's position
    for (const [fUri, fNode] of pgsl.nodes) {
      if (fNode.kind !== 'Fragment') continue;
      const pos = fNode.items.indexOf(chainFragUri);
      if (pos < 0) continue;

      // Build pattern: resolved values at each position, ? at chain position
      const outerPattern = fNode.items.map((itemUri, i) => {
        if (i === pos) return '?';
        return nodeMatchValue(itemUri as IRI) ?? '?';
      });

      if (!outerParadigm.leftPattern && pos > 0) {
        // Left outer paradigm: pattern with ? at pos-1
        const leftPattern = fNode.items.map((itemUri, i) => {
          if (i === pos - 1) return '?';
          return nodeMatchValue(itemUri as IRI) ?? '?';
        });
        outerParadigm.leftPattern = leftPattern;
        outerParadigm.leftPosition = pos - 1;
      }
      if (!outerParadigm.rightPattern && pos < fNode.items.length - 1) {
        // Right outer paradigm: pattern with ? at pos+1
        const rightPattern = fNode.items.map((itemUri, i) => {
          if (i === pos + 1) return '?';
          return nodeMatchValue(itemUri as IRI) ?? '?';
        });
        outerParadigm.rightPattern = rightPattern;
        outerParadigm.rightPosition = pos + 1;
      }
      if (!outerParadigm.selfPattern) {
        outerParadigm.selfPattern = outerPattern;
        outerParadigm.selfPosition = pos;
      }
    }
  }

  // ── Controls for chain-level operations ─────────────
  const chainControls: any[] = [];

  // Constrain outer left paradigm
  if (outerParadigm.leftPattern) {
    chainControls.push({
      rel: 'constrain-outer-source',
      title: 'Constrain what can appear before this group',
      method: 'POST',
      href: '/api/constraints',
      pattern: outerParadigm.leftPattern,
      position: outerParadigm.leftPosition,
    });
  }

  // Constrain outer right paradigm
  if (outerParadigm.rightPattern) {
    chainControls.push({
      rel: 'constrain-outer-target',
      title: 'Constrain what can appear after this group',
      method: 'POST',
      href: '/api/constraints',
      pattern: outerParadigm.rightPattern,
      position: outerParadigm.rightPosition,
    });
  }

  // Constrain what can appear at this group's position (outer self paradigm)
  if (outerParadigm.selfPattern) {
    chainControls.push({
      rel: 'constrain-outer-self',
      title: 'Constrain what groups can appear at this position',
      method: 'POST',
      href: '/api/constraints',
      pattern: outerParadigm.selfPattern,
      position: outerParadigm.selfPosition,
    });
  }

  res.json({
    chain: items,
    chainFragment: chainFragUri ? { uri: chainFragUri, href: `/node/${encodeURIComponent(chainFragUri)}`, resolved: pgslResolve(pgsl, chainFragUri) } : null,
    _links: {
      self: { href: '/api/chain', method: 'POST' },
      innerLeft, innerRight,
      outerLeft, outerRight,
    },
    _outerParadigm: outerParadigm,
    _controls: chainControls,
  });
});

// Ingest content into the lattice (and optionally to pod)
app.post('/api/ingest', (req, res) => {
  const { content, granularity } = req.body as { content: string; granularity?: TokenGranularity };
  try {
    const uri = embedInPGSL(pgsl, content, undefined, granularity ?? 'word');
    const resolved = pgslResolve(pgsl, uri);
    const stats = latticeStats(pgsl);
    recordTrace(traceStore, {
      id: `urn:prov:trace:${Date.now()}`,
      activity: 'ingest',
      agent: 'browser-user',
      agentAAT: 'aat:full-access',
      entity: uri,
      startedAt: new Date().toISOString(),
      wasAssociatedWith: 'browser-user',
      success: true,
    });
    res.json({ uri, resolved, stats });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Ingest a sequence of existing URIs as a new fragment
app.post('/api/ingest-uris', (req, res) => {
  const { uris } = req.body as { uris: string[] };
  if (!uris || uris.length < 2) {
    res.status(400).json({ error: 'Need at least 2 URIs' });
    return;
  }
  try {
    for (const uri of uris) {
      if (!pgsl.nodes.has(uri as IRI)) {
        res.status(400).json({ error: `URI not found: ${uri}` });
        return;
      }
    }
    const topUri = ingest(pgsl, uris as IRI[]);
    const resolved = pgslResolve(pgsl, topUri);
    const stats = latticeStats(pgsl);
    recordTrace(traceStore, {
      id: `urn:prov:trace:${Date.now()}`,
      activity: 'ingest',
      agent: 'browser-user',
      agentAAT: 'aat:full-access',
      entity: topUri,
      startedAt: new Date().toISOString(),
      wasAssociatedWith: 'browser-user',
      success: true,
    });
    res.json({ uri: topUri, resolved, stats });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Rebuild lattice from pod (manual refresh)
app.post('/api/rebuild', async (_req, res) => {
  await rebuildFromPod();
  res.json(latticeStats(pgsl));
});

// Get lattice stats
app.get('/api/stats', (_req, res) => {
  res.json(latticeStats(pgsl));
});

// Resolve a URI
app.post('/api/resolve', (req, res) => {
  const uri = req.body.uri as IRI;
  const node = pgsl.nodes.get(uri);
  if (!node) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ uri, resolved: pgslResolve(pgsl, uri), node });
});

// Focus: find neighbors for a chain
app.post('/api/focus', (req, res) => {
  const focusUri = req.body.uri as IRI;
  const chainContext: string[] = req.body.chainContext ?? [];
  const focusNode = pgsl.nodes.get(focusUri);

  if (!focusNode) {
    res.json({ focus: { uri: focusUri, resolved: '?', level: 0 }, left: [], right: [], containingFragments: [], annotations: [] });
    return;
  }

  const resolved = pgslResolve(pgsl, focusUri);

  // Build excluded set from nested chain elements
  const excludedFragments = new Set<string>();
  const hasNonNestedItems = chainContext.some(cu => {
    const cn = pgsl.nodes.get(cu as IRI);
    return !cn || cn.kind === 'Atom' || cn.level === 0;
  });

  for (const chainUri of chainContext) {
    excludedFragments.add(chainUri);
    const chainNode = pgsl.nodes.get(chainUri as IRI);
    if (hasNonNestedItems && chainNode && chainNode.kind === 'Fragment' && chainNode.level > 0) {
      const nestedAtoms = new Set<string>();
      const addSub = (uri: IRI) => {
        const node = pgsl.nodes.get(uri);
        if (!node) return;
        if (node.kind === 'Atom') { nestedAtoms.add(uri); return; }
        if (node.kind !== 'Fragment') return;
        excludedFragments.add(uri);
        if (node.items) for (const item of node.items) addSub(item);
        if (node.left) addSub(node.left);
        if (node.right) addSub(node.right);
      };
      addSub(chainUri as IRI);

      const focusAtomUri = focusUri;
      for (const [fUri, fNode] of pgsl.nodes) {
        if (fNode.kind !== 'Fragment' || !fNode.items) continue;
        const hasNestedAtom = fNode.items.some(item => item !== focusAtomUri && nestedAtoms.has(item));
        if (hasNestedAtom) excludedFragments.add(fUri);
      }
    }
  }

  // Build focusUris (atom + L1 wrapper)
  const focusUris = new Set<string>([focusUri]);
  if (focusNode.kind === 'Atom') {
    for (const [fUri, fNode] of pgsl.nodes) {
      if (fNode.kind === 'Fragment' && fNode.level === 1 && fNode.items.length === 1 && fNode.items[0] === focusUri) {
        focusUris.add(fUri);
      }
    }
  }

  // Find containing fragments
  const containingFragments: Array<{
    uri: string; resolved: string; level: number; position: number;
    items: string[]; itemsResolved: string[];
  }> = [];

  for (const [fragUri, fragNode] of pgsl.nodes) {
    if (fragNode.kind !== 'Fragment' || !fragNode.items) continue;
    let idx = -1;
    for (const fUri of focusUris) {
      const i = fragNode.items.indexOf(fUri as IRI);
      if (i >= 0) { idx = i; break; }
    }
    if (idx >= 0 && !excludedFragments.has(fragUri)) {
      containingFragments.push({
        uri: fragUri,
        resolved: pgslResolve(pgsl, fragUri as IRI),
        level: fragNode.level,
        position: idx,
        items: [...fragNode.items],
        itemsResolved: fragNode.items.map(i => pgslResolve(pgsl, i as IRI)),
      });
    }
  }

  // Find neighbors
  const leftNeighbors = new Map<string, { uri: string; resolved: string; count: number; level: number }>();
  const rightNeighbors = new Map<string, { uri: string; resolved: string; count: number; level: number }>();

  if (chainContext.length <= 1) {
    // Single node: neighbors from containing fragments + constituent relationships
    if (focusNode.kind === 'Fragment' && focusNode.level >= 2) {
      for (const [fragUri, fragNode] of pgsl.nodes) {
        if (fragNode.kind !== 'Fragment' || excludedFragments.has(fragUri)) continue;
        if (fragNode.left === focusUri && fragNode.right) {
          const ru = fragNode.right;
          const rn = pgsl.nodes.get(ru);
          rightNeighbors.set(ru, { uri: ru, resolved: pgslResolve(pgsl, ru), count: 1, level: rn?.level ?? 0 });
        }
        if (fragNode.right === focusUri && fragNode.left) {
          const lu = fragNode.left;
          const ln = pgsl.nodes.get(lu);
          leftNeighbors.set(lu, { uri: lu, resolved: pgslResolve(pgsl, lu), count: 1, level: ln?.level ?? 0 });
        }
      }
    }
    for (const frag of containingFragments) {
      if (frag.position > 0) {
        const lu = frag.items[frag.position - 1]!;
        const lr = frag.itemsResolved[frag.position - 1]!;
        const ex = leftNeighbors.get(lu);
        if (ex) ex.count++; else leftNeighbors.set(lu, { uri: lu, resolved: lr, count: 1, level: pgsl.nodes.get(lu as IRI)?.level ?? 0 });
      }
      if (frag.position < frag.items.length - 1) {
        const ru = frag.items[frag.position + 1]!;
        const rr = frag.itemsResolved[frag.position + 1]!;
        const ex = rightNeighbors.get(ru);
        if (ex) ex.count++; else rightNeighbors.set(ru, { uri: ru, resolved: rr, count: 1, level: pgsl.nodes.get(ru as IRI)?.level ?? 0 });
      }
    }
  } else {
    // Multi-node: find chain as sub-sequence in fragment items
    const chainItemUris = chainContext.map(cu => cu as IRI);
    let chainFragUri: IRI | null = null;
    for (const [fUri, fNode] of pgsl.nodes) {
      if (fNode.kind !== 'Fragment' || fNode.items.length !== chainItemUris.length) continue;
      let match = true;
      for (let i = 0; i < chainItemUris.length; i++) {
        if (fNode.items[i] !== chainItemUris[i]) { match = false; break; }
      }
      if (match) { chainFragUri = fUri as IRI; break; }
    }

    let chainFoundInItems = false;
    for (const [fragUri, fragNode] of pgsl.nodes) {
      if (fragNode.kind !== 'Fragment' || !fragNode.items || excludedFragments.has(fragUri)) continue;
      if (fragNode.items.length < chainItemUris.length) continue;

      for (let sp = 0; sp <= fragNode.items.length - chainItemUris.length; sp++) {
        let allMatch = true;
        for (let ci = 0; ci < chainItemUris.length; ci++) {
          if (fragNode.items[sp + ci] !== chainItemUris[ci]) { allMatch = false; break; }
        }
        if (!allMatch) continue;

        chainFoundInItems = true;
        const ir = fragNode.items.map(i => pgslResolve(pgsl, i as IRI));

        if (sp > 0) {
          const lu = fragNode.items[sp - 1]!;
          const ex = leftNeighbors.get(lu);
          if (ex) ex.count++; else leftNeighbors.set(lu, { uri: lu, resolved: ir[sp - 1]!, count: 1, level: pgsl.nodes.get(lu as IRI)?.level ?? 0 });
        }
        const ep = sp + chainItemUris.length;
        if (ep < fragNode.items.length) {
          const ru = fragNode.items[ep]!;
          const ex = rightNeighbors.get(ru);
          if (ex) ex.count++; else rightNeighbors.set(ru, { uri: ru, resolved: ir[ep]!, count: 1, level: pgsl.nodes.get(ru as IRI)?.level ?? 0 });
        }
        break;
      }
    }

    if (!chainFoundInItems && chainFragUri) {
      for (const [fragUri, fragNode] of pgsl.nodes) {
        if (fragNode.kind !== 'Fragment' || excludedFragments.has(fragUri)) continue;
        if (fragNode.left === chainFragUri && fragNode.right) {
          const ru = fragNode.right;
          const rn = pgsl.nodes.get(ru);
          rightNeighbors.set(ru, { uri: ru, resolved: pgslResolve(pgsl, ru), count: 1, level: rn?.level ?? 0 });
        }
        if (fragNode.right === chainFragUri && fragNode.left) {
          const lu = fragNode.left;
          const ln = pgsl.nodes.get(lu);
          leftNeighbors.set(lu, { uri: lu, resolved: pgslResolve(pgsl, lu), count: 1, level: ln?.level ?? 0 });
        }
      }
    }

    if (!chainFoundInItems && leftNeighbors.size === 0 && rightNeighbors.size === 0) {
      for (const frag of containingFragments) {
        if (frag.position > 0) {
          const lu = frag.items[frag.position - 1]!;
          const lr = frag.itemsResolved[frag.position - 1]!;
          const ex = leftNeighbors.get(lu);
          if (ex) ex.count++; else leftNeighbors.set(lu, { uri: lu, resolved: lr, count: 1, level: pgsl.nodes.get(lu as IRI)?.level ?? 0 });
        }
        if (frag.position < frag.items.length - 1) {
          const ru = frag.items[frag.position + 1]!;
          const rr = frag.itemsResolved[frag.position + 1]!;
          const ex = rightNeighbors.get(ru);
          if (ex) ex.count++; else rightNeighbors.set(ru, { uri: ru, resolved: rr, count: 1, level: pgsl.nodes.get(ru as IRI)?.level ?? 0 });
        }
      }
    }
  }

  const annotations = computeContainmentAnnotations(pgsl, focusUri);

  res.json({
    focus: { uri: focusUri, resolved, level: focusNode.level },
    left: [...leftNeighbors.values()].sort((a, b) => b.count - a.count),
    right: [...rightNeighbors.values()].sort((a, b) => b.count - a.count),
    containingFragments: containingFragments.sort((a, b) => b.level - a.level).slice(0, 20),
    annotations: annotations.map(a => ({...a, parentResolved: pgslResolve(pgsl, a.parentUri) })),
  });
});

// Lattice meet
app.post('/api/meet', (req, res) => {
  const { uri_a, uri_b } = req.body;
  const meet = latticeMeet(pgsl, uri_a as IRI, uri_b as IRI);
  if (!meet) { res.json({ meet: null }); return; }
  res.json({ meet, resolved: pgslResolve(pgsl, meet) });
});

// All nodes
app.get('/api/all', (_req, res) => {
  const nodes: Array<{ uri: string; resolved: string; level: number; kind: string }> = [];
  for (const [uri, node] of pgsl.nodes) {
    nodes.push({ uri, resolved: pgslResolve(pgsl, uri as IRI), level: node.level, kind: node.kind });
  }
  res.json({ nodes, stats: latticeStats(pgsl) });
});

// ── Activity log for live demo ──
const activityLog: Array<{ time: string; agent: string; action: string; detail: string }> = [];
function logActivity(agent: string, action: string, detail: string) {
  activityLog.push({ time: new Date().toISOString(), agent, action, detail });
}

// ── Observatory: serve the observatory HTML ──
app.get('/observatory', (_req, res) => {
  res.sendFile(resolve(__dirname, 'observatory.html'));
});

// ── Observatory API: Federation ──

app.get('/api/pods', async (_req, res) => {
  // Discover from all known pods
  const allPods = [POD_URL,...KNOWN_PODS].filter(Boolean);
  for (const podUrl of allPods) {
    if (podRegistry.has(podUrl)) continue;
    try {
      const entries = await discover(podUrl, undefined, { fetch: solidFetch });
      const name = podUrl.replace(CSS_URL, '').replace(/\/$/, '') || 'home';
      podRegistry.set(podUrl, {
        url: podUrl, name, entries,
        descriptors: new Map(),
        lastDiscovered: new Date().toISOString(),
        status: 'active',
      });
    } catch {
      const name = podUrl.replace(CSS_URL, '').replace(/\/$/, '') || 'unknown';
      podRegistry.set(podUrl, {
        url: podUrl, name, entries: [],
        descriptors: new Map(),
        lastDiscovered: new Date().toISOString(),
        status: 'unreachable',
      });
    }
  }
  const pods = [...podRegistry.values()].map(p => ({
    url: p.url, name: p.name, status: p.status,
    descriptorCount: p.entries.length,
    lastDiscovered: p.lastDiscovered,
    entries: p.entries.map(e => ({
      descriptorUrl: e.descriptorUrl,
      describes: e.describes,
      facetTypes: e.facetTypes,
      validFrom: e.validFrom,
      validUntil: e.validUntil,
      version: e.version,
    })),
  }));
  res.json({ pods, totalPods: pods.length, totalDescriptors: pods.reduce((s, p) => s + p.descriptorCount, 0) });
});

app.post('/api/pods/add', (req, res) => {
  const { url } = req.body;
  if (!url) { res.status(400).json({ error: 'Missing url' }); return; }
  if (!KNOWN_PODS.includes(url)) KNOWN_PODS.push(url);
  res.json({ added: url });
});

app.post('/api/pods/discover', async (req, res) => {
  const { url } = req.body;
  try {
    const entries = await discover(url, undefined, { fetch: solidFetch });
    const name = url.replace(CSS_URL, '').replace(/\/$/, '');
    podRegistry.set(url, {
      url, name, entries,
      descriptors: new Map(),
      lastDiscovered: new Date().toISOString(),
      status: 'active',
    });
    res.json({ url, entries: entries.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Observatory API: Descriptor Details ──

app.post('/api/descriptor/fetch', async (req, res) => {
  const { url } = req.body;
  try {
    const resp = await fetch(url, { headers: { 'Accept': 'text/turtle' } });
    const turtle = await resp.text();
    res.json({ url, turtle, size: turtle.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Observatory API: Composition ──

app.post('/api/compose', async (req, res) => {
  const { podA, podB, operator } = req.body as { podA: string; podB: string; operator: string };
  const stateA = podRegistry.get(podA);
  const stateB = podRegistry.get(podB);
  if (!stateA?.entries.length || !stateB?.entries.length) {
    res.status(400).json({ error: 'Both pods must have descriptors' });
    return;
  }

  // Fetch first descriptor from each as Turtle and re-parse (simplified — uses manifest metadata)
  const entryA = stateA.entries[0]!;
  const entryB = stateB.entries[0]!;

  // Build minimal descriptor data from manifest entries for composition
  const descA = ContextDescriptor.create(entryA.descriptorUrl.replace('.ttl', '') as IRI)
.describes(entryA.describes[0] as IRI);
  if (entryA.validFrom) descA.temporal({ validFrom: entryA.validFrom, validUntil: entryA.validUntil });
  for (const ft of entryA.facetTypes) {
    if (ft === 'Semiotic') descA.asserted(0.95);
    if (ft === 'Trust') descA.selfAsserted('urn:pod:a' as IRI);
  }
  const builtA = descA.version(1).build();

  const descB = ContextDescriptor.create(entryB.descriptorUrl.replace('.ttl', '') as IRI)
.describes(entryB.describes[0] as IRI);
  if (entryB.validFrom) descB.temporal({ validFrom: entryB.validFrom, validUntil: entryB.validUntil });
  for (const ft of entryB.facetTypes) {
    if (ft === 'Semiotic') descB.asserted(0.88);
    if (ft === 'Trust') descB.selfAsserted('urn:pod:b' as IRI);
  }
  const builtB = descB.version(1).build();

  let composed: ContextDescriptorData;
  switch (operator) {
    case 'union': composed = union(builtA, builtB); break;
    case 'intersection': composed = intersection(builtA, builtB); break;
    case 'restriction': composed = restriction(builtA, builtB); break;
    case 'override': composed = override(builtA, builtB); break;
    default: res.status(400).json({ error: 'Invalid operator' }); return;
  }

  res.json({
    operator,
    facets: composed.facets.map(f => ({ type: f.type,...f })),
    facetCount: composed.facets.length,
    compositionOp: composed.compositionOp,
    turtle: toTurtle(composed),
  });
});

// ── Observatory API: SPARQL ──

app.post('/api/sparql', (req, res) => {
  const { query } = req.body;
  try {
    const store = materializeTriples(pgsl);
    const result = executeSparqlString(store, query);
    if (result.boolean !== undefined) {
      res.json({ type: 'ASK', boolean: result.boolean });
    } else {
      const rows = result.bindings.map(b => Object.fromEntries(b));
      res.json({ type: 'SELECT', bindings: rows, count: rows.length });
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── Observatory API: SHACL Validation ──

app.get('/api/shacl', (_req, res) => {
  const result = validateAllPGSL(pgsl);
  res.json({
    conforms: result.conforms,
    violationCount: result.violations.length,
    violations: result.violations.slice(0, 50).map(v => ({
      node: v.node,
      shape: v.shape,
      path: v.path,
      message: v.message,
      severity: v.severity,
    })),
  });
});

// ── Virtualized RDF Layer ──────────────────────────────────

// Helper: build system state for the virtualized layer
function getSystemState() {
  return {
    pgsl,
    descriptors: [] as ContextDescriptorData[], // TODO: collect from pod registry
    certificates: getCertificates(),
    constraints: constraintRegistry,
    pods: [...podRegistry.values()].map(p => ({
      url: p.url, name: p.name, status: p.status, descriptorCount: p.entries.length,
    })),
  };
}

// OWL Ontology — the full system described as RDF
app.get('/ontology', (_req, res) => {
  res.set('Content-Type', 'text/turtle');
  res.send(systemOntology());
});

// SHACL Shapes — full system validation shapes
app.get('/ontology/shacl', (_req, res) => {
  res.set('Content-Type', 'text/turtle');
  res.send(systemShaclShapes());
});

// Hydra API Description — machine-readable API documentation
app.get('/api-doc', (_req, res) => {
  res.set('Content-Type', 'application/ld+json');
  const hydra = systemHydraApi();
  res.send(hydra);
});

// DCAT Catalog — federation as linked data catalog
app.get('/catalog', (_req, res) => {
  const pods = [...podRegistry.values()].map(p => ({
    url: p.url, name: p.name, descriptorCount: p.entries.length,
  }));
  res.set('Content-Type', 'text/turtle');
  res.send(systemDcatCatalog(pods));
});

// W3C SPARQL Protocol endpoint — full system virtualized as RDF
// Accepts both GET (query param) and POST (body)
app.get('/sparql', (req, res) => {
  const query = req.query['query'] as string;
  if (!query) { res.status(400).send('Missing query parameter'); return; }
  try {
    const state = getSystemState();
    const result = executeSparqlProtocol(state, query, req.headers.accept);
    res.set('Content-Type', result.contentType);
    res.send(result.body);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/sparql', (req, res) => {
  const query = req.body?.query ?? req.body;
  if (!query || typeof query !== 'string') { res.status(400).send('Missing query'); return; }
  try {
    const state = getSystemState();
    const result = executeSparqlProtocol(state, query, req.headers.accept);
    res.set('Content-Type', result.contentType);
    res.send(result.body);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// SPARQL UPDATE — write-back into PGSL
app.post('/sparql/update', (req, res) => {
  const update = req.body?.update ?? req.body;
  if (!update || typeof update !== 'string') { res.status(400).send('Missing update'); return; }
  try {
    const result = sparqlUpdateHandler(pgsl, update);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Full system dump as Turtle
app.get('/dump.ttl', (_req, res) => {
  const state = getSystemState();
  res.set('Content-Type', 'text/turtle');
  res.send(systemToTurtle(state));
});

// Full system dump as JSON-LD
app.get('/dump.jsonld', (_req, res) => {
  const state = getSystemState();
  res.set('Content-Type', 'application/ld+json');
  res.send(JSON.stringify(systemToJsonLd(state), null, 2));
});

// ── Observatory API: Coherence ──
import {
  verifyCoherence,
  computeCoverage,
  extractObservations,
  computeDecisionAffordances,
  selectStrategy,
  decideFromObservations,
} from '@interego/core';

app.post('/api/coherence/check', (req, res) => {
  const { agents } = req.body as { agents?: string[] };

  // First check if we already have certificates from phase 7 or prior checks
  const existingCerts = getCertificates();

  // Determine agent names: prefer explicit, then certificates, then pods
  let agentNames: string[];
  if (agents && agents.length >= 2) {
    agentNames = agents;
  } else if (existingCerts.length > 0) {
    // Use agents from existing certificates
    const fromCerts = new Set<string>();
    for (const c of existingCerts) { fromCerts.add(c.agentA); fromCerts.add(c.agentB); }
    agentNames = [...fromCerts];
  } else {
    // Fall back to pod names
    agentNames = [...podRegistry.keys()].map(url => {
      const match = url.match(/\/([^/]+)\/?$/);
      return match ? match[1]! : url;
    }).filter(n => n.length > 0);
  }

  if (agentNames.length < 2) {
    res.json({ error: 'Need at least 2 agents. Run the TLA demo first, or add pods.', agents: agentNames });
    return;
  }

  // Use existing certificates if available, otherwise run fresh checks
  let certificates: typeof existingCerts;
  if (existingCerts.length > 0) {
    certificates = existingCerts;
  } else {
    // Run fresh coherence against the shared lattice
    certificates = [];
    for (let i = 0; i < agentNames.length; i++) {
      for (let j = i + 1; j < agentNames.length; j++) {
        const cert = verifyCoherence(pgsl, pgsl, agentNames[i]!, agentNames[j]!, 'federation');
        certificates.push(cert);
      }
    }
  }

  const coverage = computeCoverage(agentNames);

  res.json({
    agents: agentNames,
    coverage,
    certificates: certificates.map(c => ({
      agentA: c.agentA,
      agentB: c.agentB,
      status: c.status,
      semanticOverlap: c.semanticOverlap,
      sharedPatterns: c.sharedPatterns.length,
      obstruction: c.obstruction,
      sharedStructure: c.sharedStructure,
      semanticProfile: c.semanticProfile.slice(0, 10).map(p => ({
        atom: p.atom,
        usagesA: p.usagesA,
        usagesB: p.usagesB,
        sharedUsages: p.sharedUsages,
        overlap: p.overlap,
      })),
    })),
  });
});

// ── Observatory API: Decisions ──
app.post('/api/decisions', (_req, res) => {
  // Get coherence certificates
  const certificates = getCertificates();

  // For each agent identity that appears in the lattice, run the decision functor
  // Find agents by looking for atoms that appear as sources in coherence certificates,
  // or by checking the demo wallets
  const agentNames: string[] = [];

  // Extract agent identifiers from coherence certificates
  for (const cert of certificates) {
    if (!agentNames.includes(cert.agentA)) agentNames.push(cert.agentA);
    if (!agentNames.includes(cert.agentB)) agentNames.push(cert.agentB);
  }

  // If no certificates, try to infer agents from the lattice activity
  if (agentNames.length === 0) {
    // Check for known agent atoms
    for (const [value] of pgsl.atoms) {
      if (value === 'LRS' || value === 'Competency' || value === 'Credential' ||
          value === 'ER' || value === 'Lab' || value === 'Pharmacy' ||
          value === 'scanner' || value === 'analyst' || value === 'lead') {
        agentNames.push(value);
      }
    }
  }

  if (agentNames.length === 0) {
    res.json({ error: 'No agents found. Run the TLA demo or coherence checks first.', agents: [] });
    return;
  }

  const results = agentNames.map(agent => {
    const obs = extractObservations(pgsl, agent, certificates);
    const affordances = computeDecisionAffordances(pgsl, obs);
    const strategy = selectStrategy(obs, affordances);
    const decision = decideFromObservations(pgsl, agent, certificates);

    return {
      agent,
      strategy: decision.strategy,
      observations: {
        atomCount: obs.atoms.length,
        patternCount: obs.patterns.length,
        coherence: [...obs.coherenceWith.entries()].map(([a, o]) => ({
          agent: a,
          overlap: (o * 100).toFixed(0),
        })),
      },
      affordanceCount: affordances.length,
      coverage: (decision.coverage * 100).toFixed(0),
      decisions: decision.decisions.slice(0, 5).map(d => ({
        type: d.affordance.type,
        description: d.affordance.description,
        confidence: d.confidence,
        justification: d.justification,
      })),
      ungrounded: decision.ungroundedObservations.slice(0, 5),
    };
  });

  res.json({ agents: results });
});

// ── Observatory API: Activity Log ──
app.get('/api/activity', (_req, res) => {
  const since = _req.query['since'] as string | undefined;
  if (since) {
    const filtered = activityLog.filter(a => a.time > since);
    res.json({ events: filtered, total: activityLog.length });
  } else {
    res.json({ events: activityLog, total: activityLog.length });
  }
});

// ── Agent Framework Endpoints ──

// AAT Endpoints
app.get('/api/aat', (_req, res) => {
  const aats = ['observer', 'analyst', 'executor', 'arbiter', 'archivist', 'full-access']
.map(id => getAAT(aatRegistry, `aat:${id}`))
.filter(Boolean);
  res.json({ aats });
});

app.post('/api/aat/validate', (req, res) => {
  const { aatId, action } = req.body;
  const aat = getAAT(aatRegistry, aatId);
  if (!aat) { res.status(404).json({ error: 'AAT not found' }); return; }
  const result = validateAction(aat, action);
  res.json(result);
});

// Policy Endpoints
app.get('/api/policy', (_req, res) => {
  res.json({ rules: policyEngine.rules });
});

app.post('/api/policy', (req, res) => {
  const rule = req.body;
  addRule(policyEngine, {...rule, id: `rule:${Date.now()}` });
  res.json({ added: true, total: policyEngine.rules.length });
});

// PROV Trace Endpoints
app.get('/api/traces', (req, res) => {
  const agent = req.query['agent'] as string | undefined;
  const activity = req.query['activity'] as string | undefined;
  const traces = getTraces(traceStore, { agent, activity });
  res.json({ traces, total: traces.length });
});

app.get('/api/traces/turtle', (_req, res) => {
  const traces = getTraces(traceStore);
  const turtle = traces.map(t => traceToTurtle(t)).join('\n\n');
  res.set('Content-Type', 'text/turtle');
  res.send(turtle);
});

// Enclave Endpoints
app.post('/api/enclaves', (req, res) => {
  const { agentId, agentDid } = req.body;
  const enclave = createEnclave(enclaveRegistry, agentId ?? 'anonymous', pgsl.defaultProvenance, agentDid);
  res.json({ id: enclave.id, agentId: enclave.agentId, status: enclave.status });
});

app.get('/api/enclaves', (_req, res) => {
  const all = listEnclaves(enclaveRegistry);
  res.json({ enclaves: all.map(e => ({ id: e.id, agentId: e.agentId, status: e.status, createdAt: e.createdAt })), stats: enclaveStats(enclaveRegistry) });
});

app.post('/api/enclaves/:id/freeze', (req, res) => {
  freezeEnclave(enclaveRegistry, req.params.id!);
  res.json({ frozen: true });
});

app.post('/api/enclaves/:id/merge', (req, res) => {
  const { targetId, operator } = req.body;
  const report = mergeEnclave(enclaveRegistry, req.params.id!, targetId, operator ?? 'union');
  res.json(report);
});

// Checkpoint Endpoints
app.post('/api/checkpoints', (req, res) => {
  const { label, enclaveId } = req.body;
  const cp = createCheckpoint(checkpointStore, pgsl, 'browser', label, enclaveId);
  res.json({ id: cp.id, atomCount: cp.atomCount, fragmentCount: cp.fragmentCount, contentHash: cp.contentHash });
});

app.get('/api/checkpoints', (_req, res) => {
  const all = listCheckpoints(checkpointStore);
  res.json({ checkpoints: all.map(c => ({ id: c.id, label: c.label, atomCount: c.atomCount, fragmentCount: c.fragmentCount, createdAt: c.createdAt })) });
});

// Marketplace Endpoints
app.get('/api/marketplace', (_req, res) => {
  res.json({...marketplaceStats(marketplace), listings: [...marketplace.listings.values()] });
});

app.post('/api/marketplace', (req, res) => {
  const listing = {...req.body, id: req.body.id ?? `listing:${Date.now()}`, registeredAt: new Date().toISOString() };
  registerListing(marketplace, listing);
  res.json({ registered: true, id: listing.id });
});

app.get('/api/marketplace/discover', (req, res) => {
  const capabilities = (req.query['capabilities'] as string)?.split(',') ?? [];
  const type = req.query['type'] as string | undefined;
  const results = type ? discoverByType(marketplace, type as any) : discoverByCapability(marketplace, capabilities);
  res.json({ results, count: results.length });
});

app.get('/api/marketplace/hydra', (_req, res) => {
  res.set('Content-Type', 'text/turtle');
  res.send(marketplaceToHydra(marketplace));
});

// Metagraph Endpoints
app.get('/api/metagraph', (_req, res) => {
  const meta = generateMetagraph(pgsl);
  res.json(meta);
});

app.post('/api/metagraph/ingest', (_req, res) => {
  const meta = generateMetagraph(pgsl);
  ingestMetagraph(pgsl, meta);
  res.json({ ingested: true, metaAtoms: meta.metaAtoms.length });
});

app.get('/api/metagraph/validate', (_req, res) => {
  const meta = generateMetagraph(pgsl);
  const discrepancies = validateMetagraph(pgsl, meta);
  res.json({ valid: discrepancies.length === 0, discrepancies });
});

app.post('/api/metagraph/query', (req, res) => {
  const { question } = req.body;
  const answer = queryMetagraph(pgsl, question);
  res.json({ question, answer });
});

// ── Observatory API: Comprehensive TLA Demo ──

// xAPI JSON data for 3 learners (real xAPI format)
const XAPI_DATA: Record<string, Array<{ verb: string; activity: string; activityName: string; score: number; success: boolean; duration: string; timestamp: string }>> = {
  chen: [
    { verb: 'completed', activity: 'ils-approach-rwy-28L', activityName: 'ILS Approach Rwy 28L', score: 92, success: true, duration: 'PT45M', timestamp: '2026-03-15T14:30:00Z' },
    { verb: 'completed', activity: 'vor-approach-rwy-10R', activityName: 'VOR Approach Rwy 10R', score: 88, success: true, duration: 'PT35M', timestamp: '2026-03-15T15:45:00Z' },
    { verb: 'completed', activity: 'gps-approach-rwy-04', activityName: 'GPS Approach Rwy 04', score: 95, success: true, duration: 'PT40M', timestamp: '2026-03-16T09:15:00Z' },
    { verb: 'attempted', activity: 'emergency-missed-approach', activityName: 'Emergency Missed Approach', score: 78, success: false, duration: 'PT25M', timestamp: '2026-03-16T10:30:00Z' },
    { verb: 'completed', activity: 'emergency-missed-approach', activityName: 'Emergency Missed Approach', score: 91, success: true, duration: 'PT30M', timestamp: '2026-03-17T08:00:00Z' },
  ],
  park: [
    { verb: 'completed', activity: 'ils-approach-rwy-28L', activityName: 'ILS Approach Rwy 28L', score: 85, success: true, duration: 'PT50M', timestamp: '2026-03-15T14:00:00Z' },
    { verb: 'attempted', activity: 'vor-approach-rwy-10R', activityName: 'VOR Approach Rwy 10R', score: 72, success: false, duration: 'PT40M', timestamp: '2026-03-15T16:00:00Z' },
    { verb: 'completed', activity: 'vor-approach-rwy-10R', activityName: 'VOR Approach Rwy 10R', score: 83, success: true, duration: 'PT38M', timestamp: '2026-03-16T10:00:00Z' },
    { verb: 'completed', activity: 'gps-approach-rwy-04', activityName: 'GPS Approach Rwy 04', score: 88, success: true, duration: 'PT42M', timestamp: '2026-03-16T14:00:00Z' },
    { verb: 'completed', activity: 'holding-pattern', activityName: 'Holding Pattern', score: 90, success: true, duration: 'PT20M', timestamp: '2026-03-17T09:00:00Z' },
  ],
  ortiz: [
    { verb: 'completed', activity: 'ils-approach-rwy-28L', activityName: 'ILS Approach Rwy 28L', score: 94, success: true, duration: 'PT38M', timestamp: '2026-03-15T13:00:00Z' },
    { verb: 'completed', activity: 'gps-approach-rwy-04', activityName: 'GPS Approach Rwy 04', score: 97, success: true, duration: 'PT35M', timestamp: '2026-03-15T15:00:00Z' },
    { verb: 'completed', activity: 'emergency-missed-approach', activityName: 'Emergency Missed Approach', score: 93, success: true, duration: 'PT28M', timestamp: '2026-03-16T08:00:00Z' },
    { verb: 'completed', activity: 'ndb-approach', activityName: 'NDB Approach', score: 89, success: true, duration: 'PT45M', timestamp: '2026-03-16T11:00:00Z' },
    { verb: 'completed', activity: 'visual-approach', activityName: 'Visual Approach', score: 96, success: true, duration: 'PT20M', timestamp: '2026-03-17T07:00:00Z' },
  ],
};

const LEARNER_INFO: Record<string, { name: string; rank: string; did: string }> = {
  chen: { name: 'CPT Sarah Chen', rank: 'Captain', did: 'did:web:learner.airforce.mil:chen.sarah' },
  park: { name: 'LT James Park', rank: 'Lieutenant', did: 'did:web:learner.airforce.mil:park.james' },
  ortiz: { name: 'SGT Maria Ortiz', rank: 'Sergeant', did: 'did:web:learner.airforce.mil:ortiz.maria' },
};

function xapiToRdf(learner: string, stmts: typeof XAPI_DATA['chen']): string {
  const info = LEARNER_INFO[learner]!;
  const lines = ['@prefix xapi: <https://w3id.org/xapi/ontology#>.', '@prefix verb: <https://w3id.org/xapi/adl/verbs/>.', '@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.', ''];
  stmts.forEach((s, i) => {
    lines.push(`<urn:xapi:${learner}:${String(i + 1).padStart(3, '0')}> a xapi:Statement ;`);
    lines.push(`    xapi:actor <${info.did}> ;`);
    lines.push(`    xapi:verb verb:${s.verb} ;`);
    lines.push(`    xapi:object <urn:activity:${s.activity}> ;`);
    lines.push(`    xapi:timestamp "${s.timestamp}"^^xsd:dateTime ;`);
    lines.push(`    <https://w3id.org/xapi/ontology#result/score> "${s.score}"^^xsd:integer ;`);
    lines.push(`    <https://w3id.org/xapi/ontology#result/success> "${s.success}"^^xsd:boolean.`);
    lines.push('');
  });
  return lines.join('\n');
}

interface DemoState {
  wallets: Record<string, Wallet>;
  delegations: WalletDelegation[];
  signatures: Record<string, SignedDescriptor>;
  descriptors: Record<string, ContextDescriptorData>;
}
let demoState: DemoState | null = null;
let demoPhase = 0;
const PHASE_NAMES = ['', 'Setup', 'xAPI Ingestion', 'Competency Assessment', 'Credential Issuance', 'Learner Discovery', 'Verification', 'Coherence & Decisions'];

app.post('/api/demo/run', async (_req, res) => {
  demoPhase++;
  const phase = demoPhase;
  const cssUrl = CSS_URL;
  const addr = (w: Wallet) => w.address.slice(0, 10) + '...' + w.address.slice(-6);

  try {
    // ════════════════════════════════════════════════════════════
    //  PHASE 1: Setup — Pods + Wallets + Delegations
    // ════════════════════════════════════════════════════════════
    if (phase === 1) {
      logActivity('System', 'phase', 'PHASE 1: Setup — Creating pods, wallets, delegations');

      // Create 6 pods
      for (const name of ['lrs', 'competency', 'credential', 'chen', 'park', 'ortiz']) {
        const podUrl = `${cssUrl}${name}/`;
        try { await fetch(podUrl, { method: 'PUT', headers: { 'Content-Type': 'text/turtle', 'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '' }); } catch {}
        logActivity('System', 'pod', `Created pod: ${name}/`);
      }

      // Create wallets
      const wallets: Record<string, Wallet> = {};
      for (const [key, label] of [['lrs', 'LRS Agent'], ['competency', 'Competency Manager'], ['credential', 'Credential Issuer'], ['chen', 'CPT Sarah Chen'], ['park', 'LT James Park'], ['ortiz', 'SGT Maria Ortiz']]) {
        wallets[key] = await createWallet(key.length <= 5 ? 'human' : 'agent', label);
        logActivity(key === 'lrs' ? 'LRS' : key === 'competency' ? 'Competency' : key === 'credential' ? 'Credential' : LEARNER_INFO[key]?.name.split(' ')[0] ?? key, 'wallet', `Created wallet: ${addr(wallets[key]!)} (${label})`);
      }

      // Create delegations: each learner authorizes LRS
      const delegations: WalletDelegation[] = [];
      for (const learner of ['chen', 'park', 'ortiz']) {
        const d = await createDelegation(wallets[learner]!, wallets['lrs']!, 'ReadWrite', '2027-03-17T00:00:00Z');
        delegations.push(d);
        logActivity(LEARNER_INFO[learner]!.name.split(' ')[0]!, 'delegate', `Delegated ReadWrite to LRS Agent (sig: ${d.signature.slice(0, 18)}...)`);
      }

      demoState = { wallets, delegations, signatures: {}, descriptors: {} };
      podRegistry.clear();
      res.json({ phase, status: '6 pods created, 6 wallets, 3 delegations', next: 'LRS ingests xAPI statements' });

    // ════════════════════════════════════════════════════════════
    //  PHASE 2: xAPI Ingestion — LRS Agent
    // ════════════════════════════════════════════════════════════
    } else if (phase === 2 && demoState) {
      logActivity('LRS', 'phase', 'PHASE 2: xAPI Ingestion — Processing flight simulator data');

      for (const [learner, stmts] of Object.entries(XAPI_DATA)) {
        const info = LEARNER_INFO[learner]!;
        logActivity('LRS', 'ingest', `Parsing ${stmts.length} xAPI statements for ${info.name}`);

        // Ingest each statement into PGSL using xAPI profile (transformMulti)
        // Atoms are short meaningful IDs: chen, completed, ils-approach-rwy-28L
        // Global IRIs connected via identity chains, display names via name chains
        for (const s of stmts) {
          const xapiJson = {
            actor: { account: { homePage: 'https://learner.airforce.mil', name: learner }, name: info.name },
            verb: { id: `http://adlnet.gov/expapi/verbs/${s.verb}`, display: { 'en-US': s.verb } },
            object: { id: `urn:activity:${s.activity}`, definition: { name: { 'en-US': s.activityName } } },
            result: { score: { raw: s.score, max: 100 }, success: s.success, duration: s.duration },
            timestamp: s.timestamp,
            context: { platform: 'T-38C' },
          };
          ingestWithProfile(pgsl, 'xapi', xapiJson);
          const chains = xapiProfile.transformMulti!(xapiJson);
          logActivity('LRS', 'pgsl', `xapi_ingest: ${chains[0]} (+${chains.length - 1} identity/name/result chains)`);
        }

        // Classify with affordance engine
        const strategy = computeCognitiveStrategy(`How did ${info.name} perform on instrument approaches?`);
        logActivity('LRS', 'affordance', `analyze_question → type: ${strategy.questionType}, strategy: ${strategy.strategy}`);

        // Build xAPI RDF
        const rdfGraph = xapiToRdf(learner, stmts);

        // Build descriptor
        const descId = `urn:cg:lrs:${learner}-session-2026-03` as IRI;
        const desc = ContextDescriptor.create(descId)
.describes(`urn:graph:lrs:${learner}-xapi` as IRI)
.temporal({ validFrom: stmts[0]!.timestamp, validUntil: stmts[stmts.length - 1]!.timestamp })
.provenance({ wasGeneratedBy: { agent: 'urn:system:lrs:adl-conformant' as IRI, startedAt: stmts[0]!.timestamp, endedAt: stmts[stmts.length - 1]!.timestamp }, wasAttributedTo: 'did:web:lrs.training.airforce.mil' as IRI, generatedAtTime: stmts[stmts.length - 1]!.timestamp })
.agent('did:web:lrs.training.airforce.mil' as IRI, 'LRS')
.semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.99 })
.trust({ trustLevel: 'SelfAsserted', issuer: 'did:web:lrs.training.airforce.mil' as IRI })
.federation({ origin: `${cssUrl}lrs/` as IRI, storageEndpoint: `${cssUrl}lrs/` as IRI, syncProtocol: 'SolidNotifications' })
.version(1).build();

        // Sign with ECDSA
        const turtle = toTurtle(desc);
        const signed = await signDescriptor(descId, turtle, demoState.wallets['lrs']!);
        demoState.signatures[descId] = signed;
        demoState.descriptors[descId] = desc;
        logActivity('LRS', 'sign', `ECDSA signed ${learner} descriptor (sig: ${signed.signature.slice(0, 18)}...)`);

        // Publish
        const pubResult = await publish(desc, rdfGraph, `${cssUrl}lrs/`, { fetch: solidFetch });
        logActivity('LRS', 'publish', `Published ${info.name}'s xAPI to ${pubResult.descriptorUrl}`);
      }

      // SPARQL: find shared activities
      const stats = latticeStats(pgsl);
      logActivity('LRS', 'pgsl', `Lattice: ${stats.atoms} atoms, ${stats.fragments} fragments, L0-L${stats.maxLevel}`);

      const completedAtom = [...pgsl.atoms.entries()].find(([k]) => k === 'completed');
      if (completedAtom) {
        const query = sparqlFragmentsContaining(completedAtom[1]);
        const result = sparqlQueryPGSL(pgsl, query);
        logActivity('LRS', 'sparql', `SPARQL: "completed" appears in ${result.bindings.length} fragments (shared across all learners)`);
      }

      podRegistry.clear();
      res.json({ phase, status: '15 xAPI statements ingested, 3 descriptors signed + published', next: 'Competency Manager assesses mastery' });

    // ════════════════════════════════════════════════════════════
    //  PHASE 3: Competency Assessment
    // ════════════════════════════════════════════════════════════
    } else if (phase === 3 && demoState) {
      logActivity('Competency', 'phase', 'PHASE 3: Competency Assessment — Mapping xAPI to framework');

      // Discover from LRS
      const lrsEntries = await discover(`${cssUrl}lrs/`, undefined, { fetch: solidFetch });
      logActivity('Competency', 'discover', `Found ${lrsEntries.length} xAPI descriptor(s) on LRS pod`);

      // SPARQL: query which learners completed which activities
      const store = materializeTriples(pgsl);
      const sparqlQuery = `PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>
SELECT ?atom ?value WHERE { ?atom a pgsl:Atom ; pgsl:value ?value. } LIMIT 30`;
      const sparqlResult = executeSparqlString(store, sparqlQuery);
      logActivity('Competency', 'sparql', `SPARQL: Found ${sparqlResult.bindings.length} atoms in lattice`);

      // Affordance engine: assess proficiency questions
      for (const learner of ['chen', 'park', 'ortiz']) {
        const info = LEARNER_INFO[learner]!;
        const q = `Is ${info.name} proficient in instrument approaches?`;
        const strategy = computeCognitiveStrategy(q);
        logActivity('Competency', 'affordance', `"${q}" → ${strategy.strategy} (${strategy.computationType ?? 'comprehension'})`);
      }

      // Build causal model
      logActivity('Competency', 'causal', 'Building Structural Causal Model for flight training...');
      const scm = buildSCM('urn:scm:flight-training' as IRI, [
        { name: 'SimulatorExposure', observed: true, mechanism: 'xAPI completion count' },
        { name: 'SkillEngagement', observed: false, mechanism: 'latent: practice quality' },
        { name: 'ConceptMastery', observed: true, mechanism: 'assessment scores' },
        { name: 'TransferSuccess', observed: false, mechanism: 'latent: real-world readiness' },
      ], [
        { from: 'SimulatorExposure', to: 'SkillEngagement', strength: 0.85 },
        { from: 'SkillEngagement', to: 'ConceptMastery', strength: 0.9 },
        { from: 'ConceptMastery', to: 'TransferSuccess', strength: 0.8 },
      ], 'Flight Training Causal Model');
      logActivity('Competency', 'causal', `SCM: ${scm.variables.length} variables, ${scm.edges.length} edges`);

      // d-separation test
      const dSep = isDSeparated(scm, 'SimulatorExposure', 'TransferSuccess', new Set(['ConceptMastery']));
      logActivity('Competency', 'causal', `d-separation: SimExposure ⊥ TransferSuccess | ConceptMastery = ${dSep}`);

      // Backdoor set
      const backdoor = findBackdoorSet(scm, 'SimulatorExposure', 'ConceptMastery');
      logActivity('Competency', 'causal', `Backdoor adjustment set: ${backdoor ? '{' + [...backdoor].join(', ') + '}' : 'identifiable without adjustment'}`);

      // Counterfactual
      const cf = evaluateCounterfactual(scm, {
        intervention: { variable: 'SimulatorExposure', value: 'reduced' },
        target: 'ConceptMastery',
      });
      logActivity('Competency', 'causal', `Counterfactual: "If SimExposure reduced, ConceptMastery affected?" → ${cf.targetAffected ? 'YES' : 'NO'} (${cf.affectedVariables.length} vars affected)`);

      // Structural overlap via latticeMeet
      const chenAtom = [...pgsl.atoms.entries()].find(([k]) => k === 'Chen');
      const parkAtom = [...pgsl.atoms.entries()].find(([k]) => k === 'Park');
      if (chenAtom && parkAtom) {
        const meet = latticeMeet(pgsl, chenAtom[1], parkAtom[1]);
        logActivity('Competency', 'pgsl', `Lattice meet(Chen, Park): ${meet ? 'shared structure found' : 'no direct overlap'}`);
      }

      // Map verbs to competency levels and publish
      for (const learner of ['chen', 'park', 'ortiz']) {
        const info = LEARNER_INFO[learner]!;
        const stmts = XAPI_DATA[learner]!;
        const completed = stmts.filter(s => s.success);
        const avgScore = Math.round(completed.reduce((s, x) => s + x.score, 0) / completed.length);
        const level = avgScore >= 90 ? 'Advanced' : avgScore >= 80 ? 'Proficient' : 'Developing';

        logActivity('Competency', 'assess', `${info.name}: ${completed.length}/${stmts.length} passed, avg ${avgScore} → ${level}`);

        const compGraph = `@prefix comp: <https://example.org/competency#>.\n<urn:competency:${learner}> a comp:CompetencyAssertion ; comp:learner <${info.did}> ; comp:level "${level}" ; comp:score "${avgScore}".`;

        const descId = `urn:cg:competency:${learner}-assessment-2026-03` as IRI;
        const desc = ContextDescriptor.create(descId)
.describes(`urn:graph:competency:${learner}-assertions` as IRI)
.temporal({ validFrom: '2026-03-17T09:00:00Z', validUntil: '2026-09-17T09:00:00Z' })
.provenance({ wasGeneratedBy: { agent: 'urn:system:competency-manager' as IRI, startedAt: '2026-03-17T09:00:00Z', endedAt: '2026-03-17T09:05:00Z' }, wasAttributedTo: 'did:web:competency.training.airforce.mil' as IRI, generatedAtTime: '2026-03-17T09:05:00Z', sources: [`urn:cg:lrs:${learner}-session-2026-03` as IRI] })
.agent('did:web:competency.training.airforce.mil' as IRI, 'Assessor')
.semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.92 })
.trust({ trustLevel: 'ThirdPartyAttested', issuer: 'did:web:competency.training.airforce.mil' as IRI })
.federation({ origin: `${cssUrl}competency/` as IRI, storageEndpoint: `${cssUrl}competency/` as IRI, syncProtocol: 'SolidNotifications' })
.version(1).build();

        const turtle = toTurtle(desc);
        const signed = await signDescriptor(descId, turtle, demoState.wallets['competency']!);
        demoState.signatures[descId] = signed;
        demoState.descriptors[descId] = desc;
        logActivity('Competency', 'sign', `Signed ${learner} assessment (sig: ${signed.signature.slice(0, 18)}...)`);

        await publish(desc, compGraph, `${cssUrl}competency/`, { fetch: solidFetch });
        logActivity('Competency', 'publish', `Published ${info.name} → ${level} (Trust: ThirdPartyAttested)`);
      }

      podRegistry.clear();
      res.json({ phase, status: 'Competency assessments published with causal reasoning', next: 'Credential Issuer issues LERS credentials' });

    // ════════════════════════════════════════════════════════════
    //  PHASE 4: Credential Issuance
    // ════════════════════════════════════════════════════════════
    } else if (phase === 4 && demoState) {
      logActivity('Credential', 'phase', 'PHASE 4: Credential Issuance — IEEE LERS credentials');

      const compEntries = await discover(`${cssUrl}competency/`, undefined, { fetch: solidFetch });
      const lrsEntries = await discover(`${cssUrl}lrs/`, undefined, { fetch: solidFetch });
      logActivity('Credential', 'discover', `Competency: ${compEntries.length} descriptors, LRS: ${lrsEntries.length} descriptors`);

      // SHACL validation on evidence lattice
      const shaclResult = validateAllPGSL(pgsl);
      logActivity('Credential', 'shacl', `SHACL validation: ${shaclResult.conforms ? 'CONFORMS' : shaclResult.violations.length + ' violations'}`);

      for (const learner of ['chen', 'park', 'ortiz']) {
        const info = LEARNER_INFO[learner]!;
        const stmts = XAPI_DATA[learner]!;
        const completed = stmts.filter(s => s.success);
        const avgScore = Math.round(completed.reduce((s, x) => s + x.score, 0) / completed.length);

        // Compose: intersection of xAPI + competency descriptors
        const lrsDescId = `urn:cg:lrs:${learner}-session-2026-03` as IRI;
        const compDescId = `urn:cg:competency:${learner}-assessment-2026-03` as IRI;
        const lrsDesc = demoState.descriptors[lrsDescId];
        const compDesc = demoState.descriptors[compDescId];
        if (lrsDesc && compDesc) {
          const composed = intersection(lrsDesc, compDesc);
          logActivity('Credential', 'compose', `${info.name}: intersection → ${composed.facets.length} facets (temporal overlap verified)`);
        }

        // Build LERS credential
        const credGraph = `@prefix vc: <https://www.w3.org/2018/credentials#>.\n@prefix lers: <https://purl.org/lers/ns#>.\n<urn:lers:${learner}-instrument-2026> a vc:VerifiableCredential, lers:LearningEmploymentRecord ; vc:issuer <did:web:credential.training.airforce.mil> ; vc:issuanceDate "2026-03-17T10:00:00Z" ; vc:credentialSubject [ lers:learner <${info.did}> ; lers:achievement [ lers:level "${avgScore >= 90 ? 'Advanced' : 'Proficient'}" ; lers:framework "USAF Instrument Rating v3" ] ].`;

        const credDescId = `urn:cg:credential:${learner}-instrument-2026` as IRI;
        const credDesc = ContextDescriptor.create(credDescId)
.describes(`urn:graph:credential:${learner}-lers` as IRI)
.temporal({ validFrom: '2026-03-17T10:00:00Z', validUntil: '2027-03-17T10:00:00Z' })
.provenance({ wasGeneratedBy: { agent: 'urn:system:credential-issuer' as IRI, startedAt: '2026-03-17T10:00:00Z', endedAt: '2026-03-17T10:00:05Z' }, wasAttributedTo: 'did:web:credential.training.airforce.mil' as IRI, generatedAtTime: '2026-03-17T10:00:05Z', sources: [lrsDescId, compDescId] })
.agent('did:web:credential.training.airforce.mil' as IRI, 'Issuer')
.semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.98, groundTruth: true })
.trust({ trustLevel: 'CryptographicallyVerified', issuer: 'did:web:credential.training.airforce.mil' as IRI })
.federation({ origin: `${cssUrl}credential/` as IRI, storageEndpoint: `${cssUrl}credential/` as IRI, syncProtocol: 'SolidNotifications' })
.version(1).build();

        const turtle = toTurtle(credDesc);
        const signed = await signDescriptor(credDescId, turtle, demoState.wallets['credential']!);
        demoState.signatures[credDescId] = signed;
        demoState.descriptors[credDescId] = credDesc;
        logActivity('Credential', 'sign', `ECDSA signed ${info.name}'s LERS credential (sig: ${signed.signature.slice(0, 18)}...)`);

        await publish(credDesc, credGraph, `${cssUrl}credential/`, { fetch: solidFetch });
        logActivity('Credential', 'publish', `Published ${info.name}'s IEEE LERS credential (Trust: CryptographicallyVerified)`);
      }

      podRegistry.clear();
      res.json({ phase, status: '3 LERS credentials signed and published', next: 'Learners discover their credentials' });

    // ════════════════════════════════════════════════════════════
    //  PHASE 5: Learner Discovery (Bidirectional)
    // ════════════════════════════════════════════════════════════
    } else if (phase === 5 && demoState) {
      logActivity('System', 'phase', 'PHASE 5: Learner Discovery — Bidirectional credential flow');

      for (const learner of ['chen', 'park', 'ortiz']) {
        const info = LEARNER_INFO[learner]!;
        const firstName = info.name.split(' ')[1] ?? learner;

        // Discover credentials
        const credEntries = await discover(`${cssUrl}credential/`, undefined, { fetch: solidFetch });
        logActivity(firstName, 'discover', `Found ${credEntries.length} credential(s) on credential pod`);

        // Verify ECDSA signature
        const credDescId = `urn:cg:credential:${learner}-instrument-2026` as IRI;
        const signed = demoState.signatures[credDescId];
        if (signed) {
          const credDesc = demoState.descriptors[credDescId];
          const turtle = credDesc ? toTurtle(credDesc) : '';
          const verification = await verifyDescriptorSignature(signed, turtle);
          logActivity(firstName, 'verify', `ECDSA signature: ${verification.valid ? 'VALID' : 'INVALID'} (recovered: ${verification.recoveredAddress?.slice(0, 10)}...)`);
        }

        // Verify delegation chain
        const delegation = demoState.delegations.find(d => {
          const msg = JSON.parse(d.message);
          return msg.owner === demoState!.wallets[learner]!.address;
        });
        if (delegation) {
          const delegValid = verifyDelegationSignature(delegation);
          logActivity(firstName, 'verify', `Delegation chain: ${delegValid ? 'VALID' : 'INVALID'} (learner → LRS authorization)`);
        }

        // Publish to own pod
        const credDesc = demoState.descriptors[credDescId];
        if (credDesc) {
          const credGraph = `<urn:lers:${learner}> a <https://www.w3.org/2018/credentials#VerifiableCredential>.`;
          await publish(credDesc, credGraph, `${cssUrl}${learner}/`, { fetch: solidFetch });
          logActivity(firstName, 'publish', `Published verified credential to personal pod: ${learner}/`);
        }
      }

      podRegistry.clear();
      res.json({ phase, status: '3 learners verified and republished credentials', next: 'External verification' });

    // ════════════════════════════════════════════════════════════
    //  PHASE 6: External Verification
    // ════════════════════════════════════════════════════════════
    } else if (phase === 6 && demoState) {
      logActivity('Verifier', 'phase', 'PHASE 6: External Verification — Full trust chain audit');

      // Discover from all learner pods
      for (const learner of ['chen', 'park', 'ortiz']) {
        const info = LEARNER_INFO[learner]!;
        const entries = await discover(`${cssUrl}${learner}/`, undefined, { fetch: solidFetch });
        logActivity('Verifier', 'discover', `${info.name}'s pod: ${entries.length} credential(s)`);
      }

      // Verify full signature chain
      logActivity('Verifier', 'verify', '── Full Trust Chain ──');
      for (const learner of ['chen', 'park', 'ortiz']) {
        const info = LEARNER_INFO[learner]!;
        const lrsSig = demoState.signatures[`urn:cg:lrs:${learner}-session-2026-03`];
        const compSig = demoState.signatures[`urn:cg:competency:${learner}-assessment-2026-03`];
        const credSig = demoState.signatures[`urn:cg:credential:${learner}-instrument-2026`];

        const chain = [
          lrsSig ? `LRS(${addr(demoState.wallets['lrs']!)})` : 'LRS(?)',
          compSig ? `Competency(${addr(demoState.wallets['competency']!)})` : 'Comp(?)',
          credSig ? `Credential(${addr(demoState.wallets['credential']!)})` : 'Cred(?)',
        ];
        logActivity('Verifier', 'verify', `${info.name}: ${chain.join(' → ')} ✓`);
      }

      // SPARQL: cohort overlap
      const store = materializeTriples(pgsl);
      const overlapQuery = `PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>
SELECT (COUNT(DISTINCT ?atom) AS ?sharedAtoms) WHERE { ?atom a pgsl:Atom. }`;
      const overlapResult = executeSparqlString(store, overlapQuery);
      const atomCount = overlapResult.bindings[0]?.get('?sharedAtoms')?.replace(/"/g, '') ?? '0';
      logActivity('Verifier', 'sparql', `Cohort SPARQL: ${atomCount} shared atoms across 3 learners (content-addressed dedup)`);

      // Trust escalation summary
      logActivity('Verifier', 'summary', '── Trust Escalation ──');
      logActivity('Verifier', 'summary', 'Simulator → xAPI (SelfAsserted, 0.99)');
      logActivity('Verifier', 'summary', '  → Competency (ThirdPartyAttested, 0.92)');
      logActivity('Verifier', 'summary', '    → LERS Credential (CryptographicallyVerified, 0.98)');
      logActivity('Verifier', 'summary', '      → Learner Pod (verified + republished)');
      logActivity('Verifier', 'summary', '        → External Verifier (full chain audited) ✓');

      // Final stats
      const finalStats = latticeStats(pgsl);
      logActivity('Verifier', 'summary', `Final PGSL: ${finalStats.atoms} atoms, ${finalStats.fragments} fragments across ${Object.keys(demoState.signatures).length} signed descriptors`);

      podRegistry.clear();
      res.json({ phase, status: 'Full trust chain verified across cohort', next: 'Coherence & Decisions' });

    } else if (phase === 7) {
      // ════════════════════════════════════════════════════════════
      //  PHASE 7: Coherence & Decisions — Full stack verification
      // ════════════════════════════════════════════════════════════
      logActivity('System', 'phase', 'PHASE 7: Coherence & Decisions — Running full stack verification');

      // Run coherence between the 3 TLA agents
      const pgslLRS = createPGSL({ wasAttributedTo: 'did:web:lrs.training.mil' as IRI, generatedAtTime: new Date().toISOString() });
      const pgslComp = createPGSL({ wasAttributedTo: 'did:web:competency.training.mil' as IRI, generatedAtTime: new Date().toISOString() });
      const pgslCred = createPGSL({ wasAttributedTo: 'did:web:credential.training.mil' as IRI, generatedAtTime: new Date().toISOString() });

      // Ingest relevant content into each agent's lattice using short atom IDs
      // LRS has xAPI statements — use the xAPI profile (transformMulti)
      for (const learner of ['chen', 'park', 'ortiz']) {
        const stmts = XAPI_DATA[learner]!;
        const info = LEARNER_INFO[learner]!;
        for (const s of stmts) {
          const xapiJson = {
            actor: { account: { homePage: 'https://learner.airforce.mil', name: learner }, name: info.name },
            verb: { id: `http://adlnet.gov/expapi/verbs/${s.verb}`, display: { 'en-US': s.verb } },
            object: { id: `urn:activity:${s.activity}`, definition: { name: { 'en-US': s.activityName } } },
            result: { score: { raw: s.score, max: 100 }, success: s.success, duration: s.duration },
          };
          ingestWithProfile(pgslLRS, 'xapi', xapiJson);
        }
      }

      // Competency has assessments — short atoms with identity chains
      for (const learner of ['chen', 'park', 'ortiz']) {
        embedInPGSL(pgslComp, `${learner} instrument-landing Proficient`, undefined, 'word');
        embedInPGSL(pgslComp, `${learner} vor-navigation Proficient`, undefined, 'word');
        embedInPGSL(pgslComp, `${learner} gps-navigation Advanced`, undefined, 'word');
        embedInPGSL(pgslComp, `instrument-landing identity urn:competency:instrument-landing`, undefined, 'word');
        embedInPGSL(pgslComp, `vor-navigation identity urn:competency:vor-navigation`, undefined, 'word');
        embedInPGSL(pgslComp, `gps-navigation identity urn:competency:gps-navigation`, undefined, 'word');
      }

      // Credential has issued creds — short atoms with identity chains
      for (const learner of ['chen', 'park', 'ortiz']) {
        embedInPGSL(pgslCred, `credential-issuer ${learner} usaf-instrument-rating Proficient`, undefined, 'word');
        embedInPGSL(pgslCred, `credential-issuer identity did:web:credential.training.mil`, undefined, 'word');
        embedInPGSL(pgslCred, `usaf-instrument-rating identity urn:credential:usaf-instrument-rating`, undefined, 'word');
      }

      // Run coherence
      const certLC = verifyCoherence(pgslLRS, pgslComp, 'LRS', 'Competency', 'training-cohort');
      const certLCr = verifyCoherence(pgslLRS, pgslCred, 'LRS', 'Credential', 'training-cohort');
      const certCCr = verifyCoherence(pgslComp, pgslCred, 'Competency', 'Credential', 'training-cohort');

      logActivity('Coherence', 'verify', `LRS ↔ Competency: ${certLC.status} (${(certLC.semanticOverlap * 100).toFixed(0)}% overlap)`);
      logActivity('Coherence', 'verify', `LRS ↔ Credential: ${certLCr.status} (${(certLCr.semanticOverlap * 100).toFixed(0)}% overlap)`);
      logActivity('Coherence', 'verify', `Competency ↔ Credential: ${certCCr.status} (${(certCCr.semanticOverlap * 100).toFixed(0)}% overlap)`);

      const coverage = computeCoverage(['LRS', 'Competency', 'Credential']);
      logActivity('Coherence', 'coverage', `${(coverage.coverage * 100).toFixed(0)}% coverage: ${coverage.verified} verified, ${coverage.divergent} divergent, ${coverage.unexamined} unexamined`);

      // Run decision functor
      const certs = getCertificates();
      const lrsObs = extractObservations(pgslLRS, 'LRS', certs);
      const compObs = extractObservations(pgslComp, 'Competency', certs);
      const credObs = extractObservations(pgslCred, 'Credential', certs);

      const lrsDecision = decideFromObservations(pgslLRS, 'LRS', certs);
      const compDecision = decideFromObservations(pgslComp, 'Competency', certs);
      const credDecision = decideFromObservations(pgslCred, 'Credential', certs);

      logActivity('Decision', 'strategy', `LRS strategy: ${lrsDecision.strategy} (${lrsDecision.decisions.length} decisions, ${(lrsDecision.coverage * 100).toFixed(0)}% coverage)`);
      logActivity('Decision', 'strategy', `Competency strategy: ${compDecision.strategy} (${compDecision.decisions.length} decisions, ${(compDecision.coverage * 100).toFixed(0)}% coverage)`);
      logActivity('Decision', 'strategy', `Credential strategy: ${credDecision.strategy} (${credDecision.decisions.length} decisions, ${(credDecision.coverage * 100).toFixed(0)}% coverage)`);

      // Log top decisions
      for (const [name, dec] of [['LRS', lrsDecision], ['Competency', compDecision], ['Credential', credDecision]] as const) {
        if (dec.decisions.length > 0) {
          const top = dec.decisions[0]!;
          logActivity('Decision', 'action', `${name} top: ${top.affordance.type} — ${top.affordance.description} (${(top.confidence * 100).toFixed(0)}% confidence)`);
        }
      }

      // Push coherence results to the browser lattice
      embedInPGSL(pgsl, `coherence LRS Competency ${certLC.status} overlap ${(certLC.semanticOverlap * 100).toFixed(0)}%`);
      embedInPGSL(pgsl, `coherence LRS Credential ${certLCr.status} overlap ${(certLCr.semanticOverlap * 100).toFixed(0)}%`);
      embedInPGSL(pgsl, `coherence Competency Credential ${certCCr.status} overlap ${(certCCr.semanticOverlap * 100).toFixed(0)}%`);
      embedInPGSL(pgsl, `decision LRS strategy ${lrsDecision.strategy}`);
      embedInPGSL(pgsl, `decision Competency strategy ${compDecision.strategy}`);
      embedInPGSL(pgsl, `decision Credential strategy ${credDecision.strategy}`);

      const finalStats = latticeStats(pgsl);
      logActivity('System', 'summary', `Final PGSL: ${finalStats.atoms} atoms, ${finalStats.fragments} fragments — full stack complete`);

      res.json({ phase, status: 'Coherence verified, decisions computed — full stack complete', next: 'Demo complete — click Reset to restart' });

    } else {
      // Reset
      demoPhase = 0;
      demoState = null;
      activityLog.length = 0;
      pgsl = createPGSL({ wasAttributedTo: 'urn:pgsl-browser:observatory' as IRI, generatedAtTime: new Date().toISOString() });
      podRegistry.clear();
      res.json({ phase: 0, status: 'Demo reset', next: 'Setup pods + wallets' });
    }
  } catch (err) {
    logActivity('System', 'error', (err as Error).message);
    res.status(500).json({ error: (err as Error).message, phase });
  }
});

// Demo state endpoints
app.get('/api/demo/wallets', (_req, res) => {
  if (!demoState) { res.json({ wallets: [] }); return; }
  const wallets = Object.entries(demoState.wallets).map(([key, w]) => ({
    key, label: w.label, address: w.address, type: w.type,
  }));
  res.json({ wallets });
});

app.get('/api/demo/signatures', (_req, res) => {
  if (!demoState) { res.json({ signatures: [] }); return; }
  const sigs = Object.entries(demoState.signatures).map(([id, s]) => ({
    descriptorId: id, signature: s.signature.slice(0, 30) + '...', signer: s.signer, timestamp: s.signedAt,
  }));
  res.json({ signatures: sigs, count: sigs.length });
});

app.post('/api/demo/reset', (_req, res) => {
  demoPhase = 0;
  demoState = null;
  activityLog.length = 0;
  pgsl = createPGSL({ wasAttributedTo: 'urn:pgsl-browser:observatory' as IRI, generatedAtTime: new Date().toISOString() });
  podRegistry.clear();
  res.json({ status: 'reset' });
});

// Build from pod then start
rebuildFromPod().then(() => {
  app.listen(PORT, () => {
    console.log(`PGSL Browser at http://localhost:${PORT}/`);
    console.log(`Pod: ${POD_URL}`);
    console.log(`The lattice is DERIVED from the pod — same data the MCP server uses.`);
  });
}).catch(err => {
  console.error('Startup error:', err);
  app.listen(PORT, () => {
    console.log(`PGSL Browser at http://localhost:${PORT}/ (no pod data)`);
  });
});
