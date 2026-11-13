# A course player for any published or hosted course

Layer: vertical application. This composes the cmi5 launch the bridge already runs and the
Interego guest the learning account already signs in. It adds no protocol term, no new kind of
account, and no course of its own.

The page is `GET /learn?course_id=<the course's id>`. An optional `au_id` names one activity in
that course. A browser that opens `GET /scorm/packages/<sha-256>` (Accept: text/html) or
`GET /content/au/<publish id>/<index>` with no cmi5 launch parameters is sent there. A request
that already carries `endpoint`, `fetch` and `registration` is the activity itself and is not
redirected. A client that asks for JSON still gets the package record.

The title, the description and the activities come from the course record. Nothing on the page
is written for one course.

## What a Start does

Start asks the person to agree to the recording. Without that agreement `POST /learn/launch`
answers `400 player_consent_required` and nothing is launched.

The learner is whoever the learning account already has (`/i2idlx/learning/session`):

- No session, and guest sign-in is on: the page runs the same browser-key sign-in as the
  workbench (`i2idlx/app/src/learning-guest.js`). Identity creates or resumes a provisional
  owner (`u-try-play-`) for that key. The identity token is not stored. If identity requires
  its hosted terms, the page asks for those before the guest is created, as that sign-in
  already does.
- An existing owner: `Sign in with an existing Interego account` is the learning account's
  OAuth start, and it returns to this page (`next` is only a `/learn` path on this origin).

The launch is `buildCmi5Launch` for that owner's DID, with the bridge as the xAPI account
homePage, the same shape as `POST /agent/cmi5/launch`. The activity URL receives `endpoint`,
`fetch`, `actor`, `activityId` and `registration`. While that attempt is not yet satisfied,
the next Start on the same owner, course and activity continues that registration and session
and only mints a new fetch token. Once it is satisfied, the next Start is a new registration
in Review.

## Keeping the guest, or linking another owner

Adding a passkey, wallet or DID to the guest is identity's add-device flow. **Keep this guest**
asks identity for a fresh token for the key this browser already holds (the same owner again)
and opens `<identity>/connect?claim=<that token>`. The token is not kept in the page or next
to the key, so leaving for the activity and coming back can still claim. That keeps the same
DID, so the statements already name the right actor.

Signing in as a different existing owner does not rewrite those statements. `POST /learn/link`
requires that owner session and a fresh proof from the guest key identity still accepts.
It records the link, copies which activities the guest has satisfied onto the owner, and
stores one statement by the owner that points at the guest and at the original statement ids.
Reads of either actor return both (`alsoAgents` on the statement query). Admin actor counts
use the owner. The stored guest statements are unchanged.

`POST /learn/forget` voids the guest's statements on this bridge (the statement body is not
rewritten; the record is marked voided) and drops the link and the open attempts. Closing the
guest account itself is identity's `POST /users/me/delete`, which the page calls with the
token when it still has one.

## What was already here

| Piece | Where | Used for |
| --- | --- | --- |
| Provisional owner (`u-try-play-`), browser P-256 key, deadline, admission cap | `deploy/identity/provisional-play.ts`, `PROVISIONAL-PLAY.md` | The guest. This player does not mint another kind of account. |
| Guest sign-in on the bridge: grant, challenge, session, HttpOnly cookie | `src/i2idlx-learning-auth.ts`, `i2idlx/app/src/learning-guest.js` | Start, and the proof a link requires. |
| Hosted terms before a guest is created | identity's `428 hosted_terms_required` | Agreement to the account, separate from the recording checkbox. |
| OAuth sign-in for an existing owner | `GET /i2idlx/learning/oauth/start` | "Sign in with an existing Interego account". `next` may be a `/learn` path. |
| Add-device claim of the same owner | identity `GET /connect?claim=` | A passkey, wallet or DID on the guest. The DID does not change. |
| cmi5 launch, fetch token, moveOn, satisfaction | `src/cmi5-lms.ts` | The tracked launch. `reissueCmi5Fetch` continues an open registration. |
| Guest creation limits | the learning guest grant's own limiter, and identity's admission cap and rate limits | How many guests can be created. |
| Unclaimed-guest expiry and deletion of the pod | `PROVISIONAL_PLAY_TTL_SECONDS` (default 24 hours, at most 7 days) and identity's janitor | There is no second clock here. A 90-day Foxxi expiry would fight that cap. |
| Account deletion | `POST /users/me/delete` | Closing the guest owner. |

## What was added, and why

The course page, the recording agreement, the resume book, and the link between two actors
were not there.

- `GET /learn`, `POST /learn/launch`, `POST /learn/link`, `POST /learn/forget` (`src/cmi5-player.ts`).
  The launch and the others are limited with `express-rate-limit` (`course-player-launch`, 30
  a minute by default).
- A browser opening a hosted package or a published activity with no launch parameters is
  redirected to that page.
- `reissueCmi5Fetch` and `copyLearnerSatisfaction` in `src/cmi5-lms.ts`. The launch always
  minted a new registration; an open attempt could not be continued.
- `alsoAgents` on a statement query, and the actor-count alias (`src/actor-alias.ts`). The LRS
  did not know that two actors were one reader, and the statements must stay immutable.
- The open attempts and the links are kept at `{tenant pod}/foxxi-lattice/cmi5-player.json`
  when the bridge has a tenant pod, the same kind of JSON file the other lattice indexes use.
  A read that fails is not followed by a write.

Phone verification was not added. Identity has no SMS or OTP enrollment for a `tel:` name.
The relay's Twilio path sends a notification to a number already declared; it does not check
a code. A phone credential, if identity grows one, is enrolled by the same add-device claim.
There is no separate hook that pretends to send a code.

## Deploy

No new required setting. Guest start is the workbench's guest, so it is off until that is on
(`i2idlx/LEARNING-CONNECTIONS.md`, "Guest learners"): `FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY`,
the service account, and this bridge's origin in identity's `PROVISIONAL_PLAY_CLIENTS`.
Signing in with an existing account needs the learning account's identity, relay and pod
origins, which that same setup already names. The player book is written on first use when
`FOXXI_TENANT_POD_URL` is set.

Redeploy the foxxi-bridge service. Identity, the relay and the gate do not change.
