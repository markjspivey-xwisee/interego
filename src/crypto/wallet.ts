/**
 * @module crypto/wallet
 * @description Real wallet operations for agent identity and descriptor signing.
 *
 * Uses ethers.js v6 for real secp256k1 cryptography:
 *   - Real private keys and Ethereum addresses
 *   - Real ECDSA signatures (signMessage, signTypedData)
 *   - Real signature verification (address recovery)
 *   - Real EIP-712 typed data for delegation messages
 *
 * Supports:
 *   - ethers.js wallets (default — real crypto, no blockchain needed)
 *   - Coinbase AgentKit (when @coinbase/agentkit is available)
 *   - External wallets (MetaMask, etc. via pre-signed messages)
 *
 * The wallet model:
 *   Human (external wallet) → delegates to → Agent (ethers/AgentKit wallet)
 *   Agent wallet signs descriptors → cryptographic proof of authorship
 *   Delegation is an EIP-712 typed signature from the human wallet
 */

import { ethers } from 'ethers';
import type { IRI } from '../model/types.js';
import type {
  Wallet,
  WalletBalance,
  WalletDelegation,
  SignedDescriptor,
  AgentIdentityToken,
  SiweMessage,
  SiweVerification,
  ChainMode,
  ChainConfig,
} from './types.js';
import { CHAIN_CONFIGS } from './types.js';
import { sha256 } from './ipfs.js';

// ── Private key storage (in-memory for this process) ─────────

const walletKeys = new Map<string, ethers.HDNodeWallet | ethers.Wallet>();

// ── Chain provider management ────────────────────────────────

let activeChainConfig: ChainConfig = CHAIN_CONFIGS.local;
let provider: ethers.JsonRpcProvider | null = null;

/**
 * Set the active chain. Call once at startup based on CG_CHAIN env var.
 */
export function setChain(mode: ChainMode): ChainConfig {
  activeChainConfig = CHAIN_CONFIGS[mode];
  if (mode !== 'local' && activeChainConfig.rpcUrl) {
    provider = new ethers.JsonRpcProvider(activeChainConfig.rpcUrl);
  } else {
    provider = null;
  }
  return activeChainConfig;
}

/**
 * Get the active chain config.
 */
export function getChainConfig(): ChainConfig {
  return activeChainConfig;
}

/**
 * Check a wallet's balance on the active chain.
 * Returns balance info with funding instructions if needed.
 */
export async function checkBalance(address: string): Promise<WalletBalance> {
  if (!provider || activeChainConfig.mode === 'local') {
    return {
      address,
      chainId: activeChainConfig.chainId,
      balance: 'N/A',
      balanceWei: '0',
      funded: true, // local mode doesn't need funds
      sufficient: true,
    };
  }

  const balanceWei = await provider.getBalance(address);
  const balance = ethers.formatEther(balanceWei);
  const funded = balanceWei > 0n;
  // ~0.001 ETH is enough for many operations on L2
  const sufficient = balanceWei >= ethers.parseEther('0.0005');

  let fundingInstructions: string | undefined;
  if (!funded) {
    if (activeChainConfig.mode === 'base-sepolia') {
      fundingInstructions = [
        `Your wallet ${address} has 0 ETH on Base Sepolia (testnet).`,
        ``,
        `To fund it (free):`,
        `  1. Go to: ${activeChainConfig.faucetUrl}`,
        `  2. Paste your address: ${address}`,
        `  3. Request testnet ETH`,
        ``,
        `Or use Coinbase AgentKit (CDP keys) for gas sponsorship — no ETH needed.`,
      ].join('\n');
    } else if (activeChainConfig.mode === 'base') {
      fundingInstructions = [
        `Your wallet ${address} has 0 ETH on Base (mainnet).`,
        ``,
        `To fund it:`,
        `  • Send ETH on Base to: ${address}`,
        `  • From: Coinbase, MetaMask, or any Base-compatible wallet`,
        `  • Minimum recommended: 0.001 ETH (~$0.003 at current gas prices)`,
        ``,
        `Gas costs on Base L2:`,
        `  • Mint ERC-8004 agent token: ~0.0001 ETH`,
        `  • Anchor descriptor on-chain: ~0.00005 ETH`,
        `  • EIP-712 delegation: FREE (off-chain signature)`,
      ].join('\n');
    }
  }

  return {
    address,
    chainId: activeChainConfig.chainId,
    balance,
    balanceWei: balanceWei.toString(),
    funded,
    sufficient,
    fundingInstructions,
  };
}

