/**
 * Bounded, own-pod-only cleanup; physical PGSL history reclamation is separate.
 *
 * `stillUnclaimed` reads the owner's record and says whether it may go, with the ETag it was
 * read under and the document read. Before anything is deleted, that document is written back
 * unchanged on that ETag (If-Match), a fence: an enrolment that read the anchor before it (the
 * other instance's, during a deploy's overlap) then fails its own If-Match, and one that reads
 * it after finds the anchor expired, which no writer accepts (server.ts playOwnerWritable). A
 * 412 on the fence means such an enrolment landed first: 'kept', and nothing is deleted. Only
 * then are the pod's resources deleted, the anchor last but the root. A pod that sends no ETag
 * gets no fence.
 */
export async function purgeProvisionalPlayPod(options: {
  userId: string; cssUrl: string; fetcher?: typeof fetch;
  stillUnclaimed(): Promise<{ ok: boolean; etag: string | null; document?: unknown }>;
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
  // Discover and validate the entire bounded tree before deleting anything.
  await visit(root, 0);
  const unclaimed = await options.stillUnclaimed();
  if (!unclaimed.ok) return 'kept';
  const anchor = new URL('auth-methods.jsonld', root).href;
  if (unclaimed.etag && unclaimed.document !== undefined) {
    const fence = await request(anchor, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', 'If-Match': unclaimed.etag },
      body: JSON.stringify(unclaimed.document, null, 2),
    });
    if (fence.status === 412) return 'kept';
    if (!fence.ok && fence.status !== 205) throw new Error('Provisional cleanup fence failed');
  }
  const targets = ordered.filter(url => url !== root.href && url !== anchor);
  if (ordered.includes(anchor)) targets.push(anchor);
  if (ordered.includes(root.href)) targets.push(root.href);
  for (const url of targets) {
    const response = await request(url, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error('Provisional cleanup deletion incomplete');
  }
  return 'purged';
}
