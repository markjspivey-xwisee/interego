/**
 * Emergent, agent-driven STANDARDS EXTENSION — the capability the agp layer
 * affords by composing Foxxi's standards.
 *
 * An agent extends a standard IN THE FLOW OF WORK: it authors an xAPI context
 * extension, an xAPI Profile fragment, or an IEEE-LER / ADL-TLA term, and gets
 * back (a) a real, conformant, self-descriptive artifact (built with Foxxi's own
 * buildProfileDoc / served LER+TLA namespaces — composition, not reimplementation),
 * (b) a iep:StandardsExtension descriptor it can publish so OTHER agents discover +
 * dereference + reuse it (distributed), and (c) in-flow performance support +
 * HATEOAS next-steps (what this builds, how to learn it, how to teach it).
 *
 * This is what re-integrates the agp layer with Foxxi: Foxxi owns the spec; agp
 * affords agents the learnable/teachable capability to extend it.
 */
import { buildProfileDoc, FOXXI_PROFILE_PARTS } from '../../foxxi-content-intelligence/src/xapi-profile.js';
import { LER_NS, TLA_NS } from '../../foxxi-content-intelligence/src/ler-tla-vocab.js';
import { AGP_NS } from './ontology.js';
import { AGP_PROFILE_ID } from './xapi-profile.js';
import { withGuidance, type AffordanceGuidance } from '../../_shared/guided-affordance/index.js';

export type ExtensionKind = 'XapiContextExtension' | 'XapiProfileFragment' | 'LerTerm' | 'TlaTerm';

export interface ProposeExtensionInput {
  kind: ExtensionKind;
  /** Local slug for the new term, e.g. 'collaborationDepth'. */
  name: string;
  /** Human-readable definition. */
  definition: string;
  /** Display label (defaults to name). */
  label?: string;
  /** The standard being extended (IRI). Defaults per kind. */
  extendsStandard?: string;
  /** The authoring agent's namespace base (with trailing #). Defaults to agp's. */
  namespace?: string;
  /** Optional agp:Capability IRI this extension builds/demonstrates. */
  buildsCapability?: string;
  /** XapiProfileFragment: the agent's own concepts/templates/patterns. */
  concepts?: Array<Record<string, unknown>>;
  templates?: Array<Record<string, unknown>>;
  patterns?: Array<Record<string, unknown>>;
  /** LerTerm/TlaTerm: the superclass IRI to subclass (defaults to the layer root). */
  subClassOf?: string;
}

const slug = (s: string): string => s.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const ttlEscape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const DEFAULT_STANDARD: Record<ExtensionKind, string> = {
  XapiContextExtension: AGP_PROFILE_ID,
  XapiProfileFragment: AGP_PROFILE_ID,
  LerTerm: LER_NS,
  TlaTerm: TLA_NS,
};

export interface ProposedExtension {
  ok: true;
  kind: ExtensionKind;
  /** IRI of the new term/extension. */
  iri: string;
  extendsStandard: string;
  /** A self-descriptive iep:StandardsExtension descriptor (publishable, distributed). */
  descriptor: Record<string, unknown>;
  /** The conformant artifact: an xAPI Profile doc (xAPI kinds) or a Turtle term (LER/TLA kinds). */
  artifact: Record<string, unknown> | { mediaType: 'text/turtle'; turtle: string };
  _guidance: AffordanceGuidance;
}

/** Guidance for the extend-standards capability — performance support in the flow. */
export const EXTEND_STANDARDS_GUIDANCE: AffordanceGuidance = {
  summary: 'Extend a standard (xAPI / IEEE-LER / ADL-TLA) with your own term, context extension, or profile fragment — in the flow of work.',
  whenToUse: 'When the vocabulary you need to record performance does not exist yet: a new context extension, a richer profile template/pattern, or a domain competency term. Compose; never fork the spec.',
  teaches: `${AGP_NS}StandardsExtension`,
  requires: ['Know which standard you are extending (xAPI Profile / IEEE-LER / ADL-TLA) and the superclass/host concept you compose onto.'],
  howToLearn: 'Dereference /ns/agp#StandardsExtension for the model; the returned artifact is a worked, conformant example you can adapt. Then teach it: frame it as an ac:TeachingPackage so other agents acquire the capability (agent-teaching loop).',
  nextAffordances: [
    { action: 'urn:iep:action:agp:actualize', rel: 'then', why: 'Record performance that uses your new extension (capability x situation -> performance).' },
    { action: 'urn:iep:action:foxxi:review-record', rel: 'verify', why: 'See your extended vocabulary flowing through your learner record.' },
  ],
};

