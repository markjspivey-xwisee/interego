/**
 * Tier 8 — production-grade end-to-end against the deployed Azure CSS.
 *
 * This is the test that proves the user-facing claim works against
 * REAL infrastructure — not in-memory wallets, not synthetic fixtures.
 * The flow is the actual production path:
 *
 *   1. INGEST a real SCORM 2004 zip into the Azure CSS pod
 *      (lpc:TrainingContent + lpc:LearningObjective + atom-bearing graph)
 *   2. IMPORT a real W3C VC (vc-jwt with Ed25519, signed by ACME)
 *      into the same pod (lpc:Credential)
 *   3. RECORD a real performance review (manager-attributed) into the pod
 *      (lpc:PerformanceRecord)
 *   4. RECORD a real xAPI Statement as a learning experience
 *      (lpc:LearningExperience cross-linked to content + credential)
 *   5. LOAD the wallet by walking the pod's manifest + descriptors
 *      + graph content (real HTTP, real parsing)
 *   6. ASK a real grounded question; get verbatim citation back
 *   7. PUBLISH the cited response back to the pod as audit trail
 *      (lpc:CitedResponse)
 *   8. ASK an unanswerable question; get null (honest no-data)
 *   9. CLEANUP — DELETE every test descriptor we wrote
 *
 * Skips automatically if Azure CSS is unreachable (network failure)
 * or if SKIP_AZURE_TESTS=1.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import AdmZip from 'adm-zip';
import { generateDidKeyEd25519, issueVcJwt } from '../../_shared/vc-jwt/index.js';
import { loadWalletFromPod } from '../src/pod-wallet.js';
import {
  ingestTrainingContent,
  importCredential,
  recordPerformanceReview,
  recordLearningExperience,
  publishCitedResponse,
} from '../src/pod-publisher.js';
import { groundedAnswer } from '../src/grounded-answer.js';
import type { IRI } from '../../../src/index.js';

// ── Config ────────────────────────────────────────────────────────────

const AZURE_CSS_BASE = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TEST_POD_BASE = `${AZURE_CSS_BASE}/u-pk-6e3bc2f9723c/`;
const REACHABILITY_TIMEOUT_MS = 8000;

// Each test uses its own sub-container so manifest writes don't race
// with other test files hitting the same pod. CSS auto-creates the
// container on first PUT; we DELETE it (and its contents) at cleanup.
function uniquePodUrl(): string {
  const id = `tier8-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${TEST_POD_BASE}${id}/`;
}

// Stable user identity for this test run; created descriptors will use
// a unique suffix per run so multiple runs don't collide
const RUN_ID = `tier8-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MARK_DID = 'did:web:tier8-test.example' as IRI;
const ARIA_DID = 'did:web:tier8-assistant.example' as IRI;

// ── Reachability + cleanup tracking ──────────────────────────────────

async function isPodReachable(): Promise<boolean> {
  if (process.env.SKIP_AZURE_TESTS === '1') return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REACHABILITY_TIMEOUT_MS);
    const r = await fetch(TEST_POD_BASE, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

const cleanupUrls: string[] = [];

async function cleanup(): Promise<void> {
  // Best-effort: also clean up the well-known manifest + container.
  // CSS won't delete a non-empty container, so we DELETE files first
  // (in cleanupUrls), then the manifest, then any sub-container roots
  // that were tracked.
  const containerRoots = new Set<string>();
  for (const url of cleanupUrls) {
    // Heuristic sub-container root extraction: everything up to and
    // including the test sub-container path component.
    const m = /^(.*\/tier8-[^/]+\/)/.exec(url);
    if (m) containerRoots.add(m[1]!);
  }

  for (const url of cleanupUrls.splice(0)) {
    try { await fetch(url, { method: 'DELETE' }); } catch { /* best-effort */ }
  }
  for (const root of containerRoots) {
    try { await fetch(`${root}.well-known/context-graphs`, { method: 'DELETE' }); } catch {}
    try { await fetch(`${root}context-graphs/`, { method: 'DELETE' }); } catch {}
    try { await fetch(`${root}.well-known/`, { method: 'DELETE' }); } catch {}
    try { await fetch(root, { method: 'DELETE' }); } catch {}
  }
}

