/**
 * SCORM packages the bridge hosts (src/scorm-hosting.ts), as its listing gives them, and the launch
 * URL a signed cmi5 launch of one answers with; and the authoring tools' own exports it keeps to be
 * folded, which launch nothing.
 *
 * Every document of a hosted package runs in a sandbox of its own on the bridge, so a launched
 * package opens in a tab of its own rather than in a frame on this page.
 */

/** A package the bridge hosts: its course, and the AUs it launches. */
export interface HostedPackage {
  packageSha256: string;
  /** The package's own record on the bridge. */
  href: string;
  course: { id: string; title: string };
  aus: ReadonlyArray<{ id: string; title: string }>;
}

const SHA = /^[0-9a-f]{64}$/;
const isHttpUrl = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
};

/** The packages a listing names, keeping only the well-formed ones. */
export function hostedPackagesFrom(body: unknown): HostedPackage[] {
  const list = (body as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(list)) return [];
  const out: HostedPackage[] = [];
  for (const entry of list) {
    const p = entry as Partial<HostedPackage> | null;
    if (!p || typeof p.packageSha256 !== 'string' || !SHA.test(p.packageSha256) || !isHttpUrl(p.href)) continue;
    if (!p.course || !isHttpUrl(p.course.id) || typeof p.course.title !== 'string') continue;
    const aus = Array.isArray(p.aus) ? p.aus.filter(a => !!a && typeof a.id === 'string' && typeof a.title === 'string') : [];
    out.push({ packageSha256: p.packageSha256, href: p.href, course: { id: p.course.id, title: p.course.title }, aus });
  }
  return out;
}

/** A package the Author page can fold: one the bridge hosts to be played, or an authoring tool's own export kept to be folded. */
export interface FoldablePackage {
  packageSha256: string;
  title: string;
  /** The tool whose own export it is, when it is one. */
  exportOf?: string;
}

/** Every package a listing names that folds: those that play, then the exports kept to be folded, each well-formed. */
export function foldablePackagesFrom(body: unknown): FoldablePackage[] {
  const out: FoldablePackage[] = hostedPackagesFrom(body).map(p => ({ packageSha256: p.packageSha256, title: p.course.title }));
  const list = (body as { exports?: unknown } | null)?.exports;
  for (const entry of Array.isArray(list) ? list : []) {
    const e = entry as { packageSha256?: unknown; href?: unknown; title?: unknown; exportOf?: unknown } | null;
    if (!e || typeof e.packageSha256 !== 'string' || !SHA.test(e.packageSha256) || !isHttpUrl(e.href)) continue;
    if (typeof e.title !== 'string' || typeof e.exportOf !== 'string' || !e.exportOf.trim()) continue;
    out.push({ packageSha256: e.packageSha256, title: e.title, exportOf: e.exportOf });
  }
  return out;
}

/**
 * How many packages a listing says are kept but not listed yet: ones the bridge is still reading
 * in the background, which a later listing lists.
 */
export function unlistedFrom(body: unknown): number {
  const n = (body as { unlisted?: unknown } | null)?.unlisted;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

/** The URL a signed cmi5 launch answers with, when it is one a browser should open. */
export function launchUrlFrom(body: unknown): string | null {
  const url = (body as { launchUrl?: unknown } | null)?.launchUrl;
  return isHttpUrl(url) ? url : null;
}
