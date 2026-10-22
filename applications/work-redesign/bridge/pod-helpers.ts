/**
 * The work-redesign bridge's pod layer: open a pod behind the SSRF guard, walk its manifest,
 * decide which version of each graph is current, read records back with their platform
 * authorship proof verified against the bytes actually served, publish new versions through a
 * compare-and-swap on a freshly read head, and copy records to a pod their holder names.
 *
 * ── HEAD ELIGIBILITY (normative) ─────────────────────────────────────────────────────────────
 * A descriptor counts toward a graph's heads only if it sits in `<pod>/wrd/records/`, carries
 * an authorship proof whose signature verifies, was signed by a platform key this bridge
 * trusts, and sits at exactly the URL its own proof's descriptorId predicts. Anything else — a
 * holder copy, a descriptor someone appended without a trusted proof, a genuine descriptor
 * replayed to another URL — is set aside with a reason and never becomes current. A head that
 * IS eligible but whose graph bytes no longer match the signed digest, or whose descriptor's
 * modal status no longer matches the status its signed payload records, is "altered": every
 * lifecycle call on that graph refuses (409) rather than act on it.
 *
 * What this cannot stop, and says so in the README: a party with write access to the pod can
 * delete files, or overwrite a genuine descriptor's unsigned facets in place. v1 relies on the
 * pod's own access control for that.
 *
 * ── SEALED GRAPHS ────────────────────────────────────────────────────────────────────────────
 * Given the bridge's record key, every new version's graph is sealed to it (publish's encrypt
 * option; stored as `<slug>-graph.envelope.jose.json`), and a sealed graph is opened with it on
 * read. Descriptors and the manifest stay plaintext: signer, kind, modal status and times remain
 * public. The authorship proof covers the plaintext graph, so the checks above run on the opened
 * bytes unchanged. A sealed graph that does not open — sealed to another key, no key held, or
 * ciphertext changed on the pod — is never read as an empty or valid record: a descriptor that is
 * otherwise eligible stays eligible and untrusted (so its graph answers "altered", 409, and an
 * older version never silently becomes current again), and one that is not is set aside.
 *
 * ── WHAT THE MANIFEST SAYS IS ONLY A HINT ─────────────────────────────────────────────────────
 * Which descriptors describe a graph, and which version supersedes which, are read from the
 * manifest, which anyone able to write the pod can edit. So a version counts toward a graph, and
 * a supersedes link is followed, only when the record's signed content names that graph: a link
 * someone added from one chain into another never puts another entity's record (opened with the
 * record key) into this graph's heads or its history.
 *
 * No environment reads. The only network is the injected fetch, always behind guardedFetchFn.
 */
import {
  assertSafeFetchTarget, guardedFetchFn, canonicalGraphDigest, canonicalGraphDigestResult, createSignedAuthorship,
  makeWalletDelegationSigner, makeWalletDelegationVerifier, verifySignedAuthorship, sha256Hex, openEncryptedEnvelope,
  type AuthorshipProof, type EncryptedEnvelope, type EncryptionKeyPair, type FetchFn, type IRI, type ManifestEntry, type Wallet,
} from '@interego/core';
import {
  publish, fetchAllManifestEntries, predictManifestUrl, predictDescriptorUrl, parseAuthorshipProofFromDescriptorTurtle,
  parseDistributionFromDescriptorTurtle, digestedGraphRegion, PublishShapeViolationError, PublishPreconditionFailedError,
} from '@interego/solid';
import { WRD_NS, WRD_SHAPES_NS, readShapesTurtle } from '../src/ontology.js';
import {
  buildDescriptor, buildGraphTurtle, parseRecordGraph, slugOf, h16, normalisePodUrl, graphIriOf, isWellFormedText,
  type DescriptorSpec, type ModalChoice, type RecordKind, type WrdRecord,
} from '../src/records.js';

export { normalisePodUrl };

export const WRD_CONTAINER = 'wrd/records/';
export const HOLDER_CONTAINER = 'wrd/held/';

export interface PlatformSigner { readonly wallet: Wallet; readonly keyKind: 'configured' | 'ephemeral' | 'demo' }

// ── Errors the handlers map to statuses ──────────────────────────────────────────────────

/** The manifest could not be read in full: nothing is written and no lifecycle answer is given (502). */
export class IncompleteManifestError extends Error {
  constructor(readonly podUrl: string) { super(`the manifest of ${podUrl} could not be read in full`); }
}
/** The head the caller read is no longer the head, or the graph already exists (409). */
export class StaleHeadError extends Error {
  constructor(readonly graphIri: string, readonly heads: readonly string[]) {
    super(`${graphIri}: the current version is ${heads.length === 0 ? 'absent' : heads.join(', ')}, not the version this write was based on`);
  }
}
/** The pod refused or failed a write (502, with the pod's status when it gave one). */
export class PodWriteError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}
/** The pod failed a read that was needed (502). A 404 is not this: it is an absent resource. */
export class PodReadError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}
/**
 * This bridge could not seal a record it built: its graph holds text a UTF-8 encoder cannot keep
 * as it is (a lone UTF-16 surrogate). Raised in this process before anything is written, so it is
 * the bridge's failure (500), never the pod's.
 */
export class RecordNotSealableError extends Error {
  constructor(message: string) { super(message); this.name = 'RecordNotSealableError'; }
}

