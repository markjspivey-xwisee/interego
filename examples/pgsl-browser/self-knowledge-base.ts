#!/usr/bin/env tsx
/**
 * Self-Referential Knowledge Base
 *
 * Karpathy's LLM Wiki pattern, implemented using Context Graphs first principles.
 * The source material IS our own codebase — the system ingests itself.
 *
 * Instead of:
 *   Raw sources → LLM-generated markdown wiki → schema (CLAUDE.md)
 *
 * We use:
 *   Source code → PGSL atoms (identifiers) + chains (relationships) → paradigm sets (live queries)
 *   No LLM-generated summaries. No markdown files. No manual cross-references.
 *   Structure emerges from composition. Queries are paradigm projections.
 *
 * What replaces each piece of Karpathy's wiki:
 *   - Wiki pages → P(entity, ?, ?) paradigm projections (always current)
 *   - Cross-references → shared atoms (automatic, content-addressed)
 *   - Contradictions → coherence verification (formal, auditable)
 *   - Index → SPARQL queries
 *   - Log → provenance on every node
 *   - Schema → paradigm constraints + SHACL shapes
 *   - Lint → SHACL validation + coherence coverage
 */

import {
  createPGSL,
  embedInPGSL,
  mintAtom,
  ingest,
  latticeStats,
  resolve as pgslResolve,
  verifyCoherence,
  computeCoverage,
  getCertificates,
  sparqlQueryPGSL,
  validateAllPGSL,
  ContextDescriptor,
  validate,
  intersection,
  union,
} from '@foxxi/context-graphs';

import type { IRI, PGSLInstance } from '@foxxi/context-graphs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const BASE = process.env['BASE'] ?? 'http://localhost:5000';

async function browserIngest(content: string): Promise<void> {
  await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, granularity: 'word' }),
  });
}

// ── Logging ─────────────────────────────────────────

const C = {
  h: '\x1b[1;37m', scan: '\x1b[36m', build: '\x1b[32m',
  query: '\x1b[33m', cohere: '\x1b[35m', lint: '\x1b[34m',
  dim: '\x1b[90m', r: '\x1b[0m',
};

function log(c: string, label: string, msg: string) {
  console.log(`${c}[${label}]${C.r} ${msg}`);
}

function banner(text: string) {
  console.log(`\n${C.h}${'═'.repeat(64)}${C.r}`);
  console.log(`${C.h}  ${text}${C.r}`);
  console.log(`${C.h}${'═'.repeat(64)}${C.r}`);
}

// ── Source Scanner ──────────────────────────────────

interface SourceFile {
  path: string;
  module: string;
  exports: string[];
  imports: string[];
  lines: number;
  dependencies: string[];
}

function scanSourceFile(filePath: string, rootDir: string): SourceFile {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const relPath = relative(rootDir, filePath).replace(/\\/g, '/');
  const module = relPath.replace(/\.ts$/, '').replace(/\//g, '/');

  // Extract exports
  const exports: string[] = [];
  for (const line of lines) {
    const funcMatch = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (funcMatch) exports.push(funcMatch[1]!);
    const classMatch = line.match(/^export\s+class\s+(\w+)/);
    if (classMatch) exports.push(classMatch[1]!);
    const ifaceMatch = line.match(/^export\s+(?:interface|type)\s+(\w+)/);
    if (ifaceMatch) exports.push(ifaceMatch[1]!);
    const constMatch = line.match(/^export\s+const\s+(\w+)/);
    if (constMatch) exports.push(constMatch[1]!);
  }

  // Extract imports (local only)
  const imports: string[] = [];
  const dependencies: string[] = [];
  for (const line of lines) {
    const importMatch = line.match(/from\s+['"](\.\.?\/[^'"]+)['"]/);
    if (importMatch) {
      imports.push(importMatch[1]!);
      // Extract the module name
      const dep = importMatch[1]!.replace(/\.js$/, '').split('/').pop()!;
      if (!dependencies.includes(dep)) dependencies.push(dep);
    }
  }

  return { path: relPath, module, exports, imports, lines: lines.length, dependencies };
}

function scanDirectory(dir: string, rootDir: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules' && entry !== 'dist') {
      files.push(...scanDirectory(full, rootDir));
    } else if (stat.isFile() && extname(entry) === '.ts' && !entry.endsWith('.test.ts')) {
      files.push(scanSourceFile(full, rootDir));
    }
  }
  return files;
}

