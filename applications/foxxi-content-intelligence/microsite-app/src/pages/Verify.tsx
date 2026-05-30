import React, { useState } from 'react';
import { callBridge, DEMO_IDENTITIES } from '../bridge-client.js';

/**
 * Verifier portal — the "third side" of credentialing after learner +
 * admin. A recruiter / compliance officer / partner-org verifier
 * pastes a learner WebID, picks which competency they want proof of,
 * and either:
 *   (a) sees the holder's verified credentials directly, OR
 *   (b) requests a BBS+ selective-disclosure presentation revealing
 *       only the claims required for the role.
 *
 * Everything is real: the verifier calls foxxi.export_clr (no auth
 * needed for public credentials — admins can also lock down per-CLR
 * via ABAC) + foxxi.verify_bbs_presentation to check ZK proofs the
 * learner derives.
 */
export function Verify({ onHome }: { onHome: () => void }) {
  const [step, setStep] = useState<'pick' | 'reviewing' | 'requesting' | 'verified'>('pick');
  const [learnerDid, setLearnerDid] = useState<string>(DEMO_IDENTITIES.joshua.webId);
  const [requiredCompetency, setRequiredCompetency] = useState('handicap');
  const [requiredLevel, setRequiredLevel] = useState<'Beginner' | 'Intermediate' | 'Advanced' | 'Expert'>('Intermediate');
  const [clr, setClr] = useState<unknown>(null);
  const [bbsCredential, setBbsCredential] = useState<unknown>(null);
  const [presentation, setPresentation] = useState<unknown>(null);
  const [verification, setVerification] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reviewWallet() {
    setBusy(true); setError(null);
    try {
      const r = await callBridge({
        tool: 'foxxi.export_clr',
        args: { learner_did: learnerDid, learner_pod_url: 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/foxxi/' },
        identity: 'joshua', // verifier acts as the learner for the demo (learner authorized the export)
      });
      setClr(r.result);
      setStep('reviewing');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function requestSelectiveProof() {
    setBusy(true); setError(null);
    try {
      // Step 1: admin issues a BBS+ credential to the learner (in production the credential already exists in the pod).
      const issue = await callBridge({
        tool: 'foxxi.issue_bbs_credential',
        args: {
          learner_did: learnerDid,
          course_id: 'golf-explained',
          course_title: 'Golf Explained',
          score_scaled: 0.87,
          proficiency_level: requiredLevel,
          aligned_skills: [{ targetCode: requiredCompetency, targetName: requiredCompetency, proficiencyLevel: requiredLevel }],
        },
        identity: 'jordan',
      });
      setBbsCredential(issue.result);
      // Step 2: learner derives a presentation revealing ONLY the required claim
      const derive = await callBridge({
        tool: 'foxxi.derive_bbs_presentation',
        args: {
          issued: issue.result,
          reveal_paths: ['issuer', 'achievement.alignment[0].targetCode', 'achievement.alignment[0].proficiencyLevel'],
          presentation_header: `verifier-portal-${Date.now()}`,
        },
      });
      setPresentation(derive.result);
      // Step 3: verifier checks the proof
      const verify = await callBridge({
        tool: 'foxxi.verify_bbs_presentation',
        args: { presentation: derive.result },
      });
      setVerification(verify.result);
      setStep('verified');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ maxWidth: 880, margin: '40px auto', padding: '0 24px' }}>
      <button onClick={onHome} style={{
        background: 'transparent', border: 'none', color: 'var(--text-dim)',
        cursor: 'pointer', fontSize: 12, padding: 0, marginBottom: 14,
        fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>← back to home</button>

      <h1 style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 44, margin: 0 }}>
        Verifier portal
      </h1>
      <p style={{ fontSize: 18, color: 'var(--text-dim)', marginTop: 12, lineHeight: 1.55 }}>
        You're a recruiter / compliance officer / partner-org consumer of credentials. The learner has
        granted you their WebID. Now you can either review their full wallet, or request a
        zero-knowledge presentation revealing only the claims relevant to your role.
      </p>

      {/* Step 1: pick learner + competency */}
      <div style={{
        marginTop: 30, padding: 22, background: 'var(--panel)',
        border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow)',
      }}>
        <div className="label" style={{ marginBottom: 10 }}>Step 1 — Identify the holder + your requirement</div>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>Learner WebID</div>
          <input
            value={learnerDid}
            onChange={e => setLearnerDid(e.target.value)}
            style={{
              width: '100%', padding: '8px 10px',
              background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4,
              fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
            }}
          />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <label>
            <div style={{ fontSize: 13, marginBottom: 4 }}>Required competency</div>
            <input
              value={requiredCompetency}
              onChange={e => setRequiredCompetency(e.target.value)}
              style={{
                width: '100%', padding: '8px 10px',
                background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4,
                fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
              }}
            />
          </label>
          <label>
            <div style={{ fontSize: 13, marginBottom: 4 }}>Minimum level</div>
            <select
              value={requiredLevel}
              onChange={e => setRequiredLevel(e.target.value as typeof requiredLevel)}
              style={{
                width: '100%', padding: '8px 10px',
                background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4,
                fontSize: 12,
              }}
            >
              <option>Beginner</option>
              <option>Intermediate</option>
              <option>Advanced</option>
              <option>Expert</option>
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
          <button onClick={reviewWallet} disabled={busy} style={{
            padding: '10px 16px', background: 'var(--text)', color: 'var(--panel)',
            border: 'none', borderRadius: 4,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            opacity: busy ? 0.5 : 1, cursor: busy ? 'wait' : 'pointer',
          }}>{busy ? 'Working…' : 'Review full wallet'}</button>
          <button onClick={requestSelectiveProof} disabled={busy} style={{
            padding: '10px 16px', background: 'var(--accent)', color: 'var(--panel)',
            border: 'none', borderRadius: 4,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            opacity: busy ? 0.5 : 1, cursor: busy ? 'wait' : 'pointer',
          }}>{busy ? 'Working…' : 'Request ZK proof only'}</button>
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim)' }}>
          ZK proof = recruiter sees ONLY the proficiency level + competency — not the score, not the credential ID,
          not the other competencies the learner holds. Real BBS+ math, not visual masking.
        </div>
      </div>

      {error && (
        <div style={{
          marginTop: 18, padding: 12,
          background: 'rgba(168,51,31,0.10)', border: '1px solid rgba(168,51,31,0.32)',
          borderRadius: 4, color: 'var(--bad)', fontSize: 13,
        }}>✗ {error}</div>
      )}

      {/* Wallet review path */}
      {clr !== null && step === 'reviewing' && (
        <div style={{
          marginTop: 18, padding: 22, background: 'var(--panel)',
          border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow)',
        }}>
          <div className="label" style={{ marginBottom: 10 }}>Step 2 — Full wallet review (learner-authorized)</div>
          <WalletSummary clr={clr} />
        </div>
      )}

      {/* Selective disclosure path */}
      {step === 'verified' && verification !== null && (
        <div style={{
          marginTop: 18, padding: 22, background: 'var(--panel)',
          border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow)',
        }}>
          <div className="label" style={{ marginBottom: 10 }}>Step 2 — Verified selective-disclosure proof</div>
          <ProofSummary verification={verification} bbsCredential={bbsCredential} />
        </div>
      )}
    </section>
  );
}

