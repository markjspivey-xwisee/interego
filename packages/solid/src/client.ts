/**
 * @module solid/client
 * @description Solid pod runtime for Interego 1.0
 *
 * Three functions that bridge the data-model layer to a live
 * decentralized storage layer:
 *
 *   publish()   — write a descriptor + graph to a Solid pod
 *   discover()  — fetch and filter the context-graphs manifest
 *   subscribe() — watch a pod for context-graph changes via
 *                 Solid Notifications Protocol (WebSocket)
 *
 * Uses only fetch and WebSocket — zero additional dependencies.
 */

import type { ContextDescriptorData, ContextTypeName, OwnerProfileData, AgentDelegationCredential, DelegationVerification, DelegationVerifier, IRI, SemioticFacetData, TrustFacetData, ModalStatus, TrustLevel, ContextFacetData } from '@interego/core';
import { toTurtle } from '@interego/core';
import { turtlePrefixes } from '@interego/core';
import { ownerProfileToTurtle, parseOwnerProfile, delegationCredentialToJsonLd, parseDelegationCredential, verifyDelegation } from '@interego/core';
import { createEncryptedEnvelope, openEncryptedEnvelope, type EncryptedEnvelope, type EncryptionKeyPair } from '@interego/core';
import { computeCid } from '@interego/core';
// The wrap refuses to store a payload whose meaning it would change; deciding that needs
// the triples, not the characters, so it reaches for the same digest the read path uses.
import { canonicalGraphDigest } from '@interego/core';
import { withTransientRetry } from '@interego/core/http';
import { getDefaultFetch, getDefaultWebSocket } from '@interego/core/http';

import { PublishPreconditionFailedError, PublishShapeViolationError } from './types.js';
import { validateAgainstShape } from '@interego/core';

import type { FetchFn } from '@interego/core/http';
import type {
  PublishResult,
  PublishOptions,
  DiscoverFilter,
  DiscoverOptions,
  ManifestEntry,
  ContextChangeCallback,
  ContextChangeEvent,
  Subscription,
  SubscribeOptions,
  RegistryOptions,
} from './types.js';

import { AGENT_REGISTRY_PATH, CREDENTIALS_PATH } from './types.js';

// ── Constants ───────────────────────────────────────────────

/** Percent-encode any char illegal in a Turtle/TriG IRIREF (`<...>`). The named-graph
 *  wrapper and the affordance/distribution block interpolate a graph IRI/URL that can derive
 *  from caller-influenced identifiers; without this a `>` (or whitespace) breaks out of the
 *  `<...>` term and injects triples into (or corrupts) the published pod document. The core
 *  descriptor serializer already escapes its facet IRIs; these hand-built wrapper lines are
 *  the remaining sink. A value with no illegal char is unchanged (valid IRIs round-trip). */
