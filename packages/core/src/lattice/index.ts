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
} from './adapter.js';
export {
  fallbackLatticeAdapter,
  setKernelLatticeAdapter,
  getKernelLatticeAdapter,
} from './adapter.js';
