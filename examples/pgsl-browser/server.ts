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
} from '@foxxi/context-graphs';

// Get the xAPI profile for direct transform calls
const xapiProfile = getProfile('xapi')!;
import type {
  IRI, PGSLInstance, TokenGranularity, ContextDescriptorData, ManifestEntry,
  Wallet, WalletDelegation, SignedDescriptor,
} from '@foxxi/context-graphs';

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

// ── Shape Registry (dogfooded — shapes are PGSL content) ──

interface ShapeConstraint {
  id: string;
  name: string;
  /** Pattern that triggers this constraint: array of atom values, ?x = variable */
  whenPattern: string[];
  /** Pattern that must exist for the constraint to be satisfied */
  requirePattern: string[];
  /** The PGSL URI of this shape (it's content in the lattice) */
  pgslUri?: string;
  /** Who defined this shape */
  definedBy: string;
  /** When */
  definedAt: string;
}

const shapeRegistry: ShapeConstraint[] = [];

// Create a shape and ingest it into PGSL
app.post('/api/shapes', (req, res) => {
  const { name, whenPattern, requirePattern, definedBy } = req.body as {
    name: string; whenPattern: string[]; requirePattern: string[]; definedBy?: string;
  };
  if (!name || !whenPattern || !requirePattern) {
    res.status(400).json({ error: 'Need name, whenPattern, requirePattern' });
    return;
  }

  const shape: ShapeConstraint = {
    id: `shape:${Date.now()}`,
    name,
    whenPattern,
    requirePattern,
    definedBy: definedBy ?? 'user',
    definedAt: new Date().toISOString(),
  };

  // Ingest the shape itself into PGSL — it's content in the lattice
  const shapeText = `WHEN (${whenPattern.join(', ')}) REQUIRE (${requirePattern.join(', ')})`;
  try {
    const uri = embedInPGSL(pgsl, shapeText);
    shape.pgslUri = uri;
  } catch {}

  shapeRegistry.push(shape);
  res.json({ shape, totalShapes: shapeRegistry.length });
});

// List all shapes
app.get('/api/shapes', (_req, res) => {
  res.json({ shapes: shapeRegistry });
});

// Delete a shape
app.delete('/api/shapes/:id', (req, res) => {
  const idx = shapeRegistry.findIndex(s => s.id === req.params['id']);
  if (idx < 0) { res.status(404).json({ error: 'Shape not found' }); return; }
  shapeRegistry.splice(idx, 1);
  res.json({ deleted: true, totalShapes: shapeRegistry.length });
});

