/**
 * Foxxi competency proof — holder-facing BBS+ selective disclosure.
 *
 * The substrate already has the three BBS+ primitives (issue / derive /
 * verify) as separate affordances. They map cleanly onto the three LER
 * principals — issuer (tenant), holder (learner), verifier (employer) —
 * but that separation makes a learner-facing demo awkward: issuance is
 * (correctly) admin-only, so a learner cannot drive the whole flow from
 * the dashboard.
 *
 * `proveCompetency` composes all three into ONE holder-facing operation:
 *
 *   1. ISSUE   — the bridge, acting as the tenant issuer (it legitimately
 *                holds the tenant BBS+ key), signs a credential that
 *                commits to many claims about the competency.
 *   2. DERIVE  — the holder discloses only a minimal, privacy-preserving
 *                subset (the competency name + proficiency + issuer);
 *                everything else — score, learner name, dates, credential
 *                id — stays hidden behind the zero-knowledge proof.
 *   3. VERIFY  — a verifier confirms the issuer signed a credential
 *                containing exactly those disclosed claims, learning
 *                nothing about the hidden ones.
 *
 * The learner triggers a holder operation ("prove my competency"); the
 * admin-only issuance happens server-side under the tenant key. Correct
 * trust model, no cross-role session juggling.
 *
 * This is the LER privacy story IEEE P2997 needs and a flat credential
 * wallet cannot give: prove one competency to an employer without
 * surrendering the whole transcript.
 */

import {
  issueBbsCompletionCredential,
  deriveCompletionPresentation,
  verifyCompletionPresentation,
} from './bbs-credentials.js';

/** Minimal privacy-preserving disclosure set — proves "this competency,
 *  at this proficiency, issued by this tenant" and nothing else. */
const DEFAULT_REVEAL_PATHS = ['issuer', 'achievement.name', 'achievement.proficiencyLevel'] as const;

export interface ProveCompetencyArgs {
  learnerDid: string;
  learnerName?: string;
  /** Competency / course title being proved (becomes Achievement.name). */
  competencyName: string;
  courseId?: string;
  scoreScaled?: number;
  proficiencyLevel?: 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
  tenantProfileName: string;
  /** Tenant BBS+ issuer seed (FOXXI_ISSUER_KEY_SEED). */
  issuerSeed: string;
  /** Claim paths to disclose. Defaults to the minimal privacy-preserving
   *  set; unknown paths are dropped. */
  revealPaths?: readonly string[];
  /** Optional verifier/occasion binding (BBS+ presentation header). */
  presentationContext?: string;
}

export interface CompetencyProofResult {
  verified: boolean;
  reason?: string;
  issuerDid: string;
  competencyName: string;
  /** Total claims the BBS+ signature commits to. */
  totalClaims: number;
  /** Claims disclosed to the verifier. */
  revealedClaims: Array<{ path: string; value: string }>;
  /** Claims kept hidden by the zero-knowledge proof. */
  hiddenClaimCount: number;
  hiddenClaimPaths: string[];
  presentationContext?: string;
  /** Base64 BBS+ proof bytes alone. Retained for wire compatibility.
   *
   *  ★ This is NOT sufficient to re-verify. A BBS+ proof is checked against the
   *  disclosed messages, their indexes, and the issuer public key; the proof bytes
   *  on their own cannot be verified by anyone. This field used to be documented as
   *  "an external verifier can re-check it", which was false — the grounded proof
   *  was, in practice, verifiable only by the bridge that minted it. Use
   *  `presentation` below for anything a third party must check. */
  proofB64: string;
  /** Reveal paths the caller asked for that the credential does not carry.
   *
   *  Unknown paths are dropped so derivation cannot throw, but dropping them
   *  silently meant a caller could ask to reveal a claim, be told nothing failed,
   *  and hand over a presentation disclosing NOTHING. Naming them is the
   *  difference between a privacy guarantee and an accident. */
  unknownRevealPaths: string[];
  /** The serialized presentation, sufficient for an INDEPENDENT verifier.
   *
   *  Binary BBS+ fields are base64-encoded for transport. Feed this straight to
   *  foxxi.verify_presentation — which is what that affordance's description has
   *  always claimed to accept. */
  presentation: {
    proof: string;
    disclosedIndexes: number[];
    disclosedMessages: Array<{ index: number; message: string; displayValue: string }>;
    issuerPublicKey: string;
    issuerDid: string;
    /** Present when the proof was bound to an occasion. A verifier MUST echo this
     *  back, or the proof will not verify — the binding is the point. */
    presentationContext?: string;
  };
}

/**
 * Compose issue → derive → verify into one holder-facing competency
 * proof. Returns what a verifier would learn (disclosed claims) and what
 * stayed private (hidden count + paths).
 */
export async function proveCompetency(args: ProveCompetencyArgs): Promise<CompetencyProofResult> {
  // 1. ISSUE — tenant-as-issuer signs a multi-claim BBS+ credential.
  const issued = await issueBbsCompletionCredential({
    subject: {
      learnerDid: args.learnerDid,
      learnerName: args.learnerName,
      courseId: args.courseId ?? slug(args.competencyName),
      courseTitle: args.competencyName,
      scoreScaled: args.scoreScaled ?? 1.0,
      proficiencyLevel: args.proficiencyLevel ?? 'Intermediate',
      alignedSkills: [],
    },
    tenantProfileName: args.tenantProfileName,
    issuerSeed: args.issuerSeed,
  });

  // 2. DERIVE — holder discloses only the minimal set; drop any path the
  //    credential does not actually carry so derivation never throws.
  const known = new Set(issued.claimIndex.map(c => c.path));
  const wanted = (args.revealPaths && args.revealPaths.length > 0)
    ? args.revealPaths
    : DEFAULT_REVEAL_PATHS;
  const revealPaths = wanted.filter(p => known.has(p));
  const unknownRevealPaths = wanted.filter(p => !known.has(p));
  const header = args.presentationContext
    ? new TextEncoder().encode(args.presentationContext)
    : undefined;
  const presentation = await deriveCompletionPresentation({
    issued,
    revealPaths,
    presentationHeader: header,
  });

  // 3. VERIFY — confirm the proof.
  const result = await verifyCompletionPresentation({ presentation });

  const revealedSet = new Set(revealPaths);
  const hidden = issued.claimIndex.filter(c => !revealedSet.has(c.path));

  return {
    verified: result.verified,
    reason: result.reason,
    issuerDid: issued.issuerDid,
    competencyName: args.competencyName,
    totalClaims: issued.claimIndex.length,
    revealedClaims: result.disclosed.map(d => ({ path: d.path, value: d.value })),
    hiddenClaimCount: hidden.length,
    hiddenClaimPaths: hidden.map(c => c.path),
    presentationContext: args.presentationContext,
    proofB64: Buffer.from(presentation.proof).toString('base64'),
    unknownRevealPaths,
    presentation: {
      proof: Buffer.from(presentation.proof).toString('base64'),
      disclosedIndexes: presentation.disclosedIndexes,
      disclosedMessages: presentation.disclosedMessages.map(d => ({
        index: d.index,
        message: Buffer.from(d.message).toString('base64'),
        displayValue: d.displayValue,
      })),
      issuerPublicKey: Buffer.from(presentation.issuerPublicKey).toString('base64'),
      issuerDid: presentation.issuerDid,
      ...(args.presentationContext ? { presentationContext: args.presentationContext } : {}),
    },
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'competency';
}
