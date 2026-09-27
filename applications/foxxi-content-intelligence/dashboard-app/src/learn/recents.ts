/**
 * The compositions a person opened lately in this browser, newest first: a convenience of this
 * portal only. Nothing here is a record. What they played is in their own record, read with
 * foxxi.content_mine, and an agent keeps its own list however it likes.
 *
 * Kept per identity, so two people signing in on one browser do not see each other's list. What is
 * read back is checked: a stored list that is not one reads as empty.
 */

export interface RecentComposition {
  hash: string;
  title?: string;
  /** When it was last opened, ISO 8601. */
  at: string;
}

export const RECENTS_MAX = 12;
const TITLE_MAX = 200;

/** The storage key for one identity's list. */
export function recentsKey(identity: string): string {
  return `foxxi:recent-compositions:${identity}`;
}

const isRecent = (x: unknown): x is RecentComposition => {
  const r = x as Partial<RecentComposition> | null;
  return !!r && typeof r.hash === 'string' && /^[0-9a-f]{64}$/.test(r.hash) && typeof r.at === 'string'
    && (r.title === undefined || (typeof r.title === 'string' && r.title.length <= TITLE_MAX));
};

/** A stored list as it can be trusted: only well-formed entries, each hash once, at most RECENTS_MAX. */
export function readRecents(raw: string | null | undefined): RecentComposition[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: RecentComposition[] = [];
  for (const x of parsed) {
    if (!isRecent(x) || seen.has(x.hash)) continue;
    seen.add(x.hash);
    out.push({ hash: x.hash, at: x.at, ...(x.title ? { title: x.title } : {}) });
    if (out.length >= RECENTS_MAX) break;
  }
  return out;
}

/** The list with `opened` first, keeping the title it had when this opening brings none. */
export function remember(list: readonly RecentComposition[], opened: RecentComposition): RecentComposition[] {
  const before = list.find(r => r.hash === opened.hash);
  const title = (opened.title ?? before?.title)?.slice(0, TITLE_MAX);
  const entry: RecentComposition = { hash: opened.hash, at: opened.at, ...(title ? { title } : {}) };
  return [entry, ...list.filter(r => r.hash !== opened.hash)].slice(0, RECENTS_MAX);
}
