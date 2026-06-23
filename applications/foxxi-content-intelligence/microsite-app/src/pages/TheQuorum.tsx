/**
 * The Quorum (#4) — a panel of LLM agents DEBATE an amendment to their shared
 * policy, each SIGNS its vote, the bridge tallies + ratifies (and the dissenters
 * fork on a loss). Signed, distinct-signer governance — composing
 * @interego/constitutional. BYOK.
 */
import React, { useState } from 'react';
import { makePanel, runGovernanceRound, makeEmit, resetCounter, type GovEvent, type RoundResult } from '../demo/governance.js';
import { BRIDGE_URL } from '../bridge-client.js';

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };

const PANEL = [
  { name: 'Ada', stance: 'Evidence-first — agent claims must be backed by verifiable, engine-graded evidence; you favor strict accountability.' },
  { name: 'Boole', stance: 'Pragmatist — rules must be enforceable and must not block legitimate fast work; you oppose unfunded mandates.' },
  { name: 'Cantor', stance: 'Minimalist — you distrust central mandates on autonomous agents and default AGAINST new constraints unless the case is overwhelming.' },
  { name: 'Dijkstra', stance: 'Rigorist — correctness and auditability above convenience; you favor anything that increases verifiability.' },
];
const PROPOSAL = 'Every recorded performance MUST cite an authoritative standard (activity_type), or be auto-marked Hypothetical until it does.';

export function TheQuorum({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [events, setEvents] = useState<GovEvent[]>([]);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = apiKey.trim().length > 0;

  async function run() {
    if (running || !hasKey) return;
    setRunning(true); setErr(null); setEvents([]); setResult(null); resetCounter();
    const emit = makeEmit(e => setEvents(prev => [...prev, e]));
    try {
      const agents = makePanel(PANEL);
      agents.forEach(a => emit({ actor: a.name, kind: 'identity', title: `${a.name} — self-sovereign voter`, detail: `${a.wallet.did.slice(0, 20)}… · ${a.stance.split('—')[0].trim()}` }));
      const r = await runGovernanceRound(apiKey, emit, { agents, policyId: 'urn:foxxi:policy:performance-evidence', tier: 2, summary: PROPOSAL, addedRules: ['performance.activity_type REQUIRED ∨ modalStatus=Hypothetical'], rules: { minQuorum: 3, threshold: 0.51 }, forkOnReject: true });
      setResult(r);
      emit({ actor: 'consortium', kind: 'done', title: r.status === 'Ratified' ? 'amendment ratified by signed quorum' : r.fork ? 'rejected → dissenters forked' : `amendment ${r.status}` });
    } catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  }

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>The Quorum</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 840, lineHeight: 1.5 }}>
        A panel of <strong>LLM agents</strong> — each a self-sovereign wallet with its own stance — <strong>debate</strong> an
        amendment to the policy that governs them, then each <strong>signs its vote</strong>. The bridge recovers each
        <strong> distinct signer</strong> (signer = claimed identity — the same anti-Sybil binding the calibration merge uses, so
        the quorum can&rsquo;t be stuffed or forged), tallies, and <strong>ratifies</strong> per the ratification rule — and the
        dissenters <strong>fork the constitution</strong> on a loss. Self-governing agents with verifiable, signed votes,
        composing the <code style={codeS}>@interego/constitutional</code> state machine. Real signed calls to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>.
      </p>

      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ ...lbl, marginBottom: 4 }}>Anthropic key — each voter is a real LLM agent reasoning from its stance, so they need your key (sent only to api.anthropic.com from this tab). The signature recovery + ratification math are deterministic.</div>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-… (required — a panel of real LLM agents debate + vote)"
          autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
          style={{ width: '100%', marginTop: 5, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' }} />
      </div>

      <div style={{ ...card, marginTop: 12 }}>
        <div style={lbl}>the amendment on the floor</div>
        <div style={{ fontSize: 14, marginTop: 4 }}>&ldquo;{PROPOSAL}&rdquo;</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>tier 2 · needs ≥3 signed votes and &gt;51% for · dissenters may fork</div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={run} disabled={running || !hasKey} style={{ ...btn, opacity: running || !hasKey ? 0.5 : 1 }}>{running ? 'the quorum deliberates…' : 'Convene the quorum'}</button>
        {!hasKey && <span style={{ fontSize: 12, color: '#b45309' }}>add your Anthropic key above — the voters are real LLM agents.</span>}
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid #c1432a', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {result && (
        <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${result.status === 'Ratified' ? '#2e9c4a' : result.fork ? '#9333ea' : '#b45309'}` }}>
          <div style={{ fontFamily: serif, fontSize: 24, color: result.status === 'Ratified' ? '#2e9c4a' : result.fork ? '#9333ea' : '#b45309' }}>
            {result.status === 'Ratified' ? '✓ Ratified by signed quorum' : result.fork ? '⑂ Rejected → constitution forked' : `✗ ${result.status}`}
          </div>
          <div style={{ fontSize: 13, marginTop: 6 }}>{result.tally?.for} for · {result.tally?.against} against · {result.tally?.abstain} abstain — {(result.tally?.proportion * 100).toFixed(0)}% of {result.tally?.distinctVoters} distinct signers (needed {(result.tally?.threshold * 100).toFixed(0)}%)</div>
          {result.holon?.descriptorUrl && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>outcome holon: <a href={result.holon.descriptorUrl} target="_blank" rel="noreferrer" style={linkBtn}>dereference ↗</a></div>}
        </div>
      )}

      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>the deliberation — debate, signed votes, ratification</div>
          <div style={{ display: 'grid', gap: 2 }}>{events.map(e => <Row key={e.id} e={e} />)}{running && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>working…</div>}</div>
        </div>
      )}
    </div>
  );
}

export function Row({ e }: { e: GovEvent }) {
  if (e.kind === 'phase') return <div style={{ ...lbl, color: 'var(--accent)', marginTop: 8 }}>▸ {e.title}</div>;
  if (e.kind === 'tally') return <div style={{ fontSize: 12.5, margin: '4px 0', paddingLeft: 8, borderLeft: '2px solid var(--accent)' }}>◆ {e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
  if (e.kind === 'ratify') return <div style={{ fontSize: 13.5, fontWeight: 600, margin: '4px 0', color: e.title.startsWith('✓') ? '#2e9c4a' : '#b45309' }}>{e.title}{e.detail ? <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
  if (e.kind === 'fork') return <div style={{ fontSize: 13, color: '#9333ea', margin: '4px 0' }}>{e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
  if (e.kind === 'done') return <div style={{ fontSize: 12, color: '#2e9c4a', marginTop: 6 }}>✓ {e.title}</div>;
  if (e.kind === 'error') return <div style={{ fontSize: 12, color: '#c1432a' }}>⚠ {e.title}</div>;
  const vColor = e.kind === 'vote' ? (e.title === 'FOR' ? '#2e9c4a' : e.title === 'AGAINST' ? '#d23f31' : '#6b7280') : 'var(--text)';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' }}>
      <span style={{ fontFamily: mono, fontSize: 9.5, color: '#2563eb', minWidth: 72, fontWeight: 600 }}>{e.actor}</span>
      <span style={{ fontSize: 12.5, flex: 1, lineHeight: 1.4 }}>
        {e.kind === 'vote' ? <><strong style={{ color: vColor }}>{e.title}</strong>{e.detail ? <span style={{ color: 'var(--text-dim)' }}> — {e.detail}</span> : null}</>
          : e.kind === 'propose' ? <><strong>{e.title}</strong>{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</>
          : <>{e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</>}
      </span>
    </div>
  );
}