const statusIn = (message: string): number | null => {
  const m = /\b([45]\d\d)\b/.exec(message);
  return m && m[1] ? Number(m[1]) : null;
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Pod access ───────────────────────────────────────────────────────────────────────────

/** Screen the pod URL with the SSRF guard, then hand back a fetch that re-checks every hop. */
export async function openPod(podUrl: string, fetchFn?: FetchFn): Promise<FetchFn> {
  await assertSafeFetchTarget(podUrl);
  const base: FetchFn = fetchFn ?? (globalThis.fetch.bind(globalThis) as unknown as FetchFn);
  return guardedFetchFn(base);
}

/**
 * The operator pod's credential, added to requests to ONE pod only: the URL's parsed origin
 * equals the pod's AND the URL lies under the pod's base path, so a holder pod on the same host
 * never receives it. It goes on reads as well as writes, so an operator can make the pod refuse
 * anonymous reads of `wrd/` and the bridge still reads its own records.
 *
 * Redirects: a decorated request is sent with `redirect: 'manual'`, so the fetch itself never
 * carries the credential to a Location. The SSRF guard in front of this re-issues a GET's (or
 * HEAD's) redirect hop itself, through this same function, which decides again for the new URL:
 * a hop that stays under the pod's path and origin carries the credential again, and a hop
 * anywhere else goes without it. A redirected write is not followed at all. So the credential is
 * never sent outside the operator pod's path, redirect or not. Copied from practice-evidence's
 * operatorPodFetch: verticals do not import each other.
 */
export function operatorPodFetch(podUrl: string | undefined, secret: string | undefined, baseFetch: typeof fetch): typeof fetch {
  if (!podUrl || !secret) return baseFetch;
  let podHref: string;
  let podOrigin: string;
  try {
    const u = new URL(normalisePodUrl(podUrl));
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

export interface ManifestWalk {
  /** wrd entries in `<pod>/wrd/records/`: the only ones that can be current. */
  readonly entries: readonly ManifestEntry[];
  /** wrd-conforming entries anywhere else on the pod: never current, listed as untrusted. */
  readonly foreign: readonly ManifestEntry[];
  readonly complete: boolean;
}

export async function walkManifest(podUrl: string, fetchFn: FetchFn): Promise<ManifestWalk> {
  let walked: Awaited<ReturnType<typeof fetchAllManifestEntries>>;
  try {
    walked = await fetchAllManifestEntries(predictManifestUrl(podUrl), fetchFn);
  } catch {
    return { entries: [], foreign: [], complete: false };
  }
  const container = `${podUrl}${WRD_CONTAINER}`;
  const ours = walked.entries.filter((e) => (e.conformsTo ?? []).some((c) => c.startsWith(WRD_NS)));
  return {
    entries: ours.filter((e) => e.descriptorUrl.startsWith(container)),
    foreign: ours.filter((e) => !e.descriptorUrl.startsWith(container)),
    complete: walked.complete,
  };
}

/** Entries describing a graph whose IRI starts with any of the prefixes. */
export function selectByScope(entries: readonly ManifestEntry[], prefixes: readonly string[]): ManifestEntry[] {
  return entries.filter((e) => e.describes.some((g) => prefixes.some((p) => g.startsWith(p))));
}

// ── Reading a record back ────────────────────────────────────────────────────────────────

/** The modal status each (kind, status) is published with; a descriptor that disagrees with its signed payload is altered. */
const MODAL_OF: { readonly [K in RecordKind]: Readonly<Record<string, ModalChoice>> } = {
  RoleRegistry: { registered: 'Asserted' },
  Workflow: { captured: 'Hypothetical' },
  Task: { captured: 'Hypothetical', ratified: 'Asserted', disputed: 'Hypothetical', retired: 'Retracted' },
  Classification: { classified: 'Hypothetical', ratified: 'Asserted', disputed: 'Hypothetical' },
  Plan: { proposed: 'Hypothetical' },
  Valuation: { valued: 'Hypothetical' },
  Decision: { submitted: 'Hypothetical', countersigned: 'Asserted', declined: 'Counterfactual', measured: 'Asserted' },
  Acknowledgement: { acknowledged: 'Asserted', objected: 'Asserted' },
  AgentRun: { 'acted-under-grant': 'Hypothetical', reviewed: 'Asserted' },
  Grant: { granted: 'Asserted', revoked: 'Retracted' },
  HolderCopy: { copied: 'Asserted', exported: 'Asserted' },
};

export function modalFor(kind: RecordKind, status: string): ModalChoice {
  const m = MODAL_OF[kind][status];
  if (m === undefined) throw new Error(`${kind} has no status ${status}`);
  return m;
}

export interface Authorship {
  readonly signatureValid: boolean;
  readonly signerAddress: string | null;
  /** signatureValid ∧ the signer is a platform key this bridge trusts. */
  readonly signedByTrustedKey: boolean;
  /** The descriptor's URL is the one its own proof's descriptorId predicts, and the descriptor names that id. */
  readonly atPredictedUrl: boolean;
  /** 'bound' | 'mismatched' | 'declared' | 'unbound' (from verifySignedAuthorship). */
  readonly contentBinding: string;
  /** The descriptor's modal status is the one the signed payload's status maps to. */
  readonly modalMatches: boolean;
  readonly eligible: boolean;
  readonly trusted: boolean;
  readonly proof: AuthorshipProof | null;
}

export interface LoadedRecord {
  readonly descriptorUrl: string;
  readonly recordId: string;
  readonly graphIri: string;
  readonly modalStatus: string | undefined;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly generatedAt: string | null;
  readonly confidence: number | null;
  readonly supersedes: readonly string[];
  readonly descriptorTurtle: string;
  /** The graph document as served (TriG), or as opened when the pod holds it sealed. */
  readonly graphContent: string;
  /** The digested region: the named graph the proof covers. */
  readonly graphTurtle: string;
  /** canonicalGraphDigest of the region, 'graph-nquads-sha256:<hex>' ('' when it did not parse). */
  readonly graphDigest: string;
  readonly record: WrdRecord | null;
  readonly authorship: Authorship;
  /** Why the record is not trusted, in plain words; null when it is. */
  readonly why: string | null;
}

interface Verified { readonly signatureValid: boolean; readonly contentBinding: string }
export type VerifyCache = Map<string, Verified>;
const VERIFY_CACHE_LIMIT = 20_000;

const firstMatch = (re: RegExp, text: string): string | null => {
  const m = re.exec(text);
  return m && m[1] !== undefined ? m[1] : null;
};

function unreadable(entry: ManifestEntry, why: string): LoadedRecord {
  return {
    descriptorUrl: entry.descriptorUrl, recordId: '', graphIri: entry.describes[0] ?? '', modalStatus: entry.modalStatus,
    validFrom: null, validUntil: null, generatedAt: null, confidence: null, supersedes: entry.supersedes ?? [],
    descriptorTurtle: '', graphContent: '', graphTurtle: '', graphDigest: '', record: null,
    authorship: {
      signatureValid: false, signerAddress: null, signedByTrustedKey: false, atPredictedUrl: false, contentBinding: 'unbound',
      modalMatches: false, eligible: false, trusted: false, proof: null,
    },
    why,
  };
}

async function getText(url: string, fetchFn: FetchFn, accept: string): Promise<{ readonly status: number; readonly body: string | null }> {
  let res;
  try {
    res = await fetchFn(url, { method: 'GET', headers: { accept } });
  } catch (e) {
    throw new PodReadError(`GET ${url} failed: ${messageOf(e)}`, null);
  }
  if (res.status === 404 || res.status === 410) return { status: res.status, body: null };
  if (!res.ok) throw new PodReadError(`GET ${url} answered ${res.status} ${res.statusText}`, res.status);
  return { status: res.status, body: await res.text() };
}

/** What a descriptor and its graph document say on their own, before any pod or URL is consulted. */
interface BytesRead {
  readonly graphIri: string;
  readonly graphTurtle: string;
  readonly graphDigest: string;
  readonly proof: AuthorshipProof | null;
  readonly subjectId: string | null;
  readonly verified: Verified;
  readonly record: WrdRecord | null;
  readonly modalStatus: string | undefined;
  readonly modalMatches: boolean;
}

/**
 * Verify a descriptor and its graph document from their bytes alone: the region of the graph
 * document the proof covers is digested; the platform authorship proof is verified against that
 * digest; and when it answers 'mismatched' it is verified once more without an observed hash,
 * to learn whether the signature itself is intact. Verification results are cached by the sha256
 * of the bytes, so a re-read of unchanged bytes costs no signature check, and a changed byte
 * cannot reuse an old verdict. readRecord adds what only a pod can answer (where the record sits);
 * verifyHolderBundle uses this as it is.
 */
async function readBytes(descriptorTurtle: string, graphContent: string, fallbackModal: string | undefined, cache?: VerifyCache):
  Promise<{ readonly ok: true; readonly read: BytesRead } | { readonly ok: false; readonly why: string }> {
  const region = digestedGraphRegion({ descriptorTurtle, graphContent });
  if (!region.ok) return { ok: false, why: `the signed region of the graph could not be identified (${region.why})` };
  const graphDigest = canonicalGraphDigest(region.turtle) ?? '';
  const proof = parseAuthorshipProofFromDescriptorTurtle(descriptorTurtle);
  const subjectId = firstMatch(/^<([^>]+)>\s*\n\s*a iep:ContextDescriptor/m, descriptorTurtle);

  let verified: Verified = { signatureValid: false, contentBinding: 'unbound' };
  if (proof) {
    const key = sha256Hex(`${descriptorTurtle}\u0000${graphContent}`);
    const hit = cache?.get(key);
    if (hit) {
      verified = hit;
    } else {
      const verifier = makeWalletDelegationVerifier();
      const first = await verifySignedAuthorship(proof, verifier, graphDigest ? { contentHash: graphDigest } : undefined);
      let signatureValid = first.valid;
      if (first.contentBinding === 'mismatched') signatureValid = (await verifySignedAuthorship(proof, verifier)).valid;
      verified = { signatureValid, contentBinding: first.contentBinding };
      if (cache) {
        if (cache.size >= VERIFY_CACHE_LIMIT) cache.clear();
        cache.set(key, verified);
      }
    }
  }
  const record = parseRecordGraph(region.turtle);
  const modalStatus = firstMatch(/iep:modalStatus\s+iep:(\w+)/, descriptorTurtle) ?? fallbackModal;
  let modalMatches = false;
  if (record) {
    try { modalMatches = modalFor(record.recordKind, record.status) === modalStatus; } catch { modalMatches = false; }
  }
  return { ok: true, read: { graphIri: region.graphIri, graphTurtle: region.turtle, graphDigest, proof, subjectId, verified, record, modalStatus, modalMatches } };
}

/** Why bytes that verified as far as they go are still not trusted, in the order the checks apply; null when they are. */
function distrust(r: BytesRead, signedByTrustedKey: boolean, atPredictedUrl: boolean | null, untrustedKey: string): string | null {
  return !r.proof ? 'it carries no authorship proof'
    : !r.verified.signatureValid ? 'its authorship signature does not verify'
      : !signedByTrustedKey ? untrustedKey
        : atPredictedUrl === false ? 'it is not at the URL its own proof names'
          : r.verified.contentBinding !== 'bound' ? 'its graph was altered after signing: the bytes no longer match the signed digest'
            : r.record === null ? 'its graph is not a well-formed wrd record'
              : !r.modalMatches ? 'its descriptor was altered after signing: the modal status no longer matches the signed status'
                : null;
}

/** Why a sealed graph that did not open is not read; the record stays untrusted. */
export const SEALED_NO_KEY = 'its graph is sealed, and this bridge holds no record key (WRD_RECORD_KEY) to open it';
export const SEALED_OTHER_KEY = 'its graph is sealed to a key this bridge does not hold, or the sealed bytes were changed on the pod (check WRD_RECORD_KEY)';
/** A version whose sealed graph this bridge could not open: never read as absent, negative or empty. */
export const isSealedShut = (l: { readonly why: string | null } | undefined): boolean => l !== undefined && (l.why === SEALED_NO_KEY || l.why === SEALED_OTHER_KEY);

/**
 * Open a sealed graph document with the record key: the plaintext, or null when it is not an
 * envelope, has no wrapped key for this key pair, or does not authenticate. Never throws, and
 * never hands back the sealed bytes as if they were the graph.
 */
export function openSealedGraph(body: string, key: EncryptionKeyPair): string | null {
  let env: unknown;
  try { env = JSON.parse(body); } catch { return null; }
  if (typeof env !== 'object' || env === null) return null;
  const e = env as Partial<EncryptedEnvelope>;
  if (e.algorithm !== 'X25519-XSalsa20-Poly1305' || !Array.isArray(e.wrappedKeys) || typeof e.content !== 'object' || e.content === null) return null;
  try {
    const plain = openEncryptedEnvelope(e as EncryptedEnvelope, key);
    return typeof plain === 'string' ? plain : null;
  } catch {
    return null;
  }
}

/**
 * Where a record sits and who signed it, from its descriptor alone: what readRecord decides for
 * every record, and all it can decide for one whose sealed graph did not open.
 */
function placement(entry: ManifestEntry, podUrl: string, container: string, proof: AuthorshipProof | null, subjectId: string | null,
  signatureValid: boolean, trusted: ReadonlySet<string>): { readonly signerAddress: string | null; readonly signedByTrustedKey: boolean; readonly atPredictedUrl: boolean } {
  const signerAddress = proof ? proof.signerAddress.toLowerCase() : null;
  const signedByTrustedKey = signatureValid && signerAddress !== null && trusted.has(signerAddress);
  const atPredictedUrl = proof !== null && subjectId === proof.descriptorId
    && entry.descriptorUrl === predictDescriptorUrl(podUrl, proof.descriptorId, { containerPath: container, descriptorSlug: slugOf(proof.descriptorId) });
  return { signerAddress, signedByTrustedKey, atPredictedUrl };
}

/**
 * A record whose sealed graph did not open. Its descriptor's proof is still checked (the
 * signature, with no content to bind), so a version a trusted platform key signed at its
 * predicted URL stays ELIGIBLE but is never trusted: its graph answers "altered" (409) instead
 * of the previous version becoming current again, which a party able to write the pod could
 * otherwise cause by corrupting one ciphertext. Anything less than that is set aside, as ever.
 */
async function sealedShut(entry: ManifestEntry, podUrl: string, descriptorTurtle: string, trusted: ReadonlySet<string>,
  container: string, why: string, cache?: VerifyCache): Promise<LoadedRecord> {
  const proof = parseAuthorshipProofFromDescriptorTurtle(descriptorTurtle);
  const subjectId = firstMatch(/^<([^>]+)>\s*\n\s*a iep:ContextDescriptor/m, descriptorTurtle);
  let verified: Verified = { signatureValid: false, contentBinding: 'unbound' };
  if (proof) {
    const key = sha256Hex(`sealed\u0000${descriptorTurtle}`);
    const hit = cache?.get(key);
    if (hit) {
      verified = hit;
    } else {
      const v = await verifySignedAuthorship(proof, makeWalletDelegationVerifier());
      verified = { signatureValid: v.valid, contentBinding: v.contentBinding };
      if (cache) {
        if (cache.size >= VERIFY_CACHE_LIMIT) cache.clear();
        cache.set(key, verified);
      }
    }
  }
  const { signerAddress, signedByTrustedKey, atPredictedUrl } = placement(entry, podUrl, container, proof, subjectId, verified.signatureValid, trusted);
  const eligible = signedByTrustedKey && atPredictedUrl;
  const reason = !proof ? 'it carries no authorship proof'
    : !verified.signatureValid ? 'its authorship signature does not verify'
      : !signedByTrustedKey ? 'it was signed by a key this bridge does not trust'
        : !atPredictedUrl ? 'it is not at the URL its own proof names'
          : why;
  return {
    ...unreadable(entry, reason),
    recordId: proof?.descriptorId ?? subjectId ?? '',
    // The graph this descriptor itself names, not the manifest's word for it (see ofGraph).
    graphIri: firstMatch(/iep:describes\s+<([^>]+)>/, descriptorTurtle) ?? '',
    modalStatus: firstMatch(/iep:modalStatus\s+iep:(\w+)/, descriptorTurtle) ?? entry.modalStatus,
    validFrom: firstMatch(/iep:validFrom\s+"([^"]+)"/, descriptorTurtle),
    validUntil: firstMatch(/iep:validUntil\s+"([^"]+)"/, descriptorTurtle),
    generatedAt: firstMatch(/prov:generatedAtTime\s+"([^"]+)"/, descriptorTurtle),
    descriptorTurtle,
    authorship: {
      signatureValid: verified.signatureValid, signerAddress, signedByTrustedKey, atPredictedUrl, contentBinding: verified.contentBinding,
      modalMatches: false, eligible, trusted: false, proof,
    },
  };
}

