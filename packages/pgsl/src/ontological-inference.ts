/**
 * @module pgsl/ontological-inference
 * @description Ontological inference for PGSL retrieval.
 *
 * Bridges semantic gaps through structural knowledge:
 *
 *   1. Hypernym chains (IS-A): "GPS system" IS-A "car component" IS-A "component"
 *   2. Meronym chains (PART-OF): "GPS" PART-OF "car", "engine" PART-OF "car"
 *   3. Synonym expansion: "issue" = "problem" = "malfunction" = "defect" = "fault"
 *   4. Domain-specific inference: "not functioning" → "malfunction" → "issue"
 *   5. Causal chains: "malfunction" CAUSES "issue", "service" PREVENTS "issue"
 *
 * No ML model. Uses a compact built-in knowledge base + pattern rules.
 * The knowledge base is itself a PGSL-compatible structure — atoms and relations.
 *
 * When ingesting text, the system expands each entity with its ontological
 * neighbors, creating additional atoms that bridge the gap between different
 * phrasings of the same concept.
 */

// ═════════════════════════════════════════════════════════════
//  Synonym Groups
// ═════════════════════════════════════════════════════════════

/** Groups of interchangeable terms. Each group shares a canonical form. */
export const FALLBACK_SYNONYM_GROUPS: Record<string, string[]> = {
  // Problems/issues
  'issue': ['problem', 'issue', 'trouble', 'difficulty', 'malfunction', 'defect', 'fault', 'error', 'bug', 'failure', 'breakdown', 'glitch'],
  // Fixing
  'fix': ['fix', 'repair', 'resolve', 'solve', 'address', 'correct', 'remedy', 'patch', 'mend', 'restore'],
  // Start/begin
  'start': ['start', 'begin', 'commence', 'initiate', 'launch', 'kick off', 'embark'],
  // End/finish
  'finish': ['finish', 'end', 'complete', 'conclude', 'finalize', 'wrap up', 'close'],
  // Like/enjoy
  'like': ['like', 'enjoy', 'love', 'prefer', 'favor', 'appreciate', 'fond of'],
  // Dislike
  'dislike': ['dislike', 'hate', 'detest', 'loathe', 'despise', 'can\'t stand'],
  // Buy/purchase
  'buy': ['buy', 'purchase', 'acquire', 'get', 'obtain', 'order', 'pick up'],
  // Travel/move
  'travel': ['travel', 'go', 'visit', 'trip', 'journey', 'commute', 'drive', 'fly', 'ride'],
  // Say/tell
  'say': ['say', 'tell', 'mention', 'state', 'explain', 'describe', 'report', 'discuss', 'talk about'],
  // Work/function
  'work': ['work', 'function', 'operate', 'run', 'perform', 'serve'],
  // Not working
  'not_working': ['not working', 'not functioning', 'broken', 'malfunctioning', 'down', 'crashed', 'failed', 'unresponsive', 'out of order'],
  // Cost/price
  'cost': ['cost', 'price', 'fee', 'charge', 'expense', 'rate', 'amount'],
  // Big/large
  'big': ['big', 'large', 'huge', 'enormous', 'massive', 'substantial', 'significant'],
  // Small/little
  'small': ['small', 'little', 'tiny', 'minor', 'slight', 'minimal'],
  // Good/positive
  'good': ['good', 'great', 'excellent', 'wonderful', 'fantastic', 'amazing', 'positive', 'nice', 'pleasant'],
  // Bad/negative
  'bad': ['bad', 'terrible', 'awful', 'horrible', 'poor', 'negative', 'disappointing'],
  // Help/assist
  'help': ['help', 'assist', 'support', 'aid', 'guide'],
  // Change/modify
  'change': ['change', 'modify', 'alter', 'adjust', 'update', 'revise', 'amend'],
  // Create/make
  'create': ['create', 'make', 'build', 'develop', 'design', 'construct', 'produce', 'generate'],
  // Remove/delete
  'remove': ['remove', 'delete', 'eliminate', 'discard', 'drop', 'clear', 'erase'],
};

