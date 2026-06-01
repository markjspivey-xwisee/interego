/**
 * @module passport/wallet
 * @description Substrate-level loader for an agent's persistent ECDSA
 *   keypair. Standardizes the "read env var or mint ephemeral, then
 *   derive did:key" pattern that was being re-implemented at every site
 *   that needs a stable agent identity (Foxxi bridge-signer, the
 *   tic-tac-toe collective watcher, pod-wallet helpers, etc.).
 *
 *   Pure composition over existing primitives:
 *     - ethers `Wallet` / `HDNodeWallet` for the secp256k1 keypair
 *     - the project-wide did:key convention `did:key:0x<addr>#<label>`
 *       already used by `src/passport/createPassport` callers and by
 *       Foxxi's bridge signer.
 *
 *   No new ontology terms. No new identity concept. Just the canonical
 *   loader so the env-or-ephemeral coin-flip lives in exactly one
 *   place.
 */

import { Wallet, type HDNodeWallet } from 'ethers';

/** Common signing surface across `new Wallet(key)` (returns `Wallet`)
 *  and `Wallet.createRandom()` (returns `HDNodeWallet`). Both expose
 *  `.address` and `.signMessage`. */
export type AgentWallet = Wallet | HDNodeWallet;

export interface AgentKeypair {
  /** The underlying ethers wallet — use for `signMessage`, `signTypedData`, etc. */
  readonly wallet: AgentWallet;
  /** Lowercase 0x-prefixed 20-byte Ethereum address. */
  readonly address: string;
  /** `did:key:0x<address>#<label>` — the canonical substrate DID form. */
  readonly did: string;
  /** Where the private key came from: process env (`env`) or fresh
   *  random key minted for this process (`ephemeral`). Callers
   *  typically warn on `ephemeral` because the DID will not survive
   *  restart. This helper does NOT log — caller formats the banner. */
  readonly source: 'env' | 'ephemeral';
}

export interface LoadAgentKeypairOptions {
  /** Name of the process env var holding the 0x-prefixed 32-byte hex
   *  private key (e.g. `'FOXXI_BRIDGE_PRIVATE_KEY'`). */
  readonly envVar: string;
  /** DID fragment appended after `#` (e.g. `'bridge'`, `'agent'`,
   *  `'aggressor'`). Identifies the agent's role within the wallet's
   *  DID — `did:key:0x…#<label>`. */
  readonly label: string;
}

/** Strict 0x-prefixed 32-byte hex private key. */
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Load (or mint) a stable ECDSA keypair for an agent identity.
 *
 * If `process.env[options.envVar]` is a valid 0x-prefixed 32-byte hex
 * private key, the wallet is loaded from it and `source === 'env'`.
 * Otherwise a fresh keypair is minted via `Wallet.createRandom()` and
 * `source === 'ephemeral'` — the caller decides whether to warn.
 *
 * The DID is derived deterministically as
 *   `did:key:0x<lowercased 20-byte address>#<label>`.
 * This matches the existing convention used across the substrate
 * (Foxxi's bridge-signer, the tic-tac-toe collective watcher, the
 * DID resolver in `src/solid/did-resolver.ts`).
 *
 * Pure function aside from reading `process.env` and minting a random
 * key. No logging — the helper stays silent so callers can format
 * their own startup banner consistently.
 */
export function loadAgentKeypair(options: LoadAgentKeypairOptions): AgentKeypair {
  const raw = process.env[options.envVar]?.trim();
  let wallet: AgentWallet;
  let source: 'env' | 'ephemeral';
  if (raw && PRIVATE_KEY_PATTERN.test(raw)) {
    wallet = new Wallet(raw);
    source = 'env';
  } else {
    wallet = Wallet.createRandom();
    source = 'ephemeral';
  }
  const address = wallet.address.toLowerCase();
  const did = `did:key:${address}#${options.label}`;
  return { wallet, address, did, source };
}
