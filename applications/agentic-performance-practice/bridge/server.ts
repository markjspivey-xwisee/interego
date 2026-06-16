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

import type { Express, Request, Response } from 'express';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { agpAffordances } from '../affordances.js';
import {
  AGP_NS, AGP_ONTOLOGY_IRI,
  readOntologyTurtle, readShapesTurtle, renderOntologyJsonLd, renderTermJsonLd,
} from '../src/ontology.js';

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
};

// ── Dereferenceable ontology serving (content negotiation + HATEOAS) ──────
function serveOntology(app: Express): void {
  const cors = (res: Response) => res.setHeader('Access-Control-Allow-Origin', '*');
  const wantsJson = (req: Request) => /json/i.test(req.headers.accept ?? '');

  app.get('/ns/agp', (req: Request, res: Response) => {
    cors(res);
    if (wantsJson(req)) res.type('application/ld+json').json(renderOntologyJsonLd());
    else res.type('text/turtle').send(readOntologyTurtle());
  });

  app.get('/ns/agp/shapes', (_req: Request, res: Response) => {
    cors(res);
    res.type('text/turtle').send(readShapesTurtle());
  });

  // Per-term resolution. An owned-namespace fragment NEVER 404s — an unknown
  // term returns a minimal back-pointer to the ontology (the convention the
  // survey documented for dereferenceable vocab hosts).
  app.get('/ns/agp/term/:name', (req: Request, res: Response) => {
    cors(res);
    const term = renderTermJsonLd(req.params.name);
    res.type('application/ld+json').json(term ?? {
      '@id': `${AGP_NS}${req.params.name}`,
      '_links': { ontology: AGP_ONTOLOGY_IRI },
      note: 'Unknown term in an owned namespace — see the ontology for declared terms.',
    });
  });
}

const PORT = parseInt(process.env.PORT ?? '6030', 10);
const app = createVerticalBridge({
  verticalName: 'agentic-performance-practice',
  affordances: agpAffordances,
  handlers,
  defaultPodUrl: process.env.AGP_DEFAULT_POD_URL,
  middleware: serveOntology,
});
app.listen(PORT, () => {
  console.log(`agentic-performance-practice bridge on http://localhost:${PORT}`);
  console.log(`  MCP: http://localhost:${PORT}/mcp  |  Manifest: http://localhost:${PORT}/affordances`);
  console.log(`  Ontology: http://localhost:${PORT}/ns/agp  |  Shapes: http://localhost:${PORT}/ns/agp/shapes`);
});
