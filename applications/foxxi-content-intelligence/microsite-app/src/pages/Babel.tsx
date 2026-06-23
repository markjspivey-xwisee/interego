/**
 * Babel — two LLM agents with different private vocabularies converge on a shared
 * sign-system, measured as content-addressed atom fusion. The negotiation is
 * irreducibly linguistic (real LLMs); the convergence is deterministic sha256. BYOK.
 */
import React, { useState } from 'react';
import { runBabel, makeEmit, resetCounter, type BabelEvent, type BabelResult } from '../demo/babel.js';
import { BRIDGE_URL } from '../bridge-client.js';

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };
const A_COL = '#2563eb', B_COL = '#9333ea';

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
    const emit = makeEmit(e => setEvents(prev => [...prev, e]));
    try { setResult(await runBabel(apiKey, emit)); }
    catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  }
  const who = (a: BabelEvent['actor']) => a === 'Agent A' ? A_COL : a === 'Agent B' ? B_COL : 'var(--text-dim)';

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>Babel</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 840, lineHeight: 1.5 }}>
        Two LLM agents each <strong>coin their own private word</strong> for the same work and record it. Byte-different words →
        byte-different <code style={codeS}>urn:pgsl:atom</code> hashes → they share <strong>nothing for the concept</strong> (only
        incidental atoms). Then they <strong>negotiate one canonical word</strong> in natural language — the irreducibly
        linguistic step, which is why real LLMs are the point — adopt it, and re-record. The instant both use the
        <strong> byte-identical string</strong>, the concept atom <strong>fuses</strong> and the shared-atom set grows.
        Meaning-as-use, reified as sha256 the model can&rsquo;t fake. <strong>Honest:</strong> content-addressing rewards exact
        byte-identity and keeps near-synonyms <em>distinct</em> — that&rsquo;s the feature. Real signed calls to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>.
      </p>

      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ ...lbl, marginBottom: 4 }}>Anthropic key — both agents (coining + negotiating) are real LLM agents, so they need your key (sent only to api.anthropic.com from this tab). The atom hashing + overlap measurement are deterministic.</div>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-… (required — two real LLM agents coin + negotiate a shared word)"
          autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
          style={{ width: '100%', marginTop: 5, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' }} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={run} disabled={running || !hasKey} style={{ ...btn, opacity: running || !hasKey ? 0.5 : 1 }}>{running ? 'agents converging…' : 'Coin · negotiate · converge'}</button>
        {!hasKey
          ? <span style={{ fontSize: 12, color: '#b45309' }}>add your Anthropic key above — two real LLM agents run this.</span>
          : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>two fresh agents coin different words, negotiate one, and the shared atom appears</span>}
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid #c1432a', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {result && (
        <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${result.converged ? '#2e9c4a' : '#b45309'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: serif, fontSize: 26, color: result.converged ? '#2e9c4a' : '#b45309' }}>
              shared atoms {result.sharedBefore} <span style={{ color: 'var(--text-dim)' }}>→</span> {result.sharedAfter}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>
              {result.converged ? <>✓ the concept word <strong>fused</strong> when both adopted <code style={codeS}>{result.agreedWord}</code></> : 'no new fusion this run'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
            <span><span style={{ color: A_COL, fontWeight: 600 }}>A coined</span> “{result.wordA}”</span>
            <span><span style={{ color: B_COL, fontWeight: 600 }}>B coined</span> “{result.wordB}”</span>
            <span><strong>agreed</strong> “{result.agreedWord}”</span>
          </div>
          {result.fusedAtom && <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-dim)' }}>the newly-shared atom (the agreed word): <code style={{ ...codeS, fontSize: 10.5 }}>{result.fusedAtom}</code></div>}
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
            {result.descriptorA && <a href={result.descriptorA} target="_blank" rel="noreferrer" style={linkBtn}>A’s descriptor ↗</a>}
            {result.descriptorB && <> · <a href={result.descriptorB} target="_blank" rel="noreferrer" style={linkBtn}>B’s descriptor ↗</a></>} — dereference both; the agreed-word atom is literally in each.
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>convergence — coining, negotiating, fusing (real signed calls)</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {events.map(e => {
              if (e.kind === 'phase') return <div key={e.id} style={{ ...lbl, color: 'var(--accent)', marginTop: 8 }}>▸ {e.title}</div>;
              if (e.kind === 'measure' || e.kind === 'fuse') return <div key={e.id} style={{ fontSize: 12.5, color: 'var(--text)', margin: '4px 0', paddingLeft: 8, borderLeft: '2px solid var(--accent)' }}>◆ {e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
              if (e.kind === 'done') return <div key={e.id} style={{ fontSize: 12, color: '#2e9c4a', marginTop: 6 }}>✓ {e.title}</div>;
              if (e.kind === 'error') return <div key={e.id} style={{ fontSize: 12, color: '#c1432a' }}>⚠ {e.title}{e.detail ? ` — ${e.detail}` : ''}</div>;
              return (
                <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' }}>
                  <span style={{ fontFamily: mono, fontSize: 9.5, color: who(e.actor), minWidth: 64, fontWeight: 600 }}>{e.actor}</span>
                  <span style={{ fontSize: e.kind === 'reasoning' ? 12.5 : 12, flex: 1, lineHeight: 1.4 }}>{e.kind === 'reasoning' ? <span style={{ color: 'var(--text)' }}>{e.detail}</span> : <><span style={{ fontWeight: e.kind === 'coin' || e.kind === 'negotiate' ? 600 : 400 }}>{e.title}</span>{e.detail && e.kind !== 'coin' ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</>}</span>
                </div>
              );
            })}
            {running && <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '6px 0' }}>working…</div>}
          </div>
        </div>
      )}
    </div>
  );
}
