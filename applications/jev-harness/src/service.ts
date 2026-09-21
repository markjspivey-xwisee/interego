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
import { fetchPodOutcomes } from './pod-calibration.js';
import { judgmentFromContent, type PodJudgment } from './pod-judgment.js';
import { HarnessStore, calibratedAdvice, computeAdviceBuckets, type CalibrationView, type PodBackfillState } from './store.js';
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
    // Memory first: every navigation consults what earlier tasks changed, here and on the pod.
    const raw = await navigate(this.jev, this.inventory(input.scope), { ...input, precedents: this.store.precedents() });
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
    const prior = this.store.findByGraphIri(input.judgmentIri) ?? await this.judgmentFromPod(input.judgmentIri);
    if (prior.kind === 'outcome') throw new HarnessError(409, 'an outcome cannot be scored by another outcome');
    const o = recordOutcome(prior as AnyJudgment, input);
    return this.finish(o, { verb: 'recorded-outcome', objectName: o.summary.slice(0, 120) }, [prior]);
  }

  /**
   * A judgment this bridge did not make, read back from the pod so it can still be scored: the
   * bridge in a CI run makes a pull request's judgments and is gone when the run ends, and the
   * outcome is known only when the pull request closes. The pod's current head for the graph
   * is either the Hypothetical judgment (scorable) or the Asserted outcome that already scored
   * it (refused with 409, so a second close cannot fork the chain).
   */
  private async judgmentFromPod(graphIri: string): Promise<PodJudgment> {
    if (!this.relay || !this.relay.podName) throw new HarnessError(404, `no judgment with graph IRI ${graphIri} in this bridge's store, and no pod to read it from`);
    const head = await this.relay.callTool('get_current_head', { urn: graphIri, pod_name: this.relay.podName });
    const url = (head.structured?.['head'] as { descriptorUrl?: unknown } | undefined)?.descriptorUrl;
    if (typeof url !== 'string') throw new HarnessError(404, `the pod holds no descriptor for ${graphIri}`);
    const d = await this.relay.callTool('get_descriptor', { url });
    const graph = d.structured?.['graph'] as { content?: unknown } | undefined;
    const content = typeof graph?.content === 'string' ? graph.content : typeof d.structured?.['turtle'] === 'string' ? d.structured['turtle'] as string : '';
    const parsed = judgmentFromContent(content, { graphIri, descriptorUrl: url });
    if (parsed.kind === 'outcome') throw new HarnessError(409, `${graphIri} is already scored on the pod`);
    if (parsed.kind === 'none') throw new HarnessError(404, `the pod's descriptor for ${graphIri} holds no readable judgment`);
    return parsed.judgment;
  }

  calibration(): CalibrationView {
    return this.store.calibration();
  }

  /**
   * Read the harness outcomes on the pod back into the store, so calibration is the union of
   * every bridge publishing as this delegate rather than what this container remembers. Off
   * without a relay that names a pod; a failure is recorded, not thrown, because a bridge that
   * cannot reach the pod should still judge.
   */
  async backfillFromPod(): Promise<PodBackfillState> {
    if (!this.relay || !this.relay.podName) {
      this.store.podBackfill = { status: 'off' };
      return this.store.podBackfill;
    }
    try {
      const r = await fetchPodOutcomes(this.relay, this.relay.podName, { known: this.store.knownPodDescriptors() });
      const m = this.store.mergePodOutcomes(r.records);
      this.store.podBackfill = { status: 'ok', at: new Date().toISOString(), scanned: r.scanned, fetched: r.records.length + r.errors.length, added: m.added, total: m.total, errors: r.errors.slice(0, 5) };
    } catch (err) {
      this.store.podBackfill = { status: 'failed', at: new Date().toISOString(), error: (err as Error).message };
    }
    return this.store.podBackfill;
  }

  private async finish<J extends Published>(j: J, step: { verb: string; objectName: string }, supersedes: readonly Published[] = []): Promise<JudgmentResponse<J>> {
    const payload = payloadTurtle(j, this.ctx);
    // A judgment read back from the pod is superseded at its pod descriptor; a local one at its own URL.
    const podUrlOf = (s: Published): string | undefined => (s as { podDescriptorUrl?: string }).podDescriptorUrl;
    const trig = descriptorTrig(j, this.ctx, supersedes.length > 0 ? { supersedes: supersedes.map((s) => podUrlOf(s) ?? `${judgmentUrl(s, this.ctx)}.trig`) } : {});
    const markdown = hmdMarkdown(j, this.ctx);
    this.store.save(j, { payloadTurtle: payload, descriptorTrig: trig, markdown });
    let publish: PublishState = { status: 'skipped' };
    if (this.relay) {
      try {
        // An outcome lands as the next version of the judgment it scores, so the pod's chain flips
        // Hypothetical → Asserted; if_match makes that a compare-and-swap on the published head.
        const prior = supersedes[0];
        const ifMatch = prior ? podUrlOf(prior) ?? this.store.relayDescriptorUrl(prior.id) : undefined;
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
