/**
 * Local store: every judgment and outcome the bridge produces, as JSON plus its payload
 * Turtle, descriptor TriG and HyperMarkdown, under <repo>/.jev-harness/. The relay publisher
 * reads the same artifacts. The calibration view is computed here over outcomes.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Published } from './descriptor.js';
import type { OutcomeRecord } from './judgments/outcome.js';
import type { JudgmentKind } from './judgments/common.js';
import { round } from './judgments/common.js';

export interface StoredArtifacts {
  readonly payloadTurtle: string;
  readonly descriptorTrig: string;
  readonly markdown: string;
}

export interface IndexRow {
  readonly id: string;
  readonly kind: JudgmentKind;
  readonly graphIri: string;
  readonly createdAt: string;
  readonly confidence: number;
  readonly relayDescriptorUrl?: string;
}

export interface CalibrationCell {
  readonly kind: JudgmentKind;
  readonly samples: number;
  readonly status: 'Hypothetical' | 'Asserted';
  readonly hitAt1: number | null;
  readonly hitAt3: number | null;
  readonly brier: number | null;
  readonly agreement: Readonly<Record<string, number>>;
}

export interface CalibrationView {
  readonly minSamples: number;
  readonly cells: readonly CalibrationCell[];
  /** Navigation hit rates per confidence bucket; the source of calibrated advice. */
  readonly adviceBuckets: readonly AdviceBucket[];
  readonly computedAt: string;
}

export const CALIBRATION_MIN_SAMPLES = 5;

export class HarnessStore {
  readonly dir: string;
  constructor(baseDir: string) {
    this.dir = join(baseDir, '.jev-harness');
    mkdirSync(join(this.dir, 'judgments'), { recursive: true });
  }

  save(j: Published, artifacts: StoredArtifacts): void {
    const d = join(this.dir, 'judgments');
    writeFileSync(join(d, `${j.id}.json`), JSON.stringify(j, null, 2));
    writeFileSync(join(d, `${j.id}.payload.ttl`), artifacts.payloadTurtle);
    writeFileSync(join(d, `${j.id}.trig`), artifacts.descriptorTrig);
    writeFileSync(join(d, `${j.id}.md`), artifacts.markdown);
    const row: IndexRow = { id: j.id, kind: j.kind, graphIri: j.graphIri, createdAt: j.createdAt, confidence: j.confidence };
    appendFileSync(join(this.dir, 'index.jsonl'), `${JSON.stringify(row)}\n`);
    if (j.kind === 'outcome') appendFileSync(join(this.dir, 'outcomes.jsonl'), `${JSON.stringify(j)}\n`);
  }

  noteRelayPublish(id: string, descriptorUrl: string): void {
    appendFileSync(join(this.dir, 'relay.jsonl'), `${JSON.stringify({ id, descriptorUrl, at: new Date().toISOString() })}\n`);
  }

  /** The descriptor URL the relay answered with when this judgment was published, if it was. */
  relayDescriptorUrl(id: string): string | undefined {
    const p = join(this.dir, 'relay.jsonl');
    if (!existsSync(p)) return undefined;
    const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; descriptorUrl: string });
    return rows.filter((r) => r.id === id).pop()?.descriptorUrl;
  }

  get(id: string): Published | undefined {
    const p = join(this.dir, 'judgments', `${id}.json`);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8')) as Published;
  }

  artifact(id: string, ext: 'payload.ttl' | 'trig' | 'md'): string | undefined {
    const p = join(this.dir, 'judgments', `${id}.${ext}`);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  }

  findByGraphIri(graphIri: string): Published | undefined {
    const row = this.index().find((r) => r.graphIri === graphIri);
    return row ? this.get(row.id) : undefined;
  }

  private indexCache: { readonly size: number; readonly rows: IndexRow[] } | undefined;

  index(): IndexRow[] {
    const p = join(this.dir, 'index.jsonl');
    if (!existsSync(p)) return [];
    const text = readFileSync(p, 'utf8');
    if (this.indexCache && this.indexCache.size === text.length) return this.indexCache.rows;
    const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as IndexRow);
    this.indexCache = { size: text.length, rows };
    return rows;
  }

  outcomes(): OutcomeRecord[] {
    const p = join(this.dir, 'outcomes.jsonl');
    if (!existsSync(p)) return [];
    const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as OutcomeRecord);
    // Outcomes recorded before priorConfidence existed are backfilled from the judgment they
    // score, so calibration buckets see every sample rather than only the newest ones.
    const byGraph = new Map<string, number>();
    return rows.map((o) => {
      if (typeof o.priorConfidence === 'number') return o;
      if (!byGraph.has(o.judgmentIri)) {
        const j = this.findByGraphIri(o.judgmentIri);
        byGraph.set(o.judgmentIri, j && j.kind !== 'outcome' ? j.confidence : Number.NaN);
      }
      const c = byGraph.get(o.judgmentIri);
      return Number.isFinite(c) ? { ...o, priorConfidence: c as number } : o;
    });
  }

  list(): string[] {
    return readdirSync(join(this.dir, 'judgments')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  }

  calibration(): CalibrationView {
    return computeCalibration(this.outcomes());
  }
}

