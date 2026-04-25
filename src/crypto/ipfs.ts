/**
 * @module crypto/ipfs
 * @description IPFS pinning and real CID computation.
 *
 * Uses ethers.js for SHA-256 hashing.
 * Computes real IPFS-compatible content identifiers.
 *
 * PGSL atoms are content-addressed — this extends that to IPFS:
 *   urn:pgsl:atom:X → CID based on real SHA-256 hash
 *
 * Supports Pinata, web3.storage, or local (CID computed, not pinned).
 */

import { ethers } from 'ethers';
import type { IRI } from '../model/types.js';
import type { CID, IpfsPinResult, IpfsAnchor, IpfsConfig } from './types.js';
import type { FetchFn } from '../solid/types.js';

// ── Content hashing (real SHA-256 via ethers.js) ─────────────

/**
 * SHA-256 hash of a string, returned as hex (no 0x prefix).
 * Uses ethers.js which uses real Web Crypto / Node crypto.
 */
export function sha256(content: string): string {
  const data = ethers.toUtf8Bytes(content);
  const hash = ethers.sha256(data);
  return hash.slice(2); // remove 0x prefix
}

// ── Real CID Computation ─────────────────────────────────────

/**
 * Compute a real CIDv1 (raw codec, sha2-256) from content.
 *
 * Format: `b` (multibase prefix for base32) + base32-lowercase encoding of:
 *   [CID version byte (0x01)] + [codec (0x55 = raw)] +
 *   [multihash header (0x12 = sha2-256, 0x20 = 32 bytes)] +
 *   [SHA-256 digest (32 bytes)]
 *
 * Output looks like `bafkreif7...` and resolves correctly on any IPFS gateway
 * for the given content. Prior implementation concatenated `bafkrei` + raw hex,
 * which is NOT a valid base32 multihash and never resolves.
 */
export function computeCid(content: string): CID {
  const hashHex = sha256(content); // 64-char hex string
  // Build the binary multihash: [0x12, 0x20, ...digest32]
  // Then prepend the CID v1 prefix: [0x01, 0x55, ...multihash]
  const digest = hexToBytes(hashHex);
  const multihash = new Uint8Array(2 + digest.length);
  multihash[0] = 0x12; // sha2-256
  multihash[1] = 0x20; // 32-byte length
  multihash.set(digest, 2);
  const cidBytes = new Uint8Array(2 + multihash.length);
  cidBytes[0] = 0x01; // CIDv1
  cidBytes[1] = 0x55; // raw codec
  cidBytes.set(multihash, 2);
  // Multibase prefix `b` = base32 lowercase, no padding (RFC 4648 §6).
  return `b${base32Encode(cidBytes)}` as CID;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// RFC 4648 base32 lowercase, no padding.
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

// ── IPFS Pinning ─────────────────────────────────────────────

/**
 * Pin content to IPFS via configured provider.
 */
export async function pinToIpfs(
  content: string,
  name: string,
  config: IpfsConfig,
  fetchFn?: FetchFn,
): Promise<IpfsPinResult> {
  switch (config.provider) {
    case 'pinata':
      return pinToPinata(content, name, config, fetchFn);
    case 'web3storage':
      return pinToWeb3Storage(content, name, config, fetchFn);
    case 'local':
    default:
      return localPin(content);
  }
}

/**
 * Pin via Pinata API.
 */
async function pinToPinata(
  content: string,
  name: string,
  config: IpfsConfig,
  fetchFn?: FetchFn,
): Promise<IpfsPinResult> {
  const doFetch = fetchFn ?? defaultFetch;
  const resp = await doFetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      pinataContent: { content, name },
      pinataMetadata: { name },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Pinata pin failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { IpfsHash: string; PinSize: number };
  const gateway = config.gateway ?? 'https://gateway.pinata.cloud/ipfs/';

  return {
    cid: data.IpfsHash as CID,
    size: data.PinSize,
    url: `${gateway}${data.IpfsHash}`,
    pinnedAt: new Date().toISOString(),
    provider: 'pinata',
  };
}

/**
 * Pin via web3.storage API.
 */
async function pinToWeb3Storage(
  content: string,
  name: string,
  config: IpfsConfig,
  fetchFn?: FetchFn,
): Promise<IpfsPinResult> {
  const doFetch = fetchFn ?? defaultFetch;

  const resp = await doFetch('https://api.web3.storage/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/octet-stream',
      'X-Name': name,
    },
    body: content,
  });

  if (!resp.ok) {
    throw new Error(`web3.storage pin failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as { cid: string };
  return {
    cid: data.cid as CID,
    size: content.length,
    url: `https://w3s.link/ipfs/${data.cid}`,
    pinnedAt: new Date().toISOString(),
    provider: 'web3storage',
  };
}

/**
 * Local CID computation without pinning.
 * Computes a real content-addressed identifier — same hash IPFS would produce.
 * Content is not uploaded anywhere.
 */
function localPin(content: string): IpfsPinResult {
  const cid = computeCid(content);
  return {
    cid,
    size: content.length,
    url: `ipfs://${cid}`,
    pinnedAt: new Date().toISOString(),
    provider: 'local',
  };
}

/**
 * Create an IpfsAnchor from a pin result.
 */
export function createIpfsAnchor(content: string, pinResult: IpfsPinResult): IpfsAnchor {
  return {
    cid: pinResult.cid,
    gatewayUrl: pinResult.url,
    contentHash: sha256(content),
    pinnedAt: pinResult.pinnedAt,
  };
}

/**
 * Pin a PGSL fragment to IPFS and return the anchor.
 */
export async function pinPgslFragment(
  fragmentUri: IRI,
  content: string,
  config: IpfsConfig,
  fetchFn?: FetchFn,
): Promise<IpfsAnchor> {
  const name = `pgsl-${fragmentUri.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 60)}`;
  const result = await pinToIpfs(content, name, config, fetchFn);
  return createIpfsAnchor(content, result);
}

/**
 * Pin a descriptor's Turtle to IPFS and return the anchor.
 */
export async function pinDescriptor(
  descriptorId: IRI,
  turtle: string,
  config: IpfsConfig,
  fetchFn?: FetchFn,
): Promise<IpfsAnchor> {
  const name = `descriptor-${descriptorId.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 60)}`;
  const result = await pinToIpfs(turtle, name, config, fetchFn);
  return createIpfsAnchor(turtle, result);
}

// ── Default fetch ────────────────────────────────────────────

const defaultFetch: FetchFn = async (url, init) => {
  const resp = await fetch(url, init as RequestInit);
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    headers: { get: (n: string) => resp.headers.get(n) },
    text: () => resp.text(),
    json: () => resp.json(),
  };
};
