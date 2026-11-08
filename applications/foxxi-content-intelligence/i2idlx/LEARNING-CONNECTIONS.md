# Enrolled learning in Ask

The learning account is the human using Ask. Pairing an AI agent does not sign
that person into their LMS or authorize student records. Each institution
connection and account link is selected at runtime; no SCORM Cloud application,
learner or administrator is configured in deployment variables.

This interface uses the canonical Foxxi Ask origin. Its host-only secure session
cookie is not shared with separately hosted static copies of the workbench.

## Setup and use

1. Use **Your learning account** to sign in through Interego's normal OAuth
   flow. Ask receives an opaque secure cookie; the relay token stays on Foxxi.
2. A learning administrator opens **Manage learning connections**, supplies their
   own Cloud application credentials, accepts encrypted storage, and chooses
   whether the connection may share course passages and/or progress with AI.
3. The administrator gives intended students its connection code. A student
   requests an account link using their verified Interego account. An optional
   authenticated LTI helper launch can discover that same connection.
4. The administrator matches the pending Interego account against institutional
   records and supplies an actual Cloud registration ID. Foxxi reads that
   registration to obtain its canonical learner ID. The student separately
   activates the association. This is an administrator-approved association,
   not proof derived from a similar email address, name or LTI subject string.
5. The student chooses **Show my enrolled courses**, selects a course, and can
   inspect their own progress without an AI. To ask a private question, pair an
   AI and explicitly choose which context may be shared.
6. **Open course** launches an existing registration after checking the current
   learning account and enrollment again. Source references also identify the
   published file. **Open lesson in course** appears only where the provider
   verifies a supported activity destination and its owner has enabled lesson
   links. A lesson destination does not establish an exact slide or paragraph.

Course, learner, account, version, institution, sharing or AI-recipient changes
clear the private conversation. Failure to confirm access leaves the selected
learning mode blocked. **Use glossary only** explicitly leaves that mode.

## Authorization and retained data

Cloud catalog access with an application key is not student enrollment. Private
reads use the approved canonical learner filter and independently verify each
matching registration's learner, course and version. Enrollment, current human
sign-in and connector policy are rechecked after retrieval, before dispatch to
the paired model and before final delivery. Revocation clears queued prompts,
partial answers and proposed tools. Stream/poll checks can share a check for at
most one second; dispatch and finish always force a fresh check.

Current human revalidation checks both the relay OAuth grant and its backing
native identity token, including the native session epoch. Native verification
uses the existing relay-held introspection secret, never a Foxxi/browser secret,
with bounded time, response size and concurrency and no cached-authority
fallback. Unavailable authority blocks the private task.

Connection credentials, join codes and private identity associations use a
service-owned encrypted Native CAS checkpoint partitioned by workbench origin.
Only the service key is an envelope recipient. Public pod bytes are ciphertext;
storage confidentiality does not rely on a private pod ACL. The service retains
no course text, reusable course graph or progress records in that checkpoint.
Corruption, missing keys, failed reads and uncertain writes fail closed. A true
404 alone means an empty checkpoint. A service restart requires human sign-in
and AI pairing again; it does not discard the encrypted connector registry.

The learner source path reads bounded native course files in request memory,
without a ZIP export or retained text/graph. This is virtual source access with
transient selected bytes, not a promise that no byte leaves the source. Sharing
passages or progress sends those selected facts to the paired AI client, whose
retention governs earlier copies. Ending a learner link or removing a connector
revokes future access; it cannot erase an already delivered client transcript.
Connector removal first confirms cleanup of its generated LTI resources. Failed
remote cleanup keeps the credential for an explicit retry.

## Course and source-location launch links

Launches are deliberate learner actions, separate from sharing context with an
AI. They work without AI pairing or permission to share course passages or
progress with AI. The server uses the current linked learner's existing Cloud
registration; it does not create a registration or substitute a course preview.
Ambiguous registrations require a known approved registration match or a clear
choice-required response rather than selecting an arbitrary attempt.

The browser sends course/version and an optional opaque location reference,
never a learner ID, registration ID, launch URL or SCORM activity identifier.
The server rechecks human identity, connector/link revisions and current
registration before and after obtaining a short-lived provider launch link.
The link is returned only for immediate navigation from a user click, outside
model context, transcripts and persisted connector state. A blocked popup does
not cause the app to obtain a launch link in the background.

