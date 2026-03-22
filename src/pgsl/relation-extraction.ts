/**
 * @module pgsl/relation-extraction
 * @description Relation extraction for PGSL — extracts (subject, predicate, object)
 * triples from natural language text.
 *
 * No ML model. Uses pattern-based extraction:
 *   1. Subject-verb-object patterns (X is/was/has/had Y)
 *   2. Possessive patterns (X's Y, Y of X)
 *   3. Causal patterns (X caused Y, because of X then Y)
 *   4. Temporal patterns (X happened before/after Y)
 *   5. Attribute patterns (X with Y, X including Y)
 *
 * Each relation becomes a compound atom: "subject::predicate::object"
 * These atoms bridge semantic gaps that word-level atoms can't.
 *
 * "GPS system not functioning" → relation atom: "car::had_issue::gps_system"
 * "What was the issue with my car?" → relation atom: "car::had_issue::?"
 * Shared atom: "car::had_issue" bridges the gap.
 */

import type { PGSLInstance } from './types.js';
import type { IRI } from '../model/types.js';
import { ingest } from './lattice.js';
import { extractEntities } from './entity-extraction.js';

// ═════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════

export interface Relation {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: number;      // 0-1, pattern match quality
  readonly source: string;          // which pattern matched
}

export interface RelationExtractionResult {
  readonly relations: readonly Relation[];
  readonly relationAtoms: readonly string[];    // "subject::predicate::object"
  readonly partialAtoms: readonly string[];     // "subject::predicate", "predicate::object"
  readonly allAtoms: readonly string[];         // combined with entity atoms
}

// ═════════════════════════════════════════════════════════════
//  Pattern-based Relation Extraction
// ═════════════════════════════════════════════════════════════

interface PatternDef {
  regex: RegExp;
  extract: (match: RegExpMatchArray) => Relation | null;
}

const PATTERNS: PatternDef[] = [
  // X is/was/are/were Y
  {
    regex: /\b([a-z][\w\s]{1,30}?)\s+(?:is|was|are|were)\s+(?:a|an|the)?\s*([a-z][\w\s]{1,30}?)(?:\.|,|;|\band\b|\bthat\b|$)/gi,
    extract: (m) => ({
      subject: normalize(m[1]!), predicate: 'is_a', object: normalize(m[2]!),
      confidence: 0.6, source: 'copula',
    }),
  },
  // X has/had/have Y
  {
    regex: /\b([a-z][\w\s]{1,30}?)\s+(?:has|had|have)\s+(?:a|an|the)?\s*([a-z][\w\s]{1,30}?)(?:\.|,|;|$)/gi,
    extract: (m) => ({
      subject: normalize(m[1]!), predicate: 'has', object: normalize(m[2]!),
      confidence: 0.6, source: 'has',
    }),
  },
  // X's Y / Y of X
  {
    regex: /\b([a-z][\w]{1,20})'s\s+([a-z][\w\s]{1,20})/gi,
    extract: (m) => ({
      subject: normalize(m[1]!), predicate: 'possesses', object: normalize(m[2]!),
      confidence: 0.7, source: 'possessive',
    }),
  },
  {
    regex: /\b([a-z][\w\s]{1,20}?)\s+of\s+(?:the|my|his|her|their|its)?\s*([a-z][\w\s]{1,20})/gi,
    extract: (m) => ({
      subject: normalize(m[2]!), predicate: 'has', object: normalize(m[1]!),
      confidence: 0.5, source: 'of',
    }),
  },
  // X caused/led to/resulted in Y
  {
    regex: /\b([a-z][\w\s]{1,30}?)\s+(?:caused|led\s+to|resulted\s+in|created|produced|triggered)\s+(?:a|an|the)?\s*([a-z][\w\s]{1,30}?)(?:\.|,|;|$)/gi,
    extract: (m) => ({
      subject: normalize(m[1]!), predicate: 'caused', object: normalize(m[2]!),
      confidence: 0.8, source: 'causal',
    }),
  },
  // because of X, Y / X because Y
  {
    regex: /because\s+(?:of\s+)?([a-z][\w\s]{1,30}?),?\s+([a-z][\w\s]{1,30}?)(?:\.|,|;|$)/gi,
    extract: (m) => ({
      subject: normalize(m[1]!), predicate: 'caused', object: normalize(m[2]!),
      confidence: 0.7, source: 'because',
    }),
  },
  // X happened/occurred before/after Y
  {
    regex: /\b([a-z][\w\s]{1,30}?)\s+(?:happened|occurred)\s+(?:before|after)\s+([a-z][\w\s]{1,30}?)(?:\.|,|;|$)/gi,
    extract: (m) => ({
      subject: normalize(m[1]!), predicate: 'temporal_order', object: normalize(m[2]!),
      confidence: 0.7, source: 'temporal',
    }),
  },
  // X with Y / X including Y / X such as Y
  {
    regex: /\b([a-z][\w\s]{1,20}?)\s+(?:with|including|such\s+as|featuring)\s+(?:a|an|the)?\s*([a-z][\w\s]{1,20})/gi,
    extract: (m) => ({
      subject: normalize(m[1]!), predicate: 'has_attribute', object: normalize(m[2]!),
      confidence: 0.5, source: 'attribute',
    }),
  },
  // X [verb]ed Y (past tense action)
  {
    regex: /\b([a-z][\w]{1,15})\s+((?:start|finish|complet|mention|discuss|report|discover|experienc|encounter|notic|fix|repair|replac|updat|install|remov|add|chang|improv|reduc|increas|creat|buil|develop|design|implement|launch|deploy|us|tri|test|check|found|saw|heard|felt|thought|believ|want|need|lik|lov|hat|enjoy|decid|chose|plan|suggest|recommend|ask|question|answer|request)ed)\s+(?:a|an|the|that|my|his|her|their)?\s*([a-z][\w\s]{1,20}?)(?:\.|,|;|\band\b|$)/gi,
    extract: (m) => ({
      subject: normalize(m[1]!), predicate: normalize(m[2]!), object: normalize(m[3]!),
      confidence: 0.6, source: 'svo',
    }),
  },
  // issue/problem/error with X
  {
    regex: /\b(issue|problem|error|bug|fault|defect|malfunction|failure|trouble)\s+(?:with|in|on|about|regarding)\s+(?:the|my|a|an)?\s*([a-z][\w\s]{1,20})/gi,
    extract: (m) => ({
      subject: normalize(m[2]!), predicate: 'had_issue', object: normalize(m[1]!),
      confidence: 0.8, source: 'issue',
    }),
  },
  // X not working/functioning/responding
  {
    regex: /\b([a-z][\w\s]{1,20}?)\s+(?:not|wasn't|isn't|weren't|aren't)\s+(?:working|functioning|responding|operating|running|loading|connecting|displaying|showing|available)/gi,
    extract: (m) => ({
      subject: normalize(m[1]!), predicate: 'had_issue', object: 'malfunction',
      confidence: 0.8, source: 'not_working',
    }),
  },
];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 30);
}

