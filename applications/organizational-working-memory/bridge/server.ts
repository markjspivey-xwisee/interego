/**
 * organizational-working-memory bridge — opinionated MCP-named-tool
 * surface over the OWM vertical.
 *
 * Like every vertical in this repo, OWM is reachable two ways from
 * the same source-of-truth (the affordance declarations):
 *
 *   Path A — generic affordance walk (no per-vertical client install):
 *     fetch GET /affordances → walk cg:Affordance entries → POST hydra:target.
 *
 *   Path B — named MCP tools (this bridge):
 *     POST /mcp → tools/list → tools/call. Tool schemas are derived
 *     from the same affordance declarations.
 *
 * Per-source isolation: navigate_source / update_source dispatch into
 * registered SourceAdapter sub-handlers. Adding a new external source
 * is a ~50-line file under source-adapters/ — the main agent never
 * sees the per-source surface.
 *
 * Run:
 *   PORT=6060 BRIDGE_DEPLOYMENT_URL=http://localhost:6060 \
 *     OWM_DEFAULT_POD_URL=https://your-pod.example/me/ \
 *     OWM_DEFAULT_ORG_DID=did:web:your-org.example \
 *     npx tsx server.ts
 */

import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { owmAffordances, owmOperatorAffordances } from '../affordances.js';
import {
  upsertPerson, upsertProject, recordDecision, queueFollowup,
  recordNote, listOverdueFollowups, discoverSubgraph,
  type PodCtx,
  type UpsertPersonArgs, type UpsertProjectArgs, type RecordDecisionArgs,
  type QueueFollowupArgs, type RecordNoteArgs,
  type OverdueFollowupsArgs, type DiscoverSubgraphArgs,
} from '../src/pod-publisher.js';
import {
  aggregateDecisionsQuery, projectHealthSummary,
  publishOrgPolicy, publishComplianceEvidence,
  type OperatorCtx,
  type AggregateDecisionsQueryArgs, type ProjectHealthSummaryArgs,
  type PublishOrgPolicyArgs, type PublishComplianceEvidenceArgs,
} from '../src/operator-publisher.js';
import { AdapterRegistry, type NavigationVerb } from '../source-adapters/index.js';
import { webAdapter } from '../source-adapters/web.js';
import type { IRI } from '../../../src/index.js';

function ctx(args: Record<string, unknown>): PodCtx {
  const podUrl = (args['pod_url'] as string | undefined) ?? process.env['OWM_DEFAULT_POD_URL'];
  const orgDid = ((args['org_did'] as string | undefined) ?? process.env['OWM_DEFAULT_ORG_DID']) as IRI | undefined;
  if (!podUrl) throw new Error('pod_url is required (or set OWM_DEFAULT_POD_URL)');
  if (!orgDid) throw new Error('org_did is required (or set OWM_DEFAULT_ORG_DID)');
  return { podUrl, orgDid };
}

function operatorCtx(args: Record<string, unknown>): OperatorCtx {
  const orgPodUrl = (args['org_pod_url'] as string | undefined) ?? process.env['OWM_DEFAULT_POD_URL'];
  const authorityDid = ((args['authority_did'] as string | undefined) ?? process.env['OWM_DEFAULT_AUTHORITY_DID'] ?? process.env['OWM_DEFAULT_ORG_DID']) as IRI | undefined;
  if (!orgPodUrl) throw new Error('org_pod_url is required (or set OWM_DEFAULT_POD_URL)');
  if (!authorityDid) throw new Error('authority_did is required (or set OWM_DEFAULT_AUTHORITY_DID / OWM_DEFAULT_ORG_DID)');
  return { orgPodUrl, authorityDid };
}

// Source-adapter registry — wire reference adapters here. Operators
// extend by importing additional adapters and calling registry.register.
const sourceRegistry = new AdapterRegistry();
sourceRegistry.register(webAdapter);
// Optional adapters — wire by setting the appropriate env vars.
// Extension point: import { driveAdapter } from '../source-adapters/drive.js'; etc.

