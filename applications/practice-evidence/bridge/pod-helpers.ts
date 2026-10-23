/**
 * The pod side of every pev act: publish a record, read one back and check its signature, find
 * the head of a chain, walk a chain, read the role registry (now, or as it stood at an instant),
 * delete a graph, and the one fetch that may carry the operator's pod credential.
 *
 * What a record must pass before any decision rests on it (§5.3, the TRUST RULE):
 *   · its body comes from the `pev:recordJson` literal, and the literal's sha256 matches;
 *   · its platform authorship proof verifies AND binds the exact graph region served
 *     (`contentBinding: 'bound'`);
 *   · the proof's signer is one of the trusted platform addresses;
 *   · it sits where it was written: the signed body names the graph and the pod it is read
 *     from, its signed `seq` is its place in the chain, and its signed `prev` names the version
 *     the pod chains it to. A signed record copied to another pod, or an old version
 *     re-published on top of a newer one, keeps a valid signature but fails this.
 * A record that fails any of these is reported, never used. What no reader can catch on its own
 * is truncation: someone who can write the pod can delete the newest versions, and the chain
 * then ends at an older, correctly placed version. That needs an anchor outside the pod.
 *
 * Every response body is read with a size limit, and a descriptor's graph is fetched only from
 * the descriptor's own container (where every record a bridge writes has it), so one read cannot
 * make the bridge fetch from anywhere else: not another host, and not another pod or path on the
 * same host. A record whose descriptor or graph is over the limit, or for which the pod answers an
 * error status (401, 403, 5xx; for a graph, after the substrate's retries), is a `RecordUnreadable`
 * naming why (the pod answered; anyone who can write it can plant such a file, or a link to a
 * resource this bridge may not read), so a listing counts it with the untrusted records and, when
 * the pod answered an error status, says it is incomplete. Only a request that fails (no answer)
 * and a manifest that cannot be read are a `PodTransportFailed`.
 *
 * What one act reads is bounded as a whole too: every read of an act goes through one `ReadBudget`
 * (`ACT_READ_BUDGET_BYTES`, four times the per-response limit), so a pod writer who plants many
 * large files cannot make one act hold them all. A listing that reaches it stops reading and says it
 * is incomplete; any other read that reaches it is a `ReadBudgetSpent`. A record a listing reads and
 * skips is dropped from the act's read cache at once, so only the records an answer uses are held.
 *
 * Records are written once, so a record read, checked and found trusted where it sits is kept
 * across acts (`VerifiedRecords`, by descriptor URL, for at most `RECORD_CACHE_TTL_MS` and
 * `RECORD_CACHE_MAX_BYTES` in all): an act re-reads the pod's manifest, and only the records it has
 * not seen. Where a record sits (its graph, its pod, its place in the chain) is checked again from
 * the manifest on every read; only its bytes are reused. So a record a pod writer changes in place
 * after it was verified is read again only once its entry expires, and a version whose head says
 * the chain was redacted is always read again, never served from the cache.
 *
 * Encryption at rest: with a record key (`TrustedPlatform.recordKey`), operator-pod records are
 * written with their graph sealed to that key alone, as `<slug>-graph.envelope.jose.json`; the
 * descriptor, its proof and the manifest entry stay readable. A sealed graph is opened with the
 * same key on read, and every check above runs over the opened Turtle. A graph sealed to a key
 * this bridge does not hold is a `RecordSealed` (a `RecordUnreadable`), never an empty record, and
 * a listing counts it apart and calls itself incomplete. An envelope that names this bridge's key
 * but does not open with it (anyone can seal bytes to a public key) is a `RecordUnreadable` saying
 * why: opening happens in this process, so only a failed request is a `PodTransportFailed`.
 * Plaintext records (written before a key was set, and every holder copy) are read as before.
 * A sealed record's descriptor URL ends in its key's fingerprint (the handlers choose the slug), so
 * the manifest alone says which record keys a pod's own records are under: `keyMarksOf`, which
 * reads only the entries of the pod's records container (never a holder copy written to it).
 *
 * Transport: every request goes through the substrate's SSRF guard (`guardedFetchFn`), which
 * re-checks every redirect hop and refuses a redirect on a write. Nothing here retries: the
 * substrate already retries transient failures inside `publish`, `discover` and
 * `fetchGraphContent`, and a retry around a retry multiplies the wait.
 */
import {
  assertSafeFetchTarget, canonicalGraphDigest, canonicalGraphDigestResult, createSignedAuthorship, guardedFetchFn,
  makeWalletDelegationSigner, makeWalletDelegationVerifier, openEncryptedEnvelope, verifySignedAuthorship,
  type AuthorshipProof, type ContextDescriptorData, type EncryptedEnvelope, type EncryptionKeyPair, type FetchFn, type IRI,
  type ManifestEntry, type Wallet,
} from '@interego/core';
import {
  digestedGraphRegion, discover, fetchGraphContent, parseAuthorshipProofFromDescriptorTurtle,
  parseDistributionFromDescriptorTurtle, publish, PublishPreconditionFailedError, PublishShapeViolationError,
} from '@interego/solid';
import { PEV_SHAPES_NS, readShapesTurtle } from '../src/ontology.js';
import {
  fingerprintOfAttemptIri, fingerprintOfRecordUrl, graphIriOf, isWellFormedText, podBase, recordBodyFromGraph, registryIri, RECORD_CLASS,
  type PevRecordBody, type Role, type RoleRegistryBody,
} from '../src/records.js';

export const PEV_RECORDS_CONTAINER = 'pev/records/';
export const PEV_COPIES_CONTAINER = 'pev/holder-copies/';

/**
 * The platform addresses whose record signatures this bridge accepts, lowercase, and the key pair
 * its operator-pod records are sealed to. Without `recordKey` records are written in plaintext,
 * and a sealed record cannot be read.
 */
export interface TrustedPlatform {
  readonly addresses: ReadonlySet<string>;
  readonly recordKey?: EncryptionKeyPair;
}

export interface ReadRecord {
  /** Set when a signed record is not where it was written (another graph, another pod, another place in the chain). */
  readonly misplaced?: string;
  readonly descriptorUrl: string;
  /** The urn id the platform's authorship proof binds (`proof.descriptorId`); '' when there is no proof. */
  readonly recordId: string;
  readonly graphUrl: string;
  readonly body: PevRecordBody;
  /** The named-graph region the proof covers. */
  readonly regionTurtle: string;
  /** `graph-nquads-sha256:<hex>` of the region: what a person's review names as its target. */
  readonly graphDigest: string;
  readonly proof: AuthorshipProof | null;
  /** The exact descriptor bytes served. */
  readonly descriptorTurtle: string;
  /** The graph document (the TriG wrap): the bytes served, or, for a sealed graph, the exact bytes that were sealed. */
  readonly graphContent: string;
  /** True when the pod holds this record's graph only as an envelope sealed to the record key. */
  readonly sealed: boolean;
  readonly authorship: { readonly valid: boolean; readonly contentBinding: string; readonly signerAddress: string | null; readonly platformKnown: boolean };
  readonly modalStatus: string | null;
}

