import React from 'react';
import type { Route } from '../App.js';
import {
  page, card, eyebrow, h1, h2, h3, lede, para, mono, serif, btnOutline, accentLink, codeChip, pill,
} from '../lib/styles.js';

interface Vertical {
  name: string;
  short: string;
  prefix: string;       // namespace prefix shorthand
  tagline: string;
  essence: string;
  surfaces: string[];
  marquee: string[];
  links: Array<{ label: string; href?: string; route?: Route; primary?: boolean }>;
  sourcePath: string;
}

const FOXXI_SITE = 'https://interego-foxxi-microsite.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const FOXXI_DASHBOARD = 'https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const FOXXI_BRIDGE = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const GITHUB = 'https://github.com/markjspivey-xwisee/interego';

const VERTICALS: Vertical[] = [
  {
    name: 'Foxxi Content Intelligence',
    short: 'Foxxi',
    prefix: 'foxxi:',
    tagline: 'Enterprise content intelligence — performance architecture, LRS, LMS, all projected over Interego.',
    essence:
      'A complete L&D stack: ingest SCORM/cmi5/xAPI packages, run a real xAPI 2.0 LRS, a SCORM 2004 SN ' +
      'engine, cmi5 launch + moveOn, LTI 1.3 Advantage, OneRoster CSV — every conformance surface a ' +
      'projection over Interego pods, not a parallel store. From the outside it is the standard you ' +
      'expect; from the inside every state change is a real iep:ContextDescriptor with seven facets.',
    surfaces: [
      'live deployed bridge (Azure) — full API surface + the projection layer',
      'live microsite with /emergent (autonomous Claude collective) and /pod (linked-data browser)',
      'live dashboard for L&D admin + learner audiences',
    ],
    marquee: [
      'The Performance Architecture — diagnosis-driven routing across four work regimes',
      'The reflexive calibration loop with iep:CalibrationProfile descriptors on every Hypothetical→Asserted flip',
      'The Emergent Collective — five real Claude subagents racing the substrate, real cryptographic identities, real federation',
    ],
    links: [
      { label: 'Open the Foxxi microsite ↗', href: FOXXI_SITE, primary: true },
      { label: 'The Emergent Collective ↗', href: `${FOXXI_SITE}/emergent` },
      { label: 'Pod browser (this site) →', route: 'pod' },
      { label: 'Live dashboard ↗', href: FOXXI_DASHBOARD },
      { label: 'Bridge API ↗', href: `${FOXXI_BRIDGE}/performance` },
    ],
    sourcePath: 'applications/foxxi-content-intelligence/',
  },
  {
    name: 'Learner-Performer Companion',
    short: 'LPC',
    prefix: 'lpc:',
    tagline: 'A portable wallet of credentials + training + performance history that follows the learner.',
    essence:
      'Two first-class audiences on the same pod. The learner sees their own credentials, training ' +
      'content, and performance records — and can chat their wallet with verbatim citations (no ' +
      'confabulation; honest "no data" when the wallet cannot answer). The institution publishes ' +
      'authoritative content + cohort credential templates to its institutional surface. Records ' +
      'travel intact across employers — the wallet is the learner\'s, not the company\'s.',
    surfaces: [
      'MCP bridge on port 6010 with 6 named tools (ingest_training_content, import_credential, grounded_answer, …)',
      'Affordance manifest at /affordances for protocol-level discovery',
      'Runnable demo (probe-cycle equivalent) showing end-to-end VC + Open Badges 3.0 + IMS CLR 2.0 round-trip',
    ],
    marquee: [
      'Grounded chat with verbatim citations to content-addressed pgsl:Atoms',
      'Cross-employer portability — wallet survives the org boundary',
      'W3C VC 2.0 + Open Badges 3.0 + IMS CLR 2.0 — real VC-JWT signing + tamper detection',
    ],
    links: [
      { label: 'Source on GitHub ↗', href: `${GITHUB}/tree/master/applications/learner-performer-companion` },
      { label: 'README ↗', href: `${GITHUB}/blob/master/applications/learner-performer-companion/README.md` },
    ],
    sourcePath: 'applications/learner-performer-companion/',
  },
  {
    name: 'Agent Development Practice',
    short: 'ADP',
    prefix: 'adp:',
    tagline: 'Complexity-informed agent lifecycle — probe-sense-respond, narrative observation, no false-precision fixes.',
    essence:
      'A pattern for managing AI agent development the way complexity-informed change practitioners ' +
      'manage human systems. Parallel safe-to-fail probes (3 agent variants), narrative observation ' +
      '(multiple narratives kept side-by-side, not collapsed), synthesis without root-cause hubris, ' +
      'operator decisions with explicit "decision NOT made" clauses, capability evolution recognized ' +
      'as it happens. Modal discipline everywhere: probes are Hypothetical until evidence flips them.',
    surfaces: [
      'Runnable probe-cycle.mjs proof-of-concept with real ECDSA signing — full cycle visible',
      'Affordance declarations for probes / syntheses / capability evolution events',
      'Reusable verb set: probe · sense · respond · synthesize · evolve · constrain',
    ],
    marquee: [
      'Complexity-informed framing — honest about Complex situations; rejects black-box trust',
      'Explicit "decision not made" clauses — humility encoded in the data, not just the prose',
      'Capability evolution + constraints + probes travel across deployments with all narratives intact',
    ],
    links: [
      { label: 'Source on GitHub ↗', href: `${GITHUB}/tree/master/applications/agent-development-practice` },
      { label: 'README ↗', href: `${GITHUB}/blob/master/applications/agent-development-practice/README.md` },
    ],
    sourcePath: 'applications/agent-development-practice/',
  },
  {
    name: 'Agent Collective',
    short: 'AC',
    prefix: 'ac:',
    tagline: 'Federation patterns for multi-agent collaboration — agents author tools, attest each other, teach across pods.',
    essence:
      'Multiple Interego-using agents — owned by different humans, running on different bridges — ' +
      'author tools, accumulate amta:Attestations toward a promotion threshold, publish to public ' +
      'registries, transfer teaching packages across pods, and coordinate via signed encrypted ' +
      'messages. Foxxi\'s /agent/teach composes ac:bundleTeachingPackage; the protocol\'s ' +
      'amta:Attestation discipline flips packages from Hypothetical to Asserted on verified transfer.',
    surfaces: [
      'Runnable collective-flow.mjs — tool authorship → attestation → promotion → teaching transfer',
      'Affordance discovery for tools in public registries; cross-pod encrypted share surface',
      'Full audit logs in every human owner\'s pod (both sides of every exchange)',
    ],
    marquee: [
      'First-class tools — self-authored code as code:Commit + pgsl:Atom with modal discipline',
      'Teaching-package transfer — the artifact AND the practice, composing with ADP',
      'Permission-gated federation — every cross-agent exchange references a capability passport',
    ],
    links: [
      { label: 'Source on GitHub ↗', href: `${GITHUB}/tree/master/applications/agent-collective` },
      { label: 'README ↗', href: `${GITHUB}/blob/master/applications/agent-collective/README.md` },
    ],
    sourcePath: 'applications/agent-collective/',
  },
  {
    name: 'Organizational Working Memory',
    short: 'OWM',
    prefix: 'owm:',
    tagline: 'Federated org memory — individuals author their slice; operators see aggregates without seeing individuals.',
    essence:
      'Two first-class audiences on one org pod. Individual contributors author their decisions, ' +
      'projects, notes, and follow-ups. Operators (PMs, ops, exec, board-facing compliance) query ' +
      'aggregates, project health, decision lineage — but never see individuals\' notes unless those ' +
      'individuals explicitly share via per-graph share_with. Aggregate queries publish as ' +
      'Hypothetical descriptors with model + confidence — operators cannot silently upgrade ' +
      'individuals\' raw notes to facts.',
    surfaces: [
      '5 contributor affordances (upsert_person, record_decision, navigate_source over web/drive/slack/github)',
      '4 operator affordances (aggregate-decisions, project-health, policy-publish, compliance-evidence)',
      'Uniform ls / cat / grep / recent verbs across all external sources (one tool pair per source)',
    ],
    marquee: [
      'Dual-audience discipline — same pod, different surfaces; ABAC + share_with is the boundary',
      'Modal honesty on aggregates — analytics published as Hypothetical, never silently Asserted',
      'Source-adapter uniformity — one tool pair regardless of source count (no tool bloat)',
    ],
    links: [
      { label: 'Source on GitHub ↗', href: `${GITHUB}/tree/master/applications/organizational-working-memory` },
      { label: 'README ↗', href: `${GITHUB}/blob/master/applications/organizational-working-memory/README.md` },
    ],
    sourcePath: 'applications/organizational-working-memory/',
  },
  {
    name: 'LRS Adapter',
    short: 'lrs-adapter',
    prefix: 'lrs:',
    tagline: 'Lossy boundary translator between xAPI Statements and Interego descriptors.',
    essence:
      'A surgical bridge between the xAPI / LRS ecosystem and Interego pods. Learners ingest their ' +
      'LRS history into portable pods; institutions project signed descriptors outbound as xAPI ' +
      'Statements with consent-gating. Hypothetical descriptors are not silently projected (they\'d ' +
      'become committed claims by spec); multi-narrative entries preserve their alternatives in ' +
      'xAPI extensions; lossy translations write an audit row explaining exactly what was dropped.',
    surfaces: [
      'Runnable translate.mjs — round-trips xAPI ↔ descriptor with lossiness notes',
      'Real Tier-3 tests against Yet Analytics Lrsql + SCORM Cloud (cross-LRS, v1.0.3 fallback)',
      'Minimal vocabulary — lrs:LRSEndpoint, lrs:StatementProjection, lrs:StatementIngestion',
    ],
    marquee: [
      'Explicit lossy translation — auditors know exactly what crossed the boundary and what didn\'t',
      'Cross-LRS certification — same shape works against Lrsql AND SCORM Cloud',
      'Consent-gated projection — institution cannot mint Statements about a learner without share_with',
    ],
    links: [
      { label: 'Source on GitHub ↗', href: `${GITHUB}/tree/master/applications/lrs-adapter` },
      { label: 'README ↗', href: `${GITHUB}/blob/master/applications/lrs-adapter/README.md` },
    ],
    sourcePath: 'applications/lrs-adapter/',
  },
];

