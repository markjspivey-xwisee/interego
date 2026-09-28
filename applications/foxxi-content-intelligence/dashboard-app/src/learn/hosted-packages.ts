/**
 * SCORM packages the bridge hosts (src/scorm-hosting.ts), as its listing gives them, and the launch
 * URL a signed cmi5 launch of one answers with.
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

/** The URL a signed cmi5 launch answers with, when it is one a browser should open. */
export function launchUrlFrom(body: unknown): string | null {
  const url = (body as { launchUrl?: unknown } | null)?.launchUrl;
  return isHttpUrl(url) ? url : null;
}
