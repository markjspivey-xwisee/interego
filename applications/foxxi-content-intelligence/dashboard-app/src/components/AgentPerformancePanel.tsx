/**
 * Agent Performance Consultant — the human-facing surface for consulting
 * on a team of agents.
 *
 * Deliberately NOT a gap-style performance dashboard. There is no score,
 * no gap, no "% to ideal", no target bar — by design. A team of agents
 * is a complex, adaptive system; this view presents its DISPOSITION
 * (work-regime placement, modal propensities, drift vector) and lets the
 * consultant run safe-to-fail constraint probes, then reads the
 * interventional + counterfactual causal effect in hindsight.
 */

import React, { useState } from 'react';
import { Card, Pill, Button, TextInput } from './common.js';
import { useAffordance, useHypermedia, invokeAffordance } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';

/** Demo team — the agents the agent-performance-example records trajectories for. */
const DEMO_TEAM = [
  'did:key:z6MkFoxxiResearchAgent',
  'did:key:z6MkFoxxiRetrievalAgent',
  'did:key:z6MkFoxxiSynthesisAgent',
].join(', ');

interface TeamDisposition {
  team: { agentDids: string[]; trajectoryCount: number; stepCount: number };
  modalBalance: {
    asserted: number; hypothetical: number; counterfactual: number;
    deliberationRatio: number; explorationRatio: number; planRevisionRatio: number;
  };
  toolCallSuccessRate: number;
  dispositions: Array<{ name: string; reading: string; signal: string }>;
  regime: { name: string; rationale: string; stance: string };
  vector: { direction: string; basis: string };
  method: string;
}
interface CausalRead {
  probeId: string; constraintTarget: string;
  interventional: { before: Record<string, unknown>; after: Record<string, unknown>; shift: string; movedAsHypothesised: boolean };
  counterfactual: { reading: string; basis: string };
  caveat: string;
  recommendation: 'amplify' | 'dampen' | 'let-run';
  recommendationRationale: string;
}
interface AssessResult {
  disposition: TeamDisposition;
  probeCount: number;
  causalReads: CausalRead[];
  error?: string;
}

