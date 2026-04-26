# Benchmarks

Adhoc evaluation scripts and result artifacts for the Interego agentic memory pipeline.

## Status

Manual / adhoc. No CI integration today — these scripts are run by the operator on demand and results are committed when noteworthy. See [`spec/OPS-RUNBOOK.md`](../spec/OPS-RUNBOOK.md) §13 for the roadmap to CI-gated benchmark regressions.

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
  "notes": "string"             // optional — free-text rationale
}
```

The schema has grown over time; older entries may have a subset. New entries SHOULD include `config` and `notes` for reproducibility.

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
