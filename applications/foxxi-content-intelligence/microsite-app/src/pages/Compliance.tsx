import React, { useState } from 'react';
import { BRIDGE_URL } from '../bridge-client.js';

/**
 * Public self-service compliance testing. A visitor RUNS Foxxi's own conformance
 * batteries live against the deployed bridge and sees the full per-check report.
 * Nothing pre-baked: each Run hits /compliance/<suite>/run on the live bridge,
 * which executes the in-repo harness (xAPI smoke / SCORM SN engine) and returns
 * a structured report. Honest by construction — failures show as ✗ with detail.
 */
interface Check { name: string; ok: boolean; spec: string; detail?: string }
interface Report {
  suite: string; title: string; standard: string; target: string; ranAt: string;
  passed: number; failed: number; total: number; checks: Check[];
}
type SuiteId = 'xapi' | 'scorm';
interface SuiteDef { id: SuiteId; label: string; standard: string; blurb: string; }

const SUITES: SuiteDef[] = [
  { id: 'xapi', label: 'LRS — xAPI 2.0', standard: 'IEEE 9274.1.1 + xAPI Profile Spec 2017',
    blurb: 'Drives the live Foxxi LRS surface end to end: /about version negotiation, the xAPI Profile document, statement POST + round-trip, immutability (409), voiding, filtered queries, and State-resource ETag concurrency.' },
  { id: 'scorm', label: 'LMS — SCORM 2004 S&N', standard: 'ADL SCORM 2004 4th Ed (IMS Simple Sequencing + CAM + RTE)',
    blurb: 'Exercises the SCORM 2004 Sequencing & Navigation engine: activity-tree parse, control modes, the Flow + Choice subprocesses, pre-condition rules, limit conditions (attemptLimit), measure/objective rollup (satisfiedByMeasure), and suspend/resume.' },
];

export function Compliance({ onHome }: { onHome: () => void }) {
  const [running, setRunning] = useState<SuiteId | null>(null);
  const [reports, setReports] = useState<Partial<Record<SuiteId, Report | { error: string }>>>({});

  async function run(id: SuiteId) {
    setRunning(id);
    try {
      const r = await fetch(`${BRIDGE_URL}/compliance/${id}/run`);
      const j = await r.json();
      if (j?.ok && j.report) setReports(prev => ({ ...prev, [id]: j.report as Report }));
      else setReports(prev => ({ ...prev, [id]: { error: j?.error ?? `HTTP ${r.status}` } }));
    } catch (e) {
      setReports(prev => ({ ...prev, [id]: { error: (e as Error).message } }));
    } finally { setRunning(null); }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: "'EB Garamond', serif", fontSize: 34, margin: '10px 0 6px' }}>Run the compliance tests yourself</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 800, lineHeight: 1.55 }}>
        Foxxi is a learning-records LMS + LRS built on the Interego substrate. Press <strong>Run</strong> below and your browser
        triggers Foxxi's own conformance batteries <strong>live against the deployed bridge</strong> — the exact in-repo harnesses,
        not a pre-baked badge. Every check shows pass/fail with its spec citation, so you can audit the claim, not trust it.
        Endpoint: <code style={code}>{BRIDGE_URL}/compliance/&lt;suite&gt;/run</code>.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 18, marginTop: 22 }}>
        {SUITES.map(s => {
          const rep = reports[s.id];
          const isRep = rep && !('error' in rep);
          return (
            <div key={s.id} style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel)', padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                <h2 style={{ fontSize: 18, margin: 0 }}>{s.label}</h2>
                {isRep && (
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 700,
                    color: (rep as Report).failed === 0 ? '#15803d' : '#dc2626' }}>
                    {(rep as Report).passed}/{(rep as Report).total} pass
                  </span>
                )}
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 10px' }}>{s.standard}</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, margin: '0 0 14px' }}>{s.blurb}</p>
              <button onClick={() => run(s.id)} disabled={running !== null}
                style={{ ...runBtn, opacity: running !== null ? 0.5 : 1 }}>
                {running === s.id ? 'Running live…' : isRep ? 'Run again' : 'Run conformance'}
              </button>

              {rep && 'error' in rep && (
                <div style={{ marginTop: 12, padding: '10px 14px', background: '#fde8e8', color: '#dc2626', borderRadius: 6, fontSize: 13 }}>
                  ⚠ {rep.error}
                </div>
              )}
              {isRep && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
                    {(rep as Report).failed === 0
                      ? <>✓ <strong style={{ color: '#15803d' }}>All {(rep as Report).total} checks pass</strong> — 0 failures, run live just now against the deployment.</>
                      : <>⚠ <strong style={{ color: '#dc2626' }}>{(rep as Report).failed} failing</strong> of {(rep as Report).total}.</>}
                    {' '}<span style={{ fontFamily: "'JetBrains Mono', monospace" }}>target: {(rep as Report).target}</span>
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                    {(rep as Report).checks.map((c, i) => (
                      <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 12px', fontSize: 12.5,
                        borderTop: i ? '1px solid var(--border)' : 'none', background: c.ok ? 'transparent' : '#fef2f2' }}>
                        <span style={{ color: c.ok ? '#15803d' : '#dc2626', fontWeight: 700 }}>{c.ok ? '✓' : '✗'}</span>
                        <span style={{ flex: 1 }}>{c.name}{c.detail ? <span style={{ color: 'var(--text-dim)' }}> — {c.detail}</span> : null}</span>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{c.spec}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p style={{ color: 'var(--text-dim)', fontSize: 12.5, marginTop: 24, maxWidth: 800, lineHeight: 1.5 }}>
        Composed from Interego/Foxxi: the LRS is Foxxi's own statement store + section-4 validator
        (<code style={code}>src/xapi-validate.ts</code>), the SCORM engine is <code style={code}>src/scorm-sequencing.ts</code>,
        and the runner is <code style={code}>src/compliance-runner.ts</code> — the same code paths a production deployment uses.
        Foxxi also passes the broader ADL/1EdTech matrix (cmi5, LTI 1.3 Advantage, OneRoster 1.2, OB3, CLR 2.0) — see the
        repo's CONFORMANCE.md for the full citation-by-citation map.
      </p>
    </div>
  );
}

const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, padding: 0, fontFamily: "'JetBrains Mono', monospace" };
const runBtn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '9px 18px', borderRadius: 5, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: 13, letterSpacing: '0.04em' };
const code: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, background: 'var(--bg)', padding: '1px 5px', borderRadius: 3 };
