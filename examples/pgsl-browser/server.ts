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
} from '@foxxi/context-graphs';
import type { IRI, PGSLInstance, TokenGranularity } from '@foxxi/context-graphs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env['PORT'] ?? '5000');
const CSS_URL = process.env['CSS_URL'] ?? 'https://context-graphs-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/';
const POD_NAME = process.env['POD_NAME'] ?? 'markj';
const POD_URL = `${CSS_URL}${POD_NAME}/`;
const CLEAN = process.env['CLEAN'] === '1';

// The PGSL lattice — derived from pod content, not a separate store
let pgsl: PGSLInstance = createPGSL({
  wasAttributedTo: `urn:pgsl-browser:${POD_NAME}` as IRI,
  generatedAtTime: new Date().toISOString(),
});

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

// Serve the HTML
app.get('/', (_req, res) => {
  res.sendFile(resolve(__dirname, 'index.html'));
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
