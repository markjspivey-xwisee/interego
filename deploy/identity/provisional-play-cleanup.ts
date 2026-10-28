/**
 * Bounded, own-pod-only cleanup; physical PGSL history reclamation is separate.
 *
 * The pod's tree is listed and checked first (own pod only, at most 128 resources over eight
 * levels), and nothing is changed when that fails. Then `close()`, under the owner's lock the
 * caller holds, closes the owner's account on its record as the pod holds it (server.ts
 * purgePlayOwner: auth-methods.jsonld is overwritten with the purge's tombstone, marked as a purge
 * not yet finished, on the ETag of the record it checked). An enrolment that read the anchor before
 * it (the other instance's, during a deploy's overlap) then fails its own If-Match, and one that
 * reads it after finds the account closed; an enrolment that lands first makes the tombstone's write
 * fail, and close() reads the record again and keeps the account: 'kept', and nothing is deleted.
 * A record that is a tombstone already is not closed again: close() says 'purge' for one an earlier
 * pass marked (its purge did not finish: the deletions are sent again), and 'closed' for any other
 * tombstone, and nothing of the pod is deleted here (a deletion's, whose owner may be provisioned
 * again until its guest deadline). The exception is a deletion the caller's process answered 503
 * (not confirmed): that one is 'kept' until its guest deadline, and after it close() itself deletes
 * the owner's agent registry, as the deletion's retry would have, before answering 'closed'
 * (server.ts deleteUserCompletely).
 * Only on 'purge' are the pod's other resources deleted, and a deletion that fails throws, leaving
 * the purge marked for the next pass. The record itself stays, as the tombstone, and so does the
 * container that holds it: a write still pending from before the purge is conditional on the
 * record's ETag, which Community Solid Server 7.2 applies to a missing document too (only
 * If-Match: * fails there), so a purge that deleted the record (it used to, last but the root) let
 * such a write re-create the owner afterwards.
 *
 * A document whose DELETE the pod answers 409 is kept, and the purge goes on: on the production
 * store (CSS 7.2 with the PGSL accessor) that is a native-committed head, which only a native
 * conditional commit changes or removes; no plain request deletes it (its DELETE, with or without
 * If-Match, is a 409 every time). A guest's game saves (`hallowmarch/checkpoints/<sha>.json`) and its
 * write budget (`play-budget.json`) are such heads: the css-gate writes them only as native commits.
 * The containers that hold a kept document are not sent a DELETE (CSS answers 409 to a container that
 * is not empty), and stay with it. The purge finishes with the kept documents listed in `retained`.
 * It used to throw at the first of them, so the purge never finished: it was sent again at every
 * pass, and after every restart, for every guest who ever saved, and met the same 409 each time. A
 * 409 on a container that holds nothing kept fails the pass as any other failure does (something
 * written in it since the listing, which the next pass lists).
 */
export interface PlayPodPurge {
  /**
   * 'purged': close() said 'purge', and every resource but the record, its container, `retained`
   * and the containers that hold those is deleted. 'closed' and 'kept': close()'s answer.
   */
  outcome: 'purged' | 'closed' | 'kept';
  /** The documents kept because the pod refused their DELETE with 409 (native heads), by URL. */
  retained: string[];
}

export async function purgeProvisionalPlayPod(options: {
  userId: string; cssUrl: string; fetcher?: typeof fetch;
  /**
   * Close the owner's account under its lock: 'purge' once its record is the purge's tombstone,
   * 'closed' when it is another tombstone (nothing of the pod is deleted here; for a deletion its
   * process answered 503, once its guest deadline has passed, close() has deleted the owner's agent
   * registry first), 'kept' when the account is kept.
   */
  close(): Promise<'purge' | 'closed' | 'kept'>;
}): Promise<PlayPodPurge> {
  if (!/^u-try-play-[a-f0-9]{32}$/.test(options.userId)) throw new Error('Refusing non-Play pod cleanup');
  const root = new URL(`${options.userId}/`, options.cssUrl);
  const fetcher = options.fetcher ?? fetch;
  const seen = new Set<string>();
  const ordered: string[] = [];
  const request = (url: string, init: RequestInit = {}) => fetcher(url, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const visit = async (url: URL, depth: number): Promise<void> => {
    if (seen.has(url.href)) return;
    if (depth > 8 || seen.size >= 128) throw new Error('Provisional cleanup traversal limit');
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.search || url.hash || url.username || url.password)
      throw new Error('Refusing foreign provisional cleanup target');
    seen.add(url.href);
    if (url.pathname.endsWith('/')) {
      const response = await request(url.href, { headers: { Accept: 'text/turtle' } });
      if (response.status === 404) return;
      if (!response.ok) throw new Error('Provisional cleanup listing unavailable');
      const body = await response.text();
      for (const block of body.matchAll(/ldp:contains\s+((?:<[^>]+>\s*(?:,\s*)?)+)(?:;|\.)/g)) {
        for (const reference of block[1].matchAll(/<([^>]+)>/g)) await visit(new URL(reference[1], url), depth + 1);
      }
    }
    ordered.push(url.href);
  };
  // Discover and validate the entire bounded tree before changing anything.
  await visit(root, 0);
  const closed = await options.close();
  if (closed !== 'purge') return { outcome: closed, retained: [] };
  // Children before their containers (the order visit listed them in); never the record, nor the
  // container that holds it.
  const anchor = new URL('auth-methods.jsonld', root).href;
  const targets = ordered.filter(url => url !== root.href && url !== anchor);
  const retained: string[] = [];
  for (const url of targets) {
    const container = url.endsWith('/');
    // A container that holds a kept document is not empty: it stays with it.
    if (container && retained.some(kept => kept.startsWith(url))) continue;
    const response = await request(url, { method: 'DELETE' });
    if (response.ok || response.status === 404) continue;
    if (response.status === 409 && !container) { retained.push(url); continue; }
    throw new Error('Provisional cleanup deletion incomplete');
  }
  return { outcome: 'purged', retained };
}