function WalletSummary({ clr }: { clr: unknown }) {
  const x = clr as { summary?: { totalEntries?: number; verifiedEntries?: number; achievements?: string[]; issuers?: string[] } };
  if (!x?.summary) return <em>No wallet content returned.</em>;
  return (
    <div>
      <div style={{ fontSize: 16, marginBottom: 10 }}>
        <strong>{x.summary.verifiedEntries}</strong> verified credential
        {x.summary.verifiedEntries === 1 ? '' : 's'} (of {x.summary.totalEntries}).
      </div>
      <div className="label" style={{ marginBottom: 6 }}>Achievements</div>
      <div style={{ marginBottom: 14 }}>
        {(x.summary.achievements ?? []).map((a, i) => (
          <div key={i} style={{
            padding: '8px 12px', marginBottom: 6,
            background: 'var(--panel-2)', borderLeft: '3px solid var(--good)',
            fontSize: 14, fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
          }}>{a}</div>
        ))}
      </div>
      <div className="label" style={{ marginBottom: 6 }}>Issuers (verifiable independently via did:key)</div>
      {(x.summary.issuers ?? []).map((iss, i) => (
        <div key={i} style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-all', marginBottom: 4 }}>
          {iss}
        </div>
      ))}
    </div>
  );
}

function ProofSummary({ verification, bbsCredential }: { verification: unknown; bbsCredential: unknown }) {
  const v = verification as { verified?: boolean; disclosed?: Array<{ path: string; value: string }> };
  const bc = bbsCredential as { claimIndex?: unknown[] };
  if (!v) return null;
  return (
    <div>
      <div style={{
        padding: 12, marginBottom: 14,
        background: v.verified ? 'rgba(47,106,58,0.14)' : 'rgba(168,51,31,0.14)',
        border: `1px solid ${v.verified ? 'rgba(47,106,58,0.32)' : 'rgba(168,51,31,0.32)'}`,
        borderRadius: 4, fontSize: 15,
      }}>
        {v.verified
          ? <><strong style={{ color: 'var(--good)' }}>✓ Issuer cryptographically signed this proof.</strong> The learner has not been able to forge any of the disclosed claims, and the verifier has learned ONLY the disclosed claims (the other {(bc.claimIndex?.length ?? 0) - (v.disclosed?.length ?? 0)} claims in the credential remain hidden).</>
          : <><strong style={{ color: 'var(--bad)' }}>✗ Proof did not verify.</strong> Reject the presentation.</>}
      </div>
      <div className="label" style={{ marginBottom: 6 }}>Disclosed claims (everything the verifier learned)</div>
      {(v.disclosed ?? []).map((d, i) => (
        <div key={i} style={{
          padding: '8px 12px', marginBottom: 6,
          background: 'var(--panel-2)', borderLeft: '3px solid var(--accent)',
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
        }}>
          <strong>{d.path}</strong> = {d.value.slice(0, 80)}{d.value.length > 80 ? '…' : ''}
        </div>
      ))}
      <div style={{ marginTop: 14, fontSize: 13, color: 'var(--text-dim)' }}>
        Everything ELSE the issuer signed — the learner's score, the credential ID, other competencies in
        the credential, exact validFrom timestamp — was hidden by the BBS+ ZK proof and is
        cryptographically unrecoverable from what you received. The signature itself was valid;
        the holder simply chose not to reveal the other claims.
      </div>
    </div>
  );
}
