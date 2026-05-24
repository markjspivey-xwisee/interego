import React from 'react';
import type { Route } from '../App.js';
import {
  page, card, eyebrow, h1, h2, h3, lede, para, mono, btnOutline, accentLink, codeChip,
} from '../lib/styles.js';

export function Substrate({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <div style={page}>
      <div style={eyebrow}>Context Graphs 1.0 · the L1 protocol</div>
      <h1 style={h1}>The substrate</h1>
      <p style={lede}>
        Every claim in Interego is a <code style={codeChip}>cg:ContextDescriptor</code>: a typed
        envelope over a named graph with seven facets, a modal status, an optional supersedes chain,
        and a list of dereferenceable affordances. The protocol is small on purpose — primitives
        compose into everything else.
      </p>

      {/* The seven facets */}
      <h2 style={h2}>The seven facets</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        A descriptor is its facets. Each facet is a named slice of metadata with profile-conformant
        vocabulary. Validation is shape-driven; absence of a facet means the descriptor makes no
        claim about that dimension.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 14 }}>
        <Facet name="Temporal" body="When is the claim valid? validFrom · validUntil · time:hasTime intervals. Profiles W3C OWL-Time." />
        <Facet name="Provenance" body="Where did it come from? prov:wasGeneratedBy · prov:wasAttributedTo · prov:wasDerivedFrom. Profiles W3C PROV-O." />
        <Facet name="Agent" body="Who is speaking? Distinct assertingAgent (the descriptor's author) and onBehalfOf (delegation chain). Activity Streams 2.0 Actor / PROV-O Agent." />
        <Facet name="AccessControl" body="Who can read it? WAC authorizations + optional ABAC policyRefs. The substrate enforces; bridges only carry the policy." />
        <Facet name="Semiotic" body="What does the descriptor commit to? modalStatus (Asserted / Hypothetical / Counterfactual) · groundTruth · epistemicConfidence · interpretation frame." />
        <Facet name="Trust" body="How is it warranted? trustLevel (SelfAsserted / ThirdPartyAttested / CryptographicallyVerified) · issuer · proofMechanism · verifiableCredential ref." />
        <Facet name="Federation" body="Where does it live? origin pod · storageEndpoint · syncProtocol · replicaOf. The substrate spans pods; descriptors carry their place." />
      </div>

      {/* Composition algebra */}
      <h2 style={h2}>Composition algebra</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        Four operators form a bounded lattice over descriptors. Each one composes the underlying
        named graphs <i>and</i> the facets correctly (per-facet merge semantics defined in spec §3.4).
        Composed descriptors are first-class — they carry their own provenance back to the inputs.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 14 }}>
        <Facet name="union" body="A ∪ B. Triple-level merge of named graphs, facets reconciled by the spec's per-type rules. Order-independent." />
        <Facet name="intersection" body="A ∩ B. Only triples in both, with the most-restrictive facets retained. Useful for finding agreement across two pods." />
        <Facet name="restriction" body="A | F. Apply a SPARQL filter to extract a slice of A. The filter is itself a descriptor — the operation is auditable." />
        <Facet name="override" body="A ▷ B. B's triples replace A's for any subject A and B both mention; A's other triples stay. The basis for personalization." />
      </div>

      {/* Modal status */}
      <h2 style={h2}>Modal status — the substrate's epistemic discipline</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        Every claim carries one of three modal statuses on its SemioticFacet:
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8, marginBottom: 18 }}>
        <ModalPill modalStatus="Asserted" />
        <ModalPill modalStatus="Hypothetical" />
        <ModalPill modalStatus="Counterfactual" />
      </div>
      <p style={{ ...para, maxWidth: 820 }}>
        Composition is modality-aware: an Asserted plus a Hypothetical does not silently become
        Asserted. <b>Modal flip</b> (Hypothetical → Asserted) marks the precise moment evidence
        becomes claimable knowledge; verticals publish a fresh descriptor on the flip so the
        substrate carries a permanent record of when the line was crossed.
      </p>

      {/* PGSL */}
      <h2 style={h2}>PGSL — the content-addressed lattice</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        Underneath every payload sits a <b>Poly-Granular Sequence Lattice atom</b>:
        <code style={codeChip}>urn:pgsl:atom:&lt;sha256-prefix&gt;</code>. Same content → same URI
        globally, on any pod. Atoms compose into Fragments (sequences) and higher levels via
        well-formed pullbacks; the structure is a presheaf topos in the categorical interpretation.
        Practically: every work product has a cryptographic address you can verify by recomputing
        the hash.
      </p>

      {/* HATEOAS */}
      <h2 style={h2}>HATEOAS affordances</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        Every descriptor carries a <code style={codeChip}>cg:affordance</code> block that lists the
        operations a consumer can perform on it as <code style={codeChip}>hydra:Operation</code> /
        <code style={codeChip}>dcat:Distribution</code> links: fetch the graph payload, supersede
        the descriptor, follow a federation pointer, etc. A consumer that knows nothing about your
        vertical can still discover what's possible — by reading the affordances on the descriptors
        it finds.
      </p>
      <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
        <button style={btnOutline} onClick={() => onNavigate('pod')}>Open the pod browser →</button>
        <a style={btnOutline} href="https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html" target="_blank" rel="noreferrer">L1 spec</a>
      </div>

      {/* Federation */}
      <h2 style={h2}>Federation</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        A pod is a sovereign Solid pod. The substrate spans many pods; <code style={codeChip}>discover()</code>
        walks each pod's <code style={codeChip}>.well-known/context-graphs</code> manifest, returns
        the matching <code style={codeChip}>cg:ManifestEntry</code> set, and dereferences whatever
        is needed. Aggregate privacy is built in: <b>federationView()</b> withholds cells under a
        k-anonymity threshold before they cross a pod boundary, so coarser summaries can be shared
        while individual records stay private.
      </p>
      <p style={{ ...para, maxWidth: 820 }}>
        E2EE is per-graph: <code style={codeChip}>publish(..., {`{ encrypt: { recipients, senderKeyPair } }`})</code>
        wraps the payload in a NaCl envelope keyed to each recipient's X25519 public key. Pods
        store ciphertext; only holders of the matching private key decrypt.
      </p>

      {/* Identity */}
      <h2 style={h2}>Wallet-rooted identity</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        Every agent and human is a <code style={codeChip}>did:key:&lt;ethereum-address&gt;</code>
        derived from an ECDSA secp256k1 keypair (ethers.js, BIP-340 Schnorr available for
        public-Nostr interop). No passwords anywhere — auth is signature over a server-issued
        nonce (SIWE / WebAuthn / did:key). Capability passports persist biographical identity
        across infrastructure migration; attestation registries (L2) catalog signed claims about
        agents and humans.
      </p>

      {/* L2 patterns */}
      <h2 style={h2}>What sits on top — L2 patterns</h2>
      <p style={{ ...para, maxWidth: 820 }}>
        The L1 protocol is small. L2 patterns name reusable constructions over L1:
        <code style={codeChip}>abac:</code> (attribute-based access control evaluation pattern),
        <code style={codeChip}>registry:</code> (federated public agent attestation registry),
        <code style={codeChip}>passport:</code> (capability passport), <code style={codeChip}>hyprcat:</code>
        (DCAT + DPROD + Hydra federated data-product catalog), <code style={codeChip}>hypragent:</code>
        (agent machinery for HyprCat — delegation, capability typing). Each ships with a reference
        runtime in <code style={codeChip}>src/</code>.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
        <button style={btnOutline} onClick={() => onNavigate('architecture')}>Read about layering →</button>
        <button style={btnOutline} onClick={() => onNavigate('verticals')}>See verticals built on top</button>
      </div>

      <div style={{ ...card, marginTop: 36, background: 'var(--panel-2)' }}>
        <div style={eyebrow}>One worked example you can dereference right now</div>
        <p style={{ ...para, marginTop: 6 }}>
          The Foxxi bridge publishes every outcome it records as a real descriptor. Pull one:
        </p>
        <pre style={{
          fontFamily: mono, fontSize: 11, padding: '10px 12px', background: 'var(--panel)',
          border: '1px solid var(--border)', borderRadius: 4, overflowX: 'auto', margin: '8px 0 0',
        }}>{`curl -H "Accept: text/turtle" \\
  https://interego-foxxi-bridge.../performance/calibration`}</pre>
        <p style={{ ...small(), marginTop: 8 }}>
          The pod browser does the same thing visually — click any descriptor to see its real Turtle
          and follow its affordances.
        </p>
      </div>
    </div>
  );
}

