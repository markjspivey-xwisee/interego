## 2026-11-18 — Auto-merge: the merge is held to the commit its checks were read on

The gated auto-merge read the checks on one commit and then asked GitHub to
merge the pull request, whatever its head was by then. A push that landed
between the two would have been merged without its checks.

- **The merge names the tested commit.** The driver now runs `gh pr merge
  --merge --match-head-commit <sha>`, and GitHub refuses when the branch's head
  is any other commit. The label is taken back on that refusal, as on any
  failed merge.
- **The workflow passes the head** (`--head-sha`), the same
  `pull_request.head.sha` the wait for the suite and the other checks used.
- **A missing or malformed head stops the driver** (exit 2) before it reads the
  pull request, updates the branch, labels or merges. `--dry-run` needs none.

**Not done.** Nothing here was run against GitHub: the tests cover the command
that is built, what counts as a head, the order of the driver's steps and the
workflow's wiring. `gh pr update-branch` is not pinned to a head. Found by
ChatGPT's review of #950 and #951.