// ═══════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════

async function main() {
  const srcDir = join(process.cwd(), 'src');

  console.log(`${C.h}`);
  console.log('  Context Graphs — Self-Referential Knowledge Base');
  console.log('  The system ingests itself. No LLM wiki. No markdown.');
  console.log('  Structure emerges from composition.');
  console.log(`${C.r}`);

  // Wipe
  await fetch(`${BASE}/api/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  // ─────────────────────────────────────────────────────────
  //  PHASE 1: SCAN — Read the source code (raw sources)
  // ─────────────────────────────────────────────────────────

  banner('Phase 1: SCAN — Reading source code');

  const sourceFiles = scanDirectory(srcDir, srcDir);
  log(C.scan, 'Scan', `Found ${sourceFiles.length} source files`);
  log(C.scan, 'Scan', `Total: ${sourceFiles.reduce((n, f) => n + f.lines, 0)} lines`);
  log(C.scan, 'Scan', `Exports: ${sourceFiles.reduce((n, f) => n + f.exports.length, 0)} symbols`);

  // Group by module
  const modules = new Map<string, SourceFile[]>();
  for (const f of sourceFiles) {
    const mod = f.path.split('/')[0]!;
    const existing = modules.get(mod);
    if (existing) existing.push(f);
    else modules.set(mod, [f]);
  }

  log(C.scan, 'Scan', `Modules: ${[...modules.keys()].join(', ')}`);

  // ─────────────────────────────────────────────────────────
  //  PHASE 2: INGEST — Build the knowledge graph
  // ─────────────────────────────────────────────────────────

  banner('Phase 2: INGEST — Building knowledge graph from source');

  // For each source file, create structured knowledge:
  // - (filename, type, module) — what kind of file
  // - (filename, exports, functionName) — what it exports
  // - (filename, depends-on, otherFile) — dependencies
  // - (filename, lines, N) — size
  // - (moduleName, contains, filename) — module structure

  let chainCount = 0;

  for (const [modName, files] of modules) {
    // Module declaration
    await browserIngest(`${modName} type module`);
    chainCount++;

    for (const f of files) {
      const fname = basename(f.path, '.ts');

      // File identity
      await browserIngest(`${fname} type source-file`);
      await browserIngest(`${modName} contains ${fname}`);
      await browserIngest(`${fname} path ${f.path}`);
      await browserIngest(`${fname} lines ${f.lines}`);
      chainCount += 4;

      // Exports — each exported symbol
      for (const exp of f.exports.slice(0, 15)) { // cap to avoid explosion
        await browserIngest(`${fname} exports ${exp}`);
        await browserIngest(`${exp} defined-in ${fname}`);
        chainCount += 2;
      }

      // Dependencies
      for (const dep of f.dependencies) {
        await browserIngest(`${fname} depends-on ${dep}`);
        chainCount++;
      }
    }

    log(C.build, 'Ingest', `Module ${modName}: ${files.length} files ingested`);
  }

  // Add cross-cutting concepts
  const concepts = [
    // Architecture layers
    'pgsl type layer', 'pgsl layer-number 1',
    'model type layer', 'model layer-number 2',
    'rdf type layer', 'rdf layer-number 3',
    'solid type layer', 'solid layer-number 4',
    'crypto type layer', 'crypto layer-number 5',
    'affordance type layer', 'affordance layer-number 6',
    'causality type layer', 'causality layer-number 7',

    // Key architectural relationships
    'lattice foundation-of pgsl',
    'coherence built-on lattice',
    'decision-functor built-on coherence',
    'persistence built-on lattice',
    'paradigm-constraints built-on lattice',
    'sparql-engine virtualizes lattice',
    'shacl validates lattice',
    'system-ontology describes entire-system',
    'virtualized-layer bridges rdf-ecosystem',

    // Design principles
    'content-addressing principle system',
    'zero-dependencies principle core',
    'composition-is-algebraic principle operators',
    'usage-based-semantics principle coherence',
    'semiotic-foundation principle descriptors',
    'local-first principle deployment',
    'progressive-persistence principle storage',

    // Key types
    'PGSLInstance type core-type',
    'ContextDescriptor type core-type',
    'CoherenceCertificate type core-type',
    'PersistenceRecord type core-type',
    'Affordance type core-type',
    'Decision type core-type',
    'ParadigmConstraint type core-type',
    'Atom type pgsl-type',
    'Fragment type pgsl-type',

    // Relationships between types
    'Atom contained-in Fragment',
    'Fragment composed-of Atom',
    'ContextDescriptor describes NamedGraph',
    'ContextDescriptor has-facet TemporalFacet',
    'ContextDescriptor has-facet ProvenanceFacet',
    'ContextDescriptor has-facet TrustFacet',
    'ContextDescriptor has-facet SemioticFacet',
    'CoherenceCertificate verifies agent-pair',
    'PersistenceRecord tracks node-tier',
    'Decision selects Affordance',
  ];

  for (const c of concepts) {
    await browserIngest(c);
    chainCount++;
  }

  log(C.build, 'Ingest', `Added ${concepts.length} architectural concepts`);

  const stats = await (await fetch(`${BASE}/api/stats`)).json();
  log(C.build, 'Ingest', `Lattice: ${stats.atoms} atoms, ${stats.fragments} fragments, L0-L${stats.maxLevel}`);
  log(C.build, 'Ingest', `Total chains ingested: ${chainCount}`);

  // ─────────────────────────────────────────────────────────
  //  PHASE 3: QUERY — Paradigm projections replace wiki pages
  // ─────────────────────────────────────────────────────────

  banner('Phase 3: QUERY — Paradigm projections (no wiki pages needed)');

  // Instead of an "entity page" for lattice.ts, query P(lattice, ?, ?)
  log(C.query, 'Query', 'What is "lattice"? → P(lattice, ?, ?)');
  const allResp = await fetch(`${BASE}/api/all`);
  const allData = await allResp.json();

  const latticeAtom = allData.nodes.find((n: any) => n.resolved === 'lattice' && n.level === 0);
  if (latticeAtom) {
    const nodeResp = await fetch(`${BASE}/api/node/${encodeURIComponent(latticeAtom.uri)}`);
    const nodeData = await nodeResp.json();
    log(C.query, 'Query', `  Sources (before lattice): ${nodeData._paradigm.sourceOptions.map((o: any) => o.resolved).join(', ')}`);
    log(C.query, 'Query', `  Targets (after lattice): ${nodeData._paradigm.targetOptions.map((o: any) => o.resolved).join(', ')}`);
    log(C.query, 'Query', `  Appears in ${nodeData._context.containers.length} fragments`);
  }

  // What does the "coherence" module export?
  log(C.query, 'Query', '');
  log(C.query, 'Query', 'What does "coherence" export? → P(coherence, exports, ?)');
  const coherenceChains = allData.nodes.filter((n: any) => n.level >= 2 && n.resolved.startsWith('coherence exports'));
  for (const c of coherenceChains.slice(0, 5)) {
    log(C.query, 'Query', `  ${c.resolved}`);
  }

  // What depends on lattice?
  log(C.query, 'Query', '');
  log(C.query, 'Query', 'What depends on lattice? → P(?, depends-on, lattice)');
  const depChains = allData.nodes.filter((n: any) => n.level >= 2 && n.resolved.includes('depends-on lattice'));
  for (const c of depChains) {
    log(C.query, 'Query', `  ${c.resolved}`);
  }

  // What are the modules?
  log(C.query, 'Query', '');
  log(C.query, 'Query', 'All modules → P(?, type, module)');
  const moduleChains = allData.nodes.filter((n: any) => n.level === 3 && n.resolved.endsWith('type module'));
  for (const c of moduleChains) {
    log(C.query, 'Query', `  ${c.resolved}`);
  }

  // What are the design principles?
  log(C.query, 'Query', '');
  log(C.query, 'Query', 'Design principles → P(?, principle, ?)');
  const principleChains = allData.nodes.filter((n: any) => n.level >= 2 && n.resolved.includes(' principle '));
  for (const c of principleChains) {
    log(C.query, 'Query', `  ${c.resolved}`);
  }

  // What are the core types?
  log(C.query, 'Query', '');
  log(C.query, 'Query', 'Core types → P(?, type, core-type)');
  const typeChains = allData.nodes.filter((n: any) => n.level === 3 && n.resolved.endsWith('type core-type'));
  for (const c of typeChains) {
    log(C.query, 'Query', `  ${c.resolved}`);
  }

  // ─────────────────────────────────────────────────────────
  //  PHASE 4: CROSS-REFERENCES — Automatic from shared atoms
  // ─────────────────────────────────────────────────────────

  banner('Phase 4: CROSS-REFERENCES — Automatic from shared atoms');

  // The atom "lattice" connects everything that mentions it
  log(C.build, 'XRef', 'Shared atoms create automatic cross-references:');

  const hubAtoms = ['lattice', 'coherence', 'pgsl', 'types', 'exports', 'depends-on', 'type'];
  for (const atomName of hubAtoms) {
    const atom = allData.nodes.find((n: any) => n.resolved === atomName && n.level === 0);
    if (atom) {
      const containers = allData.nodes.filter((n: any) =>
        n.level >= 2 && n.resolved.split(' ').includes(atomName)
      );
      log(C.build, 'XRef', `  "${atomName}" → ${containers.length} chains (auto cross-referenced)`);
    }
  }

  // ─────────────────────────────────────────────────────────
  //  PHASE 5: COHERENCE — Formal contradiction detection
  // ─────────────────────────────────────────────────────────

  banner('Phase 5: COHERENCE — Structural agreement verification');

  // Create two "views" of the system from different perspectives
  const pgslView = createPGSL({ wasAttributedTo: 'urn:agent:pgsl-perspective' as IRI, generatedAtTime: new Date().toISOString() });
  const rdfView = createPGSL({ wasAttributedTo: 'urn:agent:rdf-perspective' as IRI, generatedAtTime: new Date().toISOString() });

  // PGSL perspective: lattice is the foundation
  embedInPGSL(pgslView, 'lattice foundation system');
  embedInPGSL(pgslView, 'atoms content-addressed unique');
  embedInPGSL(pgslView, 'fragments compose atoms');
  embedInPGSL(pgslView, 'paradigm-sets emerge usage');
  embedInPGSL(pgslView, 'coherence verifies agreement');
  embedInPGSL(pgslView, 'constraints restrict paradigm');

  // RDF perspective: triples are the foundation
  embedInPGSL(rdfView, 'triples foundation system');
  embedInPGSL(rdfView, 'ontology describes classes');
  embedInPGSL(rdfView, 'sparql queries triples');
  embedInPGSL(rdfView, 'shacl validates shapes');
  embedInPGSL(rdfView, 'coherence verifies agreement');
  embedInPGSL(rdfView, 'constraints restrict paradigm');

  const cert = verifyCoherence(pgslView, rdfView, 'PGSL-view', 'RDF-view', 'system-architecture');
  log(C.cohere, 'Cohere', `PGSL-view ↔ RDF-view: ${cert.status} (${(cert.semanticOverlap * 100).toFixed(0)}% overlap)`);

  if (cert.semanticProfile.length > 0) {
    log(C.cohere, 'Cohere', 'Per-atom analysis:');
    for (const p of cert.semanticProfile.slice(0, 5)) {
      const bar = '█'.repeat(Math.round(p.overlap * 10)) + '░'.repeat(10 - Math.round(p.overlap * 10));
      log(C.cohere, 'Cohere', `  "${p.atom}" [${bar}] ${(p.overlap * 100).toFixed(0)}%`);
    }
  }

  if (cert.sharedStructure) log(C.cohere, 'Cohere', `Shared: ${cert.sharedStructure}`);
  if (cert.obstruction) log(C.cohere, 'Cohere', `Obstruction: ${cert.obstruction.description}`);

  // Push coherence results to browser
  await browserIngest(`coherence pgsl-view rdf-view ${cert.status} overlap ${(cert.semanticOverlap * 100).toFixed(0)}`);

  // ─────────────────────────────────────────────────────────
  //  PHASE 6: LINT — SHACL validation + coverage
  // ─────────────────────────────────────────────────────────

  banner('Phase 6: LINT — Structural validation');

  // Create a combined PGSL for SHACL validation
  const combined = createPGSL({ wasAttributedTo: 'urn:agent:lint' as IRI, generatedAtTime: new Date().toISOString() });
  embedInPGSL(combined, 'lattice foundation system');
  embedInPGSL(combined, 'atoms content-addressed');
  embedInPGSL(combined, 'fragments compose atoms');

  const shaclResult = validateAllPGSL(combined);
  log(C.lint, 'Lint', `SHACL: ${shaclResult.conforms ? 'CONFORMS ✓' : shaclResult.violations.length + ' violations'}`);

  const coverage = computeCoverage(['PGSL-view', 'RDF-view']);
  log(C.lint, 'Lint', `Coherence coverage: ${(coverage.coverage * 100).toFixed(0)}% (${coverage.verified} verified, ${coverage.divergent} divergent, ${coverage.unexamined} unexamined)`);
  if (coverage.unexamined > 0) {
    log(C.lint, 'Lint', `⚠ ${coverage.unexamined} unexamined pair(s) — the dangerous state`);
  }

  // ─────────────────────────────────────────────────────────
  //  PHASE 7: META — The system describing itself
  // ─────────────────────────────────────────────────────────

  banner('Phase 7: META — System self-description');

  // How many atoms are shared concepts vs file-specific?
  const finalAll = await (await fetch(`${BASE}/api/all`)).json();
  const atoms = finalAll.nodes.filter((n: any) => n.level === 0);
  const hubThreshold = 5;
  const hubs = atoms.filter((a: any) => {
    const count = finalAll.nodes.filter((n: any) => n.level >= 2 && n.resolved.split(' ').includes(a.resolved)).length;
    return count >= hubThreshold;
  });

  log(C.dim, 'Meta', `Total atoms: ${atoms.length}`);
  log(C.dim, 'Meta', `Hub atoms (≥${hubThreshold} chains): ${hubs.length}`);
  log(C.dim, 'Meta', `Hub atoms: ${hubs.map((h: any) => h.resolved).sort().join(', ')}`);

  // Final stats
  const finalStats = await (await fetch(`${BASE}/api/stats`)).json();

  console.log('');
  console.log(`${C.h}${'═'.repeat(64)}${C.r}`);
  console.log(`${C.h}  Summary${C.r}`);
  console.log(`${C.h}${'═'.repeat(64)}${C.r}`);
  console.log('');
  console.log(`  Source: ${sourceFiles.length} TypeScript files, ${sourceFiles.reduce((n, f) => n + f.lines, 0)} lines`);
  console.log(`  Lattice: ${finalStats.atoms} atoms, ${finalStats.fragments} fragments, L0-L${finalStats.maxLevel}`);
  console.log(`  Chains: ${chainCount} relationships ingested`);
  console.log(`  Hub atoms: ${hubs.length} (structural connectors)`);
  console.log('');
  console.log('  What Karpathy\'s LLM Wiki needs:');
  console.log('    ✗ LLM-generated wiki pages → we use paradigm projections (always live)');
  console.log('    ✗ Manual cross-references → we use shared atoms (automatic)');
  console.log('    ✗ LLM contradiction detection → we use coherence verification (formal)');
  console.log('    ✗ index.md → we use SPARQL + P(?, type, ?)');
  console.log('    ✗ log.md → we use provenance on every node');
  console.log('    ✗ CLAUDE.md schema → we use paradigm constraints + SHACL');
  console.log('    ✗ Periodic lint → we use SHACL + coherence coverage');
  console.log('    ✗ Obsidian graph view → we use PGSL Browser');
  console.log('');
  console.log('  Open http://localhost:5000/ to browse the self-referential knowledge base.');
  console.log('  Click any module name to see its paradigm — what it exports, depends on, contains.');
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
