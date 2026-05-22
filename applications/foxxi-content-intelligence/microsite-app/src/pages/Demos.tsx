/**
 * Demos — one page that showcases, explains, and lets you explore
 * every Foxxi capability, live against the deployed bridge.
 *
 * Each section: the principle (explain), an interactive panel that runs
 * the real thing against the live bridge / LMS / LRS (explore), and
 * links into the process doc + the CLI demo that verifies it.
 *
 * The page is built for an evaluator: every panel runs real calls, every
 * answer shows its provenance, and failures degrade to a plain message
 * rather than a blank box.
 */

import React, { useState } from 'react';
import { bridgeRest, BRIDGE_URL, DEMO_IDENTITIES } from '../bridge-client.js';
import { SAMPLE_COURSE, SAMPLE_JOB_AID } from '../../../src/sample-content.js';

const REPO = 'https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence';
const LEARNER = DEMO_IDENTITIES.joshua.webId;
const mono = "'JetBrains Mono', monospace";

// ── shared styles ───────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
  padding: 26, marginBottom: 22, boxShadow: 'var(--shadow)',
};
const btn: React.CSSProperties = {
  padding: '9px 17px', background: 'var(--text)', color: 'var(--panel)', border: 'none',
  borderRadius: 4, fontFamily: mono, fontSize: 12, fontWeight: 600,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
};
const resultBox: React.CSSProperties = {
  marginTop: 16, padding: 16, background: 'var(--panel-2)',
  borderLeft: '3px solid var(--accent)', borderRadius: 4,
  fontSize: 14, lineHeight: 1.6,
};
const chip: React.CSSProperties = {
  fontFamily: mono, fontSize: 11, padding: '4px 9px',
  borderRadius: 4, background: 'var(--panel-2)', border: '1px solid var(--border)',
  color: 'var(--text-dim)', cursor: 'pointer',
};
const selectStyle: React.CSSProperties = {
  padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)',
};
const labelStyle: React.CSSProperties = { fontSize: 12, fontFamily: mono, color: 'var(--text-dim)' };

function Busy() {
  return <>running<span className="blink">·</span><span className="blink">·</span><span className="blink">·</span></>;
}

/** A network/HTTP error, or null if the call succeeded. */
function errorOf(r: { status: number; json: Record<string, unknown> }): string | null {
  if (r.status === 0) return 'Could not reach the bridge — it may be cold-starting. Give it a moment and try again.';
  if (r.status >= 400) return String(r.json.error ?? `the bridge returned HTTP ${r.status}`);
  return null;
}

function ErrBox({ msg }: { msg: string }) {
  return (
    <div style={{ ...resultBox, borderColor: 'var(--bad)' }}>
      <b>That didn’t go through.</b> {msg}
    </div>
  );
}

// ── a demo section wrapper ──────────────────────────────────────────

function Section(props: {
  n: number; title: string; subtitle: string; principle: React.ReactNode;
  doc?: { label: string; href: string }; cli?: string; children: React.ReactNode;
}) {
  return (
    <article style={card}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 13, marginBottom: 12 }}>
        <div style={{
          width: 26, height: 26, borderRadius: '50%', background: 'var(--text)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          fontFamily: mono, fontSize: 12, fontWeight: 600,
        }}>{props.n}</div>
        <div>
          <div style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 23, lineHeight: 1.2 }}>
            {props.title}
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--text-dim)', marginTop: 2 }}>{props.subtitle}</div>
        </div>
      </header>
      <div style={{ fontSize: 15, lineHeight: 1.62, marginBottom: 18 }}>{props.principle}</div>
      {props.children}
      <footer style={{
        marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--border)',
        display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12, color: 'var(--text-dim)',
        fontFamily: mono,
      }}>
        {props.doc && <a href={props.doc.href} target="_blank" rel="noreferrer">{props.doc.label} →</a>}
        {props.cli && <span>verified by: <code>{props.cli}</code></span>}
      </footer>
    </article>
  );
}

// ── 1. Performance & Knowledge Architecture ─────────────────────────

const REGIMES: Array<{ v: string; label: string }> = [
  { v: 'Evident', label: 'Evident — the right response is self-evident' },
  { v: 'Knowable', label: 'Knowable — cause and effect are knowable with analysis' },
  { v: 'Emergent', label: 'Emergent — a complex, adaptive system' },
  { v: 'Turbulent', label: 'Turbulent — behaviour is not yet patterned' },
];
const METHOD_LABEL: Record<string, string> = {
  'apply-practice': 'apply the established practice',
  'gap-analysis': 'cause-factor gap analysis',
  'dispositional-read': 'a dispositional read',
  'stabilise-first': 'stabilise first',
};

