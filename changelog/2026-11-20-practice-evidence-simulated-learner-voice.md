## 2026-11-20 — Practice Evidence: a simulated learner voice, to try a scenario out

The owner wants to see and hear a live call with nobody on the line: two voice
models talking to each other, as if two phones in voice mode were held side by
side. The scenario's other person is already a speech model. Nothing could put
one in the learner's place without the operator's speech key, which no browser
is given.

`pev.simulated_learner_session` places one. An author or an admin signs for a
scenario version, a voice and a WebRTC offer; the bridge places a call in which
the model is told the learner's part, goal and situation (not the rubric), and
waits to be spoken to. The answer is the speech service's answer to the offer.
No credential is handed out and nothing is recorded. It counts against the
hourly call limit, per signer.

The bridge does not join the two calls. Whoever asked wires each one's audio to
the other. What a simulated learner says is not evidence of anyone's skill: the
call it joins is to be launched as an agent test, which the role-play player
writes into what it records.

Not tested: against the speech service; two models actually holding a call.
