import React, { useState } from 'react';
import { DemoCard } from '../components/DemoCard.js';
import { learnerSteps } from '../demos/learner.js';
import { adminSteps } from '../demos/admin.js';
import { leSteps } from '../demos/le.js';
import { DEMO_IDENTITIES } from '../bridge-client.js';

export type TryRole = 'learner' | 'admin' | 'le';

export function TryNow({ initialRole, onAbout, onHome }: {
  initialRole: TryRole | null;
  onAbout: () => void;
  onHome: () => void;
}) {
  const [role, setRole] = useState<TryRole>(initialRole ?? 'learner');
  const steps = role === 'learner' ? learnerSteps : role === 'admin' ? adminSteps : leSteps;
  const ident = DEMO_IDENTITIES[role === 'learner' ? 'joshua' : role === 'admin' ? 'jordan' : 'ngozi'];

  return (
    <>
      {/* Identity header */}
      <section style={{ maxWidth: 880, margin: '40px auto 24px', padding: '0 24px' }}>
        <button onClick={onHome} style={{
          background: 'transparent', border: 'none', color: 'var(--text-dim)',
          cursor: 'pointer', fontSize: 12, padding: 0, marginBottom: 14,
          fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>← back to home</button>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <RoleTab active={role === 'learner'} onClick={() => setRole('learner')}>Learner side</RoleTab>
          <RoleTab active={role === 'admin'} onClick={() => setRole('admin')}>L&amp;D admin side</RoleTab>
          <RoleTab active={role === 'le'} onClick={() => setRole('le')}>Learning engineer</RoleTab>
        </div>
        <div style={{
          padding: 20, background: 'var(--panel)',
          border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: 'var(--shadow)',
        }}>
          <div className="label">Demo identity for this session</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 6 }}>
            <div style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 24 }}>{ident.name}</div>
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{ident.role}</div>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-all' }}>
            webId: {ident.webId}
          </div>
          <div style={{ marginTop: 14, fontSize: 14, color: 'var(--text)', lineHeight: 1.6 }}>
            {role === 'learner' && <>You're seeing what Joshua sees. Every demo button below makes a <strong>real signed call</strong> to the live Foxxi bridge with Joshua's ECDSA-derived demo wallet. Other learners' data stays out of reach — try a card and check the bridge's access-decision response.</>}
            {role === 'admin' && <>You're seeing what Jordan sees. Same auth flow as the learner side but the bridge resolves Jordan to <strong>L&amp;D admin role</strong>, so admin-only affordances (issue credentials, run coverage queries, audit trails) unlock.</>}
            {role === 'le' && <>You're seeing what Ngozi sees. "Learning Engineer" is the profession IEEE ICICLE has been formalizing since Herb Simon coined it at Carnegie Mellon: <em>applying the <strong>learning sciences</strong> using <strong>human-centered design</strong>, <strong>engineering methodologies</strong>, and <strong>data-informed decision making</strong> to support learners</em>. In practice that's the three-pillar mix of learning sciences + data science + computer science — running cognitive task analysis on a course, applying the KLI (Knowledge-Learning-Instruction) framework to match practice to objectives, calibrating mastery models with BKT / IRT, and instrumenting cohorts via the ADL Total Learning Architecture (xAPI / cmi5 / SCORM 2004) the substrate ingests plus the 1EdTech competency standards (CASE / CaSS / CLR / Open Badges 3.0) it emits. Ngozi gets <strong>cohort-wide read access</strong> — design A/B experiments, run framework-gap analyses, detect learning-curve plateaus — but not credential issuance, which sits with the L&amp;D administrator role.</>}
          </div>
        </div>
      </section>

      {/* Demo steps */}
      <section style={{ maxWidth: 880, margin: '0 auto 40px', padding: '0 24px' }}>
        <div className="label" style={{ marginBottom: 14 }}>5 steps · each one a real call to the live bridge</div>
        {steps.map((step, i) => <DemoCard key={i} step={step} stepNumber={i + 1} />)}
      </section>

      {/* Footer CTAs */}
      <section style={{ maxWidth: 880, margin: '40px auto', padding: '0 24px' }}>
        <div style={{
          padding: 24, background: 'var(--text)', color: 'var(--panel)',
          borderRadius: 8,
        }}>
          <div style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 22, marginBottom: 8 }}>
            You just exercised every layer of the substrate.
          </div>
          <div style={{ color: 'rgba(245,239,226,0.75)', fontSize: 14, marginBottom: 18 }}>
            ECDSA session token → admin-only X25519 decryption → iep:discover on the tenant pod →
            VC issuance via eddsa-jcs-2022 → BBS+ selective-disclosure derivation → standards-conformant payloads, end to end.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a href="https://foxxi-dashboard.interego.xwisee.com" style={{
              padding: '10px 18px', background: 'var(--accent)', color: 'var(--panel)',
              borderRadius: 4, fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600,
              textDecoration: 'none',
            }}>Open the full dashboard →</a>
            <button onClick={onAbout} style={{
              padding: '10px 18px', background: 'transparent', color: 'var(--panel)',
              border: '1.5px solid var(--panel)', borderRadius: 4,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 500,
            }}>Understand the architecture</button>
          </div>
        </div>
      </section>
    </>
  );
}

function RoleTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '10px 16px',
      background: active ? 'var(--text)' : 'transparent',
      color: active ? 'var(--panel)' : 'var(--text)',
      border: `1.5px solid var(--text)`,
      borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12, fontWeight: 500,
      letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{children}</button>
  );
}
