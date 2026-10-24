/** Exact-content confirmation for encrypted shared-lattice snapshots.
 * The fingerprint stays in process memory; it is neither published nor a caller receipt. */
import { createHash } from 'node:crypto';

export interface ConfirmedLatticeSnapshot { readonly digest: string; readonly etag: string }

/** Covers the destination, selected root, every full node body, and all recipients.
 * Sorted node IDs and recipient sets ignore ordering only; node contents remain exact. */
export function latticeSnapshotDigest(
  resourceUrl: string, topUri: string, nodes: ReadonlyMap<string, unknown>, recipients: readonly string[],
): string {
  const hash = createHash('sha256');
  const frame = (value: string): void => {
    hash.update(String(Buffer.byteLength(value, 'utf8'))).update(':').update(value);
  };
  frame(resourceUrl); frame(topUri);
  frame('nodes'); frame(String(nodes.size));
  for (const id of [...nodes.keys()].sort()) {
    frame(id);
    const body = JSON.stringify(nodes.get(id));
    if (body === undefined) throw new Error('shared lattice node is not serializable');
    frame(body);
  }
  const recipientSet = [...new Set(recipients)].sort();
  frame('recipients'); frame(String(recipientSet.length));
  for (const recipient of recipientSet) frame(recipient);
  return hash.digest('hex');
}

/** Only an acknowledged body still current at its exact ETag can skip a write.
 * A missing/changed ETag or failed HEAD returns false and preserves normal CAS/recovery. */
export async function confirmedSnapshotMatches(
  confirmed: ConfirmedLatticeSnapshot | undefined, digest: string, knownEtag: string | undefined,
  readCurrentEtag: () => Promise<string | undefined>,
): Promise<boolean> {
  if (!confirmed || !knownEtag || confirmed.digest !== digest || confirmed.etag !== knownEtag) return false;
  try { return await readCurrentEtag() === confirmed.etag; } catch { return false; }
}