// Within a gap-analysis regime the gap still has a CAUSE, and the cause —
// not the regime — decides the intervention. Each option carries the
// evidence that isolates that one factor; only a genuine knowledge or
// skill deficiency routes to a course.
const CAUSES: Array<{
  v: string; label: string;
  factorEvidence: Record<string, { adequate: boolean; evidence: string }>;
  couldPerform?: boolean;
}> = [
  {
    v: 'knowledgeSkill', label: 'Knowledge & skill — the rep genuinely cannot do it',
    factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'reps cannot recall the refund decision tree, even given time and intent' } },
    couldPerform: false,
  },
  {
    v: 'information', label: 'Information — guidance is not at hand when work happens',
    factorEvidence: { information: { adequate: false, evidence: 'the refund policy is not surfaced at the moment a dispute opens' } },
  },
  {
    v: 'instrumentation', label: 'Tools & process — the instrumentation is broken',
    factorEvidence: { instrumentation: { adequate: false, evidence: 'the refund console does not show the rolling 90-day cap total' } },
  },
  {
    v: 'incentives', label: 'Incentives — the consequences pull the wrong way',
    factorEvidence: { incentives: { adequate: false, evidence: 'reps are measured on handle time, which rewards over-escalation' } },
  },
  {
    v: 'motives', label: 'Motivation — the rep can perform but is not choosing to',
    factorEvidence: { motives: { adequate: false, evidence: 'the rep resolves easy disputes but routes harder in-tier ones away' } },
    couldPerform: true,
  },
];

