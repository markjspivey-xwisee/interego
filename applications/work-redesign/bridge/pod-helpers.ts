/**
 * The work-redesign bridge's pod layer: open a pod behind the SSRF guard, walk its manifest,
 * decide which version of each graph is current, read records back with their platform
 * authorship proof verified against the bytes actually served, publish new versions through a
 * compare-and-swap on a freshly read head, and copy records to a pod their holder names.
 *
 * ── HEAD ELIGIBILITY (normative) ─────────────────────────────────────────────────────────────
 * A descriptor counts toward a graph's heads only if it sits in `<pod>/wrd/records/` and holds an
 * authorship proof whose signature verifies, made by a platform key this bridge trusts, whose
 * signed descriptorId predicts exactly the URL the descriptor sits at. Anything else — a holder
 * copy, a descriptor someone appended without a trusted proof, a genuine descriptor replayed to
 * another URL — is set aside with a reason and never becomes current. Eligibility is decided from
 * that signed proof alone, before the graph is looked at: every proof the descriptor states as RDF,
 * and every `iep:authorshipProof [ … ]` block in its text (comments included, and with comments
 * blanked), is a candidate (authorshipProofsIn), and the one that verifies under a trusted key and
 * names this URL places it (placeBy). The descriptor's subject is not consulted for placement: the
 * signature covers the descriptorId and the URL must be the one that id predicts, so a proof places
 * exactly one URL, the one it was signed for, and a subject line is unsigned bytes that a pod writer
 * can edit as freely as any other. So eligibility never depends on what a party able to write the
 * pod did to the graph, the descriptor's link to it, its iep:describes, its layout (whitespace, line
 * breaks, `a` or rdf:type, prefixed or full IRIs), its comments, its subject, or a decoy block placed
 * above the real one. A head that IS eligible but whose graph bytes no longer match the signed
 * digest, whose graph is missing, does not open or cannot be found in its document, whose
 * descriptor's iep:describes no longer names the graph its proof covers, whose descriptor's modal
 * status no longer matches the status its signed payload records, or whose descriptor, read as RDF,
 * no longer parses, no longer types the signed record id as an iep:ContextDescriptor, or states an
 * authorship proof other than the one that places it (or that one only in a comment), is
 * "altered": every lifecycle call on that graph refuses (409) rather than act on it, and the
 * version before it never becomes current again; once the bytes are restored it is trusted again.
 * An edit that changes nothing the bridge reads as RDF (layout, comments) leaves it trusted.
 *
 * What this cannot stop, and says so in the README: a party with write access to the pod can
 * delete files, or overwrite a genuine descriptor's unsigned facets in place. Deleting a current
 * version's descriptor, removing or breaking its proof so that no proof it holds, as RDF or in
 * its text, verifies under a trusted key and names the URL it sits at, or removing its manifest
 * entry (changing the entry's dct:conformsTo so it names no wrd: kind does the same), listing it
 * under another graph, or changing the URL the entry names, makes it ineligible or leaves it out
 * of its graph's candidates, so the version before it becomes current again: writes proceed from
 * that version, and once the bytes are restored the graph is forked (409). These, and only these,
 * act as a deletion would. Nothing signed records which version is current, so none of this can be
 * told apart from a version that was never written. v1 relies on the pod's own access control for
 * that. A whole line, by contrast, is never read short (PodView.line): every version records its
 * number in its signed content.
 *
 * ── SEALED GRAPHS ────────────────────────────────────────────────────────────────────────────
 * Given the bridge's record key, every new version's graph is sealed to it (publish's encrypt
 * option; stored as `<slug>-graph.envelope.jose.json`), and a sealed graph is opened with it on
 * read. Descriptors and the manifest stay plaintext: signer, kind, modal status and times remain
 * public. The authorship proof covers the plaintext graph, so the checks above run on the opened
 * bytes unchanged. A sealed graph that does not open — sealed to another key, no key held, or
 * ciphertext changed on the pod — is never read as an empty or valid record: a descriptor that is
 * otherwise eligible stays eligible and untrusted (so its graph answers "altered", 409, and an
 * older version never silently becomes current again), and one that is not is set aside. Which
 * record key a version was sealed to is not read from its envelope, whose recipient list is
 * unauthenticated: a version written with a record key carries that key's fingerprint in its
 * record id, which the platform's proof signs and the descriptor's URL repeats (recordIdFor), and
 * publishRecord refuses to seal a version whose id names another key, or none.
 *
 * ── WHAT THE MANIFEST SAYS IS ONLY A HINT ─────────────────────────────────────────────────────
 * Which descriptors describe a graph, and which version supersedes which, are read from the
 * manifest, which anyone able to write the pod can edit. So a version whose content its proof
 * binds counts toward a graph, and a supersedes link is followed, only when that signed content
 * names the graph: a link someone added from one chain into another never puts another entity's
 * record (opened with the record key) into this graph's heads or its history. The exception is a
 * version a trusted key signed where its proof says whose content cannot be read or no longer
 * matches its proof: it counts, never as trusted, toward any graph of the kind its signed record
 * id names that the manifest lists it under (ofGraph), so such a listing, or a link to it from a
 * chain of that kind, can make that graph answer 409; it never puts anything in a read. A
 * supersedes link from an entry to itself is ignored, and versions whose links leave none of them
 * current (a cycle) make the graph answer 409, never "absent".
 *
 * No environment reads. The only network is the injected fetch, always behind guardedFetchFn.
 */
