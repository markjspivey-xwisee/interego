/**
 * Dereferenceable serving of the agp: ontology.
 *
 * The CANONICAL source is ontology/agp.ttl (OWL) + ontology/agp-shapes.ttl
 * (SHACL). This module serves them as dereferenceable linked data with content
 * negotiation (Turtle is the full source; JSON-LD is a faithful summary
 * projection built from the term index below) plus per-term resolution and a
 * SHACL shape endpoint — the pattern the survey found MISSING in sibling
 * verticals (adp.ttl is authored but never served). Wire via the bridge's
 * middleware hook (see bridge/server.ts).
 */
import { readFileSync } from 'node:fs';

export const AGP_NS = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';
export const AGP_ONTOLOGY_IRI = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp';
export const AGP_SHAPES_NS = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp/shapes#';

const ADP_NS = 'https://markjspivey-xwisee.github.io/interego/applications/agent-development-practice/adp#';
const AC_NS = 'https://markjspivey-xwisee.github.io/interego/applications/agent-collective/ac#';
const CG_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const AMTA_NS = 'https://markjspivey-xwisee.github.io/interego/ns/amta#';

/** Read a canonical Turtle artifact from the sibling ontology/ directory.
 *  Resolves relative to this module first (tsx/source run), then the CWD
 *  (built/deployed run) so serving works in either mode. */
function readOntologyFile(file: string): string {
  const candidates = [
    new URL(`../ontology/${file}`, import.meta.url),
    new URL(`../../ontology/${file}`, import.meta.url),
  ];
  for (const url of candidates) {
    try { return readFileSync(url, 'utf8'); } catch { /* try next */ }
  }
  // Last resort: CWD-relative (covers `node dist/server.js` from bridge/).
  for (const rel of [`ontology/${file}`, `../ontology/${file}`, `../../ontology/${file}`]) {
    try { return readFileSync(rel, 'utf8'); } catch { /* try next */ }
  }
  throw new Error(`agp ontology artifact not found: ${file}`);
}

export const readOntologyTurtle = (): string => readOntologyFile('agp.ttl');
export const readShapesTurtle = (): string => readOntologyFile('agp-shapes.ttl');

type TermKind = 'Class' | 'ObjectProperty' | 'DatatypeProperty' | 'Individual';
interface AgpTerm {
  name: string;
  kind: TermKind;
  label: string;
  comment?: string;
  /** For Individual: the class it instantiates (local agp name or full IRI). */
  instanceOf?: string;
  subClassOf?: string;
  range?: string;
  domain?: string;
  closeMatch?: string;
  related?: string;
}

/** Summary term index — drives the JSON-LD projection + per-term resolution.
 *  The Turtle file is the complete source (ranges, domains, constructedFrom,
 *  every individual); this index is the dereferenceable JSON-LD view. */