function iescIri(value: string): string {
  return String(value).replace(/[\x00-\x20<>"{}|^`\\]/g, encodeURIComponent);
}

/** Escape a Turtle string LITERAL. The manifest lines below are hand-built and
 *  appended verbatim into the pod's single SHARED `.well-known/context-graphs`, so
 *  an unescaped value does not just corrupt one entry — it injects triples into the
 *  document every other entry lives in. */
function iescLit(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/** PN_LOCAL-safe local name for a prefixed name (`iep:<local>`).
 *  A prefixed name CANNOT be escaped into safety: any character outside PN_LOCAL
 *  terminates the name and begins new RDF. These positions carry closed vocabularies
 *  (facet type, ModalStatus, TrustLevel), so restrict to a conservative charset and
 *  fall back to an inert marker rather than emitting attacker-chosen syntax. */
function iescPn(value: string): string {
  const s = String(value).replace(/[^A-Za-z0-9_-]/g, '');
  return s.length > 0 ? s : 'Unspecified';
}

const MANIFEST_PATH = '.well-known/context-graphs';

// ── Bounded manifest: a hot document that LINKS to a chain of archives ──
//
// ★ WHAT A MANIFEST WRITE COSTS, MEASURED (2026-08-08, live fleet, gate-measured, see
// `tools/measure-manifest-write-cost-live.ts`). The maintainer's pod manifest is 495,492
// bytes / 653 entries / 654 Turtle statements. Overwrite latency against a disposable pod:
//
//     entries      1    10    50   100   200   300   400   450   500   550   653
//     ms         1300  1297  1354  1691  2650  4057  5119  5212  5991  6346  FAIL
//
// Least squares over those ten successes: cost(n) ≈ 1010 ms + 9.73 ms × entries. At 653 the
// PUT returns `500 InternalServerError: Lock expired after 6000ms on …/.well-known/
// context-graphs` — the production symptom, reproduced on a pod nobody else was touching, so
// it is not contention.
//
// ★ AND THE COST IS STATEMENTS, NOT BYTES — the measurement that decides the design. The
// SAME bytes written as `application/octet-stream` instead of `text/turtle` take 1629 ms at
// 67 KB, 1800 ms at 438 KB and 1828 ms at 604 KB: flat across a 9× byte range, and it
// SUCCEEDS at the size where Turtle fails. The live storage backend (`PgslDataAccessor` →
// `LdpStore.writeResource` → `rdfCodec.ingest` → `PgslStore.compose`) mints one
// content-addressed atom per Turtle statement and does a serial `await txn.get` per atom, so
// an RDF document costs a Postgres round-trip per statement while an opaque blob costs one.
// A manifest entry is exactly one statement. Bounding the ENTRY COUNT is therefore the lever;
// compressing bytes would buy nothing.
//
// THE THRESHOLD. Budget the hot write at one third of CSS's 6000 ms lock TTL, so a 3×
// slowdown from contention or a cold connection pool still lands inside the lock:
// (2000 − 1010) / 9.73 = 101.7 entries. Floored to 100. Measured directly at n=100: 1691 ms,
// 28% of the TTL, and five times below the 500-entry point that was the largest measured
// success. This is a measurement with a stated budget, not a round number.
//
// It is deliberately NOT an env var. The append-only shard attempt that this replaces put
// reader behaviour behind an environment flag, and eleven raw-manifest readers that never
// consulted it is what disqualified it. That flag and both halves of its code path have since
// been DELETED outright — not left switched off — so there is nothing here for a later reader
// to find and turn on. Re-tuning the bound is a code change with the measurement above updated
// in the same edit.
const MANIFEST_HOT_LIMIT = 100;
// How many entries stay hot after a roll-over. Half the limit, so one roll-over is amortized
// over the next 50 publishes rather than firing on every write once the hot doc sits at the
// boundary.
const MANIFEST_HOT_KEEP = Math.floor(MANIFEST_HOT_LIMIT / 2);
// Archive segments are siblings of the manifest INSIDE `.well-known/`, and that placement is
// load-bearing twice over. (a) `listDescriptorUrls` — the scan behind `rebuild_manifest` —
// already excludes `.well-known/` via NON_DESCRIPTOR_CONTAINERS, so recovery cannot mistake an
// archived index row for a descriptor. That is precisely the "recovery roughly doubles the
// manifest" defect that sank the append-only shards, which sat at the pod ROOT. (b) an archive
// is index data; it belongs where the index lives.
const MANIFEST_ARCHIVE_PREFIX = '.well-known/context-graphs-archive-';
// A cap on chain-following, so a malformed or adversarial `iep:manifestArchive` cycle cannot
// make a reader fetch forever. 512 segments × 100 entries is 51,200 entries — far past any
// real pod, and the reader reports `complete: false` if it trips.
const MANIFEST_ARCHIVE_MAX_SEGMENTS = 512;

function manifestArchiveUrl(pod: string, index: number): string {
  return `${pod}${MANIFEST_ARCHIVE_PREFIX}${String(index).padStart(4, '0')}`;
}

/**
 * The lines that make a manifest self-describing as bounded, and the pattern that removes
 * them again.
 *
 * ★ ONE DEFINITION FOR BOTH DIRECTIONS, ON PURPOSE. The insert and the strip run on every
 * roll-over — insert on the new head, strip on the old one so links do not accumulate. The
 * moment those two disagree about what an archive line looks like, a stale link survives the
 * strip and the manifest advertises a segment that has been superseded, or the comment
 * duplicates on every roll-over until the head is mostly comment.
 */
const ARCHIVE_HEAD_LINE = /^\s*(?:iep:manifestArchive\s|hydra:view\s|# ★ BOUNDED:)/;

function archiveHeadLines(archiveUrls: readonly string[]): string[] {
  if (archiveUrls.length === 0) return [];
  const list = archiveUrls.map(u => `<${iescIri(u)}>`).join(', ');
  return [
    `    # ★ BOUNDED: the entries below are the most recent ones. The rest of this index is in the write-once archive segments linked here (newest last); a reader that does not follow them holds a PARTIAL view and can tell, because these links are.`,
    `    iep:manifestArchive ${list} ;`,
    `    hydra:view ${list} ;`,
  ];
}

// ── Per-pod in-process manifest mutex ───────────────────────
//
// publish() does a read-modify-write cycle against
//   ${pod}/.well-known/context-graphs
// using HTTP optimistic concurrency (If-Match / If-None-Match) with up
// to 8 backoff retries. That CAS dance is the correct protection
// against cross-process / cross-host writers, but it is the WRONG tool
// for in-process concurrent publishes from the same Node process
// (e.g. a relay handling N parallel cartographer fan-outs or a
// Promise.all over voters from one pod):
//
//   - every writer GETs the same etag
//   - every writer builds a body that contains only its own entry
//   - the server commits one writer and 412s the rest
//   - the rest re-GET, retry, and only converge after burning their
//     retry budget
//
// Under heavy in-process contention this either drops entries (when
// the post-PUT verify read-back races with another writer's PUT into
// a false-positive) or throws after maxAttempts=8 (visible as
// `Failed to update manifest ... after 8 attempts`).
//
// Fix: serialize same-process writers to the same pod by chaining
// their manifest read-modify-write cycles through a per-pod promise
// queue. A Map<manifestUrl, Promise<void>> at module scope. On entry
// to the manifest-update block, await the prior promise for this pod
// (if any) and replace the map entry with the new tail so subsequent
// callers queue behind us. On exit, if we are the current tail (no
// one queued behind), delete the entry so the map doesn't grow.
//
// This collapses N same-process writers from a retry-storm into a
// serial queue — each iteration sees the freshest body and no etag
// fight is needed. Cross-process writers still get the existing HTTP
// CAS protection unchanged.
const manifestWriteQueues = new Map<string, Promise<void>>();

async function withManifestLock<T>(
  manifestUrl: string,
  body: () => Promise<T>,
): Promise<T> {
  const previous = manifestWriteQueues.get(manifestUrl) ?? Promise.resolve();
  let resolveTail!: () => void;
  const tail = new Promise<void>((r) => { resolveTail = r; });
  // Chain so subsequent callers wait for the prior tail AND for us.
  const newTail = previous.then(() => tail);
  manifestWriteQueues.set(manifestUrl, newTail);
  try {
    // Wait for any prior writer to finish their CAS cycle before we
    // start ours. We deliberately swallow prior errors — a previous
    // publish failing should not prevent the next one from starting.
    await previous.catch(() => undefined);
    return await body();
  } finally {
    resolveTail();
    // If no one queued behind us, drop the entry so the map doesn't
    // grow unbounded across the lifetime of the process.
    if (manifestWriteQueues.get(manifestUrl) === newTail) {
      manifestWriteQueues.delete(manifestUrl);
    }
  }
}
const DEFAULT_CONTAINER = 'context-graphs/';
const TURTLE_CONTENT_TYPE = 'text/turtle';
const TRIG_CONTENT_TYPE = 'application/trig';
// JWE-family IANA type; pragmatically correct for our tweetnacl envelope
// even though we aren't using JOSE's wire format — the semantics match
// (encrypted payload + per-recipient wrapped keys) and the media type is
// the signal other clients need to know "don't try to parse this as RDF".
const ENVELOPE_CONTENT_TYPE = 'application/jose+json';

// ── Helpers ─────────────────────────────────────────────────

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function slugFromIri(iri: string): string {
  const last = iri.split(/[/:#]/).filter(Boolean).pop() ?? 'descriptor';
  return encodeURIComponent(last);
}

/**
 * Predict the URL `publish()` will use for a given pod + descriptor ID
 * BEFORE actually calling publish(). Used by callers (notably the
 * compliance flow) that need to know the future URL — e.g., to embed
 * a self-referential `iep:proof` URL in the descriptor's TrustFacet
 * before the descriptor is serialized + signed.
 *
 * Returns the same URL `publish()` would generate as `descriptorUrl`.
 * If the caller passes custom `containerPath` or `descriptorSlug` to
 * publish(), they should pass them here too so the prediction matches.
 */
export function predictDescriptorUrl(
  podUrl: string,
  descriptorId: string,
  options?: { containerPath?: string; descriptorSlug?: string },
): string {
  const pod = ensureTrailingSlash(podUrl);
  const container = ensureTrailingSlash(`${pod}${options?.containerPath ?? DEFAULT_CONTAINER}`);
  const slug = options?.descriptorSlug ?? slugFromIri(descriptorId);
  return `${container}${slug}.ttl`;
}

/**
 * Predict the URL `publish()` will use for the graph payload.
 *
 * Mirrors the file-naming convention used inside publish() — the
 * payload lives at `<container>/<descriptorSlug>-graph.trig` for
 * plaintext publishes and `<container>/<descriptorSlug>-graph.envelope.jose.json`
 * for encrypted ones. Surfaced as a separate helper so the MCP relay's
 * accept-then-publish path can return a content-addressable graph URL
 * synchronously, before the actual CSS write has completed.
 *
 * The same warning applies as predictDescriptorUrl — if the caller
 * passes custom `containerPath`/`descriptorSlug`/`graphSlug` to publish(),
 * pass them here too.
 */
export function predictGraphUrl(
  podUrl: string,
  descriptorId: string,
  options?: {
    containerPath?: string;
    descriptorSlug?: string;
    graphSlug?: string;
    encrypted?: boolean;
  },
): string {
  const pod = ensureTrailingSlash(podUrl);
  const container = ensureTrailingSlash(`${pod}${options?.containerPath ?? DEFAULT_CONTAINER}`);
  const slug = options?.descriptorSlug ?? slugFromIri(descriptorId);
  const graphSlug = options?.graphSlug ?? `${slug}-graph`;
  return options?.encrypted
    ? `${container}${graphSlug}.envelope.jose.json`
    : `${container}${graphSlug}.trig`;
}

/**
 * Predict the URL `publish()` will use for the manifest. The manifest
 * is per-pod (not per-descriptor), so this only depends on the pod URL.
 */
export function predictManifestUrl(podUrl: string): string {
  const pod = ensureTrailingSlash(podUrl);
  return `${pod}${MANIFEST_PATH}`;
}

// Substrate-level HTTP plumbing (`getDefaultFetch`, `getDefaultWebSocket`,
// `withTransientRetry`) lives in `../http/`. `getDefaultFetch` used to be
// defined and exported from this file — it is re-exported below so the
// historical import path keeps working.
export { getDefaultFetch } from '@interego/core/http';

/**
 * Wrap Turtle triples inside a TriG named graph block.
 *
 * Per W3C TriG (https://www.w3.org/TR/trig/) §2.2, `@prefix` / `@base`
 * directives appear only at document scope, never inside a wrappedGraph
 * `{ ... }` block. The historical implementation indented the caller's
 * `graphContent` verbatim into the named-graph block, which meant any
 * `@prefix` lines embedded in caller-supplied content landed inside
 * the block — a syntax error in strict parsers, and (worse) silently
 * mis-scoped in lenient parsers, so prefixed terms in the content
 * never resolved at document level. This broke SHACL gates that target
 * prefixed IRIs (`ex:Thing`): the shape's target IRI parsed against
 * an unbound prefix, the gate found zero focus nodes, and the shape
 * vacuously conformed.
 *
 * This implementation extracts every `@prefix` / `@base` (and SPARQL
 * `PREFIX` / `BASE`) directive from `graphContent`, re-emits them at
 * document scope, and emits ONLY the remaining triples inside the
 * named-graph block — which inherits the document-level prefix
 * bindings automatically.
 *
 * ★ WHERE THE CALLER'S DIRECTIVES GO, AND WHY IT IS NOT THE TOP. They are emitted
 * immediately BEFORE the named-graph block, after the descriptor's own body — not merged
 * into the descriptor's prefix block. Turtle/TriG directives bind from their position
 * forward, so this order gives the descriptor's triples the descriptor's bindings and the
 * payload's triples the caller's, with no arbitration between them.
 *
 * The implementation used to arbitrate: a caller `@prefix` whose alias the descriptor
 * already bound was DROPPED. The descriptor block binds 23 aliases (`iep cg ieh cgh rdf
 * rdfs xsd owl prov time dct as sh acl vc did dcat ldp solid oa hydra dprod foaf`), so a
 * third-party payload declaring, say, `@prefix as: <https://example.org/assessment#>` had
 * that binding deleted and its `as:` terms silently re-pointed at ActivityStreams. Measured:
 * publishing `<urn:s> as:kind "v"` stored `<urn:s> <https://www.w3.org/ns/activitystreams#kind> "v"`.
 * That is a data-corruption defect on its own, and once authorship proofs began committing
 * to a content digest it became a live false accusation — the served graph no longer
 * denoted what the signer signed, so an entirely honest publish verified as tampering.
 * A check that fails closed on honest data is worse than no check.
 */
/**
 * Does this line open or close a triple-quoted literal — i.e. flip "inside a long literal"?
 *
 * Shared by {@link wrapAsTriG} and {@link extractNamedGraphTurtle} on purpose. The wrap
 * skips indenting lines inside a long literal and the unwrap skips un-indenting them; the
 * moment those two disagree about where a literal starts, the unwrap either eats four
 * characters of a caller's string or leaves four in, and the content digest of an honest
 * record stops matching. One function, so they cannot drift.
 *
 * An odd number of a delimiter on a line flips the state. Both styles are counted
 * independently because `'''` cannot terminate a `"""`.
 */
function flipsLongLiteralState(line: string): boolean {
  let flip = false;
  for (const delim of ['"""', "'''"]) {
    if ((line.split(delim).length - 1) % 2 === 1) flip = !flip;
  }
  return flip;
}

/**
 * ★ EXPORTED SO A TEST CAN SERVE WHAT A POD SERVES. It was private, and every `get_descriptor`
 * double in `tests/workspace-membership.test.ts` therefore set `graph.content` to the RAW
 * payload Turtle instead of the wrapped document `publish()` actually writes. Forty tests
 * carrying the round's headline claim ran against a shape that does not exist, and the defect
 * they were written to catch — a reader whose parse scope was the whole document while the
 * digester covered only the block — is invisible on a document that has no wrap to be outside
 * of. Replicating the wrap in the test file is the same mistake with more code: the copy is
 * the double. This is the emitter itself.
 */
export function wrapAsTriG(
  descriptorTurtle: string,
  graphContent: string,
  graphIri: string,
): string {
  // Extract the descriptor's prefix block — everything up to and
  // including the newline that follows the last `@prefix` directive.
  const prefixEnd = descriptorTurtle.lastIndexOf('@prefix');
  const afterLastPrefix = descriptorTurtle.indexOf('\n', prefixEnd);
  const descriptorPrefixBlock = descriptorTurtle.slice(0, afterLastPrefix + 1);
  const descriptorBody = descriptorTurtle.slice(afterLastPrefix + 1).trim();

  // Identify per-line directives in the caller-supplied graph content.
  // Recognise the four standard forms: `@prefix`, `@base`, SPARQL
  // `PREFIX`, and SPARQL `BASE`. Matched lines are hoisted; everything
  // else is treated as graph body.
  const directiveRe = /^\s*(@prefix\s+\w*:\s*<[^>]+>\s*\.|@base\s+<[^>]+>\s*\.|PREFIX\s+\w*:\s*<[^>]+>|BASE\s+<[^>]+>)\s*$/i;
  const graphLines = graphContent.split('\n');
  const graphDirectives: string[] = [];
  // Each body line paired with whether it began inside a triple-quoted literal, because
  // both rewrites below have to leave those lines alone.
  const graphBodyLines: { readonly text: string; readonly inLiteral: boolean }[] = [];
  // ★ A LINE INSIDE A LONG LITERAL IS TEXT, NOT SYNTAX, and both rewrites used to treat it
  // as syntax. A directive-shaped line was hoisted out of the literal — truncating the
  // string the caller wrote AND injecting a foreign prefix binding at document scope — and
  // every continuation line was indented four spaces, silently changing the literal's
  // value. `<s> <p> """one\n@prefix x: <http://a/> .\nthree"""` was stored as the one-line
  // string "one" under an injected `x:` binding. Track the delimiters so neither happens.
  let insideLongLiteral = false;
  for (const line of graphLines) {
    if (!insideLongLiteral && directiveRe.test(line)) {
      graphDirectives.push(line.trim());
    } else {
      graphBodyLines.push({ text: line, inLiteral: insideLongLiteral });
    }
    insideLongLiteral = flipsLongLiteralState(line) ? !insideLongLiteral : insideLongLiteral;
  }

  // Re-emit the caller's directives verbatim and in their original order, normalising
  // SPARQL-style `PREFIX` / `BASE` to Turtle `@prefix` / `@base` form so the document is
  // syntactically uniform. Nothing is dropped and nothing is de-duplicated: which binding
  // is in force is decided by POSITION below, not by arbitration here.
  const prefixNameRe = /^\s*(?:@prefix|PREFIX)\s+(\w*):/i;
  const callerPrefixLines: string[] = [];
  for (const directive of graphDirectives) {
    const m = directive.match(prefixNameRe);
    if (!m) {
      // @base / BASE — no prefix name to carry; normalise SPARQL form to Turtle.
      callerPrefixLines.push(
        /^\s*BASE\s/i.test(directive)
          ? directive.replace(/^\s*BASE\s+(<[^>]+>)\s*$/i, '@base $1 .')
          : directive,
      );
      continue;
    }
    callerPrefixLines.push(
      /^\s*PREFIX\s/i.test(directive)
        ? directive.replace(/^\s*PREFIX\s+(\w*):\s*(<[^>]+>)\s*$/i, '@prefix $1: $2 .')
        : directive,
    );
  }

  // ★ THE ONE REWRITE HOISTING CANNOT PRESERVE. A payload that binds the same alias twice
  // to different namespaces relies on the directives' positions RELATIVE TO ITS OWN
  // TRIPLES, and hoisting collapses them all to one point — the last binding would win for
  // the whole block, silently re-pointing the terms written before it. There is no ordering
  // of a single block that reproduces it, so refuse rather than store something other than
  // what the caller wrote. Checked semantically, not syntactically: a payload that
  // re-declares an alias it never used in between is unharmed and still publishes.
  const seenCallerNs = new Map<string, string>();
  let aliasRebound: string | null = null;
  for (const directive of callerPrefixLines) {
    const m = directive.match(/^@prefix\s+(\w*):\s*(<[^>]+>)/);
    if (!m) continue;
    const prior = seenCallerNs.get(m[1]!);
    if (prior !== undefined && prior !== m[2]!) aliasRebound = m[1]!;
    seenCallerNs.set(m[1]!, m[2]!);
  }
  if (aliasRebound !== null) {
    const hoisted = `${callerPrefixLines.join('\n')}\n${graphBodyLines.map(l => l.text).join('\n')}\n`;
    if (canonicalGraphDigest(hoisted) !== canonicalGraphDigest(graphContent)) {
      throw new Error(
        `publish: graph content re-binds prefix "${aliasRebound}:" to a second namespace `
        + 'partway through, and terms written before the re-binding resolve differently once '
        + 'the directives are hoisted to document scope. Publishing would store a graph that '
        + 'says something the caller did not write. Give each namespace its own alias.',
      );
    }
  }

  const lines: string[] = [];
  lines.push(descriptorPrefixBlock.trimEnd());
  lines.push('');
  lines.push('# ── Context Descriptor ────────────────────────────');
  lines.push(descriptorBody);
  lines.push('');
  // The caller's bindings sit here — past the descriptor's triples, ahead of the payload's
  // — so each side resolves against its own. Emitting them up in the descriptor's prefix
  // block instead would force one binding on both, which is what the dropping behaviour
  // this replaced was doing.
  if (callerPrefixLines.length > 0) {
    lines.push(callerPrefixLines.join('\n'));
    lines.push('');
  }
  lines.push('# ── Named Graph Content ───────────────────────────');
  lines.push(`<${iescIri(graphIri)}> {`);
  for (const line of graphBodyLines) {
    // Indent for readability, but never a line the caller is still inside a long literal
    // on: those four spaces would become part of the string's value. `extractNamedGraphTurtle`
    // runs the identical state machine so the strip stays exactly symmetric with this.
    lines.push(line.inLiteral || line.text === '' ? line.text : `    ${line.text}`);
  }
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

/**
 * Recover the named graph from a document {@link wrapAsTriG} produced, as standalone
 * Turtle a parser can read on its own.
 *
 * ★ THE INVERSE, AND IT LIVES HERE FOR THAT REASON. A reader verifying an authorship
 * proof's `contentHash` has to digest the same graph the publisher digested, and what it
 * is served is the WRAPPED document — descriptor triples and payload triples in one file,
 * the payload's own `@prefix` lines hoisted to the top and its body indented four spaces.
 * Digesting the served bytes whole would mix the descriptor's triples into the answer and
 * never match. This undoes the wrap; keeping it adjacent to `wrapAsTriG` is what stops the
 * two drifting apart, because a change to the emitter that skipped this function would
 * silently turn every content-bound proof unverifiable.
 *
 * The hoisted prefixes are carried back in deliberately: they are what the payload's
 * abbreviated terms resolve against, so a document served with a rebound prefix yields
 * DIFFERENT triples and a different digest — which is the point of binding to content.
 *
 * Returns null when the block is absent or unterminated, so the caller reports "could not
 * check" rather than digesting a truncated graph.
 */
export function extractNamedGraphTurtle(trig: string, graphIri: string): string | null {
  const opener = `<${iescIri(graphIri)}> {`;
  const open = trig.indexOf(opener);
  if (open < 0) return null;
  const bodyStart = trig.indexOf('\n', open);
  if (bodyStart < 0) return null;
  // The emitter always writes the terminator as `}` alone at column 0, so an unindented
  // brace is the block end and a `}` inside a payload line (blank-node close, collection)
  // is not mistaken for one.
  const close = trig.indexOf('\n}', bodyStart);
  if (close < 0) return null;

  // Exactly the four spaces the emitter added, and only on the lines it added them to: an
  // empty line never got them, and neither did a line inside a triple-quoted literal, whose
  // leading spaces are the caller's own characters. Same state machine as the emitter, run
  // in the same order — decide from the state BEFORE the line, then advance it.
  let insideLongLiteral = false;
  const unindented: string[] = [];
  for (const line of trig.slice(bodyStart + 1, close).split('\n')) {
    unindented.push(!insideLongLiteral && line.startsWith('    ') ? line.slice(4) : line);
    insideLongLiteral = flipsLongLiteralState(line) ? !insideLongLiteral : insideLongLiteral;
  }
  const body = unindented.join('\n');

  const prefixes = trig.slice(0, open)
    .split('\n')
    .filter(line => /^\s*(?:@prefix|@base|PREFIX|BASE)\s/i.test(line))
    .join('\n');

  return `${prefixes}\n${body}\n`;
}

/**
 * The `iep:describes` object of a descriptor — the graph IRI whose block carries the
 * payload. Read from the Turtle rather than reconstructed from the descriptor URL, because
 * the two are related only by the relay's naming convention and a descriptor is free to
 * describe a graph named some other way.
 *
 * Lives here, beside {@link wrapAsTriG} and {@link extractNamedGraphTurtle}, because it is
 * the third of the three things you need to know to say which bytes of a served document a
 * proof covers, and the three have to move together. It used to live in the relay, where the
 * only other party that needs the answer — a reader parsing the payload — could not reach it,
 * and so did not ask.
 */
export function graphIriFromDescriptorTurtle(turtle: string): string | null {
  // `iep:describes <IRI>` in the emitted descriptor; the legacy `cg:` alias is still on
  // pods written before the protocol rename, and refusing to read those would silently
  // downgrade every one of them to unverifiable.
  const m = turtle.match(/\b(?:iep|cg):describes\s+<([^>]+)>/);
  return m ? m[1]! : null;
}

/**
 * Why the digested region of a served document could not be identified. Each is ordinary
 * rather than suspicious, and they are kept apart because a caller renders them differently:
 * `'no-content'` and `'no-graph-iri'` mean "I could not look", `'no-block'` means "I looked
 * and this document is not the shape {@link wrapAsTriG} produces".
 */
export type DigestedRegionFailure = 'no-content' | 'no-graph-iri' | 'no-block';

/** @see digestedGraphRegion */
export type DigestedGraphRegion =
  | { readonly ok: true; readonly turtle: string; readonly graphIri: string }
  | { readonly ok: false; readonly why: DigestedRegionFailure };

/**
 * WHICH BYTES OF A SERVED DOCUMENT AN AUTHORSHIP PROOF COVERS. One function, because two
 * answers to this question is a forgery.
 *
 * ★ THE DEFECT THIS EXISTS TO MAKE UNWRITABLE. The digester and the reader used to answer it
 * separately: `observedGraphDigest` digested `extractNamedGraphTurtle(content, graphIri)` —
 * the block alone — while `membership.ts` handed the WHOLE served document to `parseTrig`.
 * The reader's scope strictly contained the digester's, and everything in the gap was parsed
 * and never digested. A convener could write a `wsp:MembershipAcceptance` into the DEFAULT
 * graph of a document whose named-graph block was a verbatim copy of one of a member's real
 * signed records: the digest came back byte-identical, `contentBinding` came back `'bound'`,
 * and the roster reported that member as a participant with `recordFieldBinding: 'bound'` —
 * with no cooperation from them at all. Measured: the digest of the honest and the tampered
 * document were the same string, `graph-nquads-sha256:19b2cf81…`, before and after the
 * insertion.
 *
 * ★ SO BOTH SIDES CALL THIS, WITH THE SAME TWO STRINGS OUT OF THE SAME RESPONSE. Not
 * `extractNamedGraphTurtle` twice: the graph IRI has to be derived the same way too, and a
 * caller free to derive it its own way is a caller free to digest one region and parse
 * another. There is exactly one argument shape and exactly one place the scope is decided.
 *
 * Returns a reason rather than null so a reader can say WHICH of the three ordinary "I could
 * not look" cases it hit. It must never fall back to the whole document — that fallback is
 * the defect.
 */
export function digestedGraphRegion(args: {
  /** The descriptor Turtle served with the payload; its `iep:describes` names the block. */
  readonly descriptorTurtle: string | null | undefined;
  /** The plaintext graph document as served (the TriG wrap), or null when unreadable. */
  readonly graphContent: string | null | undefined;
}): DigestedGraphRegion {
  const { descriptorTurtle, graphContent } = args;
  if (typeof graphContent !== 'string' || graphContent.length === 0) {
    return { ok: false, why: 'no-content' };
  }
  if (typeof descriptorTurtle !== 'string' || descriptorTurtle.length === 0) {
    return { ok: false, why: 'no-graph-iri' };
  }
  const graphIri = graphIriFromDescriptorTurtle(descriptorTurtle);
  if (graphIri === null || graphIri.length === 0) {
    return { ok: false, why: 'no-graph-iri' };
  }
  const turtle = extractNamedGraphTurtle(graphContent, graphIri);
  if (turtle === null) return { ok: false, why: 'no-block' };
  return { ok: true, turtle, graphIri };
}

/**
 * Build the Hydra Collection header for the manifest.
 * The manifest is a hydra:Collection with hypermedia affordances.
 *
 * Affordances declared:
 *   hydra:operation → PUT (publish new context)
 *   iep:canDiscover  → GET the manifest
 *   iep:canSubscribe → WebSocket via Solid Notifications
 *
 * DPROD alignment:
 *   Each manifest is also a dprod:DataProduct with an outputPort
 *   (the manifest itself as a DCAT distribution).
 *
 * ★ AND — WHEN THE POD IS BOUNDED — WHERE THE REST OF THE INDEX IS.
 *
 * `archiveUrls` adds `iep:manifestArchive <a>, <b>, …` (plus `hydra:view`, the same fact in
 * the vocabulary Hydra already has for a partial view of a collection). A reader learns that
 * this document is a PARTIAL view, and learns where the remainder lives, FROM THE DOCUMENT.
 * Nothing about it is implied by a writer's environment, which is the property the rejected
 * append-only flag did not have.
 *
 * ★ AND THERE IS DELIBERATELY NO `archivedEntryCount`. A mirrored total is a second place
 * for the same fact to live, and the moment a segment is rewritten by one code path and the
 * total by another they disagree — with the count, not the segments, being the thing readers
 * would trust. The links are the truth; a caller that needs a total reads the segments. This
 * is the same refusal `manifestEntryTurtle` makes about `wsp:seq`, for the same reason.
 *
 * Emitting zero archive links (the default) produces a byte-identical header to the one this
 * function has always produced, so an unbounded pod's manifest does not change at all.
 */
function manifestHeaderTurtle(podUrl: string, archiveUrls: readonly string[] = []): string {
  const manifestUrl = `${podUrl}${MANIFEST_PATH}`;
  return [
    `# Interego Manifest — Hydra-aware, DPROD-aligned`,
    ``,
    `<${iescIri(manifestUrl)}> a hydra:Collection, iep:DataProduct ;`,
    ...archiveHeadLines(archiveUrls),
    `    hydra:manages [`,
    `        hydra:property iep:describes ;`,
    `        hydra:object iep:ManifestEntry`,
    `    ] ;`,
    `    # HATEOAS affordances — what agents can do with this manifest`,
    `    hydra:operation [`,
    `        a hydra:Operation ;`,
    `        hydra:method "GET" ;`,
    `        hydra:title "Discover context descriptors" ;`,
    `        hydra:expects <http://www.w3.org/ns/hydra/core#Resource> ;`,
    `        hydra:returns iep:ManifestEntry`,
    `    ] ;`,
    `    hydra:operation [`,
    `        a hydra:Operation ;`,
    `        hydra:method "PUT" ;`,
    `        hydra:title "Publish new context descriptor" ;`,
    `        hydra:expects iep:ContextDescriptor ;`,
    `        hydra:returns iep:ManifestEntry`,
    `    ] ;`,
    `    # Affordance declarations for agent capability discovery`,
    `    iep:affordance iep:canDiscover, iep:canSubscribe ;`,
    `    # DPROD: this manifest is a data product output port`,
    `    iep:outputPort [`,
    `        a dcat:Distribution ;`,
    `        dcat:mediaType "text/turtle" ;`,
    `        dcat:accessURL <${iescIri(manifestUrl)}>`,
    `    ] .`,
  ].join('\n');
}

/**
 * Build a Turtle manifest entry for a published descriptor.
 *
 * `descriptorCid` (optional) is the content-CID of the descriptor's
 * Turtle body. When supplied it's mirrored onto the entry as
 * `iep:contentCid "<cid>"` so CAS supersession gates can compare
 * `if_match` against the head identity without a body GET + rehash.
 *
 * ── WHAT MAY BE MIRRORED HERE, AND WHY `wsp:seq` MAY NOT ──────────
 *
 * Everything below is descriptor-level `iep:`/`dct:` metadata: it is
 * read off `ContextDescriptorData`, and mirroring it only saves a
 * fetch of something the same writer already wrote in the same act.
 *
 * ★ REFUSED, AND NOT FOR TIDINESS. The shared workspace writes a
 * `wsp:seq` on every stream entry, and `verifyChain` has a check that
 * compares it against the position the supersedes links walk the row
 * into — the one check that can catch an entry removed and linked
 * around. It never fires, because the manifest row has no seq. The
 * caller's `graphContent` is in scope where this function is called,
 * so scraping the number out of it and emitting `iep:seq` here is
 * mechanically easy. It would still be wrong:
 *
 *   `verifyChain` takes its links from THIS ROW's mirrored
 *   `iep:supersedes`. Removing an entry and re-pointing its successor
 *   means rewriting the manifest anyway — dropping one row and
 *   editing another's supersedes. Renumbering a mirrored seq in that
 *   same edit costs nothing, so the check would be comparing the
 *   manifest against itself and could never disagree.
 *
 * And it would not fail silent, it would fail LOUD AND WRONG: the
 * report's `declaredSeqChecked` would flip from `false` ("nobody
 * looked", which is true today) to `true` ("the log's own numbering
 * agrees with its links") over a number that is not the log's own.
 *
 * The number is evidence only where it is signed. `wsp:seq` sits
 * inside the named-graph region that `digestedGraphRegion` covers and
 * `sign_authorship` binds, so a tamperer can delete an entry but
 * cannot renumber a survivor without breaking its authorship proof.
 * Reading it therefore costs one `get_descriptor` per entry, and
 * belongs to the caller that is already paying that — not to a
 * cleartext mirror that launders an unsigned value into a signed
 * one's place.
 */
function manifestEntryTurtle(
  descriptorUrl: string,
  descriptor: ContextDescriptorData,
  descriptorCid?: string,
): string {
  const lines: string[] = [];
  lines.push(`<${iescIri(descriptorUrl)}> a iep:ManifestEntry ;`);

  if (descriptorCid) {
    lines.push(`    iep:contentCid "${iescLit(descriptorCid)}" ;`);
  }

  for (const g of descriptor.describes) {
    lines.push(`    iep:describes <${iescIri(g)}> ;`);
  }

  const facetTypes = [...new Set(descriptor.facets.map(f => f.type))];
  for (const ft of facetTypes) {
    lines.push(`    iep:hasFacetType iep:${iescPn(ft)} ;`);
  }

  if (descriptor.validFrom) {
    lines.push(`    iep:validFrom "${iescLit(descriptor.validFrom)}"^^xsd:dateTime ;`);
  }
  if (descriptor.validUntil) {
    lines.push(`    iep:validUntil "${iescLit(descriptor.validUntil)}"^^xsd:dateTime ;`);
  }

  // conformsTo (cleartext-mirrored)
  if (descriptor.conformsTo) {
    for (const c of descriptor.conformsTo) {
      lines.push(`    dct:conformsTo <${iescIri(c)}> ;`);
    }
  }

  // supersedes (cleartext-mirrored — lets downstream code identify
  // head-of-chain entries from the manifest alone, without fetching
  // each descriptor's TriG)
  if (descriptor.supersedes && descriptor.supersedes.length > 0) {
    for (const s of descriptor.supersedes) {
      lines.push(`    iep:supersedes <${iescIri(s)}> ;`);
    }
  }

  // Extract modalStatus from Semiotic facet if present
  const semioticFacet = descriptor.facets.find((f): f is SemioticFacetData => f.type === 'Semiotic');
  if (semioticFacet?.modalStatus) {
    lines.push(`    iep:modalStatus iep:${iescPn(semioticFacet.modalStatus)} ;`);
  }

  // Extract trustLevel + issuer from Trust facet if present
  const trustFacet = descriptor.facets.find((f): f is TrustFacetData => f.type === 'Trust');
  if (trustFacet?.trustLevel) {
    lines.push(`    iep:trustLevel iep:${iescPn(trustFacet.trustLevel)} ;`);
  }
  if (trustFacet?.issuer) {
    // Cleartext-mirror the issuer DID so trust-aware federation readers
    // can filter by author from the manifest alone (no descriptor fetch).
    // iep:issuer is already defined in docs/ns/cg.ttl as "the issuer of
    // the trust assertion (typically a DID)" — exactly what we need here.
    lines.push(`    iep:issuer <${iescIri(trustFacet.issuer)}> ;`);
  }

  // Replace trailing ; with .
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/ ;$/, ' .');

  return lines.join('\n');
}

// ── Bounded manifest: document surgery, archive segments, chain reads ──
//
// ★ WHAT USED TO BE HERE, AND WHY NOTHING IS. An append-only shard scheme once sat at this
// point in the file: each manifest entry written as its own resource under `<pod>cg-entries/`
// (an O(1) PUT instead of the O(entries) whole-manifest CAS rewrite), with `discover()`
// unioning the shard container back over the monolithic manifest, all behind an environment
// flag. It composed, and it was still wrong in two ways that no amount of care at the write
// fixes:
//
//   (a) ELEVEN RAW-MANIFEST READERS NEVER CONSULTED THE FLAG. Only `discover()` knew about the
//       union; everything else that GETs `.well-known/context-graphs` directly — the relay's
//       CID backfill, `get_current_head`, the status paths — kept reading the monolith alone
//       and would have gone blind to every shard-written entry. "The monolith is still the
//       authoritative store" was true only while the flag was OFF; with it on, the sentence
//       described a pod that did not exist.
//   (b) RECOVERY EMITTED A PHANTOM ENTRY PER RECORD. `cg-entries/` sat at the pod ROOT, which
//       `listDescriptorUrls` enumerates, so `rebuild_manifest` re-derived one manifest row per
//       shard on top of the real descriptor row and roughly doubled the index. That made the
//       scheme a ONE-WAY DOOR: once a pod had shard-published, the recovery path could not
//       return it to a correct monolith.
//
// The bounded-manifest design below replaces it and is immune to (b) structurally rather than
// carefully: archive segments live INSIDE `.well-known/`, which `NON_DESCRIPTOR_CONTAINERS`
// already excludes from the descriptor scan. It has no flag, so (a) cannot recur.

/**
 * Take a manifest document apart into the three pieces a roll-over has to move independently:
 * its prefix directives, its collection header, and one RAW TEXT BLOCK per entry.
 *
 * ★ THE BLOCKS STAY AS TEXT, AND THAT IS THE WHOLE POINT. Re-serializing an entry from
 * `parseManifest` output would silently drop every predicate the parser does not model — and
 * it models a fixed list. Moving an entry from the hot document into an archive must move the
 * BYTES, or archiving is lossy in a way nobody would notice until the field that vanished was
 * the one somebody needed.
 *
 * The block boundary is the same one `parseManifest` and the relay's CID backfill already
 * rely on: an entry starts at `<url> a iep:ManifestEntry` and ends at the first line whose
 * trimmed text ends in `.`. Anything before the first entry is header; anything after the
 * last entry's terminator is dropped only if blank.
 */
function splitManifestDocument(turtle: string): { head: string; entries: string[] } {
  const lines = turtle.split('\n');
  const headLines: string[] = [];
  const entries: string[] = [];
  let current: string[] | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (/^<[^>]+>\s+a\s+iep:ManifestEntry/.test(trimmed)) {
      if (current) entries.push(current.join('\n'));
      current = [raw];
      // A single-line entry (`<u> a iep:ManifestEntry .`) opens and closes here.
      if (trimmed.endsWith('.')) { entries.push(current.join('\n')); current = null; }
      continue;
    }
    if (current) {
      current.push(raw);
      if (trimmed.endsWith('.')) { entries.push(current.join('\n')); current = null; }
      continue;
    }
    headLines.push(raw);
  }
  if (current) entries.push(current.join('\n'));
  return { head: headLines.join('\n').trimEnd(), entries };
}

/** The `iep:validFrom` an entry block declares, for ordering a roll-over split. '' when absent. */
function entryBlockValidFrom(block: string): string {
  return block.match(/iep:validFrom\s+"([^"]+)"/)?.[1] ?? '';
}

/**
 * Put the archive links into a manifest's EXISTING head, rather than regenerating one.
 *
 * ★ REGENERATING THE HEAD WOULD DELETE TRIPLES THIS FILE DOES NOT KNOW ABOUT, and at least
 * one consumer depends on some of them: the relay's `resolveContainerShapes` reads
 * container-level `iep:conformsTo` / `dct:conformsTo` off the collection subject and treats
 * their absence as "this pod declares no shape" — a fail-open on a validation gate. Calling
 * `manifestHeaderTurtle` here would have quietly discharged that gate for every pod that
 * rolled over. So the head is edited in place: existing `iep:manifestArchive` / `hydra:view`
 * lines are dropped and the current set is inserted after the collection subject line.
 *
 * Returns null when the collection subject cannot be located. A head this function does not
 * understand is one it must not rewrite — refusing leaves the caller on the unbounded path,
 * which is a known-slow state rather than a corrupted document.
 */
function headWithArchiveLinks(head: string, manifestUrl: string, archiveUrls: readonly string[]): string | null {
  const lines = head.split('\n');
  const escaped = iescIri(manifestUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const subjectRe = new RegExp(`^<${escaped}>\\s+a\\s+`);
  if (!lines.some(l => subjectRe.test(l.trim()))) return null;
  const kept = lines.filter(l => !ARCHIVE_HEAD_LINE.test(l));
  const at = kept.findIndex(l => subjectRe.test(l.trim()));
  if (at < 0) return null;
  const inserted = archiveHeadLines(archiveUrls);
  if (inserted.length === 0) return kept.join('\n');

  // ★ THE SUBJECT LINE MAY BE THE WHOLE STATEMENT, AND THEN IT ENDS IN A FULL STOP.
  //
  // `manifestHeaderTurtle` always emits a multi-predicate stanza whose first line ends in
  // `;`, so inserting after it is valid. But this function edits whatever head the POD is
  // actually serving, and a manifest written by an older build, a hand-repair, or another
  // implementation can perfectly well carry `<url> a hydra:Collection .` on one line.
  // Splicing predicate lines after a terminated statement produces a document CSS will
  // reject — and it would be rejected at the exact moment a pod first grows past the bound,
  // which is the worst possible time to discover it. Re-terminate instead: the anchor gets a
  // `;`, the last inserted line gets the `.`.
  const anchor = kept[at]!;
  const anchorTerminates = anchor.trimEnd().endsWith('.');
  const rewrittenAnchor = anchorTerminates ? anchor.replace(/\.(\s*)$/, ';$1') : anchor;
  const tail = anchorTerminates
    ? [...inserted.slice(0, -1), inserted[inserted.length - 1]!.replace(/;(\s*)$/, '.$1')]
    : inserted;
  return [...kept.slice(0, at), rewrittenAnchor, ...tail, ...kept.slice(at + 1)].join('\n');
}

/**
 * The header of a write-once archive segment.
 *
 * Types it as `hydra:PartialCollectionView` as well as `iep:ManifestArchive` so a client that
 * speaks only Hydra recognises what it is holding, and links BACKWARD via `hydra:previous` /
 * `iep:manifestArchive` to the segment before it. The backward link matters for a reader that
 * arrived at a segment directly rather than through the hot manifest: the chain is walkable
 * from either end, so no segment is reachable only via a document a reader might not have.
 */
function manifestArchiveHeaderTurtle(archiveUrl: string, manifestUrl: string, previousUrl: string | null): string {
  const lines = [
    `# Interego Manifest Archive — a write-once segment of ${manifestUrl}`,
    ``,
    `<${iescIri(archiveUrl)}> a iep:ManifestArchive, hydra:PartialCollectionView ;`,
    `    iep:archiveOf <${iescIri(manifestUrl)}> ;`,
  ];
  if (previousUrl) {
    lines.push(`    iep:manifestArchive <${iescIri(previousUrl)}> ;`);
    lines.push(`    hydra:previous <${iescIri(previousUrl)}> ;`);
  }
  lines.push(`    hydra:view <${iescIri(manifestUrl)}> .`);
  return lines.join('\n');
}

/**
 * Every archive segment a manifest (or archive) document points at, absolutized.
 *
 * Reads `iep:manifestArchive` — the objects may be a comma-separated list on one line, which
 * is how the header emits them. Deliberately tolerant of `hydra:previous` too, so a reader
 * that lands on a segment written by an older build still walks backward.
 */
/**
 * Where to actually FETCH an archive segment a manifest names.
 *
 * ★ MEASURED ON THE LIVE MAINTAINER POD, MINUTES AFTER IT ROLLED OVER. Its manifest is
 * written by the relay against the pod's canonical internal URL, so every archive link reads
 * `http://css.railway.internal:3456/u-eth-.../.well-known/context-graphs-archive-0000`. The
 * relay resolves that fine and reported all 654 rows. An external reader — the same
 * `discover()`, reached through the public gate — cannot resolve that host at all, so all
 * seven segments came back unreachable and `discover()` refused. The refusal is what surfaced
 * it, which is the whole reason it is there; had the union degraded quietly, the pod would
 * have read as 51 entries and nothing would have said otherwise.
 *
 * The canonical IRI in the data is CORRECT and must not be rewritten — it matches the 653
 * descriptor URLs beside it, and this project's rule is that the internal host in stored bytes
 * is canonical and only the fetch target is rebased. So: take the link's LAST PATH SEGMENT and
 * resolve it against the manifest URL. An archive segment is always a sibling of its manifest
 * by construction (`manifestArchiveUrl`), so this reaches the right document from whatever
 * origin the reader used, and it is strictly safer besides — a manifest cannot point a reader
 * at an arbitrary host.
 *
 * Returns null when the name is not one this writer produces. The caller must then treat the
 * link as UNREADABLE rather than ignore it: a link we decline to follow is still a part of the
 * index we did not read, and saying so is the difference between a short answer and a lie.
 */
export function archiveFetchTarget(linkIri: string, manifestUrl: string): string | null {
  let basename: string;
  try {
    basename = new URL(linkIri, manifestUrl).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch { return null; }
  if (!/^context-graphs-archive-\d+$/.test(basename)) return null;
  try { return new URL(basename, manifestUrl).href; } catch { return null; }
}

export function parseManifestArchiveUrls(turtle: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const predicate = /(?:iep:manifestArchive|hydra:previous)\s*((?:<[^>]*>\s*,\s*)*<[^>]*>)/g;
  let m: RegExpExecArray | null;
  while ((m = predicate.exec(turtle)) !== null) {
    for (const iri of m[1]!.matchAll(/<([^>]*)>/g)) {
      let abs: string;
      try { abs = new URL(iri[1]!, baseUrl).href; } catch { continue; }
      if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
    }
  }
  return out;
}

/**
 * The whole index behind a manifest URL: the hot document plus every archive segment it (or
 * they, transitively) link to.
 *
 * ★ `complete` IS THE HONEST-DEGRADATION CONTRACT, AND IT IS THE REASON THIS FUNCTION EXISTS
 * RATHER THAN A LOOP AT EACH CALL SITE. A bounded manifest makes "I read the manifest" and "I
 * have the pod's index" two different statements. Any caller that presents its result as the
 * pod must check `complete`; a caller for which a recent slice is genuinely enough may ignore
 * it. What no caller may do is believe a partial answer is a total one, which is exactly what
 * every reader would do if the union lived inside one consumer's private helper.
 *
 * Segments are fetched in PARALLEL — the hot document lists all of them, so following the
 * chain costs one extra round-trip of latency, not one per segment. The backward
 * `hydra:previous` links are followed too (bounded, cycle-safe), so a segment reachable only
 * from another segment is still found.
 *
 * A pod with no archive links yields exactly `{ bodies: [hot], complete: true }` — the
 * unbounded case is untouched and costs nothing.
 */
export async function fetchManifestChain(
  manifestUrl: string,
  fetchFn: FetchFn,
  options: { maxSegments?: number } = {},
): Promise<{
  hotBody: string | null;
  hotStatus: number;
  archives: Array<{ url: string; body: string }>;
  unreachable: string[];
  complete: boolean;
}> {
  const maxSegments = options.maxSegments ?? MANIFEST_ARCHIVE_MAX_SEGMENTS;
  // 5xx RESPONSES are promoted to throws inside the lambda so `withTransientRetry` actually
  // retries them — a cold-cache 503 arrives as a returned response, not a thrown error, and
  // would otherwise escape the retry loop.
  //
  // ★ THE MESSAGE IS `Failed to fetch manifest from …` ON PURPOSE, NOT AS PHRASING. It is the
  // string `discover()` has always thrown on an unreadable manifest, and callers (and the
  // suite) match on it. Moving the GET into this helper is not supposed to be observable to
  // anyone who was not looking for archives, and an error message is part of what is
  // observable — the whole-suite run caught exactly this when the wording drifted.
  const hotResp = await withTransientRetry(async () => {
    const r = await fetchFn(manifestUrl, { method: 'GET', headers: { 'Accept': TURTLE_CONTENT_TYPE } });
    if (r.status >= 500) {
      throw new Error(`Failed to fetch manifest from ${manifestUrl}: ${r.status} ${r.statusText}`);
    }
    return r;
  }, { maxAttempts: 6, baseMs: 500 });

  if (!hotResp.ok) {
    return { hotBody: null, hotStatus: hotResp.status, archives: [], unreachable: [], complete: hotResp.status === 404 };
  }
  const hotBody = await hotResp.text();

  const archives: Array<{ url: string; body: string }> = [];
  const unreachable: string[] = [];
  const visited = new Set<string>([manifestUrl]);
  // Links are turned into SIBLING fetch targets before anything else, so `visited` keys on
  // what will actually be requested. Keying on the canonical IRI instead would let the same
  // segment be fetched twice under two spellings of its host.
  const targets = (turtle: string, base: string): { ok: string[]; bad: string[] } => {
    const ok: string[] = []; const bad: string[] = [];
    for (const link of parseManifestArchiveUrls(turtle, base)) {
      const t = archiveFetchTarget(link, manifestUrl);
      if (t === null) bad.push(link); else ok.push(t);
    }
    return { ok, bad };
  };
  const first = targets(hotBody, manifestUrl);
  unreachable.push(...first.bad);
  let frontier = first.ok.filter(u => !visited.has(u));
  let truncated = false;
  while (frontier.length > 0) {
    if (visited.size + frontier.length > maxSegments) {
      // Refuse to keep walking, and SAY the view is partial rather than return a silently
      // clipped union — a cap that lies is worse than a cap.
      truncated = true;
      frontier = frontier.slice(0, Math.max(0, maxSegments - visited.size));
    }
    for (const u of frontier) visited.add(u);
    const fetched = await Promise.all(frontier.map(async (url) => {
      try {
        // Same 5xx-as-throw promotion the hot GET uses: a cold-cache 503 on a segment must
        // be retried, not counted as "this segment is unreachable" — that verdict makes
        // `complete` false and (in discover) turns a blip into a refusal.
        const r = await withTransientRetry(async () => {
          const resp = await fetchFn(url, { method: 'GET', headers: { 'Accept': TURTLE_CONTENT_TYPE } });
          if (resp.status >= 500) throw new Error(`archive GET <${url}> failed: ${resp.status} ${resp.statusText}`);
          return resp;
        }, { maxAttempts: 4, baseMs: 300 });
        if (!r.ok) return { url, body: null };
        return { url, body: await r.text() };
      } catch { return { url, body: null }; }
    }));
    const next: string[] = [];
    for (const f of fetched) {
      if (f.body === null) { unreachable.push(f.url); continue; }
      archives.push({ url: f.url, body: f.body });
      const onward = targets(f.body, f.url);
      unreachable.push(...onward.bad);
      for (const link of onward.ok) {
        if (!visited.has(link) && !next.includes(link)) next.push(link);
      }
    }
    if (truncated) break;
    frontier = next;
  }

  return {
    hotBody,
    hotStatus: hotResp.status,
    archives,
    unreachable,
    complete: unreachable.length === 0 && !truncated,
  };
}

/**
 * Every manifest entry a pod's index holds, hot and archived, deduplicated.
 *
 * The hot copy WINS a collision. Roll-over writes the archive segment first and the shortened
 * hot document second (see `rollOverManifest`), so a crash between the two leaves an entry in
 * both — and the hot copy is the one a CAS cycle has been maintaining.
 */
export async function fetchAllManifestEntries(
  manifestUrl: string,
  fetchFn: FetchFn,
  options: { maxSegments?: number } = {},
): Promise<{
  entries: ManifestEntry[];
  complete: boolean;
  archivesFollowed: number;
  archivesUnreachable: string[];
  hotStatus: number;
}> {
  const chain = await fetchManifestChain(manifestUrl, fetchFn, options);
  const absolutize = (u: string): string => {
    try { return new URL(u, manifestUrl).href; } catch { return u; }
  };
  const byUrl = new Map<string, ManifestEntry>();
  // Archives first, hot last, so the hot copy overwrites on collision.
  for (const a of chain.archives) {
    for (const e of parseManifest(a.body)) {
      byUrl.set(absolutize(e.descriptorUrl), {
        ...e,
        descriptorUrl: absolutize(e.descriptorUrl),
        ...(Array.isArray(e.describes) ? { describes: e.describes.map(absolutize) } : {}),
      });
    }
  }
  if (chain.hotBody !== null) {
    for (const e of parseManifest(chain.hotBody)) {
      byUrl.set(absolutize(e.descriptorUrl), {
        ...e,
        descriptorUrl: absolutize(e.descriptorUrl),
        ...(Array.isArray(e.describes) ? { describes: e.describes.map(absolutize) } : {}),
      });
    }
  }
  return {
    entries: [...byUrl.values()],
    complete: chain.complete,
    archivesFollowed: chain.archives.length,
    archivesUnreachable: chain.unreachable,
    hotStatus: chain.hotStatus,
  };
}

/**
 * Move the oldest entries out of a hot manifest body into fresh write-once archive segments,
 * and return the shortened body the caller should PUT.
 *
 * ★ ROLL-OVER IS ITSELF A WRITE, AND IT IS BOUNDED BY THE SAME NUMBER THE STEADY STATE IS.
 * Every segment this writes holds at most `MANIFEST_HOT_LIMIT` entries, so its PUT costs what
 * a full hot manifest costs — the very quantity the threshold was measured to keep safe. A
 * pod that is far over the limit (the maintainer's, at 653) does NOT get one enormous archive
 * PUT that fails the same way the manifest did; it gets ⌈evicted / limit⌉ bounded PUTs. That
 * is the difference between fixing the failure and relocating it.
 *
 * ★ AND THE ORDER IS ARCHIVE-FIRST, DELIBERATELY. Each segment is PUT and its success checked
 * BEFORE the shortened hot body is returned for its own PUT. Interrupted between the two, the
 * pod holds an archive whose entries are still in the hot manifest — duplication, which the
 * reader's dedupe absorbs. The opposite order would shorten the hot document while the
 * archive did not exist, which is entry loss, which is the one outcome that is unacceptable.
 *
 * Newest entries stay hot (ordered by the `iep:validFrom` each block declares), so the
 * degraded view an unaware reader gets is the RECENT slice — the slice for which "recent is
 * enough" is a defensible verdict.
 */
async function rollOverManifest(
  pod: string,
  hotBody: string,
  fetchFn: FetchFn,
  /**
   * ★ THE ENTRY THIS PUBLISH IS ADDING, WHICH MUST NOT BE THE ONE THAT GETS ARCHIVED.
   *
   * The split orders by `iep:validFrom`, and `manifestEntryTurtle` emits that predicate only
   * when the descriptor declares one. A descriptor without it sorts to the OLDEST end — so a
   * publish of such a descriptor would archive its own brand-new entry, the post-PUT
   * verify-GET would not find it in the hot document, the CAS loop would read that as a
   * concurrent clobber, and eight attempts later the caller would be told the write failed
   * over a write that was fine. Pinning the row being added is what keeps the verify honest.
   */
  pinnedDescriptorUrl?: string,
): Promise<{ body: string; archiveUrls: string[]; segmentsWritten: string[] } | null> {
  const { head, entries } = splitManifestDocument(hotBody);
  if (entries.length <= MANIFEST_HOT_LIMIT) return null;
  const manifestUrlForHead = `${pod}${MANIFEST_PATH}`;
  // Segments the document already links, in document order — the last is the newest, which is
  // what a fresh segment's `hydra:previous` must point at.
  const existingArchiveUrls = parseManifestArchiveUrls(head, manifestUrlForHead);
  // Refuse before writing anything if the head cannot carry the links: a segment written for
  // a manifest that will never reference it is pure garbage.
  if (headWithArchiveLinks(head, manifestUrlForHead, existingArchiveUrls) === null) return null;

  // Newest-first by declared validFrom; blocks with none sink to the oldest end (they are
  // pre-validFrom rows, and "no declared start" is the same tiebreak discover() uses).
  const ordered = [...entries].sort((a, b) => {
    const av = entryBlockValidFrom(a);
    const bv = entryBlockValidFrom(b);
    if (av === bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return av < bv ? 1 : -1;
  });
  const isPinned = (block: string): boolean =>
    pinnedDescriptorUrl !== undefined
    && block.trimStart().startsWith(`<${pinnedDescriptorUrl}>`);
  const pinned = ordered.filter(isPinned);
  const rest = ordered.filter(b => !isPinned(b));
  const keep = [...pinned, ...rest.slice(0, Math.max(0, MANIFEST_HOT_KEEP - pinned.length))];
  const evict = rest.slice(Math.max(0, MANIFEST_HOT_KEEP - pinned.length)).reverse(); // oldest first, so segments read chronologically

  const manifestUrl = manifestUrlForHead;
  const prefixes = turtlePrefixes(['iep', 'xsd', 'hydra', 'dcat', 'dprod', 'dct']);
  // Next free index: one past the highest already in use. Derived from the URLs the manifest
  // already links rather than from a listing, so it cannot race a container that has not
  // caught up.
  let nextIndex = 0;
  for (const u of existingArchiveUrls) {
    const n = Number(u.match(/-(\d+)$/)?.[1] ?? NaN);
    if (Number.isFinite(n) && n >= nextIndex) nextIndex = n + 1;
  }
  let previous = existingArchiveUrls.length > 0 ? existingArchiveUrls[existingArchiveUrls.length - 1]! : null;
  const written: string[] = [];
  for (let i = 0; i < evict.length; i += MANIFEST_HOT_LIMIT) {
    const chunk = evict.slice(i, i + MANIFEST_HOT_LIMIT);
    const url = manifestArchiveUrl(pod, nextIndex++);
    const body = `${prefixes}\n\n${manifestArchiveHeaderTurtle(url, manifestUrl, previous)}\n\n${chunk.join('\n\n')}\n`;
    const resp = await withTransientRetry(async () => {
      const r = await fetchFn(url, { method: 'PUT', headers: { 'Content-Type': TURTLE_CONTENT_TYPE }, body });
      if (r.status >= 500) throw new Error(`archive PUT <${url}> failed: ${r.status} ${r.statusText}`);
      return r;
    });
    if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
      // Abandon the roll-over and leave the hot manifest untouched. Segments already written
      // are orphans the reader dedupes away, and the next publish retries from a consistent
      // hot document. Throwing here would fail a publish whose descriptor already landed.
      throw new Error(`Failed to write manifest archive ${url}: ${resp.status} ${resp.statusText}`);
    }
    written.push(url);
    previous = url;
  }

  const archiveUrls = [...existingArchiveUrls, ...written];
  const newHead = headWithArchiveLinks(head, manifestUrl, archiveUrls);
  // Re-checked rather than asserted: the same input passed the pre-flight above, so a null
  // here would mean the head changed underneath us. Leaving the caller unbounded beats
  // emitting a manifest whose head we could not compose.
  if (newHead === null) return null;
  return { body: `${newHead.trimEnd()}\n\n${keep.join('\n\n')}\n`, archiveUrls, segmentsWritten: written };
}

/**
 * Bring a pod's hot manifest back under the bound, as its OWN committed step, before any
 * append is attempted.
 *
 * ★ WHY THIS IS NOT INSIDE THE APPEND'S CAS LOOP, WHICH IS WHERE IT STARTED.
 *
 * Measured live on a 400-entry disposable pod: the roll-over ran INSIDE the retry loop, the
 * append's conditional PUT did not take on the first attempt, and attempt two re-derived the
 * same split and rewrote all four archive segments — 8 segment PUTs for 4 segments, and a
 * single publish that took 25.7 SECONDS. Nothing was lost (the indices are derived from the
 * manifest's own links, so a retry overwrites rather than orphans) and no individual write
 * came near the lock, but a retry that costs sixteen seconds of duplicated work is a retry
 * that will eventually not finish.
 *
 * Hoisting it fixes the cause rather than the symptom: compaction owns its own small CAS, and
 * once it commits, the append loop is operating on a ~50-entry document where a 412 costs one
 * cheap PUT. The two operations retry independently at their own price.
 *
 * Idempotent by construction: segment indices come from the links the manifest already
 * carries, so a compaction that wrote segments and then lost its CAS re-derives the SAME
 * indices next time and overwrites them. There is no index counter to get out of step.
 *
 * ★ AND IT HANDS ITS READ BACK, SO THE COMMON CASE COSTS NOTHING.
 *
 * Compaction has to GET the manifest to know whether the pod is over the bound, and the
 * append below GETs it too. On the overwhelmingly common path — a pod inside the bound,
 * nothing to do — that would be a second manifest GET added to every publish in the system,
 * for a feature that does not fire. So when it declines, it returns the body and ETag it just
 * read and the append's first attempt uses them instead of fetching again: the request count
 * is exactly what it was before this existed.
 *
 * When it DOES compact it returns no priming, deliberately. The ETag it holds is the one from
 * before its own PUT, and CSS does not reliably return a fresh one on PUT, so priming with it
 * would hand the append a stale precondition and manufacture a 412 — the same self-inflicted
 * conflict `withTransientRetry` around the conditional PUT used to cause.
 */
interface CompactionOutcome {
  /** Archive segments written, if any. */
  readonly segments: string[];
  /** The manifest as read, when it is still current and the append may reuse it. */
  readonly primed: { body: string; etag: string | null } | null;
}

async function compactManifestIfNeeded(
  pod: string,
  manifestUrl: string,
  fetchFn: FetchFn,
): Promise<CompactionOutcome> {
  const maxAttempts = 4;
  const segments: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp: Awaited<ReturnType<FetchFn>>;
    try {
      resp = await withTransientRetry(async () => {
        const r = await fetchFn(manifestUrl, { method: 'GET', headers: { 'Accept': TURTLE_CONTENT_TYPE } });
        if (r.status >= 500) {
          throw new Error(`Failed to fetch manifest from ${manifestUrl}: ${r.status} ${r.statusText}`);
        }
        return r;
      });
    } catch {
      return { segments, primed: null }; // The append loop reports an unreadable manifest, not us.
    }
    if (!resp.ok) return { segments, primed: null }; // 404 cold start, or a 4xx the append surfaces.
    const body = await resp.text();
    const etag = resp.headers?.get('etag') ?? null;
    const rolled = await rollOverManifest(pod, body, fetchFn);
    // Already inside the bound — the common path. Hand the read forward.
    if (!rolled) return { segments, primed: { body, etag } };
    for (const s of rolled.segmentsWritten) if (!segments.includes(s)) segments.push(s);

    const headers: Record<string, string> = { 'Content-Type': TURTLE_CONTENT_TYPE };
    if (etag) headers['If-Match'] = etag;
    const put = await fetchFn(manifestUrl, { method: 'PUT', headers, body: rolled.body });
    if (put.ok) return { segments, primed: null };
    // Lost the CAS, or the server was unhappy. Back off and re-read: another writer may have
    // compacted already, in which case the next iteration finds the pod inside the bound and
    // returns without writing anything.
    await new Promise(r => setTimeout(r, Math.min(200 * attempt, 1000) + Math.floor(Math.random() * 200)));
  }
  // ★ NOT AN ERROR. Compaction is an optimisation on the write path, and the append below is
  // correct either way — it will just be the slow, whole-document write this exists to avoid.
  // Failing the publish here would turn a performance measure into an availability risk.
  return { segments, primed: null };
}

// ── Manifest parsing ────────────────────────────────────────

/**
 * Parse a Turtle manifest into ManifestEntry[].
 *
 * Expects the lightweight format written by publish():
 *   <url> a iep:ManifestEntry ;
 *       iep:describes <graph> ;
 *       iep:hasFacetType iep:Temporal ;
 *       iep:validFrom "..."^^xsd:dateTime .
 */
export function parseManifest(turtle: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  let current: {
    descriptorUrl: string;
    cid?: string;
    describes: string[];
    facetTypes: ContextTypeName[];
    validFrom?: string;
    validUntil?: string;
    modalStatus?: ModalStatus;
    trustLevel?: TrustLevel;
    issuer?: string;
    conformsTo?: string[];
    supersedes?: string[];
    pgslUri?: string;
    pgslLevel?: number;
  } | null = null;

  const finalize = (
    e: NonNullable<typeof current>,
  ): ManifestEntry => {
    // Reconstruct the minimal facet set the manifest mirrors so that
    // trust-aware readers can filter by facet shape without re-fetching
    // each descriptor's TriG. Only the fields the manifest itself
    // carries are populated; everything else stays in the descriptor.
    //
    // Trust-facet reconstruction has two trigger paths:
    //   (a) trustLevel and/or issuer were directly extracted from the
    //       manifest entry by the regex sweep above — populate the facet
    //       with whichever fields landed.
    //   (b) the manifest declared `iep:hasFacetType iep:Trust` for the entry
    //       but neither trustLevel nor issuer were captured. This can
    //       happen when an upstream serializer flattens or re-orders the
    //       entry. Still emit a Trust facet so trust-aware readers see the
    //       declared shape; they will fall back to the descriptor for the
    //       missing fields rather than misclassify the entry as untrusted.
    const facets: ContextFacetData[] = [];
    const hasTrustFacetType = e.facetTypes.includes('Trust' as ContextTypeName);
    if (e.trustLevel || e.issuer || hasTrustFacetType) {
      const tf: { type: 'Trust'; trustLevel?: TrustLevel; issuer?: IRI } = { type: 'Trust' };
      if (e.trustLevel) tf.trustLevel = e.trustLevel;
      if (e.issuer) tf.issuer = e.issuer as IRI;
      facets.push(tf as ContextFacetData);
    }
    if (e.modalStatus) {
      facets.push({ type: 'Semiotic', modalStatus: e.modalStatus } as ContextFacetData);
    }
    const out: ManifestEntry = {
      descriptorUrl: e.descriptorUrl,
      ...(e.cid !== undefined ? { cid: e.cid } : {}),
      describes: e.describes,
      facetTypes: e.facetTypes,
      ...(e.validFrom !== undefined ? { validFrom: e.validFrom } : {}),
      ...(e.validUntil !== undefined ? { validUntil: e.validUntil } : {}),
      ...(e.modalStatus !== undefined ? { modalStatus: e.modalStatus } : {}),
      ...(e.trustLevel !== undefined ? { trustLevel: e.trustLevel } : {}),
      ...(e.issuer !== undefined ? { issuer: e.issuer } : {}),
      ...(e.conformsTo !== undefined ? { conformsTo: e.conformsTo } : {}),
      ...(e.supersedes !== undefined ? { supersedes: e.supersedes } : {}),
      ...(e.pgslUri !== undefined ? { pgslUri: e.pgslUri } : {}),
      ...(e.pgslLevel !== undefined ? { pgslLevel: e.pgslLevel } : {}),
      ...(facets.length > 0 ? { facets } : {}),
    };
    return out;
  };

  for (const rawLine of turtle.split('\n')) {
    const line = rawLine.trim();

    const entryMatch = line.match(/^<([^>]+)>\s+a\s+iep:ManifestEntry/);
    if (entryMatch) {
      if (current) {
        entries.push(finalize(current));
      }
      current = {
        descriptorUrl: entryMatch[1]!,
        describes: [],
        facetTypes: [],
      };
      continue;
    }

    if (!current) continue;

    const cidMatch = line.match(/iep:contentCid\s+"([^"]+)"/);
    if (cidMatch) {
      current.cid = cidMatch[1]!;
    }

    const describesMatch = line.match(/iep:describes\s+<([^>]+)>/);
    if (describesMatch) {
      current.describes.push(describesMatch[1]!);
    }

    const facetMatch = line.match(/iep:hasFacetType\s+iep:(\w+)/);
    if (facetMatch) {
      current.facetTypes.push(facetMatch[1]! as ContextTypeName);
    }

    const fromMatch = line.match(/iep:validFrom\s+"([^"]+)"/);
    if (fromMatch) {
      current.validFrom = fromMatch[1]!;
    }

    const untilMatch = line.match(/iep:validUntil\s+"([^"]+)"/);
    if (untilMatch) {
      current.validUntil = untilMatch[1]!;
    }

    const modalMatch = line.match(/iep:modalStatus\s+iep:(\w+)/);
    if (modalMatch) {
      current.modalStatus = modalMatch[1]! as ModalStatus;
    }

    const trustMatch = line.match(/iep:trustLevel\s+iep:(\w+)/);
    if (trustMatch) {
      current.trustLevel = trustMatch[1]! as TrustLevel;
    }

    const issuerMatch = line.match(/iep:issuer\s+<([^>]+)>/);
    if (issuerMatch) {
      current.issuer = issuerMatch[1]!;
    }

    const conformsMatch = line.match(/dct:conformsTo\s+<([^>]+)>/);
    if (conformsMatch) {
      current.conformsTo = current.conformsTo ?? [];
      current.conformsTo.push(conformsMatch[1]!);
    }

    const supersedesMatch = line.match(/iep:supersedes\s+<([^>]+)>/);
    if (supersedesMatch) {
      current.supersedes = current.supersedes ?? [];
      current.supersedes.push(supersedesMatch[1]!);
    }

    // PGSL lattice pointer (Stage 3 projection) — links a manifest row back to
    // the holon it projects. Content-addressed, so structural overlap across
    // pods is detectable from the manifest alone. Additive: legacy rows omit it.
    const pgslUriMatch = line.match(/iep:pgslUri\s+<([^>]+)>/);
    if (pgslUriMatch) {
      current.pgslUri = pgslUriMatch[1]!;
    }
    const pgslLevelMatch = line.match(/iep:pgslLevel\s+"(\d+)"/);
    if (pgslLevelMatch) {
      current.pgslLevel = Number(pgslLevelMatch[1]);
    }

    if (line.endsWith('.')) {
      if (current) {
        entries.push(finalize(current));
        current = null;
      }
    }
  }

  if (current) {
    entries.push(finalize(current));
  }

  return entries;
}

// ── Manifest reconstruction (heals f-manifest-collapse) ─────────────
//
// The manifest at <pod>/.well-known/context-graphs is an INDEX, not the
// authority — every descriptor + payload is content-addressed and
// fetchable by URL, and supersession links live inside the descriptors.
// So a lost/truncated index is fully recoverable by scanning the on-pod
// descriptors and rebuilding one entry each. Used by (a) publish()'s
// 404-heal path so a missing manifest is never replaced by a 1-entry
// stub, and (b) the relay's /admin/rebuild-manifest one-shot restore.

const _fetchFallback: FetchFn = (async (url, init) => {
  const r = await fetch(url, init as RequestInit);
  return {
    ok: r.ok, status: r.status, statusText: r.statusText,
    headers: { get: (n: string) => r.headers.get(n) },
    text: () => r.text(), json: () => r.json(),
  };
}) as FetchFn;

/**
 * Build a single manifest entry from a descriptor's Turtle by extracting
 * the indexable fields (describes, validFrom, conformsTo, supersedes,
 * facet types, modalStatus, trustLevel, contentCid) — mirrors the shape
 * `manifestEntryTurtle` emits. Returns null if the Turtle has no
 * `iep:describes` (i.e. it isn't a descriptor).
 */
function manifestEntryFromDescriptorTurtle(descriptorUrl: string, ttl: string): string | null {
  const grabAll = (src: string): string[] => {
    const out: string[] = []; const re = new RegExp(src, 'g'); let m: RegExpExecArray | null;
    while ((m = re.exec(ttl)) !== null) out.push(m[1]!);
    return out;
  };
  const describes = grabAll('iep:describes\\s+<([^>]+)>');
  if (describes.length === 0) return null;
  const one = (src: string): string | undefined => (ttl.match(new RegExp(src)) ?? [])[1];
  const validFrom = one('iep:validFrom\\s+"([^"]+)"');
  const validUntil = one('iep:validUntil\\s+"([^"]+)"');
  const conformsTo = grabAll('dct:conformsTo\\s+<([^>]+)>');
  const supersedes = grabAll('iep:supersedes\\s+<([^>]+)>');
  const facetTypes = [...new Set(grabAll('a\\s+iep:(\\w+)Facet\\b'))]; // 'TemporalFacet' → 'Temporal'
  const modalStatus = one('iep:modalStatus\\s+iep:(\\w+)');
  const trustLevel = one('iep:trustLevel\\s+iep:(\\w+)');
  const issuer = one('iep:issuer\\s+<([^>]+)>');
  const cid = one('iep:contentCid\\s+"([^"]+)"');

  const lines: string[] = [`<${iescIri(descriptorUrl)}> a iep:ManifestEntry ;`];
  if (cid) lines.push(`    iep:contentCid "${cid}" ;`);
  for (const g of describes) lines.push(`    iep:describes <${iescIri(g)}> ;`);
  for (const ft of facetTypes) lines.push(`    iep:hasFacetType iep:${iescPn(ft)} ;`);
  if (validFrom) lines.push(`    iep:validFrom "${validFrom}"^^xsd:dateTime ;`);
  if (validUntil) lines.push(`    iep:validUntil "${validUntil}"^^xsd:dateTime ;`);
  for (const c of conformsTo) lines.push(`    dct:conformsTo <${iescIri(c)}> ;`);
  for (const s of supersedes) lines.push(`    iep:supersedes <${iescIri(s)}> ;`);
  if (modalStatus) lines.push(`    iep:modalStatus iep:${modalStatus} ;`);
  if (trustLevel) lines.push(`    iep:trustLevel iep:${trustLevel} ;`);
  if (issuer) lines.push(`    iep:issuer <${iescIri(issuer)}> ;`);
  lines[lines.length - 1] = lines[lines.length - 1]!.replace(/;\s*$/, '.');
  return lines.join('\n');
}

/** List the descriptor (.ttl, NOT -graph.trig) URLs in a pod's context-graphs/ container. */
// Pod-root containers that never hold cg descriptors/credentials — skipped on a
// pod-wide manifest scan (don't walk a huge LDN inbox or profile docs).
const NON_DESCRIPTOR_CONTAINERS = new Set(['inbox/', '.well-known/', 'profile/', 'settings/']);

/**
 * Read a container's DECLARED membership — the objects of its `ldp:contains`
 * (the LDP membership *control* the container publishes), resolved against the
 * container base. We follow the hypermedia the container advertises rather than
 * inferring membership from filename shape: a regex over filenames is exactly
 * what silently dropped %-encoded credential names and whole containers. Walks
 * the object list after each ldp:contains (prefixed or full-IRI), tolerant of
 * dotted IRIs (`…/1781.ttl`) since each object is delimited by its own `<>`.
 */
function ldpContainsMembers(body: string, base: string): string[] {
  const out: string[] = [];
  const predRe = /(?:ldp:contains|<http:\/\/www\.w3\.org\/ns\/ldp#contains>)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = predRe.exec(body)) !== null) {
    let i = pm.index + pm[0].length;
    // Collect the comma/whitespace-separated <…> objects until the statement
    // boundary (a token that is not a separator or another <…>).
    for (;;) {
      while (i < body.length && /[\s,]/.test(body[i]!)) i++;
      if (body[i] !== '<') break;
      const end = body.indexOf('>', i);
      if (end < 0) break;
      const ref = body.slice(i + 1, end);
      try { out.push(new URL(ref, base).toString()); } catch { /* skip malformed */ }
      i = end + 1;
    }
  }
  return out;
}

async function listDescriptorUrls(pod: string, fetchFn: FetchFn): Promise<string[]> {
  // Membership comes from each container's advertised `ldp:contains`, NOT a
  // filename regex. Enumerate the pod's child containers from the root's
  // ldp:contains (minus known system ones), always including the two we know
  // hold manifest content, then read each container's ldp:contains members.
  // Non-descriptor members are filtered downstream by
  // manifestEntryFromDescriptorTurtle (it reads each member's declared type), so
  // the only filename heuristic left is distinguishing a descriptor (`.ttl`)
  // from its own graph payload (`-graph.trig`) — both are real declared members.
  const containers = new Set<string>([`${pod}${DEFAULT_CONTAINER}`, `${pod}foxxi-wallet/`]);
  try {
    const root = await fetchFn(pod, { method: 'GET', headers: { Accept: TURTLE_CONTENT_TYPE } });
    if (root.ok) {
      for (const member of ldpContainsMembers(await root.text(), pod)) {
        if (member.startsWith(pod) && member.endsWith('/') && member !== pod
            && !NON_DESCRIPTOR_CONTAINERS.has(member.slice(pod.length))) {
          containers.add(member);
        }
      }
    }
  } catch { /* fall back to the known containers below */ }

  const urls = new Set<string>();
  for (const containerUrl of containers) {
    let r: Awaited<ReturnType<FetchFn>>;
    try { r = await fetchFn(containerUrl, { method: 'GET', headers: { Accept: TURTLE_CONTENT_TYPE } }); }
    catch (e) { throw new Error(`container GET <${containerUrl}> failed: ${(e as Error).message}`); }
    if (r.status === 404) continue;                       // missing container (e.g. no foxxi-wallet yet) — fine
    // Any non-404 failure aborts the rebuild rather than PUT a PARTIAL manifest
    // (a transient 5xx must not silently drop a whole container's entries).
    if (!r.ok) throw new Error(`container GET <${containerUrl}> -> ${r.status} ${r.statusText}`);
    for (const member of ldpContainsMembers(await r.text(), containerUrl)) {
      if (member.endsWith('.ttl') && !member.endsWith('-graph.trig')) urls.add(member);
    }
  }
  return [...urls];
}

/**
 * Compose the full manifest body for a pod from its on-pod descriptors.
 * Scans the container, fetches each descriptor, and rebuilds an entry
 * per descriptor. Returns { body, scanned, written }.
 */
async function buildManifestBodyFromPod(
  pod: string,
  fetchFn: FetchFn,
): Promise<{ body: string; scanned: number; written: number }> {
  const descriptorUrls = await listDescriptorUrls(pod, fetchFn);
  const entries: string[] = [];
  await Promise.allSettled(descriptorUrls.map(async durl => {
    try {
      const r = await fetchFn(durl, { method: 'GET', headers: { Accept: TURTLE_CONTENT_TYPE } });
      if (!r.ok) return;
      const entry = manifestEntryFromDescriptorTurtle(durl, await r.text());
      if (entry) entries.push(entry);
    } catch { /* skip unreadable descriptor */ }
  }));
  const prefixes = turtlePrefixes(['iep', 'xsd', 'hydra', 'dcat', 'dprod', 'dct']);
  const body = `${prefixes}\n\n${manifestHeaderTurtle(pod)}\n\n${entries.join('\n\n')}\n`;
  return { body, scanned: descriptorUrls.length, written: entries.length };
}

/**
 * Foundation-first manifest rebuild — render the recovery manifest from a
 * PGSL lattice slice instead of scanning the pod's descriptor files.
 *
 * This inverts {@link buildManifestBodyFromPod}: the lattice is the source
 * of truth, so the manifest is a deterministic render of a slice of it
 * (`projectLatticeSlice` → `renderManifestBody`) rather than a scan +
 * filename-heuristic reconstruction (the recurring manifest-collapse
 * failure mode). It also PUTs each projected descriptor (best-effort, via
 * Promise.allSettled) so the pod's descriptor resources match the manifest
 * it returns.
 *
 * Boundary-pure: `@interego/pgsl` is reached ONLY through the dynamic-import
 * escape hatch (no static import), so the Solid binding keeps zero
 * compile-time dependency on pgsl.
 *
 * @param pgsl A `PGSLInstance` (typed `unknown` to avoid the pgsl type dep).
 * @returns `{ body, written }` — the rendered manifest body + how many
 *          descriptors it covers; `written === 0` signals the caller to
 *          fall through to the RDF scan.
 */
async function buildManifestFromPGSL(
  pgsl: unknown,
  descriptorBase: string,
  fetchFn: FetchFn,
): Promise<{ body: string; written: number }> {
  const dyn = Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
  const mod = await dyn('@interego/pgsl') as {
    projectLatticeSlice: (
      pgsl: unknown,
      uris: readonly string[],
      opts: { descriptorBase: string; typedFacets?: boolean },
    ) => { entries: readonly unknown[]; descriptors: ReadonlyMap<string, string> };
    renderManifestBody: (entries: readonly unknown[]) => string;
  };
  // The slice is every node currently in the lattice. `.nodes` is a
  // Map<uri, Node>; project all of them (projectLatticeSlice skips any URI
  // it can't resolve, so this is safe even mid-build).
  const nodes = (pgsl as { nodes?: Map<string, unknown> }).nodes;
  const uris = nodes ? [...nodes.keys()] : [];
  const slice = mod.projectLatticeSlice(pgsl, uris, { descriptorBase, typedFacets: true });
  // Write each projected descriptor (best-effort — a transient PUT failure
  // on one descriptor must not abort the whole rebuild).
  await Promise.allSettled(
    [...slice.descriptors.entries()].map(async ([durl, turtle]) => {
      const r = await fetchFn(durl, {
        method: 'PUT',
        headers: { 'Content-Type': TURTLE_CONTENT_TYPE },
        body: turtle,
      });
      if (!r.ok) throw new Error(`descriptor PUT <${durl}> -> ${r.status} ${r.statusText}`);
    }),
  );
  const body = mod.renderManifestBody(slice.entries);
  return { body, written: slice.entries.length };
}

/**
 * Reconstruct + write a pod's manifest from its on-pod descriptors.
 * One-shot heal for a collapsed/lost index. Overwrites the manifest
 * (no CAS — this is an operator restore). Returns counts.
 *
 * ── WHY RECOVERY IS THE PART THAT DECIDES WHETHER A BOUNDING SCHEME IS SOUND ──
 *
 * ★ THE APPEND-ONLY SHARD ATTEMPT DIED HERE, NOT AT THE WRITE. Its shards sat at the pod ROOT
 * in `cg-entries/`, which `listDescriptorUrls` happily enumerated, so a rebuild emitted a
 * phantom manifest row per shard and roughly doubled the index — making the scheme a one-way
 * door. The archive is immune for a structural reason, not a careful one: segments live
 * inside `.well-known/`, which `NON_DESCRIPTOR_CONTAINERS` already excludes from the scan. A
 * rebuild therefore sees exactly the descriptors and nothing the index wrote about them.
 *
 * ★ AND RECOVERY IS THE REVERSIBILITY PATH. This function derives the shape from the COUNT it
 * found, never from what the pod previously was: at or under the bound it writes one plain
 * unbounded manifest with no archive links, and DELETES every segment it can see. So a pod
 * that has been bounded goes back to unbounded by shrinking below the bound and rebuilding —
 * the code path is the ordinary one, not a special migration. Above the bound there is no way
 * back, because an unbounded manifest at that size is the write that cannot land; that is the
 * defect, not a property of this design.
 *
 * The rebuild's own writes are bounded the same way a publish's are: segments of at most
 * MANIFEST_HOT_LIMIT entries each, so healing a 653-descriptor pod is a sequence of ~2-second
 * PUTs rather than the single 6-second-lock-losing PUT it used to be. Before this change
 * `rebuild_manifest` could not complete on the maintainer's pod at all.
 */
export async function rebuildManifestFromPod(
  podUrl: string,
  opts: { fetch?: FetchFn; log?: (m: string) => void } = {},
): Promise<{ scanned: number; written: number; manifestUrl: string; archives: string[]; archivesDeleted: string[] }> {
  const fetchFn = opts.fetch ?? _fetchFallback;
  const log = opts.log ?? (() => {});
  const pod = podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
  const manifestUrl = `${pod}${MANIFEST_PATH}`;
  const { body, scanned, written } = await buildManifestBodyFromPod(pod, fetchFn);

  // Every segment the CURRENT index links, so the rebuild can retire the ones it no longer
  // needs. Read before anything is written; a failure to read them is not fatal (they are
  // then simply overwritten or left, and the entries they hold are re-derived from the
  // descriptors either way).
  const priorArchives = await (async (): Promise<string[]> => {
    try {
      const r = await fetchFn(manifestUrl, { method: 'GET', headers: { Accept: TURTLE_CONTENT_TYPE } });
      if (!r.ok) return [];
      return parseManifestArchiveUrls(await r.text(), manifestUrl);
    } catch { return []; }
  })();

  // Split by the same rule publish() uses. `rollOverManifest` needs a document to split, and
  // `body` is exactly that — it writes the segments and hands back the shortened hot body.
  const rolled = await rollOverManifest(pod, body, fetchFn);
  const finalBody = rolled?.body ?? body;
  const archives = rolled?.archiveUrls ?? [];

  const put = await fetchFn(manifestUrl, { method: 'PUT', headers: { 'Content-Type': TURTLE_CONTENT_TYPE }, body: finalBody });
  if (!put.ok) throw new Error(`manifest PUT <${manifestUrl}> -> ${put.status} ${put.statusText}`);

  // Retire segments the rebuilt index does not reference. Done AFTER the manifest lands, so
  // an interruption leaves stale-but-unreferenced documents rather than referenced-but-gone
  // ones. Best-effort: a segment that will not delete is unreachable from the new manifest
  // and therefore invisible to every reader.
  const archivesDeleted: string[] = [];
  for (const stale of priorArchives) {
    if (archives.includes(stale)) continue;
    try {
      const del = await fetchFn(stale, { method: 'DELETE' });
      if (del.ok || del.status === 404 || del.status === 205) archivesDeleted.push(stale);
    } catch { /* unreferenced either way */ }
  }

  log(`[rebuildManifestFromPod] ${manifestUrl}: scanned ${scanned}, wrote ${written}, `
    + `archives ${archives.length} (${archivesDeleted.length} retired)`);
  return { scanned, written, manifestUrl, archives, archivesDeleted };
}

// ── Filter logic ────────────────────────────────────────────

function matchesFilter(entry: ManifestEntry, filter: DiscoverFilter): boolean {
  if (filter.facetType && !entry.facetTypes.includes(filter.facetType)) {
    return false;
  }

  if (filter.validFrom && entry.validUntil) {
    if (entry.validUntil < filter.validFrom) return false;
  }

  if (filter.validUntil && entry.validFrom) {
    if (entry.validFrom > filter.validUntil) return false;
  }

  if (filter.trustLevel) {
    if (!entry.facetTypes.includes('Trust') || entry.trustLevel !== filter.trustLevel) {
      return false;
    }
  }

  if (filter.modalStatus) {
    if (!entry.facetTypes.includes('Semiotic') || entry.modalStatus !== filter.modalStatus) {
      return false;
    }
  }

  // effectiveAt — "currently valid at time T": interval-contains check.
  // validFrom <= T AND (validUntil >= T OR validUntil absent).
  // Descriptors without a validFrom are treated as always-started;
  // descriptors without a validUntil are treated as open-ended.
  if (filter.effectiveAt) {
    const t = filter.effectiveAt;
    if (entry.validFrom && entry.validFrom > t) return false;
    if (entry.validUntil && entry.validUntil < t) return false;
  }

  // graphIri — narrow to descriptors that mention this graph IRI in
  // their iep:describes set. The single most useful narrowing filter
  // for agent workflows; without it, a learner asking "where is
  // urn:graph:X on this pod" has to fetch the whole manifest and
  // post-filter, which truncates on harness UIs for any pod with
  // more than ~20 entries.
  if (filter.graphIri) {
    if (!entry.describes.includes(filter.graphIri as IRI)) return false;
  }

  return true;
}

// ═════════════════════════════════════════════════════════════
//  publish()
// ═════════════════════════════════════════════════════════════

/**
 * Publish a Context Descriptor and its associated Named Graph
 * content to a Solid pod.
 *
 * 1. Serializes the descriptor to Turtle using the existing serializer.
 * 2. Wraps descriptor + graph content into a TriG document.
 * 3. PUTs the TriG to an LDP container on the pod.
 * 4. PATCHes the .well-known/context-graphs manifest.
 *
 * @param descriptor - The Context Descriptor to publish.
 * @param graphContent - Pre-serialized RDF content of the named graph
 *                       (Turtle triples — will be wrapped in a GRAPH block).
 * @param podUrl - Root URL of the Solid pod (e.g. "https://alice.solidcommunity.net/").
 * @param options - Optional configuration.
 * @returns URLs of the published resources.
 */
/**
 * Maximum permitted size of a descriptor's named-graph payload in bytes.
 * Producers that genuinely need to publish larger artifacts should split
 * the payload across multiple atoms in the PGSL lattice and reference
 * them via pgsl:contains / dct:hasPart from the descriptor — the descriptor
 * itself stays small, the bulk content is content-addressed and
 * deduplicated at the atom layer. Default 4 MiB is generous for
 * descriptor metadata + reasonable inline payloads but caps memory
 * bombs and aborts pathological inputs (multi-GB serialization) before
 * they hit the network. Override via PublishOptions.maxGraphBytes.
 */
const DEFAULT_MAX_GRAPH_BYTES = 4 * 1024 * 1024;

/**
 * Read a descriptor's Turtle representation directly from the pod for
 * the purposes of the CAS supersession precondition. Returns null on
 * 404 (head was deleted) so the caller can mark the head as "missing"
 * in the observed list without throwing. Any other non-200 surfaces
 * as an Error.
 *
 * FIX (combined sign_authorship + if_match path) — two changes:
 *
 *   1. We DO NOT send `Cache-Control: no-cache`. The original
 *      no-cache header forced CSS to skip its own response cache and
 *      re-read Azure Files on every CAS check, which is exactly the
 *      read path that flakes on a just-written descriptor URL. The
 *      CAS gate does NOT need byte-identical freshness — it needs
 *      current-or-newer — and CSS's normal cache already invalidates
 *      on PUT. Dropping the bypass header removes the failure mode
 *      where the post-write supersession check exhausts its retry
 *      budget on a transient Azure-Files re-read storm.
 *
 *   2. The retry budget is raised to 6 attempts / 500 ms base
 *      (~0.5s/1s/2s/4s/8s/16s, ~32 s ceiling) to match the symmetric
 *      window used by the graph + descriptor PUTs below. The
 *      combined signed-authorship + if_match path always traverses
 *      this code path (iep:supersedes is populated by the relay's
 *      auto-supersede block) and was the only configuration that
 *      consistently surfaced as `fetch failed (4×)` — the default
 *      maxAttempts=4 budget was symmetric on neither side, so a
 *      transient Azure-Files / CSS 5xx on the just-written rev1
 *      descriptor URL could exhaust read attempts mid-window.
 *
 *   3. On 4xx-other-than-404 we surface the descriptor URL + status
 *      in the error message so the failure shows up as
 *      `CAS prior-head fetch <url> failed: <code>` instead of bubbling
 *      up as an opaque `fetch failed` from the undici layer.
 */
async function fetchDescriptorTurtleForCas(
  descriptorUrl: string,
  fetchFn: FetchFn,
): Promise<string | null> {
  // The substrate `withTransientRetry` only retries on THROWN errors —
  // a returned 5xx response is "successful network call, server said
  // no" and falls through without retry. Azure Files cold-cache spikes
  // surface as 503 responses, not connection-reset throws, so we must
  // promote 5xx responses to throws INSIDE the lambda for the retry to
  // see them as transient. The thrown message embeds the status digits
  // so withTransientRetry's TRANSIENT_PATTERN (/5\d\d/) matches.
  let attempts = 0;
  const resp = await withTransientRetry(async () => {
    attempts++;
    const r = await fetchFn(descriptorUrl, {
      method: 'GET',
      headers: {
        'Accept': TURTLE_CONTENT_TYPE,
      },
    });
    if (r.status >= 500) {
      throw new Error(
        `publish: CAS prior-head fetch <${descriptorUrl}> failed: ${r.status} ${r.statusText} (attempt ${attempts})`,
      );
    }
    return r;
  }, { maxAttempts: 6, baseMs: 500 });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(
      `publish: CAS prior-head fetch <${descriptorUrl}> failed: ${resp.status} ${resp.statusText}`,
    );
  }
  return await resp.text();
}

/**
 * Result of a successful CAS precondition check (returned, not thrown).
 *
 * Carries the resolved head identifiers so callers (e.g. the relay's
 * `handlePublishContext`) can echo `previousHeadUrl` / `previousHeadCid`
 * synchronously even when the rest of the publish chain is deferred to
 * a background task. `preconditionWitness` records which side of the
 * `(ifMatchSupersedes, ifMatchCid)` pair matched, so the descriptor
 * Turtle written later (in Phase B) can append the same audit comment
 * the original synchronous path emitted.
 */
export interface SupersessionPreconditionPass {
  readonly ok: true;
  readonly resolvedHeadUrl: string;
  readonly resolvedHeadCid: string | null;
  readonly preconditionWitness: { matched: string; via: 'supersedes' | 'cid' };
  readonly currentHead: {
    readonly descriptorUrl: string;
    readonly cid: string | null;
    readonly supersedesList: readonly string[];
  };
}

/**
 * Standalone CAS supersession precondition check.
 *
 * Lifted out of {@link publish} so the relay can run the precondition
 * GET synchronously on the request thread (Phase A) and then defer the
 * actual graph + descriptor + manifest writes (Phase B) to a background
 * task — same 412 contract on the wire, but the typical happy-path
 * latency drops from ~7-10 s of CSS round-trips to ~1 s.
 *
 * Inputs are the same fields `publish()` derives internally:
 *   - `supersedesList` — `descriptor.supersedes` for the publish about
 *     to happen. MUST be non-empty when either match option is set,
 *     otherwise we throw immediately (the original publish() did too).
 *   - `ifMatchSupersedes` / `ifMatchCid` — caller-supplied head
 *     assertions. URL form gates on `descriptor.supersedes` equality;
 *     CID form gates on `computeCid(headTurtle)` equality. If both are
 *     set they must resolve to the same head.
 *   - `fetchFn` — pod-side fetch, threaded down from the relay so the
 *     bearer token / DPoP signing carry through unchanged.
 *
 * Throws {@link PublishPreconditionFailedError} on mismatch — same
 * shape as the in-publish path so the relay's existing 412 envelope
 * (`error:'precondition_failed', code:412, currentHead, retryHint`)
 * keeps working unchanged. On success returns `SupersessionPreconditionPass`
 * with the resolved head identifiers + the witness object.
 *
 * Non-412 failures (transient GET exhaustion, malformed turtle) bubble
 * up as regular `Error`s — the caller should map those to 503 +
 * retryable=true, NOT 412 (a 412 says "your assertion was wrong",
 * not "we couldn't tell").
 */
export async function checkSupersessionPrecondition(input: {
  readonly supersedesList: readonly string[];
  readonly ifMatchSupersedes?: string;
  readonly ifMatchCid?: string;
  readonly fetchFn: FetchFn;
  /**
   * Optional fast-path CID resolver. When provided, the precondition
   * check consults this lookup BEFORE falling back to a full descriptor
   * body GET + rehash. The relay populates this from the cached
   * manifest's `iep:contentCid` mirror — which is the same source the
   * `get_current_head` tool resolves from. Returning a string skips the
   * body fetch entirely for that supersedes target; returning null
   * (legacy manifest entry without the CID mirror, or unknown target)
   * falls through to the existing body-GET path.
   *
   * Why this exists: the Azure-Files transient that surfaced as 503
   * `precondition_unavailable` retryable=true was almost always the
   * `fetchDescriptorTurtleForCas` step — a full-body Turtle GET on a
   * cold cache. The manifest fetch the relay already does to build the
   * supersedes list also carries the head CID, so a manifest-mirrored
   * comparison removes the flaky read from the CAS path entirely.
   */
  readonly headCidLookup?: (descriptorUrl: string) => string | null | undefined;
  /**
   * The chain's CURRENT heads — the descriptors nothing else supersedes.
   *
   * ★ Without this, the precondition is not a compare-and-swap. `supersedesList` is
   * `descriptor.supersedes`, which under `auto_supersede_prior` holds EVERY prior
   * version of the graph, so matching the caller's assertion against that list means an
   * ancestor satisfies it forever. Two writers who both read v1 then both succeed, and
   * the second overwrites a state it never read — precisely the lost update the
   * precondition exists to prevent — while the response reports `precondition.passed`.
   *
   * Supplied, the assertion must name a live head. The frontier comes from the same
   * manifest read `get_current_head` performs, so the read and write halves of one CAS
   * agree on what "head" means instead of each carrying an opinion.
   *
   * Omitted, the older membership test applies — for callers whose supersedes list is
   * content-authored semantic supersession rather than a manifest-derived version chain,
   * where there is no frontier to compute. The relay's publish path, which is the only
   * externally reachable one, always supplies it.
   */
  readonly currentHeads?: readonly string[];
  /**
   * Canonicaliser for descriptor URLs. Manifest entries and `iep:supersedes` targets can
   * carry either the internal-FQDN host or the legacy public one; comparing the two raw
   * would make a live head look absent from its own frontier, rejecting a legitimate
   * publish — and a guard that fires on valid input is a guard someone switches off.
   */
  readonly normalizeUrl?: (descriptorUrl: string) => string;
}): Promise<SupersessionPreconditionPass> {
  const { supersedesList, ifMatchSupersedes, ifMatchCid, fetchFn, headCidLookup, currentHeads } = input;
  const normalizeUrl = input.normalizeUrl ?? ((u: string) => u);
  if (ifMatchSupersedes === undefined && ifMatchCid === undefined) {
    throw new Error(
      'checkSupersessionPrecondition: at least one of ifMatchSupersedes / ifMatchCid must be set — callers should skip this function when no precondition was requested.',
    );
  }
  if (supersedesList.length === 0) {
    throw new PublishPreconditionFailedError(
      'publish: ifMatchSupersedes/ifMatchCid was provided but descriptor.supersedes is empty — nothing to compare against. Add the prior head IRI to descriptor.supersedes (or drop the precondition).',
      {
        ...(ifMatchSupersedes !== undefined ? { supersedes: ifMatchSupersedes } : {}),
        ...(ifMatchCid !== undefined ? { cid: ifMatchCid } : {}),
      },
      { descriptorUrl: null, cid: null, supersedesList: [] },
    );
  }
  // Walk each supersedes target; collect descriptor URL + CID pairs so
  // the error response (on mismatch) carries the full observed head set.
  //
  // Optimization: if the caller supplied `headCidLookup` and it returns
  // a CID for this target, skip the descriptor body fetch entirely — the
  // manifest is the authoritative head pointer, and now (with the
  // `iep:contentCid` mirror) the head identity too. Body fetch is the
  // fallback when the lookup misses (legacy manifest entries written
  // before the mirror landed).
  //
  // The ifMatchSupersedes URL-form comparison doesn't need a CID at all
  // (it's a string match on supersedesList), so when only that option is
  // set we can record cid: '' without any pod read whatsoever — saves
  // one round-trip per supersedes target on every plain auto_supersede
  // publish, regardless of the manifest mirror state.
  const observed: { descriptorUrl: string; cid: string }[] = [];
  // Per-target fetch errors are recorded but do NOT abort the loop —
  // a single unresolvable target shouldn't kill the precondition when
  // ANOTHER target might match if_match. Surfaced only if no target
  // ends up matching, so the operator can see what went wrong.
  const targetErrors: { target: string; error: string }[] = [];
  for (const target of supersedesList) {
    const lookupCid = headCidLookup?.(target);
    if (typeof lookupCid === 'string' && lookupCid.length > 0) {
      observed.push({ descriptorUrl: target, cid: lookupCid });
      continue;
    }
    // Only http(s) targets are reachable via fetch. Non-http schemes
    // (urn:, did:, ipfs:, etc.) cannot be content-addressed by GET +
    // computeCid here — they're semantic supersession references the
    // user put in their content's `iep:supersedes` triples, lifted into
    // descriptor.supersedes by normalizePublishInputs. Treat them as
    // unresolvable for CAS purposes; record cid:'' so the loop
    // continues and another (http) target can still match if_match.
    // Without this guard, Node fetch rejects the urn: URL with
    // `fetch failed`, the 6-attempt retry burns ~15s on the same
    // unresolvable input, and the whole precondition surfaces as
    // `precondition_unavailable` even when an http target in the
    // SAME list would have resolved cleanly. (Rev 190 fix.)
    if (!/^https?:\/\//i.test(target)) {
      observed.push({ descriptorUrl: target, cid: '' });
      continue;
    }
    // Body-fetch the head: gates the ifMatchCid comparison AND
    // populates resolvedHeadCid as a side effect that callers
    // (e.g. the relay) echo back in their 202 response so the next
    // publish can pass it as the next CAS token. Per-target failures
    // are recorded and the loop continues — another http target may
    // still match.
    try {
      const headTurtle = await fetchDescriptorTurtleForCas(target, fetchFn);
      if (headTurtle === null) {
        observed.push({ descriptorUrl: target, cid: '' });
        continue;
      }
      const cid = computeCid(headTurtle);
      observed.push({ descriptorUrl: target, cid });
    } catch (err) {
      observed.push({ descriptorUrl: target, cid: '' });
      targetErrors.push({ target, error: (err as Error).message });
    }
  }

  let witness: { matched: string; via: 'supersedes' | 'cid' } | null = null;
  let resolvedHeadUrl: string | null = null;
  let resolvedHeadCid: string | null = null;

  if (ifMatchSupersedes !== undefined) {
    const hit = observed.find((o) => o.descriptorUrl === ifMatchSupersedes);
    if (!hit) {
      throw new PublishPreconditionFailedError(
        `publish: ifMatchSupersedes precondition failed — ${ifMatchSupersedes} is not among the declared supersedes targets [${supersedesList.join(', ')}].`,
        { supersedes: ifMatchSupersedes, ...(ifMatchCid !== undefined ? { cid: ifMatchCid } : {}) },
        { descriptorUrl: observed[0]?.descriptorUrl ?? null, cid: observed[0]?.cid ?? null, supersedesList: observed.map((o) => o.descriptorUrl) },
      );
    }
    witness = { matched: hit.descriptorUrl, via: 'supersedes' };
    resolvedHeadUrl = hit.descriptorUrl;
    resolvedHeadCid = hit.cid || null;
  }

  if (ifMatchCid !== undefined) {
    const hit = observed.find((o) => o.cid === ifMatchCid);
    if (!hit) {
      // If NO target resolved to a non-empty CID AND we recorded
      // per-target errors, this isn't "your assertion was wrong" —
      // it's "we couldn't tell". Surface as a transient Error so the
      // caller maps to 503 retryable, NOT 412 definitive. Without
      // this branch, a publish whose supersedes list is entirely
      // unresolvable (all urn:, all unreachable) would falsely
      // surface as 412 and the caller would re-read the manifest and
      // come back with the same urn: targets to no avail.
      const anyResolved = observed.some(o => o.cid.length > 0);
      if (!anyResolved && targetErrors.length > 0) {
        const tail = targetErrors.slice(0, 3).map(e => `<${e.target}>: ${e.error}`).join('; ');
        throw new Error(
          `publish: CAS precondition could not be resolved — every target in descriptor.supersedes was unreachable (first errors: ${tail}). This is a substrate / connectivity issue, not a definitive ifMatchCid mismatch — retry once the underlying read recovers.`,
        );
      }
      throw new PublishPreconditionFailedError(
        `publish: ifMatchCid precondition failed — CID ${ifMatchCid} does not match any current supersedes head (observed CIDs: [${observed.map((o) => o.cid).filter(Boolean).join(', ')}]).`,
        { ...(ifMatchSupersedes !== undefined ? { supersedes: ifMatchSupersedes } : {}), cid: ifMatchCid },
        { descriptorUrl: observed[0]?.descriptorUrl ?? null, cid: observed[0]?.cid ?? null, supersedesList: observed.map((o) => o.descriptorUrl) },
      );
    }
    if (witness && witness.matched !== hit.descriptorUrl) {
      throw new PublishPreconditionFailedError(
        `publish: ifMatchSupersedes and ifMatchCid identified different heads (${witness.matched} vs ${hit.descriptorUrl}).`,
        { supersedes: ifMatchSupersedes, cid: ifMatchCid },
        { descriptorUrl: hit.descriptorUrl, cid: hit.cid, supersedesList: observed.map((o) => o.descriptorUrl) },
      );
    }
    witness = { matched: hit.descriptorUrl, via: witness ? 'supersedes' : 'cid' };
    resolvedHeadUrl = hit.descriptorUrl;
    resolvedHeadCid = hit.cid;
  }

  // Unreachable on the contract above (either branch must have fired
  // because at least one of the match options was set) — guard anyway
  // so TS narrows resolvedHeadUrl/witness.
  if (!witness || resolvedHeadUrl === null) {
    throw new Error(
      'checkSupersessionPrecondition: internal invariant violated — match option set but no witness produced.',
    );
  }

  // ★ THE COMPARE-AND-SWAP. Everything above only established that the assertion names
  // SOMETHING in the supersedes list; under auto_supersede_prior that list is every
  // version ever published for this graph, so an ancestor matches forever. Requiring the
  // matched target to be a live head is what makes this a swap rather than a lookup:
  // a writer who read v1, was overtaken by v2, and asserts v1 is now told so, instead of
  // landing a v3 computed from a state that no longer exists.
  if (currentHeads !== undefined) {
    const heads = new Set(currentHeads.map(normalizeUrl));
    if (!heads.has(normalizeUrl(resolvedHeadUrl))) {
      throw new PublishPreconditionFailedError(
        `publish: precondition failed — <${resolvedHeadUrl}> is a SUPERSEDED ancestor of this chain, `
        + `not its current head. Another writer published after you read it. `
        + `Current head${currentHeads.length === 1 ? '' : 's'}: [${currentHeads.join(', ')}]`
        + `${currentHeads.length === 0 ? ' (none — every descriptor for this graph is superseded)' : ''}.`,
        {
          ...(ifMatchSupersedes !== undefined ? { supersedes: ifMatchSupersedes } : {}),
          ...(ifMatchCid !== undefined ? { cid: ifMatchCid } : {}),
        },
        {
          descriptorUrl: currentHeads[0] ?? null,
          cid: observed.find(o => normalizeUrl(o.descriptorUrl) === normalizeUrl(currentHeads[0] ?? ''))?.cid ?? null,
          supersedesList: currentHeads,
        },
      );
    }
  }

  return {
    ok: true,
    resolvedHeadUrl,
    resolvedHeadCid,
    preconditionWitness: witness,
    currentHead: {
      descriptorUrl: resolvedHeadUrl,
      cid: resolvedHeadCid,
      supersedesList: observed.map((o) => o.descriptorUrl),
    },
  };
}

export async function publish(
  descriptor: ContextDescriptorData,
  graphContent: string,
  podUrl: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const container = ensureTrailingSlash(
    `${pod}${options.containerPath ?? DEFAULT_CONTAINER}`,
  );

  const slug = options.descriptorSlug ?? slugFromIri(descriptor.id);
  const graphSlug = options.graphSlug ?? `${slug}-graph`;

  // Size guard — reject before serialization so an oversized publish
  // can't drive the process OOM. Byte-length, not char-length, to
  // account for multibyte UTF-8 content.
  const maxBytes = options.maxGraphBytes ?? DEFAULT_MAX_GRAPH_BYTES;
  const graphBytes = Buffer.byteLength(graphContent, 'utf8');
  if (graphBytes > maxBytes) {
    throw new Error(
      `publish: graph payload is ${graphBytes} bytes; max permitted is ${maxBytes} bytes (override via PublishOptions.maxGraphBytes). For payloads larger than this, content-address into the PGSL lattice and reference atoms via pgsl:contains / dct:hasPart instead of inlining.`,
    );
  }

  // FIX 4 — optional conformance gate. When the caller passes a list of
  // shape graphs (typically derived from the target container's
  // .well-known/container-shape declaration), run each one against the
  // inbound graphContent BEFORE any pod write. On violation throw 422
  // semantics — the descriptor + payload never land on the pod.
  if (options.conformsToShapes && options.conformsToShapes.length > 0) {
    for (const { shapeIri, shapeTurtle } of options.conformsToShapes) {
      const report = validateAgainstShape(graphContent, shapeTurtle, { entailment: 'rdfs' });
      if (!report.conforms) {
        throw new PublishShapeViolationError(
          `publish: inbound graph violates shape ${shapeIri}`,
          shapeIri,
          report.results.map(r => ({
            focusNode: r.focusNode,
            path: r.path,
            value: r.value,
            constraint: r.constraintComponent,
            severity: r.severity,
            message: r.message,
          })),
        );
      }
    }
  }

  // ── CAS supersession precondition ────────────────────────────
  //
  // When the caller passes `ifMatchSupersedes` / `ifMatchCid` they are
  // asserting that the current chain head for THIS descriptor's
  // supersedes target is the specified descriptor (or has the specified
  // content-CID). The check is a substrate-level gate: zero CSS writes
  // happen if the precondition fails, so two concurrent writers can't
  // both succeed in forking the chain.
  //
  // Resolution rules:
  //   - If descriptor.supersedes is empty/absent and either precondition
  //     option is set, this is a contract bug — throw immediately so the
  //     caller notices.
  //   - For each supersedes target we GET the descriptor Turtle (fresh
  //     read, no cache) and compute its content-CID. The "current head"
  //     is the union of (a) the explicit supersedes targets and (b) any
  //     other descriptor turtles those targets resolve to via further
  //     iep:supersedes back-links — but we only walk one hop and gate on
  //     the explicit targets. Manifest-level head resolution belongs in
  //     the caller (see relay's auto_supersede_prior block) so the
  //     substrate primitive stays cheap.
  //   - If ifMatchSupersedes is set it must equal one of descriptor.supersedes.
  //   - If ifMatchCid is set it must equal the CID of one of those targets'
  //     descriptor Turtles.
  //   - On mismatch we throw PublishPreconditionFailedError carrying the
  //     observed current head — the caller re-reads and rebuilds before
  //     retrying.
  //
  // The precondition is observable downstream too: when either match
  // option is supplied AND succeeds, we emit the witness predicate
  // iep:supersedesPredicate (a custom audit predicate) into the descriptor
  // Turtle by appending it after the body — that lets verifiers
  // reconstruct which prior head the precondition was gated against.
  let resolvedHeadUrl: string | null = null;
  let resolvedHeadCid: string | null = null;
  let preconditionWitness: { matched: string; via: 'supersedes' | 'cid' } | null = null;
  const supersedesList: readonly string[] = descriptor.supersedes ?? [];
  if (options.ifMatchSupersedes !== undefined || options.ifMatchCid !== undefined) {
    // Delegate to the standalone helper so the in-publish gate and the
    // relay's Phase-A pre-flight share one implementation (and one bug
    // surface). The helper throws PublishPreconditionFailedError on
    // mismatch with the same envelope this block used to construct
    // inline — no observable change to existing callers.
    const pass = await checkSupersessionPrecondition({
      supersedesList,
      ...(options.ifMatchSupersedes !== undefined ? { ifMatchSupersedes: options.ifMatchSupersedes } : {}),
      ...(options.ifMatchCid !== undefined ? { ifMatchCid: options.ifMatchCid } : {}),
      fetchFn,
      ...(options.headCidLookup ? { headCidLookup: options.headCidLookup } : {}),
      ...(options.currentHeads ? { currentHeads: options.currentHeads } : {}),
      ...(options.normalizeHeadUrl ? { normalizeUrl: options.normalizeHeadUrl } : {}),
    });
    resolvedHeadUrl = pass.resolvedHeadUrl;
    resolvedHeadCid = pass.resolvedHeadCid;
    preconditionWitness = pass.preconditionWitness;
  } else if (supersedesList.length > 0) {
    // No precondition was requested, but the descriptor IS superseding
    // something. Compute the head CID anyway so callers can pass it back
    // as ifMatchCid on the next publish. Best-effort: a transient read
    // failure here just leaves previousHeadCid absent in the result.
    //
    // Manifest fast-path: if the caller supplied a headCidLookup AND it
    // has a CID for the head, skip the body fetch entirely. Falls
    // through to body-GET only when the manifest mirror is missing
    // (legacy entry) or the caller didn't supply the lookup.
    const fastHeadCid = options.headCidLookup?.(supersedesList[0]!);
    if (typeof fastHeadCid === 'string' && fastHeadCid.length > 0) {
      resolvedHeadUrl = supersedesList[0]!;
      resolvedHeadCid = fastHeadCid;
    } else {
      try {
        const headTurtle = await fetchDescriptorTurtleForCas(supersedesList[0]!, fetchFn);
        if (headTurtle !== null) {
          resolvedHeadUrl = supersedesList[0]!;
          resolvedHeadCid = computeCid(headTurtle);
        }
      } catch { /* best-effort */ }
    }
  }

  // ── Descriptor serialization — legacy (toTurtle) OR Foundation-first
  //    PGSL-primary projection (opt-in via options.pgslNode) ────────────
  //
  // Default (no pgslNode): byte-identical to the historical path —
  // `toTurtle(descriptor)`. When the caller opts in with `pgslNode`, the
  // descriptor Turtle is DERIVED from the lattice node via the PGSL
  // projection engine (`projectHolon`), so the holon is the source of
  // truth and the descriptor is a deterministic render of it. We still
  // read `descriptor.describes[0]` (graph name) and `descriptor.id` below
  // from the descriptor argument — so before switching, assert the holon
  // and descriptor name the SAME graph (CAVEAT C), else the TriG graph
  // name, distribution block, and manifest entry could silently disagree.
  let projectedManifestEntry: unknown = null;
  // When PGSL-primary, the projection owns the descriptor resource URL
  // (a content-addressed `holon-<hash>.ttl` under descriptorBase). publish()
  // writes the descriptor body there + points the manifest entry at it, so
  // the on-pod resource, the Turtle subject IRI, and the manifest row all
  // agree. Null on the legacy path (slug-derived URL used instead).
  let projectedDescriptorUrl: string | null = null;
  let baseDescriptorTurtle: string;
  if (options.pgslNode) {
    const pn = options.pgslNode as { node: { uri: string }; pgsl: unknown; descriptorBase: string };
    // CAVEAT C — graph/id alignment invariant. projectHolon derives graphUri
    // from node.uri; the rest of publish() reads descriptor.describes[0] +
    // descriptor.id. They MUST name the same content graph.
    if (descriptor.describes[0] !== pn.node.uri) {
      throw new Error(
        `publish: pgslNode alignment violation — descriptor.describes[0] (<${descriptor.describes[0] ?? ''}>) ` +
        `must equal the PGSL node uri (<${pn.node.uri}>) so the TriG graph name, distribution block, and manifest entry agree.`,
      );
    }
    if (!descriptor.id) {
      throw new Error('publish: pgslNode requires descriptor.id to be set (descriptor id anchors the distribution block + slug).');
    }
    // Late-import @interego/pgsl via the dynamic-import escape hatch — the
    // ONLY coupling allowed across the solid → pgsl boundary (NO static
    // top-of-file import of the pgsl package). Cast to unknown first so TS
    // does not require the module to be resolvable at compile time.
    const dyn = Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
    const mod = await dyn('@interego/pgsl') as {
      projectHolon: (node: unknown, pgsl: unknown, opts: { descriptorBase: string; typedFacets?: boolean }) => {
        descriptorTurtle: string;
        descriptorUrl: string;
        manifestEntry: unknown;
      };
    };
    const projection = mod.projectHolon(pn.node, pn.pgsl, { descriptorBase: pn.descriptorBase, typedFacets: true });
    baseDescriptorTurtle = projection.descriptorTurtle;
    projectedManifestEntry = projection.manifestEntry;
    projectedDescriptorUrl = projection.descriptorUrl;
  } else {
    baseDescriptorTurtle = toTurtle(descriptor);
  }
  // When the precondition matched, append a Turtle comment witness so
  // downstream auditors can verify which prior head this publish was
  // gated against, without introducing a new iep: term (the ontology
  // lint blocks unregistered iep:* IRIs). The witness rides on top of
  // the existing iep:supersedes triple already in the descriptor — the
  // comment names the precondition source (URL vs CID) and which one
  // of the supersedes targets satisfied it.
  //
  // CAVEAT A — the witness comment must be appended on BOTH paths. The
  // PGSL projection does not carry it, so we append it to the projected
  // turtle's tail too, or the auditor trail is silently dropped on the
  // PGSL-primary path.
  const descriptorTurtle = preconditionWitness
    ? `${baseDescriptorTurtle.trimEnd()}\n# ── CAS supersession witness (precondition matched at publish time, via ${preconditionWitness.via}) ──\n# iep:supersedes precondition gated against <${preconditionWitness.matched}>\n`
    : baseDescriptorTurtle;
  const primaryGraph = descriptor.describes[0]!;

  // 1. PUT the graph payload — plaintext TriG OR encrypted envelope.
  //    When options.encrypt is set, the named-graph content is wrapped in
  //    an nacl-box envelope with one wrapped key per recipient, so CSS /
  //    Azure Files / IPFS see only ciphertext. Descriptor metadata stays
  //    plaintext so federation queries (facet type, temporal filter,
  //    trust level) work without the viewer being an authorized recipient.
  let graphUrl: string;
  let graphBody: string;
  let graphContentType: string;
  let encryptedFlag = false;
  if (options.encrypt) {
    const envelope = createEncryptedEnvelope(
      wrapAsTriG(descriptorTurtle, graphContent, primaryGraph),
      options.encrypt.recipients,
      options.encrypt.senderKeyPair,
    );
    graphUrl = `${container}${graphSlug}.envelope.jose.json`;
    graphBody = JSON.stringify(envelope);
    graphContentType = ENVELOPE_CONTENT_TYPE;
    encryptedFlag = true;
  } else {
    graphUrl = `${container}${graphSlug}.trig`;
    graphBody = wrapAsTriG(descriptorTurtle, graphContent, primaryGraph);
    graphContentType = TRIG_CONTENT_TYPE;
  }

  // The graph PUT carries the bulk of the payload bytes — typically the
  // largest single request in the publish path. Under upstream envoy
  // churn (Azure Container Apps' fronting proxy) a mid-write socket
  // reset surfaces here as a generic "fetch failed". The default
  // schedule (4 attempts, 1s/2s/4s/8s) can exhaust within a single
  // envoy reload window; bump to 6 attempts with a 500ms base
  // (~0.5s/1s/2s/4s/8s/16s, ~32s ceiling) so we ride out longer blips
  // without changing the overall budget more than necessary. Descriptor
  // PUT below uses the same tuning for symmetry.
  await withTransientRetry(async () => {
    const graphResponse = await fetchFn(graphUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': graphContentType,
        'If-None-Match': '*',
      },
      body: graphBody,
    });
    if (!graphResponse.ok && graphResponse.status !== 412) {
      throw new Error(
        `Failed to write graph to ${graphUrl}: ${graphResponse.status} ${graphResponse.statusText}`,
      );
    }
  }, { maxAttempts: 6, baseMs: 500 });

  // 2. PUT the descriptor as standalone Turtle — augmented with a
  //    hypermedia Distribution block linking to the graph payload.
  //    This is HATEOAS: the descriptor self-describes where its graph
  //    content lives, what media type it serves, whether it's encrypted,
  //    and what HTTP operations a client can invoke to retrieve and
  //    decrypt it. Clients follow the link instead of constructing URLs
  //    by naming convention.
  // PGSL-primary publishes write the descriptor at the projection's
  // content-addressed resource URL so the on-pod resource, the descriptor
  // Turtle's own subject IRI (projectHolon emits `<descriptorUrl> a
  // iep:ContextDescriptor`), and the manifest entry all reference the same
  // IRI. Legacy publishes keep the slug-derived URL.
  const descriptorUrl = projectedDescriptorUrl ?? `${container}${slug}.ttl`;
  const distributionBlock = buildDistributionBlock({
    graphUrl,
    graphContentType,
    encrypted: encryptedFlag,
    encryptionAlgorithm: encryptedFlag ? 'X25519-XSalsa20-Poly1305' : undefined,
    recipientCount: options.encrypt?.recipients.length,
    visibility: options.visibility,
    descriptorId: descriptor.id,
    relayBaseUrl: options.relayBaseUrl,
  });
  // Optional authorship-proof block. When the caller minted a signed
  // authorship proof for THIS publish (typically via `sign_authorship:
  // true` in the relay shim → `createSignedAuthorship` with the
  // calling agent's delegation key), embed it as
  //   <> iep:authorshipProof [ a iep:SignedAuthorship ; ... ] .
  // adjacent to the AgentFacet block. Independent of the trust-facet
  // iep:proof block (which signs the whole descriptor turtle and is
  // operator-grade): authorship binds the AgentFacet to THIS agent's
  // delegation key so any reader can verify "the named agent actually
  // signed this AgentFacet" without trusting pod storage.
  //
  // Also asserts `dct:conformsTo <iep:SignedAuthorship>` so readers
  // can detect a signed-authorship descriptor by feature, not by
  // probe-parse.
  const authorshipBlock = options.authorshipProof
    ? buildAuthorshipProofBlock(options.authorshipProof)
    : '';
  const descriptorWithDistribution =
    descriptorTurtle.trimEnd()
    + '\n\n' + distributionBlock
    + (authorshipBlock ? ('\n\n' + authorshipBlock) : '')
    + '\n';
  // Content-CID of the exact Turtle body about to land on the pod.
  // Mirrored into the manifest entry below so CAS supersession gates
  // (`checkSupersessionPrecondition`) can compare `if_match` against
  // the head identity without re-fetching + rehashing the body.
  const descriptorContentCid = computeCid(descriptorWithDistribution);
  // CAVEAT B — contentCid mirror on the PGSL-projected manifest entry.
  // `renderManifestEntry` only emits `iep:contentCid` when the entry's
  // `cid` field is set, and `projectHolon` does NOT populate it. Mirror
  // the just-computed descriptor CID onto the projected entry BEFORE we
  // render it, so the CAS supersession fast-path (head-cid lookup /
  // checkSupersessionPrecondition) still has its contentCid mirror — same
  // as the legacy `manifestEntryTurtle(..., descriptorContentCid)` path.
  if (projectedManifestEntry) {
    (projectedManifestEntry as { cid?: string }).cid = descriptorContentCid;
  }
  await withTransientRetry(async () => {
    const descResponse = await fetchFn(descriptorUrl, {
      method: 'PUT',
      headers: { 'Content-Type': TURTLE_CONTENT_TYPE },
      body: descriptorWithDistribution,
    });
    if (!descResponse.ok) {
      throw new Error(
        `Failed to write descriptor to ${descriptorUrl}: ${descResponse.status} ${descResponse.statusText}`,
      );
    }
  }, { maxAttempts: 6, baseMs: 500 });

  // 3. Update the manifest — CAS-safe via HTTP If-Match.
  //
  //    publish() can be called concurrently by multiple agents (or
  //    multiple processes on the same agent's machine). The naive
  //    GET-then-PUT pattern races: two clients read the same manifest,
  //    each appends their own entry, the last PUT clobbers the other's
  //    entry. We use HTTP optimistic concurrency:
  //
  //      1. GET manifest, capture ETag from response
  //      2. PUT with `If-Match: <ETag>` (server rejects with 412 if
  //         the manifest changed since our GET)
  //      3. On 412, retry from step 1 with fresh ETag + fresh entries
  //         (a few times with backoff; throw if persistent contention).
  //
  //    For the cold-start (no manifest yet), use `If-None-Match: *` so
  //    the PUT succeeds only if no manifest exists — protects against
  //    two cold-start clients clobbering each other.
  const manifestUrl = `${pod}${MANIFEST_PATH}`;
  // Manifest entry — legacy `manifestEntryTurtle` OR the PGSL-projected
  // entry rendered via `renderManifestEntry` (Foundation-first). The
  // projected entry already carries iep:pgslUri/iep:pgslLevel + the
  // contentCid mirror set above (CAVEAT B), and `renderManifestEntry` is
  // format-compatible with the legacy row (parseManifest reads both).
  let newEntry: string;
  if (options.pgslNode && projectedManifestEntry) {
    const dyn = Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
    const mod = await dyn('@interego/pgsl') as {
      renderManifestEntry: (entry: unknown) => string;
    };
    newEntry = mod.renderManifestEntry(projectedManifestEntry);
  } else {
    newEntry = manifestEntryTurtle(descriptorUrl, descriptor, descriptorContentCid);
  }
  // Under N-way concurrent contention (e.g. 5 voters firing Promise.all),
  // 5 internal retries are not enough — the exponential window doesn't
  // grow fast enough to scatter every writer to a clean If-Match slot.
  // 8 attempts gives 50/100/200/400/800/1500/1500/1500ms (each + 0-200ms
  // jitter) ≈ up to ~7s of scatter, which keeps every writer in the
  // queue under realistic governance / cartographer-fanout contention.
  // Archive segments this publish created, surfaced on the result so a caller (and the live
  // drivers) can see that a roll-over happened rather than infer it from latency.
  const rolledSegments: string[] = [];
  const maxAttempts = 8;
  let lastError: string | null = null;
  // Per-pod in-process serialization (see manifestWriteQueues above):
  //
  // ★ COMPACTION RUNS INSIDE THE SAME LOCK AS THE APPEND, DELIBERATELY. Two same-process
  // publishes onto one pod would otherwise both find the manifest over the bound, both write
  // the same segment indices, and both try to CAS the shortened document — one wins and the
  // other's segment writes were wasted work at ~2 seconds each. Serializing them means the
  // second publish finds the pod already inside the bound and pays one GET.
  await withManifestLock(manifestUrl, async () => {
  // Bring the hot document under the bound BEFORE the append's CAS loop, as its own committed
  // step with its own cheap retry. Everything about why is in `compactManifestIfNeeded`.
  const compaction = await compactManifestIfNeeded(pod, manifestUrl, fetchFn);
  for (const s of compaction.segments) if (!rolledSegments.includes(s)) rolledSegments.push(s);
  // Consumed by attempt 1 only, then dropped: every later attempt exists BECAUSE something
  // changed under us, so re-reading is the whole point of retrying.
  let primed = compaction.primed;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let manifestBody: string;
    let etag: string | null = null;
    // Was this attempt's body RECONSTRUCTED from the pod rather than read from the server?
    // Only that body can be over the bound at this point, and only that body may be rolled
    // here — see the last-resort roll below for why the distinction is load-bearing.
    let bodyWasReconstructed = false;

    // Reuse the read compaction already paid for, on attempt 1 only. It hands one back ONLY
    // when it decided the pod was inside the bound and wrote nothing, so the body and ETag
    // are still the server's current state.
    const reuse = attempt === 1 ? primed : null;
    primed = null;

    // 5xx-as-throw promotion (see discover() / fetchDescriptorTurtleForCas
    // for the same pattern): Azure-Files cold-cache 503s arrive as
    // returned responses, so `withTransientRetry` only sees them retry-
    // eligible when we throw inside the lambda.
    const existingResp = reuse !== null ? {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? reuse.etag : null) },
      text: async () => reuse.body,
      json: async () => ({}),
    } as unknown as Awaited<ReturnType<FetchFn>> : await withTransientRetry(async () => {
      const r = await fetchFn(manifestUrl, {
        method: 'GET',
        headers: { 'Accept': TURTLE_CONTENT_TYPE },
      });
      if (r.status >= 500) {
        throw new Error(`Failed to fetch manifest from ${manifestUrl}: ${r.status} ${r.statusText}`);
      }
      return r;
    });

    let alreadyPublished = false;
    if (existingResp.ok) {
      etag = existingResp.headers?.get('etag') ?? null;
      const existing = await existingResp.text();
      if (existing.includes(`<${descriptorUrl}>`)) {
        // Already in manifest (idempotent re-publish); skip the PUT.
        alreadyPublished = true;
        manifestBody = existing;
      } else {
        manifestBody = `${existing.trimEnd()}\n\n${newEntry}\n`;
      }
    } else if (existingResp.status === 404) {
      // Manifest absent. This is EITHER a true cold-start (no descriptors
      // yet) OR a lost/collapsed index whose descriptors are still intact
      // (the f-manifest-collapse failure mode). Reconstruct from the
      // on-pod descriptors so a missing index is never replaced by a
      // 1-entry stub that truncates the pod. The just-written descriptor
      // is normally picked up by the scan; append it defensively if the
      // container listing hasn't caught up yet.
      let rebuiltBody: string | null = null;
      bodyWasReconstructed = true;
      // Foundation-first: when the caller supplied a PGSL instance, PREFER
      // rebuilding the recovery manifest from a render of the lattice slice
      // over scanning the pod's descriptor files. The PGSL render is the
      // inversion of the scan (which was the source of the collapse bugs).
      // Wrapped in try/catch so a PGSL failure (or pgsl not installed)
      // degrades cleanly to the RDF scan below.
      if (options.pgsl) {
        try {
          const pgslBase = options.pgslNode?.descriptorBase ?? container;
          const fromPgsl = await buildManifestFromPGSL(options.pgsl, pgslBase, fetchFn);
          if (fromPgsl.written > 0) {
            rebuiltBody = fromPgsl.body.includes(`<${descriptorUrl}>`)
              ? fromPgsl.body
              : `${fromPgsl.body.trimEnd()}\n\n${newEntry}\n`;
          }
        } catch {
          rebuiltBody = null;
        }
      }
      if (rebuiltBody === null) {
        try {
          const rebuilt = await buildManifestBodyFromPod(pod, fetchFn);
          if (rebuilt.written > 0) {
            rebuiltBody = rebuilt.body.includes(`<${descriptorUrl}>`)
              ? rebuilt.body
              : `${rebuilt.body.trimEnd()}\n\n${newEntry}\n`;
          }
        } catch {
          rebuiltBody = null;
        }
      }
      manifestBody = rebuiltBody
        ?? `${turtlePrefixes(['iep', 'xsd', 'hydra', 'dcat', 'dprod', 'dct'])}\n\n${manifestHeaderTurtle(pod)}\n\n${newEntry}\n`;
    } else {
      // Non-404 non-ok (e.g. 403/401, or a non-5xx transient): the
      // manifest may well EXIST but be momentarily unreadable. Rebuilding
      // from scratch here is what truncated live indexes
      // (f-manifest-collapse). Refuse to truncate — back off and retry;
      // a later attempt re-reads the real manifest.
      lastError = `manifest GET ${existingResp.status} ${existingResp.statusText} (attempt ${attempt}/${maxAttempts}); refusing to rebuild-from-scratch on a non-404`;
      const backoff = Math.min(50 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200), 1500);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    // ★ FINDING OUR OWN ENTRY IS SUCCESS, AND IT HAS TO CLEAR THE EARLIER ERROR.
    //
    // This `break` used to leave `lastError` set, and the `if (lastError) throw` after the
    // loop then reported `Failed to update manifest ... after 8 attempts` over a manifest
    // that CONTAINS the entry — a committed write announced as a failure. Measured live on
    // 2026-08-08 against the production fleet: every single occurrence of that error, in the
    // relay's own log and in the tool responses, said `attempt 1/8` — never 2/8..8/8 — which
    // is only reachable if attempt 1 recorded an error and attempt 2 exited HERE. And after
    // each one, `get_current_head` named the supposedly-failed descriptor as the pod's head.
    //
    // A newly seated delegate's first write is where a person meets this: the write lands,
    // the tool says it did not, and the caller writes a retry loop around a substrate that
    // was already correct. See the PUT below for what manufactures the attempt-1 error.
    if (alreadyPublished) { lastError = null; break; }

    // ── The last-resort bound, for the ONE body compaction cannot have seen ───────
    //
    // ★ THIS IS GATED ON `bodyWasReconstructed`, AND THE GATE IS THE POINT.
    //
    // Compaction (above, once, with its own small retry budget) has already brought any body
    // READ from the server under the bound. The 404-heal branch is different: it builds a
    // manifest out of the pod's descriptors, so its body never existed on the server for
    // compaction to have shortened, and on a large pod it lands far past the bound in one
    // step. That body has to be rolled here or the heal writes the very document that cannot
    // be written.
    //
    // Rolling UNCONDITIONALLY here — which is where this started — makes the roll-over
    // repeatable up to `maxAttempts` times. Measured live on a 400-entry pod: the append's
    // conditional PUT lost a 412 to a concurrent writer, attempt two re-derived the same
    // split, and one publish took 25.7 SECONDS across eight segment PUTs for four segments.
    // Nothing was lost — indices are derived from the manifest's own links, so a repeat
    // overwrites rather than orphans — but eight rolls is a worst case that will eventually
    // not finish. With the gate, a contended append retries at the price of an append.
    if (bodyWasReconstructed) {
      const rolled = await rollOverManifest(pod, manifestBody, fetchFn, descriptorUrl);
      if (rolled) {
        manifestBody = rolled.body;
        for (const s of rolled.segmentsWritten) if (!rolledSegments.includes(s)) rolledSegments.push(s);
      }
    }

    const headers: Record<string, string> = { 'Content-Type': TURTLE_CONTENT_TYPE };
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';   // cold-start: only PUT if no manifest exists

    // ★ A CONDITIONAL WRITE MUST NOT BE BLIND-RETRIED, AND THIS ONE WAS.
    //
    // This PUT used to be wrapped in `withTransientRetry` with the same 5xx-as-throw
    // promotion the GETs above use. On a GET that is right; on a compare-and-swap PUT it
    // manufactures the conflict it then reports. Measured live, from CSS's own log, for one
    // failing publish onto a pod whose manifest holds ~220 entries:
    //
    //   01:21:53.061  Received PUT request for /u-eth-…/.well-known/context-graphs
    //   01:21:59.887  [WrappedExpiringReadWriteLocker] error: Lock expired after 6000ms on
    //                 …/.well-known/context-graphs
    //   01:22:00.916  Received PUT request for /u-eth-…/.well-known/context-graphs   ← re-sent
    //   01:22:01.526  Received GET  request for /u-eth-…/.well-known/context-graphs
    //
    // Rewriting a whole 220-entry manifest on a single-replica file-backed CSS takes longer
    // than CSS's 6-second write-lock TTL. CSS expires the lock and answers 5xx — but lock
    // expiry is a watchdog, not a rollback, so the bytes are already stored. `withTransientRetry`
    // then re-sent the PUT one second later carrying the SAME, now-stale `If-Match`, and CSS
    // answered 412. The "concurrent manifest update" the loop went on to report was this
    // request's own first PUT.
    //
    // The outer CAS loop IS the retry, and it is the correct one: it re-GETs a fresh etag and
    // rebuilds the body before trying again, which is the only sound way to repeat a
    // conditional write. So a transient failure here becomes one more CAS attempt — the 5xx
    // branch below already backs off and re-reads — instead of a self-inflicted conflict. A
    // thrown network error is treated the same way rather than escaping the loop, because a
    // PUT that threw may still have landed, and the next attempt's GET is what finds out.
    let manifestResp: Awaited<ReturnType<typeof fetchFn>>;
    try {
      manifestResp = await fetchFn(manifestUrl, {
        method: 'PUT', headers, body: manifestBody,
      });
    } catch (err) {
      lastError = `manifest PUT threw (attempt ${attempt}/${maxAttempts}): ${(err as Error).message}`;
      const backoff = Math.min(50 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200), 1500);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    if (manifestResp.ok) {
      // Belt-and-suspenders: under N-way contention (e.g. 4+ concurrent
      // writers), some storage backends accept simultaneous PUTs with
      // matching If-Match etags due to a TOCTOU gap between the etag
      // check and the body write. A 200 OK then is misleading — the
      // server may have already overwritten our payload with a later
      // writer's body. Verify by reading the manifest back; if our entry
      // is missing, treat as a conflict and retry. This terminates
      // because each retry GETs the freshest etag and rebuilds the body.
      const verifyResp = await withTransientRetry(async () => {
        const r = await fetchFn(manifestUrl, {
          method: 'GET',
          headers: { 'Accept': TURTLE_CONTENT_TYPE },
        });
        if (r.status >= 500) {
          throw new Error(`manifest verify-GET <${manifestUrl}> failed: ${r.status} ${r.statusText}`);
        }
        return r;
      });
      if (verifyResp.ok) {
        const verifyBody = await verifyResp.text();
        if (!verifyBody.includes(`<${descriptorUrl}>`)) {
          lastError = `post-PUT verification: entry missing after 200 OK (attempt ${attempt}/${maxAttempts}; concurrent writer clobbered us)`;
          const exponentialBase = 50 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 200);
          const backoff = Math.min(exponentialBase + jitter, 1500);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
      }
      lastError = null;
      break;
    }
    if (manifestResp.status === 412) {
      // Precondition Failed: another writer beat us. Retry with fresh GET.
      lastError = `412 (concurrent manifest update detected, attempt ${attempt}/${maxAttempts})`;
      // Exponential backoff with wider jitter, capped at 1.5s per attempt.
      // Linear backoff retry-storms under heavy contention because the
      // re-attempt window doesn't grow fast enough to spread writers.
      // Exponential (50/100/200/400/800/1500/1500/1500ms) plus 0-200ms
      // jitter scatters 5+ concurrent retries effectively (wider jitter
      // than the original 50ms because the writer pool is larger).
      const exponentialBase = 50 * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 200);
      const backoff = Math.min(exponentialBase + jitter, 1500);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    // 5xx — server is unhappy (CSS has been observed returning 500 from the
    // manifest endpoint once the manifest grows past ~14 entries; the failure
    // mode is server-internal and transient from our side). Treat like 412:
    // back off, GET the freshest etag, rebuild the body, and re-PUT. This is
    // the same recovery shape the in-loop CAS retry already implements, just
    // gated on the server-side overload signal instead of the concurrent-write
    // signal.
    if (manifestResp.status >= 500 && manifestResp.status < 600) {
      lastError = `${manifestResp.status} (server-side manifest update failure, attempt ${attempt}/${maxAttempts})`;
      const exponentialBase = 50 * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 200);
      const backoff = Math.min(exponentialBase + jitter, 1500);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    throw new Error(
      `Failed to update manifest at ${manifestUrl}: ${manifestResp.status} ${manifestResp.statusText}`,
    );
  }
  if (lastError) {
    throw new Error(
      `Failed to update manifest at ${manifestUrl} after ${maxAttempts} attempts: ${lastError}`,
    );
  }
  }); // end withManifestLock

  // 4. Optional: ingest into PGSL lattice for structural indexing
  let pgslUri: string | undefined;
  let pgslLevel: number | undefined;
  if (options.pgsl) {
    try {
      // Late-import `@interego/pgsl` so the substrate has no compile-time
      // dependency on it; the publish stays usable without PGSL installed.
      // Cast to `unknown` first to bypass the TS "cannot find module" check
      // (the substrate's package.json deliberately does not declare a
      // dependency on `@interego/pgsl` — that would be a circular dep —
      // so the resolver only finds it at runtime when PGSL is installed
      // alongside core).
      const dyn = Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
      const mod = await dyn('@interego/pgsl') as {
        embedInPGSL: (pgsl: unknown, content: string, descriptor: unknown, granularity?: string) => string;
      };
      const pgslInstance = options.pgsl as { nodes: Map<string, { level?: number }> };
      const topUri = mod.embedInPGSL(pgslInstance, graphContent, descriptor, options.pgslGranularity);
      const node = pgslInstance.nodes.get(topUri);
      pgslUri = topUri;
      pgslLevel = node?.level;
    } catch {
      // PGSL ingestion is optional — don't fail the publish.
      // (Also handles the case where `@interego/pgsl` isn't installed.)
    }
  }

  const result: PublishResult = { descriptorUrl, graphUrl, manifestUrl };
  if (rolledSegments.length > 0) {
    (result as { manifestArchivesWritten?: readonly string[] }).manifestArchivesWritten = rolledSegments;
  }
  if (encryptedFlag) (result as { encrypted?: boolean }).encrypted = true;
  if (pgslUri !== undefined) (result as { pgslUri?: string }).pgslUri = pgslUri;
  if (pgslLevel !== undefined) (result as { pgslLevel?: number }).pgslLevel = pgslLevel;
  // CAS chain head — included whenever we resolved one, regardless of
  // whether a precondition was supplied. Callers can use these to chain
  // a sequence of supersessions atomically (publish → previousHeadCid →
  // ifMatchCid on next publish → ...).
  if (resolvedHeadCid !== null) (result as { previousHeadCid?: string }).previousHeadCid = resolvedHeadCid;
  if (resolvedHeadUrl !== null) (result as { previousHeadUrl?: string }).previousHeadUrl = resolvedHeadUrl;
  return result;
}

