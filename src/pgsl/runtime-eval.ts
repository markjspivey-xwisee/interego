/**
 * @module pgsl/runtime-eval
 * @description Runtime evaluation and confidence scoring for answers.
 *
 * At design time, evals validate changes don't regress.
 * At runtime, evals measure confidence and drive retry/escalation decisions.
 *
 * The OODA verification loop applied to answers:
 *   1. Produce answer (Act)
 *   2. Self-evaluate confidence (Observe)
 *   3. Check against structural signals (Orient)
 *   4. Decide: accept, retry with different strategy, or escalate (Decide)
 *
 * Confidence signals:
 *   - Retrieval quality: how many sessions matched, how strong the overlap
 *   - Answer structure: does the answer format match the question type
 *   - Coherence: does this answer contradict stored knowledge
 *   - Strategy match: was the right strategy used for this question type
 *   - Extraction completeness: for counting, how many sessions were covered
 *
 * Integration points:
 *   - Decorator: RuntimeEvalDecorator adds confidence to HATEOAS responses
 *   - PROV: confidence score logged in trace records
 *   - Persistence: high-confidence → promote to higher tier
 *   - Decision functor: confidence feeds into strategy selection
 */

// PGSLInstance used indirectly via latticeStats
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { latticeStats } from './lattice.js';

// ── Types ──────────────────────────────────────────────────

/** Confidence level for an answer */
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'uncertain';

/** Structural signals used to compute confidence */
export interface StructuralSignals {
  /** How many sessions were found relevant (0 = no match) */
  readonly sessionsMatched: number;
  /** Total sessions available */
  readonly sessionsTotal: number;
  /** Top retrieval score from PGSL index */
  readonly topRetrievalScore: number;
  /** Number of shared atoms between question and sessions */
  readonly sharedAtoms: number;
  /** Question type detected */
  readonly questionType: string;
  /** Strategy used to answer */
  readonly strategyUsed: string;
  /** Whether the answer is an abstention */
  readonly isAbstention: boolean;
  /** For counting: how many items were extracted */
  readonly extractedItemCount?: number;
  /** For temporal: were dates explicitly found or inferred */
  readonly datesExplicit?: boolean;
}

/** Runtime evaluation result */
export interface RuntimeEval {
  /** Overall confidence score (0-1) */
  readonly confidence: number;
  /** Confidence level (derived from score) */
  readonly level: ConfidenceLevel;
  /** Structural signals that informed the score */
  readonly signals: StructuralSignals;
  /** Recommended action based on confidence */
  readonly action: 'accept' | 'retry' | 'escalate' | 'abstain';
  /** If retry: suggested alternative strategy */
  readonly retryStrategy?: string;
  /** Human-readable explanation of the confidence assessment */
  readonly explanation: string;
}

/** Eval history entry for learning which strategies work */
export interface EvalHistoryEntry {
  readonly questionType: string;
  readonly strategy: string;
  readonly confidence: number;
  readonly wasCorrect?: boolean; // set later if ground truth available
  readonly timestamp: string;
}

/** Runtime eval configuration */
export interface RuntimeEvalConfig {
  /** Confidence threshold for automatic acceptance (default 0.8) */
  readonly acceptThreshold: number;
  /** Confidence threshold below which to escalate (default 0.3) */
  readonly escalateThreshold: number;
  /** Maximum retries before escalating (default 2) */
  readonly maxRetries: number;
  /** Whether to log eval history (default true) */
  readonly logHistory: boolean;
}

// ── Default Config ─────────────────────────────────────────

export const DEFAULT_EVAL_CONFIG: RuntimeEvalConfig = {
  acceptThreshold: 0.8,
  escalateThreshold: 0.3,
  maxRetries: 2,
  logHistory: true,
};

// ── Eval History ───────────────────────────────────────────

const evalHistory: EvalHistoryEntry[] = [];

export function getEvalHistory(): readonly EvalHistoryEntry[] {
  return evalHistory;
}

export function recordEvalOutcome(entry: EvalHistoryEntry): void {
  evalHistory.push(entry);
}

/**
 * Get historical accuracy for a strategy + question type combination.
 * Returns the fraction of correct answers (if ground truth was recorded).
 */
export function historicalAccuracy(questionType: string, strategy: string): number | null {
  const matching = evalHistory.filter(
    e => e.questionType === questionType && e.strategy === strategy && e.wasCorrect !== undefined
  );
  if (matching.length < 3) return null; // not enough data
  return matching.filter(e => e.wasCorrect).length / matching.length;
}

