/**
 * A composition as an author puts it together in the dashboard, and as foxxi.content_compose takes
 * it: a title, the competency it develops, and positions, each a competency and the alternatives
 * that can fill it, in the author's order of preference. Resolution picks among them for each
 * learner, so the order is a tie-break, not a sequence every learner sees.
 *
 * Alternatives are named by IRI, a fragment's or another composition's, and the bridge refuses a
 * composition whose alternatives it cannot reach. An agent sends the same JSON.
 */

export interface PositionDraft {
  /** Empty to take the composition's own. */
  competency: string;
  alternatives: string[];
}

export interface CompositionDraft {
  title: string;
  competency: string;
  positions: PositionDraft[];
}

export function newComposition(): CompositionDraft {
  return { title: '', competency: '', positions: [{ competency: '', alternatives: [] }] };
}

/** Whether an IRI names a fragment or a composition, on any bridge. */
export function contentKindOf(iri: string): 'fragment' | 'composition' | undefined {
  return /^https?:\/\/[^/?#]+\/ns\/foxxi\/(fragment|composition)\/[0-9a-f]{64}$/.exec(iri.trim())?.[1] as 'fragment' | 'composition' | undefined;
}

/**
 * What an IRI names, whichever bridge minted it: its kind and hash, as the engine tells content
 * apart (sameContent). The same fragment under two bridges' IRIs is one alternative, not two.
 */
export function contentKeyOf(iri: string): string {
  const m = /^https?:\/\/[^/?#]+\/ns\/foxxi\/(fragment|composition)\/([0-9a-f]{64})$/.exec(iri.trim());
  return m ? `${m[1]}:${m[2]}` : iri.trim();
}

/** A composition as the bridge takes it (compositions.ts, compositionFrom). */
export function compositionPayload(d: CompositionDraft): Record<string, unknown> {
  const competency = d.competency.trim();
  return {
    title: d.title.trim(), competency,
    positions: d.positions.map(p => ({ competency: p.competency.trim() || competency, paradigm: p.alternatives.map(a => a.trim()) })),
  };
}

/** What is still missing before it can be sent, one line each; empty when nothing is. */
export function missingFromComposition(d: CompositionDraft): string[] {
  const out: string[] = [];
  if (!d.title.trim()) out.push('Give it a title.');
  if (!d.competency.trim()) out.push('Name the competency it develops.');
  if (!d.positions.length) out.push('Add a position.');
  d.positions.forEach((p, i) => {
    if (!p.alternatives.length) out.push(`Position ${i + 1}: add at least one fragment or composition that can fill it.`);
    const bad = p.alternatives.find(a => !contentKindOf(a));
    if (bad !== undefined) out.push(`Position ${i + 1}: "${bad}" is not a fragment's or a composition's IRI.`);
    if (new Set(p.alternatives.map(contentKeyOf)).size < p.alternatives.length) out.push(`Position ${i + 1}: an alternative is listed twice.`);
  });
  return out;
}

/** The draft with `iri` added to the position at `at`, unless it is there already. */
export function offer(d: CompositionDraft, at: number, iri: string): CompositionDraft {
  return {
    ...d,
    positions: d.positions.map((p, i) => (i === at && !p.alternatives.some(a => contentKeyOf(a) === contentKeyOf(iri)) ? { ...p, alternatives: [...p.alternatives, iri.trim()] } : p)),
  };
}
