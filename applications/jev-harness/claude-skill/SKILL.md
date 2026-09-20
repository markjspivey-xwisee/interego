---
name: jev-harness
description: Follow the jev-harness bridge's affordances while developing in a repository it is bound to — navigate at the start of a task, select and run tests after a change, gate the diff before finishing, and record outcomes so the judgments calibrate. Use when a task names a change to make in the bound repository, when tests need running after an edit, or before declaring a change done.
---

# jev-harness: follow the graph, not a manual

The bridge exposes System One judgments as Interego affordances. Discover them at the manifest; act by following the controls each judgment carries. Never compose bridge URLs by hand.

## Is the bridge up?

```bash
curl -s http://localhost:6090/health
```

If not, start it bound to the repository you are working in (Jev's key is read from `TYPESAFE_API_KEY`, or the Windows user-scope variable):

```bash
PORT=6090 JEV_HARNESS_REPO=<repo> BRIDGE_DEPLOYMENT_URL=http://localhost:6090 npx tsx bridge/server.ts
```

## At the start of a task

```bash
npx tsx bin/follow.ts http://localhost:6090/affordances navigate --arg task="<the task in one sentence>" --repo <repo>
```

Read the advice: `open-top-file` means open that file; `open-top-three` means open all three and decide; `widen-search` means the model is unsure, so follow the `refine` control it offers or fall back to grep. Open the covering test it names before editing.

## After a change

```bash
npx tsx bin/follow.ts http://localhost:6090/affordances select-tests --arg changed_files='["path/a.ts","path/b.ts"]' \
  --then run-selected-tests --run --then triage --outcome --repo <repo>
```

Read each failure's class and action: `retry` and `fix-environment-then-retry` are not defects in your change; `open-remediation` is. The outcome scores whether every failing test was in the selection.

## Before finishing

```bash
git diff > /tmp/change.diff
npx tsx bin/follow.ts http://localhost:6090/affordances review-gate --file diff=/tmp/change.diff --arg title="<subject>" --arg description="<what and why>" --gate --repo <repo>
```

`needs-human-review` lists the reasons; address them or hand the change to a person with those reasons. `block` means a secret is in the diff. `auto-ok` means the gate does not demand a person; it never merges.

## Closing the loop

After the change lands, score the navigation you started from:

```bash
npx tsx bin/follow.ts <navigation judgment url>.trig record-outcome --arg files_changed='["path/a.ts"]' --repo <repo>
```

Every judgment and outcome is also written under `<repo>/.jev-harness/` as JSON, payload Turtle, descriptor TriG and HyperMarkdown, and published to the pod when the bridge has `INTEREGO_BEARER`.
