## 2026-11-20 — Live call: the last exchange waits for the end, and a reply nobody heard is left out

A reviewer in another session replayed the player's logic and found that, with
one exchange left, a reply cancelled because the learner was still speaking
ended the call, and the first half of the learner's sentence was saved as a
whole, unmarked answer.

Two changes. A reply the speech service cancels before any of its audio has
played was never heard: it is now no line in the record and no longer divides
what the learner was saying into two answers. (#988, hours earlier, had marked
such a reply as a line that was cut off.) And the last exchange the scenario
allows is written when the call ends, not as soon as a reply follows it: the
call does not end on a cancelled reply, and if the learner said more than the
scenario has exchanges to hold, the last answer is marked as not all that was
said.

"Never played" is read from the service sending no truncation event for a line
it cut, which is what two recorded calls showed; it is not a documented
guarantee. An exchange is now written once the reply after it has ended, a
moment later than before. A page closed between the last answer and the end of
the call loses that last exchange.

A side effect seen in the earlier real calls: an answer the service split at a
pause, with a reply begun and cancelled in between, now counts as one exchange
and not two.
