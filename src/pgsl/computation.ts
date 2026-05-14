/**
 * @module pgsl/computation
 * @description Structural computation over PGSL lattice content.
 *
 * The LLM reads text. This module computes over extracted data.
 * Handles what LLMs are bad at: date arithmetic, counting,
 * aggregation, temporal ordering, and deduplication.
 *
 * These operations are deterministic, exact, and auditable —
 * unlike LLM-generated arithmetic which is probabilistic.
 */

import { embedInPGSL } from './geometric.js';
import { isSubFragment } from './category.js';

// ═════════════════════════════════════════════════════════════
//  Date Arithmetic (structural, not LLM)
// ═════════════════════════════════════════════════════════════

/**
 * Parse a date string into a Date object.
 * Handles various formats: ISO, US, relative, natural language.
 */
export function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  // ISO format
  const iso = Date.parse(dateStr);
  if (!isNaN(iso)) return new Date(iso);

  // Common formats: "March 15, 2023", "3/15/2023", "15 March 2023"
  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  // "Month Day, Year"
  const mdy = dateStr.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i);
  if (mdy) {
    const m = months[mdy[1]!.toLowerCase()];
    if (m !== undefined) return new Date(parseInt(mdy[3]!), m, parseInt(mdy[2]!));
  }

  // "Day Month Year"
  const dmy = dateStr.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(\w+),?\s*(\d{4})/i);
  if (dmy) {
    const m = months[dmy[2]!.toLowerCase()];
    if (m !== undefined) return new Date(parseInt(dmy[3]!), m, parseInt(dmy[1]!));
  }

  // "MM/DD/YYYY" or "M/D/YYYY"
  const slash = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) return new Date(parseInt(slash[3]!), parseInt(slash[1]!) - 1, parseInt(slash[2]!));

  // "YYYY/MM/DD"
  const ymd = dateStr.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (ymd) return new Date(parseInt(ymd[1]!), parseInt(ymd[2]!) - 1, parseInt(ymd[3]!));

  return null;
}

/**
 * Compute the difference between two dates in days.
 * Returns absolute value (always positive).
 */
export function daysBetween(date1: Date, date2: Date): number {
  const ms = Math.abs(date2.getTime() - date1.getTime());
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/**
 * Compute the difference in various units.
 */
export function dateDifference(date1: Date, date2: Date): {
  days: number;
  weeks: number;
  months: number;
  years: number;
  direction: 'before' | 'after' | 'same';
} {
  const days = daysBetween(date1, date2);
  const direction = date1 < date2 ? 'before' : date1 > date2 ? 'after' : 'same';
  return {
    days,
    weeks: Math.round(days / 7 * 10) / 10,
    months: Math.round(days / 30.44 * 10) / 10,
    years: Math.round(days / 365.25 * 10) / 10,
    direction,
  };
}

/**
 * Order dates chronologically.
 */
export function orderChronologically<T>(
  items: T[],
  getDate: (item: T) => Date | null,
): T[] {
  return [...items]
    .filter(item => getDate(item) !== null)
    .sort((a, b) => {
      const da = getDate(a)!;
      const db = getDate(b)!;
      return da.getTime() - db.getTime();
    });
}

// ═════════════════════════════════════════════════════════════
//  Counting & Aggregation (structural, not LLM)
// ═════════════════════════════════════════════════════════════

/**
 * Count unique items across multiple sources.
 * Deduplicates by normalized string comparison.
 */
export function countUnique(items: string[]): {
  count: number;
  unique: string[];
  duplicates: string[];
} {
  const normalized = new Map<string, string>();
  const duplicates: string[] = [];

  for (const item of items) {
    const norm = item.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
    if (normalized.has(norm)) {
      duplicates.push(item);
    } else {
      // Check if this item is structurally contained in an existing item
      // or if an existing item is contained in this one (substring check)
      let isContained = false;
      for (const [existingNorm] of normalized) {
        if (existingNorm.includes(norm) || norm.includes(existingNorm)) {
          // One contains the other — same thing at different granularity
          // Keep the shorter (more specific) version
          if (norm.length < existingNorm.length) {
            // New item is shorter (more specific) — replace
            normalized.delete(existingNorm);
            normalized.set(norm, item);
          }
          duplicates.push(item);
          isContained = true;
          break;
        }
      }
      if (!isContained) {
        normalized.set(norm, item);
      }
    }
  }

  return {
    count: normalized.size,
    unique: [...normalized.values()],
    duplicates,
  };
}

/**
 * Count unique items using PGSL structural containment.
 *
 * Instead of string comparison, ingests each item into the lattice and checks
 * if any item is a sub-fragment of another. "banana bread" IS structurally
 * inside "banana bread for neighbors" — count once.
 *
 * This is the PGSL-native way: canonical atoms are reused, so structural
 * overlap is automatic. Two items sharing the same atoms ARE related.
 */
export function countUniquePGSL(
  items: string[],
  pgsl: import('./types.js').PGSLInstance,
): {
  count: number;
  unique: string[];
  duplicates: string[];
} {
  // Ingest each item and get its URI. An item that can't be embedded
  // into the lattice can't participate in structural dedup — it falls
  // back to exact-string identity below rather than being silently
  // dropped, which would make `count` undercount.
  const itemUris: Array<{ text: string; uri: import('../model/types.js').IRI }> = [];
  const unembeddable: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    try {
      const uri = embedInPGSL(pgsl, trimmed);
      itemUris.push({ text: trimmed, uri });
    } catch {
      unembeddable.push(trimmed);
    }
  }

  // Dedup: if item A is a sub-fragment of item B, they're the same thing
  const unique: typeof itemUris = [];
  const duplicates: string[] = [];

  for (const item of itemUris) {
    let isDup = false;
    for (let i = 0; i < unique.length; i++) {
      const existing = unique[i]!;
      if (isSubFragment(pgsl, item.uri, existing.uri)) {
        // item is inside existing — duplicate
        duplicates.push(item.text);
        isDup = true;
        break;
      }
      if (isSubFragment(pgsl, existing.uri, item.uri)) {
        // existing is inside item — keep item (more specific), remove existing
        duplicates.push(existing.text);
        unique[i] = item;
        isDup = true;
        break;
      }
    }
    if (!isDup) unique.push(item);
  }

  // Fold unembeddable items in by exact-string identity — the most
  // conservative dedup available without a lattice URI to compare on.
  const uniqueTexts = unique.map(u => u.text);
  const seen = new Set(uniqueTexts);
  for (const text of unembeddable) {
    if (seen.has(text)) {
      duplicates.push(text);
    } else {
      seen.add(text);
      uniqueTexts.push(text);
    }
  }

  return {
    count: uniqueTexts.length,
    unique: uniqueTexts,
    duplicates,
  };
}

