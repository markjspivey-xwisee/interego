/**
 * @module pgsl/advanced-temporal
 * @description Advanced temporal retrieval for Context Graphs.
 *
 * Temporal questions require TWO-PHASE retrieval:
 *   Phase 1: Find sessions containing the referenced entities
 *   Phase 2: Use session timestamps to answer temporal relations
 *
 * Question patterns:
 *   "Which X came first, A or B?" → find A and B, compare dates
 *   "How many days between X and Y?" → find X and Y, compute duration
 *   "What was the first X after Y?" → find events after Y, return first
 */

import { expandEntitiesWithOntology } from './ontological-inference.js';
import { extractEntities } from './entity-extraction.js';

// ═════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════

export interface TemporalQuestionParsed {
  readonly type: 'ordering' | 'duration' | 'first_after' | 'last_before' | 'when' | 'general';
  readonly entityA?: string;
  readonly entityB?: string;
  readonly allEntities: readonly string[];
}

export interface AdvancedTemporalResult {
  readonly bestSessionIndex: number;
  readonly score: number;
  readonly matchedEntities: readonly string[];
  readonly method: string;
  readonly secondaryIndices: number[];
}

// ═════════════════════════════════════════════════════════════
//  Temporal Question Parsing
// ═════════════════════════════════════════════════════════════

/**
 * Parse a temporal question to extract the comparison entities and type.
 */
export function parseTemporalQuestion(question: string): TemporalQuestionParsed {
  const lower = question.toLowerCase();
  const entities = extractEntities(question);
  const contentWords = entities.contentWords;

  // "Which X came first, A or B?" / "Which did I do first, A or B?"
  const orderingMatch = lower.match(/which\s+.*(?:first|earlier|before).*,?\s+(?:the\s+)?(.+?)\s+or\s+(?:the\s+)?(.+?)[\?\.]/i);
  if (orderingMatch) {
    return {
      type: 'ordering',
      entityA: cleanEntity(orderingMatch[1]!),
      entityB: cleanEntity(orderingMatch[2]!),
      allEntities: contentWords,
    };
  }

  // "How many days between X and Y?"
  const durationMatch = lower.match(/how\s+many\s+(?:days?|weeks?|months?)\s+(?:between|from|since|after|before)\s+(?:the\s+)?(.+?)\s+(?:and|to|until)\s+(?:the\s+)?(.+?)[\?\.]/i);
  if (durationMatch) {
    return {
      type: 'duration',
      entityA: cleanEntity(durationMatch[1]!),
      entityB: cleanEntity(durationMatch[2]!),
      allEntities: contentWords,
    };
  }

  // "How many days before/after X did Y happen?"
  const durationMatch2 = lower.match(/how\s+many\s+(?:days?|weeks?|months?)\s+(?:before|after)\s+(?:the\s+)?(.+?)\s+(?:did|was|were|had)\s+(?:i\s+)?(.+?)[\?\.]/i);
  if (durationMatch2) {
    return {
      type: 'duration',
      entityA: cleanEntity(durationMatch2[2]!),
      entityB: cleanEntity(durationMatch2[1]!),
      allEntities: contentWords,
    };
  }

  // "How many days did it take for X after Y?"
  const durationMatch3 = lower.match(/how\s+many\s+(?:days?|weeks?|months?)\s+(?:did\s+it\s+take|had\s+passed|elapsed)\s+.*?(?:to|for|between)\s+(.+?)(?:\s+after\s+(.+?))?[\?\.]/i);
  if (durationMatch3) {
    return {
      type: 'duration',
      entityA: cleanEntity(durationMatch3[1]!),
      entityB: durationMatch3[2] ? cleanEntity(durationMatch3[2]) : undefined,
      allEntities: contentWords,
    };
  }

  // "What was the first X after Y?"
  const firstAfterMatch = lower.match(/(?:what|which)\s+was\s+the\s+first\s+(.+?)\s+after\s+(.+?)[\?\.]/i);
  if (firstAfterMatch) {
    return {
      type: 'first_after',
      entityA: cleanEntity(firstAfterMatch[1]!),
      entityB: cleanEntity(firstAfterMatch[2]!),
      allEntities: contentWords,
    };
  }

  // General "when" questions
  if (lower.startsWith('when ') || lower.includes('what date') || lower.includes('what time')) {
    return { type: 'when', allEntities: contentWords };
  }

  return { type: 'general', allEntities: contentWords };
}