export function AgentPerformancePanel({ session }: { session: FoxxiSession }) {
  const assessAff = useAffordance('foxxi.assess_agent_disposition');
  const probeAff = useAffordance('foxxi.run_performance_probe');
  const { bearer } = useHypermedia();

  const [teamInput, setTeamInput] = useState(DEMO_TEAM);
  const [result, setResult] = useState<AssessResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Safe-to-fail probe form — prefilled with a demo probe.
  const [constraintTarget, setConstraintTarget] = useState('delegation-scope:researcher→retrieval');
  const [change, setChange] = useState('Broaden the delegation scope so the research agent may sub-delegate retrieval to the retrieval agent.');
  const [coherence, setCoherence] = useState<'coherent' | 'oblique' | 'contradictory'>('coherent');
  const [hypothesized, setHypothesized] = useState('Sub-delegation should raise tool-call success and shift the team toward more composed trajectories.');
  const [amplifySignal, setAmplifySignal] = useState('tool-call success rises and joint (composed) trajectories appear.');
  const [dampenSignal, setDampenSignal] = useState('delegation loops or duplicated retrieval work emerge.');
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState<string | null>(null);

  const teamDids = (): string[] => teamInput.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

  async function assess() {
    if (!assessAff || loading) return;
    setLoading(true); setError(null);
    try {
      const r = await invokeAffordance({
        affordance: assessAff, bearer, args: { agent_dids: teamDids() },
      }) as AssessResult & { error?: string };
      if (r.error) { setError(r.error); setResult(null); }
      else setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function runProbe() {
    if (!probeAff || probing) return;
    setProbing(true); setProbeMsg(null);
    try {
      const r = await invokeAffordance({
        affordance: probeAff, bearer,
        args: {
          agent_dids: teamDids(),
          constraint_target: constraintTarget.trim(),
          change: change.trim(),
          coherence,
          hypothesized_effect: hypothesized.trim(),
          amplify_signal: amplifySignal.trim(),
          dampen_signal: dampenSignal.trim(),
        },
      }) as { recorded?: boolean; error?: string };
      if (r.error) { setProbeMsg(`✗ ${r.error}`); }
      else { setProbeMsg('✓ probe recorded as a deliberate change — re-assessing for the causal read…'); await assess(); }
    } catch (err) {
      setProbeMsg(`✗ ${(err as Error).message}`);
    } finally {
      setProbing(false);
    }
  }

  const d = result?.disposition;

  return (
    <Card
      title="Agent Performance Consultant"
      right={<Pill tone="accent" title="Consulting on a team of agents — complexity-aware, disposition-based, not gap-based">APT · complexity-aware</Pill>}
    >
      <div style={{ marginBottom: 14, color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.55 }}>
        You are consulting on a <strong>team of AI agents</strong> — a complex, adaptive system. This view has
        <strong> no score, no gap, no ideal future state</strong> by design. It reads the team's{' '}
        <strong>disposition</strong> (the project's own work-regime model), and you steer by running{' '}
        <strong>safe-to-fail probes</strong> on its constraints, then reading the interventional + counterfactual
        causal effect in hindsight.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <TextInput value={teamInput} onChange={setTeamInput} placeholder="agent DIDs (comma-separated)" onSubmit={assess} />
        <Button primary onClick={assess} disabled={loading || !assessAff}>{loading ? 'Reading…' : 'Read disposition'}</Button>
      </div>

      {error && (
        <div style={{ color: 'var(--bad)', fontSize: 13, marginBottom: 12 }}>
          ✗ {error}
          {/no recorded trajectories/i.test(error) && (
            <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>
              Run the example first: <code>npx tsx applications/foxxi-content-intelligence/tools/agent-performance-example.mjs</code>
            </div>
          )}
        </div>
      )}
      {!assessAff && !error && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>The bridge does not advertise <code>assess_agent_disposition</code> — offline-sample mode.</div>
      )}

      {d && (
        <div>
          {/* Work-regime placement — the headline. NOT a score. */}
          <div style={{
            padding: 14, marginBottom: 14, borderRadius: 6,
            background: 'var(--panel-2)', border: '1px solid var(--border)',
            borderLeft: `3px solid ${regimeColor(d.regime.name)}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span className="label">Work-regime placement</span>
              <Pill tone="accent">{d.regime.name}</Pill>
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                {d.team.trajectoryCount} agents · {d.team.stepCount} trajectory steps
              </span>
            </div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{d.regime.rationale}</div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Stance: {d.regime.stance}</div>
          </div>

          {/* Modal balance — propensities, descriptive. */}
          <Section title="Modal balance — propensities, not a score">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Pill tone="neutral" title="hypothetical / asserted — how much the team plans relative to acting">
                deliberation {d.modalBalance.deliberationRatio}
              </Pill>
              <Pill tone="neutral" title="counterfactual / total — how much the team explores roads not taken">
                exploration {d.modalBalance.explorationRatio}
              </Pill>
              <Pill tone="neutral" title="superseding steps / asserted — how much the team revises plans in flight">
                plan-revision {d.modalBalance.planRevisionRatio}
              </Pill>
              <Pill tone="neutral">tool-call success {d.toolCallSuccessRate}</Pill>
            </div>
          </Section>

          {/* Named dispositions. */}
          <Section title="Dispositions">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {d.dispositions.map((dp, i) => (
                <div key={i} style={rowStyle}>
                  <Pill tone="accent">{dp.name}</Pill>
                  <span style={{ flex: 1, fontSize: 12 }}>{dp.reading}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{dp.signal}</span>
                </div>
              ))}
            </div>
          </Section>

          {/* Vector — direction from the present, not a destination. */}
          <Section title="Vector of change — direction, not a destination">
            <div style={rowStyle}>
              <Pill tone={d.vector.direction.includes('higher') ? 'good' : d.vector.direction.includes('lower') ? 'bad' : 'neutral'}>
                {d.vector.direction}
              </Pill>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-dim)' }}>{d.vector.basis}</span>
            </div>
          </Section>

          {/* Safe-to-fail probe. */}
          <Section title="Run a safe-to-fail probe (a deliberate change to a constraint)">
            <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
              <TextInput value={constraintTarget} onChange={setConstraintTarget} placeholder="constraint to nudge" />
              <TextInput value={change} onChange={setChange} placeholder="the constraint change" />
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>safe-to-fail role:</span>
                {(['coherent', 'oblique', 'contradictory'] as const).map(c => (
                  <Button key={c} small primary={coherence === c} onClick={() => setCoherence(c)}>{c}</Button>
                ))}
              </div>
              <TextInput value={hypothesized} onChange={setHypothesized} placeholder="hypothesised effect" />
              <TextInput value={amplifySignal} onChange={setAmplifySignal} placeholder="amplify signal" />
              <TextInput value={dampenSignal} onChange={setDampenSignal} placeholder="dampen signal" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button primary onClick={runProbe} disabled={probing || !probeAff}>
                {probing ? 'Probing…' : 'Run probe'}
              </Button>
              {probeMsg && <span style={{ fontSize: 12, color: probeMsg.startsWith('✓') ? 'var(--good)' : 'var(--bad)' }}>{probeMsg}</span>}
            </div>
          </Section>

          {/* Causal reads. */}
          {result && result.causalReads.length > 0 && (
            <Section title={`Causal read — ${result.causalReads.length} probe${result.causalReads.length === 1 ? '' : 's'} (interventional + counterfactual)`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {result.causalReads.map((cr, i) => (
                  <div key={i} style={{ padding: 10, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <Pill tone={cr.recommendation === 'amplify' ? 'good' : cr.recommendation === 'dampen' ? 'bad' : 'neutral'}>
                        {cr.recommendation}
                      </Pill>
                      <code style={{ fontSize: 11 }}>do({cr.constraintTarget})</code>
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>
                      <strong>Interventional read:</strong> {cr.interventional.shift}
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 4 }}>
                      <strong>Counterfactual read:</strong> {cr.counterfactual.reading}
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 4, color: 'var(--text-dim)' }}>{cr.recommendationRationale}</div>
                    <div style={{ fontSize: 11, color: 'var(--warn)', fontStyle: 'italic' }}>{cr.caveat}</div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 12, fontStyle: 'italic' }}>
            {d.method}
          </div>
        </div>
      )}
    </Card>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 10px', background: 'var(--panel-2)',
  border: '1px solid var(--border)', borderRadius: 4,
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="label" style={{ marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function regimeColor(regime: string): string {
  return regime === 'Emergent' ? 'var(--accent)'
    : regime === 'Knowable' ? 'var(--good)'
    : regime === 'Turbulent' ? 'var(--bad)'
    : 'var(--warn)';
}
