/**
 * Foxxi BBS+ credential flow — issue, hold, derive, verify with
 * selective disclosure.
 *
 * Composition:
 *   1. `issueBbsCompletionCredential` — builds an OB3-shaped VC + signs
 *      it with the tenant's deterministic BBS+ key. The credential's
 *      claims are flattened into an ordered BBS+ message list; the
 *      signature commits to ALL messages but the holder can later
 *      reveal subsets.
 *   2. `deriveCompletionPresentation` — holder-side. Given the issued
 *      credential + a list of which claims to reveal, derives a
 *      zero-knowledge BBS+ proof revealing only those claims.
 *   3. `verifyCompletionPresentation` — verifier-side. Given the
 *      derived proof + the revealed claim set, returns whether the
 *      issuer signed a credential containing those claims.
 *
 * Three principals:
 *   - issuer    (tenant — has the BBS+ private key)
 *   - holder    (learner — receives the full credential + chooses what to reveal)
 *   - verifier  (third party — sees only the proof + revealed claims)
 *
 * Standards reference:
 *   - W3C VC Data Integrity 1.0 `bbs-2023` cryptosuite
 *   - BBS+ Signatures Draft 06
 *   - 1EdTech Open Badges 3.0 (OB3 credential shape)
 *
 * NOTE: this complements credentials.ts (which uses Ed25519 +
 * eddsa-jcs-2022). Both paths produce VCs that any W3C VC verifier
 * understands; the BBS+ path additionally enables selective
 * disclosure.
 */

import { createHash } from 'node:crypto';
import {
  generateBbsKeyPair,
  bbsSign,
  bbsVerify,
  bbsDeriveProof,
  bbsVerifyProof,
  flattenCredentialSubject,
  type BbsKeyPair,
} from '../../_shared/vc-jwt/bbs-2023.js';

/**
 * Deterministic BBS+ issuer keypair from a tenant seed. Different
 * seed → different keypair (and different DID); same seed → same.
 * Operator keeps the seed in a secret manager.
 */
export async function deriveBbsIssuer(seed: string): Promise<BbsKeyPair> {
  const h = createHash('sha256').update(`foxxi-bbs-issuer:${seed}`).digest();
  return generateBbsKeyPair(new Uint8Array(h));
}

// ── Issuance ──────────────────────────────────────────────────

export interface BbsCompletionSubject {
  learnerDid: string;
  learnerName?: string;
  courseId: string;
  courseTitle: string;
  scoreScaled: number;
  proficiencyLevel: 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
  alignedSkills: ReadonlyArray<{ targetCode: string; targetName: string; proficiencyLevel?: string }>;
}

export interface BbsIssuedCredential {
  /** OB3-shaped credential JSON (no proof — the proof is the BBS+ signature on the message list). */
  credential: Record<string, unknown>;
  /** Ordered list of claim messages the signature commits to. */
  messages: readonly Uint8Array[];
  /** Plain-text rendering of each message so the holder knows the index → claim mapping. */
  claimIndex: ReadonlyArray<{ index: number; path: string; displayValue: string }>;
  /** BBS+ signature over the message list. */
  signature: Uint8Array;
  /** Issuer's BBS+ public key (for the verifier — published separately as a key descriptor in production). */
  issuerPublicKey: Uint8Array;
  issuerPublicKeyMultibase: string;
  /** Issuer DID — for the demo we use the BBS+ multibase pubkey as a did:key-style identifier. */
  issuerDid: string;
}

export async function issueBbsCompletionCredential(args: {
  subject: BbsCompletionSubject;
  tenantProfileName: string;
  issuerSeed: string;
}): Promise<BbsIssuedCredential> {
  const issuer = await deriveBbsIssuer(args.issuerSeed);
  // Use a did:key-style identifier with the bls12_381-g2-pub multicodec.
  const issuerDid = `did:key:${issuer.publicKeyMultibase}`;

  const now = new Date().toISOString();
  const credential = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
      'https://w3id.org/security/data-integrity/v2',
    ],
    id: `urn:foxxi:bbs-credential:${args.subject.courseId}:${slugDid(args.subject.learnerDid)}:${Date.now()}`,
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    issuer: issuerDid,
    validFrom: now,
    credentialSubject: {
      id: args.subject.learnerDid,
      type: ['AchievementSubject'],
      ...(args.subject.learnerName ? { name: args.subject.learnerName } : {}),
      score: args.subject.scoreScaled,
      achievement: {
        id: `urn:foxxi:achievement:${args.subject.courseId}`,
        type: ['Achievement'],
        name: args.subject.courseTitle,
        // OB3 requires description + criteria on the achievement.
        description: `Demonstrated competency: ${args.subject.courseTitle}.`,
        criteria: { narrative: `Awarded on demonstrated performance of ${args.subject.courseTitle} at proficiency ${args.subject.proficiencyLevel}.` },
        proficiencyLevel: args.subject.proficiencyLevel,
        alignment: args.subject.alignedSkills.map(s => ({
          type: ['Alignment'],
          targetCode: s.targetCode,
          targetName: s.targetName,
          ...(s.proficiencyLevel ? { proficiencyLevel: s.proficiencyLevel } : {}),
        })),
      },
    },
  };

  // Flatten the credentialSubject into ordered messages. The path becomes
  // the human-readable handle the holder uses to decide what to reveal.
  // Include top-level credential fields too so the verifier can re-bind to
  // the original issuer + validFrom + credential id.
  const subjFlat = flattenCredentialSubject(credential.credentialSubject as Record<string, unknown>);
  const enc = new TextEncoder();
  const topLevelMessages = [
    { path: 'issuer', value: enc.encode(`issuer=${credential.issuer}`) },
    { path: 'validFrom', value: enc.encode(`validFrom=${credential.validFrom}`) },
    { path: 'credentialId', value: enc.encode(`credentialId=${credential.id}`) },
  ];
  const allMessages = [...topLevelMessages, ...subjFlat];
  const messages = allMessages.map(m => m.value);
  const claimIndex = allMessages.map((m, i) => ({
    index: i,
    path: m.path,
    displayValue: new TextDecoder().decode(m.value),
  }));

  const signature = await bbsSign({
    messages,
    privateKey: issuer.privateKey,
    publicKey: issuer.publicKey,
  });

  // Sanity self-check.
  const ok = await bbsVerify({ signature, messages, publicKey: issuer.publicKey });
  if (!ok) throw new Error('issued BBS+ credential failed self-verify');

  // Embed the BBS+ signature as an inline Data Integrity proof so the credential self-carries
  // proof.type (still selective-disclosure-derivable from the message list). The cryptosuite is
  // deliberately NOT labelled 'bbs-2023': the W3C vc-di-bbs 'bbs-2023' base proof is a multibase
  // CBOR of [bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers] over rdfc-canonicalized
  // N-Quads. This is a raw BBS signature over a bespoke dot-path message flatten — a DIFFERENT
  // scheme — so it carries a Foxxi-namespaced cryptosuite id to avoid FALSELY claiming vc-di-bbs
  // conformance to a verifier. proofValue is the raw signature as multibase base64url ('u').
  (credential as Record<string, unknown>).proof = {
    type: 'DataIntegrityProof',
    cryptosuite: 'bbs-flatten-foxxi-2024',
    created: now,
    verificationMethod: `${issuerDid}#bbs`,
    proofPurpose: 'assertionMethod',
    proofValue: 'u' + Buffer.from(signature).toString('base64url'),
  };

  return {
    credential,
    messages,
    claimIndex,
    signature,
    issuerPublicKey: issuer.publicKey,
    issuerPublicKeyMultibase: issuer.publicKeyMultibase,
    issuerDid,
  };
}