export const AGP_TERMS: ReadonlyArray<AgpTerm> = [
  { name: 'PerformanceSituation', kind: 'Class', label: 'Performance Situation', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'The UNIT of the theory — contextualized first by its work regime, never assumed to be a gap.' },
  { name: 'Performer', kind: 'Class', label: 'Performer', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'A human, agent, or team that performs in a situation. Actor-agnostic.' },
  { name: 'PerformanceDirection', kind: 'Class', label: 'Performance Direction', comment: 'Enumerated H2H/H2A/A2H/A2A direction of a performance relationship.' },
  { name: 'WorkRegime', kind: 'Class', label: 'Work Regime', comment: 'Enumerated complexity regime; read first, routes the method. Composes adp:CynefinDomain.' },
  { name: 'PerformanceMethod', kind: 'Class', label: 'Performance Method', comment: 'Regime-routed method. Gap-analysis is Knowable-only.' },
  { name: 'Skill', kind: 'Class', label: 'Skill', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'A constituent of a capability.' },
  { name: 'Tool', kind: 'Class', label: 'Tool', subClassOf: `${CG_NS}ContextDescriptor`, closeMatch: `${AC_NS}AgentTool`, comment: 'An instrument a performer wields; a constituent of a capability.' },
  { name: 'Knowledge', kind: 'Class', label: 'Knowledge', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'Knowledge a performer brings; classified by codifiability.' },
  { name: 'KnowledgeComponentKind', kind: 'Class', label: 'Knowledge Component Kind', comment: 'Enumerated codifiability class (Recorded/Trained/Judged/Lived/Innate).' },
  { name: 'Capability', kind: 'Class', label: 'Capability (composed, productive)', subClassOf: `${CG_NS}ContextDescriptor`, related: `${ADP_NS}Capability`, comment: 'Composed of skills + tools + knowledge; what a performer brings and what an affordance requires.' },
  { name: 'PerformanceAffordance', kind: 'Class', label: 'Performance Affordance (ecological)', subClassOf: `${CG_NS}ContextDescriptor`, related: `${CG_NS}Affordance`, comment: 'An action-possibility a situation offers given capability. ECOLOGICAL affordance — DISTINCT from the L0 iep:Affordance (REST/HATEOAS). MUST NOT be conflated.' },
  { name: 'Actualization', kind: 'Class', label: 'Actualization', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'The productive join: Capability x Situation x PerformanceAffordance -> Performance.' },
  { name: 'Performance', kind: 'Class', label: 'Performance', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'The realized performance; projected lossily to one xAPI performed statement via recordedAs.' },
  { name: 'Diagnosis', kind: 'Class', label: 'Diagnosis', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'Regime-aware reading of a situation, with regime-source provenance.' },
  { name: 'PerformanceFactor', kind: 'Class', label: 'Performance Factor', comment: 'Six-factor cause model (Knowable regime only).' },
  { name: 'InterventionPlan', kind: 'Class', label: 'Intervention Plan', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'Regime-appropriate plan; instruction warranted only for a Knowable knowledge/skill cause.' },
  { name: 'Intervention', kind: 'Class', label: 'Intervention', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'A single intervention within a plan.' },
  { name: 'InterventionEvaluation', kind: 'Class', label: 'Intervention Evaluation', subClassOf: `${AMTA_NS}Attestation`, comment: 'Four-level evaluation attesting whether an intervention worked.' },
  { name: 'CalibrationProfile', kind: 'Class', label: 'Calibration Profile', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'Reflexive per-(regime x cause x intervention) track record; only derived Knowable regimes accrue authority.' },
  // Enum individuals
  { name: 'Evident', kind: 'Individual', instanceOf: 'WorkRegime', label: 'Evident regime', closeMatch: `${ADP_NS}Clear` },
  { name: 'Knowable', kind: 'Individual', instanceOf: 'WorkRegime', label: 'Knowable regime', closeMatch: `${ADP_NS}Complicated` },
  { name: 'Emergent', kind: 'Individual', instanceOf: 'WorkRegime', label: 'Emergent regime', closeMatch: `${ADP_NS}Complex` },
  { name: 'Turbulent', kind: 'Individual', instanceOf: 'WorkRegime', label: 'Turbulent regime', closeMatch: `${ADP_NS}Chaotic` },
  { name: 'H2H', kind: 'Individual', instanceOf: 'PerformanceDirection', label: 'Human to Human' },
  { name: 'H2A', kind: 'Individual', instanceOf: 'PerformanceDirection', label: 'Human to Agent' },
  { name: 'A2H', kind: 'Individual', instanceOf: 'PerformanceDirection', label: 'Agent to Human' },
  { name: 'A2A', kind: 'Individual', instanceOf: 'PerformanceDirection', label: 'Agent to Agent' },
  { name: 'ApplyPractice', kind: 'Individual', instanceOf: 'PerformanceMethod', label: 'Apply practice (Evident)' },
  { name: 'GapAnalysis', kind: 'Individual', instanceOf: 'PerformanceMethod', label: 'Gap analysis (Knowable ONLY)' },
  { name: 'DispositionalRead', kind: 'Individual', instanceOf: 'PerformanceMethod', label: 'Dispositional read + probes (Emergent)' },
  { name: 'StabiliseFirst', kind: 'Individual', instanceOf: 'PerformanceMethod', label: 'Stabilise first (Turbulent)' },
  { name: 'ClassifyFirst', kind: 'Individual', instanceOf: 'PerformanceMethod', label: 'Classify first (unclassified)' },
  { name: 'Recorded', kind: 'Individual', instanceOf: 'KnowledgeComponentKind', label: 'Recorded (fully codifiable)' },
  { name: 'Trained', kind: 'Individual', instanceOf: 'KnowledgeComponentKind', label: 'Trained (codifiable into instruction)' },
  { name: 'Judged', kind: 'Individual', instanceOf: 'KnowledgeComponentKind', label: 'Judged (partly codifiable)' },
  { name: 'Lived', kind: 'Individual', instanceOf: 'KnowledgeComponentKind', label: 'Lived (tacit)' },
  { name: 'Innate', kind: 'Individual', instanceOf: 'KnowledgeComponentKind', label: 'Innate (not codifiable)' },
  { name: 'Information', kind: 'Individual', instanceOf: 'PerformanceFactor', label: 'Information (environmental)' },
  { name: 'Instrumentation', kind: 'Individual', instanceOf: 'PerformanceFactor', label: 'Instrumentation (environmental)' },
  { name: 'Incentives', kind: 'Individual', instanceOf: 'PerformanceFactor', label: 'Incentives (environmental)' },
  { name: 'KnowledgeSkill', kind: 'Individual', instanceOf: 'PerformanceFactor', label: 'Knowledge & Skill (individual)' },
  { name: 'Capacity', kind: 'Individual', instanceOf: 'PerformanceFactor', label: 'Capacity (individual)' },
  { name: 'Motives', kind: 'Individual', instanceOf: 'PerformanceFactor', label: 'Motives (individual)' },
  // Key properties (the productive-join + composition spine)
  { name: 'regime', kind: 'ObjectProperty', label: 'regime', domain: 'PerformanceSituation', range: 'WorkRegime' },
  { name: 'method', kind: 'ObjectProperty', label: 'method', range: 'PerformanceMethod' },
  { name: 'composedOf', kind: 'ObjectProperty', label: 'composed of', domain: 'Capability', range: `${CG_NS}ContextDescriptor` },
  { name: 'affords', kind: 'ObjectProperty', label: 'affords', domain: 'PerformanceSituation', range: 'PerformanceAffordance' },
  { name: 'requiresCapability', kind: 'ObjectProperty', label: 'requires capability', domain: 'PerformanceAffordance', range: 'Capability' },
  { name: 'engages', kind: 'ObjectProperty', label: 'engages', domain: 'Actualization', range: 'Capability' },
  { name: 'inSituation', kind: 'ObjectProperty', label: 'in situation', domain: 'Actualization', range: 'PerformanceSituation' },
  { name: 'actualizes', kind: 'ObjectProperty', label: 'actualizes', domain: 'Actualization', range: 'PerformanceAffordance' },
  { name: 'yields', kind: 'ObjectProperty', label: 'yields', domain: 'Actualization', range: 'Performance' },
  { name: 'recordedAs', kind: 'ObjectProperty', label: 'recorded as', domain: 'Performance', range: `${CG_NS}ContextDescriptor` },
  { name: 'regimeSource', kind: 'DatatypeProperty', label: 'regime source', comment: 'derived|asserted|default|unclassified — only derived may gap-analyse or calibrate.' },
  // Emergent standards-extension capability + in-flow performance support.
  { name: 'StandardsExtension', kind: 'Class', label: 'Standards Extension', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'An agent-authored extension to a standard (xAPI extension / profile fragment / IEEE-LER / ADL-TLA term); self-descriptive + distributed; authoring it is a learnable, teachable capability.' },
  { name: 'ExtensionKind', kind: 'Class', label: 'Extension Kind', comment: 'Enumerated kind of standards extension.' },
  { name: 'PerformanceSupport', kind: 'Class', label: 'Performance Support', subClassOf: `${CG_NS}ContextDescriptor`, comment: 'In-the-flow, self-descriptive guidance attached to an affordance/response (what/when/teaches/requires/howToLearn/next).' },
  { name: 'XapiContextExtension', kind: 'Individual', instanceOf: 'ExtensionKind', label: 'xAPI context extension' },
  { name: 'XapiProfileFragment', kind: 'Individual', instanceOf: 'ExtensionKind', label: 'xAPI Profile fragment' },
  { name: 'LerTerm', kind: 'Individual', instanceOf: 'ExtensionKind', label: 'IEEE-LER term extension' },
  { name: 'TlaTerm', kind: 'Individual', instanceOf: 'ExtensionKind', label: 'ADL-TLA term extension' },
  { name: 'extensionKind', kind: 'ObjectProperty', label: 'extension kind', domain: 'StandardsExtension', range: 'ExtensionKind' },
  { name: 'extendsStandard', kind: 'DatatypeProperty', label: 'extends standard', comment: 'IRI of the standard being extended (xAPI Profile / IEEE-LER / ADL-TLA).' },
  { name: 'buildsCapability', kind: 'ObjectProperty', label: 'builds capability', domain: 'StandardsExtension', range: 'Capability', comment: 'The agp:Capability authoring/using this builds — makes an affordance a learnable skill.' },
];

