import { PlayError, type PlayClaims } from './provisional-play.js';

export interface PlayAdmissionLedger { version: 1; owners: Record<string, string> }
/** Whether `value` is a ledger this module writes: version 1, its owners a plain object. */
export function isAdmissionLedger(value: unknown): value is PlayAdmissionLedger {
  const ledger = value as Partial<PlayAdmissionLedger> | null;
  return !!ledger && ledger.version === 1 && !!ledger.owners && typeof ledger.owners === 'object' && !Array.isArray(ledger.owners);
}
/**
 * The ledger at `<cssUrl>provisional-play-admission.json` with its ETag, or null where there is none
 * (404). Provisioning reserves on it (provisional-play-provider.ts), and the game-data backfill reads
 * each owner's guest deadline from it (server.ts backfillPlayGameData). Throws when it cannot be read.
 */
export async function readAdmissionLedger(request: (url: string) => Promise<Response>, cssUrl: string)
  : Promise<{ ledger: PlayAdmissionLedger; etag: string } | null> {
  const response = await request(new URL('provisional-play-admission.json', cssUrl).href);
  if (response.status === 404) return null;
  if (!response.ok || !response.headers.get('etag')) throw new Error('Provisional admission unavailable');
  return { ledger: await response.json() as PlayAdmissionLedger, etag: response.headers.get('etag')! };
}
export interface PlayAdmissionStore {
  read(): Promise<{ ledger: PlayAdmissionLedger; etag: string } | null>;
  write(ledger: PlayAdmissionLedger, etag: string | null): Promise<boolean>;
  validate(anchor: string): PlayClaims;
  /** The application audience of a ledger entry, expired or not; null where it does not open. Needed only with an application cap. */
  audienceOf?(anchor: string): string | null;
}
/**
 * Reserve before any pod creation. The lifetime count also bounds active Play
 * pods: failed creation, expiry and deletion never refund an admission. The
 * native conditional write enforces this across writers and process restarts.
 *
 * `applicationLimit`: the cap of this owner's application alone (PlayClient.maxPods), counted over
 * the ledger's entries whose attestation names the same audience. It is checked after the
 * deployment's `limit`, which still bounds the total, and the ledger's format is unchanged. An entry
 * that does not open (signed under a key since replaced) counts toward the total only.
 */
export async function reservePlayAdmission(store: PlayAdmissionStore, claims: PlayClaims,
  attestation: string, limit: number, applicationLimit?: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await store.read();
    const ledger = current?.ledger ?? { version: 1, owners: {} };
    if (!isAdmissionLedger(ledger)) throw new PlayError(503, 'provisional_admission_unavailable');
    const existing = Object.hasOwn(ledger.owners, claims.userId) ? ledger.owners[claims.userId] : null;
    if (existing) {
      const original = store.validate(existing);
      if (original.userId !== claims.userId || original.proofKeyThumbprint !== claims.proofKeyThumbprint)
        throw new PlayError(409, 'provisional_owner_conflict');
      return existing;
    }
    if (Object.keys(ledger.owners).length >= limit) throw new PlayError(503, 'provisional_play_lifetime_capacity');
    if (applicationLimit !== undefined) {
      if (!store.audienceOf) throw new PlayError(503, 'provisional_admission_unavailable');
      let admitted = 0;
      for (const anchor of Object.values(ledger.owners)) if (store.audienceOf(anchor) === claims.audience) admitted++;
      if (admitted >= applicationLimit) throw new PlayError(503, 'provisional_play_application_capacity');
    }
    const next = { version: 1 as const, owners: { ...ledger.owners, [claims.userId]: attestation } };
    if (await store.write(next, current?.etag ?? null)) return attestation;
  }
  throw new PlayError(409, 'provisional_admission_busy');
}
