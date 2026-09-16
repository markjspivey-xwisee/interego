/** Generate the declarative hook plugin; never modify host trust or credentials. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const output = resolve(process.argv[2] ?? 'plugins/interego-telemetry');
const contract = 'https://foxxi-bridge.interego.xwisee.com/affordances';
const action = 'https://relay.interego.xwisee.com/ns/iep/action/llm-telemetry/ingest';
const definitions = {
  SessionStart: { kind: 'session-observed', key: '${session_id}:SessionStart:${model}' },
  UserPromptSubmit: { kind: 'input-received', key: '${session_id}:${turn_id}:UserPromptSubmit', fields: ['turn_id'], initiator_kind: 'unknown' },
  PreToolUse: { kind: 'tool-started', key: '${session_id}:${tool_use_id}:PreToolUse', fields: ['turn_id', 'tool_use_id', 'tool_name'] },
  PostToolUse: { kind: 'tool-completed', key: '${session_id}:${tool_use_id}:PostToolUse', fields: ['turn_id', 'tool_use_id', 'tool_name'] },
  SubagentStart: { kind: 'agent-started', key: '${session_id}:${agent_id}:SubagentStart', fields: ['turn_id', 'agent_id', 'agent_type'], initiator_kind: 'agent' },
  SubagentStop: { kind: 'agent-stopped', key: '${session_id}:${agent_id}:SubagentStop', fields: ['turn_id', 'agent_id', 'agent_type'], initiator_kind: 'agent' },
  Stop: { kind: 'response-completed', key: '${session_id}:${turn_id}:Stop', fields: ['turn_id'] },
  PreCompact: { kind: 'compaction-started', key: '${session_id}:${model}:PreCompact' },
  PostCompact: { kind: 'compaction-completed', key: '${session_id}:${model}:PostCompact' },
};
const hooks = Object.fromEntries(Object.entries(definitions).map(([name, d]) => [name, [{
  ...(name.includes('ToolUse') || name.startsWith('Subagent') ? { matcher: '.*' } : {}),
  hooks: [{ type: 'mcp_tool', server: 'interego', tool: 'act', timeout: 30,
    statusMessage: 'Recording Interego activity metadata',
    input: { descriptor_url: contract, action_iri: action, sign_payload: true, payload: { events: [{
      kind: d.kind, source: 'codex-hooks', source_event_id: d.key, session_id: '${session_id}', model: '${model}',
      capture_mode: 'live', coverage: 'hook', ...(d.initiator_kind ? { initiator_kind: d.initiator_kind } : {}),
      ...Object.fromEntries((d.fields ?? []).map(k => [k, '${' + k + '}'])),
    }] } },
  }],
}]]));
await mkdir(join(output, '.codex-plugin'), { recursive: true });
await mkdir(join(output, 'hooks'), { recursive: true });
await writeFile(join(output, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'interego-telemetry', version: '1.0.0', description: 'Metadata-only LLM session, tool and agent observations in your private Interego xAPI records.', author: { name: 'Interego' }, mcpServers: './.mcp.json', interface: { displayName: 'Interego activity', shortDescription: 'Private LLM telemetry and HyperMarkdown reports', longDescription: 'Capture supported Codex lifecycle metadata in Interego. Requires connecting the Interego MCP server and reviewing hook trust. Prompts, responses, arguments, transcripts and credentials are excluded.', developerName: 'Interego', category: 'Productivity', capabilities: [], defaultPrompt: 'Open my Interego LLM activity interface at https://foxxi-bridge.interego.xwisee.com/llm-telemetry using render_hmd.' } }, null, 2) + '\n');
await writeFile(join(output, '.mcp.json'), JSON.stringify({ mcpServers: { interego: { url: 'https://relay.interego.xwisee.com/mcp' } } }, null, 2) + '\n');
await writeFile(join(output, 'hooks/hooks.json'), JSON.stringify({ description: 'Metadata-only observations. No content interpolation, command execution or transcript reads. MCP failures are nonblocking; connection and hook trust are managed by the host.', hooks }, null, 2) + '\n');
console.log(JSON.stringify({ output, hooks: Object.keys(hooks), trusted: false, installed: false }));
