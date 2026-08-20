/**
 * @module compliance
 * @description Compliance-grade publish + framework conformance check.
 *
 *   "Compliance grade" means a descriptor satisfies a stricter
 *   superset of requirements suitable for regulatory audit:
 *     - CryptographicallyVerified trust level (default is SelfAsserted).
 *       Compliance PROSE calls this tier "HighAssurance"; the L1 type and
 *       the published SHACL shape do not have that value, so it is not
 *       written anywhere. See checkComplianceInputs below, and the note on
 *       TrustLevel in packages/core/src/model/types.ts.
 *     - Cryptographic signature (ECDSA) over the descriptor
 *     - Anchoring (IPFS CID computed; can be pinned externally)
 *     - Validation against the relevant framework's SHACL shapes
 *     - Append-only via iep:supersedes (no in-place mutation)
 *
 *   Framework conformance check (per-framework: EU AI Act, NIST RMF,
 *   SOC 2) walks a set of descriptors and aggregates evidence per
 *   regulatory category, returning a structured report.
 */

import { existsSync as nsExists, readFileSync as nsRead } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
// The scope is PUBLISHED DATA parsed at runtime — see FRAMEWORK_CONTROLS for what this replaced.
import { parseTrig, findSubjectsOfType, readStringValue } from '@interego/core';
import type { IRI, ParsedSubject } from '@interego/core';

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
 * SelfAsserted → CryptographicallyVerified, add ECDSA signature).
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
  /**
   * WHERE THE DENOMINATOR CAME FROM. 'published' means the scope was read from the framework's
   * iep:ControlSet and `scopeIri` dereferences to it; 'fallback' means docs/ns was unreachable and
   * the frozen array was used. A percentage whose denominator a reader cannot locate is the defect
   * this replaced, so the provenance travels WITH the number rather than being assumed.
   */
  readonly scopeSource: 'published' | 'fallback';
  readonly scopeIri?: string;
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
 * ── ★★★ THE SCOPE IS PUBLISHED DATA NOW; THIS ARRAY IS A FALLBACK THAT MUST NOT BE REACHED ──
 *
 * The docblock here used to read "v1 ships with the controls declared in our
 * docs/ns/<framework>.ttl", and that sentence had quietly become false:
 *
 *     soc2      16 listed here     25 declared in docs/ns/soc2.ttl
 *     nist-rmf   8 listed here     10 declared in docs/ns/nist-rmf.ttl
 *
 * `generateFrameworkReport` divides by `entries.length`, so a SOC 2 report reading 100% meant
 * 16 of 16 against a scope no reader could see, with nine controls silently excluded and nothing
 * naming which. A compliance number whose denominator is invisible is not a compliance number.
 *
 * ★ AND THE PROJECT'S OWN EVIDENCE DID NOT MATCH ITS OWN SCORER. `integrations/compliance-overlay`
 * cites `eu-ai-act:Article12` — exactly as that term's published comment instructs ("used as a
 * dct:conformsTo control target in compliance evidence; realized structurally by
 * eu-ai-act:LoggedAction") — while this scorer keyed on `LoggedAction` and counted the citation as
 * nothing. The bridge read what was published; the engine did not.
 *
 * The scope now lives in each framework's ontology as an `iep:ControlSet`, is parsed at runtime,
 * and `rdfs:seeAlso` aliases resolve so either spelling of a control satisfies it. Widening the
 * scope is an edit to a graph. See `loadControlSet` below and the exemplar in
 * `applications/foxxi-content-intelligence/src/ler-tla-vocab.ts`.
 *
 * ★ THIS ARRAY REMAINS ONLY AS A LAST-RESORT FALLBACK for an embedding that cannot reach docs/ns,
 * and every report says which source it used (`scopeSource`). It is deliberately NOT the silent
 * default: a hidden fallback would recreate the exact defect — a scope in force that nobody can
 * see — and the report makes the degradation visible instead.
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
    { iri: 'soc2:CC6.2' as IRI, label: 'CC6.2 — registers + authorizes new users' },
    { iri: 'soc2:CC6.3' as IRI, label: 'CC6.3 — modify + revoke user access' },
    { iri: 'soc2:CC6.7' as IRI, label: 'CC6.7 — restricts info transmission + storage' },
    { iri: 'soc2:CC7.2' as IRI, label: 'CC7.2 — anomaly monitoring' },
    { iri: 'soc2:CC7.3' as IRI, label: 'CC7.3 — security event evaluation' },
    { iri: 'soc2:CC7.4' as IRI, label: 'CC7.4 — response to incidents' },
    { iri: 'soc2:CC7.5' as IRI, label: 'CC7.5 — recovery from incidents' },
    { iri: 'soc2:CC8.1' as IRI, label: 'CC8.1 — change management' },
    { iri: 'soc2:CC9.2' as IRI, label: 'CC9.2 — vendor + business partner risk' },
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

