/**
 * Evidence Ledger — the self-proving audit pack for agent workforces.
 *
 * Point at a real agent action and get a dereferenceable, cryptographically
 * verifiable evidence pack: the signer recovered from the raw bytes (client-side),
 * the action validated against the live SHACL shapes (whose IRI you click and it
 * dereferences), a SOC 2 / EU-AI-Act / NIST control citation bound to the event
 * (each IRI dereferences), and the authority walked from the agent's OWN pod.
 *
 * Kill-shot: re-verify any pack from a CLEAN SEAT — re-recover the signer,
 * re-dereference the shape, re-validate — with zero stored trust; and a one-byte
 * tamper breaks the signature. Mutable audit-log rows the same system vouches for
 * cannot do this.
 */
import React, { useState } from 'react';
import { buildEvidencePack, verifyFromCleanSeat, makeEmit, resetCounter, type EvidenceEvent, type EvidencePack, type EvidenceItem, type CleanSeatResult } from '../demo/evidence.js';
import { CodeReveal } from '../components/proof.js';
import { BRIDGE_URL } from '../bridge-client.js';

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '5px 13px', fontSize: 12, cursor: 'pointer', background: 'transparent' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };

export function EvidenceLedger({ onHome }: { onHome: () => void }) {
  const [events, setEvents] = useState<EvidenceEvent[]>([]);
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (running) return;
    setRunning(true); setErr(null); setEvents([]); setPack(null); resetCounter();
    const emit = makeEmit(e => setEvents(prev => [...prev, e]));
    try { setPack(await buildEvidencePack(emit)); }
    catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>Evidence ledger</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 820, lineHeight: 1.5 }}>
        Point at any agent action and get a <strong>self-proving audit pack</strong>: the signer recovered from the raw
        bytes (in your browser), the action validated against the <strong>live SHACL shapes</strong> — click the shape IRI
        and it dereferences — and a <strong>SOC&nbsp;2 / EU&nbsp;AI&nbsp;Act / NIST</strong> control cited on the event (SOC&nbsp;2
        validated against its served shape), each IRI dereferenceable. The kill-shot: <strong>re-verify from a clean seat</strong> with zero stored trust, and watch a
        one-byte tamper break the signature. Mutable audit-log rows the same vendor vouches for can&rsquo;t do this. Real signed
        calls to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>. <strong>No API key needed.</strong>
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '18px 0 6px' }}>
        <button onClick={run} disabled={running} style={{ ...btn, opacity: running ? 0.5 : 1 }}>{running ? 'Building the pack…' : 'Perform actions + assemble the pack'}</button>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>spawns a fresh agent, performs real signed actions, assembles a verifiable pack for each</span>
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid #c1432a', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>assembling — every step real</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {events.map(e => (
              <div key={e.id} style={{ borderLeft: `3px solid ${KIND[e.kind] ?? '#6b7280'}`, padding: '5px 10px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontFamily: mono, fontSize: 9, textTransform: 'uppercase', color: KIND[e.kind] ?? '#6b7280', minWidth: 66 }}>{e.kind}</span>
                  <span style={{ fontSize: 13, flex: 1 }}>{e.title}</span>
                </div>
                {e.detail && <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginLeft: 74, lineHeight: 1.4, wordBreak: 'break-all' }}>{e.detail}</div>}
              </div>
            ))}
            {running && <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '6px 0' }}>working…</div>}
          </div>
        </div>
      )}

      {pack && pack.items.map((it, i) => <PackCard key={i} item={it} n={i + 1} />)}
    </div>
  );
}

