/**
 * Minimal ambient type declarations for `rdf-canonize`.
 *
 * rdf-canonize ships as plain JS with no bundled .d.ts and has no @types
 * stub on DefinitelyTyped (verified via `npm view @types/rdf-canonize`).
 * This file covers only the surface used by
 * `applications/_shared/vc-jwt/data-integrity-rdfc.ts` (the `canonize`
 * function for URDNA2015 N-Quads canonicalization). Extend as additional
 * symbols become needed.
 *
 * Upstream API: https://github.com/digitalbazaar/rdf-canonize
 */
declare module 'rdf-canonize' {
  export interface CanonizeOptions {
    algorithm?: 'URDNA2015' | 'RDFC-1.0' | string;
    inputFormat?: 'application/n-quads' | string;
    format?: 'application/n-quads' | string;
    messageDigestAlgorithm?: string;
    produceGeneralizedRdf?: boolean;
  }

  export function canonize(
    input: string | readonly unknown[],
    options?: CanonizeOptions,
  ): Promise<string>;

  const _default: {
    canonize: typeof canonize;
  };
  export default _default;
}
