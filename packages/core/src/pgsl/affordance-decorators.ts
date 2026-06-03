/**
 * @module pgsl/affordance-decorators
 * @description Distributed affordance decorator system for HATEOAS node responses.
 *
 * Decorators are pluggable modules that add affordances to node responses.
 * When a node is dereferenced, the decorator chain runs — each decorator
 * inspects the node, its paradigm context, and existing affordances,
 * and may add new ones.
 *
 * Decorators are themselves describable as Context Descriptors:
 * publishable to pods, discoverable, composable.
 *
 * Architecture:
 *   - DecoratorRegistry holds active decorators (mutable, add/remove at runtime)
 *   - decorateNode() runs the chain in priority order (lower = earlier)
 *   - Each decorator sees accumulated affordances from earlier decorators
 *   - Built-in decorators cover: core HATEOAS, ontology patterns, xAPI,
 *     coherence, persistence, LLM advisory, and federation
 *
 * All decorators are pure functions — no side effects.
 */

import type { IRI } from '../model/types.js';
import type { PGSLInstance, Value } from './types.js';

// ── Types ──────────────────────────────────────────────────

/** A decorator adds affordances to a node's HATEOAS response. */
export interface AffordanceDecorator {
  /** Unique identifier for this decorator */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** What domain this decorator covers */
  readonly domain: string;
  /** Trust level of the decorator's suggestions */
  readonly trustLevel: 'system' | 'expert' | 'community' | 'llm';
  /** Priority (higher = runs later, can override) */
  readonly priority: number;
  /** Decorator origin — where it was loaded from */
  readonly origin?: string;
  /**
   * Decorate a node with additional affordances.
   * Receives the node context and returns new affordances to add.
   * May also return structural suggestions (how to reorganize).
   */
  decorate(context: DecoratorContext): DecoratorResult;
}

/** Everything a decorator needs to make decisions. */
export interface DecoratorContext {
  /** The node being decorated */
  readonly uri: IRI;
  readonly value?: Value;
  readonly kind: 'Atom' | 'Fragment';
  readonly level: number;
  /** Resolved text */
  readonly resolved: string;
  /** Items (for fragments) */
  readonly items?: Array<{ uri: IRI; resolved: string; kind: string; level: number }>;
  /** Paradigm: what comes before/after this node */
  readonly sourceOptions: Array<{ uri: IRI; resolved: string }>;
  readonly targetOptions: Array<{ uri: IRI; resolved: string }>;
  /** Active constraints affecting this node */
  readonly constraints: readonly any[];
  /** Containers this node appears in */
  readonly containers: Array<{ uri: IRI; resolved: string; level: number; position: number }>;
  /** The PGSL instance (for queries) */
  readonly pgsl: PGSLInstance;
  /** Existing affordances (from earlier decorators) */
  readonly existingAffordances: readonly DecoratedAffordance[];
}

/** An affordance with decorator attribution. */
export interface DecoratedAffordance {
  /** Standard affordance fields */
  readonly rel: string;
  readonly title: string;
  readonly method: string;
  readonly href: string;
  readonly fields?: readonly any[];
  /** Decorator attribution */
  readonly decoratorId: string;
  readonly decoratorName: string;
  readonly trustLevel: 'system' | 'expert' | 'community' | 'llm';
  /** Confidence of this suggestion (0-1) */
  readonly confidence: number;
  /** Why this affordance was suggested */
  readonly rationale?: string;
}

/** Structural suggestion — how to reorganize content. */
export interface StructuralSuggestion {
  readonly type: 'nest' | 'reify' | 'group' | 'split' | 'rename' | 'constrain';
  readonly description: string;
  readonly confidence: number;
  readonly decoratorId: string;
  /** The proposed structure (for nest/reify/group) */
  readonly proposed?: string;
  /** Rationale */
  readonly rationale: string;
}

/** What a decorator returns. */
export interface DecoratorResult {
  /** New affordances to add */
  readonly affordances: readonly DecoratedAffordance[];
  /** Structural suggestions (optional) */
  readonly suggestions?: readonly StructuralSuggestion[];
}

// ── Decorator Registry ────────────────────────────────────

/** Registry of all active decorators. */
export interface DecoratorRegistry {
  readonly decorators: readonly AffordanceDecorator[];
}

/** Create an empty decorator registry. */
export function createDecoratorRegistry(): DecoratorRegistry {
  return { decorators: [] };
}

/** Register a new decorator. Inserts in priority order. */
export function registerDecorator(
  registry: DecoratorRegistry,
  decorator: AffordanceDecorator,
): void {
  const decorators = [...(registry as any).decorators, decorator]
    .sort((a, b) => a.priority - b.priority);
  (registry as any).decorators = decorators;
}

