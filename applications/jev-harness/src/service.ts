/**
 * The vertical's service: run a judgment, project it into its Interego artifacts, store
 * them, publish to the pod when a relay is configured, and answer with the judgment, its
 * dereferenceable URL and the controls it affords. The bridge and the local follower both
 * call this; neither knows anything about Jev prompts or Turtle.
 */

import { contextFromEnv, controlsFor, descriptorTrig, hmdMarkdown, judgmentUrl, payloadTurtle, type Control, type PublishContext, type Published } from './descriptor.js';
import type { JevClient } from './jev-client.js';
import { navigate, type NavigateInput, type NavigationJudgment } from './judgments/navigate.js';
import { selectTests, type SelectTestsInput, type TestSelectionJudgment } from './judgments/select-tests.js';
import { triage, type TriageInput, type FailureTriageJudgment } from './judgments/triage.js';
import { reviewGate, type ReviewGateInput, type ReviewVerdictJudgment } from './judgments/review-gate.js';
import { recordOutcome, type AnyJudgment, type OutcomeInput, type OutcomeRecord } from './judgments/outcome.js';
import { publishJudgment, recordTrajectoryStep, type RelayClient } from './publish.js';
import { changedFiles, inventory, unifiedDiff, type RepoInventory } from './repo.js';
import { HarnessStore, calibratedAdvice, computeAdviceBuckets, type CalibrationView } from './store.js';
import { isIri } from './turtle.js';

export interface HarnessOptions {
  readonly jev: JevClient;
  readonly repoRoot: string;
  readonly base: string;
  readonly context?: PublishContext;
  readonly store?: HarnessStore;
  readonly relay?: RelayClient | null;
  readonly visibility?: 'public' | 'shared' | 'private';
}

export interface PublishState {
  readonly status: 'published' | 'skipped' | 'failed';
  readonly descriptorUrl?: string;
  readonly error?: string;
}

export interface JudgmentResponse<J extends Published> {
  readonly judgment: J;
  readonly url: string;
  readonly controls: readonly Control[];
  readonly publish: PublishState;
}

export class Harness {
  readonly jev: JevClient;
  readonly repoRoot: string;
  readonly ctx: PublishContext;
  readonly store: HarnessStore;
  readonly relay: RelayClient | null;
  private readonly visibility: 'public' | 'shared' | 'private';
  private inventoryCache: { readonly key: string; readonly inv: RepoInventory } | undefined;

  constructor(opts: HarnessOptions) {
    this.jev = opts.jev;
    this.repoRoot = opts.repoRoot;
    this.ctx = opts.context ?? contextFromEnv(opts.base);
    this.store = opts.store ?? new HarnessStore(opts.repoRoot);
    this.relay = opts.relay ?? null;
    this.visibility = opts.visibility ?? 'shared';
  }

  inventory(scope?: string): RepoInventory {
    const key = scope ?? '';
    if (this.inventoryCache && this.inventoryCache.key === key) return this.inventoryCache.inv;
    const inv = inventory(this.repoRoot, scope ? { scope } : {});
    this.inventoryCache = { key, inv };
    return inv;
  }

  async navigate(input: NavigateInput): Promise<JudgmentResponse<NavigationJudgment>> {
    const raw = await navigate(this.jev, this.inventory(input.scope), input);
    // The advice, and therefore the controls the judgment affords, come from measured
    // calibration once a confidence bucket has enough recorded outcomes.
    const calibrated = calibratedAdvice(raw.confidence, raw.advice, computeAdviceBuckets(this.store.outcomes()));
    const j: NavigationJudgment = { ...raw, advice: calibrated.advice, adviceBasis: calibrated.basis, ...(calibrated.bucket ? { adviceBucket: calibrated.bucket } : {}) };
    return this.finish(j, { verb: 'navigated', objectName: input.task.slice(0, 120) });
  }

  async selectTests(input: SelectTestsInput & { readonly baseRef?: string; readonly headRef?: string }): Promise<JudgmentResponse<TestSelectionJudgment>> {
    const changed = input.changedFiles.length > 0
      ? input.changedFiles
      : input.baseRef ? changedFiles(this.repoRoot, input.baseRef, input.headRef) : [];
    const j = await selectTests(this.jev, this.inventory(), { changedFiles: changed, ...(input.task ? { task: input.task } : {}) });
    return this.finish(j, { verb: 'selected-tests', objectName: `${changed.length} changed files -> ${j.mode}` });
  }

