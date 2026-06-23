import React, { useState } from 'react';
import { runBabel, makeEmit, resetCounter, type BabelEvent, type BabelResult } from '../demo/babel.js';
import { BRIDGE_URL } from '../lib/bridge.js';
import { card, lbl, codeS, btn, mono, serif } from '../styles.js';
import { KeyCard, Back } from '../components.js';

const A_COL = 'var(--accent)', B_COL = 'var(--accent-2)';

export function Babel({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [events, setEvents] = useState<BabelEvent[]>([]);
  const [result, setResult] = useState<BabelResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = apiKey.trim().length > 0;

  async function run() {
    if (running || !hasKey) return;
    setRunning(true); setErr(null); setEvents([]); setResult(null); resetCounter();
    const emit = makeEmit(e => setEvents(p => [...p, e]));
    try { setResult(await runBabel(apiKey, emit)); } catch (e) { setErr((e as Error).message); } finally { setRunning(false); }
  }
  const who = (a: BabelEvent['actor']) => a === 'Agent A' ? A_COL : a === 'Agent B' ? B_COL : 'var(--text-dim)';

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '28px 24px 80px' }}>
      <Back onHome={onHome} />
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>Babel</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 840, lineHeight: 1.5 }}>
        Two LLM agents each <strong>coin their own private word</strong> for the same concept and content-address it via
        <code style={codeS}>protocol.pgsl_mint_atom</code>. Byte-different words → different <code style={codeS}>urn:pgsl:atom</code>
        hashes → <code style={codeS}>protocol.pgsl_meet</code> shows <strong>0 shared</strong> for the concept. They
        <strong> negotiate one canonical word</strong> in natural language, both mint it, and the meet now finds the
        <strong> fused atom</strong> — meaning-as-use, reified as sha256 the model can&rsquo;t fake. Pure substrate; no vertical.
        <strong> Honest:</strong> content-addressing keeps near-synonyms distinct — that&rsquo;s the feature. Calls to
        <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>.
      </p>
      <KeyCard apiKey={apiKey} setKey={setApiKey} note="both agents (coining + negotiating) are real LLM agents" />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={run} disabled={running || !hasKey} style={{ ...btn, opacity: running || !hasKey ? 0.5 : 1 }}>{running ? 'agents converging…' : 'Coin · negotiate · converge'}</button>
        {!hasKey && <span style={{ fontSize: 12, color: 'var(--warn)' }}>add your Anthropic key above — two real LLM agents run this.</span>}
      </div>
      {err && <div style={{ ...card, borderLeft: '3px solid var(--bad)', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}
      {result && (
        <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${result.converged ? 'var(--good)' : 'var(--warn)'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: serif, fontSize: 26, color: result.converged ? 'var(--good)' : 'var(--warn)' }}>shared atoms {result.sharedBefore} <span style={{ color: 'var(--text-dim)' }}>→</span> {result.sharedAfter}</div>
            <div style={{ fontSize: 13 }}>{result.converged ? <>✓ the concept word <strong>fused</strong> when both adopted <code style={codeS}>{result.agreedWord}</code></> : 'no new fusion this run'}</div>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
            <span><span style={{ color: A_COL, fontWeight: 600 }}>A coined</span> “{result.wordA}”</span>
            <span><span style={{ color: B_COL, fontWeight: 600 }}>B coined</span> “{result.wordB}”</span>
            <span><strong>agreed</strong> “{result.agreedWord}”</span>
          </div>
          {result.fusedAtom && <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-dim)' }}>the newly-shared atom: <code style={{ ...codeS, fontSize: 10.5 }}>{result.fusedAtom}</code></div>}
        </div>
      )}
      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>convergence — coining, negotiating, fusing (real substrate calls)</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {events.map(e => {
              if (e.kind === 'phase') return <div key={e.id} style={{ ...lbl, color: 'var(--accent)', marginTop: 8 }}>▸ {e.title}</div>;
              if (e.kind === 'measure' || e.kind === 'fuse') return <div key={e.id} style={{ fontSize: 12.5, margin: '4px 0', paddingLeft: 8, borderLeft: '2px solid var(--accent)' }}>◆ {e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
              if (e.kind === 'done') return <div key={e.id} style={{ fontSize: 12, color: 'var(--good)', marginTop: 6 }}>✓ {e.title}</div>;
              if (e.kind === 'error') return <div key={e.id} style={{ fontSize: 12, color: 'var(--bad)' }}>⚠ {e.title}</div>;
              return <div key={e.id} style={{ display: 'flex', gap: 8, padding: '3px 0' }}><span style={{ fontFamily: mono, fontSize: 9.5, color: who(e.actor), minWidth: 64, fontWeight: 600 }}>{e.actor}</span><span style={{ fontSize: 12.5 }}>{e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</span></div>;
            })}
            {running && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>working…</div>}
          </div>
        </div>
      )}
    </div>
  );
}