/**
 * Read one record from a pod and verify it: the descriptor and the graph are fetched (a sealed
 * graph opened with `recordKey`), their bytes verified (readBytes), and the record is placed: it
 * must sit at exactly the URL its own proof's descriptorId predicts, and be signed by a platform
 * key this bridge trusts. A sealed graph that does not open is handled by sealedShut.
 */
export async function readRecord(entry: ManifestEntry, podUrl: string, fetchFn: FetchFn, trusted: ReadonlySet<string>,
  cache?: VerifyCache, container: string = WRD_CONTAINER, recordKey?: EncryptionKeyPair): Promise<LoadedRecord> {
  const desc = await getText(entry.descriptorUrl, fetchFn, 'text/turtle');
  if (desc.body === null) return unreadable(entry, `the descriptor is not at its manifest URL (${desc.status})`);
  const descriptorTurtle = desc.body;
  const dist = parseDistributionFromDescriptorTurtle(descriptorTurtle);
  if (!dist) return unreadable(entry, 'the descriptor links no graph');
  if (!dist.accessURL.startsWith(podUrl)) return unreadable(entry, 'the descriptor links a graph outside this pod');
  let graphContent: string;
  if (dist.encrypted) {
    const sealed = await getText(dist.accessURL, fetchFn, 'application/jose+json');
    if (sealed.body === null) return unreadable(entry, `the graph is not at the URL its descriptor names (${sealed.status})`);
    const opened = recordKey ? openSealedGraph(sealed.body, recordKey) : null;
    if (opened === null) return sealedShut(entry, podUrl, descriptorTurtle, trusted, container, recordKey ? SEALED_OTHER_KEY : SEALED_NO_KEY, cache);
    graphContent = opened;
  } else {
    const graph = await getText(dist.accessURL, fetchFn, 'application/trig, text/turtle');
    if (graph.body === null) return unreadable(entry, `the graph is not at the URL its descriptor names (${graph.status})`);
    graphContent = graph.body;
  }
  const bytes = await readBytes(descriptorTurtle, graphContent, entry.modalStatus, cache);
  if (!bytes.ok) return unreadable(entry, bytes.why);
  const r = bytes.read;
  const { proof, verified } = r;
  const { signerAddress, signedByTrustedKey, atPredictedUrl } = placement(entry, podUrl, container, proof, r.subjectId, verified.signatureValid, trusted);
  const eligible = signedByTrustedKey && atPredictedUrl;
  const isTrusted = eligible && verified.contentBinding === 'bound' && r.record !== null && r.modalMatches;
  const why = distrust(r, signedByTrustedKey, atPredictedUrl, 'it was signed by a key this bridge does not trust');
  const confidenceText = firstMatch(/iep:epistemicConfidence\s+"([^"]+)"/, descriptorTurtle);
  const confidence = confidenceText === null ? null : Number(confidenceText);
  return {
    descriptorUrl: entry.descriptorUrl,
    recordId: proof?.descriptorId ?? r.subjectId ?? '',
    graphIri: r.graphIri,
    modalStatus: r.modalStatus,
    validFrom: firstMatch(/iep:validFrom\s+"([^"]+)"/, descriptorTurtle),
    validUntil: firstMatch(/iep:validUntil\s+"([^"]+)"/, descriptorTurtle),
    generatedAt: firstMatch(/prov:generatedAtTime\s+"([^"]+)"/, descriptorTurtle),
    confidence: confidence !== null && Number.isFinite(confidence) ? confidence : null,
    supersedes: entry.supersedes ?? [],
    descriptorTurtle, graphContent, graphTurtle: r.graphTurtle, graphDigest: r.graphDigest, record: r.record,
    authorship: {
      signatureValid: verified.signatureValid, signerAddress, signedByTrustedKey, atPredictedUrl,
      contentBinding: verified.contentBinding, modalMatches: r.modalMatches, eligible, trusted: isTrusted, proof,
    },
    why,
  };
}

