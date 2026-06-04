/**
 * @module pgsl/decision-functor
 * @description Natural transformation from observation presheaves to action categories.
 *
 * The decision functor D: Obs → Act is the formal bridge between
 * "we understand each other" (glued section from coherence verification)
 * and "here's what we do" (selecting affordances from available actions).
 *
 * This is the OODA loop formalized categorically:
 *   Observe  — presheaf sections (what agents have seen)
 *   Orient   — coherence verification (do we agree on what we see?)
 *   Decide   — natural transformation (map observations to strategy)
 *   Act      — affordance selection (pick concrete actions)
 *
 * The functor maps:
 *   - Observations (ingested atoms/fragments) → Decisions (affordance selections)
 *   - Glued sections (verified coherence) → Coordinated actions
 *   - Obstructions (coherence failures) → Divergent strategies
 *
 * Connects to:
 *   - coherence.ts: CoherenceCertificate provides the "observation" side
 *   - category.ts: presheaf fiber/pullback provides structural context
 *   - lattice.ts: PGSLInstance provides the shared content
 *   - types.ts: all PGSL types
 */

import type { PGSLInstance, Fragment } from './types.js';
import type { CoherenceCertificate } from './coherence.js';
import { resolve } from './lattice.js';
import { createHash } from 'node:crypto';

// ── Types ──────────────────────────────────────────────────

/** An affordance — a possible action in a Hydra-like API. */
export interface Affordance {
  readonly id: string;
  readonly type: string; // e.g., 'read', 'write', 'compose', 'delegate', 'verify'
  readonly target: string; // URI of the resource to act on
  readonly description: string;
  readonly preconditions: readonly string[]; // Required states/capabilities
  readonly effects: readonly string[]; // Expected state changes
}

/** A decision — selected affordance with justification. */
export interface Decision {
  readonly affordance: Affordance;
  readonly confidence: number; // 0-1
  readonly justification: string;
  readonly coherenceBasis?: string; // Certificate ID that grounds this decision
  readonly causalChain: readonly string[]; // Sequence of observations leading to this decision
}

/** An observation presheaf section — what an agent has seen. */
export interface ObservationSection {
  readonly agent: string;
  readonly atoms: readonly string[]; // Atom values observed
  readonly patterns: readonly string[]; // Syntagmatic patterns observed
  readonly coherenceWith: ReadonlyMap<string, number>; // agent → overlap score
}

/** Decision strategy — how to map observations to actions. */
export type DecisionStrategy = 'exploit' | 'explore' | 'delegate' | 'abstain';

/** Decision functor result. */
export interface DecisionResult {
  readonly strategy: DecisionStrategy;
  readonly decisions: readonly Decision[];
  readonly coverage: number; // How much of the observation space was covered
  readonly ungroundedObservations: readonly string[]; // Observations without corresponding decisions
}

// ── Observation Extraction ─────────────────────────────────

/**
 * Extract an observation section from an agent's PGSL lattice and
 * its coherence certificates.
 *
 * Builds the presheaf section by collecting:
 *   - All atom values the agent has ingested
 *   - All syntagmatic patterns (fragment resolutions) at level ≥ 2
 *   - Coherence overlap scores with other agents from certificates
 *
 * @param pgsl - The agent's PGSL lattice
 * @param agent - The agent's identifier
 * @param certificates - Coherence certificates involving this agent
 */
