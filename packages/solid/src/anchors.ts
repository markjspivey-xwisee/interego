/**
 * @module solid/anchors
 * @description Zero-copy anchor receipts for Interego.
 *
 * Architecture:
 *   Physical layer:  IPFS pin, CSS pod resource, PGSL atom, wallet key
 *   Anchor layer:    CID, content hash, signature, encryption metadata
 *   Semantic layer:  Context Descriptor (facets over references)
 *   Virtual layer:   discover_all, composition, lattice meet
 *
 * Every operation writes a zero-copy anchor receipt to the pod.
 * The receipt doesn't contain the data — it's a pointer + cryptographic proof
 * that the operation happened, when, by whom.
 *
 * Anchor types:
 *   - IpfsAnchorReceipt:      CID + gateway URL + pinnedBy
 *   - SignatureAnchorReceipt:  signer + content hash + signature
 *   - EncryptionAnchorReceipt: algorithm + recipient count + key fingerprints
 *   - PgslAnchorReceipt:      lattice root + atom count + fragment URI
 *   - ActivityAnchorReceipt:   tool name + agent + timestamp + outcome
 *
 * All receipts are RDF Turtle, stored at:
 *   {pod}/anchors/{descriptorSlug}.ttl
 */

import type { IRI } from '@interego/core';
import type { FetchFn } from './types.js';
import { turtlePrefixes } from '@interego/core';

// ── Types ────────────────────────────────────────────────────

export interface IpfsAnchorReceipt {
  readonly type: 'ipfs';
  readonly descriptorUrl: string;
  readonly cid: string;
  readonly gatewayUrl: string;
  readonly contentHash: string;
  readonly pinnedBy: IRI;
  readonly pinnedAt: string;
  readonly provider: string;
}

export interface SignatureAnchorReceipt {
  readonly type: 'signature';
  readonly descriptorUrl: string;
  readonly signerAddress: string;
  readonly contentHash: string;
  readonly signature: string;
  readonly signedAt: string;
  readonly chainId: number;
}

export interface EncryptionAnchorReceipt {
  readonly type: 'encryption';
  readonly descriptorUrl: string;
  readonly algorithm: string;
  readonly recipientCount: number;
  readonly recipientFingerprints: readonly string[];
  readonly encryptedAt: string;
}

export interface PgslAnchorReceipt {
  readonly type: 'pgsl';
  readonly descriptorUrl: string;
  readonly latticeRoot: string;
  readonly atomCount: number;
  readonly fragmentCount: number;
  readonly topFragmentUri: string;
  readonly ingestedAt: string;
}

export interface ActivityAnchorReceipt {
  readonly type: 'activity';
  readonly tool: string;
  readonly agent: IRI;
  readonly target: string;
  readonly outcome: 'success' | 'failure';
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
}

export type AnchorReceipt =
  | IpfsAnchorReceipt
  | SignatureAnchorReceipt
  | EncryptionAnchorReceipt
  | PgslAnchorReceipt
  | ActivityAnchorReceipt;

// ── Serialization ────────────────────────────────────────────

