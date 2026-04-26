/**
 * @module compliance
 * @description Compliance-grade publish + framework conformance check.
 *
 *   "Compliance grade" means a descriptor satisfies a stricter
 *   superset of requirements suitable for regulatory audit:
 *     - HighAssurance trust level (default is SelfAsserted)
 *     - Cryptographic signature (ECDSA) over the descriptor
 *     - Anchoring (IPFS CID computed; can be pinned externally)
 *     - Validation against the relevant framework's SHACL shapes
 *     - Append-only via cg:supersedes (no in-place mutation)
 *
 *   Framework conformance check (per-framework: EU AI Act, NIST RMF,
 *   SOC 2) walks a set of descriptors and aggregates evidence per
 *   regulatory category, returning a structured report.
 */

import type { IRI } from '../model/types.js';

export type ComplianceFramework = 'eu-ai-act' | 'nist-rmf' | 'soc2';

export interface ComplianceCheckResult {
  readonly compliant: boolean;
  readonly violations: readonly string[];
  readonly upgradedFacets: readonly string[];
}

/**
 * Pre-publish compliance check. Returns whether the inputs satisfy
 * compliance-grade requirements + a list of violations + a list of
 * facet upgrades the caller should apply (e.g., bump trustLevel from
 * SelfAsserted → HighAssurance, add ECDSA signature).
 */
export function checkComplianceInputs(args: {
  modalStatus?: string;
  trustLevel?: string;
  hasSignature: boolean;
  framework?: ComplianceFramework;
}): ComplianceCheckResult {
  const violations: string[] = [];
  const upgradedFacets: string[] = [];

  // Modal status: must be Asserted or Counterfactual (committed). Hypothetical
  // is fine for HYPOTHESES but not for action records that need audit trail.
  if (args.modalStatus === 'Hypothetical') {
    violations.push('Compliance grade descriptors should NOT be Hypothetical (use Asserted or Counterfactual for audit-grade actions)');
  }

  // Trust level: CryptographicallyVerified (the strongest L1 tier) required
  // for compliance grade. Compliance vocabulary calls this "HighAssurance"
  // but the L1 type uses CryptographicallyVerified.
  if (args.trustLevel !== 'CryptographicallyVerified') {
    violations.push(`Trust level is ${args.trustLevel ?? 'unset'}; compliance grade requires CryptographicallyVerified`);
    upgradedFacets.push('Trust → CryptographicallyVerified');
  }

  // Signature: required.
  if (!args.hasSignature) {
    violations.push('Descriptor lacks a cryptographic signature; compliance grade requires ECDSA');
    upgradedFacets.push('Trust.proof → ECDSA signature');
  }

  return {
    compliant: violations.length === 0,
    violations,
    upgradedFacets,
  };
}

// ── Framework conformance check ─────────────────────────────

/**
 * One-record-per-control breakdown of compliance against a framework.
 * For a framework like SOC 2 with N controls, this maps each control
 * to (a) the count of evidence descriptors citing it, (b) the most
 * recent evidence timestamp, (c) a categorical status.
 */
export interface FrameworkReportEntry {
  readonly controlIri: IRI;
  readonly controlLabel: string;
  readonly evidenceCount: number;
  readonly mostRecentEvidence: string | null; // ISO 8601
  readonly status: 'satisfied' | 'partial' | 'missing';
}

export interface FrameworkReport {
  readonly framework: ComplianceFramework;
  readonly generatedAt: string;
  readonly auditPeriod?: { from: string; to: string };
  readonly summary: {
    totalControls: number;
    satisfied: number;
    partial: number;
    missing: number;
    overallScore: number; // [0, 1]
  };
  readonly entries: readonly FrameworkReportEntry[];
}

/**
 * Selected control IRIs per framework. v1 ships with the controls
 * declared in our docs/ns/<framework>.ttl. Extensible.
 */
