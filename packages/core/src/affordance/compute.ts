/**
 * @module affordance/compute
 * @description Affordance computation engine.
 *
 * Computes effective affordances as the intersection of:
 *   - Environment capabilities (what the resource provides)
 *   - Agent effectivities (what the agent can do)
 *   - Context constraints (what the facets permit)
 *   - Trust evaluation (what the trust chain warrants)
 *
 * Each affordance is a relational property (Gibson) expressed
 * as an interventional query P(Y|do(X)) (Pearl rung 2).
 */

import type { ContextDescriptorData, ContextFacetData } from '../model/types.js';
import { classifyQuestion, type QuestionType } from '../pgsl/question-router.js';
import { extractEntities, type EntityExtractionResult } from '../pgsl/entity-extraction.js';
import { shouldAbstain } from '../pgsl/computation.js';
import type {
  AffordanceAction,
  AffordanceReason,
  Affordance,
  AntiAffordance,
  AffordanceSet,
  Signifier,
  AgentProfile,
  TrustPolicy,
  SituationalAwarenessLevel,
} from './types.js';

// ── All possible actions ─────────────────────────────────────

const ALL_ACTIONS: readonly AffordanceAction[] = [
  'read', 'apply', 'compose', 'cite', 'forward',
  'challenge', 'retract', 'annotate', 'ingest',
  'derive', 'intervene', 'project', 'subscribe', 'ignore',
] as const;

// ── Scope → permitted actions mapping ────────────────────────

const SCOPE_PERMISSIONS: Record<string, readonly AffordanceAction[]> = {
  ReadWrite: ['read', 'apply', 'compose', 'cite', 'forward', 'challenge', 'retract', 'annotate', 'ingest', 'derive', 'intervene', 'project', 'subscribe', 'ignore'],
  ReadOnly: ['read', 'cite', 'ingest', 'subscribe', 'ignore'],
  PublishOnly: ['read', 'apply', 'compose', 'derive', 'ingest', 'ignore'],
  DiscoverOnly: ['read', 'cite', 'subscribe', 'ignore'],
};

// ── Capability → required actions mapping ────────────────────

const CAPABILITY_REQUIREMENTS: Partial<Record<AffordanceAction, string[]>> = {
  compose: ['compose'],
  intervene: ['causal'],
  ingest: ['pgsl'],
  project: ['project'],
  subscribe: ['subscribe'],
  challenge: ['challenge', 'publish'],
  retract: ['retract'],
  // verify is an internal operation, not in AffordanceAction
};

// ── Main computation ─────────────────────────────────────────

/**
 * Compute the full affordance set for an agent-descriptor pair.
 * This is the core Gibson relation: Affordance(agent, environment).
 */