// ═════════════════════════════════════════════════════════════
//  Hypermedia: Distribution link serialization + parsing
// ═════════════════════════════════════════════════════════════

/**
 * Build the Turtle block that links a descriptor to its graph payload
 * using the project's existing affordance + hypermedia ontology.
 *
 * Emission shape aligns with:
 *   - iep:Affordance individuals (iep:canFetchPayload, iep:canDecrypt)
 *   - iep:affordance object property (from cg.ttl)
 *   - ieh:Affordance class (harness ontology; rdfs:subClassOf hydra:Operation
 *     — single block is both a Hydra Operation AND a harness affordance)
 *   - dcat:Distribution (W3C data-catalog vocab; the facet is also a DCAT
 *     distribution so DCAT-aware catalogs can ingest it natively)
 *   - alignment.ttl cross-layer axioms (iep:FederationFacet rdfs:seeAlso
 *     dcat:Distribution; ieh:Affordance rdfs:subClassOf hydra:Operation)
 *
 * The block declares a single affordance that is simultaneously:
 *   - a iep:Affordance  (discovery-time capability)
 *   - a ieh:Affordance (execution-time operation, via subclass relation)
 *   - a hydra:Operation (HATEOAS client dispatch target)
 *   - a dcat:Distribution (data-catalog compatible)
 *
 * Single RDF node carrying the full set of hats — any client that speaks
 * any of these vocabularies can dispatch against it.
 */