// ── A holder's downloaded bundle, verified offline ───────────────────────────────────────

/** One record's verdict in a holder bundle. */
export interface BundleVerdict {
  readonly descriptorUrl: string;
  readonly recordKind: string | null;
  readonly entityIri: string | null;
  readonly status: string | null;
  readonly signerAddress: string | null;
  /** The proof verifies, binds these graph bytes, was made by an expected platform key, and the descriptor's modal status matches the signed status. */
  readonly verified: boolean;
  readonly why: string | null;
}

/**
 * Verify a bundle that wrd.holder_copy returned for download — the whole response or its
 * `bundle` array — with no pod and no bridge: each record's platform proof must verify, bind
 * the graph bytes in the bundle, and come from one of `expectedPlatform`, the platform addresses
 * the holder expects (wrd.list_records reports the bridge's as bridge.platform.address, and the
 * bridge prints it at startup). Where a record
 * sat is not checked: a download has no URL to check against. Nothing here trusts the bundle's
 * own claims about who signed it.
 */
export async function verifyHolderBundle(bundle: unknown, expectedPlatform: readonly string[]):
  Promise<{ readonly ok: boolean; readonly records: readonly BundleVerdict[]; readonly why: string | null }> {
  const items = Array.isArray(bundle) ? bundle
    : typeof bundle === 'object' && bundle !== null && Array.isArray((bundle as { bundle?: unknown }).bundle) ? (bundle as { bundle: unknown[] }).bundle : null;
  if (items === null) return { ok: false, records: [], why: 'not a holder bundle: expected the wrd.holder_copy response or its bundle array' };
  if (items.length === 0) return { ok: false, records: [], why: 'the bundle holds no record' };
  const expected = new Set(expectedPlatform.map((a) => a.toLowerCase()));
  if (expected.size === 0) return { ok: false, records: [], why: 'name the platform address you expect: a bundle verified against no key proves nothing' };
  const records: BundleVerdict[] = [];
  for (const item of items) {
    const o = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const descriptorUrl = typeof o['descriptorUrl'] === 'string' ? o['descriptorUrl'] : '';
    const descriptorTurtle = typeof o['descriptorTurtle'] === 'string' ? o['descriptorTurtle'] : null;
    const graphTrig = typeof o['graphTrig'] === 'string' ? o['graphTrig'] : null;
    if (descriptorTurtle === null || graphTrig === null) {
      records.push({ descriptorUrl, recordKind: null, entityIri: null, status: null, signerAddress: null, verified: false, why: 'the entry lacks descriptorTurtle or graphTrig' });
      continue;
    }
    const bytes = await readBytes(descriptorTurtle, graphTrig, undefined);
    if (!bytes.ok) {
      records.push({ descriptorUrl, recordKind: null, entityIri: null, status: null, signerAddress: null, verified: false, why: bytes.why });
      continue;
    }
    const r = bytes.read;
    const signerAddress = r.proof ? r.proof.signerAddress.toLowerCase() : null;
    const byExpected = r.verified.signatureValid && signerAddress !== null && expected.has(signerAddress);
    const why = distrust(r, byExpected, null, `it was signed by ${signerAddress ?? 'no key'}, not by an expected platform address`);
    records.push({
      descriptorUrl, recordKind: r.record?.recordKind ?? null, entityIri: r.record?.entityIri ?? null, status: r.record?.status ?? null,
      signerAddress, verified: why === null, why,
    });
  }
  const bad = records.filter((v) => !v.verified).length;
  return { ok: bad === 0, records, why: bad === 0 ? null : `${bad} of ${records.length} record(s) do not verify` };
}

