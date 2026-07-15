/**
 * Vault path confinement (general — every profile uses it).
 *
 * A vault is an in-memory bundle of `{ path -> bytes }` entries; NO filesystem or
 * network I/O ever happens. But a note/context/rootContext path is still attacker-
 * controlled and feeds two things that MUST agree: the "nearest context.jsonld at or
 * above this folder" resolver, and (on export) the `vld:path` placement. So both must
 * consume ONE canonical form, and any path that could escape the bundle root, carry a
 * scheme/drive/URL, or inject into a downstream IRI/Turtle sink is refused up front.
 *
 * Refuses (threat model, input-hardening class): absolute (`/`), Windows drive (`C:`),
 * UNC (`\\` -> `//`), scheme-relative (`//`), any URL scheme (`file:`/`http:`/`data:`),
 * `..` traversal, `.`-only, empty segments (leading/trailing/double slash), a `:` in any
 * segment (drive / alternate-data-stream / scheme remnant), and control/NUL characters.
 * The traversal + scheme checks run AFTER percent-decoding + NFC, so `%2e%2e` and
 * non-NFC forms cannot slip past.
 */
import { VaultInputError } from './errors.js';

const CONTROL_RE = /[\u0000-\u001F\u007F]/;
// RFC 3986 scheme at the start (also matches a Windows drive letter `C:` once
// backslashes are normalised to forward slashes).
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Canonicalize a bundle-relative vault path, or throw VaultInputError.
 * The returned string is the ONE canonical key used by both the context resolver
 * and the exporter (forward slashes, NFC, no `.`/`..`, no scheme, non-empty segments).
 */
export function canonicalizeVaultPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new VaultInputError('path.empty', 'vault path must be a non-empty string');
  }
  if (CONTROL_RE.test(raw)) {
    throw new VaultInputError('path.control', 'vault path contains control/NUL characters');
  }
  // Percent-decode BEFORE any traversal/scheme check so `%2e%2e` / `%2f` cannot hide.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new VaultInputError('path.percent', `vault path has malformed percent-encoding: ${raw}`);
  }
  if (CONTROL_RE.test(decoded)) {
    throw new VaultInputError('path.control', 'decoded vault path contains control/NUL characters');
  }
  // Normalise Unicode form and separators so the resolver and exporter cannot disagree.
  let s = decoded.normalize('NFC').replace(/\\/g, '/');

  if (SCHEME_RE.test(s)) {
    throw new VaultInputError('path.scheme', `vault path must be bundle-relative, not a scheme/drive/URL: ${raw}`);
  }
  if (s.startsWith('/')) {
    // Covers absolute `/x`, scheme-relative `//host`, and UNC `\\host` (now `//host`).
    throw new VaultInputError('path.absolute', `vault path must be bundle-relative, not absolute: ${raw}`);
  }

  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '') {
      throw new VaultInputError('path.empty-segment', `vault path has an empty segment (leading/trailing/double slash): ${raw}`);
    }
    if (seg === '.') continue;
    if (seg === '..') {
      throw new VaultInputError('path.traversal', `vault path escapes the bundle root ('..'): ${raw}`);
    }
    if (seg.includes(':')) {
      throw new VaultInputError('path.colon', `vault path segment must not contain ':' (drive/scheme/stream): ${raw}`);
    }
    out.push(seg);
  }
  if (out.length === 0) {
    throw new VaultInputError('path.empty', `vault path resolves to nothing: ${raw}`);
  }
  return out.join('/');
}

/** The final path segment ("Recipe.md" from "Concepts/Recipe.md"), for filename identity. */
export function baseName(canonicalPath: string): string {
  const i = canonicalPath.lastIndexOf('/');
  return i < 0 ? canonicalPath : canonicalPath.slice(i + 1);
}

/** Strip a trailing extension (e.g. ".md") from a name if present. */
export function stripExtension(name: string, ext: string): string {
  return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
}

/** The parent folder ("Concepts" from "Concepts/Recipe.md"; "" at the bundle root). */
export function parentFolder(canonicalPath: string): string {
  const i = canonicalPath.lastIndexOf('/');
  return i < 0 ? '' : canonicalPath.slice(0, i);
}

/** All ancestor folders of a note, nearest-first, ending with the root "" — the search
 *  order for the governing `context.jsonld`. E.g. "A/B/n.md" -> ["A/B","A",""]. */
export function ancestorFolders(canonicalPath: string): string[] {
  const out: string[] = [];
  let dir = parentFolder(canonicalPath);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    out.push(dir);
    if (dir === '') break;
    dir = parentFolder(dir);
  }
  return out;
}