  async triage(input: TriageInput): Promise<JudgmentResponse<FailureTriageJudgment>> {
    const inv = this.inventory();
    const j = await triage(this.jev, inv, input);
    return this.finish(j, { verb: 'triaged', objectName: `${j.failures.length} failures` });
  }

  async reviewGate(input: Omit<ReviewGateInput, 'diff'> & { readonly diff?: string; readonly baseRef?: string; readonly headRef?: string }): Promise<JudgmentResponse<ReviewVerdictJudgment>> {
    const diff = input.diff && input.diff.length > 0
      ? input.diff
      : input.baseRef ? unifiedDiff(this.repoRoot, input.baseRef, input.headRef) : '';
    if (!diff) throw new HarnessError(400, 'review-gate needs a diff or a base_ref that yields one');
    const inv = this.inventory();
    const { baseRef: _b, headRef: _h, ...rest } = input;
    const j = await reviewGate(this.jev, inv, { ...rest, diff });
    return this.finish(j, { verb: 'gated', objectName: `${j.verdict}${input.title ? ` for ${input.title.slice(0, 80)}` : ''}` });
  }

  async recordOutcome(input: OutcomeInput): Promise<JudgmentResponse<OutcomeRecord>> {
    // The judgment IRI is caller-supplied and is emitted into Turtle as an IRI reference.
    if (!isIri(input.judgmentIri)) throw new HarnessError(400, 'judgment_iri must be an absolute IRI without whitespace or <>"{}|^`\\');
    const prior = this.store.findByGraphIri(input.judgmentIri);
    if (!prior) throw new HarnessError(404, `no judgment with graph IRI ${input.judgmentIri} in this bridge's store`);
    if (prior.kind === 'outcome') throw new HarnessError(409, 'an outcome cannot be scored by another outcome');
    const o = recordOutcome(prior as AnyJudgment, input);
    return this.finish(o, { verb: 'recorded-outcome', objectName: o.summary.slice(0, 120) }, [prior]);
  }

  calibration(): CalibrationView {
    return this.store.calibration();
  }

  private async finish<J extends Published>(j: J, step: { verb: string; objectName: string }, supersedes: readonly Published[] = []): Promise<JudgmentResponse<J>> {
    const payload = payloadTurtle(j, this.ctx);
    const trig = descriptorTrig(j, this.ctx, supersedes.length > 0 ? { supersedes: supersedes.map((s) => `${judgmentUrl(s, this.ctx)}.trig`) } : {});
    const markdown = hmdMarkdown(j, this.ctx);
    this.store.save(j, { payloadTurtle: payload, descriptorTrig: trig, markdown });
    let publish: PublishState = { status: 'skipped' };
    if (this.relay) {
      try {
        // An outcome lands as the next version of the judgment it scores, so the pod's chain flips
        // Hypothetical → Asserted; if_match makes that a compare-and-swap on the published head.
        const prior = supersedes[0];
        const ifMatch = prior ? this.store.relayDescriptorUrl(prior.id) : undefined;
        const receipt = await publishJudgment(this.relay, j, payload, {
          visibility: this.visibility,
          ...(prior ? { graphIri: prior.graphIri } : {}),
          ...(ifMatch ? { ifMatch } : {}),
        });
        publish = { status: 'published', ...(receipt.descriptorUrl ? { descriptorUrl: receipt.descriptorUrl } : {}) };
        if (receipt.descriptorUrl) this.store.noteRelayPublish(j.id, receipt.descriptorUrl);
        await recordTrajectoryStep(this.relay, {
          verb: step.verb,
          objectName: step.objectName,
          resultSuccess: true,
          resultQuality: j.confidence,
          ...(receipt.descriptorUrl ? { wasDerivedFrom: [receipt.descriptorUrl] } : {}),
        }).catch(() => undefined);
      } catch (err) {
        publish = { status: 'failed', error: (err as Error).message };
      }
    }
    return { judgment: j, url: judgmentUrl(j, this.ctx), controls: controlsFor(j, this.ctx), publish };
  }
}

export class HarnessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}