function buildDistributionBlock(d: {
  graphUrl: string;
  graphContentType: string;
  encrypted: boolean;
  encryptionAlgorithm?: string;
  recipientCount?: number;
  visibility?: 'public' | 'shared' | 'private';
  descriptorId?: string;
  relayBaseUrl?: string;
}): string {
  const actionIRI = d.encrypted ? 'iep:canDecrypt' : 'iep:canFetchPayload';
  const returnsClass = d.encrypted ? 'iep:EncryptedGraphEnvelope' : 'iep:GraphPayload';
  const lines: string[] = [
    '# ── Affordance (iep:Affordance, ieh:Affordance, dcat:Distribution, hydra:Operation) ──',
    `<> iep:affordance [`,
    `    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;`,
    `    iep:action ${actionIRI} ;`,
    `    hydra:method "GET" ;`,
    `    hydra:target <${iescIri(d.graphUrl)}> ;`,
    `    hydra:returns ${returnsClass} ;`,
    `    hydra:title "${d.encrypted ? 'Fetch encrypted graph envelope' : 'Fetch graph payload'}" ;`,
    `    dcat:accessURL <${iescIri(d.graphUrl)}> ;`,
    `    dcat:mediaType "${d.graphContentType}" ;`,
    `    iep:encrypted ${d.encrypted ? 'true' : 'false'}`,
  ];
  if (d.encrypted && d.encryptionAlgorithm) {
    lines.push(`    ; iep:encryptionAlgorithm "${d.encryptionAlgorithm}"`);
  }
  if (d.encrypted && typeof d.recipientCount === 'number') {
    lines.push(`    ; iep:recipientCount ${d.recipientCount}`);
  }
  // Visibility is the audience-class signal for consumers (and for ACL
  // writers that mirror it onto the pod). Default-omitted preserves the
  // historical wire format for `shared` graphs; only emit when caller
  // declared `public` or `private` so older parsers don't trip on an
  // unknown predicate.
  if (d.visibility === 'public' || d.visibility === 'private') {
    lines.push(`    ; iep:visibility "${d.visibility}"`);
  }
  lines.push(`] .`);

  // Second affordance: iep:renderView. Server-side plaintext projection
  // for thin clients (no X25519 keypair) that hold a bearer token. Only
  // emitted when the payload is encrypted AND the publisher supplied a
  // relay base URL — without one we'd have no projection endpoint to
  // point at. iep:canDecrypt above remains the point-of-fetch path for
  // clients holding a recipient key; iep:renderView is the asymmetric
  // counterpart for thin clients. See cg.ttl `iep:renderView`.
  if (d.encrypted && d.relayBaseUrl && d.descriptorId) {
    const relayBase = d.relayBaseUrl.replace(/\/$/, '');
    const renderTarget = `${relayBase}/render/${encodeURIComponent(d.descriptorId)}`;
    lines.push('');
    lines.push('# ── Affordance (iep:renderView — server-side projection for thin clients) ──');
    lines.push(`<> iep:affordance [`);
    lines.push(`    a iep:Affordance, ieh:Affordance, hydra:Operation ;`);
    lines.push(`    iep:action iep:renderView ;`);
    lines.push(`    hydra:method "GET" ;`);
    lines.push(`    hydra:target <${renderTarget}> ;`);
    lines.push(`    hydra:returns iep:GraphPayload ;`);
    lines.push(`    hydra:title "Render plaintext projection of encrypted graph (relay unwraps for authorized bearer)" ;`);
    lines.push(`    dcat:mediaType "text/turtle"`);
    lines.push(`] .`);
  }
  return lines.join('\n');
}