// ── Heads ────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a record read for `graphIri` is a version of that graph. A record that opened is judged
 * by its signed content: the named graph its proof covers, and the entity that graph is about. A
 * sealed record that did not open is judged by its own descriptor, and stays untrusted anyway.
 * The manifest's `describes` is never enough: the pod's writers can edit it.
 */
export function ofGraph(l: LoadedRecord, graphIri: string): boolean {
  if (l.graphIri !== graphIri) return false;
  return l.record === null || graphIriOf(l.record.entityIri) === graphIri;
}

export interface GraphHeads {
  readonly graphIri: string;
  /** Eligible heads (after setting ineligible ones aside). */
  readonly heads: readonly LoadedRecord[];
  /** The entries still in play: every entry describing the graph, minus those set aside. */
  readonly chain: readonly ManifestEntry[];
  readonly state: 'absent' | 'ok' | 'forked' | 'altered';
  /** Descriptors set aside, with why. */
  readonly untrusted: ReadonlyArray<{ readonly descriptorUrl: string; readonly why: string }>;
}

/**
 * Lazy eligibility: compute heads over the entries; read each head; set aside any that is not
 * eligible (with its supersede links) and recompute; repeat until every head read is eligible.
 * More than one eligible head is a fork; one whose bytes or modal status changed after
 * signing is altered.
 */
