import React, { useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import { ethers } from 'ethers';
import { BRIDGE_URL, DEMO_IDENTITIES } from '../bridge-client.js';
import { mintSessionToken, deriveUserWallet } from '../session-token.js';
import { getDemoState, subscribeDemo, type DemoAgent } from '../demo/demo-session.js';
import { normalizeLrs, lmsFromStatements, subjectFromReview, type LrsAnalytics, type LmsCompletions, type SubjectRecord } from '../../../reports-ui/report-model.js';
import { LrsAnalyticsView, LmsCompletionsView, SubjectRecordView, Stat } from '../../../reports-ui/report-views.js';

type Tab = 'lrs' | 'lms' | 'subject' | 'lattice';
const ADMIN = DEMO_IDENTITIES.jordan; // the demo's operator — reads the demo agents' lenses (scoped by tenant)

async function adminToken(): Promise<string> {
  return mintSessionToken({ userId: ADMIN.userId, webId: ADMIN.webId, ttlMs: 30 * 60 * 1000 });
}
async function adminGet(path: string, token: string): Promise<any> {
  const r = await fetch(`${BRIDGE_URL}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}`);
  return r.json();
}

export function ReportsPage({ onHome, onAgents }: { onHome: () => void; onAgents?: () => void }) {
  const state = useSyncExternalStore(subscribeDemo, getDemoState);
  const [slot, setSlot] = useState<'A' | 'B'>('B');
  const [tab, setTab] = useState<Tab>('lrs');
  const [lrs, setLrs] = useState<LrsAnalytics | null>(null);
  const [lms, setLms] = useState<LmsCompletions | null>(null);
  const [subject, setSubject] = useState<SubjectRecord | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const agent: DemoAgent | undefined = state.agents[slot] ?? state.agents.A ?? state.agents.B;
  const tenant = agent?.lensTenant ?? '';
  const did = agent?.did ?? '';

  const loadAnalytics = useCallback(async () => {
    if (!tenant) return;
    setLoading(true); setErr(null); setLrs(null); setLms(null);
    try {
      const token = await adminToken();
      const tq = `&tenant=${encodeURIComponent(tenant)}`;
      const [agg, conf, stmts] = await Promise.all([
        adminGet(`/xapi/admin/aggregates?_=${Date.now()}${tq}`, token),
        adminGet(`/xapi/admin/conformance?_=${Date.now()}${tq}`, token).catch(() => null),
        adminGet(`/xapi/admin/statements?limit=200${tq}`, token).catch(() => ({ page: [] })),
      ]);
      setLrs(normalizeLrs(agg, conf));
      setLms(lmsFromStatements((stmts.page ?? [])));
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [tenant]);

  const loadSubject = useCallback(async () => {
    if (!did) return;
    setSubject(null);
    try {
      const wallet = deriveUserWallet(ADMIN.userId);
      const payload = JSON.stringify({ subject_did: did, include_clr: true, agent_id: `did:ethr:${wallet.address.toLowerCase()}`, timestamp: new Date().toISOString() });
      const sig = await wallet.signMessage(`sha256:${ethers.sha256(new TextEncoder().encode(payload)).slice(2)}`);
      const r = await fetch(`${BRIDGE_URL}/agent/review-record`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _signature: sig, _signed_payload: payload }) });
      const body = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      setSubject(subjectFromReview(did, body));
    } catch (e) { setSubject({ did, statementCount: 0, competencies: [], credentials: [], error: (e as Error).message }); }
  }, [did]);

  useEffect(() => { void loadAnalytics(); }, [loadAnalytics]);
  useEffect(() => { if (tab === 'subject') void loadSubject(); }, [tab, loadSubject]);

  const noRun = !state.agents.A && !state.agents.B;

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: "'EB Garamond', serif", fontSize: 34, margin: '10px 0 4px' }}>Reports — this demo's agents</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 15, maxWidth: 760, lineHeight: 1.5 }}>
        Live LMS + LRS reporting scoped to the <strong>two agents your Agents‑demo run spawned</strong> — their own xAPI
        lenses, completions, competencies, and credentials. Nothing here is shared system data; it's purely this demo.
      </p>

      {noRun ? (
        <div style={{ marginTop: 24, padding: '18px 20px', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-dim)', fontSize: 14 }}>
          No demo run yet — there are no spawned agents to report on.{' '}
          {onAgents && <button onClick={onAgents} style={{ ...linkBtn, fontSize: 14 }}>Run the Agents demo →</button>}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '16px 0' }}>
            <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)' }}>Agent</span>
            {(['A', 'B'] as const).map(s => state.agents[s] && (
              <button key={s} onClick={() => setSlot(s)} style={{ ...pill, background: slot === s ? 'var(--accent)' : 'transparent', color: slot === s ? 'var(--panel)' : 'var(--text)', borderColor: slot === s ? 'var(--accent)' : 'var(--border)' }}>
                Agent {s} · {s === 'A' ? 'teacher' : 'learner'}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            {(tab === 'lrs' || tab === 'lms') && <button onClick={() => void loadAnalytics()} disabled={loading} style={{ ...pill, borderColor: 'var(--border)' }}>{loading ? 'loading…' : 'refresh'}</button>}
          </div>
          {agent && <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, wordBreak: 'break-all' }}>{agent.did} · lens <code style={code}>{agent.lensTenant}</code></div>}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            {(['lrs', 'lms', 'subject', 'lattice'] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ ...pill, background: tab === t ? 'var(--text)' : 'transparent', color: tab === t ? 'var(--panel)' : 'var(--text)', borderColor: tab === t ? 'var(--text)' : 'var(--border)' }}>
                {t === 'lrs' ? 'LRS analytics' : t === 'lms' ? 'LMS completions' : t === 'subject' ? 'Competencies & credentials' : 'Lattice (PGSL)'}
              </button>
            ))}
          </div>

          {err && <div style={{ padding: '10px 14px', background: '#fde8e8', color: '#d23f31', borderRadius: 6, fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}
          {tab === 'lrs' && (lrs ? <LrsAnalyticsView data={lrs} /> : !err && <div style={{ color: 'var(--text-dim)' }}>loading…</div>)}
          {tab === 'lms' && (lms ? <LmsCompletionsView data={lms} /> : !err && <div style={{ color: 'var(--text-dim)' }}>loading…</div>)}
          {tab === 'subject' && (subject ? <SubjectRecordView data={subject} /> : <div style={{ color: 'var(--text-dim)' }}>loading…</div>)}
          {tab === 'lattice' && <LatticeExplorer label={tenant.replace(/^lens:/, '')} />}
        </>
      )}
    </div>
  );
}

