/**
 * Federated Calibration — a shared memory two rivals both trust.
 *
 * Two organizations build ONE calibration memory of what actually closes
 * performance gaps, WITHOUT sharing a single raw record. Each org distils its
 * private evaluations into aggregate (regime × cause × intervention → verdict)
 * cells and CONTRIBUTES them SIGNED (rev-196, a fresh wallet per org). The bridge
 * recovers each contributor from its signature, applies a minimum-aggregate (k-sample) suppression floor (a
 * cell crosses the boundary only as an aggregate above k samples — never
 * narrowing to a learner), then pools them: a cell Hypothetical for each org
 * alone becomes Asserted once pooled. Trust the math, not the aggregator. The
 * merged memory is a dereferenceable, interrogable PGSL holon neither org could
 * forge alone. No API key needed.
 */
import React, { useState } from 'react';
import { freshAgent, signEnvelope, type AgentWallet } from '../demo/agent-signing.js';
import { bridgeRest, BRIDGE_URL } from '../bridge-client.js';

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '5px 13px', fontSize: 12, cursor: 'pointer', background: 'transparent' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };

// The thresholds the bridge ENFORCES as floors (caller may raise, never lower).
// Single source so the caption, the per-cell badge, and the merge call can never desync.
const K_FLOOR = 8;       // minimum-aggregate (k-sample) suppression floor — a cell crosses only above this many samples
const ASSERT_FLOOR = 12; // a pooled cell is Asserted only at/above this many samples
const REGIMES = ['Evident', 'Knowable', 'Emergent', 'Turbulent'];
const CAUSES = ['information', 'instrumentation', 'incentives', 'knowledgeSkill', 'capacity', 'motives'];
const INTERVENTIONS = ['instruction', 'performance-support', 'reference', 'practice', 'assessment', 'coaching', 'probe', 'environmental-fix'];
const CAUSE_LABEL: Record<string, string> = { knowledgeSkill: 'knowledge & skill', instrumentation: 'instrumentation', incentives: 'incentives', information: 'information', capacity: 'capacity', motives: 'motives' };

interface Cell { regime: string; causeFactor: string; intervention: string; closed: number; improved: number; noChange: number }
interface Org { name: string; cells: Cell[] }

const DEFAULT_ORGS: Org[] = [
  { name: 'Org A (rival)', cells: [
    { regime: 'Knowable', causeFactor: 'knowledgeSkill', intervention: 'instruction', closed: 5, improved: 2, noChange: 2 },
    { regime: 'Knowable', causeFactor: 'instrumentation', intervention: 'performance-support', closed: 6, improved: 2, noChange: 1 },
    { regime: 'Emergent', causeFactor: 'motives', intervention: 'coaching', closed: 2, improved: 1, noChange: 0 },
  ] },
  { name: 'Org B (rival)', cells: [
    { regime: 'Knowable', causeFactor: 'knowledgeSkill', intervention: 'instruction', closed: 6, improved: 1, noChange: 2 },
    { regime: 'Knowable', causeFactor: 'instrumentation', intervention: 'performance-support', closed: 7, improved: 1, noChange: 1 },
  ] },
];

