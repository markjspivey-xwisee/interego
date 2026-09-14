# Benchmarks

Adhoc evaluation scripts and result artifacts for the Interego agentic memory pipeline.

The [controller policy and release-procedure comparison](controller-procedure-comparison/README.md)
reports a separate prospective cohort: three completed releases, one blocked,
one interrupted at its recorded checkpoint, and three unstarted assignments.
Its public accounting and disclosure checks run in the dedicated
`controller-comparison.yml` workflow. The older studies remain separate.
The [changed-binding follow-up](controller-procedure-comparison/followup.md)
reports four additional fresh trials under protocol 2.1.0, with separate
measurements and contrasts; it preserves the stopped cohort above.

## Status

Benchmark execution is manual / adhoc. Operators run scripts on demand and commit selected results. The controller comparison's public audit runs in CI; its live assessment remains an operator-run experiment. See [`spec/OPS-RUNBOOK.md`](../spec/OPS-RUNBOOK.md) §13 for the roadmap to CI-gated benchmark regressions.

## Integrity stance — no cross-run learning

**The agent must run each benchmark question cold — as if it has never seen the question before.** The benchmark runner's prompts (`run-pgsl-native.ts` and friends) MUST NOT contain hints, examples, or carve-outs derived from inspecting which past questions failed.

This rule was not always observed. In a 2026-05-03 audit the criteria-extraction prompt was found to contain rules like *"twins, multiples, and group items count individually"* (shaped to LongMemEval's Q77 about babies born to friends/family), *"a returned item AND its replacement = 2 items"* (shaped to LongMemEval's Q60 about clothing returns), *"personal/individual projects ('my research', 'my project') count even without explicit 'I led'"* (shaped to Q61), plus several abstention examples ("iPad vs iPhone", "fence vs cows", "the woman selling jam") that lifted concrete entities from the test set. The grader's few-shot examples contained literal gold-answer fragments (Premiere Pro, Netflix stand-up, hotel rooftop pools).

These were study notes from prior test-taking sessions — not general counting / abstention principles — and they inflated the headline score by an unknown amount. They were stripped on 2026-05-03 and the headline numbers were re-baselined against the cleaned pipeline. New `eval-history.json` entries after the cleanup carry a `cleanCriteria: true` flag; older entries do not.

**Going forward:** if a benchmark question fails, the response is to investigate whether the *substrate* or *generic agent pipeline* is missing a capability — never to add the failing question's specific entities, names, or pattern as a guidance line in the prompt. **A tweak that would be inappropriate to ship in production memory-agent code that has never seen these benchmarks does not belong in the benchmark runner either.**

## File inventory

### Tracked artifacts

| File | What it is |
|---|---|
| `eval-history.json` | Curated run-by-run snapshot of the LongMemEval evaluation. One JSON object per significant run. Schema below. |
| `run-*.ts`, `diagnose-*.ts`, `test-*.ts`, `fix-*.ts` | Driver scripts. Each `run-*.ts` is one experimental configuration (model + retrieval strategy + prompt template). `diagnose-*.ts` is post-hoc analysis. |
| `locomo/` (gitignored) | LOCOMO benchmark fixtures. Fetch from upstream — see `locomo/README.md` if present. |
| `LongMemEval/` (gitignored) | LongMemEval benchmark fixtures. Same — fetch from upstream. |

### Ignored artifacts

| Pattern | Why ignored |
|---|---|
| `*.log` | Per-run stdout/stderr capture. Regenerable; previously ~300MB committed by mistake. |
| `.tmp-*` | Scratch files written during interactive runs. |

## `eval-history.json` schema

Each entry in the top-level array is one evaluation run:

```jsonc
{
  "timestamp": "ISO 8601",      // when the run started
  "model": "opus" | "sonnet" | "haiku" | string,  // primary inference model
  "runs": 1,                    // number of independent passes (for self-consistency runs)
  "overall": 0.0..1.0,          // overall accuracy (correct / total)
  "perType": {                  // per-question-type accuracy
    "temporal": 0.0..1.0,
    "counting": 0.0..1.0,
    "sum": 0.0..1.0,
    "preference": 0.0..1.0,
    "knowledge-update": 0.0..1.0,
    "single-session": 0.0..1.0
  },
  "failures": [                 // 0-indexed question IDs that failed
    54, 60, 70
  ],
  "config": {                   // optional — what was different about this run
    "retrieval": "vector" | "lattice" | "hybrid",
    "topK": number,
    "promptVersion": "v1" | "v2" | string,
    "temperature": number
  },
  "notes": "string",            // optional — free-text rationale
  "cleanCriteria": true         // present + true = run used the post-2026-05-03
                                // cleaned-up cold-start agent (no prompt-level
                                // study notes from prior benchmark runs).
                                // Absent or false = ran against an older
                                // pipeline whose prompts contained
                                // benchmark-specific carve-outs. Compare
                                // only entries with the same flag value.
}
```

The schema has grown over time; older entries may have a subset. New entries SHOULD include `config` and `notes` for reproducibility AND `cleanCriteria` for integrity.

## Reading + writing

- **Read:** open `eval-history.json` in any JSON viewer; or run `node -e "console.table(require('./eval-history.json').map(({timestamp,model,overall}) => ({timestamp,model,overall})))"` for a quick scoreboard.
- **Write:** append a new object to the array; keep timestamps in ISO 8601 UTC.

## Running a benchmark

Example:

```bash
# LongMemEval, 500 questions, opus, vector retrieval
node --import tsx benchmarks/run-benchmarks.ts --model opus --topk 10 \
  > benchmarks/run-$(date +%Y%m%d-%H%M%S).log 2>&1
```

The `> ... .log` redirect lands in the gitignore-excluded path; copy the summary metrics into `eval-history.json` if the run is worth tracking.

## Methodology — current

- Dataset: LongMemEval 500-question split (and LOCOMO when comparing baselines).
- Retrieval: PGSL lattice vs vector baseline; see [`spec/architecture.md`](../spec/architecture.md) §"Retrieval".
- Inference: Anthropic Claude family (Opus / Sonnet / Haiku) via `@anthropic-ai/sdk`.
- Scoring: exact-match against the gold answer (case-insensitive, normalized whitespace). Some categories use semantic match — see the per-script comment.

## Reproducibility caveats

- Models change behavior between minor releases. A score collected on `claude-opus-4-7` may not reproduce on a later snapshot.
- Retrieval is non-deterministic when temperature > 0. Set `--seed` where the script supports it.
- LOCOMO + LongMemEval fixtures change upstream; pin the dataset commit hash in your `notes` field.

## Roadmap

See [`spec/OPS-RUNBOOK.md`](../spec/OPS-RUNBOOK.md) §13:

- CI integration: nightly small-N runs against a frozen subset
- Coverage thresholds: alert when a known-good metric drops > X%
- Provenance: every result entry carries a git SHA + dataset hash
