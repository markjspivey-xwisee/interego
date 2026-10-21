/**
 * Bounded topology for the canonical atom encoding written by LdpStore.
 * An atom has no outgoing edges. Large canonical opaque atoms need only their
 * header; unexpected historical encodings fall back to the complete JSON reader.
 */
export const ATOM_HEADER_BYTES = 512;
export interface AtomTopology { kind: 'atom'; level: 0; }
const prefix = [0x70, 0x67, 0x73, 0x6c, 0, 0x4e] as const;
function hashFromUri(uri: unknown): string | null {
  if (typeof uri !== 'string') return null;
  const match = /^urn:pgsl:atom:([0-9a-f]{40})$/i.exec(uri)
    ?? /^https?:\/\/[^"\\\s]+\/ns\/pgsl\/atom\/([0-9a-f]{40})$/i.exec(uri);
  return match?.[1]?.toLowerCase() ?? null;
}
export function atomTopologyFromPrefix(key: Uint8Array, bytes: Uint8Array, valueBytes: number): AtomTopology | null {
  if (key.length !== 27 || prefix.some((b, i) => key[i] !== b) || key[6] !== 1
    || !Number.isSafeInteger(valueBytes) || valueBytes < 0
    || bytes.length !== Math.min(valueBytes, ATOM_HEADER_BYTES)) {
    throw new Error('refusing collection: invalid atom header record');
  }
  const expectedHash = Array.from(key.subarray(7), b => b.toString(16).padStart(2, '0')).join('');
  const text = new TextDecoder().decode(bytes);
  let uri: unknown;
  if (valueBytes <= ATOM_HEADER_BYTES) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const node = parsed as Record<string, unknown>;
    if (node.kind !== 'atom' || node.level !== 0) return null;
    uri = node.uri;
  } else {
    // encodeNode(JSON.stringify) preserves LdpStore's uri/kind/level/value order.
    // Do not infer topology from a value/provenance substring or an escaped URI.
    const match = /^\{"uri":"([^"\\]+)","kind":"atom","level":0,"value":"/.exec(text);
    if (!match) return null;
    uri = match[1];
  }
  const actualHash = hashFromUri(uri);
  if (actualHash === null) return null;
  if (actualHash !== expectedHash) throw new Error('refusing collection: atom header does not match node key');
  return { kind: 'atom', level: 0 };
}