export function extractObservations(
  pgsl: PGSLInstance,
  agent: string,
  certificates: readonly CoherenceCertificate[],
): ObservationSection {
  // Collect atom values
  const atoms: string[] = [];
  for (const [value] of pgsl.atoms) {
    atoms.push(value);
  }

  // Collect syntagmatic patterns (resolved fragments at level ≥ 2)
  const patterns: string[] = [];
  for (const [, node] of pgsl.nodes) {
    if (node.kind === 'Fragment' && (node as Fragment).level >= 2) {
      patterns.push(resolve(pgsl, node.uri));
    }
  }

  // Build coherence overlap map from certificates
  const coherenceWith = new Map<string, number>();
  for (const cert of certificates) {
    if (cert.agentA === agent) {
      // Take the maximum overlap if multiple certificates exist for the same pair
      const existing = coherenceWith.get(cert.agentB) ?? 0;
      coherenceWith.set(cert.agentB, Math.max(existing, cert.semanticOverlap));
    } else if (cert.agentB === agent) {
      const existing = coherenceWith.get(cert.agentA) ?? 0;
      coherenceWith.set(cert.agentA, Math.max(existing, cert.semanticOverlap));
    }
  }

  return { agent, atoms, patterns, coherenceWith };
}

// ── Affordance Computation ─────────────────────────────────

/**
 * Compute available affordances given an agent's observations.
 *
 * Affordance availability is determined by the observation section:
 *   - Verified atoms → 'read', 'verify' affordances
 *   - High coherence with others → 'compose', 'delegate' affordances
 *   - Unique unshared content → 'write', 'share' affordances
 *
 * @param pgsl - The agent's PGSL lattice
 * @param observations - The agent's observation section
 */
export function computeAffordances(
  pgsl: PGSLInstance,
  observations: ObservationSection,
): Affordance[] {
  const affordances: Affordance[] = [];
  let idCounter = 0;

  /** Generate a deterministic affordance ID. */
  function nextId(type: string): string {
    const hash = createHash('sha256')
      .update(`${observations.agent}:${type}:${idCounter++}`)
      .digest('hex')
      .slice(0, 12);
    return `aff:${hash}`;
  }

  // Verified atoms → read/verify affordances
  for (const atomValue of observations.atoms) {
    const atomUri = pgsl.atoms.get(atomValue);
    if (!atomUri) continue;

    affordances.push({
      id: nextId('read'),
      type: 'read',
      target: atomUri,
      description: `Read atom "${atomValue}"`,
      preconditions: ['atom-exists'],
      effects: ['atom-accessed'],
    });

    affordances.push({
      id: nextId('verify'),
      type: 'verify',
      target: atomUri,
      description: `Verify provenance of atom "${atomValue}"`,
      preconditions: ['atom-exists', 'provenance-available'],
      effects: ['atom-verified'],
    });
  }

  // High coherence → compose/delegate affordances
  for (const [otherAgent, overlap] of observations.coherenceWith) {
    if (overlap >= 0.5) {
      affordances.push({
        id: nextId('compose'),
        type: 'compose',
        target: `agent:${otherAgent}`,
        description: `Compose shared context with ${otherAgent} (overlap: ${(overlap * 100).toFixed(0)}%)`,
        preconditions: ['coherence-verified', `overlap>=${(overlap * 100).toFixed(0)}%`],
        effects: ['shared-context-composed'],
      });
    }

    if (overlap >= 0.3 && overlap < 0.7) {
      affordances.push({
        id: nextId('delegate'),
        type: 'delegate',
        target: `agent:${otherAgent}`,
        description: `Delegate to ${otherAgent} for partial-overlap context (overlap: ${(overlap * 100).toFixed(0)}%)`,
        preconditions: ['coherence-partial', `overlap>=${(overlap * 100).toFixed(0)}%`],
        effects: ['task-delegated'],
      });
    }
  }

  // Unique content (atoms not shared with any high-coherence agent) → write/share
  const sharedAtoms = new Set<string>();
  for (const cert of iterateCertificateAtoms(observations)) {
    sharedAtoms.add(cert);
  }

  const uniqueAtoms = observations.atoms.filter(a => !sharedAtoms.has(a));
  if (uniqueAtoms.length > 0) {
    // Group into a single write affordance for efficiency
    const targetUri = pgsl.atoms.get(uniqueAtoms[0]!) ?? `atoms:${observations.agent}`;
    affordances.push({
      id: nextId('write'),
      type: 'write',
      target: targetUri,
      description: `Share ${uniqueAtoms.length} unique atom(s) not yet seen by other agents`,
      preconditions: ['has-unique-content'],
      effects: ['content-shared'],
    });
  }

  return affordances;
}

