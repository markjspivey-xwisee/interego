import { describe, expect, it } from 'vitest';
import { normalizeEvent, eventStatement, telemetryMetadata, digest, type TelemetryEvent } from '../applications/llm-telemetry/events.js';
import { EVENTS, telemetryProfile, META, USAGE } from '../applications/llm-telemetry/profile.js';
import { ingestTelemetry, mergeTelemetrySnapshot, normalizeQuery, telemetryReport, type TelemetryDependencies } from '../applications/llm-telemetry/service.js';
import { validateStatement } from '../applications/foxxi-content-intelligence/src/xapi-validate.js';
import { telemetryView } from '../applications/llm-telemetry/view.js';
import { parseHypermediaMarkdown, liftHypermediaMarkdown } from '@interego/core';
import { TelemetryClient } from '../applications/llm-telemetry/client.js';
import { signedActPayload } from '../deploy/mcp-relay/signed-act.js';
import { readFileSync } from 'node:fs';
import jsonld from 'jsonld';
const actor = 'did:web:example.org:observer';
const time = '2026-09-16T12:00:00.000Z';
const event = (more = {}) => normalizeEvent({ kind: 'session-observed', source: 'test-runtime', session_id: 'session-1', source_event_id: 'event-1', capture_mode: 'validation', ...more });
function runtime() {
  type Statement = ReturnType<typeof eventStatement>;
  const lrs = new Map<string, Statement>(), durable = new Map<string, Statement>(); let available = true, persist = true, ticks = 0;
  const deps: TelemetryDependencies = {
    now: () => new Date(Date.parse(time) + ticks++ * 1000).toISOString(),
    snapshot: async () => mergeTelemetrySnapshot(actor, [...lrs.values()], available ? [...durable.values()] : null),
    restore: async s => { lrs.set(s.id, s); },
    request: async (method, q, body) => {
      if (method === 'GET') { const s = lrs.get(q.get('statementId')!); return { status: s ? 200 : 404, body: s }; }
      for (const s of body as Statement[]) {
        const original = lrs.get(s.id);
        if (original) { const { authority: _a, stored: _s, version: _v, ...authored } = original; if (digest(authored) !== digest(s)) return { status: 409, body: { error: 'immutable' } }; }
        else lrs.set(s.id, { ...s, authority: { account: { homePage: 'https://lrs.example', name: 'observer' } }, stored: time });
      }
      return { status: 200, body: (body as Statement[]).map(s => s.id) };
    },
    persist: async s => { if (persist) durable.set(String(s.id), s); return { persisted: persist }; },
  };
  return { deps, lrs, durable, unavailable: () => { available = false; }, failPersist: () => { persist = false; }, resumePersist: () => { persist = true; } };
}

