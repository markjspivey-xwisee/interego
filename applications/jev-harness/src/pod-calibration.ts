/**
 * Calibration that survives a redeploy, read from the pod.
 *
 * The store under .jev-harness/ lives inside the container, so every rollout forgets the
 * outcomes this bridge scored. The outcomes are also on the pod, published as the Asserted
 * head of each judgment's graph, and every bridge that publishes as the same delegate (the
 * deployed one, CI's, a developer's) puts its outcomes there too. Reading them back through
 * the relay makes the calibration view the union of everything the harness has learned, which
 * is the point of publishing outcomes at all.
 */

import { Parser } from 'n3';
import type { JudgmentKind } from './judgments/common.js';
import type { OutcomeRecord, OutcomeSource } from './judgments/outcome.js';
import type { RelayClient } from './publish.js';

export const HARNESS_GRAPH_PREFIX = 'urn:graph:jev-harness:';
const OUTCOME_TYPE_SUFFIX = '#Outcome';
const KINDS: readonly JudgmentKind[] = ['navigation', 'test-selection', 'failure-triage', 'review-verdict', 'outcome'];

export interface ManifestEntry {
  readonly descriptorUrl: string;
  readonly describes?: readonly string[];
  readonly modalStatus?: string;
  readonly validFrom?: string;
  readonly supersedes?: readonly string[];
}

/** An outcome as it came back from the pod, with the descriptor it was read from. */
export interface PodOutcome extends OutcomeRecord {
  readonly descriptorUrl: string;
}

/** The manifest entries that are harness outcomes: an Asserted head of a jev-harness graph. */
export function outcomeEntries(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return entries.filter((e) => typeof e.descriptorUrl === 'string'
    && Array.isArray(e.describes) && e.describes.some((g) => typeof g === 'string' && g.startsWith(HARNESS_GRAPH_PREFIX))
    && e.modalStatus === 'Asserted');
}

/** The last segment of an IRI: after # or / for a namespace term, after the last colon for a URN. */
const localName = (iri: string): string => iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'), iri.lastIndexOf(':')) + 1);

/** The outcome record inside a descriptor's graph content (TriG with the jvh: payload), or undefined when it holds none. */
export function outcomeFromContent(content: string, meta: { readonly descriptorUrl: string; readonly validFrom?: string }): PodOutcome | undefined {
  let quads;
  try {
    quads = new Parser({ format: 'TriG', baseIRI: meta.descriptorUrl }).parse(content);
  } catch {
    return undefined;
  }
  const subject = quads.find((q) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && q.object.termType === 'NamedNode' && q.object.value.endsWith(OUTCOME_TYPE_SUFFIX))?.subject;
  if (!subject) return undefined;
  const values = new Map<string, string[]>();
  const iris = new Map<string, string>();
  for (const q of quads) {
    if (!q.subject.equals(subject)) continue;
    const key = localName(q.predicate.value);
    if (q.object.termType === 'NamedNode') iris.set(key, q.object.value);
    const list = values.get(key) ?? [];
    list.push(q.object.value);
    values.set(key, list);
  }
  const one = (k: string): string | undefined => values.get(k)?.[0];
  const num = (k: string): number | null => { const v = one(k); return v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v); };
  const bool = (k: string): boolean | null => { const v = one(k); return v === undefined ? null : v === 'true'; };
  const judgmentIri = iris.get('judgmentIri') ?? one('judgmentIri');
  const priorConfidence = num('priorConfidence');
  const kindValue = one('judgmentKind');
  const judgmentKind = KINDS.find((k) => k === kindValue);
  if (!judgmentIri || priorConfidence === null || !judgmentKind) return undefined;
  const id = localName(subject.value) || meta.descriptorUrl;
  const source: OutcomeSource = one('outcomeSource') === 'backtest' ? 'backtest' : 'live';
  return {
    kind: 'outcome',
    id,
    graphIri: `${HARNESS_GRAPH_PREFIX}outcome:${id}`,
    createdAt: one('created') ?? meta.validFrom ?? new Date(0).toISOString(),
    model: one('model') ?? 'unknown',
    confidence: num('confidence') ?? 1,
    repository: { name: one('repository') ?? 'unknown', root: '', commit: one('commit') ?? null },
    usage: { requests: 0, input_tokens: 0, output_tokens: 0, latencyMs: 0 },
    judgmentIri,
    judgmentKind,
    priorConfidence,
    source,
    hitAt1: bool('hitAt1'),
    hitAt3: bool('hitAt3'),
    brier: num('brier'),
    missed: values.get('missed') ?? [],
    agreement: one('agreement') ?? null,
    observed: { judgmentIri, source },
    summary: one('summary') ?? '',
    descriptorUrl: meta.descriptorUrl,
  };
}

export interface PodFetchResult {
  readonly records: PodOutcome[];
  /** Manifest entries examined. */
  readonly scanned: number;
  /** Outcome descriptors already held locally, so not fetched again. */
  readonly skipped: number;
  readonly errors: string[];
}

/** Every harness outcome on the pod that is not already known, read through the relay. */
export async function fetchPodOutcomes(relay: RelayClient, podName: string, opts: { readonly known?: ReadonlySet<string>; readonly limit?: number; readonly maxFetch?: number } = {}): Promise<PodFetchResult> {
  const discovered = await relay.callTool('discover_context', { pod_name: podName, sort: 'newest-first', limit: opts.limit ?? 1000 });
  if (discovered.isError) throw new Error(`discover_context failed: ${discovered.text ?? JSON.stringify(discovered.raw)}`);
  const entries = ((discovered.structured?.['entries'] as ManifestEntry[] | undefined) ?? []);
  const outcomes = outcomeEntries(entries);
  const known = opts.known ?? new Set<string>();
  const records: PodOutcome[] = [];
  const errors: string[] = [];
  let skipped = 0;
  let fetched = 0;
  for (const e of outcomes) {
    if (known.has(e.descriptorUrl)) { skipped += 1; continue; }
    if (fetched >= (opts.maxFetch ?? 500)) break;
    fetched += 1;
    try {
      const d = await relay.callTool('get_descriptor', { url: e.descriptorUrl });
      if (d.isError) { errors.push(`${e.descriptorUrl}: ${d.text ?? 'error'}`); continue; }
      const graph = d.structured?.['graph'] as { content?: unknown } | undefined;
      const content = typeof graph?.content === 'string' ? graph.content : typeof d.structured?.['turtle'] === 'string' ? d.structured['turtle'] as string : '';
      const record = outcomeFromContent(content, { descriptorUrl: e.descriptorUrl, ...(e.validFrom ? { validFrom: e.validFrom } : {}) });
      if (record) records.push(record);
      else errors.push(`${e.descriptorUrl}: no outcome payload`);
    } catch (err) {
      errors.push(`${e.descriptorUrl}: ${(err as Error).message}`);
    }
  }
  return { records, scanned: entries.length, skipped, errors };
}
