## 2026-11-19 — Foxxi: a launched unit asks the LMS for a live voice call

A unit that is a conversation by voice, with a speech model answering aloud, needs
a call placed with a speech service. That service's key belongs to a practice
service, and a unit in a browser holds only its cmi5 credential, which only the
LMS can check.

`POST /cmi5/live-call` is where the unit asks, sending the scenario it plays and
the WebRTC offer its browser made. The LMS checks the credential and the session
(open, launched Normal), and asks the practice service, signing with its own key,
as `GET /cmi5/reviewed` does for the reviewed result. The practice service places
the call; what comes back to the unit is the speech service's answer to its
offer. The unit is handed no credential for the speech service. Only fields the
route knows are passed on. No audio passes through the bridge.

Set with `FOXXI_LIVE_CALL_URL`, `FOXXI_LIVE_CALL_POD` and `FOXXI_LIVE_CALL_ACTION`;
without them the route answers 501. Nothing asks this route yet: the unit that
carries a call is not built.
