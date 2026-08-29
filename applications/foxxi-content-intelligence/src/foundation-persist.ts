/**
 * foundation-persist.ts — end-to-end foundation-first persistence for the Foxxi
 * vertical, composing the four substrate stages into one call:
 *
 *   Stage 1  resolveStorageForShape  — WHERE (agent's Solid Type Index, hypermedia;
 *                                       non-breaking fallback container)
 *   Stage 2  promoteToPodEncrypted   — the holon as the CANONICAL, ENCRYPTED pod
 *                                       resource (ciphertext at rest)
 *   Stage 3  projectHolon            — a cg-RDF descriptor + manifest entry that
 *                                       are deterministic RENDERS of the holon
 *
 * The holon (PGSL node) is the source of truth; the descriptor/manifest entry are
 * projections that point back at it via iep:pgslUri (content-addressed, so
 * structural overlap is detectable across pods). This is ADDITIVE — it does not
 * replace the existing RDF publish path; a caller can run both, exposing agents
 * both altitudes (encrypted canonical PGSL + discoverable RDF projection).
 *
 * Composes existing substrate primitives only (see [[feedback_compose_dont_reinvent]]).
 */
import { resolveStorageForShape, type StorageResolution } from '@interego/solid';
import {
  promoteInstanceEncrypted,
  resolveLatticeFromPod,
  projectHolon,
  renderManifestEntry,
  descriptorSlug,
  type PGSLInstance,
  type Node as PgslNode,
} from '@interego/pgsl';
import type { IRI, ManifestEntry } from '@interego/core';
import type { EncryptionKeyPair } from '@interego/core';
import type { FetchFn } from '@interego/core/http';
// One answer to 'is this URL on our own store, and how is it spelled publicly'. The rule lives in
// that module; bridge/server.ts supplies it the two names at start-up.
import { publicSpellingOf, storeSpelling } from './store-origins.js';

export interface FoundationPersistOptions {
  /** Subject agent identity (WebID / pod URL) whose Type Index resolves placement. */
  readonly agent: string;
  /** The data shape (a shape IRI) — apps reference the SHAPE, not a path. */
  readonly shapeClass: string;
  /** Non-breaking fallback container (relative to pod root) if the shape isn't registered. */
  readonly defaultContainer: string;
  /** The lattice + the holon URI to persist as the canonical encrypted resource. */
  readonly pgsl: PGSLInstance;
  readonly holonUri: string;
  /** Recipients who may decrypt the canonical holon (their public keys). */
  readonly recipientPublicKeys: readonly string[];
  /** The writer's encryption keypair (envelope sender). */
  readonly senderKeyPair: EncryptionKeyPair;
  /** Write-authorized fetch (Bearer/connector). */
  readonly fetch: FetchFn;
  /** Also PUT the projected descriptor as a pod resource. Default true. */
  readonly writeDescriptor?: boolean;
}

export interface FoundationPersistResult {
  /** How placement was resolved — the agent's Type Index, or the fallback. */
  readonly placement: StorageResolution;
  /** Content graph IRI (the holon's content-addressed URI). */
  readonly graphUri: string;
  /** Where the ENCRYPTED canonical holon was written. */
  readonly holonResourceUrl: string;
  /** Where the cg-RDF descriptor projection lives. */
  readonly descriptorUrl: string;
  /** The manifest entry (index row) projected from the holon. */
  readonly manifestEntry: ManifestEntry;
}

/** Resource URL for the encrypted canonical holon under a container. */
function holonResourceUrlFor(container: string, holonUri: string): string {
  const base = container.endsWith('/') ? container : `${container}/`;
  return `${base}${descriptorSlug(holonUri)}.holon.json`;
}

