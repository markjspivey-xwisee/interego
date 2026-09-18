import { renderHypermediaMarkdown, actionUrl, type HypermediaControl } from '@interego/core';
import { hmdProse, affordanceControl } from '../_shared/hypermedia/index.js';
import { telemetryAffordances, queryInputs, captureReadAffordance, captureUpdateAffordance, clientSetupAffordance, collectorAffordances } from './affordances.js';
import type { ClientSetup } from './client-setup.js';
import type { CapturePreferences } from './capture.js';
import { telemetryMetadata, type Json } from './events.js';
import { PROFILE, RELAY_SIGNATURE } from './profile.js';

const queryAction = telemetryAffordances[2]!;
const cell = (x: unknown) => String(x ?? '—').replace(/[|\r\n]/g, ' ').replace(/[\[\]<>`]/g, '');
const table = (headers: string[], rows: unknown[][]) => `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(r => `| ${r.map(cell).join(' | ')} |`).join('\n')}`;
const setupControl = (base: string): HypermediaControl & Json => ({ ...affordanceControl(clientSetupAffordance, base), id: 'client-setup', label: 'Client reporting setup', whenToUse: 'Client reporting setup', descriptorUrl: `${base}/affordances`, executable: true, fields: [] });

export function telemetryView(base: string, report?: Json) {
  const authority = `${base}/affordances`;
  const declared = { ...affordanceControl(queryAction, base), requires: [RELAY_SIGNATURE] };
  const fields = queryInputs.filter(i => !['offset', 'view'].includes(i.name)).map(i => ({ name: i.name, path: `${base}/llm-telemetry/query#${i.name}`, description: i.description, datatype: `http://www.w3.org/2001/XMLSchema#${i.type === 'integer' ? 'integer' : 'string'}`, minCount: 0, maxCount: 1 }));
  const controls: Array<HypermediaControl & Json> = [];
  const control = (id: string, label: string, payload?: Json) => {
    const boundFields = payload ? Object.entries(payload).filter(([, v]) => v !== undefined).map(([name, defaultValue]) => ({ name, path: `${base}/llm-telemetry/query#${name}`, defaultValue, datatype: `http://www.w3.org/2001/XMLSchema#${typeof defaultValue === 'number' ? 'integer' : 'string'}`, minCount: 0 })) : fields;
    const c = { ...declared, id, label, whenToUse: label, descriptorUrl: authority, executable: true, fields: boundFields, ...(payload ? { payload } : {}) };
    controls.push(c); return c;
  };
  let body: string;
  if (!report) {
    body = '# LLM activity\n\nSee which sessions are reporting, follow work across agents and tools, and inspect the evidence behind each insight.\n\nOpen **Capture settings** to choose Interego recording, client reporting, both, or neither. Both start off. Interego records calls through this server; client reporting covers supported host activity after its hooks are configured and reviewed. Open **Client reporting setup** to reuse your existing connection with Codex or Claude Code.\n\nOpen **My sessions** to load your private records. Use **Query** to narrow the time range, source, model or runtime.\n\nCapture collects identifiers, lifecycle events and reported usage. Message contents, tool arguments, credentials and transcripts are excluded. Coverage is measured from received events; this page alone does not start a collector.';
    control('sessions', 'My sessions', { view: 'sessions' });
    control('report', 'Activity report', { view: 'report' });
    control('query', 'Query');
  } else {
    const t = report.totals, c = report.coverage; const selectedView = report.query.view ?? (report.query.session_id ? 'timeline' : 'sessions');
    body = `# ${selectedView === 'timeline' ? 'Session timeline' : selectedView === 'report' ? 'Activity report' : selectedView === 'export' ? 'xAPI export' : 'Your sessions'}\n\n`
      + `${t.events} observations · ${t.sessions} session / relay-day groups · ${t.errors} explicit failure observations\n\n`
      + table(['Input tokens reported', 'Output tokens reported', 'Events in encrypted history'], [[t.input_tokens ?? 'Unknown', t.output_tokens ?? 'Unknown', `${c.durable_matching_events}/${t.events}`]])
      + `\n\nSource coverage: ${Object.entries(c.sources).map(([s, n]) => `${cell(s)} (${n})`).join(', ') || 'No reporting source observed'}. `
      + `LRS: ${c.lrs_available ? 'available' : 'unavailable'}. Encrypted history: ${c.encrypted_history_available ? 'available' : 'unavailable'}.\n\n`;
    if (report.capture) body += `Reporting choices: Interego **${report.capture.server_enabled ? 'on' : 'off'}** · Client **${report.capture.client_enabled ? 'on' : 'off'}**. Client installation and host trust are verified separately.\n\n`;
    if (!c.complete_for_available_snapshot) body += '**This snapshot is incomplete or contains conflicting records.** The coverage fields identify the unavailable sources or conflicting statement IDs.\n\n';
    if (selectedView === 'sessions') {
      body += table(['Session / group', 'Source / mode', 'Last seen (UTC)', 'Events', 'Agents', 'Status'], report.sessions.slice(0, 30).map((s: Json) => [s.session_id, `${s.source} / ${s.capture_modes.join(', ')}`, s.last_seen, s.events, s.agents.length, s.session_scope === 'relay-day' ? 'UTC-day group; not a chat' : s.ended ? 'End observed' : 'Last seen; end unknown'])) + '\n\n';
      for (const [i, session] of report.sessions.slice(0, 4).entries()) control(`session-${i}`, `Open ${session.session_id}`, { session_id: session.session_id, source: session.source, view: 'timeline' });
      if (report.sessions.length > 30) body += 'Showing the 30 most recently observed sessions. Query a session ID or time range to narrow the selection.\n\n';
    } else if (selectedView === 'timeline' || selectedView === 'export') {
      body += table(['UTC', 'Event', 'Agent / parent', 'Tool / model', 'Evidence ID'], report.statements.map((s: Json) => { const m = telemetryMetadata(s)!; return [s.timestamp, m.kind, [m.agent_id, m.parent_agent_id].filter(Boolean).join(' / '), m.tool_name ?? m.model, s.id]; })) + '\n\n';
      body += `Showing ${report.pagination.returned} events from offset ${report.pagination.offset}. Raw xAPI statements accompany this view in the action result.\n\n`;
    }
    if (selectedView === 'report') {
      body += table(['Measurement', 'Observed result'], [['Source-timed start/end pairs', t.paired_source_durations], ['Median paired duration (ms)', t.median_paired_duration_ms ?? 'Unknown'], ['Starts without an end', t.starts_without_end], ['Ends without a start', t.ends_without_start], ['Events with input-token usage', c.input_usage_events], ['Events with output-token usage', c.output_usage_events], ['Reported costs by currency', t.costs ? JSON.stringify(t.costs) : 'Unknown']]) + '\n\n';
    }
    if (report.insights.length) body += '## Insights\n\n' + report.insights.map((i: Json) => `- ${cell(i.text)}${i.statementIds.length ? ` Evidence: ${i.statementIds.map(cell).join(', ')}.` : ''}`).join('\n') + '\n\n';
    body += 'These results describe delivered observations. Missing lifecycle events can mean unfinished work or incomplete capture. Token totals include only explicitly reported usage; activity volume does not measure answer quality.';
    control('refresh', 'Refresh', { ...report.query });
    if (report.pagination.next_offset !== null) control('next', 'Next events', { ...report.query, view: 'timeline', offset: report.pagination.next_offset });
    control('sessions', 'All sessions', { view: 'sessions' });
    control('report', 'Report for this selection', { ...report.query, view: 'report', offset: 0 });
    control('export', 'Export xAPI page', { ...report.query, view: 'export' });
    control('query', 'New query');
  }
  controls.push({ ...affordanceControl(captureReadAffordance, base), id: 'capture', label: 'Capture settings', whenToUse: 'Capture settings', descriptorUrl: authority, executable: true, requires: [RELAY_SIGNATURE], fields: [] });
  controls.push(setupControl(base));
  const links = [{ label: 'xAPI profile', href: PROFILE, rel: 'describedby', type: 'application/ld+json' }, { label: 'Affordance contracts', href: `${authority}?format=markdown`, rel: 'related', type: 'text/markdown' }, { label: 'Capture and coverage', href: `${base}/llm-telemetry/coverage`, rel: 'related', type: 'application/json' }];
  const title = /^# ([^\n]+)/.exec(body)?.[1] ?? 'LLM activity';
  const hmd = renderHypermediaMarkdown({ id: report ? `urn:uuid:${crypto.randomUUID()}` : `${base}/llm-telemetry`, type: 'schema:DigitalDocument', descriptorUrl: authority, title, body: hmdProse(body), controls, links });
  // Same affordance-derived document for the standard HMD representation and MCP App.
  return { descriptorUrl: authority, title, hmd, body: hmdProse(body).replace(/^# [^\n]+\n+/, ''), controls, links };
}

export function captureView(base: string, preferences: CapturePreferences) {
  const authority = `${base}/affordances`;
  const controls: Array<HypermediaControl & Json> = [];
  const choice = (id: string, label: string, patch: Record<string, boolean>) => {
    const payload = { ...patch, expected_revision: preferences.revision };
    controls.push({ ...affordanceControl(captureUpdateAffordance, base), id, label, whenToUse: label,
      descriptorUrl: authority, executable: true, requires: [RELAY_SIGNATURE], payload,
      fields: Object.entries(payload).map(([name, defaultValue]) => ({ name, path: `${base}/llm-telemetry/capture#${name}`, defaultValue,
        datatype: `http://www.w3.org/2001/XMLSchema#${typeof defaultValue === 'boolean' ? 'boolean' : 'integer'}`, minCount: 0 })),
    });
  };
  choice('server', `${preferences.server_enabled ? 'Disable' : 'Enable'} Interego recording`, { server_enabled: !preferences.server_enabled });
  choice('client', `${preferences.client_enabled ? 'Disable' : 'Enable'} client reporting`, { client_enabled: !preferences.client_enabled });
  choice('both', 'Enable both', { server_enabled: true, client_enabled: true });
  choice('neither', 'Disable both', { server_enabled: false, client_enabled: false });
  controls.push({ ...affordanceControl(captureReadAffordance, base), id: 'refresh-capture', whenToUse: 'Refresh settings', descriptorUrl: authority, executable: true, requires: [RELAY_SIGNATURE], fields: [] });
  const sessionFields = [{ name: 'view', path: `${base}/llm-telemetry/query#view`, defaultValue: 'sessions', datatype: 'http://www.w3.org/2001/XMLSchema#string', minCount: 0 }];
  controls.push({ ...affordanceControl(queryAction, base), id: 'sessions', whenToUse: 'My sessions', descriptorUrl: authority, executable: true, requires: [RELAY_SIGNATURE], fields: sessionFields });
  controls.push(setupControl(base));
  const title = 'Capture settings';
  const body = '# Capture settings\n\nChoose either source, both, or neither for this connected agent. Both default to off.\n\n'
    + table(['Source', 'Your choice', 'What it covers'], [
      ['Interego recording', preferences.server_enabled ? 'On' : 'Off', 'Authenticated calls through this Interego MCP server; no client plugin required.'],
      ['Client reporting', preferences.client_enabled ? 'On' : 'Off', 'Reports from installed host hooks or runtime adapters, including supported work outside Interego.'],
    ]) + '\n\nClient reporting uses the existing Interego connection. Open **Client reporting setup** for supported Codex and Claude Code configuration. No second MCP server or source build is required. Switching it on here permits reports; it does not install or trust host hooks. Browser chat coverage and unverified host setup are shown explicitly.\n\n'
    + 'Switching a source off refuses new automatic deliveries to Interego. To stop a host collector itself, disable its hooks or adapter there. Existing records remain available. Explicit manual observations remain separate signed actions.\n\n'
    + 'Both sources can observe the same operation. Reports preserve their source labels and count observations, not distinct work. Relay UTC-day groups are not chat sessions.\n\n'
    + `Settings revision: ${preferences.revision}.`;
  const links = [{ label: 'Capture coverage', href: `${base}/llm-telemetry/coverage`, rel: 'describedby', type: 'application/json' }];
  const hmd = renderHypermediaMarkdown({ id: `urn:uuid:${crypto.randomUUID()}`, type: 'schema:DigitalDocument', descriptorUrl: authority, title, body: hmdProse(body), controls, links });
  return { descriptorUrl: authority, title, hmd, body: hmdProse(body).replace(/^# [^\n]+\n+/, ''), controls, links };
}

export function clientSetupView(base: string, setup: ClientSetup) {
  const authority = `${base}/affordances`;
  const statusLabel = (status: string) => ({ 'configuration-available': 'Configuration available; host review required', 'configuration-prepared': 'Configuration ready; host activation not verified', 'connection-name-required': 'Enter your existing connection name', 'choose-client': 'Choose your client', 'host-setup-unverified': 'Client setup not verified for this surface', 'server-capture-only': 'Server capture only' }[status] ?? status);
  const controls: Array<HypermediaControl & Json> = setup.support.filter(host => host.support === 'configuration-available').map(host => ({
    ...affordanceControl(clientSetupAffordance, base), id: `setup-${host.client}`, label: `Set up ${host.label}`, whenToUse: `Set up ${host.label}`, descriptorUrl: authority, executable: true,
    fields: [
      { name: 'client', path: `${base}/llm-telemetry/client-setup#client`, defaultValue: host.client, datatype: 'http://www.w3.org/2001/XMLSchema#string', minCount: 0 },
      { name: 'server_name', path: `${base}/llm-telemetry/client-setup#server_name`, description: 'Exact name of your EXISTING Interego MCP connection in this client. Do not create another connection.', datatype: 'http://www.w3.org/2001/XMLSchema#string', minCount: 1, maxCount: 1, ...(setup.server_name ? { defaultValue: setup.server_name } : {}) },
    ],
  }));
  const links = [{ label: 'Capture coverage', href: `${base}/llm-telemetry/coverage`, rel: 'describedby', type: 'application/json' }];
  if (setup.configuration) links.unshift({ label: `Download ${setup.label} hook configuration`, href: `${base}/llm-telemetry/setup/config?client=${encodeURIComponent(setup.client)}&server_name=${encodeURIComponent(setup.server_name!)}`, rel: 'related', type: 'application/json' });
  if (setup.configuration) links.push({ label: 'Download Interego Activity native plugin', href: `${base}/llm-telemetry/setup/plugin?client=${encodeURIComponent(setup.client)}&server_name=${encodeURIComponent(setup.server_name!)}`, rel: 'related', type: 'application/zip' });
  links.push({ label: 'Native integration coverage and requirements', href: `${base}/llm-telemetry/native-integrations`, rel: 'describedby', type: 'application/json' });
  controls.push({ ...affordanceControl(collectorAffordances[0]!, base), id: 'collector-create', requires: [RELAY_SIGNATURE], label: 'Create native OTLP collector credential', whenToUse: 'Configure Claude Code native telemetry export', descriptorUrl: authority, executable: true, fields: [{ name: 'capture_mode', path: `${base}/llm-telemetry/collector#capture_mode`, datatype: 'http://www.w3.org/2001/XMLSchema#string', defaultValue: 'live', minCount: 1, maxCount: 1 }] });
  if (setup.documentation) links.push({ label: 'Official host documentation', href: setup.documentation, rel: 'describedby', type: 'text/html' });
  if (setup.verification_query) {
    const payload = setup.verification_query;
    controls.push({ ...affordanceControl(queryAction, base), id: 'client-evidence', label: 'Client reporting evidence', whenToUse: 'Client reporting evidence', descriptorUrl: authority, executable: true, requires: [RELAY_SIGNATURE], payload,
      fields: Object.entries(payload).map(([name, defaultValue]) => ({ name, path: `${base}/llm-telemetry/query#${name}`, defaultValue, datatype: 'http://www.w3.org/2001/XMLSchema#string', minCount: 0 })) });
  }
  controls.push({ ...affordanceControl(captureReadAffordance, base), id: 'capture', label: 'Capture settings', whenToUse: 'Capture settings', descriptorUrl: authority, executable: true, requires: [RELAY_SIGNATURE], fields: [] });
  const title = 'Client reporting setup';
  const body = '# Client reporting setup\n\nTelemetry uses your existing Interego MCP connection. Server capture already works without a client plugin. Optional host hooks send additional metadata to the same ingestion affordance.\n\n'
    + table(['Client', 'Setup availability'], setup.support.map(host => [host.label, statusLabel(host.support)])) + '\n\n'
    + `Selected: **${cell(setup.label)}**. Status: **${cell(statusLabel(setup.status))}**.\n\n`
    + `Prepared at ${cell(setup.prepared_at)}. The evidence query only includes live records from this time onward; confirm the session belongs to the host you configured.\n\n`
    + (setup.server_name ? `Existing connection name: ${cell(setup.server_name)}.\n\n` : '')
    + '## Requirements\n\n' + setup.requirements.map(s => `- ${s}`).join('\n') + '\n\n'
    + '## Setup\n\n' + setup.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n\n'
    + (setup.configuration ? 'Use the **Download hook configuration** link below. Your coding agent can merge these hook entries into the existing host settings while preserving unrelated configuration. Review the result in the host before activating it. This download contains configuration only; no new MCP server, executable, token or credential.\n\n' : '')
    + '## Coverage\n\n' + setup.limits.map(s => `- ${s}`).join('\n');
  const hmd = renderHypermediaMarkdown({ id: `${base}/llm-telemetry/setup`, type: 'schema:DigitalDocument', descriptorUrl: authority, title, body: hmdProse(body), controls, links });
  return { descriptorUrl: authority, title, hmd, body: hmdProse(body).replace(/^# [^\n]+\n+/, ''), controls, links };
}
