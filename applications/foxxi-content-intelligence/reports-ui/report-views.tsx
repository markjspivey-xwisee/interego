/**
 * Shared, presentational report views. Built ONCE; rendered by both the microsite
 * (read-only, public, demo identity) and the operator dashboard. Pure rendering —
 * each takes a normalized model from report-model.ts. Styling uses only the core
 * CSS vars both apps define (--text, --text-dim, --panel, --border, --accent),
 * with hard-coded status colors so it is portable across either app's theme.
 */
import React from 'react';
import type { LrsAnalytics, LmsCompletions, SubjectRecord, Counted } from './report-model.js';

const OK = '#2e9c4a', WARN = '#d08700', BAD = '#d23f31';
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 };
const dim: React.CSSProperties = { fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' };
const mono = "'JetBrains Mono', monospace";

export function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ ...card, padding: '10px 14px' }}>
      <div style={dim}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  );
}

function BarList({ title, rows, accent }: { title: string; rows: Counted[]; accent?: string }) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  return (
    <div>
      <div style={{ ...dim, marginBottom: 6 }}>{title}</div>
      <div style={{ ...card, padding: 0 }}>
        {rows.length === 0 && <div style={{ padding: 10, color: 'var(--text-dim)', fontSize: 12 }}>—</div>}
        {rows.map(r => (
          <div key={r.id} title={r.id} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, width: `${(r.count / max) * 100}%`, background: (accent ?? 'var(--accent)'), opacity: 0.10 }} />
            <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginRight: 8 }}>{r.label}</span>
              <strong>{r.count}</strong>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** LRS analytics — the LRS report. */
export function LrsAnalyticsView({ data }: { data: LrsAnalytics }) {
  const maxHourly = data.hourly.reduce((m, h) => Math.max(m, h.count), 0) || 1;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <Stat label="Total statements" value={data.total} />
        <Stat label="Success rate" value={pct(data.successRate)} color={'var(--accent)'} />
        <Stat label="Errors (success=false)" value={data.errors} color={data.errors > 0 ? WARN : OK} />
        {data.conformance && <Stat label="xAPI-profile conformance" value={pct(data.conformance.rate)} color={OK} />}
      </div>
      <div>
        <div style={{ ...dim, marginBottom: 6 }}>Hourly volume (real event-time)</div>
        <div style={{ ...card, display: 'flex', alignItems: 'flex-end', gap: 2, height: 80 }}>
          {data.hourly.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12, alignSelf: 'center' }}>no time-series yet</div>}
          {data.hourly.map(h => <div key={h.hour} title={`${h.hour}: ${h.count}`} style={{ flex: 1, minHeight: 2, height: `${(h.count / maxHourly) * 100}%`, background: 'var(--accent)' }} />)}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <BarList title="Verbs (post-GAP5: expressive)" rows={data.verbs} />
        <BarList title="Top activities" rows={data.activities} />
        <BarList title="Top actors" rows={data.actors} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <BarList title="Direction · actorKind (H2A / A2A)" rows={data.actorKinds} accent={'#7c3aed'} />
        <BarList title="Context · contextKind (production / training)" rows={data.contextKinds} accent={'#0891b2'} />
      </div>
    </div>
  );
}