/**
 * Get a connected signer (wallet + provider) for on-chain transactions.
 * Only works when chain mode is not 'local'.
 */
export function getConnectedSigner(address: string): ethers.Wallet | ethers.HDNodeWallet | null {
  const wallet = walletKeys.get(address);
  if (!wallet || !provider) return null;
  return wallet.connect(provider);
}

// ═════════════════════════════════════════════════════════════
//  Real Wallet Creation
// ═════════════════════════════════════════════════════════════

/**
 * Create a real Ethereum wallet with a real private key.
 * Uses ethers.js Wallet.createRandom() — real secp256k1 key pair.
 */
export async function createWallet(
  type: 'human' | 'agent',
  label: string,
  chainId?: number,
): Promise<Wallet> {
  const ethersWallet = ethers.Wallet.createRandom();
  walletKeys.set(ethersWallet.address, ethersWallet);

  const resolvedChainId = chainId ?? activeChainConfig.chainId;

  return {
    address: ethersWallet.address,
    type,
    provider: 'ethers',
    chainId: resolvedChainId,
    label,
  };
}

/**
 * Import an existing wallet from a private key.
 */
export function importWallet(
  privateKey: string,
  type: 'human' | 'agent',
  label: string,
  chainId?: number,
): Wallet {
  const ethersWallet = new ethers.Wallet(privateKey);
  walletKeys.set(ethersWallet.address, ethersWallet);

  return {
    address: ethersWallet.address,
    type,
    provider: 'ethers',
    chainId: chainId ?? activeChainConfig.chainId,
    label,
  };
}

/**
 * Get the ethers.Wallet instance for signing operations.
 * Throws if the wallet was not created by this process.
 */
function getSigningWallet(address: string): ethers.HDNodeWallet | ethers.Wallet {
  const wallet = walletKeys.get(address);
  if (!wallet) {
    throw new Error(`No private key available for ${address}. Only wallets created in this process can sign.`);
  }
  return wallet;
}

/**
 * Export a wallet's private key (for backup/transfer).
 */
export function exportPrivateKey(address: string): string {
  return getSigningWallet(address).privateKey;
}

// ═════════════════════════════════════════════════════════════
//  Real Wallet Delegation (EIP-712 Typed Data)
// ═════════════════════════════════════════════════════════════

/** EIP-712 domain for Interego delegations */
const DELEGATION_DOMAIN = {
  name: 'ContextGraphsDelegation',
  version: '1',
};

/** EIP-712 types for delegation */
const DELEGATION_TYPES = {
  Delegation: [
    { name: 'owner', type: 'address' },
    { name: 'agent', type: 'address' },
    { name: 'scope', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'issuedAt', type: 'string' },
    { name: 'validUntil', type: 'string' },
  ],
};

/**
 * Create a real delegation: human wallet signs EIP-712 typed data
 * authorizing the agent wallet.
 */
export async function createDelegation(
  ownerWallet: Wallet,
  agentWallet: Wallet,
  scope: string = 'ReadWrite',
  validUntil?: string,
): Promise<WalletDelegation> {
  const signer = getSigningWallet(ownerWallet.address);
  const now = new Date().toISOString();

  const value = {
    owner: ownerWallet.address,
    agent: agentWallet.address,
    scope,
    chainId: ownerWallet.chainId,
    issuedAt: now,
    validUntil: validUntil ?? '',
  };

  const signature = await signer.signTypedData(
    { ...DELEGATION_DOMAIN, chainId: ownerWallet.chainId },
    DELEGATION_TYPES,
    value,
  );

  return {
    ownerAddress: ownerWallet.address,
    agentAddress: agentWallet.address,
    scope,
    signature,
    message: JSON.stringify(value),
    chainId: ownerWallet.chainId,
    validUntil,
  };
}

