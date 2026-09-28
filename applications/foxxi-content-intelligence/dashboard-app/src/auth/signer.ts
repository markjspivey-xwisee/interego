/**
 * Who signs a dashboard session's requests, and how.
 *
 * The /agent/* affordances authenticate a request by its signature, so every session has a signer:
 *  - a roster identity signs with its demo wallet, derived from its user id (deriveUserWallet);
 *  - a connected key signs with that key, held in this tab's memory only;
 *  - a wallet extension signs in the extension, as the account it holds. The dashboard never holds
 *    that key.
 *
 * ★ A WALLET EXTENSION ASKS BEFORE IT SIGNS. Where a bridge takes session keys for this page
 * (auth/session-key.ts), it asks once: to let a key this tab makes sign that bridge's requests as
 * its account, for an hour at most. Where a bridge takes none, each signed request is one approval.
 * Until the tab holds a session, a page says a wallet will ask, and waits for a click to read.
 */
import { ethers } from 'ethers';
import { deriveUserWallet, type MessageSigner } from './session-token.js';
import { holdsSession, sessionFor } from './session-key.js';

export type { MessageSigner } from './session-token.js';

/** The part of a session that says who signs for it. */
export interface SigningIdentity {
  userId: string;
  connectedPrivateKey?: string;
  signingMode?: 'extension';
  extensionAddress?: string;
}

/** The EIP-1193 provider a wallet extension injects into the page, if there is one. */
export function walletExtension(): ethers.Eip1193Provider | undefined {
  return (globalThis as { ethereum?: ethers.Eip1193Provider }).ethereum;
}

/** The account a wallet extension shares with this page, asking its owner if it has not yet. */
export async function extensionAccount(provider: ethers.Eip1193Provider): Promise<string> {
  const accounts: unknown = await provider.request({ method: 'eth_requestAccounts', params: [] });
  const first = Array.isArray(accounts) ? accounts.find((a): a is string => typeof a === 'string' && ethers.isAddress(a)) : undefined;
  if (!first) throw new Error('The wallet shared no account with this page.');
  return ethers.getAddress(first);
}

/**
 * A signer whose key stays in the extension: each message is signed there (personal_sign, EIP-191)
 * as `address`, on its owner's approval. It fails, saying so, once the extension no longer offers
 * that account, as when its owner switched accounts.
 */
export function extensionSigner(address: string, provider: ethers.Eip1193Provider | undefined = walletExtension()): MessageSigner {
  const self: MessageSigner = {
    address,
    async signMessage(message: string): Promise<string> {
      if (!provider) throw new Error('No wallet extension is available in this browser now; sign in again.');
      let signer: ethers.JsonRpcSigner;
      try { signer = await new ethers.BrowserProvider(provider).getSigner(address); }
      catch { throw new Error(`Your wallet did not offer ${address} for signing; switch back to it, or sign in again.`); }
      return signer.signMessage(message);
    },
    // The grant is signed in the wallet, as everything this account signs is; the key it grants
    // signs the bridge's requests after.
    session: (audience: string) => sessionFor(self, audience),
  };
  return self;
}

/** The signer for a session: its wallet extension, its connected key, or its demo wallet. */
export function signerFor(identity: SigningIdentity): MessageSigner {
  if (identity.signingMode === 'extension' && identity.extensionAddress) return extensionSigner(identity.extensionAddress);
  if (identity.connectedPrivateKey) return new ethers.Wallet(identity.connectedPrivateKey);
  return deriveUserWallet(identity.userId);
}

/**
 * Whether a session's signer will ask a person before its next signed request: a wallet extension
 * that holds no session key with time left. Once it holds one, pages read without waiting for a click.
 */
export function signerAsks(identity: SigningIdentity): boolean {
  return identity.signingMode === 'extension' && !!identity.extensionAddress && !holdsSession(identity.extensionAddress);
}
