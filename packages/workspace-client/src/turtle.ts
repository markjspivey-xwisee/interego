/**
 * Turtle/TriG reading for a workspace client — WHAT THIS VERTICAL ADDS, and nothing else.
 *
 * ★ THE READERS THEMSELVES ARE NOT HERE ANY MORE, AND THAT IS THE POINT. The one-pass scanner,
 * the comment/literal mask, the `<graph> { … }` locator and every term reader built on them moved
 * to `@interego/core/rdf/turtle-region`. None of that is a workspace concept: the relay serves
 * EVERY descriptor as a TriG document with the payload inside one signed block, so an agent
 * reading a peer's presence lease, a Foxxi record and a workspace entry all locate a region the
 * same way — or a document means two things depending on who opened it. They were here because
 * this vertical needed them first, which is the same call this project has already had to reverse
 * for delegates and for the relay transport.
 *
 * What is genuinely this vertical's, and all that is left:
 *
 *   1. {@link WSP} — its own vocabulary.
 *   2. {@link nsOf} — the substrate's prefix table PLUS `wsp:`. The substrate must not know `wsp:`
 *      and this file must not restate `dct:`/`iep:`/`prov:`, so the table is composed, not copied.
 *   3. {@link parseRoleProfile} — a role table is a workspace document.
 *
 * The readers are re-exported below, bound to that table. Every existing call site keeps working
 * and there is exactly one implementation, which is the same arrangement `delegates.ts` uses for
 * the delegate surface and for the same reason: the generated artifact bundle pulls the SUBSTRATE
 * implementation into itself rather than a copy.
 */

import {
  SUBSTRATE_NS, makeTurtleReaders, maskComments, nsFrom,
} from '@interego/core/rdf/turtle-region';

export {
  BAD_IRI, unescapeLiteral, scanTurtle, maskFill, masked, maskComments, literalAt, forms,
  graphRegion, IEP, PROV,
  type SpanKind, type TurtleReaders,
} from '@interego/core/rdf/turtle-region';

/** The WSP vocabulary this client reads and writes. */
export const WSP = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#';

/**
 * The PUBLISHED capability terms a workspace's roles permit.
 *
 * ── ★★ CAPABILITIES ARE VOCABULARY; ROLES ARE GOVERNANCE ────────────────────────────────────
 *
 * A role table is per-workspace and rightly so — "roles are DATA, a workspace that wants different
 * governance publishes a different profile". A CAPABILITY is not: `read`, `append`, `grant` are
 * terms in a published vocabulary that the reader, the fold and every other workspace share.
 *
 * ★ MINTING THEM PER WORKSPACE MADE EVERY MEMBER POWERLESS. The client emitted `<rolesIri>#Read`,
 * `#Post`, `#Convene`; the fold computes `effective = role.permits ∩ principal's scope` and the
 * scope side resolves to the published `wsp-roles-default#read|append|grant|…`. The intersection is
 * a literal IRI comparison, so it was EMPTY for every member of every workspace this client has
 * ever created — a Convener with a full ReadWrite delegation held no capability at all. The failure
 * is silent by construction: an empty effective set reads exactly like a correctly-restricted one.
 *
 * So the client stops asserting its own capability vocabulary under the workspace's name and
 * permits the published terms instead. The role IRIs stay per-workspace, which is the half that
 * genuinely is that workspace's business.
 */
export const WSPR = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default#';

/**
 * Prefix -> namespace, for the prefixes a workspace document uses.
 *
 * ★ COMPOSED FROM THE SUBSTRATE'S TABLE, NOT WRITTEN OUT BESIDE IT. A second spelling of `iep:`
 * here would be a second answer to "what does iep: expand to" the first time either moved, and the
 * consequence is not a type error — it is a reader that silently reports a real record as empty,
 * which is this file's oldest defect and the one every comment in the moved module is about.
 */
export const nsOf = (term: string): string | null => nsFrom({ ...SUBSTRATE_NS, 'wsp:': WSP }, term);

const R = makeTurtleReaders(nsOf);

/** The literal object of `term`, or null when the term is absent. */
export const readLiteral = R.readLiteral;
/** The IRI object of `term`, or null when the term is absent. */
export const readIri = R.readIri;
/** EVERY IRI object of `term` in this region, in document order, not just the first. */
export const readIriAll = R.readIriAll;
/** A list of objects after one predicate: `p <a>, <b>` or `p px:a, px:b`. */
export const readIriList = R.readIriList;
/** A number written the way Turtle actually writes one. Null is absent, which is NOT zero. */
export const readInt = R.readInt;
/** Whether `term` is asserted true, in either the native or the quoted lexical form. */
export const hasTrue = R.hasTrue;
/** `<subject> a <type>`, for either form of the type IRI. */
export const hasType = R.hasType;

/**
 * Escape a string for use inside a short Turtle literal.
 *
 * ★ THE SUBSTRATE'S, RE-EXPORTED, AND THE SIGNATURE IS WIDER THAN ITS. `rdf/escape` takes a
 * `string`; this vertical's call sites pass values read out of other people's documents, which are
 * `unknown` until something coerces them. The coercion is here rather than at each call site
 * precisely so no call site does it differently — but WHAT gets escaped, once it is a string, is
 * the substrate's answer and not a second one.
 */
export { escapeTurtleLiteral } from './escape-literal.js';

/**
 * ★ THE ONE MODAL STATUS READER, AND WHY IT IS COMPOSED HERE RATHER THAN ADDED TO THE SUBSTRATE.
 *
 * `iep:modalStatus` is the SUBSTRATE's vocabulary — `iep:` is already in `SUBSTRATE_NS`, so
 * {@link nsOf} resolves it without this vertical restating a namespace. What is composed here is
 * only the two-form read, because a membership document may state its status either way and a
 * reader that knew one form would report a withdrawn record as current:
 *
 *   · `iep:modalStatus "Retracted"` — a plain literal, which is what the maintainer's own
 *     tombstones on the live pod carry (measured, 2026-08-11);
 *   · `iep:modalStatus iep:Retracted` — the IRI form the ontology's `owl:oneOf` enumerates.
 *
 * ★ ABSENCE IS NOT RETRACTION AND RETRACTION IS NOT MALFORMEDNESS. This returns `null` for a
 * region that says nothing about its own status, and callers must render that as "said nothing"
 * — a truncated read, an unlocatable signed region and a deliberate withdrawal all produce a
 * record with no `wsp:workspace` in it, and only one of them is a statement by its author.
 */
export function readModalStatus(region: string | null | undefined): string | null {
  const lit = readLiteral(region, 'iep:modalStatus');
  if (lit !== null && lit.trim()) return lit.trim();
  for (const t of readIriList(region, 'iep:modalStatus')) {
    // `readIriList` hands back `<full-iri>` and prefixed names alike, so the local part is taken
    // after whichever of `#`, `/` or `:` comes last. A bare `<>` yields nothing and is skipped.
    const body = t.charAt(0) === '<' ? t.slice(1, -1) : t;
    const cut = Math.max(body.lastIndexOf('#'), body.lastIndexOf('/'), body.lastIndexOf(':'));
    const local = body.slice(cut + 1).trim();
    if (local) return local;
  }
  return null;
}

/** The one value that withdraws a record — `iep:ModalStatusEnum`'s own spelling. */
export const MODAL_RETRACTED = 'Retracted';

/**
 * Whether a signed region states that its own content has been withdrawn.
 *
 * Case-insensitive on the token alone: the value is an enumerated term, and a document that
 * spells it `retracted` has still said the thing. Nothing is inferred — a region that states no
 * status at all is not retracted, however little else it says.
 */
export const isRetracted = (region: string | null | undefined): boolean =>
  (readModalStatus(region) ?? '').toLowerCase() === MODAL_RETRACTED.toLowerCase();

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
