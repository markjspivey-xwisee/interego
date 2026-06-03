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
const SYNONYM_GROUPS: Record<string, string[]> = {
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

// Build reverse lookup: word → canonical form
const SYNONYM_LOOKUP = new Map<string, string>();
for (const [canonical, synonyms] of Object.entries(SYNONYM_GROUPS)) {
  for (const syn of synonyms) {
    SYNONYM_LOOKUP.set(syn.toLowerCase(), canonical);
  }
}

// ═════════════════════════════════════════════════════════════
//  Hypernym/Meronym Knowledge Base
// ═════════════════════════════════════════════════════════════

/** IS-A relationships: specific → general */
const IS_A: Record<string, string[]> = {
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
const PART_OF: Record<string, string[]> = {
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
const CAUSES: Record<string, string[]> = {
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
