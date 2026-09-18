/** OTLP/HTTP JSON logs -> content-free xAPI observations. Never retain raw records. */
import { digest, normalizeEvent, type TelemetryEvent } from './events.js';
import { CaptureError } from './capture.js';
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
function list(v: unknown): unknown[] { if (v === undefined) return []; if (!Array.isArray(v)) throw new CaptureError(400, 'Malformed OTLP array'); return v; }
function attributes(v: unknown): Obj {
  const out: Obj = Object.create(null);
  for (const entry of list(v)) {
    const e = obj(entry); const value = obj(e.value);
    if (typeof e.key !== 'string') continue;
    if (Object.hasOwn(out, e.key)) throw new CaptureError(400, 'Duplicate OTLP attribute');
    out[e.key] = value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue;
  }
  return out;
}
function id(v: unknown): string | undefined { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,239}$/.test(v) && !v.includes('${') ? v : undefined; }
function number(v: unknown): number | undefined { const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? n : undefined; }
export interface OtlpResult { events: TelemetryEvent[]; rejected: number; records: number }
export function normalizeOtlpLogs(input: unknown, source: string, mode: 'live' | 'validation', accountId?: string): OtlpResult {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new CaptureError(400, 'OTLP JSON body must be at most 1 MiB');
  if (!Array.isArray(obj(input).resourceLogs)) throw new CaptureError(400, 'resourceLogs is required');
  const events: TelemetryEvent[] = []; let rejected = 0; let records = 0;
  for (const resource of list(obj(input).resourceLogs)) {
    const r = obj(resource); const ra = attributes(obj(r.resource).attributes);
    for (const scope of list(r.scopeLogs)) for (const raw of list(obj(scope).logRecords)) {
      if (++records > 500) throw new CaptureError(413, 'Maximum 500 log records per export');
      const record = obj(raw); const a = { ...ra, ...attributes(record.attributes) };
      // event.name is defined by Claude; body is intentionally never read.
      if (source === 'claude-cowork-otel' && (!accountId || a['user.account_uuid'] !== accountId)) { rejected++; continue; }
      const name = a['event.name'] ?? record.eventName;
      const kinds: Record<string, TelemetryEvent['kind']> = { user_prompt: 'input-received', assistant_response: 'response-completed', tool_result: a.success === 'false' || a.success === false ? 'tool-failed' : 'tool-completed', api_request: 'model-completed', api_error: 'model-failed' };
      const kind = kinds[String(name)];
      const session = id(a['session.id']);
      const timestamp = typeof a['event.timestamp'] === 'string' ? a['event.timestamp'] : undefined;
      if (!kind || !session || !timestamp || !Number.isFinite(Date.parse(timestamp))) { rejected++; continue; }
      const observed_at = new Date(timestamp).toISOString();
      const tool = id(a.tool_use_id); const request = id(a.request_id) ?? id(a.client_request_id);
      const turn = id(a['prompt.id']); const message = id(a['message.uuid']);
      const sequence = number(a['event.sequence']);
      if ((kind.startsWith('tool-') && !tool) || (kind.startsWith('model-') && !request) || (sequence === undefined && !tool && !request && !message && !turn)) { rejected++; continue; }
      const usage: NonNullable<TelemetryEvent['usage']> = {};
      // Cost is explicitly estimated by the provider, so omit it from measured usage.
      for (const [key, attr] of Object.entries({ duration_ms: 'duration_ms', input_tokens: 'input_tokens', output_tokens: 'output_tokens', cached_input_tokens: 'cache_read_tokens' })) {
        const n = number(a[attr]);
        if (n !== undefined && (!key.endsWith('tokens') || Number.isSafeInteger(n))) Object.assign(usage, { [key]: n });
      }
      const event = normalizeEvent({ kind, session_id: session, source,
        source_event_id: digest([session, name, timestamp, sequence, tool, request, message, turn]),
        observed_at, capture_mode: mode, coverage: 'runtime-adapter', session_scope: 'host-session',
        ...(turn ? { turn_id: turn } : {}), ...(tool ? { tool_use_id: tool } : {}),
        ...(kind.startsWith('model-') ? { generation_id: request } : {}),
        ...(id(a.model) ? { model: a.model } : {}), ...(id(a.tool_name) ? { tool_name: a.tool_name } : {}),
        provider: 'anthropic', ...(Object.keys(usage).length ? { usage } : {}),
        ...(kind.endsWith('failed') ? { status: 'error' } : {}),
      });
      events.push(event);
    }
  }
  const unique = new Map<string, TelemetryEvent>();
  for (const event of events) {
    const prior = unique.get(event.source_event_id);
    if (prior && digest(prior) !== digest(event)) throw new CaptureError(409, 'Conflicting records in export');
    unique.set(event.source_event_id, event);
  }
  return { events: [...unique.values()], rejected, records };
}
