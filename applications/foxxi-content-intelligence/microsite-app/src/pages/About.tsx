import React from 'react';

export function About({ onTry, onHome }: { onTry: (role: 'learner' | 'admin' | 'le') => void; onHome: () => void }) {
  return (
    <section style={{ maxWidth: 820, margin: '50px auto', padding: '0 24px' }}>
      <button onClick={onHome} style={{
        background: 'transparent', border: 'none', color: 'var(--text-dim)',
        cursor: 'pointer', fontSize: 12, padding: 0, marginBottom: 18,
        fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>← back to home</button>

      <h1 style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 44, margin: 0 }}>
        How it actually works
      </h1>

      <p style={{ fontSize: 18, color: 'var(--text-dim)', marginTop: 14, lineHeight: 1.55 }}>
        Foxxi is one vertical on top of <strong>Interego</strong>, an open substrate for verifiable
        agent + learner context graphs. The substrate gives you signed descriptors, encrypted
        envelopes, federated discovery, and composable trust. Foxxi is the L&amp;D-specific
        composition.
      </p>

      <Section title="Three layers, cleanly separated">
        <p>
          <strong>Substrate (Interego)</strong> — context-descriptor publish/discover, X25519 envelope
          encryption, ABAC, capability passports, Verifiable Credentials (Ed25519 + BBS+),
          DID resolution (did:key / did:web / did:ethr). Knows nothing about L&amp;D.
        </p>
        <p>
          <strong>Vertical (Foxxi)</strong> — composes the substrate. Owns the <code>fxs:</code> /
          <code>fxk:</code> / <code>fxa:</code> / <code>rcd:</code> / <code>wallet:</code> namespaces.
          Parses SCORM packages, runs agentic Q&amp;A, mints OB3 credentials, projects to CASE 1.0
          JSON-LD, federates xAPI queries across LRSs. Doesn't propose changes to the substrate.
        </p>
        <p>
          <strong>Surfaces</strong> — the bridge (MCP at <code>/mcp</code> + REST at
          <code> /affordances</code>), the dashboard (this microsite's bigger sibling), and this
          microsite. All three call the same affordances; nothing is "demo-only."
        </p>
      </Section>

      <Section title="Standards you already invested in">
        <p>
          Every credential the bridge mints carries the official spec contexts —
          <code>https://purl.imsglobal.org/spec/ob/v3p0/...</code>, the CASE 1.0 JSON-LD context,
          W3C VC 2.0. Third-party verifiers don't need Foxxi-specific code; they just verify the
          standard payload. The <a href="https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence/CONFORMANCE.md">CONFORMANCE.md</a>
          {' '}in the repo lists every standard with file:line citations to the implementation.
        </p>
      </Section>

      <Section title="What the try-it-now demo actually does">
        <p>
          Every button in the try-it-now flow makes a real signed POST to the live bridge at
          <code> https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp</code>.
          The bridge:
        </p>
        <ol style={{ paddingLeft: 22, lineHeight: 1.6 }}>
          <li>verifies your demo wallet signature recovers an address in the published tenant directory</li>
          <li>fetches the (E2EE-encrypted) directory + policies via <code>iep:discover()</code> against the live Solid pod</li>
          <li>decrypts admin sections with its deterministic X25519 admin key</li>
          <li>applies role-based filtering (you only see Joshua's data even if you ask about Jordan)</li>
          <li>composes whatever the affordance demands — agentic RAG, BBS+ derive, CASE export, audit walk — and signs the trace</li>
        </ol>
        <p>
          When you close the tab the demo wallet vanishes from your browser. The bridge state persists
          but it's just Joshua &amp; Jordan's pre-seeded data; nothing about you was recorded.
        </p>
      </Section>

      <Section title="Where to go next">
        <p>
          The <a href="https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io">full
          dashboard</a> is the production-grade surface for the same affordances. The
          {' '}<a href="https://github.com/markjspivey-xwisee/interego">source repo</a> has every
          conformance claim wired to code. The
          {' '}<a href="https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence/CHANGELOG.md">
          CHANGELOG</a> walks the build history.
        </p>
      </Section>

      <div style={{ marginTop: 36, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={() => onTry('learner')} style={{
          padding: '12px 20px', background: 'var(--text)', color: 'var(--panel)',
          border: 'none', borderRadius: 4,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>Try as a learner →</button>
        <button onClick={() => onTry('admin')} style={{
          padding: '12px 20px', background: 'transparent', color: 'var(--text)',
          border: '1.5px solid var(--text)', borderRadius: 4,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 500,
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>Try as L&amp;D admin →</button>
      </div>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 36 }}>
      <h2 style={{
        fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
        fontSize: 26, margin: 0, marginBottom: 10, color: 'var(--text)',
      }}>{title}</h2>
      <div style={{ fontSize: 16, color: 'var(--text)', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}
