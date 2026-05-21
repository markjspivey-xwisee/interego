/**
 * Performance & Knowledge Architecture — the demo suite.
 *
 * A 4x4 routing matrix: the four directionalities (H2H, H2A, A2H, A2A)
 * across the four work regimes (Evident, Knowable, Emergent, Turbulent).
 * Each of the sixteen cells is a real performance gap; clicking it runs
 * the live diagnosis -> intervention-plan -> knowledge-map flow against
 * the bridge, so the whole routing — every directionality, every regime,
 * every disposition — can be walked end to end.
 *
 * The panel calls the bridge's open routes directly:
 *   POST /performance/plan        diagnose a gap -> the InterventionPlan
 *   POST /knowledge/map           decompose the competency's knowledge
 *   POST /content/compose-course  author an emergent course
 *   POST /content/personalize     resolve it for the performer
 */

import React, { useState } from 'react';
import { Card, Pill, Button } from './common.js';

const BRIDGE = (import.meta.env.VITE_FOXXI_BRIDGE_URL as string | undefined) ?? 'http://localhost:6080';

// ── Types (mirror the bridge response shapes) ───────────────────────

type Regime = 'Evident' | 'Knowable' | 'Emergent' | 'Turbulent';
type Direction = 'H2H' | 'H2A' | 'A2H' | 'A2A';

interface InterventionOption {
  type: string;
  selected: boolean;
  rationale: string;
  ruledOutBecause?: string;
  authoring?: { affordance: string; direction: string };
}
interface PlanResult {
  diagnosis: {
    domain: Regime; method: string; rootCauses: string[];
    skillDeficiency: boolean; reasoning: string[]; caveat?: string;
    factors?: Record<string, { factor: string; category: string; adequate: boolean; evidence: string }>;
    disposition?: { domain: string; vector: string; stance: string };
  };
  plan: {
    paradigm: InterventionOption[]; selected: InterventionOption[];
    contentWarranted: boolean; direction: Direction; summary: string;
  };
  scaffold: { contentWarranted: boolean; toAuthor: Array<{ interventionType: string; affordance: string; guidance: string }>; note: string };
}
interface KnowledgeResult {
  knowledgeMap: {
    strategy: { strategy: string; primaryMode: string; rationale: string };
    decomposition: { codifiableShare: number; recommendation: string };
    toCodify: string[]; toConnect: string[]; note: string;
  };
}
type CellState = 'idle' | 'loading' | { plan: PlanResult } | { error: string };

// ── Scenario data — 16 cells (directionality x regime) ──────────────

interface Scenario {
  key: string;
  direction: Direction;
  regime: Regime;
  title: string;
  body: Record<string, unknown>;  // the POST /performance/plan body
}

const human = (id: string, role: string) => ({ id, kind: 'human', role });
const agent = (id: string, role: string) => ({ id, kind: 'agent', role });

/** Author + performer kinds per directionality. */
const ACTORS: Record<Direction, { author: { id: string; kind: string; role: string }; performerKind: 'human' | 'agent' }> = {
  H2H: { author: human('did:web:acme#sme-lee', 'subject-matter expert'), performerKind: 'human' },
  H2A: { author: human('did:web:acme#sme-lee', 'doctrine author'), performerKind: 'agent' },
  A2H: { author: agent('did:web:acme#agent-consultant', 'performance consultant'), performerKind: 'human' },
  A2A: { author: agent('did:web:acme#agent-senior', 'senior agent'), performerKind: 'agent' },
};

/** Build a scenario. `gap` omits performer; it is filled from the directionality. */
function scn(direction: Direction, regime: Regime, title: string, gap: Record<string, unknown>, extra: Record<string, unknown> = {}): Scenario {
  const a = ACTORS[direction];
  const perf = a.performerKind === 'human'
    ? human('did:web:acme#performer-h', 'practitioner')
    : agent('did:web:acme#performer-a', 'operating agent');
  return {
    key: `${regime}-${direction}`,
    direction, regime, title,
    body: {
      gap: { performer: perf, modalStatus: 'Asserted', domain: regime, ...gap },
      author: a.author,
      ...extra,
    },
  };
}

