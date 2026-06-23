/**
 * /constitution (#5) — reflexive self-amendment. Agents amend the very rule that
 * governs them, UNDER that rule — and the amended rule then binds the next vote.
 * Round 1: lower the ratification threshold (judged under the OLD supermajority
 * rule). Round 2: a fresh proposal judged under the NEW rule the agents just chose.
 * The cleanest downward-causation loop: the rule binds its authors on the next call.
 * Composes @interego/constitutional via the signed /agent/govern/amend endpoint. BYOK.
 */
import React, { useState } from 'react';
import { makePanel, runGovernanceRound, makeEmit, resetCounter, type GovEvent, type RoundResult } from '../demo/governance.js';
import { Row } from './TheQuorum.js';
import { BRIDGE_URL } from '../bridge-client.js';

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };

const PANEL = [
  { name: 'Reformer', stance: 'You are convinced the ⅔ supermajority requirement is too rigid and has repeatedly let a stubborn minority block sensible change; you strongly support moving to a simple majority.' },
  { name: 'Pragmatist', stance: 'In your experience simple-majority rule is the right default for ordinary policy changes and supermajority should be reserved for bedrock; you support lowering the threshold.' },
  { name: 'Efficiency', stance: 'You believe a minority veto under ⅔ stalls the consortium; faster majority decisions serve everyone, so you favor lowering the threshold to a simple majority.' },
  { name: 'Traditionalist', stance: 'You value stability and minority protection above agility; you oppose lowering the threshold and will defend the ⅔ supermajority.' },
];

