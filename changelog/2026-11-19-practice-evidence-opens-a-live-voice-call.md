## 2026-11-19 — Practice Evidence: an LMS can place a live voice call for a unit it launched

The owner wants practice in the browser to be as close as it can be to a real
call: the learner speaks freely and an AI customer answers aloud. The scripted
player cannot do that; it matches what is said to one of three written replies.

`pev.live_call_session` places such a call. The LMS that launched the unit signs
for the registration and the session, as it does for `pev.launched_statements`,
and sends the WebRTC offer the learner's browser made. The bridge builds what the
speech model is told from the scenario version and takes the offer to OpenAI's
Realtime API itself, with the operator's key; the service's answer goes back to
the browser. Audio flows between the browser and the service and never through
the bridge. No credential for the speech service is handed to anyone, so one
request is one call. Nothing is recorded by placing a call.

The speech service is set with four variables, all or none: the key, the realtime
model, the voice, and the model that transcribes the learner. The bridge names no
model of its own. Calls are limited per registration and in total per hour.

The first form of this change handed the browser a short-lived client secret.
Review pointed out, and the service's reference confirms, that such a secret can
start several sessions before it expires and that its settings can be overridden
by whoever holds it, so it bounded neither the number of calls nor what they
were. It was replaced before it was merged.

Not bounded by this change: a learner who alters the page can still change what
the model in their own call is told, over the call's data channel. Not in this
change: the unit that carries the call, and the LMS route by which a unit asks
for one. No learner can place a call yet.
