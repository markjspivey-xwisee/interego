# A guest their browser keeps

Layer: vertical application (non-normative). This composes the deployment's provisional owners
(`deploy/identity/PROVISIONAL-PLAY.md`); it adds no protocol term and changes none of identity, the
relay or the storage gate.

## What it does

The dashboard's "Start as a guest" makes a wallet in the tab and signs every request to the bridge
with it (`dashboard-app/src/auth/session.ts`, `connectAsGuest`). The key is never written to
storage, so a reload loses the guest unless they wrote down the recovery phrase.

With this turned on, the sign-in page also offers **Keep this guest in this browser**. When the
guest ticks it:

1. The browser makes a P-256 key whose private half cannot be exported, and asks the bridge for a
   grant naming that key (`POST /play/grant`).
2. The browser presents the grant and a proof made with the key to identity
   (`POST /play/provisional`), which admits a provisional owner: an account with a pod of its own
   and a fixed deadline (24 hours by default).
3. The browser seals the guest's recovery phrase to an X25519 key, and writes the sealed document
   to the one path the guest's token may write
   (`<pod>/<namespace>/checkpoints/<sha256>.json`, kind `player-profile`). The X25519 secret is
   itself encrypted under a non-extractable AES key. The pod stores ciphertext only.
4. The browser remembers, in IndexedDB, where the document is and the keys that open it.

On a later visit the sign-in page says "This browser keeps a guest … until …" with **Continue as
that guest** and **Forget it on this browser**. Continuing fetches the sealed document, opens it
locally and signs in as the same `did:ethr` wallet. Nothing is sent to identity again.

The bridge's own authentication is unchanged: a kept guest signs requests exactly as a tab-only
guest does. If any step of keeping fails, the person is still signed in as a tab-only guest.

## What it does not do

- It does not protect the key from a script running in the page while it is open. Such a script can
  use the keys, as it can read the wallet held in memory today. The keys only keep the phrase from
  being readable at rest (by another site, an extension reading storage, or the pod's operator).
- It does not outlast the guest deadline. After `guestExpiresAt` identity's cleanup deletes the
  pod's documents and the browser's record is dropped. Keeping an identity longer means claiming
  the owner with a passkey or wallet through identity's add-device flow, which the dashboard does
  not offer yet.
- It does not let a guest into Foxxi's I2IDL-X learning account. That workbench has its own guest
  door, for learner operations only, as a second application with its own service key
  (`FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY`): this grant service signs for the dashboard's origin,
  never the workbench's
  (`i2idlx/LEARNING-CONNECTIONS.md`, "Guest learners").
- It uses one of the two documents a guest may write. The second (`player-profile-index`) and the
  relay's guest tools are not used.
- Only one guest is kept per browser profile; keeping a new one replaces the record of the old.

## The general guest

Identity's **general guest** (one guest per browser across Interego applications, admitted at
identity's own door and linkable to a registered account: `deploy/identity/PROVISIONAL-PLAY.md`,
"General guest") is offered by Foxxi's I2IDL-X learner workbench and its course player when
`FOXXI_I2IDLX_GENERAL_GUEST=1` (`i2idlx/LEARNING-CONNECTIONS.md`, "The general guest").

**The dashboard offers it too, beside "Start as a guest", when the bridge has
`FOXXI_PLAY_GENERAL_GUEST=1`.** It is off otherwise, and then nothing on this page changes: no
route, no member of any answer, no control on the sign-in page
(`tests/a-dashboard-guest-comes-through-identitys-door.test.ts`).

### What a general guest is on the dashboard, and what it is not

A dashboard guest **is** a key: the tab makes a secp256k1 wallet and the bridge authenticates each
request by recovering its signer. That is not one check. `resolveCaller`, `verifyDelegatedCaller`,
`bindSignedCaller` and several inline recoveries in `bridge/server.ts` each read the caller from
the signature, and most go on to derive a pod, an owner and a public-or-private regime from the
**wallet address** (the directory's address map, `foreignPodRefusal`, `membershipHolds`,
`selfBoundPod`, the human-or-agent reading of `did:ethr:<signer>`). A general guest's key is a
P-256 key that never leaves identity's door origin, so there is nothing for the tab to sign with
as that guest, and a registered account's records are keyed to its own wallet or pod.

