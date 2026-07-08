/**
 * The store's node record + (de)serialization.
 *
 * `StoredNode` is the store-local shape of a PGSL lattice node — structurally a
 * superset of @interego/pgsl's Atom/Fragment (uri + kind + level + value | items
 * + pullback + provenance). Keeping it local decouples the store from the lattice
 * package; a thin adapter maps @interego/pgsl `Node` <-> `StoredNode` in a later
 * increment. Values are opaque bytes to FDB (only KEYS need order), so JSON is a
 * fine, debuggable value encoding for now.
 */

export interface StoredNode {
  /** urn:pgsl:atom:<40hex> | urn:pgsl:fragment:<40hex> — the content address. */
  uri: string;
  kind: 'atom' | 'fragment';
  level: number;
  /** Atoms: the scalar value (or the '__ENCRYPTED__' placeholder). */
  value?: string | number | boolean;
  /** Fragments: the ordered atom-uri span. */
  items?: string[];
  /** Fragments (level >= 2): the two level-(k-1) constituents. */
  left?: string;
  right?: string;
  /** wasAttributedTo / generatedAtTime / signature / signerAddress / encryptedForRecipients. */
  provenance?: Record<string, unknown>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeNode(node: StoredNode): Uint8Array {
  return enc.encode(JSON.stringify(node));
}
export function decodeNode(bytes: Uint8Array): StoredNode {
  return JSON.parse(dec.decode(bytes)) as StoredNode;
}
export function encodeJson(doc: unknown): Uint8Array {
  return enc.encode(JSON.stringify(doc));
}
export function decodeJson<T = unknown>(bytes: Uint8Array): T {
  return JSON.parse(dec.decode(bytes)) as T;
}