export function Constitution({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [events, setEvents] = useState<GovEvent[]>([]);
  const [r1, setR1] = useState<RoundResult | null>(null);
  const [r2, setR2] = useState<RoundResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = apiKey.trim().length > 0;

  async function run() {
    if (running || !hasKey) return;
    setRunning(true); setErr(null); setEvents([]); setR1(null); setR2(null); resetCounter();
    const emit = makeEmit(e => setEvents(prev => [...prev, e]));
    try {
      const agents = makePanel(PANEL);
      agents.forEach(a => emit({ actor: a.name, kind: 'identity', title: `${a.name} — self-sovereign voter`, detail: a.wallet.did.slice(0, 22) + '…' }));
      const policyId = 'urn:foxxi:constitution:ratification-rule';

      emit({ actor: 'consortium', kind: 'phase', title: 'ROUND 1 — amend the ratification rule, UNDER the current rule (⅔ supermajority)' });
      const round1 = await runGovernanceRound(apiKey, emit, {
        agents, policyId, tier: 1,
        summary: 'Lower the ratification threshold for policy changes from a ⅔ supermajority (0.67) to a simple majority (0.51).',
        addedRules: ['ratifyRule.threshold = 0.51'],
        rules: { minQuorum: 3, threshold: 0.67 },   // judged under the OLD rule
        context: 'The constitution currently requires a ⅔ supermajority (0.67) to ratify. You are voting on whether to CHANGE that rule itself — and this very vote is judged under the current ⅔ rule.',
      });
      setR1(round1);

      const newThreshold = round1.status === 'Ratified' ? 0.51 : 0.67;
      emit({ actor: 'consortium', kind: 'phase', title: `ROUND 2 — a new proposal, now judged under the rule the agents just chose (${(newThreshold * 100).toFixed(0)}% to ratify)` });
      const round2 = await runGovernanceRound(apiKey, emit, {
        agents, policyId: 'urn:foxxi:policy:agent-rate-limit', tier: 2,
        summary: 'Adopt a shared fair-use rule: no single agent may consume more than 40% of consortium compute in a rolling hour.',
        addedRules: ['fairUse.maxSharePerHour = 0.40'],
        rules: { minQuorum: 3, threshold: newThreshold },   // judged under the (possibly amended) rule
        context: round1.status === 'Ratified'
          ? 'NOTE: the ratification threshold was just amended by your own vote from 67% to 51%. This proposal is judged under the NEW rule you adopted.'
          : 'NOTE: the attempt to lower the threshold did not pass, so the ⅔ supermajority rule still binds this vote.',
      });
      setR2(round2);
      emit({ actor: 'consortium', kind: 'done', title: `reflexive loop closed — the rule the agents ${round1.status === 'Ratified' ? 'amended (→51%)' : 'kept (67%)'} governed round 2 (${round2.status})` });
    } catch (e) { setErr((e as Error).message); }
    finally { setRunning(false); }
  }

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>/constitution — agents amend their own rules</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 840, lineHeight: 1.5 }}>
        The reflexive loop: a panel of <strong>LLM agents</strong> amends the very rule that governs them — <em>under</em> that
        rule — and the amended rule then <strong>binds the next vote</strong>. <strong>Round 1</strong> proposes lowering the
        ratification threshold, judged under the current ⅔ supermajority. If it passes, <strong>Round 2</strong>&rsquo;s fresh
        proposal is judged under the <strong>new</strong> simple-majority rule the agents just chose — upward causation (their
        votes change the rule) and downward causation (the changed rule shapes the next decision) in one signed loop. Composes
        <code style={codeS}>@interego/constitutional</code>; every vote is a real signed call to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>.
      </p>

      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ ...lbl, marginBottom: 4 }}>Anthropic key — each voter is a real LLM agent, so they need your key (sent only to api.anthropic.com from this tab). The ratification math + signature recovery are deterministic.</div>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-… (required — a panel of real LLM agents amends its own constitution)"
          autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
          style={{ width: '100%', marginTop: 5, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' }} />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0 6px' }}>
        <button onClick={run} disabled={running || !hasKey} style={{ ...btn, opacity: running || !hasKey ? 0.5 : 1 }}>{running ? 'self-amending…' : 'Run the reflexive amendment'}</button>
        {!hasKey && <span style={{ fontSize: 12, color: '#b45309' }}>add your Anthropic key above — the voters are real LLM agents.</span>}
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid #c1432a', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {(r1 || r2) && (
        <div style={{ ...card, marginTop: 16, borderLeft: '5px solid var(--accent)' }}>
          <div style={{ fontFamily: serif, fontSize: 22 }}>The rule bound its own authors</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>
            Round 1 (under ⅔): <strong style={{ color: r1?.status === 'Ratified' ? '#2e9c4a' : '#b45309' }}>{r1?.status}</strong> — {r1?.tally?.for}/{(r1?.tally?.for ?? 0) + (r1?.tally?.against ?? 0)} for ({((r1?.tally?.proportion ?? 0) * 100).toFixed(0)}%).
            {r1?.status === 'Ratified' ? ' Threshold amended to 51%.' : ' Threshold stays 67%.'}
          </div>
          {r2 && <div style={{ fontSize: 13, marginTop: 4 }}>Round 2 (under {((r2.rules?.threshold ?? 0) * 100).toFixed(0)}% — the rule from round 1): <strong style={{ color: r2.status === 'Ratified' ? '#2e9c4a' : '#b45309' }}>{r2.status}</strong> — {r2.tally?.for}/{(r2.tally?.for ?? 0) + (r2.tally?.against ?? 0)} for ({((r2.tally?.proportion ?? 0) * 100).toFixed(0)}%).</div>}
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>Whether they amended the rule or upheld it, the agents&rsquo; own signed votes determined the threshold that judged their next decision — a self-amending constitution, signed end to end. (The panel often <em>declines</em> to weaken its own supermajority — emergent, not scripted.)</div>
        </div>
      )}

      {events.length > 0 && (
        <div style={{ ...card, marginTop: 14 }}>
          <div style={{ ...lbl, marginBottom: 8 }}>the reflexive loop — two rounds of signed, ratified self-governance</div>
          <div style={{ display: 'grid', gap: 2 }}>{events.map(e => <Row key={e.id} e={e} />)}{running && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>working…</div>}</div>
        </div>
      )}
    </div>
  );
}