/**
 * The ADVERTISED (dereference) host for a holon URL. The canonical write target is the env-internal
 * CSS host (placement.target, reachable in-env), but a iep:encryptedHolon link is meant to be
 * fetched cross-seat — including by a direct (non-relay) consumer doing owner-decrypt, for whom the
 * env-internal host is unreachable. So the ADVERTISED url is re-spelled onto the public pod origin
 * (the write-gate). The WRITE target is unchanged; only the link embedded in the projection is
 * rewritten. Signature-safe: the iep:Projection carries NO authorship proof, and the encrypted-holon
 * JWE bytes at the URL are never touched (the path is identical — only the host differs, and the
 * gate routes the path to the same CSS resource).
 *
 * ── ★★ IT ASKED "DOES THE HOST CONTAIN '.internal.'", AND THAT WAS WRONG BOTH WAYS ──────────
 *
 * MEASURED by executing this function's own shipped body over the hosts this deployment actually
 * has:
 *
 *   "http://css.railway.internal:3456/eth-abc/x.holon.json"   -> unchanged   (should be rewritten)
 *   "https://a.internal.evil.example/eth-VICTIM/x.holon.json" -> REWRITTEN onto our public origin
 *
 * ★ THE FALSE NEGATIVE IS THE LIVE ONE, and it is a provider migration nobody could see. The dotted
 * ".internal." appears in an Azure Container Apps internal FQDN
 * ("interego-css.internal.livelysky-<id>.eastus.azurecontainerapps.io"), which is what this test was
 * written against. Railway's internal host is "css.railway.internal:3456" — ".internal" is the final
 * label, so nothing follows the second dot and the substring never matches. The fleet moved and this
 * quietly stopped doing anything, with no error on either side of it.
 *
 * ★ WHO IS AFFECTED, stated as what was actually established rather than as a production count.
 * `placement.target` follows the pod URL this is given, and a relay-stamped `subject_pod_url`
 * arrives in the internal spelling — `selfBoundPod` in bridge/server.ts honours exactly that
 * spelling as the caller's own pod, which was driven against the shipped function. So for a caller
 * whose pod arrives that way the holon is written to the in-env host, and the advertised link kept
 * it: the failure this function was added to fix, with the function inert. What has not been
 * measured here is how many live records that is.
 *
 * ★ THE FALSE POSITIVE IS THE RELAY'S OWN DEFECT, IN THIS TREE. placement.target is an ABSOLUTE url
 * read verbatim out of the agent's own Solid Type Index (packages/solid/src/type-index.ts returns
 * `new URL(target, tiUrl).toString()`), so an agent that writes its own registration chooses this
 * input. A host of the form "a.internal.evil.example" then had its origin replaced with ours and its
 * PATH carried across — a foreign address laundered into a link that names our store, which is what
 * the relay's `toInternalPodUrl` was doing when it discarded the host and pasted the path onto the
 * local store.
 *
 * ★ SO IT IS ASKED AS WHOLE-ORIGIN MEMBERSHIP — see src/store-origins.ts, which holds the rule and
 * reads no environment variable. A URL on any other origin is returned untouched, and with no
 * spelling configured at all nothing is re-spelled onto us either.
 *
 * ★ AND THE BRIDGE STILL HAS ITS OWN ANSWER, WHICH IS NOT THE SAME AS SAYING IT DISAGREES.
 * bridge/server.ts builds SAME_STORE_ORIGINS from the same two names and the same default, and its
 * `canonicalPublicPodUrl` is this rule for pod URLs; the two were run side by side over fourteen
 * inputs — a foreign origin, a lookalike origin, an opaque scheme, an unparseable string, a default
 * port, userinfo, and both spellings of this store — and agreed on all fourteen. Collapsing them
 * into one call is the right end state and is NOT done here: the pin in
 * tests/the-identifier-is-not-the-question.test.ts is on that function's body TEXT, so the collapse
 * edits a file outside this vertical.
 *
 * ★ THE ENV FALLBACK STAYS ONLY AS A FALLBACK. bridge/server.ts calls `configureStoreSpelling` at
 * start-up with both names; the read below is what a deployment that never configured one still
 * gets, and is the same variable this function already read.
 */
function toAdvertisedHolonUrl(url: string): string {
  return publicSpellingOf(url, storeSpelling(process.env.FOXXI_TENANT_POD_URL ?? ''));
}

/**
 * Persist a holon as the canonical encrypted pod resource and project its
 * discoverable descriptor + manifest entry — placed via the agent's own Type
 * Index. Returns everything needed to update a manifest / hand an agent both
 * altitudes. Throws on a hard write failure (412 preconditions are tolerated by
 * the underlying promote).
 */
export async function persistEncryptedHolonProjection(
  opts: FoundationPersistOptions,
): Promise<FoundationPersistResult> {
  // Stage 1 — WHERE (hypermedia-resolved, per-agent, non-breaking fallback).
  const placement = await resolveStorageForShape(opts.agent, opts.shapeClass, {
    fetch: opts.fetch,
    defaultContainer: opts.defaultContainer,
  });

  // Stage 2 — the canonical, encrypted holon resource. The lattice instance is
  // built fresh per artifact, so persist the WHOLE instance (every node, all
  // chains): the encrypted resource is then a self-contained, decryptable
  // reconstruction of the artifact — not a top node with dangling item URIs.
  const holonResourceUrl = holonResourceUrlFor(placement.target, opts.holonUri);
  await promoteInstanceEncrypted(
    opts.pgsl,
    opts.holonUri,
    holonResourceUrl,
    opts.recipientPublicKeys,
    opts.senderKeyPair,
    opts.fetch as unknown as typeof fetch,
  );

  // Stage 3 — the descriptor + manifest entry as deterministic renders.
  const node = opts.pgsl.nodes.get(opts.holonUri);
  if (!node) throw new Error(`Holon not found in lattice: ${opts.holonUri}`);
  const projection = projectHolon(node, opts.pgsl, {
    descriptorBase: placement.target,
    // Advertise the cross-seat-reachable (gate) host for the encrypted-holon
    // link; the write above still targets the canonical internal host. The
    // path is identical, so the gate serves the same JWE — owner-decrypt works
    // from a foreign seat without the relay. Signature-safe (projection has no
    // authorship proof; ciphertext untouched).
    encryptedHolonUrl: toAdvertisedHolonUrl(holonResourceUrl),
  });

  if (opts.writeDescriptor !== false) {
    const put = await opts.fetch(projection.descriptorUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: projection.descriptorTurtle,
    });
    if (!put.ok && put.status !== 412) {
      throw new Error(`descriptor PUT <${projection.descriptorUrl}> -> ${put.status} ${put.statusText}`);
    }
  }

  return {
    placement,
    graphUri: projection.graphUri,
    holonResourceUrl,
    descriptorUrl: projection.descriptorUrl,
    manifestEntry: projection.manifestEntry,
  };
}

/**
 * Read back + decrypt the full canonical lattice slice persisted by
 * {@link persistEncryptedHolonProjection}. Returns the top URI + every node
 * (so the caller can walk/rebuild the whole artifact), or null if unauthorized
 * / unreadable. Convenience binding over the substrate resolver.
 */
export async function readEncryptedHolon(
  holonResourceUrl: string,
  recipientKeyPair: EncryptionKeyPair,
  fetchFn: FetchFn,
): Promise<{ topUri: IRI; nodes: Map<IRI, PgslNode> } | null> {
  return resolveLatticeFromPod(holonResourceUrl, recipientKeyPair, fetchFn as unknown as typeof fetch);
}

/** Render the projected manifest entry as a iep:ManifestEntry Turtle row. */
export function manifestRowFor(result: FoundationPersistResult): string {
  return renderManifestEntry(result.manifestEntry);
}
