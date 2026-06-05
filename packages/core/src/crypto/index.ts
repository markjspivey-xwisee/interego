/**
 * @module crypto
 * @description Real blockchain, IPFS, and wallet integration.
 *
 * No mocks. Real cryptography:
 *   - ethers.js v6: secp256k1 key pairs, ECDSA signatures, EIP-712
 *   - @noble/hashes: SHA-256
 *   - multiformats: Real IPFS CID v1 computation
 *   - siwe: Real Sign-In With Ethereum verification
 *
 * IPFS: Content-addressed permanent storage for PGSL fragments
 * Wallets: Agent identity, descriptor signing, delegation proofs
 * ERC-8004: On-chain agent identity tokens
 * ERC-4361 (SIWE): Sign-In With Ethereum for human auth
 * X402: Agentic payments for premium context
 */

// Types
export type {
  CID,
  IpfsPinResult,
  IpfsAnchor,
  IpfsConfig,
  IpfsProvider,
  ChainMode,
  ChainConfig,
  WalletBalance,
  Wallet,
  WalletDelegation,
  SignedDescriptor,
  AgentIdentityToken,
  SiweMessage,
  SiweVerification,
  X402PaymentRequired,
  X402PaymentOption,
  X402PaymentReceipt,
  IdentityAnchors,
  ExternalCredential,
  ExternalCredentialType,
  UniversalWallet,
  CredentialPresentation,
} from './types.js';

export { CHAIN_CONFIGS } from './types.js';

// IPFS (real CID computation via multiformats)
export {
  sha256,
  computeCid,
  pinToIpfs,
  createIpfsAnchor,
  pinPgslFragment,
  pinDescriptor,
  LOCAL_UNPINNED_WARNING,
  resetLocalUnpinnedWarningLatch,
} from './ipfs.js';

// Wallets (real crypto via ethers.js)
export {
  setChain,
  getChainConfig,
  checkBalance,
  getConnectedSigner,
  createWallet,
  importWallet,
  exportPrivateKey,
  signMessageRaw,
  recoverMessageSigner,
} from './wallet.js';
export {
  getNostrPubkey,
  schnorrSign,
  schnorrVerify,
  sha256Hex,
} from './schnorr.js';
export {
  createDelegation,
  verifyDelegationSignature,
  signDescriptor,
  verifyDescriptorSignature,
  createAgentToken,
  createSiweMessage,
  formatSiweMessage,
  signSiweMessage,
  verifySiweSignature,
  createAgentKitWallet,
} from './wallet.js';

// E2E Encryption (real NaCl / tweetnacl)
export {
  generateKeyPair,
  deriveEncryptionKeyPair,
  generateContentKey,
  encryptContent,
  decryptContent,
  wrapKeyForRecipient,
  unwrapKey,
  createEncryptedEnvelope,
  openEncryptedEnvelope,
  openEncryptedEnvelopeWithHistory,
  reEncryptForRecipients,
  envelopeToJson,
  envelopeFromJson,
} from './encryption.js';

export type {
  EncryptionKeyPair,
  ContentKey,
  EncryptedContent,
  WrappedKey,
  EncryptedEnvelope,
} from './encryption.js';

// Facet-field level encryption (opt-in, for sensitive descriptor metadata)
export {
  encryptFacetValue,
  decryptFacetValue,
  isEncryptedFacetValue,
  encryptedFacetValueToTurtle,
  parseEncryptedFacetValueFromTurtle,
} from './facet-encryption.js';

export type { EncryptedFacetValue } from './facet-encryption.js';

// Pedersen commitments (substrate primitive used by aggregate-privacy
// + range proofs). Re-exported so verticals don't reach into core
// internals via deep-subpath imports.
export {
  H_GENERATOR_LABEL,
  deriveBlinding,
  randomBlinding,
  commit as pedersenCommit,
  commit,
  verifyOpening as verifyPedersenOpening,
  verifyOpening,
  addCommitments,
  verifyHomomorphicSum,
  sampleLaplaceFloat,
  sampleLaplaceInt,
} from './pedersen.js';
export type { PedersenCommitment } from './pedersen.js';

// Shamir secret sharing (substrate primitive — t-of-n threshold
// reconstruction for DKG + private aggregation flows).
export {
  splitSecret,
  reconstructSecret,
  evaluateAt,
} from './shamir.js';
export type { ShamirShare } from './shamir.js';

// Distributed Key Generation (Pedersen-DKG — committee-secret
// primitive used by federated trust + threshold-decrypt flows).
export {
  dkgRound1,
  dkgRound2,
  dkgRound3,
  simulateDKG,
} from './dkg.js';
export type { DKGFinalState } from './dkg.js';

// Differential-privacy accountant (Renyi DP — substrate primitive
// for aggregate-privacy bounds + regulator-audit reports).
export {
  sweepRenyiBestEpsilon,
  AdvancedCompositionAccountant,
  RenyiAccountant,
} from './dp-accountant.js';

// Feldman VSS (verifiable secret sharing — Shamir + Pedersen
// commitments). Used by the aggregate-privacy pattern.
export {
  splitSecretWithCommitments,
  verifyShare as verifyFeldmanShare,
  filterVerifiedShares,
  secretCommitment,
} from './feldman-vss.js';
export type {
  FeldmanCommitments,
  VerifiableShamirShare,
} from './feldman-vss.js';

// Bit-decomposition range proofs (Pedersen-based, additive). Distinct
// from the hash-chain RangeProof in zk/ — exported here as
// PedersenRangeProof to avoid the type collision.
export {
  proveBit,
  verifyBit,
  proveRange,
  verifyRange,
} from './range-proof.js';
export type {
  BitProof,
  RangeProof as PedersenRangeProof,
} from './range-proof.js';

// Zero-Knowledge Proofs (chain-hash commitments — distinct from the
// Pedersen `commit` exported above; aliased as `zkCommit` to avoid
// shadowing the Pedersen one most callers expect from the bare name).
export {
  commit as zkCommit,
  verifyCommitment,
  proveConfidenceAboveThreshold,
  verifyConfidenceProof,
  verifyConfidenceProofByReveal,
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  proveDelegationMembership,
  verifyDelegationMembership,
  proveTemporalOrdering,
  verifyTemporalProof,
  proveFragmentMembership,
  verifyFragmentMembership,
  createSelectiveDisclosure,
} from './zk/index.js';

export type {
  Commitment,
  RangeProof,
  MerkleProof,
  MerklePathElement,
  TemporalProof,
  FragmentMembershipProof,
  ZKProof,
  SelectiveDisclosure,
} from './zk/index.js';