function PackCard({ item, n }: { item: EvidenceItem; n: number }) {
  const [clean, setClean] = useState<CleanSeatResult | null>(null);
  const [busy, setBusy] = useState(false);
  async function reverify() { setBusy(true); try { setClean(await verifyFromCleanSeat(item)); } finally { setBusy(false); } }

  const rows = [
    { ok: item.signerMatches, label: 'Signer recovered from bytes', detail: item.signer ?? 'invalid' },
    { ok: !!item.xapiConforms, label: 'Validates against live xAPI SHACL shapes', detail: item.xapiShapesIri },
    { ok: !!item.soc2Conforms, label: 'Projects to a SOC 2 evidence event that is structurally conformant (cites a criterion + carries signer/occurredAt)', detail: item.soc2Conforms ? 'shape-valid · cites CC6.1' : 'compliance ontology pending deploy' },
  ];
  return (
    <div style={{ ...card, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Evidence pack #{n}</div>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{item.action}</span>
        {item.statementId && <span style={{ fontFamily: mono, fontSize: 10.5, color: 'var(--text-dim)', marginLeft: 'auto' }}>stmt {String(item.statementId).slice(0, 8)}…</span>}
      </div>

      <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: i < rows.length - 1 ? '1px solid #f0f0ee' : 'none', fontSize: 12.5 }}>
            <span style={{ color: r.ok ? '#2e9c4a' : '#d97706', fontWeight: 600, width: 12 }}>{r.ok ? '✓' : '○'}</span>
            <span style={{ flex: 1 }}>{r.label}</span>
            {r.detail && <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--text-dim)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail}</span>}
          </div>
        ))}
      </div>

      {/* Framework citations — each dereferenceable. SOC 2 is validated against its
          served shape; EU-AI-Act / NIST are cited (dereferenceable, not validated). */}
      <div style={{ marginTop: 10 }}>
        <div style={lbl}>framework controls cited — each IRI dereferences (SOC 2 validated against its served shape; others cited)</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
          {item.controls.map(c => (
            <a key={c.iri} href={c.iri} target="_blank" rel="noreferrer" title={c.label} style={{ ...pill, borderColor: 'var(--accent)', color: 'var(--accent)', textDecoration: 'none' }}>{c.id} ↗</a>
          ))}
        </div>
      </div>

      {/* Kill-shot */}
      <div style={{ marginTop: 12, padding: 10, background: '#f8fafc', border: '1px solid var(--border)', borderRadius: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={reverify} disabled={busy} style={{ ...pill, borderColor: 'var(--accent)', color: 'var(--accent)', opacity: busy ? 0.5 : 1 }}>{busy ? 'verifying…' : '🔁 Verify from a clean seat'}</button>
          <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>re-recovers the signer + re-dereferences the shape + re-validates — zero stored trust</span>
        </div>
        {clean && (
          <div style={{ marginTop: 8, display: 'grid', gap: 3 }}>
            <CleanRow ok={clean.signerOk} label={`signer re-recovered ${clean.recovered?.slice(0, 14)}…`} />
            <CleanRow ok={clean.shapeOk} label={`cited shape IRI dereferences (HTTP ${clean.shapeStatus})`} />
            <CleanRow ok={clean.validateOk} label="action re-validates against the live shapes" />
            <CleanRow ok={clean.tamperBreaks} label="one-byte tamper breaks the signature recovery" />
          </div>
        )}
      </div>

      <CodeReveal label="raw signed envelope (the bytes that prove it)" value={item.envelope} />
      <CodeReveal label="reproduce from a shell (copy the curl)" value={item.curl} />
      <CodeReveal label="SOC 2 evidence projection (validated against the served shape)" value={item.soc2Instance} />
    </div>
  );
}

function CleanRow({ ok, label }: { ok: boolean; label: string }) {
  return <div style={{ fontSize: 12, display: 'flex', gap: 6 }}><span style={{ color: ok ? '#2e9c4a' : '#d23f31', fontWeight: 600 }}>{ok ? '✓' : '✗'}</span>{label}</div>;
}

const KIND: Record<string, string> = { identity: '#6b7280', action: '#2563eb', recover: '#7c3aed', validate: '#059669', cite: '#d97706', authority: '#0891b2', error: '#dc2626' };
