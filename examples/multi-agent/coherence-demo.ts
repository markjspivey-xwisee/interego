#!/usr/bin/env tsx
/**
 * Context Graphs 1.0 — Multi-Agent Coherence Demo
 *
 * Healthcare Handoff scenario: three agents independently document
 * aspects of a patient visit, then discover alignment (or lack of it)
 * through coherence verification.
 *
 *   ER Agent — Emergency room documentation
 *   Radiology Agent — Imaging and structural findings
 *   Pharmacy Agent — Medication management and allergies
 *
 * Key insight: meaning is usage, not existence. Two agents may share
 * the atom "diagnosis" but only share its MEANING if they use it in
 * the same syntagmatic contexts. The ER's "diagnosis acute coronary
 * syndrome" and Radiology's "diagnosis no fracture detected" share
 * the sign but diverge in usage — coherence verification surfaces
 * this structural divergence automatically.
 *
 * Five phases:
 *   1. Independent documentation — each agent ingests into its own PGSL
 *   2. Pairwise coherence checks — discover partial alignment
 *   3. Context sharing — cross-pollinate to increase overlap
 *   4. Coverage & contract discovery — emergent data contracts
 *   5. PGSL structural analysis — combined lattice, SPARQL, SHACL
 *
 * No server needed — runs purely in-memory against PGSL lattices.
 */

import {
  createPGSL,
  embedInPGSL,
  latticeStats,
  pgslResolve,
  verifyCoherence,
  computeCoverage,
  getCertificates,
  getCoherenceStatus,
  sparqlQueryPGSL,
  sparqlFragmentsContaining,
  validateAllPGSL,
  mintAtom,
  ingest,
} from '@foxxi/context-graphs';

import type { IRI, PGSLInstance } from '@foxxi/context-graphs';

// ── Colors & Logging ───────────────────────────────────────

const COLORS: Record<string, string> = {
  ER:        '\x1b[31m',  // red
  Radiology: '\x1b[35m',  // magenta
  Pharmacy:  '\x1b[33m',  // yellow
  Coherence: '\x1b[36m',  // cyan
  PGSL:      '\x1b[32m',  // green
  System:    '\x1b[90m',  // gray
  Reset:     '\x1b[0m',
};

function log(agent: string, msg: string): void {
  console.log(`${COLORS[agent] ?? COLORS.System}[${agent}]${COLORS.Reset} ${msg}`);
}

function banner(text: string): void {
  console.log('');
  console.log(`${'─'.repeat(64)}`);
  console.log(`  ${text}`);
  console.log(`${'─'.repeat(64)}`);
}

// ═════════════════════════════════════════════════════════════
//  Phase 1: Independent Documentation
//  Each agent ingests patient data into its own PGSL lattice.
//  Same patient, same visit — but different clinical perspectives.
// ═════════════════════════════════════════════════════════════

function phase1_independentDocumentation(): {
  erPgsl: PGSLInstance;
  radPgsl: PGSLInstance;
  rxPgsl: PGSLInstance;
} {
  banner('Phase 1: Independent Documentation');

  // ── ER Agent ──
  log('ER', 'Documenting emergency room visit for patient Smith...');

  const erPgsl = createPGSL({
    wasAttributedTo: 'urn:agent:er-dept' as IRI,
    generatedAtTime: new Date().toISOString(),
  });

  const erDocs = [
    'patient Smith admitted chest pain',
    'patient Smith medication aspirin administered',
    'patient Smith diagnosis acute coronary syndrome',
    'patient Smith vitals blood pressure 140 90',
  ];

  for (const doc of erDocs) {
    embedInPGSL(erPgsl, doc);
    log('ER', `  ingested: "${doc}"`);
  }

  const erStats = latticeStats(erPgsl);
  log('ER', `  lattice: ${erStats.atoms} atoms, ${erStats.fragments} fragments`);

  // ── Radiology Agent ──
  log('Radiology', 'Documenting imaging results for patient Smith...');

  const radPgsl = createPGSL({
    wasAttributedTo: 'urn:agent:radiology-dept' as IRI,
    generatedAtTime: new Date().toISOString(),
  });

  const radDocs = [
    'patient Smith chest xray ordered',
    'patient Smith chest xray completed normal',
    'patient Smith diagnosis no fracture detected',
  ];

  for (const doc of radDocs) {
    embedInPGSL(radPgsl, doc);
    log('Radiology', `  ingested: "${doc}"`);
  }

  const radStats = latticeStats(radPgsl);
  log('Radiology', `  lattice: ${radStats.atoms} atoms, ${radStats.fragments} fragments`);

  // ── Pharmacy Agent ──
  log('Pharmacy', 'Documenting medication orders for patient Smith...');

  const rxPgsl = createPGSL({
    wasAttributedTo: 'urn:agent:pharmacy-dept' as IRI,
    generatedAtTime: new Date().toISOString(),
  });

  const rxDocs = [
    'patient Smith medication aspirin 325mg daily',
    'patient Smith medication clopidogrel 75mg daily',
    'patient Smith allergy penicillin documented',
  ];

  for (const doc of rxDocs) {
    embedInPGSL(rxPgsl, doc);
    log('Pharmacy', `  ingested: "${doc}"`);
  }

  const rxStats = latticeStats(rxPgsl);
  log('Pharmacy', `  lattice: ${rxStats.atoms} atoms, ${rxStats.fragments} fragments`);

  log('System', 'All three agents have documented independently.');
  log('System', 'Shared signs exist ("patient", "Smith", "medication", "diagnosis")');
  log('System', 'but do they share MEANING? Coherence will tell us.');

  return { erPgsl, radPgsl, rxPgsl };
}

