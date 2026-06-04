/**
 * @module pgsl/kernel-adapter
 * @description PGSL-backed implementation of the kernel's
 * {@link LatticeAdapter} interface.
 *
 * Wires the kernel's mint / promote / decompose verbs to the in-memory
 * PGSL lattice — preserving the historical behavior (level recovery,
 * pullback squares, content-addressed reuse) while keeping the kernel
 * itself free of direct PGSL imports. After the substrate-vs-vertical
 * split, this module is what `@interego/pgsl/index` registers as a
 * side-effect on import.
 *
 * Until the move, importing `@interego/core` continues to register the
 * adapter automatically so behavior is unchanged.
 */

import { createHash } from 'node:crypto';
import type {
  IRI,
  LatticeAdapter,
  LatticeValue,
  LatticeProvenance,
  AdapterMintResult,
  AdapterPromoteResult,
  AdapterDecomposeResult,
} from '@interego/core';
import { setKernelLatticeAdapter } from '@interego/core';
import { createPGSL, mintAtom, ingest } from './lattice.js';
import { pullbackSquare } from './category.js';
import type { PGSLInstance } from './types.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

// Process-local PGSL instance owned by the adapter. Same singleton
// pattern the kernel previously used internally — content addressing is
// global, so this is the cache, not the source of truth.
let _adapterPgsl: PGSLInstance | null = null;

function adapterPgsl(provenance?: LatticeProvenance): PGSLInstance {
  if (_adapterPgsl) return _adapterPgsl;
  _adapterPgsl = createPGSL({
    wasAttributedTo: (provenance?.wasAttributedTo ?? 'urn:cg:kernel') as IRI,
    generatedAtTime: provenance?.generatedAtTime ?? new Date().toISOString(),
  });
  return _adapterPgsl;
}

/**
 * Reset the adapter-local PGSL instance — for tests. The substrate's
 * URIs remain valid across reset (they are content-addressed); this
 * only clears the in-memory structural index.
 */
export function resetKernelPGSL(): void {
  _adapterPgsl = null;
}

/**
 * Build the lattice-aware adapter. Each call returns the same instance —
 * the adapter is stateless apart from the PGSL singleton it lazily
 * creates.
 */
export function pgslLatticeAdapter(): LatticeAdapter {
  return {
    mint(content: LatticeValue, provenance?: LatticeProvenance): AdapterMintResult {
      const iri = mintAtom(adapterPgsl(provenance), content, normaliseProvenance(provenance));
      return {
        iri,
        level: 0,
        contentHash: sha256Hex(`atom:${String(content)}`),
      };
    },
    promote(items: readonly (LatticeValue | IRI)[], provenance?: LatticeProvenance): AdapterPromoteResult {
      if (items.length === 0) {
        throw new TypeError('promote() requires at least one item');
      }
      const pgsl = adapterPgsl(provenance);
      const apex = ingest(pgsl, items, normaliseProvenance(provenance));
      const node = pgsl.nodes.get(apex);
      const level = node && node.kind === 'Fragment' ? node.level : Math.max(0, items.length - 1);
      return { apex, level };
    },
    decompose(fragmentIri: IRI): AdapterDecomposeResult | null {
      const pgsl = adapterPgsl();
      const square = pullbackSquare(pgsl, fragmentIri);
      if (!square) return null;
      return {
        apex: square.apex,
        level: square.level,
        left: square.left,
        right: square.right,
        overlap: square.overlap,
      };
    },
  };
}

/**
 * Translate the adapter's {@link LatticeProvenance} into the shape PGSL
 * lattice expects (`NodeProvenance` is the same field set, just with
 * different optionality semantics).
 */
function normaliseProvenance(p?: LatticeProvenance): import('./types.js').NodeProvenance | undefined {
  if (!p) return undefined;
  // Pass through — NodeProvenance is a strict superset shape-wise.
  return p as import('./types.js').NodeProvenance;
}

// ── Auto-registration ───────────────────────────────────────
//
// Importing this module is enough to make the kernel lattice-aware.
// `packages/pgsl/src/index.ts` will reuse this once extracted; for
// now the module is loaded transitively through `packages/core/src/pgsl/index.ts`
// so callers of `@interego/core` get the lattice-aware behavior they
// always had.
setKernelLatticeAdapter(pgslLatticeAdapter());