/** Remove a decorator by ID. */
export function removeDecorator(
  registry: DecoratorRegistry,
  decoratorId: string,
): void {
  (registry as any).decorators = (registry as any).decorators
    .filter((d: AffordanceDecorator) => d.id !== decoratorId);
}

/**
 * Run all decorators on a node context, in priority order.
 *
 * Each decorator receives the accumulated affordances from all
 * previous decorators via context.existingAffordances. This lets
 * later decorators inspect, supplement, or override earlier ones.
 */
export function decorateNode(
  registry: DecoratorRegistry,
  context: DecoratorContext,
): { affordances: readonly DecoratedAffordance[]; suggestions: readonly StructuralSuggestion[] } {
  let accumulated: DecoratedAffordance[] = [...context.existingAffordances];
  const allSuggestions: StructuralSuggestion[] = [];

  for (const decorator of registry.decorators) {
    const ctx: DecoratorContext = {
      ...context,
      existingAffordances: accumulated,
    };

    const result = decorator.decorate(ctx);
    accumulated = [...accumulated, ...result.affordances];

    if (result.suggestions) {
      allSuggestions.push(...result.suggestions);
    }
  }

  return { affordances: accumulated, suggestions: allSuggestions };
}

// ── Helper: build a DecoratedAffordance ───────────────────

function makeAffordance(
  decorator: { id: string; name: string; trustLevel: 'system' | 'expert' | 'community' | 'llm' },
  rel: string,
  title: string,
  method: string,
  href: string,
  confidence: number,
  rationale?: string,
  fields?: readonly any[],
): DecoratedAffordance {
  return {
    rel, title, method, href, fields,
    decoratorId: decorator.id,
    decoratorName: decorator.name,
    trustLevel: decorator.trustLevel,
    confidence,
    rationale,
  };
}

// ── 1. Core System Decorator ──────────────────────────────

/**
 * Core HATEOAS affordances — always present.
 * These are the basic operations currently hardcoded in the server's
 * node endpoint, now modularized as a decorator.
 */
export const coreSystemDecorator: AffordanceDecorator = {
  id: 'core-system',
  name: 'Core System',
  domain: 'system',
  trustLevel: 'system',
  priority: 0,
  origin: 'built-in',

  decorate(context: DecoratorContext): DecoratorResult {
    const d = { id: this.id, name: this.name, trustLevel: this.trustLevel } as const;
    const base = `/api/node/${encodeURIComponent(context.uri)}`;
    const affordances: DecoratedAffordance[] = [];

    // Add source link
    affordances.push(makeAffordance(
      d, 'add-source', 'Add source link', 'POST', `${base}/sources`,
      1.0, 'Core operation: connect this node as a target of a new source',
      [{ name: 'sourceUri', type: 'text', required: true }],
    ));

    // Add target link
    affordances.push(makeAffordance(
      d, 'add-target', 'Add target link', 'POST', `${base}/targets`,
      1.0, 'Core operation: connect this node as a source pointing to a new target',
      [{ name: 'targetUri', type: 'text', required: true }],
    ));

    // Create atom
    affordances.push(makeAffordance(
      d, 'create-atom', 'Create new atom', 'POST', '/api/ingest',
      1.0, 'Create a new atom and optionally chain it to this node',
      [{ name: 'value', type: 'text', required: true }],
    ));

    // Wrap in group (fragment)
    affordances.push(makeAffordance(
      d, 'wrap-group', 'Wrap in group', 'POST', '/api/ingest',
      1.0, 'Wrap this node with other nodes into a new fragment',
      [{ name: 'items', type: 'text', required: true }],
    ));

    // Chain view
    affordances.push(makeAffordance(
      d, 'chain-view', 'View as chain', 'GET', `${base}/chain`,
      1.0, 'View all chains (syntagmatic contexts) containing this node',
    ));

    // SPARQL query
    affordances.push(makeAffordance(
      d, 'sparql', 'Query with SPARQL', 'POST', '/api/sparql',
      1.0, 'Run a SPARQL query against the lattice',
      [{ name: 'query', type: 'text', required: true }],
    ));

    return { affordances };
  },
};

// ── 2. Ontology Pattern Decorator ─────────────────────────

/**
 * Recognizes common knowledge representation patterns and
 * suggests better structure. This is where the "expert ontologist"
 * behavior lives — detecting anti-patterns and proposing improvements.
 */