const SCENARIOS: Scenario[] = [
  // ── Evident regime ──
  scn('H2H', 'Evident', 'Onboarding checklist step',
    { workContext: 'first-week onboarding', competency: 'completing the equipment-setup checklist',
      desired: 'completes every checklist step', observed: 'skips the security-token step',
      frequency: 'rare', criticality: 'moderate' },
    { couldPerformUnderIdealConditions: false, factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'never shown the security-token step' } } }),
  scn('H2A', 'Evident', 'Agent on an evident task',
    { workContext: 'a repetitive, evident data-tagging task', competency: 'applying the tagging rule',
      desired: 'tags every record correctly', observed: 'mis-tags records when the tool times out',
      frequency: 'continuous', criticality: 'moderate' },
    { couldPerformUnderIdealConditions: true, factorEvidence: { instrumentation: { adequate: false, evidence: 'the tagging tool times out under load' } } }),
  scn('A2H', 'Evident', 'A known step, skipped',
    { workContext: 'closing a support ticket', competency: 'attaching the resolution summary',
      desired: 'attaches a summary on every close', observed: 'closes tickets with no summary',
      frequency: 'frequent', criticality: 'low' },
    { couldPerformUnderIdealConditions: true, factorEvidence: { incentives: { adequate: false, evidence: 'reps are measured on close-rate; the summary slows them down' } } }),
  scn('A2A', 'Evident', 'No real deficiency',
    { workContext: 'a routine evident task', competency: 'running the standard procedure',
      desired: 'runs the procedure to spec', observed: 'occasional variance within tolerance',
      frequency: 'continuous', criticality: 'low' },
    { couldPerformUnderIdealConditions: true }),

  // ── Knowable regime ──
  scn('H2H', 'Knowable', 'Refund dispute resolution',
    { workContext: 'resolving customer refund disputes', competency: 'resolving disputes within policy',
      desired: 'resolves in-policy disputes on first contact', observed: 'over-escalates resolvable disputes',
      frequency: 'continuous', criticality: 'moderate' },
    { couldPerformUnderIdealConditions: false, factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'reps cannot recall the refund decision tree' } } }),
  scn('H2A', 'Knowable', 'Agent doctrine — incident triage',
    { workContext: 'triaging a sev-2 incident', competency: 'triaging incidents to the documented doctrine',
      desired: 'follows the triage doctrine', observed: 'improvises before the rollback is ruled out',
      frequency: 'frequent', criticality: 'high' },
    { couldPerformUnderIdealConditions: false, factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'the agent has not ingested the triage doctrine' } } }),
  scn('A2H', 'Knowable', 'Fluency decayed',
    { workContext: 'the annual audit walkthrough', competency: 'leading the audit walkthrough',
      desired: 'leads the walkthrough fluently', observed: 'hesitant; consults notes constantly',
      frequency: 'frequent', criticality: 'high' },
    { couldPerformUnderIdealConditions: false, performedWellBefore: true,
      factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'led it well two years ago; fluency has decayed' } } }),
  scn('A2A', 'Knowable', 'Unverified gap',
    { workContext: 'a knowable analytical task', competency: 'producing the weekly analysis',
      desired: 'produces a correct analysis', observed: 'a manager reported the analysis "feels off"',
      frequency: 'frequent', criticality: 'moderate', modalStatus: 'Hypothetical' },
    {}),

  // ── Emergent regime ──
  scn('H2H', 'Emergent', 'A human team on novel work',
    { workContext: 'a first-of-its-kind product launch', competency: 'coordinating a novel launch',
      desired: 'a well-coordinated launch', observed: 'coordination is uneven across a genuinely new effort',
      frequency: 'rare', criticality: 'high' },
    {}),
  scn('H2A', 'Emergent', 'An agent in emergent work',
    { workContext: 'resolving novel third-party integration failures', competency: 'resolving novel failures',
      desired: 'resolves novel failures', observed: 'resolution is inconsistent across genuinely new failures',
      frequency: 'occasional', criticality: 'high' },
    {}),
  scn('A2H', 'Emergent', 'Consulting a human on the unknown',
    { workContext: 'opening a new market with no playbook', competency: 'navigating an unprecedented market',
      desired: 'traction in the new market', observed: 'no stable approach has emerged yet',
      frequency: 'rare', criticality: 'high' },
    {}),
  scn('A2A', 'Emergent', 'An agent team adapting',
    { workContext: 'an agent team on open-ended research', competency: 'adapting to open-ended research',
      desired: 'consistent research outcomes', observed: 'the team explores and revises plans constantly',
      frequency: 'continuous', criticality: 'moderate' },
    {}),

  // ── Turbulent regime ──
  scn('H2H', 'Turbulent', 'A team in crisis',
    { workContext: 'an unfolding operational crisis', competency: 'operating through the crisis',
      desired: 'a stabilised operation', observed: 'behaviour is not yet patterned — pure reaction',
      frequency: 'rare', criticality: 'safety-critical' },
    {}),
  scn('H2A', 'Turbulent', 'An agent in chaos',
    { workContext: 'an agent hitting a cascading-failure storm', competency: 'operating during a failure storm',
      desired: 'a stabilised system', observed: 'no stable act->outcome relationship to read',
      frequency: 'rare', criticality: 'safety-critical' },
    {}),
  scn('A2H', 'Turbulent', 'Consulting amid disorder',
    { workContext: 'a market shock with no precedent', competency: 'acting under a market shock',
      desired: 'a footing from which to act', observed: 'the situation is not yet patterned',
      frequency: 'rare', criticality: 'high' },
    {}),
  scn('A2A', 'Turbulent', 'An agent team unpatterned',
    { workContext: 'an agent team facing a wholly novel disruption', competency: 'operating in a novel disruption',
      desired: 'a stable working pattern', observed: 'the team has no patterned behaviour yet',
      frequency: 'rare', criticality: 'high' },
    {}),
];

