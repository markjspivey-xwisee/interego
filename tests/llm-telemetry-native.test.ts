import AdmZip from 'adm-zip';
import { telemetryPluginPackage } from '../applications/llm-telemetry/plugin-package.js';
import { telemetryClientSetup } from '../applications/llm-telemetry/client-setup.js';
import { describe, it, expect } from 'vitest';
import { normalizeOtlpLogs } from '../applications/llm-telemetry/otlp.js';
import { issueCollector, verifyCollector, revokeCollector, collectorActor, type CollectorGrant, type CollectorStore } from '../applications/llm-telemetry/collector.js';
const actor = 'did:web:identity.interego.xwisee.com:agents:test-native';
function registry() { const rows: CollectorGrant[] = []; const store: CollectorStore = { load: async () => structuredClone(rows), persist: async r => { rows.push(structuredClone(r)); return true; } }; return { rows, store }; }
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
function exportLogs(name = 'user_prompt', extra: ReturnType<typeof attr>[] = []) { return { resourceLogs: [{ resource: { attributes: [attr('session.id', 'session-one')] }, scopeLogs: [{ logRecords: [{ body: { stringValue: 'PRIVATE_BODY' }, attributes: [attr('event.name', name), attr('event.timestamp', '2026-09-18T10:00:00.000Z'), attr('event.sequence', '0'), attr('prompt.id', 'turn-one'), attr('prompt', 'PRIVATE_PROMPT'), ...extra] }] }] }] }; }
describe('native OTLP projection', () => {
  it('drops raw content, ignores submitted identities and produces stable retries', () => {
    const payload = exportLogs('user_prompt', [attr('observer', 'other'), attr('user.email', 'PRIVATE_EMAIL')]);
    const a = normalizeOtlpLogs(payload, 'claude-code-otel', 'validation');
    expect(a.events).toHaveLength(1); expect(a.events[0]).toMatchObject({ kind: 'input-received', capture_mode: 'validation' });
    expect(JSON.stringify(a)).not.toMatch(/PRIVATE|other|email|body|prompt"/);
    expect(normalizeOtlpLogs(payload, 'claude-code-otel', 'validation')).toEqual(a);
  });
  it('records reported tokens and duration but never estimated billing', () => {
    const result = normalizeOtlpLogs(exportLogs('api_request', [attr('request_id', 'req-1'), attr('input_tokens', '12'), attr('duration_ms', '25.5'), attr('cost_usd', '5')]), 'claude-code-otel', 'live');
    expect(result.events[0]).toMatchObject({ generation_id: 'req-1', usage: { input_tokens: 12, duration_ms: 25.5 } });
    expect(result.events[0]?.usage).not.toHaveProperty('cost');
  });
  it('requires actual invocation IDs and rejects unknown event kinds', () => {
    expect(normalizeOtlpLogs(exportLogs('tool_result'), 'claude-code-otel', 'live').rejected).toBe(1);
    expect(normalizeOtlpLogs(exportLogs('secret_event'), 'claude-code-otel', 'live').rejected).toBe(1);
    expect(normalizeOtlpLogs(exportLogs('tool_result', [attr('tool_use_id', 'tool-1'), attr('success', 'false')]), 'claude-code-otel', 'live').events[0]?.kind).toBe('tool-failed');
  });
  it('does not collide after a resumed process resets event.sequence', () => {
    const first = exportLogs(); const second = exportLogs(); second.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes[1] = attr('event.timestamp', '2026-09-18T11:00:00.000Z');
    expect(normalizeOtlpLogs(first, 'claude-code-otel', 'live').events[0]?.source_event_id).not.toBe(normalizeOtlpLogs(second, 'claude-code-otel', 'live').events[0]?.source_event_id);
  });
  it('rejects malformed envelopes and duplicate attributes', () => {
    expect(() => normalizeOtlpLogs({}, 'claude-code-otel', 'live')).toThrow();
    expect(() => normalizeOtlpLogs(exportLogs('user_prompt', [attr('event.name','api_request')]), 'claude-code-otel', 'live')).toThrow();
  });
});
describe('persistent scoped collector credentials', () => {
  it('survives a fresh store wrapper without storing the bearer, and revokes monotonically', async () => {
    const { rows, store } = registry(); const issued = await issueCollector(actor, 'validation', store, 1000);
    expect(JSON.stringify(rows)).not.toContain(issued.token);
    expect(collectorActor(issued.token)).toBe(actor);
    expect(await verifyCollector(issued.token, { ...store }, 1001)).toMatchObject({ observer: actor, mode: 'validation' });
    await revokeCollector(actor, issued.collector_id, store);
    rows.push(rows[0]!); // stale append cannot resurrect a revoked credential
    await expect(verifyCollector(issued.token, store, 1002)).rejects.toThrow();
    await expect(revokeCollector(actor, issued.collector_id, store)).resolves.toMatchObject({ revoked: true });
  });
  it('rejects tampering, expiry, foreign identity and unavailable persistence', async () => {
    const { store } = registry(); const issued = await issueCollector(actor, 'validation', store, 1000);
    const p = issued.token.split('.'); p[3] = 'a'.repeat(43);
    await expect(verifyCollector(p.join('.'), store, 1001)).rejects.toThrow();
    await expect(verifyCollector(issued.token, store, 3601000)).rejects.toThrow();
    const q = issued.token.split('.'); q[1] = Buffer.from(actor + '-other').toString('base64url');
    await expect(verifyCollector(q.join('.'), store, 1001)).rejects.toThrow();
    await expect(issueCollector(actor, 'live', { load: async () => null, persist: async () => true })).rejects.toThrow();
    await expect(issueCollector(actor, 'live', { load: async () => [], persist: async () => false })).rejects.toThrow();
  });
});

describe('native packages and Cowork scope', () => {
  it('ships installable metadata hooks without a second MCP connection or scripts', () => {
    for (const client of ['codex', 'chatgpt-work', 'claude-code', 'claude-code-vscode']) {
      const setup = telemetryClientSetup({ client, server_name: 'existing-interego' });
      const zip = new AdmZip(telemetryPluginPackage(setup));
      expect(zip.getEntries().map(e => e.entryName).sort()).toEqual([client.startsWith('claude') ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json', 'README.md', 'hooks/hooks.json']);
      expect(JSON.parse(zip.readAsText('hooks/hooks.json'))).toEqual(setup.configuration);
      expect(zip.readAsText('hooks/hooks.json')).toContain('existing-interego');
    }
    expect(() => telemetryPluginPackage(telemetryClientSetup({ client: 'chatgpt-web' }))).toThrow();
  });
  it('excludes organization exports from other users and never changes observer authority', async () => {
    const { store } = registry();
    await expect(issueCollector(actor, 'live', store, 1000, 'claude-cowork-otel')).rejects.toThrow();
    const issued = await issueCollector(actor, 'live', store, 1000, 'claude-cowork-otel', 'my-account');
    expect(await verifyCollector(issued.token, store, 1001)).toMatchObject({ account_id: 'my-account', observer: actor });
    expect(normalizeOtlpLogs(exportLogs('user_prompt', [attr('user.account_uuid', 'other-account')]), 'claude-cowork-otel', 'live', 'my-account').events).toEqual([]);
    expect(normalizeOtlpLogs(exportLogs('user_prompt', [attr('user.account_uuid', 'my-account')]), 'claude-cowork-otel', 'live', 'my-account').events).toHaveLength(1);
  });
});
