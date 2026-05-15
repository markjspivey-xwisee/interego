/**
 * @module crypto/facet-encryption
 * @description Opt-in field-level encryption for individual facet values.
 *
 * The graph-level envelope (solid/client.ts + encryption.ts) protects the
 * named-graph *payload* — but descriptor metadata (facet values, e.g. who
 * the asserting agent is, what the provenance timestamps are, what
 * verifiable credential underpins the trust claim) stays plaintext so
 * federation queries work. That's the right default, but some facet
 * fields ARE identity-leaking: a fully public Provenance.wasAttributedTo
 * names the pod owner, for example, even if nobody is supposed to see
 * that outside the recipient set.
 *
 * This module provides the primitive for encrypting individual facet
 * field values while keeping the *type* of field visible (so temporal
 * filters, facet-type filters, manifest discovery still work). The
 * encrypted value is an `EncryptedFacetValue` — a regular envelope per
 * our existing crypto contract, serialized inline as a blank node in
 * the descriptor's Turtle.
 */
import { createEncryptedEnvelope, openEncryptedEnvelope, type EncryptedEnvelope, type EncryptionKeyPair } from './encryption.js';

/**
 * A single facet-field value wrapped in an encrypted envelope. Callers
 * obtaining a descriptor can attempt to decrypt via `decryptFacetValue`
 * with their keypair; if they are not a recipient, the field appears
 * as a redacted placeholder.
 */
export interface EncryptedFacetValue {
  readonly '@type': 'cg:EncryptedValue';
  /** Hints at the expected post-decryption datatype (e.g. 'xsd:dateTime'). */
  readonly expectedDatatype?: string;
  readonly envelope: EncryptedEnvelope;
}

export function isEncryptedFacetValue(v: unknown): v is EncryptedFacetValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { '@type'?: string })['@type'] === 'cg:EncryptedValue' &&
    typeof (v as { envelope?: unknown }).envelope === 'object'
  );
}

/**
 * Encrypt a facet-field value so only the listed recipients can read it.
 *
 * The plaintext is stringified: strings become themselves, objects become
 * JSON. `expectedDatatype` gives decrypting clients the hint to rebuild
 * typed literals (xsd:dateTime, xsd:double, etc.).
 */
export function encryptFacetValue(
  value: string | number | boolean | object,
  recipients: readonly string[],
  senderKeyPair: EncryptionKeyPair,
  expectedDatatype?: string,
): EncryptedFacetValue {
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const envelope = createEncryptedEnvelope(plaintext, recipients, senderKeyPair);
  const result: EncryptedFacetValue = { '@type': 'cg:EncryptedValue', envelope };
  if (expectedDatatype) (result as { expectedDatatype?: string }).expectedDatatype = expectedDatatype;
  return result;
}

/**
 * Attempt to decrypt a facet value. Returns the plaintext (string form)
 * if the recipient's key is present; returns `null` when the caller is
 * not authorized.
 *
 * Optional layered defense: pass `expectedSenderPublicKey` (base64) to
 * also require the envelope to be wrapped by a specific sender — useful
 * when the pod-write ACL isn't itself sufficient provenance (e.g.
 * cross-pod relay scenarios). When the param is supplied, the function
 * returns `null` if any wrappedKey on the envelope reports a different
 * sender. The primary integrity defense remains pod-write authorization
 * + nacl's authenticated encryption (a tampered ciphertext fails its
 * MAC); this just narrows the trusted-sender set from "anyone who knew
 * the recipient's pubkey" to "exactly this sender."
 */
export function decryptFacetValue(
  encrypted: EncryptedFacetValue,
  recipientKeyPair: EncryptionKeyPair,
  expectedSenderPublicKey?: string,
): string | null {
  if (!isEncryptedFacetValue(encrypted)) return null;
  if (expectedSenderPublicKey !== undefined) {
    const ok = encrypted.envelope.wrappedKeys.some(
      wk => wk.senderPublicKey === expectedSenderPublicKey,
    );
    if (!ok) return null;
  }
  return openEncryptedEnvelope(encrypted.envelope, recipientKeyPair);
}

/**
 * Render an EncryptedFacetValue as Turtle blank-node syntax suitable for
 * inlining as a facet object. Format:
 *
 *   [ a cg:EncryptedValue ;
 *     cg:expectedDatatype "xsd:dateTime" ;
 *     cg:envelope "<base64-json>" ]
 *
 * The envelope is stored as a single base64-encoded JSON string to keep
 * the Turtle grammar simple (envelopes contain arrays + nested objects
 * that don't serialize naturally to RDF without a custom vocabulary).
 * Any consumer can base64-decode and JSON.parse to round-trip.
 */
export function encryptedFacetValueToTurtle(v: EncryptedFacetValue): string {
  const envelopeJson = JSON.stringify(v.envelope);
  const envelopeB64 = Buffer.from(envelopeJson, 'utf8').toString('base64');
  const lines: string[] = [
    '[ a cg:EncryptedValue',
  ];
  if (v.expectedDatatype) {
    lines.push(`    ; cg:expectedDatatype "${v.expectedDatatype}"`);
  }
  lines.push(`    ; cg:envelope "${envelopeB64}" ]`);
  return lines.join('\n    ');
}

/**
 * Parse an EncryptedFacetValue blank-node block out of a Turtle fragment.
 * Returns null if the fragment is not an `cg:EncryptedValue` block.
 */
export function parseEncryptedFacetValueFromTurtle(fragment: string): EncryptedFacetValue | null {
  if (!/a\s+cg:EncryptedValue/.test(fragment)) return null;
  const envB64Match = fragment.match(/cg:envelope\s+"([^"]+)"/);
  if (!envB64Match) return null;
  try {
    const json = Buffer.from(envB64Match[1]!, 'base64').toString('utf8');
    const envelope = JSON.parse(json) as EncryptedEnvelope;
    const dtMatch = fragment.match(/cg:expectedDatatype\s+"([^"]+)"/);
    const result: EncryptedFacetValue = { '@type': 'cg:EncryptedValue', envelope };
    if (dtMatch) (result as { expectedDatatype?: string }).expectedDatatype = dtMatch[1];
    return result;
  } catch {
    return null;
  }
}
