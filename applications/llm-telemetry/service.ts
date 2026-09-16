import { writeSelfXapi, type SelfXapiDependencies, type SelfXapiReply } from '../foxxi-content-intelligence/src/self-xapi.js';
import { normalizeEvent, eventStatement, telemetryMetadata, digest, type Json } from './events.js';
import { INTENT, USAGE, VERSION } from './profile.js';

export interface TelemetrySnapshot {
  statements: Json[];
  durableIds: string[];
  durableAvailable: boolean;
  lrsAvailable: boolean;
  conflictingIds: string[];
}
export interface TelemetryDependencies extends SelfXapiDependencies {
  snapshot(): Promise<TelemetrySnapshot>;
  restore(statement: Json): Promise<void>;
  now(): string;
}
const locks = new Map<string, Promise<unknown>>();
const fail = (status: number, error: string): SelfXapiReply => ({ status, body: { ok: false, error } });
export async function ingestTelemetry(actor: string, input: unknown, deps: TelemetryDependencies): Promise<SelfXapiReply> {
  let events;
  try {
    if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error('events must contain 1 to 20 observations');
    events = input.map(normalizeEvent);
  } catch (e) { return fail(400, (e as Error).message); }
  const previous = locks.get(actor) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const snapshot = await deps.snapshot();
    // Without the durable copy, a restart could make a retry look like a new event.
    if (!snapshot.durableAvailable) return fail(503, 'encrypted telemetry history unavailable; retry the same event identifiers');
    const prior = new Map(snapshot.statements.map(s => [s.id, s]));
    const statements: Json[] = []; const ids = new Set<string>();
    for (const event of events!) {
      const next = eventStatement(actor, event, deps.now());
      if (ids.has(next.id)) return fail(400, 'duplicate source event identifier in batch');
      ids.add(next.id);
      if (snapshot.conflictingIds.includes(next.id)) return fail(409, 'LRS and durable history disagree for this identifier');
      const existing = prior.get(next.id);
      if (existing) {
        if (existing.actor?.account?.name !== actor || existing.context?.extensions?.[INTENT] !== digest(event)) return fail(409, 'source_event_id was already used for different event metadata');
        await deps.restore(existing); // exact LRS-enriched envelope, not a newly timestamped statement
        const { authority: _authority, stored: _stored, version: _version, ...original } = existing;
        statements.push(original);
      } else statements.push(next);
    }
    return writeSelfXapi(actor, statements, deps);
  });
  locks.set(actor, run);
  try { return await run; } finally { if (locks.get(actor) === run) locks.delete(actor); }
}

export interface TelemetryQuery { session_id?: string; source?: string; model?: string; kind?: string; agent_id?: string; tool_name?: string; status?: string; capture_mode?: string; since?: string; until?: string; limit?: number; offset?: number; view?: string }
export function normalizeQuery(input: unknown): TelemetryQuery {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('query must be an object');
  const result: Json = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === '' || v === undefined) continue;
    if (!['session_id', 'source', 'model', 'kind', 'agent_id', 'tool_name', 'status', 'capture_mode', 'since', 'until', 'limit', 'offset', 'view'].includes(k)) throw new Error(`unsupported query field: ${k}`);
    if (k === 'limit' || k === 'offset') {
      const n = Number(v); if (!Number.isSafeInteger(n) || n < (k === 'limit' ? 1 : 0) || n > (k === 'limit' ? 200 : 1000000)) throw new Error(`invalid ${k}`); result[k] = n;
    } else {
      if (typeof v !== 'string' || v.length > 240 || /[\x00-\x1f]/.test(v)) throw new Error(`invalid ${k}`);
      if (['since', 'until'].includes(k) && (!/^\d{4}-\d\d-\d\dT/.test(v) || !Number.isFinite(Date.parse(v)))) throw new Error(`invalid ${k} timestamp`);
      result[k] = v;
    }
  }
  if (result.since && result.until && Date.parse(result.since) > Date.parse(result.until)) throw new Error('since must precede until');
  return result;
}

/** Own-lens union. Cross-source conflicts stay visible; no silent winner. */
export function mergeTelemetrySnapshot(actor: string, lrs: Json[] | null, durable: Json[] | null): TelemetrySnapshot {
  const rows = new Map<string, Json>(); const conflictingIds: string[] = []; const durableIds: string[] = [];
  const eligible = (s: Json) => s && s.actor?.account?.name === actor && typeof s.id === 'string' && telemetryMetadata(s);
  for (const s of durable ?? []) if (eligible(s)) { rows.set(s.id, s); durableIds.push(s.id); }
  for (const s of lrs ?? []) if (eligible(s)) {
    const prior = rows.get(s.id);
    if (prior && digest(prior) !== digest(s)) conflictingIds.push(s.id);
    else rows.set(s.id, s);
  }
  return { statements: [...rows.values()], durableIds, durableAvailable: durable !== null, lrsAvailable: lrs !== null, conflictingIds };
}

