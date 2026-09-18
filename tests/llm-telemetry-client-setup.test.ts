import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { telemetryClientSetup, clientSupport } from '../applications/llm-telemetry/client-setup.js';
import { mountTelemetryClientSetup } from '../applications/llm-telemetry/client-setup-routes.js';
import { normalizeEvent, eventStatement, telemetryMetadata } from '../applications/llm-telemetry/events.js';
import { mergeTelemetrySnapshot, telemetryReport } from '../applications/llm-telemetry/service.js';
import { withCaptureConsent, type CaptureStore } from '../applications/llm-telemetry/capture.js';
import { clientSetupView } from '../applications/llm-telemetry/view.js';
import { parseHypermediaMarkdown } from '@interego/core';
import { validateStatement } from '../applications/foxxi-content-intelligence/src/xapi-validate.js';

// Recorded contract shapes, not a claim of executing a real Codex/Claude host.
const fixture = { session_id: 'session-01', turn_id: 'codex-turn-01', prompt_id: 'claude-prompt-01', tool_use_id: 'toolu_01', tool_name: 'Bash', agent_id: 'subagent-01',
  prompt: 'PRIVATE_PROMPT', last_assistant_message: 'PRIVATE_REPLY', transcript_path: '/private/transcript', cwd: '/private/project', tool_input: { command: 'PRIVATE_COMMAND' }, tool_response: 'PRIVATE_RESULT', error: 'PRIVATE_ERROR', api_key: 'PRIVATE_KEY' };
function expand<T>(value: T, event: Record<string, unknown>): T {
  if (typeof value === 'string') return value.replace(/\$\{([^}]+)\}/g, (_match, key) => {
    if (event[key] === undefined) throw new Error(`host field missing: ${key}`);
    return String(event[key]);
  }) as T;
  if (Array.isArray(value)) return value.map(v => expand(v, event)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, event)])) as T;
  return value;
}
const actor = 'did:web:example.org:observer';
const now = '2026-09-18T12:00:00.000Z';