// ── Confidence Scoring ─────────────────────────────────────

/**
 * Compute confidence score from structural signals.
 *
 * This is the core runtime eval function. It takes the structural
 * signals from the answer pipeline and produces a confidence score.
 *
 * The score is NOT based on whether the answer is "correct" —
 * we don't know that at runtime. It's based on whether the
 * structural signals suggest the answer is RELIABLE.
 */
export function computeConfidence(signals: StructuralSignals): number {
  let score = 0.5; // baseline

  // Signal 1: Retrieval quality
  // High retrieval score = question entities found in sessions
  if (signals.topRetrievalScore > 10) score += 0.15;
  else if (signals.topRetrievalScore > 5) score += 0.10;
  else if (signals.topRetrievalScore > 2) score += 0.05;
  else if (signals.topRetrievalScore < 1) score -= 0.15;

  // Signal 2: Session coverage
  // More sessions matched = more evidence
  const coverageRatio = signals.sessionsTotal > 0
    ? signals.sessionsMatched / signals.sessionsTotal
    : 0;
  if (coverageRatio > 0.5) score += 0.10;
  else if (coverageRatio > 0.2) score += 0.05;
  else if (coverageRatio === 0) score -= 0.20;

  // Signal 3: Shared atoms
  if (signals.sharedAtoms > 10) score += 0.10;
  else if (signals.sharedAtoms > 5) score += 0.05;
  else if (signals.sharedAtoms < 2) score -= 0.10;

  // Signal 4: Strategy-type match
  // Some strategies are more reliable for certain question types
  const goodMatches: Record<string, string[]> = {
    'temporal': ['pgsl-temporal-first', 'pgsl-duration-computed', 'pgsl-read'],
    'counting': ['pgsl-count-cot', 'pgsl-count-verified'],
    'preference': ['pgsl-preference'],
    'factual': ['pgsl-read'],
    'knowledge-update': ['pgsl-read', 'pgsl-count-reconciled'],
  };
  const expectedStrategies = goodMatches[signals.questionType] ?? ['pgsl-read'];
  if (expectedStrategies.some(s => signals.strategyUsed.includes(s))) {
    score += 0.05;
  }

  // Signal 5: Abstention quality
  if (signals.isAbstention) {
    // Abstention is confident if retrieval score is low
    if (signals.topRetrievalScore < 1) score += 0.15; // legitimate abstention
    else score -= 0.10; // suspicious abstention — something matched but we abstained
  }

  // Signal 6: Counting-specific signals
  if (signals.extractedItemCount !== undefined) {
    if (signals.extractedItemCount === 0 && !signals.isAbstention) {
      score -= 0.15; // found nothing but didn't abstain
    }
  }

  // Signal 7: Historical accuracy for this strategy+type
  const historical = historicalAccuracy(signals.questionType, signals.strategyUsed);
  if (historical !== null) {
    // Adjust toward historical accuracy
    score = score * 0.7 + historical * 0.3;
  }

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score));
}

/**
 * Convert confidence score to level.
 */
export function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  if (score >= 0.3) return 'low';
  return 'uncertain';
}

// ── Runtime Eval ───────────────────────────────────────────

/**
 * Evaluate an answer at runtime.
 *
 * Takes the structural signals from the answer pipeline and produces
 * a confidence assessment with recommended action.
 */