function PerformanceDemo() {
  const [regime, setRegime] = useState('Knowable');
  const [cause, setCause] = useState('knowledgeSkill');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  // Only the Knowable regime frames the work as a gap — establishing an
  // exemplary state and analysing the cause of the difference. The other
  // regimes never name a gap, so the cause selector is shown for Knowable
  // alone.
  const knowable = regime === 'Knowable';
  async function run() {
    setBusy(true); setErr(null);
    const picked = CAUSES.find(c => c.v === cause);
    const r = await bridgeRest('/performance/plan', {
      situation: {
        id: `urn:foxxi:situation:demo-${Date.now()}`,
        performer: { id: LEARNER, kind: 'human', role: 'support rep' },
        workContext: 'resolving customer refund disputes',
        competency: 'resolving refund disputes within policy',
        observed: 'over-escalates disputes a rep is allowed to resolve',
        frequency: 'continuous', criticality: 'moderate', modalStatus: 'Asserted', domain: regime,
      },
      // The exemplary state and the cause evidence exist only because the
      // work contextualizes into the Knowable regime.
      ...(knowable && picked ? {
        exemplary: 'resolves in-policy disputes on first contact',
        factorEvidence: picked.factorEvidence,
        ...(picked.couldPerform !== undefined ? { couldPerformUnderIdealConditions: picked.couldPerform } : {}),
      } : {}),
      author: { id: 'did:web:acme#sme-lee', kind: 'human', role: 'SME' },
    });
    const e = errorOf(r);
    if (e) { setErr(e); setOut(null); } else { setOut(r.json); }
    setBusy(false);
  }
  const diagnosis = out?.diagnosis as { domain?: string; method?: string; reasoning?: string[]; rootCauses?: string[]; caveat?: string } | undefined;
  const plan = out?.plan as { summary?: string; selected?: Array<{ type: string }> } | undefined;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={labelStyle}>
          work regime:{' '}
          <select value={regime} onChange={e => setRegime(e.target.value)} style={selectStyle}>
            {REGIMES.map(r => <option key={r.v} value={r.v}>{r.label}</option>)}
          </select>
        </label>
        {knowable && (
          <label style={labelStyle}>
            likely cause:{' '}
            <select value={cause} onChange={e => setCause(e.target.value)} style={selectStyle}>
              {CAUSES.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
            </select>
          </label>
        )}
        <button style={btn} onClick={run} disabled={busy}>{busy ? <Busy /> : 'Contextualize this work'}</button>
      </div>
      {!knowable && (
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 8 }}>
          Only the Knowable regime frames the work as a gap and analyses a cause. The {regime} regime’s
          method follows from the regime itself — there is no gap to close.
        </div>
      )}
      {err && <ErrBox msg={err} />}
      {diagnosis && (
        <div style={resultBox}>
          <div style={{ fontFamily: mono, fontSize: 13 }}>
            work regime <b>{diagnosis.domain}</b> → method: <b>{METHOD_LABEL[diagnosis.method ?? ''] ?? diagnosis.method}</b>
          </div>
          {diagnosis.reasoning?.[0] && <div style={{ marginTop: 8 }}>{diagnosis.reasoning[0]}</div>}
          {knowable && diagnosis.rootCauses?.[0] && (
            <div style={{ marginTop: 8 }}>cause isolated: <b>{diagnosis.rootCauses[0]}</b></div>
          )}
          {diagnosis.caveat && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--warn)' }}>{diagnosis.caveat}</div>}
          {plan?.summary && <div style={{ marginTop: 8 }}><b>Plan:</b> {plan.summary}</div>}
          {plan?.selected && plan.selected.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 13 }}>interventions: {plan.selected.map(o => o.type).join(', ')}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 2. The performance portfolio ────────────────────────────────────

// A realistic spread of support-org performance situations — five
// different causes across the Knowable regime, plus one Emergent. An
// exemplary state is set only on the Knowable situations; the Emergent
// one has none — there is no ideal to close toward. The point an
// enterprise should take away: most of these are not training gaps.
const PORTFOLIO_AUTHOR = { id: 'did:web:acme#sme-lee', kind: 'human', role: 'SME' };
const PORTFOLIO_SITUATIONS = [
  {
    situation: {
      performer: { id: LEARNER, kind: 'human', role: 'support rep' },
      workContext: 'resolving customer refund disputes',
      competency: 'resolving refund disputes within policy',
      observed: 'over-escalates disputes a rep is allowed to resolve',
      frequency: 'continuous', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
    },
    exemplary: 'resolves in-policy disputes on first contact',
    factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'reps cannot recall the refund decision tree, even given time' } },
    couldPerformUnderIdealConditions: false,
  },
  {
    situation: {
      performer: { id: LEARNER, kind: 'human', role: 'support rep' },
      workContext: 'applying the rolling 90-day refund cap',
      competency: 'catching customers past the rolling cap',
      observed: 'misses cap breaches on small refunds',
      frequency: 'frequent', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
    },
    exemplary: 'catches every customer over the cap',
    factorEvidence: { instrumentation: { adequate: false, evidence: 'the refund console does not surface the rolling-cap total' } },
  },
  {
    situation: {
      performer: { id: LEARNER, kind: 'human', role: 'support rep' },
      workContext: 'choosing whether to resolve or escalate a dispute',
      competency: 'resolving in-tier disputes directly',
      observed: 'escalates resolvable disputes to protect handle time',
      frequency: 'continuous', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
    },
    exemplary: 'resolves disputes within their authority',
    factorEvidence: { incentives: { adequate: false, evidence: 'reps are measured on handle time, which rewards over-escalation' } },
  },
  {
    situation: {
      performer: { id: LEARNER, kind: 'human', role: 'support rep' },
      workContext: 'escalating a dispute under the revised policy',
      competency: 'escalating with a complete case packet',
      observed: 'sends bare hand-offs the lead must re-investigate',
      frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
    },
    exemplary: 'escalates with facts, severity, and a recommendation',
    factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'the escalation policy changed last month; the habit is not built' } },
    couldPerformUnderIdealConditions: false,
  },
  {
    situation: {
      performer: { id: LEARNER, kind: 'human', role: 'support rep' },
      workContext: 'handling difficult, high-emotion refund disputes',
      competency: 'resolving difficult disputes rather than routing them away',
      observed: 'routes difficult disputes away despite being able to resolve them',
      frequency: 'frequent', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
    },
    exemplary: 'takes difficult disputes within their authority',
    factorEvidence: { motives: { adequate: false, evidence: 'the rep can resolve difficult disputes but avoids the discomfort' } },
    couldPerformUnderIdealConditions: true,
  },
  {
    situation: {
      performer: { id: 'did:web:acme#support-agent-pool', kind: 'agent', role: 'support agent team' },
      workContext: 'a team of support agents coordinating during a live incident',
      competency: 'coordinating multi-agent incident response',
      observed: 'agents duplicate work and miss handoffs under load',
      frequency: 'occasional', criticality: 'high', modalStatus: 'Asserted', domain: 'Emergent',
    },
  },
];