export const ontologyPatternDecorator: AffordanceDecorator = {
  id: 'ontology-patterns',
  name: 'Ontology Pattern Advisor',
  domain: 'knowledge-engineering',
  trustLevel: 'expert',
  priority: 10,
  origin: 'built-in',

  decorate(context: DecoratorContext): DecoratorResult {
    const d = { id: this.id, name: this.name, trustLevel: this.trustLevel } as const;
    const affordances: DecoratedAffordance[] = [];
    const suggestions: StructuralSuggestion[] = [];

    // ── Flat chain detection ──
    // If a fragment has >4 items at the same level, suggest nesting/grouping
    if (context.kind === 'Fragment' && context.items && context.items.length > 4) {
      const itemCount = context.items.length;
      suggestions.push({
        type: 'nest',
        description: `This fragment has ${itemCount} items — consider nesting into sub-groups`,
        confidence: Math.min(0.9, 0.5 + (itemCount - 4) * 0.1),
        decoratorId: this.id,
        proposed: `Split into ${Math.ceil(itemCount / 3)} sub-fragments of 2-3 items each`,
        rationale: `Flat chains with >${4} items lose structural expressiveness. ` +
          `Nesting into (subject, predicate, object) triples or (entity, property, value) ` +
          `groups preserves relationships that flat ordering obscures.`,
      });

      affordances.push(makeAffordance(
        d, 'restructure', 'Restructure flat chain', 'POST',
        `/api/node/${encodeURIComponent(context.uri)}/restructure`,
        Math.min(0.9, 0.5 + (itemCount - 4) * 0.1),
        `This flat chain of ${itemCount} items could be nested for better structure`,
        [{ name: 'strategy', type: 'select', options: ['triple-split', 'binary-nest', 'manual'] }],
      ));
    }

    // ── Reification detection ──
    // If multiple containers share the same first item (subject), suggest grouping
    if (context.kind === 'Atom' && context.containers.length > 1) {
      // Check if this atom is the first item in multiple chains
      const asSubject = context.containers.filter(c => c.position === 0);
      if (asSubject.length > 1) {
        suggestions.push({
          type: 'reify',
          description: `"${context.resolved}" is the subject of ${asSubject.length} chains — consider an entity page`,
          confidence: Math.min(0.85, 0.4 + asSubject.length * 0.15),
          decoratorId: this.id,
          proposed: `Create an entity page for "${context.resolved}" grouping all ${asSubject.length} predications`,
          rationale: `Multiple (subject, predicate, object) chains sharing the same subject ` +
            `indicate an implicit entity. Reifying into an entity page makes the entity ` +
            `explicit and enables richer queries.`,
        });
      }
    }

    // ── Triple-only pattern ──
    // If ALL containers are length 3, note that more complex structures are available
    if (context.containers.length > 0) {
      const allTriples = context.containers.every(c => c.level === 3);
      if (allTriples && context.containers.length >= 2) {
        suggestions.push({
          type: 'nest',
          description: 'All chains are length-3 triples — PGSL supports richer structures',
          confidence: 0.3,
          decoratorId: this.id,
          rationale: `Using only (S, P, O) triples is valid but under-utilizes PGSL. ` +
            `Consider nested fragments for complex relationships, or level-4+ ` +
            `structures for contextualizing triples (reification, provenance).`,
        });
      }
    }

    // ── Missing identity chain ──
    // If an atom looks like a short name but has no identity chain
    if (context.kind === 'Atom' && typeof context.value === 'string') {
      const val = context.value;
      const looksLikeName = val.length > 0 && val.length < 50 &&
        !val.startsWith('http') && !val.startsWith('urn:');

      if (looksLikeName) {
        // Check if any container chain is an identity chain
        const hasIdentity = context.containers.some(c => {
          const resolved = c.resolved.toLowerCase();
          return resolved.includes('identity') || resolved.includes('sameas') ||
            resolved.includes('same-as') || resolved.includes('owl:sameas') ||
            resolved.includes('uri') || resolved.includes('iri');
        });

        if (!hasIdentity && context.containers.length > 0) {
          affordances.push(makeAffordance(
            d, 'add-identity', 'Add global identifier', 'POST',
            `/api/node/${encodeURIComponent(context.uri)}/identity`,
            0.6,
            `"${val}" has no global identifier — adding one enables federation and deduplication`,
            [{ name: 'identityUri', type: 'text', required: true, placeholder: 'https://...' }],
          ));
        }
      }
    }

    // ── Missing type chain ──
    // If an atom has no (atom, type, ?) chain, suggest typing
    if (context.kind === 'Atom') {
      const hasType = context.containers.some(c => {
        const resolved = c.resolved.toLowerCase();
        return (resolved.includes('type') || resolved.includes('rdf:type') ||
          resolved.includes('a ')) && c.position === 0;
      });

      if (!hasType && context.containers.length > 0) {
        affordances.push(makeAffordance(
          d, 'add-type', 'Add type annotation', 'POST',
          `/api/node/${encodeURIComponent(context.uri)}/type`,
          0.5,
          `This atom has no type — typing enables schema validation and better queries`,
          [{ name: 'type', type: 'text', required: true, placeholder: 'e.g. Person, Concept, Verb' }],
        ));
      }
    }

    return { affordances, suggestions };
  },
};

