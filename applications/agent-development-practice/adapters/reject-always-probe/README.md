# The reject-always probe

Puts the missing button on the menu, so we can find out whether anyone presses it.

> **Publishes nothing.** Standing rules and counters live in memory; `--json` writes a local
> file. Nothing about your code, prompts, paths, diffs or terminal output leaves the machine.

## Why this exists

Increment 0 measured a real question and got an answer nobody expected: **`reject_always` is
never offered.** The production ACP agent (`@zed-industries/claude-code-acp`) builds its
permission menu as `allow_always` / `allow_once` / `reject_once` and never constructs
`reject_always` at all. So the standing-deny thesis has no supply — but for *structural*
reasons, not behavioural ones. Nobody declines a button that is never rendered.

That leaves the actual question unanswered and unanswerable by observation alone: **would a
developer use a standing denial if they had one?** You cannot measure a choice nobody is
given. This supplies the choice.

## Why it is not part of the Editor Witness

The witness has exactly one invariant: it is invisible. Every frame forwarded unmodified,
unparsable frames included, because an observer that edits the stream is not an observer.

This program does the opposite on purpose. Keeping them in one file would make that
invariant untrue and unenforceable. They are siblings, and they compose:

```
editor  <->  witness (measures)  <->  probe (modifies)  <->  real agent
```

The witness sits nearer the editor deliberately, so it records the menu the human actually
**saw** — including the injected option — and the answer the human actually gave.

## Why it enforces, and does not merely offer

A button labelled "reject always" that asks again next time is a lie, and a developer would
learn within minutes not to trust it — poisoning the very behaviour being measured. So when
you choose it, the probe records a standing rule and answers later requests for that tool
itself, without troubling you. That is what makes the offer real, and it is a faithful
preview of what increment 1 would do with a published constraint.

The rule keys on **tool name**, not `toolCall.kind`. `kind` is a ~6-valued enum
(read/edit/execute/…) shared by many tools; denying "execute" forever because you refused
one command would be absurd. The agent's own persisted rules key on tool name, and so does
this.

## Run it

Chain the witness in front of the probe, and give each the next program after `--`:

```jsonc
// editor ACP agent settings
{
  "command": "npx",
  "args": [
    "tsx", "<repo>/applications/agent-development-practice/adapters/editor-witness/src/cli.ts",
    "--json", "<repo>/witness.json", "--",
    "npx", "tsx", "<repo>/applications/agent-development-practice/adapters/reject-always-probe/src/inject.ts",
    "--json", "<repo>/probe.json", "--",
    "npx", "@zed-industries/claude-code-acp"
  ]
}
```

On Windows with Node 22, `npx` fails here (`spawn npx ENOENT`, and `npx.cmd` gives `EINVAL`
because Node 22 will not spawn a `.cmd` without a shell). Call `tsx` directly instead:

```sh
node node_modules/tsx/dist/cli.mjs <repo>/.../editor-witness/src/cli.ts -- \
node node_modules/tsx/dist/cli.mjs <repo>/.../reject-always-probe/src/inject.ts -- \
node node_modules/@zed-industries/claude-code-acp/dist/index.js
```

Then **do a real session of your own work.** The number is only worth anything if the
decisions are real ones about real changes you actually cared about.

## Reading the result

- **`reject_always` chosen: 0** — a genuine negative, and a much stronger one than increment
  0's. The option was there and you did not want it. The standing-constraint thesis loses
  its input for a reason that is about people rather than menus.
- **`reject_always` chosen: n > 0** — the deny set is non-empty when the button exists.
  Increment 1 has something to carry, and the finding becomes "the ecosystem does not offer
  a control developers would use".
- **later asks auto-denied** — how much work the standing rule actually saved. A rule chosen
  once and never triggered again is weaker evidence than one that suppressed twenty asks.

## What it cannot tell you

- It is **n=1**, you, on whatever you happened to do that day.
- The menu is one this program invented. A real agent might word or scope the option
  differently, and wording moves choices.
- Tool name is recovered from `_meta.toolName` when the agent supplies it and from the
  tool-call title otherwise. The title fallback is coarse — it takes the first word — so
  rules authored during a session driven by an agent that omits `_meta` may be scoped more
  broadly than you intended. The tally records exactly which name each rule used.
- Nothing here says a standing denial would be *useful* to subtract from an unrelated
  vertical's affordances later. That is increment 2's claim and no counter can supply
  evidence for it.
