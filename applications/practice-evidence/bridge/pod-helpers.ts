/**
 * The pod side of every pev act: publish a record, read one back and check its signature, find
 * the head of a chain, walk a chain, read the role registry (now, or as it stood at an instant),
 * delete a graph, and the one fetch that may carry the operator's pod credential.
 *
 * What a record must pass before any decision rests on it (§5.3, the TRUST RULE):
 *   · its body comes from the `pev:recordJson` literal, and the literal's sha256 matches;
 *   · its platform authorship proof verifies AND binds the exact graph region served
 *     (`contentBinding: 'bound'`);
 *   · the proof's signer is one of the trusted platform addresses.
 * A record that fails any of these is reported, never used.
 *
 * Transport: every request goes through the substrate's SSRF guard (`guardedFetchFn`), which
 * re-checks every redirect hop and refuses a redirect on a write. Nothing here retries: the
 * substrate already retries transient failures inside `publish`, `discover` and
 * `fetchGraphContent`, and a retry around a retry multiplies the wait.
 */
import {
  assertSafeFetchTarget, canonicalGraphDigest, canonicalGraphDigestResult, createSignedAuthorship, guardedFetchFn,
  makeWalletDelegationSigner, makeWalletDelegationVerifier, verifySignedAuthorship,
  type AuthorshipProof, type ContextDescriptorData, type FetchFn, type IRI, type ManifestEntry, type Wallet,
} from '@interego/core';
import {
  digestedGraphRegion, discover, fetchGraphContent, parseAuthorshipProofFromDescriptorTurtle,
  parseDistributionFromDescriptorTurtle, publish, PublishPreconditionFailedError, PublishShapeViolationError,
} from '@interego/solid';
import { PEV_SHAPES_NS, readShapesTurtle } from '../src/ontology.js';
import {
  podBase, recordBodyFromGraph, registryIri, RECORD_CLASS,
  type PevRecordBody, type Role, type RoleRegistryBody,
} from '../src/records.js';

export const PEV_RECORDS_CONTAINER = 'pev/records/';
export const PEV_COPIES_CONTAINER = 'pev/holder-copies/';

/** The platform addresses whose record signatures this bridge accepts, lowercase. */
export interface TrustedPlatform { readonly addresses: ReadonlySet<string> }

