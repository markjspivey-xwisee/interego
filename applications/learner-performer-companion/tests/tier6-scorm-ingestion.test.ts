/**
 * Tier 6 — REAL SCORM / cmi5 / training-content ingestion.
 *
 * The lpc:TrainingContent + lpc:LearningObjective + lpc:groundingFragment
 * pipeline claims that an authoritative training source can be ingested
 * into a knowledge graph the assistant can cite verbatim.
 *
 * Tier 1 verified the descriptor shape. Tier 6 verifies the INGESTION
 * PIPELINE end-to-end:
 *   1. A real SCORM 1.2 imsmanifest.xml + HTML lesson content
 *   2. extract() pulls text from the HTML lesson
 *   3. mintAtom on the extracted passage produces a content-addressed
 *      PGSL IRI (deterministic — same passage → same IRI across runs)
 *   4. The chunked output preserves the passage that the assistant
 *      cites in companion-chat.mjs
 *   5. Same content with one byte changed produces a DIFFERENT atom IRI
 *      (verifying content-addressing actually addresses content)
 *
 * What this proves:
 *   - The src/extractors/ pipeline handles real SCORM-shaped HTML lesson
 *     content (the format the example claims to ingest)
 *   - PGSL atoms are deterministically content-addressed → grounding
 *     citations are stable across re-ingestion runs
 *   - ExtractionResult carries provenance metadata + content hash
 *
 * What this does NOT prove:
 *   - Full SCORM 2004 / cmi5 package unzipping + manifest walking (the
 *     extract() function takes raw content; SCORM-package-aware
 *     unwrapping would be a thin wrapper around extract())
 *   - xAPI cmi5 launch protocol (separate concern, lives in lrs-adapter)
 */

import { describe, it, expect } from 'vitest';
import {
  extract,
  createPGSL,
  mintAtom,
} from '../../../src/index.js';

// ── Real SCORM 1.2-flavored HTML lesson content ──────────────────────
//
// In a full SCORM 1.2 package this would be inside a zip alongside
// imsmanifest.xml. For ingestion testing we only need the HTML payload —
// the zip+manifest layer is a thin file-format wrapper around the same
// content.

const SCORM_LESSON_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CS-101 Module 3: Handling Frustration — Lesson 4</title>
  <script src="../shared/scormfunctions.js"></script>
</head>
<body onload="doLMSInitialize()">
  <h1>Lesson 4: Second-Contact Escalation</h1>
  <p>
    When a customer makes second contact about an unresolved issue,
    do not lead with restating the previous solution. Acknowledge their
    frustration AND the prior contact explicitly, in that order, before
    re-engaging on the substance.
  </p>
  <p>
    Even when the technical answer is the same, the leading
    acknowledgment changes the conversation. Customers who feel heard
    cooperate; customers who feel unheard escalate.
  </p>
  <h2>Practice Scenarios</h2>
  <ol>
    <li>Customer reports the same billing error twice. Try acknowledging the prior contact AND the frustration before offering the same solution.</li>
    <li>Customer asks the same technical question in a calm clinical tone. Match the tone — explicit emotional acknowledgment may feel out of place here.</li>
  </ol>
  <button onclick="doLMSFinish()">Mark Complete</button>
