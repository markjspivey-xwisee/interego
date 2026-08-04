/**
 * Real cross-pod federation: load foxxi:Outcome descriptors from peer
 * pods and compose them into the bridge's calibration profile.
 *
 * Replaces the SAMPLE_PEER_OUTCOMES seed array. Until this loader was
 * wired in, the federation read was theatre — a hard-coded peer corpus
 * baked into the bridge process. Now it's a real `discover()` call
 * against each peer pod, fetched on a TTL, decoded from the same
 * foxxi:bundleJson graphs the bridge itself publishes for outcomes.
 *
 * One bridge publishes its outcomes into its own pod (the tenant pod);
 * another bridge reads them via this loader and composes them into the
 * shared calibration profile. The cells with sub-k samples are
 * withheld by federationView() before crossing the boundary — the
 * substrate enforces aggregate privacy without needing extra plumbing.
 */

import {
  withTransientRetry,
} from '@interego/solid';
import {
  discover,
} from '@interego/solid';
import type {
  IRI,
} from '@interego/core';
import type { OutcomeRecord, CauseKey } from './performance-calibration.js';
import { verifySignature } from './outcome-descriptor-publisher.js';
import { FOXXI_NS } from './foxxi-vocab.js';

const FOXXI = FOXXI_NS;
const FOXXI_OUTCOME = `${FOXXI}Outcome`;

const VALID_REGIMES = new Set(['Evident', 'Knowable', 'Emergent', 'Turbulent']);
const VALID_METHODS = new Set(['apply-practice', 'gap-analysis', 'dispositional-read', 'stabilise-first']);
const VALID_VERDICTS = new Set(['closed', 'improved', 'no-change', 'worsened']);
const VALID_CAUSES = new Set<CauseKey>(['information', 'instrumentation', 'incentives', 'knowledgeSkill', 'capacity', 'motives', 'not-applicable']);

/** Coerce a JSON-decoded outcome payload into an OutcomeRecord. Returns null if the shape is wrong. */
function asOutcome(o: unknown): OutcomeRecord | null {
  if (!o || typeof o !== 'object') return null;
  const v = o as Record<string, unknown>;
  if (!VALID_REGIMES.has(v.regime as string)) return null;
  if (!VALID_CAUSES.has(v.causeFactor as CauseKey)) return null;
  if (typeof v.intervention !== 'string') return null;
  if (!VALID_VERDICTS.has(v.verdict as string)) return null;
  return {
    regime: v.regime as OutcomeRecord['regime'],
    method: VALID_METHODS.has(v.method as string) ? (v.method as OutcomeRecord['method']) : 'gap-analysis',
    causeFactor: v.causeFactor as CauseKey,
    intervention: v.intervention as OutcomeRecord['intervention'],
    verdict: v.verdict as OutcomeRecord['verdict'],
    ...(VALID_CAUSES.has(v.reDiagnosedCause as CauseKey) ? { reDiagnosedCause: v.reDiagnosedCause as CauseKey } : {}),
    source: typeof v.source === 'string' ? v.source : 'peer',
  };
}

function decodeOutcomeFromGraphTurtle(turtle: string): OutcomeRecord | null {
  const bundleMatch = turtle.match(/foxxi:bundleJson\s+"([^"]+)"\^\^xsd:base64Binary/);
  if (!bundleMatch) return null;
  // SIGNATURE GATE (Option D): only accept outcomes that carry a
  // foxxi:agentSignature AND a prov:wasGeneratedBy DID, AND whose
  // signature verifies against that DID over the exact bundle bytes.
  // This makes anonymous junk PUT directly to CSS inert: the peer
  // descriptors that count are only the ones the peer's bridge (or
  // signed agent) actually emitted. Unsigned legacy peer data is
  // silently dropped — re-seed peers with signed outcomes if needed.
  const sigMatch = turtle.match(/foxxi:agentSignature\s+"([^"]+)"/);
  const authorMatch = turtle.match(/prov:wasGeneratedBy\s+<([^>]+)>/);
  if (!sigMatch || !authorMatch) return null;
  try {
    // `!` on the capture groups: each regex has exactly one group and the match
    // objects are already null-checked above, so group 1 is always present. These
    // were bare index reads that compiled only because nothing in tsconfig.check.json
    // reached this module until a test imported it.
    const json = Buffer.from(bundleMatch[1]!, 'base64').toString('utf8');
    const verdict = verifySignature({
      signature: sigMatch[1]!,
      agentDid: authorMatch[1]!,
      payloadJson: json,
    });
    if (!verdict.verified) return null;
    const parsed = JSON.parse(json) as unknown;
    return asOutcome(parsed);
  } catch { return null; }
}

interface CacheEntry {
  outcomes: OutcomeRecord[];
  loadedAt: number;
  manifestEtag?: string;
}

/**
 * Why a pod contributed nothing. A configured-but-ABSENT peer and a
 * configured-and-EMPTY peer were the same observable: discover() returns []
 * for a 404 manifest by design (packages/solid/src/client.ts — a shard-only
 * pod legitimately has no monolith), so loadAll()'s catch never fires and
 * nothing is logged. That is exactly how the pod named by
 * FOXXI_FEDERATION_PODS sat unprovisioned (404) in production while
 * /performance/calibration reported `usingSeedFallback: true` — the same
 * value it reports when no peers are configured at all. This names the
 * difference so the fault can be seen.
 */
