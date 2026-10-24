/**
 * Reading accounts from their pods, and loading every account at startup.
 *
 * The identity server keeps no database: a user exists because their pod holds an
 * `auth-methods.jsonld` with at least one credential, and the in-memory indexes that
 * sign-in consults (credential id → user, wallet → user, DID → user) are rebuilt from
 * the pods whenever the container starts.
 *
 * ★ A POD THAT COULD NOT BE READ IS NOT A POD WITHOUT CREDENTIALS. The reader this
 * replaces answered every failure (a timeout, a 502 from a cold CSS, a reset connection)
 * with an empty document, so the startup rebuild counted those users as "skipped (no
 * credentials)", never as failed, and never tried them again. A restart while CSS was
 * slow therefore left most accounts unknown for the life of the container: their tokens
 * failed "User for token not found" (the connector disconnects), their passkeys failed
 * "No passkey found" / "No WebAuthn credential matches" on sign-in, and the only way
 * forward offered was registering a brand-new account. Measured on 2026-10-13: the
 * server knew 8 users while 445 pods held credentials.
 *
 * Here a read either returns the document, returns null for a pod that has none (404),
 * or throws PodReadError; and loadAccounts retries what it could not read instead of
 * forgetting it.
 */

export class PodReadError extends Error {
  constructor(readonly url: string, readonly reason: string) {
    super(`could not read ${url}: ${reason}`);
    this.name = 'PodReadError';
  }
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponseLike>;

/**
 * One pod document as JSON: its body, or null when the pod has no such document (404).
 * Anything else (a network error, another status, a body that is not JSON) throws
 * PodReadError, so a caller can never mistake an outage for an empty account.
 */
export async function readPodJson(fetchFn: FetchLike, url: string): Promise<unknown | null> {
  let r: FetchResponseLike;
  try {
    r = await fetchFn(url, { headers: { 'Accept': 'application/ld+json' } });
  } catch (err) {
    throw new PodReadError(url, (err as Error).message);
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new PodReadError(url, `${r.status} ${r.statusText}`.trim());
  let text: string;
  try {
    text = await r.text();
  } catch (err) {
    throw new PodReadError(url, `body unreadable: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PodReadError(url, 'body is not JSON');
  }
}

/**
 * The pods the CSS root container lists: its direct sub-containers, by name. An empty
 * list is an answer; a root that could not be listed throws PodReadError.
 */
export async function listPods(fetchFn: FetchLike, rootUrl: string): Promise<string[]> {
  let r: FetchResponseLike;
  try {
    r = await fetchFn(rootUrl, { headers: { 'Accept': 'text/turtle' } });
  } catch (err) {
    throw new PodReadError(rootUrl, (err as Error).message);
  }
  if (!r.ok) throw new PodReadError(rootUrl, `${r.status} ${r.statusText}`.trim());
  const body = await r.text();
  const out: string[] = [];
  // CSS writes `ldp:contains <a/>, <b/>, <c.json> .` — the children are relative IRIs, and
  // the containers among them end in '/'. The object list is read as IRIs up to the
  // statement's end, never up to the first '.' or ';': a child whose NAME holds one (the
  // root's `provisional-play-admission.json`, which sorts before every `svc-` and `u-`
  // pod) cut the listing there, and every account after it went unloaded at startup.
  const re = /ldp:contains\s+((?:<[^>]*>\s*,\s*)*<[^>]*>)/g;
  let block: RegExpExecArray | null;
  while ((block = re.exec(body)) !== null) {
    for (const ref of block[1].match(/<([^>]+)>/g) ?? []) {
      const path = ref.slice(1, -1);
      if (path.endsWith('/') && !path.startsWith('.')) out.push(path.replace(/\/$/, ''));
    }
  }
  return [...new Set(out)];
}

export interface AccountLoadReport {
  /** False when the root could not be listed, in which case nothing below was attempted. */
  readonly listed: boolean;
  /** Pods attempted. */
  readonly attempted: number;
  /** Pods whose credentials were loaded. */
  readonly loaded: number;
  /** Pods read and found to hold no credentials (service pods, deleted users). */
  readonly skipped: number;
  /** Pods still unreadable after every retry. */
  readonly unreadable: readonly string[];
  /** Passes over the pods, the first included. */
  readonly rounds: number;
  readonly finishedAt: string;
}

/**
 * Load every account: list the pods (unless `only` names them), load each, and retry the
 * ones that could not be read after each delay in turn. `load` returns true when it
 * loaded an account, false when the pod holds no credentials, and throws when the pod
 * could not be read; only a throw is retried.
 */
export async function loadAccounts(opts: {
  list: () => Promise<string[]>;
  load: (podName: string) => Promise<boolean>;
  only?: readonly string[];
  concurrency?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<AccountLoadReport> {
  const delays = opts.retryDelaysMs ?? [2000, 5000, 15000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const concurrency = Math.max(1, opts.concurrency ?? 16);
  let names: string[] | null = opts.only ? [...opts.only] : null;
  for (let attempt = 0; names === null && attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]!);
    try { names = await opts.list(); } catch { /* retried below */ }
  }
  if (names === null) {
    return { listed: false, attempted: 0, loaded: 0, skipped: 0, unreadable: [], rounds: 0, finishedAt: new Date().toISOString() };
  }
  let loaded = 0, skipped = 0, rounds = 0;
  let pending = names;
  for (;;) {
    rounds++;
    const failed: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const name = pending[next++]!;
        try {
          if (await opts.load(name)) loaded++; else skipped++;
        } catch {
          failed.push(name);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    pending = failed;
    if (pending.length === 0 || rounds > delays.length) break;
    await sleep(delays[rounds - 1]!);
  }
  return {
    listed: true, attempted: names.length, loaded, skipped,
    unreadable: [...pending].sort(), rounds, finishedAt: new Date().toISOString(),
  };
}