// ── Lattice (PGSL) explorer — dereference the agent's shared foundation lattice ──
const mono = "'JetBrains Mono', monospace";
const lcard: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 };
const ldim: React.CSSProperties = { fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 };
const lchip: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', fontSize: 11, fontFamily: mono, cursor: 'pointer', background: 'transparent', color: 'var(--text)' };
const lpre: React.CSSProperties = { fontSize: 10.5, lineHeight: 1.45, background: '#0f1115', color: '#cdd6e0', padding: 10, borderRadius: 6, overflow: 'auto', maxHeight: 320, marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

function LatticeExplorer({ label }: { label: string }) {
  const [view, setView] = useState<any>(null);
  const [term, setTerm] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyTerm, setBusyTerm] = useState<string | null>(null);
  const tail = (s: string) => s.split(/[#/]/).filter(Boolean).pop() || s;

  useEffect(() => {
    let live = true;
    setView(null); setTerm(null); setErr(null);
    if (!label) { setErr('no agent selected'); return; }
    (async () => {
      try {
        const r = await fetch(`${BRIDGE_URL}/agent/lattice/${encodeURIComponent(label)}?_=${Date.now()}`);
        const b = await r.json().catch(() => null);
        if (!live) return;
        if (!r.ok || !b?.ok) { setErr(b?.error ?? `HTTP ${r.status}`); return; }
        setView(b);
      } catch (e) { if (live) setErr((e as Error).message); }
    })();
    return () => { live = false; };
  }, [label]);

  const deref = async (iri: string) => {
    setBusyTerm(iri); setTerm(null);
    try {
      const r = await fetch(`${BRIDGE_URL}/agent/lattice/${encodeURIComponent(label)}/term?iri=${encodeURIComponent(iri)}`);
      const b = await r.json().catch(() => null);
      setTerm(b?.ok ? b : { found: false, iri, error: b?.error ?? `HTTP ${r.status}` });
    } catch (e) { setTerm({ found: false, iri, error: (e as Error).message }); }
    finally { setBusyTerm(null); }
  };

  if (err) return <div style={{ ...lcard, color: 'var(--text-dim)', fontSize: 13.5 }}>This agent has no shared lattice yet — it accumulates as the agent composes artifacts (perform / author / credential). <span style={{ fontFamily: mono, fontSize: 11 }}>({err})</span></div>;
  if (!view) return <div style={{ color: 'var(--text-dim)' }}>loading lattice…</div>;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <p style={{ color: 'var(--text-dim)', fontSize: 13.5, lineHeight: 1.55, margin: 0 }}>
        The cg‑RDF this agent writes is a <strong>projection of one shared PGSL lattice</strong>: every term — its DID, each xAPI verb, each activity‑type IRI — is a content‑addressed node <strong>reused</strong> across all its artifacts (the foundation, not hand‑written RDF). Click a term to dereference it.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 }}>
        <Stat label="Atoms (reused nodes)" value={view.stats?.atoms ?? 0} color={'var(--accent)'} />
        <Stat label="Fragments" value={view.stats?.fragments ?? 0} />
        <Stat label="Max level" value={view.stats?.maxLevel ?? 0} />
        <Stat label="Namespaces" value={view.namespaces?.length ?? 0} />
      </div>
      <div>
        <div style={ldim}>Namespaces in the lattice (coarse granularity)</div>
        <div style={{ ...lcard, padding: 0 }}>
          {(view.namespaces ?? []).map((n: any, i: number) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
              <span style={{ fontFamily: mono, fontSize: 11, wordBreak: 'break-all', marginRight: 8 }}>{n.namespace}</span><strong>{n.count}</strong>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div style={ldim}>Terms — click to dereference (fine granularity)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(view.terms ?? []).map((t: string, i: number) => (
            <button key={i} title={t} onClick={() => void deref(t)} style={{ ...lchip, opacity: busyTerm === t ? 0.5 : 1 }}>{tail(t)}</button>
          ))}
        </div>
      </div>
      {term && <TermCard label={label} term={term} />}
    </div>
  );
}