function track(...urls: (string | undefined)[]): void {
  for (const u of urls) if (u) cleanupUrls.push(u);
}

/**
 * Load the wallet from a real pod, retrying briefly if manifest writes
 * from parallel test runs haven't propagated yet (eventual consistency).
 */
async function loadWalletWithRetry(
  config: { podUrl: string; userDid: IRI; fetchTimeoutMs?: number },
  expectedIris: readonly IRI[],
  maxAttempts = 5,
  delayMs = 1500,
): Promise<Awaited<ReturnType<typeof loadWalletFromPod>>> {
  let wallet = await loadWalletFromPod(config);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const allIris = [
      ...wallet.trainingContent.map(t => t.iri),
      ...wallet.credentials.map(c => c.iri),
      ...wallet.performanceRecords.map(r => r.iri),
      ...wallet.learningExperiences.map(le => le.iri),
    ];
    if (expectedIris.every(iri => allIris.includes(iri))) return wallet;
    if (attempt === maxAttempts) return wallet;
    await new Promise(r => setTimeout(r, delayMs));
    wallet = await loadWalletFromPod(config);
  }
  return wallet;
}

// ── Fixture: real SCORM 2004 zip ─────────────────────────────────────

const LESSON_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Lesson 4: Second-Contact Escalation</title></head>
<body>
  <h1>Lesson 4: Second-Contact Escalation</h1>
  <p>When a customer makes second contact about an unresolved issue,
  acknowledge their frustration AND the prior contact explicitly,
  in that order, before re-engaging on the substance.</p>
  <p>Even when the technical answer is the same, the leading
  acknowledgment changes the conversation. Customers who feel heard
  cooperate; customers who feel unheard escalate.</p>
</body>
</html>`;

function buildScormZip(uniqueSuffix: string): Buffer {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cs101.module3.${uniqueSuffix}" version="1.0"
          xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <organizations default="cs101">
    <organization identifier="cs101">
      <title>Customer Service 101 — Module 3 (${uniqueSuffix})</title>
      <item identifier="lesson4" identifierref="lesson4-resource">
        <title>Lesson 4: Second-Contact Escalation</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="lesson4-resource" type="webcontent"
              adlcp:scormtype="sco" href="lesson4.html">
      <file href="lesson4.html"/>
    </resource>
  </resources>
</manifest>`;
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(manifest));
  zip.addFile('lesson4.html', Buffer.from(LESSON_HTML));
  return zip.toBuffer();
}

// ─────────────────────────────────────────────────────────────────────

let podReachable = false;

beforeAll(async () => {
  podReachable = await isPodReachable();
});