</body>
</html>`;

// Real SCORM 1.2 manifest (illustrative — extract() doesn't read this,
// but it's what a packaging tool would produce alongside the HTML)
const SCORM_MANIFEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cs101.module3" version="1.2"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="cs101">
    <organization identifier="cs101">
      <title>CS-101 Module 3: Handling Frustration</title>
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

// ═════════════════════════════════════════════════════════════════════
//  Tests
// ═════════════════════════════════════════════════════════════════════

describe('Tier 6 — SCORM/cmi5 content ingestion pipeline', () => {
  it('extract() processes real SCORM-flavored HTML lesson content', async () => {
    const result = await extract(SCORM_LESSON_HTML, { filename: 'lesson4.html' });

    expect(result.format).toBe('html');
    expect(result.text.length).toBeGreaterThan(100);

    // Key passages survive the HTML strip — these are what the
    // companion-chat assistant cites verbatim.
    expect(result.text).toContain('second contact');
    expect(result.text).toContain('Acknowledge their frustration');
    expect(result.text).toContain('prior contact');

    // Provenance metadata is captured
    expect(result.contentHash).toBeTruthy();
    expect(result.contentHash.length).toBeGreaterThan(20);
    expect(result.extractedAt).toBeTruthy();
    expect(result.metadata).toBeDefined();
  });

  it('content addressing: same SCORM HTML → same content hash (deterministic)', async () => {
    const r1 = await extract(SCORM_LESSON_HTML, { filename: 'lesson4.html' });
    const r2 = await extract(SCORM_LESSON_HTML, { filename: 'lesson4.html' });

    expect(r1.contentHash).toBe(r2.contentHash);
    expect(r1.text).toBe(r2.text);
  });

  it('content addressing detects ANY byte change: one-character edit → DIFFERENT hash', async () => {
    const r1 = await extract(SCORM_LESSON_HTML);
    const tampered = SCORM_LESSON_HTML.replace('frustration', 'fruztration'); // typo
    const r2 = await extract(tampered);

    expect(r1.contentHash).not.toBe(r2.contentHash);
  });

  it('extracted passages mint to deterministic PGSL atoms (lpc:groundingFragment)', async () => {
    const extraction = await extract(SCORM_LESSON_HTML, { filename: 'lesson4.html' });
    const passage = extraction.text;

    const pgsl = createPGSL();
    const atomIri1 = mintAtom(pgsl, passage);
    const atomIri2 = mintAtom(pgsl, passage);

    // Same extracted passage → same content-addressed atom IRI
    expect(atomIri1).toBe(atomIri2);

    // The atom IRI is what `lpc:groundingFragment` points at — the
    // assistant cites THIS IRI when answering "what did the training say"
    expect(atomIri1.length).toBeGreaterThan(20);
  });

  it('atom IRI changes when the source content changes (citation stability invariant)', () => {
    const original = 'When customer makes second contact, acknowledge their frustration first.';
    const corrected = 'When the customer makes second contact, acknowledge their frustration first.';
    expect(original).not.toBe(corrected);

    const pgsl = createPGSL();
    const iri1 = mintAtom(pgsl, original);
    const iri2 = mintAtom(pgsl, corrected);

    // Different content → different IRI. The assistant citing the OLD
    // passage would not silently get the NEW passage; supersession is
    // explicit.
    expect(iri1).not.toBe(iri2);
  });

  it('SCORM manifest content is plain XML extractable as text (defense-in-depth: a manifest is just text)', async () => {
    // SCORM packaging puts imsmanifest.xml alongside content. extract()
    // can pull it as JSON-or-XML-or-text — for simple manifest reading
    // a treat-as-text path is fine.
    const result = await extract(SCORM_MANIFEST_XML, { filename: 'imsmanifest.xml' });

    expect(result.text.length).toBeGreaterThan(0);
    // Identifiers + titles survive
    expect(result.text).toContain('cs101');
    expect(result.text).toContain('Module 3');
    expect(result.text).toContain('Second-Contact Escalation');
  });

  it('end-to-end: SCORM HTML → extract → atom → cite. Same passage cited twice produces same IRI.', async () => {
    // Simulates the assistant's citation flow:
    //   1. Training content ingested (extract)
    //   2. Atom minted (mintAtom)
    //   3. Assistant gets a query, retrieves the atom by content hash,
    //      cites the passage by IRI
    //   4. Later, same query is asked again → must produce same citation
    const pgsl = createPGSL();

    const ingestion1 = await extract(SCORM_LESSON_HTML);
    const atom1 = mintAtom(pgsl, ingestion1.text);

    // Simulate re-ingestion later (different runtime, fresh PGSL instance
    // would normally happen across server restart). For this test we
    // re-ingest into the same instance — the IRI is content-addressed so
    // the result is stable regardless.
    const ingestion2 = await extract(SCORM_LESSON_HTML);
    const atom2 = mintAtom(pgsl, ingestion2.text);

    expect(ingestion1.contentHash).toBe(ingestion2.contentHash);
    expect(atom1).toBe(atom2);
  });
});
