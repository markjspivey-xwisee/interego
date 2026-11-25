## 2026-11-25 — Foxxi: a hosted cmi5 unit starts, and a delegate can learn as itself beside its person

Both found by hosting exported packages on the deployed bridge and opening their
launches in a browser.

- **A unit of a hosted cmi5 package fetches its own auth-token.** Every document
  a hosted package serves used to get the whole sandbox bootstrap, which fetches
  the token for the SCORM runtime. A cmi5 unit fetches it too, and the fetch URL
  is good once (cmi5 8.2), so the unit's own fetch was answered 401 and no hosted
  cmi5 unit could start. A package with a cmi5 course structure and no SCORM
  manifest now gets only the stand-in for web storage. SCORM documents are served
  as before.
- **`learner_kind: "agent"` on the signed cmi5 launch.** A delegate's launch was
  always recorded as its person's. A delegate that says it is the learner is now
  the actor, with its own registration, progression and `satisfied`, and nothing
  is written to the person's record. Its person is named in `context.team`, which
  the LMS puts in the cmi5 context template so any unit records it; no term is
  minted. The record is kept on the person's pod. Without `learner_kind` a
  delegate's launch is still the person's. The launch answers with the person's
  and their agents' registrations on the course.

Not done, and listed in `AGENT-COLLABORATION.md` section 6: assignment for
delegates, the LTI and credential routes, reaching other people's agents, and
consulting for a person and their agents as a team.