// ── Calibrated advice ─────────────────────────────────────────────────────────
//
// The navigation advice a judgment offers (open-top-file / open-top-three / widen-search)
// starts from static confidence bands. Once enough outcomes exist in a confidence bucket,
// the advice comes from the measured hit rates instead — the controls a judgment affords
// then follow from evidence, not from a threshold somebody typed. On a 40-commit replay the
// static bands offered open-top-file 11 times at confidence ≥ 0.6 with zero hits; the
// calibrated rule offers it only where hit@1 has actually reached one in two.

export type NavigationAdvice = 'open-top-file' | 'open-top-three' | 'widen-search';

export interface AdviceBucket {
  /** Lower edge of the confidence bucket (width ADVICE_BUCKET_WIDTH). */
  readonly from: number;
  readonly samples: number;
  readonly hitAt1: number | null;
  readonly hitAt3: number | null;
}

export const ADVICE_BUCKET_WIDTH = 0.2;
export const ADVICE_RULE = { openTopFileHitAt1: 0.5, openTopThreeHitAt3: 0.5 } as const;

export function computeAdviceBuckets(outcomes: readonly OutcomeRecord[], width = ADVICE_BUCKET_WIDTH): AdviceBucket[] {
  const buckets: AdviceBucket[] = [];
  for (let from = 0; from < 1; from = round(from + width, 6)) {
    const rows = outcomes.filter((o) => o.judgmentKind === 'navigation' && o.priorConfidence >= from && (o.priorConfidence < from + width || (from + width >= 1 && o.priorConfidence <= 1)));
    const rate = (pick: (o: OutcomeRecord) => boolean | null): number | null => {
      const vals = rows.map(pick).filter((v): v is boolean => v !== null);
      return vals.length === 0 ? null : round(vals.filter(Boolean).length / vals.length);
    };
    buckets.push({ from: round(from, 6), samples: rows.length, hitAt1: rate((o) => o.hitAt1), hitAt3: rate((o) => o.hitAt3) });
  }
  return buckets;
}

export interface CalibratedAdvice {
  readonly advice: NavigationAdvice;
  readonly basis: 'default' | 'calibrated';
  readonly bucket?: AdviceBucket;
}

/** The advice for a confidence, from the bucket's measured rates when it has enough samples. */
export function calibratedAdvice(confidence: number, defaultAdvice: NavigationAdvice, buckets: readonly AdviceBucket[], minSamples = CALIBRATION_MIN_SAMPLES): CalibratedAdvice {
  const bucket = buckets.find((b) => confidence >= b.from && (confidence < b.from + ADVICE_BUCKET_WIDTH || b.from + ADVICE_BUCKET_WIDTH >= 1));
  if (!bucket || bucket.samples < minSamples) return { advice: defaultAdvice, basis: 'default' };
  if ((bucket.hitAt1 ?? 0) >= ADVICE_RULE.openTopFileHitAt1) return { advice: 'open-top-file', basis: 'calibrated', bucket };
  if ((bucket.hitAt3 ?? 0) >= ADVICE_RULE.openTopThreeHitAt3) return { advice: 'open-top-three', basis: 'calibrated', bucket };
  return { advice: 'widen-search', basis: 'calibrated', bucket };
}

export function computeCalibration(outcomes: readonly OutcomeRecord[], minSamples = CALIBRATION_MIN_SAMPLES): CalibrationView {
  const kinds: JudgmentKind[] = ['navigation', 'test-selection', 'failure-triage', 'review-verdict'];
  const cells: CalibrationCell[] = kinds.map((kind) => {
    const rows = outcomes.filter((o) => o.judgmentKind === kind);
    const rate = (pick: (o: OutcomeRecord) => boolean | null): number | null => {
      const vals = rows.map(pick).filter((v): v is boolean => v !== null);
      return vals.length === 0 ? null : round(vals.filter(Boolean).length / vals.length);
    };
    const briers = rows.map((o) => o.brier).filter((b): b is number => b !== null);
    const agreement: Record<string, number> = {};
    for (const o of rows) if (o.agreement) agreement[o.agreement] = (agreement[o.agreement] ?? 0) + 1;
    return {
      kind,
      samples: rows.length,
      status: rows.length >= minSamples ? 'Asserted' : 'Hypothetical',
      hitAt1: rate((o) => o.hitAt1),
      hitAt3: rate((o) => o.hitAt3),
      brier: briers.length === 0 ? null : round(briers.reduce((a, b) => a + b, 0) / briers.length, 4),
      agreement,
    };
  });
  return { minSamples, cells, adviceBuckets: computeAdviceBuckets(outcomes), computedAt: new Date().toISOString() };
}