import {
  assertSafeFetchTarget, guardedFetchFn, canonicalGraphDigest, canonicalGraphDigestResult, createSignedAuthorship,
  makeWalletDelegationSigner, makeWalletDelegationVerifier, verifySignedAuthorship, sha256Hex, openEncryptedEnvelope, canonicalJson,
  turtleIriRef, parseTrig, findSubjectsOfType, readStringValue, readIriValue, CG,
  type AuthorshipProof, type EncryptedEnvelope, type EncryptionKeyPair, type FetchFn, type IRI, type ManifestEntry, type Wallet,
  type ParsedDocument, type ParsedSubject,
} from '@interego/core';
import {
  publish, fetchAllManifestEntries, predictManifestUrl, predictDescriptorUrl, parseAuthorshipProofFromDescriptorTurtle,
  parseDistributionFromDescriptorTurtle, digestedGraphRegion, PublishShapeViolationError, PublishPreconditionFailedError,
} from '@interego/solid';
import { WRD_NS, WRD_SHAPES_NS, readShapesTurtle } from '../src/ontology.js';
import {
  buildDescriptor, buildGraphTurtle, parseRecordGraph, slugOf, h16, normalisePodUrl, graphIriOf, isWellFormedText, recordKeyFingerprint, fingerprintOfRecord,
  kindOfIri, kindOfRecord, type DescriptorSpec, type ModalChoice, type RecordKind, type WrdRecord,
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
/** The head the caller read is no longer the head, or the graph already exists (409). `why` says why a graph that is not ok has no usable head. */
export class StaleHeadError extends Error {
  constructor(readonly graphIri: string, readonly heads: readonly string[], why: string | null = null) {
    super(`${graphIri}: the current version is ${heads.length === 0 ? (why === null ? 'absent' : 'none') : heads.join(', ')}${why === null ? '' : ` (${why})`}, not the version this write was based on`);
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
  /**
   * The descriptor's URL is the one its proof's signed descriptorId predicts: the proof is chosen
   * among every proof the descriptor holds, as RDF or as a block in its text (authorshipProofsIn),
   * by what it signs, never by the descriptor's formatting.
   */
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

// ── Which proof places a record ─────────────────────────────────────────────────────────

/** The iep: namespace (core's CG). The parser reads the deprecated cg: spelling into it as well. */
const IEP_NS: string = CG;
const IEP_CONTEXT_DESCRIPTOR = `${IEP_NS}ContextDescriptor` as IRI;
const IEP_AUTHORSHIP_PROOF = `${IEP_NS}authorshipProof` as IRI;
const IEP_MODAL_STATUS = `${IEP_NS}modalStatus` as IRI;
/** The scheme a proof that names none is read with, as parseAuthorshipProofFromDescriptorTurtle reads it. */
const DEFAULT_PROOF_SCHEME = 'EcdsaSecp256k1Signature2019';
/**
 * The most text read inside one `iep:authorshipProof [ … ]` block. A proof publish writes is well
 * under a kilobyte; the bound keeps the scan linear in the descriptor's length however many
 * unclosed blocks a descriptor holds.
 */
const PROOF_BLOCK_MAX = 2048;

/** A descriptor read as RDF, or null when it does not parse. */
function parseDescriptor(descriptorTurtle: string): ParsedDocument | null {
  try { return parseTrig(descriptorTurtle); } catch { return null; }
}

/**
 * The authorship proof an RDF node states, field by field, read as parseAuthorshipProofFromDescriptorTurtle
 * reads a block (the same required fields, the same default scheme); null when a required field is missing.
 */
function proofOfNode(node: ParsedSubject): AuthorshipProof | null {
  const lit = (name: string): string | undefined => readStringValue(node, `${IEP_NS}${name}` as IRI);
  const ref = (name: string): IRI | undefined => readIriValue(node, `${IEP_NS}${name}` as IRI);
  const issuer = ref('issuer');
  const verificationMethod = ref('verificationMethod');
  const signerAddress = lit('signerAddress');
  const created = lit('created');
  const ownerWebId = ref('ownerWebId');
  const descriptorId = ref('descriptorId');
  const proofValue = lit('proofValue');
  const agentDid = lit('agentDid');
  const contentHash = lit('contentHash');
  if (!issuer || !verificationMethod || !signerAddress || !created || !ownerWebId || !descriptorId || !proofValue) return null;
  return {
    issuer, verificationMethod, signerAddress, created, ownerWebId, descriptorId, proofValue, scheme: lit('scheme') || DEFAULT_PROOF_SCHEME,
    ...(agentDid ? { agentDid } : {}), ...(contentHash ? { contentHash } : {}),
  };
}

/**
 * Every object of iep:authorshipProof a descriptor states as RDF, in document order, each read as a
 * proof (proofOfNode), or null when it names no node with the fields a proof needs.
 */
function statedProofs(doc: ParsedDocument): Array<AuthorshipProof | null> {
  return doc.subjects.flatMap((s) => s.properties.get(IEP_AUTHORSHIP_PROOF) ?? []).map((t) => {
    const node = t.kind === 'bnode' ? doc.subjects.find((s) => typeof s.subject === 'object' && s.subject.bnode === t.id)
      : t.kind === 'iri' ? doc.subjects.find((s) => s.subject === t.iri) : undefined;
    return node ? proofOfNode(node) : null;
  });
}

/**
 * A Turtle document with every comment blanked to spaces, so offsets hold. IRI references and
 * string literals are copied as they are, so a `#` inside one is not taken for a comment. Not a
 * parser, and never needed to be exact: it only lets authorshipProofsIn read a proof block that a
 * comment would otherwise cut short (a `]` inside it) or swallow (an unclosed `[` above it).
 */
function blankTurtleComments(ttl: string): string {
  let out = '';
  let i = 0;
  while (i < ttl.length) {
    const c = ttl.charAt(i);
    if (c === '#') {
      const nl = ttl.indexOf('\n', i);
      const stop = nl < 0 ? ttl.length : nl;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '<') {
      // An IRI reference holds no '<', '>', space or line break of its own, so it ends at the first
      // '>'; a '<' that meets one of the others first opens none and is copied as it is. Stopping
      // there keeps the whole pass linear in the text's length.
      let j = i + 1;
      while (j < ttl.length && !'<> \t\r\n'.includes(ttl.charAt(j))) j += 1;
      if (ttl.charAt(j) === '>') {
        out += ttl.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const quote = ttl.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < ttl.length && !ttl.startsWith(quote, j) && (quote.length === 3 || ttl.charAt(j) !== '\n')) j += ttl.charAt(j) === '\\' ? 2 : 1;
      const stop = Math.min(ttl.length, ttl.startsWith(quote, j) ? j + quote.length : j);
      out += ttl.slice(i, stop);
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Every authorship proof a descriptor holds, distinct, in the order they are met: first those it
 * states as RDF (however it spells them: prefixed or full IRIs, any layout, a `]` inside a literal),
 * then the `iep:authorshipProof [ … ]` blocks of its text with its comments blanked, then those of
 * the text as it is (comments included). A text block is read from every place the predicate
 * occurs, so one that a decoy above it opens and never closes cannot swallow it (up to
 * PROOF_BLOCK_MAX characters of it), and each is parsed by the same reader publish's own proof is
 * checked with; the text is read as well as the RDF so
 * that a proof a comment holds, or one in a descriptor that no longer parses, is still found. Which
 * one places the record is decided by placeBy, from what each one signs; nothing about the
 * descriptor's layout counts.
 */
function authorshipProofsIn(descriptorTurtle: string, doc: ParsedDocument | null = parseDescriptor(descriptorTurtle)): AuthorshipProof[] {
  const seen = new Set<string>();
  const out: AuthorshipProof[] = [];
  const add = (proof: AuthorshipProof | null): void => {
    if (!proof) return;
    const k = canonicalJson(proof);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(proof);
  };
  for (const proof of doc ? statedProofs(doc) : []) add(proof);
  for (const text of [blankTurtleComments(descriptorTurtle), descriptorTurtle]) {
    const block = new RegExp(`iep:authorshipProof\\s*\\[([^\\]]{0,${PROOF_BLOCK_MAX}})\\]`, 'g');
    for (let m = block.exec(text); m !== null; m = block.exec(text)) {
      block.lastIndex = m.index + 1;
      add(parseAuthorshipProofFromDescriptorTurtle(`iep:authorshipProof [${m[1] ?? ''}]`));
    }
  }
  return out;
}

/**
 * Verify one proof: against the graph's digest when there is one, and when that answers
 * 'mismatched' once more without it, to learn whether the signature itself is intact. Cached by
 * what the verdict depends on (the proof's fields and the observed digest), so a re-read costs no
 * signature check, and nothing else a byte of the descriptor holds can reuse or change a verdict.
 */
async function verifyProof(proof: AuthorshipProof, contentHash: string | null, cache?: VerifyCache): Promise<Verified> {
  const key = sha256Hex(`${contentHash ?? 'descriptor-only'}\u0000${canonicalJson(proof)}`);
  const hit = cache?.get(key);
  if (hit) return hit;
  const verifier = makeWalletDelegationVerifier();
  let verified: Verified;
  if (contentHash) {
    const first = await verifySignedAuthorship(proof, verifier, { contentHash });
    const signatureValid = first.contentBinding === 'mismatched' ? (await verifySignedAuthorship(proof, verifier)).valid : first.valid;
    verified = { signatureValid, contentBinding: first.contentBinding };
  } else {
    const v = await verifySignedAuthorship(proof, verifier);
    verified = { signatureValid: v.valid, contentBinding: v.contentBinding };
  }
  if (cache) {
    if (cache.size >= VERIFY_CACHE_LIMIT) cache.clear();
    cache.set(key, verified);
  }
  return verified;
}

/** The proof that places a record and what it establishes. */
interface Placement {
  readonly proof: AuthorshipProof | null;
  readonly verified: Verified;
  /** The signature verifies and its signer is one of the keys the check accepts. */
  readonly bySigner: boolean;
  /** Its signed descriptorId predicts the URL the descriptor was read at; null where there is no URL to check (a download). */
  readonly placed: boolean | null;
}

/**
 * Which of a descriptor's proofs places it: the first, in authorshipProofsIn's order, whose
 * signature verifies, made by one of `signers`, whose descriptorId predicts the URL (`places`),
 * preferring one that binds `contentHash`. Only a candidate that claims such a signer and that URL
 * is verified, and the first candidate always is, so that when none places the record the reason
 * given is the first one's (the proof the descriptor states as RDF, when it states one). So a decoy
 * (a comment, a block for another record, a block that does not verify) never hides the proof that
 * places a record, and never places one itself: placement rests on a signature alone. `doc` is the
 * descriptor read as RDF (parseDescriptor), null when it does not parse.
 */
async function placeBy(descriptorTurtle: string, doc: ParsedDocument | null, contentHash: string | null, signers: ReadonlySet<string>,
  places: ((p: AuthorshipProof) => boolean) | null, cache?: VerifyCache): Promise<Placement> {
  let first: Placement | null = null;
  let chosen: Placement | null = null;
  for (const [i, proof] of authorshipProofsIn(descriptorTurtle, doc).entries()) {
    const claimed = signers.has(proof.signerAddress.toLowerCase());
    const placed = places === null ? null : places(proof);
    const fits = claimed && placed !== false;
    if (!fits && i > 0) continue;
    const verified = await verifyProof(proof, contentHash, cache);
    const p: Placement = { proof, verified, bySigner: verified.signatureValid && claimed, placed };
    if (i === 0) first = p;
    if (fits && verified.signatureValid) {
      if (verified.contentBinding === 'bound') return p;
      chosen ??= p;
    }
  }
  return chosen ?? first ?? { proof: null, verified: { signatureValid: false, contentBinding: 'unbound' }, bySigner: false, placed: null };
}

/** Whether a proof's signed descriptorId predicts the URL `entry` names, in `container` of `podUrl`. */
const placesAt = (entry: ManifestEntry, podUrl: string, container: string) => (proof: AuthorshipProof): boolean =>
  entry.descriptorUrl === predictDescriptorUrl(podUrl, proof.descriptorId, { containerPath: container, descriptorSlug: slugOf(proof.descriptorId) });

/** Why a version whose descriptor no longer parses as Turtle is not trusted. */
export const DESCRIPTOR_UNPARSEABLE = 'its descriptor was altered after signing: it no longer parses as Turtle';
/** Why a version whose descriptor no longer states, as RDF, the record id its proof signs is not trusted. */
export const SUBJECT_ALTERED = 'its descriptor was altered after signing: it no longer types the record id its proof signs as an iep:ContextDescriptor';
/** Why a version whose descriptor's RDF carries another authorship proof, or its own only in a comment, is not trusted. */
export const PROOF_ALTERED = 'its descriptor was altered after signing: as RDF it no longer carries the authorship proof that places it, and only that one';

/**
 * Why a descriptor, read as RDF, does not say what the proof that places it signs, or null when
 * it does: it parses, it types the signed record id as an iep:ContextDescriptor, and it states
 * exactly one iep:authorshipProof, that one. How it is laid out (whitespace, line breaks, `a` or
 * rdf:type, prefixed or full IRIs, where the proof sits) and its comments do not count. Asked only
 * once a proof has been found, and never part of placement, so none of this ever sets a version
 * aside: a version that is otherwise eligible is altered.
 */
function rdfDisagrees(doc: ParsedDocument | null, proof: AuthorshipProof): string | null {
  if (doc === null) return DESCRIPTOR_UNPARSEABLE;
  if (!findSubjectsOfType(doc, IEP_CONTEXT_DESCRIPTOR).some((s) => s.subject === proof.descriptorId)) return SUBJECT_ALTERED;
  const stated = statedProofs(doc);
  const only = stated.length === 1 ? stated[0] : null;
  return only && canonicalJson(only) === canonicalJson(proof) ? null : PROOF_ALTERED;
}

/**
 * The modal status a descriptor states. Read as RDF when it parses, so a comment restating another
 * status never stands in for the one the descriptor states: the one iep: status it states, or
 * undefined when it states more than one, or one outside iep: (which then matches no signed
 * status). Read from its text only when it does not parse (and is altered for that anyway).
 * `fallback` (the manifest's) when it states none.
 */
function modalStatusOf(descriptorTurtle: string, doc: ParsedDocument | null, fallback: string | undefined): string | undefined {
  if (doc === null) return firstMatch(/iep:modalStatus\s+iep:(\w+)/, descriptorTurtle) ?? fallback;
  const stated = new Set(doc.subjects.flatMap((s) => s.properties.get(IEP_MODAL_STATUS) ?? [])
    .map((t) => (t.kind === 'iri' && t.iri.startsWith(IEP_NS) ? t.iri.slice(IEP_NS.length) : '')));
  if (stated.size === 0) return fallback;
  const [only] = stated;
  return stated.size === 1 && only !== '' ? only : undefined;
}

/** What a descriptor and its graph document say on their own, and which proof places them. */
interface BytesRead extends Placement {
  readonly graphIri: string;
  readonly graphTurtle: string;
  readonly graphDigest: string;
  readonly record: WrdRecord | null;
  readonly modalStatus: string | undefined;
  readonly modalMatches: boolean;
  /** Why the descriptor's RDF does not say what the placing proof signs (rdfDisagrees); null when it does, or there is no proof. */
  readonly rdfWhy: string | null;
}

/**
 * Verify a descriptor and its graph document from their bytes: the region of the graph document
 * the proof covers is digested, and the proof that places the record (placeBy, among every proof
 * the descriptor holds, accepting `signers` and, where there is one, the URL `places` checks) is
 * verified against that digest; then the descriptor, read as RDF, is checked to state that proof
 * (rdfDisagrees), which can make the record altered and never sets it aside. readRecord passes the
 * platform keys it trusts and the URL the descriptor was read at; verifyHolderBundle passes the
 * platform addresses the holder expects and no URL.
 */
async function readBytes(descriptorTurtle: string, graphContent: string, fallbackModal: string | undefined, signers: ReadonlySet<string>,
  places: ((p: AuthorshipProof) => boolean) | null, cache?: VerifyCache):
  Promise<{ readonly ok: true; readonly read: BytesRead } | { readonly ok: false; readonly why: string }> {
  const region = digestedGraphRegion({ descriptorTurtle, graphContent });
  if (!region.ok) return { ok: false, why: `the signed region of the graph could not be identified (${region.why})` };
  const graphDigest = canonicalGraphDigest(region.turtle) ?? '';
  const doc = parseDescriptor(descriptorTurtle);
  const placement = await placeBy(descriptorTurtle, doc, graphDigest === '' ? null : graphDigest, signers, places, cache);
  const record = parseRecordGraph(region.turtle);
  const modalStatus = modalStatusOf(descriptorTurtle, doc, fallbackModal);
  let modalMatches = false;
  if (record) {
    try { modalMatches = modalFor(record.recordKind, record.status) === modalStatus; } catch { modalMatches = false; }
  }
  const rdfWhy = placement.proof ? rdfDisagrees(doc, placement.proof) : null;
  return { ok: true, read: { ...placement, graphIri: region.graphIri, graphTurtle: region.turtle, graphDigest, record, modalStatus, modalMatches, rdfWhy } };
}

/** Why bytes that verified as far as they go are still not trusted, in the order the checks apply; null when they are. */
function distrust(r: BytesRead, untrustedKey: string): string | null {
  return !r.proof ? 'it carries no authorship proof'
    : !r.verified.signatureValid ? 'its authorship signature does not verify'
      : !r.bySigner ? untrustedKey
        : r.placed === false ? 'it is not at the URL its own proof names'
          : r.verified.contentBinding !== 'bound' ? 'its graph was altered after signing: the bytes no longer match the signed digest'
            : r.record === null ? 'its graph is not a well-formed wrd record'
              : !r.modalMatches ? 'its descriptor was altered after signing: the modal status no longer matches the signed status'
                : r.rdfWhy;
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
 * A record whose graph could not be read as signed: sealed and did not open, missing, linked
 * outside the pod or not at all, or its signed region not found in the document. Its descriptor's
 * proof is still found and checked (placeBy: the signature, with no content to bind), so a version
 * a trusted platform key signed at its predicted URL stays ELIGIBLE but is never trusted: its graph
 * answers "altered" (409) instead of the previous version becoming current again, which a party
 * able to write the pod could otherwise cause by corrupting one ciphertext, deleting one graph, or
 * editing one descriptor's link or iep:describes. Anything less than that is set aside, as ever,
 * with why.
 */
async function placedByDescriptor(entry: ManifestEntry, podUrl: string, descriptorTurtle: string, trusted: ReadonlySet<string>,
  container: string, why: string, cache?: VerifyCache): Promise<LoadedRecord> {
  const { proof, verified, bySigner, placed } = await placeBy(descriptorTurtle, parseDescriptor(descriptorTurtle), null, trusted, placesAt(entry, podUrl, container), cache);
  const atPredictedUrl = placed === true;
  const eligible = bySigner && atPredictedUrl;
  const reason = !proof ? 'it carries no authorship proof'
    : !verified.signatureValid ? 'its authorship signature does not verify'
      : !bySigner ? 'it was signed by a key this bridge does not trust'
        : !atPredictedUrl ? 'it is not at the URL its own proof names'
          : why;
  return {
    ...unreadable(entry, reason),
    recordId: proof?.descriptorId ?? '',
    // The graph this descriptor itself names, for display: which graph it counts toward is decided by ofGraph, never by this.
    graphIri: firstMatch(/iep:describes\s+<([^>]+)>/, descriptorTurtle) ?? '',
    modalStatus: firstMatch(/iep:modalStatus\s+iep:(\w+)/, descriptorTurtle) ?? entry.modalStatus,
    validFrom: firstMatch(/iep:validFrom\s+"([^"]+)"/, descriptorTurtle),
    validUntil: firstMatch(/iep:validUntil\s+"([^"]+)"/, descriptorTurtle),
    generatedAt: firstMatch(/prov:generatedAtTime\s+"([^"]+)"/, descriptorTurtle),
    descriptorTurtle,
    authorship: {
      signatureValid: verified.signatureValid, signerAddress: proof ? proof.signerAddress.toLowerCase() : null, signedByTrustedKey: bySigner, atPredictedUrl,
      contentBinding: verified.contentBinding, modalMatches: false, eligible, trusted: false, proof,
    },
  };
}

/** Why a version whose descriptor's iep:describes was changed after signing is not trusted. */
export const DESCRIBES_ALTERED = 'its descriptor was altered after signing: its iep:describes no longer names the graph its proof covers';
const DESCRIBES = /\b(?:iep|cg):describes\s+<[^>]+>/;
/** A named graph block's opening line, as wrapAsTriG writes it at column 0. */
const BLOCK_OPENER = /^<([^<>\s]+)> \{$/gm;
/** How many named graph blocks of one document signedRegionHeld tries; a document the bridge wrote holds one. */
const BLOCKS_TRIED = 4;

/**
 * The signed region of a graph document whose descriptor's iep:describes names no block in it:
 * the document is read as if the descriptor named, in turn, each graph the document holds a named
 * block for (only that line differs; the proof, id, modal status and times are the descriptor's
 * own), and a region is taken only when the platform's proof binds it ('bound') and the record in
 * it is a version of that graph. So the graph a version belongs to is still the one its signed
 * content names, and an edit to its iep:describes alone makes that version altered (409), never
 * a stranger to its own graph. Null when no block binds.
 */
async function signedRegionHeld(entry: ManifestEntry, descriptorTurtle: string, graphContent: string, trusted: ReadonlySet<string>,
  places: (p: AuthorshipProof) => boolean, cache?: VerifyCache): Promise<BytesRead | null> {
  if (!DESCRIBES.test(descriptorTurtle)) return null;
  const held = [...graphContent.matchAll(BLOCK_OPENER)].map((m) => m[1] ?? '').filter((g) => g !== '').slice(0, BLOCKS_TRIED);
  for (const graphIri of held) {
    // The block name comes from the pod's bytes, so it is serialized as an IRI or skipped.
    const ref = turtleIriRef(graphIri);
    if (ref === null) continue;
    const as = descriptorTurtle.replace(DESCRIBES, () => `iep:describes ${ref}`);
    if (as === descriptorTurtle) continue;
    const bytes = await readBytes(as, graphContent, entry.modalStatus, trusted, places, cache);
    if (bytes.ok && bytes.read.verified.contentBinding === 'bound' && bytes.read.record !== null && graphIriOf(bytes.read.record.entityIri) === graphIri) return bytes.read;
  }
  return null;
}

/**
 * Read one record from a pod and verify it: the descriptor and the graph are fetched (a sealed
 * graph opened with `recordKey`), their bytes verified (readBytes), and the record is placed by
 * the proof among its descriptor's blocks (placeBy) that a platform key this bridge trusts signed
 * and whose descriptorId predicts exactly the URL it sits at. Once the descriptor is read, every
 * way the graph can fail to be read as
 * signed is decided by placedByDescriptor, so a version eligible by its descriptor stays eligible
 * (and untrusted). A descriptor whose iep:describes no longer names its graph's signed region is
 * read through signedRegionHeld, and is altered (DESCRIBES_ALTERED).
 */
export async function readRecord(entry: ManifestEntry, podUrl: string, fetchFn: FetchFn, trusted: ReadonlySet<string>,
  cache?: VerifyCache, container: string = WRD_CONTAINER, recordKey?: EncryptionKeyPair): Promise<LoadedRecord> {
  const desc = await getText(entry.descriptorUrl, fetchFn, 'text/turtle');
  if (desc.body === null) return unreadable(entry, `the descriptor is not at its manifest URL (${desc.status})`);
  const descriptorTurtle = desc.body;
  const shut = (why: string): Promise<LoadedRecord> => placedByDescriptor(entry, podUrl, descriptorTurtle, trusted, container, why, cache);
  const places = placesAt(entry, podUrl, container);
  const dist = parseDistributionFromDescriptorTurtle(descriptorTurtle);
  if (!dist) return shut('its descriptor links no graph');
  if (!dist.accessURL.startsWith(podUrl)) return shut('its descriptor links a graph outside this pod');
  let graphContent: string;
  if (dist.encrypted) {
    const sealed = await getText(dist.accessURL, fetchFn, 'application/jose+json');
    if (sealed.body === null) return shut(`its graph is not at the URL its descriptor names (${sealed.status})`);
    const opened = recordKey ? openSealedGraph(sealed.body, recordKey) : null;
    if (opened === null) return shut(recordKey ? SEALED_OTHER_KEY : SEALED_NO_KEY);
    graphContent = opened;
  } else {
    const graph = await getText(dist.accessURL, fetchFn, 'application/trig, text/turtle');
    if (graph.body === null) return shut(`its graph is not at the URL its descriptor names (${graph.status})`);
    graphContent = graph.body;
  }
  let bytes = await readBytes(descriptorTurtle, graphContent, entry.modalStatus, trusted, places, cache);
  let describesAltered = false;
  if (!bytes.ok) {
    const held = await signedRegionHeld(entry, descriptorTurtle, graphContent, trusted, places, cache);
    if (held === null) return shut(bytes.why);
    bytes = { ok: true, read: held };
    describesAltered = true;
  }
  const r = bytes.read;
  const { proof, verified } = r;
  const signedByTrustedKey = r.bySigner;
  const atPredictedUrl = r.placed === true;
  const eligible = signedByTrustedKey && atPredictedUrl;
  const why = distrust(r, 'it was signed by a key this bridge does not trust') ?? (describesAltered ? DESCRIBES_ALTERED : null);
  const isTrusted = eligible && why === null;
  const confidenceText = firstMatch(/iep:epistemicConfidence\s+"([^"]+)"/, descriptorTurtle);
  const confidence = confidenceText === null ? null : Number(confidenceText);
  return {
    descriptorUrl: entry.descriptorUrl,
    recordId: proof?.descriptorId ?? '',
    graphIri: r.graphIri,
    modalStatus: r.modalStatus,
    validFrom: firstMatch(/iep:validFrom\s+"([^"]+)"/, descriptorTurtle),
    validUntil: firstMatch(/iep:validUntil\s+"([^"]+)"/, descriptorTurtle),
    generatedAt: firstMatch(/prov:generatedAtTime\s+"([^"]+)"/, descriptorTurtle),
    confidence: confidence !== null && Number.isFinite(confidence) ? confidence : null,
    supersedes: entry.supersedes ?? [],
    descriptorTurtle, graphContent, graphTurtle: r.graphTurtle, graphDigest: r.graphDigest, record: r.record,
    authorship: {
      signatureValid: verified.signatureValid, signerAddress: proof ? proof.signerAddress.toLowerCase() : null, signedByTrustedKey, atPredictedUrl,
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
 * bridge prints it at startup); the proof is found among every block the descriptor holds, as on
 * the pod, and the descriptor read as RDF must state it. Where a record sat is not checked: a
 * download has no URL to check against. Nothing here trusts the bundle's own claims about who
 * signed it.
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
    const bytes = await readBytes(descriptorTurtle, graphTrig, undefined, expected, null);
    if (!bytes.ok) {
      records.push({ descriptorUrl, recordKind: null, entityIri: null, status: null, signerAddress: null, verified: false, why: bytes.why });
      continue;
    }
    const r = bytes.read;
    const signerAddress = r.proof ? r.proof.signerAddress.toLowerCase() : null;
    const why = distrust(r, `it was signed by ${signerAddress ?? 'no key'}, not by an expected platform address`);
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
 * Whether a record read for `graphIri` is a version of that graph. A record whose content the
 * platform's proof binds is judged by that signed content: the named graph its proof covers, and
 * the entity that graph is about. A record with no signed content to judge by (its graph sealed
 * and not opened, missing, not found in its document, or changed after signing) is judged, when a
 * trusted key signed it where its proof says (eligible), by the kind of entity its signed record id
 * names: it counts toward any graph of that kind the manifest lists it under, so an edit to its
 * graph or to its descriptor's iep:describes never sets it aside to let an older version become
 * current; it stays untrusted, and the graph answers "altered" (409). Anything else is judged by
 * its descriptor, and is set aside anyway. The manifest's `describes` is never enough on its own:
 * the pod's writers can edit it.
 */
export function ofGraph(l: LoadedRecord, graphIri: string): boolean {
  if (l.record !== null && l.authorship.contentBinding === 'bound') return l.graphIri === graphIri && graphIriOf(l.record.entityIri) === graphIri;
  if (l.authorship.eligible) {
    const kind = kindOfRecord(l.recordId);
    return kind !== null && kind === kindOfIri(graphIri);
  }
  return l.graphIri === graphIri;
}

export interface GraphHeads {
  readonly graphIri: string;
  /** Eligible heads (after setting ineligible ones aside). Empty when absent, and when the versions' links leave none current. */
  readonly heads: readonly LoadedRecord[];
  /** The entries still in play: every entry describing the graph, minus those set aside. */
  readonly chain: readonly ManifestEntry[];
  readonly state: 'absent' | 'ok' | 'forked' | 'altered';
  /** Why a forked or altered graph cannot be used (the head's own why when it is altered); null when absent or ok. */
  readonly why: string | null;
  /** Descriptors set aside, with why. */
  readonly untrusted: ReadonlyArray<{ readonly descriptorUrl: string; readonly why: string }>;
}

/** Why a graph with more than one eligible head answers 409. */
export const MORE_THAN_ONE_CURRENT = 'more than one version claims to be current';
/** Why a graph whose eligible versions all supersede one another answers 409 (forked), never "absent". */
export const NONE_CURRENT = 'no version claims to be current: the supersedes links the manifest lists for its versions form a cycle';

/**
 * Lazy eligibility: compute heads over the entries; read each head; set aside any that is not
 * eligible (with its supersede links) and recompute; repeat until every head read is eligible.
 * More than one eligible head is a fork; one whose bytes or modal status changed after
 * signing is altered.
 *
 * Two things only the manifest says are never enough to hide a version from the heads: a
 * supersedes link from an entry to its own descriptorUrl is ignored (it says nothing about which
 * version is current), and when every candidate is superseded by another (a cycle), every one is
 * read: those set aside are dropped with their links as ever, and when every one left is eligible
 * the graph is forked, with heads empty and NONE_CURRENT as why. "Absent" means no candidate is
 * left at all, so a manifest edit alone never makes a graph read as one that was never written.
 */
export async function headsFor(graphIri: string, entries: readonly ManifestEntry[],
  read: (e: ManifestEntry) => Promise<LoadedRecord>): Promise<GraphHeads> {
  let candidates = entries.filter((e) => e.describes.includes(graphIri));
  const untrusted: { descriptorUrl: string; why: string }[] = [];
  for (;;) {
    const superseded = new Set(candidates.flatMap((e) => (e.supersedes ?? []).filter((u) => u !== e.descriptorUrl)));
    const headEntries = candidates.filter((e) => !superseded.has(e.descriptorUrl));
    const cycle = headEntries.length === 0 && candidates.length > 0;
    const loaded = await Promise.all((cycle ? candidates : headEntries).map(read));
    const bad = loaded.filter((l) => !l.authorship.eligible || !ofGraph(l, graphIri));
    if (bad.length === 0) {
      if (cycle) return { graphIri, heads: [], chain: candidates, state: 'forked', why: NONE_CURRENT, untrusted };
      const only = loaded[0];
      const state = loaded.length === 0 ? 'absent' : loaded.length > 1 ? 'forked' : only && only.authorship.trusted ? 'ok' : 'altered';
      const why = state === 'forked' ? MORE_THAN_ONE_CURRENT : state === 'altered' ? only?.why ?? 'it was altered after signing' : null;
      return { graphIri, heads: loaded, chain: candidates, state, why, untrusted };
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
   * ofGraph) whose signed version number is one less than the version it was reached from: one
   * added to the manifest from this chain into another entity's, which the bridge could open, is
   * passed over, so no caller reads another entity's record through this chain, and one added to
   * skip a version is passed over too. The walk ends at version 1.
   *
   * `cut` is set when the line is not whole, or null: the first version of this graph the walk met
   * that is eligible but not trusted, whatever the reason (sealed and not opening, its graph
   * changed, missing or not found, its iep:describes or link edited), or else, when the walk could
   * not reach version 1, the version it stopped at: the version before it was deleted, set aside
   * (its proof broken, say) or left out of the manifest. Every version's number is in its signed
   * content, so no edit to the pod can make a line read whole when it is not. A caller that would
   * answer from the whole line refuses (409; naming WRD_RECORD_KEY only when `cut.sealed`) or marks
   * its answer rather than answer from part of it.
   */
  async line(g: GraphHeads): Promise<{ readonly versions: LoadedRecord[]; readonly cut: LineCut | null }> {
    const head = g.heads[0];
    if (g.heads.length !== 1 || !head || !head.authorship.trusted || !ofGraph(head, g.graphIri)) return { versions: [], cut: null };
    const byUrl = new Map(g.chain.map((e) => [e.descriptorUrl, e]));
    const out: LoadedRecord[] = [head];
    const inLine = new Set([head.descriptorUrl]);
    let cut: LineCut | null = null;
    let cursor: LoadedRecord = head;
    // The version each step must reach; versions strictly decrease, so the walk ends however the links run.
    for (let want = (cursor.record?.version ?? 1) - 1; want >= 1; want -= 1) {
      let prev: LoadedRecord | null = null;
      let setAside: LoadedRecord | null = null;
      // Every link is read (not only up to the first trusted one), so a version that is not trusted is never passed over unseen.
      for (const u of cursor.supersedes) {
        const entry = byUrl.get(u);
        if (!entry || inLine.has(u)) continue;
        const loaded = await this.read(entry);
        if (!ofGraph(loaded, g.graphIri)) continue;
        if (loaded.authorship.trusted) {
          if (loaded.record?.version === want) prev ??= loaded;
        } else if (loaded.authorship.eligible) {
          cut ??= { descriptorUrl: loaded.descriptorUrl, why: `an earlier version (${loaded.descriptorUrl}) is not trusted: ${loaded.why ?? 'it is not trusted'}`, sealed: isSealedShut(loaded) };
        } else {
          setAside ??= loaded;
        }
      }
      if (!prev) {
        cut ??= {
          descriptorUrl: cursor.descriptorUrl,
          why: `an earlier version is missing: ${cursor.descriptorUrl} is version ${want + 1}, and no trusted version ${want} of this graph is listed as the one it supersedes${setAside
            ? ` (${setAside.descriptorUrl} is, and is set aside: ${setAside.why ?? 'it is not eligible'})` : ''}: it was deleted, its proof no longer verifies, or its manifest entry was removed or changed`,
          sealed: false,
        };
        break;
      }
      out.push(prev);
      inLine.add(prev.descriptorUrl);
      cursor = prev;
    }
    return { versions: out.reverse(), cut };
  }

  /** The versions of `line`, for a caller that does not answer from the whole line. */
  async history(g: GraphHeads): Promise<LoadedRecord[]> {
    return (await this.line(g)).versions;
  }
}

/** Where a graph's line stops short of its first version (see PodView.line). */
export interface LineCut {
  /** The version the walk met that is not trusted, or the oldest trusted version it reached when the one before that is missing. */
  readonly descriptorUrl: string;
  /** Why, in plain words, without the graph IRI. */
  readonly why: string;
  /** The version is sealed and does not open (isSealedShut): the setting that opens it is WRD_RECORD_KEY. */
  readonly sealed: boolean;
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
 * `<slug>-graph.envelope.jose.json`, and the record id (so the slug) must end with that key's
 * fingerprint; without one it must name no key. The shapes and the proof are checked over the
 * plaintext.
 * Sealing happens here, so a graph that cannot be sealed (a lone UTF-16 surrogate, which the
 * envelope's UTF-8 encoding refuses) is a RecordNotSealableError raised before any write, never a
 * PodWriteError: the pod was not involved.
 */
export async function publishRecord(spec: PublishSpec, ctx: PublishContext): Promise<PublishedRecord> {
  const { recordId, graphIri } = spec.descriptor;
  if ((spec.descriptor.supersedes ?? null) !== spec.expectHead) throw new Error(`publishRecord: ${recordId} supersedes a different head than it expects`);
  // The record id names the key the graph is sealed to (recordIdFor), or none for a plaintext graph: never another.
  const sealsTo = ctx.recordKey ? recordKeyFingerprint(ctx.recordKey) : null;
  if (fingerprintOfRecord(recordId) !== sealsTo) {
    throw new Error(`publishRecord: ${recordId} must ${sealsTo === null ? 'name no record key: its graph is written in plaintext' : `end -k${sealsTo}, the fingerprint of the record key its graph is sealed to`}`);
  }
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
    // A new graph only where none is listed at all: a graph whose versions' links leave none current has no head, and is not absent.
    if (spec.expectHead === null) {
      if (current.state !== 'absent') throw new StaleHeadError(graphIri, heads, current.why);
    } else if (current.state !== 'ok' || heads[0] !== spec.expectHead) {
      throw new StaleHeadError(graphIri, heads, current.why);
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
