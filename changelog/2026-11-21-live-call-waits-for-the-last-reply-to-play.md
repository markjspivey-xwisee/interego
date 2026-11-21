## 2026-11-21 — Live call: the call waits for the last reply to play, and a truncation at nought is not "heard"

Two things from a review of the live-call page by another session.

At the scenario's limit the page closed the call when the other person's last
reply had been generated. That event arrives while the reply is still being
played, so a goodbye could be cut short. The page now waits for the speech
service to say that reply's audio is finished, and closes after twelve seconds
where the service does not say. Only the audio of the reply that ended the call
releases it. Hanging up by hand is still immediate.

A reply the learner cut in on was counted as heard whenever the service sent a
truncation for it. A truncation that says the audio stopped at nought is now
read as never heard, like no truncation at all. One with no usable figure is
still read as heard. This is the service's account of its own buffer, and the
README says it is an inference, not a measurement.

Not tested against the speech service: whether it sends the audio-finished
event in the form the reference gives, which is why the bounded wait is there.
