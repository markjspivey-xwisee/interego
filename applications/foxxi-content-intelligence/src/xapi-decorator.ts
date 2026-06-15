/**
 * xapi-decorator.ts — Foxxi-vertical xAPI domain expert (affordance decorator).
 *
 * xAPI is a FOXXI-VERTICAL concern, NOT an Interego/PGSL foundation primitive.
 * This decorator therefore lives in the vertical and is registered onto the
 * substrate's decorator chain from here — composing the foundation's framework
 * (AffordanceDecorator + makeAffordance from @interego/pgsl) without baking a
 * learning-domain vocabulary (xAPI verbs, ADL verb URIs, result/context props)
 * into PGSL. It used to ship as a built-in inside @interego/pgsl; it was lifted
 * out so the foundation stays domain-neutral and Foxxi owns its own shapes.
 *
 * Register it where the chain is built, e.g.:
 *   import { createDefaultRegistry, registerDecorator } from '@interego/pgsl';
 *   import { xapiDomainDecorator } from './xapi-decorator.js';
 *   const registry = createDefaultRegistry();
 *   registerDecorator(registry, xapiDomainDecorator);
 */
import { makeAffordance } from '@interego/pgsl';
import type {
  AffordanceDecorator,
  DecoratorContext,
  DecoratorResult,
  DecoratedAffordance,
  StructuralSuggestion,
} from '@interego/pgsl';

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
  origin: 'foxxi-vertical',

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
