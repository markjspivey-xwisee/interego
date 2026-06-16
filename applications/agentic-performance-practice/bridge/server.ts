/**
 * agentic-performance-practice bridge — named-MCP-tool + HTTP surface over the
 * agp: vertical, PLUS dereferenceable serving of the agp: ontology.
 *
 * Generic agents discover via the cg:Affordance manifest at GET /affordances;
 * this bridge is the named-MCP ergonomic. It additionally serves the ontology
 * as linked data at GET /ns/agp (content-negotiated Turtle / JSON-LD), per-term
 * at GET /ns/agp/term/:name, and the SHACL shapes at GET /ns/agp/shapes — the
 * author-AND-serve pattern the survey found missing in sibling verticals.
 *
 * Stage 1 (this scaffold): ontology + discovery surface are fully live; the
 * capability HANDLERS are pending-Stage-2 stubs (they validate + echo inputs
 * but do not yet publish), because the publishers + regime engine arrive when
 * the engine is moved out of Foxxi in Stage 2. The stubs return an explicit
 * `pending: 'stage-2'` marker — never a fabricated success.
 *
 * Run:
 *   PORT=6030 BRIDGE_DEPLOYMENT_URL=https://agp.example/ \
 *     AGP_DEFAULT_POD_URL=https://your-pod.example/me/ \
 *     AGP_DEFAULT_OPERATOR_DID=did:web:you.example \
 *     npx tsx server.ts
 */

import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { attachOntologyServing } from '../../_shared/ontology-serve/index.js';
import { attachGuidanceServing, type GuidedAffordanceEntry } from '../../_shared/guided-affordance/index.js';
import { agpAffordances } from '../affordances.js';
import {
  AGP_NS, AGP_ONTOLOGY_IRI,
  readOntologyTurtle, readShapesTurtle, renderOntologyJsonLd, renderTermJsonLd,
} from '../src/ontology.js';
import { buildAgpProfileDoc, AGP_PROFILE_ID } from '../src/xapi-profile.js';
import { proposeStandardsExtension, EXTEND_STANDARDS_GUIDANCE, type ExtensionKind } from '../src/standards-extension.js';

// ── Stage-1 handler: validate + echo, mark pending Stage 2 (no fake publish) ──
function pendingHandler(toolName: string, required: string[]) {
  return async (args: Record<string, unknown>) => {
    const missing = required.filter(k => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) throw new Error(`${toolName}: missing required input(s): ${missing.join(', ')}`);
    return {
      pending: 'stage-2',
      tool: toolName,
      note: 'Vertical scaffold live (ontology + discovery served). Publisher + regime engine arrive in Stage 2, when the performance engine is moved out of Foxxi. Inputs validated and echoed; nothing was published.',
      ontology: AGP_ONTOLOGY_IRI,
      received: args,
    };
  };
}

const handlers: Record<string, (a: Record<string, unknown>) => Promise<unknown>> = {
  'agp.contextualize_situation': pendingHandler('agp.contextualize_situation', ['situation_statement']),
  'agp.define_capability': pendingHandler('agp.define_capability', ['name']),
  'agp.map_affordance': pendingHandler('agp.map_affordance', ['situation_iri', 'affordance_statement', 'requires_capability_iri']),
  'agp.actualize': pendingHandler('agp.actualize', ['situation_iri', 'capability_iri', 'affordance_iri', 'performance_statement']),
  'agp.diagnose': pendingHandler('agp.diagnose', ['situation_iri']),
  'agp.plan_intervention': pendingHandler('agp.plan_intervention', ['diagnosis_iri']),
  'agp.evaluate_intervention': pendingHandler('agp.evaluate_intervention', ['intervention_iri']),
  'agp.list_practice': pendingHandler('agp.list_practice', []),
  // REAL handler (not a stub): pure + composes Foxxi's standards, so it needs no
  // pod write to produce a conformant, self-descriptive, guided artifact.
  'agp.extend_standards': async (args: Record<string, unknown>) => proposeStandardsExtension({
    kind: String(args.kind) as ExtensionKind,
    name: String(args.name ?? ''),
    definition: String(args.definition ?? ''),
    label: args.label as string | undefined,
    extendsStandard: args.extends_standard as string | undefined,
    subClassOf: args.subclass_of as string | undefined,
    buildsCapability: args.builds_capability as string | undefined,
  }),
};

// In-flow performance support: the discoverable capability catalog (what each
// affordance teaches + how to learn it) + per-tool guidance, served at /guidance.
const GUIDANCE: GuidedAffordanceEntry[] = [
  { action: 'urn:cg:action:agp:extend-standards', toolName: 'agp.extend_standards', guidance: EXTEND_STANDARDS_GUIDANCE },
  { action: 'urn:cg:action:agp:contextualize-situation', toolName: 'agp.contextualize_situation', guidance: {
    summary: 'Place a performance situation in its work regime BEFORE choosing a method.',
    whenToUse: 'Always first. The regime (Evident/Knowable/Emergent/Turbulent) routes everything; gap-analysis is Knowable-only.',
    teaches: `${AGP_NS}PerformanceSituation`,
    nextAffordances: [{ action: 'urn:cg:action:agp:diagnose', rel: 'then', why: 'Diagnose the contextualized situation.' }],
  } },
  { action: 'urn:cg:action:agp:actualize', toolName: 'agp.actualize', guidance: {
    summary: 'Record a capability engaging a situation\'s affordance to yield performance.',
    whenToUse: 'When latent capability + an offered affordance actually became performance — the measurable event.',
    teaches: `${AGP_NS}Actualization`,
    requires: ['A defined capability (agp.define_capability) and a mapped affordance (agp.map_affordance).'],
  } },
];

const PORT = parseInt(process.env.PORT ?? '6030', 10);
const app = createVerticalBridge({
  verticalName: 'agentic-performance-practice',
  affordances: agpAffordances,
  handlers,
  defaultPodUrl: process.env.AGP_DEFAULT_POD_URL,
  // Dereferenceable serving: the agp ontology (shared primitive — content
  // negotiation + HATEOAS + per-term + SHACL shapes) AND the vertical's OWN
  // xAPI Profile, authored via Foxxi's parameterized builder (it composes,
  // rather than reimplements, the standards layer).
  middleware: (a) => {
    attachOntologyServing(a, {
      mountPath: '/ns/agp',
      ontologyIri: AGP_ONTOLOGY_IRI,
      namespace: AGP_NS,
      ontologyTurtle: readOntologyTurtle,
      shapesTurtle: readShapesTurtle,
      jsonld: renderOntologyJsonLd,
      term: renderTermJsonLd,
    });
    a.get('/xapi/profile', (_req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.type('application/ld+json').json(buildAgpProfileDoc({ generatedAt: new Date().toISOString() }));
    });
    // Performance support in the flow: the capability catalog + per-tool guidance.
    attachGuidanceServing(a, '/guidance', GUIDANCE);
  },
});
app.listen(PORT, () => {
  console.log(`agentic-performance-practice bridge on http://localhost:${PORT}`);
  console.log(`  MCP: http://localhost:${PORT}/mcp  |  Manifest: http://localhost:${PORT}/affordances`);
  console.log(`  Ontology: http://localhost:${PORT}/ns/agp  |  Shapes: http://localhost:${PORT}/ns/agp/shapes`);
  console.log(`  xAPI Profile: http://localhost:${PORT}/xapi/profile  (id: ${AGP_PROFILE_ID})`);
  console.log(`  Performance support (in the flow): http://localhost:${PORT}/guidance`);
});