export function Verticals({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <div style={page}>
      <div style={eyebrow}>L3 verticals · domain-specific compositions over the L1 substrate</div>
      <h1 style={h1}>Six verticals, one substrate</h1>
      <p style={lede}>
        A vertical is a domain composition — it never extends the L1 protocol. It puts its own
        prefix on top (<code style={codeChip}>foxxi:</code>, <code style={codeChip}>lpc:</code>,
        <code style={codeChip}>adp:</code>, <code style={codeChip}>ac:</code>, <code style={codeChip}>owm:</code>,
        <code style={codeChip}>lrs:</code>), names its work products, and composes Context Graphs
        primitives to do its work. The four cross-cutting properties (typed context, verifiable
        identity, modal discipline, federation) come for free.
      </p>

      <div style={{ display: 'grid', gap: 16, marginTop: 8 }}>
        {VERTICALS.map(v => <VerticalCard key={v.short} v={v} onNavigate={onNavigate} />)}
      </div>

      <div style={{ ...card, marginTop: 30, background: 'var(--panel-2)' }}>
        <div style={eyebrow}>Cross-vertical composition</div>
        <h3 style={h3}>None of these are silos</h3>
        <p style={{ ...para, fontSize: 15 }}>
          Foxxi's <code style={codeChip}>/agent/teach</code> composes Agent Collective's
          <code style={codeChip}>ac:bundleTeachingPackage</code> + ADP's practice. The reflexive
          calibration loop in Foxxi is the same mechanic OWM uses for aggregate operator queries.
          LRS Adapter's projection discipline is the model every Foxxi conformance surface follows.
          The verticals share machinery because the substrate makes the sharing trivial.
        </p>
      </div>
    </div>
  );
}