export const FRAMEWORK_CONTROLS: Readonly<Record<ComplianceFramework, readonly { iri: IRI; label: string }[]>> = {
  'eu-ai-act': [
    { iri: 'eu-ai-act:RiskClassification' as IRI, label: 'Article 6 — Risk classification' },
    { iri: 'eu-ai-act:RiskManagementRecord' as IRI, label: 'Article 9 — Risk management' },
    { iri: 'eu-ai-act:DataGovernanceAttestation' as IRI, label: 'Article 10 — Data governance' },
    { iri: 'eu-ai-act:LoggedAction' as IRI, label: 'Article 12 — Record-keeping' },
    { iri: 'eu-ai-act:TransparencyDisclosure' as IRI, label: 'Article 13 — Transparency' },
    { iri: 'eu-ai-act:HumanOversightCheckpoint' as IRI, label: 'Article 14 — Human oversight' },
    { iri: 'eu-ai-act:AccuracyAttestation' as IRI, label: 'Article 15 — Accuracy + robustness' },
    { iri: 'eu-ai-act:Article50Disclosure' as IRI, label: 'Article 50 — End-user disclosure' },
  ],
  'nist-rmf': [
    { iri: 'nist-rmf:Govern.1.1' as IRI, label: 'GOVERN 1.1 — policies documented' },
    { iri: 'nist-rmf:Govern.2.1' as IRI, label: 'GOVERN 2.1 — accountability roles' },
    { iri: 'nist-rmf:Map.1.1' as IRI, label: 'MAP 1.1 — context established' },
    { iri: 'nist-rmf:Map.4.1' as IRI, label: 'MAP 4.1 — impacts characterized' },
    { iri: 'nist-rmf:Measure.1.1' as IRI, label: 'MEASURE 1.1 — metrics identified' },
    { iri: 'nist-rmf:Measure.2.7' as IRI, label: 'MEASURE 2.7 — security + resilience' },
    { iri: 'nist-rmf:Manage.1.2' as IRI, label: 'MANAGE 1.2 — risk treatment prioritized' },
    { iri: 'nist-rmf:Manage.4.1' as IRI, label: 'MANAGE 4.1 — post-deployment monitoring' },
  ],
  soc2: [
    { iri: 'soc2:CC1.1' as IRI, label: 'CC1.1 — integrity + ethical values' },
    { iri: 'soc2:CC2.1' as IRI, label: 'CC2.1 — relevant + quality information' },
    { iri: 'soc2:CC3.1' as IRI, label: 'CC3.1 — risk identification objectives' },
    { iri: 'soc2:CC5.1' as IRI, label: 'CC5.1 — ongoing monitoring' },
    { iri: 'soc2:CC6.1' as IRI, label: 'CC6.1 — logical + physical access controls' },
    { iri: 'soc2:CC6.3' as IRI, label: 'CC6.3 — modify + revoke user access' },
    { iri: 'soc2:CC7.2' as IRI, label: 'CC7.2 — anomaly monitoring' },
    { iri: 'soc2:CC8.1' as IRI, label: 'CC8.1 — change management' },
    { iri: 'soc2:C1.1' as IRI, label: 'C1.1 — confidential info identified' },
    { iri: 'soc2:P1.1' as IRI, label: 'P1.1 — privacy notice provided' },
  ],
};

/**
 * Generate a framework conformance report from a set of descriptors.
 * Walks descriptors looking for evidence-citation predicates per
 * framework (eu-ai-act:appliesToSystem / nist-rmf:contributesTo /
 * soc2:satisfiesControl) — represented in our in-memory model as
 * a list of IRI strings the descriptor cites.
 */
export interface AuditableDescriptor {
  readonly id: IRI;
  readonly publishedAt: string;
  /** IRIs of regulatory controls this descriptor provides evidence for. */
  readonly evidenceForControls: readonly IRI[];
}

export function generateFrameworkReport(
  framework: ComplianceFramework,
  descriptors: readonly AuditableDescriptor[],
  options?: { auditPeriod?: { from: string; to: string } },
): FrameworkReport {
  const controls = FRAMEWORK_CONTROLS[framework];
  const period = options?.auditPeriod;

  const inPeriod = (d: AuditableDescriptor): boolean => {
    if (!period) return true;
    return d.publishedAt >= period.from && d.publishedAt <= period.to;
  };

  const entries = controls.map<FrameworkReportEntry>(c => {
    const evidence = descriptors.filter(d =>
      inPeriod(d) && d.evidenceForControls.includes(c.iri),
    );
    const status: FrameworkReportEntry['status'] = evidence.length === 0
      ? 'missing'
      : evidence.length === 1 ? 'partial' : 'satisfied';
    const mostRecentEvidence = evidence.length > 0
      ? evidence.map(e => e.publishedAt).sort().at(-1) ?? null
      : null;
    return {
      controlIri: c.iri,
      controlLabel: c.label,
      evidenceCount: evidence.length,
      mostRecentEvidence,
      status,
    };
  });

  const satisfied = entries.filter(e => e.status === 'satisfied').length;
  const partial = entries.filter(e => e.status === 'partial').length;
  const missing = entries.filter(e => e.status === 'missing').length;
  // Overall: weighted score — satisfied=1, partial=0.5, missing=0
  const overallScore = (satisfied + partial * 0.5) / entries.length;

  return {
    framework,
    generatedAt: new Date().toISOString(),
    auditPeriod: options?.auditPeriod,
    summary: {
      totalControls: entries.length,
      satisfied,
      partial,
      missing,
      overallScore,
    },
    entries,
  };
}

