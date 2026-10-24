import { PlayError, type PlayClaims } from './provisional-play.js';

export interface PlayReceipt { hash: string; expiresAt: number }
export interface PlayAnchorDocument {
  userId: string;
  provisionalPlayAnchor?: string;
  provisionalPlayReceipts?: PlayReceipt[];
  [key: string]: unknown;
}
export interface PlayAnchorStorage {
  /** null denotes a confirmed 404, never an unavailable store. */
  read(userId: string): Promise<{ document: PlayAnchorDocument; etag: string } | null>;
  /** Conditional atomic write; false means 412 and nothing committed. */
  write(userId: string, document: PlayAnchorDocument, etag: string | null): Promise<boolean>;
  reserveAdmission(claims: PlayClaims, attestation: string, maxPods: number): Promise<string>;
  empty(claims: PlayClaims): PlayAnchorDocument;
  validate(anchor: string): PlayClaims;
  committed(document: PlayAnchorDocument): void;
  now?: () => number;
}

/** Bounded receipts live beside the immutable signed anchor in the owner's pod. */
export async function provisionPlayAnchor(storage: PlayAnchorStorage, claims: PlayClaims,
  attestation: string, maxPods: number, receipt: PlayReceipt): Promise<string> {
  const now = storage.now ?? (() => Math.floor(Date.now() / 1000));
  // Conditional writes protect the same owner even if a process restarts or two
  // requests race. New owners reserve the durable lifetime budget before writing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await storage.read(claims.userId);
    const document = existing?.document ?? storage.empty(claims);
    if (document.userId !== claims.userId) throw new PlayError(409, 'provisional_owner_conflict');
    if (existing) {
      if (!document.provisionalPlayAnchor) throw new PlayError(409, 'provisional_owner_conflict');
      const live = storage.validate(document.provisionalPlayAnchor);
      if (live.userId !== claims.userId || live.audience !== claims.audience || live.proofKeyThumbprint !== claims.proofKeyThumbprint)
        throw new PlayError(409, 'provisional_owner_conflict');
    } else {
      document.provisionalPlayAnchor = await storage.reserveAdmission(claims, attestation, maxPods);
      const reserved = storage.validate(document.provisionalPlayAnchor);
      if (reserved.userId !== claims.userId || reserved.proofKeyThumbprint !== claims.proofKeyThumbprint)
        throw new PlayError(409, 'provisional_owner_conflict');
    }
    const receipts = (document.provisionalPlayReceipts ?? []).filter(row => Number.isInteger(row.expiresAt) && row.expiresAt > now());
    if (receipts.some(row => row.hash === receipt.hash)) throw new PlayError(409, 'play_grant_already_used');
    if (receipts.length >= 16) throw new PlayError(429, 'play_grant_receipt_capacity');
    document.provisionalPlayReceipts = [...receipts, receipt];
    if (!await storage.write(claims.userId, document, existing?.etag ?? null)) continue;
    storage.committed(document);
    return document.provisionalPlayAnchor!;
  }
  throw new PlayError(409, 'provisional_owner_busy');
}
