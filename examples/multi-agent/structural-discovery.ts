#!/usr/bin/env tsx
/**
 * Structural Discovery — The system discovers truths about itself
 *
 * Not a demo. Not a showcase. An actual investigation.
 * Uses PGSL's structural properties to find things about our
 * codebase that nobody explicitly documented.
 */

import { createPGSL, embedInPGSL, latticeStats, pgslResolve } from '@interego/core';
import type { IRI } from '@interego/core';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const pgsl = createPGSL({ wasAttributedTo: 'urn:agent:discovery' as IRI, generatedAtTime: new Date().toISOString() });
const srcDir = join(process.cwd(), 'src');

// Scan all source files
function scan(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist') {
      scan(full);
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      const mod = basename(e.name, '.ts');
      const src = readFileSync(full, 'utf-8');

      for (const m of src.matchAll(/from\s+['"]\.\.?\/?\.?\/?([^'"]+)['"]/g)) {
        const dep = m[1]!.replace(/\.js$/, '').split('/').pop()!;
        embedInPGSL(pgsl, `${mod} depends-on ${dep}`);
      }

      for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+(\w+)/g)) {
        embedInPGSL(pgsl, `${mod} exports ${m[1]}`);
      }

      for (const m of src.matchAll(/\b(createPGSL|mintAtom|ingest|resolve|verifyCoherence|embedInPGSL|latticeStats|materializeTriples|executeSparqlString|validateAllPGSL|createWallet|signDescriptor|computeAffordances|createEnclave|createCheckpoint|createMarketplace|decorateNode|evaluatePolicy|recordTrace|createDelegation)\s*\(/g)) {
        embedInPGSL(pgsl, `${mod} calls ${m[1]}`);
      }
    }
  }
}

scan(srcDir);
const stats = latticeStats(pgsl);
console.log(`Ingested: ${stats.atoms} atoms, ${stats.fragments} fragments\n`);

// Analyze connectivity
const atomUsage = new Map<string, number>();
for (const [value] of pgsl.atoms) {
  let count = 0;
  for (const [, node] of pgsl.nodes) {
    if (node.kind === 'Fragment' && node.level >= 2) {
      if (pgslResolve(pgsl, node.uri).split(' ').includes(value)) count++;
    }
  }
  atomUsage.set(value, count);
}

const boring = new Set(['exports', 'depends-on', 'calls']);
const sorted = [...atomUsage.entries()].filter(([k]) => !boring.has(k)).sort((a, b) => b[1] - a[1]);

console.log('=== MOST CONNECTED CONCEPTS ===');
for (const [atom, count] of sorted.slice(0, 20)) {
  console.log(`  ${String(count).padStart(4)}x  ${atom}`);
}

// Dependency analysis
const depCounts = new Map<string, number>();
const importedBy = new Map<string, string[]>();

for (const [, node] of pgsl.nodes) {
  if (node.kind !== 'Fragment' || node.level < 3) continue;
  const r = pgslResolve(pgsl, node.uri);
  if (!r.includes(' depends-on ')) continue;
  const [mod, dep] = r.split(' depends-on ');
  depCounts.set(mod!, (depCounts.get(mod!) ?? 0) + 1);
  if (!importedBy.has(dep!)) importedBy.set(dep!, []);
  importedBy.get(dep!)!.push(mod!);
}

console.log('\n=== HIGHEST COUPLING (most dependencies) ===');
for (const [mod, count] of [...depCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(count).padStart(3)} deps  ${mod}`);
}

console.log('\n=== MOST DEPENDED ON ===');
for (const [dep, mods] of [...importedBy.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
  console.log(`  ${String(mods.length).padStart(3)} importers  ${dep}  ← ${mods.slice(0, 5).join(', ')}`);
}

// Circular dependencies
console.log('\n=== CIRCULAR DEPENDENCIES ===');
const circulars = new Set<string>();
for (const [modA, importersOfA] of importedBy) {
  for (const importer of importersOfA) {
    if (importedBy.get(importer)?.includes(modA)) {
      const key = [modA, importer].sort().join(' ↔ ');
      if (!circulars.has(key)) {
        circulars.add(key);
        console.log(`  ⚠ ${key}`);
      }
    }
  }
}
if (circulars.size === 0) console.log('  None found ✓');

// Export surface area
console.log('\n=== LARGEST API SURFACE ===');
const exportCounts = new Map<string, number>();
for (const [, node] of pgsl.nodes) {
  if (node.kind !== 'Fragment' || node.level < 3) continue;
  const r = pgslResolve(pgsl, node.uri);
  if (!r.includes(' exports ')) continue;
  const mod = r.split(' exports ')[0]!;
  exportCounts.set(mod, (exportCounts.get(mod) ?? 0) + 1);
}
for (const [mod, count] of [...exportCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(count).padStart(3)} exports  ${mod}`);
}

