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
 * (not confirmed): that one is 'kept' until its guest deadline, and after it close() itself sends
 * the owner's agent registry a DELETE, as the deletion's retry would have, before answering 'closed'
 * (server.ts deleteUserCompletely); one the pod does not answer with a 2xx or a 404 leaves the
 * deletion for the caller's next pass (server.ts purgePlayOwner).
 * Only on 'purge' are the pod's other resources deleted (the relay's agent registry among them: on
 * 'purge', close() sends it no DELETE of its own), and a deletion that fails throws, leaving
 * the purge marked for the next pass. The record itself stays, as the tombstone, and so does the
 * container that holds it: a write still pending from before the purge is conditional on the
 * record's ETag, which Community Solid Server 7.2 applies to a missing document too (only
 * If-Match: * fails there), so a purge that deleted the record (it used to, last but the root) let
 * such a write re-create the owner afterwards.
 *
 * A guest's game data (PLAY_GAME_DATA: its saves, `hallowmarch/checkpoints/<64 hex>.json`, and its
 * write budget, `play-budget.json`) is written by the css-gate only as native commits, which the
 * production store (CSS 7.2 with the PGSL accessor) keeps as native-managed heads: no plain DELETE
 * removes one (with or without If-Match, it is a 409 every time). Each is deleted by the store's
 * native conditional delete instead (deleteGameData): its strong ETag read with a HEAD, then a
 * DELETE with `Interego-Native-Delete: 1` and `If-Match` on that ETag, which the store applies only
 * to that exact revision. That is sent only once the store advertises it (`Interego-Native-Delete:
 * 1` on OPTIONS), and only after close() said 'purge'. A HEAD answered 404 is a document already
 * gone. Anything else (no such capability, a 412 because the document changed or went since the
 * HEAD, a 409 because it is not a native head, any other answer) throws, and the purge stays marked
 * for the next pass, which lists the pod and reads each document again. The game data used to be
 * kept, as `retained`, and the purge finished without it, so every guest's saves stayed on the pod.
 * The containers that held it are deleted after it, through the ordinary DELETE, children first.
 *
 * A document outside the game data whose DELETE the pod answers 409 (a native head nothing here
 * expects) is kept, and the purge goes on: it is listed in `retained`, the containers that hold it
 * are not sent a DELETE (CSS answers 409 to a container that is not empty) and stay with it, and the
 * purge finishes. No plain request can delete such a head, and this cleanup sends a native delete
 * to none but the game data, so a purge kept open for one would be sent again at every pass, and
 * after every restart, and never finish. A 409 on a container that holds nothing kept fails the pass
 * as any other failure does (something written in it since the listing, which the next pass lists).
 *
 * Closure fence: a write the css-gate authorized before the tombstone can still reach the pod after
 * it (the gate let it through while the guest's token was valid), and re-create a save or the budget
 * after its deletion. So, once every deletion is done, the pod is listed again, and when that listing
 * names any of the game data the purge throws and stays marked for the next pass, which deletes it.
 * The listing names the record and the containers that are kept (the pod's own, and those of a
 * `retained` document) too; only the game data holds the purge open. A write that reaches the store
 * only after that listing is not seen: the purge, finished, does not come back to it.
 */
export interface PlayPodPurge {
  /**
   * 'purged': close() said 'purge', every resource but the record, its container, `retained` and
   * the containers that hold those is deleted, the game data included, and a last listing found no
   * game data. 'closed' and 'kept': close()'s answer.
   */
  outcome: 'purged' | 'closed' | 'kept';
  /** The documents outside the game data kept because the pod refused their DELETE with 409 (native heads), by URL. */
  retained: string[];
}

/**
 * A Play pod's game data, by path relative to the pod's root: the css-gate's checkpoints
 * (`hallowmarch/checkpoints/<sha256 hex>.json`) and its write budget (`play-budget.json`), the only
 * documents a guest's token can write (deploy/css-gate/provisional-play.mjs). Nothing else is ever
 * sent a native delete.
 */
const PLAY_GAME_DATA: readonly RegExp[] = [/^hallowmarch\/checkpoints\/[0-9a-f]{64}\.json$/, /^play-budget\.json$/];

/** The path of `url` relative to the pod's root `root`, or null where `url` is not a plain URL inside it. */
function inPod(root: URL, url: string): string | null {
  let target: URL;
  try { target = new URL(url); } catch { return null; }
  if (target.origin !== root.origin || target.search || target.hash || target.username || target.password
    || !target.pathname.startsWith(root.pathname)) return null;
  return target.pathname.slice(root.pathname.length);
}

/** `path` percent-decoded, or itself where it does not decode. */
function decoded(path: string): string {
  try { return decodeURIComponent(path); } catch { return path; }
}

/** Whether `url` is one of the game data (PLAY_GAME_DATA) of the pod whose root is `root`. */
export function isPlayGameData(root: URL, url: string): boolean {
  const relative = inPod(root, url);
  return relative !== null && PLAY_GAME_DATA.some(pattern => pattern.test(relative));
}

type PodRequest = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The native delete of the game data of the pod whose root is `root` (see the head of this file),
 * one document a call: returns once the document is deleted or found gone (a HEAD answered 404),
 * and throws otherwise. The pod's root and its sign-in record (the tombstone) are refused before
 * anything is sent, whatever the caller decided, and so is every document outside the game data.
 * The store's capability (`Interego-Native-Delete: 1` on OPTIONS) is asked once, at the first call
 * that would send a native delete; without it nothing is deleted this way.
 */
export function deleteGameData(root: URL, request: PodRequest): (url: string) => Promise<void> {
  let advertised: Promise<boolean> | undefined;
  return async (url: string) => {
    const relative = inPod(root, url);
    if (relative !== null && [relative, decoded(relative)].some(path => path === '' || path === 'auth-methods.jsonld'))
      throw new Error('Refusing a native delete of the pod or its sign-in record');
    if (!isPlayGameData(root, url)) throw new Error('Refusing a native delete outside the Play game data');
    advertised ??= request(url, { method: 'OPTIONS' })
      .then(response => response.ok && response.headers.get('interego-native-delete')?.trim() === '1');
    if (!await advertised) throw new Error('Provisional cleanup: the pod\'s store does not advertise native delete (Interego-Native-Delete: 1 on OPTIONS)');
    const read = await request(url, { method: 'HEAD' });
    if (read.status === 404) return;   // gone already
    const etag = read.headers.get('etag');
    if (!read.ok || !etag || !/^"[^"]+"$/.test(etag)) throw new Error(`Provisional cleanup: no strong ETag for ${relative} (${read.status})`);
    const response = await request(url, { method: 'DELETE', headers: { 'Interego-Native-Delete': '1', 'If-Match': etag } });
    if (!response.ok) throw new Error(`Provisional cleanup: the native delete of ${relative} was answered ${response.status}`);
  };
}

export async function purgeProvisionalPlayPod(options: {
  userId: string; cssUrl: string; fetcher?: typeof fetch;
  /**
   * Close the owner's account under its lock: 'purge' once its record is the purge's tombstone,
   * 'closed' when it is another tombstone (nothing of the pod is deleted here; for a deletion its
   * process answered 503, once its guest deadline has passed, close() has sent the owner's agent
   * registry a DELETE first, which may have failed), 'kept' when the account is kept.
   */
  close(): Promise<'purge' | 'closed' | 'kept'>;
}): Promise<PlayPodPurge> {
  if (!/^u-try-play-[a-f0-9]{32}$/.test(options.userId)) throw new Error('Refusing non-Play pod cleanup');
  const root = new URL(`${options.userId}/`, options.cssUrl);
  const fetcher = options.fetcher ?? fetch;
  const request: PodRequest = (url, init = {}) => fetcher(url, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  /** The pod's tree, children before their containers, checked as it is listed. */
  const list = async (): Promise<string[]> => {
    const seen = new Set<string>();
    const ordered: string[] = [];
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
    await visit(root, 0);
    return ordered;
  };
  // Discover and validate the entire bounded tree before changing anything.
  const listed = await list();
  const closed = await options.close();
  if (closed !== 'purge') return { outcome: closed, retained: [] };
  // Children before their containers (the order list() gives); never the record, nor the
  // container that holds it.
  const anchor = new URL('auth-methods.jsonld', root).href;
  const targets = listed.filter(url => url !== root.href && url !== anchor);
  const nativeDelete = deleteGameData(root, request);
  const retained: string[] = [];
  for (const url of targets) {
    const container = url.endsWith('/');
    // A container that holds a kept document is not empty: it stays with it.
    if (container && retained.some(kept => kept.startsWith(url))) continue;
    if (!container && isPlayGameData(root, url)) { await nativeDelete(url); continue; }
    const response = await request(url, { method: 'DELETE' });
    if (response.ok || response.status === 404) continue;
    if (response.status === 409 && !container) { retained.push(url); continue; }
    throw new Error('Provisional cleanup deletion incomplete');
  }
  // Closure fence: game data a write the gate authorized before the tombstone put back meanwhile.
  const late = (await list()).filter(url => isPlayGameData(root, url));
  if (late.length > 0) {
    throw new Error(`Provisional cleanup: game data is on the pod again after its deletion (${late.map(url => url.slice(root.href.length)).join(', ')})`);
  }
  return { outcome: 'purged', retained };
}