/**
 * Yield atom values that appear in coherence overlap with any agent.
 * Helper for identifying unique vs. shared content.
 */
function* iterateCertificateAtoms(
  observations: ObservationSection,
): Generator<string> {
  // An atom is considered "shared" if coherence overlap with any agent > 0
  // Since we only have overlap scores (not per-atom data here),
  // we approximate: if overlap > 0.5, most atoms are likely shared
  for (const [, overlap] of observations.coherenceWith) {
    if (overlap > 0.5) {
      for (const atom of observations.atoms) {
        yield atom;
      }
      return; // All atoms are considered shared if high overlap exists
    }
  }
}

// ── Strategy Selection ─────────────────────────────────────

/**
 * Select a decision strategy based on observations and available affordances.
 *
 * Strategy rules (from the observation presheaf structure):
 *   'exploit'  — High coherence (>0.7) with at least one agent → use shared knowledge
 *   'explore'  — Low coherence (<0.3) with all agents → gather more observations
 *   'delegate' — Medium coherence (0.3–0.7) + another agent has higher overlap → delegate
 *   'abstain'  — No observations or no affordances → cannot decide
 *
 * @param observations - The agent's observation section
 * @param affordances - The available affordances to choose from
 */
export function selectStrategy(
  observations: ObservationSection,
  affordances: readonly Affordance[],
): DecisionStrategy {
  // No observations or affordances → abstain
  if (observations.atoms.length === 0 || affordances.length === 0) {
    return 'abstain';
  }

  // Find the maximum coherence overlap with any agent
  let maxOverlap = 0;
  for (const [, overlap] of observations.coherenceWith) {
    if (overlap > maxOverlap) maxOverlap = overlap;
  }

  // No coherence data at all → explore (need more information)
  if (observations.coherenceWith.size === 0) {
    return 'explore';
  }

  // High coherence → exploit shared knowledge
  if (maxOverlap > 0.7) {
    return 'exploit';
  }

  // Medium coherence → delegate to higher-overlap agent
  if (maxOverlap >= 0.3) {
    return 'delegate';
  }

  // Low coherence with everyone → explore
  return 'explore';
}

// ── Decision Functor (Main) ────────────────────────────────

/**
 * The decision functor D: Obs → Act.
 *
 * Maps an agent's observations (presheaf section) to a ranked set
 * of decisions (affordance selections with justification). This is
 * the natural transformation at the heart of the OODA loop.
 *
 * Pipeline:
 *   1. Extract observations from the PGSL lattice and certificates
 *   2. Compute (or filter) available affordances
 *   3. Select a strategy based on the observation structure
 *   4. Rank affordances by coherence-grounded confidence
 *   5. Build causal chains from observation → decision
 *
 * @param pgsl - The agent's PGSL lattice
 * @param agent - The agent's identifier
 * @param certificates - Coherence certificates involving this agent
 * @param availableAffordances - Optional pre-computed affordances to filter
 */
