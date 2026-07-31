# The Editor Witness

A transparent stdio tee for **Agent Client Protocol**, run locally by the developer.

> **Privacy contract, first, because it is the point.**
> Increment 0 **publishes nothing.** It counts consent decisions in memory and prints a
> summary. No network calls, no pod writes, no credentials, no telemetry. Nothing about
> your code, your file paths, your prompts, or your terminal output leaves the machine.

## Why this exists

ACP puts a code editor and a coding agent on either end of a JSON-RPC stream. Uniquely
among the protocols this project touches, that stream carries **the human's consent as
structured data**: `session/request_permission` asks, and the answer names an option whose
kind is one of `allow_once` / `allow_always` / `reject_once` / `reject_always`.

Interego has a published, SHACL-shaped, ODRL-aligned vocabulary for exactly that kind of
decision — `ieh:PolicyDecision`, `iep:AccessControlPolicy`, `iep:deonticMode` — with a
working evaluator and **zero instances**, because nothing in the system has ever produced
a real human authorization decision. ACP is a candidate supply for a dormant capability.

The eventual claim is that a developer clicking *reject always* in an editor could author
a durable, self-owned constraint that **removes that action from the capability set an
unrelated vertical advertises to that agent later**. That would be genuine cross-vertical
recomposition with real downward causation.

## Why increment 0 is only a counter

That claim rests on something nobody has measured: **do always-scoped denials actually
happen?** If a real day of work yields no `reject_always`, the deny set is empty forever,
there is no downward causation, and the honest outcome is to ship a log and say so.

So this build answers that and nothing else. Everything downstream is contingent on the
number it prints.

## Use it

Point your editor's ACP agent command at the witness, and pass the real agent after `--`:

```jsonc
{
  "command": "npx",
  "args": ["tsx", "<repo>/applications/agent-development-practice/adapters/editor-witness/src/cli.ts",
           "--", "npx", "@agentclientprotocol/claude-agent-acp"]
}
```

Or try it from a terminal against the SDK's example agent:

```sh
npx tsx src/cli.ts -- node node_modules/@agentclientprotocol/sdk/dist/examples/agent.js
```

`--json <path>` also writes the tally to a file. Still local.

## The one invariant

**The tee is invisible.** Every frame is forwarded byte-for-byte — the original line, never
a re-serialisation of a parsed object, because re-encoding would shift key order and number
formatting and would silently drop ACP's `_meta` passthrough and any field this build does
not know about. A frame that fails to parse is still forwarded; we are not a validator and
must never become a filter. An observer that throws cannot break the stream.

`transport.ts` is framing, which is code by nature, and contains no ACP method name.
`measure.ts` is the increment-0 instrument and is deliberately literal about ACP tokens —
it is a thermometer calibrated in degrees. Neither is the mapping layer: increment 1's
`map.ts` turns frames into substrate terms driven entirely by a published mapping graph,
and it is the file the spec-blindness guard greps.

## Status

| Increment | State |
|---|---|
| 0 — transparent tee, local counting, nothing published | **built** |
| 1 — `adp:` vocabulary, published mapping + shapes, pod writes | blocked on increment 0's number |
| 2 — standing constraints subtract from advertised affordances | blocked on 1 |

**Known blocker for increment 1**, found on day one exactly as the design intended: the
relay's SHACL engine does **not** implement `sh:closed`. The design's privacy guarantee was
"a witnessed turn may carry *only* the declared predicates, enforced by the published shape
on the write path." Without `sh:closed` that degrades to an enumerated denylist, which can
only refuse predicates someone thought of. That is materially weaker and is a maintainer
decision before anything is published.