/** One control in scope: its canonical IRI, its label, and every spelling that satisfies it. */
export interface ScopedControl {
  readonly iri: IRI;
  readonly label: string;
  /** Canonical IRI, its CURIE, and any rdfs:seeAlso alias — all forms and both spellings. */
  readonly aliases: ReadonlySet<string>;
}

export interface ControlSet {
  readonly controls: readonly ScopedControl[];
  /** 'published' when the scope came from the ontology; 'fallback' when docs/ns was unreachable. */
  readonly scopeSource: 'published' | 'fallback';
  /** The dereferenceable IRI of the iep:ControlSet this scope came from, when published. */
  readonly scopeIri?: string;
}

const NS_BASE = 'https://markjspivey-xwisee.github.io/interego/ns/';
const IEP = `${NS_BASE}iep#`;

/**
 * Where the published ontologies live.
 *
 * ★★ THE WALK ALONE DOES NOT SURVIVE PACKAGING, AND THAT WOULD HAVE MADE THIS WHOLE CHANGE A
 * NO-OP IN PRODUCTION.
 *
 * Reading the roster from `docs/ns` is only an improvement where `docs/ns` is reachable. The relay
 * — the one deployed service that scores these reports — installs this package from a TARBALL into
 * `/app/node_modules/@interego/compliance`, and its image ships no `docs/ns` at all. Every walk
 * from there terminates at `/`, so `loadControlSet` would have selected the frozen array on the
 * live relay while every local test proved the published one. Green here, wrong there: the failure
 * mode this project keeps rediscovering, and one no amount of local verification detects.
 *
 * `INTEREGO_NS_DIR` makes the location an explicit deployment fact instead of a property of where
 * npm happened to put a directory. The walk stays as the development-tree convenience it always
 * was. Whichever wins, `scopeSource` on the report says which — a fallback is never silent.
 */
