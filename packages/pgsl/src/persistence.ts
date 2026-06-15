/**
 * @module pgsl/persistence
 * @description Progressive persistence for PGSL nodes.
 *
 * Every atom and fragment lives at one or more persistence tiers:
 *
 *   Tier 0: Memory    — agent's local PGSL instance, ephemeral
 *   Tier 1: Local     — agent's disk/storage, survives restart
 *   Tier 2: Pod       — agent's Solid pod, discoverable by authorized agents
 *   Tier 3: IPFS      — content-addressed, globally dereferenceable, immutable
 *   Tier 4: Chain     — blockchain-anchored hash, timestamped proof of existence
 *
 * The URI is the same at every tier (content-addressed from value).
 * What changes: availability, durability, trust proof strength.
 *
 * Resolution: to get the VALUE behind a URI, you need:
 *   1. A tier that has it
 *   2. Authorization to read it (decryption key if encrypted)
 *
 * Promotion: atoms move UP tiers (memory → local → pod → IPFS → chain).
 * Each promotion is recorded as a PersistenceRecord.
 */

import type { IRI } from '@interego/core';
import { createEncryptedEnvelope, openEncryptedEnvelope } from '@interego/core';
import type { EncryptionKeyPair, EncryptedEnvelope } from '@interego/core';
import type { PGSLInstance, Value, NodeProvenance, Node } from './types.js';
import { resolve as pgslResolve } from './lattice.js';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ── Types ──────────────────────────────────────────────────

export type PersistenceTier = 0 | 1 | 2 | 3 | 4;

export const TierName: Record<PersistenceTier, string> = {
  0: 'memory', 1: 'local', 2: 'pod', 3: 'ipfs', 4: 'chain',
};

/** Where a node is persisted and how to resolve it. */
export interface PersistenceRecord {
  readonly uri: IRI;
  readonly tier: PersistenceTier;
  readonly endpoint?: string;
  readonly cid?: string;
  readonly transactionHash?: string;
  readonly blockNumber?: number;
  readonly chainId?: number;
  readonly encryptedFor?: readonly string[];
  readonly promotedAt: string;
  readonly promotedBy: IRI;
  readonly signature?: string;
}

/** Resolution result — what you get when you dereference a URI. */
export interface ResolutionResult {
  readonly uri: IRI;
  readonly value?: Value;
  readonly encrypted?: boolean;
  readonly tier: PersistenceTier;
  readonly endpoint: string;
  readonly provenance: NodeProvenance;
  readonly cid?: string;
  readonly verified?: boolean;
}

/** Persistence registry — tracks where each node lives. */
export interface PersistenceRegistry {
  readonly records: ReadonlyMap<IRI, readonly PersistenceRecord[]>;
}

/** Options for {@link recordPersistence}. */
export interface RecordPersistenceOptions {
  readonly endpoint?: string;
  readonly cid?: string;
  readonly transactionHash?: string;
  readonly blockNumber?: number;
  readonly chainId?: number;
  readonly encryptedFor?: readonly string[];
  readonly promotedBy: IRI;
  readonly signature?: string;
}

