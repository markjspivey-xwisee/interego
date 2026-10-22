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
 * the descriptor's own host, so one read cannot make the bridge fetch from anywhere else.
 *
 * Encryption at rest: with a record key (`TrustedPlatform.recordKey`), operator-pod records are
 * written with their graph sealed to that key alone, as `<slug>-graph.envelope.jose.json`; the
 * descriptor, its proof and the manifest entry stay readable. A sealed graph is opened with the
 * same key on read, and every check above runs over the opened Turtle. A graph sealed to a key
 * this bridge does not hold is a `RecordUnreadable`, never an empty record. Plaintext records
 * (written before a key was set, and every holder copy) are read as before.
 *
 * Transport: every request goes through the substrate's SSRF guard (`guardedFetchFn`), which
 * re-checks every redirect hop and refuses a redirect on a write. Nothing here retries: the
 * substrate already retries transient failures inside `publish`, `discover` and
 * `fetchGraphContent`, and a retry around a retry multiplies the wait.
 */
import {
  assertSafeFetchTarget, canonicalGraphDigest, canonicalGraphDigestResult, createSignedAuthorship, guardedFetchFn,
  makeWalletDelegationSigner, makeWalletDelegationVerifier, verifySignedAuthorship,
  type AuthorshipProof, type ContextDescriptorData, type EncryptionKeyPair, type FetchFn, type IRI, type ManifestEntry, type Wallet,
} from '@interego/core';
import {
  digestedGraphRegion, discover, fetchGraphContent, parseAuthorshipProofFromDescriptorTurtle,
  parseDistributionFromDescriptorTurtle, publish, PublishPreconditionFailedError, PublishShapeViolationError,
} from '@interego/solid';
import { PEV_SHAPES_NS, readShapesTurtle } from '../src/ontology.js';
import {
  graphIriOf, isWellFormedText, podBase, recordBodyFromGraph, registryIri, RECORD_CLASS,
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

export type ReadCache = Map<string, Promise<ReadRecord>>;

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

/** A record that cannot be read as a pev record: no distribution, no region, or a body whose hash does not match. */
export class RecordUnreadable extends Error {
  constructor(readonly descriptorUrl: string, why: string) {
    super(why);
    this.name = 'RecordUnreadable';
  }
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
 * Read every response body with a byte limit, so a hostile pod cannot make the bridge buffer an
 * unbounded body. A response over the limit is an error, never a truncated record.
 */
export function cappedFetch(f: typeof fetch, maxBytes = MAX_RESPONSE_BYTES): typeof fetch {
  const capped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await f(input, init);
    const declared = Number(res.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`the response declares ${declared} bytes, over this bridge's limit of ${maxBytes}`);
    }
    if (!res.body || NULL_BODY.has(res.status) || res.status < 200 || res.status > 599) return res;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`the response is over this bridge's limit of ${maxBytes} bytes`);
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

/** The guarded, size-capped fetch, typed as the substrate's FetchFn. */
function guarded(fetchFn?: typeof fetch): FetchFn {
  return guardedFetchFn(cappedFetch(base(fetchFn))) as unknown as FetchFn;
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

/** The pod's manifest entries, all or those describing one graph. */
export async function listEntries(podUrl: string, fetchFn?: typeof fetch, graphIri?: string): Promise<ManifestEntry[]> {
  try {
    return await discover(podUrl, graphIri !== undefined ? { graphIri } : {}, { fetch: guarded(fetchFn) });
  } catch (e) {
    const refused = podRefusal(e);
    const why = e instanceof Error ? e.message : String(e);
    throw new PodTransportFailed(`reading the manifest of ${originOf(podUrl)} did not complete: ${why.slice(0, 200)}`, 'read', refused?.status ?? null, originOf(podUrl));
  }
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
 * descriptor's distribution link, never rebuilt from a file name. A sealed graph is opened with
 * `trusted.recordKey`, and the proof is checked over the opened bytes; one this bridge cannot open
 * is a `RecordSealed`.
 */
export function readRecord(descriptorUrl: string, trusted: TrustedPlatform, fetchFn?: typeof fetch, cache?: ReadCache): Promise<ReadRecord> {
  const hit = cache?.get(descriptorUrl);
  if (hit) return hit;
  const pending = readRecordUncached(descriptorUrl, trusted, fetchFn);
  cache?.set(descriptorUrl, pending);
  return pending;
}

async function readRecordUncached(descriptorUrl: string, trusted: TrustedPlatform, fetchFn?: typeof fetch): Promise<ReadRecord> {
  const f = guarded(fetchFn);
  const origin = originOf(descriptorUrl);
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await f(descriptorUrl, { method: 'GET', headers: { accept: 'text/turtle' } });
  } catch (e) {
    throw new PodTransportFailed(`reading ${descriptorUrl} did not complete: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, 'read', null, origin);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new PodTransportFailed(`descriptor GET ${descriptorUrl} -> ${res.status}`, 'read', res.status, origin);
    }
    if (res.status === 404) throw new RecordUnreadable(descriptorUrl, 'the manifest names a descriptor the pod does not hold');
    throw new PodTransportFailed(`descriptor GET ${descriptorUrl} -> ${res.status}`, 'read', null, origin);
  }
  const descriptorTurtle = await res.text();
  const proof = parseAuthorshipProofFromDescriptorTurtle(descriptorTurtle);
  const dist = parseDistributionFromDescriptorTurtle(descriptorTurtle);
  if (!dist) throw new RecordUnreadable(descriptorUrl, 'the descriptor names no graph distribution');
  if (originOf(dist.accessURL) !== origin) throw new RecordUnreadable(descriptorUrl, 'the descriptor points its graph at another host');
  let opened: { readonly content: string | null; readonly encrypted: boolean };
  try {
    // fetchGraphContent asks for `application/jose+json` first, opens an envelope with the record
    // key (null when that key is not a recipient, or there is none), and passes plaintext through.
    opened = await fetchGraphContent(dist.accessURL, { fetch: f, ...(trusted.recordKey ? { recipientKeyPair: trusted.recordKey } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/:\s*(404|410)\b/.test(msg)) throw new GraphMissing(descriptorUrl, dist.accessURL, proof?.descriptorId ?? null, descriptorTurtle);
    const refused = podRefusal(e);
    throw new PodTransportFailed(`reading ${dist.accessURL} did not complete: ${msg.slice(0, 200)}`, 'read', refused?.status ?? null, originOf(dist.accessURL));
  }
  if (opened.content === null) throw new RecordSealed(descriptorUrl, trusted.recordKey !== undefined);
  const graphContent = opened.content;
  const region = digestedGraphRegion({ descriptorTurtle, graphContent });
  if (!region.ok) throw new RecordUnreadable(descriptorUrl, `the signed graph region cannot be located (${region.why})`);
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
  const entries = (await listEntries(podUrl, fetchFn, graphIri)).filter((e) => e.describes.includes(graphIri));
  const heads = headsOf(entries, graphIri);
  const seq = entries.length + 1;
  if (heads.length === 0) return { head: null, heads, seq, entries };
  if (heads.length > 1) throw new ChainForked(graphIri, heads);
  const url = heads[0]!;
  if (!underPod(url, podUrl)) throw new RecordUnreadable(url, 'the pod\'s manifest names a record outside the pod');
  try {
    const rec = await readRecord(url, trusted, fetchFn, cache);
    return { head: misplace(rec, placementProblem(rec.body, podUrl, graphIri) ?? seqProblem(rec.body, entries.length)), heads, seq, entries };
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
      const rec = await readRecord(next, trusted, fetchFn, cache);
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
  return linked(newestFirst.reverse());
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
 * The trusted heads of every chain of one record kind on a pod, found through the manifest's
 * `dct:conformsTo`. Untrusted, unreadable and forked chains are skipped and counted.
 */
export async function readHeadsOfKind(
  podUrl: string, kind: PevRecordBody['kind'], trusted: TrustedPlatform,
  o: { readonly max: number; readonly fetchFn?: typeof fetch; readonly cache?: ReadCache },
): Promise<{ readonly records: readonly ReadRecord[]; readonly untrusted: number; readonly forked: number; readonly complete: boolean }> {
  const cls = RECORD_CLASS[kind];
  const all = await listEntries(podUrl, o.fetchFn);
  const groups = new Map<string, ManifestEntry[]>();
  for (const e of all) {
    if (!(e.conformsTo ?? []).includes(cls)) continue;
    for (const g of e.describes) {
      const list = groups.get(g);
      if (list) list.push(e); else groups.set(g, [e]);
    }
  }
  const graphs = [...groups.keys()].sort();
  const complete = graphs.length <= o.max;
  const records: ReadRecord[] = [];
  let untrusted = 0;
  let forked = 0;
  for (const g of graphs.slice(0, o.max)) {
    const group = groups.get(g) ?? [];
    const heads = headsOf(group, g);
    if (heads.length !== 1) { forked += 1; continue; }
    if (!underPod(heads[0]!, podUrl)) { untrusted += 1; continue; }
    try {
      const read = await readRecord(heads[0]!, trusted, o.fetchFn, o.cache);
      const r = misplace(read, placementProblem(read.body, podUrl, g) ?? seqProblem(read.body, group.length));
      if (isTrusted(r) && r.body.kind === kind) records.push(r); else untrusted += 1;
    } catch (e) {
      if (e instanceof RecordUnreadable || e instanceof GraphMissing) { untrusted += 1; continue; }
      throw e;
    }
  }
  return { records, untrusted, forked, complete };
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
