/**
 * SCORM / cmi5 zip-package unwrapping.
 *
 * Closes the file-format wrapper gap: previously the test ingested
 * raw HTML lesson content directly. Real SCORM 2004 / cmi5 packages
 * arrive as ZIP files with imsmanifest.xml at the root identifying
 * resources and lesson content. This module:
 *
 *   1. Reads the ZIP archive (adm-zip, devDependency)
 *   2. Locates + parses imsmanifest.xml (XML, simple regex)
 *   3. Identifies lesson resources by adlcp:scormtype="sco" attribute
 *      (SCORM 1.2/2004) or au element (cmi5 cmi5.xml)
 *   4. Extracts referenced HTML content for ingestion via
 *      src/extractors/.
 *
 * Output: a flat array of {path, content, type} records the consumer
 * pipes through extract() + mintAtom() to populate the
 * lpc:TrainingContent + lpc:LearningObjective + lpc:groundingFragment
 * descriptor cluster.
 *
 * Coverage:
 *   - SCORM 1.2 (imscp_rootv1p1p2 + adlcp_rootv1p2)
 *   - SCORM 2004 (imscp_rootv1p2 + adlcp_rootv1p3)
 *   - cmi5 (cmi5.xml at root)
 *
 * Out of scope (file as a separate concern if you need it):
 *   - SCORM CAM sequencing rules (the seq:sequencing block)
 *   - SCORM API runtime data model (cmi.* getters/setters)
 *     — those are LMS-runtime concerns, not ingestion concerns
 */

import AdmZip from 'adm-zip';

export type ScormPackageFormat = 'scorm-1.2' | 'scorm-2004' | 'cmi5' | 'unknown';

export interface ScormResource {
  /** Path inside the zip (e.g., "lesson4.html"). */
  readonly path: string;
  /** Raw content (utf-8 text where possible; Buffer otherwise). */
  readonly content: string | Buffer;
  /** MIME-style type derived from extension. */
  readonly type: 'html' | 'xml' | 'text' | 'binary';
  /** Whether this resource is a SCO (Sharable Content Object) — i.e.,
   *  a launchable lesson the LMS would invoke. Identifiers from
   *  imsmanifest.xml that match. */
  readonly isLaunchable: boolean;
}

export interface ScormPackage {
  readonly format: ScormPackageFormat;
  readonly manifestRaw: string;
  readonly resources: readonly ScormResource[];
  /** Top-level course identifier from imsmanifest.xml/cmi5.xml. */
  readonly identifier: string;
  /** Top-level course title. */
  readonly title: string;
}

/**
 * Unwrap a SCORM/cmi5 zip package buffer into resources ready for
 * ingestion. Throws if the package is malformed (not a zip, or
 * missing manifest).
 */
export function unwrapScormPackage(zipBuffer: Buffer): ScormPackage {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Locate the manifest. SCORM 1.2/2004 → imsmanifest.xml. cmi5 → cmi5.xml.
  const manifestEntry =
    entries.find(e => !e.isDirectory && e.entryName.toLowerCase() === 'imsmanifest.xml')
    ?? entries.find(e => !e.isDirectory && e.entryName.toLowerCase() === 'cmi5.xml');

  if (!manifestEntry) {
    throw new Error('SCORM/cmi5 package missing imsmanifest.xml or cmi5.xml at root');
  }

  const manifestRaw = manifestEntry.getData().toString('utf8');
  const format = detectFormat(manifestEntry.entryName, manifestRaw);
  const launchableSet = identifyLaunchableResources(manifestRaw, format);

  const resources: ScormResource[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.entryName === manifestEntry.entryName) continue;

    const buf = entry.getData();
    const ext = entry.entryName.split('.').pop()?.toLowerCase() ?? '';
    const type = ext === 'html' || ext === 'htm' ? 'html'
               : ext === 'xml' ? 'xml'
               : ext === 'txt' || ext === 'md' || ext === 'js' || ext === 'css' ? 'text'
               : 'binary';

    const content = type === 'binary' ? buf : buf.toString('utf8');

    resources.push({
      path: entry.entryName,
      content,
      type,
      isLaunchable: launchableSet.has(entry.entryName),
    });
  }

  const identifier = extractManifestField(manifestRaw, format, 'identifier');
  const title = extractManifestField(manifestRaw, format, 'title');

  return {
    format,
    manifestRaw,
    resources,
    identifier,
    title,
  };
}

