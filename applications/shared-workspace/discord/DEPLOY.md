# Deploying the Discord bot, start to finish

This is the path from "I have this repo" to "the bot is in my server and two people are
recording a thread." It follows the same shape as every other service on the fleet: a GHCR image
built by `build-ghcr.yml`, deployed to Railway by `deploy-railway.yml`. The bot needs two secrets
and they are set on the Railway service, never in the repo.

For *why* the bot works the way it does — the delegation model, why it never holds anyone's
bearer, what a signature on an entry does and does not prove — read [`README.md`](README.md). This
file is the operational runbook.

> **What is verified, and what is not.** Everything up to and including the image build and the
> Railway wiring was checked against this repository and, where noted, against the live relay. The
> **Discord half cannot be verified from here** — it needs a real bot token, which only you have.
> So the Developer-Portal steps and the in-Discord flow are written from the bot's own code
> (`src/discord.ts`, `src/main.ts`, `src/workspace.ts`), traced end to end, but nobody has run
> them against a live gateway. Where a step is a claim about Discord's behaviour rather than the
> bot's, it says so.

---

## The shape of this service

The bot is a **worker, not a server**. It opens an outbound WebSocket to the Discord gateway and
makes HTTPS calls to the relay; it listens on **no port**. So its Railway service has no public
domain and no `/health` to poll — you confirm it is alive by reading its logs, where it prints its
pod, its wallet address, and its agent DID on boot. `tools/railway-services.mjs` records
`health: null` for it, exactly as it does for `css`, and that is not an oversight.

It holds **two secrets**, and the container exits until both are present:

| Variable | What it is | Where it comes from |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | the bot token | Discord Developer Portal → your application → Bot → Reset Token |
| `INTEREGO_BOT_KEY` | a secp256k1 private key, `0x`-prefixed | `openssl rand -hex 32`, prefixed with `0x` |

Neither is ever committed. The Dockerfile leaves both unset on purpose (baking a key into an image
publishes it to everyone who can pull the image), and `src/main.ts` throws with a named message if
either is missing — a bot that ran as a placeholder would attribute records to the wrong identity.

---

## Part A — create the Discord application

1. Go to <https://discord.com/developers/applications> and **New Application**. Name it whatever
   your server should see.
2. **Bot** tab → the token lives here. Click **Reset Token**, copy it once, and treat it like a
   password — this is `DISCORD_BOT_TOKEN`. Resetting it invalidates the previous one, so if you
   lose it you reset and re-set the service variable; nothing else breaks.
3. **Bot → Privileged Gateway Intents → MESSAGE CONTENT: ON.** This is the one that bites.
   Without it the gateway still connects and the bot still starts, but **every message arrives
   with empty content** — Discord sends blank `content` fields to bots that lack this intent. The
   bot would then record blanks. It is defended against this: the bot asks for MESSAGE CONTENT in
   its IDENTIFY, and if Discord rejects the request it receives close code **4014** and treats it
   as fatal, logging the exact remedy rather than running on and writing empty entries. If you see
   `4014` in the logs, this toggle is off.
4. **OAuth2 → URL Generator** — build the invite link:
   - **Scopes:** `bot` and `applications.commands`. (`applications.commands` is what lets the
     `/workspace …` commands be used in the server; `bot` is what puts the bot in it.)
   - **Bot Permissions:** *View Channels*, *Send Messages*, *Send Messages in Threads*, *Read
     Message History*. A workspace is a Discord **thread**, so "Send Messages in Threads" is the
     one that matters for the bot's replies; the others let it see the channel and read history.
   - The generator writes the URL for you. It looks like:
     ```
     https://discord.com/oauth2/authorize?client_id=<YOUR_APPLICATION_ID>&scope=bot+applications.commands&permissions=274877975552
     ```
     `<YOUR_APPLICATION_ID>` is on the application's **General Information** page. The
     `permissions=` integer is just those four boxes ticked; let the URL Generator compute it
     rather than hand-editing, since it is the authoritative source.
