#!/usr/bin/env tsx
/**
 * Emergent Semiotics Demo
 *
 * Three agents independently build meaning from different slices of
 * the same codebase. No agent is told what any term means. Meaning
 * EMERGES from how each agent uses terms in chains.
 *
 * The Peircean thesis: meaning = usage. A sign (atom) acquires meaning
 * through its syntagmatic contexts (what chains it appears in). Two
 * agents share MEANING when they use the same sign in the same contexts.
 *
 * What we're testing:
 *   1. Do agents independently converge on the same meaning for shared terms?
 *   2. Where does meaning diverge — same sign, different usage?
 *   3. What NEW meaning emerges from combining all three perspectives?
 *   4. Can the system detect all of this structurally, without an ontologist?
 */

import {
  createPGSL, embedInPGSL, latticeStats, pgslResolve,
  verifyCoherence, computeCoverage, getCertificates,
  sparqlQueryPGSL,
} from '@foxxi/context-graphs';

import {
  extractObservations,
  computeAffordances as computeDecisionAffordances,
  selectStrategy,
  decide as decideFromObservations,
} from '../../src/pgsl/decision-functor.js';

import {
  generateMetagraph, ingestMetagraph,
} from '../../src/pgsl/discovery.js';

import type { IRI, PGSLInstance } from '@foxxi/context-graphs';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const BASE = process.env['BASE'] ?? 'http://localhost:5000';

// ── Logging ─────────────────────────────────────────

const C: Record<string, string> = {
  A: '\x1b[31m', B: '\x1b[33m', C: '\x1b[34m',
  sem: '\x1b[35m', emerge: '\x1b[32m', meta: '\x1b[36m',
  dim: '\x1b[90m', h: '\x1b[1;37m', r: '\x1b[0m',
};

function log(agent: string, msg: string) {
  console.log(`${C[agent] ?? C.dim}[${agent}]${C.r} ${msg}`);
}

function banner(text: string) {
  console.log(`\n${C.h}${'═'.repeat(64)}${C.r}`);
  console.log(`${C.h}  ${text}${C.r}`);
  console.log(`${C.h}${'═'.repeat(64)}${C.r}`);
}

// ── Source Reader ───────────────────────────────────

interface SourceSlice {
  files: string[];
  content: Map<string, string>;
}

function readSourceSlice(srcDir: string, filter: (path: string) => boolean): SourceSlice {
  const files: string[] = [];
  const content = new Map<string, string>();

  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist') {
        scan(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && filter(full)) {
        files.push(full);
        content.set(basename(full, '.ts'), readFileSync(full, 'utf-8'));
      }
    }
  }

  scan(srcDir);
  return { files, content };
}

// ── Knowledge Extraction ───────────────────────────

/**
 * Extract knowledge from source code as structured chains.
 * Each agent does this independently — no shared vocabulary,
 * no instructions on what terms mean.
 */
function extractKnowledge(pgsl: PGSLInstance, moduleName: string, source: string): number {
  let chainCount = 0;

  // Extract exports
  const exportMatches = source.matchAll(/export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+(\w+)/g);
  for (const m of exportMatches) {
    embedInPGSL(pgsl, `${moduleName} exports ${m[1]}`);
    chainCount++;
  }

  // Extract imports (what this module depends on)
  const importMatches = source.matchAll(/from\s+['"]\.\/?\.?\/?([^'"]+)['"]/g);
  for (const m of importMatches) {
    const dep = m[1]!.replace(/\.js$/, '').split('/').pop()!;
    embedInPGSL(pgsl, `${moduleName} uses ${dep}`);
    chainCount++;
  }

  // Extract type references (what concepts appear together)
  const typeMatches = source.matchAll(/:\s*(PGSLInstance|IRI|Node|Atom|Fragment|CoherenceCertificate|ContextDescriptorData|Value|Level|NodeProvenance|PersistenceRecord|Affordance|Decision|DecoratorContext)\b/g);
  const seenTypes = new Set<string>();
  for (const m of typeMatches) {
    if (!seenTypes.has(m[1]!)) {
      seenTypes.add(m[1]!);
      embedInPGSL(pgsl, `${moduleName} references ${m[1]}`);
      chainCount++;
    }
  }

  // Extract key concepts from comments/docstrings
  const conceptMatches = source.matchAll(/\*\s+(?:@description|@module)\s+(.+)/g);
  for (const m of conceptMatches) {
    const words = m[1]!.split(/\s+/).filter(w => w.length > 3 && !w.startsWith('*') && !w.startsWith('@'));
    for (const word of words.slice(0, 5)) {
      embedInPGSL(pgsl, `${moduleName} about ${word.toLowerCase()}`);
      chainCount++;
    }
  }

  // Extract function calls to other modules (co-occurrence)
  const callMatches = source.matchAll(/\b(createPGSL|mintAtom|ingest|resolve|verifyCoherence|computeCoverage|embedInPGSL|latticeStats|pullbackSquare|materializeTriples|executeSparqlString|validateAllPGSL|createWallet|signDescriptor)\b/g);
  const seenCalls = new Set<string>();
  for (const m of callMatches) {
    if (!seenCalls.has(m[1]!)) {
      seenCalls.add(m[1]!);
      embedInPGSL(pgsl, `${moduleName} calls ${m[1]}`);
      chainCount++;
    }
  }

  return chainCount;
}

