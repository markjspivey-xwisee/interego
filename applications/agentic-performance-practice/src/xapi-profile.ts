/**
 * The agentic-performance-practice vertical's OWN xAPI Profile (ADL 2017).
 *
 * agp: COMPOSES Foxxi's standards layer rather than reimplementing it: it builds
 * its profile with Foxxi's now-parameterized buildProfileDoc (Stage-2 seam 3) and
 * REUSES the single domain-agnostic `performed` verb (WHAT was performed is carried
 * by the object's conformsTo, never a domain verb). On top, it adds agp-specific
 * context extensions + an actualized-affordance statement template + a performance-
 * stream pattern, so a performance recorded in Foxxi's xAPI 2.0 LRS carries the
 * agp model (capability, actualized affordance, regime, situation).
 *
 * Served dereferenceably by the agp bridge at GET /xapi/profile.
 */
import { buildProfileDoc, FOXXI_PROFILE_PARTS } from '../../foxxi-content-intelligence/src/xapi-profile.js';
import { AGP_NS } from './ontology.js';

/** The Profile's identity IRI (dereferences to itself when served). */
export const AGP_PROFILE_ID = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/xapi/profile';

/** The shared, domain-agnostic performance verb, reused verbatim from Foxxi. */
const PERFORMED = FOXXI_PROFILE_PARTS.verbs.find(v => v.id.endsWith('#performed'));
if (!PERFORMED) throw new Error('agp xapi-profile: could not locate the shared `performed` verb in FOXXI_PROFILE_PARTS');

const ext = (name: string, label: string, definition: string) =>
  ({ id: `${AGP_NS}${name}`, prefLabel: { en: label }, definition: { en: definition } });
const activity = (name: string, label: string, definition: string) =>
  ({ id: `${AGP_NS}${name}`, prefLabel: { en: label }, definition: { en: definition } });

const extensions = [
  ext('capability', 'capability', 'IRI of the agp:Capability the performer engaged in this actualization.'),
  ext('actualizedAffordance', 'actualizedAffordance', 'IRI of the agp:PerformanceAffordance the actualization realized.'),
  ext('regime', 'regime', 'The agp:WorkRegime of the situation (Evident/Knowable/Emergent/Turbulent).'),
  ext('regimeSource', 'regimeSource', 'Provenance of the regime placement (derived/asserted/default/unclassified).'),
  ext('situationId', 'situationId', 'IRI of the agp:PerformanceSituation this performance occurred in.'),
];

const activityTypes = [
  activity('PerformanceSituation', 'Performance Situation', 'The unit — a situation in which a performer performs, contextualized by its work regime.'),
  activity('Capability', 'Capability', 'A productive capability composed of skills + tools + knowledge.'),
  activity('PerformanceAffordance', 'Performance Affordance', 'An action-possibility a situation offers a performer given capability (ecological affordance; not a cg:Affordance).'),
  activity('Actualization', 'Actualization', 'Capability x Situation x Affordance -> Performance.'),
  activity('Performance', 'Performance', 'The realized performance an actualization yields.'),
];

const templates = [
  {
    id: `${AGP_PROFILE_ID}/templates/actualized-affordance`,
    prefLabel: { en: 'actualized-affordance' },
    definition: { en: 'An actualization: a capability engaged a situation\'s affordance, yielding performance. Verb is the shared `performed`; the agp context extensions name the capability, the actualized affordance, the regime, and the situation. WHAT was performed is the object\'s conformsTo, never a domain verb.' },
    verb: PERFORMED.id,
    rules: [
      { location: `context.extensions["${AGP_NS}capability"]`, presence: 'included' },
      { location: `context.extensions["${AGP_NS}actualizedAffordance"]`, presence: 'included' },
      { location: `context.extensions["${AGP_NS}regime"]`, presence: 'recommended' },
      { location: `context.extensions["${AGP_NS}situationId"]`, presence: 'recommended' },
    ],
  },
];

const patterns = [
  {
    id: `${AGP_PROFILE_ID}/patterns/agp-performance-stream`,
    prefLabel: { en: 'agp-performance-stream' },
    definition: { en: 'A performer\'s stream of actualized affordances — capabilities meeting situations to yield performance. Domain-agnostic: holds for any vertical whose work this measures.' },
    primary: true,
    oneOrMore: `${AGP_PROFILE_ID}/templates/actualized-affordance`,
  },
];

/** Building blocks, exported for reuse + verification. */
export const AGP_PROFILE_PARTS = { verbs: [PERFORMED], activityTypes, extensions, templates, patterns } as const;

/** Build the agp xAPI Profile JSON-LD document. Pure. */
export function buildAgpProfileDoc(versionInfo: { generatedAt: string }): Record<string, unknown> {
  return buildProfileDoc({
    id: AGP_PROFILE_ID,
    prefLabel: { en: 'Agentic Performance Practice — xAPI Profile' },
    definition: {
      en: 'xAPI Profile (ADL Profile Spec 2017) for the agentic-performance-practice vertical. COMPOSES Foxxi\'s standards layer: reuses the single domain-agnostic `performed` verb and adds agp-specific context extensions (capability, actualizedAffordance, regime, regimeSource, situationId) + an actualized-affordance statement template + a performance-stream pattern. Performances are recorded in Foxxi\'s xAPI 2.0 LRS; this profile describes their agp-specific shape.',
    },
    seeAlso: 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp',
    author: { type: 'Organization', name: 'agentic-performance-practice (demo)' },
    generatedAt: versionInfo.generatedAt,
    concepts: [
      { ...PERFORMED, type: 'Verb' },
      ...activityTypes.map(a => ({ ...a, type: 'ActivityType' })),
      ...extensions.map(e => ({ ...e, type: 'ContextExtension' })),
    ],
    templates,
    patterns,
  });
}