function VerticalCard({ v, onNavigate }: { v: Vertical; onNavigate: (r: Route) => void }) {
  return (
    <div style={{ ...card, padding: 26 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={eyebrow}>{v.short} · {v.prefix} · {v.sourcePath}</div>
          <h3 style={{ ...h3, fontSize: 26, marginTop: 6 }}>{v.name}</h3>
        </div>
        <span style={pill}>L3 vertical</span>
      </div>
      <p style={{ ...para, fontStyle: 'italic', color: 'var(--text-dim)', marginTop: 4 }}>
        {v.tagline}
      </p>
      <p style={{ ...para, fontSize: 15, marginTop: 8 }}>
        {v.essence}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 14 }}>
        <div>
          <div style={eyebrow}>Surfaces</div>
          <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--text-dim)' }}>
            {v.surfaces.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
          </ul>
        </div>
        <div>
          <div style={eyebrow}>Marquee features</div>
          <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--text-dim)' }}>
            {v.marquee.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
          </ul>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
        {v.links.map((l, i) => l.route
          ? <button key={i} onClick={() => onNavigate(l.route as Route)} style={l.primary ? primaryLink : secondaryLink}>{l.label}</button>
          : <a key={i} href={l.href} target="_blank" rel="noreferrer" style={l.primary ? primaryLink : secondaryLink}>{l.label}</a>
        )}
      </div>
    </div>
  );
}

const primaryLink: React.CSSProperties = {
  display: 'inline-block', padding: '8px 16px', background: 'var(--text)', color: 'var(--panel)',
  border: 'none', borderRadius: 4, fontFamily: mono, fontSize: 12, fontWeight: 600,
  letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer', textDecoration: 'none',
};
const secondaryLink: React.CSSProperties = {
  display: 'inline-block', padding: '8px 16px', background: 'transparent', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 4, fontFamily: mono, fontSize: 12,
  letterSpacing: '0.04em', cursor: 'pointer', textDecoration: 'none',
};
