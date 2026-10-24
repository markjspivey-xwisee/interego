/** Bounded, own-pod-only cleanup; physical PGSL history reclamation is separate. */
export async function purgeProvisionalPlayPod(options: {
  userId: string; cssUrl: string; fetcher?: typeof fetch;
  stillUnclaimed(): Promise<boolean>;
}): Promise<void> {
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
  if (!await options.stillUnclaimed()) return;
  const anchor = new URL('auth-methods.jsonld', root).href;
  const targets = ordered.filter(url => url !== root.href && url !== anchor);
  if (ordered.includes(anchor)) targets.push(anchor);
  if (ordered.includes(root.href)) targets.push(root.href);
  for (const url of targets) {
    const response = await request(url, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error('Provisional cleanup deletion incomplete');
  }
}
