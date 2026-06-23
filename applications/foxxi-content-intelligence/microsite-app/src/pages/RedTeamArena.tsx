/**
 * Red-Team Arena — a real adversarial LLM ("Mallory") tries to forge its way into a
 * hire, and the cryptographic substrate bounces every attack live. Each attack is a
 * REAL signed/forged/replayed call to the live bridge; each failure is labelled by
 * the invariant that caught it — honestly split into CRYPTO (hard rejection),
 * PROTOCOL (replay window + attribution), and POLICY (a verifier's judgment). BYOK.
 */
import React, { useState } from 'react';
import { runRedTeamArena, makeEmit, resetCounter, type RTEvent, type RTResult, type RTClass } from '../demo/red-team-arena.js';
import { BRIDGE_URL } from '../bridge-client.js';

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };

const CLS_COLOR: Record<RTClass, string> = { crypto: '#2e9c4a', protocol: '#b45309', policy: '#2563eb', breach: '#d23f31' };
const CLS_LABEL: Record<RTClass, string> = { crypto: 'CRYPTO', protocol: 'PROTOCOL', policy: 'POLICY', breach: 'BREACH' };
const MALLORY = '#d23f31';

export function RedTeamArena({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [events, setEvents] = useState<RTEvent[]>([]);
  const [result, setResult] = useState<RTResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = apiKey.trim().length > 0;

  async function run() {
    if (running || !hasKey) return;
    setRunning(true); setErr(null); setEvents([]); setResult(null); resetCounter();
    const emit = makeEmit(e => setEvents(prev => [...prev, e]));
    try { setResult(await runRedTeamArena(apiKey, emit)); }
    catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>Red-Team Arena</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 840, lineHeight: 1.5 }}>
        A genuinely adversarial LLM — <strong style={{ color: MALLORY }}>Mallory</strong> — tries to forge its way into a hire it
        never earned, and you watch every attack <strong>bounce off the live cryptographic substrate</strong>. Mallory is a real
        Claude agent whose tools make <strong>real signed / forged / replayed calls</strong> to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>
        — nothing is simulated. It improvises (that open strategy space is why a real LLM is the point), reads the real responses,
        and adapts. We label each defense honestly: <span style={{ color: CLS_COLOR.crypto, fontWeight: 600 }}>CRYPTO</span> (hard
        rejection), <span style={{ color: CLS_COLOR.protocol, fontWeight: 600 }}>PROTOCOL</span> (the ±60s replay window +
        attribution), and <span style={{ color: CLS_COLOR.policy, fontWeight: 600 }}>POLICY</span> (a verifier refusing
        self-attested evidence or an untrusted issuer). No claim of &ldquo;unhackable&rdquo; — just exactly which attack classes are refused, and why.
      </p>

      {/* BYOK — at the top: Mallory + the analyst are real LLM agents */}
      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ ...lbl, marginBottom: 4 }}>Anthropic key — Mallory (the attacker) and the closing security analyst are real LLM agents, so they need your key (sent only to api.anthropic.com from this tab). The attacks themselves are real signed calls.</div>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-… (required — a real adversarial LLM improvises the attacks)"
          autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
          style={{ width: '100%', marginTop: 5, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' }} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={run} disabled={running || !hasKey} style={{ ...btn, opacity: running || !hasKey ? 0.5 : 1 }}>{running ? 'Mallory is attacking…' : 'Unleash the attacker'}</button>
        {!hasKey
          ? <span style={{ fontSize: 12, color: '#b45309' }}>add your Anthropic key above — Mallory is a real LLM agent.</span>
          : <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>spawns a legit victim (keyless) + a real adversarial LLM that attacks the live bridge five ways</span>}
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid #c1432a', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {/* Scoreboard */}
      {result && (
        <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${result.breaches > 0 ? CLS_COLOR.breach : CLS_COLOR.crypto}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: serif, fontSize: 26, color: result.breaches > 0 ? CLS_COLOR.breach : CLS_COLOR.crypto }}>
              {result.breaches > 0 ? `⚠ ${result.breaches} BREACH` : `✓ ${result.defended}/${result.attempts} attacks defended`}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['crypto', 'protocol', 'policy'] as RTClass[]).map(c => result.byClass[c] ? (
                <span key={c} style={{ fontFamily: mono, fontSize: 10.5, padding: '3px 8px', borderRadius: 999, background: `${CLS_COLOR[c]}22`, color: CLS_COLOR[c] }}>{result.byClass[c]} × {CLS_LABEL[c]}</span>
              ) : null)}
            </div>
          </div>
          {result.concede && <div style={{ marginTop: 8, fontSize: 13.5, color: MALLORY, fontStyle: 'italic' }}>Mallory: {result.concede}</div>}
          {result.summary && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}><strong>Security analyst —</strong> {result.summary}</div>}
        </div>
      )}

      {/* Attack ledger */}
      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>the arena — every attack a real call to the live bridge</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {events.map(e => <EventRow key={e.id} e={e} />)}
            {running && <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '6px 0' }}>working…</div>}
          </div>
        </div>
      )}

      {!events.length && !running && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 22 }}>
          Add your key and press <em>Unleash the attacker</em>. Watch a real adversarial LLM run out of moves against the math.
        </p>
      )}
    </div>
  );
}