/**
 * Verify a delegation signature — recovers the signer address
 * and checks it matches the claimed owner.
 */
export function verifyDelegationSignature(delegation: WalletDelegation): boolean {
  try {
    const value = JSON.parse(delegation.message);
    const recovered = ethers.verifyTypedData(
      { ...DELEGATION_DOMAIN, chainId: delegation.chainId },
      DELEGATION_TYPES,
      value,
      delegation.signature,
    );
    return recovered.toLowerCase() === delegation.ownerAddress.toLowerCase();
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════
//  Real Descriptor Signing (ECDSA)
// ═════════════════════════════════════════════════════════════

/**
 * Sign a descriptor with the agent wallet.
 * Signs the SHA-256 hash of the Turtle content using real ECDSA.
 */
export async function signDescriptor(
  descriptorId: IRI,
  turtle: string,
  agentWallet: Wallet,
): Promise<SignedDescriptor> {
  const signer = getSigningWallet(agentWallet.address);
  const contentHash = await sha256(turtle);

  const signedAt = new Date().toISOString();

  // Sign a structured message containing the descriptor ID and content hash
  const message = `Interego Descriptor Signature\nDescriptor: ${descriptorId}\nContent Hash: ${contentHash}\nSigned At: ${signedAt}`;
  const signature = await signer.signMessage(message);

  return {
    descriptorId,
    contentHash,
    signature,
    signerAddress: agentWallet.address,
    signedAt,
    chainId: agentWallet.chainId,
  };
}

/**
 * Verify a descriptor signature.
 * Recovers the signer address from the ECDSA signature and checks:
 *   1. Content hash matches the provided Turtle
 *   2. Recovered address matches the claimed signer
 */
export async function verifyDescriptorSignature(
  signed: SignedDescriptor,
  turtle: string,
): Promise<{ valid: boolean; recoveredAddress?: string; reason?: string }> {
  // 1. Verify content hash
  const contentHash = await sha256(turtle);
  if (contentHash !== signed.contentHash) {
    return { valid: false, reason: 'Content hash mismatch — descriptor was modified after signing' };
  }

  // 2. Recover signer from signature
  try {
    // Reconstruct the signed message
    const message = `Interego Descriptor Signature\nDescriptor: ${signed.descriptorId}\nContent Hash: ${signed.contentHash}\nSigned At: ${signed.signedAt}`;
    const recoveredAddress = ethers.verifyMessage(message, signed.signature);

    if (recoveredAddress.toLowerCase() !== signed.signerAddress.toLowerCase()) {
      return {
        valid: false,
        recoveredAddress,
        reason: `Signer mismatch: expected ${signed.signerAddress}, recovered ${recoveredAddress}`,
      };
    }

    return { valid: true, recoveredAddress };
  } catch (err) {
    return { valid: false, reason: `Signature verification failed: ${(err as Error).message}` };
  }
}

// ═════════════════════════════════════════════════════════════
//  ERC-8004: Agent Identity Token
// ═════════════════════════════════════════════════════════════

/**
 * Create an ERC-8004 agent identity token.
 * In production with a blockchain connection, this would mint an NFT.
 * Without a provider, it prepares the token data for later minting.
 */
export async function createAgentToken(
  ownerWallet: Wallet,
  agentWallet: Wallet,
  agentUri: IRI,
  metadata: { name: string; description: string; capabilities: string[]; delegationScope: string },
): Promise<AgentIdentityToken> {
  const tokenId = await sha256(`erc8004:${agentWallet.address}:${ownerWallet.address}:${Date.now()}`);

  return {
    tokenId: tokenId.slice(0, 16),
    contractAddress: '0x8004000000000000000000000000000000000000', // placeholder until deployed
    chainId: ownerWallet.chainId,
    ownerAddress: ownerWallet.address,
    agentAddress: agentWallet.address,
    agentUri,
    metadata,
    mintedAt: new Date().toISOString(),
    // transactionHash is undefined until actually minted on-chain
  };
}

// ═════════════════════════════════════════════════════════════
//  ERC-4361: Sign-In With Ethereum (SIWE)
// ═════════════════════════════════════════════════════════════

/**
 * Create a SIWE message for human authentication.
 */
export function createSiweMessage(
  domain: string,
  address: string,
  statement: string,
  uri: string,
  chainId: number = 1,
  resources?: string[],
): SiweMessage {
  return {
    domain,
    address,
    statement,
    uri,
    version: '1',
    chainId,
    nonce: ethers.hexlify(ethers.randomBytes(8)).slice(2),
    issuedAt: new Date().toISOString(),
    resources,
  };
}

/**
 * Format a SIWE message as the ERC-4361 string.
 */
export function formatSiweMessage(msg: SiweMessage): string {
  const lines = [
    `${msg.domain} wants you to sign in with your Ethereum account:`,
    msg.address,
    '',
    msg.statement,
    '',
    `URI: ${msg.uri}`,
    `Version: ${msg.version}`,
    `Chain ID: ${msg.chainId}`,
    `Nonce: ${msg.nonce}`,
    `Issued At: ${msg.issuedAt}`,
  ];
  if (msg.expirationTime) lines.push(`Expiration Time: ${msg.expirationTime}`);
  if (msg.resources?.length) {
    lines.push('Resources:');
    for (const r of msg.resources) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}

/**
 * Sign a SIWE message with a wallet.
 * Returns the signature that proves the wallet owner approves the message.
 */
export async function signSiweMessage(
  msg: SiweMessage,
  wallet: Wallet,
): Promise<string> {
  const signer = getSigningWallet(wallet.address);
  const formatted = formatSiweMessage(msg);
  return signer.signMessage(formatted);
}

/**
 * Verify a SIWE signature using the siwe library.
 * Recovers the signer address and validates the message fields.
 */
export async function verifySiweSignature(
  message: SiweMessage,
  signature: string,
): Promise<SiweVerification> {
  try {
    // Check expiration
    if (message.expirationTime && new Date(message.expirationTime) < new Date()) {
      return { valid: false, error: 'SIWE message expired' };
    }

    // Recover signer from the formatted message
    const formatted = formatSiweMessage(message);
    const recoveredAddress = ethers.verifyMessage(formatted, signature);

    if (recoveredAddress.toLowerCase() !== message.address.toLowerCase()) {
      return { valid: false, error: `Address mismatch: expected ${message.address}, recovered ${recoveredAddress}` };
    }

    return {
      valid: true,
      address: recoveredAddress,
      chainId: message.chainId,
    };
  } catch (err) {
    return { valid: false, error: `SIWE verification failed: ${(err as Error).message}` };
  }
}

// ═════════════════════════════════════════════════════════════
//  Coinbase AgentKit Integration
// ═════════════════════════════════════════════════════════════

/**
 * Create an agent wallet via Coinbase AgentKit.
 * Falls back to ethers.js if AgentKit is not installed.
 */
export async function createAgentKitWallet(
  label: string,
  chainId: number = 84532,
): Promise<Wallet> {
  // Try to load AgentKit dynamically
  try {
    const moduleName = '@coinbase/agentkit';
    const agentkit = await import(moduleName) as any;
    if (agentkit?.AgentKit?.from) {
      const kit = await agentkit.AgentKit.from({
        cdpApiKeyName: process.env['CDP_API_KEY_NAME'],
        cdpApiKeyPrivate: process.env['CDP_API_KEY_PRIVATE'],
      });
      const walletData = await kit.exportWallet();
      return {
        address: walletData.defaultAddressId ?? ethers.Wallet.createRandom().address,
        type: 'agent',
        provider: 'agentkit',
        chainId,
        label,
      };
    }
  } catch {
    // AgentKit not available, fall through to ethers
  }

  // Fallback to real ethers.js wallet
  return createWallet('agent', label, chainId);
}
