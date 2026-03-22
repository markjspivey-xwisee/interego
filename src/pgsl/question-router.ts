/**
 * @module pgsl/question-router
 * @description Routes questions to the optimal retrieval strategy.
 *
 * Question types and strategies:
 *   - Temporal → temporal facet exploitation (dates, ordering)
 *   - Factual/single-hop → entity + relation + ontological retrieval
 *   - Multi-hop → composite retrieval across sessions
 *   - Causal → causal chain traversal
 *   - Preference → attribute pattern matching
 *   - Abstention → check if information exists at all
 */

import type { PGSLInstance } from './types.js';
import type { IRI } from '../model/types.js';
import { isTemporalQuestion, temporalMatch } from './temporal-retrieval.js';
import { advancedTemporalRetrieve } from './advanced-temporal.js';
import { extractRelations } from './relation-extraction.js';
import { atomRetrieve } from './retrieval.js';
import { ontologicalSimilarity, expandEntitiesWithOntology } from './ontological-inference.js';
import { extractEntities } from './entity-extraction.js';
import { ingest } from './lattice.js';

// ═════════════════════════════════════════════════════════════
//  Question Classification
// ═════════════════════════════════════════════════════════════

export type QuestionType =
  | 'temporal'
  | 'factual'
  | 'causal'
  | 'preference'
  | 'multi-hop'
  | 'abstention'
  | 'unknown';

export function classifyQuestion(question: string): QuestionType {
  const lower = question.toLowerCase();

  if (isTemporalQuestion(question)) return 'temporal';

  // Causal
  if (lower.includes('why did') || lower.includes('what caused') ||
      lower.includes('because') || lower.includes('reason for') ||
      lower.includes('led to') || lower.includes('resulted in')) return 'causal';

  // Preference
  if (lower.includes('favorite') || lower.includes('favourite') ||
      lower.includes('prefer') || lower.includes('like most') ||
      lower.includes('like best') || lower.includes('opinion about') ||
      lower.includes('think about') || lower.includes('feel about')) return 'preference';

  // Abstention signals (negation + existence)
  if (lower.includes('did i ever') || lower.includes('have i ever') ||
      lower.includes('did we ever') || lower.includes('was there ever')) return 'abstention';

  // Multi-hop signals
  if (lower.includes(' and ') && (lower.includes('both') || lower.includes('compare') ||
      lower.includes('difference') || lower.includes('similar'))) return 'multi-hop';
  if ((lower.match(/\?/g) || []).length > 1) return 'multi-hop';

  return 'factual';
}

// ═════════════════════════════════════════════════════════════
//  Routed Retrieval
// ═════════════════════════════════════════════════════════════

export interface RoutedRetrievalResult {
  readonly strategy: QuestionType;
  readonly bestSessionIndex: number;
  readonly score: number;
  readonly evidence: string;        // why this session was chosen
  readonly secondaryIndices: number[];
}

/**
 * Route a question to the best retrieval strategy and execute it.
 */
export function routedRetrieve(
  pgsl: PGSLInstance,
  question: string,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): RoutedRetrievalResult {
  const qType = classifyQuestion(question);

  switch (qType) {
    case 'temporal':
      return temporalStrategy(question, sessions);
    case 'causal':
      return causalStrategy(pgsl, question, sessions);
    case 'preference':
      return preferenceStrategy(question, sessions);
    case 'multi-hop':
      return multiHopStrategy(pgsl, question, sessions);
    case 'abstention':
      return abstentionStrategy(question, sessions);
    case 'factual':
    default:
      return factualStrategy(pgsl, question, sessions);
  }
}

// ═════════════════════════════════════════════════════════════
//  Strategy Implementations
// ═════════════════════════════════════════════════════════════

function temporalStrategy(
  question: string,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): RoutedRetrievalResult {
  // Try advanced temporal (entity-first, then temporal reasoning)
  const advanced = advancedTemporalRetrieve(question, sessions);
  if (advanced.score > 0.05) {
    return {
      strategy: 'temporal',
      bestSessionIndex: advanced.bestSessionIndex,
      score: advanced.score,
      evidence: `Advanced temporal (${advanced.method}): ${advanced.matchedEntities.slice(0, 3).join(', ')}`,
      secondaryIndices: advanced.secondaryIndices,
    };
  }

  // Fallback to basic temporal
  const matches = temporalMatch(question, sessions);
  if (matches.length > 0) {
    return {
      strategy: 'temporal',
      bestSessionIndex: matches[0]!.sessionIndex,
      score: matches[0]!.score,
      evidence: `Basic temporal: ${matches[0]!.markers.map(m => m.value).join(', ')}`,
      secondaryIndices: matches.slice(1, 3).map(m => m.sessionIndex),
    };
  }

  // Final fallback to ontological
  return factualStrategy(null as any, question, sessions);
}