5. Open the URL, pick your server, authorise. The bot appears in the member list, offline, until
   you deploy it.

Slash commands are **global** and registered by the bot on boot (and can also be registered
without starting the gateway via `npm run register-commands`). Discord can take up to an hour to
roll global commands out the first time — if `/workspace` does not autocomplete immediately, that
is why, not a failure.

---

## Part B — generate `INTEREGO_BOT_KEY`

```bash
echo "0x$(openssl rand -hex 32)"
```

This one string **is the bot's identity.** The relay derives the bot's pod and its agent DID from
it, and that agent DID is the string every participant delegates to (Part D). So:

- **Keep it.** Store it wherever you keep the fleet's other secrets. A new key is a **new agent**
  with a new pod and a new DID — every participant's existing delegation would then name an agent
  that no longer exists, `checkDelegation` would fail for everyone, and every write would stop
  until each person re-linked. Losing the key is not a data-loss event (the records already
  written stand on their authors' pods), but it is a re-onboard-everyone event.
- **Do not commit it.** It goes on the Railway service and nowhere else.

---

## Part C — deploy on Railway

The fleet's rule is two explicit, manually dispatched steps: building an image does not deploy it.
Both are `gh workflow run` dispatches; you need the repo's `gh` auth and, for the deploy, the
`RAILWAY_PROJECT_TOKEN` secret already configured on the repo (it is — it is what deploys every
other service).

**1. Build and push the image to GHCR.** The image name is `interego-discord` (the Railway
*service* will be named `discord`; the two differ by the `interego-` prefix, as they do for the
rest of the fleet):

```bash
gh workflow run build-ghcr.yml -f image=interego-discord --ref master
gh run watch    # wait for it green; note the commit sha it built
```

This produces `ghcr.io/markjspivey-xwisee/interego-discord:<sha>` and `:latest`.

**2. Create the Railway service** (once), in the Railway dashboard for the `interego` project:

- **New service → Deploy from a Docker image** → `ghcr.io/markjspivey-xwisee/interego-discord:latest`
  (the first deploy pins it properly to a sha; `latest` just gets it created).
- **Variables** — set the two secrets:
  - `DISCORD_BOT_TOKEN` = the token from Part A
  - `INTEREGO_BOT_KEY` = the key from Part B
- **No public networking.** Do not generate a domain — it has no port to expose. Leave it as a
  private worker.
- **Optional but recommended — a volume for link state.** The bot records which Discord account is
  linked to which pod, and which thread convenes which workspace, in
  `INTEREGO_DISCORD_STATE` (the image points this at `/data/discord-workspace.json`). Attach a
  Railway **volume mounted at `/data`** and that state survives redeploys. Without a volume the
  state is ordinary container storage and is lost on each redeploy — which is recoverable (each
  person re-runs `/workspace link`, and a thread is re-bound by `/workspace start`), just annoying.
  Given runtime data on this fleet is treated as disposable, a volume is a convenience, not a
  requirement.

**3. Give the service its GHCR pull credential and deploy.** A service created after the
Azure→Railway migration has no registry credential and fails the first deploy with no build log
and no deploy log — which reads like anything but a credential — so the first dispatch sets it:

```bash
gh workflow run deploy-railway.yml \
  -f service=discord \
  -f tag=<the 40-hex sha from step 1> \
  -f set_registry_credentials=true
gh run watch
```

On later deploys drop `set_registry_credentials` (harmless to repeat) and just pass `service` and
`tag`. There is no `verify_url` to pass, and the deploy is still verified — just not over HTTP.
Because the bot binds no port there is no URL to derive, so `tools/railway-redeploy.mjs` polls the
**logs of the deployment it just triggered** until they report `discord: bot online`, the line
`src/main.ts` prints when — and only when — the Discord gateway has sent `READY` to *this*
container. That is strictly later than both credentials (`rest.me()` authenticated the bot token,
`session.open()` signed the bot key in to the relay), and it is the needle for a reason worth
knowing: it used to be `discord: commands registered`, which proves two HTTPS calls succeeded and
says **nothing about the WebSocket the bot's entire function depends on**. On 2026-08-09 the
gateway died at 12:46 and the container sat there for 75 minutes with every boot line present,
answering nothing in Discord, while Railway reported the deployment SUCCESS. If that line appears **twice** in
one deployment the container restarted — a crash loop wearing a SUCCESS — and the deploy fails with
the log tail. `css` is portless too and is still refused by name: nothing here decides what it
prints, and it is the one service whose correctness needs exactly one container.

**4. Confirm it is alive.** Open the service's **Deploy Logs** on Railway. A healthy boot prints,
in order: the bot's pod, its wallet address, and **its agent DID** — copy that DID, it is what
participants delegate — then whether the slash commands needed re-publishing, then `discord: bot
online`. The DID has the shape

```
did:web:identity.interego.xwisee.com:agents:interego-discord-<the bot's pod>
```

because the relay bakes the OAuth **client name** into the agent identifier it issues, and this
bot signs in under `DISCORD_CLIENT_NAME` (`src/identity.ts`). The pod half comes from
`INTEREGO_BOT_KEY`, so the two halves move for two different reasons: a new key is a new pod AND a
new DID; a changed client name is a new DID on the SAME pod. Either invalidates every delegation
already published, because a delegation names one exact agent string. If instead you see the
`INTEREGO_BOT_KEY is not set` / `DISCORD_BOT_TOKEN is not set` refusal, a variable did not take; if
you see close code `4014`, the MESSAGE CONTENT intent (Part A step 3) is off.

### Two symptoms in Discord, and which one is a bug

**"The application did not respond."** Discord invalidates an interaction token that is not
acknowledged within **3 seconds**. Every command defers immediately (callback type 5) and edits the
placeholder when the substrate work finishes, so the only way to see this message is that the bot
never received the interaction at all — i.e. **the gateway is down**. Read the logs for
`gateway closed`, `reconnecting in … (attempt N of 10)` and `gateway FATAL`. A bot that cannot
re-establish the gateway after ten attempts now **exits non-zero on purpose**, so Railway restarts
it; a worker that stays up with no connection is the worst state available, because the platform
believes it is healthy and nothing tells anyone otherwise.

**"This command is outdated, please try again in a few minutes."** This is Discord's own
read-repair (error 50035, `INTERACTION_APPLICATION_COMMAND_INVALID_VERSION`): the client invoked a
command carrying a `version` older than the registered one. Global commands reach clients through a
cache, so after a **real** change to the command tree this is expected and self-healing within the
hour — not a fault. It is only a bug if it keeps happening without the tree changing, and the boot
log now settles which case you are in: the bot reads the registered commands first and prints either
`commands are registered — unchanged since the last boot …` or `… the definitions differ …`. If you
see the second line on a boot where nothing changed, the payload in `src/discord.ts` has drifted
from what Discord normalises and stores, and `commandFingerprint` needs to account for the field.

---

## Part D — what two people actually do in Discord

The bot never holds anyone's credential. A participant's messages land on **their own pod**, under
a delegation **they** published on it. That means there is a required order, because a person must
**exist on the relay** — have a pod — before they can authorise anything on it.

### The order, for each participant

1. **Have an Interego identity.** Sign in once through any Interego client — the desktop app
   (wallet or passkey), the published workspace page, or an MCP connector. This is what creates
   their pod. Until they have done this, there is nothing to delegate on.
2. **Publish the delegation on their own pod.** From that same client, they authorise the bot:
   ```
   register_agent { agent_id: "<the bot's agent DID>", scope: "PublishOnly",
                    label: "discord-link <their own Discord user id>" }
   ```
   `register_agent` is own-pod gated at the relay, so this can only ever write to *their* pod — not
   the bot's, not anyone else's. **The desktop app does exactly this for them:** its "link a chat
   account" card takes the bot's agent DID and the person's Discord user id, publishes precisely
   that call on their pod, reads it back, and then tells them to run `/workspace link-confirm` in
   Discord. The published artifact and any MCP connector can publish the same call. The label is
   not a secret and is not a code to keep — it is the claim itself, and the bot recomputes the
   label it checks from the id of the account actually running the confirm, so knowing someone's
   Discord id buys an attacker nothing.
3. **Confirm the link in Discord.** In the server:
   ```
   /workspace link
   ```
   The bot replies privately with its agent DID and the exact `register_agent` call to publish (in
   case they did not use the desktop card). Then, once the delegation is on their pod:
   ```
   /workspace link-confirm pod:<their pod, e.g. u-eth-…>
   ```
   The bot verifies, from the substrate alone, that the pod delegates its agent un-revoked, that
   the delegation's label matches the id of the account running the confirm, and that the agent is
   write-eligible. Only then is the Discord account bound to that pod.

### Starting and running a workspace

- **`/workspace start`** in a thread creates the workspace on the caller's own pod and seats them
  as convener. The caller must be linked first; an unlinked caller is told *"Run `/workspace link`
  first — a workspace is created on the convener's own pod, and this bot does not have one to put
  it on for you."*
- After that, a **linked** participant's messages in that thread become signed entries on **their
  own** pod (they are seated automatically on first speaking). A participant who is **not** linked
  is not recorded, and is told so once, visibly: *"not recorded. You are not linked … Nothing you
  have said here has been written anywhere."* Unlinked people can talk freely; nothing of theirs is
  written.
- **`/workspace show`** renders the composed view — the roster, the newest entries from each seated
  member's own log, and the IRI anyone can follow to read the record outside Discord.
- **`/workspace who`** lists every agent that could be asked something here, and what its own pod
  says about it. A filled dot means that agent published a short lease saying its host was running,
  signed with its own key, and the lease is live now; an open dot means it did not, and the line
  says which — a lapsed lease, none at all, or a pod that would not answer. Whether a person
  *authorises* an agent is read from **their** pod; whether that agent's host is **up** is read from
  **its own**. Two documents, and they can disagree.
- **`/workspace ask agent:<pick one> task:<what you want>`** puts a request on the record addressed
  to one agent. The picker is live per keystroke — it re-reads every seated pod's delegation
  registry and every delegate's presence document each time, so an agent revoked thirty seconds ago
  disappears from it without the bot being told. The value it fills in is the agent's full DID,
  because "Mark's agent" is ambiguous by construction: a person may authorise several.

  **The ask is an entry in the channel, not a message in an inbox.** It lands on the asker's own
  pod, signed, with `iep:addressedTo` inside the signed region so whoever relays it cannot change
  who it is for. If the agent's host is not running, a notification is *also* sent — but it carries
  **no task text**, because any account on this relay can write into any inbox, so text that
  travelled that way is text a forger could write. The agent dereferences the pointer and refuses it
  unless the party that delivered it is the party that signed the record.

  **Asking is not instructing.** The agent decides whether there is anything to add, and one that
  decides there is not writes nothing — which from outside looks identical to one that never read
  it. After ten minutes with nothing written, the channel says exactly that, as a statement about
  the record rather than a claim about anybody's agent.
- **`/workspace unlink`** makes the bot forget the binding. It does **not** revoke the delegation —
  it says so. Revocation is the pod owner's own act (`revoke_agent`) on their own pod, and it works
  whether or not the bot cooperates.

### How this relates to the desktop app's Discord card

They are two ends of the same handshake. The desktop card does **step 2** — publishing the
delegation on your pod — and nothing else; it explicitly cannot do step 3 for you, because the bot
checks the delegation row itself rather than taking any app's word for it. So the normal flow for a
desktop user is: sign in (step 1) → fill the card and publish (step 2) → switch to Discord and run
`/workspace link-confirm pod:<your pod>` (step 3). A user who never touches the desktop app does
step 2 from the artifact or a connector instead; the Discord side is identical.
