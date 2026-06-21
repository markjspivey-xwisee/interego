import React from 'react';
import type { Route } from '../App.js';
import {
  page, card, eyebrow, h1, h2, h3, lede, para, mono, btnOutline, codeChip, pill,
} from '../lib/styles.js';

interface Demo {
  category: 'substrate' | 'vertical' | 'cli';
  vertical?: string;
  title: string;
  description: string;
  whatItShows: string[];
  action: { label: string; href?: string; route?: Route; cli?: string };
  liveOk?: boolean;
}

const FOXXI_SITE = 'https://interego-foxxi-microsite.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const FOXXI_BRIDGE = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const FOXXI_DASHBOARD = 'https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io';

const DEMOS: Demo[] = [
  // Substrate demos
  {
    category: 'substrate',
    title: 'Linked-data pod browser',
    description:
      'Walks any Interego pod by its .well-known/context-graphs manifest. Click any descriptor ' +
      'to dereference its Turtle; click any iep:Affordance to follow the link as a Hydra operation. ' +
      'Defaults to the tenant pod, one-click switch to the federation peer, accepts any pod URL.',
    whatItShows: [
      'iep:ContextDescriptor as the universal envelope',
      'iep:Affordance / hydra:Operation / dcat:Distribution links that actually work',
      'Cross-pod browsing — same client, no special protocol',
    ],
    action: { label: 'Open the pod browser →', route: 'pod' },
    liveOk: true,
  },
  {
    category: 'substrate',
    title: 'Real cross-pod federation',
    description:
      'The deployed Foxxi bridge composes its calibration profile from a real discover() call ' +
      'against a separate peer pod — not from any in-process seed corpus. /performance/calibration ' +
      'returns provenance.federation showing pods list + last refresh + peer outcome count.',
    whatItShows: [
      'discover() across pods, with k-anonymity federationView() at the boundary',
      'Cached results with TTL for synchronous calibration recompute',
      'federationView withholds sub-k cells before they cross the boundary',
    ],
    action: { label: 'See the federation provenance ↗', href: `${FOXXI_BRIDGE}/performance/calibration` },
    liveOk: true,
  },
  // Foxxi vertical demos
  {
    category: 'vertical',
    vertical: 'Foxxi',
    title: 'The Emergent Collective — autonomous',
    description:
      'Five real Claude subagents (via the Claude Agent SDK), each a wallet-rooted identity, ' +
      'each spawned independently, coordinating only through the live substrate. The calibration ' +
      'cell really climbs as outcomes land; the Hypothetical → Asserted modal flip captures the ' +
      'exact moment evidence becomes claimable knowledge.',
    whatItShows: [
      'Five live ECDSA wallets + signed-and-verified participation claims',
      'Real Claude subagents making their own tool-call decisions',
      'Stigmergic coordination via the pod — agents never call each other',
    ],
    action: { label: 'Open the dashboard ↗', href: `${FOXXI_SITE}/emergent` },
    liveOk: true,
  },
  {
    category: 'vertical',
    vertical: 'Foxxi',
    title: 'Foxxi microsite — landing + demos',
    description:
      'The Foxxi vertical\'s own site. Three pages worth opening: /emergent (the autonomous ' +
      'collective above), /pod (linked-data browser focused on Foxxi\'s pod), and /demos (the ' +
      'Performance Architecture + Knowledge Architecture walk-through with sample content).',
    whatItShows: [
      'Performance Architecture — diagnosis-driven routing, not content-first',
      'The reflexive calibration loop with iep:CalibrationProfile descriptors on every flip',
      'Three audiences: learner / admin / learning engineer',
    ],
    action: { label: 'Open Foxxi ↗', href: FOXXI_SITE },
    liveOk: true,
  },
  {
    category: 'vertical',
    vertical: 'Foxxi',
    title: 'Foxxi dashboard (admin / learner)',
    description:
      'The L&D dashboard. Auto-probes the bridge on load; falls back to sample mode if the bridge ' +
      'is unreachable. Two audiences (admin / learner) with role-specific affordances; agentic ' +
      'RAG surface for course Q&A; live xAPI statement feed.',
    whatItShows: [
      'Dual-audience UX over one substrate',
      'Agentic RAG with modal-statused trace (question → retrieval → synthesis → citation)',
      'Live LRS statement feed via the projection-backed store',
    ],
    action: { label: 'Open the dashboard ↗', href: FOXXI_DASHBOARD },
    liveOk: true,
  },
  // Foxxi bridge endpoints (raw API)
  {
    category: 'vertical',
    vertical: 'Foxxi',
    title: 'Bridge — self-describing index',
    description:
      'GET /performance returns the bridge\'s HATEOAS index — a single document advertising every ' +
      'affordance the bridge exposes (contextualizeAndPlan, calibration, recordOutcome, teachAgent, ' +
      'composeCourse, personalizeCourse, knowledgeIndex). A consumer can walk the substrate from ' +
      'this entry point alone.',
    whatItShows: [
      'HATEOAS index as the bridge\'s contract',
      'No memorizing URLs — discover the API by following links',
    ],
    action: { label: 'GET /performance ↗', href: `${FOXXI_BRIDGE}/performance` },
    liveOk: true,
  },
  // CLI demos
  {
    category: 'cli',
    vertical: 'Foxxi',
    title: 'The Emergent Collective — CLI',
    description:
      'The same multi-agent emergence as the in-browser dashboard, but runs in your terminal ' +
      'with full structured output (acts, contributions, modal flip, federation). Two editions: ' +
      'scripted (fast, deterministic, no API key) and autonomous (real Claude Agent SDK subagents).',
    whatItShows: [
      'End-to-end run from your machine against the deployed bridge',
      'Both deterministic and LLM-driven editions',
      'Real signed participation claims published to the pod as iep:ParticipationClaim descriptors',
    ],
    action: {
      label: 'See the CLI commands ↓',
      cli: 'npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-demo.mjs\nnpx tsx applications/foxxi-content-intelligence/tools/emergent-collective-agents.mjs\nnpx tsx applications/foxxi-content-intelligence/tools/emergent-collective-live.mjs    # opens a local dashboard',
    },
  },
  {
    category: 'cli',
    vertical: 'lrs-adapter',
    title: 'xAPI ↔ Interego boundary round-trip',
    description:
      'Translate a Statement into a descriptor, publish it to a pod, then project it back to xAPI ' +
      'against a real external LRS. Tested against Yet Analytics Lrsql and SCORM Cloud.',
    whatItShows: [
      'Lossy projection discipline — what crosses the boundary and what doesn\'t',
      'Cross-LRS compatibility with v2.0.0 / v1.0.3 negotiation',
    ],
    action: { label: 'See the CLI commands ↓', cli: 'npx tsx applications/lrs-adapter/translate.mjs' },
  },
  {
    category: 'cli',
    vertical: 'ADP',
    title: 'Agent Development probe cycle',
    description:
      'A full probe-sense-respond cycle. Three agent variants run in parallel; narratives are kept ' +
      'side-by-side; synthesis is bound to a constraint; capability evolution recognized when it ' +
      'happens. Real ECDSA signing throughout; modal discipline at every step.',
    whatItShows: [
      'Parallel safe-to-fail experiments, narrative observation',
      'Explicit "decision NOT made" clauses',
      'Capability evolution as a first-class passport event',
    ],
    action: { label: 'See the CLI commands ↓', cli: 'npx tsx applications/agent-development-practice/probe-cycle.mjs' },
  },
  {
    category: 'cli',
    vertical: 'AC',
    title: 'Agent Collective tool-authoring + teaching',
    description:
      'Tool authorship → accumulating amta:Attestations to reach a promotion threshold → ' +
      'registry publication → teaching-package transfer across pods → cross-pod refinement.',
    whatItShows: [
      'Self-authored tools as code:Commit + pgsl:Atom',
      'Permission-gated cross-pod exchange via capability passports',
    ],
    action: { label: 'See the CLI commands ↓', cli: 'npx tsx applications/agent-collective/collective-flow.mjs' },
  },
  {
    category: 'cli',
    vertical: 'OWM',
    title: 'Organizational memory — Curator + Surfacer',
    description:
      'Demo 15 in OWM. A Curator distills sources (web/drive/slack/github) into typed descriptors on ' +
      'the org pod; a Surfacer agent later recovers org state from the pod alone — no access to the ' +
      'original sources. Proof the org\'s working memory IS the pod, not the tools.',
    whatItShows: [
      'Uniform ls / cat / grep / recent over any source adapter',
      'Pod as durable org memory, source tools as ephemeral input adapters',
    ],
    action: { label: 'See the CLI commands ↓', cli: 'npx tsx applications/organizational-working-memory/demos/15-curator-surfacer.mjs' },
  },
];

