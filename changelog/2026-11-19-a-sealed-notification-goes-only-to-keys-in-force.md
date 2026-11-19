## 2026-11-19 — Relay: a sealed notification goes only to registry keys in force, and the whole path is tested in a booted relay

Two things left open when sealed notifications landed (#976), and one cleanup.

**An expired or not-yet-valid registry row was still a recipient.** The seal
asked only whether a registry row was revoked. A delegation that ended in 2021
and one not due to begin until 2099 both had new notifications wrapped to their
keys, and both keys opened them. Found in review of #976 and reproduced there
with a mocked registry. `currentRegistryKeys`
(`deploy/mcp-relay/managed-recipient.ts`) now chooses a row only when it is
unrevoked, names a key, says when it began, that time has come, and its end, if
it states one, has not. A start or end that does not read as a time is not a
row in force. The fleet key is never chosen. The pod's own inbox key is
unaffected, so the pod's owner always reads through `read_inbox`.

**No test sent a notification through a running relay and read it back.**
`deploy/mcp-relay/tests/tool-result-size.test.ts` boots the relay against a
store that keeps what is written and lists its containers. It now sends a
notification with `notify_agent`, checks that the bytes the store holds are an
envelope with neither the summary nor the body in them, and reads it back
through `read_inbox` as the pod's owner with its summary, body and sender.

**The scan for a bare `.listen()` excuses no file by name.** #973 let one suite
through because it called a speech recogniser's `listen()`. #974 renamed that
call, so the allowance is removed and a fixture shows a bare `.listen()` in
that file is an offender like any other.

**Tested.** `sealed-notifications.test.ts`, 36 checks: ten more, covering which
rows are chosen, that an expired, future, revoked, undated and unreadably dated
row's key does not open what is sealed now, the start and end boundaries, and a
control showing the rule this replaces did choose the expired and future rows.
`tool-result-size.test.ts`, 125 checks, three of them the round trip.
`listen-loopback.test.ts`, 14 checks.

**Not done.**

- Nothing was run against the deployed relay. That the deployed gate now
  refuses an anonymous inbox read was checked (401 on a listing and on an item,
  2026-11-19, one session's own inbox); that deployed notifications are sealed
  was not, because the bytes are no longer readable without a bearer.
- The round trip is one user notifying their own pod. A second user reading
  the first's inbox through a booted relay is covered only by the unit checks.
- A recipient holding its own registered key is tested at the envelope, not
  through a booted relay.
