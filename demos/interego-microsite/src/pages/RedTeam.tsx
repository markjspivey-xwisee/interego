import React, { useState } from 'react';
import { runRedTeam, makeEmit, resetCounter, type RTEvent, type RTResult, type RTClass } from '../demo/red-team.js';
import { BRIDGE_URL } from '../lib/bridge.js';
import { card, lbl, codeS, btn, mono, serif } from '../styles.js';
import { KeyCard, Back } from '../components.js';

const CLS_COLOR: Record<RTClass, string> = { crypto: 'var(--good)', protocol: 'var(--warn)', breach: 'var(--bad)' };
const CLS_LABEL: Record<RTClass, string> = { crypto: 'CRYPTO', protocol: 'PROTOCOL', breach: 'BREACH' };
const MALLORY = 'var(--bad)';

export function RedTeam({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [events, setEvents] = useState<RTEvent[]>([]);
  const [result, setResult] = useState<RTResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = apiKey.trim().length > 0;

  async function run() {
    if (running || !hasKey) return;
    setRunning(true); setErr(null); setEvents([]); setResult(null); resetCounter();
    const emit = makeEmit(e => setEvents(p => [...p, e]));
    try { setResult(await runRedTeam(apiKey, emit)); } catch (e) { setErr((e as Error).message); } finally { setRunning(false); }
  }

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '28px 24px 80px' }}>
      <Back onHome={onHome} />
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>Red-Team Arena</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 840, lineHeight: 1.5 }}>
        A real adversarial LLM — <strong style={{ color: MALLORY }}>Mallory</strong> — throws <strong>forged / tampered / replayed</strong>
        envelopes at the substrate&rsquo;s L1 integrity primitive <code style={codeS}>protocol.attest</code>, and each bounces off a
        different invariant: <span style={{ color: CLS_COLOR.crypto, fontWeight: 600 }}>CRYPTO</span> (signer recovery + content-bound
        signatures) and <span style={{ color: CLS_COLOR.protocol, fontWeight: 600 }}>PROTOCOL</span> (the ±60s replay window). Every
        attack is a real call to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code> — nothing simulated. No claim of
        &ldquo;unhackable&rdquo;: exactly the three substrate-level (L1) attack classes are refused; a verbatim replay within the
        window is accepted but stays attributed to the original signer.
      </p>
      <KeyCard apiKey={apiKey} setKey={setApiKey} note="Mallory (the attacker) is a real LLM agent" />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={run} disabled={running || !hasKey} style={{ ...btn, opacity: running || !hasKey ? 0.5 : 1 }}>{running ? 'Mallory is attacking…' : 'Unleash the attacker'}</button>
        {!hasKey && <span style={{ fontSize: 12, color: 'var(--warn)' }}>add your Anthropic key above — Mallory is a real LLM agent.</span>}
      </div>
      {err && <div style={{ ...card, borderLeft: '3px solid var(--bad)', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}
      {result && (
        <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${result.breaches > 0 ? CLS_COLOR.breach : CLS_COLOR.crypto}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: serif, fontSize: 26, color: result.breaches > 0 ? CLS_COLOR.breach : CLS_COLOR.crypto }}>{result.breaches > 0 ? `⚠ ${result.breaches} BREACH` : `✓ ${result.defended}/${result.attempts} attacks defended`}</div>
            <div style={{ display: 'flex', gap: 6 }}>{(['crypto', 'protocol'] as RTClass[]).map(c => result.byClass[c] ? <span key={c} style={{ fontFamily: mono, fontSize: 10.5, padding: '3px 8px', borderRadius: 999, background: 'var(--panel-2)', color: CLS_COLOR[c] }}>{result.byClass[c]} × {CLS_LABEL[c]}</span> : null)}</div>
          </div>
          {result.concede && <div style={{ marginTop: 8, fontSize: 13.5, color: MALLORY, fontStyle: 'italic' }}>Mallory: {result.concede}</div>}
        </div>
      )}
      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>the arena — every attack a real call to protocol.attest</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {events.map(e => {
              if (e.kind === 'phase') return <div key={e.id} style={{ ...lbl, color: 'var(--accent)', marginTop: 8 }}>▸ {e.title}</div>;
              if (e.kind === 'done' && e.actor === 'Mallory') return <div key={e.id} style={{ fontSize: 13, color: MALLORY, fontStyle: 'italic', margin: '4px 0' }}>↳ {e.title}</div>;
              if (e.kind === 'done') return <div key={e.id} style={{ fontSize: 12, color: 'var(--good)', marginTop: 6 }}>✓ {e.title}</div>;
              if (e.kind === 'error') return <div key={e.id} style={{ fontSize: 12, color: 'var(--bad)' }}>⚠ {e.title}</div>;
              if (e.kind === 'result') { const c = e.cls ?? 'crypto'; return <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' }}><span style={{ fontFamily: mono, fontSize: 9, padding: '2px 7px', borderRadius: 3, background: 'var(--panel-2)', color: CLS_COLOR[c], minWidth: 64, textAlign: 'center' }}>{CLS_LABEL[c]}</span><span style={{ fontSize: 12.5 }}><strong>{e.title}</strong> — <span style={{ color: 'var(--text-dim)' }}>{e.detail}</span></span></div>; }
              const ac = e.actor === 'Mallory' ? MALLORY : e.actor === 'Substrate' ? 'var(--accent)' : 'var(--text-dim)';
              return <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' }}><span style={{ fontFamily: mono, fontSize: 9.5, color: ac, minWidth: 70, fontWeight: 600 }}>{e.actor}</span><span style={{ fontSize: e.kind === 'reasoning' ? 12.5 : 12, flex: 1, lineHeight: 1.4 }}>{e.kind === 'attack' ? '⚔ ' : ''}{e.kind === 'reasoning' ? <span style={{ color: 'var(--text)' }}>{e.detail}</span> : <span style={{ fontWeight: e.kind === 'attack' ? 600 : 400 }}>{e.title}</span>}</span></div>;
            })}
            {running && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>working…</div>}
          </div>
        </div>
      )}
    </div>
  );
}