// ═════════════════════════════════════════════════════════════
//  Phase 2: Pairwise Coherence Checks
//  Run verifyCoherence between each pair of agents.
//  Surfaces where meaning aligns and where it diverges.
// ═════════════════════════════════════════════════════════════

function phase2_coherenceChecks(
  erPgsl: PGSLInstance,
  radPgsl: PGSLInstance,
  rxPgsl: PGSLInstance,
): void {
  banner('Phase 2: Pairwise Coherence Verification');

  const pairs: Array<{
    nameA: string; nameB: string;
    pgslA: PGSLInstance; pgslB: PGSLInstance;
    topic: string;
  }> = [
    { nameA: 'ER', nameB: 'Radiology', pgslA: erPgsl, pgslB: radPgsl, topic: 'patient-smith-visit' },
    { nameA: 'ER', nameB: 'Pharmacy',  pgslA: erPgsl, pgslB: rxPgsl,  topic: 'patient-smith-visit' },
    { nameA: 'Radiology', nameB: 'Pharmacy', pgslA: radPgsl, pgslB: rxPgsl, topic: 'patient-smith-visit' },
  ];

  for (const { nameA, nameB, pgslA, pgslB, topic } of pairs) {
    log('Coherence', '');
    log('Coherence', `Verifying: ${nameA} <-> ${nameB}`);

    const cert = verifyCoherence(pgslA, pgslB, nameA, nameB, topic);

    log('Coherence', `  Status: ${cert.status.toUpperCase()}`);
    log('Coherence', `  Semantic overlap: ${(cert.semanticOverlap * 100).toFixed(1)}%`);
    log('Coherence', `  Shared patterns: ${cert.sharedPatterns.length}`);
    log('Coherence', `  Certificate: ${cert.id}`);

    if (cert.sharedStructure) {
      log('Coherence', `  Structure: ${cert.sharedStructure}`);
    }

    if (cert.obstruction) {
      log('Coherence', `  Obstruction: ${cert.obstruction.type}`);
      log('Coherence', `  Description: ${cert.obstruction.description}`);
      for (const item of cert.obstruction.divergentItems.slice(0, 3)) {
        log('Coherence', `    divergent: ${item}`);
      }
    }

    // Show per-atom semantic profiles — the heart of usage-based semantics
    log('Coherence', '  Per-atom profiles:');
    for (const profile of cert.semanticProfile.slice(0, 6)) {
      const bar = profile.overlap >= 0.7 ? '+++' :
                  profile.overlap >= 0.3 ? '++.' :
                  profile.overlap > 0   ? '+..' : '...';
      log('Coherence', `    "${profile.atom}" [${bar}] overlap=${(profile.overlap * 100).toFixed(0)}% ` +
        `(A=${profile.usagesA}, B=${profile.usagesB}, shared=${profile.sharedUsages})`);
    }
  }

  log('Coherence', '');
  log('Coherence', 'Key finding: "patient" and "Smith" have high overlap — both agents');
  log('Coherence', 'use them in the same syntagmatic position (subject of clinical facts).');
  log('Coherence', '"diagnosis" DIVERGES — ER uses it with "acute coronary syndrome",');
  log('Coherence', 'Radiology uses it with "no fracture detected". Same sign, different meaning.');
}

