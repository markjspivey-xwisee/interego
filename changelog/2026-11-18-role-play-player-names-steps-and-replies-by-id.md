## 2026-11-18 — Role-play player: a step and a reply are named by id, and a reopened practice is tested through the import

A practice opened again part way through is put back together from the exchanges
its earlier load recorded. Each exchange was found again by text: the other
person's line, and the reply's own wording. An edit to either between the two
visits lost the exchange, and the practice could not be carried on.

The sample scenario now gives every step and every reply an id. The player
records the step's on the exchange, in the role-play profile's `step-id`
extension, and the reply's beside the learner's answer, as `pev:replyId`
(declared in `ontology/pev.ttl`, with its published copies). A reopened practice
finds each exchange by those ids. An id the step does not have is not guessed at
from the text. An exchange recorded before this change is still found the old
way, by the recorded reply's text. A scenario that uses an id twice is refused
when it loads.

`tests/roleplay-player-through-import.test.ts` runs the page's two scripts whole
against a stand-in LMS: a practice is closed after two replies, opened again,
finished, and what the learning record holds is read by `readLaunchedCall`, the
function the bridge's import runs. It comes out as one conversation of five
exchanges. The same test shows the import refusing a session with a second
conversation in it, which is what carrying on prevents.

Not changed: which customer a practice was with is still worked out from the
exchanges, not recorded. Other scenarios have no ids until they are given some;
the player treats them as before.
