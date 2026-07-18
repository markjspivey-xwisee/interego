/**
 * @module lattice
 * @description Pluggable lattice backend for the kernel's mint / promote /
 * decompose verbs. See `./adapter.ts` for the architectural rationale.
 */

export type {
  LatticeAdapter,
  LatticeValue,
  LatticeLevel,
  LatticeProvenance,
  AdapterMintResult,
  AdapterPromoteResult,
  AdapterDecomposeResult,
  AdapterResolveResult,
} from './adapter.js';
export {
  fallbackLatticeAdapter,
  setKernelLatticeAdapter,
  getKernelLatticeAdapter,
} from './adapter.js';
export {
  PGSL_ID_AUTHORITY,
  LEGACY_PGSL_PREFIX,
  mintNodeId,
  isPgslNodeId,
  pgslNodeKind,
  pgslNodeHash,
  toCanonicalNodeId,
} from './node-id.js';
export type { PgslNodeKind } from './node-id.js';
