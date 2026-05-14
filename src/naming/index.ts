/**
 * @module naming
 * @description Interego name service — attestation-based naming.
 *
 * A name is a *verifiable attestation*, not a claimed registration:
 *
 *     <did:web:pod.example:users:abc>  foaf:nick  "alice"
 *
 * published as an ordinary `cg:ContextDescriptor` carrying Trust +
 * Provenance + Temporal facets and `cg:supersedes` chains. Resolution
 * is federated discovery + trust evaluation — name conflicts resolve by
 * the resolver's own trust policy, never first-come-first-served. There
 * is no central registrar, no root, no namespace governance: the cost
 * is that a name is trust-relative, not globally unique. That is the
 * correct trade for a substrate whose non-negotiables are federation,
 * verifiability, and no central authority. See `docs/NAME-SERVICE.md`
 * for the full design and the ENS comparison.
 *
 * This module composes existing primitives only — the descriptor
 * builder, `publish` / `discover`, the seven facets, `cg:supersedes`,
 * and `foaf:nick` (W3C FOAF). It introduces NO new L1/L2 ontology
 * terms. Layer: L2 architecture pattern (sibling of `registry:` /
 * `passport:`).
 *
 *   buildNameAttestation(args, config)  → { descriptor, graphContent, … }   (pure)
 *   attestName(args, config)            → { attestationIri, descriptorUrl } (publishes)
 *   resolveName(name, config, opts?)    → NameCandidate[]   (forward, trust-ranked)
 *   namesFor(subject, config, opts?)    → NameCandidate[]   (reverse)
 *   defaultNameTrustPolicy              → NameTrustPolicy   (pluggable)
 */

// Import from source modules, NOT the `../index.js` barrel: `discovery.ts`
// imports this module (to surface resolveName as a resolver tier), and a
// barrel import here would close a `discovery → naming → barrel →
// solid → discovery` cycle. Pointing at the leaf modules keeps the
// dependency graph a clean DAG.
import { ContextDescriptor } from '../model/descriptor.js';
import { publish, discover } from '../solid/client.js';
import { parseTrig } from '../rdf/turtle-parser.js';
import { sha256 } from '../crypto/ipfs.js';
import type {
  IRI,
  TrustLevel,
  ModalStatus,
  ContextDescriptorData,
} from '../model/types.js';
import type { ManifestEntry, FetchFn } from '../solid/types.js';

// W3C FOAF — the name binding predicate. No new vocabulary.
const FOAF_NICK = 'http://xmlns.com/foaf/0.1/nick' as IRI;

// Recognizable IRI prefixes so federated discovery can cheaply filter
// to name attestations without fetching every graph. The two share a
// content hash, so one is derivable from the other.
const NAME_DESCRIPTOR_PREFIX = 'urn:cg:name:';
const NAME_GRAPH_PREFIX = 'urn:graph:cg:name:';

// ── Types ────────────────────────────────────────────────────────────

export interface NamingConfig {
  /** Pod URL where this principal publishes (and, by default, resolves) attestations. */
  readonly podUrl: string;
  /** DID of the agent making the attestation — sets PROV provenance + signs on publish. */
  readonly attestingAgentDid: IRI;
  /**
   * Optional human / org owner the agent acts on behalf of. When set,
   * the Trust + Provenance facets attribute to the owner, not the
   * agent. Defaults to `attestingAgentDid` (self-attributed).
   */
  readonly onBehalfOf?: IRI;
}

export interface AttestNameArgs {
  /** The principal (DID / WebID / agent IRI) being named. */
  readonly subject: IRI;
  /** The human-friendly name being attested. */
  readonly name: string;
  /**
   * Trust level of THIS attestation:
   *   - 'SelfAsserted' (default): the attester simply states the binding.
   *   - 'ThirdPartyAttested': a third party vouches for a binding it observed.
   *   - 'CryptographicallyVerified': a third party co-signs a binding it
   *     verified — pass `proof`.
   */
  readonly trustLevel?: TrustLevel;
  /** Proof IRI for a CryptographicallyVerified attestation. */
  readonly proof?: IRI;
  /**
   * Prior name-attestation IRIs (`urn:cg:name:…`) this supersedes — a
   * rename or reassignment. The prior attestation stays on the pod,
   * audit-walkable; it just drops out of default resolution.
   */
  readonly supersedes?: readonly IRI[];
}

