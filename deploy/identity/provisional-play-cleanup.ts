/**
 * Bounded, own-pod-only cleanup; physical PGSL history reclamation is separate.
 *
 * The pod's tree is listed and checked first (own pod only, at most 128 resources over eight
 * levels), and nothing is changed when that fails. Then `close()`, under the owner's lock the
 * caller holds, closes the owner's account on its record as the pod holds it (server.ts
 * deleteUserCompletely: auth-methods.jsonld is overwritten with the deletion's tombstone, on the
 * ETag of the record it checked). An enrolment that read the anchor before it (the other
 * instance's, during a deploy's overlap) then fails its own If-Match, and one that reads it after
 * finds the account closed; an enrolment that lands first makes the tombstone's write fail, and
 * close() reads the record again and keeps the account: 'kept', and nothing is deleted. Only then
 * are the pod's other resources deleted. The record itself stays, as the tombstone, and so does the
 * container that holds it: a write still pending from before the purge is conditional on the
 * record's ETag, which Community Solid Server 7.2 applies to a missing document too (only
 * If-Match: * fails there), so a purge that deleted the record (it used to, last but the root) let
 * such a write re-create the owner afterwards. Provisioning may replace the tombstone
 * (provisional-play-store.ts).
 */
export async function purgeProvisionalPlayPod(options: {
  userId: string; cssUrl: string; fetcher?: typeof fetch;
  /** Close the owner's account under its lock: true once its record is the tombstone, false when it is kept. */
  close(): Promise<boolean>;
}): Promise<'purged' | 'kept'> {
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
  if (!await options.close()) return 'kept';
  // Children before their containers (the order visit listed them in); never the record, nor the
  // container that holds it.
  const anchor = new URL('auth-methods.jsonld', root).href;
  const targets = ordered.filter(url => url !== root.href && url !== anchor);
  for (const url of targets) {
    const response = await request(url, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error('Provisional cleanup deletion incomplete');
  }
  return 'purged';
}
