/**
 * Shared proof-rendering components used by the agentic demos (Portfolio,
 * Evidence Ledger): the independent-verification matrix (engine-graded /
 * tamper-evident vs self-attested) and the BBS+ selective-disclosure split
 * (revealed vs cryptographically hidden). Honest by construction.
 */
import React, { useState } from 'react';

const mono = "'JetBrains Mono', monospace";
export const artLabel: React.CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', marginBottom: 3 };

/** The verifier's due diligence: verify_extension `checks` as a 3-tier matrix.
 *  Engine grading + shape conformance are tamper-evident; the performance OUTCOME
 *  is flagged self-attested. */
export function VerificationMatrix({ d }: { d: any }) {
  const c = d?.checks ?? {};
  const rows = [
    { label: 'Engine grading', sub: 'SCORM SN runtime — tamper-evident', ok: !!c.independentlyGraded, badge: c.gradedScore != null ? `score ${c.gradedScore}` : (c.independentlyGraded ? 'graded' : 'no grade') },
    { label: 'Performance', sub: c.selfAttestedPerformance ? 'recorded on subject’s pod — ⚠ outcome self-attested' : 'recorded on subject’s pod', ok: !!c.performanceRecorded, badge: c.performanceRecorded ? 'recorded' : 'none' },
    { label: 'Extension shape', sub: 'PGSL / SHACL structural check', ok: !!c.shapeConformant, badge: c.shapeConformant ? 'conforms' : '—' },
  ];
  const n = Array.isArray(d?.evidence) ? d.evidence.length : 0;
  return (
    <div>
      <div style={artLabel}>independent verification — {d?.verified ? 'PASSED' : 'INSUFFICIENT'}</div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: i < 2 ? '1px solid #f0f0ee' : 'none', fontSize: 12 }}>
            <span style={{ color: r.ok ? '#2e9c4a' : '#d23f31', fontWeight: 600, width: 12 }}>{r.ok ? '✓' : '✗'}</span>
            <span style={{ flex: 1 }}><strong>{r.label}</strong> <span style={{ color: 'var(--text-dim)' }}>— {r.sub}</span></span>
            <span style={{ fontFamily: mono, fontSize: 10.5, color: 'var(--text-dim)' }}>{r.badge}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.45 }}>
        Engine grading + shape conformance are tamper-evident; the performance outcome is self-attested by the subject. {n > 0 ? `${n} evidencing statement${n === 1 ? '' : 's'} on the subject’s own pod.` : ''}
      </div>
    </div>
  );
}

/** BBS+ selective disclosure: revealed vs. cryptographically hidden. */
export function SelectiveDisclosure({ revealed, hidden }: { revealed: Array<{ path: string; value: string }>; hidden: string[] }) {
  const tail = (p: string) => p.replace(/^achievement\./, '').replace(/\[0\]/, '');
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

/** A collapsible raw JSON / text viewer (dark code block). */
export function CodeReveal({ label, value, open: openInit = false }: { label: string; value: unknown; open?: boolean }) {
  const [open, setOpen] = useState(openInit);
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(o => !o)} style={{ ...artLabel, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 9 }}>{open ? '▾' : '▸'}</span>{label}
      </button>
      {open && (
        <pre style={{ fontSize: 10.5, lineHeight: 1.45, background: '#0f1115', color: '#cdd6e0', padding: 10, borderRadius: 5, overflow: 'auto', maxHeight: 320, margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</pre>
      )}
    </div>
  );
}
