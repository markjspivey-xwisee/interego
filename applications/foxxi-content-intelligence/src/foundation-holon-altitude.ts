/**
 * foundation-holon-altitude.ts — shared "second altitude" for Foxxi artifacts.
 *
 * Every durable Foxxi artifact (recorded performance, authored course, issued
 * credential) is written as an authoritative RDF record (the existing path) AND,
 * additively, as an ENCRYPTED CANONICAL PGSL HOLON + a projected cg-RDF
 * descriptor — placed via the subject's own Solid Type Index. This module is the
 * single, DRY entry point both flows call, so the encryption keypair + best-effort
 * semantics live in one place rather than copied per call site.
 *
 * Foundation-first: the holon is the canonical, content-addressed, encrypted form;
 * the RDF record + projected descriptor are projections over it (the descriptor
 * carries iep:pgslUri back to the holon). Holons are built via the Foxxi-vertical
 * ingestion profiles (xapi for performances, lers for credentials) — xAPI/LERS are
 * Foxxi concerns, not substrate primitives, so the vertical registers them here.
 *
 * Best-effort by design: any failure (no seed, unreachable pod, profile mismatch)
 * is swallowed so the authoritative RDF path is never affected (non-breaking).
 */
import type { PGSLInstance } from '@interego/pgsl';
import { deriveEncryptionKeyPair, type EncryptionKeyPair } from '@interego/core';
import type { IRI, FetchFn } from '@interego/core';
import { createPGSL } from '@interego/pgsl';
import { resolveAgentEncryptionKey } from '@interego/solid';
import { guardedFetchFn } from './ssrf-guard.js';
import { persistEncryptedHolonProjection } from './foundation-persist.js';
import { registerFoxxiIngestionProfiles } from './pgsl-ingestion-profiles.js';
import { createHash } from 'node:crypto';

// The vertical registers its PGSL ingestion profiles (xapi, lers) onto the
// substrate registry at module load — so ingestWithProfile(pgsl, 'xapi'|'lers')
// resolves wherever this altitude is used.
registerFoxxiIngestionProfiles();

/** Bridge encryption keypair, derived once from a pinned seed. Null if no seed
 *  is configured — in which case the encrypted-holon altitude is skipped and only
 *  the authoritative RDF record is written (fully non-breaking). */
let _bridgeKp: EncryptionKeyPair | null | undefined;
export function bridgeEncryptionKeypair(): EncryptionKeyPair | null {
  if (_bridgeKp !== undefined) return _bridgeKp;
  const seed = process.env.FOXXI_WALLET_SEED || process.env.FOXXI_ISSUER_KEY_SEED || '';
  _bridgeKp = seed
    ? deriveEncryptionKeyPair(createHash('sha256').update(seed).digest('hex'))
    : null;
  return _bridgeKp;
}

export interface EncryptedHolonAltitudeOptions {
  /** Subject agent's pod (system of record) whose Type Index resolves placement. */
  podUrl: string;
  /** The agent/issuer the artifact is attributed to (becomes holon provenance). */
  agentDid: string;
  /** The artifact's data shape (a shape IRI) — apps reference the SHAPE, not a path. */
  shapeClass: IRI;
  /** Non-breaking fallback container if the shape isn't registered in the Type Index. */
  defaultContainer: string;
  /** Write-authorized fetch. */
  fetch?: FetchFn;
  /** Build the holon for this artifact in the given lattice; return its top URI
   *  (or null to skip). Typically ingestWithProfile(pgsl, 'xapi'|'lers', ...). */
  build: (pgsl: PGSLInstance, prov: { wasAttributedTo: IRI; generatedAtTime: string }) => string | null;
  /** ADDITIONAL recipient pods (beyond the owner + bridge) whose DURABLE
   *  self-published key (`<pod>/keys/encryption.json`) should also be wrapped,
   *  so those agents can owner-decrypt the canonical holon cross-seat. Each is
   *  resolved via resolveAgentEncryptionKey; any that does not resolve is simply
   *  skipped (best-effort, non-breaking). This is the durable-key recipient path
   *  — distinct from publish_context's share_with, which consumes session keys. */
  additionalRecipientPods?: readonly string[];
}

/**
 * ADDITIVE: persist the artifact as an encrypted canonical PGSL holon + a
 * projected cg-RDF descriptor, placed via the agent's own Type Index. Best-effort
 * — never throws. Returns the holon resource URL on success, else null.
 */
export async function alsoPersistEncryptedHolon(
  opts: EncryptedHolonAltitudeOptions,
): Promise<string | null> {
  try {
    const kp = bridgeEncryptionKeypair();
    if (!kp) return null;
    const prov = { wasAttributedTo: opts.agentDid as IRI, generatedAtTime: new Date().toISOString() };
    const pgsl = createPGSL(prov);
    const holonUri = opts.build(pgsl, prov);
    if (!holonUri) return null;

    // Self-sovereign recipients: encrypt to the OWNING agent (whose pod this
    // lives on) so they can read their own canonical holon, plus the bridge for
    // its own operations. Best-effort — if the owner hasn't published an
    // encryption key, fall back to bridge-only (non-breaking).
    const recipients = [kp.publicKey];
    // guardedFetchFn re-guards the <pod>/keys/encryption.json GET + every redirect hop —
    // a caller-supplied recipient pod could otherwise 302 the key read to an internal
    // host (round-30 recipient-key redirect SSRF).
    const guardedFetch = guardedFetchFn(opts.fetch) as typeof opts.fetch;
    const ownerKey = await resolveAgentEncryptionKey(opts.podUrl, { fetch: guardedFetch });
    if (ownerKey && ownerKey !== kp.publicKey) recipients.push(ownerKey);
    // Additional cross-seat recipients — resolve each pod's DURABLE published
    // key and wrap to it too; skip any that don't resolve (non-breaking). This
    // is what gives maintainer/boozer owner-decrypt off their self-published
    // keys/encryption.json, not the session keys publish_context's share_with uses.
    for (const pod of opts.additionalRecipientPods ?? []) {
      try {
        const k = await resolveAgentEncryptionKey(pod, { fetch: guardedFetch });
        if (k && !recipients.includes(k)) recipients.push(k);
      } catch { /* skip an unresolvable recipient — best-effort */ }
    }

    const r = await persistEncryptedHolonProjection({
      agent: opts.podUrl,
      shapeClass: opts.shapeClass,
      defaultContainer: opts.defaultContainer,
      pgsl,
      holonUri,
      recipientPublicKeys: recipients,
      senderKeyPair: kp,
      fetch: opts.fetch ?? (globalThis.fetch as unknown as FetchFn),
    });
    return r.holonResourceUrl;
  } catch {
    return null;
  }
}