export interface AttestNameResult {
  /** The content-addressed logical IRI of the attestation. */
  readonly attestationIri: IRI;
  /** Where the descriptor Turtle was written on the pod. */
  readonly descriptorUrl: string;
  /** Where the binding graph was written on the pod. */
  readonly graphUrl: string;
}

/** One discovered name binding plus the metadata needed to rank it. */
export interface NameCandidate {
  /** The attested name (`foaf:nick` literal, as published). */
  readonly name: string;
  /** The principal the name is bound to. */
  readonly subject: IRI;
  /** Content-addressed logical IRI of the attestation (its supersedes identity). */
  readonly attestationIri: IRI;
  /** Pod URL the attestation descriptor was found at. */
  readonly attestationUrl: string;
  /** Pod the attestation was discovered on. */
  readonly podUrl: string;
  /** Trust level from the descriptor's Trust facet. */
  readonly trustLevel: TrustLevel;
  /** Modal status from the descriptor's Semiotic facet. */
  readonly modalStatus: ModalStatus;
  /** When the attestation became valid (ISO 8601), if declared. */
  readonly attestedAt?: string;
  /** True if another discovered attestation supersedes this one. */
  readonly superseded: boolean;
  /** Trust-policy rank score; higher = preferred. Set by the policy. */
  readonly score: number;
}

export interface ResolveOptions {
  /** Pods to search. Default: `[config.podUrl]`. Pass subscribed / directory pods to go federated. */
  readonly pods?: readonly string[];
  /** Ranking + filtering policy. Default: {@link defaultNameTrustPolicy}. */
  readonly trustPolicy?: NameTrustPolicy;
  /** Max candidates returned. Default 8. */
  readonly limit?: number;
  /**
   * Custom fetch — threaded into `discover` and the graph fetches.
   * Same `FetchFn` shape the rest of the substrate's federated calls
   * accept. Defaults to the global fetch.
   */
  readonly fetch?: FetchFn;
}

/**
 * Ranks and filters discovered name candidates. Receives every
 * candidate (with `superseded` already computed); returns the ordered,
 * filtered subset — best first. Pluggable: a pod, an org, or an agent
 * can supply its own policy. Resolution is NEVER first-come-first-served
 * — it is whatever the policy decides.
 */
export type NameTrustPolicy = (candidates: readonly NameCandidate[]) => readonly NameCandidate[];

// ── Helpers ──────────────────────────────────────────────────────────

