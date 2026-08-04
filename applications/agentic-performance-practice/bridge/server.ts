/**
 * agentic-performance-practice bridge — named-MCP-tool + HTTP surface over the
 * agp: vertical, PLUS dereferenceable serving of the agp: ontology.
 *
 * Generic agents discover via the iep:Affordance manifest at GET /affordances;
 * this bridge is the named-MCP ergonomic. It additionally serves the ontology
 * as linked data at GET /ns/agp (content-negotiated Turtle / JSON-LD), per-term
 * at GET /ns/agp/term/:name, and the SHACL shapes at GET /ns/agp/shapes — the
 * author-AND-serve pattern the survey found missing in sibling verticals.
 *
 * Status: the engine lives HERE (src/performance-architecture.ts; Foxxi
 * re-exports it via a shim) and eight of the nine affordances run real code and
 * publish real, SHACL-validated artifacts. The one remaining stub is
 * agp.list_practice, and it names the blocker that is actually unmet — no pod
 * container-enumeration read — rather than a stage label. The previous header
 * claimed the whole bridge was pending "when the engine is moved out of Foxxi";
 * that move had already shipped, and nothing could detect the sentence had gone
 * false because it was a literal, not a derived fact. Handler reasons are now a
 * required argument (bridge/handlers.ts), so a stale one cannot be copy-pasted.
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
import { EXTEND_STANDARDS_GUIDANCE } from '../src/standards-extension.js';
// The REAL engine runs IN this bridge (its canonical home); Foxxi re-exports the
// same engine via its shim (arrow: foxxi → agp). The handlers themselves live in
// ./handlers.ts, NOT here: this module calls app.listen() at import time, so any
// handler defined in it is unreachable from a test.
import { createAgpHandlers } from './handlers.js';

const handlers = createAgpHandlers();

// In-flow performance support: the discoverable capability catalog (what each
// affordance teaches + how to learn it) + per-tool guidance, served at /guidance.
const GUIDANCE: GuidedAffordanceEntry[] = [
  { action: 'urn:iep:action:agp:extend-standards', toolName: 'agp.extend_standards', guidance: EXTEND_STANDARDS_GUIDANCE },
  { action: 'urn:iep:action:agp:contextualize-situation', toolName: 'agp.contextualize_situation', guidance: {
    summary: 'Place a performance situation in its work regime BEFORE choosing a method.',
    whenToUse: 'Always first. The regime (Evident/Knowable/Emergent/Turbulent) routes everything; gap-analysis is Knowable-only.',
    teaches: `${AGP_NS}PerformanceSituation`,
    nextAffordances: [{ action: 'urn:iep:action:agp:diagnose', rel: 'then', why: 'Diagnose the contextualized situation.' }],
  } },
  { action: 'urn:iep:action:agp:actualize', toolName: 'agp.actualize', guidance: {
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
  console.log(`  Handlers — REAL (engine + SHACL-validated publish): contextualize_situation, define_capability, map_affordance, actualize, diagnose, plan_intervention, evaluate_intervention, extend_standards`);
  console.log(`  Handlers — pending: list_practice (blocked on a pod container-enumeration read, not on any stage)`);
});
