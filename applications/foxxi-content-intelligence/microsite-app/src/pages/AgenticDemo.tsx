import React, { useState, useSyncExternalStore } from 'react';
import { runDemo } from '../demo/demo-runtime.js';
import { getDemoState, subscribeDemo, clearDemo, type DemoEvent, type EventKind } from '../demo/demo-session.js';
import { BRIDGE_URL } from '../bridge-client.js';

type Lens = 'dev' | 'le' | 'pm';

const LENS_KINDS: Record<Lens, Set<EventKind>> = {
  dev: new Set<EventKind>(['identity', 'phase', 'thinking', 'tool-call', 'auth', 'xapi', 'scorm', 'verify', 'credential', 'error', 'done']),
  le: new Set<EventKind>(['identity', 'phase', 'scorm', 'xapi', 'verify', 'credential', 'error', 'done']),
  pm: new Set<EventKind>(['identity', 'phase', 'verify', 'credential', 'scorm', 'error', 'done']),
};
const LENS_LABEL: Record<Lens, string> = { dev: 'Developer', le: 'Learning engineer', pm: 'Performance manager' };
const LENS_BLURB: Record<Lens, string> = {
  dev: 'Raw MCP/affordance calls, rev-196 signatures, and xAPI — the wire.',
  le: 'The authored profile, SCORM course, cmi5 session + the learner record.',
  pm: 'Capability transfer + the issued competency credential — the outcome.',
};
const KIND_COLOR: Record<EventKind, string> = {
  identity: '#6b7280', phase: 'var(--accent)', thinking: '#8b8b8b', 'tool-call': '#2563eb',
  auth: '#0891b2', xapi: '#7c3aed', scorm: '#059669', verify: '#d97706', credential: '#db2777', error: '#dc2626', done: 'var(--accent)',
};

export function AgenticDemo({ onHome, onReports }: { onHome: () => void; onReports?: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [lens, setLens] = useState<Lens>('dev');
  const state = useSyncExternalStore(subscribeDemo, getDemoState);
  const running = state.status === 'running';

  async function run() {
    if (!apiKey.trim() || running) return;
    await runDemo(apiKey.trim()); // writes to the shared store; never throws
  }

  const visible = (a: 'A' | 'B') => state.events.filter(e => e.agent === a && LENS_KINDS[lens].has(e.kind));
  const phase = [...state.events].reverse().find(e => e.kind === 'phase');
  const done = state.events.find(e => e.kind === 'done');
  const credential = state.events.find(e => e.kind === 'credential');
  const hasRun = state.events.length > 0 || state.status !== 'idle';

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: "'EB Garamond', serif", fontSize: 34, margin: '10px 0 6px' }}>Two agents, learning live</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 760, lineHeight: 1.5 }}>
        Two <strong>fresh, self‑sovereign AI agents</strong> teach and credential each other on the live Foxxi substrate —
        nothing scripted. Agent A authors a custom xAPI profile + a SCORM course, assigns it to Agent B, who completes it
        (real cmi5 trace), performs the learned skill, and earns a verifiable credential. Every step is a real signed call
        to <code style={code}>{BRIDGE_URL}</code>. <strong>Bring your own Anthropic key</strong> (used only in your browser).
        {onReports && <> The <button onClick={onReports} style={{ ...linkBtn, fontSize: 16 }}>Reports</button> tab shows these agents' live LMS/LRS records.</>}
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '18px 0 6px' }}>
        <input type="password" value={apiKey} disabled={running} onChange={e => setApiKey(e.target.value)}
          placeholder="sk-ant-… (your Anthropic API key, stays in this tab)"
          style={{ flex: '1 1 360px', padding: '11px 13px', border: '1px solid var(--border)', borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }} />
        <button onClick={run} disabled={running || !apiKey.trim()} style={{ ...runBtn, opacity: running || !apiKey.trim() ? 0.5 : 1 }}>
          {running ? 'Running…' : hasRun ? 'Run again' : 'Run the demo'}
        </button>
        {hasRun && !running && <button onClick={clearDemo} style={{ ...pill, borderColor: 'var(--border)' }}>Clear</button>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Your key calls <code style={code}>api.anthropic.com</code> directly from this browser tab; it is never sent to our servers. Results persist as you switch tabs.
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '22px 0 4px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)' }}>Lens</span>
        {(['dev', 'le', 'pm'] as Lens[]).map(l => (
          <button key={l} onClick={() => setLens(l)} style={{ ...pill, background: lens === l ? 'var(--accent)' : 'transparent', color: lens === l ? 'var(--panel)' : 'var(--text)', borderColor: lens === l ? 'var(--accent)' : 'var(--border)' }}>{LENS_LABEL[l]}</button>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 6 }}>{LENS_BLURB[lens]}</span>
      </div>

      {phase && (
        <div style={{ margin: '12px 0', padding: '10px 14px', background: 'var(--text)', color: 'var(--panel)', borderRadius: 6, fontSize: 14, borderLeft: '4px solid var(--accent)' }}>
          {done ? `✓ ${done.title}` : phase.title}
        </div>
      )}
      {state.error && <div style={{ margin: '10px 0', padding: '10px 14px', background: '#fde8e8', color: '#dc2626', borderRadius: 6, fontSize: 13 }}>⚠ {state.error}</div>}
      {credential && (
        <div style={{ margin: '12px 0', padding: '12px 16px', background: '#fdf2f8', border: '1px solid #db2777', borderRadius: 8, fontSize: 14, color: '#9d174d' }}>
          🎓 <strong>Credential issued.</strong> Agent A attested Agent B's competency as an Open Badges 3.0 verifiable credential, now in B's pod wallet — {credential.detail}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <AgentColumn label="Agent A — teacher · issuer · observer" did={state.agents.A?.did} events={visible('A')} running={running} />
        <AgentColumn label="Agent B — learner · performer" did={state.agents.B?.did} events={visible('B')} running={running} />
      </div>

      {!hasRun && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 22 }}>
          Enter your key and press <em>Run the demo</em>. The two agents will appear and start acting against the live bridge.
        </p>
      )}
    </div>
  );
}