function escapeLit(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function nowIso(): string { return new Date().toISOString(); }

/**
 * Default pod filename convention: a descriptor at `<x>.ttl` has its
 * graph at `<x>-graph.trig`. The substrate-correct path is to follow
 * the descriptor's `dcat:distribution` / `hydra:target` link; until
 * that is wired into the resolver this convention is what `publish()`
 * produces, and an unresolvable graph just contributes no candidate
 * (the resolver never throws).
 */
function graphUrlFor(descriptorUrl: string): string {
  return descriptorUrl.replace(/\.ttl$/, '-graph.trig');
}

function isNameAttestation(entry: ManifestEntry): boolean {
  return entry.describes.some(d => d.startsWith(NAME_GRAPH_PREFIX));
}

/** Pull every `foaf:nick` binding out of a parsed attestation graph. */
function parseNameGraph(trig: string): readonly { subject: IRI; name: string }[] {
  let doc;
  try { doc = parseTrig(trig); } catch { return []; }
  const out: { subject: IRI; name: string }[] = [];
  for (const subj of doc.subjects) {
    if (typeof subj.subject !== 'string') continue; // skip blank nodes
    const nicks = subj.properties.get(FOAF_NICK);
    if (!nicks) continue;
    for (const term of nicks) {
      if (term.kind === 'literal' && term.value.trim().length > 0) {
        out.push({ subject: subj.subject, name: term.value });
      }
    }
  }
  return out;
}

// ── Build (pure) ─────────────────────────────────────────────────────

/**
 * Build the descriptor + graph for a name attestation. Pure and
 * synchronous — separated from {@link attestName} so it can be
 * unit-tested without a pod.
 *
 * The attestation is content-addressed on `(subject, name)`: re-running
 * it for the same pair yields the same `attestationIri`, so a repeat
 * attestation is idempotent rather than a duplicate.
 */
export function buildNameAttestation(
  args: AttestNameArgs,
  config: NamingConfig,
): {
  readonly descriptor: ContextDescriptorData;
  readonly graphContent: string;
  readonly attestationIri: IRI;
  readonly graphIri: IRI;
} {
  const name = args.name.trim();
  if (name.length === 0) throw new Error('cannot attest an empty name');
  if (!args.subject) throw new Error('a name attestation requires a subject IRI');

  const id = sha256(`${args.subject}|${name}`).slice(0, 16);
  const attestationIri = `${NAME_DESCRIPTOR_PREFIX}${id}` as IRI;
  const graphIri = `${NAME_GRAPH_PREFIX}${id}` as IRI;

  // The Trust + Provenance issuer is whoever is vouching — the owner the
  // attesting agent acts for (or the agent itself when self-attributed).
  const issuer = config.onBehalfOf ?? config.attestingAgentDid;
  const level: TrustLevel = args.trustLevel ?? 'SelfAsserted';

  const builder = ContextDescriptor.create(attestationIri)
    .describes(graphIri)
    .agent(config.attestingAgentDid)
    .generatedBy(config.attestingAgentDid, { onBehalfOf: issuer, endedAt: nowIso() })
    .temporal({ validFrom: nowIso() });

  if (level === 'CryptographicallyVerified') {
    builder.verified(issuer, args.proof);
  } else if (level === 'ThirdPartyAttested') {
    builder.trust({ trustLevel: 'ThirdPartyAttested', issuer });
  } else {
    builder.selfAsserted(issuer);
  }

  // A name attestation is Asserted — the attester commits to it. (A
  // rejected / retracted binding is published as a superseding
  // attestation, not by deleting this one.)
  builder.asserted(0.9);

  if (args.supersedes && args.supersedes.length > 0) {
    builder.supersedes(...args.supersedes);
  }

  const graphContent = `<${args.subject}> <${FOAF_NICK}> "${escapeLit(name)}" .\n`;
  return { descriptor: builder.build(), graphContent, attestationIri, graphIri };
}

// ── Publish ──────────────────────────────────────────────────────────

/**
 * Publish a name attestation to the configured pod. The descriptor is
 * signed (Trust facet + the pod's identity layer), provenance-attributed,
 * and temporally bounded — an ordinary federated descriptor that
 * `discover` / `resolveName` pick up.
 */
export async function attestName(
  args: AttestNameArgs,
  config: NamingConfig,
): Promise<AttestNameResult> {
  const built = buildNameAttestation(args, config);
  const r = await publish(built.descriptor, built.graphContent, config.podUrl);
  return {
    attestationIri: built.attestationIri,
    descriptorUrl: r.descriptorUrl,
    graphUrl: r.graphUrl,
  };
}

// ── Discovery (shared by resolveName + namesFor) ─────────────────────

type RawCandidate = Omit<NameCandidate, 'superseded' | 'score'>;

/**
 * Walk the given pods, collect every name-attestation binding that
 * `match` accepts, and mark which are superseded. Never throws — a pod
 * that can't be reached, or a graph that can't be fetched/parsed, simply
 * contributes nothing.
 */
async function gatherCandidates(
  pods: readonly string[],
  match: (binding: { subject: IRI; name: string }) => boolean,
  fetchFn?: FetchFn,
): Promise<NameCandidate[]> {
  const raw: RawCandidate[] = [];
  const supersededIris = new Set<string>();
  // The global fetch's Response is a structural superset of FetchFn's
  // FetchResponse (both expose .ok / .status / .text()).
  const gf: FetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchFn);

  for (const podUrl of pods) {
    let entries: readonly ManifestEntry[];
    try {
      entries = await discover(podUrl, undefined, fetchFn ? { fetch: fetchFn } : {});
    } catch {
      continue; // an unreachable pod contributes nothing
    }
    for (const entry of entries) {
      for (const s of entry.supersedes ?? []) supersededIris.add(s);
      if (!isNameAttestation(entry)) continue;

      const nameGraphIri = entry.describes.find(d => d.startsWith(NAME_GRAPH_PREFIX));
      if (!nameGraphIri) continue;
      const attestationIri = nameGraphIri
        .replace(NAME_GRAPH_PREFIX, NAME_DESCRIPTOR_PREFIX) as IRI;

      let trig: string;
      try {
        const resp = await gf(graphUrlFor(entry.descriptorUrl), {
          headers: { Accept: 'application/trig, text/turtle' },
        });
        if (!resp.ok) continue;
        trig = await resp.text();
      } catch {
        continue;
      }

      for (const binding of parseNameGraph(trig)) {
        if (!match(binding)) continue;
        raw.push({
          name: binding.name,
          subject: binding.subject,
          attestationIri,
          attestationUrl: entry.descriptorUrl,
          podUrl,
          trustLevel: entry.trustLevel ?? 'SelfAsserted',
          modalStatus: entry.modalStatus ?? 'Asserted',
          attestedAt: entry.validFrom,
        });
      }
    }
  }

  return raw.map(c => ({
    ...c,
    superseded: supersededIris.has(c.attestationIri),
    score: 0,
  }));
}

