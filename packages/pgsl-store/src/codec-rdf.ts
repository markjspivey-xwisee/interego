/**
 * The RDF codec — the first codec on the seam.
 *
 * ingest(turtle/trig bytes):
 *   (a) OPAQUE byte-atom: value = base64 of the exact bytes → projectBytes()
 *       returns them verbatim, so a signed graph round-trips byte-for-byte and
 *       its signature still verifies. THIS is the fidelity path.
 *   (b) STRUCTURAL projection: one atom per RDF statement (content-addressed by
 *       the normalized statement text) + a graph fragment over them. Two graphs
 *       that share a statement share that statement-atom's URI, so cross-holon
 *       overlap is detectable from the projection alone (via the store's CB
 *       index) WITHOUT reading values. Lossy/normalized by design — query & dedup
 *       only, never used to reconstruct bytes.
 *
 * NOTE: the structural projection is STATEMENT-granular (a real, deterministic,
 * overlap-detecting functor); a finer term/quad-granular functor is a later
 * refinement. Byte fidelity does not depend on it.
 */

import { createHash } from 'node:crypto';
import type { Codec, IngestOptions, IngestResult } from './codec.js';
import { atomAddress, publicAtomAddress } from './addressing.js';
import type { StoredNode } from './node.js';

const RDF_FORMAT = 'text/turtle';

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Split a Turtle/TriG body into normalized statements (quote/IRI/comment-aware,
 *  decimal-safe). Directives (@prefix/@base) are dropped. Pragmatic but
 *  deterministic — good enough to mint stable, overlap-sharing statement atoms. */
export function splitTurtleStatements(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inStr: false | '"' | "'" = false;
  let inIri = false;
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inComment) {
      if (c === '\n') inComment = false;
      buf += c;
      continue;
    }
    if (inStr) {
      buf += c;
      if (c === '\\') { buf += text[i + 1] ?? ''; i++; continue; }
      if (c === inStr) inStr = false;
      continue;
    }
    if (inIri) {
      buf += c;
      if (c === '>') inIri = false;
      continue;
    }
    if (c === '#') { inComment = true; buf += c; continue; }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue; }
    if (c === '<') { inIri = true; buf += c; continue; }
    // Statement terminator only when '.' is followed by whitespace/EOF (so
    // decimals like 3.14 and dotted prefixed names don't split).
    if (c === '.' && (i + 1 >= text.length || /\s/.test(text[i + 1]!))) {
      const s = normalizeStatement(buf);
      if (s) out.push(s);
      buf = '';
      continue;
    }
    buf += c;
  }
  const tail = normalizeStatement(buf);
  if (tail) out.push(tail);
  return out;
}

function normalizeStatement(raw: string): string | null {
  const noComments = raw.replace(/#[^\n]*/g, ' ');
  const s = noComments.replace(/\s+/g, ' ').trim().replace(/\s*\.\s*$/, '').trim();
  if (!s) return null;
  if (/^@?(prefix|base)\b/i.test(s)) return null;
  return s;
}

export const rdfCodec: Codec = {
  format: RDF_FORMAT,

  ingest(bytes: Uint8Array, opts: IngestOptions = {}): IngestResult {
    const text = new TextDecoder().decode(bytes);

    // (a) opaque byte-atom — exact bytes, the byte-faithful mirror.
    const opaqueValue = b64(bytes);
    const opaqueUri = atomAddress(opaqueValue, opts);
    const opaque: StoredNode = {
      uri: opaqueUri,
      kind: 'atom',
      level: 0,
      value: opaqueValue,
      provenance: { codec: RDF_FORMAT, opaque: true },
    };

    // (b) structural projection — one atom per statement + a graph fragment.
    const statements = splitTurtleStatements(text);
    const structuralUris: string[] = [];
    const structuralAtoms: StoredNode[] = [];
    const seen = new Set<string>();
    for (const stmt of statements) {
      const uri = atomAddress(stmt, opts);
      structuralUris.push(uri);
      if (!seen.has(uri)) {
        seen.add(uri);
        structuralAtoms.push({ uri, kind: 'atom', level: 0, value: stmt });
      }
    }

    // The graph fragment is content-addressed over its (deduped, ordered)
    // statement atoms, so two byte-different-but-statement-identical graphs
    // converge, and the fragment references the opaque mirror via provenance.
    const fragHashInput = 'graph:' + structuralUris.join('|');
    const fragHex = createHash('sha256').update(fragHashInput).digest('hex').slice(0, 40);
    const topUri = `urn:pgsl:fragment:${fragHex}`;
    const graph: StoredNode = {
      uri: topUri,
      kind: 'fragment',
      level: 1,
      items: structuralUris,
      provenance: { codec: RDF_FORMAT, opaque: opaqueUri },
    };

    return {
      nodes: [opaque, ...structuralAtoms, graph],
      topUri,
      opaqueUri,
      structuralUris,
    };
  },

  projectBytes(opaqueNode: StoredNode): Uint8Array {
    if (typeof opaqueNode.value !== 'string') {
      throw new Error('rdfCodec.projectBytes: opaque node has no base64 value');
    }
    return new Uint8Array(Buffer.from(opaqueNode.value, 'base64'));
  },
};

/** Convenience: the canonical public opaque-atom URI for a Turtle body (for
 *  tests / callers that want the address without a full ingest). */
export function rdfOpaqueUri(bytes: Uint8Array): string {
  return publicAtomAddress(b64(bytes));
}