function Facet({ name, body }: { name: string; body: string }) {
  return (
    <div style={card}>
      <div style={{ fontFamily: mono, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--accent)' }}>
        {name}
      </div>
      <p style={{ ...para, fontSize: 14, margin: '6px 0 0' }}>{body}</p>
    </div>
  );
}

function ModalPill({ modalStatus }: { modalStatus: 'Asserted' | 'Hypothetical' | 'Counterfactual' }) {
  const colors: Record<typeof modalStatus, { bg: string; fg: string; explain: string }> = {
    Asserted: { bg: 'rgba(47,106,58,0.16)', fg: 'var(--good)', explain: 'committed to truth — facts you stand behind' },
    Hypothetical: { bg: 'rgba(184,114,17,0.18)', fg: 'var(--warn)', explain: 'tentative or inferred — not yet warranted' },
    Counterfactual: { bg: 'rgba(168,51,31,0.14)', fg: 'var(--bad)', explain: 'a what-if exploration — explicitly not the actual world' },
  };
  const c = colors[modalStatus];
  return (
    <div style={{
      flex: '1 1 220px', minWidth: 220, padding: '12px 14px',
      background: c.bg, borderRadius: 6, border: '1px solid var(--border)',
    }}>
      <div style={{ fontFamily: mono, fontSize: 11, color: c.fg, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        cg:{modalStatus}
      </div>
      <p style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.5 }}>{c.explain}</p>
    </div>
  );
}

function small(): React.CSSProperties { return { fontFamily: mono, fontSize: 12, color: 'var(--text-dim)' }; }
