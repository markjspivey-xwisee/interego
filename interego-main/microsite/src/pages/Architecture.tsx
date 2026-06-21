import React from 'react';
import type { Route } from '../App.js';
import {
  page, card, eyebrow, h1, h2, h3, lede, para, mono, serif, btnOutline, codeChip, pill,
} from '../lib/styles.js';

export function Architecture({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <div style={page}>
      <div style={eyebrow}>Layering · composition discipline · the substrate's transplant test</div>
      <h1 style={h1}>Architecture &amp; layering</h1>
      <p style={lede}>
        The Interego codebase is split into three layers + a separate non-normative vertical surface.
        Knowing where a thing lives — and where it doesn't — is what keeps the protocol small and
        the verticals compositional.
      </p>

      {/* The three layers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 16 }}>
        <LayerCard
          tier="L1"
          name="Protocol"
          flavor="normative"
          flavorColor="var(--accent)"
          body={<>
            <p style={para}>
              <b>Context Graphs 1.0</b>. The L1 spec uses RFC 2119 language: MUST / MUST NOT /
              SHOULD. The vocabulary is small and stable.
            </p>
            <div style={{ marginTop: 8 }}>
              <span style={pill}>iep:</span>
              <span style={pill}>ieh:</span>
              <span style={pill}>pgsl:</span>
              <span style={pill}>ie:</span>
              <span style={pill}>align:</span>
            </div>
            <p style={{ ...para, fontSize: 14, marginTop: 10, color: 'var(--text-dim)' }}>
              spec/architecture.md · spec/conformance/**
            </p>
          </>}
        />
        <LayerCard
          tier="L2"
          name="Architecture patterns"
          flavor="informative"
          flavorColor="var(--warn)"
          body={<>
            <p style={para}>
              Reusable patterns OVER L1: ABAC evaluation, public attestation registry, capability
              passport, federated data-product catalog. Each ships a reference runtime in <code style={codeChip}>src/</code>.
              Patterns are informative; the protocol stays small.
            </p>
            <div style={{ marginTop: 8 }}>
              <span style={pill}>abac:</span>
              <span style={pill}>registry:</span>
              <span style={pill}>passport:</span>
              <span style={pill}>hyprcat:</span>
              <span style={pill}>hypragent:</span>
            </div>
          </>}
        />
        <LayerCard
          tier="L3"
          name="Implementation &amp; domain"
          flavor="non-normative"
          flavorColor="var(--text-dim)"
          body={<>
            <p style={para}>
              Domain ontologies and the source code. Each domain gets its own prefix; this is
              where verticals + their work products live.
            </p>
            <div style={{ marginTop: 8 }}>
              <span style={pill}>hela:</span>
              <span style={pill}>sat:</span>
              <span style={pill}>cts:</span>
              <span style={pill}>olke:</span>
              <span style={pill}>amta:</span>
              <span style={pill}>code:</span>
              <span style={pill}>eu-ai-act:</span>
              <span style={pill}>nist-rmf:</span>
              <span style={pill}>soc2:</span>
            </div>
          </>}
        />
      </div>

      {/* Verticals */}
      <h2 style={h2}>Verticals — non-normative, application-over-L3</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        Verticals (<code style={codeChip}>applications/</code>) compose the substrate without
        extending it. Each declares its own prefix outside the protocol IRI space (<code style={codeChip}>foxxi:</code>,
        <code style={codeChip}>lpc:</code>, <code style={codeChip}>adp:</code>, <code style={codeChip}>ac:</code>,
        <code style={codeChip}>owm:</code>, <code style={codeChip}>lrs:</code>) and names its work
        products there. Verticals MUST NOT propose changes to L1 / L2 / L3 ontologies. Generic
        deployments (mcp-server, examples/personal-bridge, deploy/mcp-relay) NEVER bundle verticals.
      </p>

      {/* The five drift triggers */}
      <h2 style={h2}>Five drift triggers — stop and flag if any appears</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        These are the checks that keep layering honest. Each one is enforced at review time and (for
        the namespace cases) by <code style={codeChip}>tools/ontology-lint.mjs</code> running in CI.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginTop: 12 }}>
        <Trigger num={1} title="Domain term in a core namespace"
          body="iep:CommitDescriptor or iep:MedicalFacet — no. Domain semantics go in their own namespace (code:, med:, …) at L3, not in the L1 core." />
        <Trigger num={2} title="L1 MUST that names a technology"
          body='"Implementations MUST use Solid Notifications" — no. "Implementations MUST provide a subscription mechanism" — yes. L1 is technology-neutral.' />
        <Trigger num={3} title="Bundling multiple layers in one PR"
          body='"Build the coding-agent substrate" is actually three things: an L2 applicability note, an L3 domain ontology, an L3 reference adapter. Split before writing.' />
        <Trigger num={4} title="Cross-layer contamination in an existing artifact"
          body="A Layer 1 spec importing ex: in a normative section, a Layer 2 applicability note depending on a specific implementation repo — open an issue, restructure rather than build on top." />
        <Trigger num={5} title="A new artifact cannot be classified"
          body="If you can't decide which layer it belongs to, it's probably bundling layers. Apply the transplant test: would the claim still make sense in a completely different domain or stack? Yes → L1 / L2. No → L3." />
      </div>

      {/* The projection discipline */}
      <h2 style={h2}>The projection discipline (for verticals)</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        A vertical can implement a conformance surface (xAPI, SCORM, cmi5, LTI, OneRoster) in two ways:
        <b> parallel to the substrate</b> (in-memory store alongside Interego) or <b>as a projection
        over the substrate</b> (every state change is a real iep:ContextDescriptor on the pod; the
        conformance surface is a view). The protocol does not mandate the projection, but Foxxi
        adopted it as a hard rule:
      </p>
      <div style={{ ...card, marginTop: 12, borderLeft: '3px solid var(--accent)' }}>
        <p style={{ ...para, fontStyle: 'italic', margin: 0, color: 'var(--text)' }}>
          “Any new endpoint defaults to a projection over the substrate. The pod is the source of
          truth across container lifetimes. Parallel-to-Interego stops being a quiet default and
          becomes a choice that has to be justified.”
        </p>
        <p style={{ ...para, fontSize: 13, marginTop: 8, color: 'var(--text-dim)' }}>
          — applications/foxxi-content-intelligence/PROJECTION-ARCHITECTURE.md
        </p>
      </div>

      {/* Three properties */}
      <h2 style={h2}>Three properties the projection discipline preserves</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginTop: 14 }}>
        <div style={card}>
          <h3 style={h3}>Substrate as source of truth</h3>
          <p style={{ ...para, fontSize: 14 }}>
            Container restart never loses data; federation discovers it natively; auditors can
            verify it without bridge access.
          </p>
        </div>
        <div style={card}>
          <h3 style={h3}>Uniform semantic surface</h3>
          <p style={{ ...para, fontSize: 14 }}>
            Every work product carries the seven facets, modal status, provenance, trust level,
            federation origin. One query (<code style={codeChip}>discover(&#123;conformsTo: foxxi:Outcome&#125;)</code>)
            works across surfaces — no per-surface API.
          </p>
        </div>
        <div style={card}>
          <h3 style={h3}>Compositional emergence</h3>
          <p style={{ ...para, fontSize: 14 }}>
            The reflexive calibration loop, the downward-causation annotation, the modal flip —
            properties of the graph, not bridge logic. Every projected surface gets them for free.
          </p>
        </div>
      </div>

      {/* What's deployed */}
      <h2 style={h2}>What's deployed today</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        The Foxxi stack runs as five container apps on Azure: bridge (xAPI / SCORM / cmi5 / LTI /
        OneRoster + Performance Architecture, all projected over the pod), dashboard (L&D admin +
        learner), microsite (try-it-now flow + pod browser + Emergent Collective), an identity
        server, and a Solid CSS pod that hosts the substrate. The Foxxi vertical is the worked
        exemplar — the same projection pattern applies to every vertical above L3.
      </p>

      <div style={{ display: 'flex', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
        <button style={btnOutline} onClick={() => onNavigate('substrate')}>Read the substrate</button>
        <button style={btnOutline} onClick={() => onNavigate('verticals')}>Verticals overview</button>
        <button style={btnOutline} onClick={() => onNavigate('demos')}>Live demos</button>
        <a style={btnOutline} href="https://github.com/markjspivey-xwisee/interego/blob/master/spec/LAYERS.md" target="_blank" rel="noreferrer">spec/LAYERS.md ↗</a>
      </div>
    </div>
  );
}

function LayerCard({ tier, name, flavor, flavorColor, body }: {
  tier: string; name: string; flavor: string; flavorColor: string; body: React.ReactNode;
}) {
  return (
    <div style={{ ...card, position: 'relative' }}>
      <div style={{
        display: 'inline-block', padding: '2px 9px', borderRadius: 999,
        background: flavorColor, color: 'var(--panel)', fontFamily: mono, fontSize: 10,
        fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em',
      }}>{tier}</div>
      <h3 style={{ ...h3, marginTop: 6 }}>{name}</h3>
      <div style={{ fontFamily: mono, fontSize: 10, color: flavorColor, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
        {flavor}
      </div>
      {body}
    </div>
  );
}

function Trigger({ num, title, body }: { num: number; title: string; body: string }) {
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
        <div style={{
          width: 26, height: 26, borderRadius: '50%', background: 'var(--text)', color: 'var(--panel)',
          fontFamily: mono, fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>{num}</div>
        <h3 style={{ ...h3, fontSize: 16, margin: 0 }}>{title}</h3>
      </div>
      <p style={{ ...para, fontSize: 14, marginTop: 8 }}>{body}</p>
    </div>
  );
}