export function computeAffordances(
  agent: AgentProfile,
  descriptor: ContextDescriptorData,
): AffordanceSet {
  const affordances: Affordance[] = [];
  const antiAffordances: AntiAffordance[] = [];
  const signifiers: Signifier[] = [];

  // Extract facet data for evaluation
  const facetMap = buildFacetMap(descriptor);

  // Build signifiers from facets (Norman)
  for (const facet of descriptor.facets) {
    signifiers.push(...extractSignifiers(facet));
  }

  // Evaluate each action
  for (const action of ALL_ACTIONS) {
    const reasons: AffordanceReason[] = [];
    let blocked = false;
    let blockReason = '';
    let blockSource = '';
    let overridable = false;

    // 1. Delegation scope check
    const permitted = SCOPE_PERMISSIONS[agent.delegationScope] ?? [];
    if (!permitted.includes(action)) {
      blocked = true;
      blockReason = `Action '${action}' not permitted for scope '${agent.delegationScope}'`;
      blockSource = 'delegation';
      reasons.push({
        facet: 'delegation',
        constraint: `scope includes '${action}'`,
        satisfied: false,
        detail: blockReason,
      });
    } else {
      reasons.push({
        facet: 'delegation',
        constraint: `scope includes '${action}'`,
        satisfied: true,
      });
    }

    // 2. Capability check
    const required = CAPABILITY_REQUIREMENTS[action];
    if (required && !blocked) {
      const hasAll = required.every(c => agent.capabilities.includes(c as any));
      if (!hasAll) {
        blocked = true;
        blockReason = `Agent lacks capability: ${required.filter(c => !agent.capabilities.includes(c as any)).join(', ')}`;
        blockSource = 'capability';
        overridable = true; // capabilities could be acquired
      }
      reasons.push({
        facet: 'capability',
        constraint: `agent has ${required.join(', ')}`,
        satisfied: hasAll,
        detail: hasAll ? undefined : blockReason,
      });
    }

    // 3. Trust policy check
    if (!blocked) {
      const trustResult = evaluateTrustPolicy(agent.trustPolicies, action, facetMap);
      if (!trustResult.satisfied) {
        blocked = true;
        blockReason = trustResult.reason;
        blockSource = 'trust';
        overridable = true;
      }
      reasons.push({
        facet: 'trust',
        constraint: trustResult.constraint,
        satisfied: trustResult.satisfied,
        detail: trustResult.reason,
      });
    }

    // 4. Semiotic check (modal status constraints)
    if (!blocked) {
      const semioticResult = evaluateSemioticConstraint(action, facetMap);
      if (!semioticResult.satisfied) {
        blocked = true;
        blockReason = semioticResult.reason;
        blockSource = 'semiotic';
        overridable = true;
      }
      reasons.push({
        facet: 'semiotic',
        constraint: semioticResult.constraint,
        satisfied: semioticResult.satisfied,
        detail: semioticResult.reason,
      });
    }

    // 5. Vocabulary check (for 'apply' and 'compose')
    if (!blocked && (action === 'apply' || action === 'compose' || action === 'project')) {
      const vocabResult = evaluateVocabularyAccess(agent, facetMap);
      reasons.push({
        facet: 'vocabulary',
        constraint: 'agent understands descriptor vocabulary',
        satisfied: vocabResult.accessible,
        detail: vocabResult.detail,
      });
      if (!vocabResult.accessible && action !== 'project') {
        blocked = true;
        blockReason = vocabResult.detail;
        blockSource = 'vocabulary';
        overridable = true; // could add projection capability
      }
    }

    // Compute confidence
    const confidence = blocked ? 0 : computeActionConfidence(action, facetMap, reasons);

    if (blocked) {
      antiAffordances.push({
        action,
        blockedBy: blockSource,
        reason: blockReason,
        overridable,
      });
    }

    affordances.push({
      action,
      available: !blocked,
      confidence,
      reasons,
    });
  }

  // Build SA level
  const saLevel = buildSALevel(descriptor, affordances, facetMap);

  return {
    agent: agent.agentId,
    descriptor: descriptor.id,
    timestamp: new Date().toISOString(),
    affordances,
    antiAffordances,
    signifiers,
    saLevel,
  };
}

// ── Facet extraction ─────────────────────────────────────────

interface FacetMap {
  temporal?: ContextFacetData & { type: 'Temporal' };
  provenance?: ContextFacetData & { type: 'Provenance' };
  agent?: ContextFacetData & { type: 'Agent' };
  semiotic?: ContextFacetData & { type: 'Semiotic' };
  trust?: ContextFacetData & { type: 'Trust' };
  federation?: ContextFacetData & { type: 'Federation' };
  causal?: ContextFacetData & { type: 'Causal' };
  projection?: ContextFacetData & { type: 'Projection' };
  accessControl?: ContextFacetData & { type: 'AccessControl' };
}

function buildFacetMap(descriptor: ContextDescriptorData): FacetMap {
  const map: FacetMap = {};
  for (const facet of descriptor.facets) {
    const key = facet.type.charAt(0).toLowerCase() + facet.type.slice(1);
    (map as any)[key] = facet;
  }
  return map;
}

// ── Trust policy evaluation ──────────────────────────────────

