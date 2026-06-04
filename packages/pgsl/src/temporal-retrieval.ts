/**
 * @module pgsl/temporal-retrieval
 * @description Temporal-aware retrieval for Interego.
 *
 * For temporal reasoning questions ("When did X happen?", "What happened first?"),
 * extract temporal markers from text and match against session timestamps.
 *
 * This bypasses content search entirely — the answer is in the metadata,
 * not the text.
 */

// ═════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════

export interface TemporalMarker {
  readonly type: 'date' | 'relative' | 'ordinal' | 'duration';
  readonly value: string;
  readonly normalized?: string;  // ISO 8601 if parseable
}

export interface TemporalMatch {
  readonly sessionIndex: number;
  readonly sessionDate?: string;
  readonly markers: readonly TemporalMarker[];
  readonly score: number;
}

// ═════════════════════════════════════════════════════════════
//  Temporal Marker Extraction
// ═════════════════════════════════════════════════════════════

/**
 * Extract temporal markers from text.
 */
export function extractTemporalMarkers(text: string): TemporalMarker[] {
  const markers: TemporalMarker[] = [];
  const lower = text.toLowerCase();

  // ISO dates (2026-03-22, 2026-03-22T04:00:00Z)
  const isoRegex = /\b(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?)?)\b/g;
  for (const match of text.matchAll(isoRegex)) {
    markers.push({ type: 'date', value: match[1]!, normalized: match[1]! });
  }

  // Natural dates (March 22, 2026 / 22 March 2026 / Mar 2026)
  const months = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const naturalDateRegex = new RegExp(`\\b(\\d{1,2})?\\s*(${months})\\s*(\\d{1,2})?[,.]?\\s*(\\d{4})?\\b`, 'gi');
  for (const match of text.matchAll(naturalDateRegex)) {
    markers.push({ type: 'date', value: match[0]!.trim() });
  }

  // Relative temporal references
  const relativePatterns = [
    'yesterday', 'today', 'tomorrow', 'last week', 'last month', 'last year',
    'next week', 'next month', 'next year', 'this week', 'this month', 'this year',
    'recently', 'earlier', 'later', 'previously', 'afterwards', 'before that',
    'after that', 'the day before', 'the next day', 'a week ago', 'a month ago',
    'a year ago', 'two days ago', 'three days ago',
  ];
  for (const pattern of relativePatterns) {
    if (lower.includes(pattern)) {
      markers.push({ type: 'relative', value: pattern });
    }
  }

  // Ordinal references (first, second, last, most recent)
  const ordinalPatterns = [
    'first', 'second', 'third', 'fourth', 'fifth', 'last', 'most recent',
    'latest', 'earliest', 'initial', 'final', 'previous', 'next',
  ];
  for (const pattern of ordinalPatterns) {
    if (lower.includes(pattern)) {
      markers.push({ type: 'ordinal', value: pattern });
    }
  }

  // Duration references
  const durationRegex = /\b(\d+)\s*(days?|weeks?|months?|years?|hours?|minutes?)\b/gi;
  for (const match of text.matchAll(durationRegex)) {
    markers.push({ type: 'duration', value: match[0]! });
  }

  return markers;
}

/**
 * Detect if a question is temporal-reasoning type.
 */
export function isTemporalQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  const temporalSignals = [
    'when did', 'when was', 'what date', 'what time', 'how long',
    'first time', 'last time', 'most recent', 'before', 'after',
    'how many days', 'how many weeks', 'how many months',
    'earlier', 'later', 'previously', 'since when',
    'what was the first', 'what was the last',
    'in what order', 'chronological',
  ];
  return temporalSignals.some(signal => lower.includes(signal));
}

/**
 * Match a temporal question against timestamped sessions.
 * Returns sessions ranked by temporal relevance.
 */
export function temporalMatch(
  question: string,
  sessions: readonly { text: string; timestamp?: string; index: number }[],
): TemporalMatch[] {
  const questionMarkers = extractTemporalMarkers(question);
  const isOrdinal = questionMarkers.some(m => m.type === 'ordinal');
  const questionLower = question.toLowerCase();

  const matches: TemporalMatch[] = [];

  for (const session of sessions) {
    const sessionMarkers = extractTemporalMarkers(session.text);
    let score = 0;

    // Date matching: if question mentions a date, find sessions near that date
    for (const qm of questionMarkers) {
      if (qm.type === 'date' && qm.normalized) {
        for (const sm of sessionMarkers) {
          if (sm.type === 'date' && sm.value.includes(qm.value.slice(0, 7))) {
            score += 2; // same month
          }
          if (sm.normalized === qm.normalized) {
            score += 5; // exact date match
          }
        }
        // Also check session timestamp
        if (session.timestamp?.includes(qm.value.slice(0, 10))) {
          score += 5;
        }
      }
    }

    // Ordinal matching: "first" → earliest session, "last" → latest
    if (isOrdinal) {
      if (questionLower.includes('first') || questionLower.includes('earliest') || questionLower.includes('initial')) {
        // Prefer earlier sessions (lower index)
        score += Math.max(0, (sessions.length - session.index) / sessions.length);
      }
      if (questionLower.includes('last') || questionLower.includes('most recent') || questionLower.includes('latest') || questionLower.includes('final')) {
        // Prefer later sessions (higher index)
        score += session.index / sessions.length;
      }
    }

    // Content word overlap with temporal context
    const questionWords = new Set(questionLower.split(/\s+/).filter(w => w.length > 2));
    const sessionWords = new Set(session.text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    let contentOverlap = 0;
    for (const w of questionWords) {
      if (sessionWords.has(w)) contentOverlap++;
    }
    score += contentOverlap * 0.1;

    if (score > 0) {
      matches.push({
        sessionIndex: session.index,
        sessionDate: session.timestamp,
        markers: sessionMarkers,
        score,
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}
