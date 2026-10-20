/** Read-only, allowlisted source projections for intervention conversation packets. */
import type { ImportedPackage } from './package-import.js';
import { scormArtifactLinks, type ScormArtifactCourse } from './scorm-artifacts.js';

export interface PublicInterventionSection {
  id: string;
  title: string;
  body: string;
  source_uri?: string;
  locator?: string;
}

export interface PublicInterventionSource {
  id: string;
  title: string;
  kind: string;
  source_uri?: string;
  version?: string;
  rights?: string;
  sections: PublicInterventionSection[];
  missing_context?: string[];
}

function sourceBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The intervention source base must be an HTTP(S) URL without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * Preserve the published course's identity and instructional text. This deliberately does not
 * call the agentic-course adapter: that adapter also reads assessment questions. An empty body
 * remains missing content; a section title is never invented into an instructional passage.
 */
export function publicAuthoredIntervention(
  course: Pick<ScormArtifactCourse, 'courseId' | 'title' | 'scos'>,
  baseUrl: string,
): PublicInterventionSource {
  const base = sourceBase(baseUrl);
  const source = `${base}/agent/scorm/course/${encodeURIComponent(course.courseId)}`;
  const links = scormArtifactLinks(base, course.courseId);
  const sections: PublicInterventionSection[] = [];
  let empty = 0;
  for (const section of course.scos) {
    if (!section.body.trim()) { empty++; continue; }
    sections.push({
      id: section.id, title: section.title, body: section.body,
      source_uri: links.sco(section.id), locator: section.id,
    });
  }
  const missing: string[] = [];
  if (!sections.length) missing.push('No authored instructional section bodies are available.');
  if (empty) missing.push(`${empty} authored section body/bodies are empty and were not replaced with invented text.`);
  return {
    id: course.courseId, title: course.title, kind: 'SCORM course', source_uri: source, sections,
    ...(missing.length ? { missing_context: missing } : {}),
  };
}

/** A package path stays within the addressed ZIP; it is never resolved as an external URL. */
function safePackagePath(path: string): boolean {
  return !!path && !/[\\\u0000]/.test(path) && !path.startsWith('/')
    && !path.split('/').some(segment => !segment || segment === '.' || segment === '..');
}

/**
 * readAnyPackage separates instructional pages from question banks. Visit only those pages,
 * rather than spreading a topic or serializing the imported package (which contains answers).
 * The package reader's unsupported resources are counted, never copied into model context.
 * This projection executes no runtime script and establishes no learning or completion result.
 */
export function publicPackageIntervention(
  imported: ImportedPackage,
  sha256: string,
  baseUrl: string,
): PublicInterventionSource {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('A hosted package source requires its lowercase SHA-256.');
  const root = `${sourceBase(baseUrl)}/scorm/packages/${sha256}`;
  const sections: PublicInterventionSection[] = [];
  const paths = new Set<string>();
  let empty = 0, unsafe = 0;
  for (const topic of imported.topics) {
    for (const page of topic.pages) {
      if (!safePackagePath(page.path)) { unsafe++; continue; }
      if (!page.body.trim()) { empty++; continue; }
      if (paths.has(page.path)) continue;
      paths.add(page.path);
      sections.push({
        id: page.path, title: page.title, body: page.body,
        source_uri: `${root}/files/${page.path.split('/').map(encodeURIComponent).join('/')}`,
        locator: page.path,
      });
    }
  }
  const missing: string[] = [];
  if (!sections.length) missing.push('No readable instructional pages were separated from this package. Runtime-only content and assessment data were not substituted.');
  if (empty) missing.push(`${empty} parsed page body/bodies are empty and were not replaced with invented text.`);
  if (unsafe) missing.push(`${unsafe} parsed page path(s) could not be represented safely within this package.`);
  if (imported.unread.length) missing.push(`${imported.unread.length} package resource(s) were not converted into readable instructional pages.`);
  return {
    id: sha256, title: imported.title, kind: 'Hosted package', source_uri: root, version: `sha256:${sha256}`,
    sections, ...(missing.length ? { missing_context: missing } : {}),
  };
}
