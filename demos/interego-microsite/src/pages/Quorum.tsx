import React, { useState } from 'react';
import { makePanel, runGovernanceRound, makeEmit, resetCounter, type GovEvent, type RoundResult } from '../demo/governance.js';
import { BRIDGE_URL } from '../lib/bridge.js';
import { card, lbl, codeS, btn, mono, serif } from '../styles.js';
import { KeyCard, Back } from '../components.js';

const PANEL = [
  { name: 'Ada', stance: 'Evidence-first — agent claims must be backed by verifiable, engine-graded evidence; you favor strict accountability.' },
  { name: 'Boole', stance: 'Pragmatist — rules must be enforceable and not block legitimate fast work; you oppose unfunded mandates.' },
  { name: 'Cantor', stance: 'Minimalist — you distrust central mandates on autonomous agents and default AGAINST new constraints unless the case is overwhelming.' },
  { name: 'Dijkstra', stance: 'Rigorist — correctness and auditability above convenience; you favor anything that increases verifiability.' },
];
const PROPOSAL = 'Every signed performance MUST cite an authoritative standard, or be auto-marked Hypothetical until it does.';

export function Quorum({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [events, setEvents] = useState<GovEvent[]>([]);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = apiKey.trim().length > 0;

  async function run() {
    if (running || !hasKey) return;
    setRunning(true); setErr(null); setEvents([]); setResult(null); resetCounter();
    const emit = makeEmit(e => setEvents(p => [...p, e]));
    try {
      const agents = makePanel(PANEL);
      agents.forEach(a => emit({ actor: a.name, kind: 'identity', title: `${a.name} — self-sovereign voter`, detail: `${a.wallet.did.slice(0, 20)}… · ${a.stance.split('—')[0].trim()}` }));
      setResult(await runGovernanceRound(apiKey, emit, { agents, policyId: 'urn:iep:policy:demo', tier: 2, summary: PROPOSAL, addedRules: ['performance.standard REQUIRED ∨ modalStatus=Hypothetical'], rules: { minQuorum: 3, threshold: 0.51 }, forkOnReject: true }));
    } catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  }

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '28px 24px 80px' }}>
      <Back onHome={onHome} />
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>The Quorum</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 840, lineHeight: 1.5 }}>
        A panel of <strong>LLM agents</strong>, each a self-sovereign wallet with its own stance, <strong>debate</strong> an
        amendment and each <strong>signs its vote</strong>. The substrate&rsquo;s emergent <code style={codeS}>protocol.governance_round</code>
        capability — <em>discovered</em> from the bridge manifest, not a hardcoded path — recovers each <strong>distinct signer</strong>
        (signer = claimed identity, so the quorum can&rsquo;t be stuffed or forged), tallies, ratifies, and the dissenters
        <strong> fork the constitution</strong> on a loss. Composes <code style={codeS}>@interego/constitutional</code>. Real signed
        calls to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>.
      </p>
      <KeyCard apiKey={apiKey} setKey={setApiKey} note="each voter is a real LLM agent reasoning from its stance" />
      <div style={{ ...card, marginTop: 12 }}>
        <div style={lbl}>the amendment on the floor</div>
        <div style={{ fontSize: 14, marginTop: 4 }}>&ldquo;{PROPOSAL}&rdquo;</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>tier 2 · needs ≥3 signed votes and &gt;51% for · dissenters may fork</div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={run} disabled={running || !hasKey} style={{ ...btn, opacity: running || !hasKey ? 0.5 : 1 }}>{running ? 'the quorum deliberates…' : 'Convene the quorum'}</button>
        {!hasKey && <span style={{ fontSize: 12, color: 'var(--warn)' }}>add your Anthropic key above — the voters are real LLM agents.</span>}
      </div>
      {err && <div style={{ ...card, borderLeft: '3px solid var(--bad)', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}
      {result && (
        <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${result.status === 'Ratified' ? 'var(--good)' : result.fork ? 'var(--accent-2)' : 'var(--warn)'}` }}>
          <div style={{ fontFamily: serif, fontSize: 24, color: result.status === 'Ratified' ? 'var(--good)' : result.fork ? 'var(--accent-2)' : 'var(--warn)' }}>
            {result.status === 'Ratified' ? '✓ Ratified by signed quorum' : result.fork ? '⑂ Rejected → constitution forked' : `✗ ${result.status}`}
          </div>
          <div style={{ fontSize: 13, marginTop: 6 }}>{result.tally?.for} for · {result.tally?.against} against · {result.tally?.abstain} abstain — {(result.tally?.proportion * 100).toFixed(0)}% of {result.tally?.distinctVoters} distinct signers (needed {(result.tally?.threshold * 100).toFixed(0)}%)</div>
          {result.holon?.holonUri && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>content-addressed outcome holon: <code style={{ ...codeS, fontSize: 10.5 }}>{result.holon.holonUri}</code></div>}
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
  if (e.kind === 'ratify') return <div style={{ fontSize: 13.5, fontWeight: 600, margin: '4px 0', color: e.title.startsWith('✓') ? 'var(--good)' : 'var(--warn)' }}>{e.title}{e.detail ? <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
  if (e.kind === 'fork') return <div style={{ fontSize: 13, color: 'var(--accent-2)', margin: '4px 0' }}>{e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
  if (e.kind === 'done') return <div style={{ fontSize: 12, color: 'var(--good)', marginTop: 6 }}>✓ {e.title}</div>;
  if (e.kind === 'error') return <div style={{ fontSize: 12, color: 'var(--bad)' }}>⚠ {e.title}</div>;
  const vColor = e.kind === 'vote' ? (e.title === 'FOR' ? 'var(--good)' : e.title === 'AGAINST' ? 'var(--bad)' : 'var(--text-dim)') : 'var(--text)';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' }}>
      <span style={{ fontFamily: mono, fontSize: 9.5, color: 'var(--accent)', minWidth: 72, fontWeight: 600 }}>{e.actor}</span>
      <span style={{ fontSize: 12.5, flex: 1, lineHeight: 1.4 }}>
        {e.kind === 'vote' ? <><strong style={{ color: vColor }}>{e.title}</strong>{e.detail ? <span style={{ color: 'var(--text-dim)' }}> — {e.detail}</span> : null}</>
          : <><strong>{e.title}</strong>{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</>}
      </span>
    </div>
  );
}