describe('Tier 8 — production end-to-end against real Azure CSS', () => {
  it('reachability probe (skips remaining tests when pod is down)', () => {
    if (!podReachable) {
      console.warn(`Azure CSS at ${AZURE_CSS_BASE} is unreachable; remaining Tier 8 tests skipped`);
    }
    expect(typeof podReachable).toBe('boolean');
  });

  it('full production lifecycle: ingest → import → record → record → load → ask → cite → ask-no-data → cleanup', { timeout: 90000 }, async (ctx) => {
    if (!podReachable) return ctx.skip();
    try {
      const config = { podUrl: uniquePodUrl(), userDid: MARK_DID };

      // ─── Step 1: Ingest real SCORM into the real pod ──────────────
      const ingestResult = await ingestTrainingContent(
        buildScormZip(RUN_ID),
        'did:web:acme-training.example' as IRI,
        config,
      );
      track(ingestResult.descriptorUrl, ingestResult.graphUrl);

      expect(ingestResult.trainingContentIri).toContain(RUN_ID);
      expect(ingestResult.atomCount).toBeGreaterThan(0);
      expect(ingestResult.descriptorUrl).toContain(TEST_POD_BASE);

      // ─── Step 2: Import a real W3C VC (vc-jwt) into the pod ───────
      const acme = await generateDidKeyEd25519();
      const learner = await generateDidKeyEd25519();
      const vcPayload = {
        '@context': [
          'https://www.w3.org/ns/credentials/v2',
          'https://purl.imsglobal.org/spec/ob/v3p0/context.json',
        ],
        type: ['VerifiableCredential', 'OpenBadgeCredential'],
        id: `urn:uuid:tier8-${RUN_ID}`,
        issuer: acme.did,
        validFrom: '2025-09-15T11:00:00Z',
        credentialSubject: {
          id: learner.did,
          type: ['AchievementSubject'],
          achievement: {
            id: `urn:uuid:tier8-achievement-${RUN_ID}`,
            type: ['Achievement'],
            name: `CS-101 Mod 3 — Tier 8 (${RUN_ID})`,
            description: 'Production end-to-end test credential.',
          },
        },
      };
      const vcJwt = await issueVcJwt(vcPayload, acme);

      const credResult = await importCredential(vcJwt, config, ingestResult.trainingContentIri);
      track(credResult.descriptorUrl, credResult.graphUrl);

      expect(credResult.verified).toBe(true);
      expect(credResult.issuerDid).toBe(acme.did);
      expect(credResult.achievementName).toContain('CS-101 Mod 3');

      // ─── Step 3: Record a manager-attributed performance review ───
      const reviewResult = await recordPerformanceReview({
        content: `Tier 8 (${RUN_ID}): Strong performance in customer-service-tone area. Three specific second-contact resolutions where Mark led with explicit acknowledgment. Growth area: tone-matching across affect contexts.`,
        managerDid: 'did:web:jane.example' as IRI,
        signature: '0xfake-signature-for-tier8',
        recordedAt: '2026-04-20T16:00:00Z',
      }, config);
      track(reviewResult.descriptorUrl, reviewResult.graphUrl);

      expect(reviewResult.recordIri).toContain('performance-record');
      expect(reviewResult.descriptorUrl).toContain(TEST_POD_BASE);

      // ─── Step 4: Record an xAPI learning experience ──────────────
      const expResult = await recordLearningExperience({
        statement: {
          id: `urn:uuid:tier8-stmt-${RUN_ID}`,
          actor: { account: { homePage: 'https://acme.example', name: `mark-tier8-${RUN_ID}` } },
          verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
          object: {
            id: `https://courses.acme.example/cs101-mod3-${RUN_ID}`,
            definition: { name: { 'en-US': 'CS-101 Module 3 (Tier 8)' } },
          },
          result: { completion: true, success: true, score: { scaled: 0.86 } },
          timestamp: '2026-04-15T14:32:00Z',
        },
        forContent: ingestResult.trainingContentIri,
        earnedCredential: credResult.credentialIri,
      }, config);
      track(expResult.descriptorUrl, expResult.graphUrl);

      expect(expResult.experienceIri).toContain('learning-experience');

      // ─── Step 5: Load the wallet by walking the real pod ─────────
      // Real pods have eventual consistency — manifest updates from
      // parallel test runs can clobber each other briefly. Retry a few
      // times so we tolerate transient inconsistency. (Production agents
      // should do the same.)
      const wallet = await loadWalletWithRetry(
        { podUrl: config.podUrl, userDid: MARK_DID, fetchTimeoutMs: 12000 },
        [
          ingestResult.trainingContentIri,
          credResult.credentialIri,
          reviewResult.recordIri,
          expResult.experienceIri,
        ],
      );

      // The wallet picks up at minimum the four descriptors we just wrote
      expect(wallet.trainingContent.some(tc => tc.iri === ingestResult.trainingContentIri)).toBe(true);
      expect(wallet.credentials.some(c => c.iri === credResult.credentialIri)).toBe(true);
      expect(wallet.performanceRecords.some(r => r.iri === reviewResult.recordIri)).toBe(true);
      expect(wallet.learningExperiences.some(le => le.iri === expResult.experienceIri)).toBe(true);

      // The training content has at least one atom (from the lesson HTML)
      const ourTrainingContent = wallet.trainingContent.find(tc => tc.iri === ingestResult.trainingContentIri)!;
      expect(ourTrainingContent.atoms.length).toBeGreaterThan(0);
      const lessonAtom = ourTrainingContent.atoms[0]!;
      expect(lessonAtom.value).toContain('second contact');
      expect(lessonAtom.value).toContain('frustration');

      // ─── Step 6: Ask a grounded question; get verbatim cited answer ─
      const answer = groundedAnswer(
        'What does the customer service training say about second contact escalation?',
        wallet,
      );
      expect(answer).not.toBeNull();
      expect(answer!.citations.length).toBeGreaterThan(0);
      const citedQuote = answer!.citations.map(c => c.verbatimQuote).join(' ');
      expect(citedQuote).toContain('second contact');
      expect(citedQuote).toContain('frustration');

      // ─── Step 7: Persist the cited response back to the pod ──────
      const responseResult = await publishCitedResponse(
        { answer: answer!, assistantDid: ARIA_DID },
        config,
      );
      track(responseResult.descriptorUrl, responseResult.graphUrl);

      expect(responseResult.responseIri).toContain('cited-response');

      // ─── Step 8: Ask an unanswerable question; get honest null ───
      const unanswerableAnswer = groundedAnswer(
        'What did the training say about quantum chromodynamics and gauge theory?',
        wallet,
      );
      expect(unanswerableAnswer).toBeNull();

      // ─── Step 9: Cleanup happens in finally block ───────────────
    } finally {
      await cleanup();
    }
  });

  it('separate run: review-shaped question retrieves performance record verbatim with manager attribution', { timeout: 60000 }, async (ctx) => {
    if (!podReachable) return ctx.skip();
    try {
      const config = { podUrl: uniquePodUrl(), userDid: MARK_DID };

      // Publish a single performance record
      const reviewContent = `Tier 8 review-only run (${RUN_ID}-review): Mark's q2 review notes strong handling of escalating customer frustration during second-contact scenarios. Recommend continued practice in clinical-affect tone matching.`;
      const reviewResult = await recordPerformanceReview({
        content: reviewContent,
        managerDid: 'did:web:jane-q2.example' as IRI,
        signature: '0xtier8-review-sig',
        recordedAt: '2026-07-15T10:00:00Z',
      }, config);
      track(reviewResult.descriptorUrl, reviewResult.graphUrl);

      // Load wallet + ask review-shaped question
      const wallet = await loadWalletWithRetry(
        { podUrl: config.podUrl, userDid: MARK_DID, fetchTimeoutMs: 12000 },
        [reviewResult.recordIri],
      );

      const answer = groundedAnswer(
        'What did my review say about handling escalating customer frustration during second-contact scenarios?',
        wallet,
      );

      // We get a review citation (not lesson text)
      expect(answer).not.toBeNull();
      // Find OUR review (the one this test wrote, not stale residue)
      const ourCitation = answer!.performanceCitations.find(p => p.recordIri === reviewResult.recordIri);
      expect(ourCitation).toBeDefined();
      expect(ourCitation!.verbatimQuote).toContain('clinical-affect');
      // Provenance honesty: attributed to MANAGER not user
      expect(ourCitation!.attributedTo).toBe('did:web:jane-q2.example');
      expect(ourCitation!.attributedTo).not.toBe(MARK_DID);
    } finally {
      await cleanup();
    }
  });
});