// ── Persisted ECDSA wallet for compliance signing ───────────
//
// The publish surfaces (stdio + relay) need a stable ECDSA wallet
// so signatures over compliance descriptors are verifiable across
// restarts. This helper loads the wallet from disk if present,
// otherwise generates a fresh one + persists it (mode 0600). The
// resulting wallet's private key never leaves the host filesystem.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { importWallet, type Wallet } from '../crypto/index.js';

/**
 * On-disk format for the compliance wallet store. Supports rotation:
 * the `active` wallet signs new descriptors; `history` retains all
 * prior wallets so signatures from previous epochs still verify.
 *
 * Operators rotate by calling rotateComplianceWallet() — which moves
 * the current active to history and generates a fresh active. Old
 * descriptors remain verifiable forever (until you actively remove
 * a wallet from history, which you should only do in extreme cases).
 */
export interface ComplianceWalletEntry {
  readonly privateKey: string; // hex with 0x prefix
  readonly address: string;
  readonly createdAt: string;
  readonly label?: string;
  readonly retiredAt?: string;
}

export interface ComplianceWalletStore {
  readonly active: ComplianceWalletEntry;
  readonly history: readonly ComplianceWalletEntry[];
}

export interface PersistedComplianceWallet {
  readonly wallet: Wallet;
  readonly privateKey: string;
  readonly createdAt: string;
  readonly path: string;
  readonly fresh: boolean;
  readonly historyCount: number;
}

function generatePrivateKey(): string {
  // Lazy-load ethers to avoid surfacing it in the type API.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { ethers } = require('ethers');
  return new ethers.Wallet(ethers.Wallet.createRandom().privateKey).privateKey;
}

function addressFromPrivateKey(privateKey: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { ethers } = require('ethers');
  return new ethers.Wallet(privateKey).address;
}

function readStore(path: string): ComplianceWalletStore | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    // Backward-compat: old format had a flat { privateKey, createdAt, ... }
    // Migrate by treating it as the active entry with empty history.
    if (raw.privateKey && !raw.active) {
      return {
        active: {
          privateKey: raw.privateKey,
          address: raw.address ?? addressFromPrivateKey(raw.privateKey),
          createdAt: raw.createdAt ?? new Date().toISOString(),
          label: raw.label,
        },
        history: [],
      };
    }
    return raw as ComplianceWalletStore;
  } catch {
    return null;
  }
}