export function Demos({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const sub = DEMOS.filter(d => d.category === 'substrate');
  const vert = DEMOS.filter(d => d.category === 'vertical');
  const cli = DEMOS.filter(d => d.category === 'cli');
  return (
    <div style={page}>
      <div style={eyebrow}>Live demos · running against deployed Azure infrastructure</div>
      <h1 style={h1}>Demos</h1>
      <p style={lede}>
        Everything below runs on the same deployed substrate: a Foxxi bridge, a tenant pod, a
        federation peer pod, the microsite. No simulation; what you see is what the system is doing.
        Some demos are in-browser; some are CLIs you run from a clone.
      </p>

      <h2 style={h2}>Substrate-level</h2>
      <p style={{ ...para, maxWidth: 800 }}>
        These exercise the Context Graphs 1.0 protocol directly — pod browser, real federation,
        modal-status flip. They are not vertical-specific.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        {sub.map((d, i) => <DemoCard key={i} d={d} onNavigate={onNavigate} />)}
      </div>

      <h2 style={h2}>In-browser vertical demos</h2>
      <p style={{ ...para, maxWidth: 800 }}>
        Open in a tab; everything runs against the live deployed bridge and pod.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        {vert.map((d, i) => <DemoCard key={i} d={d} onNavigate={onNavigate} />)}
      </div>

      <h2 style={h2}>CLI demos</h2>
      <p style={{ ...para, maxWidth: 800 }}>
        Clone the repo and run from your machine. Each one is a single <code style={codeChip}>npx tsx</code> command;
        the agent demos require an active Claude Code OAuth login (or <code style={codeChip}>ANTHROPIC_API_KEY</code>).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
        {cli.map((d, i) => <DemoCard key={i} d={d} onNavigate={onNavigate} />)}
      </div>

      <div style={{ ...card, marginTop: 30, background: 'var(--panel-2)' }}>
        <div style={eyebrow}>Want more depth?</div>
        <p style={{ ...para, fontSize: 15, marginTop: 6 }}>
          The <button style={inlineBtn} onClick={() => onNavigate('substrate')}>substrate page</button> explains
          how the primitives compose; the <button style={inlineBtn} onClick={() => onNavigate('verticals')}>verticals page</button> covers
          what each vertical brings; the <button style={inlineBtn} onClick={() => onNavigate('architecture')}>architecture page</button> covers
          L1 / L2 / L3 layering. The pod browser is the most direct way to see the substrate as it
          actually lives.
        </p>
      </div>
    </div>
  );
}

function DemoCard({ d, onNavigate }: { d: Demo; onNavigate: (r: Route) => void }) {
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={eyebrow}>
          {d.category === 'substrate' ? 'substrate' : d.category === 'cli' ? `cli · ${d.vertical}` : `vertical · ${d.vertical}`}
        </div>
        {d.liveOk && <span style={{ ...pill, color: 'var(--good)', borderColor: 'var(--good)' }}>live</span>}
      </div>
      <h3 style={{ ...h3, marginTop: 4 }}>{d.title}</h3>
      <p style={{ ...para, fontSize: 14, margin: '6px 0 10px' }}>{d.description}</p>
      <ul style={{ margin: '0 0 12px 16px', padding: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim)' }}>
        {d.whatItShows.map((s, i) => <li key={i} style={{ marginBottom: 3 }}>{s}</li>)}
      </ul>
      {d.action.cli ? (
        <div>
          <div style={eyebrow}>command</div>
          <pre style={{
            fontFamily: mono, fontSize: 11, padding: '8px 10px', background: 'var(--panel-2)',
            border: '1px solid var(--border)', borderRadius: 4, overflowX: 'auto', margin: '4px 0 0',
            whiteSpace: 'pre-wrap',
          }}>{d.action.cli}</pre>
        </div>
      ) : d.action.route ? (
        <button style={btnOutline} onClick={() => onNavigate(d.action.route as Route)}>{d.action.label}</button>
      ) : (
        <a style={btnOutline} href={d.action.href} target="_blank" rel="noreferrer">{d.action.label}</a>
      )}
    </div>
  );
}

const inlineBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: 0, color: 'var(--accent)',
  cursor: 'pointer', fontFamily: mono, fontSize: 14, fontWeight: 600, textDecoration: 'underline',
};