export type PodOutcomeStatus =
  | 'ok'            // >=1 signed outcome decoded
  | 'no-manifest'   // discover() returned zero entries: pod absent (404) or empty
  | 'no-outcomes'   // manifest exists but carries no foxxi:Outcome entries
  | 'all-rejected'  // outcome entries exist but every one failed fetch or the signature gate
  | 'error';        // discover() itself threw

export interface FederationLoaderConfig {
  /** Cache TTL (ms). Default 60s — fresh enough for live demos, cheap enough for prod. */
  ttlMs?: number;
  /** Fetch implementation; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * FederationOutcomeLoader — discovers foxxi:Outcome descriptors on
 * configured peer pods and returns their decoded payloads. Caches per
 * pod with a TTL so the calibration recompute path stays synchronous.
 */
export class FederationOutcomeLoader {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly podStatus = new Map<string, PodOutcomeStatus>();
  private readonly ttlMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: FederationLoaderConfig = {}) {
    this.ttlMs = config.ttlMs ?? 60_000;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Load + cache outcomes from every configured peer pod. */
  async loadAll(podUrls: readonly string[]): Promise<OutcomeRecord[]> {
    const out: OutcomeRecord[] = [];
    const now = Date.now();
    for (const podUrl of podUrls) {
      const cached = this.cache.get(podUrl);
      if (cached && now - cached.loadedAt < this.ttlMs) {
        out.push(...cached.outcomes);
        continue;
      }
      try {
        const { outcomes: fresh, status } = await this.loadFromPod(podUrl);
        this.podStatus.set(podUrl, status);
        this.cache.set(podUrl, { outcomes: fresh, loadedAt: now });
        out.push(...fresh);
        // A configured peer that yields nothing is a provisioning fault, not a
        // quiet no-op. Without this line a 404 peer pod produced ZERO log output
        // (discover() swallows 404 into []), so the only trace was an unchanged
        // seed profile that nobody reads as an error.
        if (status !== 'ok') console.warn(`[federation-loader] ${podUrl}: ${status}`);
      } catch (err) {
        this.podStatus.set(podUrl, 'error');
        console.error(`[federation-loader] ${podUrl}: ${(err as Error).message}`);
        // Fall back to whatever cache we have for this pod (even stale)
        if (cached) out.push(...cached.outcomes);
      }
    }
    return out;
  }

  /** Per-pod diagnosis from the most recent non-cached load. */
  podStatuses(): Record<string, PodOutcomeStatus> {
    return Object.fromEntries(this.podStatus);
  }

  private async loadFromPod(podUrl: string): Promise<{ outcomes: OutcomeRecord[]; status: PodOutcomeStatus }> {
    // transient-network retry now provided by @interego/core's discover
    const entries = await discover(podUrl, {}, { fetch: this.fetchFn });
    // discover() maps a 404 manifest to [] rather than throwing, so this is the
    // ONLY place an absent pod is observable at all.
    if (entries.length === 0) return { outcomes: [], status: 'no-manifest' };
    const outcomeEntries = entries.filter(e => {
      const ct = (e as { conformsTo?: readonly IRI[] }).conformsTo;
      return Array.isArray(ct) && ct.some(t => String(t) === FOXXI_OUTCOME);
    });
    if (outcomeEntries.length === 0) return { outcomes: [], status: 'no-outcomes' };
    const outcomes: OutcomeRecord[] = [];
    // Each outcome's graph URL is deterministic from its slug; but the
    // manifest carries it explicitly. Read the manifest's `graph` (or
    // `describes`) field and fetch the TriG body.
    for (const entry of outcomeEntries) {
      const graphIri = (entry as { graph?: string }).graph
        ?? entry.describes?.[0];
      if (!graphIri) continue;
      // The graph file URL follows the publisher's slug convention:
      //   <podUrl>foxxi/work-products/<slug>-graph.trig
      // We don't know the slug from the manifest entry; fall back to the
      // graph IRI's content-hash suffix or to walking the container.
      // Cleanest: use the manifest's stored graph URL when available.
      const graphUrl = (entry as { graphUrl?: string }).graphUrl
        ?? this.guessGraphUrl(podUrl, graphIri);
      if (!graphUrl) continue;
      try {
        const ttl = await withTransientRetry(async () => {
          const r = await this.fetchFn(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
          if (!r.ok) throw new Error(`graph fetch failed: ${r.status} ${r.statusText}`);
          return r.text();
        });
        const o = decodeOutcomeFromGraphTurtle(ttl);
        if (o) outcomes.push(o);
      } catch { /* skip this entry; partial peer is OK */ }
    }
    return { outcomes, status: outcomes.length > 0 ? 'ok' : 'all-rejected' };
  }

  private guessGraphUrl(podUrl: string, graphIri: string): string | null {
    // Outcome IRIs follow `urn:foxxi:outcome:<uid>` and live at
    // `<podUrl>foxxi/work-products/outcome-<uid>-graph.trig`.
    const m = String(graphIri).match(/^urn:foxxi:outcome:([^#]+)$/);
    if (!m) return null;
    return `${podUrl.endsWith('/') ? podUrl : podUrl + '/'}foxxi/work-products/outcome-${m[1]}-graph.trig`;
  }

  /** Clear the cache. Useful for tests or admin-triggered refresh. */
  clear(): void { this.cache.clear(); this.podStatus.clear(); }
}

/** Parse FOXXI_FEDERATION_PODS into a clean list. */
export function parseFederationPods(env: string | undefined): string[] {
  return (env ?? '').split(',').map(s => s.trim()).filter(Boolean);
}
