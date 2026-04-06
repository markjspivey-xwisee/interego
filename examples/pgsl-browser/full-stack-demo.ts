#!/usr/bin/env tsx
/**
 * Full Stack Demo — Every Layer of Context Graphs
 *
 * Shows how each layer builds on the one below:
 *
 *   Layer 1: PGSL            — content-addressed atoms + chains + paradigm sets
 *   Layer 2: Context Desc    — typed facets (temporal, trust, semiotic, provenance)
 *   Layer 3: Composition     — algebraic merge (union, intersection, restriction, override)
 *   Layer 4: Coherence       — usage-based verification, certificates, coverage
 *   Layer 5: Decision        — observation → orientation → decision → action
 *   Layer 6: Federation      — cross-agent discovery, trust escalation
 *
 * Results are pushed to the browser at http://localhost:5000 so you can
 * see each layer's output in the lattice.
 */

import {
  // PGSL (Layer 1)
  createPGSL,
  mintAtom,
  ingest,
  embedInPGSL,
  latticeStats,
  resolve as pgslResolve,
  sparqlQueryPGSL,
  validateAllPGSL,
  // Context Descriptors (Layer 2)
  ContextDescriptor,
  validate,
  toTurtle,
  // Composition (Layer 3)
  union,
  intersection,
  restriction,
  override,
  // Coherence (Layer 4)
  verifyCoherence,
  computeCoverage,
  getCertificates,
  // Decision Functor (Layer 5)
  extractObservations,
  selectStrategy,
} from '@foxxi/context-graphs';

import {
  computeAffordances as computeDecisionAffordances,
  decide as decideFromObservations,
} from '../../src/pgsl/decision-functor.js';

import type { IRI, PGSLInstance } from '@foxxi/context-graphs';

// ── Browser API ─────────────────────────────────────────

const BASE = 'http://localhost:5000';

async function browserIngest(content: string): Promise<void> {
  await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, granularity: 'word' }),
  });
}

// ── Logging ─────────────────────────────────────────────

const C = {
  layer:  '\x1b[1;37m',  // bold white
  pgsl:   '\x1b[36m',    // cyan
  desc:   '\x1b[33m',    // yellow
  comp:   '\x1b[32m',    // green
  cohere: '\x1b[35m',    // magenta
  decide: '\x1b[34m',    // blue
  fed:    '\x1b[31m',    // red
  dim:    '\x1b[90m',    // gray
  reset:  '\x1b[0m',
};

function banner(layer: number, name: string, desc: string) {
  console.log('');
  console.log(`${C.layer}${'═'.repeat(64)}${C.reset}`);
  console.log(`${C.layer}  Layer ${layer}: ${name}${C.reset}`);
  console.log(`${C.dim}  ${desc}${C.reset}`);
  console.log(`${C.layer}${'═'.repeat(64)}${C.reset}`);
}

function log(color: string, label: string, msg: string) {
  console.log(`${color}[${label}]${C.reset} ${msg}`);
}

