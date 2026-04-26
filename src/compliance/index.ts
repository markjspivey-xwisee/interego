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
import { createWallet, importWallet, type Wallet } from '../crypto/index.js';

export interface PersistedComplianceWallet {
  readonly wallet: Wallet;
  readonly privateKey: string; // hex with 0x prefix
  readonly createdAt: string;
  readonly path: string;
  readonly fresh: boolean; // true if just generated this session
}

/**
 * Load an ECDSA wallet from a JSON file, or create + persist one if
 * absent. Used by stdio mcp-server + relay to obtain a stable signer
 * for compliance-grade descriptors.
 */
export async function loadOrCreateComplianceWallet(
  path: string,
  label = 'compliance-signer',
): Promise<PersistedComplianceWallet> {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        privateKey: string;
        createdAt: string;
        label?: string;
      };
      const wallet = importWallet(parsed.privateKey, 'agent', parsed.label ?? label);
      return {
        wallet,
        privateKey: parsed.privateKey,
        createdAt: parsed.createdAt,
        path,
        fresh: false,
      };
    } catch {
      // Corrupt file — overwrite below.
    }
  }
  const wallet = await createWallet('agent', label);
  // Re-derive the underlying ethers wallet to extract the private key.
  // (createWallet stores the signing wallet keyed by address; we need
  //  the raw private key to persist it for restart-survivability.)
  const { ethers } = await import('ethers');
  const ethersWallet = new ethers.Wallet(
    // We can't get the priv key from the createWallet API without
    // touching ethers directly — generate the key OURSELVES then
    // import, so we control persistence.
    ethers.Wallet.createRandom().privateKey,
  );
  const persisted = importWallet(ethersWallet.privateKey, 'agent', label);
  const record = {
    privateKey: ethersWallet.privateKey,
    createdAt: new Date().toISOString(),
    label,
    address: ethersWallet.address,
  };
  try {
    writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch {
    // best-effort; in environments where filesystem writes fail
    // (read-only mounts, container ephemeral disks), the wallet
    // is regenerated each restart — caller should warn.
  }
  // Suppress unused-var: we use `wallet` for type inference but
  // re-derive a persistable one just above. Return the persistable.
  void wallet;
  return {
    wallet: persisted,
    privateKey: ethersWallet.privateKey,
    createdAt: record.createdAt,
    path,
    fresh: true,
  };
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
