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
 * The ADVERTISED (dereference) host for a holon URL. The canonical write target
 * is the env-internal CSS host (placement.target, reachable in-env), but a
 * iep:encryptedHolon link is meant to be fetched cross-seat — including by a
 * direct (non-relay) consumer doing owner-decrypt, for whom the env-internal
 * host is unreachable. So the ADVERTISED url is rewritten to the public pod
 * origin (the write-gate) when one is configured (FOXXI_TENANT_POD_URL's
 * origin). The WRITE target is unchanged; only the link embedded in the
 * projection is rewritten. This is signature-safe: the iep:Projection carries NO
 * authorship proof, and the encrypted-holon JWE bytes at the URL are never
 * touched (the path is identical — only the host differs, and the gate routes
 * the path to the same CSS resource). No-op when no public origin is configured
 * or the url is not an env-internal host.
 */
function toAdvertisedHolonUrl(url: string): string {
  const tenant = process.env.FOXXI_TENANT_POD_URL;
  if (!tenant) return url;
  try {
    const pub = new URL(tenant);
    const u = new URL(url);
    if (u.host.includes('.internal.') && u.host !== pub.host) {
      u.protocol = pub.protocol;
      u.host = pub.host;
      return u.toString();
    }
  } catch { /* leave as-is on parse failure */ }
  return url;
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