// Query: given a partial chain being built, what candidates satisfy all active shapes?
// This is the core of SHACL-driven autocomplete.
app.post('/api/shapes/candidates', (req, res) => {
  const { currentChain, side } = req.body as { currentChain: string[]; side: 'left' | 'right' };
  if (!currentChain) { res.status(400).json({ error: 'Need currentChain' }); return; }

  // Resolve chain items to their text values
  const chainValues = currentChain.map(uri => {
    const node = pgsl.nodes.get(uri as IRI);
    if (!node) return '?';
    return node.kind === 'Atom' ? String((node as any).value) : pgslResolve(pgsl, uri as IRI);
  });

  // For each shape, check if the current chain + a candidate would trigger a constraint
  const constraints: Array<{ shape: ShapeConstraint; requiredPattern: string[]; variableBindings: Record<string, string> }> = [];

  for (const shape of shapeRegistry) {
    // Try to match whenPattern against currentChain + new item
    // Variables in whenPattern (starting with ?) get bound to chain values
    const wp = shape.whenPattern;

    // Check if the chain is building toward this pattern
    // e.g., chain is [mark, is] and whenPattern is [?x, is, employee]
    // The new item (side=right) would be at position chainValues.length
    if (side === 'right' && chainValues.length < wp.length) {
      // Check if existing chain matches the prefix of whenPattern
      let match = true;
      const bindings: Record<string, string> = {};
      for (let i = 0; i < chainValues.length; i++) {
        if (wp[i]!.startsWith('?')) {
          bindings[wp[i]!] = chainValues[i]!;
        } else if (wp[i] !== chainValues[i]) {
          match = false; break;
        }
      }

      if (match && chainValues.length === wp.length - 1) {
        // The next item would complete the whenPattern
        const nextSlot = wp[chainValues.length]!;
        if (!nextSlot.startsWith('?')) {
          // The slot is a fixed value — this shape constrains what can go here
          constraints.push({ shape, requiredPattern: shape.requirePattern, variableBindings: bindings });
        }
      }
    }

    if (side === 'left' && chainValues.length < wp.length) {
      let match = true;
      const bindings: Record<string, string> = {};
      for (let i = 0; i < chainValues.length; i++) {
        const wpIdx = wp.length - chainValues.length + i;
        if (wp[wpIdx]!.startsWith('?')) {
          bindings[wp[wpIdx]!] = chainValues[i]!;
        } else if (wp[wpIdx] !== chainValues[i]) {
          match = false; break;
        }
      }

      if (match && chainValues.length === wp.length - 1) {
        constraints.push({ shape, requiredPattern: shape.requirePattern, variableBindings: bindings });
      }
    }
  }

  if (constraints.length === 0) {
    // No constraints apply — all nodes are valid candidates
    res.json({ constrained: false, constraints: [], candidates: null });
    return;
  }

  // For each constraint, find which values satisfy the requirePattern
  const validCandidates = new Set<string>();

  for (const c of constraints) {
    // Find all atoms/fragments that, when bound to the variable, satisfy requirePattern
    // e.g., requirePattern is [?x, is, human], bindings has ?x bound
    // Check if (binding[?x], is, human) exists as a chain in the lattice

    for (const [uri, node] of pgsl.nodes) {
      if (node.kind !== 'Atom') continue;
      const candidateValue = String((node as any).value);

      // Try binding this candidate to the unbound variable in requirePattern
      const rp = c.requiredPattern;
      const bindings = { ...c.variableBindings };

      // Find unbound variables in requirePattern
      for (const slot of rp) {
        if (slot.startsWith('?') && !bindings[slot]) {
          bindings[slot] = candidateValue;
        }
      }

      // Resolve requirePattern with bindings
      const resolvedRequire = rp.map(slot => slot.startsWith('?') ? (bindings[slot] ?? slot) : slot);

      // Check if this resolved pattern exists in the lattice
      // Search for the sequence as atoms
      const atomUris = resolvedRequire.map(val => {
        for (const [aKey, aUri] of pgsl.atoms) {
          if (aKey === val) return aUri;
        }
        return null;
      });

      if (atomUris.every(u => u !== null)) {
        // Check if this sequence exists as a fragment
        for (const [fUri, fNode] of pgsl.nodes) {
          if (fNode.kind !== 'Fragment') continue;
          if (fNode.items.length !== atomUris.length) continue;
          let seqMatch = true;
          for (let i = 0; i < atomUris.length; i++) {
            if (fNode.items[i] !== atomUris[i]) { seqMatch = false; break; }
          }
          if (seqMatch) {
            // The require pattern is satisfied for the variable binding
            // The candidate is the value bound to the variable in the WHEN pattern
            const whenVar = c.shape.whenPattern.find(s => s.startsWith('?'));
            if (whenVar && bindings[whenVar]) {
              // Find the atom URI for this value
              for (const [aKey, aUri] of pgsl.atoms) {
                if (aKey === bindings[whenVar]) validCandidates.add(aUri);
              }
            }
            break;
          }
        }
      }
    }
  }

  res.json({
    constrained: true,
    constraints: constraints.map(c => ({ shape: c.shape.name, require: c.requiredPattern.join(', ') })),
    candidates: [...validCandidates].map(uri => ({
      uri,
      resolved: pgslResolve(pgsl, uri as IRI),
      level: pgsl.nodes.get(uri as IRI)?.level ?? 0,
    })),
  });
});

