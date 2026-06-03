/**
 * @module pgsl/entity-extraction
 * @description Entity-level atom extraction for PGSL.
 *
 * Instead of ingesting raw words as atoms, extract meaningful entities
 * and n-grams that bridge semantic gaps:
 *
 *   Raw: "What was the first issue I had with my new car after its first service?"
 *   Words: [What, was, the, first, issue, I, had, with, my, new, car, after, its, first, service]
 *   Entities: [car, first_service, issue, new_car, first_issue, car_service]
 *
 * Three extraction layers:
 *   1. Stopword removal — remove noise words
 *   2. N-gram extraction — bigrams and trigrams as compound atoms
 *   3. Noun phrase chunking — simple pattern-based NP detection
 *
 * No ML model needed — pure structural extraction.
 */

import type { PGSLInstance } from './types.js';
import type { IRI } from '../model/types.js';
import { ingest } from './lattice.js';

// ═════════════════════════════════════════════════════════════
//  Stopwords
// ═════════════════════════════════════════════════════════════

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'because',
  'but', 'and', 'or', 'if', 'while', 'that', 'this', 'these', 'those',
  'what', 'which', 'who', 'whom', 'whose', 'it', 'its', 'i', 'me', 'my',
  'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
  'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
  'hers', 'herself', 'they', 'them', 'their', 'theirs', 'themselves',
  'about', 'up', 'down', 'also', 'get', 'got', 'getting', 'go', 'going',
  'went', 'gone', 'come', 'came', 'make', 'made', 'take', 'took', 'taken',
  'give', 'gave', 'given', 'say', 'said', 'tell', 'told', 'ask', 'asked',
  'know', 'knew', 'known', 'think', 'thought', 'see', 'saw', 'seen',
  'want', 'like', 'look', 'looked', 'looking', 'really', 'even', 'back',
  'still', 'way', 'well', 'let', 'much', 'thing', 'things', 'something',
]);

// ═════════════════════════════════════════════════════════════
//  Entity Extraction
// ═════════════════════════════════════════════════════════════

export interface EntityExtractionResult {
  readonly contentWords: readonly string[];    // stopwords removed
  readonly bigrams: readonly string[];         // adjacent content word pairs
  readonly trigrams: readonly string[];        // adjacent content word triples
  readonly nounPhrases: readonly string[];     // simple NP chunks
  readonly allEntities: readonly string[];     // combined, deduplicated
}

/**
 * Extract entities from text — content words, n-grams, and noun phrases.
 */
export function extractEntities(text: string): EntityExtractionResult {
  const words = tokenize(text);

  // 1. Content words (stopwords removed)
  const contentWords = words.filter(w => !STOPWORDS.has(w) && w.length > 1);

  // 2. Bigrams from content words
  const bigrams: string[] = [];
  for (let i = 0; i < contentWords.length - 1; i++) {
    bigrams.push(`${contentWords[i]}_${contentWords[i + 1]}`);
  }

  // 3. Trigrams from content words
  const trigrams: string[] = [];
  for (let i = 0; i < contentWords.length - 2; i++) {
    trigrams.push(`${contentWords[i]}_${contentWords[i + 1]}_${contentWords[i + 2]}`);
  }

  // 4. Noun phrase extraction (simple pattern-based)
  const nounPhrases = extractNounPhrases(words);

  // 5. Combine all, deduplicate
  const allSet = new Set<string>([
    ...contentWords,
    ...bigrams,
    ...trigrams,
    ...nounPhrases,
  ]);

  return {
    contentWords,
    bigrams,
    trigrams,
    nounPhrases,
    allEntities: [...allSet],
  };
}

/**
 * Ingest text into PGSL using entity-level atoms instead of raw words.
 * Returns the top fragment URI.
 */
export function embedEntitiesInPGSL(pgsl: PGSLInstance, text: string): IRI {
  const entities = extractEntities(text);

  // Ingest entities as a sequence — the PGSL lattice gives them structure
  if (entities.allEntities.length === 0) {
    // Fallback to raw words if no entities extracted
    const words = tokenize(text);
    return ingest(pgsl, words);
  }

  return ingest(pgsl, entities.allEntities);
}

/**
 * Extract entities from text and ingest BOTH raw words AND entities.
 * This gives the lattice two overlapping sequences — the meet between
 * them captures the entity-word relationship.
 */
export function embedDualInPGSL(pgsl: PGSLInstance, text: string): {
  wordUri: IRI;
  entityUri: IRI;
  entities: EntityExtractionResult;
} {
  const words = tokenize(text);
  const entities = extractEntities(text);

  const wordUri = ingest(pgsl, words);
  const entityUri = entities.allEntities.length > 0
    ? ingest(pgsl, entities.allEntities)
    : wordUri;

  return { wordUri, entityUri, entities };
}

// ═════════════════════════════════════════════════════════════
//  Noun Phrase Extraction (pattern-based)
// ═════════════════════════════════════════════════════════════

// Simple determiners and adjectives that precede nouns
const DETERMINERS = new Set(['the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'these', 'those']);
const ADJECTIVES = new Set([
  'new', 'old', 'first', 'last', 'next', 'previous', 'big', 'small', 'good', 'bad',
  'great', 'little', 'long', 'short', 'high', 'low', 'young', 'important', 'different',
  'large', 'local', 'recent', 'major', 'main', 'current', 'early', 'late', 'best', 'worst',
  'favorite', 'favourite', 'free', 'full', 'special', 'general', 'specific', 'social',
  'real', 'certain', 'whole', 'entire', 'final', 'initial', 'original', 'particular',
]);

/**
 * Extract noun phrases using simple pattern matching.
 * Pattern: (DET)? (ADJ)* NOUN+
 */
function extractNounPhrases(words: string[]): string[] {
  const phrases: string[] = [];
  let i = 0;

  while (i < words.length) {
    const phrase: string[] = [];

    // Skip determiner
    if (DETERMINERS.has(words[i]!)) {
      i++;
    }

    // Collect adjectives
    while (i < words.length && ADJECTIVES.has(words[i]!)) {
      phrase.push(words[i]!);
      i++;
    }

    // Collect content words (potential nouns)
    while (i < words.length && !STOPWORDS.has(words[i]!) && words[i]!.length > 1) {
      phrase.push(words[i]!);
      i++;
    }

    if (phrase.length >= 2) {
      phrases.push(phrase.join('_'));
    }

    // Skip stopwords
    while (i < words.length && (STOPWORDS.has(words[i]!) || words[i]!.length <= 1)) {
      i++;
    }
  }

  return phrases;
}

// ═════════════════════════════════════════════════════════════
//  Tokenizer
// ═════════════════════════════════════════════════════════════

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
}