// ── 3. xAPI Domain Expert Decorator ───────────────────────

/** xAPI verb vocabulary for pattern recognition. */
const XAPI_VERBS = new Set([
  'completed', 'attempted', 'passed', 'failed', 'answered',
  'experienced', 'interacted', 'launched', 'initialized',
  'terminated', 'suspended', 'resumed', 'scored', 'commented',
  'voided', 'registered', 'unregistered', 'progressed',
  'mastered', 'preferred', 'satisfied', 'waived',
]);

/** xAPI result properties. */
const XAPI_RESULT_PROPS = new Set([
  'score', 'success', 'completion', 'duration', 'response',
  'extensions', 'raw', 'scaled', 'min', 'max',
]);

/** xAPI context properties. */
const XAPI_CONTEXT_PROPS = new Set([
  'instructor', 'team', 'revision', 'platform', 'language',
  'statement', 'registration', 'contextActivities',
]);

/**
 * Recognizes xAPI-related atoms and adds domain-specific affordances.
 * Suggests valid verb completions, result properties, and flags
 * non-standard patterns.
 */
export const xapiDomainDecorator: AffordanceDecorator = {
  id: 'xapi-domain',
  name: 'xAPI Domain Expert',
  domain: 'xapi',
  trustLevel: 'expert',
  priority: 20,
  origin: 'built-in',

  decorate(context: DecoratorContext): DecoratorResult {
    const d = { id: this.id, name: this.name, trustLevel: this.trustLevel } as const;
    const affordances: DecoratedAffordance[] = [];
    const suggestions: StructuralSuggestion[] = [];

    if (context.kind !== 'Atom' || typeof context.value !== 'string') {
      return { affordances };
    }

    const val = context.value.toLowerCase().trim();

    // ── Recognized xAPI verb ──
    if (XAPI_VERBS.has(val)) {
      // Suggest valid verb URI
      affordances.push(makeAffordance(
        d, 'xapi-verb-uri', `Use standard xAPI verb URI for "${context.value}"`, 'POST',
        `/api/node/${encodeURIComponent(context.uri)}/identity`,
        0.85,
        `"${context.value}" is a recognized xAPI verb — link to the ADL verb URI for interoperability`,
        [{
          name: 'verbUri', type: 'text', required: true,
          placeholder: `http://adlnet.gov/expapi/verbs/${val}`,
          default: `http://adlnet.gov/expapi/verbs/${val}`,
        }],
      ));

      // Suggest result properties that often accompany this verb
      const resultSuggestions = getVerbResultSuggestions(val);
      if (resultSuggestions.length > 0) {
        affordances.push(makeAffordance(
          d, 'xapi-add-result', `Add result properties for "${context.value}"`, 'POST',
          `/api/node/${encodeURIComponent(context.uri)}/targets`,
          0.7,
          `xAPI "${context.value}" statements typically include: ${resultSuggestions.join(', ')}`,
          resultSuggestions.map(prop => ({ name: prop, type: 'text', required: false })),
        ));
      }
    }

    // ── Recognized xAPI result property ──
    if (XAPI_RESULT_PROPS.has(val)) {
      affordances.push(makeAffordance(
        d, 'xapi-result-schema', `Validate "${context.value}" as xAPI result property`, 'GET',
        `/api/node/${encodeURIComponent(context.uri)}/validate-xapi`,
        0.75,
        `"${context.value}" is an xAPI result property — validate its value against the xAPI spec`,
      ));
    }

    // ── Looks like an xAPI verb but isn't standard ──
    const verbLikePatterns = /^(did|has|was|can|will|should|would|could|might)[-_]?\w+$/i;
    if (verbLikePatterns.test(val) && !XAPI_VERBS.has(val)) {
      suggestions.push({
        type: 'rename',
        description: `"${context.value}" looks like a verb but isn't a standard xAPI verb`,
        confidence: 0.4,
        decoratorId: this.id,
        proposed: findClosestXapiVerb(val),
        rationale: `Non-standard verbs reduce interoperability. Consider using ` +
          `a recognized ADL verb, or register a custom verb URI in an xAPI profile.`,
      });
    }

    // ── xAPI context property ──
    if (XAPI_CONTEXT_PROPS.has(val)) {
      affordances.push(makeAffordance(
        d, 'xapi-context-schema', `Validate "${context.value}" as xAPI context`, 'GET',
        `/api/node/${encodeURIComponent(context.uri)}/validate-xapi`,
        0.7,
        `"${context.value}" is an xAPI context property`,
      ));
    }

    // ── Ingest xAPI statement affordance ──
    // Present when any xAPI-related atom is detected
    if (XAPI_VERBS.has(val) || XAPI_RESULT_PROPS.has(val) || XAPI_CONTEXT_PROPS.has(val)) {
      const alreadyHasIngest = context.existingAffordances.some(a => a.rel === 'ingest-xapi');
      if (!alreadyHasIngest) {
        affordances.push(makeAffordance(
          d, 'ingest-xapi', 'Ingest xAPI statement', 'POST',
          '/api/xapi/ingest',
          0.8,
          'Ingest a full xAPI statement using the xAPI profile to structure it in PGSL',
          [{ name: 'statement', type: 'json', required: true }],
        ));
      }
    }

    return { affordances, suggestions };
  },
};

