## 2026-11-19 — Practice Evidence: an LMS can open a live voice call for a unit it launched

The owner wants practice in the browser to be as close as it can be to a real
call: the learner speaks freely and an AI customer answers aloud. The scripted
player cannot do that; it matches what is said to one of three written replies.

`pev.live_call_session` opens such a call. The LMS that launched the unit signs
for the registration and the session, as it does for `pev.launched_statements`.
The bridge builds what the speech model is told from the scenario version and
asks OpenAI's Realtime API, with the operator's key, for a client secret good for
starting one call in the next two minutes. The browser connects to the speech
service itself; audio never passes through the bridge, and the operator's key
never leaves it. Nothing is recorded by opening a call.

The speech service is set with four variables, all or none: the key, the realtime
model, the voice, and the model that transcribes the learner. The bridge names no
model of its own. Calls are limited per registration and in total per hour.

Not in this change: the unit that carries the call, and the LMS route by which a
unit asks for one. No learner can place a call yet.
