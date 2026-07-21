import React, { useState } from 'react';
import { callBridge, DEMO_IDENTITIES } from '../bridge-client.js';

/**
 * Compliance-officer dashboard — generates a Data Protection Impact
 * Assessment (GDPR Art. 35 + EU AI Act §13) for a given learner pod.
 * Composes foxxi.audit_compliance_trail + foxxi.generate_dpia. Findings
 * include suggested mitigations the compliance officer can hand to
 * engineering.
 */
export function Dpia({ onHome }: { onHome: () => void }) {
  const [learnerDid, setLearnerDid] = useState<string>(DEMO_IDENTITIES.joshua.webId);
  const [dpia, setDpia] = useState<DpiaReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true); setError(null);
    try {
      const r = await callBridge({
        tool: 'foxxi.generate_dpia',
        args: { learner_did: learnerDid, learner_pod_url: 'https://gate.interego.xwisee.com/foxxi/' },
        identity: 'jordan',
      });
      if ((r.result as { error?: string })?.error) {
        setError(((r.result as { error?: string }).error)!);
      } else {
        setDpia(r.result as DpiaReport);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ maxWidth: 880, margin: '40px auto', padding: '0 24px' }}>
      <button onClick={onHome} style={{
        background: 'transparent', border: 'none', color: 'var(--text-dim)',
        cursor: 'pointer', fontSize: 12, padding: 0, marginBottom: 14,
        fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>← back to home</button>

      <h1 style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 44, margin: 0 }}>
        Compliance-officer DPIA
      </h1>
      <p style={{ fontSize: 18, color: 'var(--text-dim)', marginTop: 12, lineHeight: 1.55 }}>
        Generate a Data Protection Impact Assessment for one learner's record within a Foxxi tenant.
        Composes <code>foxxi.audit_compliance_trail</code> (walks every descriptor on the pod) +
        <code> foxxi.generate_dpia</code> (rolls up framework citations, data categories, and risk
        findings into GDPR Art. 35 / EU AI Act §13 shape).
      </p>

      <div style={{
        marginTop: 30, padding: 22, background: 'var(--panel)',
        border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow)',
      }}>
        <div className="label" style={{ marginBottom: 10 }}>Learner WebID</div>
        <input
          value={learnerDid}
          onChange={e => setLearnerDid(e.target.value)}
          style={{
            width: '100%', padding: '8px 10px',
            background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4,
            fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
            marginBottom: 14,
          }}
        />
        <button onClick={generate} disabled={busy} style={{
          padding: '12px 18px', background: 'var(--text)', color: 'var(--panel)',
          border: 'none', borderRadius: 4,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          opacity: busy ? 0.5 : 1, cursor: busy ? 'wait' : 'pointer',
        }}>{busy ? 'Generating…' : 'Generate DPIA'}</button>
      </div>

      {error && (
        <div style={{
          marginTop: 18, padding: 12,
          background: 'rgba(168,51,31,0.10)', border: '1px solid rgba(168,51,31,0.32)',
          borderRadius: 4, color: 'var(--bad)', fontSize: 13,
        }}>✗ {error}</div>
      )}

      {dpia && (
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <SummaryBlock dpia={dpia} />
          <FrameworksBlock controls={dpia.frameworkControlsCited ?? []} />
          <DataCategoriesBlock categories={dpia.dataCategories ?? []} />
          <FindingsBlock findings={dpia.findings ?? []} />
        </div>
      )}
    </section>
  );
}

interface DpiaReport {
  generatedAt: string;
  learnerDid: string;
  summary: { totalDataPoints: number; automatedDecisions: number; aiAssistedAssessments: number; humanCountersigns: number; accessDecisionsRecorded: number; encryptedAtRest: number };
  frameworkControlsCited: string[];
  dataCategories: Array<{ category: string; count: number; encrypted: boolean }>;
  findings: Array<{ severity: 'info' | 'low' | 'medium' | 'high'; finding: string; mitigation: string }>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: 22, background: 'var(--panel)',
      border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow)',
    }}>
      <div className="label" style={{ marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );
}