// ═════════════════════════════════════════════════════════════
//  Phase 3: Context Sharing
//  Agents share specific context to increase alignment.
//  ER shares diagnosis with Radiology; Pharmacy shares meds with ER.
// ═════════════════════════════════════════════════════════════

function phase3_contextSharing(
  erPgsl: PGSLInstance,
  radPgsl: PGSLInstance,
  rxPgsl: PGSLInstance,
): void {
  banner('Phase 3: Context Sharing');

  // ER shares its diagnosis context with Radiology
  log('ER', 'Sharing diagnosis context with Radiology...');
  embedInPGSL(radPgsl, 'patient Smith diagnosis acute coronary syndrome');
  log('ER', '  -> Radiology now has ER diagnosis alongside its own imaging findings');

  const radStats = latticeStats(radPgsl);
  log('Radiology', `  Updated lattice: ${radStats.atoms} atoms, ${radStats.fragments} fragments`);

  // Pharmacy shares medication context with ER
  log('Pharmacy', 'Sharing medication details with ER...');
  embedInPGSL(erPgsl, 'patient Smith medication aspirin 325mg daily');
  embedInPGSL(erPgsl, 'patient Smith medication clopidogrel 75mg daily');
  log('Pharmacy', '  -> ER now has full medication dosing info');

  const erStats = latticeStats(erPgsl);
  log('ER', `  Updated lattice: ${erStats.atoms} atoms, ${erStats.fragments} fragments`);

  // Re-run coherence checks to show increased alignment
  log('Coherence', '');
  log('Coherence', 'Re-verifying after context sharing...');

  const certERRad = verifyCoherence(erPgsl, radPgsl, 'ER', 'Radiology', 'patient-smith-post-share');
  log('Coherence', `  ER <-> Radiology: ${certERRad.status} (overlap: ${(certERRad.semanticOverlap * 100).toFixed(1)}%)`);

  const certERRx = verifyCoherence(erPgsl, rxPgsl, 'ER', 'Pharmacy', 'patient-smith-post-share');
  log('Coherence', `  ER <-> Pharmacy:  ${certERRx.status} (overlap: ${(certERRx.semanticOverlap * 100).toFixed(1)}%)`);

  const certRadRx = verifyCoherence(radPgsl, rxPgsl, 'Radiology', 'Pharmacy', 'patient-smith-post-share');
  log('Coherence', `  Radiology <-> Pharmacy: ${certRadRx.status} (overlap: ${(certRadRx.semanticOverlap * 100).toFixed(1)}%)`);

  log('Coherence', '');
  log('Coherence', 'Sharing context increases semantic overlap because the agents');
  log('Coherence', 'now USE the same atoms in more similar syntagmatic contexts.');
  log('Coherence', 'Meaning converges through shared usage, not through ontology alignment.');
}

// ═════════════════════════════════════════════════════════════
//  Phase 4: Coverage & Contract Discovery
//  Compute coverage across all agents. Identify emergent
//  data contracts — atoms and patterns that all agents share.
// ═════════════════════════════════════════════════════════════

