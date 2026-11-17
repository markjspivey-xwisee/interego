/**
 * Reading an order attestation this world published: is the list signed, by whom, and which
 * statement digests does it give, in which order.
 *
 * The world signs the `canonical` text of every graph it publishes with its wallet
 * (./world.ts, `publish`). For an order attestation that text holds the digests
 * (./graphs.ts, `orderAttestationGraph`), so one signature covers the descriptor and the list.
 *
 * This verifies the signature and reads the list. Whether the statements a reader holds are the
 * ones listed, in that order, is `orderBasis` (foxxi-content-intelligence/src/xapix/statement.ts),
 * which recomputes each digest. Whether the signer is to be trusted is the reader's decision:
 * the signer's address is returned, and `expectedSigner` only says whether it is the one named.
 */
import { verifyMessage } from 'ethers';
import { isDigest, orderBasis, type OrderAttestationRead, type OrderJudgement } from '../../foxxi-content-intelligence/src/xapix/statement.js';

export interface PublishedAttestation { readonly canonical: string; readonly signature: string }

export interface OrderAttestationReading extends OrderAttestationRead {
  /** The registration the list says it is of, when the signed text names one. */
  readonly registration?: string;
  /** Why the signature was not taken as verified, when it was not. */
  readonly reason?: string;
}

/**
 * The attestation as a reader holds it. `signatureVerified` is true only when the signature
 * recovers to an address, the signed text is a list of digests, and, when `expectedSigner` is
 * given, the address is that one.
 */
export function readOrderAttestation(published: PublishedAttestation, expectedSigner?: string): OrderAttestationReading {
  const refused = (reason: string): OrderAttestationReading => ({ digests: [], signatureVerified: false, reason });
  let body: unknown;
  try { body = JSON.parse(published.canonical); } catch { return refused('The signed text is not JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refused('The signed text is not an order attestation.');
  const { statementDigests, registration } = body as { statementDigests?: unknown; registration?: unknown };
  if (!Array.isArray(statementDigests) || !statementDigests.every(isDigest)) return refused('The signed text lists no statement digests.');
  let signer: string;
  try { signer = verifyMessage(published.canonical, published.signature); } catch { return refused('The signature does not recover to a signer.'); }
  const named = expectedSigner === undefined || signer.toLowerCase() === expectedSigner.toLowerCase();
  return {
    digests: statementDigests, signer, signatureVerified: named,
    ...(typeof registration === 'string' ? { registration } : {}),
    ...(named ? {} : { reason: `It is signed by ${signer}, not by ${expectedSigner}.` }),
  };
}

/** What stands behind the order of these statements, given an attestation this world published. */
export function orderOf(statements: ReadonlyArray<Record<string, unknown>>, published?: PublishedAttestation, expectedSigner?: string): OrderJudgement {
  return orderBasis(statements, published ? readOrderAttestation(published, expectedSigner) : undefined);
}
