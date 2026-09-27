/**
 * An author's shelf: the fragments and compositions they made or picked up in this browser, to
 * compose from. A convenience of this portal only, kept per identity like the list opened lately.
 * What an author made is also in the index of where content lives, read with foxxi.content_mine,
 * and an agent keeps its own shelf however it likes.
 *
 * What is read back is checked: a stored shelf that is not one reads as empty.
 */

export interface ShelfItem {
  iri: string;
  type: 'fragment' | 'composition';
  title?: string;
  kind?: string;
  level?: string;
  /** When it was put on the shelf, ISO 8601. */
  at: string;
}

export const SHELF_MAX = 200;
const TEXT_MAX = 200;

export function shelfKey(identity: string): string {
  return `foxxi:author-shelf:${identity}`;
}

const IRI = /^https?:\/\/[^/?#]+\/ns\/foxxi\/(fragment|composition)\/[0-9a-f]{64}$/;
const text = (x: unknown): boolean => x === undefined || (typeof x === 'string' && x.length <= TEXT_MAX);

const isItem = (x: unknown): x is ShelfItem => {
  const r = x as Partial<ShelfItem> | null;
  const m = r && typeof r.iri === 'string' ? IRI.exec(r.iri) : null;
  return !!m && r!.type === m[1] && typeof r!.at === 'string' && text(r!.title) && text(r!.kind) && text(r!.level);
};

/** A stored shelf as it can be trusted: well-formed items only, each IRI once, at most SHELF_MAX. */
export function readShelf(raw: string | null | undefined): ShelfItem[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: ShelfItem[] = [];
  for (const x of parsed) {
    if (!isItem(x) || seen.has(x.iri)) continue;
    seen.add(x.iri);
    out.push({ iri: x.iri, type: x.type, at: x.at, ...(x.title ? { title: x.title } : {}), ...(x.kind ? { kind: x.kind } : {}), ...(x.level ? { level: x.level } : {}) });
    if (out.length >= SHELF_MAX) break;
  }
  return out;
}

/** The shelf with `item` first; an item already on it keeps what this one does not say. */
export function shelve(shelf: readonly ShelfItem[], item: ShelfItem): ShelfItem[] {
  const before = shelf.find(s => s.iri === item.iri);
  const said = Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)) as Partial<ShelfItem>;
  const entry = { ...before, ...said } as ShelfItem;
  return [entry, ...shelf.filter(s => s.iri !== item.iri)].slice(0, SHELF_MAX);
}

/** The shelf without the item at `iri`. */
export function unshelve(shelf: readonly ShelfItem[], iri: string): ShelfItem[] {
  return shelf.filter(s => s.iri !== iri);
}
