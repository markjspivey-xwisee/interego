/**
 * Tier 7 — REAL end-to-end grounded chat (the actual UX claim).
 *
 * The vertical's promise is "human asks a question, agent retrieves
 * grounded answers from the wallet, returns verbatim citation with
 * cross-links, OR honest no-data when nothing in the wallet grounds
 * the question."
 *
 * Tier 1-6c covered the SUBSTRATE (zip unwraps, atoms mint, credentials
 * sign, statements roundtrip, descriptors validate). Tier 7 covers the
 * USER-FACING CLAIM end-to-end:
 *
 *   1. Build a realistic wallet from real SCORM content + a real OB 3.0
 *      credential + a real performance record + a real learning experience
 *   2. Ask multiple grounded questions — exercise actual retrieval
 *   3. Verify each answer:
 *      - Cites VERBATIM (the literal atom value, not paraphrased)
 *      - Includes the grounding atom IRI (clickable source)
 *      - Cross-links to the credential earned + completion date
 *      - Composes a valid lpc:CitedResponse descriptor
 *   4. Ask an unanswerable question → returns NULL (honest no-data,
 *      not confabulation)
 *   5. Tamper a grounding atom → answer DOES NOT cite it (atom hash
 *      mismatch detected)
 *   6. Ask review-shaped question → returns performance record verbatim
 *      with manager attribution
 *   7. Ask credential-shaped question → returns credential metadata
 *      (issuer, achievement name, issued date)
 *
 * Honesty discipline being tested:
 *   - Verbatim citation (no paraphrasing of source content)
 *   - Honest no-match (null instead of confabulation)
 *   - Tamper detection (corrupted atoms are silently skipped, not cited)
 *   - Cross-link integrity (claimed credentials must actually be in
 *     the wallet)
 *   - Provenance honesty (review citations attribute to the manager,
 *     not to the user)
 */

import { describe, it, expect } from 'vitest';
import {
  groundedAnswer,
  computeContentHash,
  citedAnswerToDescriptor,
  type UserWallet,
  type GroundingAtom,
} from '../src/grounded-answer.js';
import { unwrapScormPackage, launchableLessons } from '../../_shared/scorm/index.js';
import { extract, validate } from '../../../src/index.js';
import AdmZip from 'adm-zip';
import type { IRI } from '../../../src/index.js';

// ── Fixture wallet (real content end-to-end) ─────────────────────────

const MARK_DID  = 'did:web:mark.example' as IRI;
const ARIA_DID  = 'did:web:aria-assistant.example' as IRI;
const ACME_DID  = 'did:web:acme-training.example' as IRI;
const JANE_DID  = 'did:web:jane.example' as IRI;

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