/** A version whose graph was deleted by a redaction; its descriptor and proof remain. */
export interface DeletedVersion {
  readonly descriptorUrl: string; readonly recordId: string | null; readonly graphUrl: string | null;
  /** The descriptor bytes, which still carry the platform proof and its content hash. */
  readonly descriptorTurtle: string;
  readonly contentDeleted: true;
}

/**
 * What one act has read: each record once (in flight or done), each pod's manifest once until it is
 * cleared (`manifests`), and the records kept across acts (`verified`).
 */
export interface ReadCache {
  readonly records: Map<string, Promise<ReadRecord>>;
  /**
   * The manifest entries of each pod this act read, by pod base. Absent: every read goes to the
   * pod. The handlers clear it when an act takes its lock after the same bridge wrote a record
   * meanwhile, so what it reads under the lock includes that write.
   */
  readonly manifests?: Map<string, Promise<ManifestEntry[]>>;
  readonly verified?: VerifiedRecords;
}

/** A read cache for one act. */
export function readCache(verified?: VerifiedRecords): ReadCache {
  return { records: new Map(), manifests: new Map(), ...(verified ? { verified } : {}) };
}

/** How long a verified record is reused before it is read from the pod again. */
export const RECORD_CACHE_TTL_MS = 300_000;
/** The most the verified records kept across acts may hold, by `recordBytes`. */
export const RECORD_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** An estimate of what a read record holds in memory: its texts, at two bytes a character, the region twice (it is also the body). */
export function recordBytes(r: ReadRecord): number {
  return 2 * (r.descriptorTurtle.length + r.graphContent.length + 2 * r.regionTurtle.length);
}

/**
 * Records read, checked and found trusted where they sit, kept across acts by descriptor URL. A
 * record this bridge writes never changes once written, so reusing one saves reading its
 * descriptor and graph again; where it sits is checked again on every read by its caller. An entry
 * is dropped once it is `ttlMs` old (counted from when it was read), and the least recently used
 * are dropped while the entries hold more than `maxBytes`; a record over an eighth of that is not
 * kept. `ttlMs` 0 keeps nothing.
 */
export class VerifiedRecords {
  private readonly byUrl = new Map<string, { readonly rec: ReadRecord; readonly at: number; readonly bytes: number }>();
  private held = 0;
  private readonly clock: () => number;

  constructor(readonly ttlMs: number = RECORD_CACHE_TTL_MS, readonly maxBytes: number = RECORD_CACHE_MAX_BYTES, clock?: () => number) {
    this.clock = clock ?? ((): number => performance.now());
  }

  get(url: string): ReadRecord | undefined {
    const e = this.byUrl.get(url);
    if (!e) return undefined;
    if (this.clock() - e.at >= this.ttlMs) { this.drop(url); return undefined; }
    this.byUrl.delete(url);
    this.byUrl.set(url, e);
    return e.rec;
  }

  keep(rec: ReadRecord): void {
    if (this.ttlMs <= 0 || rec.misplaced !== undefined || this.byUrl.has(rec.descriptorUrl)) return;
    const bytes = recordBytes(rec);
    if (bytes > this.maxBytes / 8) return;
    this.byUrl.set(rec.descriptorUrl, { rec, at: this.clock(), bytes });
    this.held += bytes;
    for (const url of this.byUrl.keys()) {
      if (this.held <= this.maxBytes) break;
      this.drop(url);
    }
  }

  drop(url: string): void {
    const e = this.byUrl.get(url);
    if (!e) return;
    this.byUrl.delete(url);
    this.held -= e.bytes;
  }

  /** How many records are kept, and what they hold by `recordBytes`. */
  get size(): number { return this.byUrl.size; }
  get bytes(): number { return this.held; }
}

/** Keep a record across acts when it is trusted where it was read. */
function keepIfTrusted(cache: ReadCache | undefined, r: ReadRecord): void {
  if (cache?.verified && isTrusted(r)) cache.verified.keep(r);
}

/** Drop a record from the act's read cache: it was read and skipped, so nothing holds its bytes. */
function forget(cache: ReadCache | undefined, url: string): void {
  cache?.records.delete(url);
}

/** The pod could not be read or written. `refusedStatus` is set when the pod answered 401 or 403. */
export class PodTransportFailed extends Error {
  constructor(
    message: string,
    readonly direction: 'read' | 'write',
    readonly refusedStatus: 401 | 403 | null,
    readonly podOrigin: string,
  ) {
    super(message);
    this.name = 'PodTransportFailed';
  }
}

/**
 * A record that cannot be read as a pev record: no distribution, no region, a body whose hash does
 * not match, a response over the read limit, or an error status the pod answered for its
 * descriptor or graph (`status`, the HTTP status, when that is why).
 */
export class RecordUnreadable extends Error {
  constructor(readonly descriptorUrl: string, why: string, readonly status: number | null = null) {
    super(why);
    this.name = 'RecordUnreadable';
  }
}

/** True when the pod answered an error status for the record that leaves what it holds unknown (not a 404 or 410). */
export function unanswered(e: RecordUnreadable): boolean {
  return e.status !== null && e.status !== 404 && e.status !== 410;
}

/**
 * A record whose graph is sealed to a key this bridge does not hold, or sealed while this bridge
 * has no record key. A `RecordUnreadable`, so every reader that skips or refuses an unreadable
 * record does the same with this one: it is never read as an empty record.
 */
export class RecordSealed extends RecordUnreadable {
  constructor(descriptorUrl: string, readonly bridgeHasKey: boolean) {
    super(descriptorUrl, bridgeHasKey
      ? 'its graph is sealed to a record key this bridge does not hold (PEV_RECORD_KEY is not the key that wrote it)'
      : 'its graph is sealed, and this bridge has no record key to open it (PEV_RECORD_KEY)');
    this.name = 'RecordSealed';
  }
}

/**
 * This bridge could not seal a record it built (its graph is not text a UTF-8 encoder keeps as
 * is). Raised in this process before anything is written: never a pod failure.
 */
export class RecordNotSealable extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'RecordNotSealable';
  }
}

/** A version whose graph resource answers 404 (deleted, or never written). */
export class GraphMissing extends Error {
  constructor(readonly descriptorUrl: string, readonly graphUrl: string, readonly recordId: string | null, readonly descriptorTurtle: string) {
    super(`the graph of ${descriptorUrl} is not on the pod`);
    this.name = 'GraphMissing';
  }
}

/** More than one head on one chain: two writers raced from the same head. */
export class ChainForked extends Error {
  constructor(readonly graphIri: string, readonly heads: readonly string[]) {
    super(`${graphIri} has ${heads.length} heads`);
    this.name = 'ChainForked';
  }
}

