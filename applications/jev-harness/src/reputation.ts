/**
 * Reputation from attestations: what the pod says about the harness agent, aggregated the way
 * the registry aggregates it.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * The bridge issues an amta:Attestation about itself once its calibration earns one (see
 * calibration-publish.ts). Until 2026-09-21 nothing read it: the gated auto-merge looked at
 * the calibration JSON the bridge serves, and the attestation sat on the pod as evidence
 * nobody consumed. @interego/registry is the consumer this repository already has — it turns
 * a set of amta:Attestation inputs into a ReputationSnapshot under a stated policy, weighting
 * each attestation by who issued it and how old it is. So the bridge reads every attestation
 * about its agent from the pod (its own chain and any a peer publishes under the same prefix),
 * feeds them to that aggregator, and serves the snapshot; the auto-merge, when a person is
 * required, reads the snapshot's accuracy axis as one of its conditions.
 *
 * The policy differs from the registry's default in one number, and says why: the default
 * gives a self-attestation weight 0 ("you cannot vouch for yourself"). Ours are grounded —
 * amta:fromExecution names the calibration descriptor the ratings were computed from, which a
 * reader can dereference and recompute — so they count at a quarter of a peer's word and half
 * of a high-assurance one's. A bare claim would still count for nothing; this file only
 * accepts attestations that name what grounds them.
 */

import { Parser } from 'n3';
import type { AggregationPolicy, ReputationSnapshot } from '@interego/registry';
import { RATED_AXES, reputationOf as aggregate, reputationPolicy, toAttestationInput, type Attestation } from '../../_shared/judgment-kit/attestations.js';
import type { RelayClient } from './publish.js';
import { AMTA, ATTESTATION_GRAPH_PREFIX } from './calibration-publish.js';
import type { ManifestEntry } from './pod-calibration.js';

export const REPUTATION_POLICY: AggregationPolicy = reputationPolicy('urn:jev-harness:policy:reputation-v1');

// The record, the axes and the mapping to the registry live in the judgment kit now; the harness
// keeps its names so its callers and tests read unchanged.
export { RATED_AXES, toAttestationInput };
export type PodAttestation = Attestation;
const localName = (iri: string): string => iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'), iri.lastIndexOf(':')) + 1);

/** The amta:Attestation inside a descriptor's graph content, or undefined when it holds none it can vouch for. */
export function attestationFromContent(content: string, meta: { readonly descriptorUrl: string }): PodAttestation | undefined {
  let quads;
  try {
    quads = new Parser({ format: 'TriG', baseIRI: meta.descriptorUrl }).parse(content);
  } catch {
    return undefined;
  }
  const subject = quads.find((q) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && q.object.value === `${AMTA}Attestation`)?.subject;
  if (!subject) return undefined;
  const values = new Map<string, string>();
  for (const q of quads) {
    if (!q.subject.equals(subject)) continue;
    const ns = q.predicate.value.startsWith(AMTA) ? 'amta' : 'other';
    const key = `${ns}:${localName(q.predicate.value)}`;
    if (!values.has(key)) values.set(key, q.object.value);
  }
  const attestor = values.get('amta:attestor');
  const about = values.get('amta:subject');
  const attestedAt = values.get('amta:attestedAt');
  const fromExecution = values.get('amta:fromExecution');
  if (!attestor || !about || !attestedAt || !fromExecution) return undefined;
  const axes: Record<string, number> = {};
  for (const axis of RATED_AXES) {
    const v = values.get(`amta:${axis}`);
    if (v !== undefined && v !== '' && !Number.isNaN(Number(v))) axes[axis] = Number(v);
  }
  if (Object.keys(axes).length === 0) return undefined;
  const samples = values.get('other:samples');
  return {
    descriptorUrl: meta.descriptorUrl,
    attestor,
    subject: about,
    direction: values.get('amta:direction') ?? 'Peer',
    axes,
    attestedAt,
    fromExecution,
    ...(samples !== undefined && !Number.isNaN(Number(samples)) ? { samples: Number(samples) } : {}),
  };
}

/** The manifest entries that are attestation chain heads: the newest Asserted entry per attestation graph. */
export function attestationHeads(entries: readonly ManifestEntry[]): ManifestEntry[] {
  const seen = new Set<string>();
  const heads: ManifestEntry[] = [];
  for (const e of entries) {
    const graph = e.describes?.find((g) => typeof g === 'string' && g.startsWith(ATTESTATION_GRAPH_PREFIX));
    if (!graph || e.modalStatus !== 'Asserted' || typeof e.descriptorUrl !== 'string') continue;
    if (seen.has(graph)) continue;
    seen.add(graph);
    heads.push(e);
  }
  return heads;
}

export interface PodAttestationsResult {
  readonly attestations: PodAttestation[];
  readonly scanned: number;
  readonly errors: string[];
}

/** Every attestation head on the pod, read through the relay (entries newest first, so the first entry per graph is its head). */
export async function fetchPodAttestations(relay: RelayClient, podName: string, opts: { readonly limit?: number } = {}): Promise<PodAttestationsResult> {
  const discovered = await relay.callTool('discover_context', { pod_name: podName, sort: 'newest-first', limit: opts.limit ?? 1000 });
  if (discovered.isError) throw new Error(`discover_context failed: ${discovered.text ?? JSON.stringify(discovered.raw)}`);
  const entries = ((discovered.structured?.['entries'] as ManifestEntry[] | undefined) ?? []);
  const attestations: PodAttestation[] = [];
  const errors: string[] = [];
  for (const e of attestationHeads(entries)) {
    try {
      const d = await relay.callTool('get_descriptor', { url: e.descriptorUrl });
      if (d.isError) { errors.push(`${e.descriptorUrl}: ${d.text ?? 'error'}`); continue; }
      const graph = d.structured?.['graph'] as { content?: unknown } | undefined;
      const content = typeof graph?.content === 'string' ? graph.content : typeof d.structured?.['turtle'] === 'string' ? d.structured['turtle'] as string : '';
      const a = attestationFromContent(content, { descriptorUrl: e.descriptorUrl });
      if (a) attestations.push(a);
      else errors.push(`${e.descriptorUrl}: no grounded attestation in the payload`);
    } catch (err) {
      errors.push(`${e.descriptorUrl}: ${(err as Error).message}`);
    }
  }
  return { attestations, scanned: entries.length, errors };
}

/** The agent's reputation under the harness policy, or null when nothing on the pod attests to it. */
export function reputationOf(agentId: string, attestations: readonly PodAttestation[], policy: AggregationPolicy = REPUTATION_POLICY, now?: string): ReputationSnapshot | null {
  return aggregate(agentId, attestations, policy, now);
}
