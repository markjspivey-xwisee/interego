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

// Zero-Knowledge Proofs
export {
  commit,
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
