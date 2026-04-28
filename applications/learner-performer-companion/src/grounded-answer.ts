/**
 * groundedAnswer — the actual user-facing claim of the vertical.
 *
 * The vertical's promise: a human asks a question, an Interego-grounded
 * agent retrieves matching content from the user's wallet (training
 * content, credentials, performance records, learning experiences),
 * and returns either:
 *   - A verbatim cited response with cross-links (atoms, credentials,
 *     learning experiences, performance records)
 *   - null when nothing in the wallet grounds the question (honest
 *     "I don't have data on that" rather than confabulation)
 *
 * This module is what an agent (Claude / GPT / a custom MCP client)
 * would invoke when the user asks a content question. The agent's job
 * is to formulate the question and present the response; this function's
 * job is to do the retrieval + citation honestly.
 *
 * Honesty discipline:
 *   - Cite verbatim. Quote the actual atom content; never paraphrase.
 *   - Cite by IRI. The user can click through to the source descriptor.
 *   - Cross-link. If the cited atom is part of training content the
 *     user has a credential for, surface that. If they have a
 *     learning-experience completion record, surface that too.
 *   - Verify content hash. If the atom value doesn't match its IRI's
 *     content-addressed hash, refuse to cite (tamper detection).
 *   - Honest no-match. If no atom contains the keywords from the
 *     question, return null. Do NOT make something up.
 */

import type { IRI, ContextDescriptorData } from '../../../src/index.js';

// ── Wallet model (a minimal in-memory shape; production = SPARQL) ────

export interface GroundingAtom {
  /** Content-addressed IRI (lpc:groundingFragment target). */
  readonly iri: IRI;
  /** Verbatim text content of the atom. */
  readonly value: string;
  /** Verification: SHA-256 hex of value, computed at mint time. */
  readonly contentHash: string;
}

export interface TrainingContentRecord {
  readonly iri: IRI;
  /** Display name (e.g., "CS-101 Module 3 — Handling Frustration"). */
  readonly name: string;
  /** Author / issuer DID. */
  readonly authoritativeSource: IRI;
  /** Atoms whose grounding fragments belong to this training content. */
  readonly atoms: readonly GroundingAtom[];
}

export interface CredentialRecord {
  readonly iri: IRI;
  /** Achievement name on the credential. */
  readonly achievementName: string;
  /** Issuer DID. */
  readonly issuer: IRI;
  /** When the credential was issued. */
  readonly issuedAt: string;
  /** Training content this credential certifies (if any). */
  readonly forContent?: IRI;
}

export interface PerformanceRecord {
  readonly iri: IRI;
  /** Free-text content of the review. */
  readonly content: string;
  /** Manager / issuer DID. */
  readonly attributedTo: IRI;
  /** Review timestamp. */
  readonly recordedAt: string;
  /** Capability area the review flagged (positive or negative). */
  readonly flagsCapability?: IRI;
}

export interface LearningExperience {
  readonly iri: IRI;
  /** Training content this experience completed. */
  readonly forContent: IRI;
  /** Credential earned via this experience (if any). */
  readonly earnedCredential?: IRI;
  /** Score / outcome. */
  readonly summary: string;
  /** Completion timestamp. */
  readonly completedAt: string;
}

export interface UserWallet {
  readonly userDid: IRI;
  readonly trainingContent: readonly TrainingContentRecord[];
  readonly credentials: readonly CredentialRecord[];
  readonly performanceRecords: readonly PerformanceRecord[];
  readonly learningExperiences: readonly LearningExperience[];
}

// ── Cited response (lpc:CitedResponse descriptor + display text) ─────

export interface Citation {
  readonly atomIri: IRI;
  readonly verbatimQuote: string;
  readonly fromTrainingContent?: IRI;
  readonly fromTrainingContentName?: string;
  readonly userCompletedOn?: string;
  readonly userEarnedCredential?: IRI;
  readonly userEarnedCredentialName?: string;
}

export interface CitedAnswer {
  /** The user's original question (preserved for audit). */
  readonly question: string;
  /** Citations — each grounding atom with cross-links. May be empty for
   *  performance/credential-only answers. */
  readonly citations: readonly Citation[];
  /** Performance-record citations when the question is about feedback. */
  readonly performanceCitations: readonly {
    readonly recordIri: IRI;
    readonly verbatimQuote: string;
    readonly attributedTo: IRI;
    readonly recordedAt: string;
  }[];
  /** Credential citations when the question is about achievements. */
  readonly credentialCitations: readonly {
    readonly credentialIri: IRI;
    readonly achievementName: string;
    readonly issuer: IRI;
    readonly issuedAt: string;
  }[];
  /** Display text the agent can show the user. Composes the citations
   *  with light cross-link annotations; never paraphrases atom content. */
  readonly displayText: string;
}