function factualStrategy(
  _pgsl: PGSLInstance | null,
  question: string,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): RoutedRetrievalResult {
  // Use ontological similarity for factual questions
  let bestIdx = 0;
  let bestScore = 0;
  let bestConcepts: string[] = [];

  for (const session of sessions) {
    const sim = ontologicalSimilarity(question, session.text);
    if (sim.score > bestScore) {
      bestScore = sim.score;
      bestIdx = session.index;
      bestConcepts = sim.sharedConcepts;
    }
  }

  // Also check with expanded entities in PGSL if available
  if (_pgsl) {
    const qEntities = extractEntities(question);
    const expanded = expandEntitiesWithOntology(qEntities.allEntities);
    const qUri = ingest(_pgsl, expanded.slice(0, 60));

    const sessionUris: { uri: IRI; idx: number }[] = [];
    for (const session of sessions) {
      const sEntities = extractEntities(session.text.slice(0, 500));
      const sExpanded = expandEntitiesWithOntology(sEntities.allEntities);
      const sUri = ingest(_pgsl, sExpanded.slice(0, 60));
      sessionUris.push({ uri: sUri, idx: session.index });
    }

    const retrieved = atomRetrieve(_pgsl, qUri, sessionUris.map(s => s.uri), 3);
    if (retrieved.length > 0 && retrieved[0]!.score > bestScore) {
      const match = sessionUris.find(s => s.uri === retrieved[0]!.candidateUri);
      if (match) {
        bestIdx = match.idx;
        bestScore = retrieved[0]!.score;
        bestConcepts = [...retrieved[0]!.sharedAtoms];
      }
    }
  }

  return {
    strategy: 'factual',
    bestSessionIndex: bestIdx,
    score: bestScore,
    evidence: `Ontological: ${bestConcepts.slice(0, 5).join(', ')}`,
    secondaryIndices: [],
  };
}

function causalStrategy(
  _pgsl: PGSLInstance,
  question: string,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): RoutedRetrievalResult {
  // Extract causal relations from question
  const qRelations = extractRelations(question);
  const causalAtoms = qRelations.relations
    .filter(r => r.predicate === 'caused' || r.source === 'causal' || r.source === 'because')
    .flatMap(r => [r.subject, r.object]);

  // Find sessions with matching causal entities
  let bestIdx = 0;
  let bestScore = 0;

  for (const session of sessions) {
    const sRelations = extractRelations(session.text.slice(0, 800));
    const sessionCausalAtoms = new Set(
      sRelations.relations
        .filter(r => r.predicate === 'caused' || r.source === 'causal')
        .flatMap(r => [r.subject, r.object])
    );

    let score = 0;
    for (const ca of causalAtoms) {
      if (sessionCausalAtoms.has(ca)) score += 2;
    }

    // Also use ontological similarity
    const sim = ontologicalSimilarity(question, session.text);
    score += sim.score * 3;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = session.index;
    }
  }

  return {
    strategy: 'causal',
    bestSessionIndex: bestIdx,
    score: bestScore,
    evidence: `Causal entities: ${causalAtoms.slice(0, 3).join(', ')}`,
    secondaryIndices: [],
  };
}

function preferenceStrategy(
  question: string,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): RoutedRetrievalResult {
  const lower = question.toLowerCase();

  // Extract the subject of preference
  const prefMatch = lower.match(/(?:favorite|favourite|prefer|like\s+(?:most|best))\s+(\w+)/);
  const prefSubject = prefMatch?.[1] ?? '';

  let bestIdx = 0;
  let bestScore = 0;

  for (const session of sessions) {
    const sessionLower = session.text.toLowerCase();
    let score = 0;

    // Check for preference language in session
    const prefWords = ['favorite', 'favourite', 'prefer', 'love', 'enjoy', 'like', 'best'];
    for (const pw of prefWords) {
      if (sessionLower.includes(pw)) score += 1;
    }

    // Check if preference subject appears
    if (prefSubject && sessionLower.includes(prefSubject)) score += 3;

    // Ontological backup
    const sim = ontologicalSimilarity(question, session.text);
    score += sim.score * 2;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = session.index;
    }
  }

  return {
    strategy: 'preference',
    bestSessionIndex: bestIdx,
    score: bestScore,
    evidence: `Preference subject: ${prefSubject}`,
    secondaryIndices: [],
  };
}

function multiHopStrategy(
  pgsl: PGSLInstance,
  question: string,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): RoutedRetrievalResult {
  // Multi-hop: find multiple sessions that together answer the question
  // Split question at "and" or multi-clause boundaries
  const parts = question.split(/\band\b|\bbut\b|,/);

  const bestIndices: number[] = [];
  let totalScore = 0;

  for (const part of parts) {
    if (part.trim().length < 5) continue;
    const result = factualStrategy(pgsl, part.trim(), sessions);
    if (!bestIndices.includes(result.bestSessionIndex)) {
      bestIndices.push(result.bestSessionIndex);
      totalScore += result.score;
    }
  }

  return {
    strategy: 'multi-hop',
    bestSessionIndex: bestIndices[0] ?? 0,
    score: totalScore,
    evidence: `Multi-hop: ${bestIndices.length} sessions combined`,
    secondaryIndices: bestIndices.slice(1),
  };
}

function abstentionStrategy(
  question: string,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): RoutedRetrievalResult {
  // Check if ANY session mentions the topic — if not, the answer is "no"/"never"
  const sim = factualStrategy(null, question, sessions);

  return {
    strategy: 'abstention',
    bestSessionIndex: sim.bestSessionIndex,
    score: sim.score,
    evidence: sim.score < 0.05 ? 'No evidence found — likely abstention' : `Low evidence: ${sim.evidence}`,
    secondaryIndices: [],
  };
}
