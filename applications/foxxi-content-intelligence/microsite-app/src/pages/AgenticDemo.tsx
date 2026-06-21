import React, { useState, useEffect, useMemo, useSyncExternalStore } from 'react';
import { runDemo } from '../demo/demo-runtime.js';
import { getDemoState, subscribeDemo, clearDemo, type DemoEvent, type EventKind, type DemoAgent } from '../demo/demo-session.js';
import { BRIDGE_URL } from '../bridge-client.js';

/** A pinned landing tour = a REAL completed run's captured event stream + its agents. */
interface TourFixture { agents: { A?: DemoAgent; B?: DemoAgent; C?: DemoAgent }; events: DemoEvent[]; eventCount?: number; pinnedAt?: string }

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
  const [replayN, setReplayN] = useState<number | null>(null);   // reveal cursor (null = not playing)
  const [tour, setTour] = useState<TourFixture | null>(null);    // pinned landing tour (a REAL run)
  const [mode, setMode] = useState<'live' | 'tour'>('live');     // which event source the page shows
  const [pinMsg, setPinMsg] = useState('');                      // operator pin feedback
  const state = useSyncExternalStore(subscribeDemo, getDemoState);
  const running = state.status === 'running';

  // Fetch the pinned landing tour once — a no-key visitor can watch a real run.
  useEffect(() => {
    let alive = true;
    fetch(`${BRIDGE_URL}/agent/landing-tour`).then(r => r.json()).then(j => {
      if (alive && j?.present && Array.isArray(j.tour?.events) && j.tour.events.length) setTour(j.tour as TourFixture);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  async function run() {
    if (!apiKey.trim() || running) return;
    setMode('live'); setReplayN(null);
    await runDemo(apiKey.trim()); // writes to the shared store; never throws
  }

  // The active event source: the visitor's OWN live run, or the pinned tour.
  const srcEvents = mode === 'tour' && tour ? tour.events : state.events;
  const srcAgents = mode === 'tour' && tour ? tour.agents : state.agents;

  // Incremental reveal (no key, no bridge calls) — drives BOTH the own-run replay
  // and the pinned-tour autoplay. Re-watch the wow without spending a token.
  useEffect(() => {
    if (replayN == null) return;
    if (replayN >= srcEvents.length) { const t = setTimeout(() => setReplayN(null), 1800); return () => clearTimeout(t); }
    const t = setTimeout(() => setReplayN(n => (n == null ? null : n + 1)), 480);
    return () => clearTimeout(t);
  }, [replayN, srcEvents.length]);

  const shown = replayN == null ? srcEvents : srcEvents.slice(0, replayN);
  const visible = (a: 'A' | 'B' | 'C') => shown.filter(e => e.agent === a && LENS_KINDS[lens].has(e.kind));
  const phase = [...shown].reverse().find(e => e.kind === 'phase');
  const done = shown.find(e => e.kind === 'done');
  const credential = shown.find(e => e.kind === 'credential');
  const showC = !!srcAgents.C && shown.some(e => e.agent === 'C');
  // A tour with model `thinking` events is an emergent BYOK capture; one without is a
  // real headless protocol capture (no LLM in the loop). Label honestly either way.
  const tourHasReasoning = !!tour?.events?.some(e => e.kind === 'thinking');
  const tourProvenance = tourHasReasoning
    ? 'a real prior run (real agents, real artifacts, real reasoning)'
    : 'a real prior run (real agents, real signed calls, real artifacts) — captured headlessly, so it shows the protocol flow without the model’s reasoning narration';
  const hasRun = state.events.length > 0 || state.status !== 'idle';
  const liveComplete = !running && !!state.events.find(e => e.kind === 'done') && !!state.agents.C; // a pinnable run

  function watchTour() { setMode('tour'); setReplayN(0); }
  function exitTour() { setMode('live'); setReplayN(null); }
  async function pinTour() {
    const pin = window.prompt('Operator pin — publish THIS run as the no-key landing tour for all visitors:');
    if (!pin) return;
    setPinMsg('pinning…');
    try {
      const r = await fetch(`${BRIDGE_URL}/agent/landing-tour`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, agents: state.agents, events: state.events }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.pinned) { setPinMsg(`✓ pinned as the landing tour (${j.eventCount} events) — no-key visitors now see this run`); setTour({ agents: state.agents, events: state.events }); }
      else setPinMsg(`✗ ${j?.error ?? `HTTP ${r.status}`}`);
    } catch (e) { setPinMsg(`✗ ${(e as Error).message}`); }
  }

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
        {/* Watch the pinned tour (a real run) — for no-key visitors */}
        {tour && mode === 'live' && !running && <button onClick={watchTour} style={{ ...pill, borderColor: 'var(--accent)', color: 'var(--accent)' }}>&#9654; Watch a recorded run (no key)</button>}
        {mode === 'tour' && <button onClick={exitTour} style={{ ...pill, borderColor: 'var(--border)' }}>&#10005; Exit recorded run</button>}
        {/* Replay the visitor's OWN run */}
        {mode === 'live' && hasRun && !running && replayN == null && <button onClick={() => setReplayN(0)} style={{ ...pill, borderColor: 'var(--accent)', color: 'var(--accent)' }}>&#9654; Replay (no key)</button>}
        {mode === 'live' && replayN != null && <button onClick={() => setReplayN(null)} style={{ ...pill, borderColor: 'var(--border)' }}>&#9632; Stop replay</button>}
        {/* Operator: pin this completed run as the public landing tour */}
        {liveComplete && mode === 'live' && replayN == null && <button onClick={pinTour} style={{ ...pill, borderColor: 'var(--border)' }}>&#128204; Pin as landing tour</button>}
        {mode === 'live' && hasRun && !running && <button onClick={clearDemo} style={{ ...pill, borderColor: 'var(--border)' }}>Clear</button>}
      </div>
      {pinMsg && <div style={{ fontSize: 12, color: pinMsg.startsWith('✗') ? '#dc2626' : 'var(--accent)', marginTop: 4 }}>{pinMsg}</div>}
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Your key calls <code style={code}>api.anthropic.com</code> directly from this browser tab; it is never sent to our servers. Results persist as you switch tabs.
      </div>

      {tour && !hasRun && mode === 'live' && (
        <div style={{ margin: '14px 0 0', padding: '11px 15px', background: 'var(--panel)', border: '1px solid var(--accent)', borderRadius: 8, fontSize: 13, color: 'var(--text)' }}>
          &#9654; A <strong>recorded run</strong> is available — <button onClick={watchTour} style={{ ...linkBtn, fontSize: 13, color: 'var(--accent)' }}>watch it now</button> with no key. It’s {tourProvenance}, replayed locally — enter your key above to run your own live.
        </div>
      )}
      {mode === 'tour' && (
        <div style={{ margin: '14px 0 0', padding: '11px 15px', background: '#fffbeb', border: '1px solid #d97706', borderRadius: 8, fontSize: 13, color: '#92400e' }}>
          &#9654; <strong>Recorded run.</strong> This is {tourProvenance}, replayed locally (no key, no live calls). To run your own live, <button onClick={exitTour} style={{ ...linkBtn, fontSize: 13, color: '#92400e' }}>exit</button> and enter your Anthropic key.
        </div>
      )}

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

      <div style={{ display: 'grid', gridTemplateColumns: showC ? '1fr 1fr 1fr' : '1fr 1fr', gap: 16, marginTop: 16 }}>
        <AgentColumn label="Agent A — teacher · issuer · observer" did={srcAgents.A?.did} events={visible('A')} running={running} />
        <AgentColumn label="Agent B — learner · performer" did={srcAgents.B?.did} events={visible('B')} running={running} />
        {showC && <AgentColumn label="Agent C — independent verifier (no prior relationship)" did={srcAgents.C?.did} events={visible('C')} running={running} />}
      </div>

      {/* Interrogating a holon needs it resident on the bridge — true right after a
          live run (the lattice is fresh), but a recorded tour's holon may have been
          evicted, so only offer it for the visitor's own live run. Bind to the FULL
          live event list (not the replay slice `shown`) so the target holon is stable
          and the panel doesn't flicker / re-bind as the no-key replay cursor advances. */}
      {mode === 'live' && <InterrogatePanel events={srcEvents} agents={srcAgents} />}

      {!hasRun && mode === 'live' && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 22 }}>
          Enter your key and press <em>Run the demo</em>. The two agents will appear and start acting against the live bridge.{tour && <> Or <button onClick={watchTour} style={{ ...linkBtn, fontSize: 13 }}>watch a recorded run</button> first — no key needed.</>}
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
  if (d?.descriptor) out.push({ label: 'self-descriptive descriptor (iep:StandardsExtension)', json: d.descriptor });
  if (d?.elr?.competencies) out.push({ label: 'ELR competencies', json: d.elr.competencies });
  if (d?.justifiedBy) out.push({ label: 'chain of custody → justified by verification holon', text: String(d.justifiedBy) });
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
          {(e.data as any)?.envelope && <WireTrace d={e.data as any} />}
          {(e.data as any)?.checks && <VerificationMatrix d={e.data as any} />}
          {(e.data as any)?.revealed && (e.data as any)?.hiddenPaths && <SelectiveDisclosure d={e.data as any} />}
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

/** The wire: the exact rev-196 signed envelope, the signer recovered from those
 *  bytes (client-side, zero trust in the bridge), and a copy-paste curl recipe.
 *  This is "watch the protocol" — no account, no OAuth, just a signature. */
function WireTrace({ d }: { d: any }) {
  const [copied, setCopied] = useState(false);
  const recovered = String(d.recoveredSigner ?? '').toLowerCase();
  const expected = String(d.expectedSigner ?? '').toLowerCase();
  const ok = recovered && recovered === expected;
  const payload = (() => { try { return JSON.stringify(JSON.parse(d.envelope._signed_payload), null, 2); } catch { return String(d.envelope?._signed_payload ?? ''); } })();
  return (
    <div>
      <div style={artLabel}>the wire — rev-196 signed envelope (no account · no OAuth · no directory)</div>
      <div style={{ fontSize: 11.5, color: ok ? '#2e9c4a' : '#d23f31', marginBottom: 4 }}>
        {ok ? '✓' : '✗'} signer recovered from the bytes alone: <code style={{ fontFamily: vMono, fontSize: 10.5 }}>{recovered.slice(0, 16)}…</code> {ok ? '= the acting agent (the bridge is not trusted to assert who acted)' : '≠ expected'}
      </div>
      <div style={{ ...artLabel, marginTop: 4 }}>POST {d.path} · _signed_payload</div>
      <pre style={{ fontSize: 10.5, lineHeight: 1.45, background: '#0f1115', color: '#cdd6e0', padding: 10, borderRadius: 5, overflow: 'auto', maxHeight: 220, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{payload}</pre>
      <div style={{ ...artLabel, marginTop: 6 }}>_signature (secp256k1)</div>
      <pre style={{ fontSize: 10, lineHeight: 1.4, background: '#0f1115', color: '#8b9bb0', padding: 8, borderRadius: 5, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{d.envelope?._signature}</pre>
      <button onClick={() => { navigator.clipboard?.writeText(String(d.curl ?? '')); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        style={{ ...pill, marginTop: 6, borderColor: 'var(--accent)', color: 'var(--accent)' }}>{copied ? '✓ copied' : 'Copy as curl — reproduce from a shell'}</button>
    </div>
  );
}

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
      {d.verificationHolonUri ? (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
          &#8627; published as a dereferenceable <strong>iep:Verification</strong> holon (chain of custody: credential &rarr; verification &rarr; evidence) &mdash; explore it in <em>Reports &rarr; Lattice (PGSL)</em>.
        </div>
      ) : null}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.45 }}>
        Engine grading + shape conformance are tamper-evident; the performance outcome is self‑attested by the subject. {n > 0 ? `${n} evidencing statement${n === 1 ? '' : 's'} on the subject’s own pod.` : ''}
      </div>
    </div>
  );
}

/** BBS+ selective disclosure: what the verifier learns vs. what stays cryptographically
 *  hidden — split-pane from the prove_competency response (revealed + hiddenPaths). */
function SelectiveDisclosure({ d }: { d: any }) {
  const revealed = (d.revealed ?? []) as Array<{ path: string; value: string }>;
  const hidden = (d.hiddenPaths ?? []) as string[];
  const tail = (p: string) => p.replace(/^achievement\./, '').replace(/\[0\]/, '').replace(/^issuer$/, 'issuer');
  return (
    <div>
      <div style={artLabel}>BBS+ selective disclosure — revealed vs. cryptographically hidden</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div style={{ border: '1px solid #2e9c4a', borderRadius: 6, padding: 8 }}>
          <div style={{ fontSize: 10.5, color: '#2e9c4a', fontWeight: 600, marginBottom: 4 }}>REVEALED ({revealed.length}) — what the verifier learns</div>
          {revealed.map((r, i) => <div key={i} style={{ fontSize: 11.5, lineHeight: 1.5 }}><strong>{tail(r.path)}</strong>: <span style={{ wordBreak: 'break-all' }}>{r.value.length > 44 ? r.value.slice(0, 44) + '…' : r.value}</span></div>)}
        </div>
        <div style={{ border: '1px solid #d23f31', borderRadius: 6, padding: 8 }}>
          <div style={{ fontSize: 10.5, color: '#d23f31', fontWeight: 600, marginBottom: 4 }}>HIDDEN ({hidden.length}) — withheld by the proof</div>
          {hidden.map((h, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>🔒 {tail(h)}</div>)}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.45 }}>
        Real W3C BBS+ (bbs‑2023) selective‑disclosure proof — the verifier confirms the issuer signed exactly the revealed claims, and learns nothing about the hidden ones (no score, name, or dates). It proves issuer-signed possession, not a zero-knowledge predicate.
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

// ── Interrogatives: ask the substrate WHO/WHAT/WHEN/WHY/HOW-MUCH about the run ──
// Interego maps the canonical interrogatives (ie:) to descriptor facets. After a
// run, B's recorded performance is a published holon; the bridge routes the
// interrogative grammar over its REAL descriptor bytes and resolves the pointers
// it can satisfy locally (the What artifact + the HowMuch lattice cardinality).
// Nothing synthetic — this reads the same descriptor the Pod browser shows.
const IE_GLOSS: Record<string, string> = {
  Who: 'who asserted it', What: 'what it is', When: 'when it became valid',
  Where: 'where it lives', Why: 'why — motive / cause', How: 'how it was produced',
  Which: 'which alternative', WhatKind: 'what kind — interpretation frame',
  HowMuch: 'how much — extent / confidence', Whose: 'whose authority', Whether: 'whether — trust / permission',
};
const IE_ORDER = ['Who', 'What', 'When', 'WhatKind', 'Whether', 'Why', 'How', 'HowMuch', 'Where', 'Which', 'Whose'];
const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  full: { bg: 'rgba(46,160,67,0.14)', fg: '#2e9c4a' },
  partial: { bg: 'rgba(217,119,6,0.14)', fg: '#b45309' },
  pointer: { bg: 'rgba(37,99,235,0.14)', fg: '#2563eb' },
  absent: { bg: 'rgba(107,114,128,0.12)', fg: '#6b7280' },
};

interface HolonTarget { holonUri: string; label: string; did: string; agent: 'A' | 'B' | 'C'; descriptorUrl?: string; title: string; }
/** The most recent shown event carrying a published holon (prefer B's performance). */
function findHolonTarget(events: DemoEvent[], agents: { A?: DemoAgent; B?: DemoAgent; C?: DemoAgent }): HolonTarget | null {
  let fallback: HolonTarget | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const sl = (e.data as any)?.sharedLattice;
    const uri: string | undefined = sl?.holonUri;
    if (!uri || (e.agent !== 'A' && e.agent !== 'B' && e.agent !== 'C')) continue;
    const ag = agents[e.agent];
    if (!ag?.label || !ag?.did) continue;
    const t: HolonTarget = { holonUri: uri, label: ag.label, did: ag.did, agent: e.agent, descriptorUrl: sl?.descriptorUrl, title: e.title };
    if (e.agent === 'B') return t;           // the learner's performance is the most interesting target
    if (!fallback) fallback = t;
  }
  return fallback;
}

function InterrogatePanel({ events, agents }: { events: DemoEvent[]; agents: { A?: DemoAgent; B?: DemoAgent; C?: DemoAgent } }) {
  const target = useMemo(() => findHolonTarget(events, agents), [events, agents]);
  const [res, setRes] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A new run invalidates a prior interrogation.
  useEffect(() => { setRes(null); setErr(null); }, [target?.holonUri]);
  if (!target) return null;

  async function interrogate() {
    if (!target) return;
    setLoading(true); setErr(null); setRes(null);
    try {
      const url = `${BRIDGE_URL}/agent/lattice/${target.label}/interrogate`
        + `?uri=${encodeURIComponent(target.holonUri)}&agent_did=${encodeURIComponent(target.did)}`;
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
      setRes(j);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }

  const answers: any[] = Array.isArray(res?.answers) ? res.answers : [];
  const byType = new Map<string, any>(answers.map(a => [a.interrogative, a]));
  const ordered = [...IE_ORDER.filter(t => byType.has(t)), ...answers.map(a => a.interrogative).filter(t => !IE_ORDER.includes(t))];
  const resolved = res?.resolved ?? {};

  return (
    <div style={{ marginTop: 22, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--panel)', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Ask the substrate about this run</div>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          who · what · when · why · how much — routed over Agent {target.agent}'s published holon
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5, margin: '6px 0 10px' }}>
        Interego maps the canonical interrogatives to descriptor facets. The bridge routes the grammar over the
        REAL bytes of <code style={code}>{target.title}</code> and resolves what it can locally — the same descriptor the
        <strong> Pod</strong> browser dereferences. Honest by construction: each answer is tagged{' '}
        <em>full / partial / pointer / absent</em>.
      </p>
      <button onClick={interrogate} disabled={loading} style={{ ...pill, borderColor: 'var(--accent)', color: 'var(--accent)', opacity: loading ? 0.5 : 1 }}>
        {loading ? 'interrogating…' : res ? '↻ Interrogate again' : 'Interrogate this run'}
      </button>
      {target.descriptorUrl && (
        <a href={target.descriptorUrl} target="_blank" rel="noreferrer" style={{ ...linkBtn, fontSize: 12, marginLeft: 12 }}>view the descriptor on the pod ↗</a>
      )}
      {err && <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>⚠ {err}</div>}

      {ordered.length > 0 && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))', gap: 8 }}>
          {ordered.map(t => {
            const a = byType.get(t);
            const st = STATUS_STYLE[a.status] ?? STATUS_STYLE.absent;
            const vals = a.values && Object.keys(a.values).length ? a.values : null;
            return (
              <div key={t} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <strong style={{ fontSize: 13 }}>{t}</strong>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{IE_GLOSS[t] ?? ''}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: vMono, fontSize: 9.5, padding: '1px 6px', borderRadius: 3, background: st.bg, color: st.fg, textTransform: 'lowercase' }}>{a.status}</span>
                </div>
                {vals && (
                  <div style={{ marginTop: 4, fontFamily: vMono, fontSize: 10.5, color: 'var(--text)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                    {Object.entries(vals).map(([k, v]) => (
                      <div key={k}><span style={{ color: 'var(--text-dim)' }}>{k}:</span> {fmtVal(v)}</div>
                    ))}
                  </div>
                )}
                {!vals && a.nextStep && (
                  <div style={{ marginTop: 4, fontSize: 11, color: '#2563eb' }}>→ resolve via <code style={{ fontFamily: vMono, fontSize: 10.5 }}>{a.nextStep.tool}</code></div>
                )}
                {a.caveat && <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.4 }}>{a.caveat}</div>}
              </div>
            );
          })}
        </div>
      )}

      {(resolved.What || resolved.HowMuch) && (
        <div style={{ marginTop: 12 }}>
          <div style={artLabel}>resolve-depth — pointers the bridge walked locally (resident lattice)</div>
          {resolved.What && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11.5, marginBottom: 3 }}><strong>What</strong> → resolved the real artifact <span style={{ fontFamily: vMono, fontSize: 10.5, color: 'var(--text-dim)' }}>({String(resolved.What.contentType)})</span></div>
              <pre style={{ fontSize: 10.5, lineHeight: 1.45, background: '#0f1115', color: '#cdd6e0', padding: 10, borderRadius: 5, overflow: 'auto', maxHeight: 220, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
{typeof resolved.What.content === 'string' ? resolved.What.content : JSON.stringify(resolved.What.content, null, 2)}
              </pre>
            </div>
          )}
          {resolved.HowMuch && (
            <div style={{ fontSize: 11.5 }}>
              <strong>HowMuch</strong> → lattice now <code style={{ fontFamily: vMono, fontSize: 10.5 }}>{resolved.HowMuch.atoms} atoms / {resolved.HowMuch.fragments} fragments</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
/** Render an interrogative value compactly (truncate long IRIs/strings). */
function fmtVal(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') { const s = JSON.stringify(v); return s.length > 80 ? s.slice(0, 80) + '…' : s; }
  const s = String(v);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

const runBtn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '5px 13px', fontSize: 12, cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };
const code: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
