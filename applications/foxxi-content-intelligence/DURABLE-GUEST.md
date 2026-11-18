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

**The dashboard's page does not offer it yet.** The bridge's side of it exists and is switched
off: `FOXXI_PLAY_GENERAL_GUEST=1` turns it on (with the dashboard's own service account,
`FOXXI_PLAY_SERVICE_PRIVATE_KEY` and `FOXXI_PLAY_AUDIENCE`; `FOXXI_PLAY_GENERAL_GUEST_DOOR_ORIGIN`
names the door's origin where identity serves it from a dedicated one). With the switch unset
nothing below is built or attached and nothing on this page changes. The page's button, and a
guest linked to a registered account, are later steps.

Two things stood in the way, and this is how each is settled (`src/dashboard-general-guest.ts`):

1. *The dashboard is a static site on another origin, so no cookie can bind a visit.* The page
   starts a visit with `POST /play/general/start` (answered only for the dashboard's `Origin`) and
   keeps the door's `binding` in its tab. Identity returns the browser to the dashboard's
   registered return path (`/guest/general/return`) with a code. The page then makes a key for its
   tab and sends `{code, state, binding}` in a request that key signs, to
   `POST /play/general/finish`. The bridge finishes the visit only with the binding it issued for
   that state and exchanges the code itself. The page may add `record_key`, an X25519 public key
   it made for the tab (the secret stays in the tab): the guest's record is then sealed for that
   tab too. This round trip has been run in no browser.
2. *A tab key is not the guest.* After `finish`, the bridge holds that this tab key was admitted
   as that guest, for an hour at most or until the guest's own deadline. A request the key signs
   at `POST /play/general/act` is the **guest's**: its subject is the guest's DID
   (`did:web:<identity host>:users:u-try-guest-…`) and its records are on the guest's own pod. The
   key itself is nobody, and is refused on every signed `/agent/*` route while it is admitted.

**What a guest can do** is the list in `src/guest-operations.ts`, and nothing else: ask its
standing, sign out, read its own learning record, see what a composition would play for it, launch
one, and answer its steps. Any other name is refused, and so is any request that says who it is
for, on whose authority, or which pod it touches (`acting_as`, a subject, a pod URL): a guest acts
as itself. No signed `/agent/*` route and no `foxxi.*` tool accepts a request in a guest's name.

**Where a guest's record is.** One sealed document on the guest's own pod,
`<pod origin>/<guest id>/foxxi-dashboard/learning-record.sealed.json`
(`src/guest-learning-record.ts`), written by the bridge with the gate's operator bearer. It is
never the tenant pod: with the switch on, the bridge's pod resolver places a general guest's DID on
its own pod or refuses it. Nothing is written to a lens, a lattice, the efficacy tally or a
forwarding target for a guest. When the gate answers a write with `410` (the guest is closed or
expired) every session of that guest ends and the write is not tried again.

**Who can read a guest's record.** The gate serves pod reads with no sign-in, so whoever has a
guest's id can fetch the document. It is ciphertext: the record is sealed in the substrate's
multi-recipient envelope (X25519, XSalsa20-Poly1305), and nothing of it is in the clear. Two
parties can open it:

- **The bridge**, at any time, for every guest. It opens each guest's record with a key derived
  from its own secret (`FOXXI_BRIDGE_PRIVATE_KEY`, else its wallet seed) and that guest's DID. This
  is a bridge-held service key: the record is confidential from the public and from the storage
  provider, not from whoever operates the bridge. The bridge needs it because it reads the record
  at every step, and because a guest outlives both a bridge process and a browser tab.
- **The guest's own tab**, when it sent a `record_key` at `finish`: it is a recipient of every
  version written while it is admitted, and can open the document from its pod without asking the
  bridge. A tab that sent none reads its record through the bridge (`record.read`).

Nobody else: not a holder of the guest's id, not a reader at the gate, not the operator bearer.
A reader without a key still sees that a record exists, when it was last sealed, about how large
it is, and the public keys it is sealed for. With the switch on the bridge does not start without
a secret to seal with.

**Who is refused at the door.** A guest identity states is linked to a registered account, or
acting on another's behalf. Not yet.

**Limits** are counted per guest, not per tab or address: 120 operations and 30 writes a minute,
at most four tabs, and at most 256 writes to the pod per bridge process, each a record of at most
256 KiB (384 KiB as sealed).

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
