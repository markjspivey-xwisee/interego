/**
 * Where the bridge keeps fragments and compositions while it serves them.
 *
 * Content here is identified by its hash, so this store needs none of the ownership machinery a
 * mutable course id does (first-writer locks, owner-first reads). Nothing can be kept under an IRI
 * except content that hashes to it, and an item fetched from anywhere is checked the same way
 * before it is kept. A wrong or hostile source can make an item unavailable; it cannot make it
 * different.
 *
 * An author's pod is where content lives durably. This store is a bounded cache in front of it:
 * `fetch` falls back to the durable copy on a miss, and `gather` brings everything a composition
 * can reach into the cache before it is resolved, so resolution never waits on storage mid-way.
 */
import { COMPOSITION_LIMITS, compositionIsIntact, type Composition } from './compositions.js';
import { ContentError, contentRefOf, fragmentIsIntact, sameContent, type Fragment } from './content-fragments.js';

export type ContentItem = Fragment | Composition;

export const isCompositionItem = (x: ContentItem): x is Composition => Array.isArray((x as Composition).positions);

const isIntact = (x: ContentItem): boolean => (isCompositionItem(x) ? compositionIsIntact(x) : fragmentIsIntact(x));

const keyOf = (iri: string): string | undefined => {
  const ref = contentRefOf(iri);
  return ref ? `${ref.type}:${ref.hash}` : undefined;
};

/** Where content lives durably. Whatever it returns is checked before it is used. */
export interface DurableContent {
  load(ref: { type: 'fragment' | 'composition'; hash: string; iri: string }): Promise<ContentItem | undefined>;
}

/** How many items `gather` brings in at most, and how many it asks storage for at once. */
export const GATHER_LIMITS = { items: 5_000, parallel: 16 } as const;

/**
 * How many authors' pods a location index remembers for one item. Identical content authored by
 * several people is one item; remembering more than one pod means the first author withdrawing it
 * does not make it unreachable while others still hold it.
 */
export const LOCATIONS_PER_ITEM = 5;

/** Two location indexes (content key → author DIDs) as one: each key's DIDs in first-seen order, at most LOCATIONS_PER_ITEM. */
export function mergeLocations(first: unknown, second: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const source of [first, second]) {
    if (!source || typeof source !== 'object') continue;
    const entries = source instanceof Map ? [...source.entries()] : Object.entries(source as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || !/^(fragment|composition):[0-9a-f]{64}$/.test(key)) continue;
      const list = out.get(key) ?? [];
      for (const did of Array.isArray(value) ? value : [value]) {
        if (typeof did === 'string' && did && !list.includes(did) && list.length < LOCATIONS_PER_ITEM) list.push(did);
      }
      if (list.length) out.set(key, list);
    }
  }
  return out;
}

export class ContentStore {
  private readonly items = new Map<string, ContentItem>();

  constructor(private readonly max = 20_000, private readonly durable?: DurableContent) {}

  get size(): number { return this.items.size; }

  /** Keep an item. Refused unless it hashes to its IRI. The least recently kept goes first past the cap. */
  put(item: ContentItem): void {
    const key = keyOf(item?.['@id']);
    if (!key || !isIntact(item)) throw new ContentError('content does not hash to its IRI, so it was not kept');
    this.items.delete(key);
    this.items.set(key, item);
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  /** The item an IRI names, if it is held here. */
  get(iri: string): ContentItem | undefined {
    const key = keyOf(iri);
    return key ? this.items.get(key) : undefined;
  }

  /** The item an IRI names, from here or from durable storage, checked before it is kept. */
  async fetch(iri: string): Promise<ContentItem | undefined> {
    const held = this.get(iri);
    if (held) return held;
    const ref = contentRefOf(iri);
    if (!ref || !this.durable) return undefined;
    const loaded = await this.durable.load({ ...ref, iri }).catch(() => undefined);
    if (!loaded || !sameContent(loaded['@id'], iri) || !isIntact(loaded)) return undefined;
    this.put(loaded);
    return loaded;
  }

  /**
   * Bring everything a composition can reach into the store, level by level to the nesting depth
   * resolution allows, and say what could not be found. Refused past GATHER_LIMITS.items.
   */
  async gather(root: Composition, limit: number = GATHER_LIMITS.items): Promise<{ missing: string[] }> {
    const seen = new Set<string>([keyOf(root['@id']) ?? root['@id']]);
    const missing: string[] = [];
    let frontier: Composition[] = [root];
    for (let depth = 0; depth < COMPOSITION_LIMITS.depth && frontier.length; depth++) {
      const wanted: string[] = [];
      for (const comp of frontier) {
        for (const pos of comp.positions) {
          for (const iri of pos.paradigm) {
            const key = keyOf(iri);
            if (!key || seen.has(key)) continue;
            if (seen.size >= limit) throw new ContentError(`"${root.title}" reaches more than ${limit} pieces of content`);
            seen.add(key);
            wanted.push(iri);
          }
        }
      }
      const next: Composition[] = [];
      for (let i = 0; i < wanted.length; i += GATHER_LIMITS.parallel) {
        const batch = wanted.slice(i, i + GATHER_LIMITS.parallel);
        const found = await Promise.all(batch.map(iri => this.fetch(iri)));
        found.forEach((item, k) => {
          if (!item) missing.push(batch[k]!);
          else if (isCompositionItem(item)) next.push(item);
        });
      }
      frontier = next;
    }
    return { missing };
  }
}