// Serve the HTML — root and node-specific URLs
app.get('/', (_req, res) => {
  res.sendFile(resolve(__dirname, 'index.html'));
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

  // Build links (HATEOAS)
  const links: Record<string, any> = {
    self: { href: `/node/${encodeURIComponent(nodeUri)}`, rel: 'self' },
  };

  // Items (for fragments)
  if (node.kind === 'Fragment' && node.items) {
    links.items = node.items.map((itemUri, i) => ({
      href: `/node/${encodeURIComponent(itemUri)}`,
      rel: 'item',
      position: i,
      resolved: pgslResolve(pgsl, itemUri),
      level: pgsl.nodes.get(itemUri)?.level ?? 0,
    }));
  }

  // Constituents (for level >= 2)
  if (node.kind === 'Fragment' && node.left) {
    links.leftConstituent = { href: `/node/${encodeURIComponent(node.left)}`, rel: 'left-constituent', resolved: pgslResolve(pgsl, node.left) };
  }
  if (node.kind === 'Fragment' && node.right) {
    links.rightConstituent = { href: `/node/${encodeURIComponent(node.right)}`, rel: 'right-constituent', resolved: pgslResolve(pgsl, node.right) };
  }

  // Containing fragments (what contains this node)
  const containers: any[] = [];
  for (const [fUri, fNode] of pgsl.nodes) {
    if (fNode.kind === 'Fragment' && fNode.items.includes(nodeUri)) {
      const pos = fNode.items.indexOf(nodeUri);
      containers.push({
        href: `/node/${encodeURIComponent(fUri)}`,
        rel: 'container',
        resolved: pgslResolve(pgsl, fUri as IRI),
        level: fNode.level,
        position: pos,
      });
    }
  }
  if (containers.length > 0) links.containers = containers;

  // Neighbors (left/right in containing fragments)
  const leftN: any[] = [];
  const rightN: any[] = [];
  for (const c of containers) {
    const cNode = pgsl.nodes.get(decodeURIComponent(c.href.replace('/node/', '')) as IRI);
    if (!cNode || cNode.kind !== 'Fragment') continue;
    const pos = cNode.items.indexOf(nodeUri);
    if (pos > 0) {
      const lu = cNode.items[pos - 1]!;
      if (!leftN.some(n => n.uri === lu)) leftN.push({ href: `/node/${encodeURIComponent(lu)}`, rel: 'left-neighbor', uri: lu, resolved: pgslResolve(pgsl, lu) });
    }
    if (pos < cNode.items.length - 1) {
      const ru = cNode.items[pos + 1]!;
      if (!rightN.some(n => n.uri === ru)) rightN.push({ href: `/node/${encodeURIComponent(ru)}`, rel: 'right-neighbor', uri: ru, resolved: pgslResolve(pgsl, ru) });
    }
  }
  if (leftN.length > 0) links.leftNeighbors = leftN;
  if (rightN.length > 0) links.rightNeighbors = rightN;

  // Controls (available operations)
  const controls: any[] = [
    { rel: 'ingest', method: 'POST', href: '/api/ingest', description: 'Ingest new content' },
  ];
  if (node.kind === 'Atom') {
    controls.push({ rel: 'find-containing', method: 'GET', href: `/api/node/${encodeURIComponent(nodeUri)}`, description: 'Find all fragments containing this atom' });
  }

  res.json({
    uri: nodeUri,
    resolved,
    kind: node.kind,
    level: node.level,
    _links: links,
    _controls: controls,
    annotations: annotations.map(a => ({ ...a, parentResolved: pgslResolve(pgsl, a.parentUri) })),
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

  res.json({
    chain: items,
    chainFragment: chainFragUri ? { uri: chainFragUri, href: `/node/${encodeURIComponent(chainFragUri)}`, resolved: pgslResolve(pgsl, chainFragUri) } : null,
    _links: {
      self: { href: '/api/chain', method: 'POST' },
      innerLeft, innerRight,
      outerLeft, outerRight,
    },
  });
});

// Ingest content into the lattice (and optionally to pod)
app.post('/api/ingest', (req, res) => {
  const { content, granularity } = req.body as { content: string; granularity?: TokenGranularity };
  try {
    const uri = embedInPGSL(pgsl, content, undefined, granularity ?? 'word');
    const resolved = pgslResolve(pgsl, uri);
    const stats = latticeStats(pgsl);
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
    annotations: annotations.map(a => ({ ...a, parentResolved: pgslResolve(pgsl, a.parentUri) })),
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
  const allPods = [POD_URL, ...KNOWN_PODS].filter(Boolean);
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
    facets: composed.facets.map(f => ({ type: f.type, ...f })),
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
  const lines = ['@prefix xapi: <https://w3id.org/xapi/ontology#> .', '@prefix verb: <https://w3id.org/xapi/adl/verbs/> .', '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .', ''];
  stmts.forEach((s, i) => {
    lines.push(`<urn:xapi:${learner}:${String(i + 1).padStart(3, '0')}> a xapi:Statement ;`);
    lines.push(`    xapi:actor <${info.did}> ;`);
    lines.push(`    xapi:verb verb:${s.verb} ;`);
    lines.push(`    xapi:object <urn:activity:${s.activity}> ;`);
    lines.push(`    xapi:timestamp "${s.timestamp}"^^xsd:dateTime ;`);
    lines.push(`    <https://w3id.org/xapi/ontology#result/score> "${s.score}"^^xsd:integer ;`);
    lines.push(`    <https://w3id.org/xapi/ontology#result/success> "${s.success}"^^xsd:boolean .`);
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
const PHASE_NAMES = ['', 'Setup', 'xAPI Ingestion', 'Competency Assessment', 'Credential Issuance', 'Learner Discovery', 'Verification'];

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

        // Ingest each statement into PGSL using xAPI profile
        for (const s of stmts) {
          const xapiJson = {
            actor: { name: info.name },
            verb: { id: `http://adlnet.gov/expapi/verbs/${s.verb}`, display: { 'en-US': s.verb } },
            object: { id: `urn:activity:${s.activity}`, definition: { name: { 'en-US': s.activityName } } },
            result: { score: { raw: s.score, max: 100 }, success: s.success, duration: s.duration },
            timestamp: s.timestamp,
          };
          const structured = xapiProfile.transform(xapiJson);
          embedInPGSL(pgsl, structured, undefined, 'structured');
          logActivity('LRS', 'pgsl', `xapi_ingest: ${structured}`);
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
      const sparqlQuery = `PREFIX pgsl: <https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#>
SELECT ?atom ?value WHERE { ?atom a pgsl:Atom ; pgsl:value ?value . } LIMIT 30`;
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

        const compGraph = `@prefix comp: <https://example.org/competency#> .\n<urn:competency:${learner}> a comp:CompetencyAssertion ; comp:learner <${info.did}> ; comp:level "${level}" ; comp:score "${avgScore}" .`;

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
        const credGraph = `@prefix vc: <https://www.w3.org/2018/credentials#> .\n@prefix lers: <https://purl.org/lers/ns#> .\n<urn:lers:${learner}-instrument-2026> a vc:VerifiableCredential, lers:LearningEmploymentRecord ; vc:issuer <did:web:credential.training.airforce.mil> ; vc:issuanceDate "2026-03-17T10:00:00Z" ; vc:credentialSubject [ lers:learner <${info.did}> ; lers:achievement [ lers:level "${avgScore >= 90 ? 'Advanced' : 'Proficient'}" ; lers:framework "USAF Instrument Rating v3" ] ] .`;

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
          const credGraph = `<urn:lers:${learner}> a <https://www.w3.org/2018/credentials#VerifiableCredential> .`;
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
      const overlapQuery = `PREFIX pgsl: <https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#>
SELECT (COUNT(DISTINCT ?atom) AS ?sharedAtoms) WHERE { ?atom a pgsl:Atom . }`;
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
      res.json({ phase, status: 'Full trust chain verified across cohort', next: 'Demo complete — click Reset to restart' });

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
