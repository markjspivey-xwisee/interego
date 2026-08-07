/**
 * Hardened Turtle/TriG reading for a workspace client.
 *
 * ★ WHY THIS IS A MODULE AND NOT A COPY IN EACH CLIENT.
 * Every one of the defects named below was found in a hand-written reader inside the
 * published artifact, and every one of them was found MORE THAN ONCE: the fix was applied
 * to one reader, and the next reader written later reintroduced it. A second client — a
 * desktop shell — would have been a third copy. So the readers live here, once, and the
 * artifact's script is GENERATED from this file rather than maintained beside it.
 *
 * The bytes these readers run over are written by whoever publishes the graph, and a
 * workspace is by construction a document somebody else wrote. So none of this is defensive
 * programming against a hypothetical: a member's own pod is the attacker's position.
 */

/**
 * The characters an IRI reference may not contain, per Turtle's IRIREF production.
 *
 * ONE definition, used by the walker, by every reader that returns an IRI, and by the WebID
 * parser that turns a name out of somebody else's document into a segment of an IRI the
 * client then fetches. Whitespace is in the set, and whitespace is also what the mask below
 * writes over anything that must not be read as a term — so masked bytes can never come
 * back out as an IRI.
 */
export const BAD_IRI = /[\s<>"{}|\\^`]/;

/** Undo Turtle's literal escapes, including \\uXXXX and \\UXXXXXXXX. */
export function unescapeLiteral(s: string): string {
  return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_m, g: string) => {
    const head = g[0];
    if (head === 'u' || head === 'U') return String.fromCodePoint(parseInt(g.slice(1), 16));
    const table: Record<string, string> = {
      n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', "'": "'", '\\': '\\',
    };
    return table[g] ?? g;
  });
}

const rxEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What {@link scanTurtle} reports back about a span it walked over. */
export type SpanKind = 'comment' | 'literal';

/**
 * ONE PASS OVER THE BYTES. Everything here that reads them goes through it: the mask below,
 * and the region locator below that.
 *
 * ★ THE ATTACK IT CLOSES. The publisher of a graph controls its bytes. An `indexOf` for the
 * opening sequence, and a brace counter that counts braces inside string literals, both hand
 * that publisher the reader: they can put the sequence `<theirGraphIri> {` inside a literal
 * earlier in the document and have every field read from a position the signature does not
 * cover, or put a single `{` in any literal and truncate the real region.
 *
 * `onToken(i, ch, iriEnd)` fires only for characters OUTSIDE every literal and every comment.
 * `iriEnd` is the index of the closing `>` when `ch` opens a WELL-FORMED IRI reference and is
 * undefined otherwise — so a caller can never treat a token that merely LOOKS like an IRI as
 * one. That distinction is the whole of the fix for a graph IRI containing `{`, which walked
 * the region locator past the block's own closing brace and out into unsigned bytes.
 *
 * Returning `false` from `onToken` stops the walk.
 */
export function scanTurtle(
  content: string,
  onToken: (i: number, ch: string, iriEnd?: number) => boolean | void,
  onSpan?: (kind: SpanKind, from: number, to: number) => void,
): void {
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i] as string;
    if (c === '<') {
      // An IRI reference is consumed whole. A `#` inside one is a fragment, not a comment,
      // and a brace or a quote inside one is neither.
      const close = content.indexOf('>', i);
      if (close > i && !BAD_IRI.test(content.slice(i + 1, close))) {
        if (onToken(i, c, close) === false) return;
        i = close + 1;
        continue;
      }
    }
    if (c === '#') {                                   // comment to end of line
      const from = i;
      while (i < n && content[i] !== '\n') i++;
      if (onSpan) onSpan('comment', from, i);
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = c + c + c;
      if (content.startsWith(triple, i)) {             // long literal
        i += 3;
        const from = i;
        while (i < n) {
          if (content[i] === '\\') { i += 2; continue; }
          if (content.startsWith(triple, i)) break;
          i++;
        }
        if (onSpan) onSpan('literal', from, Math.min(i, n));
        if (i < n) i += 3;
        continue;
      }
      i++;                                             // short literal
      const from = i;
      while (i < n) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === c) break;
        if (content[i] === '\n') break;                // unterminated; bail out
        i++;
      }
      if (onSpan) onSpan('literal', from, Math.min(i, n));
      if (i < n && content[i] === c) i++;
      continue;
    }
    if (onToken(i, c) === false) return;
    i++;
  }
}

