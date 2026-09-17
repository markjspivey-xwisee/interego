import { createHash } from 'node:crypto';
import { EVENTS, META, USAGE, INTENT, NS, VERSION, type EventKind } from './profile.js';
export type Json = Record<string, any>;
export interface TelemetryEvent {
  kind: EventKind; session_id: string; source: string; source_event_id: string;
  capture_mode: 'live' | 'backfill' | 'validation'; observed_at?: string;
  turn_id?: string; tool_use_id?: string; agent_id?: string; parent_agent_id?: string;
  generation_id?: string; trace_id?: string; span_id?: string; parent_span_id?: string;
  artifact_id?: string; target_agent_id?: string;
  model?: string; provider?: string; tool_name?: string; agent_type?: string;
  initiator_kind?: 'human' | 'agent' | 'unknown'; status?: 'ok' | 'error' | 'cancelled' | 'unknown';
  coverage?: 'hook' | 'runtime-adapter' | 'manual-observation' | 'server-observation';
  session_scope?: 'host-session' | 'relay-day';
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; duration_ms?: number; cost?: number; currency?: string };
}
const ID_KEYS = ['session_id', 'source', 'source_event_id', 'turn_id', 'tool_use_id', 'agent_id', 'parent_agent_id', 'generation_id', 'trace_id', 'span_id', 'parent_span_id', 'model', 'provider', 'tool_name', 'agent_type', 'artifact_id', 'target_agent_id'];
const ENUMS: Record<string, readonly string[]> = { kind: Object.keys(EVENTS), capture_mode: ['live', 'backfill', 'validation'], initiator_kind: ['human', 'agent', 'unknown'], status: ['ok', 'error', 'cancelled', 'unknown'], coverage: ['hook', 'runtime-adapter', 'manual-observation', 'server-observation'], session_scope: ['host-session', 'relay-day'] };
const ALLOWED = new Set([...ID_KEYS, ...Object.keys(ENUMS), 'observed_at', 'usage']);
export function eventSchema(): Json {
  return { '$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': `${NS}event-schema`, type: 'object', additionalProperties: false,
    required: ['kind', 'session_id', 'source', 'source_event_id', 'capture_mode'],
    properties: { ...Object.fromEntries(ID_KEYS.map(k => [k, { type: 'string', minLength: 1, maxLength: 240, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:@/+\\-]*$' }])),
      ...Object.fromEntries(Object.entries(ENUMS).map(([k, values]) => [k, { enum: values }])), observed_at: { type: 'string', format: 'date-time' },
      usage: { type: 'object', additionalProperties: false, properties: { input_tokens: { type: 'integer', minimum: 0 }, output_tokens: { type: 'integer', minimum: 0 }, cached_input_tokens: { type: 'integer', minimum: 0 }, duration_ms: { type: 'number', minimum: 0 }, cost: { type: 'number', minimum: 0 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }, dependentRequired: { cost: ['currency'], currency: ['cost'] } } },
    allOf: [['tool-', 'tool_use_id'], ['agent-', 'agent_id'], ['model-', 'generation_id']].map(([prefix, field]) => ({ if: { properties: { kind: { pattern: `^${prefix}` } } }, then: { required: [field] } })),
  };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
/** Deterministic UUIDv5 with the standard URL namespace. Inputs include the observer. */
export function stableUuid(value: string): string {
  const h = createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')).update(value).digest();
  h[6] = (h[6]! & 15) | 80; h[8] = (h[8]! & 63) | 128;
  const s = h.subarray(0, 16).toString('hex'); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function normalizeEvent(input: unknown): TelemetryEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 8192) throw new Error('event must be a metadata object of at most 8 KiB');
  const event: Json = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ALLOWED.has(k)) throw new Error(`unsupported event field: ${k}`);
    if (v === undefined || v === '') continue;
    if (ID_KEYS.includes(k)) {
      if (typeof v !== 'string' || v.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]*$/.test(v) || v.includes('${')) throw new Error(`${k} must be a bounded opaque identifier, not content or a path`);
      event[k] = v;
    } else if (ENUMS[k]) {
      if (!ENUMS[k]!.includes(v as string)) throw new Error(`invalid ${k}`);
      event[k] = v;
    } else if (k === 'observed_at') {
      if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('observed_at must be a UTC timestamp');
      event[k] = new Date(v).toISOString();
    } else if (k === 'usage') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('usage must be an object');
      const usage: Json = {};
      for (const [uk, uv] of Object.entries(v)) {
        if (uk === 'currency') { if (typeof uv !== 'string' || !/^[A-Z]{3}$/.test(uv)) throw new Error('currency must be an ISO 4217 code'); }
        else if (!['input_tokens', 'output_tokens', 'cached_input_tokens', 'duration_ms', 'cost'].includes(uk) || typeof uv !== 'number' || !Number.isFinite(uv) || uv < 0 || (uk.endsWith('tokens') && !Number.isSafeInteger(uv))) throw new Error('invalid measured usage');
        usage[uk] = uv;
      }
      if ((usage.cost === undefined) !== (usage.currency === undefined)) throw new Error('cost and currency must be supplied together');
      if (Object.keys(usage).length) event.usage = usage;
    }
  }
  for (const k of ['kind', 'session_id', 'source', 'source_event_id', 'capture_mode']) if (!event[k]) throw new Error(`${k} is required`);
  if (event.kind.startsWith('tool-') && !event.tool_use_id) throw new Error('tool events require tool_use_id');
  if (event.kind.startsWith('agent-') && !event.agent_id) throw new Error('agent events require agent_id');
  if (event.kind.startsWith('model-') && !event.generation_id) throw new Error('model events require generation_id');
  return event as TelemetryEvent;
}
export const sessionRegistration = (actor: string, source: string, session: string) => stableUuid(canonical([actor, source, session]));
export function eventStatement(actor: string, event: TelemetryEvent, now: string): Json {
  const registration = sessionRegistration(actor, event.source, event.session_id);
  const activityType = EVENTS[event.kind][0];
  const objectKey = activityType === 'session' ? event.session_id : activityType === 'tool-call' ? event.tool_use_id! : activityType === 'agent-run' ? event.agent_id! : activityType === 'generation' ? event.generation_id! : activityType === 'turn' ? event.turn_id ?? event.source_event_id : event.source_event_id;
  const activity = (type: string, key: string) => ({ objectType: 'Activity', id: `${NS}instances/${type}/${stableUuid(canonical([actor, event.source, event.session_id, key]))}`, definition: { type: `${NS}activities/${type}` } });
  const { observed_at, usage, ...metadata } = event;
  return {
    id: stableUuid(canonical([actor, event.source, event.source_event_id])),
    actor: { objectType: 'Agent', account: { homePage: 'https://identity.interego.xwisee.com', name: actor } },
    verb: { id: `${NS}verbs/${event.kind}`, display: { en: EVENTS[event.kind][1] } },
    object: activity(activityType, objectKey),
    timestamp: observed_at ?? now,
    context: { registration, contextActivities: { category: [{ id: VERSION }], grouping: [activity('session', event.session_id),
      ...(event.agent_id && activityType !== 'agent-run' ? [activity('agent-run', event.agent_id)] : []),
      ...(event.parent_agent_id ? [activity('agent-run', event.parent_agent_id)] : [])],
      ...(event.target_agent_id ? { other: [activity('agent-run', event.target_agent_id)] } : {}),
      ...(event.turn_id && activityType !== 'turn' ? { parent: [activity('turn', event.turn_id)] } : {}) },
      extensions: { [META]: { ...metadata, time_basis: observed_at ? 'source' : 'collector' }, [INTENT]: digest(event) } },
    ...(usage || event.status ? { result: { ...(usage ? { extensions: { [USAGE]: usage } } : {}), ...(event.status === 'error' ? { success: false } : {}) } } : {}),
  };
}
export function telemetryMetadata(s: Json): Json | null {
  const m = s.context?.extensions?.[META];
  return s.context?.contextActivities?.category?.some((c: Json) => c.id === VERSION) && m && typeof m === 'object' && !Array.isArray(m) && Object.hasOwn(EVENTS, m.kind) ? m : null;
}