function cleanEntity(text: string): string {
  return text.trim()
    .replace(/^(?:the|a|an|my|our|his|her|their|its)\s+/i, '')
    .replace(/[?.!,;:]+$/, '')
    .trim();
}

// ═════════════════════════════════════════════════════════════
//  Advanced Temporal Retrieval
// ═════════════════════════════════════════════════════════════

/**
 * Advanced temporal retrieval: entity-first, then temporal reasoning.
 */
export function advancedTemporalRetrieve(
  question: string,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): AdvancedTemporalResult {
  const parsed = parseTemporalQuestion(question);

  switch (parsed.type) {
    case 'ordering':
      return orderingRetrieve(parsed, sessions);
    case 'duration':
      return durationRetrieve(parsed, sessions);
    case 'first_after':
      return firstAfterRetrieve(parsed, sessions);
    default:
      return entityTemporalRetrieve(parsed, sessions);
  }
}

/**
 * "Which came first, A or B?" → find both, return the one in the earlier session
 */
function orderingRetrieve(
  parsed: TemporalQuestionParsed,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): AdvancedTemporalResult {
  if (!parsed.entityA || !parsed.entityB) {
    return entityTemporalRetrieve(parsed, sessions);
  }

  const entityAExpanded = new Set(expandEntitiesWithOntology(tokenize(parsed.entityA)));
  const entityBExpanded = new Set(expandEntitiesWithOntology(tokenize(parsed.entityB)));

  let bestAIdx = -1;
  let bestAScore = 0;
  let bestBIdx = -1;
  let bestBScore = 0;

  for (const session of sessions) {
    const sessionWords = new Set(tokenize(session.text));

    let scoreA = 0;
    for (const e of entityAExpanded) { if (sessionWords.has(e)) scoreA++; }
    scoreA = entityAExpanded.size > 0 ? scoreA / entityAExpanded.size : 0;

    let scoreB = 0;
    for (const e of entityBExpanded) { if (sessionWords.has(e)) scoreB++; }
    scoreB = entityBExpanded.size > 0 ? scoreB / entityBExpanded.size : 0;

    if (scoreA > bestAScore) { bestAScore = scoreA; bestAIdx = session.index; }
    if (scoreB > bestBScore) { bestBScore = scoreB; bestBIdx = session.index; }
  }

  // For "which first?" — the answer is in the EARLIER session
  // The session that was mentioned first (lower timestamp or lower index) contains the answer
  const bothFound = bestAIdx >= 0 && bestBIdx >= 0;
  let bestIdx: number;

  if (bothFound && bestAIdx !== bestBIdx) {
    // Both entities found in different sessions — answer is in the session
    // containing the entity that came first (earlier index = earlier in conversation)
    bestIdx = Math.min(bestAIdx, bestBIdx);
  } else if (bestAIdx >= 0) {
    bestIdx = bestAIdx;
  } else if (bestBIdx >= 0) {
    bestIdx = bestBIdx;
  } else {
    bestIdx = 0;
  }

  return {
    bestSessionIndex: bestIdx,
    score: Math.max(bestAScore, bestBScore),
    matchedEntities: [parsed.entityA, parsed.entityB],
    method: 'ordering',
    secondaryIndices: bothFound ? [Math.max(bestAIdx, bestBIdx)] : [],
  };
}

/**
 * "How many days between X and Y?" → find both sessions, they contain the answer
 */
