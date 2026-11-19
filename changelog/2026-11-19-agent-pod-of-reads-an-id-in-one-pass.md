## 2026-11-19 — Core: `agentPodOf` reads an agent id in one pass

`agentPodOf` (`packages/core/src/model/delegate.ts`) took the pod out of
`…agents:<surface>-<pod>` with `/agents:[a-z0-9-]*?(u-[a-z0-9-]+)$/i`. On an id
that does not end in a pod the engine retried the lazy prefix from every `u-`
it had passed, so `agents:` followed by a long run of `u-` and one character
outside the class cost time in the square of its length. An agent id is text
another party writes. CodeQL reported it on #973, where a new caller passed
caller-supplied text to it; that call was removed there and the pattern left.

It is now read by hand in one pass: the tail after the last `agents:`, all
letters, digits and hyphens, taken from its first `u-` that has something after
it. The `/users/<pod>/profile` reading is unchanged.

**Tested.** `tests/core-delegate.test.ts` holds the new reading to the old
pattern's answer on 24 ids, including ones that end in `u-`, carry two
`agents:`, or contain a letter whose lowercase form is longer; and gives it
`agents:` plus 200,000 `u-` and a `!`, which must answer within a second. The
existing delegate suites pass unchanged.

**Not done.** No other pattern in the file was examined.