Normal course launches use the provider's normal tracking and course order;
they may record learner activity. The launch-link expiry governs use of the
link, not the lifetime of the opened content session. Ending an account link
blocks future launch requests; already issued provider links and content
sessions remain subject to SCORM Cloud's authorization and expiry rules.

Optional lesson links require the connection owner's explicit
`allowTargetedLaunch` policy, off when absent. Cloud's `startSco` is a manifest
item identifier, not an asset URL, resource identifier or slide bookmark. Only
an authoritative, unambiguous mapping of an actually cited source file to a
launchable activity can produce a lesson reference. Targeting requires multiple
verified SCOs and the selected registration's effective
`WhenToRestartRegistration=NEVER` setting. These links can override normal course
order; owner policy and provider sequencing rules still apply.
File locators and parser fragments are displayed as reference information and
are never converted into guessed player URLs or slide anchors. Where verified
targeting is unavailable, **Open course** remains the supported destination.

Cloud registration launches do not accept a fixed course-version selector.
Owner-configured registration migration can change the played version at
launch. Citation versions remain source evidence, not a promise that Cloud will
play an immutable historical version.

## What SCORM Cloud and LTI supply

Cloud registrations supply observed completion, success, score and tracked time
where present. Cloud `score.scaled` is **0–100 percent**; it is not xAPI's scaled
score range. Observation time means when Foxxi checked the provider, not when
the learner last worked. No progress is inferred from course content.

For this provider, registration presence is the available enrollment authority.
Changes to enrollment in a separate LMS that are not reflected in Cloud are not
discoverable through this connector.

LTI 1.3 verifies a registered issuer/client/deployment and platform subject in a
signed launch. The optional Cloud helper is discovery only, never evidence of
enrollment in the original course. A verified launch is bound to its initiating
browser, followed by independent Interego sign-in and explicit CSRF-protected
link request. State, nonce and discovery receipts are short-lived and one-use.
Cloud's public API does not document a reliable conversion from an LTI subject
to its canonical learner ID, so the administrator/learner association remains
required.

Generated helpers use inline player/SCO launch settings and
`Lti13PrivacySettings=NO_LEARNER_INFO`. Setup becomes ready only after Cloud
reports those effective settings for the exact disposable helper. A lost
settings acknowledgement remains pending and is reconciled before another
write; neither the original course nor account defaults are configured.
Previously saved ready helpers without this settings confirmation are shown
as pending and cannot start a new public launch until their owner refreshes
the connection and the effective settings are confirmed.

The separate **Manage course content** owner test opens the generated helper's
native SCORM Cloud course page, using the current connection's application ID.
The owner signs in to Cloud and selects **Launch** in its testing sandbox,
then returns to Ask to check and explicitly attach the verified launch.
This does not identify or enroll a student. API access-token connections
without an application ID instead receive instructions to open the helper in
their Cloud library. The workbench does not create a learner for this handoff
or substitute a Cloud preview. The tested Cloud API preview omitted the course
context; the registered synthetic launch included it and passed the unchanged
context checks. Student discovery continues to require a genuine LMS launch
and the independent administrator/learner association above.

This connector does not fetch NRPS rosters, write AGS grades, or expose a global
learning transcript. NRPS membership and AGS results are context/tool scoped;
they are not a general enrollment, curriculum or prerequisites API. SCORM Cloud
prerequisites and curriculum are explicitly unavailable here. Future providers
must advertise an authoritative source before Ask can answer those questions.

Reference contracts: [Cloud API](https://cloud.scorm.com/docs/swagger.json),
[Cloud users and learners](https://support.scorm.com/hc/en-us/articles/360039781254-SCORM-Cloud-User-vs-Learner),
[Cloud sandbox registrations](https://support.scorm.com/hc/en-us/articles/360029498134-SCORM-Cloud-API-Documentation),
[LTI 1.3](https://www.imsglobal.org/spec/lti/v1p3/),
[NRPS](https://www.imsglobal.org/spec/lti-nrps/v2p0/) and
[AGS](https://www.imsglobal.org/spec/lti-ags/v2p0/).

## Verification boundary

Automated fixtures exercise separate human OAuth accounts, actual HTTP route
composition, native encrypted checkpoint crypto/CAS, provider enrollment guards,
signed LTI verification, and broker dispatch/stream/finish revocation. Provider
and institution fixtures do not prove a live student's identity or enrollment.
A live institution setup requires its administrator's explicit permission,
private credentials and a separately verified student registration association.