So the caller model is **not changed**. A general guest on the dashboard is still a tab key:

- The tab makes a wallet and signs every request with it, exactly as "Start as a guest" does.
  Every request is authenticated and authorized as `did:ethr:<that key>` and nothing else: the
  same role, the same pods, the same limits as any tab guest, whether the guest is linked or not.
- What the door adds is a **statement** the bridge keeps beside the caller model
  (`src/dashboard-general-guest.ts`): "tab key K was admitted through identity's door as guest G,
  which identity said acts for subject S, until T". S is `canonicalSubject` of what identity
  stated at the exchange (the account a guest is linked to, else the guest itself).
- Nothing in the bridge's authorization reads the statement. The bridge's own file names the table
  only where it is made and where its routes are attached, and a test holds it to that.

What this gives a visitor: they come in as their browser's one Interego guest (admitted under
identity's terms and caps, recorded on that guest as having used this application, linkable to
their account at the door), and the dashboard and the bridge know which Interego guest, or which
account, the tab's key belongs to.

What it does **not** give, and why it was not built here:

- *The same records on the next visit.* Each visit is a new tab key, so what a guest did last time
  is under last time's key. Carrying records across visits needs one of two things. Either the
  bridge treats a tab key's requests as subject S's **wherever it reads a caller**, which means
  every site above is re-decided for a subject that is not a wallet (which pod it writes, with
  the bridge's own write credential; whether its records read as a person's, private, or an
  agent's, public; what `membershipHolds` means for it) and, for a linked guest, that a browser
  holding only a guest's key writes into a registered account's pod. Or the bridge hands each
  returning guest the same wallet, which makes the bridge the keeper of guests' keys. The first is
  a change to the bridge's authentication as a whole and the second a custody decision; neither is
  safe to add beside the rest, so neither is here. Until one is decided, "Keep this guest in this
  browser" above is what brings the same dashboard guest back.
- *Anything of the account's.* A linked guest is attributed to the account and is not it: it has no
  role of the account's, reads none of its records, and cannot change or delete them, because no
  request it can sign is the account's.
- *A reader of the attribution.* The statement is answered to the tab key that owns it
  (`POST /play/general/standing`) and to code in the bridge (`standingOf`). No store or report
  reads it yet: what a guest does is recorded under its tab key as before.

### The visit, with no cookie

The dashboard is a static site on another origin than the bridge, so the HttpOnly cookie the other
adopters bind a visit with would be a cross-site one. The visit is bound to the tab instead.

1. **Start.** The sign-in page asks `POST /play/general/start`, answered only for the dashboard's
   `Origin` and rate-limited (each start has the service agent sign a grant). The answer carries the
   door address and the door's `binding`, a random value. The page keeps the visit's `state` and
   `binding` in its tab's `sessionStorage` and navigates to the door. The bridge's CORS lets only
   the dashboard's origins read the answer, and the page goes nowhere but identity's door.
2. **Return.** Identity sends the browser to the **dashboard's** origin, at
   `/guest/general/return?code=…&state=…` (the dashboard's entry in identity's client list, so no
   second return path is needed on the bridge's). The app serves its sign-in page there, which
   takes the code and state out of the address in the same step that reads them, before any
   request. The code is not a bearer: it is exchanged only with the PKCE verifier, which never
   leaves the bridge, and it is spent after one use or sixty seconds. It does appear, once, in the
   request line the dashboard's web server sees.
3. **Finish.** The page makes its tab key (in memory, never stored) and sends `{code, state,
   binding}` in a request that key signs to `POST /play/general/finish`. The bridge finishes the
   visit only with the binding it issued for that state, exchanges the code with identity itself,
   checks the answer again against its own identity origin, and keeps the statement for the key.
   The answer says whom the key is attributed to, and nothing else.

Why this holds against the two attacks a sign-in round trip invites:

- *Login CSRF* (making a victim's tab act as the attacker's guest). The attacker can pass the door
  as their own guest and hand a victim the return address. The victim's page finishes only a visit
  whose state is in its own tab's storage, so it drops the address without a request; and were a
  page to send it, the bridge refuses a binding that is not the one issued for that state. Neither
  refusal spends anyone's visit.
- *Fixation, and a stolen return address.* Someone holding a victim's return address has a code and
  a state, and neither the binding (in the victim's tab) nor the verifier (in the bridge). They
  finish nothing, and the refusal spends nothing, so the victim's tab still finishes.

A top-level navigation to a bridge address that sets a first-party bridge cookie was the other
candidate. It needs a second return path on the bridge's origin (identity allows one per entry,
and the learner workbench has it), a start ticket in an address, and a hand-over of the finished
session to another origin at the end. The scheme above needs none of the three.

### Bounds

A statement lasts no later than the guest's own deadline, nor eight hours (a tab guest's session),
and ten minutes when the guest is linked: the bridge is not told when an owner unlinks, so the link
is read again at the door (`LINKED_GUEST_SESSION_MS`). Statements are held in memory only, at most
1000 at once (a full table refuses a new key before its code is spent), swept when past their
bound, dropped by `POST /play/general/sign-out` (which the dashboard's sign-out sends), and all
forgotten when the bridge restarts. When a statement ends the tab is a tab guest and nothing it was
doing stops.

### What a general guest can reach

Everything a tab guest can, as its tab key, and nothing else. The pages are the ones a signing
session has (`signsOnly`): Learn (play what is hosted, bring a package, read its own record),
Author (fragments, compositions, folding a course, admissions), Work (signed performance records)
and My forwarding (forwarding targets, inbound credentials). Each of those requests is decided as
it is for any tab guest, on `did:ethr:<tab key>`; none consults the statement. The roster pages
(profile, my activity) and every administrator page stay closed to it, as to any signing session,
and the admin gate's policy (`src/tenant-admin-policy.ts`) refuses it in shadow and enforcing
alike, even where the linked account is the tenant's administrator.

### Turning it on

| Variable | Value |
| --- | --- |
| `FOXXI_PLAY_GENERAL_GUEST` | Exactly `1`. Needs `FOXXI_PLAY_SERVICE_PRIVATE_KEY` and `FOXXI_PLAY_AUDIENCE` (below): the door's grants are signed by the same service agent. `1` without them stops the bridge at start. |
| `FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN` | Optional. The HTTPS origin identity serves the door page from, when that is a dedicated one (identity's `GENERAL_GUEST_DOOR_ORIGIN`). Unset, the door is identity's own origin. |

In identity's `PROVISIONAL_PLAY_CLIENTS`, the **dashboard's** entry (the one step 6 below adds)
gains `"generalGuest": true` and `"generalGuestReturnPath": "/guest/general/return"`, and identity
runs with `PROVISIONAL_GENERAL_GUEST=1`. The bridge's own entry, which the learner workbench uses,
is not touched. `GET /play/guest` and `GET /play/status` then carry a `generalGuest` member.

Not exercised, because it needs the live services and a browser: the door page itself, the
dashboard's web server answering the return path with the app (its fallback does, by its
configuration), `sessionStorage` across the navigation, and the bridge's CORS for the four
posts. The round trip is tested against identity's own provider run in process.

## The three routes

| Route | What it answers |
| --- | --- |
| `GET /play/guest` | `{enabled:false}`, or `{enabled:true, audience, identityUrl}`. The dashboard asks this before offering anything. |
| `POST /play/grant` | Body `{publicKeyThumbprint, challenge}` and nothing else. Answers `{playGrant:{_signed_payload,_signature}, audience, identityUrl}`. Refused unless the request's `Origin` is the configured audience. 10 an hour per address. |
| `GET /play/status` | For the operator: whether the service can sign in, the agent DID and pod the relay signs it as, and whether the relay will sign for it. Returns no key and no token. |

None of the three takes or returns a credential. A grant lets the one browser key it names ask
identity for an owner for two minutes, inside identity's own caps and rate limits.

## Turning it on

It is off unless **both** of these are set on the bridge. One without the other, or a malformed
value, stops the bridge at start.

| Variable | Value |
| --- | --- |
| `FOXXI_PLAY_SERVICE_PRIVATE_KEY` | A secp256k1 private key (0x + 64 hex) made for this purpose. The bridge signs in to identity with it. Do not reuse `FOXXI_BRIDGE_PRIVATE_KEY`. |
| `FOXXI_PLAY_AUDIENCE` | The dashboard's exact HTTPS origin. It must also be in `FOXXI_DASHBOARD_ORIGIN`. |

`INTEREGO_IDENTITY_URL` and `INTEREGO_RELAY_URL` are read as elsewhere in the bridge.

### Steps, in order

Each step changes a live service. None is done by merging this code.

1. **Relay, storage gate and identity run the per-application write surface** (PR 841). A gate
   from before it would let this application's guest write the default application's two paths
   instead.
2. **Make the service key** and keep it as a secret. Its address is the service's wallet.
3. **Create the service's identity account** by signing in once with that wallet (ERC-4361, without
   `existingOnly`). The bridge itself always signs in with `existingOnly: true` and never creates
   an account.
4. **Register the service's agent with the relay** on the service's own pod, so the relay holds a
   delegation credential anchored to its signing key.

   `tools/setup-play-service.mjs` does steps 3 and 4. With no flag it changes nothing and reports
   what it found; each change needs its own flag, and it never agrees to identity's terms itself:

   ```bash
   FOXXI_PLAY_SERVICE_PRIVATE_KEY=0x... node tools/setup-play-service.mjs
   ```

   ```bash
   FOXXI_PLAY_SERVICE_PRIVATE_KEY=0x... node tools/setup-play-service.mjs --create-account --accept-terms=<version it printed>
   ```

   ```bash
   FOXXI_PLAY_SERVICE_PRIVATE_KEY=0x... node tools/setup-play-service.mjs --register-agent --audience=https://<dashboard origin>
   ```

   The key is read from the environment only and is never printed, nor is any token. When the
   relay signs for the agent, the script prints the `PROVISIONAL_PLAY_CLIENTS` entry for step 6.
   It sets nothing on the bridge or on identity.
5. **Set the two variables on the bridge** and restart it. Open `GET /play/status`.
   - `service` names the `agentDid` and `podUrl` the relay signs this service as
     (`asSignedByRelay: true`). These are the two values identity compares exactly.
   - `ready: true` means the relay verified the agent and will sign delegated requests for it.
     `ready: false` comes with `problem`, in identity's or the relay's own words.
6. **Add the application to identity's `PROVISIONAL_PLAY_CLIENTS`**, using the values from step 5:

   ```json
   {"https://<dashboard origin>":{"agentDid":"<service.agentDid>","podUrl":"<service.podUrl>","namespace":"foxxi","maxPods":25}}
   ```

   Merge it into the existing value; do not replace the other application's entry. `maxPods` is
   this application's own lifetime cap and is a storage-budget decision.
7. **Check from a browser**: on the dashboard's sign-in page the "Keep this guest" box appears;
   start as a guest with it ticked, reload, and continue as that guest.

To turn it off, unset the two bridge variables. Guests already kept stay openable until their
deadline, because opening one needs neither the bridge nor identity.

### What has and has not been exercised

Tested with the servers' own code (`tests/a-guest-is-kept-by-their-browser.test.ts`): identity's
admission (`ProvisionalPlay.bootstrap`) with a second application and its namespace; identity's
ERC-4361 reader on the service's sign-in message; the storage gate's marker check, permitted
paths, native-commit and sealed-envelope requirements.

Not exercised, because it needs the live services:

- Steps 3 and 4. `tools/setup-play-service.mjs` has run only against stand-ins for identity's
  accounts and the relay's registry, written from reading their handlers; identity's own ERC-4361
  reader does check each sign-in message it builds. Two things in particular are unconfirmed:
  whether the relay's `register_agent`, called over REST with an identity token, succeeds on a pod
  nothing has bootstrapped yet (the relay bootstraps a pod on its OAuth and `/mcp` paths, not on
  `/tool`), and what identity's token names as the agent for a wallet-created account. The script
  stops and prints the relay's or identity's own answer when a step is refused, and both it and
  `/play/status` report what the relay actually signs as.
- The relay's `POST /tool/sign_request` with the service's identity token, and the exact
  `agent_id` and `subject_pod_url` it signs. The grant service checks what comes back and refuses
  a mismatch, and `/play/status` shows the values, but the request has only been made to a
  stand-in.
- The gate's answer to an anonymous `GET` of the sealed document in production (the stand-in
  returns the stored JSON body), and the gate's and identity's CORS for the dashboard origin.
- IndexedDB itself. The record's logic is tested with an in-memory store; `indexedDbGuestStore`
  has run in no browser yet.