function phase4_coverageAndContracts(): void {
  banner('Phase 4: Coverage & Emergent Data Contracts');

  const agents = ['ER', 'Radiology', 'Pharmacy'];
  const coverage = computeCoverage(agents);

  log('Coherence', `Total agent pairs: ${coverage.totalPairs}`);
  log('Coherence', `  Verified:   ${coverage.verified}`);
  log('Coherence', `  Divergent:  ${coverage.divergent}`);
  log('Coherence', `  Unexamined: ${coverage.unexamined}`);
  log('Coherence', `  Coverage:   ${(coverage.coverage * 100).toFixed(0)}%`);

  if (coverage.unexaminedPairs.length > 0) {
    log('Coherence', '  WARNING: Unexamined pairs (the dangerous state):');
    for (const pair of coverage.unexaminedPairs) {
      log('Coherence', `    ${pair.agentA} <-> ${pair.agentB}`);
    }
  }

  // Inspect all certificates to find emergent data contracts
  const allCerts = getCertificates();
  log('Coherence', '');
  log('Coherence', `Total certificates issued: ${allCerts.length}`);

  // Find atoms that appear with high overlap across multiple certificates
  // These represent emergent data contracts — structural agreements
  // that no one explicitly designed
  const atomOverlaps = new Map<string, { total: number; count: number; pairs: string[] }>();

  for (const cert of allCerts) {
    for (const profile of cert.semanticProfile) {
      const existing = atomOverlaps.get(profile.atom) ?? { total: 0, count: 0, pairs: [] };
      existing.total += profile.overlap;
      existing.count += 1;
      existing.pairs.push(`${cert.agentA}-${cert.agentB}`);
      atomOverlaps.set(profile.atom, existing);
    }
  }

  log('Coherence', '');
  log('Coherence', 'Emergent Data Contracts (atoms with high cross-agent overlap):');
  log('Coherence', '');

  const sorted = [...atomOverlaps.entries()]
    .map(([atom, data]) => ({ atom, avgOverlap: data.total / data.count, ...data }))
    .sort((a, b) => b.avgOverlap - a.avgOverlap);

  for (const entry of sorted.slice(0, 10)) {
    const status = entry.avgOverlap >= 0.7 ? 'CONTRACT' :
                   entry.avgOverlap >= 0.3 ? 'emerging' : 'divergent';
    const icon = entry.avgOverlap >= 0.7 ? '[=]' :
                 entry.avgOverlap >= 0.3 ? '[~]' : '[x]';
    log('Coherence', `  ${icon} "${entry.atom}" avg overlap: ${(entry.avgOverlap * 100).toFixed(0)}% ` +
      `across ${entry.count} pair(s) -> ${status}`);
  }

  log('Coherence', '');
  log('Coherence', 'Data contracts are EMERGENT: no schema was agreed upon in advance.');
  log('Coherence', 'The contract is discovered from actual usage patterns across agents.');
  log('Coherence', 'This is how language works — meaning stabilizes through use.');
}

// ═════════════════════════════════════════════════════════════
//  Phase 5: PGSL Structural Analysis
//  Combined lattice with SPARQL queries and SHACL validation.
// ═════════════════════════════════════════════════════════════

