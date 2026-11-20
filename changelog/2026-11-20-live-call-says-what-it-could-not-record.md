## 2026-11-20 — Live call: what could not be recorded is marked, not written as words

A live call's record had three ways of saying more than was known. A line the
learner spoke over was saved whole, as if it had been heard. Speech the
transcriber failed on was saved as the learner's answer "[not transcribed]",
which a judge could read as evidence and quote. And, found in the first live
test on 2026-11-20, a beep was transcribed as "." and saved as an answer, using
one of the scenario's five exchanges. A reviewer in another session raised the
first two independently.

A cut-off line is now marked as cut off; its text is still the whole line the
model produced, because the speech service says where the audio stopped and not
which words were heard. Untranscribed speech is an exchange with a mark and no
answer in it. A transcript with no letter or digit in it is not speech and uses
no turn.

The import carries the marks onto the attempt's turns. A judge sees
`CUT OFF` and `NOT TRANSCRIBED` in the transcript, with no words after the
second, and is told that neither is evidence about the learner and that a
criterion it cannot judge for that reason goes to the reviewer at the lowest
level. The reviewer sees the same marks beside the turns. A mark is part of the
transcript's hash. The judge's prompt changed, so its template hash did.

Also: the player sent a learner's agreement before the visit's `initialized`
when they agreed within a few seconds of the page loading (seen in the same
live test, three seconds apart). Agreeing now waits for the visit to be open, in
the scripted practice as well.

Not tested: a judgment by a real model over a marked transcript, so whether a
model follows the new instructions is not known. Calls saved before this change
keep the earlier form.