// The reverse lookup (word → canonical form) is built AFTER the lexicon loads, below the
// loader, so it indexes whatever is actually in use. Built here it would have indexed the
// frozen table and then silently disagreed with a published lexicon that had moved on.

// ═════════════════════════════════════════════════════════════
//  Hypernym/Meronym Knowledge Base
// ═════════════════════════════════════════════════════════════

/** IS-A relationships: specific → general */
export const FALLBACK_IS_A: Record<string, string[]> = {
  // Vehicles
  'car': ['vehicle', 'transport', 'automobile'],
  'truck': ['vehicle', 'transport'],
  'bike': ['vehicle', 'transport'],
  'bus': ['vehicle', 'transport'],
  // Car components
  'gps': ['car_component', 'electronics', 'navigation', 'device'],
  'gps_system': ['car_component', 'electronics', 'navigation', 'device'],
  'engine': ['car_component', 'mechanical', 'powertrain'],
  'brake': ['car_component', 'safety', 'mechanical'],
  'brakes': ['car_component', 'safety', 'mechanical'],
  'tire': ['car_component', 'wheel'],
  'tires': ['car_component', 'wheel'],
  'battery': ['car_component', 'electrical', 'power'],
  'transmission': ['car_component', 'mechanical', 'powertrain'],
  'ac': ['car_component', 'climate', 'comfort'],
  'air_conditioning': ['car_component', 'climate', 'comfort'],
  'radio': ['car_component', 'entertainment', 'electronics'],
  'headlight': ['car_component', 'lighting', 'safety'],
  'windshield': ['car_component', 'glass', 'safety'],
  // Tech
  'laptop': ['computer', 'device', 'electronics'],
  'phone': ['device', 'electronics', 'communication'],
  'smartphone': ['phone', 'device', 'electronics'],
  'tablet': ['device', 'electronics', 'computer'],
  'app': ['software', 'application', 'program'],
  'website': ['software', 'online_service', 'digital'],
  // People
  'doctor': ['professional', 'medical', 'healthcare'],
  'teacher': ['professional', 'education', 'instructor'],
  'engineer': ['professional', 'technical'],
  'manager': ['professional', 'leadership'],
  // Places
  'restaurant': ['place', 'food', 'dining', 'business'],
  'hospital': ['place', 'medical', 'healthcare', 'building'],
  'school': ['place', 'education', 'building'],
  'office': ['place', 'work', 'building'],
  'gym': ['place', 'fitness', 'exercise', 'building'],
  'park': ['place', 'outdoor', 'recreation'],
  // Events
  'service': ['event', 'maintenance', 'appointment'],
  'meeting': ['event', 'work', 'discussion'],
  'appointment': ['event', 'scheduled'],
  'party': ['event', 'social', 'celebration'],
  'wedding': ['event', 'ceremony', 'celebration'],
  'concert': ['event', 'entertainment', 'music'],
  'vacation': ['event', 'travel', 'leisure'],
  'trip': ['event', 'travel'],
  // Activities
  'cooking': ['activity', 'food', 'hobby'],
  'reading': ['activity', 'hobby', 'education'],
  'exercise': ['activity', 'fitness', 'health'],
  'running': ['exercise', 'activity', 'fitness'],
  'swimming': ['exercise', 'activity', 'fitness', 'sport'],
  // Emotions
  'happy': ['emotion', 'positive', 'feeling'],
  'sad': ['emotion', 'negative', 'feeling'],
  'angry': ['emotion', 'negative', 'feeling'],
  'excited': ['emotion', 'positive', 'feeling'],
  'worried': ['emotion', 'negative', 'feeling', 'anxiety'],
  'stressed': ['emotion', 'negative', 'feeling', 'anxiety'],
  // Health
  'cold': ['illness', 'health_issue', 'respiratory'],
  'flu': ['illness', 'health_issue', 'respiratory'],
  'headache': ['symptom', 'health_issue', 'pain'],
  'pain': ['symptom', 'health_issue'],
  'fever': ['symptom', 'health_issue'],
};