// ── Holder-side selective-disclosure derivation ──────────────

export interface CredentialPresentation {
  /** ZK proof bytes (BBS+ derived proof). */
  proof: Uint8Array;
  /** Indexes (into the original message list) of the disclosed messages. */
  disclosedIndexes: number[];
  /** The disclosed messages themselves (as raw bytes for the verifier). */
  disclosedMessages: ReadonlyArray<{ index: number; message: Uint8Array; displayValue: string }>;
  /** Issuer's BBS+ pubkey (verifier needs it to verify the proof). */
  issuerPublicKey: Uint8Array;
  issuerDid: string;
  /** Free-form domain (binds the proof to a specific verifier / occasion). */
  presentationHeader?: Uint8Array;
}

/**
 * Holder selects which claims to disclose by their `path` strings. The
 * issued credential's `claimIndex` is the menu the holder picks from.
 */
export async function deriveCompletionPresentation(args: {
  issued: BbsIssuedCredential;
  revealPaths: readonly string[];
  presentationHeader?: Uint8Array;
}): Promise<CredentialPresentation> {
  const wantSet = new Set(args.revealPaths);
  const revealedIndexes: number[] = [];
  const revealedDetail: Array<{ index: number; message: Uint8Array; displayValue: string }> = [];
  for (const claim of args.issued.claimIndex) {
    if (wantSet.has(claim.path)) {
      revealedIndexes.push(claim.index);
      revealedDetail.push({
        index: claim.index,
        message: args.issued.messages[claim.index]!,
        displayValue: claim.displayValue,
      });
    }
  }
  const proof = await bbsDeriveProof({
    signature: args.issued.signature,
    messages: args.issued.messages,
    revealedIndexes,
    publicKey: args.issued.issuerPublicKey,
    presentationHeader: args.presentationHeader,
  });
  return {
    proof,
    disclosedIndexes: revealedIndexes,
    disclosedMessages: revealedDetail,
    issuerPublicKey: args.issued.issuerPublicKey,
    issuerDid: args.issued.issuerDid,
    presentationHeader: args.presentationHeader,
  };
}

// ── Verifier-side check ──────────────────────────────────────

export interface VerifierResult {
  verified: boolean;
  reason?: string;
  /** What the verifier learns (the disclosed claims as strings). */
  disclosed: ReadonlyArray<{ path: string; value: string }>;
}

export async function verifyCompletionPresentation(args: { presentation: CredentialPresentation }): Promise<VerifierResult> {
  const ok = await bbsVerifyProof({
    proof: args.presentation.proof,
    disclosedMessages: args.presentation.disclosedMessages.map(d => ({ index: d.index, message: d.message })),
    publicKey: args.presentation.issuerPublicKey,
    presentationHeader: args.presentation.presentationHeader,
  });
  // Derive the disclosed claims from the cryptographically-VERIFIED `message` bytes
  // (what the issuer's BBS+ signature actually commits to), NOT the holder-supplied
  // `displayValue` wire field. displayValue is a THIRD, unbound input — trusting it let
  // a holder (or a MITM) report claim values the issuer never signed (e.g. flip a signed
  // proficiencyLevel=Beginner to =Expert while leaving the proven message bytes intact),
  // defeating the core vc-di-bbs / OB3 selective-disclosure guarantee. Only disclose when
  // the proof verified — a failed proof discloses nothing.
  const dec = new TextDecoder();
  return {
    verified: ok,
    reason: ok ? undefined : 'BBS+ proof verification failed',
    disclosed: ok
      ? args.presentation.disclosedMessages.map(d => {
          const [path, ...rest] = dec.decode(d.message).split('=');
          return { path: path!, value: rest.join('=') };
        })
      : [],
  };
}

function slugDid(did: string): string {
  return did.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 80);
}