/** Suggest result properties that commonly accompany a given xAPI verb. */
function getVerbResultSuggestions(verb: string): string[] {
  switch (verb) {
    case 'completed': return ['completion', 'duration'];
    case 'passed': case 'failed': return ['score', 'success', 'completion'];
    case 'scored': return ['score', 'raw', 'scaled', 'min', 'max'];
    case 'attempted': return ['duration', 'completion'];
    case 'answered': return ['response', 'success', 'score'];
    case 'progressed': return ['extensions'];
    case 'experienced': return ['duration'];
    default: return [];
  }
}

/** Find the closest standard xAPI verb to a given string. */
function findClosestXapiVerb(input: string): string {
  const normalized = input.toLowerCase().replace(/[-_]/g, '');
  let bestMatch = 'experienced';
  let bestScore = 0;

  for (const verb of XAPI_VERBS) {
    const score = computeOverlap(normalized, verb);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = verb;
    }
  }

  return bestMatch;
}

/** Simple character overlap score between two strings. */
function computeOverlap(a: string, b: string): number {
  let shared = 0;
  const bChars = new Set(b.split(''));
  for (const ch of a) {
    if (bChars.has(ch)) shared++;
  }
  return shared / Math.max(a.length, b.length);
}

// ── 4. Coherence Decorator ────────────────────────────────

/**
 * Checks if this node is involved in coherence relationships.
 * Shows overlap info from coherence certificates and warns about
 * unexamined shared atoms.
 */
export const coherenceDecorator: AffordanceDecorator = {
  id: 'coherence',
  name: 'Coherence Verifier',
  domain: 'federation',
  trustLevel: 'system',
  priority: 15,
  origin: 'built-in',

  decorate(context: DecoratorContext): DecoratorResult {
    const d = { id: this.id, name: this.name, trustLevel: this.trustLevel } as const;
    const affordances: DecoratedAffordance[] = [];
    const suggestions: StructuralSuggestion[] = [];

    if (context.kind !== 'Atom' || typeof context.value !== 'string') {
      return { affordances };
    }

    const val = String(context.value);
    const pgsl = context.pgsl;

    // Check the PGSL's provenance to see if this atom might be shared.
    // An atom is "shared" if its provenance agent differs from the default,
    // or if it has been seen in multiple agents' lattices.
    const node = pgsl.nodes.get(context.uri);
    if (!node) return { affordances };

    const defaultAgent = pgsl.defaultProvenance.wasAttributedTo;
    const nodeAgent = node.provenance.wasAttributedTo;
    const isShared = nodeAgent !== defaultAgent;

    if (isShared) {
      // This atom was ingested from a different agent — coherence matters
      affordances.push(makeAffordance(
        d, 'verify-coherence',
        `Verify coherence of "${val}" across agents`,
        'POST', `/api/coherence/verify`,
        0.8,
        `This atom originated from ${nodeAgent} but appears in ${defaultAgent}'s lattice — ` +
        `verifying coherence ensures both agents share the same meaning`,
        [
          { name: 'atomUri', type: 'hidden', value: context.uri },
          { name: 'agentA', type: 'text', required: true, placeholder: defaultAgent },
          { name: 'agentB', type: 'text', required: true, placeholder: nodeAgent },
        ],
      ));

      suggestions.push({
        type: 'constrain',
        description: `Shared atom "${val}" — coherence status unknown`,
        confidence: 0.7,
        decoratorId: this.id,
        rationale: `This atom is shared across agents but coherence has not been examined. ` +
          `Both agents may be using "${val}" with different meanings. ` +
          `Verify coherence to confirm alignment or discover divergence.`,
      });
    }

    // Check if this atom's value appears in containers with coherence-related atoms
    const coherenceRelated = context.containers.some(c => {
      const resolved = c.resolved.toLowerCase();
      return resolved.includes('coherence') || resolved.includes('cert:') ||
        resolved.includes('overlap') || resolved.includes('verified');
    });

    if (coherenceRelated) {
      affordances.push(makeAffordance(
        d, 'view-coherence',
        `View coherence certificates for "${val}"`,
        'GET', `/api/coherence/certificates?atom=${encodeURIComponent(context.uri)}`,
        0.9,
        `This atom appears in coherence certificates — view the overlap and verification status`,
      ));
    }

    return { affordances, suggestions };
  },
};

