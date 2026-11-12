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
   whether the connection may share course passages, progress and separately
   released submitted quiz review with AI. Review is off on existing connections.
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
no retrieved course bodies, reusable source graph or provider progress records
in that checkpoint.
Optional owner-authored learning maps and private notification configuration
are metadata in the same encrypted checkpoint, with course-version and owner
binding. Notification receipts contain a timestamp, not learner answers.
Deletion or revocation removes the affected maps, links and credentials from
active configuration and stops future authorized use. It does not physically
erase older encrypted storage versions; reclaiming those unreferenced storage
nodes requires separate storage cleanup.
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

## Guest learners (off unless a grant signer is configured)

A learner can also arrive as a provisional guest (`deploy/identity/PROVISIONAL-PLAY.md`): an owner
the identity service creates for a P-256 key this browser generates, cannot export, and keeps in
IndexedDB. Possession of that key is all a guest proves. It does not identify a person.

Guest sign-in exists only where the workbench is given a `guestGrant` signer, which signs grants as
Foxxi's registered service agent. The bridge wires none today, so `/i2idlx/learning/session` offers
no `guest_sign_in`, the three guest routes answer `503 learning_guest_unavailable`, and nothing
below is reachable in production. Turning it on also needs Foxxi's origin, service agent and pod in
identity's `PROVISIONAL_PLAY_CLIENTS`; both are operator steps.

The flow, all under `/i2idlx/learning/guest/`, each requiring the workbench's own `Origin`:

1. `POST grant` with `{publicKeyThumbprint}` returns a grant for that key, which the browser signs
   and posts to identity's `/play/provisional` itself. The identity token in that answer is never
   read or stored; only the attestation (public proof material) is kept beside the key.
2. `POST challenge` returns a single-use challenge, valid two minutes.
3. `POST session` with `{attestation, challenge, proof}`: the workbench consumes the challenge, asks
   identity's `/play/provisional/verify` whether this is a live guest of this application, checks
   every canonical field of the answer again (issuer, audience, `u-try-play-` owner, DID, WebID, pod),
   and sets the same HttpOnly session cookie as a normal sign-in.

The workbench holds no relay or identity credential for a guest. It keeps the proof it was shown and
repeats the identity check when a request arrives more than 30 seconds after the last one, so a
guest that was deleted, expired or claimed away stops within that window; the session also ends at
the guest's fixed deadline and never lasts more than an hour. A returning guest signs in again with
its stored attestation and a fresh proof, without spending a new grant.

A guest is a learner and nothing else. `auth.resolve()` refuses a guest session unless the route
opts in, so a route nobody decided about is closed to guests. What is open:

| Open to a guest | Closed to a guest (`403 learning_guest_refused`) |
|---|---|
| `request-link`, `discover`, `my-links`, `confirm-link`, `revoke-link` (its own) | creating or revoking a connector, policies, course maps, `pending-links`, `approve-link`, LTI setup |
| `courses`, `progress`, `course-readiness`, `quiz-review` | progress notifications (a subscription would outlive the guest) |
| `/i2idlx/api/learning/launch` | `/i2idlx/api/learning/context` (needs a paired agent, which a guest cannot register) |

An administrator still decides whether a guest is a learner at all: a link is `pending-admin` until
the connection's owner matches it to an actual registration, and the owner sees the requesting
account's `u-try-play-` WebID when doing so. A link belongs to the guest's owner DID, so a guest
that later adds a passkey or wallet to the same owner keeps its links and signs in the normal way.

This is separate from the dashboard's "Start as a guest", which makes a secp256k1 wallet in the tab
and signs requests to the Foxxi bridge as `did:ethr:`; that guest has no identity account and no
learning account, and cannot use these routes.

## Course readiness and released quiz review

Select a course and explicitly check its readiness. This verifies current
enrollment and reads a bounded instructional sample; it does not promise every
file in a course is readable. The panel distinguishes readable content, actual
released submitted results, course versus lesson launch support and the time
evidence was observed. A visible quiz does not guarantee the course reports
interaction data. Unchecked and unavailable states are explicit.

Quiz review requires all three choices: the connector owner permits AI review,
the owner releases mapped question labels for the exact course version, and
the learner chooses to share their released review with the paired AI. Only
the learner's independently authorized registration is read. Provider interaction
IDs must match the released map; unlisted questions and in-progress activities
are omitted. Result, own response and supplied provider timestamp are projected
without `correctResponses`, hidden question descriptions, runtime blobs or
suspend data. Owner response labels are attributed presentation metadata.

For SCORM 1.2 a provider runtime `passed` or `failed` lesson status can establish
a terminal submitted activity without establishing overall course completion.
Unknown, numeric and unanticipated results are not regraded. Journaled records
remain in provider order rather than being turned into an invented attempt
history. Review is question-specific context, not a separate assessment service.

When a released item maps to an instructional file, retrieval prioritizes that
safe listed file while retaining existing file limits and assessment exclusions.
Only actually returned instructional citations receive navigation references.
The browser validates released review from that same model-bound context and
passes the original context unchanged, preserving its authorization receipt.
The AI can explain supplied results and teach from those passages; it cannot
recover hidden grading logic or claim eligibility, mastery or passing.

## Owner learning maps

The owner selects a current Cloud course/version, loads its map and previews
strictly validated JSON before explicitly saving. The map can declare bounded
instructional locations, released interaction labels, objectives, competency
IRIs, required or recommended prerequisite relationships and a suggested
curriculum sequence. Referenced IRIs are identifiers and are never fetched.
Source fragments are advisory references, not guessed slide launch URLs.

Each snapshot records the authenticated connector owner, connector, course
version, save time, random revision and canonical SHA-256. Replacement/deletion
requires the expected revision. These statements are visibly owner-supplied;
they are neither SCORM Cloud assertions nor inferred evidence of another course's
completion. A map never grants enrollment. Saving/deleting it invalidates older
question receipts and lesson references. Deleting it ends future quiz release
without erasing an earlier AI-client transcript.

## Optional progress notifications

The owner may permit progress notifications, then a learner explicitly enables
them for a selected existing registration. Configuration is registration-only;
no application defaults, other learners or deployments are hardcoded or changed.
An existing unrelated postback configuration is refused rather than overwritten.
Callbacks use a private per-link secret and a fixed HTTPS Foxxi endpoint.
Setup explicitly selects JSON on that registration and verifies the effective
setting values and their registration source, including Cloud responses that
omit a separate explicit-value field. Saved JSON-override intent alone does not
prove ownership of an otherwise unrelated JSON setting. Ambiguous settings stay
unchanged for owner review. Cleanup keeps this feature's matched URL in place
until its matching credentials and format settings are removed, then removes
the URL last; it never submits the empty values Cloud rejects.

An authenticated callback is a refresh signal. The receiver independently reads
Cloud and verifies the current linked learner, course and version before saving
only its receipt time. Incoming completion/score payloads are not authoritative
and are not retained. No Interego inbox, email or other notification recipient is
added. Status and Refresh show current provider observations separately from the
last callback time. Disable and revocation remove only this feature's matching
remote settings; cleanup failure is explicit and retains configuration for retry.

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
provider prerequisites and curriculum are explicitly unavailable here. An owner
learning map can supply separately attributed course requirements or suggested
study order; it must not be described as provider evidence or confirmation that
the learner has satisfied those requirements. Future providers must advertise
an authoritative source before provider-level claims become available.

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
