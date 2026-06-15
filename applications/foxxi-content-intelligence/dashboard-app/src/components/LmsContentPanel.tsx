/**
 * LMS content & launch — the operator view for getting content INTO Foxxi
 * and launching it. Three tools over existing bridge endpoints:
 *
 *   Upload package   POST {base}/mcp foxxi.ingest_content_package (base64 zip)
 *   OneRoster import POST {base}/ims/oneroster/v1p2/import (CSV bundle)
 *   cmi5 launch      GET  {base}/cmi5/launch (build a conformant AU launch URL)
 *                    GET  {base}/cmi5/registration/:reg (inspect progress)
 *
 * Admin-only (the route is gated to admin / learning-engineer; the launch
 * + registration inspector are read-only and useful to LEs too).
 */

import React, { useState } from 'react';
import { useHypermedia } from '../hypermedia.js';
import { Card, Button } from './common.js';
import type { FoxxiSession } from '../auth/session.js';

type Tool = 'upload' | 'oneroster' | 'launch';

function bridgeOrigin(entry: { '@id'?: string; _links?: Record<string, { href: string }> } | null): string {
  const candidate = entry?.['@id'] ?? entry?._links?.['statements-admin']?.href ?? entry?._links?.['self']?.href;
  if (!candidate) return '';
  try { return new URL(candidate).origin; } catch { return ''; }
}

const input: React.CSSProperties = {
  padding: 7, borderRadius: 4, border: '1px solid var(--border)', fontSize: 12,
  background: 'var(--panel)', color: 'var(--text)', width: '100%', boxSizing: 'border-box',
};
const label: React.CSSProperties = { fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, display: 'block' };

function ResultBox({ result }: { result: unknown }) {
  if (result === null || result === undefined) return null;
  return (
    <pre style={{ marginTop: 10, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, padding: 10, overflow: 'auto', maxHeight: 320 }}>
{JSON.stringify(result, null, 2)}
    </pre>
  );
}

export function LmsContentPanel({ session }: { session: FoxxiSession }) {
  const { entry } = useHypermedia();
  const origin = bridgeOrigin(entry);
  const bearer = session.bearerToken;
  const [tool, setTool] = useState<Tool>('upload');

  return (
    <Card title="LMS content & launch">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        {(['upload', 'oneroster', 'launch'] as const).map(t => (
          <Button key={t} primary={tool === t} small onClick={() => setTool(t)}>
            {t === 'upload' ? 'Upload package' : t === 'oneroster' ? 'OneRoster import' : 'cmi5 launch'}
          </Button>
        ))}
      </div>
      {!origin && <div style={{ color: 'var(--bad)', fontSize: 12 }}>✗ bridge endpoint not resolved (hypermedia entry unavailable)</div>}
      {origin && tool === 'upload' && <UploadPackage origin={origin} bearer={bearer} session={session} />}
      {origin && tool === 'oneroster' && <OneRosterImport origin={origin} bearer={bearer} session={session} />}
      {origin && tool === 'launch' && <Cmi5Launch origin={origin} bearer={bearer} session={session} />}
    </Card>
  );
}

// ── Upload a SCORM / cmi5 / xAPI package ────────────────────────────

async function mcpCall(origin: string, bearer: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json() as { result?: { content?: { text: string }[] }; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  const text = j.result?.content?.[0]?.text;
  if (!text) return j.result;
  try { return JSON.parse(text); } catch { return text; }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
    };
    reader.onerror = () => reject(new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

function UploadPackage({ origin, bearer, session }: { origin: string; bearer: string; session: FoxxiSession }) {
  const [file, setFile] = useState<File | null>(null);
  const [courseId, setCourseId] = useState('');
  const [source, setSource] = useState(session.webId || session.tenantPodUrl);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  async function submit() {
    if (!file) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const zip_base64 = await fileToBase64(file);
      const r = await mcpCall(origin, bearer, 'foxxi.ingest_content_package', {
        zip_base64,
        tenant_pod_url: session.tenantPodUrl,
        authoritative_source: source,
        ...(courseId ? { course_id: courseId } : {}),
        lms_source: 'Dashboard upload',
      });
      setResult(r);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
        Upload a SCORM 1.2 / SCORM 2004 / cmi5 .zip. The bridge unwraps it, runs the Foxxi parser
        (structural + concept extraction + prerequisite inference), SHACL-validates against the Foxxi
        vocab, and publishes three-stratum descriptors to the tenant pod.
      </div>
      <div>
        <span style={label}>Package (.zip)</span>
        <input type="file" accept=".zip,application/zip" onChange={e => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: 12 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div><span style={label}>Course id (optional)</span><input style={input} value={courseId} onChange={e => setCourseId(e.target.value)} placeholder="derived from manifest" /></div>
        <div><span style={label}>Authoritative source (DID)</span><input style={input} value={source} onChange={e => setSource(e.target.value)} /></div>
      </div>
      <div><Button primary small disabled={busy || !file} onClick={submit}>{busy ? 'Ingesting…' : 'Ingest package'}</Button></div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 12 }}>✗ {err}</div>}
      <ResultBox result={result} />
    </div>
  );
}

