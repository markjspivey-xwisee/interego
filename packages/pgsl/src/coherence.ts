/**
 * @module pgsl/coherence
 * @description Coherence verification between agents/systems.
 *
 * When two agents share context across a federation, their
 * interpretations may or may not align. Coherence is the property
 * that two agents' presheaf sections agree on their overlaps —
 * i.e., the sheaf condition holds for the pair.
 *
 * Three states:
 *   - Verified: coherence was checked and confirmed (sections glue)
 *   - Divergent: coherence was checked and failed (obstruction found)
 *   - Unexamined: coherence has never been checked (null state —
 *     observationally identical to verified from inside either system)
 *
 * The dangerous state is unexamined — both agents proceed as if
 * they agree, but neither has verified this. Coherence coverage
 * tracks which agent pairs have been examined.
 *
 * Coherence certificates are signed proof of verification,
 * stored as context descriptors with full provenance.
 */

import type { PGSLInstance } from './types.js';
import { resolve } from './lattice.js';
import { createHash } from 'node:crypto';

// ── Types ──────────────────────────────────────────────────

export type CoherenceStatus = 'verified' | 'divergent' | 'unexamined';

export interface CoherenceCertificate {
  /** Unique ID for this certificate */
  readonly id: string;
  /** Agent A identifier */
  readonly agentA: string;
  /** Agent B identifier */
  readonly agentB: string;
  /** What was checked — the shared topic/object */
  readonly topic: string;
  /** Result */
  readonly status: CoherenceStatus;
  /** If verified: the shared structure (lattice meet content) */
  readonly sharedStructure?: string;
  /** If divergent: what specifically diverges */
  readonly obstruction?: CoherenceObstruction;
  /** When the check was performed */
  readonly verifiedAt: string;
  /** Signature of the verifying agent (if signed) */
  readonly signature?: string;
  /** Hash of the verification computation (replayable) */
  readonly computationHash: string;
  /** Semantic overlap: 0-1 continuous measure of shared usage */
  readonly semanticOverlap: number;
  /** Shared syntagmatic patterns (structural agreement) */
  readonly sharedPatterns: readonly string[];
  /** Emergent semantic profile: per-atom usage overlap */
  readonly semanticProfile: readonly AtomCoherence[];
}

export interface AtomCoherence {
  /** The shared atom value */
  readonly atom: string;
  /** How many usage contexts agent A has for this atom */
  readonly usagesA: number;
  /** How many usage contexts agent B has */
  readonly usagesB: number;
  /** How many usage contexts are shared */
  readonly sharedUsages: number;
  /** Overlap ratio: shared / max(A, B) */
  readonly overlap: number;
  /** Shared syntagmatic patterns for this atom */
  readonly sharedContexts: readonly string[];
  /** Usage contexts unique to A */
  readonly uniqueToA: readonly string[];
  /** Usage contexts unique to B */
  readonly uniqueToB: readonly string[];
}

export interface CoherenceObstruction {
  /** What kind of divergence */
  readonly type: 'term-mismatch' | 'structure-mismatch' | 'frame-incompatible';
  /** Human-readable description */
  readonly description: string;
  /** The specific items that diverge */
  readonly divergentItems: string[];
}

export interface CoherenceCoverage {
  /** Total number of agent pairs */
  readonly totalPairs: number;
  /** Number of verified pairs */
  readonly verified: number;
  /** Number of divergent pairs */
  readonly divergent: number;
  /** Number of unexamined pairs */
  readonly unexamined: number;
  /** Coverage ratio: (verified + divergent) / total — how much has been examined */
  readonly coverage: number;
  /** The unexamined pairs (the dangerous ones) */
  readonly unexaminedPairs: ReadonlyArray<{ agentA: string; agentB: string }>;
}

// ── Certificate Registry ───────────────────────────────────

const certificates = new Map<string, CoherenceCertificate>();

/**
 * Verify coherence between two agents' PGSL lattices.
 *
 * Checks whether two agents' ingested content shares structural
 * overlap (lattice meet exists) and whether the shared content
 * resolves to the same values.
 *
 * @param pgslA - Agent A's lattice
 * @param pgslB - Agent B's lattice
 * @param agentA - Agent A identifier
 * @param agentB - Agent B identifier
 * @param topic - What's being checked (e.g., "patient-status")
 */