// ═════════════════════════════════════════════════════════════
//  Extraction
// ═════════════════════════════════════════════════════════════

/**
 * Extract relations from text using pattern matching.
 */
export function extractRelations(text: string): RelationExtractionResult {
  const relations: Relation[] = [];
  const seen = new Set<string>();

  for (const pattern of PATTERNS) {
    // Reset regex state
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const rel = pattern.extract(match);
      if (!rel) continue;
      if (!rel.subject || !rel.object) continue;
      if (rel.subject.length < 2 || rel.object.length < 2) continue;

      const key = `${rel.subject}::${rel.predicate}::${rel.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push(rel);
    }
  }

  // Build atoms
  const relationAtoms = relations.map(r => `${r.subject}::${r.predicate}::${r.object}`);
  const partialAtoms: string[] = [];
  for (const r of relations) {
    partialAtoms.push(`${r.subject}::${r.predicate}`);
    partialAtoms.push(`${r.predicate}::${r.object}`);
  }

  // Combine with entity atoms
  const entities = extractEntities(text);
  const allSet = new Set<string>([
    ...entities.allEntities,
    ...relationAtoms,
    ...partialAtoms,
  ]);

  return {
    relations,
    relationAtoms,
    partialAtoms,
    allAtoms: [...allSet],
  };
}

/**
 * Ingest text into PGSL using relation-level atoms.
 * Combines entity atoms + relation triples + partial relation atoms.
 */
export function embedRelationsInPGSL(pgsl: PGSLInstance, text: string): IRI {
  const result = extractRelations(text);

  if (result.allAtoms.length === 0) {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    return ingest(pgsl, words.slice(0, 50));
  }

  // Cap atoms to prevent OOM on large texts
  // Prioritize: relation atoms > partial atoms > entity bigrams > content words
  const capped = result.allAtoms.slice(0, 80);
  return ingest(pgsl, capped);
}

/**
 * Multi-session retrieval: ingest multiple sessions, compose fragments
 * that collectively answer a question.
 *
 * Instead of finding ONE best session, find the top-N sessions whose
 * UNION of relation atoms covers the most question atoms.
 */
export function compositeRetrieve(
  _pgsl: PGSLInstance,
  questionText: string,
  sessionTexts: readonly string[],
  topN: number = 3,
): { sessionIndices: number[]; coverageScore: number; sharedRelations: string[] } {
  const questionResult = extractRelations(questionText);
  const questionAtoms = new Set(questionResult.allAtoms);

  if (questionAtoms.size === 0) {
    return { sessionIndices: [], coverageScore: 0, sharedRelations: [] };
  }

  // Score each session by atom coverage
  const sessionScores: { index: number; atoms: Set<string>; overlap: number }[] = [];

  for (let i = 0; i < sessionTexts.length; i++) {
    const sessionResult = extractRelations(sessionTexts[i]!);
    const sessionAtoms = new Set(sessionResult.allAtoms);
    let overlap = 0;
    for (const qa of questionAtoms) {
      if (sessionAtoms.has(qa)) overlap++;
    }
    sessionScores.push({ index: i, atoms: sessionAtoms, overlap });
  }

  // Greedy set cover: pick sessions that add the most uncovered atoms
  const selected: number[] = [];
  const covered = new Set<string>();
  const sharedRelations: string[] = [];

  for (let round = 0; round < topN; round++) {
    let bestIdx = -1;
    let bestNew = 0;

    for (const ss of sessionScores) {
      if (selected.includes(ss.index)) continue;
      let newCoverage = 0;
      for (const qa of questionAtoms) {
        if (!covered.has(qa) && ss.atoms.has(qa)) newCoverage++;
      }
      if (newCoverage > bestNew) {
        bestNew = newCoverage;
        bestIdx = ss.index;
      }
    }

    if (bestIdx < 0 || bestNew === 0) break;

    selected.push(bestIdx);
    const bestSession = sessionScores.find(s => s.index === bestIdx)!;
    for (const qa of questionAtoms) {
      if (bestSession.atoms.has(qa)) {
        covered.add(qa);
        sharedRelations.push(qa);
      }
    }
  }

  return {
    sessionIndices: selected,
    coverageScore: questionAtoms.size > 0 ? covered.size / questionAtoms.size : 0,
    sharedRelations: [...new Set(sharedRelations)],
  };
}
