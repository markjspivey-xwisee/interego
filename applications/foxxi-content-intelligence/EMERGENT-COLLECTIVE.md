# The Emergent Collective

A real multi-agent demonstration of an **emergent property of the whole
Interego ecosystem**: a piece of knowledge that no single agent holds —
and that no agent could establish alone — arising from the independent
contributions of many, becoming claimable, becoming a transmissible
capability, and coming to live in a profile that two organizations
share.

Run it:

```
# scripted edition — five cryptographic identities, scripted per-agent contributions
npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-demo.mjs

# autonomous edition — five real Claude subagents via the Claude Agent SDK,
# each one independently deciding how to work its cases through the substrate.
# Requires ANTHROPIC_API_KEY or an active Claude Code OAuth login.
npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-agents.mjs

# live edition — same emergence, with a browser dashboard that shows it
# happening in real time: per-agent event lanes, a system log, and an
# artifact browser over the descriptors the run produces.
npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-live.mjs
# then open http://127.0.0.1:8765 — per-agent event lanes, system log, artifact browser
```

The three editions exercise the **same architecture** and the **same emergence** —
they differ only in where the per-agent decisions come from and how the
run is surfaced. The scripted edition iterates a deterministic case list
(fast, free, deterministic verification). The autonomous edition spawns
real Claude subagents that decide for themselves which tools to call and
in what order, with the substrate as their only channel to each other.
The live edition runs the same scripted contributions behind a local
HTTP server on `127.0.0.1:8765`, streaming each agent's substrate calls
into per-agent lanes and letting you click through the artifacts as they
land.

## Signed writes (all three editions)

Every outcome and every teaching call is signed by the contributing
agent's wallet before it is POSTed. The bridge rejects unsigned writes
(`401 signature required`) and rejects writes whose recovered address
does not match the author DID (`401 signature does not verify`). The
three editions share one helper, `signPayload(wallet, payload)`:

```
signedPayload = JSON.stringify(payload)
hash          = sha256_hex(signedPayload)
signature     = wallet.signMessage(`sha256:${hash}`)
```

The body sent to `POST /performance/outcome` is:

```
{
  author:        { id: 'did:key:0x<addr>#agent', kind: 'agent' },
  signature,
  signedPayload   // the canonical outcome JSON, as a string
}
```

The body sent to `POST /agent/teach` follows the same shape, but the
signed payload is `{ teachingPackage, targetBehaviour }` and the author
is the teacher.

A contributor writing their own tool against the bridge can copy the
helper verbatim — that is the working signed-write path.

## Nothing is faked

The standing instruction for this demo was that it not be faked,
simulated, or synthetic at all. It is not:

- **Real identities.** Five agents, each a real ECDSA wallet → a real
  DID. Their participation claims are really signed and the signatures
  are really recovered and verified. Every outcome record and every
  teaching call is also signed by the contributing agent's wallet; the
  bridge rejects the write if the signature is missing or if the
  recovered address does not match the author DID.
- **Real computation on live infrastructure.** Every diagnosis,
  evaluation, calibration read, outcome record and teaching call is a
  real HTTP request to the **live deployed bridge on Azure**, which
  really computes the result. The modal-status flip is the live bridge's
  own `buildCalibrationProfile` crossing its assertion threshold.
  Storage stays zero-trust — anyone can read pod contents — and trust
  lives at the verifier and reader layer: the bridge verifies signatures
  on write, and the reader-side federated-outcome loader silently drops
  any peer descriptor whose `foxxi:agentSignature` does not check out
  against its `prov:wasGeneratedBy` DID.
- **Real coordination through the substrate — stigmergy.** The agents
  never call each other. Their only channel is the substrate: one agent
  records an outcome, the calibration profile on the live bridge
  recomposes, another agent reads it back. Coordination through a shared
  environment, not direct messaging.
- **Real federation.** The live bridge composes a second organization's
  calibration evidence; the peer organization's pod is really fetched
  over the federation.