// ── 5. Persistence Decorator ──────────────────────────────

/**
 * Shows persistence tier info and promotion affordances.
 * Atoms at lower tiers can be promoted for greater durability
 * and discoverability.
 */
export const persistenceDecorator: AffordanceDecorator = {
  id: 'persistence',
  name: 'Persistence Advisor',
  domain: 'infrastructure',
  trustLevel: 'system',
  priority: 15,
  origin: 'built-in',

  decorate(context: DecoratorContext): DecoratorResult {
    const d = { id: this.id, name: this.name, trustLevel: this.trustLevel } as const;
    const affordances: DecoratedAffordance[] = [];

    const node = context.pgsl.nodes.get(context.uri);
    if (!node) return { affordances };

    // Determine current persistence tier from the node's properties.
    // CID presence indicates IPFS (tier 3); signature indicates chain (tier 4);
    // otherwise we assume memory (tier 0).
    const hasCid = !!node.cid;
    const hasSignature = !!node.provenance.signature;

    let currentTier: number;
    let tierName: string;

    if (hasSignature) {
      currentTier = 4;
      tierName = 'chain';
    } else if (hasCid) {
      currentTier = 3;
      tierName = 'ipfs';
    } else {
      // Default assumption: if in a PGSLInstance, at least tier 0 (memory)
      currentTier = 0;
      tierName = 'memory';
    }

    // Suggest promotion based on current tier
    if (currentTier === 0) {
      affordances.push(makeAffordance(
        d, 'promote', 'Save to local storage', 'POST',
        `/api/persistence/promote`,
        0.6,
        `This atom is only in memory (tier 0) — promote to local storage for persistence across restarts`,
        [
          { name: 'uri', type: 'hidden', value: context.uri },
          { name: 'targetTier', type: 'hidden', value: 1 },
        ],
      ));

      affordances.push(makeAffordance(
        d, 'promote', 'Publish to pod', 'POST',
        `/api/persistence/promote`,
        0.5,
        `Publish this atom to your Solid pod for discoverability by authorized agents`,
        [
          { name: 'uri', type: 'hidden', value: context.uri },
          { name: 'targetTier', type: 'hidden', value: 2 },
        ],
      ));
    } else if (currentTier <= 2) {
      affordances.push(makeAffordance(
        d, 'promote', 'Pin to IPFS', 'POST',
        `/api/persistence/promote`,
        0.5,
        `Pin this atom to IPFS for permanent, content-addressed availability (currently at ${tierName})`,
        [
          { name: 'uri', type: 'hidden', value: context.uri },
          { name: 'targetTier', type: 'hidden', value: 3 },
        ],
      ));
    } else if (currentTier === 3) {
      affordances.push(makeAffordance(
        d, 'promote', 'Anchor to blockchain', 'POST',
        `/api/persistence/promote`,
        0.3,
        `Anchor this atom's hash to a blockchain for timestamped proof of existence`,
        [
          { name: 'uri', type: 'hidden', value: context.uri },
          { name: 'targetTier', type: 'hidden', value: 4 },
        ],
      ));
    }

    // Show current tier info
    affordances.push(makeAffordance(
      d, 'persistence-info', `Persistence: ${tierName} (tier ${currentTier})`, 'GET',
      `/api/persistence/status/${encodeURIComponent(context.uri)}`,
      1.0,
      `Current persistence tier: ${currentTier} (${tierName})` +
      (hasCid ? ` — CID: ${node.cid}` : '') +
      (hasSignature ? ` — signed` : ''),
    ));

    return { affordances };
  },
};

// ── 6. LLM Advisor Decorator ──────────────────────────────