interface PortfolioEntry {
  workContext: string; regime: string; rootCause: string | null;
  interventions: string[]; contentWarranted: boolean;
}

function PortfolioDemo() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    const r = await bridgeRest('/performance/portfolio', { situations: PORTFOLIO_SITUATIONS, author: PORTFOLIO_AUTHOR });
    const e = errorOf(r);
    if (e) { setErr(e); setOut(null); } else { setOut(r.json); }
    setBusy(false);
  }
  const portfolio = out?.portfolio as {
    entries?: number; contentVsNonContent?: { content: number; nonContent: number }; readout?: string;
  } | undefined;
  const entries = (out?.entries as PortfolioEntry[] | undefined) ?? [];
  const total = portfolio?.entries ?? 0;
  const content = portfolio?.contentVsNonContent?.content ?? 0;
  const courses = entries.filter(e => e.interventions.includes('instruction')).length;
  const stat = (n: number | string, label: string) => (
    <div style={{ flex: '1 1 110px', textAlign: 'center', padding: '10px 8px',
      background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6 }}>
      <div style={{ fontFamily: "'EB Garamond', serif", fontSize: 30, lineHeight: 1 }}>{n}</div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{label}</div>
    </div>
  );
  return (
    <div>
      <button style={btn} onClick={run} disabled={busy}>{busy ? <Busy /> : out ? 'Re-diagnose' : 'Diagnose the portfolio'}</button>
      {err && <ErrBox msg={err} />}
      {portfolio && (
        <div style={resultBox}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {stat(total, 'gaps diagnosed')}
            {stat(content, 'need content of any kind')}
            {stat(courses, courses === 1 ? 'needs a course' : 'need a course')}
            {stat(total - content, 'need no content at all')}
          </div>
          {portfolio.readout && <div style={{ marginTop: 12 }}>{portfolio.readout}</div>}
          <div style={{ marginTop: 12 }}>
            {entries.map((e, i) => {
              const isCourse = e.interventions.includes('instruction');
              const badge = isCourse ? 'course'
                : e.contentWarranted ? 'content · no course' : 'no content';
              const badgeColor = isCourse ? 'var(--accent)'
                : e.contentWarranted ? 'var(--warn)' : 'var(--text-dim)';
              return (
                <div key={i} style={{
                  display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0',
                  borderTop: '1px solid var(--border)',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13 }}>{e.workContext}</div>
                    <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                      {e.regime} regime · {e.interventions.join(', ')}
                      {e.rootCause ? ` · ${e.rootCause.split(' — ')[0]}` : ''}
                    </div>
                  </div>
                  <span style={{
                    fontFamily: mono, fontSize: 10, padding: '2px 7px', borderRadius: 3,
                    border: `1px solid ${badgeColor}`, color: badgeColor, whiteSpace: 'nowrap',
                  }}>{badge}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 3. Closing the loop ─────────────────────────────────────────────

function ClosingLoopDemo() {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null); setLaunchUrl(null); setOut(null);
    // The shared sample course — three modules, six lessons, each fragment
    // a real concept / worked example / assessment item.
    const composed = await bridgeRest('/content/compose-course', {
      ...SAMPLE_COURSE,
      title: `${SAMPLE_COURSE.title} ${new Date().toISOString().slice(11, 19)}`,
    });
    const ce = errorOf(composed);
    if (ce || !composed.json.course) { setErr(ce ?? 'compose-course returned no course'); setBusy(false); return; }
    const pub = await bridgeRest('/content/publish-course', { course: composed.json.course });
    const pe = errorOf(pub);
    if (pe || pub.json.published !== true) { setErr(pe ?? 'publish-course did not confirm publication'); setBusy(false); return; }
    setOut(pub.json); setBusy(false);
  }

  // Launch the lesson properly — a cmi5 launch mints the one-time fetch
  // token + endpoint params the AU needs; opening the bare AU URL would
  // only get "preview only". A blank window is opened in the click
  // gesture, then navigated once the launch URL is back.
  async function launch(courseId: string, auId: string) {
    const w = window.open('', '_blank');
    try {
      const r = await fetch(`${BRIDGE_URL}/cmi5/launch?course_id=${encodeURIComponent(courseId)}`
        + `&au_id=${encodeURIComponent(auId)}&learner=${encodeURIComponent(LEARNER)}&learner_name=Joshua%20Liu`);
      const lj = await r.json() as { launchUrl?: string };
      if (lj.launchUrl && w) w.location.href = lj.launchUrl;
      else if (lj.launchUrl) setLaunchUrl(lj.launchUrl);
      else { if (w) w.close(); setErr('the cmi5 LMS did not issue a launch'); }
    } catch (e) { if (w) w.close(); setErr((e as Error).message); }
  }

  const aus = (out?.aus as Array<{ title: string; auId: string }> | undefined) ?? [];
  const artifacts = out?.artifacts as { cmi5Xml?: string; scormZip?: string } | undefined;
  const courseId = out?.courseId as string | undefined;
  return (
    <div>
      <button style={btn} onClick={run} disabled={busy}>{busy ? <Busy /> : out ? 'Re-run' : 'Compose & publish a course'}</button>
      {err && <ErrBox msg={err} />}
      {out?.published === true && (
        <div style={resultBox}>
          <div><b>Published + registered on the cmi5 LMS</b> — <code>{String(out.publishId)}</code></div>
          <div style={{ marginTop: 8 }}><b>Generated artifacts</b> (real, conformant):</div>
          <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
            {artifacts?.cmi5Xml && <li><a href={artifacts.cmi5Xml} target="_blank" rel="noreferrer">cmi5.xml course structure</a></li>}
            {artifacts?.scormZip && <li><a href={artifacts.scormZip} target="_blank" rel="noreferrer">SCORM 2004 .zip package</a></li>}
          </ul>
          <div style={{ marginTop: 8 }}><b>Launch the lesson</b> — a fresh cmi5 launch each click; the AU
            exchanges its one-time fetch token, renders, and emits xAPI to the live LRS when you complete it:</div>
          <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {courseId && aus.map((au, i) => (
              <button key={i} style={chip} onClick={() => launch(courseId, au.auId)}>▶ Launch “{au.title}”</button>
            ))}
          </div>
          {launchUrl && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              popup blocked — <a href={launchUrl} target="_blank" rel="noreferrer">open the launched lesson →</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 4. The Context Companion ────────────────────────────────────────

const COMPANION_CHIPS = [
  'How should I triage an incident?',
  'How do I handle a refund over $500?',
  'What does the refund authority threshold mean?',
  'Do I have anything about golf?',
];

// The agentic-RAG trace: each step is a named graph in the substrate,
// carrying a modal status and what it was derived from.
const TRACE_STEP: Record<string, { label: string; describe: (b: Record<string, unknown>) => string }> = {
  'fxa:LearnerQuestionEvent': {
    label: 'Question', describe: () => 'the asked question, recorded as a committed event',
  },
  'fxa:RetrievalActivity': {
    label: 'Retrieval',
    describe: b => `graph retrieval — ${(b.seedConcepts as unknown[] | undefined)?.length ?? 0} concept(s) seeded, `
      + `${b.expandedConceptCount ?? 0} expanded, ${(b.citedSlideIds as unknown[] | undefined)?.length ?? 0} slide(s) cited`,
  },
  'fxa:LlmCompletion': {
    label: 'Synthesis',
    describe: b => `model synthesis${b.model ? ` (${b.model})` : ''} — tentative until grounded in cited sources`,
  },
  'fxa:CitedAnswer': {
    label: 'Cited answer', describe: () => 'the answer of record, grounded in cited sources',
  },
};
const MODAL_STYLE: Record<string, React.CSSProperties> = {
  Asserted: { color: '#1a7f37', borderColor: '#1a7f37' },
  Hypothetical: { color: '#b06f00', borderColor: '#b06f00' },
};

interface TraceStep {
  type: string; modalStatus: string; supersedes?: string; graphIri?: string;
  body?: Record<string, unknown>;
}

function TraceView({ trace }: { trace: TraceStep[] }) {
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div className="label">verifiable provenance — each step a named graph in the substrate</div>
      <div style={{ marginTop: 4 }}>
        {trace.map((s, i) => {
          const meta = TRACE_STEP[s.type] ?? { label: s.type, describe: () => '' };
          const modal = MODAL_STYLE[s.modalStatus] ?? { color: 'var(--text-dim)', borderColor: 'var(--border)' };
          return (
            <div key={i} style={{
              display: 'flex', gap: 9, alignItems: 'flex-start', padding: '6px 0',
              borderTop: i > 0 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-dim)', width: 12, flexShrink: 0 }}>{i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{meta.label}</span>
                  <span style={{
                    fontFamily: mono, fontSize: 10, padding: '1px 6px', borderRadius: 3,
                    border: '1px solid', ...modal,
                  }}>{s.modalStatus}</span>
                  {s.supersedes && (
                    <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--text-dim)' }}>
                      cg:supersedes the raw model output
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 1 }}>{meta.describe(s.body ?? {})}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompanionDemo() {
  const [q, setQ] = useState(COMPANION_CHIPS[0]);
  const [scope, setScope] = useState<'interego' | 'vertical'>('interego');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  async function ask() {
    setBusy(true); setErr(null);
    const r = await bridgeRest('/content/ask', { question: q, scope, learner: LEARNER }, 'joshua');
    const e = errorOf(r);
    if (e) { setErr(e); setOut(null); } else { setOut(r.json); }
    setBusy(false);
  }
  const sources = (out?.sources as Array<{ kind: string; locator: string }> | undefined) ?? [];
  const trace = (out?.trace as TraceStep[] | undefined) ?? [];
  const summary = out?.contextSummary as { interegoDescriptors?: number; interegoPods?: string[] } | undefined;
  const grounded = out?.grounded === true;
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {COMPANION_CHIPS.map(c => (
          <button key={c} style={chip} onClick={() => setQ(c)}>{c}</button>
        ))}
      </div>
      <textarea value={q} onChange={e => setQ(e.target.value)} rows={2}
        style={{ width: '100%', padding: 10, borderRadius: 4, border: '1px solid var(--border)', fontSize: 13, resize: 'vertical' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
        <button style={btn} onClick={ask} disabled={busy || !q.trim()}>{busy ? <Busy /> : 'Ask'}</button>
        <label style={labelStyle}>
          scope:{' '}
          <select value={scope} onChange={e => setScope(e.target.value as 'interego' | 'vertical')} style={selectStyle}>
            <option value="interego">interego (whole networked context)</option>
            <option value="vertical">vertical (Foxxi slice only)</option>
          </select>
        </label>
      </div>
      {err && <ErrBox msg={err} />}
      {out && (
        <div style={resultBox}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{String(out.answer ?? '')}</div>
          <div style={{ marginTop: 10, fontSize: 12, fontFamily: mono, color: 'var(--text-dim)' }}>
            intent: <b>{String(out.intent ?? '—')}</b> · scope: <b>{String(out.scope ?? '—')}</b> ·
            grounded: <b>{String(grounded)}</b>
            {summary?.interegoPods && summary.interegoPods.length > 0 &&
              <> · federated across <b>{summary.interegoPods.length}</b> pod(s), <b>{summary.interegoDescriptors ?? 0}</b> descriptor(s)</>}
          </div>
          {sources.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="label">sourced from</div>
              {sources.map((s, i) => (
                <div key={i} style={{ fontSize: 12.5, marginTop: 3 }}>
                  <span style={{
                    fontFamily: mono, fontSize: 10, padding: '1px 5px',
                    borderRadius: 3, background: 'var(--panel)', border: '1px solid var(--border)',
                  }}>{s.kind}</span>{' '}{s.locator}
                </div>
              ))}
            </div>
          )}
          {trace.length > 0 && <TraceView trace={trace} />}
        </div>
      )}
    </div>
  );
}

// ── 5. Content forms ────────────────────────────────────────────────

// The shared sample job aid, rendered section by section so the
// interactive form has real collapsible sections, plus one self-check
// drawn from the course's assessment items.
const FORM_UNIT = {
  title: `Job aid — ${SAMPLE_JOB_AID.competencyPoint}`,
  kind: 'job-aid',
  competency: SAMPLE_JOB_AID.competencyPoint,
  blocks: [
    ...SAMPLE_JOB_AID.body.split('\n\n').map(section => ({
      label: section.split('\n')[0].split(' — ')[0].split(' when')[0].trim(),
      text: section,
    })),
    { label: 'self-check', text: SAMPLE_COURSE.modules[0].lessons[0].fragments[2].body },
  ],
};
const FORMS: Array<{ v: string; label: string }> = [
  { v: 'plain', label: 'plain text' },
  { v: 'markdown', label: 'markdown' },
  { v: 'html', label: 'static HTML hypertext' },
  { v: 'interactive', label: 'interactive hypermedia' },
];

function FormsDemo() {
  const [form, setForm] = useState('interactive');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  async function render() {
    setBusy(true); setErr(null);
    const r = await bridgeRest('/content/deliver', { unit: FORM_UNIT, channel: 'document', form });
    const e = errorOf(r);
    if (e) { setErr(e); setOut(null); } else { setOut(r.json); }
    setBusy(false);
  }
  const rendering = out?.rendering as { form?: string; mediaType?: string; body?: string } | undefined;
  const isHtml = rendering?.mediaType === 'text/html';
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={labelStyle}>
          form:{' '}
          <select value={form} onChange={e => setForm(e.target.value)} style={selectStyle}>
            {FORMS.map(f => <option key={f.v} value={f.v}>{f.label}</option>)}
          </select>
        </label>
        <button style={btn} onClick={render} disabled={busy}>{busy ? <Busy /> : 'Render this job aid'}</button>
      </div>
      {err && <ErrBox msg={err} />}
      {rendering?.body && (
        <div style={resultBox}>
          <div style={{ fontSize: 12, fontFamily: mono, color: 'var(--text-dim)', marginBottom: 8 }}>
            rendered as <b>{rendering.form}</b> ({rendering.mediaType})
          </div>
          {isHtml ? (
            <iframe srcDoc={rendering.body} sandbox="allow-scripts" title="rendered content"
              style={{ width: '100%', height: 320, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }} />
          ) : (
            <pre style={{
              margin: 0, padding: 12, background: '#1a2332', color: '#f5efe2', borderRadius: 6,
              fontSize: 11.5, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto',
            }}>{rendering.body}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── hero + closing ──────────────────────────────────────────────────

function Hero() {
  return (
    <div style={{ marginBottom: 30 }}>
      <div className="label">Foxxi · live demos</div>
      <h1 style={{
        fontFamily: "'EB Garamond', serif", fontWeight: 500, fontSize: 38, lineHeight: 1.15, margin: '8px 0 12px',
      }}>One page. Every demo. Run it yourself.</h1>
      <p style={{ fontSize: 17, lineHeight: 1.6, color: 'var(--text)', maxWidth: 680 }}>
        Each section explains a Foxxi capability and runs the real thing — live against the deployed
        bridge, LMS and LRS. Nothing is mocked. What an enterprise evaluator should look for is here
        too: every answer carries a verifiable provenance trace, discovery federates across
        independently-operated pods, the LMS/LRS surfaces are standards-conformant, and a learner’s
        own record is gated to a wallet-signed identity. Follow the links for the full process record
        and the CLI suite that verifies each one.
      </p>
    </div>
  );
}

function Closing({ onHome }: { onHome: () => void }) {
  return (
    <div style={{ ...card, background: 'var(--panel-2)' }}>
      <div style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 21, marginBottom: 8 }}>
        The whole picture
      </div>
      <p style={{ fontSize: 14.5, lineHeight: 1.62, margin: '0 0 12px' }}>
        These demos compose one substrate. Performance reasoning is routed by the work regime, and a
        portfolio shows how rarely the answer is a course; where the regime does call for instruction,
        a real course is generated, delivered, and completed on a conformant LMS/LRS; the Context
        Companion chats over the whole networked context — gated to a wallet-signed identity, federated
        across pods, every answer carrying its provenance trace — and content travels in whatever text
        form the situation calls for. The same capabilities span humans and agents (H2H · H2A · A2H ·
        A2A); the agent-collaboration tour lives in the operational dashboard.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, fontFamily: mono }}>
        <a href={`${REPO}/CONFORMANCE.md`} target="_blank" rel="noreferrer">LRS / LMS conformance →</a>
        <a href={`${REPO}/PERFORMANCE-ARCHITECTURE.md`} target="_blank" rel="noreferrer">Performance Architecture →</a>
        <a href="https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io" target="_blank" rel="noreferrer">Operational dashboard →</a>
        <button onClick={onHome} style={{ ...chip, cursor: 'pointer' }}>← back to the site</button>
      </div>
    </div>
  );
}

// ── the page ────────────────────────────────────────────────────────

export function Demos({ onHome }: { onHome: () => void }) {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '34px 24px 40px' }}>
      <Hero />

      <Section n={1} title="Performance & Knowledge Architecture"
        subtitle="contextualize the work first — only the Knowable regime frames it as a gap"
        principle={<>The system reasons from performance, not content. The universal first step is to{' '}
          <b>contextualize</b> a performance situation — read its <b>regime</b>, the kind of work it
          is — and route to that regime's method. Idealising an exemplary future state, naming the gap
          to observed performance, and closing it is the method of <b>one</b> regime, the Knowable
          regime — not a universal frame. Evident work applies the established practice. Emergent work —
          a complex, adaptive system — gets a dispositional read: no exemplary state exists, so there
          is no gap. Turbulent work is stabilised first. Within the Knowable regime the gap has a{' '}
          <b>cause</b>, and the cause — not the regime — decides the intervention: missing knowledge,
          absent guidance, broken tools, misaligned incentives, or low motivation, and only one of
          those, a genuine knowledge or skill deficiency, is answered by a course. Pick a regime, and
          (for a Knowable one) a cause, and watch the method and the intervention change.</>}
        doc={{ label: 'PERFORMANCE-ARCHITECTURE.md', href: `${REPO}/PERFORMANCE-ARCHITECTURE.md` }}
        cli="tools/performance-architecture-example.mjs">
        <PerformanceDemo />
      </Section>

      <Section n={2} title="The performance portfolio"
        subtitle="contextualize a set of situations at once — most are not training gaps"
        principle={<>One situation is an anecdote; a portfolio is the business case. Contextualize a
          realistic spread of performance situations and roll them up. A performance-driven practice
          routes most of them to <b>non-content interventions</b> — a broken tool, a misaligned
          incentive, an Emergent-regime team — because no course fixes those. The headline number is
          how few situations actually need a course. This is the read a head of L&amp;D uses to defend
          a budget.</>}
        doc={{ label: 'PERFORMANCE-ARCHITECTURE.md', href: `${REPO}/PERFORMANCE-ARCHITECTURE.md` }}
        cli="tools/performance-architecture-example.mjs">
        <PortfolioDemo />
      </Section>

      <Section n={3} title="Closing the loop"
        subtitle="where the regime calls for instruction, a real course on the LMS"
        principle={<>When the analysis warrants instruction, an emergent course is composed and turned
          into deployable artifacts — a <b>cmi5 package</b> and a conformant <b>SCORM 2004 .zip</b> —
          registered on the LMS. Open a runnable lesson: it does the cmi5 handshake and emits xAPI
          straight to the live LRS.</>}
        doc={{ label: 'CLOSING-THE-LOOP.md', href: `${REPO}/CLOSING-THE-LOOP.md` }}
        cli="tools/closed-loop-example.mjs">
        <ClosingLoopDemo />
      </Section>

      <Section n={4} title="The Context Companion"
        subtitle="one chat front door over a user's whole networked context — with a provenance trace"
        principle={<>A human or agent just asks. The companion classifies intent, answers from the
          substrate's own surfaces, and <b>sources every claim</b>. Scope <code>interego</code>
          federates discovery across pods (Interego passes through to what composes it);{' '}
          <code>vertical</code> narrows to the Foxxi slice. Progress / assignment questions are gated
          to a wallet-signed identity — this panel is authed as a demo learner. Every answer carries a{' '}
          <b>verifiable provenance trace</b>: each step a named graph with a modal status — Asserted
          (committed) or Hypothetical (tentative) — and the cited answer supersedes the raw model
          output.</>}
        doc={{ label: 'ASKING-YOUR-CONTEXT.md', href: `${REPO}/ASKING-YOUR-CONTEXT.md` }}
        cli="tools/ask-your-context-example.mjs">
        <CompanionDemo />
      </Section>

      <Section n={5} title="Content in any form"
        subtitle="text — plain, markdown, hypertext, or interactive hypermedia"
        principle={<>The content is text, but text takes many forms, and the right one is a composition
          choice. The same job aid renders as plain text, markdown, static HTML hypertext, or a
          self-contained <b>interactive hypermedia</b> artifact — collapsible sections and an inline
          self-check. Pick a form and see it rendered live. No media is generated; every form is text.</>}
        doc={{ label: 'ASKING-YOUR-CONTEXT.md §6', href: `${REPO}/ASKING-YOUR-CONTEXT.md` }}
        cli="tools/content-forms-smoke.ts">
        <FormsDemo />
      </Section>

      <Closing onHome={onHome} />
    </div>
  );
}
