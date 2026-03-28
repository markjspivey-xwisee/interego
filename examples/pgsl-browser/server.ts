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
} from '@foxxi/context-graphs';
import type { IRI, PGSLInstance, TokenGranularity } from '@foxxi/context-graphs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env['PORT'] ?? '5000');
const CSS_URL = process.env['CSS_URL'] ?? 'https://context-graphs-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/';
const POD_NAME = process.env['POD_NAME'] ?? 'markj';
const POD_URL = `${CSS_URL}${POD_NAME}/`;

// Create PGSL instance
const pgsl: PGSLInstance = createPGSL({
  wasAttributedTo: `urn:pgsl-browser:${POD_NAME}` as IRI,
  generatedAtTime: new Date().toISOString(),
});

// Load live data from the pod on startup
async function loadFromPod() {
  console.log(`Loading live data from ${POD_URL}...`);
  try {
    // Fetch all descriptors
    const entries = await discover(POD_URL, undefined, {
      fetch: async (url, init) => {
        const resp = await fetch(url, init as RequestInit);
        return {
          ok: resp.ok, status: resp.status, statusText: resp.statusText,
          headers: { get: (n: string) => resp.headers.get(n) },
          text: () => resp.text(), json: () => resp.json(),
        };
      },
    });

    console.log(`Found ${entries.length} descriptors`);

    // Fetch each descriptor's graph content and ingest key facts into PGSL
    for (const entry of entries) {
      try {
        // Fetch the graph content (the actual knowledge, not the descriptor metadata)
        const graphUrl = entry.descriptorUrl.replace('.ttl', '-graph.trig');
        const graphResp = await fetch(graphUrl);
        if (graphResp.ok) {
          const graphContent = await graphResp.text();
          // Extract meaningful lines (skip prefixes and blank lines)
          const lines = graphContent.split('\n')
            .filter(l => l.trim().length > 0 && !l.trim().startsWith('@prefix') && !l.trim().startsWith('GRAPH'))
            .map(l => l.trim().replace(/[<>"^@]/g, '').replace(/\s+/g, ' ').trim())
            .filter(l => l.length > 5 && l.length < 200);

          for (const line of lines.slice(0, 10)) { // limit per descriptor
            embedInPGSL(pgsl, line);
          }
          console.log(`  Ingested ${Math.min(lines.length, 10)} facts from: ${entry.describes.join(', ')}`);
        }

        // Ingest graph IRIs as individual atoms (not sequences)
        for (const g of entry.describes) {
          mintAtom(pgsl, g);
        }
        // Ingest facet types as individual atoms (they're labels, not a sentence)
        for (const ft of entry.facetTypes) {
          mintAtom(pgsl, ft);
        }
      } catch (err) {
        console.log(`  Error: ${(err as Error).message}`);
      }
    }

    const stats = latticeStats(pgsl);
    console.log(`PGSL loaded: ${stats.atoms} atoms, ${stats.fragments} fragments, L0-L${stats.maxLevel}`);
  } catch (err) {
    console.log(`Failed to load from pod: ${(err as Error).message}`);
    console.log('Starting with empty lattice — ingest content manually');
  }
}

const app = express();
app.use(express.json());

// Serve the HTML
app.get('/', (_req, res) => {
  res.sendFile(resolve(__dirname, 'index.html'));
});

// Ingest content
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

// Get lattice stats
app.get('/api/stats', (_req, res) => {
  res.json(latticeStats(pgsl));
});

// Resolve a URI
app.get('/api/resolve', (req, res) => {
  const uri = (req.query.uri as string) as IRI;
  const node = pgsl.nodes.get(uri);
  if (!node) { res.status(404).json({ error: 'Not found' }); return; }
  const resolved = pgslResolve(pgsl, uri);
  res.json({ uri, resolved, node });
});
app.post('/api/resolve', (req, res) => {
  const uri = req.body.uri as IRI;
  const node = pgsl.nodes.get(uri);
  if (!node) { res.status(404).json({ error: 'Not found' }); return; }
  const resolved = pgslResolve(pgsl, uri);
  res.json({ uri, resolved, node });
});

// Get neighbors (what appears to the left/right of a node)
app.get('/api/neighbors', (req, res) => {
  const uri = (req.query.uri as string) as IRI;
  const direction = (req.query.direction as string) as 'left' | 'right';
  const neighbors = queryNeighbors(pgsl, uri, direction);
  const results = [...neighbors].map(n => ({
    uri: n,
    resolved: pgslResolve(pgsl, n),
    node: pgsl.nodes.get(n),
  }));
  res.json(results);
});

// Get all nodes at a specific level
app.get('/api/level/:level', (req, res) => {
  const level = parseInt(req.params.level);
  const nodes: Array<{ uri: string; resolved: string; level: number }> = [];
  for (const [uri, node] of pgsl.nodes) {
    if (node.level === level) {
      nodes.push({ uri, resolved: pgslResolve(pgsl, uri as IRI), level: node.level });
    }
  }
  res.json(nodes);
});

// Get all atoms
app.get('/api/atoms', (_req, res) => {
  const atoms: Array<{ uri: string; value: string }> = [];
  for (const [uri, node] of pgsl.nodes) {
    if (node.kind === 'Atom') {
      atoms.push({ uri, value: String(node.value) });
    }
  }
  res.json(atoms);
});

// Get focus chain — given a focus node, find what's to its left and right across all fragments
// If chainContext is provided, excludes neighbors from inside nested chain elements
app.post('/api/focus', (req, res) => {
  const focusUri = req.body.uri as IRI;
  const chainContext: string[] = req.body.chainContext ?? [];
  const focusNode = pgsl.nodes.get(focusUri);
  if (!focusNode) { res.status(404).json({ error: 'Not found' }); return; }

  const resolved = pgslResolve(pgsl, focusUri);

  // Build set of fragment URIs to EXCLUDE from neighbor search
  // These are chain elements AND their sub-fragments
  const excludedFragments = new Set<string>();
  for (const chainUri of chainContext) {
    excludedFragments.add(chainUri); // exclude the chain element itself
    const chainNode = pgsl.nodes.get(chainUri as IRI);
    if (chainNode && chainNode.kind === 'Fragment' && chainNode.level > 0) {
      // This is a nested fragment in the chain — exclude all its sub-fragments
      // AND any fragment that contains ONLY atoms from inside this nested element
      const nestedAtoms = new Set<string>();
      const addSubFragments = (uri: IRI) => {
        const node = pgsl.nodes.get(uri);
        if (!node) return;
        if (node.kind === 'Atom') { nestedAtoms.add(uri); return; }
        if (node.kind !== 'Fragment') return;
        excludedFragments.add(uri);
        if (node.items) {
          for (const item of node.items) {
            addSubFragments(item);
          }
        }
        if (node.left) addSubFragments(node.left);
        if (node.right) addSubFragments(node.right);
      };
      addSubFragments(chainUri as IRI);

      // Exclude ANY fragment that contains atoms from inside the nested element
      // (except the focus atom itself, which legitimately appears at both levels)
      const focusAtomUri = focusUri;
      for (const [fUri, fNode] of pgsl.nodes) {
        if (fNode.kind !== 'Fragment' || !fNode.items) continue;
        // If ANY item (other than the focus) is a nested atom, exclude this fragment
        const hasNestedAtom = fNode.items.some(item => item !== focusAtomUri && nestedAtoms.has(item));
        if (hasNestedAtom) excludedFragments.add(fUri);
      }
    }
  }

  // Build a set of ALL URIs that "contain" or "are" this focus node
  // An atom is contained in its L1 wrapper, which is in L2 pairs, etc.
  const focusUris = new Set<string>([focusUri]);
  // Find L1 wrapper of this atom (if atom)
  if (focusNode.kind === 'Atom') {
    for (const [fUri, fNode] of pgsl.nodes) {
      if (fNode.kind === 'Fragment' && fNode.level === 1 && fNode.items.length === 1 && fNode.items[0] === focusUri) {
        focusUris.add(fUri);
      }
    }
  }

  // Find all fragments containing ANY of the focus URIs
  const containingFragments: Array<{
    uri: string;
    resolved: string;
    level: number;
    position: number;
    items: string[];
    itemsResolved: string[];
  }> = [];

  for (const [fragUri, fragNode] of pgsl.nodes) {
    if (fragNode.kind !== 'Fragment' || !fragNode.items) continue;
    // Check if any focus URI is in this fragment's items
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

  // Find left/right neighbors
  const leftNeighbors = new Map<string, { uri: string; resolved: string; count: number; level: number }>();
  const rightNeighbors = new Map<string, { uri: string; resolved: string; count: number; level: number }>();

  if (chainContext.length <= 1) {
    // Single node: use all containing fragments directly
    for (const frag of containingFragments) {
      if (frag.position > 0) {
        const leftUri = frag.items[frag.position - 1]!;
        const leftResolved = frag.itemsResolved[frag.position - 1]!;
        const existing = leftNeighbors.get(leftUri);
        if (existing) { existing.count++; }
        else {
          const leftNode = pgsl.nodes.get(leftUri as IRI);
          leftNeighbors.set(leftUri, { uri: leftUri, resolved: leftResolved, count: 1, level: leftNode?.level ?? 0 });
        }
      }
      if (frag.position < frag.items.length - 1) {
        const rightUri = frag.items[frag.position + 1]!;
        const rightResolved = frag.itemsResolved[frag.position + 1]!;
        const existing = rightNeighbors.get(rightUri);
        if (existing) { existing.count++; }
        else {
          const rightNode = pgsl.nodes.get(rightUri as IRI);
          rightNeighbors.set(rightUri, { uri: rightUri, resolved: rightResolved, count: 1, level: rightNode?.level ?? 0 });
        }
      }
    }
  } else {
    // Multi-node chain: the chain IS a fragment. Find its URI, then find ITS neighbors.
    const chainItemUris = chainContext.map(cu => cu as IRI);

    // Find the fragment whose items match the chain sequence (try raw URIs)
    let chainFragUri: IRI | null = null;
    for (const [fUri, fNode] of pgsl.nodes) {
      if (fNode.kind !== 'Fragment' || fNode.items.length !== chainItemUris.length) continue;
      let match = true;
      for (let i = 0; i < chainItemUris.length; i++) {
        if (fNode.items[i] !== chainItemUris[i]) { match = false; break; }
      }
      if (match) { chainFragUri = fUri as IRI; break; }
    }

    if (chainFragUri) {
      // Found the chain's fragment URI. Now find fragments containing IT.
      const chainFragUris = new Set<string>([chainFragUri]);
      // Also find L1 wrapper of the chain fragment
      for (const [fUri, fNode] of pgsl.nodes) {
        if (fNode.kind === 'Fragment' && fNode.level === chainContext.length + 1 && fNode.items.length === 1 && fNode.items[0] === chainFragUri) {
          chainFragUris.add(fUri);
        }
      }

      for (const [fragUri, fragNode] of pgsl.nodes) {
        if (fragNode.kind !== 'Fragment' || excludedFragments.has(fragUri)) continue;
        // Check items array
        let idx = -1;
        if (fragNode.items) {
          for (const cfUri of chainFragUris) {
            const i = fragNode.items.indexOf(cfUri as IRI);
            if (i >= 0) { idx = i; break; }
          }
        }
        // Also check left/right constituents
        let isLeft = false, isRight = false;
        if (idx < 0) {
          for (const cfUri of chainFragUris) {
            if (fragNode.left === cfUri) { isLeft = true; break; }
            if (fragNode.right === cfUri) { isRight = true; break; }
          }
          if (!isLeft && !isRight) continue;
        }

        const items = fragNode.items ?? [];
        const itemsResolved = items.map(i => pgslResolve(pgsl, i as IRI));

        // If found via left/right constituent, map to neighbor
        if (isLeft && fragNode.right) {
          // Chain fragment is the LEFT constituent → right constituent is the right neighbor
          const rightUri = fragNode.right;
          const rightResolved = pgslResolve(pgsl, rightUri);
          const existing = rightNeighbors.get(rightUri);
          if (existing) { existing.count++; }
          else {
            const rightNode = pgsl.nodes.get(rightUri);
            rightNeighbors.set(rightUri, { uri: rightUri, resolved: rightResolved, count: 1, level: rightNode?.level ?? 0 });
          }
          continue;
        }
        if (isRight && fragNode.left) {
          // Chain fragment is the RIGHT constituent → left constituent is the left neighbor
          const leftUri = fragNode.left;
          const leftResolved = pgslResolve(pgsl, leftUri);
          const existing = leftNeighbors.get(leftUri);
          if (existing) { existing.count++; }
          else {
            const leftNode = pgsl.nodes.get(leftUri);
            leftNeighbors.set(leftUri, { uri: leftUri, resolved: leftResolved, count: 1, level: leftNode?.level ?? 0 });
          }
          continue;
        }

        if (idx > 0) {
          const leftUri = items[idx - 1]!;
          const leftResolved = itemsResolved[idx - 1]!;
          const existing = leftNeighbors.get(leftUri);
          if (existing) { existing.count++; }
          else {
            const leftNode = pgsl.nodes.get(leftUri as IRI);
            leftNeighbors.set(leftUri, { uri: leftUri, resolved: leftResolved, count: 1, level: leftNode?.level ?? 0 });
          }
        }
        if (idx < fragNode.items.length - 1) {
          const rightUri = fragNode.items[idx + 1]!;
          const rightResolved = itemsResolved[idx + 1]!;
          const existing = rightNeighbors.get(rightUri);
          if (existing) { existing.count++; }
          else {
            const rightNode = pgsl.nodes.get(rightUri as IRI);
            rightNeighbors.set(rightUri, { uri: rightUri, resolved: rightResolved, count: 1, level: rightNode?.level ?? 0 });
          }
        }
      }
    } else {
      // Chain fragment not found in lattice — fall back to single-node neighbors
      // for the leftmost (sources) and rightmost (targets) chain items
      for (const frag of containingFragments) {
        if (frag.position > 0) {
          const leftUri = frag.items[frag.position - 1]!;
          const leftResolved = frag.itemsResolved[frag.position - 1]!;
          const existing = leftNeighbors.get(leftUri);
          if (existing) { existing.count++; }
          else {
            const leftNode = pgsl.nodes.get(leftUri as IRI);
            leftNeighbors.set(leftUri, { uri: leftUri, resolved: leftResolved, count: 1, level: leftNode?.level ?? 0 });
          }
        }
        if (frag.position < frag.items.length - 1) {
          const rightUri = frag.items[frag.position + 1]!;
          const rightResolved = frag.itemsResolved[frag.position + 1]!;
          const existing = rightNeighbors.get(rightUri);
          if (existing) { existing.count++; }
          else {
            const rightNode = pgsl.nodes.get(rightUri as IRI);
            rightNeighbors.set(rightUri, { uri: rightUri, resolved: rightResolved, count: 1, level: rightNode?.level ?? 0 });
          }
        }
      }
    }
  }

  // Compute containment annotations (contextual properties per edge)
  const annotations = computeContainmentAnnotations(pgsl, focusUri);

  res.json({
    focus: { uri: focusUri, resolved, level: focusNode.level },
    left: [...leftNeighbors.values()].sort((a, b) => b.count - a.count),
    right: [...rightNeighbors.values()].sort((a, b) => b.count - a.count),
    containingFragments: containingFragments.sort((a, b) => b.level - a.level).slice(0, 20),
    annotations: annotations.map(a => ({
      ...a,
      parentResolved: pgslResolve(pgsl, a.parentUri),
    })),
  });
});

// Ingest a sequence of URIs as a new fragment (preserving structural identity)
app.post('/api/ingest-uris', (req, res) => {
  const { uris } = req.body as { uris: string[] };
  if (!uris || uris.length < 2) {
    res.status(400).json({ error: 'Need at least 2 URIs' });
    return;
  }

  try {
    // Verify all URIs exist in the lattice
    for (const uri of uris) {
      if (!pgsl.nodes.has(uri as IRI)) {
        res.status(400).json({ error: `URI not found in lattice: ${uri}` });
        return;
      }
    }

    // Ingest the URI sequence — this creates a real fragment
    const topUri = ingest(pgsl, uris as IRI[]);
    const resolved = pgslResolve(pgsl, topUri);
    const stats = latticeStats(pgsl);
    res.json({ uri: topUri, resolved, stats });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Lattice meet
app.post('/api/meet', (req, res) => {
  const { uri_a, uri_b } = req.body;
  const meet = latticeMeet(pgsl, uri_a as IRI, uri_b as IRI);
  if (!meet) { res.json({ meet: null }); return; }
  res.json({ meet, resolved: pgslResolve(pgsl, meet) });
});

// Get all nodes (for visualization)
app.get('/api/all', (_req, res) => {
  const nodes: Array<{ uri: string; resolved: string; level: number; kind: string }> = [];
  for (const [uri, node] of pgsl.nodes) {
    nodes.push({
      uri,
      resolved: pgslResolve(pgsl, uri as IRI),
      level: node.level,
      kind: node.kind,
    });
  }
  res.json({ nodes, stats: latticeStats(pgsl) });
});

// Start server — skip pod loading if CLEAN=1 env var
const skipPod = process.env['CLEAN'] === '1';
(skipPod ? Promise.resolve() : loadFromPod()).then(() => {
  app.listen(PORT, () => {
    console.log(`PGSL Browser running at http://localhost:${PORT}/`);
    console.log(`Connected to pod: ${POD_URL}`);
  });
}).catch(err => {
  console.error('Startup error:', err);
  // Start anyway with empty lattice
  app.listen(PORT, () => {
    console.log(`PGSL Browser running at http://localhost:${PORT}/ (no live data)`);
  });
});