/** PART-OF relationships: part → whole */
export const FALLBACK_PART_OF: Record<string, string[]> = {
  'gps': ['car', 'vehicle'],
  'gps_system': ['car', 'vehicle'],
  'engine': ['car', 'vehicle'],
  'brake': ['car', 'vehicle'],
  'brakes': ['car', 'vehicle'],
  'tire': ['car', 'vehicle'],
  'tires': ['car', 'vehicle'],
  'battery': ['car', 'vehicle', 'phone', 'laptop'],
  'screen': ['phone', 'laptop', 'tablet', 'device'],
  'keyboard': ['laptop', 'computer'],
  'wheel': ['car', 'vehicle', 'bike'],
  'door': ['car', 'building', 'house'],
  'window': ['car', 'building', 'house'],
  'roof': ['car', 'building', 'house'],
  'seat': ['car', 'vehicle', 'chair'],
};

/** CAUSES relationships: cause → effect */
export const FALLBACK_CAUSES: Record<string, string[]> = {
  'malfunction': ['issue', 'problem', 'breakdown', 'failure'],
  'accident': ['injury', 'damage', 'issue'],
  'rain': ['wet', 'delay', 'flood'],
  'traffic': ['delay', 'late', 'stress'],
  'stress': ['anxiety', 'health_issue', 'insomnia'],
  'exercise': ['fitness', 'health', 'energy'],
  'service': ['fix', 'maintenance', 'repair'],
  'repair': ['fix', 'working', 'resolved'],
};

// ═════════════════════════════════════════════════════════════
//  The lexicon, READ FROM THE PUBLISHED ONTOLOGY
// ═════════════════════════════════════════════════════════════
//
// ★ The four tables above used to BE the knowledge base: 101 keys and 387 values of
// domain fact — cars, GPS units, brake components — frozen into the substrate package as
// TypeScript literals. This module's own header already said what they should have been
// ("The knowledge base is itself a PGSL-compatible structure — atoms and relations"), and
// they were not: nothing could add a term without editing and rebuilding `packages/pgsl`,
// and no other agent could read what this one believed "gps" was a part of.
//
// So they are published as RDF at docs/ns/pgsl-lexicon.ttl and read at runtime. The
// engine below is unchanged and stays general — it walks relations, it does not know what
// a brake is. Standard vocabulary where standard vocabulary exists: a synonym group is a
// skos:Concept with skos:prefLabel + skos:altLabel, and IS-A is skos:broader. Only the two
// relations SKOS has no term for are ours (pgsl:partOf, pgsl:causes).
//
// ★ The tables remain as FALLBACK_*, exported, for two reasons. A deployment that cannot
// reach docs/ns must degrade rather than silently lose every expansion — the retrieval
// path has no other signal that its lexicon vanished. And they are the anti-drift anchor:
// tests/the-lexicon-is-published-not-frozen.test.ts asserts the published file parses back
// to exactly these tables, so the copy that ships and the copy that falls back cannot
// diverge without a test saying so.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IRI, ParsedSubject } from '@interego/core';
import { parseTrig } from '@interego/core';

const PGSL_NS = 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#';
const SKOS_NS = 'http://www.w3.org/2004/02/skos/core#';

/**
 * Lexicon ENTRIES are hash IRIs in the lexicon DOCUMENT, not terms of the vocabulary:
 * `pgsl#partOf` is a term of the ontology, `pgsl-lexicon#gps` is a thing the ontology
 * describes, and 387 instances in the vocabulary namespace would all have read as
 * vocabulary.
 *
 * ★ A hash namespace rather than a `pgsl/term/` path, because the point of not using a urn:
 * is that the identifier RESOLVES, and only one of the two does. Fetching a hash IRI strips
 * the fragment and returns docs/ns/pgsl-lexicon.ttl — the document that defines the term —
 * by exactly the mechanism every other ontology here already relies on. A path IRI would
 * have needed 387 documents that do not exist, so it would have been an http URL that 404s:
 * the letter of "everything is a URL" without the part that makes it worth anything.
 */
