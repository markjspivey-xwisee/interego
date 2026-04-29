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
    inputs: [
      { name: 'name', type: 'string', required: true, description: 'Display name.' },
      { name: 'role', type: 'string', required: false, description: 'Free-text role / title.' },
      { name: 'organization', type: 'string', required: false, description: 'Organizational affiliation.' },
      { name: 'did', type: 'string', required: false, description: 'Optional DID for agent-people; humans omit.' },
      { name: 'aliases', type: 'array', required: false, description: 'Alternate names / handles for matching.', itemType: 'string' },
      { name: 'notes', type: 'string', required: false, description: 'Free-form notes.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL (defaults from env).' },
    ],
  },
  {
    action: 'urn:cg:action:owm:upsert-project' as IRI,
    toolName: 'owm.upsert_project',
    title: 'Create or update a project record',
    description: 'Upsert an owm:Project descriptor. Projects are owm:WorkingScope subclasses — composable with olke: knowledge-state vocabulary (Tacit / Articulate / Collective / Institutional). Subsequent upserts supersede.',
    method: 'POST',
    targetTemplate: '{base}/owm/upsert_project',
    inputs: [
      { name: 'name', type: 'string', required: true, description: 'Project name.' },
      { name: 'objective', type: 'string', required: false, description: 'One-sentence objective.' },
      { name: 'olke_stage', type: 'string', required: false, description: 'OLKE knowledge stage.', enum: ['Tacit', 'Articulate', 'Collective', 'Institutional'] },
      { name: 'participants', type: 'array', required: false, description: 'IRIs of owm:Person records who are working on this project.', itemType: 'string' },
      { name: 'status', type: 'string', required: false, description: 'Free-text status note.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
  },
  {
    action: 'urn:cg:action:owm:record-decision' as IRI,
    toolName: 'owm.record_decision',
    title: 'Record a decision with modal status',
    description: 'Record an owm:Decision descriptor. Modal status defaults to Hypothetical (decision pending). Use Asserted for committed decisions. To reverse a decision, call again with modal_status=Counterfactual and supersedes=[<prior decision IRI>].',
    method: 'POST',
    targetTemplate: '{base}/owm/record_decision',
    inputs: [
      { name: 'topic', type: 'string', required: true, description: 'Short topic / what is being decided.' },
      { name: 'rationale', type: 'string', required: true, description: 'The argument or evidence behind the decision.' },
      { name: 'modal_status', type: 'string', required: false, description: 'Default Hypothetical (pending).', enum: ['Hypothetical', 'Asserted', 'Counterfactual'] },
      { name: 'project_iri', type: 'string', required: false, description: 'Project this decision belongs to.' },
      { name: 'decided_by', type: 'array', required: false, description: 'IRIs of owm:Person records who made the decision.', itemType: 'string' },
      { name: 'supersedes', type: 'array', required: false, description: 'Prior decision IRIs this one supersedes.', itemType: 'string' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
  },
  {
    action: 'urn:cg:action:owm:queue-followup' as IRI,
    toolName: 'owm.queue_followup',
    title: 'Queue a follow-up to surface later',
    description: 'Queue an owm:FollowUp with a due-date (ISO 8601). The bridge\'s list_overdue_followups affordance surfaces items whose due_at has passed, so a cron or interactive query closes the observe-and-revise loop.',
    method: 'POST',
    targetTemplate: '{base}/owm/queue_followup',
    inputs: [
      { name: 'topic', type: 'string', required: true, description: 'What needs follow-up.' },
      { name: 'due_at', type: 'string', required: true, description: 'ISO 8601 datetime when this should surface.' },
      { name: 'context_iri', type: 'string', required: false, description: 'IRI of the project / decision this follow-up relates to.' },
      { name: 'watcher_did', type: 'string', required: false, description: 'DID of the agent or person responsible for the follow-up.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
  },
  {
    action: 'urn:cg:action:owm:record-note' as IRI,
    toolName: 'owm.record_note',
    title: 'Record a content-addressed note',
    description: 'Capture a free-form insight as a content-addressed pgsl:Atom + descriptor. Two observers minting the same verbatim text mint the same atom IRI — duplicate notes collapse structurally.',
    method: 'POST',
    targetTemplate: '{base}/owm/record_note',
    inputs: [
      { name: 'text', type: 'string', required: true, description: 'The note content. Stored as a content-addressed atom.' },
      { name: 'subject_iris', type: 'array', required: false, description: 'IRIs the note is about (people, projects, decisions).', itemType: 'string' },
      { name: 'tags', type: 'array', required: false, description: 'Free-text tags.', itemType: 'string' },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
  },
  {
    action: 'urn:cg:action:owm:list-overdue-followups' as IRI,
    toolName: 'owm.list_overdue_followups',
    title: 'List overdue follow-ups',
    description: 'Return follow-ups whose due_at is on or before now (or `now` arg). Used by cron schedulers and by interactive agents that want to surface pending work at session start.',
    method: 'POST',
    targetTemplate: '{base}/owm/list_overdue_followups',
    inputs: [
      { name: 'now', type: 'string', required: false, description: 'Optional ISO 8601 datetime to evaluate against (default: server clock).' },
      { name: 'limit', type: 'integer', required: false, description: 'Maximum items to return (default 50).', minimum: 1, maximum: 500 },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
  },
  {
    action: 'urn:cg:action:owm:discover-subgraph' as IRI,
    toolName: 'owm.discover_subgraph',
    title: 'Walk the org graph for a subject',
    description: 'Affordance-walk the org pod for descriptors related to a subject IRI. Returns the manifest entries (descriptor URLs + facet summary + supersedes chain head). Caller can then get_descriptor on URLs of interest.',
    method: 'POST',
    targetTemplate: '{base}/owm/discover_subgraph',
    inputs: [
      { name: 'subject_iri', type: 'string', required: true, description: 'IRI of the entity to walk from (person/project/decision).' },
      { name: 'depth', type: 'integer', required: false, description: 'How many hops to traverse (default 1).', minimum: 1, maximum: 4 },
      { name: 'pod_url', type: 'string', required: false, description: 'Org pod URL.' },
    ],
  },

  // ── Navigation surface (per-source isolation) ──────────────

  {
    action: 'urn:cg:action:owm:navigate-source' as IRI,
    toolName: 'owm.navigate_source',
    title: 'Read from an external source via uniform verbs',
    description: 'Read an external information source (web, drive, slack, github, ...) using uniform verbs (ls / cat / grep / recent). Each source runs as an isolated sub-handler inside the bridge so the main agent\'s context is never polluted by source-specific tool noise. The source\'s native quirks (auth, pagination, content-type) are handled inside the sub-handler.',
    method: 'POST',
    targetTemplate: '{base}/owm/navigate_source',
    inputs: [
      { name: 'source', type: 'string', required: true, description: 'Source key (e.g., "web", "drive", "slack"). Use list_sources to enumerate currently-loaded adapters.' },
      { name: 'verb', type: 'string', required: true, description: 'Navigation verb.', enum: ['ls', 'cat', 'grep', 'recent'] },
      { name: 'args', type: 'object', required: true, description: 'Verb-specific arguments. cat: { uri }. grep: { pattern, scope? }. ls: { path? }. recent: { window_minutes? }.' },
    ],
  },
  {
    action: 'urn:cg:action:owm:update-source' as IRI,
    toolName: 'owm.update_source',
    title: 'Write to an external source via uniform action',
    description: 'Write back to an external source (post Slack message, append note to drive doc, comment on PR). Uniform write surface; per-source sub-handler owns the protocol.',
    method: 'POST',
    targetTemplate: '{base}/owm/update_source',
    inputs: [
      { name: 'source', type: 'string', required: true, description: 'Source key.' },
      { name: 'action', type: 'string', required: true, description: 'Source-specific action (post, append, comment, ...).' },
      { name: 'args', type: 'object', required: true, description: 'Action-specific arguments.' },
    ],
  },
  {
    action: 'urn:cg:action:owm:list-sources' as IRI,
    toolName: 'owm.list_sources',
    title: 'List currently-wired source adapters',
    description: 'Return the source keys + supported verbs the bridge currently has loaded. Useful before asking the main agent to navigate.',
    method: 'POST',
    targetTemplate: '{base}/owm/list_sources',
    inputs: [],
  },
];

export const owmAffordances = OWM_AFFORDANCES;