/**
 * Build the Turtle block embedding an authorship proof in the
 * descriptor. Shape:
 *
 *   <> dct:conformsTo <https://markjspivey-xwisee.github.io/interego/ns/iep#SignedAuthorship> .
 *   <> iep:authorshipProof [
 *     a iep:SignedAuthorship ;
 *     iep:scheme "EcdsaSecp256k1Signature2019" ;
 *     iep:issuer <agentId> ;
 *     iep:verificationMethod <did:ethr:0x...> ;
 *     iep:signerAddress "0x..." ;
 *     iep:created "2026-06-06T..." ;
 *     iep:ownerWebId <https://...> ;
 *     iep:descriptorId <descriptorIRI> ;
 *     iep:proofValue "0x..."
 *   ] .
 *
 * Verifiable from the descriptor ALONE: the embedded
 * `iep:verificationMethod` resolves to a public key (did:ethr:0x...
 * recovers directly; other DID methods would be resolved). The
 * canonical payload is reconstructed from (issuer, ownerWebId,
 * descriptorId, created, agentDid?) at verify time so any tampering
 * with those fields invalidates the signature.
 */
export function buildAuthorshipProofBlock(p: import('@interego/core').AuthorshipProof): string {
  // Escape minimal Turtle-literal hazards in the proof value + signer
  // address (they are hex / base64 in practice but defensive).
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines: string[] = [
    '# ── Authorship Proof (iep:SignedAuthorship) ──',
    `<> dct:conformsTo <https://markjspivey-xwisee.github.io/interego/ns/iep#SignedAuthorship> .`,
    `<> iep:authorshipProof [`,
    `    a iep:SignedAuthorship ;`,
    `    iep:scheme "${esc(p.scheme)}" ;`,
    `    iep:issuer <${p.issuer}> ;`,
    `    iep:verificationMethod <${p.verificationMethod}> ;`,
    `    iep:signerAddress "${esc(p.signerAddress)}" ;`,
    `    iep:created "${esc(p.created)}"^^xsd:dateTime ;`,
    `    iep:ownerWebId <${p.ownerWebId}> ;`,
    `    iep:descriptorId <${p.descriptorId}> ;`,
  ];
  if (p.agentDid) {
    lines.push(`    iep:agentDid "${esc(p.agentDid)}" ;`);
  }
  // ★ MUST round-trip. The verifier rebuilds the canonical payload from this block alone,
  // so a field that is signed but not serialised makes every NEW proof fail to verify —
  // a silent, total break that looks like a broken signature rather than a missing field.
  if (p.contentHash) {
    lines.push(`    iep:contentHash "${esc(p.contentHash)}" ;`);
  }
  lines.push(`    iep:proofValue "${esc(p.proofValue)}"`);
  lines.push(`] .`);
  return lines.join('\n');
}

