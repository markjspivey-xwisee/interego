/**
 * @module pgsl/fact-extraction
 * @description Structured fact extraction for the PGSL fact lattice.
 *
 * Extracts (entity, relation, value, timestamp, modality) tuples from
 * natural language text. Two modes:
 *
 *   1. Structural extraction (no LLM): regex patterns for common fact types
 *   2. LLM-assisted extraction: Claude Haiku extracts structured facts
 *
 * Facts become typed PGSL atoms. The lattice operates on facts, not words.
 * This is the bridge between raw text and structured knowledge.
 *
 * Semiotic interpretation:
 *   - Each fact carries modal status (asserted, negated, hypothetical)
 *   - Temporal scope (when, how long, ordinal position)
 *   - Epistemic status (stated directly, inferred, uncertain)
 */

import type { IRI } from '../model/types.js';
import type { PGSLInstance } from './types.js';
import { ingest } from './lattice.js';

// ═════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════

export interface Fact {
  readonly entity: string;
  readonly relation: string;
  readonly value: string;
  readonly timestamp?: string;
  readonly modality: 'asserted' | 'negated' | 'hypothetical' | 'preference';
  readonly source: string;       // which extraction method
}

export interface FactExtractionResult {
  readonly facts: readonly Fact[];
  readonly factAtoms: readonly string[];  // canonical fact atom strings
}

// ═════════════════════════════════════════════════════════════
//  LLM-Assisted Fact Extraction
// ═════════════════════════════════════════════════════════════

/**
 * Extract structured facts using an LLM.
 * The LLM reads the session text and returns structured JSON facts.
 *
 * @param text - Session text to extract facts from
 * @param llmCall - Function that calls the LLM and returns text
 * @returns Extracted facts as typed atoms
 */
export async function extractFactsWithLLM(
  text: string,
  llmCall: (prompt: string) => Promise<string>,
): Promise<FactExtractionResult> {
  const prompt = `You are a fact extraction engine. Extract EVERY factual statement from this text as a JSON array.

RULES:
- Extract EVERYTHING mentioned: dates, numbers, prices, names, places, preferences, actions, problems, purchases, events, opinions, plans, habits, routines, relationships, possessions
- Include implicit facts (e.g., "I took it to the dealership" implies entity=user, relation=visited, value=dealership)
- Include preferences and opinions as facts with modality="preference"
- Include negated statements with modality="negated"
- Be EXHAUSTIVE — extract 20+ facts from a typical conversation

Format: [{"entity":"...", "relation":"...", "value":"...", "timestamp":"...", "modality":"asserted|negated|hypothetical|preference"}]

Text:
${text.slice(0, 4000)}

JSON array:`;

  try {
    const response = await llmCall(prompt);

    // Parse JSON from response — try multiple extraction strategies
    let jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // Try extracting from markdown code block
      const codeBlock = response.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
      if (codeBlock) jsonMatch = [codeBlock[1]!];
    }
    if (!jsonMatch) return structuralFactExtraction(text);

    const parsed = JSON.parse(jsonMatch[0]) as any[];
    const facts: Fact[] = parsed
      .filter(f => f.entity && f.relation && f.value)
      .map(f => ({
        entity: normalize(f.entity),
        relation: normalize(f.relation),
        value: normalize(f.value),
        timestamp: f.timestamp ?? undefined,
        modality: f.modality ?? 'asserted',
        source: 'llm',
      }));

    return {
      facts,
      factAtoms: factsToAtoms(facts),
    };
  } catch {
    // LLM failed — fall back to structural
    return structuralFactExtraction(text);
  }
}

// ═════════════════════════════════════════════════════════════
//  Structural Fact Extraction (no LLM)
// ═════════════════════════════════════════════════════════════

/**
 * Extract facts using regex patterns. No LLM needed.
 * Catches ~30-40% of facts that the LLM would find.
 */