/**
 * Generates prompts for LLM analysis without calling an LLM directly.
 * Builds rich context from the node's position in the lattice and
 * adds an affordance that lets the UI or agent invoke the LLM.
 * Also provides basic heuristic suggestions via pattern matching.
 */
export const llmAdvisorDecorator: AffordanceDecorator = {
  id: 'llm-advisor',
  name: 'LLM Advisor',
  domain: 'analysis',
  trustLevel: 'llm',
  priority: 100,
  origin: 'built-in',

  decorate(context: DecoratorContext): DecoratorResult {
    const d = { id: this.id, name: this.name, trustLevel: this.trustLevel } as const;
    const affordances: DecoratedAffordance[] = [];
    const suggestions: StructuralSuggestion[] = [];

    // ── Build the LLM prompt ──
    const lines: string[] = [];
    lines.push(`Analyze this PGSL node and suggest improvements to its knowledge representation.`);
    lines.push(``);
    lines.push(`## Node`);
    lines.push(`- URI: ${context.uri}`);
    lines.push(`- Kind: ${context.kind}`);
    lines.push(`- Level: ${context.level}`);
    lines.push(`- Resolved: "${context.resolved}"`);

    if (context.value !== undefined) {
      lines.push(`- Value: ${JSON.stringify(context.value)}`);
    }

    if (context.items && context.items.length > 0) {
      lines.push(``);
      lines.push(`## Items (${context.items.length})`);
      for (const item of context.items) {
        lines.push(`- [${item.kind} L${item.level}] "${item.resolved}"`);
      }
    }

    if (context.sourceOptions.length > 0) {
      lines.push(``);
      lines.push(`## Source options (what can come before this node)`);
      for (const src of context.sourceOptions) {
        lines.push(`- "${src.resolved}"`);
      }
    }

    if (context.targetOptions.length > 0) {
      lines.push(``);
      lines.push(`## Target options (what can come after this node)`);
      for (const tgt of context.targetOptions) {
        lines.push(`- "${tgt.resolved}"`);
      }
    }

    if (context.containers.length > 0) {
      lines.push(``);
      lines.push(`## Containers (${context.containers.length} chains)`);
      for (const c of context.containers) {
        lines.push(`- [L${c.level} pos ${c.position}] "${c.resolved}"`);
      }
    }

    if (context.constraints.length > 0) {
      lines.push(``);
      lines.push(`## Active constraints: ${context.constraints.length}`);
    }

    // Summarize existing affordances from other decorators
    const existingByDecorator = new Map<string, number>();
    for (const aff of context.existingAffordances) {
      existingByDecorator.set(aff.decoratorName,
        (existingByDecorator.get(aff.decoratorName) ?? 0) + 1);
    }
    if (existingByDecorator.size > 0) {
      lines.push(``);
      lines.push(`## Other decorators' affordances`);
      for (const [name, count] of existingByDecorator) {
        lines.push(`- ${name}: ${count} affordance(s)`);
      }
    }

    lines.push(``);
    lines.push(`## Task`);
    lines.push(`Suggest how to improve the knowledge representation. Consider:`);
    lines.push(`1. Are there missing relationships?`);
    lines.push(`2. Should this be nested differently?`);
    lines.push(`3. Are there implicit types or categories?`);
    lines.push(`4. Would this benefit from federation (linking to external resources)?`);
    lines.push(`5. Are there xAPI or ontology patterns that could be applied?`);

    const prompt = lines.join('\n');

    // ── Add the ask-llm affordance ──
    affordances.push(makeAffordance(
      d, 'ask-llm', 'Ask LLM for analysis', 'POST',
      '/api/llm/analyze',
      0.5,
      'Generate an LLM analysis of this node with full lattice context',
      [
        { name: 'prompt', type: 'textarea', required: true, value: prompt },
        { name: 'model', type: 'text', required: false, placeholder: 'claude-sonnet-4-20250514' },
      ],
    ));

    // ── Basic heuristic suggestions (no LLM needed) ──

    // Orphan detection: atom with no containers
    if (context.kind === 'Atom' && context.containers.length === 0) {
      suggestions.push({
        type: 'constrain',
        description: `Orphan atom "${context.resolved}" — not part of any chain`,
        confidence: 0.6,
        decoratorId: this.id,
        rationale: `This atom exists in the lattice but isn't contained in any fragment. ` +
          `Orphan atoms have no syntagmatic context, which means they have no ` +
          `emergent meaning (meaning = usage). Consider connecting it to a chain.`,
      });
    }

    // Low connectivity: atom in only one container
    if (context.kind === 'Atom' && context.containers.length === 1) {
      suggestions.push({
        type: 'constrain',
        description: `Low connectivity: "${context.resolved}" appears in only 1 chain`,
        confidence: 0.3,
        decoratorId: this.id,
        rationale: `Atoms gain richer meaning through multiple usage contexts. ` +
          `Consider whether "${context.resolved}" should appear in additional chains ` +
          `to establish paradigmatic relationships.`,
      });
    }

    // High connectivity: atom in many containers — likely important
    if (context.kind === 'Atom' && context.containers.length > 5) {
      suggestions.push({
        type: 'reify',
        description: `Hub atom: "${context.resolved}" appears in ${context.containers.length} chains`,
        confidence: 0.4,
        decoratorId: this.id,
        rationale: `Highly connected atoms are conceptual hubs. Consider whether ` +
          `"${context.resolved}" deserves its own entity page, or whether some of ` +
          `these connections represent different senses that should be disambiguated.`,
      });
    }

    return { affordances, suggestions };
  },
};

