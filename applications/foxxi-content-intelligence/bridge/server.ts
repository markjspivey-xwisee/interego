/**
 * foxxi-content-intelligence bridge — opinionated MCP-named-tool
 * surface over the Foxxi vertical.
 *
 * Generic agents don't need this — they can discover + invoke this
 * vertical's affordances via the protocol's cg:Affordance manifest at
 * GET /affordances. The bridge is just an ergonomic accelerant for
 * clients that prefer named MCP tools.
 *
 * Run:
 *   PORT=6080 BRIDGE_DEPLOYMENT_URL=http://localhost:6080 \
 *     FOXXI_TENANT_POD_URL=https://your-pod.example/markj/ \
 *     FOXXI_AUTHORITATIVE_SOURCE=did:web:your-tenant.example \
 *     npx tsx server.ts
 *
 * Audience split (per docs/DEPLOYMENT-SPLIT.md):
 *   FOXXI_AUDIENCE=learner   → expose foxxiAffordances only
 *   FOXXI_AUDIENCE=admin     → expose foxxiAdminAffordances only
 *   FOXXI_AUDIENCE=both      → expose both (default)
 */

import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';
import {
  ingestContentPackage,
  publishAuthoringPolicy,
  assignAudience,
  coverageQuery,
  type AuthoringPolicy,
  type AudienceAssignment,
  type ParsedFoxxiPackage,
  type CoverageQueryArgs,
} from '../src/publisher.js';
import type { IRI } from '../../../src/index.js';

const tenantPodUrl = process.env.FOXXI_TENANT_POD_URL ?? '';
const authoritativeSource = (process.env.FOXXI_AUTHORITATIVE_SOURCE ?? 'did:web:foxxi.example') as IRI;

function configOrThrow(args: Record<string, unknown>): { tenantPodUrl: string; authoritativeSource: IRI } {
  const pod = (args.tenant_pod_url as string) || tenantPodUrl;
  if (!pod) throw new Error('foxxi bridge: tenant_pod_url required (or set FOXXI_TENANT_POD_URL).');
  return { tenantPodUrl: pod, authoritativeSource };
}

// ── Handlers ───────────────────────────────────────────────────────────

const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  // ── Learner-side ────────────────────────────────────────────────────
  'foxxi.discover_assigned_courses': async (args) => {
    // Skeleton: real implementation walks tenant pod's policy descriptors
    // + filters by learner's audience tags.
    return { assignments: [], note: 'stub: bridge handler not yet wired to pod-walk; affordance is discoverable' };
  },

  'foxxi.consume_lesson': async (args) => {
    // Real implementation streams the parsed lesson + emits xAPI via lrs-adapter.
    return { consumed: false, note: 'stub: bridge handler not yet wired; compose with applications/lrs-adapter/' };
  },

  'foxxi.explore_concept_map': async (args) => {
    // Real implementation fetches fxk: descriptors + builds nav graph.
    return { concepts: [], edges: [], note: 'stub: bridge handler not yet wired; pulls the published concept map artifact' };
  },

  // ── Admin-side ───────────────────────────────────────────────────────
  'foxxi.ingest_content_package': async (args) => {
    const config = configOrThrow(args);
    // The real parse runs the Python parser (imported/foxxi_storyline_parser_v03.py)
    // out-of-process. The bridge handler accepts the ALREADY-parsed payload
    // here for the substrate composition step. Stub returns a placeholder.
    if (!args.parsed) {
      return {
        note: 'stub: supply args.parsed (ParsedFoxxiPackage) — production wiring runs the Python parser on args.zip_base64 then calls this',
      };
    }
    return ingestContentPackage({
      parsed: args.parsed as ParsedFoxxiPackage,
      config,
    });
  },

  'foxxi.publish_authoring_policy': async (args) => {
    const config = configOrThrow(args);
    const policy: AuthoringPolicy = {
      acceptedTools: (args.accepted_tools as string[]) ?? [],
      acceptedStandards: (args.accepted_standards as string[]) ?? [],
      effectiveFrom: (args.effective_from as string) ?? new Date().toISOString(),
    };
    return publishAuthoringPolicy({ policy, config });
  },

  'foxxi.connect_lms': async (args) => {
    // Skeleton: composes with src/connectors/ in the real wiring.
    void args;
    return { note: 'stub: bridge handler not yet wired to src/connectors/ — affordance is discoverable' };
  },

  'foxxi.assign_audience': async (args) => {
    const config = configOrThrow(args);
    const assignment: AudienceAssignment = {
      courseIri: args.course_iri as IRI,
      audienceTag: args.audience_tag as string,
      requirementType: (args.requirement_type as 'required' | 'recommended') ?? 'recommended',
      trigger: (args.trigger as 'on-hire' | 'on-role-change' | 'on-cycle' | 'manual') ?? 'manual',
      dueRelativeDays: (args.due_relative_days as number) ?? 30,
    };
    return assignAudience({ assignment, config });
  },

  'foxxi.coverage_query': async (args) => {
    const config = configOrThrow(args);
    const q: CoverageQueryArgs = {
      config,
      coverage: (args.coverage as CoverageQueryArgs['coverage']) ?? [],
      privacyMode: args.privacy_mode as CoverageQueryArgs['privacyMode'],
      epsilon: args.epsilon as number | undefined,
      distributionEdges: args.distribution_edges
        ? (args.distribution_edges as string[]).map(BigInt)
        : undefined,
      distributionMaxValue: args.distribution_max_value
        ? BigInt(args.distribution_max_value as string)
        : undefined,
    };
    return coverageQuery(q);
  },

  'foxxi.publish_concept_map': async (args) => {
    // Skeleton: would re-publish the fxk: stratum graph with explicit share_with.
    void args;
    return { note: 'stub: bridge handler not yet wired to re-publish the fxk stratum with share_with' };
  },

  'foxxi.publish_compliance_evidence': async (args) => {
    // Skeleton: composes with integrations/compliance-overlay/ + src/ops/.
    void args;
    return { note: 'stub: bridge handler not yet wired to compliance-overlay — wire via recordAgentAction' };
  },
};

// ── Audience split + bridge bootstrap ─────────────────────────────────

const audience = (process.env.FOXXI_AUDIENCE ?? 'both').toLowerCase();
let activeAffordances: typeof foxxiAffordances;
if (audience === 'learner') activeAffordances = foxxiAffordances;
else if (audience === 'admin') activeAffordances = foxxiAdminAffordances;
else activeAffordances = [...foxxiAffordances, ...foxxiAdminAffordances];

const PORT = parseInt(process.env.PORT ?? '6080', 10);
const app = createVerticalBridge({
  verticalName: 'foxxi-content-intelligence',
  affordances: activeAffordances,
  handlers,
  defaultPodUrl: tenantPodUrl,
});

app.listen(PORT, () => {
  console.log(`foxxi-content-intelligence bridge on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:        http://localhost:${PORT}/mcp`);
  console.log(`  Affordance manifest: http://localhost:${PORT}/affordances`);
  console.log(`  Audience: ${audience} (${activeAffordances.length} affordances active; FOXXI_AUDIENCE=learner|admin|both)`);
});