/** Authorization for resolving encrypted content. */
export interface ResolutionAuthorization {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** Options for {@link promoteBatch}. */
export interface PromoteBatchOptions {
  readonly storagePath?: string;
  readonly podUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly ipfsConfig?: unknown;
  readonly wallet?: unknown;
  readonly chainConfig?: unknown;
  readonly promotedBy: IRI;
}

// ── Registry Operations ────────────────────────────────────

/** Create an empty persistence registry. */
export function createPersistenceRegistry(): PersistenceRegistry {
  return { records: new Map() };
}

/**
 * Record that a node exists at a given persistence tier.
 * Idempotent: re-recording the same URI+tier replaces the previous record.
 */
export function recordPersistence(
  registry: PersistenceRegistry,
  uri: IRI,
  tier: PersistenceTier,
  options: RecordPersistenceOptions,
): PersistenceRecord {
  const record: PersistenceRecord = {
    uri, tier,
    endpoint: options.endpoint,
    cid: options.cid,
    transactionHash: options.transactionHash,
    blockNumber: options.blockNumber,
    chainId: options.chainId,
    encryptedFor: options.encryptedFor,
    promotedAt: new Date().toISOString(),
    promotedBy: options.promotedBy,
    signature: options.signature,
  };
  const mutable = registry.records as Map<IRI, PersistenceRecord[]>;
  const existing = mutable.get(uri) ?? [];
  mutable.set(uri, [...existing.filter(r => r.tier !== tier), record]);
  return record;
}

/** Highest tier a node exists at (0 if no explicit records). */
export function getMaxTier(registry: PersistenceRegistry, uri: IRI): PersistenceTier {
  const records = registry.records.get(uri);
  if (!records || records.length === 0) return 0;
  return Math.max(...records.map(r => r.tier)) as PersistenceTier;
}

/** All persistence records for a node, ordered by tier ascending. */
export function getTierRecords(registry: PersistenceRegistry, uri: IRI): PersistenceRecord[] {
  const records = registry.records.get(uri);
  if (!records) return [];
  return [...records].sort((a, b) => a.tier - b.tier);
}

/** All node URIs that have a record at a specific tier. */
export function getNodesAtTier(registry: PersistenceRegistry, tier: PersistenceTier): IRI[] {
  const result: IRI[] = [];
  for (const [uri, records] of registry.records) {
    if (records.some(r => r.tier === tier)) result.push(uri);
  }
  return result;
}

// ── Tier Promotion Functions ───────────────────────────────

/** Promote a node to tier 1 — serialize to disk as JSON. */
export async function promoteToLocal(
  pgsl: PGSLInstance, uri: IRI, storagePath: string,
): Promise<PersistenceRecord> {
  const node = pgsl.nodes.get(uri);
  if (!node) throw new Error(`Node not found: ${uri}`);

  const hash = createHash('sha256').update(uri).digest('hex').slice(0, 16);
  const filePath = `${storagePath}/${hash}.json`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(node, null, 2), 'utf-8');

  return recordPersistence(createPersistenceRegistry(), uri, 1, {
    endpoint: filePath,
    promotedBy: node.provenance.wasAttributedTo,
  });
}

/** Promote a node to tier 2 — publish as Turtle to a Solid pod. */
export async function promoteToPod(
  pgsl: PGSLInstance, uri: IRI, podUrl: string, fetchFn: typeof fetch,
): Promise<PersistenceRecord> {
  const node = pgsl.nodes.get(uri);
  if (!node) throw new Error(`Node not found: ${uri}`);

  const turtle = nodeToTurtle(node, pgslResolve(pgsl, uri));
  const slug = createHash('sha256').update(uri).digest('hex').slice(0, 16);
  const resourceUrl = `${podUrl.replace(/\/$/, '')}/pgsl/${slug}.ttl`;

  const response = await fetchFn(resourceUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle', 'If-None-Match': '*' },
    body: turtle,
  });
  if (!response.ok && response.status !== 412) {
    throw new Error(`Pod publish failed: ${response.status} ${response.statusText}`);
  }

  return recordPersistence(createPersistenceRegistry(), uri, 2, {
    endpoint: resourceUrl,
    promotedBy: node.provenance.wasAttributedTo,
  });
}

/**
 * Promote a node to tier 2 (pod) ENCRYPTED — the canonical, encrypted-by-default
 * form. The holon is the source of truth; this writes it as an encrypted
 * envelope (JWE-style, per-recipient wrapped content key) so the pod holds
 * ciphertext, never plaintext. `resourceUrl` is supplied by the caller (resolved
 * via the agent's shape-driven Type Index placement), keeping this layer free of
 * any Solid/placement dependency. Pair with {@link resolveHolonFromPod}.
 */