function anchorToTurtle(receipt: AnchorReceipt): string {
  const lines: string[] = [];

  switch (receipt.type) {
    case 'ipfs':
      lines.push(`<${receipt.descriptorUrl}> iep:ipfsAnchor [`);
      lines.push(`    a iep:IpfsAnchor ;`);
      lines.push(`    iep:cid "${receipt.cid}" ;`);
      lines.push(`    iep:gatewayUrl <${receipt.gatewayUrl}> ;`);
      lines.push(`    iep:contentHash "${receipt.contentHash}" ;`);
      lines.push(`    iep:pinnedBy <${receipt.pinnedBy}> ;`);
      lines.push(`    iep:pinnedAt "${receipt.pinnedAt}"^^xsd:dateTime ;`);
      lines.push(`    iep:provider "${receipt.provider}"`);
      lines.push(`] .`);
      break;

    case 'signature':
      lines.push(`<${receipt.descriptorUrl}> iep:signatureAnchor [`);
      lines.push(`    a iep:SignatureAnchor ;`);
      lines.push(`    iep:signerAddress "${receipt.signerAddress}" ;`);
      lines.push(`    iep:contentHash "${receipt.contentHash}" ;`);
      lines.push(`    iep:signature "${receipt.signature}" ;`);
      lines.push(`    iep:signedAt "${receipt.signedAt}"^^xsd:dateTime ;`);
      lines.push(`    iep:chainId "${receipt.chainId}"^^xsd:integer`);
      lines.push(`] .`);
      break;

    case 'encryption':
      lines.push(`<${receipt.descriptorUrl}> iep:encryptionAnchor [`);
      lines.push(`    a iep:EncryptionAnchor ;`);
      lines.push(`    iep:algorithm "${receipt.algorithm}" ;`);
      lines.push(`    iep:recipientCount "${receipt.recipientCount}"^^xsd:integer ;`);
      for (const fp of receipt.recipientFingerprints) {
        lines.push(`    iep:recipientFingerprint "${fp}" ;`);
      }
      lines.push(`    iep:encryptedAt "${receipt.encryptedAt}"^^xsd:dateTime`);
      lines.push(`] .`);
      break;

    case 'pgsl':
      lines.push(`<${receipt.descriptorUrl}> iep:pgslAnchor [`);
      lines.push(`    a iep:PgslAnchor ;`);
      lines.push(`    iep:latticeRoot "${receipt.latticeRoot}" ;`);
      lines.push(`    iep:atomCount "${receipt.atomCount}"^^xsd:integer ;`);
      lines.push(`    iep:fragmentCount "${receipt.fragmentCount}"^^xsd:integer ;`);
      lines.push(`    iep:topFragment <${receipt.topFragmentUri}> ;`);
      lines.push(`    iep:ingestedAt "${receipt.ingestedAt}"^^xsd:dateTime`);
      lines.push(`] .`);
      break;

    case 'activity':
      lines.push(`<${receipt.target}> iep:activityAnchor [`);
      lines.push(`    a iep:ActivityAnchor ;`);
      lines.push(`    iep:tool "${receipt.tool}" ;`);
      lines.push(`    iep:agent <${receipt.agent}> ;`);
      lines.push(`    iep:outcome "${receipt.outcome}" ;`);
      lines.push(`    iep:timestamp "${receipt.timestamp}"^^xsd:dateTime`);
      if (receipt.metadata) {
        for (const [key, value] of Object.entries(receipt.metadata)) {
          if (typeof value === 'string') {
            lines.push(`    ; iep:${key} "${value}"`);
          }
        }
      }
      lines.push(`] .`);
      break;
  }

  return lines.join('\n');
}

// ── Writing anchors to pods ──────────────────────────────────

const ANCHORS_CONTAINER = 'anchors/';

/**
 * Write an anchor receipt to the pod.
 * Stored at {pod}/anchors/{slug}.ttl — appended if the file exists.
 */
export async function writeAnchor(
  receipt: AnchorReceipt,
  podUrl: string,
  options: { fetch?: FetchFn } = {},
): Promise<string> {
  const fetchFn = options.fetch ?? defaultFetch();
  const pod = podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
  const containerUrl = `${pod}${ANCHORS_CONTAINER}`;

  // Ensure anchors container exists
  await fetchFn(containerUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });

  // Determine slug from the receipt
  const slug = receiptSlug(receipt);
  const anchorUrl = `${containerUrl}${slug}.ttl`;
  const turtle = anchorToTurtle(receipt);

  // Append or create
  const existing = await fetchFn(anchorUrl, {
    method: 'GET',
    headers: { 'Accept': 'text/turtle' },
  });

  let body: string;
  if (existing.ok) {
    const existingContent = await existing.text();
    body = `${existingContent.trimEnd()}\n\n${turtle}\n`;
  } else {
    body = `${turtlePrefixes(['iep', 'xsd', 'prov'])}\n\n${turtle}\n`;
  }

  await fetchFn(anchorUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body,
  });

  return anchorUrl;
}

/**
 * Write multiple anchor receipts in one batch.
 */
export async function writeAnchors(
  receipts: readonly AnchorReceipt[],
  podUrl: string,
  options: { fetch?: FetchFn } = {},
): Promise<string[]> {
  const urls: string[] = [];
  for (const receipt of receipts) {
    const url = await writeAnchor(receipt, podUrl, options);
    urls.push(url);
  }
  return urls;
}

/**
 * Read all anchors for a specific descriptor from the pod.
 */
export async function readAnchors(
  descriptorUrl: string,
  podUrl: string,
  options: { fetch?: FetchFn } = {},
): Promise<string | null> {
  const fetchFn = options.fetch ?? defaultFetch();
  const pod = podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
  const slug = urlToSlug(descriptorUrl);
  const anchorUrl = `${pod}${ANCHORS_CONTAINER}${slug}.ttl`;

  const resp = await fetchFn(anchorUrl, {
    method: 'GET',
    headers: { 'Accept': 'text/turtle' },
  });

  if (!resp.ok) return null;
  return resp.text();
}

// ── Helpers ──────────────────────────────────────────────────

function receiptSlug(receipt: AnchorReceipt): string {
  switch (receipt.type) {
    case 'ipfs':
    case 'signature':
    case 'encryption':
    case 'pgsl':
      return urlToSlug(receipt.descriptorUrl);
    case 'activity':
      return `activity-${Date.now()}`;
  }
}

function urlToSlug(url: string): string {
  return url.replace(/[^a-zA-Z0-9]/g, '-').slice(-60);
}

function defaultFetch(): FetchFn {
  return async (url, init) => {
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
}
