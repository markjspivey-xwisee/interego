import React from 'react';

export function Landing({ onTry, onAbout, onConvergence }: { onTry: (role: 'learner' | 'admin' | 'le') => void; onAbout: () => void; onConvergence: () => void }) {
  return (
    <>
      {/* Hero */}
      <section style={{ maxWidth: 980, margin: '60px auto 30px', padding: '0 24px' }}>
        <div className="label" style={{ marginBottom: 14 }}>performance architecture · four regimes · four directionalities · interego vertical</div>
        <h1 style={{
          fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
          fontSize: 56, lineHeight: 1.06, margin: 0, letterSpacing: '-0.02em',
        }}>
          Foxxi is the performance-architecture<br />vertical of Interego.
        </h1>
        <p style={{
          fontSize: 20, lineHeight: 1.55, maxWidth: 760, marginTop: 22, color: 'var(--text-dim)',
        }}>
          The unit of work is a <em>performance situation</em>, not a course or a credential. Each
          situation is routed to one of four work regimes — Evident, Knowable, Emergent, Turbulent —
          and each regime brings its own method. Gap analysis is the Knowable regime's method; it is
          not the universal frame.
        </p>
        <p style={{
          fontSize: 17, lineHeight: 1.6, maxWidth: 760, marginTop: 16, color: 'var(--text-dim)',
        }}>
          The same affordances serve all four directionalities of work: human-to-human, human-to-agent,
          agent-to-human, and agent-to-agent. A nurse coaching a nurse, an agent teaching another
          agent, and an agent supporting a human use the same substrate, signed and attributed end
          to end.
        </p>
        <p style={{
          fontSize: 17, lineHeight: 1.6, maxWidth: 760, marginTop: 16, color: 'var(--text-dim)',
        }}>
          Outcomes are reflexive. What actually happened recomposes the calibration profile (upward
          causation); the updated profile shapes the next plan (downward causation). Federation lets
          peer evidence from other orgs compose into the local profile without giving up custody of
          the underlying records.
        </p>
        <p style={{
          fontSize: 15, lineHeight: 1.6, maxWidth: 760, marginTop: 16, color: 'var(--text-dim)',
        }}>
          The LRS, LMS, SCORM, cmi5, LTI 1.3 and OneRoster surfaces are emergent projections over
          the Interego substrate — one signed graph rendered through each standard's lens, not
          parallel implementations. Don't take our word for it: the <strong>Compliance</strong> tab
          lets you run Foxxi's xAPI 2.0 (IEEE 9274.1.1) and SCORM 2004 Sequencing &amp; Navigation
          conformance batteries live against this deployment and read every check.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 30, flexWrap: 'wrap' }}>
          <PrimaryCta onClick={() => onTry('learner')}>Try it as a learner →</PrimaryCta>
          <SecondaryCta onClick={() => onTry('admin')}>Try it as an L&amp;D admin →</SecondaryCta>
          <SecondaryCta onClick={() => onTry('le')}>Try it as a learning engineer →</SecondaryCta>
          <SecondaryCta onClick={onAbout}>How it works</SecondaryCta>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 16, fontFamily: "'JetBrains Mono', monospace" }}>
          no signup · runs against a real cloud-deployed substrate · stops working when you close the tab
        </div>
      </section>

      {/* What is this — 4 value props */}
      <section style={{ maxWidth: 1100, margin: '60px auto 0', padding: '0 24px' }}>
        <div className="label" style={{ marginBottom: 20 }}>Four things you can't easily do today</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          <ValueProp
            title="Selective disclosure"
            blurb="Prove you're competent in handicap control without revealing your score, employer, or any other course you've taken. BBS+ selective-disclosure proofs make this real."
          />
          <ValueProp
            title="Cross-org portability"
            blurb="Move from Acme Training to PartnerCo, hand over your pod URL, your credentials follow. No re-credentialing, no spreadsheet hand-offs, no PDF transcripts."
          />
          <ValueProp
            title="AI-mentored learning"
            blurb="An AI agent reviews your work + signs a CompetencyAssertion VC — modal status Hypothetical. A human admin countersigns to elevate it to a real OB3 badge."
          />
          <ValueProp
            title="One-query audit trail"
            blurb="For regulators, one descriptor query returns every cmi5 completion → OB3 credential → CASE competency alignment → policy citation → SOC 2 control. Cryptographically verifiable end-to-end."
          />
        </div>
      </section>

      {/* Standards row */}
      <section style={{ maxWidth: 1100, margin: '60px auto 0', padding: '0 24px' }}>
        <div className="label" style={{ marginBottom: 12 }}>Composes the standards stack you already invested in</div>
        <div style={{
          padding: 18, background: 'var(--panel)',
          border: '1px solid var(--border)', borderRadius: 6,
          fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
          color: 'var(--text-dim)', lineHeight: 1.8,
        }}>
          ADL SCORM 1.2 / 2004 · ADL xAPI 1.0.3 / 2.0.0 (IEEE 9274.1.1) ·
          ADL cmi5 (IEEE 9274.2.1, all 9 statements) · IEEE LOM 1484.12.1 ·
          IEEE RDCEO/RCD 1484.20 · 1EdTech CASE 1.0 · ADL CaSS ·
          1EdTech Open Badges 3.0 · 1EdTech CLR 1.0 + 2.0 ·
          W3C Verifiable Credentials 2.0 (vc-jwt + eddsa-jcs-2022 + eddsa-rdfc-2022 + bbs-2023) ·
          W3C DIDs (did:key + did:web + did:ethr) ·
          ADL TLA Master Object Model · ADL TLA Experience Index (write + read-side federation)
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }}>
          Every conformance claim is wired to source code in the public repo.
        </div>
      </section>

      {/* W3C convergence callout */}
      <section style={{ maxWidth: 1100, margin: '34px auto 0', padding: '0 24px' }}>
        <div style={{
          padding: 20, background: 'var(--panel)',
          border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)', borderRadius: 6,
          display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between',
        }}>
          <div style={{ maxWidth: 720 }}>
            <div style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 21, color: 'var(--text)' }}>
              How Interego lines up with the W3C
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.55, marginTop: 6 }}>
              The W3C Holon CG, Kurt Cagle&rsquo;s DataBook spec, and the Context Graphs CG explore ideas Interego
              independently arrived at. Four live, no-signup panels map each to the corresponding Interego primitive —
              including the strict <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5 }}>SKILL.md&nbsp;&#8644;&nbsp;iep:Affordance</code> translator.
              No precedence is claimed in either direction.
            </div>
          </div>
          <SecondaryCta onClick={onConvergence}>W3C convergence &rarr;</SecondaryCta>
        </div>
      </section>

      {/* Bottom CTA */}
      <section style={{
        maxWidth: 980, margin: '60px auto', padding: '40px 24px',
        background: 'var(--text)', color: 'var(--panel)',
        borderRadius: 8,
      }}>
        <div style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 32, lineHeight: 1.2 }}>
          Five real bridge calls, three minutes, no signup.
        </div>
        <div style={{ marginTop: 12, color: 'rgba(245,239,226,0.75)', fontSize: 15 }}>
          The try-it-now flow runs every demo against the live deployed bridge — same code path
          a production tenant would use. Pick a side:
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
          <PrimaryCta onClick={() => onTry('learner')} inverse>I'm a learner →</PrimaryCta>
          <PrimaryCta onClick={() => onTry('admin')} inverse>I'm an L&amp;D admin →</PrimaryCta>
          <PrimaryCta onClick={() => onTry('le')} inverse>I'm a learning engineer →</PrimaryCta>
        </div>
      </section>
    </>
  );
}

function PrimaryCta({ children, onClick, inverse }: { children: React.ReactNode; onClick: () => void; inverse?: boolean }) {
  return (
    <button onClick={onClick} style={{
      padding: '14px 22px',
      background: inverse ? 'var(--accent)' : 'var(--text)',
      color: inverse ? 'var(--panel)' : 'var(--panel)',
      border: 'none', borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13, fontWeight: 600,
      letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{children}</button>
  );
}

function SecondaryCta({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '13px 20px',
      background: 'transparent', color: 'var(--text)',
      border: '1.5px solid var(--text)', borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13, fontWeight: 500,
      letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{children}</button>
  );
}

function ValueProp({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div style={{
      padding: 20, background: 'var(--panel)',
      border: '1px solid var(--border)', borderRadius: 6,
      boxShadow: 'var(--shadow)',
    }}>
      <div style={{
        fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
        fontSize: 22, marginBottom: 10, color: 'var(--text)',
      }}>{title}</div>
      <div style={{ fontSize: 15, color: 'var(--text)', lineHeight: 1.55 }}>{blurb}</div>
    </div>
  );
}