export function FederatedCalibration({ onHome }: { onHome: () => void }) {
  const [orgs, setOrgs] = useState<Org[]>(DEFAULT_ORGS);
  const [res, setRes] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [interrog, setInterrog] = useState<any>(null);
  const [interrogBusy, setInterrogBusy] = useState(false);

  function samples(c: Cell) { return c.closed + c.improved + c.noChange; }
  function setCell(oi: number, ci: number, key: keyof Cell, v: string) {
    setOrgs(os => os.map((o, i) => i !== oi ? o : { ...o, cells: o.cells.map((c, j) => j !== ci ? c : { ...c, [key]: key === 'regime' || key === 'causeFactor' || key === 'intervention' ? v : Math.max(0, Number(v) || 0) }) }));
  }

  async function merge() {
    if (running) return;
    setRunning(true); setErr(null); setRes(null); setInterrog(null);
    try {
      // Each org signs its OWN contribution with a fresh wallet (rev-196).
      const contributions = await Promise.all(orgs.map(async (o) => {
        const w: AgentWallet = freshAgent();
        return signEnvelope(w, { specs: o.cells });
      }));
      const { status, json } = await bridgeRest('/agent/calibration/merge', { contributions, k: K_FLOOR, assertThreshold: ASSERT_FLOOR });
      if (status !== 200 || json.ok === false) { setErr(String(json.error ?? `HTTP ${status}`)); }
      else setRes(json);
    } catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  }

  async function interrogate() {
    if (!res?.holon?.holonUri) return;
    setInterrogBusy(true); setInterrog(null);
    try {
      // The merged memory is itself interrogable — route the grammar over its holon.
      const label = String(res.holon.descriptorUrl || '').split('/').filter(Boolean).slice(-2, -1)[0] || 'calibration-consortium';
      const url = `${BRIDGE_URL}/agent/lattice/${label}/interrogate?uri=${encodeURIComponent(res.holon.holonUri)}&agent_did=${encodeURIComponent('did:web:consortium')}`;
      const r = await fetch(url); const j = await r.json().catch(() => ({}));
      setInterrog(j);
    } catch (e) { setInterrog({ error: (e as Error).message }); }
    finally { setInterrogBusy(false); }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>A shared memory two rivals both trust</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 840, lineHeight: 1.5 }}>
        Two rival orgs build <strong>one calibration memory</strong> of what actually closes performance gaps — without trusting
        each other or surrendering a raw record. Each distils private evaluations into aggregate
        <code style={codeS}>regime × cause × intervention → did&nbsp;it&nbsp;close</code> cells and contributes them <strong>signed by a distinct key</strong>.
        The bridge applies a <strong>minimum-aggregate (k-sample) suppression floor</strong> (a cell crosses only as an aggregate above {K_FLOOR} samples) and pools
        across <strong>distinct signing keys</strong> — a cell <strong>Hypothetical for each contributor alone becomes Asserted once pooled</strong>. Trust the math, not the
        aggregator. (Signatures prove the contributing key, not that two keys are independent rival orgs.) Real signed calls to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>. <strong>No API key.</strong>
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 18 }}>
        {orgs.map((o, oi) => (
          <div key={oi} style={card}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{o.name}</div>
            <div style={{ ...lbl, marginBottom: 4 }}>private outcome cells (closed / improved / no-change)</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {o.cells.map((c, ci) => (
                <div key={ci} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px' }}>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                    <Sel v={c.regime} opts={REGIMES} onChange={v => setCell(oi, ci, 'regime', v)} />
                    <Sel v={c.causeFactor} opts={CAUSES} onChange={v => setCell(oi, ci, 'causeFactor', v)} />
                    <Sel v={c.intervention} opts={INTERVENTIONS} onChange={v => setCell(oi, ci, 'intervention', v)} />
                  </div>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    <Num v={c.closed} onChange={v => setCell(oi, ci, 'closed', v)} title="closed" />
                    <Num v={c.improved} onChange={v => setCell(oi, ci, 'improved', v)} title="improved" />
                    <Num v={c.noChange} onChange={v => setCell(oi, ci, 'noChange', v)} title="no-change" />
                    <span style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 10, color: samples(c) >= K_FLOOR ? '#2e9c4a' : '#b45309' }}>
                      {samples(c)} smpl {samples(c) >= K_FLOOR ? '(≥k, shareable)' : '(<k, withheld)'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={merge} disabled={running} style={{ ...btn, opacity: running ? 0.5 : 1 }}>{running ? 'Merging…' : 'Each org signs + contribute → merge'}</button>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>min-aggregate (k-sample) floor = {K_FLOOR} samples · assert threshold = {ASSERT_FLOOR} samples (server-enforced)</span>
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid #c1432a', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {res && (
        <>
          {res.promoted?.length > 0 && (
            <div style={{ ...card, marginTop: 14, borderLeft: '5px solid #2e9c4a' }}>
              <div style={{ fontFamily: serif, fontSize: 20, color: '#2e9c4a' }}>✓ Pooling asserted what neither org could alone</div>
              <div style={{ fontSize: 13, color: 'var(--text)', marginTop: 6 }}>
                {res.promoted.map((p: any, i: number) => (
                  <div key={i}>· <strong>{p.intervention}</strong> for a <strong>{CAUSE_LABEL[p.causeFactor] ?? p.causeFactor}</strong> cause ({p.regime}) — {p.samples} pooled samples, closes {(p.closureRate * 100).toFixed(0)}% — <span style={{ color: '#2e9c4a' }}>now Asserted</span></div>
                ))}
              </div>
            </div>
          )}

          <div style={{ ...card, marginTop: 14 }}>
            <div style={{ ...lbl, marginBottom: 6 }}>the merged calibration memory · {res.contributors?.length ?? 0} contributors · {res.merged?.totalSamples ?? 0} pooled samples</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {(res.merged?.cells ?? []).map((c: any, i: number) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12.5, borderLeft: `4px solid ${c.modalStatus === 'Asserted' ? '#2e9c4a' : '#b45309'}` }}>
                  <span><strong>{c.intervention}</strong> · {CAUSE_LABEL[c.causeFactor] ?? c.causeFactor} · {c.regime}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 11, color: 'var(--text-dim)' }}>{c.samples} smpl · closes {(c.closureRate * 100).toFixed(0)}%</span>
                  <span style={{ fontFamily: mono, fontSize: 9.5, padding: '1px 7px', borderRadius: 3, background: c.modalStatus === 'Asserted' ? 'rgba(46,160,67,0.14)' : 'rgba(180,83,9,0.14)', color: c.modalStatus === 'Asserted' ? '#2e9c4a' : '#b45309' }}>{c.modalStatus}</span>
                </div>
              ))}
            </div>
            {res.readout?.readout && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>↳ {res.readout.readout}</div>}
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.45 }}>
              No raw record crossed a boundary — only aggregate cells above the minimum-aggregate (k-sample) suppression floor (cells below it were withheld). Each contribution was signed by a distinct key (recovered, not asserted; same-key resubmissions collapse to one source).{res.distinctSigners != null && <> {res.distinctSigners} distinct signing key(s){res.multiParty === false && ' — single-key merge: self-only profile, not cross-source consensus'}.</>}
            </div>
          </div>

          {res.holon?.holonUri && (
            <div style={{ ...card, marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Interrogate the merged truth</div>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>the consortium memory is itself a dereferenceable, interrogable holon</span>
                <button onClick={interrogate} disabled={interrogBusy} style={{ ...pill, marginLeft: 'auto', borderColor: 'var(--accent)', color: 'var(--accent)', opacity: interrogBusy ? 0.5 : 1 }}>{interrogBusy ? 'asking…' : 'Interrogate (who/what/why)'}</button>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 4 }}>
                holon <code style={codeS}>{String(res.holon.holonUri).slice(0, 44)}…</code>
                {res.holon.descriptorUrl && <> · <a href={res.holon.descriptorUrl} target="_blank" rel="noreferrer" style={linkBtn}>dereference ↗</a></>}
              </div>
              {interrog && Array.isArray(interrog.answers) && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: 8, marginTop: 10 }}>
                  {interrog.answers.slice(0, 8).map((a: any) => (
                    <div key={a.interrogative} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px' }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{a.interrogative} <span style={{ fontFamily: mono, fontSize: 9.5, color: 'var(--text-dim)' }}>· {a.status}</span></div>
                      {a.values && <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--text)', marginTop: 2, wordBreak: 'break-word' }}>{Object.entries(a.values).slice(0, 3).map(([k, v]) => <div key={k}>{k}: {String(v).slice(0, 50)}</div>)}</div>}
                    </div>
                  ))}
                </div>
              )}
              {interrog?.error && <div style={{ fontFamily: mono, fontSize: 11.5, color: '#c1432a', marginTop: 6 }}>⚠ {interrog.error}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Sel({ v, opts, onChange }: { v: string; opts: string[]; onChange: (v: string) => void }) {
  return <select value={v} onChange={e => onChange(e.target.value)} style={{ flex: 1, minWidth: 90, padding: '3px 4px', borderRadius: 4, border: '1px solid var(--border)', fontFamily: mono, fontSize: 10.5 }}>{opts.map(o => <option key={o} value={o}>{o}</option>)}</select>;
}
function Num({ v, onChange, title }: { v: number; onChange: (v: string) => void; title: string }) {
  return <label style={{ fontSize: 9.5, color: 'var(--text-dim)' }} title={title}>{title[0]}<input value={v} onChange={e => onChange(e.target.value)} style={{ width: 36, padding: '3px 4px', borderRadius: 4, border: '1px solid var(--border)', fontFamily: mono, fontSize: 11, marginLeft: 2 }} /></label>;
}
