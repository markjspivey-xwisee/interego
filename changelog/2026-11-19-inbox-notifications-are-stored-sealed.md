## 2026-11-19 — Relay: an inbox notification is stored sealed

`notify_agent` wrote each notification into the recipient's inbox as plain JSON.
The store serves reads to anybody, by design: on a pod, confidentiality comes
from encryption, and `publish_context` has always sealed what it writes. The
notification path did not. Checked against the deployed gate on 2026-11-19 with
no credentials, and against this session's own inbox only: the inbox container
answered 200 with its listing, and a notification answered with its sender,
summary and whole body.

A notification is now written as an envelope (`deploy/mcp-relay/agent-mesh.ts`:
`sealNotification`, `sealedEnvelopeOf`, `unsealedNotification`).

- **Inside the envelope:** the sender, the activity type, the summary, the body,
  what it is about and what it replies to.
- **Outside it:** the notification's own URL, the recipient and the time, which
  listing and ordering need, and a fixed outer type. The object is an
  `iep:EncryptedValue` carrying `iep:envelope`; no term is added.
- **Sealed to:** the relay's own key, and every key the recipient pod's registry
  lists for an unrevoked agent, so a recipient that holds its own key can open
  the envelope without the relay.
- **Opened by `read_inbox`** with the rule the relay already applies to its own
  key: only for the authenticated owner of the pod the envelope was fetched
  from. A notification the reader has no key for is listed as unopened, with no
  sender and no body.
- A notification that cannot be sealed is not written in the clear instead.
- A notification stored before this change still reads as it did.

A send now makes one more request to the store, a read of the recipient pod's
registry. `tests/the-writers-are-gated.test.ts` pinned the count at two and now
pins it at three, and checks that what the booted relay wrote is an envelope.

**Tested.** `deploy/mcp-relay/tests/sealed-notifications.test.ts`, 18 checks
against an in-memory store with keys made in the test: the stored bytes carry
none of the sealed fields; the relay key and a recipient's own key each open
it; a stranger's key, no opener and a throwing opener each list it unopened;
the relay's key rule opens it for the pod's owner and not for another user or
a caller with no pod; an unsealable notification writes nothing; the plaintext
cannot rename or re-date its resource; an older plaintext notification still
reads.

**Not done.**

- Nothing was run against the deployed relay. No test sends a notification
  through a booted relay and reads it back as the recipient: the fixture that
  boots the relay does not model inbox listings.
- The relay holds a key for every notification, so the relay can read them.
  Only a recipient that registers its own key gets a copy the relay did not
  need to open, and the relay's wrap is still there.
- The inbox listing, and each notification's recipient and time, are still
  readable by anybody.
- Notifications already stored are still plaintext.
- The other delivery channels (Discord, Telegram, email and the rest) are sent
  what they were sent before.
