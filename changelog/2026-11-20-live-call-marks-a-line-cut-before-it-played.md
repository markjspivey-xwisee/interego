## 2026-11-20 — Live call: a line cut in on before it played is marked cut off

A spoken test call against the real speech service saved the customer's line as
"Hold", unmarked. The learner had started speaking again before any audio of the
reply had played. The player marked a cut-off line from the service's
`conversation.item.truncated`, which is sent when playing audio is stopped; with
nothing yet played, the service sends none. It ends the line's item `incomplete`
and its response `cancelled`, after sending a transcript of what little there
was, and the player had read that transcript as a finished line.

A line is now marked cut off on any of the three: the truncation, the item
ending incomplete, or the response ending other than completed. The events were
recorded from a second real call the same day and the test replays them in
their order.

Seen in the same calls, and working as written: a line stopped part way through
its audio was marked; an utterance the service split in two was joined into one
answer when nothing came between; the judge (OpenAI's gpt-4.1) scored an
imported call with quotes the platform verified.
