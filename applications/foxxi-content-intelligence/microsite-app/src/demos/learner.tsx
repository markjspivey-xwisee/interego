import React from 'react';
import { callBridge, DEMO_IDENTITIES } from '../bridge-client.js';
import type { DemoStep } from '../components/DemoCard.js';

const JOSHUA = DEMO_IDENTITIES.joshua;

// State the learner flow needs to carry across cards (so step 5 can use
// the credential issued in step 4 without the visitor re-clicking).
const sessionState: { lastBbsIssued?: unknown } = {};

export const learnerSteps: DemoStep[] = [
  {
    title: 'Discover what you’re assigned',
    subtitle: 'foxxi.discover_assigned_courses',
    body: (
      <>
        Foxxi tenants publish their roster + policies as encrypted descriptors on a Solid pod. When you
        ask the bridge "what am I assigned?", it walks the pod, verifies the descriptors are signed by
        the tenant's authoritative source, then resolves your audience-tag membership to the
        matching assignments. You see <strong>only your enrollments</strong> — never the other 182
        employees' data.
      </>
    ),
    actionLabel: 'Fetch my assignments',
    run: () => callBridge({
      tool: 'foxxi.discover_assigned_courses',
      args: { learner_did: JOSHUA.webId },
      identity: 'joshua',
    }),
    summarize: (r) => {
      const x = r as { enrollments?: unknown[] };
      return x?.enrollments ? `${x.enrollments.length} enrollments resolved` : 'no result';
    },
    explainer: (r) => {
      const x = r as { learnerName?: string; audienceTags?: string[]; enrollments?: Array<{ courseTitle: string; status: string }>; accessDecision?: { decision: string; callerRole: string } };
      if (!x?.enrollments) return <em>Bridge returned an error — check the call trace above.</em>;
      const overdueCount = x.enrollments.filter(e => e.status === 'overdue').length;
      return (
        <>
          The bridge resolved you as <strong>{x.learnerName}</strong> via your audience tags
          ({x.audienceTags?.join(', ')}), walked the tenant's encrypted directory + policy descriptors,
          and returned {x.enrollments.length} assignments — {overdueCount} overdue. Notice the
          <code style={{ marginLeft: 4 }}>accessDecision</code> field on the response: every authenticated
          call emits a <code>fxa:AccessDecision</code> trace recording the policy that fired
          ({x.accessDecision?.decision} / role: {x.accessDecision?.callerRole}). Try clicking the call trace
          above to see the full response.
        </>
      );
    },
  },

  {
    title: 'Ask Golf Explained a real question',
    subtitle: 'foxxi.ask_course_question_agentic',
    body: (
      <>
        Foxxi parsed the SCORM package for "Golf Explained" into a concept graph (19 concepts,
        14 prereq edges, 14 slides). Ask a question; the bridge runs agentic retrieval (federated
        concept-graph search → prereq + modifier-of edge expansion → round-robin slide allocation →
        LLM synthesis grounded in the verbatim transcripts). Every step emits an Interego trace
        descriptor so the answer's provenance is auditable end-to-end.
      </>
    ),
    actionLabel: 'Ask “what is handicap?”',
    run: () => callBridge({
      tool: 'foxxi.ask_course_question_agentic',
      args: { learner_did: JOSHUA.webId, course_id: 'golf-explained', question: 'what is handicap?' },
      identity: 'joshua',
    }),
    summarize: (r) => {
      const x = r as { synthesizedAnswer?: string; retrieval?: { seedConcepts?: unknown[]; citedSlides?: unknown[] } };
      if (x?.synthesizedAnswer) return `answered (${x.synthesizedAnswer.length} chars) · ${x.retrieval?.citedSlides?.length ?? 0} cited slides`;
      return x?.retrieval ? `${x.retrieval.seedConcepts?.length} seeds, ${x.retrieval.citedSlides?.length} cited slides (no LLM key configured)` : 'no result';
    },
    explainer: (r) => {
      const x = r as {
        synthesizedAnswer?: string;
        llmModel?: string;
        llmKeySource?: string;
        retrieval?: { seedConcepts?: Array<{ conceptLabel: string }>; citedSlides?: Array<{ slideTitle: string; sequenceIndex: number }> };
        trace?: Array<{ type: string; modalStatus: string }>;
        error?: string;
      };
      if (x?.error) return <em>Bridge returned: {x.error}</em>;
      if (!x?.retrieval) return <em>Bridge returned an error.</em>;
      const seeds = x.retrieval.seedConcepts?.slice(0, 3).map(s => s.conceptLabel).join(', ');
      if (x.synthesizedAnswer) {
        return (
          <>
            <div style={{
              padding: 12, background: 'var(--panel)', borderRadius: 4,
              fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 16,
              marginBottom: 12, lineHeight: 1.55, borderLeft: '3px solid var(--good)',
            }}>
              "{x.synthesizedAnswer}"
            </div>
            The bridge ran the full agentic pipeline: picked <em>{seeds}</em> as seed concepts, pulled
            {' '}{x.retrieval.citedSlides?.length} verbatim transcript citations from the Foxxi-parsed
            slides, then asked {x.llmModel} to synthesise an answer using <strong>only</strong> the
            cited transcripts. Inference paid for by <code>{x.llmKeySource}</code>. Each pipeline step
            ({x.trace?.map(t => t.type.split(':').pop()).join(' → ')}) emitted an Interego trace
            descriptor with proper modal status — Asserted on the final answer, Hypothetical on the
            retrieval scaffold the answer references.
          </>
        );
      }
      // No LLM key — fell through to retrieval scaffold only.
      return (
        <>
          The bridge ran the retrieval pipeline (seed concepts: <em>{seeds}</em>; {x.retrieval.citedSlides?.length} cited
          slides) but didn't synthesise an answer because the tenant operator hasn't set
          <code> FOXXI_LLM_API_KEY</code> on the bridge yet. The scaffold itself is still useful — an
          MCP-native agent (Claude Code / Cursor) would synthesise in its own session using these
          citations. Once an Anthropic key is configured, this same call returns a full prose answer.
        </>
      );
    },
  },

  {
    title: 'See everything your wallet holds',
    subtitle: 'foxxi.export_clr',
    body: (
      <>
        Your pod IS your wallet. Foxxi's <code>export_clr</code> walks your pod for every
        <code>fxa:CourseCompletionCredential</code> + <code>fxa:CompetencyAssertion</code>, verifies
        each one's W3C Data Integrity Proof, and aggregates them into a 1EdTech Comprehensive Learner
        Record 2.0 envelope. Each entry preserves its own signature — a third-party verifier can
        re-check any single credential without trusting the envelope.
      </>
    ),
    actionLabel: 'Export my CLR',
    run: () => callBridge({
      tool: 'foxxi.export_clr',
      args: { learner_did: JOSHUA.webId, learner_pod_url: 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/foxxi/' },
      identity: 'joshua',
    }),
    summarize: (r) => {
      const x = r as { summary?: { totalEntries?: number; verifiedEntries?: number; issuers?: string[] } };
      return x?.summary ? `${x.summary.verifiedEntries}/${x.summary.totalEntries} verified · ${x.summary.issuers?.length ?? 0} issuer${x.summary?.issuers?.length === 1 ? '' : 's'}` : 'no result';
    },
    explainer: (r) => {
      const x = r as { summary?: { totalEntries?: number; verifiedEntries?: number; issuers?: string[] }; '@context'?: string[] };
      if (!x?.summary) return <em>Bridge returned an error.</em>;
      return (
        <>
          The envelope wraps {x.summary.totalEntries} credentials (all verified) from
          {' '}{x.summary.issuers?.length} distinct issuer{x.summary?.issuers?.length === 1 ? '' : 's'}.
          The <code>@context</code> array references the official CLR 2.0 + W3C VC 2.0 spec contexts
          ({x['@context']?.length} contexts in total), so any CLR-aware verifier accepts the document.
          The envelope itself is unsigned — it's an aggregator; trust flows through each per-entry proof.
          If you completed step 4 below first, you'll see a fresh BBS+ credential here too.
        </>
      );
    },
  },

  {
    title: 'Earn a BBS+ credential',
    subtitle: 'foxxi.issue_bbs_credential (admin-issued, you receive)',
    body: (
      <>
        For this step we simulate Jordan (your L&amp;D admin) issuing you a BBS+ -signed Open Badges 3.0
        credential for Golf Explained. BBS+ is the W3C cryptosuite that enables selective disclosure later in
        step 5 — the signature commits to <em>all</em> claims, but you can later prove only the ones you
        choose to reveal. The whole credential lands in your wallet; the next step shows what you do
        with it.
      </>
    ),
    actionLabel: 'Have Jordan issue me a BBS+ credential',
    run: async () => {
      const call = await callBridge({
        tool: 'foxxi.issue_bbs_credential',
        args: {
          learner_did: JOSHUA.webId,
          course_id: 'golf-explained',
          course_title: 'Golf Explained',
          score_scaled: 0.87,
          proficiency_level: 'Intermediate',
          aligned_skills: [
            { targetCode: 'handicap', targetName: 'Handicap calculation', proficiencyLevel: 'Intermediate' },
            { targetCode: 'pace-of-play', targetName: 'pace of play', proficiencyLevel: 'Beginner' },
          ],
        },
        identity: 'jordan',
      });
      sessionState.lastBbsIssued = call.result;
      return call;
    },
    summarize: (r) => {
      const x = r as { credential?: { type?: string[] }; claimIndex?: unknown[] };
      return x?.credential ? `${x.credential.type?.length}-type VC, ${x.claimIndex?.length} BBS+ claims signed` : 'no result';
    },
    explainer: (r) => {
      const x = r as { issuerDid?: string; credential?: { type?: string[]; credentialSubject?: { achievement?: { name?: string } } }; claimIndex?: unknown[] };
      if (!x?.credential) return <em>Bridge returned an error — make sure the admin auth path is wired (you may need to retry).</em>;
      return (
        <>
          Jordan's bridge derived a deterministic BBS+ keypair from <code>FOXXI_ISSUER_KEY_SEED</code>,
          built an OB3-shaped W3C VC for <em>{x.credential.credentialSubject?.achievement?.name}</em>,
          flattened your claims into {x.claimIndex?.length} ordered messages, and signed them with one
          BLS12-381 signature. Issuer DID: <code style={{ wordBreak: 'break-all' }}>{x.issuerDid?.slice(0, 60)}…</code>.
          The full credential is now in <code>sessionState.lastBbsIssued</code> for the next step.
        </>
      );
    },
  },

  {
    title: 'Prove competence without revealing your score',
    subtitle: 'foxxi.derive_bbs_presentation → foxxi.verify_bbs_presentation',
    body: (
      <>
        Imagine you're applying at PartnerCo. They want proof of your <em>handicap proficiency</em> —
        nothing else. Not your score, not your alignment to <em>pace of play</em>, not the credential ID,
        not other competencies you hold. You derive a zero-knowledge BBS+ proof revealing only the
        three claims you choose. The verifier learns those three claims + nothing else — the hidden
        claims stay <em>cryptographically hidden</em>, not just visually masked.
      </>
    ),
    actionLabel: 'Derive ZK proof + verify',
    run: async () => {
      if (!sessionState.lastBbsIssued) {
        throw new Error('Run step 4 first to receive the BBS+ credential.');
      }
      const derive = await callBridge({
        tool: 'foxxi.derive_bbs_presentation',
        args: {
          issued: sessionState.lastBbsIssued,
          reveal_paths: ['issuer', 'achievement.name', 'achievement.alignment[0].targetCode'],
          presentation_header: 'partnerco-recruiter-2026-interview',
        },
      });
      const verify = await callBridge({
        tool: 'foxxi.verify_bbs_presentation',
        args: { presentation: derive.result },
      });
      return [derive, verify];
    },
    summarize: (r) => {
      const x = r as { verified?: boolean; disclosed?: unknown[] };
      return x?.verified ? `✓ verifier accepted · learned ${x.disclosed?.length} claims` : 'verify failed';
    },
    explainer: (r) => {
      const x = r as { verified?: boolean; disclosed?: Array<{ path: string; value: string }> };
      if (!x?.verified) return <em>Verification failed — check the call traces above.</em>;
      return (
        <>
          The verifier accepted your proof <strong>without ever seeing</strong> the other 11 claims in
          your credential. They learned exactly this: {x.disclosed?.map((d, i) => (
            <span key={i} style={{ display: 'inline-block', margin: '4px 4px 0 0', padding: '2px 8px', background: 'rgba(47,106,58,0.14)', border: '1px solid rgba(47,106,58,0.32)', borderRadius: 999, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>{d.path}={d.value.slice(0, 40)}{d.value.length > 40 ? '…' : ''}</span>
          ))}. The score (0.87), the PLL alignment, the credential ID, the validFrom timestamp — all
          present in the BBS+ signature mathematically, none of them disclosed. This is the W3C
          <code> bbs-2023</code> cryptosuite running for real against BLS12-381.
        </>
      );
    },
  },
];
