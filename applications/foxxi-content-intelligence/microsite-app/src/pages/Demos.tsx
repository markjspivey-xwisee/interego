/**
 * Demos — one page that showcases, explains, and lets you explore
 * every Foxxi capability, live against the deployed bridge.
 *
 * Each section: the principle (explain), an interactive panel that runs
 * the real thing against the live bridge / LMS / LRS (explore), and
 * links into the process doc + the CLI demo that verifies it.
 */

import React, { useState } from 'react';
import { bridgeRest, BRIDGE_URL, DEMO_IDENTITIES } from '../bridge-client.js';

const REPO = 'https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence';
const LEARNER = DEMO_IDENTITIES.joshua.webId;

// ── shared styles ───────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
  padding: 26, marginBottom: 22, boxShadow: 'var(--shadow)',
};
const btn: React.CSSProperties = {
  padding: '9px 17px', background: 'var(--text)', color: 'var(--panel)', border: 'none',
  borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
};
const resultBox: React.CSSProperties = {
  marginTop: 16, padding: 16, background: 'var(--panel-2)',
  borderLeft: '3px solid var(--accent)', borderRadius: 4,
  fontSize: 14, lineHeight: 1.6,
};
const chip: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: '4px 9px',
  borderRadius: 4, background: 'var(--panel-2)', border: '1px solid var(--border)',
  color: 'var(--text-dim)', cursor: 'pointer',
};

function Busy() {
  return <>running<span className="blink">·</span><span className="blink">·</span><span className="blink">·</span></>;
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
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600,
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
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        {props.doc && <a href={props.doc.href} target="_blank" rel="noreferrer">{props.doc.label} →</a>}
        {props.cli && <span>verified by: <code>{props.cli}</code></span>}
      </footer>
    </article>
  );
}

// ── 1. Performance & Knowledge Architecture ─────────────────────────

function DiagnoseDemo() {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  async function run() {
    setBusy(true);
    const r = await bridgeRest('/performance/plan', {
      gap: {
        id: `urn:foxxi:gap:demo-${Date.now()}`,
        performer: { id: LEARNER, kind: 'human', role: 'support rep' },
        workContext: 'resolving customer refund disputes',
        competency: 'resolving refund disputes within policy',
        desired: 'resolves in-policy disputes on first contact',
        observed: 'over-escalates disputes a rep is allowed to resolve',
        frequency: 'continuous', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
      },
      couldPerformUnderIdealConditions: false,
      factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'reps cannot recall the refund decision tree' } },
      author: { id: 'did:web:acme#sme-lee', kind: 'human', role: 'SME' },
    });
    setOut(r.json); setBusy(false);
  }
  const diagnosis = out?.diagnosis as { method?: string } | undefined;
  const plan = out?.plan as { summary?: string; selected?: Array<{ type: string }> } | undefined;
  return (
    <div>
      <button style={btn} onClick={run} disabled={busy}>{busy ? <Busy /> : out ? 'Re-run' : 'Diagnose a real gap'}</button>
      {out && (
        <div style={resultBox}>
          {plan ? <>
            <div><b>Diagnosis method:</b> {diagnosis?.method ?? '—'}</div>
            <div style={{ marginTop: 6 }}><b>Plan:</b> {plan.summary ?? '—'}</div>
            <div style={{ marginTop: 6 }}><b>Interventions selected:</b>{' '}
              {(plan.selected ?? []).map(o => o.type).join(', ') || 'none'}</div>
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-dim)' }}>
              A performance gap was diagnosed and an intervention plan composed — content is one
              option among nine, selected only when the diagnosis warrants it.
            </div>
          </> : <span style={{ color: 'var(--bad)' }}>{JSON.stringify(out).slice(0, 200)}</span>}
        </div>
      )}
    </div>
  );
}

// ── 2. Closing the loop ─────────────────────────────────────────────

