import { isAbsolute } from 'node:path';
import { AGENT_ID_PATTERN } from './agent-protocol.js';
import type { AgentConnection, AgentSetup } from './agent-types.js';

export interface AgentLaunch { readonly command: string; readonly args: readonly string[]; }
const ENV = { NODE_OPTIONS: '' };
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export function buildAgentSetup(connection: AgentConnection, launch: AgentLaunch, userData: string): AgentSetup {
  if (!AGENT_ID_PATTERN.test(connection.id) || !['waiting', 'active'].includes(connection.state)
    || typeof launch.command !== 'string' || typeof userData !== 'string' || !Array.isArray(launch.args)
    || !isAbsolute(launch.command) || !isAbsolute(userData)
    || [launch.command, userData, ...launch.args].some(value => typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value))
    || launch.args.some(value => ['--mcp-stdio', '--connection', '--pod-data-dir'].includes(value))) {
    throw new Error('Setup is unavailable for this connection.');
  }
  const name = `interego-${connection.id}`;
  const args = [...launch.args, '--mcp-stdio', '--connection', connection.id, '--pod-data-dir', userData];
  const entry = { command: launch.command, args, env: ENV };
  const json = JSON.stringify({ mcpServers: { [name]: entry } }, null, 2);
  const commandArgs = [launch.command, ...args].map(quote).join(' ');
  const common = ['Keep Interego open and start your local pod.', 'Add this connection to the selected agent, keeping its other settings.', 'Restart or reconnect the agent, then ask it to check its Interego connection.', 'Notes an agent reads may be sent to its AI provider. Revoke this connection in Interego to stop future access.'];
  let title: string;
  let configLocation: string;
  let configuration = json;
  let command: string | undefined;
  let steps = common;
  switch (connection.client) {
    case 'codex':
    case 'chatgpt-desktop': {
      title = connection.client === 'codex' ? 'Connect Codex' : 'Connect ChatGPT desktop';
      configLocation = '%USERPROFILE%\\.codex\\config.toml';
      configuration = `[mcp_servers.${name}]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(args)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 180\n\n[mcp_servers.${name}.env]\nNODE_OPTIONS = ""\n`;
      if (connection.client === 'codex') {
        command = `codex mcp add ${name} --env ${quote('NODE_OPTIONS=')} -- ${commandArgs}`;
        steps = [common[0]!, 'In PowerShell, run the command below, or merge the configuration into your Codex settings.', ...common.slice(2)];
      }
      else steps = [common[0]!, 'In ChatGPT desktop, open Settings → MCP servers. Add a STDIO server, or merge the configuration below into the shared Codex settings.', ...common.slice(2)];
      break;
    }
    case 'claude-code':
      title = 'Connect Claude Code'; configLocation = 'Claude Code user settings (~/.claude.json), or project .mcp.json';
      configuration = JSON.stringify({ mcpServers: { [name]: { type: 'stdio', ...entry } } }, null, 2);
      command = `claude mcp add --env ${quote('NODE_OPTIONS=')} --transport stdio --scope user ${name} -- ${commandArgs}`;
      steps = [common[0]!, 'In PowerShell, run the command below to add this connection for your Windows user, or merge the JSON into Claude Code’s MCP settings.', ...common.slice(2)];
      break;
    case 'claude-desktop':
      title = 'Connect Claude Desktop'; configLocation = '%APPDATA%\\Claude\\claude_desktop_config.json';
      steps = [common[0]!, 'Open Claude Desktop’s local MCP settings and merge this JSON into its configuration. Use the local server setup, rather than a remote web connector.', ...common.slice(2)];
      break;
    case 'grok-build':
      title = 'Connect Grok Build'; configLocation = '%USERPROFILE%\\.grok\\config.toml';
      configuration = `[mcp_servers.${name}]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(args)}\nenv = { NODE_OPTIONS = "" }\nstartup_timeout_sec = 30\ntool_timeout_sec = 180\n`;
      steps = [common[0]!, 'Merge this into Grok Build’s MCP configuration. This setup is for the local Grok Build client, rather than the Grok Bot cloud computer.', 'Run grok mcp doctor to check the connection.', common[3]!];
      break;
    case 'openclaw':
      title = 'Connect OpenClaw'; configLocation = 'OpenClaw configuration → mcp.servers';
      configuration = JSON.stringify({ mcp: { servers: { [name]: { ...entry, enabled: true, connectionTimeoutMs: 30_000, requestTimeoutMs: 180_000 } } } }, null, 2);
      steps = [common[0]!, 'Use this configuration in an OpenClaw Gateway running on this computer. A cloud Gateway cannot start this Windows command.', `Run openclaw mcp doctor ${name} --probe to check the connection.`, common[3]!];
      break;
    case 'other':
      title = 'Connect another local MCP client'; configLocation = 'Your client’s local STDIO MCP configuration';
      steps = [common[0]!, 'Your client must support launching a local STDIO MCP command. Merge the command, arguments and environment settings below into its configuration.', ...common.slice(2)];
      break;
    default: throw new Error('Choose a supported local MCP client.');
  }
  return { connectionId: connection.id, title, configLocation, steps, configuration, ...(command ? { command } : {}) };
}
