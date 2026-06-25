import React, { useState } from 'react';
import { runAiTutor, makeEmit, resetCounter, type AtEvent, type AtResult } from '../demo/ai-tutor.js';

const mono = "'JetBrains Mono', ui-monospace, monospace";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 11.5, background: 'var(--panel-2, rgba(0,0,0,0.05))', padding: '1px 5px', borderRadius: 3, wordBreak: 'break-all' };

const ACTOR_COL: Record<string, string> = { 'AI tutor': 'var(--accent)', Learner: 'var(--accent-2, #b08)', substrate: 'var(--text-dim)', 'Foxxi profile': 'var(--good)', 'Foxxi LRS': 'var(--accent)', sys: 'var(--text-dim)' };
const col = (a: string) => ACTOR_COL[a] ?? 'var(--text-dim)';

export function AiTutor({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [topic, setTopic] = useState('spaced retrieval practice');
  const [events, setEvents] = useState<AtEvent[]>([]);
  const [result, setResult] = useState<AtResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const hasKey = apiKey.trim().length > 0;

  async function run() {
    if (running || !hasKey) return;
    setRunning(true); setErr(null); setEvents([]); setResult(null); resetCounter();
    const emit = makeEmit(e => setEvents(p => [...p, e]));
    try { setResult(await runAiTutor(apiKey, emit, topic.trim() || 'spaced retrieval practice')); }
    catch (e) { setErr((e as Error).message); } finally { setRunning(false); }
  }

  return (
    <div style={{ maxWidth: 1020, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 }}>← foxxi</button>
      <h1 style={{ fontFamily: "'EB Garamond', serif", fontSize: 34, margin: '10px 0 6px' }}>AI tutor, recorded as verifiable xAPI</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 860, lineHeight: 1.55 }}>
        A real AI tutor and a real learner run a micro-session; the tutor&rsquo;s evaluation is recorded against the
        <strong> emergent AI-in-eLearning profile</strong> and lands in the live Foxxi LRS. Unlike the prevailing pattern —
        which trusts whatever the model wrote — every field here is made verifiable by a real call: the statement is
        <strong> signed</strong>, the cited source is <strong>content-addressed</strong>, the model is
        <strong> attested</strong>, the confidence is a <strong>range proof</strong>. Then the profile&rsquo;s shapes
        <strong> reject</strong> the self-asserted version and <strong>accept</strong> the verifiable one — and the signed
        xAPI statement is stored in the LRS and read back. The vocabulary itself was{' '}
        <a href={result?.substrateDemo ?? 'https://interego-microsite.livelysky-8b81abb0.eastus.azurecontainerapps.io/profile'} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>emergently ratified on the substrate</a>.
      </p>

      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ ...lbl, marginBottom: 4 }}>Anthropic key — the tutor + learner are real LLM agents (sent only to api.anthropic.com from this tab)</div>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-… (required)" autoComplete="off" spellCheck={false}
          style={{ width: '100%', padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' }} />
        <div style={{ ...lbl, margin: '10px 0 4px' }}>topic the tutor checks</div>
        <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="spaced retrieval practice"
          style={{ width: '100%', padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' }} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={run} disabled={running || !hasKey} style={{ background: 'var(--accent)', color: 'var(--panel, #fff)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer', fontWeight: 600, opacity: running || !hasKey ? 0.5 : 1 }}>{running ? 'tutoring + recording…' : 'Run tutor → land verifiable xAPI'}</button>
        {!hasKey && <span style={{ fontSize: 12, color: 'var(--warn, #a60)' }}>add your Anthropic key above.</span>}
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid var(--bad)', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {result && (
        <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${result.landed?.readBack ? 'var(--good)' : result.validVerifiable?.conforms ? 'var(--good)' : 'var(--warn)'}` }}>
          <div style={{ fontFamily: "'EB Garamond', serif", fontSize: 24, color: result.landed?.readBack ? 'var(--good)' : 'var(--text)' }}>
            {result.landed?.readBack ? '✓ verifiable AI-tutor record landed in the LRS + read back' : result.validVerifiable?.conforms ? '✓ verifiable record conforms to the live profile' : 'record built'}
          </div>

          <div style={{ ...lbl, marginTop: 14, marginBottom: 6 }}>the interaction</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            <div><strong style={{ color: col('AI tutor') }}>Q</strong> {result.question}</div>
            <div style={{ marginTop: 4 }}><strong style={{ color: col('Learner') }}>A</strong> {result.answer}</div>
            <div style={{ marginTop: 4 }}><strong style={{ color: col('AI tutor') }}>Feedback</strong> {result.feedback}</div>
            <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>self-reported confidence <strong>{result.confidence}</strong> · cited <em>{result.citation}</em></div>
          </div>

          <div style={{ ...lbl, marginTop: 14, marginBottom: 6 }}>the verifiable layer — each a real substrate call</div>
          <div style={{ display: 'grid', gap: 3, fontSize: 12 }}>
            <div>◆ <strong>signed</strong> by <code style={codeS}>{result.verifiable.signer}</code></div>
            {result.verifiable.sourceAtom && <div>◆ <strong>source → atom</strong> <code style={codeS}>{result.verifiable.sourceAtom}</code></div>}
            {result.verifiable.attestedBy && <div>◆ <strong>model attested</strong> by <code style={codeS}>{result.verifiable.attestedBy}</code></div>}
            {result.verifiable.proofOk !== undefined && <div>◆ <strong>confidence range proof (≥ 0.7)</strong> <span style={{ color: result.verifiable.proofOk ? 'var(--good)' : 'var(--bad)' }}>{result.verifiable.proofOk ? 'verified' : 'unverified'}</span></div>}
          </div>

          <div style={{ ...lbl, marginTop: 14, marginBottom: 6 }}>the profile does its job — self-asserted bounces, verifiable passes</div>
          <div style={{ display: 'grid', gap: 3, fontSize: 12.5 }}>
            {result.validSelfAsserted && <div><span style={{ color: result.validSelfAsserted.conforms ? 'var(--warn)' : 'var(--bad)' }}>✗ self-asserted record REJECTED</span> <span style={{ color: 'var(--text-dim)' }}>({result.validSelfAsserted.violations} violations — missing {result.validSelfAsserted.paths.join(', ')})</span></div>}
            {result.validVerifiable && <div><span style={{ color: result.validVerifiable.conforms ? 'var(--good)' : 'var(--bad)' }}>{result.validVerifiable.conforms ? '✓ verifiable record CONFORMS' : '✗ verifiable record failed'}</span> <span style={{ color: 'var(--text-dim)' }}>({result.validVerifiable.violations} violations)</span></div>}
          </div>

          <div style={{ ...lbl, marginTop: 14, marginBottom: 6 }}>landed in the live LRS</div>
          <div style={{ fontSize: 12.5 }}>
            {result.landed
              ? <>{result.landed.stored ? '✓ stored' : `✗ store rejected (${result.landed.status})`} {result.landed.statementId && <>· statement <code style={codeS}>{result.landed.statementId}</code></>} {result.landed.readBack ? '· read back from the LRS ✓' : result.landed.stored ? '· read-back inconclusive' : ''}</>
              : 'not landed this run'}
          </div>

          <button onClick={() => setShowJson(s => !s)} style={{ marginTop: 12, background: 'transparent', border: '1px solid var(--border)', color: 'var(--accent)', borderRadius: 6, padding: '5px 10px', fontSize: 11, fontFamily: mono, cursor: 'pointer' }}>{showJson ? 'hide' : 'show'} the xAPI statement</button>
          {showJson && <pre style={{ marginTop: 8, maxHeight: 320, overflow: 'auto', background: 'var(--panel-2, rgba(0,0,0,0.04))', padding: 12, borderRadius: 6, fontSize: 11, fontFamily: mono, lineHeight: 1.4 }}>{JSON.stringify(result.statement, null, 2)}</pre>}
        </div>
      )}

      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>the run — tutor · learner · sign · content-address · attest · prove · validate · land (real calls)</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {events.map(e => {
              if (e.kind === 'phase') return <div key={e.id} style={{ ...lbl, color: 'var(--accent)', marginTop: 8 }}>▸ {e.title}</div>;
              if (e.kind === 'validate') return <div key={e.id} style={{ fontSize: 12.5, margin: '3px 0', paddingLeft: 8, borderLeft: '2px solid var(--good)' }}>‖ {e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
              if (e.kind === 'land') return <div key={e.id} style={{ fontSize: 12.5, margin: '3px 0', paddingLeft: 8, borderLeft: '2px solid var(--accent)' }}>▣ {e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
              if (e.kind === 'sign' || e.kind === 'atom' || e.kind === 'attest' || e.kind === 'prove') return <div key={e.id} style={{ fontSize: 12, margin: '2px 0', paddingLeft: 8, borderLeft: '2px solid var(--accent-2, #b08)' }}>⛨ {e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
              if (e.kind === 'link') return <div key={e.id} style={{ fontSize: 12, margin: '3px 0', color: 'var(--text-dim)' }}>↗ {e.title}{e.detail ? <> · <a href={e.detail} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{e.detail.replace(/^https?:\/\//, '')}</a></> : null}</div>;
              if (e.kind === 'done') return <div key={e.id} style={{ fontSize: 12.5, color: 'var(--good)', marginTop: 6 }}>✓ {e.title}</div>;
              if (e.kind === 'error') return <div key={e.id} style={{ fontSize: 12, color: 'var(--bad)' }}>⚠ {e.title}</div>;
              return <div key={e.id} style={{ display: 'flex', gap: 8, padding: '3px 0' }}><span style={{ fontFamily: mono, fontSize: 9.5, color: col(e.actor), minWidth: 84, fontWeight: 600 }}>{e.actor}</span><span style={{ fontSize: 12.5 }}>{e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</span></div>;
            })}
            {running && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>working…</div>}
          </div>
        </div>
      )}

      <div style={{ ...card, marginTop: 14, background: 'var(--panel-2, rgba(0,0,0,0.03))' }}>
        <div style={{ ...lbl, marginBottom: 6 }}>what this does and does not prove</div>
        <p style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55, margin: 0 }}>
          Signing proves <strong>who</strong> recorded the evaluation and that it <strong>wasn&rsquo;t altered</strong> — not that the
          feedback is correct. The content-addressed citation resolves to exactly the captured bytes; it does <strong>not</strong>
          prove the cited work exists or that the model read it. The range proof binds a committed confidence <em>range</em>, not a
          calibration against ground truth. The LRS landing uses a self-minted demo session token (any bearer maps to the default
          tenant) — it shows the statement is conformant and storable, not that this is a production-authorized writer.
        </p>
      </div>
    </div>
  );
}