What is *scenario data* — the agents' names, the field-guidance
situations — is domain data, as in any demonstration. Every
**computation** is real and runs on the real architecture.

In the **autonomous edition**, additionally:

- **Real Claude subagents.** Each of the five agents is a separate
  `query()` call to the Claude Agent SDK (claude-sonnet-4-6 by default),
  spawned as an isolated subprocess. Each agent decides for itself which
  tools to call and in what order. The orchestrator never tells an agent
  "now contextualize" or "now record" — the agent reads the substrate,
  works its cases, and reports back when done.
- **Real tool affordances.** The agents reach the substrate through
  three MCP tools whose handlers make real HTTP calls to the deployed
  bridge: `read_calibration_profile`, `contextualize_situation`,
  `record_outcome`. There is no in-process mock — the network round-trip
  is genuine. The teaching agent (Atlas) gets a fourth tool, `teach`,
  that issues a real `/agent/teach` call.

## The cast

Five autonomous agents, five distinct cryptographic identities. Four
operate field-guidance cases; the fifth is taught the result. None is
given the finding the demo produces; none can establish it alone.

## What happens

| Act | What runs, for real |
|---|---|
| 1 | The deployed bridge and a peer organization's pod are pinged — this is live infrastructure. |
| 2 | Five real wallets are created; five participation claims are signed and the signatures verified. |
| 3 | Baseline — the calibration cell `information → reference` does not exist; the seeded corpus has no such finding, so anything that appears there must be earned live. |
| 4 | Each agent, alone, contextualizes three field cases on the live bridge, applies a searchable reference, and records the real outcome (verdict via the architecture's own `evaluateIntervention`). After each agent, the shared profile is read back — the cell climbs 3 → 6 → 9 → 12 → 15. |
| 5 | **Emergence.** The cell crosses the assertion threshold and flips `Hypothetical → Asserted`. The finding — a real ~80% closure rate — is now claimable knowledge, computed by the live bridge from the aggregate, held by no agent. |
| 6 | A fresh plan is now annotated with the calibration evidence the collective produced — the whole pressing back on the next part (downward causation). |
| 7 | One agent encodes the finding as a teaching package and teaches another; Foxxi's `/agent/teach` (composing agent-collective's `ac:TeachingPackage`) verifies the transfer from the learner's real trajectories. |
| 8 | The finding now lives in the federated profile the live bridge composes across two organizations — and only the signature-verified peer outcomes are admitted; anything unsigned is dropped by the reader. |

## The emergent property, precisely

A single agent's three outcomes are, honestly, `Hypothetical` — too thin
to claim anything. The calibration cell stays `Hypothetical` no matter
how the work is sliced *per agent*. Only when enough independent agents
have each contributed does the cell cross the threshold and flip to
`Asserted`.

`Asserted` is a property of the **whole**. It is not in any agent, not
in any single contribution, and was authored by no one. It exists only
as the relation between the parts — the loop that runs between the
outcomes and the profile. That is emergence, and the substrate's
**modal status** makes it exact and verifiable: the system refuses to
call a thin signal knowledge, and names the precise point at which the
collective's evidence makes it knowledge.

## What it demonstrates about the whole ecosystem

The demo is one motion across the whole substrate and several verticals:

- **wallet-rooted identity + cryptography** — five real signed identities;
- **the Performance Architecture** — real contextualization and evaluation;
- **the reflexive calibration loop** — the live upward arm (outcomes →
  profile) and downward arm (profile → the next plan);
- **modal status** — the `Hypothetical → Asserted` flip as the exact
  marker of emergence;
- **agent-collective** — the finding becomes an `ac:TeachingPackage`,
  taught and verified;
- **federation** — the finding composed across two organizations, with
  no coordinator.

Five real agents, acting alone, coordinating only by reading and writing
the live substrate, produced a piece of knowledge none of them had. The
whole acquired a property that none of its parts possessed. That is the
mind-blowing thing — and every step of it is real.