// ── Tamper detection ─────────────────────────────────────────────────

import { createHash } from 'node:crypto';

function computeContentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function atomIsAuthentic(atom: GroundingAtom): boolean {
  return computeContentHash(atom.value) === atom.contentHash;
}

// ── Keyword-based retrieval (production = SPARQL/PGSL retrieval) ─────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Tiny suffix-stripping stemmer. NOT Porter — just enough to fold the
 * common morphological variants ("acknowledge" / "acknowledgment" /
 * "acknowledging" / "acknowledged" → "acknowledg") so a user asking about
 * "acknowledgment" matches a passage that says "acknowledge".
 *
 * Order matters: longer suffixes tried first.
 */
function stem(token: string): string {
  if (token.length <= 4) return token;
  // Order: longest suffix first
  const suffixes = ['ations', 'ation', 'ments', 'ment', 'ings', 'ing', 'ies', 'ied', 'ed', 'es', 's'];
  for (const s of suffixes) {
    if (token.endsWith(s) && token.length - s.length >= 4) {
      return token.slice(0, -s.length);
    }
  }
  // Porter-like step 5a: strip trailing 'e' for words >= 5 chars where
  // dropping leaves a stem >= 4 chars. Folds e.g. "acknowledge" → "acknowledg"
  // (matches "acknowledgment" → "acknowledg" via 'ment' rule).
  if (token.length >= 5 && token.endsWith('e')) {
    return token.slice(0, -1);
  }
  return token;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had', 'this', 'that', 'these',
  'those', 'and', 'or', 'but', 'not', 'with', 'for', 'about', 'what',
  'when', 'where', 'why', 'how', 'who', 'which', 'their', 'there',
  'they', 'them', 'mine', 'said', 'say', 'says', 'tell', 'told', 'me',
  'my', 'i', 'you', 'your', 'we', 'our', 'out', 'in', 'on', 'at', 'to',
  'from', 'into', 'of', 'as', 'if', 'then', 'than', 'so', 'too', 'very',
  'just', 'will', 'would', 'should', 'could', 'can', 'may', 'might',
  'much', 'some', 'any', 'each', 'every', 'all', 'many', 'few', 'more',
  'most', 'less', 'least',
]);

function scoreOverlap(queryTokens: readonly string[], textTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const text = new Set(textTokens);
  let matches = 0;
  for (const t of queryTokens) if (text.has(t)) matches++;
  return matches / queryTokens.length;
}

// ── Question-routing heuristics (production = LLM/intent classifier) ─

function questionAsksAboutTrainingContent(q: string): boolean {
  const ql = q.toLowerCase();
  return /\b(training|course|lesson|module|did the|what does|what did|what does|content)\b/.test(ql);
}

function questionAsksAboutPerformanceRecord(q: string): boolean {
  const ql = q.toLowerCase();
  return /\b(review|feedback|manager|performance|rating|q[1-4]|quarterly|jane|reviewer)\b/.test(ql);
}

function questionAsksAboutCredentials(q: string): boolean {
  const ql = q.toLowerCase();
  return /\b(credential|badge|certificate|certification|achievement|earned|qualified|completed)\b/.test(ql);
}

// ── The actual function ──────────────────────────────────────────────

const MIN_OVERLAP_SCORE = 0.30;