function resolveNsDir(): string | undefined {
  const configured = process.env['INTEREGO_NS_DIR']?.trim();
  if (configured) return nsExists(configured) ? configured : undefined;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = joinPath(dir, 'docs', 'ns');
    if (nsExists(candidate)) return candidate;
    const parent = joinPath(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const _scopeCache = new Map<string, ControlSet>();

/**
 * The controls a report scores against, READ FROM THE PUBLISHED ONTOLOGY.
 *
 * Membership comes from the framework's `iep:ControlSet` (`iep:control` members) rather than from
 * `rdf:type`, because the three ontologies model controls differently and inferring would be the
 * engine guessing at somebody else's modelling — see the ControlSet term's own comment.
 *
 * Falls back to the frozen array ONLY when docs/ns cannot be reached, and says so in the report via
 * `scopeSource`, because a silent fallback is the defect this replaces.
 */
export function loadControlSet(framework: ComplianceFramework): ControlSet {
  const cached = _scopeCache.get(framework);
  if (cached) return cached;
  const ns = resolveNsDir();
  const file = ns ? joinPath(ns, `${framework}.ttl`) : undefined;
  let set: ControlSet | undefined;
  if (file && nsExists(file)) {
    try { set = parseControlSet(nsRead(file, 'utf8'), framework); } catch { set = undefined; }
  }
  if (!set || set.controls.length === 0) {
    /**
     * ★★ A NARROWER SCOPE IS A DEGRADED ANSWER; A DIFFERENT SPELLING IS A WRONG ONE.
     *
     * This built `aliases: new Set([String(c.iri)])` — the one frozen CURIE, and nothing else. So
     * the fallback did not merely score fewer controls: it stopped matching the evidence the rest
     * of the system emits. `loadControlSet` returns ABSOLUTE IRIs on the published path, and
     * `integrations/compliance-overlay` mirrors exactly those into `dct:conformsTo`; against a
     * CURIE-only alias set, every one of those citations scores `missing`. A deployment that fell
     * back would have reported not "16 of 16 known" but "0 of 16 satisfied" — a confident,
     * plausible, and entirely wrong compliance verdict, from the path that exists to degrade
     * safely.
     *
     * Both spellings are therefore carried here, and the canonical IRI is the dereferenceable one,
     * so the two paths differ only in WHICH controls are in scope — never in what counts as
     * evidence for one. The published aliases (article forms, NIST short codes) genuinely cannot
     * be known without the ontology; that loss is real, and it is what `scopeSource` reports.
     */
    set = {
      controls: FRAMEWORK_CONTROLS[framework].map(c => {
        const curieForm = String(c.iri);
        const local = curieForm.startsWith(`${framework}:`) ? curieForm.slice(framework.length + 1) : undefined;
        const absolute = local ? `${NS_BASE}${framework}#${local}` : curieForm;
        return {
          iri: absolute as IRI,
          label: c.label,
          aliases: new Set<string>([absolute, curieForm]),
        };
      }),
      scopeSource: 'fallback',
    };
  }
  _scopeCache.set(framework, set);
  return set;
}

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label' as IRI;
const RDFS_SEE_ALSO = 'http://www.w3.org/2000/01/rdf-schema#seeAlso' as IRI;

/** Every IRI object of `predicate` — the parser ships the singular; a set needs all of them. */
function iriValues(subject: ParsedSubject, predicate: IRI): readonly IRI[] {
  const out: IRI[] = [];
  for (const term of subject.properties.get(predicate) ?? []) {
    if (term.kind === 'iri') out.push(term.iri);
  }
  return out;
}

/** A named subject's IRI, or undefined for a blank node. */
function subjectIri(s: ParsedSubject): IRI | undefined {
  return typeof s.subject === 'string' ? s.subject : undefined;
}

/** Parse an `iep:ControlSet` and its members out of a framework ontology. Exported for testing. */
export function parseControlSet(turtle: string, framework: string): ControlSet {
  const doc = parseTrig(turtle);
  const base = `${NS_BASE}${framework}#`;
  const curie = (iri: string): string => (iri.startsWith(base) ? `${framework}:${iri.slice(base.length)}` : iri);
  const scopeNode = findSubjectsOfType(doc, `${IEP}ControlSet` as IRI)[0];
  /**
   * ★ AN ABSENT SCOPE IS NOT AN EMPTY PUBLISHED ONE.
   *
   * This returned `{ controls: [], scopeSource: 'published' }` — a roster of nothing, labelled as
   * though the framework had published it. `loadControlSet` happens to catch that via its
   * `controls.length === 0` guard, so the live path degrades correctly; but this function is
   * exported, and any other caller would have received a scope claiming publication for a document
   * that published none. Scored directly, an empty roster yields `0/0` — `overallScore: NaN` with
   * `missing: 0`, which reads as "nothing outstanding" precisely when the scope failed to load.
   *
   * Throwing keeps the live behaviour identical (the caller's try/catch already selects the visible
   * `fallback`) while making the mislabelled value unreachable.
   */
  if (!scopeNode) {
    throw new Error(
      `${framework}.ttl declares no iep:ControlSet — there is no published scope to score against. ` +
      `Refusing to return an empty roster as a published one; the caller falls back to the frozen ` +
      `array and reports scopeSource: "fallback" so the degradation is visible in the report.`,
    );
  }

  // rdfs:seeAlso runs alias -> canonical, so index it once rather than rescanning per control.
  const aliasesOf = new Map<string, string[]>();
  for (const s of doc.subjects) {
    const from = subjectIri(s);
    if (!from) continue;
    for (const to of iriValues(s, RDFS_SEE_ALSO)) {
      const list = aliasesOf.get(String(to)) ?? [];
      list.push(String(from));
      aliasesOf.set(String(to), list);
    }
  }
  const byIri = new Map<string, ParsedSubject>();
  for (const s of doc.subjects) {
    const id = subjectIri(s);
    if (id) byIri.set(String(id), s);
  }

  const controls: ScopedControl[] = [];
  for (const iri of iriValues(scopeNode, `${IEP}control` as IRI)) {
    const subj = byIri.get(String(iri));
    const label = (subj ? readStringValue(subj, RDFS_LABEL) : undefined) ?? curie(String(iri));
    // Every published spelling of this ONE control: canonical, its CURIE, and any node that points
    // at it with rdfs:seeAlso — the article-form aliases the ontologies instruct evidence to cite.
    const aliases = new Set<string>([String(iri), curie(String(iri))]);
    for (const alias of aliasesOf.get(String(iri)) ?? []) {
      aliases.add(alias);
      aliases.add(curie(alias));
    }
    controls.push({ iri: iri as IRI, label, aliases });
  }
  const scopeIri = subjectIri(scopeNode);
  return { controls, scopeSource: 'published', ...(scopeIri ? { scopeIri: String(scopeIri) } : {}) };
}

export function generateFrameworkReport(
  framework: ComplianceFramework,
  descriptors: readonly AuditableDescriptor[],
  options?: { auditPeriod?: { from: string; to: string } },
): FrameworkReport {
  const scope = loadControlSet(framework);
  const controls = scope.controls;
  const period = options?.auditPeriod;

  const inPeriod = (d: AuditableDescriptor): boolean => {
    if (!period) return true;
    return d.publishedAt >= period.from && d.publishedAt <= period.to;
  };

  const entries = controls.map<FrameworkReportEntry>(c => {
    /**
     * ★ A CONTROL IS SATISFIED BY A CITATION OF ANY OF ITS PUBLISHED SPELLINGS. The ontologies
     * declare article-form IRIs as citable aliases of the structural control and say so in their
     * own comments; evidence in this repo follows that instruction. Matching the canonical form
     * alone scored those citations as nothing — the engine ignoring what the vocabulary published
     * about itself.
     */
    const accepted = c.aliases;
    const evidence = descriptors.filter(d =>
      inPeriod(d) && d.evidenceForControls.some(e => accepted.has(String(e))),
    );
    // The default policy is bi-modal: either evidence exists for the
    // control (satisfied) or it doesn't (missing). The previous "exactly
    // one evidence → partial" rule was arbitrary — a single signed audit
    // record can fully satisfy a control. Callers who need a quality
    // threshold (e.g., "N pieces of evidence required") should derive
    // their own status from `evidenceCount` rather than rely on a
    // hardcoded count. The `'partial'` value is preserved in the type
    // so a custom aggregation can still produce it.
    const status: FrameworkReportEntry['status'] = evidence.length === 0
      ? 'missing'
      : 'satisfied';
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
  // Overall: weighted score — satisfied=1, partial=0.5, missing=0. The
  // default policy never emits 'partial' (see above); the weight survives
  // for custom aggregation policies that do.
  const overallScore = (satisfied + partial * 0.5) / entries.length;

  return {
    framework,
    scopeSource: scope.scopeSource,
    ...(scope.scopeIri ? { scopeIri: scope.scopeIri } : {}),
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
import { Wallet as EthersWallet } from 'ethers';
import { importWallet, type Wallet } from '@interego/core';

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
  // ethers.Wallet.createRandom() returns a Wallet whose privateKey
  // is a 0x-prefixed hex string suitable for re-instantiation via
  // new Wallet(privateKey). The intermediate Wallet construction
  // mirrors the original CJS require() shape.
  return new EthersWallet(EthersWallet.createRandom().privateKey).privateKey;
}

function addressFromPrivateKey(privateKey: string): string {
  return new EthersWallet(privateKey).address;
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
  // Capture whether the store had to be minted on this call before we
  // mutate it. `fresh` is the operator-visible signal that "your
  // wallet was just generated; back this file up immediately."
  const wasFresh = store === null;
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
    fresh: wasFresh,
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

/**
 * Return the set of addresses that were ACTIVE at a given point in
 * time — used for stricter verification when the signedAt timestamp
 * is known and the verifier wants to refuse signatures from wallets
 * that were not yet active (or had already been retired) at that
 * moment.
 *
 * Closes audit Sec #6: previously `listValidSignerAddresses` returned
 * every wallet in history as forever-valid, so a wallet compromised
 * *after* signing some descriptor (and later found in history) could
 * be retroactively used to forge "signed at time T" claims. The
 * time-bounded variant lets the verifier enforce the wallet's
 * lifecycle window:
 *
 *   active iff   createdAt ≤ signedAt   AND   (retiredAt ≥ signedAt
 *                                              OR retiredAt absent
 *                                                 = still active)
 *
 * Callers that already trust the broader pool (e.g. an internal audit
 * tool walking lineage) can continue to use the unbounded
 * listValidSignerAddresses. External-auditor / regulator-grade
 * verifications should prefer this variant.
 */
export function listValidSignerAddressesAt(path: string, signedAt: Date): readonly string[] {
  const store = readStore(path);
  if (!store) return [];
  const t = signedAt.getTime();
  const validAt = (e: ComplianceWalletEntry): boolean => {
    const createdMs = new Date(e.createdAt).getTime();
    if (!Number.isFinite(createdMs) || createdMs > t) return false;
    if (e.retiredAt) {
      const retiredMs = new Date(e.retiredAt).getTime();
      if (Number.isFinite(retiredMs) && retiredMs < t) return false;
    }
    return true;
  };
  const valid: string[] = [];
  if (validAt(store.active)) valid.push(store.active.address);
  for (const h of store.history) if (validAt(h)) valid.push(h.address);
  return valid;
}

// ── Lineage walk ─────────────────────────────────────────────

/**
 * Walk the prov:wasDerivedFrom + iep:supersedes chains for a given
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
