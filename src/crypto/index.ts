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