/**
 * Sum numeric values extracted from text.
 */
export function sumValues(values: Array<{ value: number; source: string }>): {
  total: number;
  breakdown: Array<{ value: number; source: string }>;
} {
  return {
    total: values.reduce((sum, v) => sum + v.value, 0),
    breakdown: values,
  };
}

/**
 * Compute average of numeric values.
 */
export function averageValues(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100;
}

/**
 * Extract numbers from text.
 */
export function extractNumbers(text: string): Array<{ value: number; context: string }> {
  const results: Array<{ value: number; context: string }> = [];

  // Match numbers with optional currency/unit context
  const patterns = [
    /\$?([\d,]+(?:\.\d+)?)\s*(?:dollars?|USD)?/gi,
    /(\d+(?:\.\d+)?)\s*(?:percent|%)/gi,
    /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)/gi,
    /(\d+(?:\.\d+)?)\s*(?:miles?|km|feet|meters?|lbs?|kg)/gi,
    /\b(\d+(?:\.\d+)?)\b/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = parseFloat(match[1]!.replace(/,/g, ''));
      if (!isNaN(value)) {
        const start = Math.max(0, match.index - 20);
        const end = Math.min(text.length, match.index + match[0].length + 20);
        results.push({
          value,
          context: text.slice(start, end).trim(),
        });
      }
    }
  }

  return results;
}

// ═════════════════════════════════════════════════════════════
//  Temporal Ordering of Facts
// ═════════════════════════════════════════════════════════════

export interface TemporalFact {
  fact: string;
  date: Date;
  source: string;
  sessionIndex: number;
}

/**
 * Given facts with dates, find the latest version of a fact
 * (for knowledge-update questions).
 */
export function getLatestFact(
  facts: TemporalFact[],
  matchFn: (fact: string) => boolean,
): TemporalFact | null {
  const matching = facts.filter(f => matchFn(f.fact));
  if (matching.length === 0) return null;
  return matching.reduce((latest, f) =>
    f.date > latest.date ? f : latest
  );
}

/**
 * Find the first occurrence of something after a given date.
 */
export function findFirstAfter(
  facts: TemporalFact[],
  afterDate: Date,
  matchFn: (fact: string) => boolean,
): TemporalFact | null {
  const matching = facts
    .filter(f => matchFn(f.fact) && f.date > afterDate)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  return matching[0] ?? null;
}

/**
 * Order facts by which came first.
 */
export function whichCameFirst(
  facts: TemporalFact[],
  labelA: string,
  labelB: string,
): { first: string; second: string; daysBetween: number } | null {
  const a = facts.find(f => f.fact.toLowerCase().includes(labelA.toLowerCase()));
  const b = facts.find(f => f.fact.toLowerCase().includes(labelB.toLowerCase()));
  if (!a || !b) return null;

  if (a.date <= b.date) {
    return { first: labelA, second: labelB, daysBetween: daysBetween(a.date, b.date) };
  } else {
    return { first: labelB, second: labelA, daysBetween: daysBetween(a.date, b.date) };
  }
}

// ═════════════════════════════════════════════════════════════
//  Abstention Detection
// ═════════════════════════════════════════════════════════════

/**
 * Check if question entities exist in any session content.
 * If no entities match, the system should abstain rather than hallucinate.
 */
export function shouldAbstain(
  questionEntities: string[],
  sessionEntities: Set<string>,
  threshold: number = 0.3,
): { abstain: boolean; matchRatio: number; matchedEntities: string[]; missingEntities: string[] } {
  if (questionEntities.length === 0) return { abstain: false, matchRatio: 1, matchedEntities: [], missingEntities: [] };

  const matched: string[] = [];
  const missing: string[] = [];

  for (const qe of questionEntities) {
    const norm = qe.toLowerCase();
    if (sessionEntities.has(norm) || [...sessionEntities].some(se => se.includes(norm) || norm.includes(se))) {
      matched.push(qe);
    } else {
      missing.push(qe);
    }
  }

  const matchRatio = matched.length / questionEntities.length;
  return {
    abstain: matchRatio < threshold,
    matchRatio,
    matchedEntities: matched,
    missingEntities: missing,
  };
}
