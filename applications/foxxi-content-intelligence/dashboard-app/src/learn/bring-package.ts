/**
 * Bringing a package to the bridge from the browser (foxxi.host_package_signed): the file as the
 * base64 the signed payload carries, and what the bridge answered, read defensively.
 *
 * The bridge decides what it takes. The size here is only the bridge's default, used to say so
 * before a large file is read and signed for nothing; a bridge set to take less still refuses with
 * its own words, and those are what the page shows.
 */

/** The bridge's default limit for a package brought by a signer, in bytes. */
export const DEFAULT_MAX_PACKAGE_BYTES = 25 * 1024 * 1024;

/** Bytes as base64, built in pieces so a large file does not overflow the call stack. */
export function base64OfBytes(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

/** Why a chosen file cannot be brought, before anything is read or signed; null when it can be tried. */
export function whyNotBring(file: { name: string; size: number }, maxBytes = DEFAULT_MAX_PACKAGE_BYTES): string | null {
  if (file.size === 0) return 'That file is empty.';
  if (file.size > maxBytes) return `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB; a bridge takes ${Math.floor(maxBytes / (1024 * 1024))} MB from a signer unless it is set otherwise.`;
  return null;
}

/** What the bridge said of a package brought to it. */
export type Brought =
  | { hosted: true; playable: true; title: string; courseId: string; packageSha256: string }
  | { hosted: true; playable: false; title: string; packageSha256: string; why: string }
  | { hosted: false; why: string };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Read the answer to a brought package: played, kept to be folded, or not kept and why. */
export function broughtFrom(body: unknown): Brought {
  const b = (body ?? {}) as Record<string, unknown>;
  const sha = text(b.packageSha256);
  const title = text(b.packageTitle) || text((b.course as { title?: unknown } | undefined)?.title) || 'Untitled package';
  if (b.hosted === true && /^[0-9a-f]{64}$/.test(sha)) {
    const courseId = text((b.course as { id?: unknown } | undefined)?.id);
    if (courseId && b.playable !== false) return { hosted: true, playable: true, title, courseId, packageSha256: sha };
    return { hosted: true, playable: false, title, packageSha256: sha, why: text(b.playableWhy) || 'It is kept here, and launches nothing as it is.' };
  }
  return { hosted: false, why: text(b.hostedWhy) || text(b.error) || 'The bridge did not keep the package and did not say why.' };
}