/** The status a pod refused with, read from a substrate error message (`… -> 401`, `…: 403 …`). */
export function podRefusal(e: unknown): { readonly status: 401 | 403 } | null {
  const m = e instanceof Error ? /(?:->|:)\s*(401|403)\b/.exec(e.message) : null;
  if (!m) return null;
  return { status: m[1] === '401' ? 401 : 403 };
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

function base(fetchFn?: typeof fetch): typeof fetch {
  return fetchFn ?? globalThis.fetch.bind(globalThis);
}

/** The most this bridge reads from any one response: a manifest, a descriptor or a graph. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Statuses whose response cannot carry a body, which a Response cannot be rebuilt with. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * A response over this bridge's read limit, by its declared Content-Length or by the bytes it
 * streamed. The pod answered: anyone who can write it can plant a resource that size, so a record
 * read from one is a `RecordUnreadable` (counted with the untrusted records), never a transport
 * failure that would make every listing over that pod answer 502.
 */
export class ResponseOverLimit extends Error {
  constructor(readonly limit: number, readonly declared: number | null) {
    super(declared !== null
      ? `the response declares ${declared} bytes, over this bridge's limit of ${limit}`
      : `the response is over this bridge's limit of ${limit} bytes`);
    this.name = 'ResponseOverLimit';
  }
}

/** The most one act reads from pods, over every response it reads: four times the per-response limit. */
export const ACT_READ_BUDGET_BYTES = 4 * MAX_RESPONSE_BYTES;

/** One act went past what it may read from pods in all (`ReadBudget`). Raised in this process: never the pod's failure. */
export class ReadBudgetSpent extends Error {
  constructor(readonly limit: number) {
    super(`this act has read its limit of ${limit} bytes from the pod`);
    this.name = 'ReadBudgetSpent';
  }
}

/**
 * What one act may read from pods, over every response together. Each response is capped on its
 * own (`MAX_RESPONSE_BYTES`); this caps their sum, so many large planted files cannot make one act
 * hold them all. Once spent it stays spent, and every further read of the act is refused before it
 * is sent.
 */
export class ReadBudget {
  private used = 0;
  private over = false;
  constructor(readonly limit: number = ACT_READ_BUDGET_BYTES) {}

  /** Count `n` bytes read; false from the first byte past the limit on. */
  charge(n: number): boolean {
    this.used += n;
    if (this.used > this.limit) this.over = true;
    return !this.over;
  }

  get spent(): boolean { return this.over; }
  get bytesRead(): number { return this.used; }
}

/**
 * Read every response body with a byte limit, so a hostile pod cannot make the bridge buffer an
 * unbounded body. A response over the limit is a `ResponseOverLimit`, never a truncated record.
 * With a `budget`, every byte read also counts against the act's budget, and a response that
 * takes it past its limit (or any request once it is spent) is a `ReadBudgetSpent`.
 */
export function cappedFetch(f: typeof fetch, maxBytes = MAX_RESPONSE_BYTES, budget?: ReadBudget): typeof fetch {
  const capped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (budget?.spent) throw new ReadBudgetSpent(budget.limit);
    const res = await f(input, init);
    const declared = Number(res.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new ResponseOverLimit(maxBytes, declared);
    }
    if (!res.body || NULL_BODY.has(res.status) || res.status < 200 || res.status > 599) return res;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      const within = budget ? budget.charge(value.byteLength) : true;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseOverLimit(maxBytes, null);
      }
      if (!within) {
        await reader.cancel().catch(() => undefined);
        throw new ReadBudgetSpent(budget!.limit);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    return new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return capped as typeof fetch;
}

const BUDGETED: unique symbol = Symbol('pev.readBudget');
type Budgeted = typeof fetch & { readonly [BUDGETED]?: { readonly inner: typeof fetch; readonly budget: ReadBudget } };

/**
 * `fetchFn`, with every response read through it here counted against `budget`. Every reader in
 * this module takes it as its fetch; writes are given the plain one.
 */
export function withReadBudget(fetchFn: typeof fetch, budget: ReadBudget): typeof fetch {
  const f = ((input: RequestInfo | URL, init?: RequestInit) => fetchFn(input, init)) as Budgeted;
  Object.defineProperty(f, BUDGETED, { value: { inner: fetchFn, budget } });
  return f;
}

/** The read budget a fetch carries (`withReadBudget`), or null. */
export function budgetOf(fetchFn?: typeof fetch): ReadBudget | null {
  return fetchFn ? ((fetchFn as Budgeted)[BUDGETED]?.budget ?? null) : null;
}

/** A record's descriptor or graph the pod answered with a redirect. */
export class RecordRedirected extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`the pod answered ${status} (a redirect) for ${url}`);
    this.name = 'RecordRedirected';
  }
}

/**
 * Refuses a redirect below the SSRF guard. The guard follows a GET's redirect itself, re-checking each
 * hop only for private addresses, so a same-container link could otherwise be answered from another
 * path or pod on the host, with the operator's credential re-added on a hop under the pod.
 */
function refusingRedirects(f: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await f(input, init);
    if (res.status >= 300 && res.status < 400) {
      throw new RecordRedirected(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, res.status);
    }
    return res;
  }) as typeof fetch;
}

/**
 * The guarded, size-capped fetch, typed as the substrate's FetchFn; budgeted when `fetchFn` carries a
 * budget. With `followRedirects: false` (record reads) a redirect is refused rather than followed.
 */
function guarded(fetchFn?: typeof fetch, opts: { readonly followRedirects?: boolean } = {}): FetchFn {
  const b = fetchFn ? (fetchFn as Budgeted)[BUDGETED] : undefined;
  const inner = b ? cappedFetch(b.inner, MAX_RESPONSE_BYTES, b.budget) : cappedFetch(base(fetchFn));
  return guardedFetchFn(opts.followRedirects === false ? refusingRedirects(inner) : inner) as unknown as FetchFn;
}

/**
 * The operator pod's credential, added to requests to ONE pod only: the URL's parsed origin
 * equals the pod's AND the URL lies under the pod's base path, so a holder pod on the same host
 * never receives it. It goes on reads as well as writes, so an operator can make the pod refuse
 * anonymous reads of `pev/` and the bridge still reads its own records. A decorated request is
 * sent with `redirect: 'manual'`, so the credential cannot follow a redirect anywhere. Mirrors
 * foxxi's gate-write-fetch, tightened to the pod path.
 */