function SummaryBlock({ dpia }: { dpia: DpiaReport }) {
  const s = dpia.summary;
  return (
    <Card title="Summary">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
        {[
          ['Total data points', s.totalDataPoints],
          ['Automated decisions', s.automatedDecisions],
          ['AI-assisted assessments', s.aiAssistedAssessments],
          ['Human countersigns', s.humanCountersigns],
          ['Access-decision traces', s.accessDecisionsRecorded],
          ['Encrypted at rest', s.encryptedAtRest],
        ].map(([label, val]) => (
          <div key={label as string}>
            <div className="label" style={{ marginBottom: 4 }}>{label as string}</div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 24, fontWeight: 600 }}>{val as number}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-dim)' }}>
        Generated {new Date(dpia.generatedAt).toLocaleString()} for {dpia.learnerDid}
      </div>
    </Card>
  );
}

function FrameworksBlock({ controls }: { controls: string[] }) {
  return (
    <Card title={`Framework controls cited (${controls.length})`}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {controls.map((c, i) => (
          <span key={i} style={{
            display: 'inline-block', padding: '4px 10px',
            background: 'var(--panel-2)', border: '1px solid var(--border)',
            borderRadius: 999, fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
            color: 'var(--text-dim)',
          }}>{abbreviateIri(c)}</span>
        ))}
      </div>
    </Card>
  );
}

function DataCategoriesBlock({ categories }: { categories: Array<{ category: string; count: number; encrypted: boolean }> }) {
  if (categories.length === 0) return null;
  return (
    <Card title="GDPR data categories">
      {categories.map((c, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 0', borderBottom: '1px dashed var(--border)',
        }}>
          <div style={{ flex: 1, fontSize: 14 }}>{c.category}</div>
          <span style={{
            padding: '2px 8px', borderRadius: 999, fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            background: c.encrypted ? 'rgba(47,106,58,0.14)' : 'rgba(184,114,17,0.14)',
            color: c.encrypted ? 'var(--good)' : 'var(--warn)',
            border: `1px solid ${c.encrypted ? 'rgba(47,106,58,0.32)' : 'rgba(184,114,17,0.32)'}`,
          }}>{c.encrypted ? 'encrypted' : 'plaintext'}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, minWidth: 30, textAlign: 'right' }}>{c.count}</span>
        </div>
      ))}
    </Card>
  );
}

function FindingsBlock({ findings }: { findings: Array<{ severity: string; finding: string; mitigation: string }> }) {
  return (
    <Card title={`Findings (${findings.length})`}>
      {findings.map((f, i) => {
        const tone = {
          high: { bg: 'rgba(168,51,31,0.10)', border: 'rgba(168,51,31,0.32)', fg: 'var(--bad)' },
          medium: { bg: 'rgba(184,114,17,0.10)', border: 'rgba(184,114,17,0.32)', fg: 'var(--warn)' },
          low: { bg: 'rgba(193,80,28,0.08)', border: 'rgba(193,80,28,0.20)', fg: 'var(--accent)' },
          info: { bg: 'var(--panel-2)', border: 'var(--border)', fg: 'var(--text-dim)' },
        }[f.severity] ?? { bg: 'var(--panel-2)', border: 'var(--border)', fg: 'var(--text-dim)' };
        return (
          <div key={i} style={{
            padding: 14, marginBottom: 10,
            background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 4,
          }}>
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600,
              color: tone.fg, textTransform: 'uppercase', letterSpacing: '0.08em',
              marginBottom: 6,
            }}>{f.severity}</div>
            <div style={{ fontSize: 15, marginBottom: 8 }}>{f.finding}</div>
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              <strong>Mitigation:</strong> {f.mitigation}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

function abbreviateIri(iri: string): string {
  if (iri.length < 60) return iri;
  const fragment = iri.split(/[#/]/).filter(Boolean).pop() ?? iri;
  return `…${fragment}`;
}
