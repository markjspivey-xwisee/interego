/**
 * Content-addressed source atoms (byte-exact recovery + tamper detection; F1/A4/A13).
 *
 * Every note and context is stored VERBATIM in an atom keyed by the sha-256 of its bytes,
 * producing a substrate-compatible `urn:pgsl:atom:<sha40>` IRI. Recovery re-hashes the
 * stored bytes and refuses to return them if the hash no longer matches (A13 tamper): the
 * content address is the integrity proof, verified — never trusted. Bodies survive byte-
 * for-byte (frontmatter delimiters, spacing, CRLF, trailing newline — F2), which is what
 * lets us exceed Vault-LD's own round-trip (its RDF cycle drops bodies, §5.3).
 *
 * Self-contained (node:crypto over the raw UTF-8 bytes) so the engine needs no kernel
 * lattice adapter wired to mint an atom; the scheme matches the substrate's pgsl:Atom URI.
 */
import { createHash } from 'node:crypto';
import { VaultInputError } from './errors.js';

export interface SourceAtom {
  /** urn:pgsl:atom:<sha40> content address. */
  readonly iri: string;
  /** canonical bundle path this atom came from. */
  readonly path: string;
  /** whether the source was a note or a context.jsonld. */
  readonly kind: 'note' | 'context';
  /** the exact original bytes. */
  readonly bytes: string;
}

function contentAddress(bytes: string): string {
  return `urn:pgsl:atom:${createHash('sha256').update(bytes, 'utf8').digest('hex').slice(0, 40)}`;
}

export function mintSourceAtom(path: string, kind: 'note' | 'context', bytes: string): SourceAtom {
  return { iri: contentAddress(bytes), path, kind, bytes };
}

/** Verify an atom's stored bytes against its content address and return them, or throw. */
export function recoverAtomBytes(atom: SourceAtom): string {
  if (contentAddress(atom.bytes) !== atom.iri) {
    throw new VaultInputError('atom.tamper', `content-address mismatch for "${atom.path}": stored bytes do not match the atom hash`);
  }
  return atom.bytes;
}
