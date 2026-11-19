## 2026-11-19 — Core: admitting a delegate's receipt can require the delegation its principal signed

`admitDelegateReceipt` (#973) reads a signer's standing from the delegate row on
the principal's pod. That row is a document. Only the pod's owner is meant to
write it, but whoever operates the store or the relay can write it too, and so
can anything holding a write on that pod. The `agent-collective` request gate
has refused to rest on that row since it was written: it reads the delegation
credential the owner signed.

A caller can now ask the same of a receipt. `ownerSigned` is an optional port
on `admitDelegateReceipt` (`packages/core/src/model/delegate-receipt.ts`) with
the result shape of `verifyDelegation`. When it is supplied, admission also
requires that it answer valid, cryptographically verified, and for the expected
principal. A throw, or an answer that is none of those, is a refusal or a
"not established", and never a pass. When it is omitted, standing rests on the
row as before, and the standing line now says so.

The row is still read either way: a signed credential says the principal
delegated, and the row is where a revocation shows.

**Tested.** `tests/core-delegate-receipt.test.ts`, 34 cases, eight new:
admitted when signed; a line saying standing rests on the row alone when it is
not asked for; refused for no valid credential, a recorded-but-unsigned one and
one from another owner; a throwing or empty check is not a pass; a missing
credential does not use up the receipt's nonce; and one case through the
substrate's own `verifyDelegation` with a credential signed by a real key,
where a credential signed by another key is refused even when its proof block
names the principal's address.

**Not done.** Nothing was run against a deployed service. No caller passes
`ownerSigned` yet. How a principal's signed credential is published and fetched
for a real worker is not addressed here.
