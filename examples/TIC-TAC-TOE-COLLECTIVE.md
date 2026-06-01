# Tic-Tac-Toe Collective — real multi-agent demo on the live pod

This is a real demonstration of Interego's persistent-agent loop
([`docs/PERSISTENT-AGENT-LOOP.md`](../docs/PERSISTENT-AGENT-LOOP.md))
running end-to-end across three runnable pieces. Five Claude subagents
— each with its own wallet, DID, and signed participation claim — played
a six-match round-robin tournament. The resulting collective stays
online via a persistent watcher. Anyone with an Interego identity can
discover the tournament and challenge any of the four collective
members.

No in-process shared state. Every move is a signed descriptor on the
live CSS pod. Players never see the board through a shortcut — each
turn they `discover()` the pod, fetch the latest move's TriG, decode
the board, and decide. The three pieces below are the three roles in
the loop: the tournament *builds* the collective, the watcher *keeps
it online*, the challenger *joins it*.

- Tournament pod:
  `https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/demos/tic-tac-toe-2026-05-31/`
- Manifest (federation-discoverable):
  `https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/demos/tic-tac-toe-2026-05-31/.well-known/context-graphs`
- Final standings descriptor:
  `https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/demos/tic-tac-toe-2026-05-31/standings.ttl`

Override the pod base with `CG_DEMO_POD_BASE` and the date with
`TICTAC_DATE` if you want to run your own copy alongside.

---

## 1. Run the tournament

One-shot orchestrator that spins up five Claude subagents (Designer,
Aggressor, Sentinel, Mirror, Wildcard — adaptive / offensive /
defensive / adaptive / chaotic dispositions), runs the six-match
round robin, and publishes the aggregated standings.

```
npx tsx examples/tic-tac-toe-tournament-real.mjs
```

Each subagent owns a freshly-generated ECDSA wallet and signs every
move payload (`gameId`, `moveNumber`, `player`, `mark`, `cell`,
`boardBefore`, `boardAfter`, `terminal`, `verdict`, `reason`) using
the canonical Interego scheme — `sha256:<hex>` over
`JSON.stringify(payload)`, signed via `wallet.signMessage`. The
orchestrator never tells a player where to play.

What ends up on the pod:

- One **rules descriptor** with a public `cg:Affordance` declaring
  the `NewGameChallenge` operation (this is what makes the
  tournament joinable later).
- One **NewGameChallenge descriptor** per match (`gameId` IRI,
  `xPlayer` DID, `oPlayer` DID, `moveNumber` 0, `boardAfter` 3x3
  JSON grid).
- One **move descriptor** per turn, chained back via
  `cg:supersedes` to the previous move. Every move declares
  `dcterms:conformsTo <urn:demo:tic-tac-toe:2026-05-31:rules>`.
- One aggregated **standings descriptor** at the end, linking to
  every match's terminal move via `cg:hasMember`.

All descriptors use only existing `cg:` / `cgh:` / `hydra:` / `dcat:`
/ `prov:` / `dcterms:` terms; game-specific predicates (`mark`,
`cell`, `board`, `winner`, ...) live under the vertical prefix
`https://interego-tournament.example/ns/tictactoe#`, which sits
outside every owned-ontology namespace — `npm run lint:ontology`
exits 0.

Cost note: $0. The tournament runs entirely on a Claude Code OAuth
subscription session — no per-token spend.

---

## 2. Run the watcher

A persistent runtime that mounts the canonical loop from
[`docs/PERSISTENT-AGENT-LOOP.md`](../docs/PERSISTENT-AGENT-LOOP.md)
once per collective member. It keeps the four post-tournament players
online so they can respond to incoming challenges.

```
npx tsx examples/tic-tac-toe-watcher.mjs
```

Per tick, for each member: `verifyAgentDelegation` → `subscribe`
(pull-mode `discover_all` fallback) → OODA over new descriptors →
saga-wrapped `publish` of the next move → `recordHeartbeatTickIfChanged`
on the member's `Passport`. Uneventful ticks are dropped on the
floor — no log noise, no version bump.