// ── Resolution ───────────────────────────────────────────────────────

/**
 * Resolve a human-friendly name to its principal(s). Returns a
 * trust-RANKED candidate set, NOT a single guaranteed answer — a name
 * is trust-relative. The caller (or its agent) picks, or supplies a
 * stricter `trustPolicy`. Search is case-insensitive on the name.
 *
 * By default it searches only `config.podUrl`; pass `options.pods` (own
 * pod + subscribed pods + pod-directory entries) to resolve federated.
 */
export async function resolveName(
  name: string,
  config: NamingConfig,
  options: ResolveOptions = {},
): Promise<readonly NameCandidate[]> {
  const target = name.trim().toLowerCase();
  if (target.length === 0) return [];
  const pods = options.pods && options.pods.length > 0 ? options.pods : [config.podUrl];
  const candidates = await gatherCandidates(
    pods,
    b => b.name.trim().toLowerCase() === target,
    options.fetch,
  );
  const policy = options.trustPolicy ?? defaultNameTrustPolicy;
  return policy(candidates).slice(0, options.limit ?? 8);
}

/**
 * Reverse lookup — every name attested for a principal. Same discovery
 * + trust ranking as {@link resolveName}, matched on the subject IRI.
 */
export async function namesFor(
  subject: IRI,
  config: NamingConfig,
  options: ResolveOptions = {},
): Promise<readonly NameCandidate[]> {
  const pods = options.pods && options.pods.length > 0 ? options.pods : [config.podUrl];
  const candidates = await gatherCandidates(pods, b => b.subject === subject, options.fetch);
  const policy = options.trustPolicy ?? defaultNameTrustPolicy;
  return policy(candidates).slice(0, options.limit ?? 8);
}

// ── Default trust policy ─────────────────────────────────────────────

const TRUST_RANK: Readonly<Record<TrustLevel, number>> = {
  CryptographicallyVerified: 3,
  ThirdPartyAttested: 2,
  SelfAsserted: 1,
};

/**
 * The default name trust policy. Drops attestations that are no longer
 * active — `Counterfactual` / `Retracted` modal status, or superseded
 * by a later attestation — then ranks the rest by trust level, with
 * recency as the within-level tiebreaker.
 *
 * It is deliberately conservative and fully pluggable: swap in a policy
 * that weighs social distance, `amta:` multi-axis attestation, ABAC
 * predicates, or an org allowlist. Resolution semantics are the
 * policy's, not the substrate's.
 */
export const defaultNameTrustPolicy: NameTrustPolicy = (candidates) => {
  return candidates
    .filter(c =>
      c.modalStatus !== 'Counterfactual' &&
      c.modalStatus !== 'Retracted' &&
      !c.superseded,
    )
    .map(c => ({
      ...c,
      score:
        (TRUST_RANK[c.trustLevel] ?? 1) * 1e13 +
        (c.attestedAt ? Date.parse(c.attestedAt) || 0 : 0),
    }))
    .sort((a, b) => b.score - a.score);
};