// ── OneRoster 1.2 CSV import ─────────────────────────────────────────

const ONEROSTER_FILES = ['users.csv', 'orgs.csv', 'courses.csv', 'classes.csv', 'enrollments.csv'] as const;

function OneRosterImport({ origin, bearer }: { origin: string; bearer: string; session: FoxxiSession }) {
  const [bundle, setBundle] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  async function onFile(name: string, file: File | null) {
    if (!file) { setBundle(b => { const n = { ...b }; delete n[name]; return n; }); return; }
    const text = await file.text();
    setBundle(b => ({ ...b, [name]: text }));
  }

  async function submit() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch(`${origin}/ims/oneroster/v1p2/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(bundle),
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      setResult(j);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
        Import a OneRoster 1.2 CSV bundle. Imported records win on sourcedId collision with Foxxi's own
        directory and are reflected by the OneRoster GET endpoints.
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {ONEROSTER_FILES.map(f => (
          <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <code style={{ fontSize: 12, minWidth: 130 }}>{f}</code>
            <input type="file" accept=".csv,text/csv" onChange={e => void onFile(f, e.target.files?.[0] ?? null)} style={{ fontSize: 12 }} />
            {bundle[f] && <span style={{ color: 'var(--good)', fontSize: 11 }}>✓ {bundle[f].split('\n').length - 1} rows</span>}
          </div>
        ))}
      </div>
      <div><Button primary small disabled={busy || Object.keys(bundle).length === 0} onClick={submit}>{busy ? 'Importing…' : 'Import bundle'}</Button></div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 12 }}>✗ {err}</div>}
      <ResultBox result={result} />
    </div>
  );
}

// ── cmi5 launch generator + registration inspector ──────────────────

function Cmi5Launch({ origin, bearer, session }: { origin: string; bearer: string; session: FoxxiSession }) {
  const [auId, setAuId] = useState('');
  const [courseId, setCourseId] = useState('');
  const [learner, setLearner] = useState(session.userId);
  const [learnerName, setLearnerName] = useState(session.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [reg, setReg] = useState('');
  const [regResult, setRegResult] = useState<unknown>(null);

  async function generate() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const q = new URLSearchParams();
      if (auId) q.set('au_id', auId);
      if (courseId) q.set('course_id', courseId);
      q.set('learner', learner);
      q.set('learner_name', learnerName);
      q.set('tenant_pod_url', session.tenantPodUrl);
      const r = await fetch(`${origin}/cmi5/launch?${q}`, { headers: { Authorization: `Bearer ${bearer}` } });
      const j = await r.json();
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      setResult(j);
      const regId = (j as { registration?: string }).registration;
      if (regId) setReg(regId);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function inspect() {
    if (!reg) return;
    setRegResult(null);
    try {
      const r = await fetch(`${origin}/cmi5/registration/${encodeURIComponent(reg)}`, { headers: { Authorization: `Bearer ${bearer}` } });
      const j = await r.json();
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      setRegResult(j);
    } catch (e) { setRegResult({ error: (e as Error).message }); }
  }

  const launchUrl = (result as { launchUrl?: string } | null)?.launchUrl;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
        Build a conformant cmi5 launch URL for an Assignable Unit (the LMS launch contract: endpoint,
        fetch token, actor, registration). Then inspect the registration to see launched / satisfied state.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div><span style={label}>AU id</span><input style={input} value={auId} onChange={e => setAuId(e.target.value)} placeholder="urn:…:au or course AU id" /></div>
        <div><span style={label}>Course id (optional)</span><input style={input} value={courseId} onChange={e => setCourseId(e.target.value)} /></div>
        <div><span style={label}>Learner id</span><input style={input} value={learner} onChange={e => setLearner(e.target.value)} /></div>
        <div><span style={label}>Learner name</span><input style={input} value={learnerName} onChange={e => setLearnerName(e.target.value)} /></div>
      </div>
      <div><Button primary small disabled={busy} onClick={generate}>{busy ? 'Building…' : 'Generate launch URL'}</Button></div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 12 }}>✗ {err}</div>}
      {launchUrl && (
        <div style={{ fontSize: 12 }}>
          <span style={label}>Launch URL</span>
          <a href={launchUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all', fontFamily: "'JetBrains Mono', monospace" }}>{launchUrl}</a>
        </div>
      )}
      <ResultBox result={result} />
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <span style={label}>Inspect registration</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={input} value={reg} onChange={e => setReg(e.target.value)} placeholder="registration UUID" />
          <Button small disabled={!reg} onClick={inspect}>Inspect</Button>
        </div>
        <ResultBox result={regResult} />
      </div>
    </div>
  );
}
