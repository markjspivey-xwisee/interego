## 2026-11-19 — Core: a delegate signs its own receipt, and admitting one keeps four questions apart

A delegate that keeps its own key, account and pod had no way to hand back
signed evidence of assigned work that the assigner could check without the
relay. Every signature the relay adds is made with the relay's key, and the two
existing checks answer other questions: `checkDelegation` is a write verdict on
the delegator's pod, so it says no to a `ReadOnly` delegate, and
`judgeAuthorship` is relative to the owner of the log a record sits in and
takes the signer as already verified.

`@interego/core/delegate-receipt` (`packages/core/src/model/delegate-receipt.ts`)
adds the receipt and its admission:

- `delegateReceiptBody`, `signDelegateReceipt`, `receiptText`, `digestOf`: a
  fixed set of fields, signed over their canonical JSON. The signature scheme
  is a named field; `eip191-secp256k1` is the one that exists.
- `admitDelegateReceipt` reports, one line each: the signature against the key
  bound to the named agent; the agent's current, unrevoked place among the
  principal's delegates, read from the principal's own pod with
  `readDelegates` and without consulting its scope; the footing the receipt
  states, held to the expected principal; and that the pod it was read from is
  the pod it says it is kept on. It also holds the receipt to the expected
  assignment digest, an age limit, and a ledger that admits a receipt once.
- Signing, recovering and resolving an agent's key are ports, so the module
  imports no signing library and loads in a browser bundle.

**Tested.** `tests/core-delegate-receipt.test.ts`, 26 cases with keys made in
the test: admission for `ReadOnly` and `DiscoverOnly` delegates where
`checkDelegation` says no; refusals for an unseated, non-delegate, revoked,
expired or not-yet-started signer, an unreadable roster, a roster on somebody
else's pod, a wrong key, a changed body, an unbound key, own-account footing,
another principal, the wrong pod, another assignment, a stale or future date
and a second presentation; and one two-party run with sealed envelopes in
which each side writes only to its own in-memory pod.

**Not done.** Nothing here was run against a deployed relay, identity service
or pod. A `did:web` delegate id does not state its key, so a caller must
supply `resolveAddress`; none is provided. `MemoryReceiptLedger` forgets on
restart. No caller uses the module yet, and it writes no Turtle.
