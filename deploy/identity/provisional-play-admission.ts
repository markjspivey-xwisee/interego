import { PlayError, type PlayClaims } from './provisional-play.js';

export interface PlayAdmissionLedger { version: 1; owners: Record<string, string> }
export interface PlayAdmissionStore {
  read(): Promise<{ ledger: PlayAdmissionLedger; etag: string } | null>;
  write(ledger: PlayAdmissionLedger, etag: string | null): Promise<boolean>;
  validate(anchor: string): PlayClaims;
  checkActiveCapacity(limit: number): Promise<void>;
}
/** Lifetime admission is never refunded by guest expiry or soft deletion. */
export async function reservePlayAdmission(store: PlayAdmissionStore, claims: PlayClaims,
  attestation: string, limit: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await store.read();
    const ledger = current?.ledger ?? { version: 1, owners: {} };
    if (ledger.version !== 1 || !ledger.owners || typeof ledger.owners !== 'object' || Array.isArray(ledger.owners))
      throw new PlayError(503, 'provisional_admission_unavailable');
    const existing = Object.hasOwn(ledger.owners, claims.userId) ? ledger.owners[claims.userId] : null;
    if (existing) {
      const original = store.validate(existing);
      if (original.userId !== claims.userId || original.proofKeyThumbprint !== claims.proofKeyThumbprint)
        throw new PlayError(409, 'provisional_owner_conflict');
      return existing;
    }
    if (Object.keys(ledger.owners).length >= limit) throw new PlayError(503, 'provisional_play_lifetime_capacity');
    await store.checkActiveCapacity(limit);
    const next = { version: 1 as const, owners: { ...ledger.owners, [claims.userId]: attestation } };
    if (await store.write(next, current?.etag ?? null)) return attestation;
  }
  throw new PlayError(409, 'provisional_admission_busy');
}