/**
 * Parse the `iep:authorshipProof [...]` block embedded in a descriptor
 * Turtle document. Returns null when no authorship proof is present.
 * Forgiving regex-based parser (mirrors the existing
 * `parseDistributionFromDescriptorTurtle` style) so it stays in step
 * with the relay's hand-built emitter without dragging a full Turtle
 * parser into the runtime.
 */
export function parseAuthorshipProofFromDescriptorTurtle(
  turtle: string,
): import('@interego/core').AuthorshipProof | null {
  const blockMatch = turtle.match(/iep:authorshipProof\s+\[([^\]]+)\]/);
  if (!blockMatch) return null;
  const body = blockMatch[1]!;
  const read = (re: RegExp): string | undefined => {
    const m = body.match(re);
    return m?.[1];
  };
  const issuer = read(/iep:issuer\s+<([^>]+)>/);
  const verificationMethod = read(/iep:verificationMethod\s+<([^>]+)>/);
  const signerAddress = read(/iep:signerAddress\s+"([^"]+)"/);
  const created = read(/iep:created\s+"([^"]+)"/);
  const ownerWebId = read(/iep:ownerWebId\s+<([^>]+)>/);
  const descriptorId = read(/iep:descriptorId\s+<([^>]+)>/);
  const proofValue = read(/iep:proofValue\s+"([^"]+)"/);
  const scheme = read(/iep:scheme\s+"([^"]+)"/) ?? 'EcdsaSecp256k1Signature2019';
  const agentDid = read(/iep:agentDid\s+"([^"]+)"/);
  const contentHash = read(/iep:contentHash\s+"([^"]+)"/);
  if (!issuer || !verificationMethod || !signerAddress || !created
      || !ownerWebId || !descriptorId || !proofValue) {
    return null;
  }
  type IRIType = import('@interego/core').IRI;
  return {
    issuer: issuer as IRIType,
    verificationMethod: verificationMethod as IRIType,
    signerAddress,
    created,
    ownerWebId: ownerWebId as IRIType,
    descriptorId: descriptorId as IRIType,
    proofValue,
    scheme,
    ...(agentDid ? { agentDid } : {}),
    ...(contentHash ? { contentHash } : {}),
  };
}