const handlers = {
  'owm.upsert_person': async (args: Record<string, unknown>) =>
    upsertPerson(args as unknown as UpsertPersonArgs, ctx(args)),

  'owm.upsert_project': async (args: Record<string, unknown>) =>
    upsertProject(args as unknown as UpsertProjectArgs, ctx(args)),

  'owm.record_decision': async (args: Record<string, unknown>) =>
    recordDecision(args as unknown as RecordDecisionArgs, ctx(args)),

  'owm.queue_followup': async (args: Record<string, unknown>) =>
    queueFollowup(args as unknown as QueueFollowupArgs, ctx(args)),

  'owm.record_note': async (args: Record<string, unknown>) =>
    recordNote(args as unknown as RecordNoteArgs, ctx(args)),

  'owm.list_overdue_followups': async (args: Record<string, unknown>) =>
    listOverdueFollowups(args as unknown as OverdueFollowupsArgs, ctx(args)),

  'owm.discover_subgraph': async (args: Record<string, unknown>) =>
    discoverSubgraph(args as unknown as DiscoverSubgraphArgs, ctx(args)),

  'owm.navigate_source': async (args: Record<string, unknown>) => {
    const source = String(args['source'] ?? '');
    const verb = String(args['verb'] ?? '') as NavigationVerb;
    const verbArgs = (args['args'] as Record<string, unknown> | undefined) ?? {};
    const adapter = sourceRegistry.get(source);
    if (!adapter) throw new Error(`unknown source "${source}". Registered: ${sourceRegistry.list().map(s => s.key).join(', ')}`);
    if (!adapter.supportedVerbs.includes(verb)) {
      throw new Error(`source "${source}" does not support verb "${verb}". Supports: ${adapter.supportedVerbs.join(', ')}`);
    }
    return adapter.navigate(verb, verbArgs);
  },

  'owm.update_source': async (args: Record<string, unknown>) => {
    const source = String(args['source'] ?? '');
    const action = String(args['action'] ?? '');
    const actionArgs = (args['args'] as Record<string, unknown> | undefined) ?? {};
    const adapter = sourceRegistry.get(source);
    if (!adapter) throw new Error(`unknown source "${source}"`);
    if (!adapter.update) throw new Error(`source "${source}" is read-only`);
    if (!adapter.supportedActions.includes(action)) {
      throw new Error(`source "${source}" does not support action "${action}". Supports: ${adapter.supportedActions.join(', ')}`);
    }
    return adapter.update(action, actionArgs);
  },

  'owm.list_sources': async () => sourceRegistry.list(),

  // ── Operator-side affordances (dual-audience: org-level operator) ──
  // Counterparts to the contributor-side handlers above. See
  // docs/DUAL-AUDIENCE.md and src/operator-publisher.ts.

  'owm.aggregate_decisions_query': async (args: Record<string, unknown>) =>
    aggregateDecisionsQuery(args as unknown as AggregateDecisionsQueryArgs, operatorCtx(args)),

  'owm.project_health_summary': async (args: Record<string, unknown>) =>
    projectHealthSummary(args as unknown as ProjectHealthSummaryArgs, operatorCtx(args)),

  'owm.publish_org_policy': async (args: Record<string, unknown>) =>
    publishOrgPolicy(args as unknown as PublishOrgPolicyArgs, operatorCtx(args)),

  'owm.publish_compliance_evidence': async (args: Record<string, unknown>) =>
    publishComplianceEvidence(args as unknown as PublishComplianceEvidenceArgs, operatorCtx(args)),
};

const allAffordances = [...owmAffordances, ...owmOperatorAffordances];

const PORT = parseInt(process.env['PORT'] ?? '6060', 10);
const app = createVerticalBridge({
  verticalName: 'organizational-working-memory',
  affordances: allAffordances,
  handlers,
  defaultPodUrl: process.env['OWM_DEFAULT_POD_URL'],
});

app.listen(PORT, () => {
  console.log(`organizational-working-memory bridge on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:        http://localhost:${PORT}/mcp`);
  console.log(`  Affordance manifest: http://localhost:${PORT}/affordances`);
  console.log(`  Source adapters:     ${sourceRegistry.list().map(s => s.key).join(', ')}`);
  console.log(`  ${allAffordances.length} affordances available (${owmAffordances.length} contributor + ${owmOperatorAffordances.length} operator)`);
});
