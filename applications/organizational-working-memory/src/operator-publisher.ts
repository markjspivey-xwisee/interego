/**
 * Operator-side publisher for the organizational-working-memory vertical.
 *
 * Implements the four operator affordances declared in
 * `affordances.ts → owmOperatorAffordances`:
 *
 *   - aggregate_decisions_query  : counts / distributions over decision lineage
 *   - project_health_summary     : per-project rollup
 *   - publish_org_policy         : signed org-authority policy descriptors
 *   - publish_compliance_evidence: wraps src/ops/ events as compliance: true
 *
 * Dual-audience design (docs/DUAL-AUDIENCE.md): these are the operator
 * counterparts to the contributor-side publishers in pod-publisher.ts.
 * Both surfaces write to the same org pod; ABAC + per-graph share_with
 * + (planned) aggregate-privacy queries are the boundary.
 *
 * Aggregate queries (v1): return counts and distributions derived from
 * the descriptors the operator's ABAC scope permits reading. Full ZK
 * aggregate-privacy proofs (spec/AGGREGATE-PRIVACY.md) are a v2 — v1
 * relies on the substrate's existing ABAC + per-graph share_with for
 * the privacy boundary. Each aggregate response includes
 * `privacyMode: 'abac'` so callers can see the v1 → v2 upgrade path.
 */

import { ContextDescriptor, publish, discover, buildDeployEvent, buildAccessChangeEvent, buildWalletRotationEvent, buildIncidentEvent, buildQuarterlyReviewEvent } from '../../../src/index.js';
import type { IRI, ContextDescriptorData, ManifestEntry, ComplianceFramework } from '../../../src/index.js';
import { createHash } from 'node:crypto';

const OWM_NS = 'https://markjspivey-xwisee.github.io/interego/applications/organizational-working-memory/owm#';

function nowIso(): string { return new Date().toISOString(); }
function sha16(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }
function escapeLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

export interface OperatorCtx {
  /** Pod URL of the org (descriptors live here). */
  readonly orgPodUrl: string;
  /** DID of the org-authority signing key (cg:assertingAgent on policy descriptors). */
  readonly authorityDid: IRI;
}

// ── aggregate_decisions_query ────────────────────────────────────────

export interface AggregateDecisionsQueryArgs {
  period_from: string;   // ISO 8601
  period_to: string;     // ISO 8601
  scope_iri?: string;    // optional narrowing scope
  metric: 'decision-count' | 'mean-revision-count' | 'supersession-distribution' | 'contributor-breadth';
}

export interface AggregateDecisionsQueryResult {
  readonly metric: AggregateDecisionsQueryArgs['metric'];
  readonly period: { from: string; to: string };
  readonly scope?: string;
  readonly value: number | Record<string, number>;
  readonly sampleSize: number;
  readonly privacyMode: 'abac' | 'zk-aggregate';
}