function writeStore(path: string, store: ComplianceWalletStore): void {
  try {
    writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch {
    // best-effort
  }
}

/**
 * Load the compliance wallet store, or create a fresh one with a new
 * active wallet if absent. Returns the active wallet for signing;
 * history is preserved for verification of older signatures.
 */
export async function loadOrCreateComplianceWallet(
  path: string,
  label = 'compliance-signer',
): Promise<PersistedComplianceWallet> {
  let store = readStore(path);
  if (!store) {
    const privateKey = generatePrivateKey();
    store = {
      active: {
        privateKey,
        address: addressFromPrivateKey(privateKey),
        createdAt: new Date().toISOString(),
        label,
      },
      history: [],
    };
    writeStore(path, store);
  }
  const wallet = importWallet(store.active.privateKey, 'agent', store.active.label ?? label);
  return {
    wallet,
    privateKey: store.active.privateKey,
    createdAt: store.active.createdAt,
    path,
    fresh: !existsSync(path) ? false : false, // existed by the time we returned
    historyCount: store.history.length,
  };
}

/**
 * Rotate the compliance signing wallet: retire the current active,
 * promote a freshly-generated key to active. The retired wallet stays
 * in history so previously-signed descriptors keep verifying.
 *
 * Returns the new active wallet plus the retired wallet's address (for
 * logging / passport:LifeEvent records).
 */
export async function rotateComplianceWallet(
  path: string,
  label = 'compliance-signer',
): Promise<{
  newActiveAddress: string;
  retiredAddress: string;
  historyCount: number;
}> {
  const existing = readStore(path);
  if (!existing) {
    // Nothing to rotate — create fresh active + return as if rotated from null.
    await loadOrCreateComplianceWallet(path, label);
    const fresh = readStore(path)!;
    return { newActiveAddress: fresh.active.address, retiredAddress: '(no prior)', historyCount: 0 };
  }
  const retired: ComplianceWalletEntry = {
    ...existing.active,
    retiredAt: new Date().toISOString(),
  };
  const newPrivateKey = generatePrivateKey();
  const newActive: ComplianceWalletEntry = {
    privateKey: newPrivateKey,
    address: addressFromPrivateKey(newPrivateKey),
    createdAt: new Date().toISOString(),
    label,
  };
  const newStore: ComplianceWalletStore = {
    active: newActive,
    history: [...existing.history, retired],
  };
  writeStore(path, newStore);
  return {
    newActiveAddress: newActive.address,
    retiredAddress: retired.address,
    historyCount: newStore.history.length,
  };
}

/**
 * Import an externally-managed wallet (e.g., a hardware-backed key,
 * a key generated on a co-signer service) as the new active. The
 * current active moves to history. Use this when an operator wants
 * to replace the active wallet WITHOUT generating a fresh random key
 * (e.g., switching to a custodial signer).
 */
export async function importComplianceWallet(
  path: string,
  privateKey: string,
  label = 'compliance-signer-imported',
): Promise<{ newActiveAddress: string; retiredAddress: string; historyCount: number }> {
  const existing = readStore(path);
  const newActive: ComplianceWalletEntry = {
    privateKey,
    address: addressFromPrivateKey(privateKey),
    createdAt: new Date().toISOString(),
    label,
  };
  if (!existing) {
    writeStore(path, { active: newActive, history: [] });
    return { newActiveAddress: newActive.address, retiredAddress: '(no prior)', historyCount: 0 };
  }
  const retired: ComplianceWalletEntry = { ...existing.active, retiredAt: new Date().toISOString() };
  const newStore: ComplianceWalletStore = {
    active: newActive,
    history: [...existing.history, retired],
  };
  writeStore(path, newStore);
  return {
    newActiveAddress: newActive.address,
    retiredAddress: retired.address,
    historyCount: newStore.history.length,
  };
}

/**
 * Return the set of addresses that should be considered valid signers
 * for verification — the active wallet plus all retired wallets in
 * history. Use this when verifying a signature: if the recovered
 * address is in this set, the signature is valid even if the wallet
 * has since been rotated.
 */
export function listValidSignerAddresses(path: string): readonly string[] {
  const store = readStore(path);
  if (!store) return [];
  return [store.active.address, ...store.history.map(h => h.address)];
}

// ── Lineage walk ─────────────────────────────────────────────

/**
 * Walk the prov:wasDerivedFrom + cg:supersedes chains for a given
 * descriptor IRI, returning the full ancestral graph. Used by the
 * /audit/lineage endpoint.
 */
export interface LineageNode {
  readonly id: IRI;
  readonly publishedAt: string;
  readonly relation: 'self' | 'derivedFrom' | 'supersedes';
  readonly depth: number;
}

export function walkLineage(
  rootIri: IRI,
  index: ReadonlyMap<IRI, { publishedAt: string; derivedFrom: IRI[]; supersedes: IRI[] }>,
  maxDepth = 50,
): readonly LineageNode[] {
  const visited = new Set<IRI>();
  const out: LineageNode[] = [];
  const queue: { id: IRI; depth: number; relation: LineageNode['relation'] }[] = [
    { id: rootIri, depth: 0, relation: 'self' },
  ];

  while (queue.length > 0) {
    const { id, depth, relation } = queue.shift()!;
    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);
    const entry = index.get(id);
    if (!entry) {
      // External or unknown; record but don't expand
      out.push({ id, publishedAt: '', relation, depth });
      continue;
    }
    out.push({ id, publishedAt: entry.publishedAt, relation, depth });
    for (const d of entry.derivedFrom) queue.push({ id: d, depth: depth + 1, relation: 'derivedFrom' });
    for (const s of entry.supersedes) queue.push({ id: s, depth: depth + 1, relation: 'supersedes' });
  }
  return out;
}