export function verifyCoherence(
  pgslA: PGSLInstance,
  pgslB: PGSLInstance,
  agentA: string,
  agentB: string,
  topic: string,
): CoherenceCertificate {
  // ── Usage-based coherence: meaning is usage, not existence ──
  // Two agents share a sign if they both have the atom.
  // They share MEANING if they USE the sign in the same syntagmatic contexts.
  // Same atom in different positions/chains = different meaning.

  // Step 1: Find shared atoms (shared signs)
  const sharedAtoms: string[] = [];
  for (const [valueA] of pgslA.atoms) {
    if (pgslB.atoms.has(valueA)) {
      sharedAtoms.push(valueA);
    }
  }

  // Step 2: For each shared atom, compare USAGE — what syntagmatic
  // contexts does it appear in? Build a "usage signature" for each atom:
  // the set of (position, co-occurring atoms) tuples.
  interface UsageContext { position: number; coItems: string[] }

  function getUsageContexts(pgsl: PGSLInstance, atomValue: string): UsageContext[] {
    const atomUri = pgsl.atoms.get(atomValue);
    if (!atomUri) return [];
    const contexts: UsageContext[] = [];

    for (const [, node] of pgsl.nodes) {
      if (node.kind !== 'Fragment') continue;
      const pos = node.items.indexOf(atomUri);
      if (pos < 0) continue;

      // Co-occurring items in this syntagm
      const coItems: string[] = [];
      for (let i = 0; i < node.items.length; i++) {
        if (i === pos) continue;
        const itemNode = pgsl.nodes.get(node.items[i]!);
        if (itemNode?.kind === 'Atom') coItems.push(String((itemNode as any).value));
        else coItems.push(resolve(pgsl, node.items[i]!));
      }
      contexts.push({ position: pos, coItems: coItems.sort() });
    }
    return contexts;
  }

  // Step 3: Build semantic profile — per-atom usage comparison
  // This captures emergent semantics: meaning = totality of usage contexts
  const semanticProfile: AtomCoherence[] = [];
  const sharedPatterns: string[] = [];
  let totalOverlap = 0;
  let atomsCompared = 0;

  for (const atomValue of sharedAtoms) {
    const usageA = getUsageContexts(pgslA, atomValue);
    const usageB = getUsageContexts(pgslB, atomValue);

    if (usageA.length === 0 && usageB.length === 0) continue;

    // Convert to comparable strings (usage signatures)
    const sigA = new Set(usageA.map(u => `pos${u.position}:[${u.coItems.join(',')}]`));
    const sigB = new Set(usageB.map(u => `pos${u.position}:[${u.coItems.join(',')}]`));

    // Compute overlap
    const shared: string[] = [];
    for (const s of sigA) if (sigB.has(s)) shared.push(s);
    const uniqueA = [...sigA].filter(s => !sigB.has(s));
    const uniqueB = [...sigB].filter(s => !sigA.has(s));

    const maxUsages = Math.max(sigA.size, sigB.size);
    const overlap = maxUsages > 0 ? shared.length / maxUsages : 0;

    semanticProfile.push({
      atom: atomValue,
      usagesA: sigA.size,
      usagesB: sigB.size,
      sharedUsages: shared.length,
      overlap,
      sharedContexts: shared,
      uniqueToA: uniqueA,
      uniqueToB: uniqueB,
    });

    if (shared.length > 0) {
      sharedPatterns.push(`${atomValue}: ${shared.join(', ')}`);
    }

    totalOverlap += overlap;
    atomsCompared++;
  }

  // Step 4: Shared syntagmatic structures (exact fragment matches)
  // These represent complete shared usage patterns — strongest form of coherence
  for (const [keyA, uriA] of pgslA.fragments) {
    if (pgslB.fragments.has(keyA)) {
      sharedPatterns.push(`syntagm: ${resolve(pgslA, uriA)}`);
    }
  }

  // Step 5: Compute overall semantic overlap (continuous 0-1)
  const semanticOverlap = atomsCompared > 0 ? totalOverlap / atomsCompared : 0;

  const now = new Date().toISOString();
  const computationData = `${agentA}|${agentB}|${topic}|overlap:${semanticOverlap.toFixed(4)}|patterns:${sharedPatterns.length}|${now}`;
  const computationHash = createHash('sha256').update(computationData).digest('hex').slice(0, 40);

  // Step 6: Determine status from semantic overlap
  // Not binary — uses overlap threshold
  // >0.7 = verified (strong shared semantics)
  // >0.3 = divergent with partial overlap (emerging alignment)
  // >0 = divergent (minimal shared usage)
  // 0 = frame incompatible or unexamined
  let status: CoherenceStatus;
  let obstruction: CoherenceObstruction | undefined;
  let sharedStructure: string | undefined;

  if (sharedAtoms.length === 0) {
    status = 'unexamined';
  } else if (semanticOverlap >= 0.7) {
    status = 'verified';
    sharedStructure = `${semanticOverlap.toFixed(0)}% semantic overlap across ${atomsCompared} shared signs`;
  } else if (semanticOverlap > 0) {
    // Partial overlap — signs are shared but used differently in some contexts
    // This is the interesting emergent state: meaning is partially shared
    const divergentAtoms = semanticProfile
      .filter(p => p.overlap < 0.5 && p.uniqueToA.length > 0 && p.uniqueToB.length > 0)
      .map(p => `"${p.atom}": A=${p.uniqueToA[0]}, B=${p.uniqueToB[0]}`);

    status = 'divergent';
    obstruction = {
      type: divergentAtoms.length > 0 ? 'term-mismatch' : 'structure-mismatch',
      description: `${(semanticOverlap * 100).toFixed(0)}% semantic overlap — partial alignment, ${divergentAtoms.length} term(s) used differently`,
      divergentItems: divergentAtoms,
    };
    sharedStructure = `${sharedPatterns.length} shared patterns emerging`;
  } else {
    // Zero overlap in usage even though atoms are shared
    const examples = semanticProfile.slice(0, 3).map(p =>
      `"${p.atom}": A=${p.uniqueToA[0] ?? 'unused'}, B=${p.uniqueToB[0] ?? 'unused'}`
    );
    status = 'divergent';
    obstruction = {
      type: 'frame-incompatible',
      description: `Shared signs but zero usage overlap — incompatible frames`,
      divergentItems: examples,
    };
  }

  const cert: CoherenceCertificate = {
    id: `cert:${computationHash.slice(0, 16)}`,
    agentA,
    agentB,
    topic,
    status,
    sharedStructure,
    obstruction,
    verifiedAt: now,
    computationHash,
    semanticOverlap,
    sharedPatterns,
    semanticProfile,
  };

  // Store the certificate
  const pairKey = [agentA, agentB].sort().join('|');
  certificates.set(`${pairKey}:${topic}`, cert);

  return cert;
}

