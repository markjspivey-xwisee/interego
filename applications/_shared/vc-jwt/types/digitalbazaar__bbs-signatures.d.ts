/**
 * Minimal ambient type declarations for `@digitalbazaar/bbs-signatures`.
 *
 * @digitalbazaar/bbs-signatures ships as plain JS with no bundled .d.ts and
 * has no @types stub on DefinitelyTyped. This file covers only the surface
 * used by `applications/_shared/vc-jwt/bbs-2023.ts` (generateKeyPair / sign /
 * verifySignature / deriveProof / verifyProof + CIPHERSUITES). Extend as
 * additional symbols become needed.
 *
 * Upstream API: https://github.com/digitalbazaar/bbs-signatures
 */
declare module '@digitalbazaar/bbs-signatures' {
  export const CIPHERSUITES: {
    readonly BLS12381_SHA256: string;
    readonly BLS12381_SHAKE256: string;
    readonly [k: string]: string;
  };

  export interface BbsKeyPairRaw {
    secretKey: Uint8Array;
    publicKey: Uint8Array;
  }

  export function generateKeyPair(args: {
    seed?: Uint8Array;
    ciphersuite: string;
  }): Promise<BbsKeyPairRaw>;

  export function sign(args: {
    secretKey: Uint8Array;
    publicKey: Uint8Array;
    header?: Uint8Array;
    messages: readonly Uint8Array[];
    ciphersuite: string;
  }): Promise<Uint8Array>;

  export function verifySignature(args: {
    publicKey: Uint8Array;
    signature: Uint8Array;
    header?: Uint8Array;
    messages: readonly Uint8Array[];
    ciphersuite: string;
  }): Promise<boolean>;

  export function deriveProof(args: {
    publicKey: Uint8Array;
    signature: Uint8Array;
    header?: Uint8Array;
    presentationHeader?: Uint8Array;
    messages: readonly Uint8Array[];
    disclosedMessageIndexes: readonly number[];
    ciphersuite: string;
  }): Promise<Uint8Array>;

  export function verifyProof(args: {
    publicKey: Uint8Array;
    proof: Uint8Array;
    header?: Uint8Array;
    presentationHeader?: Uint8Array;
    disclosedMessages: readonly Uint8Array[];
    disclosedMessageIndexes: readonly number[];
    ciphersuite: string;
  }): Promise<boolean>;
}