export async function aggregateDecisionsQuery(
  args: AggregateDecisionsQueryArgs,
  ctx: OperatorCtx,
): Promise<AggregateDecisionsQueryResult> {
  const from = Date.parse(args.period_from);
  const to = Date.parse(args.period_to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('period_from / period_to must be ISO 8601');
  if (to < from) throw new Error('period_to must be >= period_from');

  // discover() reads what the operator's ABAC scope permits; descriptors
  // outside that scope are simply not in the result set. v1 privacy
  // boundary = the substrate's standard ABAC + per-graph share_with.
  const entries = await discover(ctx.orgPodUrl);
  const decisions = entries.filter(e =>
    e.describes.some(d => d.startsWith('urn:owm:decision:')) &&
    inPeriod(e, from, to) &&
    (!args.scope_iri || mentionsScope(e, args.scope_iri))
  );

  // Group entries by their describes-IRI so we can walk supersedes chains.
  const byDecision = groupByDecisionIri(decisions);
  const sampleSize = byDecision.size;

  let value: number | Record<string, number>;
  switch (args.metric) {
    case 'decision-count':
      value = sampleSize;
      break;
    case 'mean-revision-count': {
      let totalRevisions = 0;
      for (const versions of byDecision.values()) totalRevisions += versions.length;
      value = sampleSize === 0 ? 0 : totalRevisions / sampleSize;
      break;
    }
    case 'supersession-distribution': {
      // Bucket by number of revisions per decision.
      const buckets: Record<string, number> = {};
      for (const versions of byDecision.values()) {
        const k = String(versions.length);
        buckets[k] = (buckets[k] ?? 0) + 1;
      }
      value = buckets;
      break;
    }
    case 'contributor-breadth': {
      // Distinct contributors across the discovered decisions. The
      // contributor is the descriptor's wasGeneratedBy in the manifest
      // entry (or assertingAgent); v1 uses the descriptor URL host as
      // a proxy until per-entry contributor metadata is exposed by
      // discover(). This counts pod authors, not individuals.
      const contributors = new Set<string>();
      for (const e of decisions) {
        try { contributors.add(new URL(e.descriptorUrl).host); } catch { /* skip */ }
      }
      value = contributors.size;
      break;
    }
  }

  return {
    metric: args.metric,
    period: { from: args.period_from, to: args.period_to },
    ...(args.scope_iri ? { scope: args.scope_iri } : {}),
    value,
    sampleSize,
    privacyMode: 'abac',
  };
}

function inPeriod(e: ManifestEntry, from: number, to: number): boolean {
  if (!e.validFrom) return true; // can't bound, include
  const t = Date.parse(e.validFrom);
  return Number.isFinite(t) && t >= from && t <= to;
}

function mentionsScope(e: ManifestEntry, scope: string): boolean {
  // v1: scope match is descriptor-URL substring (project IRI usually
  // contains a sha16 segment shared with the project descriptor URL).
  // A v2 would resolve project-descriptor relationships from the graph.
  return e.descriptorUrl.includes(scope) ||
    e.describes.some(d => d.includes(scope));
}

function groupByDecisionIri(entries: readonly ManifestEntry[]): Map<string, ManifestEntry[]> {
  const m = new Map<string, ManifestEntry[]>();
  for (const e of entries) {
    for (const d of e.describes) {
      if (!d.startsWith('urn:owm:decision:')) continue;
      const arr = m.get(d) ?? [];
      arr.push(e);
      m.set(d, arr);
    }
  }
  return m;
}

// ── project_health_summary ───────────────────────────────────────────

export interface ProjectHealthSummaryArgs {
  project_iri: string;
  window_days?: number;
}

export interface ProjectHealthSummaryResult {
  readonly projectIri: string;
  readonly windowDays: number;
  readonly decisionCount: number;
  readonly recentDecisionCount: number;
  readonly followUpCount: number;
  readonly openFollowUpCount: number;
  readonly noteCount: number;
  readonly supersessionChurn: number; // mean revisions per decision
  readonly privacyMode: 'abac' | 'zk-aggregate';
}

export async function projectHealthSummary(
  args: ProjectHealthSummaryArgs,
  ctx: OperatorCtx,
): Promise<ProjectHealthSummaryResult> {
  if (!args.project_iri) throw new Error('project_iri is required');
  const windowDays = args.window_days ?? 30;
  const windowCutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const all = await discover(ctx.orgPodUrl);
  const projectScoped = all.filter(e =>
    e.describes.some(d => d.includes(args.project_iri)) ||
    e.descriptorUrl.includes(args.project_iri)
  );

  const decisions = projectScoped.filter(e =>
    e.describes.some(d => d.startsWith('urn:owm:decision:'))
  );
  const followUps = projectScoped.filter(e =>
    e.describes.some(d => d.startsWith('urn:owm:followup:'))
  );
  const notes = projectScoped.filter(e =>
    e.describes.some(d => d.startsWith('urn:owm:note:'))
  );

  const byDecision = groupByDecisionIri(decisions);
  const decisionCount = byDecision.size;
  let revisionTotal = 0;
  for (const versions of byDecision.values()) revisionTotal += versions.length;
  const supersessionChurn = decisionCount === 0 ? 0 : revisionTotal / decisionCount;

  const recentDecisions = new Set<string>();
  for (const e of decisions) {
    if (!e.validFrom) continue;
    const t = Date.parse(e.validFrom);
    if (Number.isFinite(t) && t >= windowCutoff) {
      for (const d of e.describes) if (d.startsWith('urn:owm:decision:')) recentDecisions.add(d);
    }
  }

  // Open follow-ups: v1 heuristic — manifest doesn't carry the open/
  // closed bit, so we count distinct follow-up IRIs that have not been
  // superseded by a closure descriptor. Same `groupByDecisionIri` shape.
  const followUpsByIri = new Map<string, ManifestEntry[]>();
  for (const e of followUps) {
    for (const d of e.describes) {
      if (!d.startsWith('urn:owm:followup:')) continue;
      const arr = followUpsByIri.get(d) ?? [];
      arr.push(e);
      followUpsByIri.set(d, arr);
    }
  }
  const openFollowUpCount = [...followUpsByIri.values()]
    .filter(versions => !versions.some(v => v.modalStatus === 'Retracted' || v.modalStatus === 'Counterfactual'))
    .length;

  return {
    projectIri: args.project_iri,
    windowDays,
    decisionCount,
    recentDecisionCount: recentDecisions.size,
    followUpCount: followUpsByIri.size,
    openFollowUpCount,
    noteCount: notes.length,
    supersessionChurn,
    privacyMode: 'abac',
  };
}

// ── publish_org_policy ───────────────────────────────────────────────

export interface PublishOrgPolicyArgs {
  policy_type: 'retention' | 'decision-promotion' | 'compliance-attestation' | 'source-governance';
  policy_body: Record<string, unknown>;
  // authority_did + org_pod_url come from ctx; the affordance schema
  // exposes them as inputs for non-bridge callers (Path A affordance-walk).
}

export interface PublishOrgPolicyResult {
  readonly policyIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly authorityDid: IRI;
}

export async function publishOrgPolicy(
  args: PublishOrgPolicyArgs,
  ctx: OperatorCtx,
): Promise<PublishOrgPolicyResult> {
  if (!args.policy_type) throw new Error('policy_type is required');
  if (!args.policy_body || typeof args.policy_body !== 'object') throw new Error('policy_body must be an object');

  // Content-stable IRI: re-publishing the same policy body under the
  // same type yields the same IRI and supersedes the prior version
  // via the substrate's auto-supersedes machinery in publish().
  const canon = JSON.stringify(args.policy_body, Object.keys(args.policy_body).sort());
  const policyIri = `urn:owm:policy:${args.policy_type}:${sha16(canon)}` as IRI;
  const graphIri = `urn:graph:owm:policy:${args.policy_type}:${sha16(canon)}` as IRI;

  const bodyTtl = JSON.stringify(args.policy_body);
  const ttl = `@prefix owm: <${OWM_NS}> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
<${graphIri}> a owm:OrgPolicy ;
  owm:policyType "${args.policy_type}" ;
  owm:policyBody """${escapeLit(bodyTtl)}""" ;
  prov:wasAttributedTo <${ctx.authorityDid}> ;
  dct:issued "${nowIso()}" .`;

  const built = ContextDescriptor.create(policyIri)
    .describes(graphIri)
    .agent(ctx.authorityDid)
    .generatedBy(ctx.authorityDid, { onBehalfOf: ctx.authorityDid, endedAt: nowIso() })
    .temporal({ validFrom: nowIso() })
    .asserted(0.95)
    .verified(ctx.authorityDid)
    .build();

  const r = await publish(built, ttl, ctx.orgPodUrl);
  return {
    policyIri,
    descriptorUrl: r.descriptorUrl,
    graphUrl: r.graphUrl,
    authorityDid: ctx.authorityDid,
  };
}

// ── publish_compliance_evidence ──────────────────────────────────────

export interface PublishComplianceEvidenceArgs {
  event_kind: 'deploy' | 'access-change' | 'key-rotation' | 'incident' | 'quarterly-review';
  event_payload: Record<string, unknown>;
  framework: ComplianceFramework;
  cited_controls: readonly string[];
}

export interface PublishComplianceEvidenceResult {
  readonly evidenceIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly framework: ComplianceFramework;
  readonly controls: readonly string[];
  readonly modalStatus: 'Asserted' | 'Counterfactual';
}

export async function publishComplianceEvidence(
  args: PublishComplianceEvidenceArgs,
  ctx: OperatorCtx,
): Promise<PublishComplianceEvidenceResult> {
  if (!args.event_kind) throw new Error('event_kind is required');
  if (!args.framework) throw new Error('framework is required');
  if (!Array.isArray(args.cited_controls) || args.cited_controls.length === 0) {
    throw new Error('cited_controls must be a non-empty array of control IRIs');
  }

  // Delegate to the src/ops/ event builder for the event-shape; same
  // code path the operator already uses for SOC 2 evidence in
  // tools/publish-ops-event.mjs.
  let event;
  switch (args.event_kind) {
    case 'deploy':           event = buildDeployEvent(args.event_payload as unknown as Parameters<typeof buildDeployEvent>[0]); break;
    case 'access-change':    event = buildAccessChangeEvent(args.event_payload as unknown as Parameters<typeof buildAccessChangeEvent>[0]); break;
    case 'key-rotation':     event = buildWalletRotationEvent(args.event_payload as unknown as Parameters<typeof buildWalletRotationEvent>[0]); break;
    case 'incident':         event = buildIncidentEvent(args.event_payload as unknown as Parameters<typeof buildIncidentEvent>[0]); break;
    case 'quarterly-review': event = buildQuarterlyReviewEvent(args.event_payload as unknown as Parameters<typeof buildQuarterlyReviewEvent>[0]); break;
  }

  // Reinforce the operator's framework + cited_controls into the
  // descriptor (the ops builder already cites its default controls;
  // the operator may want to expand citations for a specific audit).
  const builder = ContextDescriptor.create(event.graph_iri as IRI)
    .describes(event.graph_iri as IRI)
    .agent(ctx.authorityDid)
    .generatedBy(ctx.authorityDid, { onBehalfOf: ctx.authorityDid, endedAt: nowIso() })
    .temporal({ validFrom: nowIso() });
  if (event.modal_status === 'Counterfactual') {
    builder.counterfactual(0.95);
  } else {
    builder.asserted(0.95);
  }
  builder.verified(ctx.authorityDid);
  for (const ctrl of args.cited_controls) builder.conformsTo(ctrl as IRI);
  const built = builder.build();

  const r = await publish(built, event.graph_content, ctx.orgPodUrl);
  return {
    evidenceIri: event.graph_iri as IRI,
    descriptorUrl: r.descriptorUrl,
    graphUrl: r.graphUrl,
    framework: args.framework,
    controls: args.cited_controls,
    modalStatus: event.modal_status,
  };
}