/** Author a standards extension. Pure: returns the artifact + a publishable,
 *  self-descriptive descriptor + in-flow guidance. Composes Foxxi's standards. */
export function proposeStandardsExtension(input: ProposeExtensionInput): ProposedExtension {
  if (!input?.name?.trim()) throw new Error('name is required');
  if (!input?.definition?.trim()) throw new Error('definition is required');
  const kind = input.kind;
  if (!(kind in DEFAULT_STANDARD)) throw new Error(`unknown extension kind: ${kind}`);
  const ns = input.namespace ?? AGP_NS;
  const local = slug(input.name);
  const iri = `${ns}${local}`;
  const label = input.label ?? input.name;
  const extendsStandard = input.extendsStandard ?? DEFAULT_STANDARD[kind];

  let artifact: ProposedExtension['artifact'];
  if (kind === 'XapiContextExtension') {
    // A new xAPI ContextExtension, delivered as a complete (dereferenceable) profile
    // fragment so it is immediately valid + composable with the host profile.
    const concept = { id: iri, type: 'ContextExtension', prefLabel: { en: label }, definition: { en: input.definition } };
    artifact = buildProfileDoc({
      id: `${iri}/profile`,
      prefLabel: { en: `${label} — xAPI extension fragment` },
      definition: { en: `Agent-authored xAPI context extension composing ${extendsStandard}.` },
      author: { type: 'Agent', name: ns },
      generatedAt: new Date().toISOString(),
      concepts: [concept],
      templates: [],
      patterns: [],
    });
  } else if (kind === 'XapiProfileFragment') {
    // A full profile fragment: the agent's concepts/templates/patterns, reusing the
    // shared `performed` verb where a template needs it.
    const performed = FOXXI_PROFILE_PARTS.verbs.find(v => v.id.endsWith('#performed'))!;
    artifact = buildProfileDoc({
      id: `${iri}/profile`,
      prefLabel: { en: `${label} — xAPI Profile fragment` },
      definition: { en: input.definition },
      author: { type: 'Agent', name: ns },
      generatedAt: new Date().toISOString(),
      concepts: [{ ...performed, type: 'Verb' }, ...(input.concepts ?? [])],
      templates: input.templates ?? [],
      patterns: input.patterns ?? [],
    });
  } else {
    // LER / TLA term: a Turtle class composed onto the served semantic layer.
    const superClass = input.subClassOf ?? (kind === 'LerTerm' ? `${LER_NS}EnterpriseLearnerRecord` : `${TLA_NS}TLA`);
    const turtle = [
      `@prefix owl:  <http://www.w3.org/2002/07/owl#> .`,
      `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
      `@prefix iep:   <https://markjspivey-xwisee.github.io/interego/ns/iep#> .`,
      ``,
      `<${iri}> a owl:Class ;`,
      `    rdfs:subClassOf <${superClass}> ;`,
      `    rdfs:label "${ttlEscape(label)}" ;`,
      `    rdfs:comment "${ttlEscape(input.definition)}" ;`,
      `    iep:constructedFrom <${superClass}> .`,
      ``,
    ].join('\n');
    artifact = { mediaType: 'text/turtle', turtle };
  }

  const descriptor: Record<string, unknown> = {
    '@id': iri,
    '@type': ['iep:ContextDescriptor', 'agp:StandardsExtension'],
    'conformsTo': `${AGP_NS.replace('#', '')}/shapes#StandardsExtensionShape`,
    [`${AGP_NS}extensionKind`]: { '@id': `${AGP_NS}${kind}` },
    [`${AGP_NS}extendsStandard`]: extendsStandard,
    'rdfs:label': label,
    'rdfs:comment': input.definition,
    ...(input.buildsCapability ? { [`${AGP_NS}buildsCapability`]: { '@id': input.buildsCapability } } : {}),
  };

  return withGuidance({
    ok: true as const,
    kind,
    iri,
    extendsStandard,
    descriptor,
    artifact,
  }, EXTEND_STANDARDS_GUIDANCE);
}