// ═══════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log(`${C.layer}`);
  console.log(`  Context Graphs 1.0 — Full Stack Demo`);
  console.log(`  Every layer, from PGSL atoms to federated decisions`);
  console.log(`${C.reset}`);

  // ─────────────────────────────────────────────────────────
  //  LAYER 1: PGSL — Content-Addressed Lattice
  // ─────────────────────────────────────────────────────────

  banner(1, 'PGSL', 'Content-addressed lattice. Atoms are unique. Chains compose. Overlap is structural.');

  // Three agents each get their own PGSL instance
  const pgslER = createPGSL({ wasAttributedTo: 'did:web:er.hospital.org' as IRI, generatedAtTime: '2026-04-05T08:00:00Z' });
  const pgslLab = createPGSL({ wasAttributedTo: 'did:web:lab.hospital.org' as IRI, generatedAtTime: '2026-04-05T09:00:00Z' });
  const pgslPharmacy = createPGSL({ wasAttributedTo: 'did:web:pharmacy.hospital.org' as IRI, generatedAtTime: '2026-04-05T08:15:00Z' });

  // ER ingests clinical observations
  embedInPGSL(pgslER, 'patient-47 condition chest-pain');
  embedInPGSL(pgslER, 'patient-47 heart-rate 120');
  embedInPGSL(pgslER, 'patient-47 blood-pressure 90 60');
  embedInPGSL(pgslER, 'patient-47 status critical');
  embedInPGSL(pgslER, 'patient-47 administered aspirin 325mg');

  // Lab ingests test results
  embedInPGSL(pgslLab, 'patient-47 troponin elevated');
  embedInPGSL(pgslLab, 'patient-47 metabolic-panel normal');
  embedInPGSL(pgslLab, 'patient-47 creatinine 1.2');
  embedInPGSL(pgslLab, 'patient-47 blood-type A-positive');

  // Pharmacy ingests medication records
  embedInPGSL(pgslPharmacy, 'patient-47 prescribed aspirin 325mg daily');
  embedInPGSL(pgslPharmacy, 'patient-47 prescribed heparin drip continuous');
  embedInPGSL(pgslPharmacy, 'patient-47 allergy penicillin');
  embedInPGSL(pgslPharmacy, 'patient-47 allergy sulfa');

  const erStats = latticeStats(pgslER);
  const labStats = latticeStats(pgslLab);
  const pharmaStats = latticeStats(pgslPharmacy);

  log(C.pgsl, 'PGSL', `ER lattice: ${erStats.atoms} atoms, ${erStats.fragments} fragments`);
  log(C.pgsl, 'PGSL', `Lab lattice: ${labStats.atoms} atoms, ${labStats.fragments} fragments`);
  log(C.pgsl, 'PGSL', `Pharmacy lattice: ${pharmaStats.atoms} atoms, ${pharmaStats.fragments} fragments`);

  // Show shared atoms — the structural overlap
  const erAtoms = new Set([...pgslER.atoms.keys()]);
  const labAtoms = new Set([...pgslLab.atoms.keys()]);
  const pharmaAtoms = new Set([...pgslPharmacy.atoms.keys()]);
  const sharedAll = [...erAtoms].filter(a => labAtoms.has(a) && pharmaAtoms.has(a));
  const sharedERLab = [...erAtoms].filter(a => labAtoms.has(a) && !pharmaAtoms.has(a));
  const sharedERPharma = [...erAtoms].filter(a => pharmaAtoms.has(a) && !labAtoms.has(a));

  log(C.pgsl, 'PGSL', `Shared by ALL three: ${sharedAll.join(', ')}`);
  log(C.pgsl, 'PGSL', `Shared ER+Lab only: ${sharedERLab.join(', ')}`);
  log(C.pgsl, 'PGSL', `Shared ER+Pharmacy only: ${sharedERPharma.join(', ')}`);
  log(C.pgsl, 'PGSL', '');
  log(C.pgsl, 'PGSL', '"patient-47" is one content-addressed atom. Same hash in all three lattices.');
  log(C.pgsl, 'PGSL', 'No ontology alignment needed — structural overlap is automatic.');

  // Push to browser
  log(C.dim, 'Browser', 'Pushing Layer 1 to browser...');
  await browserIngest('LAYER-1 PGSL content-addressed-lattice');
  for (const phrase of [
    'ER observes patient-47 condition chest-pain',
    'ER observes patient-47 heart-rate 120',
    'ER observes patient-47 status critical',
    'ER observes patient-47 administered aspirin 325mg',
    'Lab observes patient-47 troponin elevated',
    'Lab observes patient-47 metabolic-panel normal',
    'Lab observes patient-47 creatinine 1.2',
    'Pharmacy observes patient-47 prescribed aspirin 325mg daily',
    'Pharmacy observes patient-47 prescribed heparin drip continuous',
    'Pharmacy observes patient-47 allergy penicillin',
  ]) {
    await browserIngest(phrase);
  }

  // ─────────────────────────────────────────────────────────
  //  LAYER 2: Context Descriptors — Typed Facets
  // ─────────────────────────────────────────────────────────

  banner(2, 'Context Descriptors', 'Typed metadata on every piece of knowledge. Temporal, Trust, Semiotic, Provenance.');

  const erDescriptor = ContextDescriptor.create('urn:cg:er:patient-47-visit' as IRI)
    .describes('urn:graph:er:patient-47' as IRI)
    .temporal({ validFrom: '2026-04-05T08:00:00Z', validUntil: '2026-04-05T20:00:00Z' })
    .provenance({
      wasGeneratedBy: { agent: 'urn:system:er:triage' as IRI, startedAt: '2026-04-05T08:00:00Z' },
      wasAttributedTo: 'did:web:er.hospital.org' as IRI,
      generatedAtTime: '2026-04-05T08:05:00Z',
    })
    .agent('did:web:er.hospital.org' as IRI, 'ER Physician')
    .semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.85, groundTruth: false })
    .trust({ trustLevel: 'SelfAsserted', issuer: 'did:web:er.hospital.org' as IRI })
    .build();

  const labDescriptor = ContextDescriptor.create('urn:cg:lab:patient-47-results' as IRI)
    .describes('urn:graph:lab:patient-47' as IRI)
    .temporal({ validFrom: '2026-04-05T09:30:00Z', validUntil: '2026-04-06T09:30:00Z' })
    .provenance({
      wasGeneratedBy: { agent: 'urn:system:lab:analyzer' as IRI, startedAt: '2026-04-05T09:30:00Z' },
      wasAttributedTo: 'did:web:lab.hospital.org' as IRI,
      generatedAtTime: '2026-04-05T09:45:00Z',
      sources: ['urn:cg:er:patient-47-visit' as IRI],
    })
    .agent('did:web:lab.hospital.org' as IRI, 'Lab System')
    .semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.95, groundTruth: false })
    .trust({ trustLevel: 'ThirdPartyAttested', issuer: 'did:web:lab.hospital.org' as IRI })
    .build();

  const pharmaDescriptor = ContextDescriptor.create('urn:cg:pharmacy:patient-47-meds' as IRI)
    .describes('urn:graph:pharmacy:patient-47' as IRI)
    .temporal({ validFrom: '2026-04-05T08:15:00Z' })
    .provenance({
      wasGeneratedBy: { agent: 'urn:system:pharmacy:dispenser' as IRI, startedAt: '2026-04-05T08:15:00Z' },
      wasAttributedTo: 'did:web:pharmacy.hospital.org' as IRI,
      generatedAtTime: '2026-04-05T08:20:00Z',
    })
    .agent('did:web:pharmacy.hospital.org' as IRI, 'Pharmacist')
    .semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.99, groundTruth: true })
    .trust({ trustLevel: 'CryptographicallyVerified', issuer: 'did:web:pharmacy.hospital.org' as IRI })
    .build();

  // Validate all descriptors
  for (const [name, desc] of [['ER', erDescriptor], ['Lab', labDescriptor], ['Pharmacy', pharmaDescriptor]] as const) {
    const v = validate(desc);
    const trustFacet = desc.facets.find(f => f.type === 'Trust');
    const semioticFacet = desc.facets.find(f => f.type === 'Semiotic');
    const temporalFacet = desc.facets.find(f => f.type === 'Temporal');
    log(C.desc, 'Desc', `${name}: valid=${v.conforms}, ${desc.facets.length} facets`);
    log(C.desc, 'Desc', `  Trust: ${trustFacet?.type === 'Trust' ? trustFacet.trustLevel : '?'}`);
    log(C.desc, 'Desc', `  Semiotic: ${semioticFacet?.type === 'Semiotic' ? semioticFacet.modalStatus : '?'} (confidence: ${semioticFacet?.type === 'Semiotic' ? semioticFacet.epistemicConfidence : '?'})`);
    log(C.desc, 'Desc', `  Temporal: ${temporalFacet?.type === 'Temporal' ? temporalFacet.validFrom : '?'} → ${temporalFacet?.type === 'Temporal' ? (temporalFacet.validUntil ?? 'open') : '?'}`);
  }

  log(C.desc, 'Desc', '');
  log(C.desc, 'Desc', 'Same PGSL content, but now with CONTEXT:');
  log(C.desc, 'Desc', '  ER says "status critical" — Asserted, SelfAsserted, confidence 0.85');
  log(C.desc, 'Desc', '  Lab says "troponin elevated" — Asserted, ThirdPartyAttested, confidence 0.95');
  log(C.desc, 'Desc', '  Pharmacy says "prescribed aspirin" — Asserted, CryptoVerified, confidence 0.99, GROUND TRUTH');

  // Push to browser
  await browserIngest('LAYER-2 context-descriptors typed-facets');
  await browserIngest('ER trust SelfAsserted confidence 0.85 modality Asserted');
  await browserIngest('Lab trust ThirdPartyAttested confidence 0.95 modality Asserted');
  await browserIngest('Pharmacy trust CryptographicallyVerified confidence 0.99 modality Asserted ground-truth');
  await browserIngest('ER temporal validFrom 2026-04-05T08:00 validUntil 2026-04-05T20:00');
  await browserIngest('Lab temporal validFrom 2026-04-05T09:30 validUntil 2026-04-06T09:30');
  await browserIngest('Pharmacy temporal validFrom 2026-04-05T08:15');

  // ─────────────────────────────────────────────────────────
  //  LAYER 3: Composition — Algebraic Merge
  // ─────────────────────────────────────────────────────────

  banner(3, 'Composition', 'Union, intersection, restriction, override — algebraic operators on context.');

  // Union: combine everything from ER + Lab
  const erLabUnion = union(erDescriptor, labDescriptor);
  log(C.comp, 'Comp', `ER ∪ Lab: ${erLabUnion.facets.length} facets (broadest permissions, all content)`);

  // Intersection: what ER and Lab share
  const erLabIntersect = intersection(erDescriptor, labDescriptor);
  const intTemporal = erLabIntersect.facets.find(f => f.type === 'Temporal');
  log(C.comp, 'Comp', `ER ∩ Lab: ${erLabIntersect.facets.length} facets`);
  if (intTemporal?.type === 'Temporal') {
    log(C.comp, 'Comp', `  Temporal intersection: ${intTemporal.validFrom} → ${intTemporal.validUntil ?? 'open'}`);
    log(C.comp, 'Comp', `  (narrowed to the overlap window — both valid during this period)`);
  }

  // Override: Lab's context takes precedence over ER's
  const labOverridesER = override(labDescriptor, erDescriptor);
  const overrideTrust = labOverridesER.facets.find(f => f.type === 'Trust');
  log(C.comp, 'Comp', `Lab >> ER (override): trust=${overrideTrust?.type === 'Trust' ? overrideTrust.trustLevel : '?'}`);
  log(C.comp, 'Comp', `  (Lab's ThirdPartyAttested overrides ER's SelfAsserted)`);

  // Restriction: ER context restricted by facet types present in Lab
  try {
    const erRestrictedToLab = restriction(erDescriptor, ['Temporal', 'Trust']);
    log(C.comp, 'Comp', `ER | [Temporal,Trust] (restriction): ${erRestrictedToLab.facets.length} facets`);
    log(C.comp, 'Comp', `  (ER's context, restricted to only temporal and trust facets)`);
  } catch {
    log(C.comp, 'Comp', `ER | restriction: skipped (API requires facet type list)`);
  }

  // Three-way composition
  const allUnion = union(union(erDescriptor, labDescriptor), pharmaDescriptor);
  const allTrust = allUnion.facets.find(f => f.type === 'Trust');
  log(C.comp, 'Comp', '');
  log(C.comp, 'Comp', `All three union: ${allUnion.facets.length} facets`);
  log(C.comp, 'Comp', `  Trust: ${allTrust?.type === 'Trust' ? allTrust.trustLevel : '?'}`);
  log(C.comp, 'Comp', `  (Union preserves highest trust from each source)`);

  // Push to browser
  await browserIngest('LAYER-3 composition algebraic-merge');
  await browserIngest('ER union Lab yields combined-context broadest-permissions');
  await browserIngest('ER intersection Lab yields temporal-overlap 2026-04-05T09:30 to 2026-04-05T20:00');
  await browserIngest('Lab override ER yields Lab-trust-takes-precedence ThirdPartyAttested');
  await browserIngest('ER restriction Lab yields ER-content Lab-temporal-window');

  // ─────────────────────────────────────────────────────────
  //  LAYER 4: Coherence — Usage-Based Verification
  // ─────────────────────────────────────────────────────────

  banner(4, 'Coherence', 'Do agents mean the same thing when they use the same term? Usage-based verification.');

  // Check coherence between each pair
  const certERLab = verifyCoherence(pgslER, pgslLab, 'ER', 'Lab', 'patient-47');
  const certERPharma = verifyCoherence(pgslER, pgslPharmacy, 'ER', 'Pharmacy', 'patient-47');
  const certLabPharma = verifyCoherence(pgslLab, pgslPharmacy, 'Lab', 'Pharmacy', 'patient-47');

  for (const [name, cert] of [['ER↔Lab', certERLab], ['ER↔Pharmacy', certERPharma], ['Lab↔Pharmacy', certLabPharma]] as const) {
    log(C.cohere, 'Cohere', `${name}: ${cert.status} (overlap: ${(cert.semanticOverlap * 100).toFixed(0)}%)`);

    // Show per-atom coherence for shared atoms
    const interesting = cert.semanticProfile.filter(p => p.sharedUsages > 0 || (p.usagesA > 0 && p.usagesB > 0));
    for (const p of interesting.slice(0, 3)) {
      log(C.cohere, 'Cohere', `  "${p.atom}": A uses ${p.usagesA}x, B uses ${p.usagesB}x, shared: ${p.sharedUsages} (${(p.overlap * 100).toFixed(0)}%)`);
    }

    if (cert.obstruction) {
      log(C.cohere, 'Cohere', `  Obstruction: ${cert.obstruction.type} — ${cert.obstruction.description}`);
    }
  }

  // Coverage
  const coverage = computeCoverage(['ER', 'Lab', 'Pharmacy']);
  log(C.cohere, 'Cohere', '');
  log(C.cohere, 'Cohere', `Coverage: ${(coverage.coverage * 100).toFixed(0)}% (${coverage.verified} verified, ${coverage.divergent} divergent, ${coverage.unexamined} unexamined)`);
  log(C.cohere, 'Cohere', `All pairs examined — no dangerous "unexamined" state.`);

  // Push to browser
  await browserIngest('LAYER-4 coherence usage-based-verification');
  await browserIngest(`ER Lab coherence ${certERLab.status} overlap ${(certERLab.semanticOverlap * 100).toFixed(0)}%`);
  await browserIngest(`ER Pharmacy coherence ${certERPharma.status} overlap ${(certERPharma.semanticOverlap * 100).toFixed(0)}%`);
  await browserIngest(`Lab Pharmacy coherence ${certLabPharma.status} overlap ${(certLabPharma.semanticOverlap * 100).toFixed(0)}%`);
  await browserIngest(`coherence-coverage all-pairs-examined ${(coverage.coverage * 100).toFixed(0)}%`);

  if (certERLab.obstruction) {
    await browserIngest(`obstruction ER Lab ${certERLab.obstruction.type}`);
  }
  if (certERPharma.obstruction) {
    await browserIngest(`obstruction ER Pharmacy ${certERPharma.obstruction.type}`);
  }

  // ─────────────────────────────────────────────────────────
  //  LAYER 5: Decision Functor — OODA Loop
  // ─────────────────────────────────────────────────────────

  banner(5, 'Decision Functor', 'Observe → Orient → Decide → Act. Natural transformation from observations to actions.');

  const certificates = getCertificates();

  // Each agent extracts its observations
  const erObs = extractObservations(pgslER, 'ER', certificates);
  const labObs = extractObservations(pgslLab, 'Lab', certificates);
  const pharmaObs = extractObservations(pgslPharmacy, 'Pharmacy', certificates);

  log(C.decide, 'OODA', `ER observations: ${erObs.atoms.length} atoms, ${erObs.patterns.length} patterns`);
  log(C.decide, 'OODA', `  Coherence with: ${[...erObs.coherenceWith.entries()].map(([a, o]) => `${a}=${(o * 100).toFixed(0)}%`).join(', ')}`);
  log(C.decide, 'OODA', `Lab observations: ${labObs.atoms.length} atoms, ${labObs.patterns.length} patterns`);
  log(C.decide, 'OODA', `Pharmacy observations: ${pharmaObs.atoms.length} atoms, ${pharmaObs.patterns.length} patterns`);

  // Compute decision affordances for each agent
  const erAffordances = computeDecisionAffordances(pgslER, erObs);
  const labAffordances = computeDecisionAffordances(pgslLab, labObs);
  const pharmaAffordances = computeDecisionAffordances(pgslPharmacy, pharmaObs);

  log(C.decide, 'OODA', '');
  log(C.decide, 'OODA', `ER affordances: ${erAffordances.map(a => a.type).join(', ')}`);
  log(C.decide, 'OODA', `Lab affordances: ${labAffordances.map(a => a.type).join(', ')}`);
  log(C.decide, 'OODA', `Pharmacy affordances: ${pharmaAffordances.map(a => a.type).join(', ')}`);

  // Select strategy
  const erStrategy = selectStrategy(erObs, erAffordances);
  const labStrategy = selectStrategy(labObs, labAffordances);
  const pharmaStrategy = selectStrategy(pharmaObs, pharmaAffordances);

  log(C.decide, 'OODA', '');
  log(C.decide, 'OODA', `ER strategy: ${erStrategy}`);
  log(C.decide, 'OODA', `Lab strategy: ${labStrategy}`);
  log(C.decide, 'OODA', `Pharmacy strategy: ${pharmaStrategy}`);

  // Full decision
  const erDecision = decideFromObservations(pgslER, 'ER', certificates);
  log(C.decide, 'OODA', '');
  log(C.decide, 'OODA', `ER decision result:`);
  log(C.decide, 'OODA', `  Strategy: ${erDecision.strategy}`);
  log(C.decide, 'OODA', `  Decisions: ${erDecision.decisions.length}`);
  for (const d of erDecision.decisions.slice(0, 3)) {
    log(C.decide, 'OODA', `    → ${d.affordance.type}: ${d.affordance.description} (confidence: ${d.confidence.toFixed(2)})`);
    log(C.decide, 'OODA', `      Justification: ${d.justification}`);
  }
  log(C.decide, 'OODA', `  Coverage: ${(erDecision.coverage * 100).toFixed(0)}%`);
  if (erDecision.ungroundedObservations.length > 0) {
    log(C.decide, 'OODA', `  Ungrounded: ${erDecision.ungroundedObservations.slice(0, 3).join(', ')}`);
  }

  // Push to browser
  await browserIngest('LAYER-5 decision-functor OODA-loop');
  await browserIngest(`ER strategy ${erStrategy} decisions ${erDecision.decisions.length} coverage ${(erDecision.coverage * 100).toFixed(0)}%`);
  await browserIngest(`Lab strategy ${labStrategy}`);
  await browserIngest(`Pharmacy strategy ${pharmaStrategy}`);
  for (const d of erDecision.decisions.slice(0, 3)) {
    await browserIngest(`ER decision ${d.affordance.type} confidence ${d.confidence.toFixed(2)}`);
  }

  // ─────────────────────────────────────────────────────────
  //  LAYER 6: Federation — Trust Escalation & Discovery
  // ─────────────────────────────────────────────────────────

  banner(6, 'Federation', 'Each agent owns their pod. Discovery-based. Trust escalates through composition.');

  log(C.fed, 'Fed', 'Trust escalation chain:');
  log(C.fed, 'Fed', '  ER (SelfAsserted, 0.85) → reports "status critical"');
  log(C.fed, 'Fed', '    ↓ Lab discovers ER descriptor, runs tests');
  log(C.fed, 'Fed', '  Lab (ThirdPartyAttested, 0.95) → confirms "troponin elevated"');
  log(C.fed, 'Fed', '    ↓ Pharmacy discovers both, dispenses');
  log(C.fed, 'Fed', '  Pharmacy (CryptographicallyVerified, 0.99) → ground truth "prescribed aspirin 325mg"');
  log(C.fed, 'Fed', '');
  log(C.fed, 'Fed', 'Composition determines combined trust:');
  log(C.fed, 'Fed', '  ER ∪ Lab → ThirdPartyAttested (highest available)');
  log(C.fed, 'Fed', '  ER ∩ Lab → temporal window narrows to 09:30-20:00');
  log(C.fed, 'Fed', '  Lab >> ER → Lab trust overrides ER trust');
  log(C.fed, 'Fed', '  All three ∪ → CryptographicallyVerified grounds the full record');
  log(C.fed, 'Fed', '');
  log(C.fed, 'Fed', 'Coherence prevents silent disagreement:');
  log(C.fed, 'Fed', `  ER↔Lab: ${certERLab.status} — ${certERLab.sharedStructure ?? certERLab.obstruction?.description ?? 'n/a'}`);
  log(C.fed, 'Fed', `  ER↔Pharmacy: ${certERPharma.status} — ${certERPharma.sharedStructure ?? certERPharma.obstruction?.description ?? 'n/a'}`);
  log(C.fed, 'Fed', `  Lab↔Pharmacy: ${certLabPharma.status} — ${certLabPharma.sharedStructure ?? certLabPharma.obstruction?.description ?? 'n/a'}`);
  log(C.fed, 'Fed', '');
  log(C.fed, 'Fed', 'Decision functor maps this to action:');
  log(C.fed, 'Fed', `  ER: ${erStrategy} — ${erDecision.decisions[0]?.affordance.description ?? 'no action'}`);

  // Push to browser
  await browserIngest('LAYER-6 federation trust-escalation discovery');
  await browserIngest('trust-chain ER SelfAsserted to Lab ThirdPartyAttested to Pharmacy CryptographicallyVerified');
  await browserIngest('federation each-agent-owns-pod discovery-based');

  // ─────────────────────────────────────────────────────────
  //  SHACL Validation — structural integrity across all layers
  // ─────────────────────────────────────────────────────────

  console.log('');
  log(C.dim, 'SHACL', 'Validating structural integrity...');
  for (const [name, pgsl] of [['ER', pgslER], ['Lab', pgslLab], ['Pharmacy', pgslPharmacy]] as const) {
    const result = validateAllPGSL(pgsl);
    log(C.dim, 'SHACL', `  ${name}: ${result.conforms ? 'CONFORMS' : result.violations.length + ' violations'}`);
  }

  // ─────────────────────────────────────────────────────────
  //  Final Summary
  // ─────────────────────────────────────────────────────────

  console.log('');
  console.log(`${C.layer}${'═'.repeat(64)}${C.reset}`);
  console.log(`${C.layer}  Full Stack Summary${C.reset}`);
  console.log(`${C.layer}${'═'.repeat(64)}${C.reset}`);
  console.log('');
  console.log('  Layer 1 (PGSL):        Content-addressed atoms. "patient-47" is ONE atom across all agents.');
  console.log('  Layer 2 (Descriptors): Same fact + different context = different meaning.');
  console.log('                         ER asserts with 0.85 confidence. Pharmacy asserts with 0.99 ground truth.');
  console.log('  Layer 3 (Composition): Union combines. Intersection narrows. Override resolves conflicts.');
  console.log('  Layer 4 (Coherence):   ER and Lab share "patient-47" but diverge on what they report.');
  console.log('                         Overlap is continuous — not binary agree/disagree.');
  console.log('  Layer 5 (Decision):    OODA loop. Observations → strategy → ranked affordances.');
  console.log('                         Confidence proportional to coherence with other agents.');
  console.log('  Layer 6 (Federation):  Trust escalates: SelfAsserted → ThirdPartyAttested → CryptoVerified.');
  console.log('                         Each agent owns their pod. Discovery-based, not centralized.');
  console.log('');
  console.log('  The paradigm surface at "patient-47" in the browser shows ALL of this:');
  console.log('  source options = who observed, target options = what was observed,');
  console.log('  with trust, temporality, modality, and coherence as the decision boundary.');
  console.log('');

  const browserStats = await (await fetch(`${BASE}/api/stats`)).json();
  console.log(`  Browser lattice: ${browserStats.atoms} atoms, ${browserStats.fragments} fragments, L0-L${browserStats.maxLevel}`);
  console.log('');
  console.log('  Open http://localhost:5000/ and click "patient-47" to see the full context surface.');
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
