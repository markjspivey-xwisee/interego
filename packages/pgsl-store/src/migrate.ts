/**
 * Per-pod migration tooling (Stage 4) — migrate a file-backed pod's resources
 * into the PGSL store, NON-DESTRUCTIVELY (the source is read-only input; nothing
 * here mutates it) with a per-resource byte-parity verify gate, and idempotently
 * (content-addressed set-if-absent, so re-running is safe).
 *
 * The code + its verification are proven here on SYNTHETIC pods. EXECUTING it on
 * the ~728 REAL users' pods (and the subsequent production write-path cutover /
 * multi-replica enablement, Stage 5) mutates live user data and is the one step
 * that requires explicit maintainer consent — it is NOT run autonomously.
 */

import type { LdpStore } from './ldp.js';
import type { IngestOptions } from './codec.js';

export interface SourceResource {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface MigrationReport {
  migrated: number;
  /** Resources whose read-back matched the source byte-for-byte + content-type. */
  verified: number;
  /** Paths whose read-back did NOT match (must be empty for a clean migration). */
  mismatches: string[];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function migratePod(
  ldp: LdpStore,
  pod: string,
  resources: Iterable<SourceResource>,
  opts: IngestOptions = {},
): Promise<MigrationReport> {
  let migrated = 0;
  let verified = 0;
  const mismatches: string[] = [];
  for (const r of resources) {
    await ldp.writeResource(pod, r.path, r.bytes, r.contentType, opts);
    migrated++;
    const back = await ldp.readResource(pod, r.path);
    if (back && back.contentType === r.contentType && bytesEqual(back.bytes, r.bytes)) {
      verified++;
    } else {
      mismatches.push(r.path);
    }
  }
  return { migrated, verified, mismatches };
}

/** Read-only re-verification of an already-migrated pod (the per-pod cutover gate:
 *  every source resource must read back byte-identical before flipping the pod). */
export async function verifyMigration(
  ldp: LdpStore,
  pod: string,
  resources: Iterable<SourceResource>,
): Promise<{ ok: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  for (const r of resources) {
    const back = await ldp.readResource(pod, r.path);
    if (!back || back.contentType !== r.contentType || !bytesEqual(back.bytes, r.bytes)) {
      mismatches.push(r.path);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