/** LMS completions — the LMS report (per-course delivery outcomes). */
export function LmsCompletionsView({ data }: { data: LmsCompletions }) {
  const pct = (n: number | null) => n == null ? '—' : `${(n * 100).toFixed(0)}%`;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <Stat label="Courses" value={data.courses.length} />
        <Stat label="Completed" value={data.totalCompleted} color={OK} />
        <Stat label="Passed" value={data.totalPassed} color={'var(--accent)'} />
        <Stat label="Failed" value={data.totalFailed} color={data.totalFailed > 0 ? WARN : OK} />
      </div>
      <div style={{ ...card, padding: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              {['Course', 'Launched', 'Completed', 'Passed', 'Failed', 'Pass rate', 'Avg score'].map((h, i) => (
                <th key={h} style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text-dim)', fontWeight: 600, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.courses.length === 0 && <tr><td colSpan={7} style={{ padding: 12, color: 'var(--text-dim)' }}>No course-delivery statements in this window.</td></tr>}
            {data.courses.map(c => (
              <tr key={c.course}>
                <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--border)' }} title={c.course}>{c.title}</td>
                <td style={tdNum}>{c.launched}</td>
                <td style={tdNum}>{c.completed}</td>
                <td style={{ ...tdNum, color: OK }}>{c.passed}</td>
                <td style={{ ...tdNum, color: c.failed > 0 ? BAD : 'var(--text-dim)' }}>{c.failed}</td>
                <td style={{ ...tdNum, fontWeight: 600 }}>{pct(c.passRate)}</td>
                <td style={tdNum}>{c.avgScore == null ? '—' : c.avgScore.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
const tdNum: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

/** Per-subject record — competencies (ELR) + credentials (CLR). The
 *  performance-manager + per-learner lens. */
export function SubjectRecordView({ data }: { data: SubjectRecord }) {
  if (data.error) return <div style={{ ...card, color: BAD, fontSize: 13 }}>✗ {data.error}</div>;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <Stat label="xAPI statements" value={data.statementCount} />
        <Stat label="Competencies" value={data.competencies.length} color={'var(--accent)'} />
        <Stat label="Credentials held" value={data.credentials.length} color={data.credentials.length > 0 ? OK : 'var(--text-dim)'} />
      </div>
      <div>
        <div style={{ ...dim, marginBottom: 6 }}>Competencies (ELR rollup) — expand for the evidencing statements</div>
        <div style={{ ...card, padding: 0 }}>
          {data.competencies.length === 0 && <div style={{ padding: 10, color: 'var(--text-dim)', fontSize: 12 }}>none yet</div>}
          {data.competencies.map((c, i) => (
            <details key={i} style={{ borderBottom: '1px solid var(--border)' }}>
              <summary style={summaryS}>
                <span style={{ flex: 1, fontSize: 12 }}>{c.label}</span>
                <span style={{ padding: '1px 7px', borderRadius: 3, fontSize: 10, background: c.basis === 'performance' ? 'rgba(46,156,74,0.14)' : 'rgba(124,124,124,0.14)', color: c.basis === 'performance' ? OK : 'var(--text-dim)' }}>{c.basis || c.modalStatus}</span>
                {c.successRate != null && <span style={{ color: 'var(--text-dim)', fontFamily: mono, fontSize: 11 }}>{(c.successRate * 100).toFixed(0)}%</span>}
              </summary>
              <div style={evBody}>
                {c.framework && <div>framework: <code style={{ wordBreak: 'break-all' }}>{c.framework}</code></div>}
                {c.evidenceSummary && <pre style={evPre}>{JSON.stringify(c.evidenceSummary, null, 2)}</pre>}
                <div>{c.evidence.length} evidencing xAPI statement{c.evidence.length === 1 ? '' : 's'}{c.evidence.length === 0 ? ' recorded on this competency' : ':'}</div>
                {c.evidence.map((id, j) => <code key={j} style={{ fontFamily: mono, fontSize: 10.5, wordBreak: 'break-all' }}>{id}</code>)}
              </div>
            </details>
          ))}
        </div>
      </div>
      <div>
        <div style={{ ...dim, marginBottom: 6 }}>Credentials (CLR wallet · OB3 / VC) — expand for the verifiable credential</div>
        <div style={{ ...card, padding: 0 }}>
          {data.credentials.length === 0 && <div style={{ padding: 10, color: 'var(--text-dim)', fontSize: 12 }}>none held</div>}
          {data.credentials.map((c, i) => (
            <details key={i} style={{ borderBottom: '1px solid var(--border)' }}>
              <summary style={summaryS}>
                <span style={{ color: '#db2777' }}>🎓</span>
                <span style={{ flex: 1, fontSize: 12 }}>{c.name}</span>
                {c.issuedAt && <span style={{ color: 'var(--text-dim)', fontFamily: mono, fontSize: 10 }}>{String(c.issuedAt).slice(0, 10)}</span>}
              </summary>
              <div style={evBody}>
                {c.issuer && <div>issuer: <code style={{ wordBreak: 'break-all' }}>{c.issuer}</code></div>}
                {c.description && <div>{c.description}</div>}
                {c.raw != null && <pre style={evPre}>{JSON.stringify(c.raw, null, 2)}</pre>}
              </div>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

const summaryS: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer' };
const evBody: React.CSSProperties = { padding: '2px 12px 10px 24px', fontSize: 11.5, color: 'var(--text-dim)', display: 'grid', gap: 6 };
const evPre: React.CSSProperties = { fontSize: 10.5, lineHeight: 1.45, background: '#0f1115', color: '#cdd6e0', padding: 8, borderRadius: 5, overflow: 'auto', maxHeight: 220, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };
