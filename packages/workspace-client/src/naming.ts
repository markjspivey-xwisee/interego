/**
 * THE NAMING SCHEME, and why it is shaped this way.
 *
 * A workspace IRI is `<relay>/ns/<convener pod>/<slug>`. Both halves of it are read back out,
 * so anything composed from them is reconstructible by any reader holding only the workspace
 * IRI. A workspace record does not enumerate its grants, streams or capabilities, so a client
 * COMPOSES those names — and every place a composed name is used to conclude something, the
 * conclusion has to say it was composed rather than read.
 *
 * A member's own documents live on the MEMBER'S pod and are named
 *   `<convener pod>--<slug>-acceptance`   (also `-stream`, `-canvas`, `-affordances`)
 * rather than the older `<slug>-acceptance`. The reason is collision: two conveners who both
 * call a workspace "family-room" would otherwise write to the same four names on a member who
 * joined both, and the second would silently supersede the first. Qualifying by the convener's
 * pod removes that, and the split stays unambiguous because a pod segment can never contain
 * `--` ({@link POD_RX}) and a slug is refused if it does ({@link slugProblem}).
 *
 * The unqualified form is still READ, because documents written under it exist and revoking a
 * name that already carries a conversation would be the client deciding to lose it.
 */

import { BAD_IRI } from './turtle.js';

/**
 * A pod segment. Used to decide whether the text before a `--` in somebody's document can be
 * a pod at all — which is what makes the split unambiguous.
 */
export const POD_RX = /^u-(eth|pk|did)-[0-9a-fA-F]+$/;

/**
 * A slug. No `--`, because that is the separator; no leading `-`, so a name can never be read
 * as a suffix; bounded, because it becomes part of a URL.
 */
export const SLUG_RX = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Why this slug cannot be used, or null when it can. */
export function slugProblem(s: string): string | null {
  if (!s) return 'Type a short name.';
  if (!SLUG_RX.test(s)) return 'Lower-case letters, digits and single hyphens only, 2 to 41 characters, starting with a letter or digit.';
  if (s.indexOf('--') >= 0) return 'Two hyphens in a row are the separator member document names are split on, so a slug may not contain them.';
  if (s.slice(-1) === '-') return 'A trailing hyphen would run into the document suffix.';
  return null;
}

/** The four kinds of document a member publishes on their own pod for one workspace. */
export type MemberDocKind = 'acceptance' | 'stream' | 'canvas' | 'affordances';

/** Which of the two naming forms a document was found under. */
export type Naming = 'qualified' | 'legacy';

export const nsIri = (relay: string, pod: string, name: string): string =>
  relay + '/ns/' + pod + '/' + name;

export const qualifiedName = (convenerPod: string, slug: string, kind: MemberDocKind): string =>
  convenerPod + '--' + slug + '-' + kind;

export const legacyName = (slug: string, kind: MemberDocKind): string => slug + '-' + kind;

/** Both IRIs a member document could live at, qualified first. */
export function memberDocIris(
  relay: string, memberPod: string, convenerPod: string, slug: string, kind: MemberDocKind,
): readonly { readonly iri: string; readonly naming: Naming }[] {
  return [
    { iri: nsIri(relay, memberPod, qualifiedName(convenerPod, slug, kind)), naming: 'qualified' },
    { iri: nsIri(relay, memberPod, legacyName(slug, kind)), naming: 'legacy' },
  ];
}

/** What an acceptance IRI found on a pod turns out to be about. */
export type ParsedAcceptance =
  | { readonly naming: 'qualified'; readonly owner: string; readonly slug: string; readonly workspace: string }
  | { readonly naming: 'legacy'; readonly owner: null; readonly slug: string; readonly workspace: null };

/**
 * Take an acceptance IRI found on a pod apart, WITHOUT a fetch when the name is qualified.
 * That is the whole reason the qualified form exists: listing the workspaces somebody is in
 * becomes one manifest read.
 *
 * Deliberately strict: this is applied to names discovered on a pod, and a name that does not
 * take apart cleanly is reported as legacy rather than guessed at.
 */
export function parseAcceptanceIri(relay: string, iri: unknown, memberPod: string): ParsedAcceptance | null {
  const pre = nsIri(relay, memberPod, '');
  if (typeof iri !== 'string' || iri.indexOf(pre) !== 0) return null;
  const name = iri.slice(pre.length);
  if (name.indexOf('/') >= 0) return null;
  if (name.slice(-11) !== '-acceptance') return null;
  const stem = name.slice(0, -11);
  const cut = stem.indexOf('--');
  if (cut > 0) {
    const owner = stem.slice(0, cut);
    const slug = stem.slice(cut + 2);
    if (POD_RX.test(owner) && !slugProblem(slug)) {
      return { naming: 'qualified', owner, slug, workspace: nsIri(relay, owner, slug) };
    }
  }
  // Unqualified: the name carries no convener, so which workspace it accepts has to be read
  // out of the document itself.
  return { naming: 'legacy', owner: null, slug: stem, workspace: null };
}

/**
 * The pod segment a WebID names, or null when this reader cannot resolve one.
 *
 * ★ A segment lifted out of somebody else's document is not trusted to be a legal IRI
 * component. This name is concatenated into IRIs the client then fetches and locates signed
 * regions inside, and a `{`, a space or a quote in it would make those IRIs something other
 * than what the interface says they are.
 */
export function podOfWebid(w: unknown): string | null {
  if (typeof w !== 'string' || !w) return null;
  const m = /\/users\/([^/]+)\/profile/.exec(w) ?? /agents:[a-z0-9-]*?(u-[a-z0-9-]+)$/i.exec(w);
  const seg = m?.[1];
  if (!seg) return null;
  return !BAD_IRI.test(seg) && !/[#?]/.test(seg) ? seg : null;
}

/**
 * The pod segment inside a relay `/ns/<pod>/<slug>` IRI. Used to check that a log a member
 * NAMES is one they could actually own.
 */
export function podOfNsIri(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  const m = /^https?:\/\/[^/]+\/ns\/([^/]+)\//.exec(u);
  return m?.[1] ?? null;
}

/**
 * Where the bytes CAME FROM, taken from the URL that was actually fetched — not a name parsed
 * out of somebody's assertion about where they live. These two can disagree.
 */
export function podOfDescriptorUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  const m = /^https?:\/\/[^/]+\/([^/]+)\//.exec(u);
  return m?.[1] ?? null;
}

/** The pod's base URL, taken from a descriptor URL. */
export function podBaseOfDescriptorUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  const m = /^(https?:\/\/[^/]+\/[^/]+\/)/.exec(u);
  return m?.[1] ?? null;
}

/** The result of holding a claimed pod against the pod the bytes were served from. */
export interface PodClaimCheck {
  readonly mismatch: boolean;
  readonly text: string;
  readonly title: string;
}

/**
 * The pod a name in somebody else's document CLAIMS, held against the pod the bytes were
 * actually SERVED from.
 *
 * ONE helper, so the roster and every message header apply the same test — the roster used to
 * compute the served pod and then print the claim without it, under a comment saying it
 * checked.
 */
export function podClaimVsServed(
  claimed: string | null, served: string | null, fetchedUrl: string | null, claimSource: string,
): PodClaimCheck {
  const mismatch = !!(claimed && served && claimed !== served);
  return {
    mismatch,
    text: served ? (mismatch ? served + ' ≠ ' + claimSource : served) : (claimed ?? 'unresolved'),
    title: served
      ? 'Served from pod ' + served + ', read off the descriptor URL that was fetched: ' + fetchedUrl
        + (mismatch ? '. The ' + claimSource + ' names this pod as ' + claimed + '. These disagree and neither is being preferred here.' : '.')
      : 'No pod could be read out of the descriptor URL that was fetched (' + (fetchedUrl ?? 'none reported')
        + '), so where the bytes are is not established — only what the ' + claimSource + ' claims.',
  };
}

/**
 * A short unique badge per pod.
 *
 * Two pods whose identifiers share their first two characters would share a badge, so the
 * mark is WIDENED until it is unique across the pods actually being rendered. Uniqueness is
 * the only thing that makes the badge worth showing.
 */
export function assignPodMarks(pods: readonly (string | null | undefined)[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const p of pods) {
    if (!p || out.has(p)) continue;
    const base = (p.replace(/^u-(eth|pk|did)-/, '') || '??').toUpperCase();
    let mk = base.slice(0, 2);
    for (let n = 3; n <= 4 && used.has(mk); n++) mk = base.slice(0, n);
    for (let k = 2; used.has(mk); k++) mk = base.slice(0, 3) + k;
    used.add(mk);
    out.set(p, mk);
  }
  return out;
}

/** A workspace IRI split into the pod that convenes it and its slug, or null. */
export function parseWorkspaceIri(relay: string, iri: string): { readonly owner: string; readonly slug: string } | null {
  const pre = relay + '/ns/';
  if (iri.indexOf(pre) !== 0) return null;
  const parts = iri.slice(pre.length).split('/');
  const owner = parts[0];
  const slug = parts[1];
  if (parts.length !== 2 || !owner || !slug) return null;
  return { owner, slug };
}
