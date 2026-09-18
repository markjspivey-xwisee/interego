/** Hosted, metadata-only configuration for an EXISTING client MCP connection. */
export const TELEMETRY_CLIENTS = ['codex', 'claude-code', 'claude-code-vscode', 'codex-vscode', 'chatgpt-work', 'chatgpt-web', 'claude-web'] as const;
export type TelemetryHost = typeof TELEMETRY_CLIENTS[number];
export const clientSupport = [
  { client: 'codex', label: 'Codex CLI', support: 'configuration-available', runtime: 'codex', settings: '~/.codex/hooks.json', documentation: 'https://learn.chatgpt.com/docs/hooks' },
  { client: 'claude-code', label: 'Claude Code CLI', support: 'configuration-available', runtime: 'claude', settings: '~/.claude/settings.json', documentation: 'https://code.claude.com/docs/en/hooks' },
  { client: 'claude-code-vscode', label: 'Claude Code in VS Code', support: 'configuration-available', runtime: 'claude', settings: '~/.claude/settings.json', documentation: 'https://code.claude.com/docs/en/vs-code' },
  { client: 'codex-vscode', label: 'Codex in VS Code', support: 'host-setup-unverified', documentation: 'https://learn.chatgpt.com/docs/hooks' },
  { client: 'chatgpt-work', label: 'ChatGPT Work', support: 'host-setup-unverified', documentation: 'https://learn.chatgpt.com/docs/plugins' },
  { client: 'chatgpt-web', label: 'ChatGPT browser chat', support: 'server-capture-only', documentation: 'https://learn.chatgpt.com/docs/plugins' },
  { client: 'claude-web', label: 'Claude browser chat', support: 'server-capture-only', documentation: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp' },
] as const;

type HookEvent = Record<string, string>;
interface HookGroup {
  matcher?: string;
  hooks: Array<{ type: 'mcp_tool'; server: string; tool: string; timeout: number;
    input: { descriptor_url: string; action_iri: string; sign_payload: boolean; payload: { events: HookEvent[] } } }>;
}
export interface ClientSetup {
  ok: true; client: string; label: string; status: string; prepared_at: string;
  connection: 'existing-interego-mcp'; server_name: string | null;
  source: string | null; settings_path: string | null;
  configuration: { hooks: Record<string, HookGroup[]> } | null;
  host_activation: 'not-verified'; support: typeof clientSupport;
  requirements: string[]; steps: string[]; limits: string[];
  verification_query: Record<string, string> | null;
  documentation: string | null;
}

/** Restrict aliases to plain configured names; never interpolate executable code. */
function serverName(value: unknown): string | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:() /-]{0,127}$/.test(value) || value.trim() !== value) {
    throw new Error('server_name must be the existing client MCP connection name (1–128 plain characters)');
  }
  return value;
}

export function telemetryClientSetup(input: unknown = {}): ClientSetup {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('setup input must be an object');
  const options = input as Record<string, unknown>;
  for (const key of Object.keys(options)) if (!['client', 'server_name'].includes(key)) throw new Error(`unsupported setup field: ${key}`);
  const selected = options.client === undefined || options.client === '' ? 'overview' : options.client;
  if (typeof selected !== 'string' || (selected !== 'overview' && !TELEMETRY_CLIENTS.includes(selected as TelemetryHost))) throw new Error('unknown telemetry client');
  const server = serverName(options.server_name);
  const host = clientSupport.find(h => h.client === selected);
  const runtime = host && 'runtime' in host ? host.runtime : null;
  const source = runtime === 'claude' ? 'claude-code-hooks' : runtime === 'codex' ? 'codex-hooks' : null;
  const preparedAt = new Date().toISOString();
  const result: ClientSetup = {
    ok: true, client: selected, label: host?.label ?? 'Client reporting setup', prepared_at: preparedAt,
    status: host?.support ?? 'choose-client', connection: 'existing-interego-mcp', server_name: server,
    source, settings_path: host && 'settings' in host ? host.settings : null,
    configuration: null, host_activation: 'not-verified', support: clientSupport,
    requirements: ['Keep the existing authenticated Interego MCP connection.', 'Enable Client reporting for the observer identity used by this client. Each connected identity has its own consent.'],
    steps: [], documentation: host?.documentation ?? null,
    limits: ['Preparing configuration does not install hooks, approve host trust, or prove delivery.',
      'Only metadata is sent: no prompts, replies, reasoning, tool arguments/results, transcript paths or credentials.',
      'Token counts, cost and model identity are unknown unless supplied by separate runtime instrumentation.',
      'These hooks have no durable retry queue. Receipt times are not tool execution durations.',
      'Session and compaction markers coalesce; counts are observations, not exact lifecycle occurrence counts.',
      'Generic act tool calls are excluded from client tool hooks to prevent recursive telemetry. Server capture can observe ordinary Interego calls.'],
    verification_query: source ? { source, capture_channel: 'client', capture_mode: 'live', since: preparedAt, view: 'sessions' } : null,
  };
  if (!host) {
    result.steps = ['Choose the client that actually runs your work. Server capture needs no additional plugin.', 'For a supported runtime, supply the exact existing MCP connection name from that runtime, not a guessed display name.'];
    return result;
  }
  if (!runtime) {
    result.steps = [host.support === 'host-setup-unverified'
      ? 'The runtime may support hooks, but an installation and trust flow for this surface has not been verified. This service does not mark it supported or provide an unverified installation command.'
      : 'Use Interego server capture through the existing connector. Connecting an MCP server alone does not register conversation lifecycle hooks.',
    'Client reporting can still receive explicit reports from an instrumented runtime; it cannot automatically observe unreported native chat activity.'];
    return result;
  }
  result.requirements.push('The host must support type:mcp_tool hooks on an already-connected server. The hook does not establish a connection or perform OAuth.');
  result.requirements.push(runtime === 'claude'
    ? 'Claude Code must expose prompt_id (documented from v2.1.196) and MCP tool hooks. A version number alone does not attest those capabilities.'
    : 'Codex must expose turn_id and MCP tool hooks. Review and trust the exact hook definitions using the host hook review.');
  result.steps = [
    'Select your existing MCP connection name. Do not add another server or copy credentials.',
    `Download the configuration and merge its hooks into ${result.settings_path}, preserving unrelated settings and hooks. On Windows use the corresponding user-profile path. No source build or local executable is required.`,
    'Replace any earlier Interego telemetry hooks rather than enabling two copies. Do not change host trust files or bypass review.',
    runtime === 'claude' ? 'Reload the Claude Code session and review the host configuration/workspace trust requirements. CLI and VS Code use the same Claude Code settings.' : 'Open /hooks in Codex CLI to review and trust the new definitions, then start a new session.',
    'With Interego connected and Client reporting enabled for that identity, send a new prompt and run an ordinary supported tool.',
    'Query Client reporting evidence for this source and the setup time. An empty result is not proof of installation; historical records do not prove this host is active.',
  ];
  if (!server) { result.status = 'connection-name-required'; return result; }
  result.configuration = hookConfiguration(runtime, server, source!);
  result.status = 'configuration-prepared';
  return result;
}