export function telemetryReport(actor: string, snapshot: TelemetrySnapshot, query: TelemetryQuery, now: string) {
  const rows = snapshot.statements.filter(s => {
    const m = telemetryMetadata(s)!;
    return ['session_id', 'source', 'model', 'kind', 'agent_id', 'tool_name', 'status', 'capture_mode'].every(k => !(query as Json)[k] || m[k] === (query as Json)[k])
      && (!query.since || Date.parse(s.timestamp) >= Date.parse(query.since)) && (!query.until || Date.parse(s.timestamp) <= Date.parse(query.until));
  }).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id)));
  const sessions = new Map<string, Json>(); const sourceCounts: Json = {}; const eventCounts: Json = {};
  const costs: Json = {}; let inputTokens = 0, outputTokens = 0, inputKnown = 0, outputKnown = 0, costKnown = 0;
  const starts = new Map<string, Json>(); const ends = new Set<string>(); const durations: number[] = [];
  const durationEvidence: Json[] = []; let unmatchedEnds = 0;
  const durable = new Set(snapshot.durableIds);
  for (const s of rows) {
    const m = telemetryMetadata(s)!; const u = s.result?.extensions?.[USAGE];
    const key = s.context.registration;
    let session = sessions.get(key);
    if (!session) { session = { registration: key, session_id: m.session_id, source: m.source, first_seen: s.timestamp, last_seen: s.timestamp, events: 0, errors: 0, agents: new Set<string>(), models: new Set<string>(), capture_modes: new Set<string>(), ended: false }; sessions.set(key, session); }
    session.last_seen = s.timestamp; session.events++; session.errors += m.status === 'error' || m.kind.endsWith('-failed') ? 1 : 0;
    if (m.agent_id) session.agents.add(m.agent_id); if (m.model) session.models.add(m.model); session.capture_modes.add(m.capture_mode);
    if (m.kind === 'session-ended') session.ended = true;
    sourceCounts[m.source] = (sourceCounts[m.source] ?? 0) + 1; eventCounts[m.kind] = (eventCounts[m.kind] ?? 0) + 1;
    if (typeof u?.input_tokens === 'number') { inputTokens += u.input_tokens; inputKnown++; }
    if (typeof u?.output_tokens === 'number') { outputTokens += u.output_tokens; outputKnown++; }
    if (typeof u?.cost === 'number' && typeof u.currency === 'string') { costs[u.currency] = (costs[u.currency] ?? 0) + u.cost; costKnown++; }
    const operationId = m.tool_use_id ?? m.generation_id ?? m.agent_id;
    const family = m.kind.split('-')[0];
    const pairKey = operationId ? `${key}:${family}:${operationId}` : null;
    if (pairKey && /-(started|invoked)$/.test(m.kind)) starts.set(pairKey, s);
    if (pairKey && /-(completed|stopped|failed)$/.test(m.kind)) {
      ends.add(pairKey); const start = starts.get(pairKey);
      if (!start) unmatchedEnds++;
      else if (telemetryMetadata(start)!.time_basis === 'source' && m.time_basis === 'source') {
        const elapsed = Date.parse(s.timestamp) - Date.parse(start.timestamp);
        if (elapsed >= 0) { durations.push(elapsed); durationEvidence.push({ milliseconds: elapsed, statementIds: [start.id, s.id] }); }
      }
    }
  }
  const missingEnds = [...starts.keys()].filter(k => !ends.has(k));
  durations.sort((a, b) => a - b);
  const offset = query.offset ?? 0; const limit = query.limit ?? 50;
  const insights: Json[] = [];
  const errors = rows.filter(s => { const m = telemetryMetadata(s)!; return m.status === 'error' || m.kind.endsWith('-failed'); });
  if (errors.length) insights.push({ kind: 'errors', text: `${errors.length} explicit failure observations. Inspect their runtime and tool identifiers.`, statementIds: errors.slice(0, 20).map(s => s.id) });
  if (missingEnds.length || unmatchedEnds) insights.push({ kind: 'capture-gaps', text: `${missingEnds.length} starts have no observed end; ${unmatchedEnds} ends have no observed start in this selection. These are capture gaps or unfinished work, not proven failures.`, statementIds: missingEnds.slice(0, 20).map(k => starts.get(k)!.id) });
  if (!inputKnown && !outputKnown) insights.push({ kind: 'usage-coverage', text: 'No provider token usage was reported in this selection. Tokens and cost remain unknown.', statementIds: [] });
  return {
    ok: true, profile: VERSION, observer: actor, generated_at: now, query,
    coverage: { total_matching_events: rows.length, snapshot_events: snapshot.statements.length,
      lrs_available: snapshot.lrsAvailable, encrypted_history_available: snapshot.durableAvailable,
      complete_for_available_snapshot: snapshot.durableAvailable && snapshot.lrsAvailable && !snapshot.conflictingIds.length,
      durable_matching_events: rows.filter(s => durable.has(s.id)).length, conflicting_statement_ids: snapshot.conflictingIds,
      sources: sourceCounts, input_usage_events: inputKnown, output_usage_events: outputKnown, cost_events: costKnown,
      time_filter: 'event timestamp; source time when provided, otherwise collector observation time',
      scope: 'Only configured observers that delivered records are visible. An empty result does not prove no activity. Hosted web tools, uninstalled hooks and inaccessible chats are not covered.',
    },
    totals: { sessions: sessions.size, events: rows.length, errors: errors.length, event_counts: eventCounts,
      input_tokens: inputKnown ? inputTokens : null, output_tokens: outputKnown ? outputTokens : null, costs: costKnown ? costs : null,
      paired_source_durations: durations.length, median_paired_duration_ms: durations.length ? durations[Math.floor(durations.length / 2)] : null,
      starts_without_end: missingEnds.length, ends_without_start: unmatchedEnds },
    sessions: [...sessions.values()].map((s): Json => ({ ...s, agents: [...s.agents], models: [...s.models], capture_modes: [...s.capture_modes] })).sort((a, b) => b.last_seen.localeCompare(a.last_seen)),
    insights, duration_evidence: durationEvidence.slice(0, 20),
    statements: rows.slice(offset, offset + limit),
    pagination: { offset, limit, returned: rows.slice(offset, offset + limit).length, next_offset: offset + limit < rows.length ? offset + limit : null, order: 'event timestamp ascending; id tie-break', consistency: 'live snapshot; use a fixed until timestamp for exports' },
  };
}