export async function promoteToPodEncrypted(
  pgsl: PGSLInstance,
  uri: IRI,
  resourceUrl: string,
  recipientPublicKeys: readonly string[],
  senderKeyPair: EncryptionKeyPair,
  fetchFn: typeof fetch,
): Promise<PersistenceRecord> {
  const node = pgsl.nodes.get(uri);
  if (!node) throw new Error(`Node not found: ${uri}`);

  // Canonical, lossless holon serialization → encrypted envelope. (JSON of the
  // node round-trips exactly; the projection layer renders RDF/Turtle separately.)
  const plaintext = JSON.stringify(node);
  const envelope = createEncryptedEnvelope(plaintext, recipientPublicKeys, senderKeyPair);

  const response = await fetchFn(resourceUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  if (!response.ok && response.status !== 412) {
    throw new Error(`Encrypted pod publish failed: ${response.status} ${response.statusText}`);
  }

  return recordPersistence(createPersistenceRegistry(), uri, 2, {
    endpoint: resourceUrl,
    encryptedFor: [...recipientPublicKeys],
    promotedBy: node.provenance.wasAttributedTo,
  });
}

/**
 * Resolve + decrypt a holon persisted via {@link promoteToPodEncrypted}.
 * Returns the node, or null if unauthorized / unreadable / decryption fails.
 */
export async function resolveHolonFromPod(
  resourceUrl: string,
  recipientKeyPair: EncryptionKeyPair,
  fetchFn: typeof fetch,
): Promise<Node | null> {
  const r = await fetchFn(resourceUrl, { headers: { Accept: 'application/json' } });
  if (!r.ok) return null;
  let envelope: EncryptedEnvelope;
  try { envelope = (await r.json()) as EncryptedEnvelope; } catch { return null; }
  const plaintext = openEncryptedEnvelope(envelope, recipientKeyPair);
  if (plaintext == null) return null;
  try { return JSON.parse(plaintext) as Node; } catch { return null; }
}

/** All nodes reachable from a top holon — the lattice slice it spans (items +
 *  left/right constituents, transitively). This is the CANONICAL extent of an
 *  artifact: persisting only the top node leaves its item URIs dangling. */
export function collectLatticeSlice(pgsl: PGSLInstance, topUri: IRI): Map<IRI, Node> {
  const out = new Map<IRI, Node>();
  const stack: IRI[] = [topUri];
  while (stack.length > 0) {
    const uri = stack.pop()!;
    if (out.has(uri)) continue;
    const node = pgsl.nodes.get(uri);
    if (!node) continue;
    out.set(uri, node);
    if (node.kind === 'Fragment') {
      for (const item of node.items) stack.push(item);
      if (node.left) stack.push(node.left);
      if (node.right) stack.push(node.right);
    }
  }
  return out;
}

/** Serialized, decryptable form of a full lattice slice. */
export interface EncryptedLatticeSlice {
  readonly topUri: IRI;
  /** uri → node, for every node reachable from topUri. */
  readonly nodes: Record<string, Node>;
}

/**
 * Promote the FULL lattice slice spanned by `topUri` to tier 2 (pod), ENCRYPTED
 * — the canonical, self-contained, encrypted form of an artifact. Unlike
 * {@link promoteToPodEncrypted} (top node only), this persists every node
 * reachable from the holon, so {@link resolveLatticeFromPod} can rebuild the
 * artifact in full from ciphertext alone. `resourceUrl` is supplied by the
 * caller (resolved via the agent's shape-driven Type Index placement).
 */
export async function promoteLatticeSliceEncrypted(
  pgsl: PGSLInstance,
  topUri: IRI,
  resourceUrl: string,
  recipientPublicKeys: readonly string[],
  senderKeyPair: EncryptionKeyPair,
  fetchFn: typeof fetch,
): Promise<PersistenceRecord> {
  const top = pgsl.nodes.get(topUri);
  if (!top) throw new Error(`Node not found: ${topUri}`);

  const slice = collectLatticeSlice(pgsl, topUri);
  const payload: EncryptedLatticeSlice = {
    topUri,
    nodes: Object.fromEntries(slice) as Record<string, Node>,
  };
  const envelope = createEncryptedEnvelope(JSON.stringify(payload), recipientPublicKeys, senderKeyPair);

  const response = await fetchFn(resourceUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  if (!response.ok && response.status !== 412) {
    throw new Error(`Encrypted lattice-slice publish failed: ${response.status} ${response.statusText}`);
  }

  return recordPersistence(createPersistenceRegistry(), topUri, 2, {
    endpoint: resourceUrl,
    encryptedFor: [...recipientPublicKeys],
    promotedBy: top.provenance.wasAttributedTo,
  });
}

/**
 * Promote the ENTIRE lattice instance to tier 2 (pod), ENCRYPTED, anchored at
 * `topUri`. Use this when the instance holds exactly one artifact (e.g. a fresh
 * per-artifact lattice) — it persists every node, so multi-chain ingests (whose
 * chains aren't all reachable from a single top) are captured in full. Same
 * encrypted wire shape as {@link promoteLatticeSliceEncrypted}; read back with
 * {@link resolveLatticeFromPod}.
 */
export async function promoteInstanceEncrypted(
  pgsl: PGSLInstance,
  topUri: IRI,
  resourceUrl: string,
  recipientPublicKeys: readonly string[],
  senderKeyPair: EncryptionKeyPair,
  fetchFn: typeof fetch,
): Promise<PersistenceRecord> {
  const top = pgsl.nodes.get(topUri);
  if (!top) throw new Error(`Node not found: ${topUri}`);

  const payload: EncryptedLatticeSlice = {
    topUri,
    nodes: Object.fromEntries(pgsl.nodes) as Record<string, Node>,
  };
  const envelope = createEncryptedEnvelope(JSON.stringify(payload), recipientPublicKeys, senderKeyPair);

  const response = await fetchFn(resourceUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  if (!response.ok && response.status !== 412) {
    throw new Error(`Encrypted instance publish failed: ${response.status} ${response.statusText}`);
  }

  return recordPersistence(createPersistenceRegistry(), topUri, 2, {
    endpoint: resourceUrl,
    encryptedFor: [...recipientPublicKeys],
    promotedBy: top.provenance.wasAttributedTo,
  });
}

/**
 * Resolve + decrypt a full lattice slice persisted via
 * {@link promoteLatticeSliceEncrypted}. Returns the top URI + the node map (so
 * the caller can rebuild a PGSLInstance / walk the full artifact), or null if
 * unauthorized / unreadable / decryption fails.
 */
export async function resolveLatticeFromPod(
  resourceUrl: string,
  recipientKeyPair: EncryptionKeyPair,
  fetchFn: typeof fetch,
): Promise<{ topUri: IRI; nodes: Map<IRI, Node> } | null> {
  const r = await fetchFn(resourceUrl, { headers: { Accept: 'application/json' } });
  if (!r.ok) return null;
  let envelope: EncryptedEnvelope;
  try { envelope = (await r.json()) as EncryptedEnvelope; } catch { return null; }
  const plaintext = openEncryptedEnvelope(envelope, recipientKeyPair);
  if (plaintext == null) return null;
  try {
    const payload = JSON.parse(plaintext) as EncryptedLatticeSlice;
    return { topUri: payload.topUri, nodes: new Map(Object.entries(payload.nodes)) as Map<IRI, Node> };
  } catch {
    return null;
  }
}

/** Promote a node to tier 3 — pin to IPFS, return CID. */
export async function promoteToIpfs(
  pgsl: PGSLInstance, uri: IRI, ipfsConfig: unknown,
): Promise<PersistenceRecord> {
  const node = pgsl.nodes.get(uri);
  if (!node) throw new Error(`Node not found: ${uri}`);

  const { computeCid, pinToIpfs } = await import('@interego/core');
  const config = ipfsConfig as import('@interego/core').IpfsConfig;
  const content = JSON.stringify(node);
  const cid = computeCid(content);
  const pinResult = await pinToIpfs(content, uri, config);

  return recordPersistence(createPersistenceRegistry(), uri, 3, {
    endpoint: pinResult.url,
    cid: cid.toString(),
    promotedBy: node.provenance.wasAttributedTo,
  });
}

/**
 * Promote a node to tier 4 — anchor content hash to blockchain.
 * Signs the content; does not submit a tx without an RPC endpoint.
 */
export async function promoteToChain(
  pgsl: PGSLInstance, uri: IRI, wallet: unknown, chainConfig: unknown,
): Promise<PersistenceRecord> {
  const node = pgsl.nodes.get(uri);
  if (!node) throw new Error(`Node not found: ${uri}`);

  const { signDescriptor } = await import('@interego/core');
  const w = wallet as import('@interego/core').Wallet;
  const chain = chainConfig as import('@interego/core').ChainConfig;
  const content = JSON.stringify(node);
  const contentHash = createHash('sha256').update(content).digest('hex');
  const signed = await signDescriptor(uri, content, w);

  return recordPersistence(createPersistenceRegistry(), uri, 4, {
    endpoint: chain.blockExplorer ?? `chain:${chain.chainId}`,
    cid: contentHash,
    chainId: chain.chainId,
    signature: signed.signature,
    promotedBy: node.provenance.wasAttributedTo,
  });
}

// ── Resolution ─────────────────────────────────────────────

/**
 * Resolve a URI by trying tiers in descending order (highest trust first).
 * If encrypted and no authorization provided, returns { encrypted: true }.
 */
export function resolve(
  registry: PersistenceRegistry, pgsl: PGSLInstance,
  uri: IRI, authorization?: ResolutionAuthorization,
): ResolutionResult {
  const node = pgsl.nodes.get(uri);
  if (!node) {
    return { uri, tier: 0, endpoint: 'memory', provenance: pgsl.defaultProvenance, verified: false };
  }

  const records = getTierRecords(registry, uri);
  const isEncrypted = !!(node.provenance.encryptedForRecipients?.length);

  if (isEncrypted && !authorization) {
    const best = records.length > 0 ? records[records.length - 1]! : undefined;
    return {
      uri, encrypted: true,
      tier: best?.tier ?? 0,
      endpoint: best?.endpoint ?? 'memory',
      provenance: node.provenance,
      cid: best?.cid,
      verified: !!best?.signature,
    };
  }

  const value = node.kind === 'Atom' ? node.value : pgslResolve(pgsl, uri);

  if (records.length > 0) {
    const best = records[records.length - 1]!;
    return {
      uri, value, tier: best.tier,
      endpoint: best.endpoint ?? TierName[best.tier],
      provenance: node.provenance,
      cid: best.cid ?? node.cid,
      verified: !!best.signature,
    };
  }

  return {
    uri, value, tier: 0, endpoint: 'memory',
    provenance: node.provenance, cid: node.cid,
    verified: !!node.provenance.signature,
  };
}

// ── Batch Operations ───────────────────────────────────────

/** Promote multiple nodes to a target tier. */
export async function promoteBatch(
  pgsl: PGSLInstance, uris: readonly IRI[],
  targetTier: PersistenceTier, options: PromoteBatchOptions,
): Promise<PersistenceRecord[]> {
  const results: PersistenceRecord[] = [];
  for (const uri of uris) {
    switch (targetTier) {
      case 1: {
        if (!options.storagePath) throw new Error('storagePath required for tier 1');
        results.push(await promoteToLocal(pgsl, uri, options.storagePath));
        break;
      }
      case 2: {
        if (!options.podUrl || !options.fetchFn) throw new Error('podUrl and fetchFn required for tier 2');
        results.push(await promoteToPod(pgsl, uri, options.podUrl, options.fetchFn));
        break;
      }
      case 3: {
        if (!options.ipfsConfig) throw new Error('ipfsConfig required for tier 3');
        results.push(await promoteToIpfs(pgsl, uri, options.ipfsConfig));
        break;
      }
      case 4: {
        if (!options.wallet || !options.chainConfig) throw new Error('wallet and chainConfig required for tier 4');
        results.push(await promoteToChain(pgsl, uri, options.wallet, options.chainConfig));
        break;
      }
      default: break;
    }
  }
  return results;
}

// ── Statistics ──────────────────────────────────────────────

/** Persistence statistics: total unique nodes and count per tier. */
export function persistenceStats(
  registry: PersistenceRegistry,
): { total: number; byTier: Record<PersistenceTier, number> } {
  const byTier: Record<PersistenceTier, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const [, records] of registry.records) {
    for (const record of records) byTier[record.tier]++;
  }
  return { total: registry.records.size, byTier };
}

// ── Internal Helpers ───────────────────────────────────────

/** @internal Serialize a PGSL node to minimal Turtle. */
function nodeToTurtle(node: import('./types.js').Node, resolved: string): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  const lines = [
    '@prefix pgsl: <https://contextgraphs.org/ns/pgsl/> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
  ];
  if (node.kind === 'Atom') {
    lines.push(`<${node.uri}> a pgsl:Atom ;`);
    lines.push(`  pgsl:value "${esc(String(node.value))}" ;`);
  } else {
    lines.push(`<${node.uri}> a pgsl:Fragment ;`);
    lines.push(`  pgsl:level ${node.level} ;`);
    lines.push(`  pgsl:resolved "${esc(resolved)}" ;`);
  }
  lines.push(`  pgsl:attributedTo <${node.provenance.wasAttributedTo}> ;`);
  lines.push(`  pgsl:generatedAt "${node.provenance.generatedAtTime}"^^xsd:dateTime .`);
  return lines.join('\n');
}