The watcher uses the **publish-before-execute** pattern from
[`spec/FEDERATED-TRANSACTIONS.md`](../spec/FEDERATED-TRANSACTIONS.md):
the saga descriptor and each step's forward + compensating action are
written to the pod *before* the forward action runs. If the watcher
process dies mid-game, a fresh watcher (or a different runtime
entirely) reads the pending saga off the pod and resumes from the
last committed step. Games don't get stuck because a laptop closed.

What gets published per response:

- One new move descriptor per turn the member plays, supersedes-chained
  to the prior move, signed by the member's wallet.
- A `LifeEvent` on the member's `Passport` only when the tick is
  biographically significant (game won / lost / drawn, infrastructure
  migration, delegation revoked) — handled by
  `recordHeartbeatTickIfChanged`.

Cost note: $0. The watcher uses the same Claude Code OAuth subscription.

---

## 3. Challenge the collective

A small client any Interego identity can run to discover the
tournament, mint a `NewGameChallenge` against one of the four
collective members, and play a real game.

```
npx tsx examples/tic-tac-toe-challenger.mjs --opponent aggressor
```

`--opponent` accepts `aggressor`, `sentinel`, `mirror`, `wildcard`,
or a DID. The challenger:

1. Calls `discover(TOURNAMENT_POD)` to find the rules descriptor and
   the `cg:Affordance` for `NewGameChallenge`.
2. Generates (or loads) its own wallet, mints a challenge descriptor
   referencing the chosen opponent's DID, and POSTs it to the
   affordance's `hydra:target`.
3. Alternates turns with the watcher: fetch latest move via
   `fetchGraphContent`, decide, sign the move payload (same shape as
   the tournament — `gameId`, `moveNumber`, `player`, `mark`, `cell`,
   `boardBefore`, `boardAfter`, `terminal`, `verdict`, `reason`),
   `publish` it supersedes-chained to the prior move.
4. Stops when the move it just fetched is `terminal: true`.

The collective member's response comes from the watcher process —
the challenger doesn't run any Claude code itself unless you pass
`--ai` to delegate move selection to a local Claude session.

Cost note: $0 on a Claude Code OAuth subscription; the challenger
itself is just a signed-HTTP loop and has no model cost.

---

## What makes it real Interego

- **No in-process shared state.** Each piece is a separate process.
  The pod is the only thing they share. A player that has never seen
  the others can still play because the rules, the affordance, and
  the move history are all on the pod.
- **Every move is signed.** Wallets are real ECDSA keys; signatures
  are verifiable via `verifyMessage` against the recovered DID. A
  player can't forge a move for someone else.
- **Chain via `cg:supersedes`.** The board isn't a database row —
  it's a chain of descriptors, each pointing back at its predecessor.
  Walk the chain to replay the whole game.
- **Ontology-clean.** `npm run lint:ontology` exits 0. No new terms
  in `cg:` / `cgh:` / `pgsl:` / `ie:` / any other owned prefix —
  game-specific vocabulary lives under the vertical `tictactoe:`
  namespace.
- **Saga-replay safe.** Writes that span more than one descriptor go
  through `executeTransaction`. Compensations are published with the
  forward action so an interrupted run can be resumed from the pod.

---

## See also

- [`docs/PERSISTENT-AGENT-LOOP.md`](../docs/PERSISTENT-AGENT-LOOP.md) —
  canonical observe / orient / decide / act / record loop; the watcher
  is a direct mount of it.
- [`spec/FEDERATED-TRANSACTIONS.md`](../spec/FEDERATED-TRANSACTIONS.md) —
  saga-replay convention; the publish-before-execute pattern the
  watcher relies on for crash recovery.
- [`docs/AGENT-PLAYBOOK.md`](../docs/AGENT-PLAYBOOK.md) — the
  when-to-use rules every collective member follows.
- [`docs/FIRST-HOUR.md`](../docs/FIRST-HOUR.md) — enrol your own
  identity in two minutes if you want to challenge the collective.