const PROJ_LABEL: Record<string, string> = { rdf: 'cg-RDF descriptor', vc: 'W3C Verifiable Credential', activity: 'ActivityStreams' };

function TermCard({ label, term }: { label: string; term: any }) {
  const tail = (s: string) => s.split(/[#/]/).filter(Boolean).pop() || s;
  const holon: string | undefined = term.holons?.[0];
  const [as, setAs] = useState<'rdf' | 'vc' | 'activity'>('rdf');
  const [proj, setProj] = useState<unknown>(term.projectedRdf ?? null);
  const [artifact, setArtifact] = useState<{ contentType: string; content: unknown } | null>(null);
  useEffect(() => {
    if (!holon || !term.found) return;
    let live = true;
    (async () => {
      try {
        const r = await fetch(`${BRIDGE_URL}/agent/lattice/${encodeURIComponent(label)}/holon?uri=${encodeURIComponent(holon)}&as=${as}`);
        const b = await r.json().catch(() => null);
        if (!live) return;
        setProj(b?.projection ?? null);
        setArtifact(b?.artifact ?? null);
      } catch { /* ignore */ }
    })();
    return () => { live = false; };
  }, [label, holon, as, term.found]);
  if (!term.found) return <div style={{ ...lcard, color: 'var(--text-dim)', fontSize: 13 }}>Term not in this lattice{term.error ? ` (${term.error})` : ''}.</div>;
  const Neighbors = ({ label: l, items }: { label: string; items?: string[] }) => (
    <div style={{ fontSize: 12 }}>
      <span style={{ color: 'var(--text-dim)' }}>{l}: </span>
      {(items && items.length) ? items.map((t, i) => <code key={i} title={t} style={{ ...code, marginRight: 4 }}>{tail(t)}</code>) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
    </div>
  );
  return (
    <div style={{ ...lcard, display: 'grid', gap: 10 }}>
      <div style={{ fontFamily: mono, fontSize: 12, wordBreak: 'break-all' }}>{term.iri}</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        node <code style={code}>{String(term.atomUri ?? '').slice(0, 28)}…</code> · appears in <strong>{term.appearsInFragments}</strong> fragments · across <strong>{term.artifacts?.length ?? 0}</strong> artifact(s)
      </div>
      <Neighbors label="← left (syntagmatic)" items={term.leftNeighbors} />
      <Neighbors label="right (syntagmatic) →" items={term.rightNeighbors} />
      <Neighbors label="usage neighborhood (paradigmatic)" items={term.coOccurring} />
      <div>
        <div style={ldim}>Artifacts this term participates in (spine)</div>
        {(term.artifacts ?? []).map((a: string, i: number) => <div key={i} style={{ fontFamily: mono, fontSize: 10.5, wordBreak: 'break-all', color: 'var(--text-dim)', padding: '2px 0' }}>{a}</div>)}
      </div>
      {artifact && (
        <div>
          <div style={ldim}>Artifact read BACK from the lattice — PGSL is canonical ({artifact.contentType})</div>
          <pre style={lpre}>{JSON.stringify(artifact.content, null, 2)}</pre>
        </div>
      )}
      {holon && (
        <div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={ldim}>Project this holon as</span>
            {(['rdf', 'vc', 'activity'] as const).map(k => (
              <button key={k} onClick={() => setAs(k)} style={{ ...lchip, background: as === k ? 'var(--accent)' : 'transparent', color: as === k ? 'var(--panel)' : 'var(--text)', borderColor: as === k ? 'var(--accent)' : 'var(--border)' }}>{PROJ_LABEL[k]}</button>
            ))}
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>— RDF is one projection of many</span>
          </div>
          <pre style={lpre}>{typeof proj === 'string' ? proj : JSON.stringify(proj, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '6px 14px', fontSize: 12, cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };
const code: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, background: '#f3f3f1', padding: '1px 4px', borderRadius: 3 };
