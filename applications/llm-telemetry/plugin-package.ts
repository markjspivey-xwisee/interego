import AdmZip from 'adm-zip';
import type { ClientSetup } from './client-setup.js';
/** Distributable configuration, no executable, copied OAuth secret or second MCP server. */
export function telemetryPluginPackage(setup: ClientSetup): Buffer {
  if (!setup.configuration || !['codex', 'chatgpt-work', 'claude-code', 'claude-code-vscode'].includes(setup.client)) throw new Error('Select a hook-capable host and its existing connection name');
  const name = 'interego-activity'; const zip = new AdmZip();
  const manifest = { name, version: '0.2.0', description: 'Opt-in metadata reporting through your existing Interego connection.', author: { name: 'Interego' } };
  const codex = setup.client === 'codex' || setup.client === 'chatgpt-work';
  zip.addFile(`${codex ? '.codex-plugin' : '.claude-plugin'}/plugin.json`, Buffer.from(JSON.stringify(codex ? { ...manifest, interface: { displayName: 'Interego Activity', shortDescription: 'Report runtime activity to Interego.', longDescription: 'Metadata-only native hooks using your existing connection. Host trust and reporting consent are required.', developerName: 'Interego', category: 'Productivity', capabilities: [], defaultPrompt: 'Check my Interego activity reporting setup.' } } : manifest, null, 2)));
  zip.addFile('hooks/hooks.json', Buffer.from(JSON.stringify(setup.configuration, null, 2)));
  zip.addFile('README.md', Buffer.from(`# Interego Activity\n\nPrepared for ${setup.label}. Existing MCP name: ${setup.server_name}.\n\nInstall using your host's native plugin installation flow if available. Installing does not trust hooks or activate consent. Review the exact hooks in the host and enable Client reporting in Interego. Do not enable this package alongside the same standalone hook configuration.\n\nNo new MCP server, credentials, scripts or browser extension. This package observes supported runtime events only, not all ordinary browser chats. Work installation and live activation must be verified in your actual host.\n\n${setup.steps.join('\n\n')}\n\n${setup.limits.join('\n\n')}\n`));
  return zip.toBuffer();
}
