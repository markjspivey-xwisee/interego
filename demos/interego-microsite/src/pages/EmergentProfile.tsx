import React, { useState } from 'react';
import {
  runEmergentProfile, runDivergenceControl, runDissensusControl,
  makeEmit, resetCounter, type EpEvent, type EpResult, type EpControls,
} from '../demo/emergent-profile.js';
import { BRIDGE_URL } from '../lib/bridge.js';
import { card, lbl, codeS, btn, mono, serif } from '../styles.js';
import { KeyCard, Back } from '../components.js';

const ACTOR_COL: Record<string, string> = {
  Auditor: 'var(--accent)', Integrator: 'var(--accent-2)',
  'Learner-Custodian': 'var(--good)', 'Standards-Steward': 'var(--warn)',
  Gateway: 'var(--accent-2)', consortium: 'var(--accent)', sys: 'var(--text-dim)',
};
const col = (a: string) => ACTOR_COL[a] ?? 'var(--text-dim)';

// One activity-log line, shared by the main-run log and the controls log.
function renderEvent(e: EpEvent): React.ReactNode {
  if (e.kind === 'phase' || e.kind === 'control') return <div key={e.id} style={{ ...lbl, color: e.kind === 'control' ? 'var(--warn)' : 'var(--accent)', marginTop: 8 }}>▸ {e.title}</div>;
  if (e.kind === 'measure' || e.kind === 'fuse') return <div key={e.id} style={{ fontSize: 12.5, margin: '4px 0', paddingLeft: 8, borderLeft: `2px solid ${e.kind === 'fuse' ? 'var(--good)' : 'var(--accent)'}` }}>◆ {e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
  if (e.kind === 'tally' || e.kind === 'ratify' || e.kind === 'fork') return <div key={e.id} style={{ fontSize: 13, margin: '4px 0', color: e.kind === 'fork' ? 'var(--warn)' : 'var(--text)' }}>‖ {e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
  if (e.kind === 'attest' || e.kind === 'prove') return <div key={e.id} style={{ fontSize: 12.5, margin: '3px 0', paddingLeft: 8, borderLeft: '2px solid var(--accent-2)' }}>⛨ {e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
  if (e.kind === 'calibrate' || e.kind === 'land') return <div key={e.id} style={{ fontSize: 12, margin: '3px 0', color: 'var(--text-dim)' }}>↗ {e.title}{e.detail ? <> · <a href={e.detail} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{e.detail.replace(/^https?:\/\//, '')}</a></> : null}</div>;
  if (e.kind === 'done') return <div key={e.id} style={{ fontSize: 12.5, color: 'var(--good)', marginTop: 6 }}>✓ {e.title}</div>;
  if (e.kind === 'error') return <div key={e.id} style={{ fontSize: 12, color: 'var(--bad)' }}>⚠ {e.title}</div>;
  return <div key={e.id} style={{ display: 'flex', gap: 8, padding: '3px 0' }}><span style={{ fontFamily: mono, fontSize: 9.5, color: col(e.actor), minWidth: 92, fontWeight: 600 }}>{e.actor}</span><span style={{ fontSize: 12.5 }}>{e.title}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</span></div>;
}

// The contrast: the prevailing vendor pattern (self-asserted fields) vs. what this run produces.
const CONTRAST: Array<{ field: string; vendor: string; here: string }> = [
  { field: 'the record itself', vendor: 'an LRS statement anyone can write — "claude said X" is unsigned', here: 'a signed rev-196 envelope — altering it breaks the signature; backdating is detectable' },
  { field: 'sources', vendor: 'a free-text array of source strings', here: 'each citation content-addressed to a urn:pgsl:atom — resolves to exactly the captured bytes' },
  { field: 'model / provider', vendor: 'free text ("gpt-4.1", "Anthropic")', here: 'a signed attestation — the gateway attests what it called, attributable to its DID' },
  { field: 'confidence', vendor: 'a bare self-reported number the spec simply trusts', here: 'a committed range proof (≥ threshold) — Pedersen + per-bit OR-proofs; proves it clears the bar revealing neither the value nor the gap' },
  { field: 'the vocabulary', vendor: 'one vendor publishes a doc; it changes on a release cycle', here: 'terms enter by independent atom-fusion + a distinct-signer vote; dissent can fork' },
  { field: 'custody', vendor: 'statements pool in a central LRS', here: "the learner's pod holds the record; the LRS is a reader (Foxxi vertical)" },
];

export function EmergentProfile({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [events, setEvents] = useState<EpEvent[]>([]);
  const [controlEvents, setControlEvents] = useState<EpEvent[]>([]);
  const [result, setResult] = useState<EpResult | null>(null);
  const [controls, setControls] = useState<EpControls>({});
  const [running, setRunning] = useState<null | 'main' | 'controls'>(null);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = apiKey.trim().length > 0;

  // The main run and the controls keep SEPARATE result + activity panels, so running
  // one never wipes the other — both stay visible side by side once produced.
  async function runMain() {
    if (running || !hasKey) return;
    setRunning('main'); setErr(null); setResult(null); setEvents([]); resetCounter();
    const emit = makeEmit(e => setEvents(p => [...p, e]));
    try { setResult(await runEmergentProfile(apiKey, emit)); }
    catch (e) { setErr((e as Error).message); } finally { setRunning(null); }
  }
  async function runControls() {
    if (running || !hasKey) return;
    setRunning('controls'); setErr(null); setControls({}); setControlEvents([]); resetCounter();
    const emit = makeEmit(e => setControlEvents(p => [...p, e]));
    try {
      const divergence = await runDivergenceControl(apiKey, emit);
      const dissensus = await runDissensusControl(apiKey, emit);
      setControls({ divergence, dissensus });
    } catch (e) { setErr((e as Error).message); } finally { setRunning(null); }
  }

  const host = BRIDGE_URL.replace(/^https?:\/\//, '');

  return (
    <div style={{ maxWidth: 1060, margin: '0 auto', padding: '28px 24px 80px' }}>
      <Back onHome={onHome} />
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>Profile</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 880, lineHeight: 1.55 }}>
        The prevailing way to make AI-in-eLearning &ldquo;accountable&rdquo; is for a vendor to publish an xAPI
        profile — a confidence number, source strings, a model name, an audit trail — whose fields the spec simply
        <strong> trusts whatever the model wrote</strong>. Here a cast of self-sovereign LLM agents build a
        <strong> competing</strong> vocabulary where a term is admitted only when two agents
        <strong> independently mint byte-identical atoms</strong> (a sha256 they can&rsquo;t fake) <em>and</em> it crosses a
        <strong> distinct-signer governance vote</strong> whose signatures bind the quorum to that exact term set — then each
        field is upgraded by a <strong>real substrate call</strong>: a source becomes a content-addressed atom, the
        model becomes a signed attestation, the confidence becomes a committed range proof. Pure substrate
        (<code style={codeS}>{host}</code>); landing it as xAPI happens on the Foxxi vertical.
      </p>
      <KeyCard apiKey={apiKey} setKey={setApiKey} note="every coiner, negotiator and voter is a real LLM agent" />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={runMain} disabled={!!running || !hasKey} style={{ ...btn, opacity: running || !hasKey ? 0.5 : 1 }}>{running === 'main' ? 'agents building the profile…' : 'Coin · converge · ratify'}</button>
        <button onClick={runControls} disabled={!!running || !hasKey} style={{ ...btn, background: 'transparent', color: 'var(--accent)', border: '1px solid var(--border)', opacity: running || !hasKey ? 0.5 : 1 }}>{running === 'controls' ? 'running controls…' : 'Run negative controls'}</button>
        {!hasKey && <span style={{ fontSize: 12, color: 'var(--warn)' }}>add your Anthropic key above — real LLM agents drive this.</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', maxWidth: 880, lineHeight: 1.5 }}>
        The controls make &ldquo;this is emergence, not a script&rdquo; falsifiable: <strong>divergence</strong> (agents keep
        different terms → the gate refuses to admit) and <strong>dissensus</strong> (an over-reaching proposal put to a real
        quorum → it can fail and fork). The surviving profile is the intersection of what <em>fused</em> and what the
        <em> signed quorum</em> ratified — neither is author-chosen, so a different key set or stance mix yields a different result.
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid var(--bad)', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {result && (
        <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${result.ratified ? 'var(--good)' : 'var(--warn)'}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: serif, fontSize: 26, color: result.ratified ? 'var(--good)' : 'var(--warn)' }}>
              {result.ratified ? `✓ profile ratified — ${result.candidateAtoms.length} content-addressed terms` : `✗ ${result.status} — not ratified`}
            </div>
            {result.tally && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{result.tally.for} for · {result.tally.against} against · {result.tally.abstain} abstain · {result.tally.distinctVoters} distinct signers</div>}
          </div>
          {result.holon && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>ratified holon: <code style={{ ...codeS, fontSize: 10.5 }}>{result.holon}</code></div>}

          {/* the emergent term set */}
          <div style={{ ...lbl, marginTop: 14, marginBottom: 6 }}>the emergent vocabulary — admitted only if fused AND ratified</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {result.terms.map(t => (
              <div key={t.gap} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12.5, padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontFamily: mono, fontSize: 10, minWidth: 80, color: 'var(--text-dim)' }}>{t.gap}</span>
                <span style={{ flex: 1 }}>
                  <span style={{ color: col('Auditor') }}>“{t.wordA}”</span> + <span style={{ color: col('Integrator') }}>“{t.wordB}”</span> →{' '}
                  <strong>{t.fused ? `“${t.agreed}”` : 'no fusion'}</strong>
                  <span style={{ color: 'var(--text-dim)' }}> · {t.sharedBefore}→{t.sharedAfter} shared</span>
                </span>
                <span style={{ fontFamily: mono, fontSize: 10, color: t.inProfile ? 'var(--good)' : 'var(--text-dim)' }}>{t.inProfile ? '● in profile' : '○ excluded'}</span>
              </div>
            ))}
          </div>

          {/* the verifiable upgrades */}
          <div style={{ ...lbl, marginTop: 14, marginBottom: 6 }}>the upgrades — each a real substrate call this run</div>
          <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            {result.upgrades.sourceAtom && <div>◆ <strong>source → atom</strong> <span style={{ color: 'var(--text-dim)' }}>· {result.upgrades.sourceAtom}</span></div>}
            {result.upgrades.attestedBy && <div>◆ <strong>model/provider → signed attestation</strong> <span style={{ color: 'var(--text-dim)' }}>· {result.upgrades.attestedBy}</span></div>}
            {result.upgrades.confidenceProof && <div>◆ <strong>confidence → committed range proof (≥ {result.upgrades.confidenceProof.threshold}, Pedersen gap-hiding)</strong> <span style={{ color: result.upgrades.confidenceProof.ok ? 'var(--good)' : 'var(--bad)' }}>· {result.upgrades.confidenceProof.ok ? 'verified' : 'unverified'}</span></div>}
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>the run — coin · measure · negotiate · fuse · sign · ratify · upgrade (real substrate calls)</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {events.map(renderEvent)}
            {running === 'main' && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>working…</div>}
          </div>
        </div>
      )}

      {(controls.divergence || controls.dissensus) && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 6 }}>negative controls — outcomes that CAN fail (that&rsquo;s the point)</div>
          {controls.divergence && <div style={{ fontSize: 13, margin: '4px 0' }}>divergence: {controls.divergence.sharedBefore}→{controls.divergence.sharedAfter} shared — <strong style={{ color: controls.divergence.heldFlat ? 'var(--good)' : 'var(--warn)' }}>{controls.divergence.heldFlat ? 'gate held; term not admitted' : 'terms coincided (same bytes → same atom)'}</strong></div>}
          {controls.dissensus && <div style={{ fontSize: 13, margin: '4px 0' }}>dissensus: status <strong>{controls.dissensus.status}</strong> — <strong style={{ color: controls.dissensus.forked ? 'var(--good)' : 'var(--warn)' }}>{controls.dissensus.forked ? 'over-reach rejected / forked' : 'ratified (a real outcome)'}</strong></div>}
        </div>
      )}

      {controlEvents.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>the controls — divergence (gate must refuse) · dissensus (over-reach put to a real quorum)</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {controlEvents.map(renderEvent)}
            {running === 'controls' && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>working…</div>}
          </div>
        </div>
      )}

      {/* the contrast — vendor self-asserted vs this run */}
      <div style={{ ...card, marginTop: 14 }}>
        <div style={{ ...lbl, marginBottom: 8 }}>self-asserted (the prevailing pattern) → verifiable (this run)</div>
        <div style={{ display: 'grid', gap: 0 }}>
          {CONTRAST.map((c, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr', gap: 10, fontSize: 12.5, padding: '7px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <span style={{ fontFamily: mono, fontSize: 10.5, color: 'var(--text-dim)' }}>{c.field}</span>
              <span style={{ color: 'var(--text-dim)' }}>{c.vendor}</span>
              <span><span style={{ color: 'var(--good)' }}>→ </span>{c.here}</span>
            </div>
          ))}
        </div>
      </div>

      {/* honest ceiling — regime-honest, house style */}
      <div style={{ ...card, marginTop: 14, background: 'var(--panel-2)' }}>
        <div style={{ ...lbl, marginBottom: 6 }}>what this does and does not prove</div>
        <p style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55, margin: 0 }}>
          Signing proves <strong>who</strong> said it and that it <strong>wasn&rsquo;t altered</strong> — not that it&rsquo;s true.
          A content-addressed citation resolves to exactly the captured bytes; it does <strong>not</strong> verify the cited work
          exists or that the model read it (a hallucinated string content-addresses fine). The committed range proof (Pedersen +
          per-bit OR-proofs) shows the confidence cleared the bar while hiding both the value and the gap — but it is still
          <strong>not</strong> a calibration of the number against ground truth (a confidently-wrong answer still proves).
          The efficacy evidence on the Foxxi vertical is signed self-report aggregated across <strong>distinct keys</strong>, not
          measured accuracy, and distinct keys are not proof of independent rival organizations. The holon is content-addressed and
          tamper-evident, recording that these recovered signers cast these votes — it is not collectively signed by the panel.
          Pods and shared governance are built; their value depends on adoption.
        </p>
      </div>
    </div>
  );
}