// Bridge functions — called from 3+ different modules
console.log('\n=== BRIDGE FUNCTIONS (called from 3+ modules) ===');
const callsByFunc = new Map<string, Set<string>>();
for (const [, node] of pgsl.nodes) {
  if (node.kind !== 'Fragment' || node.level < 3) continue;
  const r = pgslResolve(pgsl, node.uri);
  if (!r.includes(' calls ')) continue;
  const [mod, func] = r.split(' calls ');
  if (!callsByFunc.has(func!)) callsByFunc.set(func!, new Set());
  callsByFunc.get(func!)!.add(mod!);
}
for (const [func, mods] of [...callsByFunc.entries()].filter(([, m]) => m.size >= 3).sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  ${func} (${mods.size} callers): ${[...mods].join(', ')}`);
}

// Orphan modules — high export count but nobody imports them
console.log('\n=== HIDDEN COUPLING (high exports but few importers) ===');
for (const [mod, expCount] of [...exportCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const importCount = importedBy.get(mod)?.length ?? 0;
  if (expCount >= 5 && importCount <= 2) {
    console.log(`  ${mod}: ${expCount} exports but only ${importCount} importers — potential dead code or missing integration`);
  }
}

// THE REAL DISCOVERY: what concepts connect different architectural layers?
console.log('\n=== CROSS-LAYER BRIDGES ===');
console.log('(atoms that connect modules from different directories)');

// Categorize modules by their directory
const modToDir = new Map<string, string>();
function categorize(dir: string, category: string) {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.ts')) {
        modToDir.set(basename(e.name, '.ts'), category);
      }
    }
  } catch {}
}
categorize(join(srcDir, 'pgsl'), 'pgsl');
categorize(join(srcDir, 'model'), 'model');
categorize(join(srcDir, 'rdf'), 'rdf');
categorize(join(srcDir, 'solid'), 'solid');
categorize(join(srcDir, 'crypto'), 'crypto');
categorize(join(srcDir, 'affordance'), 'affordance');
categorize(join(srcDir, 'validation'), 'validation');

// Find atoms that appear in chains linking modules from different directories
const crossLayer = new Map<string, Set<string>>();
for (const [, node] of pgsl.nodes) {
  if (node.kind !== 'Fragment' || node.level < 3) continue;
  const r = pgslResolve(pgsl, node.uri);
  const words = r.split(' ');
  const mod = words[0]!;
  const dir = modToDir.get(mod);
  if (!dir) continue;

  for (const word of words.slice(1)) {
    if (boring.has(word)) continue;
    const wordDir = modToDir.get(word);
    if (wordDir && wordDir !== dir) {
      const bridge = `${dir}→${wordDir}`;
      if (!crossLayer.has(word)) crossLayer.set(word, new Set());
      crossLayer.get(word)!.add(bridge);
    }
  }
}

for (const [atom, bridges] of [...crossLayer.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15)) {
  console.log(`  "${atom}" bridges ${bridges.size} layer pairs: ${[...bridges].join(', ')}`);
}

console.log('\n=== WHAT THIS TELLS US ===');
console.log('The structural analysis reveals architectural truths:');
console.log('- Which modules are the load-bearing walls (most depended on)');
console.log('- Where coupling is highest (most dependencies)');
console.log('- What functions are the system\'s API surface (bridge functions)');
console.log('- Where dead code might hide (high exports, low importers)');
console.log('- What concepts bridge architectural layers');
console.log('None of this was manually documented — it emerged from the code structure.');
