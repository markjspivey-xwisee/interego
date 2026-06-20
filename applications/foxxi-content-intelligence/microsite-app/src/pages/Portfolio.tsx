/**
 * Portfolio — "an agent walks into a new job."
 *
 * A FRESH employer-agent with no prior relationship to a candidate takes a job
 * spec, reads the candidate's OWN pod (no admin token), independently re-runs
 * verification, the candidate proves the required competency via BBS+ (score
 * hidden), the employer verifies the proof, a deterministic decision function
 * matches it against the spec, and the employer records the decision back onto
 * the substrate. A reference check the reference cannot fake — decided on math.
 *
 * Every step is a REAL rev-196 signed call to the live Foxxi bridge — NO API key
 * needed (the candidate's track record is built by a scripted authority, not an
 * LLM). Composes /agent/scorm/*, /agent/record-performance, /agent/verify-
 * extension, /agent/review-record, /agent/prove-competency + /agent/verify-
 * presentation — the same affordances the BYOK agent demo emerges.
 */
import React, { useState } from 'react';
import {
  buildCredentialedCandidate, evaluateCandidate, makeEmit, resetCounter,
  type CeremonyEvent, type JobSpec, type Proficiency, type Candidate, type Evaluation, PROFICIENCY_ORDER,
} from '../demo/ceremonies.js';
import { VerificationMatrix, SelectiveDisclosure } from '../components/proof.js';
import { BRIDGE_URL } from '../bridge-client.js';

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '5px 13px', fontSize: 12, cursor: 'pointer', background: 'transparent' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };

const ACTOR_COLOR: Record<string, string> = { 'Training authority': '#0891b2', Candidate: '#7c3aed', Employer: '#db2777' };
const KIND_COLOR: Record<string, string> = { identity: '#6b7280', phase: 'var(--accent)', call: '#2563eb', result: '#059669', verify: '#d97706', credential: '#db2777', disclosure: '#7c3aed', decision: '#111', evidence: '#2e9c4a', error: '#dc2626' };

export function Portfolio({ onHome }: { onHome: () => void }) {
  const [spec, setSpec] = useState<JobSpec>({ role: 'Standards Integration Engineer', requiredCompetency: 'Standards Extension', minProficiency: 'Advanced', tamperEvidentRequired: true });
  const [events, setEvents] = useState<CeremonyEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [evalRes, setEvalRes] = useState<Evaluation | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (running) return;
    setRunning(true); setErr(null); setEvents([]); setCandidate(null); setEvalRes(null);
    resetCounter();
    const emit = makeEmit(e => setEvents(prev => [...prev, e]));
    try {
      const cand = await buildCredentialedCandidate(emit);
      setCandidate(cand);
      const ev = await evaluateCandidate(emit, cand, spec);
      setEvalRes(ev);
    } catch (e) {
      setErr((e as Error).message);
      emit({ actor: 'Employer', kind: 'error', title: 'run halted', detail: (e as Error).message });
    } finally { setRunning(false); }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>An agent walks into a new job</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 820, lineHeight: 1.5 }}>
        A <strong>fresh employer agent</strong> — no prior relationship to the candidate — reads the candidate&rsquo;s
        <strong> own pod</strong> with no admin token, <strong>independently re-runs the verification</strong> (engine-graded,
        tamper-evident), asks the candidate to prove the required competency via a <strong>BBS+ selective-disclosure proof</strong>
        (revealing proficiency, hiding the score), and a deterministic decision function matches it against the job spec.
        A reference check decided on the candidate&rsquo;s <strong>own verifiable, tamper-evident records — not its say-so</strong>.
        Every step is a real signed call to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>. <strong>No API key needed.</strong>
      </p>

      {/* Job spec */}
      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ ...lbl, marginBottom: 8 }}>the job spec — what this role requires</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, alignItems: 'end' }}>
          <Field label="Role">
            <input value={spec.role} disabled={running} onChange={e => setSpec(s => ({ ...s, role: e.target.value }))} style={inp} />
          </Field>
          <Field label="Required competency">
            <input value={spec.requiredCompetency} disabled={running} onChange={e => setSpec(s => ({ ...s, requiredCompetency: e.target.value }))} style={inp} />
          </Field>
          <Field label="Min proficiency">
            <select value={spec.minProficiency} disabled={running} onChange={e => setSpec(s => ({ ...s, minProficiency: e.target.value as Proficiency }))} style={inp}>
              {PROFICIENCY_ORDER.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Evidence must be tamper-evident">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, height: 38 }}>
              <input type="checkbox" checked={spec.tamperEvidentRequired} disabled={running} onChange={e => setSpec(s => ({ ...s, tamperEvidentRequired: e.target.checked }))} />
              {spec.tamperEvidentRequired ? 'engine-graded evidence required' : 'self-attested accepted'}
            </label>
          </Field>
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={run} disabled={running} style={{ ...btn, opacity: running ? 0.5 : 1 }}>{running ? 'Hiring…' : 'Run the hiring'}</button>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>spawns 3 fresh wallets (a training authority, a candidate, an employer) and drives the full arc live</span>
        </div>
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid #c1432a', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {/* The decision — hero */}
      {evalRes && <DecisionCard ev={evalRes} spec={spec} candidate={candidate} />}

      {/* Proof panels */}
      {evalRes && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
          <div style={card}><VerificationMatrix d={evalRes.verify} /></div>
          <div style={card}>
            {evalRes.revealed.length > 0
              ? <SelectiveDisclosure revealed={evalRes.revealed} hidden={evalRes.hiddenPaths} />
              : <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>BBS+ proof unavailable on this deployment.</div>}
          </div>
        </div>
      )}

      {/* The arc */}
      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>the arc — every step a real signed call</div>
          <div style={{ display: 'grid', gap: 2 }}>
            {events.map(e => <EventRow key={e.id} e={e} />)}
            {running && <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '6px 0' }}>working…</div>}
          </div>
        </div>
      )}

      {!events.length && !running && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 22 }}>
          Set the job spec and press <em>Run the hiring</em>. Watch a fresh employer decide whether to trust a stranger&rsquo;s agent — using only what it can independently verify.
        </p>
      )}
    </div>
  );
}

