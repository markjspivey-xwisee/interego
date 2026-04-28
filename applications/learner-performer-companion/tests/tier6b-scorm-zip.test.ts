/**
 * Tier 6b — REAL SCORM 2004 / cmi5 zip-package unwrapping.
 *
 * Closes the file-format wrapper gap from Tier 6: previously the test
 * ingested raw HTML lesson content directly. Real SCORM/cmi5 packages
 * arrive as ZIP files with imsmanifest.xml at the root identifying
 * launchable resources. This test:
 *
 *   1. Constructs real ZIP packages for SCORM 1.2, SCORM 2004, and
 *      cmi5 — using actual zip layout (adm-zip), not just file content
 *   2. Calls unwrapScormPackage() on each
 *   3. Verifies the manifest is parsed (format detected, title +
 *      identifier extracted)
 *   4. Verifies launchable resources are correctly identified by
 *      adlcp:scormtype="sco" / cmi5 <au> elements
 *   5. Pipes a launchable resource through extract() + mintAtom() to
 *      produce a content-addressed grounding atom
 *   6. Confirms the grounding atom for the SAME passage is identical
 *      whether ingested raw or via a zip — packaging doesn't change
 *      the citation IRI (content-addressing invariant)
 *
 * What this proves:
 *   - SCORM/cmi5 zip packages can be unpacked end-to-end through real
 *     code paths (not synthetic shortcuts)
 *   - All three packaging formats handled (1.2 / 2004 / cmi5)
 *   - Launchable resources distinguished from supporting assets
 *   - Citation stability holds across packaging — the IRI a learner
 *     companion cites is the same whether the source was a raw HTML
 *     file or extracted from a SCORM zip
 */

import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import {
  unwrapScormPackage,
  launchableLessons,
} from '../../_shared/scorm/index.js';
import {
  extract,
  createPGSL,
  mintAtom,
} from '../../../src/index.js';

// ── Fixtures: build real SCORM zips in-memory ────────────────────────

const LESSON_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Lesson 4: Second-Contact Escalation</title></head>
<body>
  <h1>Lesson 4: Second-Contact Escalation</h1>
  <p>When a customer makes second contact about an unresolved issue,
  acknowledge their frustration AND the prior contact explicitly,
  in that order, before re-engaging on the substance.</p>
</body>
</html>`;

function buildScorm12Zip(): Buffer {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cs101.module3.v12" version="1.2"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <organizations default="cs101">
    <organization identifier="cs101">
      <title>CS-101 Module 3</title>
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
    <resource identifier="shared-css" type="webcontent"
              adlcp:scormtype="asset" href="shared/style.css">
      <file href="shared/style.css"/>
    </resource>
  </resources>
</manifest>`;

  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(manifest));
  zip.addFile('lesson4.html', Buffer.from(LESSON_HTML));
  zip.addFile('shared/style.css', Buffer.from('body { font-family: sans-serif; }'));
  return zip.toBuffer();
}