/**
 * THE MASK: no reader here ever sees raw bytes.
 *
 * A reader that is a plain regex cannot tell a triple from a COMMENT or from text inside a
 * literal, and every reader here used to be exactly that. All of these were real, against
 * this relay: `# dct:description "x"` came back as the record's description;
 * `# wsp:convener <https://evil/…>` came back as the convener; `# wsp:revoked true` read as
 * a revocation; and a `"""…"""` literal quoting `dct:description "SPOOF"` had SPOOF returned
 * as the description. A comment carries no triples at all, so each of those rendered as fact
 * something the graph does not state.
 *
 * Fixing it per-reader is how it kept coming back. It is fixed once, here: the result is the
 * SAME LENGTH as the original, with every character inside a comment and inside a literal
 * replaced by a space and the literal's own delimiters left in place. A regex can therefore
 * still find WHERE a literal begins, offsets still line up with the original, and any text a
 * reader returns is recovered from the ORIGINAL at that offset.
 *
 * `null` for either fill leaves that span untouched.
 */
export function maskFill(s: string, comments: string | null, literals: string | null): string {
  const out = s.split('');
  scanTurtle(s, () => true, (kind, from, to) => {
    const fill = kind === 'comment' ? comments : literals;
    if (fill === null) return;
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = fill;
  });
  return out.join('');
}

// One-entry memo. Readers are called several times over the same document in a row (a record
// yields five or six fields), and masking is a full walk each time.
let maskSrc: string | null = null;
let maskOut: string | null = null;

/** Comments AND literals masked. What every reader below matches against. */
export function masked(ttl: string): string {
  if (ttl === maskSrc && maskOut !== null) return maskOut;
  maskSrc = ttl;
  maskOut = maskFill(ttl, ' ', ' ');
  return maskOut;
}

/**
 * Comments only, literals intact — for a caller that has to hand a SLICE of the text to the
 * readers, which then mask that slice themselves.
 */
export const maskComments = (ttl: string): string => maskFill(ttl, ' ', null);

/**
 * Read the literal that starts at `i` in the ORIGINAL text.
 *
 * Turtle has two literal syntaxes and a reader that knows only one reports a real multi-line
 * message as having no content: against `"""x"""` a short-literal pattern matches the empty
 * string between the first two quotes, which is how "no description" got asserted about text
 * that was plainly there. An unterminated literal is not a literal, and reads as absent
 * rather than as everything after the opening quote.
 */
export function literalAt(s: string, i: number): string | null {
  const q = s[i];
  if (q !== '"' && q !== "'") return null;
  const triple = q + q + q;
  if (s.startsWith(triple, i)) {
    let j = i + 3;
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s.startsWith(triple, j)) return s.slice(i + 3, j);
      j++;
    }
    return null;
  }
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === q) return unescapeLiteral(s.slice(i + 1, j));
    if (s[j] === '\n') return null;
    j++;
  }
  return null;
}

/**
 * A predicate can appear prefixed or as a full IRI reference, and which one a publisher used
 * is not this reader's business. Both forms are tried, always — reading only the prefixed
 * form silently reported real records as empty.
 */
export function forms(term: string, ns: string | null): readonly string[] {
  const colon = term.indexOf(':');
  const local = colon > 0 ? term.slice(colon + 1) : term;
  const pfx = colon > 0 ? term : null;
  const out: string[] = [];
  if (pfx) out.push(rxEsc(pfx));
  if (ns) out.push('<' + rxEsc(ns + local) + '>');
  return out.length ? out : [rxEsc(term)];
}

/** The WSP vocabulary this client reads and writes. */
export const WSP = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#';
/** The Interego protocol vocabulary. */
export const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
/**
 * W3C PROV-O. Not ours, and that is why it is used.
 *
 * Who authored an entry and which person an agent authored it FOR are not workspace-specific
 * questions, and PROV already answers both — `prov:wasAttributedTo` and `prov:actedOnBehalfOf`.
 * Minting `wsp:authoredBy` beside them would be this vertical restating a standard vocabulary
 * under its own name, which every reader outside it would then have to learn.
 */
