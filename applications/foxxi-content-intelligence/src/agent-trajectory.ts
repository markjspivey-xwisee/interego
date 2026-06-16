/**
 * Transitional re-export shim (Stage 2 of the agentic-performance extraction).
 * The performance THEORY engine moved to the agentic-performance-practice (agp:)
 * vertical — its canonical home. Foxxi composes it from there during the staged
 * extraction; existing Foxxi imports of `./agent-trajectory.js` resolve unchanged through this
 * shim, so Foxxi behaves identically. Phase 2b migrates Foxxi's /performance
 * surface to the agp bridge and removes these shims.
 */
export * from '../../agentic-performance-practice/src/agent-trajectory.js';
