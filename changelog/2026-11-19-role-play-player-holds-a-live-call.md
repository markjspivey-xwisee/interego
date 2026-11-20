## 2026-11-19 — Role-play player: a launch can ask for a live call with an AI speech model

The owner wants practice in the browser to be as close as it can be to a real
phone call: the learner speaks freely and an AI customer answers aloud. The
scripted practice matches what is said to one of three written replies.

Launched with `call=live`, the role-play player now holds a live call instead.
It asks for the microphone, makes a WebRTC offer and sends it to the LMS that
launched it (`POST /cmi5/live-call`, with the session's cmi5 credential); the
practice service places the call with the speech service and the page is handed
that service's answer, and no credential. Before the call the learner is told,
and agrees to, what it is: an AI speech model on the other end, the microphone's
audio sent to the speech service for the call, and the transcribed text of both
sides saved.

Each exchange is written to the learning record as text once it can no longer
change: what the other person said, and what the learner answered, as the
service transcribed them. The call ends when the learner ends it, at the
scenario's turn limit, at a time limit, or when the connection drops. Nothing is
scored and no result is sent: the registration is taken as an unscored
conversation, judged, and reviewed by a person, as before.

One registration holds one call. A page closed during a call ends it, and
opening the course again places no second one. A later visit to a course whose
first visit held no call is offered none either: the import reads the first
visit, so that call could not be reviewed.

The scripted practice is unchanged for a launch that does not ask for a live
call. The sample scenario gains a `ui.liveCall` block naming the service's data
channel, the service as the learner is told of it, and a ten-minute limit.

Not tested: a call against a real speech service. The page was run in Chrome
over a real WebRTC connection against a second page standing in for the service.
No course launches the player this way yet.