export function evaluate(
  signals: StructuralSignals,
  config: RuntimeEvalConfig = DEFAULT_EVAL_CONFIG,
): RuntimeEval {
  const confidence = computeConfidence(signals);
  const level = confidenceLevel(confidence);

  let action: RuntimeEval['action'];
  let retryStrategy: string | undefined;
  let explanation: string;

  if (signals.isAbstention && confidence >= 0.6) {
    action = 'abstain';
    explanation = 'Low retrieval match supports abstention';
  } else if (confidence >= config.acceptThreshold) {
    action = 'accept';
    explanation = `High confidence (${(confidence * 100).toFixed(0)}%) — ${signals.sessionsMatched}/${signals.sessionsTotal} sessions matched, ${signals.sharedAtoms} shared atoms`;
  } else if (confidence <= config.escalateThreshold) {
    action = 'escalate';
    explanation = `Very low confidence (${(confidence * 100).toFixed(0)}%) — consider human review or alternative approach`;
  } else {
    action = 'retry';
    // Suggest alternative strategy
    if (signals.strategyUsed.includes('count') && !signals.strategyUsed.includes('cot')) {
      retryStrategy = 'pgsl-count-cot';
      explanation = 'Counting strategy may benefit from chain-of-thought approach';
    } else if (signals.strategyUsed.includes('temporal') && signals.datesExplicit === false) {
      retryStrategy = 'pgsl-read';
      explanation = 'Dates were inferred, not explicit — try direct reading';
    } else {
      retryStrategy = 'pgsl-read';
      explanation = `Medium confidence (${(confidence * 100).toFixed(0)}%) — retry with general reading`;
    }
  }

  // Log to history
  if (config.logHistory) {
    recordEvalOutcome({
      questionType: signals.questionType,
      strategy: signals.strategyUsed,
      confidence,
      timestamp: new Date().toISOString(),
    });
  }

  return { confidence, level, signals, action, retryStrategy, explanation };
}

/**
 * Run answer pipeline with automatic retry based on eval.
 *
 * This is the general-purpose wrapper that any answer function can use:
 *   1. Get answer from primary strategy
 *   2. Evaluate confidence
 *   3. If low → retry with alternative strategy
 *   4. If still low → escalate
 *   5. Return best answer with confidence metadata
 */
export function answerWithEval<T extends { answer: string; method: string }>(
  primaryFn: () => T,
  retryFn: ((strategy: string) => T) | undefined,
  signals: Omit<StructuralSignals, 'strategyUsed' | 'isAbstention'>,
  config: RuntimeEvalConfig = DEFAULT_EVAL_CONFIG,
): T & { eval: RuntimeEval } {
  // Attempt 1: primary strategy
  const primary = primaryFn();
  const isAbstention = primary.answer.toLowerCase().includes('not enough to answer');
  const evalResult = evaluate(
    { ...signals, strategyUsed: primary.method, isAbstention },
    config,
  );

  if (evalResult.action === 'accept' || evalResult.action === 'abstain' || !retryFn) {
    return { ...primary, eval: evalResult };
  }

  // Attempt 2: retry with suggested strategy
  if (evalResult.action === 'retry' && evalResult.retryStrategy) {
    const retry = retryFn(evalResult.retryStrategy);
    const retryIsAbstention = retry.answer.toLowerCase().includes('not enough to answer');
    const retryEval = evaluate(
      { ...signals, strategyUsed: retry.method, isAbstention: retryIsAbstention },
      config,
    );

    // Use retry if it's more confident
    if (retryEval.confidence > evalResult.confidence) {
      return { ...retry, eval: retryEval };
    }
  }

  // Return primary with its eval (even if low confidence)
  return { ...primary, eval: evalResult };
}

// ── Decorator Integration ──────────────────────────────────

/**
 * Create a runtime eval decorator for the HATEOAS node endpoint.
 *
 * This decorator adds confidence metadata to every node response,
 * based on the structural signals of how the node was retrieved/computed.
 */
export function createRuntimeEvalDecorator(_config: RuntimeEvalConfig = DEFAULT_EVAL_CONFIG) {
  return {
    id: 'decorator:runtime-eval',
    name: 'Runtime Eval',
    domain: 'system',
    trustLevel: 'system' as const,
    priority: 99, // runs last — evaluates what other decorators produced
    decorate(context: any) {
      const pgslStats = latticeStats(context.pgsl);
      const confidence = computeConfidence({
        sessionsMatched: context.containers?.length ?? 0,
        sessionsTotal: pgslStats.atoms,
        topRetrievalScore: (context.sourceOptions?.length ?? 0) + (context.targetOptions?.length ?? 0),
        sharedAtoms: context.sourceOptions?.length ?? 0,
        questionType: 'navigation',
        strategyUsed: 'hateoas',
        isAbstention: false,
      });

      return {
        affordances: [{
          rel: 'eval-confidence',
          title: `Confidence: ${(confidence * 100).toFixed(0)}%`,
          method: 'GET',
          href: '#',
          decoratorId: 'decorator:runtime-eval',
          decoratorName: 'Runtime Eval',
          trustLevel: 'system' as const,
          confidence,
          rationale: `${context.containers?.length ?? 0} containers, ${context.sourceOptions?.length ?? 0} source options`,
        }],
        suggestions: [],
      };
    },
  };
}
