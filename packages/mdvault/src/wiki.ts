/**
 * `[[wiki-link]]` resolution (§4.4.1 + georgio's C catalogue).
 *
 * A frontmatter object-property value is a wiki-link: `[[name]]`, `[[path/to/name]]`,
 * `[[name|alias]]`, `[[name#fragment]]`. Resolution rules:
 *  - the ALIAS (after `|`) is display-only, discarded for the graph edge (C3);
 *  - the FRAGMENT (after `#`) addresses a location within a note; the edge resolves to the
 *    NOTE itself — we do NOT invent RDF fragment semantics (C4);
 *  - a PATH only disambiguates; the FINAL segment names the note (C2);
 *  - the edge resolves to the participating note whose filename stem equals the link's,
 *    else a DANGLING (C5) or AMBIGUOUS (C6) diagnostic and NO edge — never a guessed IRI.
 *
 * Wiki-links in the BODY are navigation only and never lifted (C7) — the body isn't graph
 * material. Stems are NFC-normalized and matched case-sensitively, so a case/Unicode
 * variance never platform-dependently picks a target (C8): it simply doesn't match.
 */
import type { Diagnostic } from './errors.js';

export interface WikiLink {
  /** the full name inside `[[…]]` minus alias/fragment (may contain a path). */
  readonly name: string;
  /** NFC-normalized final path segment — what the edge resolves against. */
  readonly stem: string;
  /** the path portion (everything before the final segment), if the link was path-qualified. */
  readonly path?: string;
  readonly alias?: string;
  readonly fragment?: string;
}

const WIKI_RE = /^\[\[(.+)\]\]$/s;

/** Parse a value as a wiki-link, or null if the whole value is not a single `[[…]]`. */
export function parseWikiLink(value: unknown): WikiLink | null {
  if (typeof value !== 'string') return null;
  const m = WIKI_RE.exec(value.trim());
  if (!m) return null;
  let inner = m[1]!;
  let alias: string | undefined;
  let fragment: string | undefined;
  const pipe = inner.indexOf('|');
  if (pipe >= 0) { alias = inner.slice(pipe + 1); inner = inner.slice(0, pipe); }
  const hash = inner.indexOf('#');
  if (hash >= 0) { fragment = inner.slice(hash + 1); inner = inner.slice(0, hash); }
  const name = inner.trim();
  if (name === '') return null;
  const slash = name.lastIndexOf('/');
  const stem = (slash >= 0 ? name.slice(slash + 1) : name).normalize('NFC');
  const link: { name: string; stem: string; path?: string; alias?: string; fragment?: string } = { name, stem };
  if (slash >= 0) link.path = name.slice(0, slash);
  if (alias !== undefined) link.alias = alias;
  if (fragment !== undefined) link.fragment = fragment;
  return link;
}

/** True iff the value is a single `[[…]]` wiki-link. */
export function isWikiLink(value: unknown): value is string {
  return parseWikiLink(value) !== null;
}

export interface WikiTarget {
  readonly subject: string;
  readonly path: string;
}

export interface WikiResolution {
  /** the resolved note subject IRI, if unambiguous. */
  readonly subject?: string;
  /** a dangling/ambiguous diagnostic, if the edge could not be resolved. */
  readonly diagnostic?: Diagnostic;
}

/** An index of participating notes (stem -> targets) for wiki-link resolution. */
export class WikiIndex {
  private readonly byStem = new Map<string, WikiTarget[]>();

  /** Register a participating note (one that has frontmatter + @type). */
  add(stem: string, subject: string, path: string): void {
    const key = stem.normalize('NFC');
    const list = this.byStem.get(key);
    if (list) list.push({ subject, path });
    else this.byStem.set(key, [{ subject, path }]);
  }

  /**
   * Resolve a wiki-link to a single note subject, or return a diagnostic. A path narrows a
   * multi-candidate stem; if it doesn't narrow to exactly one, the result is ambiguous and
   * NO edge is produced.
   */
  resolve(link: WikiLink, where: string): WikiResolution {
    const cands = this.byStem.get(link.stem) ?? [];
    let narrowed = cands;
    if (link.path && cands.length > 1) {
      const want = link.path.normalize('NFC');
      const filtered = cands.filter(c => {
        const dir = c.path.slice(0, Math.max(0, c.path.lastIndexOf('/')));
        return dir === want || dir.endsWith('/' + want) || c.path.startsWith(want + '/');
      });
      if (filtered.length > 0) narrowed = filtered;
    }
    if (narrowed.length === 0) {
      return { diagnostic: { severity: 'flag', code: 'wiki.dangling', message: `wiki-link [[${link.name}]] resolves to no participating note`, where } };
    }
    if (narrowed.length > 1) {
      return { diagnostic: { severity: 'flag', code: 'wiki.ambiguous', message: `wiki-link [[${link.name}]] is ambiguous (${narrowed.length} candidates)`, where } };
    }
    return { subject: narrowed[0]!.subject };
  }
}