const TERM_BASE = 'https://markjspivey-xwisee.github.io/interego/ns/pgsl-lexicon#';

export interface Lexicon {
  readonly synonymGroups: Record<string, string[]>;
  readonly isA: Record<string, string[]>;
  readonly partOf: Record<string, string[]>;
  readonly causes: Record<string, string[]>;
  /** `'published'` when docs/ns was read; `'fallback'` when the frozen tables were used. */
  readonly source: 'published' | 'fallback';
}

/** Same walk as @interego/compliance's resolveNsDir — env first, then upward from here. */
function resolveNsDir(): string | undefined {
  const configured = process.env['INTEREGO_NS_DIR']?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = joinPath(dir, 'docs', 'ns');
    if (existsSync(candidate)) return candidate;
    const parent = joinPath(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** `…/ns/pgsl-lexicon#gps_system` → `gps_system`; anything else → undefined. */
function localTerm(iri: string): string | undefined {
  return iri.startsWith(TERM_BASE) ? iri.slice(TERM_BASE.length) : undefined;
}

/**
 * Parse the published lexicon. Returns undefined — never a partial lexicon — if the file
 * is unreadable or yields nothing, so the caller falls back as a whole rather than
 * retrieving against a lexicon that is silently missing three of its four relations.
 */
export function parseLexicon(turtle: string): Omit<Lexicon, 'source'> | undefined {
  let doc;
  try { doc = parseTrig(turtle); } catch { return undefined; }

  const synonymGroups: Record<string, string[]> = {};
  const isA: Record<string, string[]> = {};
  const partOf: Record<string, string[]> = {};
  const causes: Record<string, string[]> = {};

  const collectIris = (subj: ParsedSubject, predicate: string): string[] =>
    (subj.properties.get(predicate as IRI) ?? [])
      .map(t => (t.kind === 'iri' ? localTerm(t.iri) : undefined))
      .filter((t): t is string => t !== undefined);

  for (const subj of doc.subjects) {
    // Blank-node subjects carry no term identity — a lexicon entry has to be nameable, or
    // nothing outside this process could ever refer to it.
    if (typeof subj.subject !== 'string') continue;
    const self = localTerm(subj.subject);
    if (self === undefined) continue;

    // A synonym group: prefLabel is the canonical form, altLabels are its members.
    const pref = subj.properties.get(`${SKOS_NS}prefLabel` as IRI)?.[0];
    const alts = (subj.properties.get(`${SKOS_NS}altLabel` as IRI) ?? [])
      .map(t => (t.kind === 'literal' ? t.value : undefined))
      .filter((v): v is string => v !== undefined);
    if (pref?.kind === 'literal' && alts.length > 0) synonymGroups[pref.value] = alts;

    const broader = collectIris(subj, `${SKOS_NS}broader`);
    if (broader.length > 0) isA[self] = broader;
    const parts = collectIris(subj, `${PGSL_NS}partOf`);
    if (parts.length > 0) partOf[self] = parts;
    const effects = collectIris(subj, `${PGSL_NS}causes`);
    if (effects.length > 0) causes[self] = effects;
  }

  if (Object.keys(synonymGroups).length === 0 || Object.keys(isA).length === 0) return undefined;
  return { synonymGroups, isA, partOf, causes };
}

function loadLexicon(): Lexicon {
  const ns = resolveNsDir();
  const file = ns ? joinPath(ns, 'pgsl-lexicon.ttl') : undefined;
  if (file && existsSync(file)) {
    try {
      const parsed = parseLexicon(readFileSync(file, 'utf8'));
      if (parsed) return { ...parsed, source: 'published' };
    } catch { /* fall through to the frozen tables */ }
  }
  return {
    synonymGroups: FALLBACK_SYNONYM_GROUPS,
    isA: FALLBACK_IS_A,
    partOf: FALLBACK_PART_OF,
    causes: FALLBACK_CAUSES,
    source: 'fallback',
  };
}

const LEXICON = loadLexicon();

const SYNONYM_GROUPS = LEXICON.synonymGroups;
const IS_A = LEXICON.isA;
const PART_OF = LEXICON.partOf;
const CAUSES = LEXICON.causes;

// Reverse lookup: word → canonical form, over the lexicon actually in use.
const SYNONYM_LOOKUP = new Map<string, string>();
for (const [canonical, synonyms] of Object.entries(SYNONYM_GROUPS)) {
  for (const syn of synonyms) {
    SYNONYM_LOOKUP.set(syn.toLowerCase(), canonical);
  }
}

/** Whether the lexicon in use was read from docs/ns or fell back to the frozen tables. */
export function lexiconSource(): 'published' | 'fallback' {
  return LEXICON.source;
}

// ═════════════════════════════════════════════════════════════
//  Inference Engine
// ═════════════════════════════════════════════════════════════

/**
 * Expand a term with its ontological neighbors.
 * Returns the original term plus all inferred related terms.
 */
export function expandTerm(term: string): string[] {
  const normalized = term.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const expanded = new Set<string>([normalized]);

  // Synonym expansion
  const canonical = SYNONYM_LOOKUP.get(normalized);
  if (canonical) {
    expanded.add(canonical);
    const synonyms = SYNONYM_GROUPS[canonical];
    if (synonyms) {
      for (const syn of synonyms) {
        expanded.add(syn.replace(/\s+/g, '_'));
      }
    }
  }

  // IS-A expansion (upward: specific → general)
  const isA = IS_A[normalized];
  if (isA) {
    for (const parent of isA) expanded.add(parent);
  }

  // PART-OF expansion (upward: part → whole)
  const partOf = PART_OF[normalized];
  if (partOf) {
    for (const whole of partOf) expanded.add(whole);
  }

  // CAUSES expansion
  const causes = CAUSES[normalized];
  if (causes) {
    for (const effect of causes) expanded.add(effect);
  }

  // Reverse CAUSES: find what causes this term
  for (const [cause, effects] of Object.entries(CAUSES)) {
    if (effects.includes(normalized)) expanded.add(cause);
  }

  // Reverse PART-OF: find parts of this term
  for (const [part, wholes] of Object.entries(PART_OF)) {
    if (wholes.includes(normalized)) expanded.add(part);
  }

  // Reverse IS-A: find subtypes of this term
  for (const [child, parents] of Object.entries(IS_A)) {
    if (parents.includes(normalized)) expanded.add(child);
  }

  return [...expanded];
}

/**
 * Expand all entities in a text with ontological inference.
 * Returns expanded atom set.
 */
export function expandEntitiesWithOntology(entities: readonly string[]): string[] {
  const expanded = new Set<string>();

  for (const entity of entities) {
    // Add original
    expanded.add(entity);

    // Split compound entities and expand each part
    const parts = entity.split('_');
    for (const part of parts) {
      if (part.length < 2) continue;
      for (const exp of expandTerm(part)) {
        expanded.add(exp);
      }
    }

    // Also expand the full compound
    for (const exp of expandTerm(entity)) {
      expanded.add(exp);
    }
  }

  return [...expanded];
}

/**
 * Score how well two texts relate through ontological inference.
 * Returns the overlap between their expanded entity sets.
 */
export function ontologicalSimilarity(textA: string, textB: string): {
  score: number;
  sharedConcepts: string[];
  expansionA: number;
  expansionB: number;
} {
  const wordsA = textA.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const wordsB = textB.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const expandedA = new Set(expandEntitiesWithOntology(wordsA));
  const expandedB = new Set(expandEntitiesWithOntology(wordsB));

  const shared: string[] = [];
  for (const a of expandedA) {
    if (expandedB.has(a)) shared.push(a);
  }

  return {
    score: Math.min(expandedA.size, expandedB.size) > 0
      ? shared.length / Math.min(expandedA.size, expandedB.size)
      : 0,
    sharedConcepts: shared,
    expansionA: expandedA.size,
    expansionB: expandedB.size,
  };
}