function AgentColumn({ label, did, events, running }: { label: string; did?: string; events: DemoEvent[]; running: boolean }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 360 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        {did && <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-dim)', wordBreak: 'break-all' }}>{did}</div>}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', maxHeight: 520, padding: '6px 0' }}>
        {events.length === 0 && <div style={{ padding: 16, color: 'var(--text-dim)', fontSize: 13 }}>{running ? 'waiting for activity…' : '—'}</div>}
        {events.map(e => <EventRow key={e.id} e={e} />)}
      </div>
    </div>
  );
}

/** Pull the most meaningful artifacts out of an event's data for inline display. */
function artifactsOf(data: unknown): Array<{ label: string; text?: string; json?: unknown }> {
  const d = (data ?? {}) as Record<string, any>;
  const out: Array<{ label: string; text?: string; json?: unknown }> = [];
  const turtle = d?.artifact?.turtle ?? (d?.mediaType === 'text/turtle' ? d?.turtle : undefined);
  if (turtle) out.push({ label: 'artifact · Turtle (composes the IEEE-LER / ADL-TLA layer)', text: String(turtle) });
  else if (d?.artifact) out.push({ label: 'artifact · xAPI Profile fragment', json: d.artifact });
  if (d?.descriptor) out.push({ label: 'self-descriptive descriptor (cg:StandardsExtension)', json: d.descriptor });
  if (d?.elr?.competencies) out.push({ label: 'ELR competencies', json: d.elr.competencies });
  if (d?.credential || d?.issuerDid) out.push({ label: 'credential (OB3 / VC)', json: d.credential ?? d });
  if (d?.graded) out.push({ label: 'assessment grading', json: d.graded });
  if (d?._guidance) out.push({ label: 'performance support (in the flow)', json: d._guidance });
  // Always offer the full envelope last.
  out.push({ label: 'full response / call', json: data });
  return out;
}