describe('general LLM xAPI observations', () => {
  it.each(Object.keys(EVENTS))('produces valid xAPI for %s', kind => {
    const s = eventStatement(actor, event({ kind, turn_id: 'turn-1', tool_use_id: 'tool-1', agent_id: 'agent-1', generation_id: 'generation-1' }), time);
    expect(validateStatement(s)).toEqual([]);
    expect(telemetryMetadata(s)?.kind).toBe(kind);
    expect(s.actor.account.name).toBe(actor);
  });
  it('keeps turn activity identity distinct with the same runtime agent', () => {
    const a = eventStatement(actor, event({ kind: 'response-completed', agent_id: 'agent-1', turn_id: 'one' }), time);
    const b = eventStatement(actor, event({ kind: 'response-completed', agent_id: 'agent-1', turn_id: 'two' }), time);
    expect(a.object.id).not.toBe(b.object.id);
  });
  it.each(['prompt', 'response', 'reasoning', 'tool_input', 'tool_response', 'transcript_path', 'api_key', 'actor'])('rejects content-bearing or identity field %s', key => {
    expect(() => event({ [key]: 'sensitive' })).toThrow(/unsupported/);
  });
  it('rejects malformed usage and unresolved host placeholders', () => {
    expect(() => event({ usage: { input_tokens: -1 } })).toThrow();
    expect(() => event({ usage: { cost: 1 } })).toThrow();
    expect(() => event({ session_id: '${session_id}' })).toThrow();
  });
  it('retries without changing time or duplicating records, including after LRS restart', async () => {
    const r = runtime(); const first = await ingestTelemetry(actor, [event()], r.deps);
    expect(first.status).toBe(200); const original = [...r.durable.values()][0];
    expect((await ingestTelemetry(actor, [event()], r.deps)).status).toBe(200);
    r.lrs.clear(); expect((await ingestTelemetry(actor, [event()], r.deps)).status).toBe(200);
    expect(r.lrs.size).toBe(1); expect([...r.lrs.values()][0]).toEqual(original); expect(r.durable.size).toBe(1);
  });
  it('rejects conflicting identifiers, fences unavailable history, and reports partial commits', async () => {
    const r = runtime(); r.failPersist(); expect((await ingestTelemetry(actor, [event()], r.deps)).status).toBe(502);
    expect(r.lrs.size).toBe(1); expect(r.durable.size).toBe(0);
    r.resumePersist(); expect((await ingestTelemetry(actor, [event()], r.deps)).status).toBe(200);
    expect((await ingestTelemetry(actor, [event({ model: 'changed' })], r.deps)).status).toBe(409);
    r.unavailable(); expect((await ingestTelemetry(actor, [event({ source_event_id: 'two' })], r.deps)).status).toBe(503);
  });
  it('serializes concurrent duplicate deliveries', async () => {
    const r = runtime(); expect((await Promise.all([ingestTelemetry(actor, [event()], r.deps), ingestTelemetry(actor, [event()], r.deps)])).map(r => r.status)).toEqual([200, 200]); expect(r.lrs.size).toBe(1);
  });
  it('queries owner records, preserves missing usage and exposes gaps plus durable-only history', () => {
    const start = eventStatement(actor, event({ kind: 'tool-started', tool_use_id: 't', source_event_id: 'start' }), time);
    const other = eventStatement('did:web:other', event(), time);
    const snapshot = mergeTelemetrySnapshot(actor, [], [start, other]);
    const report = telemetryReport(actor, snapshot, {}, time);
    expect(report.totals.events).toBe(1); expect(report.totals.starts_without_end).toBe(1);
    expect(report.totals.input_tokens).toBeNull(); expect(report.coverage.durable_matching_events).toBe(1);
    expect(report.insights[0]?.statementIds).toContain(start.id);
  });
  it('separates measured usage from event timing and preserves currency units', () => {
    const start = eventStatement(actor, event({ kind: 'model-invoked', generation_id: 'g', source_event_id: 'start', observed_at: time }), time);
    const end = eventStatement(actor, event({ kind: 'model-completed', generation_id: 'g', source_event_id: 'end', observed_at: '2026-09-16T12:00:02.000Z', usage: { input_tokens: 20, output_tokens: 5, cost: 0.01, currency: 'USD' } }), time);
    const report = telemetryReport(actor, mergeTelemetrySnapshot(actor, [end, start], [start, end]), { limit: 1 }, time);
    expect(report.totals).toMatchObject({ input_tokens: 20, output_tokens: 5, median_paired_duration_ms: 2000, costs: { USD: 0.01 } });
    expect(report.statements).toHaveLength(1); expect(report.pagination.next_offset).toBe(1);
    const changed = { ...end, timestamp: time }; expect(mergeTelemetrySnapshot(actor, [changed], [end]).conflictingIds).toEqual([end.id]);
  });
  it('renders a readable HMD report with grounded controls and query defaults', () => {
    const s = eventStatement(actor, event(), time); const report = telemetryReport(actor, mergeTelemetrySnapshot(actor, [s], [s]), {}, time);
    const v = telemetryView('https://example.org', report); const doc = parseHypermediaMarkdown(v.hmd);
    expect(doc.body).toContain('1 observations'); expect(doc.body).not.toContain('"actor":');
    expect(doc.controls.every(c => c.requires?.length === 1)).toBe(true);
    expect(doc.controls.find(c => c.id?.includes('session-0'))?.fields?.some(f => f.defaultValue === 'session-1')).toBe(true);
    expect(liftHypermediaMarkdown(v.hmd).some(t => t.p === 'http://www.w3.org/ns/shacl#defaultValue' && t.o === 'session-1')).toBe(true);
  });
  it('publishes one template per verb, a versioned stream pattern and typed extension schemas', () => {
    const p = telemetryProfile(); expect(p.templates).toHaveLength(19); expect(new Set(p.concepts.map(c => c.id)).size).toBe(p.concepts.length);
    expect(p.concepts.filter(c => [META, USAGE].includes(c.id)).every(c => 'inlineSchema' in c && JSON.parse(c.inlineSchema).type === 'object')).toBe(true);
    expect(p.patterns[0]).toMatchObject({ primary: true });
  });
  it('expands the profile with the official ADL context without dropping its vocabulary', async () => {
    // https://github.com/adlnet/xapi-profiles/blob/master/context/profile-context.jsonld
    const context = JSON.parse(readFileSync(new URL('./fixtures/xapi-profile-context.jsonld', import.meta.url), 'utf8'));
    const expanded = await jsonld.expand(telemetryProfile() as never, { documentLoader: (async (url: string) => {
      if (url !== 'https://w3id.org/xapi/profiles/context') throw new Error('Unexpected context: ' + url);
      return { contextUrl: null, documentUrl: url, document: context };
    }) as never });
    const text = JSON.stringify(expanded);
    expect(text).toContain('http://www.w3.org/2004/02/skos/core#prefLabel');
    expect(text.includes('https://w3id.org/xapi/profiles/ontology#oneOrMore')).toBe(true);
    expect(text.includes('https://w3id.org/xapi/profiles/ontology#inlineSchema')).toBe(true);
  });
});