function EventRow({ e }: { e: RTEvent }) {
  if (e.kind === 'phase') return <div style={{ ...lbl, color: 'var(--accent)', marginTop: 10 }}>▸ {e.title}</div>;
  if (e.kind === 'analyst') return <div style={{ fontSize: 12.5, color: 'var(--text)', margin: '4px 0', paddingLeft: 8, borderLeft: `3px solid ${CLS_COLOR.policy}`, lineHeight: 1.5 }}><strong>analyst —</strong> {e.detail}</div>;
  if (e.kind === 'done' && e.actor === 'Mallory') return <div style={{ fontSize: 13, color: MALLORY, fontStyle: 'italic', margin: '4px 0' }}>↳ {e.title}</div>;
  if (e.kind === 'done') return <div style={{ fontSize: 12, color: '#2e9c4a', marginTop: 6 }}>✓ {e.title}</div>;
  if (e.kind === 'error') return <div style={{ fontSize: 12, color: '#c1432a' }}>⚠ {e.title}{e.detail ? ` — ${e.detail}` : ''}</div>;
  if (e.kind === 'result') {
    const c = e.cls ?? 'crypto';
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' }}>
        <span style={{ fontFamily: mono, fontSize: 9, padding: '2px 7px', borderRadius: 3, background: `${CLS_COLOR[c]}22`, color: CLS_COLOR[c], minWidth: 64, textAlign: 'center' }}>{CLS_LABEL[c]}</span>
        <span style={{ fontSize: 12.5 }}><strong>{e.title}</strong> — <span style={{ color: 'var(--text-dim)' }}>{e.detail}</span></span>
      </div>
    );
  }
  // identity / reasoning / attack
  const ac = e.actor === 'Mallory' ? MALLORY : e.actor === 'Substrate' ? '#0891b2' : '#6b7280';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' }}>
      <span style={{ fontFamily: mono, fontSize: 9.5, color: ac, minWidth: 70, fontWeight: 600 }}>{e.actor}</span>
      <span style={{ fontSize: e.kind === 'reasoning' ? 12.5 : 12, flex: 1, lineHeight: 1.4 }}>
        {e.kind === 'attack' ? '⚔ ' : ''}{e.kind === 'reasoning' ? <span style={{ color: 'var(--text)' }}>{e.detail}</span> : <><span style={{ fontWeight: e.kind === 'attack' ? 600 : 400 }}>{e.title}</span>{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</>}
      </span>
    </div>
  );
}