export const PROV = 'http://www.w3.org/ns/prov#';

/** Prefix -> namespace, for the handful of prefixes a workspace document uses. */
export function nsOf(term: string): string | null {
  if (term.indexOf('wsp:') === 0) return WSP;
  if (term.indexOf('dct:') === 0) return 'http://purl.org/dc/terms/';
  if (term.indexOf('rdfs:') === 0) return 'http://www.w3.org/2000/01/rdf-schema#';
  if (term.indexOf('hydra:') === 0) return 'http://www.w3.org/ns/hydra/core#';
  if (term.indexOf('iep:') === 0) return IEP;
  if (term.indexOf('prov:') === 0) return PROV;
  return null;
}

/**
 * The literal object of `term`, or null when the term is absent.
 *
 * Matches against {@link masked} and never against the raw text; where it returns text it
 * takes that text out of the ORIGINAL at the offset the match gave. The two strings are the
 * same length, so the offsets agree.
 */
export function readLiteral(ttl: string | null | undefined, term: string): string | null {
  if (!ttl) return null;
  const mk = masked(ttl);
  for (const f of forms(term, nsOf(term))) {
    const rx = new RegExp('(?:^|[\\s;\\[])' + f + '\\s+(?=["\'])', 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(mk))) {
      const at = m.index + m[0].length;
      const lit = literalAt(ttl, at);
      if (lit !== null) return lit;
      rx.lastIndex = at + 1;
    }
  }
  return null;
}

/**
 * The IRI object of `term`, or null when the term is absent.
 *
 * ★ An object that is not a WELL-FORMED IRI reference is not an IRI. A `{` inside one used to
 * survive this reader, reach the region locator, and walk it out of the signed block. It is
 * rejected here, at the reader, for every caller at once.
 */
export function readIri(ttl: string | null | undefined, term: string): string | null {
  if (!ttl) return null;
  const mk = masked(ttl);
  for (const f of forms(term, nsOf(term))) {
    const rx = new RegExp('(?:^|[\\s;\\[])' + f + '\\s+<([^>]*)>', 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(mk))) {
      const body = m[1] as string;
      if (!BAD_IRI.test(body)) return body;
      rx.lastIndex = m.index + m[0].length;
    }
  }
  return null;
}

/**
 * EVERY IRI object of `term` in this region, in document order, not just the first.
 *
 * ★ WHY THE COUNT MATTERS AND `readIri` CANNOT ANSWER IT. These readers are REGION-scoped, not
 * subject-scoped: they find a predicate anywhere in the block and return its object. For a field
 * that appears once that is exact. For a field a caller uses to decide WHO WROTE SOMETHING it is
 * not, because the author of the region controls its bytes and can state the predicate twice —
 * and `readIri` would silently return whichever came first, which is a choice this reader is not
 * entitled to make on a reader's behalf. Callers that care use this and refuse anything but one.
 *
 * Duplicate objects are collapsed: `p <a> , <a>` states one fact twice and is not a disagreement.
 */
export function readIriAll(ttl: string | null | undefined, term: string): readonly string[] {
  if (!ttl) return [];
  const mk = masked(ttl);
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (body: string): void => {
    if (!BAD_IRI.test(body) && !seen.has(body)) { seen.add(body); out.push(body); }
  };
  for (const f of forms(term, nsOf(term))) {
    const rx = new RegExp('(?:^|[\\s;\\[])' + f + '(?=\\s)', 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(mk))) {
      // ★ THE COMMA LIST IS WALKED, NOT IGNORED. `p <a> , <b>` is Turtle for TWO statements, and
      // a reader that stopped at the first object would report one — which for a caller counting
      // how many authors an entry claims is the difference between "one, believe it" and "two,
      // refuse". Matching only `f\s+<…>` had exactly that hole.
      let i = m.index + m[0].length;
      for (;;) {
        while (i < mk.length && /\s/.test(mk[i] as string)) i++;
        if (mk[i] !== '<') break;
        const close = mk.indexOf('>', i);
        if (close < 0) break;
        take(mk.slice(i + 1, close));
        i = close + 1;
        while (i < mk.length && /\s/.test(mk[i] as string)) i++;
        if (mk[i] !== ',') break;
        i++;
      }
      rx.lastIndex = m.index + m[0].length;
    }
  }
  return out;
}