export interface DistributionLink {
  readonly accessURL: string;
  readonly mediaType: string;
  readonly encrypted: boolean;
  readonly encryptionAlgorithm?: string;
  /**
   * Audience class declared on the affordance via `iep:visibility`. Absent
   * when the descriptor predates the visibility extension (treat as
   * `'shared'` for backwards compatibility).
   */
  readonly visibility?: 'public' | 'shared' | 'private';
}

/**
 * Parse a descriptor's affordance block and return the graph payload's
 * accessURL + media type + encryption status. Matches the canonical
 * `iep:affordance [...]` form plus a legacy `iep:hasDistribution [...]`
 * form (preserved for descriptors written before the ontology
 * realignment). Returns null when no linkage is declared.
 */
export function parseDistributionFromDescriptorTurtle(turtle: string): DistributionLink | null {
  // Canonical form: iep:affordance [ ... a dcat:Distribution ... ]
  // Legacy form:    iep:hasDistribution [ ... a dcat:Distribution ... ]
  // Try canonical first; fall back to legacy.
  let match = turtle.match(/iep:affordance\s*\[([\s\S]*?)\]/);
  if (!match) match = turtle.match(/iep:hasDistribution\s*\[([\s\S]*?)\]/);
  if (!match) return null;
  const block = match[1]!;
  // Prefer hydra:target over dcat:accessURL (they're synonymous in our
  // emission, but hydra:target is the operation-centric view for
  // dispatch; dcat:accessURL is the catalog-centric view. Either works).
  const accessUrlMatch = block.match(/hydra:target\s+<([^>]+)>/) || block.match(/dcat:accessURL\s+<([^>]+)>/);
  const mediaTypeMatch = block.match(/dcat:mediaType\s+"([^"]+)"/);
  const encryptedMatch = block.match(/iep:encrypted\s+(true|false)/);
  const algoMatch = block.match(/iep:encryptionAlgorithm\s+"([^"]+)"/);
  const visibilityMatch = block.match(/iep:visibility\s+"(public|shared|private)"/);
  if (!accessUrlMatch || !mediaTypeMatch) return null;
  const result: DistributionLink = {
    accessURL: accessUrlMatch[1]!,
    mediaType: mediaTypeMatch[1]!,
    encrypted: encryptedMatch?.[1] === 'true',
  };
  if (algoMatch) (result as { encryptionAlgorithm?: string }).encryptionAlgorithm = algoMatch[1];
  if (visibilityMatch) {
    (result as { visibility?: 'public' | 'shared' | 'private' }).visibility =
      visibilityMatch[1] as 'public' | 'shared' | 'private';
  }
  return result;
}