function evaluateTrustPolicy(
  policies: readonly TrustPolicy[],
  action: AffordanceAction,
  facets: FacetMap,
): { satisfied: boolean; constraint: string; reason: string } {
  const trustFacet = facets.trust as any;
  const semioticFacet = facets.semiotic as any;

  for (const policy of policies) {
    if (!policy.requiredForAction.includes(action)) continue;

    // Check trust level
    const trustLevels = ['SelfAsserted', 'DelegatedTrust', 'CryptographicallyVerified'];
    const actualLevel = trustFacet?.trustLevel ?? 'SelfAsserted';
    const actualIdx = trustLevels.indexOf(actualLevel);
    const requiredIdx = trustLevels.indexOf(policy.minTrustLevel);

    if (actualIdx < requiredIdx) {
      return {
        satisfied: false,
        constraint: `trust >= ${policy.minTrustLevel} for '${action}'`,
        reason: `Trust level '${actualLevel}' below required '${policy.minTrustLevel}'`,
      };
    }

    // Check confidence
    const confidence = semioticFacet?.epistemicConfidence ?? 0.5;
    if (confidence < policy.minConfidence) {
      return {
        satisfied: false,
        constraint: `confidence >= ${policy.minConfidence} for '${action}'`,
        reason: `Confidence ${confidence} below required ${policy.minConfidence}`,
      };
    }
  }

  return {
    satisfied: true,
    constraint: 'trust policy met',
    reason: '',
  };
}

// ── Semiotic constraint evaluation ───────────────────────────

function evaluateSemioticConstraint(
  action: AffordanceAction,
  facets: FacetMap,
): { satisfied: boolean; constraint: string; reason: string } {
  const semiotic = facets.semiotic as any;
  if (!semiotic) {
    return { satisfied: true, constraint: 'no semiotic facet', reason: '' };
  }

  const modalStatus = semiotic.modalStatus ?? 'Asserted';

  // Retracted descriptors anti-afford everything except 'read' and 'ignore'
  if (modalStatus === 'Retracted' && !['read', 'ignore', 'cite'].includes(action)) {
    return {
      satisfied: false,
      constraint: `modal status permits '${action}'`,
      reason: `Descriptor is Retracted — cannot ${action}`,
    };
  }

  // Hypothetical descriptors require caution for 'apply' and 'forward'
  if (modalStatus === 'Hypothetical' && (action === 'apply' || action === 'forward')) {
    const confidence = semiotic.epistemicConfidence ?? 0.5;
    if (confidence < 0.8) {
      return {
        satisfied: false,
        constraint: `Hypothetical with confidence >= 0.8 for '${action}'`,
        reason: `Hypothetical descriptor at ${confidence} confidence — too uncertain to ${action}`,
      };
    }
  }

  // Counterfactual descriptors anti-afford 'apply' (they describe what didn't happen)
  if (modalStatus === 'Counterfactual' && action === 'apply') {
    return {
      satisfied: false,
      constraint: `Counterfactual cannot be applied directly`,
      reason: `Counterfactual descriptors describe unrealized states — use 'compose' or 'cite' instead`,
    };
  }

  return { satisfied: true, constraint: `modal status '${modalStatus}' permits '${action}'`, reason: '' };
}

// ── Vocabulary access evaluation ─────────────────────────────

function evaluateVocabularyAccess(
  agent: AgentProfile,
  facets: FacetMap,
): { accessible: boolean; detail: string } {
  const projection = facets.projection as any;

  // If there's a projection facet with vocabulary mappings, check if agent knows the target
  if (projection?.vocabularyMappings) {
    return { accessible: true, detail: 'Projection facet provides vocabulary mapping' };
  }

  // If agent has 'project' capability, it can attempt translation
  if (agent.capabilities.includes('project')) {
    return { accessible: true, detail: 'Agent has projection capability' };
  }

  // Default: assume accessible (vocabulary mismatch is detected at runtime)
  return { accessible: true, detail: 'Vocabulary compatibility assumed' };
}

// ── Confidence computation ───────────────────────────────────

function computeActionConfidence(
  action: AffordanceAction,
  facets: FacetMap,
  reasons: readonly AffordanceReason[],
): number {
  let confidence = 1.0;

  // Factor in epistemic confidence
  const semiotic = facets.semiotic as any;
  if (semiotic?.epistemicConfidence !== undefined) {
    confidence *= semiotic.epistemicConfidence;
  }

  // Factor in trust level
  const trust = facets.trust as any;
  if (trust?.trustLevel) {
    const trustMultipliers: Record<string, number> = {
      CryptographicallyVerified: 1.0,
      DelegatedTrust: 0.85,
      SelfAsserted: 0.7,
    };
    confidence *= trustMultipliers[trust.trustLevel] ?? 0.5;
  }

  // Actions that modify state have lower base confidence
  const modifyActions: AffordanceAction[] = ['apply', 'compose', 'forward', 'derive', 'intervene'];
  if (modifyActions.includes(action)) {
    confidence *= 0.95; // slight penalty for consequential actions
  }

  // Factor in reason satisfaction rate
  const satisfiedRatio = reasons.filter(r => r.satisfied).length / Math.max(reasons.length, 1);
  confidence *= satisfiedRatio;

  return Math.round(confidence * 1000) / 1000;
}