// ── 7. Federation Decorator ───────────────────────────────

/**
 * When pods are registered, checks if this atom appears on remote pods
 * and adds links to remote nodes. Enables cross-pod discovery.
 */
export const federationDecorator: AffordanceDecorator = {
  id: 'federation',
  name: 'Federation Discovery',
  domain: 'federation',
  trustLevel: 'system',
  priority: 25,
  origin: 'built-in',

  decorate(context: DecoratorContext): DecoratorResult {
    const d = { id: this.id, name: this.name, trustLevel: this.trustLevel } as const;
    const affordances: DecoratedAffordance[] = [];

    // Since federation is inherently async (remote pod queries), this
    // decorator works with locally cached descriptor information.
    // The actual remote discovery happens via the discover-remote affordance.

    // Check if the node has provenance indicating a remote origin
    const node = context.pgsl.nodes.get(context.uri);
    if (!node) return { affordances };

    const origin = node.provenance.wasAttributedTo;
    const isRemote = origin.startsWith('http://') || origin.startsWith('https://');

    if (isRemote) {
      // This node came from a remote pod — add a link back
      affordances.push(makeAffordance(
        d, 'view-remote', `View on origin pod`, 'GET',
        `${origin}/api/node/${encodeURIComponent(context.uri)}`,
        0.9,
        `This node originated from ${origin} — view the authoritative version`,
      ));
    }

    // Always offer remote discovery
    affordances.push(makeAffordance(
      d, 'discover-remote',
      'Search for this atom across federated pods', 'POST',
      '/api/federation/discover',
      0.5,
      `Search registered pods for atoms matching "${context.resolved}"`,
      [
        { name: 'query', type: 'hidden', value: context.resolved },
        { name: 'atomUri', type: 'hidden', value: context.uri },
      ],
    ));

    // If the node has a CID, it's content-addressed and can be verified remotely
    if (node.cid) {
      affordances.push(makeAffordance(
        d, 'verify-remote', 'Verify content on IPFS', 'GET',
        `/api/federation/verify-cid/${node.cid}`,
        0.8,
        `This node has CID ${node.cid} — verify the content matches across the network`,
      ));
    }

    // Suggest federation for atoms that appear to be shared concepts
    if (context.kind === 'Atom' && typeof context.value === 'string') {
      const val = context.value;
      // Heuristic: short, capitalized words are likely shared concepts
      const looksLikeEntity = val.length > 1 && val.length < 30 &&
        val[0] === val[0]!.toUpperCase() && !val.includes(' ');

      if (looksLikeEntity && !isRemote) {
        affordances.push(makeAffordance(
          d, 'federate', `Publish "${val}" to pod`, 'POST',
          '/api/federation/publish',
          0.4,
          `"${val}" looks like a named entity — publishing to your pod makes it discoverable`,
          [
            { name: 'atomUri', type: 'hidden', value: context.uri },
            { name: 'podUrl', type: 'text', required: true, placeholder: 'https://pod.example.org/' },
          ],
        ));
      }
    }

    return { affordances };
  },
};

// ── Default Registry ──────────────────────────────────────

/**
 * Create a registry pre-loaded with all built-in decorators.
 * This is the standard configuration — all seven decorators active.
 */
export function createDefaultRegistry(): DecoratorRegistry {
  const registry = createDecoratorRegistry();
  registerDecorator(registry, coreSystemDecorator);
  registerDecorator(registry, ontologyPatternDecorator);
  registerDecorator(registry, coherenceDecorator);
  registerDecorator(registry, persistenceDecorator);
  registerDecorator(registry, xapiDomainDecorator);
  registerDecorator(registry, federationDecorator);
  registerDecorator(registry, llmAdvisorDecorator);
  return registry;
}