/**
 * A list of objects after one predicate: `p <a>, <b>` or `p px:a, px:b`.
 *
 * The objects are WALKED rather than split. This was `([^;.]+)`, which cannot survive a full
 * IRI: every http IRI contains a `.`, so the first one truncated the list to a fragment of
 * itself and the role then rendered as permitting nothing at all — the false negative the
 * predicate side had already been fixed for.
 */
export function readIriList(ttl: string | null | undefined, term: string): readonly string[] {
  if (!ttl) return [];
  const mk = masked(ttl);
  for (const f of forms(term, nsOf(term))) {
    const m = new RegExp('(?:^|[\\s;\\[])' + f + '(?=\\s)').exec(mk);
    if (!m) continue;
    const out: string[] = [];
    let i = m.index + m[0].length;
    for (;;) {
      while (i < mk.length && /\s/.test(mk[i] as string)) i++;
      if (i >= mk.length) break;
      if (mk[i] === '<') {
        const close = mk.indexOf('>', i);
        if (close < 0 || BAD_IRI.test(mk.slice(i + 1, close))) break;
        out.push('<' + mk.slice(i + 1, close) + '>');
        i = close + 1;
      } else if (/[A-Za-z_]/.test(mk[i] as string)) {
        let j = i;
        while (j < mk.length && !/[\s,;.\])]/.test(mk[j] as string)) j++;
        out.push(mk.slice(i, j));
        i = j;
      } else break;
      while (i < mk.length && /\s/.test(mk[i] as string)) i++;
      if (mk[i] !== ',') break;
      i++;
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * A number written the way Turtle actually writes one: bare, or as a typed literal.
 * Returns null when the term is absent — which is NOT zero.
 */
export function readInt(ttl: string | null | undefined, term: string): number | null {
  if (!ttl) return null;
  const mk = masked(ttl);
  for (const f of forms(term, nsOf(term))) {
    const rx = new RegExp('(?:^|[\\s;\\[])' + f + '\\s+(?=["\'\\d])', 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(mk))) {
      const at = m.index + m[0].length;
      if (mk[at] === '"' || mk[at] === "'") {
        const lit = literalAt(ttl, at);
        if (lit !== null && /^\d+$/.test(lit)) return Number(lit);
      } else {
        const d = /^\d+/.exec(mk.slice(at));
        if (d) return Number(d[0]);
      }
      rx.lastIndex = at + 1;
    }
  }
  return null;
}

/**
 * Whether `term` is asserted true.
 *
 * `wsp:revoked true` is the native boolean and is what a Turtle writer emits. Matching only
 * the quoted lexical form meant a REVOKED grant read as active — a withdrawn member who kept
 * their seat.
 */
export function hasTrue(ttl: string | null | undefined, term: string): boolean {
  if (!ttl) return false;
  const mk = masked(ttl);
  for (const f of forms(term, nsOf(term))) {
    const rx = new RegExp('(?:^|[\\s;\\[])' + f + '\\s+(?=["\'t])', 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(mk))) {
      const at = m.index + m[0].length;
      if (mk[at] === '"' || mk[at] === "'") {
        if (literalAt(ttl, at) === 'true') return true;
      } else if (/^true(?=[\s;,.\]]|$)/.test(mk.slice(at))) return true;
      rx.lastIndex = at + 1;
    }
  }
  return false;
}

/** `<subject> a <type>`, for either form of the type IRI. */
export function hasType(ttl: string | null | undefined, term: string): boolean {
  if (!ttl) return false;
  const mk = masked(ttl);
  return forms(term, nsOf(term)).some((f) =>
    new RegExp('(?:^|[\\s;\\[])a\\s+' + f + '(?=[\\s;,.\\]]|$)').test(mk));
}

