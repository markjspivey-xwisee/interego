import React from 'react';
import type { Route } from '../App.js';
import {
  page, card, eyebrow, h1, h2, h3, lede, para, mono, serif, btnPrimary, btnOutline, accentLink, codeChip,
} from '../lib/styles.js';

export function Home({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <div style={page}>
      {/* Hero */}
      <div style={{ marginBottom: 40 }}>
        <div style={eyebrow}>Open-source · MIT · TypeScript</div>
        <h1 style={h1}>
          Composable, verifiable, federated context infrastructure<br />
          for multi-agent shared memory.
        </h1>
        <p style={lede}>
          Interego is a protocol and a substrate. The protocol — <b>Context Graphs 1.0</b> — defines
          typed context descriptors over RDF 1.2 named graphs with a small composition algebra and
          three modal statuses. The substrate adds verifiable identity, attestation, and federation
          on a single cryptographic root. Verticals (learning, organizational memory, agent
          development, agent collaboration) compose on top without extending the protocol.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button style={btnPrimary} onClick={() => onNavigate('substrate')}>The substrate →</button>
          <button style={btnOutline} onClick={() => onNavigate('verticals')}>Verticals</button>
          <button style={btnOutline} onClick={() => onNavigate('demos')}>Live demos</button>
        </div>
      </div>

      {/* The three pillars on one cryptographic root */}
      <div style={{ ...eyebrow, marginTop: 36 }}>The three pillars, one root</div>
      <h2 style={{ ...h2, marginTop: 4 }}>What Interego is, end-to-end</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 16 }}>
        <div style={card}>
          <div style={eyebrow}>Pillar 1 · L1 protocol</div>
          <h3 style={h3}>Typed context</h3>
          <p style={para}>
            <b>Context Graphs 1.0</b>. Every claim is a <code style={codeChip}>cg:ContextDescriptor</code>
            with seven facets — <i>Temporal · Provenance · Agent · AccessControl · Semiotic · Trust · Federation</i>.
            Composition algebra (union / intersection / restriction / override) and three modal statuses
            (Asserted / Hypothetical / Counterfactual) are first-class.
          </p>
        </div>
        <div style={card}>
          <div style={eyebrow}>Pillar 2 · Verifiable identity</div>
          <h3 style={h3}>Wallet-rooted DIDs</h3>
          <p style={para}>
            ECDSA keys (ethers / secp256k1) → <code style={codeChip}>did:key:&lt;addr&gt;</code>.
            <b> Capability passports</b> persist biographical identity across infrastructure
            migration; <b>attestation registries</b> are federated NPM-for-AI; <b>ABAC</b> evaluates
            attribute-based policies on the typed graph.
          </p>
        </div>
        <div style={card}>
          <div style={eyebrow}>Pillar 3 · Coordination</div>
          <h3 style={h3}>Federated, p2p, accountable</h3>
          <p style={para}>
            Multi-axis attestation, self-amending constitutional policies, federated saga
            transactions across pods, Nostr-style p2p relays with dual ECDSA + Schnorr signing,
            ZK proofs. Verticals compose these — they don't reinvent them.
          </p>
        </div>
      </div>

      {/* What does this actually feel like? */}
      <h2 style={h2}>What it feels like to use</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        Every action by a human or agent — recording an outcome, filing a situation, teaching another
        agent, publishing a credential — becomes a real <code style={codeChip}>cg:ContextDescriptor</code>
        in a Solid pod. Each carries its seven facets, signed, content-addressed via a <code style={codeChip}>pgsl:Atom</code>,
        and dereferenceable on the wire. Conformance surfaces like xAPI 2.0, SCORM, cmi5, or LTI
        become <b>projections</b> over the substrate — from outside they're the standard you expect;
        from inside they're a graph of typed descriptors with HATEOAS affordances and supersedes chains.
      </p>

      {/* Showcases */}
      <h2 style={h2}>Showcases that run live, right now</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <ShowcaseCard
          title="Pod browser"
          eyebrowText="Substrate · linked-data client"
          body={<>
            Walks any Interego pod by reading its <code style={codeChip}>.well-known/context-graphs</code>
            manifest, dereferences any descriptor as Turtle, decodes the graph payload, and follows
            <code style={codeChip}>cg:Affordance</code> links as clickable Hydra operations.
          </>}
          actionLabel="Open the pod browser →"
          onClick={() => onNavigate('pod')}
        />
        <ShowcaseCard
          title="The Emergent Collective"
          eyebrowText="Vertical · Foxxi"
          body={<>
            Five real Claude subagents (via the Claude Agent SDK), each a wallet-rooted identity,
            coordinating only through the substrate. A <code style={codeChip}>cg:Hypothetical → cg:Asserted</code>
            flip captures the moment evidence becomes claimable knowledge.
          </>}
          actionLabel="Live multi-agent emergence →"
          href="https://interego-foxxi-microsite.livelysky-8b81abb0.eastus.azurecontainerapps.io/emergent"
        />
        <ShowcaseCard
          title="Real cross-pod federation"
          eyebrowText="Substrate · federation"
          body={<>
            Two pods, real <code style={codeChip}>discover()</code> across the wire, calibration
            profile composed from real signed evidence on both. Federation is the protocol's default,
            not a special-purpose API.
          </>}
          actionLabel="See the federated calibration →"
          href="https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/performance/calibration"
        />
        <ShowcaseCard
          title="Verticals overview"
          eyebrowText="Six verticals · one substrate"
          body={<>
            Foxxi (L&D content intelligence), Learner-Performer Companion, Agent Development
            Practice, Agent Collective, Organizational Working Memory, LRS Adapter. Each composes
            the same L1 primitives.
          </>}
          actionLabel="Browse the verticals →"
          onClick={() => onNavigate('verticals')}
        />
      </div>

      {/* Why */}
      <h2 style={h2}>Why this exists</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        Most AI systems treat context as opaque text shipped per-request to a model. Interego treats
        context as a <b>typed, verifiable, federated graph</b> that humans, agents, and organizations
        share. The graph carries who said it, when, with what authority, under what semiotic frame,
        with what modal commitment — properties an opaque blob cannot have. Verticals get
        compositional emergence (the calibration flip, the downward-causation annotation, the
        modal-status discipline) <i>for free</i> because they're properties of the graph, not bridge logic.
      </p>
      <p style={{ ...para, maxWidth: 820, marginTop: 14, color: 'var(--text-dim)', fontStyle: 'italic', fontFamily: serif }}>
        “Substrate as source of truth” stops being a quiet default and becomes an explicit
        commitment — any deviation has to justify itself.
      </p>

      {/* Where to next */}
      <div style={{ ...card, marginTop: 30, background: 'var(--panel-2)' }}>
        <div style={eyebrow}>Where to next</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
          <button style={btnOutline} onClick={() => onNavigate('substrate')}>Read the substrate</button>
          <button style={btnOutline} onClick={() => onNavigate('architecture')}>Architecture &amp; layering</button>
          <button style={btnOutline} onClick={() => onNavigate('demos')}>Try the demos</button>
          <button style={btnOutline} onClick={() => onNavigate('verticals')}>Pick a vertical</button>
          <a style={btnOutline} href="https://github.com/markjspivey-xwisee/interego" target="_blank" rel="noreferrer">Source on GitHub</a>
        </div>
      </div>
    </div>
  );
}

function ShowcaseCard({ title, eyebrowText, body, actionLabel, onClick, href }: {
  title: string; eyebrowText: string; body: React.ReactNode; actionLabel: string;
  onClick?: () => void; href?: string;
}) {
  const action = href
    ? <a href={href} target="_blank" rel="noreferrer" style={accentLink}>{actionLabel}</a>
    : <button onClick={onClick} style={{ ...accentLink, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: mono, fontSize: 13 }}>{actionLabel}</button>;
  return (
    <div style={card}>
      <div style={eyebrow}>{eyebrowText}</div>
      <h3 style={h3}>{title}</h3>
      <p style={{ ...para, fontSize: 15 }}>{body}</p>
      <div style={{ marginTop: 8, fontFamily: mono, fontSize: 13 }}>{action}</div>
    </div>
  );
}