// ═════════════════════════════════════════════════════════════
//  Fetch & decrypt an encrypted graph payload
// ═════════════════════════════════════════════════════════════

/**
 * Fetch a graph URL that may be an encrypted envelope and return plaintext
 * if the caller's key is a recipient. Plaintext TriG passes through
 * unchanged. Returns null when the caller isn't a recipient (authorized
 * but no wrapped key for their public key) or decryption fails.
 */
export async function fetchGraphContent(
  graphUrl: string,
  options: { fetch?: FetchFn; recipientKeyPair?: EncryptionKeyPair } = {},
): Promise<{ content: string | null; encrypted: boolean; mediaType: string }> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const r = await withTransientRetry(async () => {
    const resp = await fetchFn(graphUrl, { headers: { 'Accept': `${ENVELOPE_CONTENT_TYPE}, ${TRIG_CONTENT_TYPE}, ${TURTLE_CONTENT_TYPE}` } });
    if (!resp.ok) throw new Error(`Failed to GET ${graphUrl}: ${resp.status} ${resp.statusText}`);
    return resp;
  });
  const mediaType = r.headers?.get('Content-Type') ?? '';
  const body = await r.text();

  const looksLikeEnvelope = graphUrl.endsWith('.envelope.jose.json') || mediaType.includes('jose') || mediaType.includes('json');
  if (!looksLikeEnvelope) {
    return { content: body, encrypted: false, mediaType };
  }
  // Attempt envelope parse; if it's malformed JSON, surface body as-is.
  let env: EncryptedEnvelope;
  try {
    env = JSON.parse(body) as EncryptedEnvelope;
  } catch {
    return { content: body, encrypted: false, mediaType };
  }
  if (!env || env.algorithm !== 'X25519-XSalsa20-Poly1305' || !Array.isArray(env.wrappedKeys)) {
    return { content: body, encrypted: false, mediaType };
  }
  if (!options.recipientKeyPair) {
    return { content: null, encrypted: true, mediaType };
  }
  const plaintext = openEncryptedEnvelope(env, options.recipientKeyPair);
  return { content: plaintext, encrypted: true, mediaType };
}

// ═════════════════════════════════════════════════════════════
//  discover()
// ═════════════════════════════════════════════════════════════

/**
 * Discover Context Descriptors published on a Solid pod.
 *
 * Fetches the .well-known/context-graphs manifest, parses it,
 * and returns entries optionally filtered by facet type,
 * temporal range, trust level, or modal status.
 *
 * @param podUrl - Root URL of the Solid pod.
 * @param filter - Optional filter criteria.
 * @param options - Optional configuration.
 * @returns Matching manifest entries.
 */
export async function discover(
  podUrl: string,
  filter?: DiscoverFilter,
  options: DiscoverOptions = {},
): Promise<ManifestEntry[]> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const manifestUrl = `${pod}${MANIFEST_PATH}`;

  // ★ FOLLOWS THE ARCHIVE CHAIN. On an unbounded pod this is exactly the single GET it always
  // was; on a bounded one it unions the hot document with the segments the document itself
  // links, absolutizing and deduplicating (hot wins). `discover()` is the substrate's answer
  // to "what is on this pod", so a partial answer here is the absence-as-evidence defect: it
  // REFUSES below rather than return a short list, in the one case where it cannot be sure.
  //
  // The 5xx-as-throw promotion the manifest GET has always needed now lives inside
  // `fetchManifestChain` — a cold-cache 503 arrives as a RETURNED response, not a thrown
  // network error, so `withTransientRetry` only retries it if the lambda throws. Without it a
  // single 503 escaped the retry loop and surfaced as `precondition_unavailable` to every
  // caller relying on the manifest read, including the Phase A CAS pre-flight in the relay's
  // publish_context handler. The thrown message keeps its exact wording — callers and the
  // suite match on `Failed to fetch manifest from` — and embeds the status digits so the
  // helper's TRANSIENT_PATTERN (/5\d\d/) matches.
  const all = await fetchAllManifestEntries(manifestUrl, fetchFn);

  if (all.hotStatus !== 200 && all.hotStatus !== 404) {
    throw new Error(
      `Failed to fetch manifest from ${manifestUrl}: ${all.hotStatus} (after transient retries)`,
    );
  }
  if (!all.complete) {
    // A manifest that SAYS it has archives, and archives we could not read, is a pod whose
    // size we do not know. Returning the hot slice would be a smaller pod reported as the
    // pod — silently, with no way for the caller to notice. Throwing is the honest failure.
    throw new Error(
      `Manifest at ${manifestUrl} is bounded and ${all.archivesUnreachable.length} archive segment(s) could not be read `
      + `(${all.archivesUnreachable.join(', ')}); refusing to report a partial pod as complete`,
    );
  }
  // Relative entry URLs were already resolved against the manifest base by
  // fetchAllManifestEntries. CSS may serialize same-origin descriptor URLs as RELATIVE (e.g.
  // `../context-graphs/X.ttl`) after a PATCH triggers a re-serialize; downstream consumers
  // call fetch()/new URL() on `descriptorUrl`/`describes`, which throws on a relative string.
  const entries: ManifestEntry[] = all.entries;

  // Apply filter, then sort, then limit. Order matters: filter first
  // so the sort+limit operate over the relevant slice; sort before
  // limit so 'latest N' actually returns the N most-recent matches
  // rather than the N first matches in server-native order.
  const filtered = filter
    ? entries.filter(entry => matchesFilter(entry, filter))
    : entries;

  const sortMode = filter?.sort ?? 'newest-first';
  let sorted: ManifestEntry[] = filtered;
  if (sortMode !== 'unsorted') {
    // Sort by `validFrom` (the descriptor's own declared instant of
    // becoming valid — same field publish() stamps with the publish
    // moment). Entries lacking validFrom sink to the end on
    // newest-first, rise to the front on oldest-first — consistent
    // with treating "no declared start" as "indeterminate, deprioritize
    // when ranking by recency."
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a.validFrom ?? '';
      const bv = b.validFrom ?? '';
      if (sortMode === 'newest-first') {
        if (!av && bv) return 1;
        if (av && !bv) return -1;
        if (av === bv) return 0;
        return av < bv ? 1 : -1;
      }
      // oldest-first
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      if (av === bv) return 0;
      return av < bv ? -1 : 1;
    });
    sorted = copy;
  }

  if (filter?.limit !== undefined && filter.limit >= 0) {
    return sorted.slice(0, filter.limit);
  }
  return sorted;
}

// ═════════════════════════════════════════════════════════════
//  subscribe()
// ═════════════════════════════════════════════════════════════

/**
 * Subscribe to context-graph changes on a Solid pod using the
 * Solid Notifications Protocol (WebSocket channel).
 *
 * Discovery follows the Solid Protocol:
 *   1. HEAD the pod URL to find the storage description via
 *      Link rel="http://www.w3.org/ns/solid/terms#storageDescription".
 *   2. GET the storage description (Turtle) and parse the
 *      WebSocketChannel2023 subscription endpoint.
 *   3. POST a subscription request for the context-graphs resource.
 *   4. Open a WebSocket to the returned receiveFrom URL.
 *
 * @see https://solidproject.org/TR/notifications-protocol
 *
 * @param podUrl - Root URL of the Solid pod.
 * @param callback - Invoked on each context-graph change event.
 * @param options - Optional configuration.
 * @returns A Subscription handle with an unsubscribe() method.
 */
export async function subscribe(
  podUrl: string,
  callback: ContextChangeCallback,
  options: SubscribeOptions = {},
): Promise<Subscription> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const WS = options.WebSocket ?? getDefaultWebSocket();
  const pod = ensureTrailingSlash(podUrl);
  const topic = `${pod}${MANIFEST_PATH}`;

  // Step 1: Discover the storage description URL.
  // Per Solid Protocol, any resource's response includes a Link header
  // with rel="http://www.w3.org/ns/solid/terms#storageDescription".
  const headResponse = await withTransientRetry(() => fetchFn(pod, {
    method: 'HEAD',
  }));

  let storageDescUrl: string | undefined;

  // Parse Link header for storageDescription
  const linkHeader = headResponse.headers?.get('link') ?? headResponse.headers?.get('Link') ?? '';
  const storageDescMatch = linkHeader.match(/<([^>]+)>;\s*rel="http:\/\/www\.w3\.org\/ns\/solid\/terms#storageDescription"/);
  if (storageDescMatch) {
    storageDescUrl = storageDescMatch[1]!;
  }

  // Fallback: try .well-known/solid at the pod URL
  if (!storageDescUrl) {
    storageDescUrl = `${pod}.well-known/solid`;
  }

  // Step 2: Fetch the storage description to find the notification endpoint.
  const descResponse = await withTransientRetry(() => fetchFn(storageDescUrl, {
    method: 'GET',
    headers: { 'Accept': 'text/turtle' },
  }));

  if (!descResponse.ok) {
    throw new Error(
      `Failed to fetch storage description from ${storageDescUrl}: ${descResponse.status} ${descResponse.statusText}`,
    );
  }

  const descBody = await descResponse.text();

  // Parse the WebSocket subscription endpoint from the Turtle description.
  // CSS returns Turtle like:
  //   <../.notifications/WebSocketChannel2023/> notify:channelType notify:WebSocketChannel2023 .
  // The URL may be relative (CSS uses relative IRIs) — resolve against the description URL.
  let subscriptionEndpoint: string | undefined;

  const wsEndpointMatch = descBody.match(/<([^>]*WebSocketChannel2023[^>]*)>/);
  if (wsEndpointMatch) {
    const raw = wsEndpointMatch[1]!;
    // Resolve relative URLs against the storage description URL
    try {
      subscriptionEndpoint = new URL(raw, storageDescUrl).href;
    } catch {
      subscriptionEndpoint = raw;
    }
  }

  // Fallback: construct the conventional CSS path
  if (!subscriptionEndpoint) {
    const serverRoot = storageDescUrl.replace(/\.well-known\/solid$/, '');
    subscriptionEndpoint = `${serverRoot}.notifications/WebSocketChannel2023/`;
  }

  // Step 3: Request a WebSocket subscription for the topic.
  const subResponse = await withTransientRetry(() => fetchFn(subscriptionEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify({
      '@context': ['https://www.w3.org/ns/solid/notification/v1'],
      type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
      topic,
    }),
  }));

  if (!subResponse.ok) {
    throw new Error(
      `Failed to subscribe at ${subscriptionEndpoint}: ${subResponse.status} ${subResponse.statusText}`,
    );
  }

  const subResult = await subResponse.json() as Record<string, unknown>;
  const wsUrl = (subResult['receiveFrom'] ?? subResult['source']) as string;

  if (!wsUrl) {
    throw new Error('Subscription response did not contain a WebSocket URL (receiveFrom)');
  }

  // Step 4: Open WebSocket and listen for notifications.
  //
  // Some WebSocket implementations throw synchronously from the
  // constructor on transient failures (DNS hiccup, refused connect).
  // We retry the open itself with the same backoff schedule the rest
  // of the substrate uses — but only for the open. Once the channel
  // is established the long-lived stream is the caller's resume
  // problem; we deliberately do not paper over disconnects below.
  const ws = await withTransientRetry(() => Promise.resolve(new WS(wsUrl)));

  ws.onmessage = (event: { data: unknown }) => {
    try {
      const notification = JSON.parse(
        typeof event.data === 'string' ? event.data : '',
      ) as Record<string, unknown>;

      let changeType: ContextChangeEvent['type'];
      const asType = notification['type'] as string | undefined;
      if (asType === 'Add' || asType === 'Create') {
        changeType = 'Add';
      } else if (asType === 'Update') {
        changeType = 'Update';
      } else if (asType === 'Remove' || asType === 'Delete') {
        changeType = 'Remove';
      } else {
        changeType = 'Update';
      }

      const objectVal = notification['object'];
      const resource =
        typeof objectVal === 'string'
          ? objectVal
          : (typeof objectVal === 'object' && objectVal !== null
              ? (objectVal as Record<string, unknown>)['id'] as string
              : topic);

      callback({
        resource,
        type: changeType,
        timestamp:
          (notification['published'] as string) ??
          new Date().toISOString(),
      });
    } catch {
      // Ignore unparseable messages (e.g. ping frames)
    }
  };

  return {
    unsubscribe: () => {
      ws.close();
    },
  };
}

// ═════════════════════════════════════════════════════════════
//  Agent Registry — pod-level owner/agent delegation
// ═════════════════════════════════════════════════════════════

/**
 * Write an owner profile (agent registry) to a Solid pod.
 *
 * Stores the profile at `{podUrl}/agents` as Turtle containing:
 *   - The owner's WebID and name
 *   - All authorized agents with scope, validity, and revocation status
 *
 * @param profile - The owner profile to write
 * @param podUrl - Root URL of the Solid pod
 * @param options - Optional configuration
 * @returns The URL where the registry was written
 */
export async function writeAgentRegistry(
  profile: OwnerProfileData,
  podUrl: string,
  options: RegistryOptions = {},
): Promise<string> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const registryUrl = `${pod}${AGENT_REGISTRY_PATH}`;
  const turtle = ownerProfileToTurtle(profile);

  const resp = await fetchFn(registryUrl, {
    method: 'PUT',
    headers: { 'Content-Type': TURTLE_CONTENT_TYPE },
    body: turtle,
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to write agent registry to ${registryUrl}: ${resp.status} ${resp.statusText}`,
    );
  }

  return registryUrl;
}

/**
 * Read an owner profile (agent registry) from a Solid pod.
 *
 * @param podUrl - Root URL of the Solid pod
 * @param options - Optional configuration
 * @returns The parsed owner profile, or null if not found
 */
export async function readAgentRegistry(
  podUrl: string,
  options: RegistryOptions = {},
): Promise<OwnerProfileData | null> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const registryUrl = `${pod}${AGENT_REGISTRY_PATH}`;

  const resp = await fetchFn(registryUrl, {
    method: 'GET',
    headers: { 'Accept': TURTLE_CONTENT_TYPE },
  });

  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(
      `Failed to read agent registry from ${registryUrl}: ${resp.status} ${resp.statusText}`,
    );
  }

  const turtle = await resp.text();
  return parseOwnerProfile(turtle);
}

/**
 * Write a delegation credential to a Solid pod.
 *
 * Stores the credential at `{podUrl}/credentials/{agentId}.jsonld`
 * as JSON-LD conforming to the VC Data Model 2.0.
 *
 * @param credential - The delegation credential to write
 * @param podUrl - Root URL of the Solid pod
 * @param options - Optional configuration
 * @returns The URL where the credential was written
 */
export async function writeDelegationCredential(
  credential: AgentDelegationCredential,
  podUrl: string,
  options: RegistryOptions = {},
): Promise<string> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const agentSlug = encodeURIComponent(credential.credentialSubject.id);
  const credentialUrl = `${pod}${CREDENTIALS_PATH}${agentSlug}.jsonld`;
  const jsonLd = delegationCredentialToJsonLd(credential);

  const resp = await fetchFn(credentialUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: jsonLd,
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to write credential to ${credentialUrl}: ${resp.status} ${resp.statusText}`,
    );
  }

  return credentialUrl;
}

/**
 * Read a signed delegation credential from a Solid pod.
 *
 * Returns `null` when no credential exists for the agent. Used by
 * `verifyAgentDelegation` when a `verifier` is supplied: the credential
 * is rehydrated, its canonical payload is recomputed, and the proof block
 * is checked against the owner's wallet key.
 */
export async function readDelegationCredential(
  podUrl: string,
  agentId: IRI,
  options: RegistryOptions = {},
): Promise<AgentDelegationCredential | null> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const agentSlug = encodeURIComponent(agentId);
  const credentialUrl = `${pod}${CREDENTIALS_PATH}${agentSlug}.jsonld`;

  const resp = await fetchFn(credentialUrl, {
    method: 'GET',
    headers: { 'Accept': 'application/ld+json' },
  });
  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(
      `Failed to read delegation credential from ${credentialUrl}: ${resp.status} ${resp.statusText}`,
    );
  }
  const jsonLd = await resp.text();
  return parseDelegationCredential(jsonLd);
}

/**
 * Options for `verifyAgentDelegation` — extends the registry options with
 * an optional `verifier` callback that turns the function into a
 * cryptographic chain check. When supplied, verifyAgentDelegation walks
 * the signed VC chain from the agent up to the pod owner and only
 * returns `trustLevel: 'CryptographicallyVerified'` if every link
 * validates.
 */
export interface VerifyAgentDelegationOptions extends RegistryOptions {
  /** Cryptographic verifier for VC proof blocks. */
  readonly verifier?: DelegationVerifier;
  /** Whether to walk sub-delegation chains (default true). */
  readonly walkSubDelegations?: boolean;
  /** Maximum chain depth before erroring out (default 8). */
  readonly maxChainLength?: number;
}

/**
 * Verify that an agent is authorized to act on a pod by checking the
 * pod's agent registry, and — when a `verifier` is supplied — its signed
 * delegation credential chain.
 *
 * Without a verifier, the result mirrors the legacy registry-only check
 * and carries `trustLevel: 'SelfAsserted'`. With a verifier, the signed
 * VC at `<pod>/credentials/<agentId>.jsonld` is fetched, its proof is
 * checked against the owner's wallet key, and any sub-delegation chain
 * is walked to the pod owner — only then is the result labelled
 * `'CryptographicallyVerified'`.
 *
 * @param agentId - The agent claiming delegation
 * @param podUrl - The pod URL being acted on
 * @param options - Optional configuration (fetch, verifier, chain limits)
 * @returns Verification result
 */
export async function verifyAgentDelegation(
  agentId: IRI,
  podUrl: string,
  options: VerifyAgentDelegationOptions = {},
): Promise<DelegationVerification> {
  return verifyDelegation(
    agentId,
    podUrl,
    async (url: string) => readAgentRegistry(url, options),
    options.verifier
      ? {
          fetchCredential: async (url, agent) => readDelegationCredential(url, agent, options),
          verifier: options.verifier,
          walkSubDelegations: options.walkSubDelegations,
          maxChainLength: options.maxChainLength,
        }
      : {},
  );
}

// ─────────────────────────────────────────────────────────────
//  verify_agent response envelope (shared by MCP shims)
// ─────────────────────────────────────────────────────────────

/**
 * Stable response envelope returned by every `verify_agent` MCP tool
 * (both the stdio shim under `mcp-server/` and the HTTP relay under
 * `deploy/mcp-relay/`).
 *
 * Why this exists: the raw `DelegationVerification` shape uses
 * trust-label string-discrimination (`trustLevel === 'CryptographicallyVerified'`)
 * to tell registry-only from chain-walked results. Downstream agents
 * (claude.ai connector, ChatGPT, codex/cursor bridges, regulators)
 * need to branch on a single boolean — they should not have to parse
 * `trustLevel` strings. So we surface `delegationChain` as a concrete
 * object iff the chain walk succeeded, and `null` otherwise.
 *
 * The raw `valid` / `owner` / `agent` / `scope` fields stay alongside
 * so the v0.4 wire shape still passes through; this is additive.
 */
export interface VerifyAgentEnvelope {
  /**
   * The pod this verdict is ABOUT — `null` only when no subject could be resolved.
   *
   * ★ WHY A VERDICT MUST NAME ITS SUBJECT. Without this the envelope answered "is this
   * agent authorised?" without saying WHERE, so the answer to a question about someone
   * else's pod and the answer to a question about your own were byte-identical
   * documents. That is what made the `pod_name`-ignored defect invisible rather than
   * merely wrong: `verify_agent { agent_id, pod_name: "<not yours>" }` returned
   * `verified: true, CryptographicallyVerified` about the CALLER's pod (measured live),
   * and there was no field a caller could read to tell. An authority answer that cannot
   * be attributed to a subject is not checkable.
   */
  readonly subjectPodUrl: string | null;
  /** Wire spelling of {@link subjectPodUrl}; both are emitted so either name reads. */
  readonly subject_pod_url: string | null;
  readonly verified: boolean;
  readonly trustLevel: 'CryptographicallyVerified' | 'SelfAsserted';
  /**
   * Number of signed links in the verified chain. 0 when verification
   * failed before any link could be checked; 1 for a direct
   * owner→agent delegation; n>1 for sub-delegated chains.
   */
  readonly chainLength: number;
  /**
   * Concrete chain block, ONLY populated when
   * `trustLevel === 'CryptographicallyVerified'`. Clients branch on
   * `delegationChain != null` to gate cryptographic-trust paths.
   */
  readonly delegationChain: {
    readonly anchored: true;
    readonly owner?: IRI;
    readonly agent?: IRI;
    readonly scope?: string;
    readonly length: number;
  } | null;
  readonly reason: string | null;
  // Raw fields kept for back-compat.
  readonly valid: boolean;
  readonly owner?: IRI;
  readonly agent?: IRI;
  readonly scope?: string;
}

/**
 * Wrap a `DelegationVerification` (the raw result returned by
 * `verifyAgentDelegation`) in the stable `verify_agent` envelope.
 *
 * Factored out so the stdio shim under `mcp-server/server.ts` and the
 * HTTP shim under `deploy/mcp-relay/server.ts` emit byte-equivalent
 * JSON for the same `(agent_id, pod_url)` input — wire-format drift
 * between the two surfaces was the original observable bug
 * (johnny's `{ verified, agents:[...] }` paraphrase did not match the
 * stdio text-summary that callers actually hit).
 */
export function buildVerifyAgentEnvelope(
  result: DelegationVerification,
  /**
   * The pod the verdict is about. Required by callers that resolved one; `undefined`
   * only on the path where no subject could be resolved and the envelope is a refusal.
   */
  subjectPodUrl?: string,
): VerifyAgentEnvelope {
  const trustLevel = result.trustLevel ?? 'SelfAsserted';
  const chainLength = result.chainLength ?? (result.valid ? 1 : 0);
  const cryptographicallyVerified = result.valid && trustLevel === 'CryptographicallyVerified';
  const subject = subjectPodUrl ?? null;
  return {
    subjectPodUrl: subject,
    subject_pod_url: subject,
    verified: result.valid,
    trustLevel,
    chainLength,
    delegationChain: cryptographicallyVerified
      ? {
          anchored: true,
          owner: result.owner,
          agent: result.agent,
          scope: result.scope,
          length: chainLength,
        }
      : null,
    reason: result.reason ?? null,
    valid: result.valid,
    owner: result.owner,
    agent: result.agent,
    scope: result.scope,
  };
}