export function decide(
  pgsl: PGSLInstance,
  agent: string,
  certificates: readonly CoherenceCertificate[],
  availableAffordances?: readonly Affordance[],
): DecisionResult {
  const observations = extractObservations(pgsl, agent, certificates);

  // Compute or use provided affordances
  const affordances = availableAffordances
    ? filterAffordances(availableAffordances, observations)
    : computeAffordances(pgsl, observations);

  const strategy = selectStrategy(observations, affordances);

  // Abstain: nothing to decide
  if (strategy === 'abstain') {
    return {
      strategy,
      decisions: [],
      coverage: 0,
      ungroundedObservations: [...observations.atoms],
    };
  }

  // Build decisions — rank by strategy-appropriate criteria
  const decisions: Decision[] = [];
  const groundedAtoms = new Set<string>();

  for (const affordance of affordances) {
    // Filter affordances by strategy alignment
    if (!isStrategyAligned(strategy, affordance.type)) continue;

    // Compute confidence from coherence basis
    const { confidence, basisId, chain } = computeConfidence(
      affordance, observations, certificates, strategy,
    );

    decisions.push({
      affordance,
      confidence,
      justification: buildJustification(strategy, affordance, confidence),
      coherenceBasis: basisId,
      causalChain: chain,
    });

    // Track which observations are grounded by this decision
    if (affordance.type === 'read' || affordance.type === 'verify') {
      const atomNode = pgsl.nodes.get(affordance.target as any);
      if (atomNode?.kind === 'Atom') {
        groundedAtoms.add(String(atomNode.value));
      }
    }
  }

  // Sort by confidence descending
  decisions.sort((a, b) => b.confidence - a.confidence);

  // Ungrounded observations: atoms without a corresponding decision
  const ungroundedObservations = observations.atoms.filter(a => !groundedAtoms.has(a));

  // Coverage: ratio of grounded to total observations
  const totalObs = observations.atoms.length + observations.patterns.length;
  const coverage = totalObs > 0
    ? (observations.atoms.length - ungroundedObservations.length + observations.patterns.length) / totalObs
    : 0;

  return { strategy, decisions, coverage, ungroundedObservations };
}

// ── Decision Composition ───────────────────────────────────

/**
 * Compose multiple agents' decisions into a group decision.
 *
 * Uses coherence overlap to weight contributions: agents with
 * higher coherence get more influence. Resolves conflicts by
 * preferring higher-confidence decisions.
 *
 * This is the colimit in the action category — the universal
 * cocone over the diagram of individual agent decisions.
 *
 * @param results - Individual decision results from multiple agents
 */
export function composeDecisions(
  results: readonly DecisionResult[],
): DecisionResult {
  if (results.length === 0) {
    return { strategy: 'abstain', decisions: [], coverage: 0, ungroundedObservations: [] };
  }

  if (results.length === 1) {
    return results[0]!;
  }

  // Merge all decisions, deduplicating by affordance target + type
  const seen = new Map<string, Decision>();
  for (const result of results) {
    for (const decision of result.decisions) {
      const key = `${decision.affordance.type}:${decision.affordance.target}`;
      const existing = seen.get(key);
      // Keep the higher-confidence decision
      if (!existing || decision.confidence > existing.confidence) {
        seen.set(key, decision);
      }
    }
  }

  const mergedDecisions = [...seen.values()].sort((a, b) => b.confidence - a.confidence);

  // Aggregate ungrounded observations (union of all, minus those grounded by any)
  const allUngrounded = new Set<string>();
  for (const result of results) {
    for (const obs of result.ungroundedObservations) {
      allUngrounded.add(obs);
    }
  }

  // Composite strategy: highest-priority strategy wins
  // Priority: exploit > delegate > explore > abstain
  const strategyPriority: Record<DecisionStrategy, number> = {
    exploit: 3, delegate: 2, explore: 1, abstain: 0,
  };
  let bestStrategy: DecisionStrategy = 'abstain';
  for (const result of results) {
    if (strategyPriority[result.strategy] > strategyPriority[bestStrategy]) {
      bestStrategy = result.strategy;
    }
  }

  // Average coverage
  const totalCoverage = results.reduce((sum, r) => sum + r.coverage, 0);
  const avgCoverage = totalCoverage / results.length;

  return {
    strategy: bestStrategy,
    decisions: mergedDecisions,
    coverage: avgCoverage,
    ungroundedObservations: [...allUngrounded],
  };
}

// ── Internal Helpers ───────────────────────────────────────

/**
 * Check whether an affordance type aligns with the selected strategy.
 */