function ClosingLoopDemo() {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null); setLaunchUrl(null); setOut(null);
    const composed = await bridgeRest('/content/compose-course', {
      title: `Refund Dispute Resolution ${new Date().toISOString().slice(11, 19)}`,
      competency: 'resolving refund disputes within policy', audience: 'human',
      authoredBy: { id: 'did:web:acme#sme-lee', kind: 'human' },
      modules: [{
        title: 'Refund basics', competencyPoint: 'resolving refund disputes within policy',
        lessons: [
          { title: 'Authority thresholds', competencyPoint: 'refund thresholds', fragments: [
            { modality: 'concept', body: 'A rep may authorise refunds up to $500; above that, route the dispute to a lead.', level: 'foundational' },
            { modality: 'worked-example', body: 'A $420 dispute — the rep resolves it. A $1,300 dispute — route to a lead.', level: 'working' },
          ] },
        ],
      }],
    });
    const course = composed.json.course;
    if (!course) { setErr('compose-course failed'); setBusy(false); return; }
    const pub = await bridgeRest('/content/publish-course', { course });
    if (pub.json.published !== true) { setErr('publish-course failed'); setBusy(false); return; }
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
      else { if (w) w.close(); setErr('cmi5 launch failed'); }
    } catch (e) { if (w) w.close(); setErr((e as Error).message); }
  }

  const aus = (out?.aus as Array<{ title: string; auId: string }> | undefined) ?? [];
  const artifacts = out?.artifacts as { cmi5Xml?: string; scormZip?: string } | undefined;
  const courseId = out?.courseId as string | undefined;
  return (
    <div>
      <button style={btn} onClick={run} disabled={busy}>{busy ? <Busy /> : out ? 'Re-run' : 'Compose & publish a course'}</button>
      {err && <div style={{ ...resultBox, borderColor: 'var(--bad)' }}>{err}</div>}
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

// ── 3. The Context Companion ────────────────────────────────────────

const COMPANION_CHIPS = [
  'How should I triage an incident?',
  'Do I have anything about golf?',
  'What does the refund authority threshold mean?',
];

function CompanionDemo() {
  const [q, setQ] = useState(COMPANION_CHIPS[0]);
  const [scope, setScope] = useState<'interego' | 'vertical'>('interego');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  async function ask() {
    setBusy(true);
    const r = await bridgeRest('/content/ask', { question: q, scope, learner: LEARNER }, 'joshua');
    setOut(r.json); setBusy(false);
  }
  const sources = (out?.sources as Array<{ kind: string; locator: string }> | undefined) ?? [];
  const summary = out?.contextSummary as { courses?: number; interegoDescriptors?: number; interegoPods?: string[] } | undefined;
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
        <label style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-dim)' }}>
          scope:{' '}
          <select value={scope} onChange={e => setScope(e.target.value as 'interego' | 'vertical')}
            style={{ padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)' }}>
            <option value="interego">interego (whole networked context)</option>
            <option value="vertical">vertical (Foxxi slice only)</option>
          </select>
        </label>
      </div>
      {out && (
        <div style={resultBox}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{String(out.answer ?? out.error ?? '')}</div>
          <div style={{ marginTop: 10, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-dim)' }}>
            intent: <b>{String(out.intent ?? '—')}</b> · scope: <b>{String(out.scope ?? '—')}</b> ·
            grounded: <b>{String(out.grounded)}</b>
            {summary?.interegoPods && summary.interegoPods.length > 0 &&
              <> · federated across <b>{summary.interegoPods.length}</b> pod(s)</>}
          </div>
          {sources.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="label">sourced from</div>
              {sources.map((s, i) => (
                <div key={i} style={{ fontSize: 12.5, marginTop: 3 }}>
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 10, padding: '1px 5px',
                    borderRadius: 3, background: 'var(--panel)', border: '1px solid var(--border)',
                  }}>{s.kind}</span>{' '}{s.locator}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 4. Content forms ────────────────────────────────────────────────

const FORM_UNIT = {
  title: 'Refund threshold job aid', kind: 'job-aid', competency: 'refund thresholds',
  blocks: [
    { label: 'The rule', text: 'A rep may authorise refunds up to $500; above that, route the dispute to a lead.' },
    { label: 'Worked example', text: 'A $420 dispute — the rep resolves it. A $1,300 dispute — route to a lead.' },
    { text: 'Up to what amount may a rep authorise a refund alone? ::: $500' },
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
  const [out, setOut] = useState<Record<string, unknown> | null>(null);
  async function render() {
    setBusy(true);
    const r = await bridgeRest('/content/deliver', { unit: FORM_UNIT, channel: 'document', form });
    setOut(r.json); setBusy(false);
  }
  const rendering = out?.rendering as { form?: string; mediaType?: string; body?: string } | undefined;
  const isHtml = rendering?.mediaType === 'text/html';
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-dim)' }}>
          form:{' '}
          <select value={form} onChange={e => setForm(e.target.value)}
            style={{ padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)' }}>
            {FORMS.map(f => <option key={f.v} value={f.v}>{f.label}</option>)}
          </select>
        </label>
        <button style={btn} onClick={render} disabled={busy}>{busy ? <Busy /> : 'Render this job aid'}</button>
      </div>
      {rendering?.body && (
        <div style={resultBox}>
          <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-dim)', marginBottom: 8 }}>
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
        Each section below explains a Foxxi capability and runs the real thing — live against the
        deployed bridge, LMS and LRS. Nothing is mocked: courses are genuinely generated, the
        Context Companion genuinely answers from the networked context, content is genuinely
        rendered. Follow the links for the full process record and the CLI demo that verifies it.
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
        These demos compose one substrate. A diagnosed gap becomes a real course; the course is
        delivered and completed on a conformant LMS/LRS; the Context Companion chats over the whole
        networked context — gated to a wallet-signed identity, federated across pods — and content
        travels in whatever text form the situation calls for. The same capabilities span humans and
        agents (H2H · H2A · A2H · A2A); the agent-collaboration tour lives in the operational dashboard.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
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
        subtitle="diagnosis-driven — performance is the unit, not content"
        principle={<>The system reasons from a <b>performance gap</b>, not a content request. A gap is
          diagnosed — routed by the work regime — and an intervention plan is composed. Content is one
          of nine interventions, chosen only when the diagnosis warrants it.</>}
        doc={{ label: 'PERFORMANCE-ARCHITECTURE.md', href: `${REPO}/PERFORMANCE-ARCHITECTURE.md` }}
        cli="tools/performance-architecture-example.mjs">
        <DiagnoseDemo />
      </Section>

      <Section n={2} title="Closing the loop"
        subtitle="a diagnosed gap becomes a real, conformant course on the LMS"
        principle={<>When the diagnosis warrants instruction, an emergent course is composed and turned
          into deployable artifacts — a <b>cmi5 package</b> and a conformant <b>SCORM 2004 .zip</b> —
          registered on the LMS. Open a runnable lesson: it does the cmi5 handshake and emits xAPI
          straight to the live LRS.</>}
        doc={{ label: 'CLOSING-THE-LOOP.md', href: `${REPO}/CLOSING-THE-LOOP.md` }}
        cli="tools/closed-loop-example.mjs">
        <ClosingLoopDemo />
      </Section>

      <Section n={3} title="The Context Companion"
        subtitle="one chat front door over a user's whole networked context"
        principle={<>A human or agent just asks. The companion classifies intent, answers from the
          substrate's own surfaces, and <b>sources every claim</b>. Scope <code>interego</code>
          federates discovery across pods (Interego passes through to what composes it);{' '}
          <code>vertical</code> narrows to the Foxxi slice. Progress / assignment questions are gated
          to a wallet-signed identity — this panel is authed as a demo learner.</>}
        doc={{ label: 'ASKING-YOUR-CONTEXT.md', href: `${REPO}/ASKING-YOUR-CONTEXT.md` }}
        cli="tools/ask-your-context-example.mjs">
        <CompanionDemo />
      </Section>

      <Section n={4} title="Content in any form"
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