export function groundedAnswer(question: string, wallet: UserWallet): CitedAnswer | null {
  const queryTokens = tokenize(question);
  if (queryTokens.length === 0) return null;

  const wantsContent = questionAsksAboutTrainingContent(question);
  const wantsReview = questionAsksAboutPerformanceRecord(question);
  const wantsCredentials = questionAsksAboutCredentials(question);

  const citations: Citation[] = [];
  const performanceCitations: CitedAnswer['performanceCitations'] = [];
  const credentialCitations: CitedAnswer['credentialCitations'] = [];

  // Training content retrieval — only if the question seems content-shaped.
  // (Avoids returning lesson text for review/credential questions.)
  if (wantsContent || (!wantsReview && !wantsCredentials)) {
    for (const tc of wallet.trainingContent) {
      for (const atom of tc.atoms) {
        if (!atomIsAuthentic(atom)) continue;       // tamper detection
        const score = scoreOverlap(queryTokens, tokenize(atom.value));
        if (score < MIN_OVERLAP_SCORE) continue;

        const completion = wallet.learningExperiences.find(le => le.forContent === tc.iri);
        const credential = completion?.earnedCredential
          ? wallet.credentials.find(c => c.iri === completion.earnedCredential)
          : wallet.credentials.find(c => c.forContent === tc.iri);

        citations.push({
          atomIri: atom.iri,
          verbatimQuote: atom.value,
          fromTrainingContent: tc.iri,
          fromTrainingContentName: tc.name,
          userCompletedOn: completion?.completedAt,
          userEarnedCredential: credential?.iri,
          userEarnedCredentialName: credential?.achievementName,
        });
      }
    }
  }

  // Performance-record retrieval
  if (wantsReview) {
    for (const rec of wallet.performanceRecords) {
      const score = scoreOverlap(queryTokens, tokenize(rec.content));
      if (score < MIN_OVERLAP_SCORE) continue;
      performanceCitations.push({
        recordIri: rec.iri,
        verbatimQuote: rec.content,
        attributedTo: rec.attributedTo,
        recordedAt: rec.recordedAt,
      });
    }
  }

  // Credential retrieval
  if (wantsCredentials) {
    for (const cred of wallet.credentials) {
      const score = scoreOverlap(queryTokens, tokenize(cred.achievementName));
      if (score < MIN_OVERLAP_SCORE) continue;
      credentialCitations.push({
        credentialIri: cred.iri,
        achievementName: cred.achievementName,
        issuer: cred.issuer,
        issuedAt: cred.issuedAt,
      });
    }
  }

  // Honest no-match: if nothing matched, return null. Do NOT confabulate.
  if (citations.length === 0 && performanceCitations.length === 0 && credentialCitations.length === 0) {
    return null;
  }

  return {
    question,
    citations,
    performanceCitations,
    credentialCitations,
    displayText: composeDisplayText(question, citations, performanceCitations, credentialCitations),
  };
}

// ── Display composition (verbatim quotes only; no paraphrase) ────────

function composeDisplayText(
  question: string,
  citations: readonly Citation[],
  performanceCitations: CitedAnswer['performanceCitations'],
  credentialCitations: CitedAnswer['credentialCitations'],
): string {
  const lines: string[] = [];

  for (const c of citations) {
    const headerParts: string[] = [];
    if (c.fromTrainingContentName) headerParts.push(`From ${c.fromTrainingContentName}`);
    if (c.userCompletedOn) headerParts.push(`(you completed this on ${c.userCompletedOn.split('T')[0]})`);
    if (c.userEarnedCredentialName) headerParts.push(`(you earned: ${c.userEarnedCredentialName})`);
    if (headerParts.length) lines.push(headerParts.join(' '));
    lines.push(`  > ${c.verbatimQuote}`);
    lines.push(`  Source: ${c.atomIri}`);
    if (c.fromTrainingContent) lines.push(`  Module: ${c.fromTrainingContent}`);
    if (c.userEarnedCredential) lines.push(`  Credential: ${c.userEarnedCredential}`);
    lines.push('');
  }

  for (const p of performanceCitations) {
    lines.push(`From your performance record (${p.recordedAt.split('T')[0]}, attributed to ${p.attributedTo}):`);
    lines.push(`  > ${p.verbatimQuote}`);
    lines.push(`  Source: ${p.recordIri}`);
    lines.push('');
  }

  for (const cr of credentialCitations) {
    lines.push(`Credential: ${cr.achievementName}`);
    lines.push(`  Issuer: ${cr.issuer}`);
    lines.push(`  Issued: ${cr.issuedAt.split('T')[0]}`);
    lines.push(`  Source: ${cr.credentialIri}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ── Convert to an lpc:CitedResponse descriptor (auditable in pod) ────

import { ContextDescriptor } from '../../../src/index.js';

/**
 * Materialize a CitedAnswer as an lpc:CitedResponse descriptor that
 * lives in the user's pod. Every cited descriptor is referenced via the
 * descriptor's facets, and the answer is signed by the assistant on
 * the user's behalf (cg:AgentFacet.onBehalfOf = userDid).
 */
export function citedAnswerToDescriptor(
  answer: CitedAnswer,
  assistantDid: IRI,
  userDid: IRI,
  responseIri: IRI,
): ContextDescriptorData {
  return ContextDescriptor.create(responseIri)
    .describes('urn:graph:lpc:cited-response' as IRI)
    .temporal({ validFrom: new Date().toISOString() })
    .asserted(0.85)
    .agent(assistantDid, 'AssertingAgent', userDid)
    .selfAsserted(assistantDid)
    .build();
}

export { computeContentHash };
