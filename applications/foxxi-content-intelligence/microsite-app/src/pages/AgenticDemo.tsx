import React, { useRef, useState } from 'react';
import { runDemo, type DemoEvent, type EventKind } from '../demo/demo-runtime.js';
import { BRIDGE_URL } from '../bridge-client.js';

type Lens = 'dev' | 'le' | 'pm';

/** Which event kinds each role lens surfaces (one live dataset, three lenses). */
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

export function AgenticDemo({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [lens, setLens] = useState<Lens>('dev');
  const [fatal, setFatal] = useState<string | null>(null);
  const idRef = useRef(0);

  function emit(e: Omit<DemoEvent, 'id' | 'ts'>) {
    setEvents(prev => [...prev, { ...e, id: idRef.current++, ts: new Date().toISOString() }]);
  }

  async function run() {
    if (!apiKey.trim() || running) return;
    setEvents([]); setFatal(null); setRunning(true); idRef.current = 0;
    try { await runDemo(apiKey.trim(), emit); }
    catch (err) { setFatal((err as Error).message); emit({ agent: 'sys', kind: 'error', title: 'run halted', detail: (err as Error).message }); }
    finally { setRunning(false); }
  }

  const visible = (a: 'A' | 'B') => events.filter(e => e.agent === a && LENS_KINDS[lens].has(e.kind));
  const phase = [...events].reverse().find(e => e.kind === 'phase');
  const done = events.find(e => e.kind === 'done');
  const credential = events.find(e => e.kind === 'credential');
  const idA = events.find(e => e.agent === 'A' && e.kind === 'identity');
  const idB = events.find(e => e.agent === 'B' && e.kind === 'identity');

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: "'EB Garamond', serif", fontSize: 34, margin: '10px 0 6px' }}>
        Two agents, learning live
      </h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 760, lineHeight: 1.5 }}>
        Watch two <strong>fresh, self‑sovereign AI agents</strong> teach and credential each other on the live
        Foxxi substrate — nothing scripted. Agent A authors a custom xAPI profile and a SCORM course, assigns it
        to Agent B, who completes it (real cmi5 trace), performs the learned skill, and earns a verifiable
        credential. Every step is a real signed call to <code style={code}>{BRIDGE_URL}</code> — discover the
        affordances, sign, act. <strong>Bring your own Anthropic key</strong> (used only in your browser).
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '18px 0 6px' }}>
        <input
          type="password" value={apiKey} disabled={running}
          onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-… (your Anthropic API key, stays in this tab)"
          style={{ flex: '1 1 360px', padding: '11px 13px', border: '1px solid var(--border)', borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}
        />
        <button onClick={run} disabled={running || !apiKey.trim()} style={{ ...runBtn, opacity: running || !apiKey.trim() ? 0.5 : 1 }}>
          {running ? 'Running…' : 'Run the demo'}
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Your key calls <code style={code}>api.anthropic.com</code> directly from this browser tab (BYO‑key pattern); it is never sent to our servers.
      </div>

      {/* Role lens */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '22px 0 4px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)' }}>Lens</span>
        {(['dev', 'le', 'pm'] as Lens[]).map(l => (
          <button key={l} onClick={() => setLens(l)} style={{
            ...pill, background: lens === l ? 'var(--accent)' : 'transparent', color: lens === l ? 'var(--panel)' : 'var(--text)',
            borderColor: lens === l ? 'var(--accent)' : 'var(--border)',
          }}>{LENS_LABEL[l]}</button>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 6 }}>{LENS_BLURB[lens]}</span>
      </div>

      {phase && (
        <div style={{ margin: '12px 0', padding: '10px 14px', background: 'var(--text)', color: 'var(--panel)', borderRadius: 6, fontSize: 14, borderLeft: '4px solid var(--accent)' }}>
          {done ? `✓ ${done.title}` : phase.title}
        </div>
      )}
      {fatal && <div style={{ margin: '10px 0', padding: '10px 14px', background: '#fde8e8', color: '#dc2626', borderRadius: 6, fontSize: 13 }}>⚠ {fatal}</div>}
      {credential && (
        <div style={{ margin: '12px 0', padding: '12px 16px', background: '#fdf2f8', border: '1px solid #db2777', borderRadius: 8, fontSize: 14, color: '#9d174d' }}>
          🎓 <strong>Credential issued.</strong> Agent A attested Agent B's competency as an Open Badges 3.0 verifiable credential, now in B's pod wallet — {credential.detail}
        </div>
      )}

      {/* Per-agent live streams */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <AgentColumn label="Agent A — teacher · issuer · observer" did={idA?.detail} events={visible('A')} empty={running} />
        <AgentColumn label="Agent B — learner · performer" did={idB?.detail} events={visible('B')} empty={running} />
      </div>

      {!running && events.length === 0 && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 22 }}>
          Enter your key and press <em>Run the demo</em>. The two agents will appear and start acting against the live bridge.
        </p>
      )}
    </div>
  );
}

function AgentColumn({ label, did, events, empty }: { label: string; did?: string; events: DemoEvent[]; empty: boolean }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 360 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        {did && <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-dim)', wordBreak: 'break-all' }}>{did}</div>}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', maxHeight: 520, padding: '6px 0' }}>
        {events.length === 0 && <div style={{ padding: 16, color: 'var(--text-dim)', fontSize: 13 }}>{empty ? 'waiting for activity…' : '—'}</div>}
        {events.map(e => <EventRow key={e.id} e={e} />)}
      </div>
    </div>
  );
}

function EventRow({ e }: { e: DemoEvent }) {
  const [open, setOpen] = useState(false);
  const color = KIND_COLOR[e.kind] ?? '#6b7280';
  return (
    <div style={{ padding: '8px 14px', borderBottom: '1px solid #f0f0ee', borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color, minWidth: 78 }}>{e.kind}</span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{e.title}</span>
      </div>
      {e.detail && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: e.kind === 'thinking' ? 120 : undefined, overflow: 'auto' }}>{e.detail}</div>}
      {e.data != null && (
        <div style={{ marginTop: 3 }}>
          <button onClick={() => setOpen(o => !o)} style={{ ...linkBtn, fontSize: 11 }}>{open ? 'hide' : 'raw'}</button>
          {open && <pre style={{ fontSize: 10.5, background: '#0f1115', color: '#cdd6e0', padding: 10, borderRadius: 5, overflow: 'auto', maxHeight: 240, marginTop: 4 }}>{JSON.stringify(e.data, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

const runBtn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '5px 13px', fontSize: 12, cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };
const code: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