export interface ReadRecord {
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
  /** The exact bytes served. */
  readonly descriptorTurtle: string;
  readonly graphContent: string;
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

/** The guarded fetch, typed as the substrate's FetchFn. */
function guarded(fetchFn?: typeof fetch): FetchFn {
  return guardedFetchFn(base(fetchFn)) as unknown as FetchFn;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The operator pod's write credential, added to WRITES to ONE pod only: the method is POST, PUT,
 * PATCH or DELETE, the URL's parsed origin equals the pod's, AND the URL lies under the pod's
 * base path — so a holder pod on the same host never receives it. Reads never carry it. A
 * decorated request is sent with `redirect: 'manual'`, so the credential cannot follow a
 * redirect anywhere. Mirrors foxxi's gate-write-fetch, tightened to the pod path.
 */
export function operatorWriteFetch(podUrl: string | undefined, writeSecret: string | undefined, baseFetch: typeof fetch): typeof fetch {
  if (!podUrl || !writeSecret) return baseFetch;
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
    const method = String(init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    let mine = false;
    if (WRITE_METHODS.has(method)) {
      try {
        const u = new URL(url);
        mine = u.origin === podOrigin && u.href.startsWith(podHref);
      } catch { mine = false; }
    }
    if (!mine) return baseFetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${writeSecret}`);
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
 * Publish one record. The shapes gate runs before any write; with `supersedes` the publish is a
 * compare-and-set against `currentHeads` unless `ifMatch` is false (holder copies). Records are
 * plaintext with no visibility facet: who may read them is the pod's own access control.
 */
export async function publishPevRecord(a: {
  readonly podUrl: string; readonly descriptor: ContextDescriptorData; readonly graphTurtle: string; readonly slug: string;
  readonly containerPath?: string; readonly authorshipProof: AuthorshipProof; readonly supersedes?: string;
  readonly currentHeads?: readonly string[]; readonly ifMatch?: boolean; readonly shapes?: boolean; readonly fetchFn?: typeof fetch;
}): Promise<{ readonly descriptorUrl: string; readonly graphUrl: string }> {
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
    });
    return { descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
  } catch (e) {
    if (e instanceof PublishShapeViolationError || e instanceof PublishPreconditionFailedError) throw e;
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

/** True when a record may drive a decision: the proof verifies, binds the served bytes, and its signer is trusted. */
export function isTrusted(r: ReadRecord): boolean {
  return r.authorship.valid && r.authorship.contentBinding === 'bound' && r.authorship.platformKnown;
}

/**
 * Read one record by its descriptor URL and check it. The graph URL is followed from the
 * descriptor's distribution link, never rebuilt from a file name.
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
  let graphContent: string | null;
  try {
    graphContent = (await fetchGraphContent(dist.accessURL, { fetch: f })).content;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/:\s*(404|410)\b/.test(msg)) throw new GraphMissing(descriptorUrl, dist.accessURL, proof?.descriptorId ?? null, descriptorTurtle);
    const refused = podRefusal(e);
    throw new PodTransportFailed(`reading ${dist.accessURL} did not complete: ${msg.slice(0, 200)}`, 'read', refused?.status ?? null, originOf(dist.accessURL));
  }
  if (graphContent === null) throw new RecordUnreadable(descriptorUrl, 'the graph is encrypted; pev records are plaintext');
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
    regionTurtle: region.turtle, graphDigest, proof, descriptorTurtle, graphContent, authorship,
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

/** The single head of a chain (or none). Two heads are a fork, refused as such. */
export async function readHead(podUrl: string, graphIri: string, trusted: TrustedPlatform, fetchFn?: typeof fetch, cache?: ReadCache): Promise<HeadRead> {
  const entries = (await listEntries(podUrl, fetchFn, graphIri)).filter((e) => e.describes.includes(graphIri));
  const heads = headsOf(entries, graphIri);
  const seq = entries.length + 1;
  if (heads.length === 0) return { head: null, heads, seq, entries };
  if (heads.length > 1) throw new ChainForked(graphIri, heads);
  try {
    return { head: await readRecord(heads[0]!, trusted, fetchFn, cache), heads, seq, entries };
  } catch (e) {
    if (e instanceof GraphMissing) throw new RecordUnreadable(e.descriptorUrl, 'the head record\'s graph is not on the pod');
    throw e;
  }
}

/**
 * Every version of a chain, oldest first, by following `supersedes` back from the head. After a
 * redaction the earlier graphs are gone: those versions come back as `contentDeleted` when the
 * chain's trusted head is in state `redacted`. Any other missing graph is a read failure.
 */
export async function readChain(
  podUrl: string, graphIri: string, trusted: TrustedPlatform, fetchFn?: typeof fetch, cache?: ReadCache,
): Promise<readonly (ReadRecord | DeletedVersion)[]> {
  const { head, entries } = await readHead(podUrl, graphIri, trusted, fetchFn, cache);
  if (!head) return [];
  const byUrl = new Map(entries.map((e) => [e.descriptorUrl, e]));
  const redactedHead = isTrusted(head) && head.body.kind === 'attempt' && head.body.state === 'redacted';
  const newestFirst: (ReadRecord | DeletedVersion)[] = [head];
  const seen = new Set([head.descriptorUrl]);
  let next = byUrl.get(head.descriptorUrl)?.supersedes?.[0];
  while (next !== undefined && !seen.has(next)) {
    seen.add(next);
    try {
      newestFirst.push(await readRecord(next, trusted, fetchFn, cache));
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
  return newestFirst.reverse();
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
    const heads = headsOf(groups.get(g) ?? [], g);
    if (heads.length !== 1) { forked += 1; continue; }
    try {
      const r = await readRecord(heads[0]!, trusted, o.fetchFn, o.cache);
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