// ── Signifier extraction (Norman) ────────────────────────────

function extractSignifiers(facet: ContextFacetData): Signifier[] {
  const signifiers: Signifier[] = [];

  switch (facet.type) {
    case 'Semiotic': {
      const f = facet as any;
      const modal = f.modalStatus ?? 'Asserted';
      const conf = f.epistemicConfidence ?? 0.5;
      signifiers.push({
        facetType: 'Semiotic',
        indicates: modal === 'Asserted' ? ['apply', 'compose', 'forward'] :
                   modal === 'Hypothetical' ? ['compose', 'cite', 'challenge'] :
                   modal === 'Counterfactual' ? ['cite', 'compose'] :
                   ['read', 'ignore'],
        strength: conf > 0.8 ? 'strong' : conf > 0.5 ? 'weak' : 'ambiguous',
        detail: `${modal} at ${conf} confidence`,
      });
      break;
    }
    case 'Trust': {
      const f = facet as any;
      signifiers.push({
        facetType: 'Trust',
        indicates: f.trustLevel === 'CryptographicallyVerified'
          ? ['apply', 'forward', 'compose']
          : f.trustLevel === 'DelegatedTrust'
          ? ['apply', 'compose', 'cite']
          : ['read', 'cite', 'ingest'],
        strength: f.trustLevel === 'CryptographicallyVerified' ? 'strong' :
                  f.trustLevel === 'DelegatedTrust' ? 'weak' : 'ambiguous',
        detail: `Trust: ${f.trustLevel}`,
      });
      break;
    }
    case 'Causal': {
      signifiers.push({
        facetType: 'Causal',
        indicates: ['intervene', 'compose', 'derive'],
        strength: 'strong',
        detail: 'Causal model available — interventional reasoning afforded',
      });
      break;
    }
    case 'Federation': {
      signifiers.push({
        facetType: 'Federation',
        indicates: ['subscribe', 'forward'],
        strength: 'strong',
        detail: 'Federation metadata — subscription and forwarding afforded',
      });
      break;
    }
    case 'Projection': {
      signifiers.push({
        facetType: 'Projection',
        indicates: ['project', 'compose', 'apply'],
        strength: 'strong',
        detail: 'Vocabulary projection available',
      });
      break;
    }
  }

  return signifiers;
}

// ── Situational Awareness level (Endsley) ────────────────────

function buildSALevel(
  descriptor: ContextDescriptorData,
  affordances: readonly Affordance[],
  facets: FacetMap,
): SituationalAwarenessLevel {
  const available = affordances.filter(a => a.available);

  return {
    level1_perception: {
      descriptorsDiscovered: 1,
      podsScanned: facets.federation ? 1 : 0,
      facetTypesObserved: descriptor.facets.map(f => f.type),
      coverageGaps: descriptor.facets.length < 3
        ? ['Limited facet coverage — may be missing context']
        : [],
    },
    level2_comprehension: {
      trustEvaluated: facets.trust ? 1 : 0,
      vocabularyMapped: facets.projection ? 1 : 0,
      causalModelsResolved: facets.causal ? 1 : 0,
      conflictsDetected: 0,
      coherenceScore: available.length / Math.max(affordances.length, 1),
    },
    level3_projection: {
      anticipatedChanges: [],
      projectedAffordances: available,
      timeHorizon: facets.temporal && (facets.temporal as any).validUntil
        ? (facets.temporal as any).validUntil
        : 'indefinite',
      projectionConfidence: available.reduce((sum, a) => sum + a.confidence, 0) / Math.max(available.length, 1),
    },
  };
}

// ═════════════════════════════════════════════════════════════
//  Query Comprehension Strategy (bridges question → affordance)
// ═════════════════════════════════════════════════════════════

/**
 * A cognitive strategy for answering a question.
 * Selected by the affordance engine based on question analysis.
 */
