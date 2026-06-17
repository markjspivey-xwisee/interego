import React, { useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import { ethers } from 'ethers';
import { BRIDGE_URL, DEMO_IDENTITIES } from '../bridge-client.js';
import { mintSessionToken, deriveUserWallet } from '../session-token.js';
import { getDemoState, subscribeDemo, type DemoAgent } from '../demo/demo-session.js';
import { normalizeLrs, lmsFromStatements, subjectFromReview, type LrsAnalytics, type LmsCompletions, type SubjectRecord } from '../../../reports-ui/report-model.js';
import { LrsAnalyticsView, LmsCompletionsView, SubjectRecordView } from '../../../reports-ui/report-views.js';

type Tab = 'lrs' | 'lms' | 'subject';
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
            {(['lrs', 'lms', 'subject'] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ ...pill, background: tab === t ? 'var(--text)' : 'transparent', color: tab === t ? 'var(--panel)' : 'var(--text)', borderColor: tab === t ? 'var(--text)' : 'var(--border)' }}>
                {t === 'lrs' ? 'LRS analytics' : t === 'lms' ? 'LMS completions' : 'Competencies & credentials'}
              </button>
            ))}
          </div>

          {err && <div style={{ padding: '10px 14px', background: '#fde8e8', color: '#d23f31', borderRadius: 6, fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}
          {tab === 'lrs' && (lrs ? <LrsAnalyticsView data={lrs} /> : !err && <div style={{ color: 'var(--text-dim)' }}>loading…</div>)}
          {tab === 'lms' && (lms ? <LmsCompletionsView data={lms} /> : !err && <div style={{ color: 'var(--text-dim)' }}>loading…</div>)}
          {tab === 'subject' && (subject ? <SubjectRecordView data={subject} /> : <div style={{ color: 'var(--text-dim)' }}>loading…</div>)}
        </>
      )}
    </div>
  );
}

const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '6px 14px', fontSize: 12, cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };
const code: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, background: '#f3f3f1', padding: '1px 4px', borderRadius: 3 };