/**
 * The interior of `<graphIri> { … }` inside a TriG document, or null when it is not there.
 *
 * The relay serves the descriptor and the payload in one document; the payload sits inside
 * that block, and only that block is covered by the signature. So it is the only region read,
 * and {@link scanTurtle} is what makes that sentence true rather than aspirational.
 *
 * ★ `null` AND `''` ARE DIFFERENT ANSWERS AND CALLERS MUST NOT COLLAPSE THEM. `''` is a block
 * that WAS located and is empty; `null` is one that was not located. Reporting a located
 * empty region as "could not be located" is a false statement about a region that was found,
 * and it happened in three separate call sites.
 */
export function graphRegion(content: string | null | undefined, graphIri: string): string | null {
  if (!content) return null;
  let start = -1;
  let depth = 0;
  let end = -1;
  scanTurtle(content, (i, c, iriEnd) => {
    if (start < 0) {
      // Only a top-level `<iri> {` counts: brace depth zero, outside every literal. Braces of
      // any earlier graph block are counted, so a preceding block cannot make this one look
      // top-level or hide it.
      if (c === '{') { depth++; return true; }
      if (c === '}') { if (depth > 0) depth--; return true; }
      if (depth === 0 && c === '<' && iriEnd !== undefined
          && content.slice(i + 1, iriEnd) === graphIri) {
        // A comment is legal between the IRI and its brace, and treating one as a miss made a
        // legal TriG region unfindable.
        const after = content.slice(iriEnd + 1).match(/^(?:\s|#[^\n]*(?:\n|$))*\{/);
        // `depth` is left at 0 on purpose: the scanner still has to walk over that `{`, and it
        // is the one that opens the region.
        if (after) start = iriEnd + 1 + after[0].length;
      }
      return true;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; return false; } }
    return true;
  });
  if (start < 0 || end < 0) return null;
  return content.slice(start, end);
}

/** Escape a string for use inside a short Turtle literal. */
export const escapeTurtleLiteral = (s: unknown): string => String(s)
  .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');

/** A role table read out of a role-profile document. */
export interface RoleProfile {
  readonly roles: Map<string, { label: string; comment: string; permits: readonly string[] }>;
  readonly caps: Map<string, { label: string; comment: string }>;
}

/**
 * Parse the `wsp:Role` / `wsp:Capability` declarations out of a role profile.
 *
 * Comments are MASKED, not deleted: `^\s*#.*$` missed a comment that trails a triple, and
 * deleting text moves every offset after it. The literals are left intact, because the slices
 * handed to the readers below still have to contain their own text — those readers mask what
 * they are given.
 */
export function parseRoleProfile(ttl: string): RoleProfile {
  const roles: RoleProfile['roles'] = new Map();
  const caps: RoleProfile['caps'] = new Map();
  const prefixes = new Map<string, string>();
  const pre = /@prefix\s+([A-Za-z][\w.-]*)?:\s*<([^>]+)>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pre.exec(ttl))) prefixes.set(pm[1] ?? '', pm[2] as string);
  const expand = (t: string): string => {
    if (t[0] === '<') return t.slice(1, -1);
    const i = t.indexOf(':');
    if (i < 0) return t;
    const base = prefixes.get(t.slice(0, i));
    return base ? base + t.slice(i + 1) : t;
  };
  const stripped = maskComments(ttl);
  const stmt = /((?:<[^>]+>)|(?:[A-Za-z][\w.-]*:[^\s;,.]+))\s+a\s+((?:<[^>]+>)|(?:[A-Za-z][\w.-]*:[^\s;,.]+))\s*;([\s\S]*?)\.\s*(?=(?:<|[A-Za-z][\w.-]*:)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = stmt.exec(stripped))) {
    const subj = expand(m[1] as string);
    const type = expand(m[2] as string);
    const body = m[3] as string;
    const label = readLiteral(body, 'rdfs:label');
    const comment = readLiteral(body, 'rdfs:comment') ?? '';
    const fallback = subj.split('#').pop() ?? subj;
    if (type === WSP + 'Capability') caps.set(subj, { label: label ?? fallback, comment });
    if (type === WSP + 'Role') {
      // Both forms of wsp:permits, for the same reason as every other term here: reading only
      // the prefixed form reported a real role as permitting nothing, which then rendered as
      // a false "not permitted".
      const permits = readIriList(body, 'wsp:permits').map(expand).filter(Boolean);
      roles.set(subj, { label: label ?? fallback, comment, permits });
    }
  }
  return { roles, caps };
}
