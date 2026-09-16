import { renderHypermediaMarkdown, actionUrl, type HypermediaControl } from '@interego/core';
import { hmdProse, affordanceControl } from '../_shared/hypermedia/index.js';
import { telemetryAffordances, queryInputs } from './affordances.js';
import { telemetryMetadata, type Json } from './events.js';
import { PROFILE, RELAY_SIGNATURE } from './profile.js';

const queryAction = telemetryAffordances[2]!;
const cell = (x: unknown) => String(x ?? '—').replace(/[|\r\n]/g, ' ').replace(/[\[\]<>`]/g, '');
const table = (headers: string[], rows: unknown[][]) => `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(r => `| ${r.map(cell).join(' | ')} |`).join('\n')}`;

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
    body = '# LLM activity\n\nSee which sessions are reporting, follow work across agents and tools, and inspect the evidence behind each insight.\n\nOpen **My sessions** to load your private records. Use **Query** to narrow the time range, model or runtime.\n\nCapture collects identifiers, lifecycle events and reported usage. Message contents, tool arguments, credentials and transcripts are excluded.\n\n**Coverage is measured from received events.** Installing the hook integration and reviewing its trust request enables capture on supported hosts; this page alone does not activate it.';
    control('sessions', 'My sessions', { view: 'sessions' });
    control('report', 'Activity report', { view: 'report' });
    control('query', 'Query');
  } else {
    const t = report.totals, c = report.coverage; const selectedView = report.query.view ?? (report.query.session_id ? 'timeline' : 'sessions');
    body = `# ${selectedView === 'timeline' ? 'Session timeline' : selectedView === 'report' ? 'Activity report' : selectedView === 'export' ? 'xAPI export' : 'Your sessions'}\n\n`
      + `${t.events} observations · ${t.sessions} sessions · ${t.errors} explicit failure observations\n\n`
      + table(['Input tokens reported', 'Output tokens reported', 'Events in encrypted history'], [[t.input_tokens ?? 'Unknown', t.output_tokens ?? 'Unknown', `${c.durable_matching_events}/${t.events}`]])
      + `\n\nSource coverage: ${Object.entries(c.sources).map(([s, n]) => `${cell(s)} (${n})`).join(', ') || 'No reporting source observed'}. `
      + `LRS: ${c.lrs_available ? 'available' : 'unavailable'}. Encrypted history: ${c.encrypted_history_available ? 'available' : 'unavailable'}.\n\n`;
    if (!c.complete_for_available_snapshot) body += '**This snapshot is incomplete or contains conflicting records.** The coverage fields identify the unavailable sources or conflicting statement IDs.\n\n';
    if (selectedView === 'sessions') {
      body += table(['Session', 'Source / mode', 'Last seen (UTC)', 'Events', 'Agents', 'Status'], report.sessions.slice(0, 30).map((s: Json) => [s.session_id, `${s.source} / ${s.capture_modes.join(', ')}`, s.last_seen, s.events, s.agents.length, s.ended ? 'End observed' : 'Last seen; end unknown'])) + '\n\n';
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
  const links = [{ label: 'xAPI profile', href: PROFILE, rel: 'describedby', type: 'application/ld+json' }, { label: 'Affordance contracts', href: `${authority}?format=markdown`, rel: 'related', type: 'text/markdown' }, { label: 'Capture and coverage', href: `${base}/llm-telemetry/coverage`, rel: 'related', type: 'application/json' }];
  const title = /^# ([^\n]+)/.exec(body)?.[1] ?? 'LLM activity';
  const hmd = renderHypermediaMarkdown({ id: report ? `urn:uuid:${crypto.randomUUID()}` : `${base}/llm-telemetry`, type: 'schema:DigitalDocument', descriptorUrl: authority, title, body: hmdProse(body), controls, links });
  // Same affordance-derived document for the standard HMD representation and MCP App.
  return { descriptorUrl: authority, title, hmd, body: hmdProse(body).replace(/^# [^\n]+\n+/, ''), controls, links };
}
