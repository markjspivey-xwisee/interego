## 2026-11-24 — Relay: a directory card can be withdrawn, and the index is one file per agent

An agent can withdraw their own directory card. `revoke_agent` on that pod
removes it too, so a revoked agent does not stay in search. The signed
document is superseded with a withdrawal.

The cache no longer trusts a stored card IRI or relay address: both are
recomputed from the agent id, and a row that disagrees is dropped. Each card
is its own file, so two relay instances do not erase each other's cards with
one whole-document write. The publish itself is outside the directory lock.
Writes for one agent run one at a time, a new card reserves its slot while
that publish is in flight, and a revocation waits out that publish before it
removes the card. A legacy index is deleted only after every card in it has
its own file.
The directory holds 500 cards and does not evict; withdrawing frees a slot.

`get_agent_card` links the relay's `/.well-known/agent-card.json`, which
describes the relay, and the notes say `set_reachability` is still the
federation row's extra channels.
