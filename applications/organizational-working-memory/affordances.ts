/**
 * Affordance declarations for the organizational-working-memory vertical.
 *
 * Vertical purpose:
 *   Federated organizational memory — people, projects, decisions,
 *   and follow-ups, persisted as typed Context Descriptors on the
 *   org's pod. The "graph" emerges from the substrate (cg:supersedes
 *   chains carry decision revision; passport:LifeEvent records
 *   identity continuity; pgsl:Atom content-addresses captured notes
 *   so two observers minting the same insight collide on IRI).
 *
 * Two surfaces, one source of truth:
 *
 *   ENTITY surface — owm.upsert_person / upsert_project /
 *     record_decision / queue_followup / record_note. These publish
 *     typed descriptors. Schema is open-world: an organization can
 *     introduce its own facets without a migration step (RDF + SHACL
 *     handle this natively).
 *
 *   NAVIGATION surface — owm.navigate_source / update_source. The
 *     main agent sees ONE pair of tools regardless of how many
 *     external sources are wired (web, drive, slack, github, ...).
 *     Each source runs as an isolated sub-process inside the bridge:
 *     it owns the source's quirks (auth, pagination, ACL inheritance,
 *     content-type handling) so the main agent's context is never
 *     polluted by source-specific tool noise.
 *
 *     Verbs are uniform across sources:
 *       ls       — enumerate children at a path / scope
 *       cat      — fetch the content at a path
 *       grep     — keyword scan within a scope
 *       recent   — items modified within a window
 *
 *     Whatever the source returns becomes addressable as a typed
 *     descriptor at write time (record_note / record_decision /
 *     etc.) — the substrate is the persistence layer, the source is
 *     the observation surface.
 */

import type { Affordance } from '../_shared/affordance-mcp/index.js';
import type { IRI } from '../../src/index.js';

