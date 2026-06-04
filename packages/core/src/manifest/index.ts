/**
 * @module manifest
 * @description Substrate-level types for the `.well-known/context-graphs`
 * manifest. The Solid binding writes + reads the manifest; the substrate
 * types describe its shape so the kernel + affordance follower can work
 * against it without dragging the Solid binding in.
 */
export type { ManifestEntry } from './types.js';
