import type { IRI } from '@interego/core';
import type { Affordance, AffordanceInput } from '../_shared/affordance-mcp/index.js';

export const queryInputs: readonly AffordanceInput[] = [
  { name: 'session_id', type: 'string', required: false, description: 'Optional opaque session ID; empty means all observed sessions.' },
  { name: 'source', type: 'string', required: false, description: 'Optional reporting adapter, for example codex-hooks.' },
  { name: 'model', type: 'string', required: false, description: 'Optional exact model identifier reported by the source.' },
  { name: 'agent_id', type: 'string', required: false, description: 'Optional exact runtime agent identifier.' },
  { name: 'tool_name', type: 'string', required: false, description: 'Optional exact tool name.' },
  { name: 'status', type: 'string', required: false, description: 'Optional explicit event outcome. Completion alone does not mean success.', enum: ['ok', 'error', 'cancelled', 'unknown'] },
  { name: 'kind', type: 'string', required: false, description: 'Optional event kind, for example tool-failed.' },
  { name: 'capture_mode', type: 'string', required: false, description: 'Optional live, backfill or validation observation filter.', enum: ['live', 'backfill', 'validation'] },
  { name: 'since', type: 'string', required: false, description: 'Optional inclusive UTC event time, for example 2026-09-16T00:00:00Z.' },
  { name: 'until', type: 'string', required: false, description: 'Optional inclusive UTC event time.' },
  { name: 'limit', type: 'integer', required: false, description: 'Event page size (default 50). Aggregates cover the full matching snapshot.', minimum: 1, maximum: 200 },
  { name: 'offset', type: 'integer', required: false, description: 'Event page offset (default 0).', minimum: 0, maximum: 1000000 },
  { name: 'view', type: 'string', required: false, description: 'Choose the report presentation.', enum: ['sessions', 'timeline', 'report', 'export'] },
];
export const telemetryAffordances: readonly Affordance[] = [
  { action: 'urn:iep:action:llm-telemetry:profile' as IRI, toolName: 'llm_telemetry.profile', title: 'Read the LLM xAPI profile',
    description: 'Read the versioned, general LLM telemetry vocabulary, statement templates and observation-stream pattern.',
    method: 'GET', targetTemplate: '{base}/llm-telemetry/profile', mediaType: 'application/ld+json', externallyRouted: true,
    inputs: [], outputs: { description: 'Versioned ADL xAPI Profile document.', properties: { id: { type: 'string' }, type: { type: 'string' }, versions: { type: 'array', items: { type: 'object', additionalProperties: true } }, concepts: { type: 'array', items: { type: 'object', additionalProperties: true } }, templates: { type: 'array', items: { type: 'object', additionalProperties: true } }, patterns: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
    annotations: { title: 'Read LLM telemetry profile', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['entry', 'profiles', 'telemetry'] } },
  { action: 'urn:iep:action:llm-telemetry:ingest' as IRI, toolName: 'llm_telemetry.ingest', title: 'Record LLM observations',
    description: 'Sign {events:[...]} with the authenticated observer using sign_request then act, or act(sign_payload:true). Accepts 1–20 allowlisted metadata events, validates xAPI in the actual own-lens LRS, then awaits encrypted PGSL persistence. Retry identical source_event_id and metadata; conflicting reuse returns 409. Content, credentials and transcripts are excluded.',
    method: 'POST', targetTemplate: '{base}/agent/llm-telemetry/ingest', mediaType: 'application/json', externallyRouted: true,
    inputs: [{ name: 'events', type: 'array', itemType: 'object', required: true, minItems: 1, description: 'Metadata observations conforming to /llm-telemetry/event-schema. Actor is bound by verified signature.' }],
    outputs: { description: 'LRS acceptance and awaited encrypted persistence receipts. A 502 can represent a partial commit; retry identical event IDs.', properties: { ok: { type: 'boolean' }, lrsAccepted: { type: 'boolean' }, durable: { type: 'boolean' }, statementIds: { type: 'array', items: { type: 'string' } }, receipts: { type: 'array', items: { type: 'object', additionalProperties: true } }, error: { type: 'string' } } },
    annotations: { title: 'Record LLM observations', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['telemetry'] } },
  { action: 'urn:iep:action:llm-telemetry:query' as IRI, toolName: 'llm_telemetry.query', title: 'Query sessions and insights',
    description: 'Sign the query with your bound identity. Read only your observer records from the actual LRS lens and a fresh encrypted PGSL snapshot, preserving provenance and exposing unavailable sources and conflicting IDs. Returns sessions, timeline, measured usage, capture-gap insights and paginated xAPI statements. No prompt or response text is collected.',
    method: 'POST', targetTemplate: '{base}/agent/llm-telemetry/query', mediaType: 'application/json', externallyRouted: true,
    inputs: queryInputs,
    outputs: { description: 'Own-observer snapshot with source coverage, measured totals, session summaries, evidence-backed insights, an xAPI event page and the affordance-derived HyperMarkdown view.', properties: { ok: { type: 'boolean' }, observer: { type: 'string' }, profile: { type: 'string' }, coverage: { type: 'object', additionalProperties: true }, totals: { type: 'object', additionalProperties: true }, sessions: { type: 'array', items: { type: 'object', additionalProperties: true } }, insights: { type: 'array', items: { type: 'object', additionalProperties: true } }, statements: { type: 'array', items: { type: 'object', additionalProperties: true } }, pagination: { type: 'object', additionalProperties: true }, view: { type: 'object', additionalProperties: true }, error: { type: 'string' } } },
    annotations: { title: 'Query LLM observations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, appliesTo: { collections: ['entry', 'profiles', 'telemetry'] } },
];
