import React from 'react';
import type { Route } from '../App.js';
import {
  page, card, eyebrow, h1, h2, h3, lede, para, mono, serif, btnOutline, accentLink, codeChip,
} from '../lib/styles.js';

export function About({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <div style={page}>
      <div style={eyebrow}>About</div>
      <h1 style={h1}>About Interego</h1>
      <p style={lede}>
        Interego is open-source infrastructure for typed, verifiable, federated context — a
        protocol (Context Graphs 1.0) and a substrate (verifiable identity + coordination), with
        verticals (learning, organizational memory, agent development, agent collaboration)
        composing on top. MIT licensed. TypeScript. Zero runtime dependencies in the core.
      </p>

      <h2 style={h2}>The core principles</h2>
      <ul style={{ ...para, paddingLeft: 22, maxWidth: 820 }}>
        <li><b>Typed context.</b> Every claim is a iep:ContextDescriptor with seven facets. Validation is shape-driven; absence of a facet means no claim on that dimension.</li>
        <li><b>Wallet-rooted identity.</b> No passwords anywhere. ECDSA secp256k1 → did:key. SIWE / WebAuthn / DID signatures over server nonces.</li>
        <li><b>Pods are the source of truth.</b> Storage is zero-trust; bridges are stateless. Container restart never loses data.</li>
        <li><b>Federation is cryptographic.</b> Recipients via wrapped envelope keys; no membership service; no central authority.</li>
        <li><b>Modal honesty.</b> Three modal statuses (Asserted / Hypothetical / Counterfactual) are first-class. Composition is modality-aware; the substrate refuses to silently upgrade a tentative claim to a fact.</li>
        <li><b>The protocol stays small.</b> Five drift triggers + the transplant test keep L1 / L2 / L3 cleanly separated.</li>
      </ul>

      <h2 style={h2}>License + intent</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        MIT. Interego is intentionally open source — no paid SaaS, no x402 revenue path. The
        existing x402 plumbing in the code is for downstream operators who want it; the substrate
        itself is free to run, fork, and build on. Verticals follow the same license.
      </p>

      <h2 style={h2}>Where things live</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <ResourceCard
          title="Source code"
          body="The monorepo, all verticals, all the deploy infrastructure."
          href="https://github.com/markjspivey-xwisee/interego"
          linkLabel="github.com/markjspivey-xwisee/interego ↗"
        />
        <ResourceCard
          title="The L1 spec"
          body="Context Graphs 1.0 — the normative protocol document."
          href="https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html"
          linkLabel="interego-1.0.html ↗"
        />
        <ResourceCard
          title="The Foxxi vertical"
          body="The worked exemplar — full stack deployed on Azure, every conformance surface projected over the substrate."
          href="https://interego-foxxi-microsite.livelysky-8b81abb0.eastus.azurecontainerapps.io"
          linkLabel="interego-foxxi-microsite ↗"
        />
        <ResourceCard
          title="The pod browser"
          body="A small linked-data client that browses any Interego pod by its manifest. Built into this site at /pod."
          onClick={() => onNavigate('pod')}
          linkLabel="Open the pod browser →"
        />
      </div>

      <h2 style={h2}>Standards we conform to / compose</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        Interego doesn't reinvent vocabularies that already exist. The seven facets profile
        existing W3C / PROV / Activity Streams / WAC / DCAT / Solid / Hydra vocabularies; verticals
        cite domain standards directly.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 8 }}>
        <StandardChip label="RDF 1.2 Named Graphs" />
        <StandardChip label="W3C PROV-O" />
        <StandardChip label="W3C OWL-Time" />
        <StandardChip label="Activity Streams 2.0" />
        <StandardChip label="WAC + ABAC" />
        <StandardChip label="W3C VC 2.0" />
        <StandardChip label="DID Core" />
        <StandardChip label="DCAT 3 + DPROD" />
        <StandardChip label="Solid Protocol" />
        <StandardChip label="Hydra Operation" />
        <StandardChip label="xAPI 2.0 (LRS)" />
        <StandardChip label="SCORM 2004 SN" />
        <StandardChip label="cmi5" />
        <StandardChip label="LTI 1.3 Advantage" />
        <StandardChip label="OneRoster 1.2" />
        <StandardChip label="ADL TLA" />
        <StandardChip label="IEEE LERS" />
        <StandardChip label="Open Badges 3.0" />
        <StandardChip label="IMS CLR 2.0" />
        <StandardChip label="MCP" />
        <StandardChip label="OAuth 2.0 / OIDC" />
        <StandardChip label="JOSE / JWS / JWE" />
        <StandardChip label="EU AI Act mapping" />
        <StandardChip label="NIST AI RMF mapping" />
        <StandardChip label="SOC 2 TSC mapping" />
      </div>

      <h2 style={h2}>Where to start</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
        <button style={btnOutline} onClick={() => onNavigate('substrate')}>The substrate</button>
        <button style={btnOutline} onClick={() => onNavigate('verticals')}>Pick a vertical</button>
        <button style={btnOutline} onClick={() => onNavigate('demos')}>Try the demos</button>
        <button style={btnOutline} onClick={() => onNavigate('pod')}>Browse a pod</button>
      </div>

      <div style={{ ...card, marginTop: 30, background: 'var(--panel-2)' }}>
        <div style={eyebrow}>One sentence about why</div>
        <p style={{ ...para, fontSize: 17, fontStyle: 'italic', marginTop: 6, color: 'var(--text)', fontFamily: serif, lineHeight: 1.55 }}>
          Most AI systems treat context as opaque text shipped per request to a model; Interego
          treats it as a typed, verifiable, federated graph that humans, agents, and organizations
          share — and gives every actor an honest place to keep their work.
        </p>
      </div>
    </div>
  );
}

function ResourceCard({ title, body, href, onClick, linkLabel }: {
  title: string; body: string; href?: string; onClick?: () => void; linkLabel: string;
}) {
  return (
    <div style={card}>
      <h3 style={h3}>{title}</h3>
      <p style={{ ...para, fontSize: 14 }}>{body}</p>
      {href
        ? <a href={href} target="_blank" rel="noreferrer" style={accentLink}>{linkLabel}</a>
        : <button onClick={onClick} style={{ ...accentLink, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: mono, fontSize: 14 }}>{linkLabel}</button>}
    </div>
  );
}

function StandardChip({ label }: { label: string }) {
  return (
    <div style={{
      padding: '6px 10px', background: 'var(--panel)', border: '1px solid var(--border)',
      borderRadius: 4, fontFamily: mono, fontSize: 11, color: 'var(--text)',
    }}>
      {label}
    </div>
  );
}
