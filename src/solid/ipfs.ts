/**
 * @module solid/ipfs
 * @description IPFS content anchoring for PGSL lattice fragments.
 *
 * PGSL atoms are already content-addressed (deterministic URIs from content).
 * IPFS CIDs are also content-addressed. The mapping is natural:
 *   urn:pgsl:atom:X → ipfs://Qm<hash(X)>
 *
 * This module provides:
 *   - CID computation for PGSL nodes (without requiring IPFS daemon)
 *   - Pinning via HTTP API (Pinata, web3.storage, etc.)
 *   - Anchor metadata generation for the Trust facet
 */

import type { IRI, IPFSAnchor } from '../model/types.js';
import type { PGSLInstance } from '../pgsl/types.js';
import type { FetchFn } from '../solid/types.js';

/**
 * Compute a CID-like hash for a PGSL node.
 * Uses SHA-256 + base32 encoding (CIDv1 compatible structure).
 * In production, use the actual multihash/CID libraries.
 */
export async function computeCid(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  // Base32-encode (simplified — real CID uses multibase + multicodec + multihash)
  const hex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  return `bafk${hex.slice(0, 52)}`; // CIDv1-like prefix
}

/**
 * Compute CIDs for all nodes in a PGSL lattice.
 * Returns a map from PGSL URI → IPFS CID.
 */
export async function computeLatticeCids(
  pgsl: PGSLInstance,
): Promise<Map<IRI, string>> {
  const cids = new Map<IRI, string>();

  for (const [uri, node] of pgsl.nodes) {
    const content = node.kind === 'Atom'
      ? `atom:${node.value}`
      : `fragment:L${node.level}:${node.items.join('|')}`;
    const cid = await computeCid(content);
    cids.set(uri, cid);
  }

  return cids;
}

/**
 * Pin content to an IPFS pinning service via HTTP API.
 * Supports Pinata-compatible API.
 */
export async function pinToIPFS(
  content: string,
  name: string,
  options: {
    pinServiceUrl: string;
    apiKey: string;
    fetch?: FetchFn;
  },
): Promise<IPFSAnchor> {
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const cid = await computeCid(content);

  try {
    const resp = await fetchFn(`${options.pinServiceUrl}/pinning/pinByHash`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        hashToPin: cid,
        pinataMetadata: { name },
      }),
    });

    return {
      cid,
      pinned: resp.ok,
      pinnedAt: resp.ok ? new Date().toISOString() : undefined,
      pinService: 'pinata',
    };
  } catch {
    // Pinning failed — return unpinned anchor with computed CID
    return {
      cid,
      pinned: false,
      pinService: 'none',
    };
  }
}

/**
 * Generate an IPFSAnchor for a descriptor without actually pinning.
 * Useful for computing what the CID would be before committing to pinning.
 */
export async function computeDescriptorAnchor(
  descriptorTurtle: string,
): Promise<IPFSAnchor> {
  const cid = await computeCid(descriptorTurtle);
  return {
    cid,
    pinned: false,
  };
}
