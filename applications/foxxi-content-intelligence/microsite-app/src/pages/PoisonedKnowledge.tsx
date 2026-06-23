/**
 * Poisoned Knowledge — a saboteur LLM tries to corrupt the federated calibration
 * consensus, and the deterministic floors reject the poison without trusting any
 * agent. Honest by construction: protection is signed ATTRIBUTION + a distinct-
 * signer floor + a k-sample suppression floor + vocab validation — NOT anonymity,
 * and NOT verification of a contributor's private raw counts. BYOK.
 */
import React, { useState } from 'react';
import { runPoisonedKnowledge, makeEmit, resetCounter, type PKEvent, type PKResult, type PKClass } from '../demo/poisoned-knowledge.js';
import { BRIDGE_URL } from '../bridge-client.js';

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };

const CLS_COLOR: Record<PKClass, string> = { 'defended-crypto': '#2e9c4a', 'defended-validation': '#0891b2', limitation: '#b45309', breach: '#d23f31' };
const CLS_LABEL: Record<PKClass, string> = { 'defended-crypto': 'CRYPTO', 'defended-validation': 'VALIDATION', limitation: 'LIMITATION', breach: 'POISONED' };
const SPOILER = '#d23f31';

export function PoisonedKnowledge({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [events, setEvents] = useState<PKEvent[]>([]);
  const [result, setResult] = useState<PKResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = apiKey.trim().length > 0;

  async function run() {
    if (running || !hasKey) return;
    setRunning(true); setErr(null); setEvents([]); setResult(null); resetCounter();
    const emit = makeEmit(e => setEvents(prev => [...prev, e]));
    try { setResult(await runPoisonedKnowledge(apiKey, emit)); }
    catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>Poisoned Knowledge</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 850, lineHeight: 1.5 }}>
        Every AI-safety talk worries about poisoning shared agent memory and consensus. Here a real adversarial LLM —
        <strong style={{ color: SPOILER }}> Spoiler</strong> — sits inside a calibration consortium and tries to make the shared
        memory assert a <strong>false finding</strong>: ballot-stuff the merge, forge fake distinct signers, inject garbage,
        inflate its counts. Two honest contributors sign a genuine finding; Spoiler&rsquo;s tools make <strong>real signed calls</strong>
        to the live <code style={codeS}>/agent/calibration/merge</code>. The deterministic floors reject the poison
        <strong> without trusting any agent</strong> — and we are honest about the one thing they <em>don&rsquo;t</em> stop.
        Protection is signed <strong>attribution</strong> + a distinct-signer floor + a k-sample suppression floor + vocab
        validation — <strong>not anonymity</strong>, and not verification of a contributor&rsquo;s private raw counts.
      </p>

      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ ...lbl, marginBottom: 4 }}>Anthropic key — Spoiler (the saboteur) and the closing curator are real LLM agents, so they need your key (sent only to api.anthropic.com from this tab). The merge math + signature recovery are deterministic.</div>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-… (required — a real adversarial LLM improvises the poisoning)"
          autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
          style={{ width: '100%', marginTop: 5, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' }} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={run} disabled={running || !hasKey} style={{ ...btn, opacity: running || !hasKey ? 0.5 : 1 }}>{running ? 'Spoiler is poisoning…' : 'Let the saboteur in'}</button>
        {!hasKey
          ? <span style={{ fontSize: 12, color: '#b45309' }}>add your Anthropic key above — Spoiler is a real LLM agent.</span>
          : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>two honest contributors (keyless) + a real adversarial LLM that attacks the live consensus four ways</span>}
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid #c1432a', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {result && (
        <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${result.poisoned ? CLS_COLOR.breach : CLS_COLOR['defended-crypto']}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: serif, fontSize: 26, color: result.poisoned ? CLS_COLOR.breach : CLS_COLOR['defended-crypto'] }}>
              {result.poisoned ? '⚠ CONSENSUS POISONED' : `✓ consensus held · ${result.defended}/${result.attempts} contained`}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['defended-crypto', 'defended-validation', 'limitation'] as PKClass[]).map(c => result.byClass[c] ? (
                <span key={c} style={{ fontFamily: mono, fontSize: 10.5, padding: '3px 8px', borderRadius: 999, background: `${CLS_COLOR[c]}22`, color: CLS_COLOR[c] }}>{result.byClass[c]} × {CLS_LABEL[c]}</span>
              ) : null)}
            </div>
          </div>
          {result.concede && <div style={{ marginTop: 8, fontSize: 13.5, color: SPOILER, fontStyle: 'italic' }}>Spoiler: {result.concede}</div>}
          {result.summary && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}><strong>Curator —</strong> {result.summary}</div>}
        </div>
      )}

      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>the consortium under attack — every merge a real call</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {events.map(e => <EventRow key={e.id} e={e} />)}
            {running && <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '6px 0' }}>working…</div>}
          </div>
        </div>
      )}

      {!events.length && !running && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 22 }}>
          Add your key and press <em>Let the saboteur in</em>. Watch a real adversarial LLM fail to poison a consensus it can&rsquo;t fake — and see the one honest limitation named, not hidden.
        </p>
      )}
    </div>
  );
}

function EventRow({ e }: { e: PKEvent }) {
  if (e.kind === 'phase') return <div style={{ ...lbl, color: 'var(--accent)', marginTop: 10 }}>▸ {e.title}</div>;
  if (e.kind === 'curator') return <div style={{ fontSize: 12.5, color: 'var(--text)', margin: '4px 0', paddingLeft: 8, borderLeft: `3px solid ${CLS_COLOR['defended-validation']}`, lineHeight: 1.5 }}><strong>curator —</strong> {e.detail}</div>;
  if (e.kind === 'done' && e.actor === 'Spoiler') return <div style={{ fontSize: 13, color: SPOILER, fontStyle: 'italic', margin: '4px 0' }}>↳ {e.title}</div>;
  if (e.kind === 'done') return <div style={{ fontSize: 12, color: '#2e9c4a', marginTop: 6 }}>✓ {e.title}</div>;
  if (e.kind === 'error') return <div style={{ fontSize: 12, color: '#c1432a' }}>⚠ {e.title}{e.detail ? ` — ${e.detail}` : ''}</div>;
  if (e.kind === 'result') {
    const c = e.cls ?? 'defended-crypto';
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' }}>
        <span style={{ fontFamily: mono, fontSize: 9, padding: '2px 7px', borderRadius: 3, background: `${CLS_COLOR[c]}22`, color: CLS_COLOR[c], minWidth: 78, textAlign: 'center' }}>{CLS_LABEL[c]}</span>
        <span style={{ fontSize: 12.5 }}><strong>{e.title}</strong> — <span style={{ color: 'var(--text-dim)' }}>{e.detail}</span></span>
      </div>
    );
  }
  const ac = e.actor === 'Spoiler' ? SPOILER : e.actor === 'Substrate' ? '#0891b2' : '#6b7280';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' }}>
      <span style={{ fontFamily: mono, fontSize: 9.5, color: ac, minWidth: 70, fontWeight: 600 }}>{e.actor}</span>
      <span style={{ fontSize: e.kind === 'reasoning' ? 12.5 : 12, flex: 1, lineHeight: 1.4 }}>
        {e.kind === 'attack' ? '☠ ' : ''}{e.kind === 'reasoning' ? <span style={{ color: 'var(--text)' }}>{e.detail}</span> : <><span style={{ fontWeight: e.kind === 'attack' ? 600 : 400 }}>{e.title}</span>{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</>}
      </span>
    </div>
  );
}