export function structuralFactExtraction(text: string): FactExtractionResult {
  const facts: Fact[] = [];
  // Date extraction
  const dateRegex = /\b(?:on\s+)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{0,4}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/gi;
  const dates: string[] = [];
  for (const m of text.matchAll(dateRegex)) {
    dates.push(m[1]!.trim());
  }

  // Price/money extraction
  const priceRegex = /\$(\d+(?:,\d{3})*(?:\.\d{2})?)/g;
  for (const m of text.matchAll(priceRegex)) {
    facts.push({ entity: 'purchase', relation: 'cost', value: `$${m[1]}`, modality: 'asserted', source: 'structural' });
  }

  // Number extraction with context
  const numContextRegex = /(\w+)\s+(?:is|was|are|were|has|had|have)\s+(\d+(?:\.\d+)?)\s*(%|percent|years?|months?|days?|hours?|minutes?|miles?|pounds?|dollars?|kg|lbs?)?/gi;
  for (const m of text.matchAll(numContextRegex)) {
    facts.push({
      entity: normalize(m[1]!),
      relation: 'has_value',
      value: `${m[2]}${m[3] ? ` ${m[3]}` : ''}`,
      modality: 'asserted',
      source: 'structural',
    });
  }

  // Preference patterns
  const prefRegex = /(?:i|my)\s+(?:favorite|favourite|prefer|love|enjoy|like)\s+(?:\w+\s+)*?(\w[\w\s]{1,30})/gi;
  for (const m of text.matchAll(prefRegex)) {
    facts.push({ entity: 'user', relation: 'prefers', value: normalize(m[1]!), modality: 'preference', source: 'structural' });
  }

  // Action patterns (I verb-ed X)
  const actionRegex = /i\s+(bought|purchased|got|ordered|started|finished|completed|attended|visited|went\s+to|tried|used|watched|read|played|cooked|made|built|fixed|repaired)\s+(?:a|an|the|my|some)?\s*(\w[\w\s]{1,30}?)(?:\.|,|!|\band\b|$)/gi;
  for (const m of text.matchAll(actionRegex)) {
    const timestamp = dates.length > 0 ? dates[0] : undefined;
    facts.push({
      entity: 'user',
      relation: normalize(m[1]!),
      value: normalize(m[2]!),
      timestamp,
      modality: 'asserted',
      source: 'structural',
    });
  }

  // Issue/problem patterns
  const issueRegex = /(?:issue|problem|trouble|difficulty)\s+(?:with|about|regarding)\s+(?:my|the|a)?\s*(\w[\w\s]{1,20})/gi;
  for (const m of text.matchAll(issueRegex)) {
    facts.push({ entity: normalize(m[1]!), relation: 'had_issue', value: 'problem', modality: 'asserted', source: 'structural' });
  }

  // Negation patterns
  const negRegex = /(?:don't|didn't|doesn't|haven't|hasn't|never|not)\s+(\w+)\s+(\w[\w\s]{1,20})/gi;
  for (const m of text.matchAll(negRegex)) {
    facts.push({
      entity: 'user',
      relation: normalize(m[1]!),
      value: normalize(m[2]!),
      modality: 'negated',
      source: 'structural',
    });
  }

  // Age/time patterns
  const ageRegex = /(?:i'm|i am|i was)\s+(\d+)\s*(?:years?\s*old)?/gi;
  for (const m of text.matchAll(ageRegex)) {
    facts.push({ entity: 'user', relation: 'age', value: m[1]!, modality: 'asserted', source: 'structural' });
  }

  // Location patterns
  const locRegex = /(?:live|living|moved|moved\s+to|located|based)\s+(?:in|at|to)\s+(\w[\w\s]{1,30})/gi;
  for (const m of text.matchAll(locRegex)) {
    facts.push({ entity: 'user', relation: 'location', value: normalize(m[1]!), modality: 'asserted', source: 'structural' });
  }

  return {
    facts,
    factAtoms: factsToAtoms(facts),
  };
}

// ═════════════════════════════════════════════════════════════
//  Fact Atoms (for PGSL ingestion)
// ═════════════════════════════════════════════════════════════

/**
 * Convert facts to canonical atom strings for PGSL ingestion.
 * Each fact becomes: "entity::relation::value[::timestamp][::modality]"
 */
function factsToAtoms(facts: readonly Fact[]): string[] {
  const atoms: string[] = [];

  for (const f of facts) {
    // Full fact atom
    const parts = [f.entity, f.relation, f.value];
    if (f.timestamp) parts.push(`t:${f.timestamp}`);
    if (f.modality !== 'asserted') parts.push(`m:${f.modality}`);
    atoms.push(parts.join('::'));

    // Partial atoms for flexible matching
    atoms.push(`${f.entity}::${f.relation}`);
    atoms.push(`${f.relation}::${f.value}`);
    atoms.push(f.entity);
    atoms.push(f.value);
  }

  return [...new Set(atoms)];
}

/**
 * Ingest facts into PGSL as typed atoms.
 */
export function embedFactsInPGSL(pgsl: PGSLInstance, facts: FactExtractionResult): IRI {
  if (facts.factAtoms.length === 0) return '' as IRI;
  return ingest(pgsl, facts.factAtoms.slice(0, 100));
}

// ═════════════════════════════════════════════════════════════
//  Fact Querying
// ═════════════════════════════════════════════════════════════

/**
 * Parse a question into a fact query pattern.
 * Returns the atoms to search for in the fact lattice.
 */
export function questionToFactQuery(question: string): string[] {
  const lower = question.toLowerCase();
  const queryAtoms: string[] = [];

  // "How many X?" → count query
  const countMatch = lower.match(/how\s+many\s+(\w[\w\s]{1,30})/);
  if (countMatch) {
    queryAtoms.push(`count::${normalize(countMatch[1]!)}`);
    queryAtoms.push(normalize(countMatch[1]!));
  }

  // "How much money/cost?" → sum query
  const sumMatch = lower.match(/how\s+much\s+(?:money|total|did\s+\w+\s+(?:spend|cost|pay|earn))/);
  if (sumMatch) queryAtoms.push('cost', 'price', 'money', 'spend', 'purchase');

  // "What is my favorite X?" → preference query
  const prefMatch = lower.match(/(?:favorite|favourite|prefer|like\s+(?:best|most))\s+(\w+)/);
  if (prefMatch) {
    queryAtoms.push(`user::prefers`);
    queryAtoms.push(`prefers::${normalize(prefMatch[1]!)}`);
    queryAtoms.push(normalize(prefMatch[1]!));
  }

  // "When did X happen?" → temporal query
  const whenMatch = lower.match(/when\s+(?:did|was|were|have)\s+(?:i|we|you)?\s*(\w[\w\s]{1,30})/);
  if (whenMatch) {
    queryAtoms.push(`user::${normalize(whenMatch[1]!)}`);
    queryAtoms.push(normalize(whenMatch[1]!));
  }

  // "What was the first/last X?" → ordinal + entity query
  const ordinalMatch = lower.match(/(?:first|last|most\s+recent)\s+(\w[\w\s]{1,20})/);
  if (ordinalMatch) {
    queryAtoms.push(normalize(ordinalMatch[1]!));
  }

  // "Did I / Do I / Is my..." → yes/no query
  if (lower.match(/^(?:did|do|does|is|are|was|were|have|has)\s+/)) {
    // Extract the subject
    const yesnoMatch = lower.match(/(?:did|do|does|is|are|was|were|have|has)\s+(?:i|my|we)\s+(\w[\w\s]{1,30})/);
    if (yesnoMatch) {
      queryAtoms.push(`user::${normalize(yesnoMatch[1]!)}`);
      queryAtoms.push(normalize(yesnoMatch[1]!));
    }
  }

  // "How old..." → age query
  if (lower.includes('how old')) {
    queryAtoms.push('user::age', 'age');
  }

  // General: extract content words from question
  const words = lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
  queryAtoms.push(...words);

  return [...new Set(queryAtoms)];
}

/**
 * Match a fact query against extracted facts.
 * Returns matching facts ranked by relevance.
 */
export function matchFacts(
  queryAtoms: readonly string[],
  facts: readonly Fact[],
): { fact: Fact; score: number }[] {
  const querySet = new Set(queryAtoms);
  const results: { fact: Fact; score: number }[] = [];

  for (const fact of facts) {
    let score = 0;

    // Check entity match
    if (querySet.has(fact.entity)) score += 2;
    // Check relation match
    if (querySet.has(fact.relation)) score += 2;
    // Check value match
    if (querySet.has(fact.value)) score += 2;
    // Check composite matches
    if (querySet.has(`${fact.entity}::${fact.relation}`)) score += 3;
    if (querySet.has(`${fact.relation}::${fact.value}`)) score += 3;

    // Partial word matches
    for (const qa of queryAtoms) {
      if (fact.entity.includes(qa) || qa.includes(fact.entity)) score += 0.5;
      if (fact.value.includes(qa) || qa.includes(fact.value)) score += 0.5;
    }

    if (score > 0) results.push({ fact, score });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Derive an answer from matched facts.
 * Handles counting, summing, temporal ordering, yes/no, and direct lookup.
 */
export function deriveAnswer(
  question: string,
  matchedFacts: readonly { fact: Fact; score: number }[],
): string | null {
  if (matchedFacts.length === 0) return null;

  const lower = question.toLowerCase();

  // Count queries
  if (lower.includes('how many')) {
    // Count unique facts with high scores
    const relevant = matchedFacts.filter(f => f.score >= 2);
    if (relevant.length > 0) return String(relevant.length);
  }

  // Sum/total money queries
  if (lower.match(/how\s+much\s+(?:money|total|did)/)) {
    const amounts = matchedFacts
      .filter(f => f.fact.value.match(/^\$?\d/))
      .map(f => parseFloat(f.fact.value.replace(/[$,]/g, '')))
      .filter(n => !isNaN(n));
    if (amounts.length > 0) return `$${amounts.reduce((a, b) => a + b, 0)}`;
  }

  // Yes/No queries
  if (lower.match(/^(?:did|do|does|is|are|was|were|have|has)\s+/)) {
    const topFact = matchedFacts[0]!.fact;
    if (topFact.modality === 'negated') return 'No';
    if (topFact.modality === 'asserted') return 'Yes';
  }

  // Age queries
  if (lower.includes('how old')) {
    const ageFact = matchedFacts.find(f => f.fact.relation === 'age');
    if (ageFact) return ageFact.fact.value;
  }

  // Preference queries
  if (lower.match(/(?:favorite|favourite|prefer)/)) {
    const prefFact = matchedFacts.find(f => f.fact.modality === 'preference' || f.fact.relation === 'prefers');
    if (prefFact) return prefFact.fact.value;
  }

  // Default: return the top fact's value
  return matchedFacts[0]!.fact.value;
}

// ═════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 40);
}

const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'but', 'and', 'or', 'if', 'that', 'this', 'it', 'its', 'my',
  'me', 'we', 'our', 'you', 'your', 'he', 'him', 'she', 'her', 'they',
  'them', 'their', 'what', 'which', 'who', 'how', 'when', 'where', 'not',
  'i', 'am', 'been', 'just', 'about', 'very', 'also', 'so', 'up', 'out',
]);