function durationRetrieve(
  parsed: TemporalQuestionParsed,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): AdvancedTemporalResult {
  // Find sessions mentioning both entities
  const allEntities = [
    ...(parsed.entityA ? tokenize(parsed.entityA) : []),
    ...(parsed.entityB ? tokenize(parsed.entityB) : []),
    ...parsed.allEntities,
  ];
  const expanded = new Set(expandEntitiesWithOntology(allEntities));

  const scored = sessions.map(session => {
    const words = new Set(tokenize(session.text));
    let overlap = 0;
    for (const e of expanded) { if (words.has(e)) overlap++; }
    return { index: session.index, score: expanded.size > 0 ? overlap / expanded.size : 0 };
  }).sort((a, b) => b.score - a.score);

  return {
    bestSessionIndex: scored[0]?.index ?? 0,
    score: scored[0]?.score ?? 0,
    matchedEntities: allEntities.slice(0, 5),
    method: 'duration',
    secondaryIndices: scored.slice(1, 3).map(s => s.index),
  };
}

/**
 * "What was the first X after Y?" → find Y, then find X in later sessions
 */
function firstAfterRetrieve(
  parsed: TemporalQuestionParsed,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): AdvancedTemporalResult {
  // Find session with entity B (the anchor event)
  const entityBTokens = parsed.entityB ? tokenize(parsed.entityB) : [];
  const entityBExpanded = new Set(expandEntitiesWithOntology(entityBTokens));

  // Find session with entity A (the thing we're looking for)
  const entityATokens = parsed.entityA ? tokenize(parsed.entityA) : parsed.allEntities.slice() as string[];
  const entityAExpanded = new Set(expandEntitiesWithOntology(entityATokens));

  // Score all sessions for both entities
  const scored = sessions.map(session => {
    const words = new Set(tokenize(session.text));
    let scoreA = 0, scoreB = 0;
    for (const e of entityAExpanded) { if (words.has(e)) scoreA++; }
    for (const e of entityBExpanded) { if (words.has(e)) scoreB++; }
    return {
      index: session.index,
      scoreA: entityAExpanded.size > 0 ? scoreA / entityAExpanded.size : 0,
      scoreB: entityBExpanded.size > 0 ? scoreB / entityBExpanded.size : 0,
      combined: (scoreA + scoreB) / Math.max(entityAExpanded.size + entityBExpanded.size, 1),
    };
  });

  // Best combined score (session mentioning both or the main entity)
  scored.sort((a, b) => b.combined - a.combined);

  return {
    bestSessionIndex: scored[0]?.index ?? 0,
    score: scored[0]?.combined ?? 0,
    matchedEntities: [...entityATokens.slice(0, 3), ...entityBTokens.slice(0, 3)],
    method: 'first_after',
    secondaryIndices: scored.slice(1, 3).map(s => s.index),
  };
}

/**
 * General entity + temporal: find sessions with the most entity overlap
 */
function entityTemporalRetrieve(
  parsed: TemporalQuestionParsed,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): AdvancedTemporalResult {
  const expanded = new Set(expandEntitiesWithOntology(parsed.allEntities.slice() as string[]));

  const scored = sessions.map(session => {
    const words = new Set(tokenize(session.text));
    let overlap = 0;
    const matched: string[] = [];
    for (const e of expanded) {
      if (words.has(e)) { overlap++; matched.push(e); }
    }
    return {
      index: session.index,
      score: expanded.size > 0 ? overlap / expanded.size : 0,
      matched,
    };
  }).sort((a, b) => b.score - a.score);

  return {
    bestSessionIndex: scored[0]?.index ?? 0,
    score: scored[0]?.score ?? 0,
    matchedEntities: scored[0]?.matched ?? [],
    method: 'entity_temporal',
    secondaryIndices: scored.slice(1, 3).map(s => s.index),
  };
}

// ═════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w));
}

const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
  'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
  'but', 'and', 'or', 'if', 'that', 'this', 'it', 'its', 'my', 'me',
  'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they',
  'them', 'their', 'what', 'which', 'who', 'how', 'when', 'where', 'not',
  'no', 'so', 'up', 'out', 'just', 'about', 'than', 'very', 'also', 'i',
]);