const REGIMES: Regime[] = ['Evident', 'Knowable', 'Emergent', 'Turbulent'];
const DIRECTIONS: Direction[] = ['H2H', 'H2A', 'A2H', 'A2A'];

// ── Component ───────────────────────────────────────────────────────

export function PerformanceDemoSuitePanel() {
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [knowledge, setKnowledge] = useState<Record<string, KnowledgeResult | { error: string }>>({});
  const [routingAll, setRoutingAll] = useState(false);

  const byKey = (k: string) => SCENARIOS.find(s => s.key === k)!;

  async function runCell(s: Scenario): Promise<CellState> {
    try {
      const r = await fetch(`${BRIDGE}/performance/plan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s.body),
      });
      if (!r.ok) return { error: `bridge ${r.status}` };
      const plan = await r.json() as PlanResult;
      if ((plan as unknown as { error?: string }).error) return { error: (plan as unknown as { error: string }).error };
      return { plan };
    } catch (e) { return { error: (e as Error).message }; }
  }

  async function runKnowledge(s: Scenario): Promise<void> {
    try {
      const g = s.body.gap as Record<string, unknown>;
      const r = await fetch(`${BRIDGE}/knowledge/map`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          competency: g.competency, regime: s.regime,
          components: knowledgeComponentsFor(s.regime),
        }),
      });
      if (!r.ok) { setKnowledge(k => ({ ...k, [s.key]: { error: `bridge ${r.status}` } })); return; }
      const km = await r.json() as KnowledgeResult;
      setKnowledge(k => ({ ...k, [s.key]: km }));
    } catch (e) { setKnowledge(k => ({ ...k, [s.key]: { error: (e as Error).message } })); }
  }

  async function selectCell(s: Scenario): Promise<void> {
    setSelected(s.key);
    if (typeof cells[s.key] !== 'object') {
      setCells(c => ({ ...c, [s.key]: 'loading' }));
      const res = await runCell(s);
      setCells(c => ({ ...c, [s.key]: res }));
    }
    if (!knowledge[s.key]) void runKnowledge(s);
  }

  async function routeAll(): Promise<void> {
    setRoutingAll(true);
    setCells(Object.fromEntries(SCENARIOS.map(s => [s.key, 'loading' as CellState])));
    const results = await Promise.all(SCENARIOS.map(runCell));
    setCells(Object.fromEntries(SCENARIOS.map((s, i) => [s.key, results[i]!])));
    setRoutingAll(false);
  }

  const done = SCENARIOS.filter(s => typeof cells[s.key] === 'object');
  const ran = done.map(s => cells[s.key]).filter((c): c is { plan: PlanResult } => !!c && typeof c === 'object' && 'plan' in c);
  const contentCount = ran.filter(c => c.plan.plan.contentWarranted).length;
  const sel = selected ? byKey(selected) : null;
  const selState = selected ? cells[selected] : undefined;

  return (
    <Card
      title="Performance & Knowledge Architecture — demo suite"
      right={<Pill tone="accent">{done.length}/16 flows routed</Pill>}
    >
      <div style={{ marginBottom: 14, color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.55 }}>
        Sixteen real performance gaps — the four <strong>directionalities</strong> (who authors × who
        performs) across the four <strong>work regimes</strong> (how knowable the work is). Click any
        cell to route it live: a diagnosis decides the intervention, content is composed only when it
        is the answer, and the knowledge map says how much of the competency can honestly become
        content. Each cell calls the deployed bridge — nothing here is mocked.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button primary onClick={routeAll} disabled={routingAll}>
          {routingAll ? 'Routing…' : 'Route all 16 flows'}
        </Button>
        {ran.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {contentCount}/{ran.length} routed to <strong>content</strong> · {ran.length - contentCount} to{' '}
            <strong>non-content</strong> interventions (the system is performance-driven, not content-driven).
          </span>
        )}
      </div>

      {/* ── The 4x4 routing matrix ── */}
      <div style={{ overflowX: 'auto', marginBottom: 18 }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 6, width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left' }}>regime ╲ direction</th>
              {DIRECTIONS.map(d => (
                <th key={d} style={thStyle} title={directionMeaning(d)}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {REGIMES.map(regime => (
              <tr key={regime}>
                <td style={{ ...thStyle, textAlign: 'left', whiteSpace: 'nowrap' }} title={regimeMeaning(regime)}>
                  {regime}
                </td>
                {DIRECTIONS.map(direction => {
                  const s = SCENARIOS.find(x => x.regime === regime && x.direction === direction)!;
                  const st = cells[s.key];
                  return (
                    <td key={direction} style={{ padding: 0 }}>
                      <button onClick={() => void selectCell(s)} style={cellStyle(st, selected === s.key)}>
                        <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 3 }}>{s.title}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-dim)', minHeight: 26 }}>
                          {st === 'loading' && 'routing…'}
                          {st && typeof st === 'object' && 'error' in st && <span style={{ color: 'var(--bad)' }}>✗ {st.error}</span>}
                          {st && typeof st === 'object' && 'plan' in st && (
                            <span>{st.plan.plan.selected.map(o => o.type).join(', ') || 'no intervention'}</span>
                          )}
                          {(st === undefined || st === 'idle') && 'click to route'}
                        </div>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── The selected flow, in full ── */}
      {sel && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <Pill tone="accent">{sel.direction}</Pill>
            <Pill tone="neutral">{sel.regime} regime</Pill>
            <strong style={{ fontSize: 14 }}>{sel.title}</strong>
          </div>

          {selState === 'loading' && <div style={{ color: 'var(--text-dim)' }}>routing the flow…</div>}
          {selState && typeof selState === 'object' && 'error' in selState && (
            <div style={{ color: 'var(--bad)', fontSize: 13 }}>
              ✗ {selState.error} — is the bridge reachable at <code>{BRIDGE}</code>?
            </div>
          )}
          {selState && typeof selState === 'object' && 'plan' in selState && (
            <FlowDetail scenario={sel} result={selState.plan} knowledge={knowledge[sel.key]} />
          )}
        </div>
      )}
    </Card>
  );
}

// ── The full-flow detail for one cell ───────────────────────────────

function FlowDetail({ scenario, result, knowledge }: {
  scenario: Scenario; result: PlanResult; knowledge?: KnowledgeResult | { error: string };
}) {
  const g = scenario.body.gap as Record<string, string>;
  const { diagnosis, plan, scaffold } = result;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* 1. The gap */}
      <Step n={1} title="The performance gap">
        <div style={{ fontSize: 12.5 }}>
          <strong>{g.competency}</strong> — desired: <em>{g.desired}</em>; observed: <em>{g.observed}</em>.
          <div style={{ color: 'var(--text-dim)', marginTop: 3 }}>
            {g.frequency} · {g.criticality} criticality · gap claim is {g.modalStatus}
          </div>
        </div>
      </Step>

      {/* 2. The diagnosis */}
      <Step n={2} title={`Diagnosis — ${diagnosis.method}`}>
        <div style={{ fontSize: 12.5 }}>
          Work regime <strong>{diagnosis.domain}</strong>. {diagnosis.reasoning[0]}
        </div>
        {diagnosis.factors && (
          <div style={{ marginTop: 6, display: 'grid', gap: 2 }}>
            {Object.values(diagnosis.factors).map(f => (
              <div key={f.factor} style={{ fontSize: 11.5, color: f.adequate ? 'var(--text-dim)' : 'var(--bad)' }}>
                {f.adequate ? '○' : '●'} <strong>{f.factor.split(' — ')[0]}</strong>
                {!f.adequate && ` — ${f.evidence}`}
              </div>
            ))}
          </div>
        )}
        {diagnosis.disposition && (
          <div style={{ fontSize: 11.5, marginTop: 6, color: 'var(--text-dim)' }}>
            Disposition: {diagnosis.disposition.stance}
          </div>
        )}
        {diagnosis.caveat && (
          <div style={{ fontSize: 11.5, marginTop: 6, color: 'var(--warn)' }}>⚠ {diagnosis.caveat}</div>
        )}
      </Step>

      {/* 3. The full intervention paradigm */}
      <Step n={3} title="The intervention paradigm — every option, with reasoning">
        <div style={{ display: 'grid', gap: 3 }}>
          {plan.paradigm.map(o => (
            <div key={o.type} style={{
              fontSize: 11.5, display: 'flex', gap: 6, alignItems: 'baseline',
              opacity: o.selected ? 1 : 0.6,
            }}>
              <span style={{ color: o.selected ? 'var(--good)' : 'var(--text-dim)', fontWeight: 700, width: 14 }}>
                {o.selected ? '✓' : '✗'}
              </span>
              <span style={{ fontWeight: 600, width: 150, flexShrink: 0 }}>{o.type}</span>
              <span style={{ color: 'var(--text-dim)' }}>{o.selected ? o.rationale : o.ruledOutBecause}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, marginTop: 8, fontWeight: 500 }}>{plan.summary}</div>
      </Step>

      {/* 4. Content scaffold */}
      <Step n={4} title={plan.contentWarranted ? 'Content to author' : 'No content to author'}>
        <div style={{ fontSize: 12, color: plan.contentWarranted ? 'var(--text)' : 'var(--text-dim)' }}>
          {scaffold.note}
        </div>
        {scaffold.toAuthor.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {scaffold.toAuthor.map((t, i) => (
              <div key={i} style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                · <code>{t.affordance}</code> — {t.guidance}
              </div>
            ))}
          </div>
        )}
      </Step>

      {/* 5. Knowledge map */}
      <Step n={5} title="Knowledge map — what can honestly become content">
        {!knowledge && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>mapping…</div>}
        {knowledge && 'error' in knowledge && (
          <div style={{ fontSize: 12, color: 'var(--bad)' }}>✗ {knowledge.error}</div>
        )}
        {knowledge && 'knowledgeMap' in knowledge && (
          <div style={{ fontSize: 12 }}>
            Strategy <strong>{knowledge.knowledgeMap.strategy.strategy}</strong>{' '}
            ({knowledge.knowledgeMap.strategy.primaryMode}).{' '}
            {Math.round(knowledge.knowledgeMap.decomposition.codifiableShare * 100)}% codifiable —{' '}
            {knowledge.knowledgeMap.toCodify.length} component(s) to content,{' '}
            {knowledge.knowledgeMap.toConnect.length} to flow.
            <div style={{ color: 'var(--text-dim)', marginTop: 3 }}>{knowledge.knowledgeMap.note}</div>
          </div>
        )}
      </Step>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', marginBottom: 6 }}>
        {n}. {title}
      </div>
      {children}
    </div>
  );
}

// ── Styling + helpers ───────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--text-dim)', textAlign: 'center', padding: '2px 6px',
};

function cellStyle(st: CellState | undefined, isSelected: boolean): React.CSSProperties {
  let border = '1px solid var(--border)';
  let bg = 'var(--panel-2)';
  if (st && typeof st === 'object' && 'plan' in st) {
    border = `1px solid ${st.plan.plan.contentWarranted ? 'var(--accent)' : 'var(--good)'}`;
  } else if (st && typeof st === 'object' && 'error' in st) {
    border = '1px solid var(--bad)';
  }
  if (isSelected) { bg = 'var(--panel)'; border = '2px solid var(--accent)'; }
  return {
    width: '100%', minWidth: 150, minHeight: 64, textAlign: 'left',
    padding: '8px 10px', borderRadius: 6, border, background: bg,
    cursor: 'pointer', color: 'var(--text)',
  };
}

function directionMeaning(d: Direction): string {
  return d === 'H2H' ? 'human authors for a human'
    : d === 'H2A' ? 'human authors doctrine an agent ingests'
    : d === 'A2H' ? 'an agent authors for a human'
    : 'an agent authors a playbook for another agent';
}
function regimeMeaning(r: Regime): string {
  return r === 'Evident' ? 'act→outcome is self-evident'
    : r === 'Knowable' ? 'act→outcome is discoverable by expertise'
    : r === 'Emergent' ? 'act→outcome coheres only in retrospect'
    : 'no stable act→outcome yet — stabilise first';
}

/** Representative knowledge components for a regime — drives /knowledge/map. */
function knowledgeComponentsFor(regime: Regime): Array<{ component: string; description: string }> {
  if (regime === 'Emergent' || regime === 'Turbulent') {
    return [
      { component: 'judged', description: 'reading a situation with no precedent' },
      { component: 'lived', description: 'pattern sense built only by exposure' },
    ];
  }
  return [
    { component: 'recorded', description: 'the documented procedure and tools' },
    { component: 'trained', description: 'the trainable skill the task needs' },
    { component: 'judged', description: 'knowing when the procedure does not apply' },
  ];
}