export async function headsFor(graphIri: string, entries: readonly ManifestEntry[],
  read: (e: ManifestEntry) => Promise<LoadedRecord>): Promise<GraphHeads> {
  let candidates = entries.filter((e) => e.describes.includes(graphIri));
  const untrusted: { descriptorUrl: string; why: string }[] = [];
  for (;;) {
    const superseded = new Set(candidates.flatMap((e) => e.supersedes ?? []));
    const headEntries = candidates.filter((e) => !superseded.has(e.descriptorUrl));
    const loaded = await Promise.all(headEntries.map(read));
    const bad = loaded.filter((l) => !l.authorship.eligible || !ofGraph(l, graphIri));
    if (bad.length === 0) {
      const only = loaded[0];
      const state = loaded.length === 0 ? 'absent' : loaded.length > 1 ? 'forked' : only && only.authorship.trusted ? 'ok' : 'altered';
      return { graphIri, heads: loaded, chain: candidates, state, untrusted };
    }
    for (const b of bad) {
      untrusted.push({
        descriptorUrl: b.descriptorUrl,
        why: !b.authorship.eligible ? b.why ?? 'not eligible' : `it is a version of ${b.graphIri || 'another graph'}, not of ${graphIri}, although the manifest lists it under ${graphIri}`,
      });
    }
    const dropped = new Set(bad.map((b) => b.descriptorUrl));
    candidates = candidates.filter((e) => !dropped.has(e.descriptorUrl));
  }
}

/**
 * One call's view of a pod: the manifest is walked once, each descriptor read at most once,
 * and each graph's heads computed at most once. `strict` views (every write and lifecycle
 * load) refuse an incomplete manifest; the read affordances use a lenient view and report
 * `complete: false` instead.
 */
export class PodView {
  private walkP: Promise<ManifestWalk> | null = null;
  private readonly reads = new Map<string, Promise<LoadedRecord>>();
  private readonly graphs = new Map<string, Promise<GraphHeads>>();
  constructor(readonly podUrl: string, readonly fetchFn: FetchFn, readonly trusted: ReadonlySet<string>,
    private readonly cache: VerifyCache, readonly strict: boolean, private readonly recordKey?: EncryptionKeyPair) {}