/** Returns just the launchable HTML/XML lesson resources, ready for
 *  src/extractors/extract(). */
export function launchableLessons(pkg: ScormPackage): readonly ScormResource[] {
  return pkg.resources.filter(r =>
    r.isLaunchable && (r.type === 'html' || r.type === 'xml' || r.type === 'text'),
  );
}

// ── Internals ────────────────────────────────────────────────────────

function detectFormat(manifestName: string, raw: string): ScormPackageFormat {
  if (manifestName.toLowerCase() === 'cmi5.xml') return 'cmi5';
  // SCORM 2004 uses adlcp_rootv1p3 namespace (and CP v1p2)
  if (raw.includes('adlcp_rootv1p3') || raw.includes('imscp_v1p1')) return 'scorm-2004';
  // SCORM 1.2 uses adlcp_rootv1p2 + imscp_rootv1p1p2
  if (raw.includes('adlcp_rootv1p2') || raw.includes('imscp_rootv1p1p2')) return 'scorm-1.2';
  return 'unknown';
}

function identifyLaunchableResources(manifestRaw: string, format: ScormPackageFormat): Set<string> {
  const result = new Set<string>();

  if (format === 'cmi5') {
    // cmi5: <au id="..." launchable="true"><url>...</url></au>
    const auRegex = /<au\b[^>]*?(?:>|\/>)([\s\S]*?)<\/au>|<au\b[^/>]*\/>/gi;
    const urlRegex = /<url\b[^>]*>([^<]+)<\/url>/i;
    let match;
    while ((match = auRegex.exec(manifestRaw)) !== null) {
      const inner = match[1] ?? '';
      const urlMatch = urlRegex.exec(inner);
      if (urlMatch) result.add(urlMatch[1]!.trim());
    }
    return result;
  }

  // SCORM 1.2 / 2004: <resource adlcp:scormtype="sco" href="path/to/lesson.html">
  // (Plus type="webcontent" but scormtype is the discriminator)
  const scoRegex = /<resource\b[^>]*?(?:adlcp:scormtype|scormtype)="sco"[^>]*?href="([^"]+)"/gi;
  let match;
  while ((match = scoRegex.exec(manifestRaw)) !== null) {
    result.add(match[1]!);
  }

  // Also try the order-flipped form (href before scormtype)
  const altRegex = /<resource\b[^>]*?href="([^"]+)"[^>]*?(?:adlcp:scormtype|scormtype)="sco"/gi;
  while ((match = altRegex.exec(manifestRaw)) !== null) {
    result.add(match[1]!);
  }

  return result;
}

function extractManifestField(raw: string, format: ScormPackageFormat, field: 'identifier' | 'title'): string {
  if (field === 'identifier') {
    // SCORM: <manifest identifier="...">
    // cmi5: <course id="..."> nested inside <courseStructure>
    if (format === 'cmi5') {
      const m = /<course\b[^>]*?id="([^"]+)"/i.exec(raw);
      return m?.[1] ?? 'unknown';
    }
    const m = /<manifest\b[^>]*?identifier="([^"]+)"/i.exec(raw);
    return m?.[1] ?? 'unknown';
  }
  // title
  if (format === 'cmi5') {
    const m = /<title>\s*<langstring[^>]*>([^<]+)<\/langstring>\s*<\/title>/i.exec(raw)
           ?? /<title>([^<]+)<\/title>/i.exec(raw);
    return m?.[1]?.trim() ?? 'untitled';
  }
  // SCORM: first <organization><title>...</title></organization>
  const m = /<organization\b[^>]*>[\s\S]*?<title>([^<]+)<\/title>/i.exec(raw);
  return m?.[1]?.trim() ?? 'untitled';
}