function buildScorm2004Zip(): Buffer {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cs101.module3.v2004" version="1.0"
          xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <organizations default="cs101">
    <organization identifier="cs101">
      <title>CS-101 Module 3 (SCORM 2004)</title>
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

function buildCmi5Zip(): Buffer {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1.0/CourseStructure.xsd">
  <course id="cs101.module3.cmi5">
    <title><langstring lang="en">CS-101 Module 3 (cmi5)</langstring></title>
  </course>
  <au id="lesson4-au">
    <title><langstring lang="en">Lesson 4: Second-Contact Escalation</langstring></title>
    <url>lesson4.html</url>
  </au>
</courseStructure>`;

  const zip = new AdmZip();
  zip.addFile('cmi5.xml', Buffer.from(manifest));
  zip.addFile('lesson4.html', Buffer.from(LESSON_HTML));
  return zip.toBuffer();
}

// ═════════════════════════════════════════════════════════════════════
//  Tests
// ═════════════════════════════════════════════════════════════════════

describe('Tier 6b — SCORM/cmi5 zip-package unwrapping', () => {
  it('SCORM 1.2 package: unwraps + identifies launchable lesson + extracts manifest fields', () => {
    const pkg = unwrapScormPackage(buildScorm12Zip());

    expect(pkg.format).toBe('scorm-1.2');
    expect(pkg.identifier).toBe('cs101.module3.v12');
    expect(pkg.title).toBe('CS-101 Module 3');

    // 2 resources (lesson + asset); only the SCO is launchable
    expect(pkg.resources).toHaveLength(2);
    const lessons = launchableLessons(pkg);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.path).toBe('lesson4.html');
    expect(lessons[0]!.type).toBe('html');

    // The non-SCO asset is present but not launchable
    const cssAsset = pkg.resources.find(r => r.path === 'shared/style.css');
    expect(cssAsset).toBeDefined();
    expect(cssAsset!.isLaunchable).toBe(false);
  });

  it('SCORM 2004 package: unwraps + identifies launchable lesson', () => {
    const pkg = unwrapScormPackage(buildScorm2004Zip());

    expect(pkg.format).toBe('scorm-2004');
    expect(pkg.identifier).toBe('cs101.module3.v2004');
    expect(pkg.title).toBe('CS-101 Module 3 (SCORM 2004)');

    const lessons = launchableLessons(pkg);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.path).toBe('lesson4.html');
  });

  it('cmi5 package: unwraps + identifies launchable AU + extracts course title', () => {
    const pkg = unwrapScormPackage(buildCmi5Zip());

    expect(pkg.format).toBe('cmi5');
    expect(pkg.identifier).toBe('cs101.module3.cmi5');
    expect(pkg.title).toBe('CS-101 Module 3 (cmi5)');

    const lessons = launchableLessons(pkg);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.path).toBe('lesson4.html');
  });

  it('end-to-end: SCORM 2004 zip → unwrap → extract launchable HTML → mint atom', async () => {
    const pkg = unwrapScormPackage(buildScorm2004Zip());
    const lessons = launchableLessons(pkg);
    expect(lessons).toHaveLength(1);

    const lessonContent = lessons[0]!.content as string;
    expect(lessonContent).toContain('second contact');

    // Pipe through extract() + mintAtom() — same flow as the assistant
    // would use to populate lpc:groundingFragment.
    const extraction = await extract(lessonContent, { filename: lessons[0]!.path });
    expect(extraction.format).toBe('html');
    expect(extraction.text).toContain('acknowledge their frustration');

    const pgsl = createPGSL();
    const atomIri = mintAtom(pgsl, extraction.text);
    expect(atomIri.length).toBeGreaterThan(20);
  });

  it('citation stability invariant: SAME passage cited from a zip vs raw HTML produces SAME atom IRI', async () => {
    // Path A: raw HTML straight to extractor
    const extractionRaw = await extract(LESSON_HTML, { filename: 'lesson4.html' });
    const pgslA = createPGSL();
    const atomFromRaw = mintAtom(pgslA, extractionRaw.text);

    // Path B: same HTML via SCORM zip
    const pkg = unwrapScormPackage(buildScorm2004Zip());
    const lessonContent = launchableLessons(pkg)[0]!.content as string;
    const extractionViaZip = await extract(lessonContent, { filename: 'lesson4.html' });
    const pgslB = createPGSL();
    const atomFromZip = mintAtom(pgslB, extractionViaZip.text);

    // Content-addressing means the atom IRI is identical regardless of
    // packaging — a learner who first ingested a raw HTML and later
    // re-imported the SCORM zip would still cite the SAME atom IRI.
    expect(atomFromRaw).toBe(atomFromZip);
  });

  it('one-byte change in lesson HTML produces a different atom IRI (supersession explicit)', async () => {
    const pkg1 = unwrapScormPackage(buildScorm2004Zip());
    const lesson1 = launchableLessons(pkg1)[0]!.content as string;

    // Build a second zip with a one-character edit (typo in the lesson)
    const tamperedHtml = LESSON_HTML.replace('frustration', 'fruztration');
    const tamperedZip = new AdmZip();
    tamperedZip.addFile('imsmanifest.xml', buildScorm2004Zip()
      ? unwrapScormPackage(buildScorm2004Zip()).manifestRaw
      : '');
    // Reconstruct the zip with the tampered HTML
    const manifestBuf = Buffer.from(unwrapScormPackage(buildScorm2004Zip()).manifestRaw);
    const z2 = new AdmZip();
    z2.addFile('imsmanifest.xml', manifestBuf);
    z2.addFile('lesson4.html', Buffer.from(tamperedHtml));
    const pkg2 = unwrapScormPackage(z2.toBuffer());
    const lesson2 = launchableLessons(pkg2)[0]!.content as string;

    expect(lesson1).not.toBe(lesson2);

    const e1 = await extract(lesson1);
    const e2 = await extract(lesson2);
    expect(e1.contentHash).not.toBe(e2.contentHash);

    const pgsl = createPGSL();
    const a1 = mintAtom(pgsl, e1.text);
    const a2 = mintAtom(pgsl, e2.text);
    expect(a1).not.toBe(a2);
  });

  it('malformed package: non-zip buffer throws early', () => {
    const bogus = Buffer.from('not a zip file');
    expect(() => unwrapScormPackage(bogus)).toThrow();
  });

  it('package missing manifest: throws with clear error', () => {
    const zip = new AdmZip();
    zip.addFile('lesson4.html', Buffer.from(LESSON_HTML));
    // No imsmanifest.xml or cmi5.xml
    expect(() => unwrapScormPackage(zip.toBuffer())).toThrow(/manifest/i);
  });
});