  walk(): Promise<ManifestWalk> {
    this.walkP ??= walkManifest(this.podUrl, this.fetchFn);
    return this.walkP;
  }

  async entries(): Promise<readonly ManifestEntry[]> {
    const w = await this.walk();
    if (!w.complete && this.strict) throw new IncompleteManifestError(this.podUrl);
    return w.entries;
  }

  read(e: ManifestEntry): Promise<LoadedRecord> {
    let p = this.reads.get(e.descriptorUrl);
    if (!p) {
      p = readRecord(e, this.podUrl, this.fetchFn, this.trusted, this.cache, WRD_CONTAINER, this.recordKey);
      this.reads.set(e.descriptorUrl, p);
    }
    return p;
  }

  graph(graphIri: string): Promise<GraphHeads> {
    let p = this.graphs.get(graphIri);
    if (!p) {
      p = this.entries().then((entries) => headsFor(graphIri, entries, (e) => this.read(e)));
      this.graphs.set(graphIri, p);
    }
    return p;
  }

  /** Every graph IRI on the pod whose IRI starts with the prefix (in the wrd container). */
  async graphIris(prefix: string): Promise<string[]> {
    const out = new Set<string>();
    for (const e of await this.entries()) for (const g of e.describes) if (g.startsWith(prefix)) out.add(g);
    return [...out].sort();
  }

  /**
   * The trusted versions of a graph's current line, oldest first: from a trusted single head,
   * back along supersedes links. A link is followed only to a trusted version of THIS graph (see
   * ofGraph): one added to the manifest from this chain into another entity's, which the bridge
   * could open, is passed over, so no caller reads another entity's record through this chain.
   * The line stops at the first version that is not trusted.
   */
  async history(g: GraphHeads): Promise<LoadedRecord[]> {
    const head = g.heads[0];
    if (g.heads.length !== 1 || !head || !head.authorship.trusted || !ofGraph(head, g.graphIri)) return [];
    const byUrl = new Map(g.chain.map((e) => [e.descriptorUrl, e]));
    const out: LoadedRecord[] = [head];
    const seen = new Set([head.descriptorUrl]);
    let cursor: LoadedRecord = head;
    for (;;) {
      let prev: LoadedRecord | null = null;
      for (const u of cursor.supersedes) {
        const entry = byUrl.get(u);
        if (!entry || seen.has(u)) continue;
        seen.add(u);
        const loaded = await this.read(entry);
        if (loaded.authorship.trusted && ofGraph(loaded, g.graphIri)) { prev = loaded; break; }
      }
      if (!prev) break;
      out.push(prev);
      cursor = prev;
    }
    return out.reverse();
  }
}

// ── Publishing ───────────────────────────────────────────────────────────────────────────

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export interface PublishSpec {
  readonly descriptor: DescriptorSpec;
  readonly record: WrdRecord;
  /** The descriptorUrl of the head the caller read, or null for a new graph. */
  readonly expectHead: string | null;
}
export interface PublishContext {
  readonly podUrl: string;
  readonly fetchFn: FetchFn;
  readonly platform: PlatformSigner;
  readonly trusted: ReadonlySet<string>;
  readonly mutex: KeyedMutex;
  readonly cache?: VerifyCache;
  /** The bridge's record key: the new version's graph is sealed to it, and the current heads are opened with it. Absent → plaintext. */
  readonly recordKey?: EncryptionKeyPair;
}
export interface PublishedRecord { readonly descriptorUrl: string; readonly graphUrl: string; readonly recordId: string; readonly graphDigest: string }

let shapesCache: string | null = null;
const shapes = (): string => { shapesCache ??= readShapesTurtle(); return shapesCache; };

/**
 * Publish one record version. The graph is built and digested, the descriptor built and
 * validated, and the platform's content-bound authorship proof signed — then, under this
 * graph's lock, the manifest is walked AFRESH and the write goes ahead only if the graph's
 * current eligible head is exactly the one the caller read (or there is none, for a new graph).
 *
 * The fresh read is mandatory: publish()'s `currentHeads` check compares against the heads the
 * CALLER passes, and passing a stale head after another write had superseded it was measured to
 * be accepted, forking the chain. The slug comes from the record id, which carries the
 * envelope's nonce, so no two write attempts share a URL and a partial write can never leave
 * one attempt's graph under another attempt's proof.
 *
 * With a record key the graph is sealed to it before it leaves the process: the pod stores only
 * `<slug>-graph.envelope.jose.json`. The shapes and the proof are checked over the plaintext.
 * Sealing happens here, so a graph that cannot be sealed (a lone UTF-16 surrogate, which the
 * envelope's UTF-8 encoding refuses) is a RecordNotSealableError raised before any write, never a
 * PodWriteError: the pod was not involved.
 */