export function operatorPodFetch(podUrl: string | undefined, secret: string | undefined, baseFetch: typeof fetch): typeof fetch {
  if (!podUrl || !secret) return baseFetch;
  let podHref: string;
  let podOrigin: string;
  try {
    const u = new URL(podBase(podUrl));
    podHref = u.href;
    podOrigin = u.origin;
  } catch {
    return baseFetch;
  }
  const decorated = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let mine = false;
    try {
      const u = new URL(url);
      mine = u.origin === podOrigin && u.href.startsWith(podHref);
    } catch { mine = false; }
    if (!mine) return baseFetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${secret}`);
    return baseFetch(input, { ...init, headers, redirect: 'manual' });
  };
  return decorated as typeof fetch;
}

/** The platform's content-bound authorship proof over exactly this graph Turtle. */
export async function signRecordAuthorship(
  wallet: Wallet, platformDid: string, recordId: string, graphTurtle: string, created: string,
): Promise<AuthorshipProof> {
  const d = canonicalGraphDigestResult(graphTurtle);
  if (d.digest === null) throw new Error(`the record graph cannot be digested: ${d.reason}`);
  return createSignedAuthorship({
    agentId: platformDid as IRI, ownerWebId: platformDid as IRI, descriptorId: recordId as IRI, created, contentHash: d.digest,
  }, makeWalletDelegationSigner(wallet));
}

/**
 * Publish one record. The shapes gate runs before any write, on the plaintext; with `supersedes`
 * the publish is a compare-and-set against `currentHeads` unless `ifMatch` is false (holder
 * copies). Records carry no visibility facet.
 *
 * With `sealTo` the graph is sealed to that key pair alone (an X25519 envelope stored as
 * `<slug>-graph.envelope.jose.json`, marked `iep:encrypted true` on the descriptor's distribution)
 * and the pod holds no plaintext of it; the descriptor, its proof and the manifest entry stay
 * readable. Without it the graph is plaintext and who may read it is the pod's own access control.
 * Only operator-pod records are sealed: a holder copy goes to the learner's own pod, and the
 * learner does not hold this bridge's record key.
 *
 * Sealing happens in this process, so a graph that cannot be sealed (text with a lone UTF-16
 * surrogate, which the envelope's UTF-8 encoding refuses) is a `RecordNotSealable` raised before
 * any write, never a `PodTransportFailed`: the pod was not involved.
 */
export async function publishPevRecord(a: {
  readonly podUrl: string; readonly descriptor: ContextDescriptorData; readonly graphTurtle: string; readonly slug: string;
  readonly containerPath?: string; readonly authorshipProof: AuthorshipProof; readonly supersedes?: string;
  readonly currentHeads?: readonly string[]; readonly ifMatch?: boolean; readonly shapes?: boolean; readonly fetchFn?: typeof fetch;
  readonly sealTo?: EncryptionKeyPair;
}): Promise<{ readonly descriptorUrl: string; readonly graphUrl: string }> {
  if (a.sealTo && !isWellFormedText(a.graphTurtle)) {
    throw new RecordNotSealable('the record graph holds text with a lone UTF-16 surrogate, which cannot be encrypted as it is');
  }
  try {
    await assertSafeFetchTarget(a.podUrl);
  } catch {
    throw new PodTransportFailed(`the pod ${a.podUrl} is not a public http(s) address`, 'write', null, originOf(a.podUrl));
  }
  try {
    const r = await publish(a.descriptor, a.graphTurtle, a.podUrl, {
      fetch: guarded(a.fetchFn),
      containerPath: a.containerPath ?? PEV_RECORDS_CONTAINER,
      descriptorSlug: a.slug,
      graphSlug: `${a.slug}-graph`,
      authorshipProof: a.authorshipProof,
      ...(a.shapes === false ? {} : { conformsToShapes: [{ shapeIri: PEV_SHAPES_NS, shapeTurtle: readShapesTurtle() }] }),
      ...(a.supersedes !== undefined && a.ifMatch !== false ? { ifMatchSupersedes: a.supersedes, currentHeads: [...(a.currentHeads ?? [])] } : {}),
      ...(a.sealTo ? { encrypt: { recipients: [a.sealTo.publicKey], senderKeyPair: a.sealTo } } : {}),
    });
    return { descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
  } catch (e) {
    if (e instanceof PublishShapeViolationError || e instanceof PublishPreconditionFailedError) throw e;
    // The envelope's UTF-8 encoding throws URIError on text it cannot encode: a local failure.
    if (e instanceof URIError) throw new RecordNotSealable(`the record could not be encrypted (${e.message.slice(0, 120)})`);
    const refused = podRefusal(e);
    const why = e instanceof Error ? e.message : String(e);
    throw new PodTransportFailed(`writing to ${originOf(a.podUrl)} did not complete: ${why.slice(0, 200)}`, 'write', refused?.status ?? null, originOf(a.podUrl));
  }
}

/** DELETE one resource. A 404 or 410 counts as already gone. */
export async function deleteResource(url: string, fetchFn?: typeof fetch): Promise<'deleted' | 'absent' | { readonly status: number }> {
  try {
    const res = await guarded(fetchFn)(url, { method: 'DELETE' });
    if (res.status >= 200 && res.status < 300) return 'deleted';
    if (res.status === 404 || res.status === 410) return 'absent';
    return { status: res.status };
  } catch {
    return { status: 0 };
  }
}

/**
 * The pod's manifest entries, all or those describing one graph. A manifest that cannot be read is
 * a `PodTransportFailed`; one whose reading took the act past its read budget (the substrate reports
 * an archive segment it could not read, without saying why) is a `ReadBudgetSpent`.
 */
export async function listEntries(podUrl: string, fetchFn?: typeof fetch, graphIri?: string): Promise<ManifestEntry[]> {
  try {
    return await discover(podUrl, graphIri !== undefined ? { graphIri } : {}, { fetch: guarded(fetchFn) });
  } catch (e) {
    if (e instanceof ReadBudgetSpent) throw e;
    const budget = budgetOf(fetchFn);
    if (budget?.spent) throw new ReadBudgetSpent(budget.limit);
    const refused = podRefusal(e);
    const why = e instanceof Error ? e.message : String(e);
    throw new PodTransportFailed(`reading the manifest of ${originOf(podUrl)} did not complete: ${why.slice(0, 200)}`, 'read', refused?.status ?? null, originOf(podUrl));
  }
}

/**
 * Every manifest entry of the pod, read once per act when `cache` keeps manifests (until they are
 * cleared), else read now.
 */
export function podEntries(podUrl: string, fetchFn?: typeof fetch, cache?: ReadCache): Promise<ManifestEntry[]> {
  const memo = cache?.manifests;
  if (!memo) return listEntries(podUrl, fetchFn);
  const key = normalPod(podUrl) ?? podUrl;
  const hit = memo.get(key);
  if (hit) return hit;
  const p = listEntries(podUrl, fetchFn);
  memo.set(key, p);
  p.catch(() => { if (memo.get(key) === p) memo.delete(key); });
  return p;
}

/** The descriptor URLs describing `graphIri` that no other entry supersedes. */
export function headsOf(entries: readonly ManifestEntry[], graphIri: string): string[] {
  const mine = entries.filter((e) => e.describes.includes(graphIri));
  const superseded = new Set(mine.flatMap((e) => e.supersedes ?? []));
  return [...new Set(mine.map((e) => e.descriptorUrl).filter((u) => !superseded.has(u)))].sort();
}

/** A fresh read of the chain's heads, taken immediately before a publish. */
export async function refreshHeads(podUrl: string, graphIri: string, fetchFn?: typeof fetch): Promise<string[]> {
  return headsOf(await listEntries(podUrl, fetchFn, graphIri), graphIri);
}

function modalOf(descriptorTurtle: string): string | null {
  const m = /iep:modalStatus\s+iep:([A-Za-z]+)/.exec(descriptorTurtle)
    ?? /modalStatus>\s+<[^>]*#([A-Za-z]+)>/.exec(descriptorTurtle);
  return m ? (m[1] ?? null) : null;
}

/** True when a record may drive a decision: the proof verifies, binds the served bytes, its signer is trusted, and it sits where it was written. */
export function isTrusted(r: ReadRecord): boolean {
  return r.authorship.valid && r.authorship.contentBinding === 'bound' && r.authorship.platformKnown && r.misplaced === undefined;
}

/** The pod base of a URL, normalised the way the URL parser writes it (host case, default port). */
export function normalPod(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? podBase(u.href) : null;
  } catch {
    return null;
  }
}

/** True when `url` lies under the pod's base path. */
export function underPod(url: string, podUrl: string): boolean {
  const pod = normalPod(podUrl);
  try { return pod !== null && new URL(url).href.startsWith(pod); } catch { return false; }
}

/**
 * True when `url` is a resource directly in the container that holds `descriptorUrl`: where
 * `publish` puts every record's graph beside its descriptor. A descriptor is read only from under
 * its pod, so a graph in its container is under that pod too.
 */
export function inSameContainer(url: string, descriptorUrl: string): boolean {
  try {
    const container = new URL('.', new URL(descriptorUrl)).href;
    const href = new URL(url).href;
    return href.startsWith(container) && href.length > container.length && !href.slice(container.length).includes('/');
  } catch {
    return false;
  }
}

/** Why a signed body does not belong at (pod, graph): another graph, or written for another pod. */
export function placementProblem(body: PevRecordBody, podUrl: string, graphIri: string): string | undefined {
  if (graphIriOf(body) !== graphIri) return 'its signed body describes another graph than the one this pod files it under';
  const written = normalPod(body.podUrl);
  if (written === null || written !== normalPod(podUrl)) return `its signed body was written for the pod ${body.podUrl}, not this one`;
  return undefined;
}

function seqProblem(body: PevRecordBody, versions: number): string | undefined {
  return body.seq === versions ? undefined
    : `its signed body says it is version ${body.seq ?? '(none)'} of its chain, but this pod holds ${versions} version(s)`;
}

function misplace(r: ReadRecord, why: string | undefined): ReadRecord {
  return why === undefined ? r : { ...r, misplaced: why };
}

/**
 * Read one record by its descriptor URL and check it. The graph URL is followed from the
 * descriptor's distribution link, never rebuilt from a file name, and only within the descriptor's
 * own container. A sealed graph is opened with `trusted.recordKey`, and the proof is checked over
 * the opened bytes; one this bridge cannot open is a `RecordSealed`.
 *
 * With a cache, a record kept across acts (`cache.verified`) is reused, and one read earlier in the
 * act is read once. `fresh` reads it from the pod whatever is cached, and drops it from the cache.
 */
export function readRecord(
  descriptorUrl: string, trusted: TrustedPlatform, fetchFn?: typeof fetch, cache?: ReadCache, o: { readonly fresh?: boolean } = {},
): Promise<ReadRecord> {
  if (o.fresh) {
    cache?.verified?.drop(descriptorUrl);
  } else {
    const kept = cache?.verified?.get(descriptorUrl);
    if (kept) return Promise.resolve(kept);
    const hit = cache?.records.get(descriptorUrl);
    if (hit) return hit;
  }
  const pending = readRecordUncached(descriptorUrl, trusted, fetchFn);
  cache?.records.set(descriptorUrl, pending);
  return pending;
}

/**
 * Open a sealed graph with the record key, in this process. Null (the caller's RecordSealed) when
 * this bridge has no key, or the envelope is not sealed to its key: another key wrote it. Anyone
 * can seal bytes to a public key, so an envelope that names this bridge's key and still does not
 * open, or opens to bytes that are not UTF-8 text, or whose fields do not decode, was altered or
 * forged by someone who can write the pod: a RecordUnreadable saying which, never a failure of the
 * pod and never "sealed to another key".
 */
function openSealed(descriptorUrl: string, env: EncryptedEnvelope, key: EncryptionKeyPair | undefined): string | null {
  if (!key) return null;
  const wrapped: unknown = (env as { readonly wrappedKeys?: unknown }).wrappedKeys;
  const named = Array.isArray(wrapped)
    && wrapped.some((w) => typeof w === 'object' && w !== null && (w as { readonly recipientPublicKey?: unknown }).recipientPublicKey === key.publicKey);
  if (!named) return null;
  const cannot = 'its graph envelope names this bridge\'s record key but cannot be opened';
  let text: string | null;
  try {
    text = openEncryptedEnvelope(env, key);
  } catch (e) {
    // tweetnacl-util throws URIError on bytes that are not UTF-8, TypeError on a field that is not base64.
    const why = e instanceof URIError ? 'it opens to bytes that are not UTF-8 text'
      : `a field of it does not decode (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`;
    throw new RecordUnreadable(descriptorUrl, `${cannot}: ${why}`);
  }
  if (text === null) throw new RecordUnreadable(descriptorUrl, `${cannot}: it does not authenticate under that key (altered, or sealed by someone else to this bridge's public key)`);
  return text;
}

/** A record whose descriptor or graph the pod served over this bridge's read limit (`ResponseOverLimit`). */
function overLimit(descriptorUrl: string, what: 'descriptor' | 'graph', e: ResponseOverLimit): RecordUnreadable {
  return new RecordUnreadable(descriptorUrl, `its ${what} is over this bridge's read limit of ${e.limit} bytes${e.declared !== null ? ` (the pod declares ${e.declared})` : ''}, so it is not read`);
}

/**
 * A record whose descriptor or graph the pod answered with an error status: the pod answered, so
 * it is this record that cannot be read, not the pod that cannot be reached. Anyone who can write
 * the pod can plant a record whose graph link answers 401 or 403 (a resource this bridge may not
 * read), so one such record never makes a listing fail.
 */
function answeredWith(descriptorUrl: string, what: 'descriptor' | 'graph', status: number): RecordUnreadable {
  const why = status === 401 || status === 403
    ? ' (this bridge may not read it: if the operator pod refuses this bridge its own records, the operator sets PEV_POD_WRITE_SECRET)'
    : status >= 500 && what === 'graph' ? ', after retries' : '';
  return new RecordUnreadable(descriptorUrl, `the pod answers HTTP ${status} for its ${what}${why}, so it is not read`, status);
}

/** The status in the substrate's `Failed to GET <url>: <status> <text>` for this graph URL, or null. */
function graphStatus(message: string, graphUrl: string): number | null {
  const prefix = `Failed to GET ${graphUrl}: `;
  if (!message.startsWith(prefix)) return null;
  const m = /^(\d{3})\b/.exec(message.slice(prefix.length));
  return m ? Number(m[1]) : null;
}

/** RDF, an envelope, or untyped text: what a descriptor or graph may be served as. */
const READABLE_TYPE = /turtle|trig|n-?triples|n-?quads|\bn3\b|json|text\/plain|octet-stream/i;

/** ` (the pod serves it as <type>)` when a response that could not be read was served as something else, or ''. */
function servedAs(contentType: string | null): string {
  return contentType && !READABLE_TYPE.test(contentType) ? ` (the pod serves it as ${contentType.split(';')[0]!.trim().slice(0, 60)})` : '';
}

async function readRecordUncached(descriptorUrl: string, trusted: TrustedPlatform, fetchFn?: typeof fetch): Promise<ReadRecord> {
  // A record is read at the URL its manifest entry and descriptor name, never where a redirect points.
  const f = guarded(fetchFn, { followRedirects: false });
  const origin = originOf(descriptorUrl);
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await f(descriptorUrl, { method: 'GET', headers: { accept: 'text/turtle' } });
  } catch (e) {
    // The pod answered, with more than this bridge reads: an unreadable record, not a failed request.
    if (e instanceof ResponseOverLimit) throw overLimit(descriptorUrl, 'descriptor', e);
    if (e instanceof RecordRedirected) throw new RecordUnreadable(descriptorUrl, `the pod answered ${e.status} (a redirect) for its descriptor, and a redirect is not followed`, e.status);
    if (e instanceof ReadBudgetSpent) throw e;
    throw new PodTransportFailed(`reading ${descriptorUrl} did not complete: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, 'read', null, origin);
  }
  if (!res.ok) {
    if (res.status === 404 || res.status === 410) throw new RecordUnreadable(descriptorUrl, 'the manifest names a descriptor the pod does not hold', res.status);
    throw answeredWith(descriptorUrl, 'descriptor', res.status);
  }
  const descriptorTurtle = await res.text();
  const proof = parseAuthorshipProofFromDescriptorTurtle(descriptorTurtle);
  const dist = parseDistributionFromDescriptorTurtle(descriptorTurtle);
  if (!dist) throw new RecordUnreadable(descriptorUrl, `the descriptor names no graph distribution${servedAs(res.headers?.get('content-type') ?? null)}`);
  // Never another host, and never another pod or path on this one: where the bridge's credential
  // may reach, or a resource of someone else's it may not read.
  if (!inSameContainer(dist.accessURL, descriptorUrl)) {
    throw new RecordUnreadable(descriptorUrl, 'the descriptor points its graph outside its own container on the pod, so the graph is not read');
  }
  let opened: { readonly content: string | null; readonly encrypted: boolean; readonly mediaType: string };
  try {
    // fetchGraphContent asks for `application/jose+json` first, passes plaintext through, and hands
    // an envelope to openSealed, which opens it here, in this process: whatever goes wrong there
    // is a RecordUnreadable it throws itself. A graph over the read limit (cappedFetch, which the
    // substrate does not retry) or answered with an error status (after the substrate's retries of
    // a 5xx) is the pod's answer; only a request that got no answer is a failed request.
    opened = await fetchGraphContent(dist.accessURL, { fetch: f, openEnvelope: (env) => openSealed(descriptorUrl, env, trusted.recordKey) });
  } catch (e) {
    if (e instanceof RecordUnreadable || e instanceof ReadBudgetSpent) throw e;
    if (e instanceof ResponseOverLimit) throw overLimit(descriptorUrl, 'graph', e);
    if (e instanceof RecordRedirected) throw new RecordUnreadable(descriptorUrl, `the pod answered ${e.status} (a redirect) for its graph, and a redirect is not followed`, e.status);
    const msg = e instanceof Error ? e.message : String(e);
    const status = graphStatus(msg, dist.accessURL);
    if (status === 404 || status === 410) throw new GraphMissing(descriptorUrl, dist.accessURL, proof?.descriptorId ?? null, descriptorTurtle);
    if (status !== null) throw answeredWith(descriptorUrl, 'graph', status);
    throw new PodTransportFailed(`reading ${dist.accessURL} did not complete: ${msg.slice(0, 200)}`, 'read', null, originOf(dist.accessURL));
  }
  if (opened.content === null) throw new RecordSealed(descriptorUrl, trusted.recordKey !== undefined);
  const graphContent = opened.content;
  const region = digestedGraphRegion({ descriptorTurtle, graphContent });
  if (!region.ok) throw new RecordUnreadable(descriptorUrl, `the signed graph region cannot be located (${region.why})${servedAs(opened.mediaType)}`);
  const parsed = recordBodyFromGraph(region.turtle);
  if ('unreadable' in parsed) throw new RecordUnreadable(descriptorUrl, parsed.unreadable);
  const graphDigest = canonicalGraphDigest(region.turtle) ?? '';
  let authorship: ReadRecord['authorship'] = { valid: false, contentBinding: 'unbound', signerAddress: proof?.signerAddress ?? null, platformKnown: false };
  if (proof) {
    const v = await verifySignedAuthorship(proof, makeWalletDelegationVerifier(), graphDigest ? { contentHash: graphDigest } : {});
    authorship = {
      valid: v.valid, contentBinding: v.contentBinding, signerAddress: proof.signerAddress,
      platformKnown: trusted.addresses.has(proof.signerAddress.toLowerCase()),
    };
  }
  return {
    descriptorUrl, recordId: proof?.descriptorId ?? '', graphUrl: dist.accessURL, body: parsed.body,
    regionTurtle: region.turtle, graphDigest, proof, descriptorTurtle, graphContent, sealed: opened.encrypted, authorship,
    modalStatus: modalOf(descriptorTurtle),
  };
}

export interface HeadRead {
  readonly head: ReadRecord | null;
  readonly heads: readonly string[];
  /** The seq the NEXT record on this chain takes: 1 + the entries describing the graph. */
  readonly seq: number;
  readonly entries: readonly ManifestEntry[];
}

/**
 * The single head of a chain (or none). Two heads are a fork, refused as such. The head is read
 * only from under the pod, and is marked `misplaced` unless its signed body names this graph and
 * this pod and its signed seq equals the number of versions the pod holds.
 */
export async function readHead(podUrl: string, graphIri: string, trusted: TrustedPlatform, fetchFn?: typeof fetch, cache?: ReadCache): Promise<HeadRead> {
  const entries = (await podEntries(podUrl, fetchFn, cache)).filter((e) => e.describes.includes(graphIri));
  const heads = headsOf(entries, graphIri);
  const seq = entries.length + 1;
  if (heads.length === 0) return { head: null, heads, seq, entries };
  if (heads.length > 1) throw new ChainForked(graphIri, heads);
  const url = heads[0]!;
  if (!underPod(url, podUrl)) throw new RecordUnreadable(url, 'the pod\'s manifest names a record outside the pod');
  try {
    const rec = await readRecord(url, trusted, fetchFn, cache);
    const head = misplace(rec, placementProblem(rec.body, podUrl, graphIri) ?? seqProblem(rec.body, entries.length));
    keepIfTrusted(cache, head);
    return { head, heads, seq, entries };
  } catch (e) {
    if (e instanceof GraphMissing) throw new RecordUnreadable(e.descriptorUrl, 'the head record\'s graph is not on the pod');
    throw e;
  }
}

/**
 * Every version of a chain, oldest first, by following `supersedes` back from the head. After a
 * redaction the earlier graphs are gone: those versions come back as `contentDeleted` when the
 * chain's trusted head is in state `redacted`. Any other missing graph is a read failure.
 *
 * A version is opened only when the pod's own manifest files it under this chain's graph. The
 * manifest is writable by anyone who can write the pod; a `supersedes` pointing at a record of
 * another graph (another learner's attempt) is refused as unreadable BEFORE that record is
 * fetched, so a forged chain cannot make this bridge open, with its record key, a record the
 * caller is not entitled to. A record opened anyway (a manifest that files one descriptor under
 * two graphs) is marked misplaced by its signed body, and callers use only trusted versions.
 *
 * Under a trusted redacted head every earlier version is read from the pod, never from the records
 * kept across acts: its graph was deleted, and a kept copy would hand back the removed text.
 */
export async function readChain(
  podUrl: string, graphIri: string, trusted: TrustedPlatform, fetchFn?: typeof fetch, cache?: ReadCache,
): Promise<readonly (ReadRecord | DeletedVersion)[]> {
  const { head, entries } = await readHead(podUrl, graphIri, trusted, fetchFn, cache);
  if (!head) return [];
  // readHead's entries are exactly the manifest entries describing this graph.
  const byUrl = new Map(entries.map((e) => [e.descriptorUrl, e]));
  const redactedHead = isTrusted(head) && head.body.kind === 'attempt' && head.body.state === 'redacted';
  const newestFirst: (ReadRecord | DeletedVersion)[] = [head];
  const seen = new Set([head.descriptorUrl]);
  let next = byUrl.get(head.descriptorUrl)?.supersedes?.[0];
  while (next !== undefined && !seen.has(next)) {
    seen.add(next);
    if (!underPod(next, podUrl)) throw new RecordUnreadable(next, 'the pod\'s manifest chains to a record outside the pod');
    if (!byUrl.has(next)) {
      throw new RecordUnreadable(next, 'the pod\'s manifest chains this record to a version it does not file under the same graph; that version is not opened');
    }
    try {
      const rec = await readRecord(next, trusted, fetchFn, cache, { fresh: redactedHead });
      newestFirst.push(misplace(rec, placementProblem(rec.body, podUrl, graphIri)));
    } catch (e) {
      if (e instanceof GraphMissing && redactedHead) {
        newestFirst.push({ descriptorUrl: e.descriptorUrl, recordId: e.recordId, graphUrl: e.graphUrl, descriptorTurtle: e.descriptorTurtle, contentDeleted: true });
      } else if (e instanceof GraphMissing) {
        throw new RecordUnreadable(e.descriptorUrl, 'an earlier version\'s graph is not on the pod');
      } else {
        throw e;
      }
    }
    next = byUrl.get(next)?.supersedes?.[0];
  }
  const chain = linked(newestFirst.reverse());
  if (!redactedHead) for (const v of chain) if (!isDeleted(v)) keepIfTrusted(cache, v);
  return chain;
}

/**
 * Check each version's signed place in the chain against the chain the pod's manifest gives:
 * version i (from 1) says seq i, and names version i − 1 as its prev (the first names none). A
 * version that does not is marked misplaced; a deleted version's own body cannot be checked.
 */
function linked(oldestFirst: readonly (ReadRecord | DeletedVersion)[]): (ReadRecord | DeletedVersion)[] {
  return oldestFirst.map((v, i) => {
    if (isDeleted(v) || v.misplaced !== undefined) return v;
    const before = i > 0 ? oldestFirst[i - 1] : undefined;
    const p = v.body.prev;
    if (v.body.seq !== i + 1) return misplace(v, `its signed body says it is version ${v.body.seq ?? '(none)'} of its chain, but it is version ${i + 1} here`);
    if (before === undefined) return p === undefined ? v : misplace(v, 'its signed body names a predecessor, but it is the first version here');
    const priorId = before.recordId;
    const priorDigest = isDeleted(before) ? null : before.graphDigest;
    if (!p || (priorId !== null && p.recordId !== priorId) || (priorDigest !== null && p.graphDigest !== priorDigest)) {
      return misplace(v, 'its signed predecessor is not the version this pod chains it to');
    }
    return v;
  });
}

export function isDeleted(v: ReadRecord | DeletedVersion): v is DeletedVersion {
  return 'contentDeleted' in v;
}

/**
 * A place in the pod's manifest that names a record key, and that key's fingerprint
 * (`iriKeyFingerprint`): a keyed attempt IRI (`by: 'attempt-iri'`, `at` the IRI), or the descriptor
 * URL of a record sealed to the key (`by: 'sealed-record'`, `at` the URL, whose slug ends in
 * `-k<fingerprint>`). Every record a bridge seals carries one, so a pod on which a record key has
 * written anything says which key from its manifest alone, whether or not an attempt was started.
 */
export interface KeyMark { readonly fingerprint: string; readonly at: string; readonly by: 'attempt-iri' | 'sealed-record' }

const PEV_RECORD_CLASSES = new Set(Object.values(RECORD_CLASS));

/**
 * True when `url` is a descriptor directly in the pod's own records container
 * (`<pod>pev/records/<slug>.ttl`, no deeper path): where every record a bridge writes for the pod it
 * serves goes (`publishPevRecord`'s default container, with a slug that holds no `/`), and where no
 * holder copy goes (they go to `pev/holder-copies/` under the pod the learner names).
 */
export function inRecordsContainer(url: string, podUrl: string): boolean {
  const pod = normalPod(podUrl);
  if (pod === null) return false;
  const container = `${pod}${PEV_RECORDS_CONTAINER}`;
  try {
    const href = new URL(url).href;
    return href.startsWith(container) && !href.slice(container.length).includes('/');
  } catch {
    return false;
  }
}

/**
 * Every key mark in the pod's own records, each place once, in manifest order: only entries whose
 * descriptor is directly in the pod's records container (`inRecordsContainer`) count, and of those
 * a sealed-record mark counts only on an entry filed as a pev record (`dct:conformsTo` a pev record
 * class).
 *
 * Why where the descriptor sits, and not anything else: a holder copy of a keyed attempt (its
 * plaintext versions, describing the keyed IRI) may be written into a pod that another pev bridge
 * serves, when that is the pod a learner names; counted, it would mark that pod with a key its own
 * bridge never held, and stop it, telling it to take another operator's key. The descriptor URL is
 * the one thing the manifest entry itself fixes that tells a pod's own records from such a copy,
 * and it is positive: every record a bridge writes for its pod is directly in the container, and a
 * holder copy never is. The alternatives are weaker. "Not under pev/holder-copies/" is negative: an
 * entry anywhere else, on another pod or off any pod, would still count. "Not derived from another
 * pod" is not in the entry at all: `prov:wasDerivedFrom` is in the copy's descriptor, so it would
 * mean fetching every descriptor before any act, and a pod writer controls those bytes anyway.
 *
 * The manifest is writable by anyone who can write the pod, so a mark can be added (in the
 * container); it can only make a bridge refuse, never write.
 */
export function keyMarksOf(entries: readonly ManifestEntry[], podUrl: string): KeyMark[] {
  const seen = new Set<string>();
  const out: KeyMark[] = [];
  const add = (fingerprint: string | null, at: string, by: KeyMark['by']): void => {
    if (fingerprint === null || seen.has(at)) return;
    seen.add(at);
    out.push({ fingerprint, at, by });
  };
  for (const e of entries) {
    if (!inRecordsContainer(e.descriptorUrl, podUrl)) continue;
    for (const g of e.describes) add(fingerprintOfAttemptIri(g), g, 'attempt-iri');
    if ((e.conformsTo ?? []).some((c) => PEV_RECORD_CLASSES.has(c))) add(fingerprintOfRecordUrl(e.descriptorUrl), e.descriptorUrl, 'sealed-record');
  }
  return out;
}

export interface HeadsOfKind {
  readonly records: readonly ReadRecord[];
  /** Heads that were read and failed the trust rule, or could not be read for any reason but a seal. */
  readonly untrusted: number;
  readonly forked: number;
  /**
   * Heads whose graph is sealed to a record key this bridge does not hold, or sealed while it
   * holds none (`RecordSealed`). Counted apart: a sealed record is one this bridge cannot see, not
   * one that failed a check, so an answer computed without it would read its absence as a fact.
   */
  readonly sealed: number;
  /**
   * Of the untrusted, the heads for which the pod answered an error status (401, 403, 5xx) for the
   * descriptor or the graph: what they hold is unknown, so the read is incomplete.
   */
  readonly unanswered: number;
  /** True when the act's read budget ran out before every head was read (`ReadBudget`). */
  readonly readLimitReached: boolean;
  /**
   * False when the cap or the act's read budget left graphs unread, or any head was sealed or
   * answered with an error status: the records are not all there are.
   */
  readonly complete: boolean;
  /** The key marks of the pod's own records in the manifest this read walked (every kind): see `keyMarksOf`. */
  readonly keyMarks: readonly KeyMark[];
}

/**
 * The trusted heads of every chain of one record kind on a pod, found through the manifest's
 * `dct:conformsTo`. Untrusted, unreadable and forked chains are skipped and counted; sealed heads
 * are skipped and counted apart, and make the read incomplete, as do heads the pod answered with an
 * error status. `beforeReading` sees the key marks of the manifest before any record is read, and
 * may refuse by throwing. A head read and skipped is dropped from the act's read cache at once, so
 * the act holds only the records it returns; once the act's read budget runs out, nothing more is
 * read from the pod (heads kept from earlier acts are still used) and the read is incomplete.
 */
export async function readHeadsOfKind(
  podUrl: string, kind: PevRecordBody['kind'], trusted: TrustedPlatform,
  o: { readonly max: number; readonly fetchFn?: typeof fetch; readonly cache?: ReadCache; readonly beforeReading?: (marks: readonly KeyMark[]) => void },
): Promise<HeadsOfKind> {
  const cls = RECORD_CLASS[kind];
  const all = await podEntries(podUrl, o.fetchFn, o.cache);
  const keyMarks = keyMarksOf(all, podUrl);
  o.beforeReading?.(keyMarks);
  const groups = new Map<string, ManifestEntry[]>();
  for (const e of all) {
    if (!(e.conformsTo ?? []).includes(cls)) continue;
    for (const g of e.describes) {
      const list = groups.get(g);
      if (list) list.push(e); else groups.set(g, [e]);
    }
  }
  const graphs = [...groups.keys()].sort();
  const records: ReadRecord[] = [];
  let untrusted = 0;
  let forked = 0;
  let sealed = 0;
  let unansweredHeads = 0;
  let readLimitReached = false;
  const budget = budgetOf(o.fetchFn);
  for (const g of graphs.slice(0, o.max)) {
    const group = groups.get(g) ?? [];
    const heads = headsOf(group, g);
    if (heads.length !== 1) { forked += 1; continue; }
    const url = heads[0]!;
    if (!underPod(url, podUrl)) { untrusted += 1; continue; }
    // Once the budget is spent, only heads kept from earlier acts are still used: they cost no read.
    if (budget?.spent && o.cache?.verified?.get(url) === undefined) { readLimitReached = true; continue; }
    try {
      const read = await readRecord(url, trusted, o.fetchFn, o.cache);
      const r = misplace(read, placementProblem(read.body, podUrl, g) ?? seqProblem(read.body, group.length));
      if (isTrusted(r) && r.body.kind === kind) {
        records.push(r);
        keepIfTrusted(o.cache, r);
      } else {
        untrusted += 1;
        forget(o.cache, url);
      }
    } catch (e) {
      forget(o.cache, url);
      if (e instanceof ReadBudgetSpent) { readLimitReached = true; continue; }
      if (e instanceof RecordSealed) { sealed += 1; continue; }
      if (e instanceof RecordUnreadable) {
        untrusted += 1;
        if (unanswered(e)) unansweredHeads += 1;
        continue;
      }
      if (e instanceof GraphMissing) { untrusted += 1; continue; }
      throw e;
    }
  }
  return {
    records, untrusted, forked, sealed, unanswered: unansweredHeads, readLimitReached,
    complete: graphs.length <= o.max && sealed === 0 && unansweredHeads === 0 && !readLimitReached, keyMarks,
  };
}

export interface RoleRegistryView {
  readonly registryIri: string;
  readonly head: ReadRecord | null;
  /** False when a registry record exists but fails the trust rule; its roles are then not read. */
  readonly trusted: boolean;
  readonly roles: ReadonlyMap<string, ReadonlySet<Role>>;
}

function rolesMap(body: PevRecordBody | undefined): Map<string, ReadonlySet<Role>> {
  const out = new Map<string, ReadonlySet<Role>>();
  if (!body || body.kind !== 'role-registry') return out;
  for (const e of (body as RoleRegistryBody).entries) out.set(e.address.toLowerCase(), new Set(e.roles));
  return out;
}

/** The pod's current role registry. */
export async function readRoleRegistry(podUrl: string, trusted: TrustedPlatform, fetchFn?: typeof fetch, cache?: ReadCache): Promise<RoleRegistryView> {
  const iri = registryIri(podUrl);
  const { head } = await readHead(podUrl, iri, trusted, fetchFn, cache);
  if (!head) return { registryIri: iri, head: null, trusted: true, roles: new Map() };
  const ok = isTrusted(head) && head.body.kind === 'role-registry';
  return { registryIri: iri, head, trusted: ok, roles: ok ? rolesMap(head.body) : new Map() };
}

/**
 * The registry as it stood at `at`: the latest trusted version whose `at` is not after it.
 * Untrusted versions are skipped, so they can neither grant nor remove a role.
 */
export async function readRoleRegistryAt(podUrl: string, at: string, trusted: TrustedPlatform, fetchFn?: typeof fetch, cache?: ReadCache): Promise<RoleRegistryView> {
  const iri = registryIri(podUrl);
  const chain = await readChain(podUrl, iri, trusted, fetchFn, cache);
  const t = Date.parse(at);
  let pick: ReadRecord | null = null;
  for (const v of chain) {
    if (isDeleted(v) || !isTrusted(v) || v.body.kind !== 'role-registry') continue;
    if (Date.parse(v.body.at) <= t) pick = v;
  }
  return { registryIri: iri, head: pick, trusted: true, roles: rolesMap(pick?.body) };
}

/**
 * An in-process mutex per key (one graph). Each handler set makes its own, so two handler sets
 * behave like two processes: what keeps them apart is the fresh head read before each publish
 * and the publish's own compare-and-set.
 */
export function createGraphLocks(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => gate);
    tails.set(key, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