/**
 * Compute coherence coverage across a set of agents.
 *
 * Returns the ratio of examined-to-total agent pairs,
 * and identifies which pairs are unexamined (the dangerous state).
 */
export function computeCoverage(agents: string[]): CoherenceCoverage {
  const pairs: Array<{ agentA: string; agentB: string }> = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      pairs.push({ agentA: agents[i]!, agentB: agents[j]! });
    }
  }

  let verified = 0;
  let divergent = 0;
  const unexaminedPairs: Array<{ agentA: string; agentB: string }> = [];

  for (const pair of pairs) {
    const pairKey = [pair.agentA, pair.agentB].sort().join('|');
    // Check if any certificate exists for this pair
    let hasExamined = false;
    for (const [key] of certificates) {
      if (key.startsWith(pairKey + ':')) {
        const cert = certificates.get(key)!;
        if (cert.status === 'verified') verified++;
        else if (cert.status === 'divergent') divergent++;
        hasExamined = true;
        break;
      }
    }
    if (!hasExamined) {
      unexaminedPairs.push(pair);
    }
  }

  const totalPairs = pairs.length;
  const coverage = totalPairs > 0 ? (verified + divergent) / totalPairs : 1;

  return {
    totalPairs,
    verified,
    divergent,
    unexamined: unexaminedPairs.length,
    coverage,
    unexaminedPairs,
  };
}

/**
 * Get all coherence certificates.
 */
export function getCertificates(): CoherenceCertificate[] {
  return [...certificates.values()];
}

/**
 * Get the coherence status between two specific agents.
 */
export function getCoherenceStatus(agentA: string, agentB: string): CoherenceStatus {
  const pairKey = [agentA, agentB].sort().join('|');
  for (const [key, cert] of certificates) {
    if (key.startsWith(pairKey + ':')) {
      return cert.status;
    }
  }
  return 'unexamined';
}