export async function publishRecord(spec: PublishSpec, ctx: PublishContext): Promise<PublishedRecord> {
  const { recordId, graphIri } = spec.descriptor;
  if ((spec.descriptor.supersedes ?? null) !== spec.expectHead) throw new Error(`publishRecord: ${recordId} supersedes a different head than it expects`);
  const graphTurtle = buildGraphTurtle(spec.record);
  if (ctx.recordKey && !isWellFormedText(graphTurtle)) {
    throw new RecordNotSealableError(`the graph of ${recordId} holds text with a lone UTF-16 surrogate, which cannot be sealed as it is; nothing was written`);
  }
  const digest = canonicalGraphDigestResult(graphTurtle);
  if (digest.digest === null) throw new Error(`publishRecord: the graph of ${recordId} does not parse (${digest.reason ?? 'no reason given'})`);
  const contentHash = digest.digest;
  const descriptor = buildDescriptor(spec.descriptor);
  const platformDid = spec.descriptor.platformDid as IRI;
  const proof = await createSignedAuthorship(
    { agentId: platformDid, ownerWebId: platformDid, descriptorId: recordId as IRI, created: spec.descriptor.now, contentHash },
    makeWalletDelegationSigner(ctx.platform.wallet),
  );
  const slug = slugOf(recordId);
  return ctx.mutex.run(`${ctx.podUrl}|${graphIri}`, async () => {
    const walk = await walkManifest(ctx.podUrl, ctx.fetchFn);
    if (!walk.complete) throw new IncompleteManifestError(ctx.podUrl);
    const current = await headsFor(graphIri, walk.entries, (e) => readRecord(e, ctx.podUrl, ctx.fetchFn, ctx.trusted, ctx.cache, WRD_CONTAINER, ctx.recordKey));
    const heads = current.heads.map((h) => h.descriptorUrl);
    if (spec.expectHead === null) {
      if (heads.length > 0) throw new StaleHeadError(graphIri, heads);
    } else if (current.state !== 'ok' || heads[0] !== spec.expectHead) {
      throw new StaleHeadError(graphIri, heads);
    }
    try {
      const r = await publish(descriptor, graphTurtle, ctx.podUrl, {
        fetch: ctx.fetchFn,
        containerPath: WRD_CONTAINER,
        descriptorSlug: slug,
        graphSlug: `${slug}-graph`,
        authorshipProof: proof,
        conformsToShapes: [{ shapeIri: WRD_SHAPES_NS, shapeTurtle: shapes() }],
        ...(spec.expectHead ? { ifMatchSupersedes: spec.expectHead, currentHeads: [spec.expectHead] } : {}),
        ...(ctx.recordKey ? { encrypt: { recipients: [ctx.recordKey.publicKey], senderKeyPair: ctx.recordKey } } : {}),
      });
      return { descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl, recordId, graphDigest: contentHash };
    } catch (e) {
      if (e instanceof PublishShapeViolationError) throw e;
      if (e instanceof PublishPreconditionFailedError) throw new StaleHeadError(graphIri, e.actual.descriptorUrl ? [e.actual.descriptorUrl] : heads);
      // The envelope's UTF-8 encoding throws URIError on text it cannot encode: a failure in this process, not the pod's.
      if (e instanceof URIError) throw new RecordNotSealableError(`the graph of ${recordId} could not be sealed (${messageOf(e).slice(0, 120)}); nothing was written`);
      const message = messageOf(e);
      throw new PodWriteError(`the pod did not accept ${recordId}: ${message}`, statusIn(message));
    }
  });
}

/**
 * Copy one eligible record version to a pod its holder names: the same record id and graph,
 * the original modal status and validity window, derived from the original, superseding the
 * holder-pod copy of the previous version (so the holder's pod shows one chain), and carrying
 * the ORIGINAL platform authorship proof — which binds the id and the content digest, so it
 * still verifies 'bound' on the holder's pod. Idempotent: a copy already at its predicted URL
 * is skipped. The copy is plaintext even when the original is sealed: it goes to a pod the
 * holder names, through a fetch that never carries the operator's credential, and encrypted
 * copies are out of scope.
 */
export async function copyRecordToHolder(rec: LoadedRecord, opts: {
  readonly targetPodUrl: string; readonly fetchFn: FetchFn; readonly previousCopyUrl: string | null; readonly existing: ReadonlySet<string>;
}): Promise<{ readonly descriptorUrl: string; readonly skipped: boolean }> {
  const record = rec.record;
  const proof = rec.authorship.proof;
  if (!record || !proof || !rec.authorship.trusted) throw new Error(`copyRecordToHolder: ${rec.descriptorUrl} is not a trusted record`);
  const slug = `held-${h16(rec.descriptorUrl)}`;
  const predicted = predictDescriptorUrl(opts.targetPodUrl, rec.recordId, { containerPath: HOLDER_CONTAINER, descriptorSlug: slug });
  if (opts.existing.has(predicted)) return { descriptorUrl: predicted, skipped: true };
  const modal = rec.modalStatus as ModalChoice;
  const validFrom = rec.validFrom ?? rec.generatedAt ?? '';
  const descriptor = buildDescriptor({
    recordId: rec.recordId,
    graphIri: rec.graphIri,
    recordKind: record.recordKind,
    now: rec.generatedAt ?? validFrom,
    validFrom,
    ...(modal === 'Retracted' && rec.validUntil ? { validUntil: rec.validUntil } : {}),
    modal,
    ...(rec.confidence !== null && (modal === 'Hypothetical' || modal === 'Asserted') ? { confidence: rec.confidence } : {}),
    ...(opts.previousCopyUrl ? { supersedes: opts.previousCopyUrl } : {}),
    platformDid: record.platform.did,
    signers: record.signers.map((s) => ({ did: s.did, softwareAgent: s.softwareAgent, role: s.facetRole })),
    derivedFrom: [rec.descriptorUrl],
  });
  try {
    const r = await publish(descriptor, rec.graphTurtle, opts.targetPodUrl, {
      fetch: opts.fetchFn, containerPath: HOLDER_CONTAINER, descriptorSlug: slug, graphSlug: `${slug}-graph`, authorshipProof: proof,
    });
    return { descriptorUrl: r.descriptorUrl, skipped: false };
  } catch (e) {
    const message = messageOf(e);
    throw new PodWriteError(`the holder's pod did not accept the copy of ${rec.descriptorUrl}: ${message}`, statusIn(message));
  }
}