function DecisionCard({ ev, spec, candidate }: { ev: Evaluation; spec: JobSpec; candidate: Candidate | null }) {
  const v = ev.decision.verdict;
  const accept = v === 'ACCEPT';
  const tone = accept ? '#2e9c4a' : v === 'UNDECIDABLE' ? '#b45309' : '#d23f31';
  const head = accept ? '✓ ACCEPT' : v === 'UNDECIDABLE' ? '⊘ UNDECIDABLE' : '✗ REJECT';
  const m = ev.decision.matched;
  const rows = [
    { k: 'proofValid', label: 'BBS+ selective-disclosure proof cryptographically verified', ok: m.proofValid },
    { k: 'tamperEvident', label: spec.tamperEvidentRequired ? 'load-bearing competency backed by tamper-evident evidence' : 'tamper-evident evidence not required', ok: m.tamperEvident },
    { k: 'proficiency', label: `disclosed proficiency ≥ ${spec.minProficiency}`, ok: m.proficiency },
  ];
  return (
    <div style={{ ...card, marginTop: 16, borderLeft: `5px solid ${tone}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: serif, fontSize: 28, color: tone }}>{head}</div>
        <div style={{ fontSize: 14, color: 'var(--text)' }}>for <strong>{spec.role}</strong></div>
        <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>decided by a fresh employer with no prior relationship</div>
      </div>
      <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {rows.map((r, i) => (
          <div key={r.k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: i < rows.length - 1 ? '1px solid #f0f0ee' : 'none', fontSize: 13 }}>
            <span style={{ color: r.ok ? '#2e9c4a' : '#d23f31', fontWeight: 600, width: 12 }}>{r.ok ? '✓' : '✗'}</span>
            <span>{r.label}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>{ev.decision.reasons.join(' · ')}</div>
      <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-dim)' }}>
        Read <strong>{ev.reviewedStatements ?? 0}</strong> statements from the candidate&rsquo;s own pod ·
        {candidate?.credentialIssued ? ' credential chain of custody intact' : ' (credential issuance unavailable on this deployment)'} ·
        the decision was recorded back onto the substrate as signed evidence.
      </div>
    </div>
  );
}

function EventRow({ e }: { e: CeremonyEvent }) {
  const ac = ACTOR_COLOR[e.actor] ?? '#6b7280';
  const kc = KIND_COLOR[e.kind] ?? '#6b7280';
  return (
    <div style={{ borderLeft: `3px solid ${ac}`, padding: '6px 10px', background: e.kind === 'phase' ? '#faf9f7' : 'transparent' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: mono, fontSize: 9.5, color: ac, minWidth: 120, fontWeight: 600 }}>{e.actor}</span>
        <span style={{ fontFamily: mono, fontSize: 9, textTransform: 'uppercase', color: kc, minWidth: 64 }}>{e.kind}</span>
        <span style={{ fontSize: 13, flex: 1, fontWeight: e.kind === 'phase' || e.kind === 'decision' ? 600 : 400 }}>{e.title}</span>
      </div>
      {e.detail && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 128, lineHeight: 1.45, wordBreak: 'break-word' }}>{e.detail}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ ...lbl, marginBottom: 4 }}>{label}</div>{children}</div>;
}
const inp: React.CSSProperties = { width: '100%', padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' };
