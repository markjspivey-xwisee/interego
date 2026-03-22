/**
 * @module crypto/types
 * @description Types for blockchain/IPFS/wallet integration.
 *
 * Standards covered:
 *   - IPFS: Content-addressed storage for PGSL fragments
 *   - ERC-8004: On-chain agent identity tokens
 *   - ERC-4361 (SIWE): Sign-In With Ethereum for human auth
 *   - X402: HTTP 402 payment required for agentic commerce
 *   - Coinbase AgentKit: MPC wallets for AI agents
 */

import type { IRI } from '../model/types.js';

// ═════════════════════════════════════════════════════════════
//  IPFS
// ═════════════════════════════════════════════════════════════

/** IPFS Content Identifier */
export type CID = string & { readonly __brand: 'CID' };

/** Result of pinning content to IPFS */
export interface IpfsPinResult {
  readonly cid: CID;
  readonly size: number;
  readonly url: string;             // gateway URL: ipfs://CID or https://gateway/ipfs/CID
  readonly pinnedAt: string;        // ISO timestamp
  readonly provider: 'pinata' | 'web3storage' | 'local';
}

/** IPFS anchor on a descriptor or PGSL fragment */
export interface IpfsAnchor {
  readonly cid: CID;
  readonly gatewayUrl: string;
  readonly contentHash: string;     // sha256 of the content
  readonly pinnedAt: string;
}

/** Configuration for IPFS pinning service */
export interface IpfsConfig {
  readonly provider: 'pinata' | 'web3storage' | 'local';
  readonly apiKey?: string;
  readonly apiSecret?: string;
  readonly gateway?: string;        // default: https://gateway.pinata.cloud/ipfs/
}

// ═════════════════════════════════════════════════════════════
//  Wallets (Coinbase AgentKit / Generic)
// ═════════════════════════════════════════════════════════════

/** Chain configuration */
export type ChainMode = 'local' | 'base-sepolia' | 'base';

export interface ChainConfig {
  readonly mode: ChainMode;
  readonly chainId: number;
  readonly rpcUrl?: string;
  readonly blockExplorer?: string;
  readonly faucetUrl?: string;           // testnet only
  readonly paymasterUrl?: string;        // ERC-4337 paymaster
  readonly gasModel: 'human-pays' | 'agent-independent' | 'sponsored';
}

/** Pre-configured chain settings */
export const CHAIN_CONFIGS: Record<ChainMode, ChainConfig> = {
  local: {
    mode: 'local',
    chainId: 0,
    gasModel: 'human-pays',
  },
  'base-sepolia': {
    mode: 'base-sepolia',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    blockExplorer: 'https://sepolia.basescan.org',
    faucetUrl: 'https://faucet.quicknode.com/base/sepolia',
    gasModel: 'sponsored',
  },
  base: {
    mode: 'base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    blockExplorer: 'https://basescan.org',
    gasModel: 'human-pays',
  },
};

/** Wallet balance info */
export interface WalletBalance {
  readonly address: string;
  readonly chainId: number;
  readonly balance: string;            // in ETH (human-readable)
  readonly balanceWei: string;         // in wei
  readonly funded: boolean;            // balance > 0
  readonly sufficient: boolean;        // enough for typical operations
  readonly fundingInstructions?: string;
}

/** A blockchain wallet (human or agent) */
export interface Wallet {
  readonly address: string;         // 0x... Ethereum address
  readonly type: 'human' | 'agent';
  readonly provider: 'agentkit' | 'external' | 'ethers';
  readonly chainId: number;         // 0 = local, 84532 = base-sepolia, 8453 = base
  readonly label?: string;
}

/** Wallet delegation: human wallet authorizes agent wallet */
export interface WalletDelegation {
  readonly ownerAddress: string;    // human wallet
  readonly agentAddress: string;    // agent wallet
  readonly scope: string;           // ReadWrite, ReadOnly, etc.
  readonly signature: string;       // EIP-712 typed signature from owner
  readonly message: string;         // the signed message
  readonly chainId: number;
  readonly validUntil?: string;     // ISO expiration
}

/** Signed descriptor: agent wallet signs the content hash */
export interface SignedDescriptor {
  readonly descriptorId: IRI;
  readonly contentHash: string;     // sha256 of the Turtle
  readonly signature: string;       // ECDSA signature from agent wallet
  readonly signerAddress: string;   // agent wallet address
  readonly signedAt: string;
  readonly chainId: number;
}

// ═════════════════════════════════════════════════════════════
//  ERC-8004: Agent Identity Token
// ═════════════════════════════════════════════════════════════

/** On-chain agent identity as an NFT (ERC-8004) */
export interface AgentIdentityToken {
  readonly tokenId: string;
  readonly contractAddress: string;
  readonly chainId: number;
  readonly ownerAddress: string;    // human who owns this agent
  readonly agentAddress: string;    // the agent's wallet
  readonly agentUri: IRI;           // our internal agent ID
  readonly metadata: {
    readonly name: string;
    readonly description: string;
    readonly capabilities: string[];
    readonly delegationScope: string;
  };
  readonly mintedAt?: string;
  readonly transactionHash?: string;
}

// ═════════════════════════════════════════════════════════════
//  ERC-4361: Sign-In With Ethereum (SIWE)
// ═════════════════════════════════════════════════════════════

/** SIWE message fields per ERC-4361 */
export interface SiweMessage {
  readonly domain: string;
  readonly address: string;
  readonly statement: string;
  readonly uri: string;
  readonly version: '1';
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime?: string;
  readonly resources?: string[];    // pod URLs, agent URIs the user is claiming
}

/** Result of SIWE verification */
export interface SiweVerification {
  readonly valid: boolean;
  readonly address?: string;
  readonly chainId?: number;
  readonly error?: string;
}

// ═════════════════════════════════════════════════════════════
//  X402: Agentic Payments
// ═════════════════════════════════════════════════════════════

/** X402 payment requirement on a resource */
export interface X402PaymentRequired {
  readonly version: '1';
  readonly resource: string;        // the pod URL or descriptor URL
  readonly accepts: readonly X402PaymentOption[];
}

export interface X402PaymentOption {
  readonly network: string;         // 'ethereum', 'base', 'polygon'
  readonly token: string;           // 'ETH', 'USDC', etc.
  readonly amount: string;          // in smallest unit (wei, etc.)
  readonly address: string;         // recipient wallet
}

/** X402 payment receipt */
export interface X402PaymentReceipt {
  readonly transactionHash: string;
  readonly network: string;
  readonly token: string;
  readonly amount: string;
  readonly from: string;            // payer (agent wallet)
  readonly to: string;              // recipient (pod owner wallet)
  readonly paidAt: string;
  readonly resource: string;        // what was paid for
}

// ═════════════════════════════════════════════════════════════
//  Identity Anchors (unified)
// ═════════════════════════════════════════════════════════════

/**
 * All identity/anchoring credentials for an agent or descriptor.
 * Stored on the Trust facet.
 */
export interface IdentityAnchors {
  // Wallet identity
  readonly walletAddress?: string;
  readonly walletDelegation?: WalletDelegation;

  // On-chain identity (ERC-8004)
  readonly erc8004Token?: AgentIdentityToken;

  // IPFS content anchor
  readonly ipfsAnchor?: IpfsAnchor;

  // Blockchain timestamp proof
  readonly blockchainAnchor?: {
    readonly transactionHash: string;
    readonly blockNumber: number;
    readonly chainId: number;
    readonly anchoredAt: string;
  };

  // Descriptor signature
  readonly descriptorSignature?: SignedDescriptor;
}