describe('runtime transport and bound signing', () => {
  it('queues actual work observations, preserves work output and retries identical delivery', async () => {
    let pending: TelemetryEvent[] = [], failures = 0;
    const calls: Array<Record<string, unknown>> = [];
    const client = new TelemetryClient({ source: 'runtime', session_id: 's', outbox: { read: async () => pending, replace: async e => { pending = e; } },
      call: async (_tool, args) => { calls.push(args); if (failures++ === 0) throw new Error('offline'); return { ok: true, durable: true, statementIds: (args.payload as { events: TelemetryEvent[] }).events.map(() => 'id') }; } });
    expect(await client.observe('tool', { tool_name: 'calculate' }, async () => 42)).toBe(42); expect(pending).toHaveLength(2);
    await expect(client.flush()).rejects.toThrow('offline'); const ids = pending.map(e => e.source_event_id);
    expect(await client.flush()).toEqual({ delivered: 2, pending: 0 });
    expect((calls[1]!.payload as { events: TelemetryEvent[] }).events.map(e => e.source_event_id)).toEqual(ids);
  });
  it('signs only the payload and bound session, then returns only the wire envelope', async () => {
    let signed: Record<string, unknown> | undefined;
    const envelope = await signedActPayload({ descriptor_url: 'https://example.org/affordances', action_iri: 'urn:query', sign_payload: true, _session_agent_did: actor, method: 'POST' }, { query: {} }, async args => { signed = args; return JSON.stringify({ _signature: 'signature', _signed_payload: 'payload', signed_as: actor }); });
    expect(signed).toEqual({ _session_agent_did: actor, payload: { query: {} } }); expect(envelope).toEqual({ _signature: 'signature', _signed_payload: 'payload' });
    await expect(signedActPayload({ sign_payload: true, target: 'https://example.org' }, {}, async () => '{}')).rejects.toThrow(/descriptor_url/);
  });
  it('refuses unknown query options and reversed ranges', () => {
    expect(() => normalizeQuery({ actor: 'someone-else' })).toThrow();
    expect(() => normalizeQuery({ since: '2026-09-17T00:00:00Z', until: time })).toThrow();
  });
});