const OWM_AFFORDANCES: ReadonlyArray<Affordance> = [
  // ── Entity surface ──────────────────────────────────────────

  {
    action: 'urn:cg:action:owm:upsert-person' as IRI,
    toolName: 'owm.upsert_person',
    title: 'Create or update a person record',
    description: 'Upsert an owm:Person descriptor on the org pod. Person IRIs are stable across sessions; subsequent calls supersede prior versions via cg:supersedes. Handles humans (no DID) and agent-people (with DID + capability passport).',
    method: 'POST',
    targetTemplate: '{base}/owm/upsert_person',
    annotations: { title: 'Create or update a person', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'name', type: 'string', required: true, description: 'Display name.' },
      { name: 'role', type: 'string', required: false, description: 'Free-text role / title.' },
      { name: 'organization', type: 'string', required: false, description: 'Organizational affiliation.' },
      { name: 'did', type: 'string', required: false, description: 'Optional DID for agent-people; humans omit.' },
      { name: 'aliases', type: 'array', required: false, description: 'Alternate names / handles for matching.', itemType: 'string' },
      { name: 'notes', type: 'string', required: false, description: 'Free-form notes.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL (defaults from env).' },
    ],
    outputs: {
      description: 'PublishResult — IRI of the new/updated owm:Person + descriptor/graph URLs + the modalStatus the descriptor was published with + IRIs of any prior descriptors superseded by this upsert (cg:supersedes chain).',
      properties: {
        iri: { type: 'string', description: 'Stable owm:Person IRI (content-derived from name + organization).' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
        modalStatus: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
        supersedes: { type: 'array', description: 'Prior descriptor URLs this upsert supersedes (empty on first publish).', items: { type: 'string' } },
      },
      required: ['iri', 'descriptorUrl', 'graphUrl', 'modalStatus', 'supersedes'],
    },
  },
  {
    action: 'urn:cg:action:owm:upsert-project' as IRI,
    toolName: 'owm.upsert_project',
    title: 'Create or update a project record',
    description: 'Upsert an owm:Project descriptor. Projects are owm:WorkingScope subclasses — composable with olke: knowledge-state vocabulary (Tacit / Articulate / Collective / Institutional). Subsequent upserts supersede.',
    method: 'POST',
    targetTemplate: '{base}/owm/upsert_project',
    annotations: { title: 'Create or update a project', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'name', type: 'string', required: true, description: 'Project name.' },
      { name: 'objective', type: 'string', required: false, description: 'One-sentence objective.' },
      { name: 'olke_stage', type: 'string', required: false, description: 'OLKE knowledge stage.', enum: ['Tacit', 'Articulate', 'Collective', 'Institutional'] },
      { name: 'participants', type: 'array', required: false, description: 'IRIs of owm:Person records who are working on this project.', itemType: 'string' },
      { name: 'status', type: 'string', required: false, description: 'Free-text status note.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
    outputs: {
      description: 'PublishResult — IRI of the new/updated owm:Project + descriptor/graph URLs + modalStatus + IRIs of prior descriptors superseded.',
      properties: {
        iri: { type: 'string', description: 'Stable owm:Project IRI (content-derived from name).' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
        modalStatus: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
        supersedes: { type: 'array', items: { type: 'string' } },
      },
      required: ['iri', 'descriptorUrl', 'graphUrl', 'modalStatus', 'supersedes'],
    },
  },
  {
    action: 'urn:cg:action:owm:record-decision' as IRI,
    toolName: 'owm.record_decision',
    title: 'Record a decision with modal status',
    description: 'Record an owm:Decision descriptor. Modal status defaults to Hypothetical (decision pending). Use Asserted for committed decisions. To reverse a decision, call again with modal_status=Counterfactual and supersedes=[<prior decision IRI>].',
    method: 'POST',
    targetTemplate: '{base}/owm/record_decision',
    annotations: { title: 'Record a decision', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'topic', type: 'string', required: true, description: 'Short topic / what is being decided.' },
      { name: 'rationale', type: 'string', required: true, description: 'The argument or evidence behind the decision.' },
      { name: 'modal_status', type: 'string', required: false, description: 'Default Hypothetical (pending).', enum: ['Hypothetical', 'Asserted', 'Counterfactual'] },
      { name: 'project_iri', type: 'string', required: false, description: 'Project this decision belongs to.' },
      { name: 'decided_by', type: 'array', required: false, description: 'IRIs of owm:Person records who made the decision.', itemType: 'string' },
      { name: 'supersedes', type: 'array', required: false, description: 'Prior decision IRIs this one supersedes.', itemType: 'string' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
    outputs: {
      description: 'PublishResult — IRI of the new owm:Decision + descriptor/graph URLs + modalStatus (defaults Hypothetical until promoted) + the cg:supersedes chain (from caller-supplied prior decision IRIs + auto-supersedes of any earlier descriptor at the same IRI).',
      properties: {
        iri: { type: 'string', description: 'owm:Decision IRI.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
        modalStatus: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
        supersedes: { type: 'array', description: 'Prior IRIs this decision supersedes (caller-supplied + auto-detected).', items: { type: 'string' } },
      },
      required: ['iri', 'descriptorUrl', 'graphUrl', 'modalStatus', 'supersedes'],
    },
  },
  {
    action: 'urn:cg:action:owm:queue-followup' as IRI,
    toolName: 'owm.queue_followup',
    title: 'Queue a follow-up to surface later',
    description: 'Queue an owm:FollowUp with a due-date (ISO 8601). The bridge\'s list_overdue_followups affordance surfaces items whose due_at has passed, so a cron or interactive query closes the observe-and-revise loop.',
    method: 'POST',
    targetTemplate: '{base}/owm/queue_followup',
    annotations: { title: 'Queue a follow-up', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'topic', type: 'string', required: true, description: 'What needs follow-up.' },
      { name: 'due_at', type: 'string', required: true, description: 'ISO 8601 datetime when this should surface.' },
      { name: 'context_iri', type: 'string', required: false, description: 'IRI of the project / decision this follow-up relates to.' },
      { name: 'watcher_did', type: 'string', required: false, description: 'DID of the agent or person responsible for the follow-up.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
    outputs: {
      description: 'PublishResult — IRI of the new owm:FollowUp + descriptor/graph URLs + modalStatus + supersedes chain.',
      properties: {
        iri: { type: 'string', description: 'owm:FollowUp IRI.' },
        descriptorUrl: { type: 'string' },
        graphUrl: { type: 'string' },
        modalStatus: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
        supersedes: { type: 'array', items: { type: 'string' } },
      },
      required: ['iri', 'descriptorUrl', 'graphUrl', 'modalStatus', 'supersedes'],
    },
  },
  {
    action: 'urn:cg:action:owm:record-note' as IRI,
    toolName: 'owm.record_note',
    title: 'Record a content-addressed note',
    description: 'Capture a free-form insight as a content-addressed pgsl:Atom + descriptor. Two observers minting the same verbatim text mint the same atom IRI — duplicate notes collapse structurally.',
    method: 'POST',
    targetTemplate: '{base}/owm/record_note',
    annotations: { title: 'Record a content-addressed note', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'text', type: 'string', required: true, description: 'The note content. Stored as a content-addressed atom.' },
      { name: 'subject_iris', type: 'array', required: false, description: 'IRIs the note is about (people, projects, decisions).', itemType: 'string' },
      { name: 'tags', type: 'array', required: false, description: 'Free-text tags.', itemType: 'string' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
    outputs: {
      description: 'PublishResult — IRI of the content-addressed owm:Note (re-publishing the same verbatim text returns the same IRI) + descriptor/graph URLs + modalStatus + supersedes.',
      properties: {
        iri: { type: 'string', description: 'owm:Note IRI (content-addressed from the note text + pgsl:Atom hash).' },
        descriptorUrl: { type: 'string' },
        graphUrl: { type: 'string' },
        modalStatus: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
        supersedes: { type: 'array', items: { type: 'string' } },
      },
      required: ['iri', 'descriptorUrl', 'graphUrl', 'modalStatus', 'supersedes'],
    },
  },
  {
    action: 'urn:cg:action:owm:list-overdue-followups' as IRI,
    toolName: 'owm.list_overdue_followups',
    title: 'List overdue follow-ups',
    description: 'Return follow-ups whose due_at is on or before now (or `now` arg). Used by cron schedulers and by interactive agents that want to surface pending work at session start.',
    method: 'POST',
    targetTemplate: '{base}/owm/list_overdue_followups',
    annotations: { title: 'List overdue follow-ups', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'now', type: 'string', required: false, description: 'Optional ISO 8601 datetime to evaluate against (default: server clock).' },
      { name: 'limit', type: 'integer', required: false, description: 'Maximum items to return (default 50).', minimum: 1, maximum: 500 },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
    outputs: {
      description: 'Array of OverdueFollowupSummary — owm:FollowUp entries whose due_at is on or before the evaluation moment, sorted due-soonest first. Handler returns the array directly; this property documents the entry shape.',
      properties: {
        results: {
          type: 'array',
          description: 'OverdueFollowupSummary entries (iri, descriptorUrl, due_at, topic).',
          items: {
            type: 'object',
            properties: {
              iri: { type: 'string' },
              descriptorUrl: { type: 'string' },
              due_at: { type: 'string', description: 'ISO 8601 datetime — when the follow-up was queued to surface.' },
              topic: { type: 'string', description: 'Human-readable follow-up topic; may be null when the underlying descriptor omitted it.' },
            },
            required: ['iri', 'descriptorUrl'],
          },
        },
      },
    },
  },
  {
    action: 'urn:cg:action:owm:discover-subgraph' as IRI,
    toolName: 'owm.discover_subgraph',
    title: 'Walk the org graph for a subject',
    description: 'Affordance-walk the org pod for descriptors related to a subject IRI. Returns the manifest entries (descriptor URLs + facet summary + supersedes chain head). Caller can then get_descriptor on URLs of interest.',
    method: 'POST',
    targetTemplate: '{base}/owm/discover_subgraph',
    annotations: { title: 'Walk the org subgraph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'subject_iri', type: 'string', required: true, description: 'IRI of the entity to walk from (person/project/decision).' },
      { name: 'depth', type: 'integer', required: false, description: 'How many hops to traverse (default 1).', minimum: 1, maximum: 4 },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
    outputs: {
      description: 'Subject + per-edge metadata for descriptors related to the queried subject IRI on the org pod (descriptor URLs + facet types + modal status + supersedes chain head). Caller can follow up with get_descriptor on URLs of interest.',
      properties: {
        subject: { type: 'string', description: 'Echo of the queried subject IRI.' },
        edges: {
          type: 'array',
          description: 'SubgraphEdge entries — one per related descriptor at depth-1.',
          items: {
            type: 'object',
            properties: {
              descriptor_url: { type: 'string' },
              describes: { type: 'array', items: { type: 'string' } },
              facet_types: { type: 'array', items: { type: 'string' } },
              modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
              supersedes: { type: 'array', items: { type: 'string' } },
            },
            required: ['descriptor_url', 'describes', 'facet_types', 'supersedes'],
          },
        },
      },
      required: ['subject', 'edges'],
    },
  },

  // ── Navigation surface (per-source isolation) ──────────────

  {
    action: 'urn:cg:action:owm:navigate-source' as IRI,
    toolName: 'owm.navigate_source',
    title: 'Read from an external source via uniform verbs',
    description: 'Read an external information source (web, drive, slack, github, ...) using uniform verbs (ls / cat / grep / recent). Each source runs as an isolated sub-handler inside the bridge so the main agent\'s context is never polluted by source-specific tool noise. The source\'s native quirks (auth, pagination, content-type) are handled inside the sub-handler.',
    method: 'POST',
    targetTemplate: '{base}/owm/navigate_source',
    annotations: { title: 'Read from an external source', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'source', type: 'string', required: true, description: 'Source key (e.g., "web", "drive", "slack"). Use list_sources to enumerate currently-loaded adapters.' },
      { name: 'verb', type: 'string', required: true, description: 'Navigation verb.', enum: ['ls', 'cat', 'grep', 'recent'] },
      { name: 'args', type: 'object', required: true, description: 'Verb-specific arguments. cat: { uri }. grep: { pattern, scope? }. ls: { path? }. recent: { window_minutes? }.' },
    ],
    outputs: {
      description: 'Source-specific navigation result shaped by the underlying sub-handler (web / drive / slack / github / …). Common ls payload: { entries: [{ uri, name, type, modified? }] }. Common cat payload: { uri, mediaType, body }. Common grep payload: { hits: [{ uri, snippet, score? }] }. Common recent payload: { entries: [{ uri, name, modified, summary? }] }. Each adapter is free to add adapter-specific fields.',
    },
  },
  {
    action: 'urn:cg:action:owm:update-source' as IRI,
    toolName: 'owm.update_source',
    title: 'Write to an external source via uniform action',
    description: 'Write back to an external source (post Slack message, append note to drive doc, comment on PR). Uniform write surface; per-source sub-handler owns the protocol.',
    method: 'POST',
    targetTemplate: '{base}/owm/update_source',
    annotations: { title: 'Write to an external source', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'source', type: 'string', required: true, description: 'Source key.' },
      { name: 'action', type: 'string', required: true, description: 'Source-specific action (post, append, comment, ...).' },
      { name: 'args', type: 'object', required: true, description: 'Action-specific arguments.' },
    ],
    outputs: {
      description: 'Source-specific write-action receipt shaped by the underlying sub-handler (web / drive / slack / github / …). Common shape: { ok, uri?, externalId?, error? }. Each adapter is free to add adapter-specific fields (e.g., slack timestamp + permalink, github PR comment id).',
    },
  },
  {
    action: 'urn:cg:action:owm:list-sources' as IRI,
    toolName: 'owm.list_sources',
    title: 'List currently-wired source adapters',
    description: 'Return the source keys + supported verbs the bridge currently has loaded. Useful before asking the main agent to navigate.',
    method: 'POST',
    targetTemplate: '{base}/owm/list_sources',
    annotations: { title: 'List wired source adapters', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [],
    outputs: {
      description: 'List of currently-wired source adapters: each entry carries the source key, the verbs it supports, and an optional short description of what kind of source it is.',
      properties: {
        sources: {
          type: 'array',
          description: 'Per-source adapter entries.',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Source key passed to navigate_source / update_source (e.g., "web", "drive", "slack").' },
              verbs: { type: 'array', description: 'Navigation verbs the adapter supports (subset of ls / cat / grep / recent).', items: { type: 'string' } },
              actions: { type: 'array', description: 'Write actions supported by update_source.', items: { type: 'string' } },
              description: { type: 'string' },
            },
            required: ['source', 'verbs'],
          },
        },
      },
      required: ['sources'],
    },
  },
];

export const owmAffordances = OWM_AFFORDANCES;

// ─────────────────────────────────────────────────────────────────────
//  Org-level operator — implemented affordance surface
// ─────────────────────────────────────────────────────────────────────
//
// The dual-audience design discipline (docs/DUAL-AUDIENCE.md) names two
// first-class audiences for the OWM vertical: the knowledge worker /
// individual contributor (entity + navigation affordances above) AND
// the org-level operator (PM lead, ops, exec, board-facing compliance
// manager).
//
// The affordances below describe the operator side of the surface.
// They are now WIRED INTO THE BRIDGE — the bridge concatenates
// `owmAffordances` (above) + `owmOperatorAffordances` (this constant)
// into one auto-registered set and dispatches handlers from
// `src/operator-publisher.ts`.
//
// All four respect the substrate's bilateral primitives:
//   - Aggregate queries v1 use the substrate's ABAC + per-graph
//     share_with as the privacy boundary (each result includes
//     `privacyMode: 'abac'`). v2 will swap in src/crypto/'s ZK
//     primitives + spec/AGGREGATE-PRIVACY.md for counts / thresholds
//     / proofs over non-shared descriptors.
//   - Org-policy descriptors are signed by an org-authority key and
//     published to the org pod; contributors discover via federated
//     read on their own ABAC scope.
//   - Compliance evidence wraps the existing src/ops/ operational
//     event builders + integrations/compliance-overlay/ so the same
//     code path that records a DeployEvent records a board-facing
//     summary descriptor.
const OWM_OPERATOR_AFFORDANCES: ReadonlyArray<Affordance> = [
  {
    action: 'urn:cg:action:owm:aggregate-decisions-query' as IRI,
    toolName: 'owm.aggregate_decisions_query',
    title: '[operator] Aggregate-privacy query over decision lineage',
    description: 'Org-operator-side: return counts / thresholds / lineage summaries over owm:Decision descriptors. Five privacy modes layered on the same surface: v1 abac (default) | v2 merkle-attested-opt-in (verifiable count + Merkle inclusion proofs over contributing descriptor URLs) | v3 zk-aggregate (homomorphic Pedersen sum + DP-Laplace noise) | v3.1 + require_signed_bounds (regulator-grade attribution) | v3.2 + epsilon_budget_max (cumulative ε discipline). Distribution-shaped metrics (mean-revision / supersession-distribution / contributor-breadth) work under v1/v2; v3 supports decision-count only. Returns the underlying count + the chosen mode\'s attestation bundle.',
    method: 'POST',
    targetTemplate: '{base}/owm/aggregate_decisions_query',
    annotations: { title: 'Aggregate-privacy decision query', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'period_from', type: 'string', required: true, description: 'ISO 8601 lower bound on cg:TemporalFacet.validFrom.' },
      { name: 'period_to', type: 'string', required: true, description: 'ISO 8601 upper bound.' },
      { name: 'scope_iri', type: 'string', required: false, description: 'Optional scope (project, team, decision class) to narrow the aggregate.' },
      { name: 'metric', type: 'string', required: true, description: 'One of: decision-count | mean-revision-count | supersession-distribution | contributor-breadth.' },
      { name: 'privacy_mode', type: 'string', required: false, description: 'One of: abac (default v1) | merkle-attested-opt-in (v2) | zk-aggregate (v3 single-sum) | zk-distribution (v3 histogram, useful for supersession-distribution metric). The bundle returned in the response advertises which path was taken.' },
      { name: 'epsilon', type: 'number', required: false, description: 'DP ε budget for zk-aggregate / zk-distribution modes. Required when privacy_mode is one of those. For zk-distribution this is the per-bucket ε; histogram-level cumulative ε under sequential composition is k * ε.' },
      { name: 'distribution_edges', type: 'array', required: false, description: 'v3 zk-distribution: ascending bucket-edge boundaries as decimal-string bigints. Required when privacy_mode=zk-distribution. Right-open buckets except the last (right-closed at distribution_max_value).' },
      { name: 'distribution_max_value', type: 'string', required: false, description: 'v3 zk-distribution: upper bound (decimal-string bigint) for the last bucket. Required when privacy_mode=zk-distribution.' },
      { name: 'epsilon_budget_max', type: 'number', required: false, description: 'v3.2: declare a cumulative ε cap for this query session. The operator constructs a per-call EpsilonBudget and refuses to run if cumulative consumption would exceed cap.' },
      { name: 'threshold_reveal_n', type: 'number', required: false, description: 'v4-partial+VSS: total pseudo-aggregators in the threshold-reveal committee for trueBlinding. When set with privacy_mode=zk-aggregate, the aggregator emits Shamir shares + Feldman VSS `coefficientCommitments` (tampered shares caught BEFORE Lagrange reconstruction) + omits trueBlinding from audit fields.' },
      { name: 'threshold_reveal_t', type: 'number', required: false, description: 'v4-partial+VSS: threshold for reconstruction. Required when threshold_reveal_n is supplied. After a successful t-of-n reconstruction, the committee signs a CommitteeReconstructionAttestation (chain-of-custody) via signCommitteeReconstruction + publishCommitteeReconstructionAttestation.' },
    ],
    outputs: {
      description: 'AggregateDecisionsQueryResult — privacy-preserving aggregate over owm:Decision descriptors in the requested period and scope, with mode-specific proof bundles (Merkle inclusion proofs for v2; homomorphic Pedersen sum + DP-Laplace noise + optional threshold-reveal VSS bundle for v3+).',
      properties: {
        metric: { type: 'string', enum: ['decision-count', 'mean-revision-count', 'supersession-distribution', 'contributor-breadth'] },
        period: { type: 'object', description: 'Echo of the queried { from, to } window.', additionalProperties: true },
        scope: { type: 'string', description: 'Optional scope IRI echo when scope_iri was supplied.' },
        value: { type: 'object', description: 'Number (for count-shaped metrics) or { [bucket: string]: number } (for distribution-shaped metrics). v3 zk-aggregate returns the DP-noised sum here.', additionalProperties: true },
        sampleSize: { type: 'integer', description: 'Number of distinct contributing descriptors that satisfied the filter.' },
        privacyMode: { type: 'string', enum: ['abac', 'merkle-attested-opt-in', 'zk-aggregate'] },
        attestation: { type: 'object', additionalProperties: true, description: 'v2 AttestedAggregateResult — Merkle root + per-leaf inclusion proofs over the contributing descriptor URLs.' },
        homomorphic: { type: 'object', additionalProperties: true, description: 'v3 AttestedHomomorphicSumResult — Pedersen commitment sum + noisySum (DP-Laplace) + optional signed-bounds attestations + optional threshold-reveal VSS bundle.' },
      },
      required: ['metric', 'period', 'value', 'sampleSize', 'privacyMode'],
    },
  },
  {
    action: 'urn:cg:action:owm:project-health-summary' as IRI,
    toolName: 'owm.project_health_summary',
    title: '[operator] Per-project rollup of follow-up flow + decision recency',
    description: 'Org-operator-side: aggregate-shaped rollup over a project — follow-up open/closed counts, decision recency, contributor breadth, supersession churn. Individual descriptors only surface where the contributor has explicitly issued share_with on them. Composes the existing owm:Project + owm:Decision + owm:FollowUp shapes.',
    method: 'POST',
    targetTemplate: '{base}/owm/project_health_summary',
    annotations: { title: 'Per-project health summary', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'project_iri', type: 'string', required: true, description: 'IRI of the owm:Project being summarized.' },
      { name: 'window_days', type: 'number', required: false, description: 'Recency window in days for "stale" thresholds. Default 30.' },
    ],
    outputs: {
      description: 'ProjectHealthSummaryResult — aggregate-shaped rollup over a single owm:Project (decision counts + recency + follow-up open/closed + note count + supersession churn). Individual descriptors only contribute when the contributor has issued share_with on them; privacyMode reports which boundary was used.',
      properties: {
        projectIri: { type: 'string' },
        windowDays: { type: 'integer' },
        decisionCount: { type: 'integer', description: 'Distinct owm:Decision IRIs in scope.' },
        recentDecisionCount: { type: 'integer', description: 'Distinct decisions with cg:validFrom inside the window.' },
        followUpCount: { type: 'integer', description: 'Distinct owm:FollowUp IRIs in scope.' },
        openFollowUpCount: { type: 'integer', description: 'Follow-ups not superseded by a closure / Counterfactual descriptor.' },
        noteCount: { type: 'integer', description: 'Distinct owm:Note descriptors in scope.' },
        supersessionChurn: { type: 'number', description: 'Mean revisions per decision (supersedes-chain depth).' },
        privacyMode: { type: 'string', enum: ['abac', 'zk-aggregate'] },
      },
      required: ['projectIri', 'windowDays', 'decisionCount', 'recentDecisionCount', 'followUpCount', 'openFollowUpCount', 'noteCount', 'supersessionChurn', 'privacyMode'],
    },
  },
  {
    action: 'urn:cg:action:owm:publish-org-policy' as IRI,
    toolName: 'owm.publish_org_policy',
    title: '[operator] Sign and publish an org-level policy descriptor',
    description: 'Org-operator-side: publish a SIGNED org-policy descriptor to the org pod — retention windows, decision-promotion thresholds, framework-compliance attestations, source-adapter governance rules. Authored by an org-authority signing key (NOT a contributor key). Contributors discover via federated read; per-graph share_with is the boundary that determines who sees what.',
    method: 'POST',
    targetTemplate: '{base}/owm/publish_org_policy',
    annotations: { title: 'Publish an org-level policy', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'policy_type', type: 'string', required: true, description: 'One of: retention | decision-promotion | compliance-attestation | source-governance.' },
      { name: 'policy_body', type: 'object', required: true, description: 'Policy content as typed descriptor data (shape depends on policy_type).' },
      { name: 'authority_did', type: 'string', required: true, description: 'DID of the org-authority signing key.' },
      { name: 'org_pod_url', type: 'string', required: true, description: 'Pod URL of the publishing org.' },
    ],
    outputs: {
      description: 'PublishOrgPolicyResult — content-stable IRI of the org-policy descriptor (re-publishing the same body under the same type yields the same IRI and supersedes the prior version) + descriptor/graph URLs + authority DID echo.',
      properties: {
        policyIri: { type: 'string', description: 'urn:owm:policy:<policy_type>:<sha16(canonicalized body)>.' },
        descriptorUrl: { type: 'string' },
        graphUrl: { type: 'string' },
        authorityDid: { type: 'string' },
      },
      required: ['policyIri', 'descriptorUrl', 'graphUrl', 'authorityDid'],
    },
  },
  {
    action: 'urn:cg:action:owm:publish-compliance-evidence' as IRI,
    toolName: 'owm.publish_compliance_evidence',
    title: '[operator] Wrap an operational event as compliance-grade evidence',
    description: 'Org-operator-side: wrap an org-level operational event (deploy, access change, key rotation, incident, quarterly review) as a compliance: true descriptor citing the relevant control IRIs (soc2:CC6.1, eu-ai-act:Article15, nist-rmf:MG-1.1, etc.). Composes src/ops/ for the event shape and integrations/compliance-overlay/ for the framework citation. The same code path that records the ops event becomes board-facing audit evidence; no parallel pipeline.',
    method: 'POST',
    targetTemplate: '{base}/owm/publish_compliance_evidence',
    annotations: { title: 'Publish compliance evidence', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'event_kind', type: 'string', required: true, description: 'One of: deploy | access-change | key-rotation | incident | quarterly-review.' },
      { name: 'event_payload', type: 'object', required: true, description: 'Payload matching the src/ops/ buildXEvent signature for the chosen kind.' },
      { name: 'framework', type: 'string', required: true, description: 'One of: soc2 | eu-ai-act | nist-rmf.' },
      { name: 'cited_controls', type: 'array', required: true, description: 'Array of control IRIs being evidenced (e.g., ["soc2:CC6.1"]).' },
      { name: 'org_pod_url', type: 'string', required: true, description: 'Pod URL of the publishing org.' },
    ],
    outputs: {
      description: 'PublishComplianceEvidenceResult — IRI of the compliance-grade evidence descriptor (compliance: true; ECDSA-signed; cites the supplied framework controls via dct:conformsTo) + descriptor/graph URLs + framework + control echo + final modal status.',
      properties: {
        evidenceIri: { type: 'string' },
        descriptorUrl: { type: 'string' },
        graphUrl: { type: 'string' },
        framework: { type: 'string', enum: ['soc2', 'eu-ai-act', 'nist-rmf'] },
        controls: { type: 'array', description: 'Cited control IRIs echoed back.', items: { type: 'string' } },
        modalStatus: { type: 'string', enum: ['Asserted', 'Counterfactual'] },
      },
      required: ['evidenceIri', 'descriptorUrl', 'graphUrl', 'framework', 'controls', 'modalStatus'],
    },
  },
];

/**
 * Implemented affordance surface for the org-level operator audience.
 * The bridge concatenates `owmAffordances` (above) +
 * `owmOperatorAffordances` (this constant) into one auto-registered
 * set; handlers live in `src/operator-publisher.ts`. Requires the
 * `OWM_DEFAULT_AUTHORITY_DID` env var (or `authority_did` per-call arg)
 * — the org-authority signing key is distinct from a contributor's DID.
 */
export const owmOperatorAffordances = OWM_OPERATOR_AFFORDANCES;