describe('existing-connection client telemetry', () => {
  it.each(['codex', 'claude-code', 'claude-code-vscode'])('generates %s events accepted by the real event/xAPI contract without content', client => {
    const setup = telemetryClientSetup({ client, server_name: 'interego-railway' });
    expect(setup.status).toBe('configuration-prepared');
    expect(setup.host_activation).toBe('not-verified');
    expect(Object.keys(setup.configuration!)).toEqual(['hooks']);
    const inputs: unknown[] = [];
    for (const groups of Object.values(setup.configuration!.hooks)) {
      for (const group of groups) for (const hook of group.hooks) {
        expect(hook).toMatchObject({ type: 'mcp_tool', server: 'interego-railway', tool: 'act' });
        const input = expand(hook.input, fixture);
        expect(input).toMatchObject({ descriptor_url: 'https://foxxi-bridge.interego.xwisee.com/affordances', sign_payload: true });
        for (const raw of input.payload.events) {
          const event = normalizeEvent(raw);
          expect(validateStatement(eventStatement(actor, event, now))).toEqual([]);
          expect(event).not.toHaveProperty('usage');
          expect(event).not.toHaveProperty('model');
        }
        inputs.push(input);
      }
    }
    expect(JSON.stringify(inputs)).not.toMatch(/PRIVATE_|\/private|transcript_path|tool_input|tool_response|api_key/);
    expect(JSON.stringify(setup.configuration)).not.toMatch(/"(?:mcpServers|command)"|"type":"http"|\.mcp\.json/);
  });

  it('uses Claude prompt_id rather than Codex turn_id, and keeps tool success unknown', () => {
    for (const client of ['claude-code', 'codex']) {
      const hooks = telemetryClientSetup({ client, server_name: 'existing' }).configuration!.hooks;
      const input = expand(hooks.UserPromptSubmit![0]!.hooks[0]!.input, fixture);
      expect(input.payload.events[1]!.turn_id).toBe(client === 'codex' ? fixture.turn_id : fixture.prompt_id);
      expect(hooks.PostToolUse![0]!.hooks[0]!.input.payload.events[1]!.status).toBe('unknown');
      expect(hooks.SessionStart).toBeUndefined();
      expect(hooks.SessionEnd).toBeUndefined();
    }
    const claude = telemetryClientSetup({ client: 'claude-code', server_name: 'existing' }).configuration!.hooks;
    expect(claude.PostToolUseFailure![0]!.hooks[0]!.input.payload.events[1]).toMatchObject({ kind: 'tool-failed', status: 'error' });
  });

  it('does not need optional Claude model or turn fields for tool delivery and excludes recursive act calls', () => {
    const hooks = telemetryClientSetup({ client: 'claude-code', server_name: 'plugin:existing:interego' }).configuration!.hooks;
    const group = hooks.PreToolUse![0]!;
    const input = expand(group.hooks[0]!.input, { session_id: 'session-1', tool_use_id: 'tool-1', tool_name: 'Read' });
    expect(input.payload.events.map(normalizeEvent)).toHaveLength(2);
    for (const name of ['act', 'mcp__interego__act', 'mcp__plugin_existing_interego__act']) expect(new RegExp(group.matcher!).test(name)).toBe(false);
    for (const name of ['Bash', 'Read', 'mcp__github__get_issue']) expect(new RegExp(group.matcher!).test(name)).toBe(true);
  });

  it('deduplicates session markers and keeps actual tool operations distinct', () => {
    const hooks = telemetryClientSetup({ client: 'claude-code', server_name: 'existing' }).configuration!.hooks;
    const statements = new Map<string, ReturnType<typeof eventStatement>>();
    for (const tool_use_id of ['tool-1', 'tool-2']) for (const phase of ['PreToolUse', 'PostToolUse']) {
      const input = expand(hooks[phase]![0]!.hooks[0]!.input, { ...fixture, tool_use_id });
      for (const e of input.payload.events) { const s = eventStatement(actor, normalizeEvent(e), now); statements.set(s.id, s); }
    }
    const values = [...statements.values()];
    expect(values).toHaveLength(5);
    expect(values.filter(s => telemetryMetadata(s)?.kind === 'session-observed')).toHaveLength(1);
    const report = telemetryReport(actor, mergeTelemetrySnapshot(actor, values, values), { source: 'claude-code-hooks' }, now);
    expect(report.totals).toMatchObject({ events: 5, sessions: 1, input_tokens: null, output_tokens: null, costs: null, paired_source_durations: 0 });
  });

  it('requires actual client consent even with valid generated events', async () => {
    const hooks = telemetryClientSetup({ client: 'claude-code', server_name: 'existing' }).configuration!.hooks;
    const events = expand(hooks.PreToolUse![0]!.hooks[0]!.input, fixture).payload.events;
    const store: CaptureStore = { now: () => now, load: async () => [], persist: async () => true };
    await expect(withCaptureConsent(actor, events, undefined, store, async () => true)).rejects.toMatchObject({ status: 403 });
  });

  it('does not guess a connection name, enable hosts, or claim unsupported browser hooks', () => {
    expect(telemetryClientSetup({ client: 'claude-code' })).toMatchObject({ status: 'connection-name-required', configuration: null, host_activation: 'not-verified' });
    for (const host of clientSupport.filter(h => h.support !== 'configuration-available')) {
      expect(telemetryClientSetup({ client: host.client, server_name: 'existing' })).toMatchObject({ status: host.support, configuration: null });
    }
    for (const input of [{ client: 'imaginary' }, { server_name: '${secret}' }, { server_name: 'server\ncommand' }, { server_name: 'x'.repeat(129) }, { token: 'private' }, { client: ['codex'] }]) expect(() => telemetryClientSetup(input)).toThrow();
  });

  it('publishes usable HMD controls and a download without exposing a configuration wall of text', () => {
    const view = clientSetupView('https://example.org', telemetryClientSetup({ client: 'claude-code', server_name: 'Interego (railway)' }));
    const parsed = parseHypermediaMarkdown(view.hmd);
    expect(parsed.controls.some(c => c.id === 'setup-claude-code')).toBe(true);
    expect(view.links[0]!.href).toContain('server_name=Interego%20(railway)');
    expect(view.body).not.toContain('"hooks":');
    expect(view.controls.find(c => c.id === 'client-evidence')?.payload).toMatchObject({ source: 'claude-code-hooks', capture_mode: 'live', capture_channel: 'client' });
  });
});

describe('hosted setup delivery', () => {
  let server: Server | undefined;
  afterEach(async () => { if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); });
  it('serves configuration from the existing application and refuses unsupported downloads', async () => {
    const app = express(); app.use(express.json()); mountTelemetryClientSetup(app, 'https://example.org');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/agent/llm-telemetry/client-setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: 'claude-code', server_name: 'existing' }) });
    expect(response.status).toBe(200);
    const setup = await response.json();
    expect(setup).toMatchObject({ status: 'configuration-prepared', host_activation: 'not-verified' });
    const download = await fetch(`${base}/llm-telemetry/setup/config?client=claude-code&server_name=existing`);
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(download.headers.get('Cache-Control')).toBe('no-store');
    expect(await download.json()).toEqual(setup.configuration);
    const page = await fetch(`${base}/llm-telemetry/setup`);
    expect(page.headers.get('Content-Type')).toContain('text/markdown');
    expect(await page.text()).toContain('Client reporting setup');
    expect((await fetch(`${base}/llm-telemetry/setup/config?client=claude-web&server_name=existing`)).status).toBe(409);
    expect((await fetch(`${base}/llm-telemetry/setup/config?client=codex`)).status).toBe(409);
    expect((await fetch(`${base}/llm-telemetry/setup?client=codex&token=secret`)).status).toBe(400);
  });
});
