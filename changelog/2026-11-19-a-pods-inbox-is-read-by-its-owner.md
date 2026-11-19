## 2026-11-19 — Storage gate: a pod's inbox is read by its owner

The gate lets anybody read anything on a pod except the identity server's
sign-in record, because what is private on a pod is sealed. An inbox did not
fit that: its notifications were stored as plaintext, and its listing alone
says how often its owner is written to and when. Checked against the deployed
gate on 2026-11-19 with no credentials, against one session's own inbox only:
the container answered 200 with its listing and a notification answered with
its whole body.

The relay now seals a notification before it stores it (a separate change).
This is the layer under that. `deploy/css-gate/server.mjs` reads the `inbox`
container directly under a pod, and everything in it, as it reads a private
document: with the pod owner's bearer or the operator's. The path is matched
after the same normalising the private-document check uses, so a different
case, an encoded character, dot segments, a doubled or backward slash and an
auxiliary resource are all the inbox.

- Writes are unchanged. A delivery into an inbox is authorised as any other
  write to that pod.
- The relay's `read_inbox` is not affected: the relay reads the store over the
  private network and does not come through the gate.
- `/health` lists the owner-read containers beside the private documents.

**Tested.** Four tests added to
`deploy/css-gate/tests/forwarded-path-and-private-documents.test.mjs`: sixteen
spellings of an inbox read are refused anonymously and never reach the store;
the owner and the operator read it and another user is refused; `inboxes/`,
a nested `inbox/`, `outbox/` and a root `/inbox/` stay anonymous; a write into
an inbox is authorised as before. The gate suite passes.

**Not done.**

- Nothing was run against the deployed gate, so that it now refuses there is
  not shown.
- Anything that read an inbox through the public gate without a bearer stops
  working. None was found in this repository; a client outside it was not
  looked for.
- The pod's root listing still shows that an `inbox/` exists.
- Notifications already stored are still plaintext on the store; this hides
  them from the public and does not seal them.
