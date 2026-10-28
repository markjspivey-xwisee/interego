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

const listed = (value: unknown) => Array.isArray(value) && value.length > 0;
/** Whether an owner's document lists a passkey, wallet or DID (a claimed owner). */
function holdsCredential(document: PlayAnchorDocument): boolean {
  return listed(document['webAuthnCredentials']) || listed(document['walletAddresses']) || listed(document['didKeys']);
}

/** Bounded receipts live beside the immutable signed anchor in the owner's pod. */
export async function provisionPlayAnchor(storage: PlayAnchorStorage, claims: PlayClaims,
  attestation: string, maxPods: number, receipt: PlayReceipt): Promise<string> {
  const now = storage.now ?? (() => Math.floor(Date.now() / 1000));
  // Conditional writes protect the same owner even if a process restarts or two
  // requests race. New owners reserve the durable lifetime budget before writing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await storage.read(claims.userId);
    // A record that holds no owner (no anchor, no credential: a deletion's tombstone, or the empty
    // record a write's settlement leaves where a document was missing) is replaced, on its ETag, as
    // a missing one is created. It stays on the pod rather than being removed, because a store may
    // apply a write sent with If-Match to a missing document (CSS 7.2 does), and a write still
    // pending from before the deletion would then re-create the owner. Its session epoch is kept, so
    // the tokens issued before the deletion stay refused.
    const vacant = existing !== null && !existing.document.provisionalPlayAnchor && !holdsCredential(existing.document);
    const document = existing && !vacant ? existing.document : storage.empty(claims);
    if (vacant && Number.isInteger(existing.document['sessionEpoch'])) document['sessionEpoch'] = existing.document['sessionEpoch'];
    if (document.userId !== claims.userId) throw new PlayError(409, 'provisional_owner_conflict');
    if (existing && !vacant) {
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