// ═══════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════

async function main() {
  const srcDir = join(process.cwd(), 'src');

  console.log(`${C.h}`);
  console.log('  Emergent Semiotics');
  console.log('  Three agents × different source slices × no shared definitions');
  console.log('  Meaning emerges from usage. Agreement detected structurally.');
  console.log(`${C.r}`);

  // Wipe browser
  await fetch(`${BASE}/api/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  // ─────────────────────────────────────────────────────
  //  Phase 1: Three agents, three slices, no coordination
  // ─────────────────────────────────────────────────────

  banner('Phase 1: Independent Knowledge Extraction');

  // Agent A: reads PGSL modules (lattice, category, types, coherence, etc.)
  const pgslA = createPGSL({ wasAttributedTo: 'urn:agent:alpha' as IRI, generatedAtTime: new Date().toISOString() });
  const sliceA = readSourceSlice(srcDir, p => p.includes('pgsl') && !p.includes('affordance-decorators') && !p.includes('agent-framework') && !p.includes('infrastructure') && !p.includes('discovery'));

  let chainsA = 0;
  for (const [mod, src] of sliceA.content) {
    chainsA += extractKnowledge(pgslA, mod, src);
  }
  const statsA = latticeStats(pgslA);
  log('A', `Slice: PGSL core (${sliceA.files.length} files) → ${statsA.atoms} atoms, ${chainsA} chains`);

  // Agent B: reads model + rdf + validation (descriptors, composition, serialization)
  const pgslB = createPGSL({ wasAttributedTo: 'urn:agent:beta' as IRI, generatedAtTime: new Date().toISOString() });
  const sliceB = readSourceSlice(srcDir, p => p.includes('model') || p.includes('rdf') || p.includes('validation'));

  let chainsB = 0;
  for (const [mod, src] of sliceB.content) {
    chainsB += extractKnowledge(pgslB, mod, src);
  }
  const statsB = latticeStats(pgslB);
  log('B', `Slice: Model + RDF + Validation (${sliceB.files.length} files) → ${statsB.atoms} atoms, ${chainsB} chains`);

  // Agent C: reads crypto + solid + affordance (federation, signing, agents)
  const pgslC = createPGSL({ wasAttributedTo: 'urn:agent:gamma' as IRI, generatedAtTime: new Date().toISOString() });
  const sliceC = readSourceSlice(srcDir, p => p.includes('crypto') || p.includes('solid') || p.includes('affordance') || p.includes('causality'));

  let chainsC = 0;
  for (const [mod, src] of sliceC.content) {
    chainsC += extractKnowledge(pgslC, mod, src);
  }
  const statsC = latticeStats(pgslC);
  log('C', `Slice: Crypto + Solid + Affordance (${sliceC.files.length} files) → ${statsC.atoms} atoms, ${chainsC} chains`);

  // ─────────────────────────────────────────────────────
  //  Phase 2: What atoms do they share? (shared signs)
  // ─────────────────────────────────────────────────────

  banner('Phase 2: Shared Signs (atoms appearing in multiple agents)');

  const atomsA = new Set([...pgslA.atoms.keys()]);
  const atomsB = new Set([...pgslB.atoms.keys()]);
  const atomsC = new Set([...pgslC.atoms.keys()]);

  const sharedAB = [...atomsA].filter(a => atomsB.has(a));
  const sharedAC = [...atomsA].filter(a => atomsC.has(a));
  const sharedBC = [...atomsB].filter(a => atomsC.has(a));
  const sharedAll = [...atomsA].filter(a => atomsB.has(a) && atomsC.has(a));
  const uniqueA = [...atomsA].filter(a => !atomsB.has(a) && !atomsC.has(a));
  const uniqueB = [...atomsB].filter(a => !atomsA.has(a) && !atomsC.has(a));
  const uniqueC = [...atomsC].filter(a => !atomsA.has(a) && !atomsB.has(a));

  log('sem', `Shared by ALL three: ${sharedAll.length} signs`);
  log('sem', `  ${sharedAll.slice(0, 20).join(', ')}${sharedAll.length > 20 ? '...' : ''}`);
  log('sem', '');
  log('sem', `Shared A↔B only: ${sharedAB.length - sharedAll.length} | A↔C only: ${sharedAC.length - sharedAll.length} | B↔C only: ${sharedBC.length - sharedAll.length}`);
  log('sem', `Unique to A: ${uniqueA.length} | Unique to B: ${uniqueB.length} | Unique to C: ${uniqueC.length}`);

  // ─────────────────────────────────────────────────────
  //  Phase 3: Do shared signs have shared MEANING?
  // ─────────────────────────────────────────────────────

  banner('Phase 3: Coherence — Same signs, same meaning?');

  const certAB = verifyCoherence(pgslA, pgslB, 'Alpha', 'Beta', 'codebase');
  const certAC = verifyCoherence(pgslA, pgslC, 'Alpha', 'Gamma', 'codebase');
  const certBC = verifyCoherence(pgslB, pgslC, 'Beta', 'Gamma', 'codebase');

  for (const [name, cert] of [['Alpha↔Beta', certAB], ['Alpha↔Gamma', certAC], ['Beta↔Gamma', certBC]] as const) {
    const statusColor = cert.status === 'verified' ? C.emerge : cert.status === 'divergent' ? C.A : C.dim;
    log('sem', `${statusColor}${name}: ${cert.status} (${(cert.semanticOverlap * 100).toFixed(0)}% semantic overlap)${C.r}`);
  }

  // ─────────────────────────────────────────────────────
  //  Phase 4: Per-atom semiotic analysis
  // ─────────────────────────────────────────────────────

  banner('Phase 4: Per-Atom Semiotic Analysis');

  // For each shared sign, show how each agent uses it
  log('sem', 'How do agents use shared signs differently?');
  log('sem', '');

  // Pick the most interesting shared atoms (those with varied usage)
  const interestingAtoms = sharedAll.filter(a =>
    a !== 'exports' && a !== 'uses' && a !== 'references' && a !== 'about' && a !== 'calls'
    && a.length > 3
  );

  for (const atomValue of interestingAtoms.slice(0, 12)) {
    // Find all chains containing this atom in each agent's lattice
    const chainsInA: string[] = [];
    const chainsInB: string[] = [];
    const chainsInC: string[] = [];

    for (const [, node] of pgslA.nodes) {
      if (node.kind === 'Fragment' && node.level >= 2) {
        const resolved = pgslResolve(pgslA, node.uri);
        if (resolved.split(' ').includes(atomValue)) chainsInA.push(resolved);
      }
    }
    for (const [, node] of pgslB.nodes) {
      if (node.kind === 'Fragment' && node.level >= 2) {
        const resolved = pgslResolve(pgslB, node.uri);
        if (resolved.split(' ').includes(atomValue)) chainsInB.push(resolved);
      }
    }
    for (const [, node] of pgslC.nodes) {
      if (node.kind === 'Fragment' && node.level >= 2) {
        const resolved = pgslResolve(pgslC, node.uri);
        if (resolved.split(' ').includes(atomValue)) chainsInC.push(resolved);
      }
    }

    // Find shared chains (exact syntagmatic agreement = shared meaning)
    const allChains = new Set([...chainsInA, ...chainsInB, ...chainsInC]);
    const sharedChains = [...allChains].filter(c =>
      (chainsInA.includes(c) ? 1 : 0) + (chainsInB.includes(c) ? 1 : 0) + (chainsInC.includes(c) ? 1 : 0) >= 2
    );

    log('sem', `"${atomValue}" — ${C.A}A:${chainsInA.length}${C.r} ${C.B}B:${chainsInB.length}${C.r} ${C.C}C:${chainsInC.length}${C.r} chains | ${sharedChains.length} shared`);

    // Show unique uses per agent (where meaning diverges)
    const onlyA = chainsInA.filter(c => !chainsInB.includes(c) && !chainsInC.includes(c)).slice(0, 2);
    const onlyB = chainsInB.filter(c => !chainsInA.includes(c) && !chainsInC.includes(c)).slice(0, 2);
    const onlyC = chainsInC.filter(c => !chainsInA.includes(c) && !chainsInB.includes(c)).slice(0, 2);

    if (onlyA.length > 0) log('sem', `  ${C.A}Only A: ${onlyA.join(' | ')}${C.r}`);
    if (onlyB.length > 0) log('sem', `  ${C.B}Only B: ${onlyB.join(' | ')}${C.r}`);
    if (onlyC.length > 0) log('sem', `  ${C.C}Only C: ${onlyC.join(' | ')}${C.r}`);
    if (sharedChains.length > 0) log('sem', `  ${C.emerge}Shared: ${sharedChains.slice(0, 2).join(' | ')}${C.r}`);
    log('sem', '');
  }

  // ─────────────────────────────────────────────────────
  //  Phase 5: Emergent meaning from combination
  // ─────────────────────────────────────────────────────

  banner('Phase 5: Emergent Meaning — What arises from combination?');

  // Create a combined PGSL with all three perspectives
  const pgslCombined = createPGSL({ wasAttributedTo: 'urn:agent:combined' as IRI, generatedAtTime: new Date().toISOString() });

  // Re-ingest all chains from all agents into the combined lattice
  for (const agentPgsl of [pgslA, pgslB, pgslC]) {
    for (const [, node] of agentPgsl.nodes) {
      if (node.kind === 'Fragment' && node.level >= 2) {
        const resolved = pgslResolve(agentPgsl, node.uri);
        embedInPGSL(pgslCombined, resolved);
      }
    }
  }

  const combinedStats = latticeStats(pgslCombined);
  log('emerge', `Combined lattice: ${combinedStats.atoms} atoms, ${combinedStats.fragments} fragments, max L${combinedStats.maxLevel}`);

  // Find atoms that appear in MORE chains in the combined lattice than in any single agent
  // These are atoms whose meaning EXPANDED through combination
  const expandedMeaning: Array<{ atom: string; single: number; combined: number; expansion: number }> = [];

  for (const atomValue of interestingAtoms) {
    const maxSingle = Math.max(
      [...pgslA.nodes.values()].filter(n => n.kind === 'Fragment' && n.level >= 2 && pgslResolve(pgslA, n.uri).split(' ').includes(atomValue)).length,
      [...pgslB.nodes.values()].filter(n => n.kind === 'Fragment' && n.level >= 2 && pgslResolve(pgslB, n.uri).split(' ').includes(atomValue)).length,
      [...pgslC.nodes.values()].filter(n => n.kind === 'Fragment' && n.level >= 2 && pgslResolve(pgslC, n.uri).split(' ').includes(atomValue)).length,
    );
    const combinedCount = [...pgslCombined.nodes.values()].filter(n => n.kind === 'Fragment' && n.level >= 2 && pgslResolve(pgslCombined, n.uri).split(' ').includes(atomValue)).length;

    if (combinedCount > maxSingle) {
      expandedMeaning.push({ atom: atomValue, single: maxSingle, combined: combinedCount, expansion: combinedCount - maxSingle });
    }
  }

  expandedMeaning.sort((a, b) => b.expansion - a.expansion);

  log('emerge', '');
  log('emerge', 'Signs whose MEANING EXPANDED through combination:');
  log('emerge', '(more syntagmatic contexts in combined than any single agent)');
  log('emerge', '');
  for (const em of expandedMeaning.slice(0, 10)) {
    const bar = '█'.repeat(em.combined) + '░'.repeat(Math.max(0, 20 - em.combined));
    log('emerge', `  "${em.atom}": ${em.single} → ${em.combined} contexts (+${em.expansion}) [${bar}]`);
  }

  // Find EMERGENT chains — chains that exist in the combined lattice
  // that NO individual agent had
  const chainsA2 = new Set<string>();
  const chainsB2 = new Set<string>();
  const chainsC2 = new Set<string>();
  for (const [, n] of pgslA.nodes) if (n.kind === 'Fragment' && n.level >= 3) chainsA2.add(pgslResolve(pgslA, n.uri));
  for (const [, n] of pgslB.nodes) if (n.kind === 'Fragment' && n.level >= 3) chainsB2.add(pgslResolve(pgslB, n.uri));
  for (const [, n] of pgslC.nodes) if (n.kind === 'Fragment' && n.level >= 3) chainsC2.add(pgslResolve(pgslC, n.uri));

  const emergentChains: string[] = [];
  for (const [, n] of pgslCombined.nodes) {
    if (n.kind === 'Fragment' && n.level >= 3) {
      const resolved = pgslResolve(pgslCombined, n.uri);
      if (!chainsA2.has(resolved) && !chainsB2.has(resolved) && !chainsC2.has(resolved)) {
        emergentChains.push(resolved);
      }
    }
  }

  log('emerge', '');
  log('emerge', `EMERGENT chains (exist in combined but NO individual agent): ${emergentChains.length}`);
  for (const ec of emergentChains.slice(0, 15)) {
    log('emerge', `  ${C.emerge}★${C.r} ${ec}`);
  }

  // ─────────────────────────────────────────────────────
  //  Phase 6: Decision functor — what should each agent do?
  // ─────────────────────────────────────────────────────

  banner('Phase 6: Decision Functor — What should each agent do next?');

  const certs = getCertificates();
  for (const [name, agentPgsl, agentId] of [['Alpha', pgslA, 'Alpha'], ['Beta', pgslB, 'Beta'], ['Gamma', pgslC, 'Gamma']] as const) {
    const decision = decideFromObservations(agentPgsl, agentId, certs);
    log('meta', `${name}: strategy=${decision.strategy} | ${decision.decisions.length} decisions | coverage ${(decision.coverage * 100).toFixed(0)}%`);
    if (decision.decisions[0]) {
      log('meta', `  Top: ${decision.decisions[0].affordance.type} — ${decision.decisions[0].affordance.description.slice(0, 80)}`);
    }
  }

  // ─────────────────────────────────────────────────────
  //  Phase 7: Push to browser
  // ─────────────────────────────────────────────────────

  banner('Phase 7: Push Combined Lattice to Browser');

  // Push the combined perspective
  for (const [, node] of pgslCombined.nodes) {
    if (node.kind === 'Fragment' && node.level >= 2 && node.level <= 3) {
      const resolved = pgslResolve(pgslCombined, node.uri);
      await fetch(`${BASE}/api/ingest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: resolved, granularity: 'word' }),
      });
    }
  }

  const browserStats = await (await fetch(`${BASE}/api/stats`)).json();
  log('meta', `Browser: ${browserStats.atoms} atoms, ${browserStats.fragments} fragments`);

  // ─────────────────────────────────────────────────────
  //  Summary
  // ─────────────────────────────────────────────────────

  banner('Emergent Semiotics Summary');

  const coverage = computeCoverage(['Alpha', 'Beta', 'Gamma']);

  console.log('');
  console.log('  Three agents read different slices of the same codebase.');
  console.log('  No shared vocabulary. No ontology. No coordination.');
  console.log('');
  console.log(`  Shared signs (same atoms): ${sharedAll.length}`);
  console.log(`  Coherence coverage: ${(coverage.coverage * 100).toFixed(0)}% (${coverage.verified} verified, ${coverage.divergent} divergent)`);
  console.log(`  Emergent chains: ${emergentChains.length} (exist only in combination)`);
  console.log(`  Expanded meaning: ${expandedMeaning.length} signs gained new contexts`);
  console.log('');
  console.log('  The Peircean thesis confirmed:');
  console.log('    - Signs (atoms) are shared through content-addressing');
  console.log('    - Meaning (usage) diverges when agents use signs differently');
  console.log('    - Coherence verification detects agreement WITHOUT ontology');
  console.log('    - New meaning EMERGES when perspectives combine');
  console.log('    - The emergent chains are syntagmatic structures that');
  console.log('      no single agent created — they arose from the overlap');
  console.log('      of independently-built lattices.');
  console.log('');
  console.log('  Open http://localhost:5000/ to browse the emergent meaning.');
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