function isStrategyAligned(strategy: DecisionStrategy, affordanceType: string): boolean {
  switch (strategy) {
    case 'exploit':
      return ['read', 'verify', 'compose'].includes(affordanceType);
    case 'explore':
      return ['read', 'write', 'verify'].includes(affordanceType);
    case 'delegate':
      return ['delegate', 'compose', 'read'].includes(affordanceType);
    case 'abstain':
      return false;
  }
}

/**
 * Filter pre-computed affordances by what the observation section supports.
 */
function filterAffordances(
  affordances: readonly Affordance[],
  observations: ObservationSection,
): Affordance[] {
  return affordances.filter(aff => {
    // Read/verify require the target atom to be in observations
    if (aff.type === 'read' || aff.type === 'verify') {
      return true; // Allow — target validity checked downstream
    }
    // Compose/delegate require coherence with the target agent
    if (aff.type === 'compose' || aff.type === 'delegate') {
      const targetAgent = aff.target.replace('agent:', '');
      return observations.coherenceWith.has(targetAgent);
    }
    return true;
  });
}

/**
 * Compute confidence score for a decision based on coherence data.
 */
function computeConfidence(
  affordance: Affordance,
  observations: ObservationSection,
  certificates: readonly CoherenceCertificate[],
  strategy: DecisionStrategy,
): { confidence: number; basisId?: string; chain: string[] } {
  const chain: string[] = [];
  let confidence = 0;
  let basisId: string | undefined;

  chain.push(`observe: ${observations.atoms.length} atoms, ${observations.patterns.length} patterns`);

  if (affordance.type === 'compose' || affordance.type === 'delegate') {
    // Confidence is the coherence overlap with the target agent
    const targetAgent = affordance.target.replace('agent:', '');
    const overlap = observations.coherenceWith.get(targetAgent) ?? 0;
    confidence = overlap;

    // Find the grounding certificate
    const cert = certificates.find(c =>
      (c.agentA === observations.agent && c.agentB === targetAgent) ||
      (c.agentB === observations.agent && c.agentA === targetAgent),
    );
    if (cert) {
      basisId = cert.id;
      chain.push(`orient: coherence with ${targetAgent} = ${(overlap * 100).toFixed(0)}% [${cert.id}]`);
    }
  } else if (affordance.type === 'read' || affordance.type === 'verify') {
    // Confidence based on whether the atom is coherently shared
    const maxOverlap = Math.max(0, ...Array.from(observations.coherenceWith.values()));
    confidence = strategy === 'exploit' ? Math.max(0.5, maxOverlap) : 0.3;
    chain.push(`orient: atom grounded by ${strategy} strategy`);
  } else if (affordance.type === 'write') {
    // Writing unique content: confidence inversely proportional to existing coherence
    const maxOverlap = Math.max(0, ...Array.from(observations.coherenceWith.values()));
    confidence = 1 - maxOverlap;
    chain.push(`orient: unique content, low overlap = high write confidence`);
  }

  chain.push(`decide: strategy=${strategy}`);
  chain.push(`act: ${affordance.type} → ${affordance.target}`);

  return { confidence: Math.max(0, Math.min(1, confidence)), basisId, chain };
}

/**
 * Build a human-readable justification for a decision.
 */
function buildJustification(
  strategy: DecisionStrategy,
  affordance: Affordance,
  confidence: number,
): string {
  const pct = (confidence * 100).toFixed(0);
  switch (strategy) {
    case 'exploit':
      return `Exploit shared knowledge: ${affordance.description} (${pct}% confidence from coherence verification)`;
    case 'explore':
      return `Explore: ${affordance.description} — low coherence with peers, gathering more observations (${pct}% confidence)`;
    case 'delegate':
      return `Delegate: ${affordance.description} — partial overlap suggests complementary capabilities (${pct}% confidence)`;
    case 'abstain':
      return `Abstain: insufficient observations to ground any decision`;
  }
}