function buildScormZip(): Buffer {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cs101.module3" version="1.0"
          xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <organizations default="cs101">
    <organization identifier="cs101">
      <title>Customer Service 101 — Module 3: Handling Frustration</title>
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

async function buildRealisticWallet(): Promise<UserWallet> {
  // Step 1: real SCORM unwrap → extract → atom
  const pkg = unwrapScormPackage(buildScormZip());
  const lesson = launchableLessons(pkg)[0]!;
  const extraction = await extract(lesson.content as string, { filename: lesson.path });

  // Confirm the SCORM pipeline actually produced the lesson text we
  // expect; use the verbatim HTML passages as atom values (so the test
  // verifies grounded-answer behavior independent of HTML-extractor
  // tokenization quirks).
  expect(extraction.text).toContain('second contact');
  expect(extraction.text).toContain('escalate');

  const passage1 = 'When a customer makes second contact about an unresolved issue, acknowledge their frustration AND the prior contact explicitly, in that order, before re-engaging on the substance.';
  const passage2 = 'Even when the technical answer is the same, the leading acknowledgment changes the conversation. Customers who feel heard cooperate; customers who feel unheard escalate.';

  const atom1: GroundingAtom = {
    iri: 'urn:pgsl:atom:cs101-mod3-second-contact-rule' as IRI,
    value: passage1,
    contentHash: computeContentHash(passage1),
  };
  const atom2: GroundingAtom = {
    iri: 'urn:pgsl:atom:cs101-mod3-acknowledgment-effect' as IRI,
    value: passage2,
    contentHash: computeContentHash(passage2),
  };

  return {
    userDid: MARK_DID,
    trainingContent: [{
      iri: 'urn:cg:lpc:training-content:cs101:mod3' as IRI,
      name: 'Customer Service 101 — Module 3',
      authoritativeSource: ACME_DID,
      atoms: [atom1, atom2],
    }],
    credentials: [{
      iri: 'urn:cg:credential:open-badge-3:cs101-mod3' as IRI,
      achievementName: 'CS-101 Mod 3: Handling Frustration',
      issuer: ACME_DID,
      issuedAt: '2025-09-15T11:00:00Z',
      forContent: 'urn:cg:lpc:training-content:cs101:mod3' as IRI,
    }],
    performanceRecords: [{
      iri: 'urn:cg:lpc:performance-record:q1-2026' as IRI,
      content: 'Strong performance in customer-service-tone area. Three specific second-contact resolutions where Mark led with explicit acknowledgment of prior contact and frustration. Growth area: in clinical-affect technical scenarios, the explicit acknowledgment occasionally felt out of place; suggest training on tone-matching across affect contexts.',
      attributedTo: JANE_DID,
      recordedAt: '2026-04-20T16:00:00Z',
    }],
    learningExperiences: [{
      iri: 'urn:cg:lpc:learning-experience:cs101-mod3' as IRI,
      forContent: 'urn:cg:lpc:training-content:cs101:mod3' as IRI,
      earnedCredential: 'urn:cg:credential:open-badge-3:cs101-mod3' as IRI,
      summary: 'Completed module 3 with score 0.86',
      completedAt: '2026-04-15T14:32:00Z',
    }],
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Tests — the actual user-facing claim
// ═════════════════════════════════════════════════════════════════════

describe('Tier 7 — grounded chat: human asks question, agent answers from wallet', () => {
  it('content question with grounding: returns VERBATIM citation + cross-links', async () => {
    const wallet = await buildRealisticWallet();
    const answer = groundedAnswer(
      'What did the customer service training say about second contact escalation?',
      wallet,
    );

    expect(answer).not.toBeNull();
    expect(answer!.citations.length).toBeGreaterThan(0);

    // Citations are VERBATIM — atom values appear literally in the response
    const cited = answer!.citations[0]!;
    expect(cited.verbatimQuote).toContain('When a customer makes second contact');
    expect(cited.verbatimQuote).toContain('acknowledge their frustration');
    expect(cited.atomIri).toMatch(/^urn:pgsl:atom:/);

    // Cross-links: training content + completion + credential
    expect(cited.fromTrainingContent).toBe('urn:cg:lpc:training-content:cs101:mod3');
    expect(cited.fromTrainingContentName).toContain('Customer Service 101');
    expect(cited.userCompletedOn).toBe('2026-04-15T14:32:00Z');
    expect(cited.userEarnedCredential).toBe('urn:cg:credential:open-badge-3:cs101-mod3');
  });

  it('display text composes citations with cross-link annotations (no paraphrasing)', async () => {
    const wallet = await buildRealisticWallet();
    const answer = groundedAnswer(
      'What does the training say about acknowledgment for second contact?',
      wallet,
    );

    expect(answer).not.toBeNull();
    const display = answer!.displayText;

    // Display includes verbatim atom values
    expect(display).toContain('When a customer makes second contact');
    // Display includes cross-link headers
    expect(display).toContain('Customer Service 101');
    expect(display).toContain('you completed this on 2026-04-15');
    expect(display).toContain('CS-101 Mod 3');
    // Display includes clickable atom IRIs
    expect(display).toMatch(/Source: urn:pgsl:atom:/);
  });

  it('UNANSWERABLE question: returns NULL (honest no-data, not confabulation)', async () => {
    const wallet = await buildRealisticWallet();

    const answer = groundedAnswer(
      'What did the training say about quantum mechanics and the lattice gauge theory?',
      wallet,
    );
    expect(answer).toBeNull();
  });

  it('TAMPERED grounding atom: response does NOT cite it (atom hash mismatch detected)', async () => {
    const wallet = await buildRealisticWallet();

    // Tamper: replace atom value while leaving content hash unchanged
    const tamperedWallet: UserWallet = {
      ...wallet,
      trainingContent: wallet.trainingContent.map(tc => ({
        ...tc,
        atoms: tc.atoms.map(a => ({
          ...a,
          value: a.value.replace('acknowledge', 'IGNORE'),  // mutated content
          // contentHash unchanged → mismatch
        })),
      })),
    };

    const answer = groundedAnswer(
      'What did the training say about second contact?',
      tamperedWallet,
    );

    // Either null (no atoms cited) or no citations include tampered text
    if (answer) {
      for (const c of answer.citations) {
        expect(c.verbatimQuote).not.toContain('IGNORE');
      }
    }
  });

  it('REVIEW question: returns performance record VERBATIM with manager attribution', async () => {
    const wallet = await buildRealisticWallet();
    const answer = groundedAnswer(
      'What did my last review say about my performance?',
      wallet,
    );

    expect(answer).not.toBeNull();
    expect(answer!.performanceCitations.length).toBe(1);

    const cited = answer!.performanceCitations[0]!;
    // Verbatim from the manager's record — no paraphrasing
    expect(cited.verbatimQuote).toContain('Strong performance');
    expect(cited.verbatimQuote).toContain('explicit acknowledgment');
    expect(cited.verbatimQuote).toContain('Growth area');
    // Provenance honesty: attributed to the manager (not to the user)
    expect(cited.attributedTo).toBe(JANE_DID);
    expect(cited.attributedTo).not.toBe(MARK_DID);
    expect(cited.recordedAt).toBe('2026-04-20T16:00:00Z');
  });

  it('CREDENTIAL question: returns credential metadata (issuer, achievement, date)', async () => {
    const wallet = await buildRealisticWallet();
    const answer = groundedAnswer(
      'Do I have any credential for handling frustration?',
      wallet,
    );

    expect(answer).not.toBeNull();
    expect(answer!.credentialCitations.length).toBe(1);

    const cited = answer!.credentialCitations[0]!;
    expect(cited.achievementName).toContain('Handling Frustration');
    expect(cited.issuer).toBe(ACME_DID);
    expect(cited.issuedAt).toBe('2025-09-15T11:00:00Z');
    expect(cited.credentialIri).toBe('urn:cg:credential:open-badge-3:cs101-mod3');
  });

  it('CONTENT question NOT covered in wallet: returns null even though wallet has unrelated content', async () => {
    const wallet = await buildRealisticWallet();
    const answer = groundedAnswer(
      'What did the training say about handling refund disputes?',
      wallet,
    );

    // The wallet HAS training content (CS-101 Mod 3), but it's about
    // second-contact escalation, not refund disputes. The agent must
    // honestly say "no data" rather than dredge up unrelated content.
    expect(answer).toBeNull();
  });

  it('cited answer materializes as a valid lpc:CitedResponse descriptor (auditable in pod)', async () => {
    const wallet = await buildRealisticWallet();
    const answer = groundedAnswer(
      'What did the training say about second contact?',
      wallet,
    );
    expect(answer).not.toBeNull();

    const desc = citedAnswerToDescriptor(
      answer!,
      ARIA_DID,
      MARK_DID,
      'urn:cg:lpc:cited-response:tier7-test' as IRI,
    );

    // Descriptor passes L1 validation
    expect(validate(desc).conforms).toBe(true);

    // Asserted by the assistant ON BEHALF OF the user
    const agent = desc.facets.find(f => f.type === 'Agent') as
      { assertingAgent?: { identity?: IRI }; onBehalfOf?: IRI };
    expect(agent?.assertingAgent?.identity).toBe(ARIA_DID);
    expect(agent?.onBehalfOf).toBe(MARK_DID);
  });

  it('cross-link integrity: citation\'s claimed credential IRI MUST exist in the wallet', async () => {
    const wallet = await buildRealisticWallet();
    const answer = groundedAnswer(
      'What did the training say about acknowledgment?',
      wallet,
    );
    expect(answer).not.toBeNull();

    for (const cited of answer!.citations) {
      if (!cited.userEarnedCredential) continue;
      const credentialActuallyExists = wallet.credentials.some(c => c.iri === cited.userEarnedCredential);
      expect(credentialActuallyExists).toBe(true);
    }
  });

  it('TWO matching atoms in same training content: BOTH cited, no silent collapse', async () => {
    const wallet = await buildRealisticWallet();
    const answer = groundedAnswer(
      'What does the training say about acknowledgment escalate frustration?',
      wallet,
    );

    expect(answer).not.toBeNull();
    // Both atoms (the rule passage AND the effect passage) match — verify
    // the agent surfaces BOTH, not just the first one (no silent collapse)
    expect(answer!.citations.length).toBeGreaterThanOrEqual(2);
    const atomIris = answer!.citations.map(c => c.atomIri);
    expect(atomIris).toContain('urn:pgsl:atom:cs101-mod3-second-contact-rule');
    expect(atomIris).toContain('urn:pgsl:atom:cs101-mod3-acknowledgment-effect');
  });

  it('empty/garbage question: returns null (no degenerate cite-everything)', async () => {
    const wallet = await buildRealisticWallet();
    expect(groundedAnswer('', wallet)).toBeNull();
    expect(groundedAnswer('???', wallet)).toBeNull();
    expect(groundedAnswer('xyz qrs lmn', wallet)).toBeNull();
  });

  it('empty wallet (cold-start user): every question returns null', () => {
    const emptyWallet: UserWallet = {
      userDid: MARK_DID,
      trainingContent: [],
      credentials: [],
      performanceRecords: [],
      learningExperiences: [],
    };

    expect(groundedAnswer('What did the training say?', emptyWallet)).toBeNull();
    expect(groundedAnswer('What was my last review?', emptyWallet)).toBeNull();
    expect(groundedAnswer('What credentials do I have?', emptyWallet)).toBeNull();
  });
});