export interface CognitiveStrategy {
  readonly questionType: QuestionType;
  readonly strategy: 'direct' | 'temporal-twopass' | 'multi-session-aggregate' | 'knowledge-update-latest' | 'preference-meta' | 'abstain';
  readonly requiresComputation: boolean;
  readonly computationType?: 'date-arithmetic' | 'counting' | 'aggregation' | 'comparison' | 'ordering';
  readonly entities: EntityExtractionResult;
  readonly shouldAbstain: boolean;
  readonly confidence: number;
}

/**
 * Analyze a question and determine the optimal cognitive strategy.
 * This is the affordance computation for comprehension —
 * it determines WHAT OPERATIONS the system should perform.
 *
 * Maps our primitives to benchmark insights:
 *   - classifyQuestion → affordance routing
 *   - extractEntities → PGSL entity atoms
 *   - shouldAbstain → affordance engine's anti-affordance
 *   - date/count detection → structural computation routing
 */
export function computeCognitiveStrategy(
  question: string,
  sessionEntities?: Set<string>,
): CognitiveStrategy {
  const questionType = classifyQuestion(question);
  const entities = extractEntities(question);
  const qLower = question.toLowerCase();

  // Check if we should abstain (question entities don't appear in sessions)
  const abstainResult = sessionEntities
    ? shouldAbstain([...entities.contentWords], sessionEntities)
    : { abstain: false, matchRatio: 1, matchedEntities: [] as string[], missingEntities: [] as string[] };

  // Detect computation type needed.
  // Order matters: temporal indicators override counting because
  // "how many days ago" is temporal, not counting.
  //
  // Temporal signals: time units (days/weeks/months/years) + temporal
  // prepositions (ago/between/before/after/since/until/when/first/last)
  const temporalUnits = /days?|weeks?|months?|years?|hours?|minutes?/i;
  const temporalPrepositions = /\b(ago|between|before|after|since|until|passed|took|spend|spent|long|old|recently|first|last|earlier|later|order)\b/i;
  const hasTemporalUnit = temporalUnits.test(qLower);
  const hasTemporalPreposition = temporalPrepositions.test(qLower);

  // Date arithmetic: question involves time units WITH temporal prepositions
  // e.g. "how many days ago", "how long did", "which came first", "how old was I"
  const needsDateArithmetic = (hasTemporalUnit && hasTemporalPreposition)
    || /when did|which.*first|order.*earliest|how old|how long/i.test(qLower);

  // Counting: "how many X" where X is NOT a time unit
  // e.g. "how many books" YES, "how many days ago" NO
  const howManyMatch = qLower.match(/how many (\w+)/i);
  const howManyNonTemporal = howManyMatch
    ? !temporalUnits.test(howManyMatch[1]!)
    : false;
  const needsCounting = howManyNonTemporal
    || /total number|count\b|how much.*total/i.test(qLower);

  // Aggregation: explicit sum/total/average language
  const needsAggregation = /\btotal\b|combined|altogether|\bsum\b|average|gpa/i.test(qLower);

  // Comparison: relative judgments
  const needsComparison = /more than|less than|higher|lower|same as|prefer/i.test(qLower);
  const needsOrdering = /order|sequence|first.*last|earliest.*latest|chronological/i.test(qLower);

  const requiresComputation = needsDateArithmetic || needsCounting || needsAggregation || needsComparison || needsOrdering;
  const computationType = needsDateArithmetic ? 'date-arithmetic' as const
    : needsCounting ? 'counting' as const
    : needsAggregation ? 'aggregation' as const
    : needsComparison ? 'comparison' as const
    : needsOrdering ? 'ordering' as const
    : undefined;

  // Select strategy based on question type
  let strategy: CognitiveStrategy['strategy'];
  if (abstainResult.abstain) {
    strategy = 'abstain';
  } else if (questionType === 'temporal') {
    strategy = 'temporal-twopass';
  } else if (questionType === 'multi-hop' || needsCounting) {
    strategy = 'multi-session-aggregate';
  } else if (questionType === 'preference') {
    strategy = 'preference-meta';
  } else {
    strategy = 'direct';
  }

  return {
    questionType,
    strategy,
    requiresComputation,
    computationType,
    entities,
    shouldAbstain: abstainResult.abstain,
    confidence: abstainResult.matchRatio,
  };
}
