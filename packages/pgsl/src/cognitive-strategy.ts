/**
 * @module cognitive-strategy
 * @description Query → cognitive-strategy planner that bridges question
 * analysis with the affordance engine.
 *
 * Lives in `@interego/pgsl` because every signal feeding the decision
 * (`classifyQuestion`, `extractEntities`, `shouldAbstain`) comes from
 * the PGSL retrieval stack. The substrate kernel exposes the affordance
 * engine itself; the strategy layer above it that consults the
 * structural index is a particular composition over the substrate.
 */

import { classifyQuestion, type QuestionType } from './question-router.js';
import { extractEntities, type EntityExtractionResult } from './entity-extraction.js';
import { shouldAbstain } from './computation.js';

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