const JSONLD_CONTEXT = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dct: 'http://purl.org/dc/terms/',
  iep: CG_NS,
  adp: ADP_NS,
  ac: AC_NS,
  agp: AGP_NS,
};

const kindToType = (k: TermKind): string =>
  k === 'Class' ? 'owl:Class'
    : k === 'ObjectProperty' ? 'owl:ObjectProperty'
      : k === 'DatatypeProperty' ? 'owl:DatatypeProperty'
        : 'owl:NamedIndividual';

const refIri = (v: string): string => v.startsWith('http') ? v : `${AGP_NS}${v}`;

function termNode(t: AgpTerm): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@id': `${AGP_NS}${t.name}`,
    '@type': t.kind === 'Individual' && t.instanceOf ? [kindToType(t.kind), refIri(t.instanceOf)] : kindToType(t.kind),
    'rdfs:label': t.label,
    'rdfs:isDefinedBy': { '@id': AGP_ONTOLOGY_IRI },
  };
  if (t.comment) node['rdfs:comment'] = t.comment;
  if (t.subClassOf) node['rdfs:subClassOf'] = { '@id': t.subClassOf };
  if (t.domain) node['rdfs:domain'] = { '@id': refIri(t.domain) };
  if (t.range) node['rdfs:range'] = { '@id': refIri(t.range) };
  if (t.closeMatch) node['skos:closeMatch'] = { '@id': t.closeMatch };
  if (t.related) node['skos:related'] = { '@id': t.related };
  return node;
}

export function renderOntologyJsonLd(): Record<string, unknown> {
  return {
    '@context': JSONLD_CONTEXT,
    '@graph': [
      {
        '@id': AGP_ONTOLOGY_IRI,
        '@type': 'owl:Ontology',
        'dct:title': 'agp: — Agentic Performance Practice (vertical application)',
        'rdfs:comment': 'Non-normative vertical ontology. JSON-LD is a summary view; the complete OWL source is the Turtle representation, and SHACL shapes are at /ns/agp/shapes.',
      },
      ...AGP_TERMS.map(termNode),
    ],
  };
}

export function renderTermJsonLd(name: string): Record<string, unknown> | null {
  const t = AGP_TERMS.find(x => x.name === name);
  if (!t) return null;
  return {
    '@context': JSONLD_CONTEXT,
    ...termNode(t),
    '_links': {
      self: `${AGP_NS}${t.name}`,
      ontology: AGP_ONTOLOGY_IRI,
      shapes: `${AGP_NS.replace('#', '')}/shapes`,
    },
  };
}

export const termNames = (): string[] => AGP_TERMS.map(t => t.name);