function phase5_structuralAnalysis(
  erPgsl: PGSLInstance,
  radPgsl: PGSLInstance,
  rxPgsl: PGSLInstance,
): void {
  banner('Phase 5: PGSL Structural Analysis');

  // Create a combined PGSL instance with all content from all agents
  log('PGSL', 'Creating combined lattice from all three agents...');

  const combined = createPGSL({
    wasAttributedTo: 'urn:agent:coherence-demo:combined' as IRI,
    generatedAtTime: new Date().toISOString(),
  });

  // Re-ingest all content into the combined lattice
  const allContent = [
    // ER
    'patient Smith admitted chest pain',
    'patient Smith medication aspirin administered',
    'patient Smith diagnosis acute coronary syndrome',
    'patient Smith vitals blood pressure 140 90',
    // Radiology
    'patient Smith chest xray ordered',
    'patient Smith chest xray completed normal',
    'patient Smith diagnosis no fracture detected',
    // Pharmacy
    'patient Smith medication aspirin 325mg daily',
    'patient Smith medication clopidogrel 75mg daily',
    'patient Smith allergy penicillin documented',
  ];

  for (const content of allContent) {
    embedInPGSL(combined, content);
  }

  const combinedStats = latticeStats(combined);
  log('PGSL', `Combined lattice: ${combinedStats.atoms} atoms, ${combinedStats.fragments} fragments, max level ${combinedStats.maxLevel}`);

  // SPARQL: Find all fragments containing "patient" — the universal anchor
  log('PGSL', '');
  log('PGSL', 'SPARQL: Fragments containing shared atom "patient"...');
  const patientAtom = combined.atoms.get('patient');
  if (patientAtom) {
    const query = sparqlFragmentsContaining(patientAtom);
    const result = sparqlQueryPGSL(combined, query);
    log('PGSL', `  "patient" appears in ${result.bindings.length} fragments`);
    log('PGSL', '  -> This atom is the structural anchor across all three departments');
    log('PGSL', '  -> Content-addressed: one canonical URI, zero duplication');
  }

  // SPARQL: Find fragments containing "Smith"
  const smithAtom = combined.atoms.get('Smith');
  if (smithAtom) {
    const query = sparqlFragmentsContaining(smithAtom);
    const result = sparqlQueryPGSL(combined, query);
    log('PGSL', `  "Smith" appears in ${result.bindings.length} fragments`);
  }

  // SPARQL: Find fragments containing "diagnosis" — the divergent atom
  const diagnosisAtom = combined.atoms.get('diagnosis');
  if (diagnosisAtom) {
    const query = sparqlFragmentsContaining(diagnosisAtom);
    const result = sparqlQueryPGSL(combined, query);
    log('PGSL', `  "diagnosis" appears in ${result.bindings.length} fragments`);
    log('PGSL', '  -> Same atom, two different syntagmatic contexts:');
    log('PGSL', '     ER: "diagnosis acute coronary syndrome"');
    log('PGSL', '     Radiology: "diagnosis no fracture detected"');
    log('PGSL', '  -> The lattice preserves BOTH usages without conflation');
  }

  // SPARQL: Find fragments containing "medication" — partially shared
  const medAtom = combined.atoms.get('medication');
  if (medAtom) {
    const query = sparqlFragmentsContaining(medAtom);
    const result = sparqlQueryPGSL(combined, query);
    log('PGSL', `  "medication" appears in ${result.bindings.length} fragments`);
    log('PGSL', '  -> Shared by ER and Pharmacy, with overlapping usage contexts');
  }

  // SHACL validation
  log('PGSL', '');
  log('PGSL', 'SHACL validation of combined lattice...');
  const shaclResult = validateAllPGSL(combined);
  if (shaclResult.conforms) {
    log('PGSL', '  CONFORMS — all structural invariants hold');
  } else {
    log('PGSL', `  ${shaclResult.violations.length} violation(s):`);
    for (const v of shaclResult.violations.slice(0, 5)) {
      log('PGSL', `    ${v.severity}: ${v.message}`);
    }
  }

  // Per-agent lattice comparison
  log('PGSL', '');
  log('PGSL', 'Per-agent lattice statistics:');
  const agentLattices: Array<{ name: string; pgsl: PGSLInstance }> = [
    { name: 'ER', pgsl: erPgsl },
    { name: 'Radiology', pgsl: radPgsl },
    { name: 'Pharmacy', pgsl: rxPgsl },
    { name: 'Combined', pgsl: combined },
  ];

  for (const { name, pgsl } of agentLattices) {
    const stats = latticeStats(pgsl);
    log('PGSL', `  ${name.padEnd(12)} atoms=${String(stats.atoms).padStart(3)} ` +
      `fragments=${String(stats.fragments).padStart(3)} ` +
      `maxLevel=${stats.maxLevel}`);
  }

  log('PGSL', '');
  log('PGSL', 'The combined lattice has FEWER atoms than the sum of individual lattices');
  log('PGSL', 'because PGSL is content-addressed: "patient" is minted once, shared everywhere.');
  log('PGSL', 'This is structural deduplication — not string matching, but lattice identity.');
}

// ═════════════════════════════════════════════════════════════
//  Main
// ═════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Context Graphs 1.0 — Multi-Agent Coherence Demo');
  console.log('  Healthcare Handoff: ER -> Radiology -> Pharmacy');
  console.log('  Meaning is usage, not existence.');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Phase 1: Each agent documents independently
  const { erPgsl, radPgsl, rxPgsl } = phase1_independentDocumentation();

  // Phase 2: Discover alignment through coherence verification
  phase2_coherenceChecks(erPgsl, radPgsl, rxPgsl);

  // Phase 3: Share context to increase overlap
  phase3_contextSharing(erPgsl, radPgsl, rxPgsl);

  // Phase 4: Compute coverage and discover emergent data contracts
  phase4_coverageAndContracts();

  // Phase 5: Combined PGSL analysis with SPARQL and SHACL
  phase5_structuralAnalysis(erPgsl, radPgsl, rxPgsl);

  // Final summary
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Coherence Demo Complete');
  console.log('');
  console.log('  Three agents, three perspectives, one patient.');
  console.log('  Coherence verification revealed:');
  console.log('    - "patient" and "Smith": high overlap (shared usage)');
  console.log('    - "diagnosis": divergent (same sign, different meaning)');
  console.log('    - "medication": partial overlap (converging after sharing)');
  console.log('');
  console.log('  Emergent data contracts formed from usage patterns,');
  console.log('  not from pre-agreed schemas. This is how meaning works.');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