function hookConfiguration(runtime: 'claude' | 'codex', server: string, source: string): { hooks: Record<string, HookGroup[]> } {
  const session = '${session_id}';
  const turn = runtime === 'claude' ? '${prompt_id}' : '${turn_id}';
  const common = { source, session_id: session, session_scope: 'host-session', capture_mode: 'live', coverage: 'hook' };
  // Every delivered event can establish the session; SessionStart can precede MCP readiness.
  const sessionEvent = { ...common, kind: 'session-observed', source_event_id: `v2:${session}:session-observed` };
  const definitions: Record<string, HookEvent> = {
    UserPromptSubmit: { kind: 'input-received', source_event_id: `v2:${session}:${turn}:input`, turn_id: turn, initiator_kind: 'unknown' },
    PreToolUse: { kind: 'tool-started', source_event_id: `v2:${session}:tool:${'${tool_use_id}'}:start`, tool_use_id: '${tool_use_id}', tool_name: '${tool_name}' },
    PostToolUse: { kind: 'tool-completed', source_event_id: `v2:${session}:tool:${'${tool_use_id}'}:end`, tool_use_id: '${tool_use_id}', tool_name: '${tool_name}', status: 'unknown' },
    SubagentStart: { kind: 'agent-started', source_event_id: `v2:${session}:agent:${'${agent_id}'}:start`, agent_id: '${agent_id}', initiator_kind: 'agent' },
    SubagentStop: { kind: 'agent-stopped', source_event_id: `v2:${session}:agent:${'${agent_id}'}:end`, agent_id: '${agent_id}', initiator_kind: 'agent' },
    Stop: { kind: 'response-completed', source_event_id: `v2:${session}:${turn}:response`, turn_id: turn },
    PreCompact: { kind: 'compaction-started', source_event_id: `v2:${session}:compaction-started` },
    PostCompact: { kind: 'compaction-completed', source_event_id: `v2:${session}:compaction-completed` },
  };
  if (runtime === 'claude') definitions.PostToolUseFailure = { kind: 'tool-failed', source_event_id: `v2:${session}:tool:${'${tool_use_id}'}:failure`, tool_use_id: '${tool_use_id}', tool_name: '${tool_name}', status: 'error' };
  const hooks = Object.fromEntries(Object.entries(definitions).map(([name, event]) => [name, [{
    ...(name.includes('ToolUse') ? { matcher: '^(?!act$|mcp__.*__act$).*' } : {}),
    hooks: [{ type: 'mcp_tool' as const, server, tool: 'act', timeout: 10,
      input: { descriptor_url: 'https://foxxi-bridge.interego.xwisee.com/affordances',
        action_iri: 'https://relay.interego.xwisee.com/ns/iep/action/llm-telemetry/ingest', sign_payload: true,
        payload: { events: [sessionEvent, { ...common, ...event }] } },
    }],
  }]]));
  return { hooks };
}
