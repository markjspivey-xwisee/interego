import type { IRI } from '@interego/core';
import type { Affordance, AffordanceInput } from '../_shared/affordance-mcp/index.js';

export const queryInputs: readonly AffordanceInput[] = [
  { name: 'session_id', type: 'string', required: false, description: 'Optional opaque session ID; empty means all observed sessions.' },
  { name: 'source', type: 'string', required: false, description: 'Optional reporting adapter, for example codex-hooks.' },
  { name: 'model', type: 'string', required: false, description: 'Optional exact model identifier reported by the source.' },
  { name: 'runtime_agent_id', type: 'string', required: false, description: 'Optional exact runtime agent identifier. Distinct from the signature-bound observer agent_id.' },
  { name: 'tool_name', type: 'string', required: false, description: 'Optional exact tool name.' },
  { name: 'status', type: 'string', required: false, description: 'Optional explicit event outcome. Completion alone does not mean success.', enum: ['ok', 'error', 'cancelled', 'unknown'] },
  { name: 'kind', type: 'string', required: false, description: 'Optional event kind, for example tool-failed.' },
  { name: 'capture_mode', type: 'string', required: false, description: 'Optional live, backfill or validation observation filter.', enum: ['live', 'backfill', 'validation'] },
  { name: 'capture_channel', type: 'string', required: false, description: 'Select server, client or explicit manual observations. Multiple channels may observe the same work.', enum: ['server', 'client', 'manual'] },
  { name: 'since', type: 'string', required: false, description: 'Optional inclusive UTC event time, for example 2026-09-16T00:00:00Z.' },
  { name: 'until', type: 'string', required: false, description: 'Optional inclusive UTC event time.' },
  { name: 'limit', type: 'integer', required: false, description: 'Event page size (default 50). Aggregates cover the full matching snapshot.', minimum: 1, maximum: 200 },
  { name: 'offset', type: 'integer', required: false, description: 'Event page offset (default 0).', minimum: 0, maximum: 1000000 },
  { name: 'view', type: 'string', required: false, description: 'Choose the report presentation.', enum: ['sessions', 'timeline', 'report', 'export'] },
];
const observationAffordances: readonly Affordance[] = [
  { action: 'urn:iep:action:llm-telemetry:profile' as IRI, toolName: 'llm_telemetry.profile', title: 'Read the LLM xAPI profile',
    description: 'Read the versioned, general LLM telemetry vocabulary, statement templates and observation-stream pattern.',
    method: 'GET', targetTemplate: '{base}/llm-telemetry/profile', mediaType: 'application/ld+json', externallyRouted: true,
    inputs: [], outputs: { description: 'Versioned ADL xAPI Profile document.', properties: { id: { type: 'string' }, type: { type: 'string' }, versions: { type: 'array', items: { type: 'object', additionalProperties: true } }, concepts: { type: 'array', items: { type: 'object', additionalProperties: true } }, templates: { type: 'array', items: { type: 'object', additionalProperties: true } }, patterns: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
    annotations: { title: 'Read LLM telemetry profile', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['entry', 'profiles', 'telemetry'] } },
  { action: 'urn:iep:action:llm-telemetry:ingest' as IRI, toolName: 'llm_telemetry.ingest', title: 'Record LLM observations',
    description: 'Sign {events:[...]} with the authenticated observer using sign_request then act, or act(sign_payload:true). Server and client deliveries require their independent capture opt-in; explicit manual-observation events are a signed one-off action. Accepts 1–20 allowlisted metadata events, validates xAPI in the actual own-lens LRS, then awaits encrypted PGSL persistence. Retry identical source_event_id and metadata; conflicting reuse returns 409. Content, credentials and transcripts are excluded.',
    method: 'POST', targetTemplate: '{base}/agent/llm-telemetry/ingest', mediaType: 'application/json', externallyRouted: true,
    inputs: [{ name: 'events', type: 'array', itemType: 'object', required: true, minItems: 1, description: 'Metadata observations conforming to /llm-telemetry/event-schema. Actor is bound by verified signature.' }, { name: 'capture_revision', type: 'integer', required: false, minimum: 0, description: 'Required for server observations: the durable consent revision read before the operation.' }],
    outputs: { description: 'LRS acceptance and awaited encrypted persistence receipts. A 502 can represent a partial commit; retry identical event IDs.', properties: { ok: { type: 'boolean' }, lrsAccepted: { type: 'boolean' }, durable: { type: 'boolean' }, statementIds: { type: 'array', items: { type: 'string' } }, receipts: { type: 'array', items: { type: 'object', additionalProperties: true } }, error: { type: 'string' } } },
    annotations: { title: 'Record LLM observations', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['telemetry'] } },
  { action: 'urn:iep:action:llm-telemetry:query' as IRI, toolName: 'llm_telemetry.query', title: 'Query sessions and insights',
    description: 'Sign the query with your bound identity. Read only your observer records from the actual LRS lens and a fresh encrypted PGSL snapshot, preserving provenance and exposing unavailable sources and conflicting IDs. Returns sessions, timeline, measured usage, capture-gap insights and paginated xAPI statements. No prompt or response text is collected.',
    method: 'POST', targetTemplate: '{base}/agent/llm-telemetry/query', mediaType: 'application/json', externallyRouted: true,
    inputs: queryInputs,
    outputs: { description: 'Own-observer snapshot with source coverage, measured totals, session summaries, evidence-backed insights, an xAPI event page and the affordance-derived HyperMarkdown view.', properties: { ok: { type: 'boolean' }, observer: { type: 'string' }, profile: { type: 'string' }, capture: { type: 'object', additionalProperties: true }, capture_unavailable: { type: 'boolean' }, coverage: { type: 'object', additionalProperties: true }, totals: { type: 'object', additionalProperties: true }, sessions: { type: 'array', items: { type: 'object', additionalProperties: true } }, insights: { type: 'array', items: { type: 'object', additionalProperties: true } }, statements: { type: 'array', items: { type: 'object', additionalProperties: true } }, pagination: { type: 'object', additionalProperties: true }, view: { type: 'object', additionalProperties: true }, error: { type: 'string' } } },
    annotations: { title: 'Query LLM observations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['entry', 'profiles', 'telemetry'] } },
];

const captureOutputs = { description: 'Durable independent capture preferences for this authenticated observer, plus a HyperMarkdown view. Client opt-in does not attest host installation or hook trust.', properties: { ok: { type: 'boolean' as const }, preferences: { type: 'object' as const, additionalProperties: true }, scope: { type: 'string' as const }, client_host_activation: { type: 'string' as const }, view: { type: 'object' as const, additionalProperties: true }, error: { type: 'string' as const } } };
export const captureReadAffordance: Affordance = {
  action: 'urn:iep:action:llm-telemetry:capture-read' as IRI, toolName: 'llm_telemetry.capture_read', title: 'Read capture settings',
  description: 'Read your independent server and client reporting opt-ins. Both default to off. The server observer covers Interego /mcp requests; client reporters use the existing connection with host hook configuration and review.',
  method: 'POST', targetTemplate: '{base}/agent/llm-telemetry/capture/read', mediaType: 'application/json', externallyRouted: true,
  inputs: [], outputs: captureOutputs, annotations: { title: 'Capture settings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['entry', 'telemetry'] },
};
export const captureUpdateAffordance: Affordance = {
  action: 'urn:iep:action:llm-telemetry:capture-update' as IRI, toolName: 'llm_telemetry.capture_update', title: 'Change capture settings',
  description: 'Opt this authenticated observer into server reporting, client reporting, both or neither. Omitted switches retain their value. Disabling refuses new automatic deliveries; it does not erase history or disable hooks in another host. Client installation and hook trust remain separate.',
  method: 'POST', targetTemplate: '{base}/agent/llm-telemetry/capture/update', mediaType: 'application/json', externallyRouted: true,
  inputs: [
    { name: 'server_enabled', type: 'boolean', required: false, description: 'Allow automatic metadata recording for authenticated calls through Interego MCP.' },
    { name: 'client_enabled', type: 'boolean', required: false, description: 'Accept reports from client hooks and runtime adapters. Does not install or trust a collector.' },
    { name: 'expected_revision', type: 'integer', required: false, minimum: 0, description: 'The revision displayed by Capture settings. A stale change is refused.' },
  ], outputs: captureOutputs, annotations: { title: 'Change capture settings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['telemetry'] },
};
export const captureAffordances: readonly Affordance[] = [captureReadAffordance, captureUpdateAffordance];
export const clientSetupAffordance: Affordance = {
  action: 'urn:iep:action:llm-telemetry:client-setup' as IRI, toolName: 'llm_telemetry.client_setup', title: 'Set up client reporting',
  description: 'Read hosted metadata-only hook configuration for an existing Interego MCP connection. Supports Codex CLI and Claude Code CLI/VS Code contracts; other surfaces report their coverage limits explicitly. Does not install a plugin, connect another server, change consent or approve host trust. Configuration availability is not proof of live delivery.',
  method: 'POST', targetTemplate: '{base}/agent/llm-telemetry/client-setup', mediaType: 'application/json', externallyRouted: true,
  inputs: [
    { name: 'client', type: 'string', required: false, description: 'Runtime or surface to configure; omitted means support overview.', enum: ['overview', 'codex', 'claude-code', 'claude-code-vscode', 'codex-vscode', 'chatgpt-work', 'chatgpt-web', 'claude-web'] },
    { name: 'server_name', type: 'string', required: false, description: 'Exact existing MCP server name in the selected client. Required to generate configuration. No credentials or new connection.' },
  ],
  outputs: { description: 'Client support, requirements, configuration and verification query, with an executable HyperMarkdown setup view. No activation is attested.', properties: {
    ok: { type: 'boolean' }, client: { type: 'string' }, status: { type: 'string' },
    host_activation: { type: 'string' }, view: { type: 'object', additionalProperties: true },
  } },
  annotations: { title: 'Client reporting setup', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['entry', 'telemetry'] },
};
export const collectorAffordances: readonly Affordance[] = [
  { action: 'urn:iep:action:llm-telemetry:collector-create' as IRI, toolName: 'llm_telemetry.collector_create', title: 'Create native collector credential',
    description: 'Create a private, expiring, ingest-only credential bound to this authenticated observer. Requires client consent. Returns native Claude Code OTLP HTTP/JSON settings. Does not configure a host. Keep the credential private.',
    method: 'POST', targetTemplate: '{base}/agent/llm-telemetry/collector/create', mediaType: 'application/json', externallyRouted: true,
    inputs: [{ name: 'source', type: 'string', required: false, enum: ['claude-code-otel', 'claude-cowork-otel'], description: 'Native exporter source. Defaults to Claude Code.' }, { name: 'account_id', type: 'string', required: false, description: 'Your exact user.account_uuid; mandatory for organization-wide Cowork export so other users are excluded.' }, { name: 'capture_mode', type: 'string', required: true, enum: ['live', 'validation'], description: 'Live native observations or explicitly separated validation fixtures.' }],
    outputs: { description: 'Private collector credential and native settings; activation remains unverified.', properties: { ok: { type: 'boolean' }, token: { type: 'string' }, collector_id: { type: 'string' }, configuration: { type: 'object', additionalProperties: true } } },
    annotations: { title: 'Create collector', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, appliesTo: { collections: ['telemetry'] } },
  { action: 'urn:iep:action:llm-telemetry:collector-revoke' as IRI, toolName: 'llm_telemetry.collector_revoke', title: 'Revoke collector credential',
    description: 'Revoke one own collector credential. Existing observations are preserved.',
    method: 'POST', targetTemplate: '{base}/agent/llm-telemetry/collector/revoke', mediaType: 'application/json', externallyRouted: true,
    inputs: [{ name: 'collector_id', type: 'string', required: true, description: 'Collector ID returned at creation.' }],
    outputs: { description: 'Confirmed revocation.', properties: { ok: { type: 'boolean' }, revoked: { type: 'boolean' } } },
    annotations: { title: 'Revoke collector', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['telemetry'] } },
];
export const telemetryAffordances: readonly Affordance[] = [...observationAffordances, ...captureAffordances, clientSetupAffordance, ...collectorAffordances];
