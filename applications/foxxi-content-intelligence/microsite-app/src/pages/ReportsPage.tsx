import React, { useEffect, useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { BRIDGE_URL, DEMO_IDENTITIES } from '../bridge-client.js';
import { mintSessionToken, deriveUserWallet } from '../session-token.js';
import { normalizeLrs, lmsFromStatements, subjectFromReview, type LrsAnalytics, type LmsCompletions, type SubjectRecord } from '../../../reports-ui/report-model.js';
import { LrsAnalyticsView, LmsCompletionsView, SubjectRecordView } from '../../../reports-ui/report-views.js';

type Tab = 'lrs' | 'lms' | 'subject';
const ADMIN = DEMO_IDENTITIES.jordan; // u-admin — verifies as admin against the published directory
const DEFAULT_SUBJECT = 'did:ethr:0x8f3b8e9396003c4e25a89ca2ec4d2bec54c679fd'; // the maintainer mesh agent (has live records)

async function adminToken(): Promise<string> {
  return mintSessionToken({ userId: ADMIN.userId, webId: ADMIN.webId, ttlMs: 30 * 60 * 1000 });
}
async function adminGet(path: string, token: string): Promise<any> {
  const r = await fetch(`${BRIDGE_URL}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}`);
  return r.json();
}

export function ReportsPage({ onHome }: { onHome: () => void }) {
  const [tab, setTab] = useState<Tab>('lrs');
  const [tenant, setTenant] = useState('');
  const [lrs, setLrs] = useState<LrsAnalytics | null>(null);
  const [lms, setLms] = useState<LmsCompletions | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [subjectInput, setSubjectInput] = useState(DEFAULT_SUBJECT);
  const [subject, setSubject] = useState<SubjectRecord | null>(null);
  const [subjBusy, setSubjBusy] = useState(false);

  const tq = tenant ? `&tenant=${encodeURIComponent(tenant)}` : '';

  const loadAnalytics = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const token = await adminToken();
      const [agg, conf, stmts] = await Promise.all([
        adminGet(`/xapi/admin/aggregates?_=${Date.now()}${tq}`, token),
        adminGet(`/xapi/admin/conformance?_=${Date.now()}${tq}`, token).catch(() => null),
        adminGet(`/xapi/admin/statements?limit=200${tq}`, token).catch(() => ({ page: [] })),
      ]);
      setLrs(normalizeLrs(agg, conf));
      setLms(lmsFromStatements((stmts.page ?? []).map((r: any) => r))); // page rows carry verb/object/result
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [tenant]);

  useEffect(() => { void loadAnalytics(); }, [loadAnalytics]);

  const loadSubject = useCallback(async (didRaw: string) => {
    const did = didRaw.trim().toLowerCase();
    if (!/^did:ethr:0x[0-9a-f]{40}$/.test(did)) { setSubject({ did, statementCount: 0, competencies: [], credentials: [], error: 'enter a did:ethr:0x… (40 hex)' }); return; }
    setSubjBusy(true);
    try {
      const wallet = deriveUserWallet(ADMIN.userId);
      const payload = JSON.stringify({ subject_did: did, include_clr: true, agent_id: `did:ethr:${wallet.address.toLowerCase()}`, timestamp: new Date().toISOString() });
      const sig = await wallet.signMessage(`sha256:${ethers.sha256(new TextEncoder().encode(payload)).slice(2)}`);
      const r = await fetch(`${BRIDGE_URL}/agent/review-record`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _signature: sig, _signed_payload: payload }) });
      const body = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      setSubject(subjectFromReview(did, body));
    } catch (e) { setSubject({ did, statementCount: 0, competencies: [], credentials: [], error: (e as Error).message }); }
    finally { setSubjBusy(false); }
  }, []);

  useEffect(() => { if (tab === 'subject' && !subject) void loadSubject(DEFAULT_SUBJECT); }, [tab, subject, loadSubject]);

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 }}>← home</button>
      <h1 style={{ fontFamily: "'EB Garamond', serif", fontSize: 34, margin: '10px 0 4px' }}>Reports</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 15, maxWidth: 760, lineHeight: 1.5 }}>
        Live LMS + LRS reporting over the deployed Foxxi LRS — read with the demo admin identity ({ADMIN.name}). Real
        statements, real completions, real competencies + credentials. (For a tenant's per-agent view, set a tenant like
        <code style={codeS}> lens:maintainer</code>.)
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '16px 0' }}>
        {(['lrs', 'lms', 'subject'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...pill, background: tab === t ? 'var(--accent)' : 'transparent', color: tab === t ? 'var(--panel)' : 'var(--text)', borderColor: tab === t ? 'var(--accent)' : 'var(--border)' }}>
            {t === 'lrs' ? 'LRS analytics' : t === 'lms' ? 'LMS completions' : 'Competencies & credentials'}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {(tab === 'lrs' || tab === 'lms') && (
          <>
            <input value={tenant} onChange={e => setTenant(e.target.value)} placeholder="tenant (blank = default)" style={inputS} />
            <button onClick={() => void loadAnalytics()} disabled={loading} style={{ ...pill, borderColor: 'var(--border)' }}>{loading ? 'loading…' : 'refresh'}</button>
          </>
        )}
      </div>

      {err && <div style={{ padding: '10px 14px', background: '#fde8e8', color: '#d23f31', borderRadius: 6, fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}

      {tab === 'lrs' && (lrs ? <LrsAnalyticsView data={lrs} /> : !err && <div style={{ color: 'var(--text-dim)' }}>loading LRS analytics…</div>)}
      {tab === 'lms' && (lms ? <LmsCompletionsView data={lms} /> : !err && <div style={{ color: 'var(--text-dim)' }}>loading LMS completions…</div>)}
      {tab === 'subject' && (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={subjectInput} onChange={e => setSubjectInput(e.target.value)} placeholder="did:ethr:0x…" style={{ ...inputS, flex: '1 1 420px', fontFamily: "'JetBrains Mono', monospace" }} />
            <button onClick={() => void loadSubject(subjectInput)} disabled={subjBusy} style={{ ...pill, background: 'var(--accent)', color: 'var(--panel)', borderColor: 'var(--accent)' }}>{subjBusy ? 'reading…' : 'load record'}</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            Reads the subject's own ELR (competencies) + CLR wallet (credentials) via a signed <code style={codeS}>review-record</code> — the record a subject actually owns. Defaults to the maintainer mesh agent; paste any agent's did:ethr (e.g. from an Agents-demo run).
          </div>
          {subject && <SubjectRecordView data={subject} />}
        </div>
      )}
    </div>
  );
}

const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '6px 14px', fontSize: 12, cursor: 'pointer' };
const inputS: React.CSSProperties = { padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 };
const codeS: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, background: '#f3f3f1', padding: '1px 4px', borderRadius: 3 };