function EventRow({ e }: { e: DemoEvent }) {
  const [open, setOpen] = useState(false);
  const color = KIND_COLOR[e.kind] ?? '#6b7280';
  const longDetail = !!e.detail && e.detail.length > 150;
  const expandable = e.data != null || longDetail;
  const arts = open && e.data != null ? artifactsOf(e.data) : [];
  return (
    <div style={{ borderBottom: '1px solid #f0f0ee', borderLeft: `3px solid ${color}` }}>
      <div onClick={() => expandable && setOpen(o => !o)}
        style={{ padding: '8px 14px', cursor: expandable ? 'pointer' : 'default', display: 'flex', gap: 8, alignItems: 'baseline' }}>
        {expandable && <span style={{ color, fontSize: 10, width: 10, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>}
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color, minWidth: 74, flexShrink: 0 }}>{e.kind}</span>
        <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{e.title}</span>
      </div>
      {e.detail && (
        <div style={{
          fontSize: 12.5, color: 'var(--text-dim)', padding: '0 14px 8px', marginLeft: expandable ? 18 : 0,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          ...(open ? {} : { maxHeight: 38, overflow: 'hidden' }),
        }}>{e.detail}</div>
      )}
      {open && (
        <div style={{ padding: '0 14px 10px', marginLeft: 18, display: 'grid', gap: 8 }}>
          {(e.data as any)?.checks && <VerificationMatrix d={e.data as any} />}
          {(e.data as any)?.sharedLattice && <LatticeBadge sl={(e.data as any).sharedLattice} />}
          {arts.map((a, i) => (
            <div key={i}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', marginBottom: 3 }}>{a.label}</div>
              <pre style={{ fontSize: 10.5, lineHeight: 1.45, background: '#0f1115', color: '#cdd6e0', padding: 10, borderRadius: 5, overflow: 'auto', maxHeight: 300, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
{a.text ?? JSON.stringify(a.json, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const vMono = "'JetBrains Mono', monospace";
const artLabel: React.CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', marginBottom: 3 };

/** The issuer's due diligence, unfurled: the verify_extension `checks` as a 3-tier
 *  matrix. Honest by construction — engine grading + shape conformance are
 *  tamper-evident; the performance OUTCOME is flagged as self-attested. */
function VerificationMatrix({ d }: { d: any }) {
  const c = d.checks ?? {};
  const rows = [
    { label: 'Engine grading', sub: 'SCORM SN runtime — tamper-evident', ok: !!c.independentlyGraded, badge: c.gradedScore != null ? `score ${c.gradedScore}` : (c.independentlyGraded ? 'graded' : 'no grade') },
    { label: 'Performance', sub: c.selfAttestedPerformance ? 'recorded on subject’s pod — ⚠ outcome self-attested' : 'recorded on subject’s pod', ok: !!c.performanceRecorded, badge: c.performanceRecorded ? 'recorded' : 'none' },
    { label: 'Extension shape', sub: 'PGSL / SHACL structural check', ok: !!c.shapeConformant, badge: c.shapeConformant ? 'conforms' : '—' },
  ];
  const n = Array.isArray(d.evidence) ? d.evidence.length : 0;
  return (
    <div>
      <div style={artLabel}>independent verification — {d.verified ? 'PASSED' : 'INSUFFICIENT'}</div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: i < 2 ? '1px solid #f0f0ee' : 'none', fontSize: 12 }}>
            <span style={{ color: r.ok ? '#2e9c4a' : '#d23f31', fontWeight: 600, width: 12 }}>{r.ok ? '✓' : '✗'}</span>
            <span style={{ flex: 1 }}><strong>{r.label}</strong> <span style={{ color: 'var(--text-dim)' }}>— {r.sub}</span></span>
            <span style={{ fontFamily: vMono, fontSize: 10.5, color: 'var(--text-dim)' }}>{r.badge}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.45 }}>
        Engine grading + shape conformance are tamper-evident; the performance outcome is self‑attested by the subject. {n > 0 ? `${n} evidencing statement${n === 1 ? '' : 's'} on the subject’s own pod.` : ''}
      </div>
    </div>
  );
}

/** Every artifact snaps onto the shared, content-addressed PGSL lattice — show the
 *  reuse counts (honest: counts only, already returned by the bridge). */
function LatticeBadge({ sl }: { sl: any }) {
  const reused = Number(sl.reusedNodes ?? 0), nu = Number(sl.newNodes ?? 0);
  return (
    <div>
      <div style={artLabel}>shared PGSL lattice (canonical)</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        composed <strong>{reused + nu}</strong> terms · <strong style={{ color: '#2e9c4a' }}>{reused}</strong> reused from the substrate · {nu} new
        {sl.stats ? <> · lattice now <code style={{ fontFamily: vMono, fontSize: 11 }}>{sl.stats.atoms} atoms / {sl.stats.fragments} fragments</code></> : null}
        {Array.isArray(sl.projections) && sl.projections.length ? <> · projects as {sl.projections.join(' / ')}</> : null}
      </div>
    </div>
  );
}

const runBtn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '5px 13px', fontSize: 12, cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };
const code: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
