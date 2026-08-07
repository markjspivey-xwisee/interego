# Interego Workspace — desktop shell

Against the **live** relay, with no fixtures anywhere in it:

    boot -> sign in -> lobby (who you are, your inbox, the workspaces you accepted)
         -> create a workspace / invite somebody / accept an invitation
         -> channel: roster, stream, canvas
         -> post an entry, save the canvas, meet a 412 and merge forward

Everything it knows about the substrate comes from **`@interego/workspace-client`** — the same
module the published artifact's script is generated from. This package holds a window, two
sign-in flows and a key. It does not parse Turtle, name a member's documents, decide who is
seated, verify a grant, work out where an entry goes in a chain, or decide whether a save
became the head.

---

## Everything it can do, and the two things it cannot

| flow | where the decision is made | driven live |
|---|---|---|
| create a workspace (five documents, in order, on your own pod) | `createWorkspace` | yes |
| invite by handle, grant on your pod, LDN notice | `sendInvite` | yes |
| accept, from an inbox item that is **verified first** | `verifyGrantIri` + `acceptGrant` | yes |
| switch between the workspaces you have accepted | `listWorkspaces` + `verifyWorkspaceEntry` | yes |
| revoke a grant you published | `revokeGrant` | yes |
| post an entry onto your own pod, compare-and-swap safe | `postEntry` | yes |
| canvas: create, save, forced stale 412, merge forward | `readCanvas` / `saveCanvas` / `mergeForward` | yes |
| renew the bearer with no user present | `refreshBearer` here + the relay's `refresh_token` grant | yes |
| link a Discord account by publishing the delegation for you | `discordLinkPlan` + `publishDelegation` | yes |
| withdraw that delegation, confirmed by reading the pod back | `revokeDelegation` | yes |
| run your own agent on your own model subscription | `decideTurn` / `briefPrompt` / `checkDraft` + `modelprovider.ts` | yes |

---

## What a brand-new user does, start to finish, with nothing but the app

1. **Open it and press *Create an account with a passkey*.** Windows Hello / Touch ID both creates
   the account and signs in; there is no password and no sign-up form. The ceremony happens in the
   system browser rather than in this window, because `clientDataJSON.origin` has to be the
   identity server's and a page loaded from disk cannot produce one — that also means a real
   platform authenticator instead of a soft key this program made up. First run takes **12–17 s**
   while the relay provisions a pod; the boot checklist counts up and names the step rather than
   spinning. Wallet sign-in stays on the same card for people who already have a `u-eth-…` pod.
2. **Read *Getting set up*.** Four steps with their real state — account, model, workspace,
   Discord — each marked as established for, established against, or **not established**. Step 2
   is a finding against when the CLI was asked and said no; step 4 is an *unknown*, because
   whether a pod delegates a bot needs an agent id to ask about and the app has none until you
   type one. It never draws "you have not linked Discord".
3. **Check *Your agent's model*.** It reports what this machine can run your agent on and under
   which account. If nothing is there it says what to install and that everything else still works.
4. **Create or accept a workspace**, exactly as before.
5. **Link Discord** from the lobby card, if you want the thread.
6. **In the channel, turn your agent on** when you want it. It drafts into the composer; you press
   Post.

Nothing in that sequence needs a terminal, a key, or a second client.

---

## Your agent runs on your own subscription, or it does not run

Everything in this section was driven end to end against the live fleet, with two freshly minted
disposable identities and the real `claude` CLI on the operator's own Max subscription:

```sh
npx tsx applications/shared-workspace/tools/drive-local-agent-live.ts
```

It mints A and B, creates and accepts a workspace across both pods, has B ask a real question, runs
A's agent for real, appends the answer to A's own pod, asks again to prove the loop guard refuses a
second reply, publishes a Discord delegation and verifies it *from the delegate's own session*,
refuses a different chat account against the same row, and revokes. All checks pass.


**The question, and the measurement that answers it.** Can this app run a person's agent on the
Claude subscription they have already signed into on this machine — no API key, nobody else
paying? Measured on Windows 10, Claude Code 2.1.162, 2026-08-07, with **no `ANTHROPIC_API_KEY`
anywhere in the environment**:

| what was run | what came back |
|---|---|
| `claude auth status --json` | `{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}`, exit 0, 844 ms |
| `claude -p … --output-format json` | `{"is_error":false,"result":"SPAWN_OK"}`, exit 0, 5.5 s |
| the same, prompt on **stdin** instead of argv | `{"is_error":false,"result":"STDIN_OK"}`, exit 0 |
| the same, from a `HOME` with no credentials | `{"is_error":true,"result":"Not logged in · Please run /login"}`, exit 1, **1.2 s** |

So: yes, and cleanly. The CLI reads the credential itself — `~/.claude/.credentials.json` on
Windows and Linux, the Keychain on macOS — and refreshes it itself. **This app never reads that
file, never copies the token and never holds it.** It spawns a child and reads stdout. There is no
key here because there is no key.

`claude auth status --json` answers with exit 0 and an honest `loggedIn` boolean in *both* states,
which is the detection primitive: the app never has to stat a credential file to know whether
somebody is signed in. And a logged-out `-p` **fails fast** rather than hanging or prompting, which
is what makes an unattended loop safe to start.

### Three measured footguns, each of which silently breaks the subscription path

1. **`--bare` must never be passed.** Its own help says "Anthropic auth is strictly
   `ANTHROPIC_API_KEY` or `apiKeyHelper` — OAuth and keychain are never read". Measured: with a
   valid subscription signed in, `-p --bare` returns "Not logged in" in 78 ms. It reads as a
   lean-startup flag and it is an auth-disabling flag.
2. **On Windows the `.exe` must win over the `.cmd`.** npm installs both. Node 22 refuses to spawn
   a `.cmd` without `shell: true` — `EINVAL`, measured — and a shell would pass a channel full of
   other people's words through `cmd.exe`. `resolveClaudeCli` looks for the executable first and
   *reports* a shim rather than running one.
3. **The parent's `CLAUDE_CODE_*` environment must be stripped.** A developer launching this app
   from inside a Claude Code session would otherwise hand the child `CLAUDECODE=1` and
   `ELECTRON_RUN_AS_NODE=1`, which is not a configuration any real user's machine has.

### What is NOT supported, and why that is not a shrug

**There is no Codex provider, and no BYO-API-key field.** Codex was researched against its own
source before that was decided: `codex exec --json` is a documented non-interactive mode,
`$CODEX_HOME/auth.json` holds a real Sign-in-with-ChatGPT OAuth bundle rather than a key, and the
official SDK's `apiKey` is optional so a child that omits it rides the user's own login. Three
things stopped it shipping: **it is not installed on this machine**, so not one line of it could be
measured; **it does not fail fast when logged out** — no auth preflight, ~20 s of 401 retries, exit
1 with no machine-readable code (openai/codex#30514, open) — so matching the Claude path needs a
separate `codex doctor --json` preflight that must itself be measured; and **whether OpenAI permits
it is unresolved**, with a broad undefined clause in their terms, an auth doc that recommends API
keys for programmatic CLI use, and every request for a position on their own tracker unanswered.

When somebody installs it and drives it end to end, it gets an entry. Until then the app says it is
not supported here, which is true, rather than offering it and failing.

**And there is no built-in fallback.** If no provider is available the agent does not run and the
screen says what is missing. An agent whose replies came from anywhere other than the user's own
credential would be a puppet wearing their name on a permanent public record.

### The loop is off, visible and stoppable

It starts **off**. Turning it on says so on screen. It considers a turn only after the bodies for a
read are in — hooking it to the watch tick would let it answer a message whose text had not arrived
yet. When it decides to speak, **the draft goes into the composer** and stops there: the person
reads it and presses the same *Post to my pod* button they would use themselves, and the entry is
the same compare-and-swap append with the same readback. Posting without review is a separate
checkbox, off by default and never remembered. Turning the agent off calls `agent:cancel`, which
**kills the child process** — an agent switched off that keeps thinking and then posts is the exact
failure the panel exists to prevent. A draft is never written over text the person is mid-sentence
on, in either direction.

**Where the decision lives.** `decideTurn`, `briefPrompt` and `checkDraft` are in
`@interego/workspace-client`, because "is anyone waiting on me, and have I answered this already"
is a statement about the substrate and three clients would each get it slightly wrong. Only the
child-process spawn is in this shell, because a package that has to run in a browser cannot have
it. The renderer holds the channel already, so the loop runs there and the main process does one
thing: `agent:think`. **The renderer cannot name the binary** — the path comes from this process's
own probe, never from the call.

### Whose entry it is — the one open question here

**As built, the local agent writes as YOU.** It runs under your own session, appends to your own
log, and the entry is indistinguishable from one you typed — the only difference is who composed
the words, and you approved them before they went. That is why it is not a second member and why
the panel is a review step rather than a seat.

**The other reading is defensible and is not what shipped.** The deployed `wsp-bridge` is a seated
member with its own key: its entries say *the agent wrote this*, and a reader can tell them apart
from the human's. A local agent could work the same way — mint a key in the OS secret store, have
you delegate it on your own pod with exactly the `register_agent` writer this PR already added and
drove live, and let it appear in the roster under its own name. That buys honest attribution at the
cost of a second identity to manage and a roster entry per person.

The machinery for it exists and is tested; only the choice was made the other way. **If attribution
should distinguish "you" from "your agent" on the record, this is the thing to change**, and it is
contained: the decision, the ceiling check and the writer would all stay where they are.

**The dedupe rule, and the loop-forever defect it prevents.** The obvious test is whether one of my
entries declares `prov:wasDerivedFrom` the entry I am about to answer. That **does not work from
this client**: `entryTurtle` writes no derivation link, so an entry posted from here never carries
one, and an agent relying on it would re-answer the same message on every poll, permanently, on a
public log. The rule that holds for every author is simply *whether somebody else has spoken since
I last did*. It needs no state, survives a restart, and cannot double-post after a crash. A
derivation link is still honoured when present, because the bridge's entries do carry one.

### What an adversarial review found after all of the above was green

Every test in this document passed before a reviewer was pointed at the code and told to **refute**
these claims rather than confirm them. It refuted three, and each defect was reachable, silent, and
wrote to somebody's permanent public log. They are recorded because the shape of them recurs.

**The loop guard never fired.** The ordering used `at ?? Number.MAX_SAFE_INTEGER`, so an entry with
no readable timestamp sorted *last* — which in a conversation means *newest*. The "have I spoken
since they did" test then compared against that undated entry, which is never the agent's own, so
it never matched: one model call and one permanent public entry **every 45 seconds, forever**. The
exact loop the guard existed to prevent, produced by the guard's own tie-break. Undated entries are
now excluded from the ordering decision entirely rather than given a position that is a guess in
one direction. (`Date.parse(x) || null` also made the Unix epoch read as "no time" — the same bug
one falsy value over.)

**A partial read answered twice.** Entries whose descriptor failed to read were dropped silently,
so losing the read of the agent's *own* latest reply made an older entry of its own the newest —
and it answered the same message again. Unreadable rows are now **counted**, and `decideTurn`
refuses outright when the count is non-zero: a partially-read channel cannot answer "who spoke
last", and guessing costs a duplicate on a permanent log.

**Switching workspace carried the agent across.** `teardownWorkspace` reset streams, bodies, seats,
roles and canvas — and not the agent. An in-flight turn composed from one channel wrote its draft
into another channel's composer, and with auto-post ticked published one workspace's discussion in
a different workspace. Consent to run here was being read as consent to run there. The agent is now
switched off and its draft discarded on every workspace change.

Two more, from the same review: **`agent:cancel` could not reach a child that did not exist yet** —
a turn spends its first seconds inside a 20-second provider probe, and the old code only registered
a killer after the model child spawned, so "off" during that window was ignored and the turn ran to
completion on a subscription the user had just switched off. And **`thinking.clear()` orphaned
overlapping turns** — clearing the whole set on every completion destroyed the very overlap the set
was introduced to handle. Both fixed; a turn is now a live object from its first line and removes
only itself.

And one honesty defect: **three of the four "unusable" model states were drawn as a cross.** The
CLI-not-installed, probe-timed-out and unreadable-answer cases all have `loggedIn: null` — nothing
was established about the account at all — and rendering them as a finding *against* is exactly
what `membership.ts` warns about ("collapsing the two is how absence gets rendered as a negative
fact"). Only `loggedIn === false` is the tool having been asked and having answered no.

**Known and not fixed:** an active IME preedit is not protected by the composer guard (it tests
`.value`, which a preedit has not yet committed); and `cp.kill()` on Windows terminates one process
rather than a tree, so a cancel reaches the CLI but not necessarily anything it spawned.

### One thing the live drive changed

The instruction the agent is given was **tuned from a measured failure, not from taste**. The first
version led with "write only what they would be content to have stand" and put the abstain sentinel
last. Driven live against a channel whose single entry was a direct question — *"do we re-tile in
spring or patch it now?"* — the model answered `NOTHING TO ADD`, because it had no independent
knowledge of the roof and the framing made silence the safe move. An agent that abstains from every
genuine question is not cautious, it is broken. The permanence is now stated as a constraint on
tone, and the sentinel is scoped to the narrow case it is for.

---

## Linking Discord, without reintroducing the hole

`/workspace link` in Discord prints two values: the bot's agent id and your own Discord user id.
Put them in the lobby card and this app publishes the delegation on your pod for you —
`register_agent { agent_id, scope: "PublishOnly", label: "discord-link <your id>" }` — so nobody
has to run a tool call by hand in another client.

**Neither value is a secret and this app mints nothing.** A delegation row is world-readable:
`get_pod_status { pod_name: <anyone's> }` answers for any pod and returns the rows *with their
labels*. The bot's `links.ts` records the defect that taught this — a nonce published as a label is
a nonce published, and whoever reads that pod first can bind *their* Discord account to *your* pod.
The label is the claim itself, and the bot recomputes it from the id of the account actually
running the confirm. **Do not add a code field to that card.**

`challengeLabel` and `SNOWFLAKE_RX` **moved into `@interego/workspace-client`** for this. The
comment on `challengeLabel` warned that "two format sites is how a link flow comes to reject every
honest user" while the bot was still the only site; a copy here would have made that come true. The
bot now re-exports them from the module.

The card **shows the exact call before it makes it**, along with what is actually being granted —
including that `PublishOnly` is **pod-wide**, because the substrate has no per-graph delegation
scope, and that the relay may honour a cached permission for up to 60 s after a revoke. A screen
that said "Link Discord" and quietly published a pod-wide publish delegation has not asked for
consent to what it did. And a link is reported as published only when **reading the pod back**
confirms it — `register_agent` answering `{registered: true}` is the relay describing its own
action, and the two have disagreed before.

**Not signed and not notarised, on any platform.** Windows SmartScreen will warn on first run
of the `.exe`, and macOS Gatekeeper will refuse to open the `.app` and say the developer cannot
be verified. **Both warnings are accurate**: the binaries genuinely are not signed by anybody
either OS recognises. There is no code-signing certificate for this project and notarisation
needs an Apple Developer account nobody here holds. Out of scope — see *Packaging* below,
which also states which targets have actually been built and which have not.

**Not pushed — polled.** The channel updates by re-reading on a timer, not by subscription, and
the shell says so on screen in the transport's own words rather than claiming "live". See
*The watch* below for the measurement.

---

## Build and run on Windows

Prerequisites: Node 20+ and npm. Nothing else — no Rust, no C++ toolchain, no Python.

```sh
# from the repo root
npm install
npm run build --workspace @interego/workspace-client
npm run build --workspace @interego/workspace-desktop

# run it
cd applications/shared-workspace/desktop
npx electron .
```

`npm start` from this directory does the build and the run in one step.

### If the window never appears and you see "Cannot read properties of undefined (reading 'whenReady')"

Your shell has `ELECTRON_RUN_AS_NODE=1` set — every terminal spawned by an Electron-based
editor or agent inherits it, and it makes Electron behave as plain Node, so `require('electron')`
returns a path string instead of the API. Measured on this machine, from a Git Bash spawned by
Claude Code. Clear it for the run:

```sh
env -u ELECTRON_RUN_AS_NODE npx electron .          # bash
$env:ELECTRON_RUN_AS_NODE=$null; npx electron .     # PowerShell
```

### Headless check against the live relay

`selftest.js` runs the shell's own main-process modules — real `safeStorage`, real SIWE
ceremony, real `POST /mcp` — and prints what came back. It is not a mock; the only thing it
replaces is the human pressing buttons.

```sh
cd applications/shared-workspace/desktop

# wallet path: sign in, read a workspace, and append a real, public entry
env -u ELECTRON_RUN_AS_NODE \
  INTEREGO_SELFTEST_KEY=0x... \
  INTEREGO_SELFTEST_WORKSPACE=https://relay.interego.xwisee.com/ns/POD/NAME \
  INTEREGO_SELFTEST_POST=1 \
  ../../../node_modules/electron/dist/electron.exe dist/selftest.js

# browser-delegated path, with the WebAuthn gesture scripted
env -u ELECTRON_RUN_AS_NODE \
  INTEREGO_SELFTEST_PASSKEY=path/to/credential.json \
  ../../../node_modules/electron/dist/electron.exe dist/selftest.js
```

---

## The two ways to sign in

Both end at the **same** credential — an OAuth bearer minted by the relay's own authorization
server at `POST /token`. SIWE and WebAuthn are two ways of satisfying `POST /oauth/verify` for
one pending authorization, not two token types. What differs is the pod the relay provisions,
and that is permanent:

| Sign-in | Where the secret is | Pod prefix | Browser needed |
|---|---|---|---|
| Wallet key on this machine | OS secret store (`safeStorage`) | `u-eth-...` | no |
| Sign in in my browser (passkey / Windows Hello) | the platform authenticator | `u-pk-...` | yes |

### Why the passkey path opens your browser instead of doing it in-app

Measured: the WebAuthn ceremony's `clientDataJSON.origin` must be
`https://identity.interego.xwisee.com` — the **identity server** — even though the proof is
POSTed to the **relay's** `/oauth/verify`. A renderer loaded from `file://` has origin
`file://` and can never satisfy that. So the app opens the relay's own sign-in page in the
system browser and receives the authorization code back over a **loopback** redirect
(`http://127.0.0.1:<os-assigned port>/callback`), with PKCE. That is RFC 8252, and it is also
the only way the authenticator is a real one rather than a soft key this process generated.

Not an embedded webview: an embedded webview can read what you type into it, which defeats the
point of delegating the ceremony. Not a custom URL scheme: another installed program can claim
one. The loopback socket binds `127.0.0.1` only, so nothing off this machine can reach it.

### What the OS secret store does and does not protect

The wallet key is encrypted by the operating system before it touches disk — DPAPI on Windows,
scoped to your Windows user account. That defeats an attacker who copies the file off the
machine. **It does not defeat software already running as you**, because DPAPI binds the
ciphertext to the *user*, not to this application. It is the same protection Chrome gives
cookies. If the OS store is unavailable the wallet path **refuses** rather than writing a
plaintext key, because a "secret store" that quietly writes cleartext is worse than none.

Nothing is written to the repo, and nothing is written in plaintext anywhere.

---

## Shape

```
src/auth.ts       the two flows: SIWE against /oauth/verify, RFC 8252 loopback + PKCE,
                  and refreshBearer — renewal with no user present
src/secrets.ts    safeStorage, and an explicit refusal when it is not available
src/main.ts       the privileged half — holds the bearer, renews it, exposes the IPC channels
src/preload.ts    the whole surface the renderer gets: describe, sign in, call a tool,
                  read the session and be told when it changes
src/renderer.ts   draws; every substrate decision comes from @interego/workspace-client
src/selftest.ts   the headless live run above
```

**The bearer never crosses the IPC boundary.** The renderer asks for a tool call by name and
arguments; the main process attaches the credential. The renderer is the half that displays
bytes other people wrote, so it is the half that must not hold a token.

**Nothing here fetches a descriptor URL.** They come back as
`http://css.railway.internal:3456/...`, an address inside the fleet — unreachable from a
laptop. `get_descriptor` is the only way to turn one into bytes, and it is what the client uses.

**Cold start is 12-16 s on a fresh identity**, because the first pod-aware call provisions a
pod. Measured again while this shell was built: **16.7 s** for a brand-new wallet, **1.8 s** for
one whose pod already existed, and **30.0 s** for the packaged app's first run. The boot
checklist counts up and names the step rather than showing a spinner.

---

## The watch, and why it re-reads instead of subscribing

`RelayMcpTransport.watchTool()` used to return `null` and every caller polled on its own. Before
replacing that, the relay was **asked what a watch could actually be**
(`tools/probe-watch-live.ts`, two bearers, two real pods, 2026-08-06):

```
GET /notifications/<slug of my OWN pod>   -> 400 {"error":"pod_url_rejected",
                                                  "detail":"pod URL must use https"}
GET /notifications/<slug of ANOTHER pod>  -> 404 {"error":"unknown_pod_slug"}
GET /sse                                  -> 200 text/event-stream
```

The per-pod SolidNotifications channel is the one shaped right — its events carry `podUrl`,
`descriptorUrl`, `graphUrl` and an eventType — and it is **unreachable on this deployment in
both directions**. Outward: its gate runs every pod URL through `assertPublicPodUrl`, and this
fleet's pods *are* `http://css.railway.internal:3456/…`, so the relay's own guard rejects the
relay's own pods before authorization is even considered. Inward: the same gate requires the
slug's pod to be a prefix of the bearer's own, so even repaired it could never open a channel on
**another member's** log — which is the only thing a workspace watch is for.

`GET /sse` connects and is not a subscription. It re-sends the last five entries of a
recent-activity ring every 2 s, and the frames carry a `resource` with no pod and no graph IRI.
Measured 2026-08-06: 5 frames in 8 s, four of them identical. A reader cannot tell which graph
an event is about, or a new one from a repeat.

**One line of that measurement was also a security finding.** This paragraph used to add "one
process-global ring, not a per-pod queue" as evidence the channel was too coarse to watch on.
The ring was fed by *every* pod's publish and `/sse` sits behind a gate that checks only that a
bearer is valid — so any authenticated client received the descriptor URL and timestamp of every
write on the fleet, on pods it had no relationship with. Reproduced on 2026-08-07 with two
disposable identities (`tools/probe-notification-scope-live.ts`) and closed the same day: the
ring is keyed by pod, `/sse` serves only the connection's own, and `get_pod_status` returns
`recentNotifications` only to the pod's proven owner. See
`deploy/mcp-relay/notification-log.ts`.

The conclusion below is unchanged and now holds more strongly: scoped to your own pod, this
channel cannot carry another member's log even in principle.

So there is nothing to subscribe to, and what got built is what the interface's own
`refetchInterval` option already describes: **re-read on a timer, fire an event only when the
answer changes**. That is a real event — the answer to this exact read differs from last time —
and it is not what a push would be, so the difference is published on
`Transport.watchDescription` and printed under the composer instead of the word "live".

One implementation, not two: `pollingWatch` lives in the module and is bound by *both*
`RelayMcpTransport` (main process) and the renderer's own bridge. Without the second binding the
desktop had **no watch at all** — the renderer drives a `ConnectorTransport` over IPC, whose
`watchTool` returns null when the host object has none, so every log fell straight to the
one-shot fallback and the channel never moved again. That was found by driving the renderer in a
document; typechecking could not see it.

---

## Packaging

```sh
npm run package       --workspace @interego/workspace-desktop   # Windows: zip + NSIS
npm run package:linux --workspace @interego/workspace-desktop   # Linux:   AppImage + deb
npm run package:mac   --workspace @interego/workspace-desktop   # macOS:   zip + dmg
```

### What has actually been built, and where

★ **This table separates "configured" from "built", because a target asserted as working and
never run is worse than one marked untested.** Everything below was measured on the maintainer's
machine — Windows 10 x64, electron-builder 25.1.8, Electron 33.4.11 — on 2026-08-07.

| target | status here | evidence |
|---|---|---|
| **win** `zip` + `nsis` | **BUILT** | `Interego Workspace-0.1.0-win.zip` 115,482,536 B, `…-setup.exe` 84,771,195 B, `win-unpacked/` 285 MB. Rebuilt from scratch after the mac/linux sections were added, so those additions are known not to have broken the working target. |
| **linux** app tree (`--linux dir`) | **BUILT** | `release/linux-unpacked/` — 279 MB. The real `linux-x64` Electron runtime is downloaded and the app packed into it; `resources/app.asar` is present. The application packs for Linux on this machine; only the two Linux *package formats* do not. |
| **linux** `AppImage` | **NOT BUILDABLE ON WINDOWS** | `⨯ cannot execute … appimage-12.0.1\linux-x64\mksquashfs: file does not exist`. The file IS in the cache; it is a Linux **ELF** (`\x7fELF` verified), so Windows cannot exec it and Node reports the spawn failure as ENOENT. |
| **linux** `deb` | **NOT BUILDABLE ON WINDOWS** | `⨯ cannot execute  cause=exec: "fpm": executable file not found in %PATH%`. electron-builder shells out to `fpm`, which is not shipped for Windows hosts. |
| **mac** `zip` + `dmg` | **CONFIGURED, UNVERIFIED** | Never run. There is no macOS machine on this project, and `dmg` cannot be produced off a Mac at all. Nothing here has been launched, and `safeStorage` has never been exercised on macOS. |

So: **Linux packages need a Linux host** (or Docker / WSL — untried here), and **macOS needs a
Mac**. The configuration for both is committed and reviewable; only the Windows artifacts and
the Linux *unpacked* tree have been produced.

Two things the first Linux attempt turned up, both now fixed in the config rather than left for
whoever next runs it on a Linux box: `deb` is a **hard failure** without a `homepage` (added to
`package.json`) and without a maintainer email (`linux.maintainer` in `electron-builder.yml` —
`author` carries no address). And `deb.depends` names `libsecret-1-0` explicitly, because
`safeStorage` — where the wallet key lives — is backed by libsecret on Linux; omit it and the
app starts, looks healthy, and silently cannot persist a key.

**Unsigned, and not notarised.** `signAndEditExecutable: false`, `mac.identity: null` and
`forceCodeSigning: false` in `electron-builder.yml` are deliberate: there is no certificate.
Windows SmartScreen warns on first run of the `.exe` and macOS Gatekeeper refuses to open the
`.app`; **both warnings are accurate** — the binaries are not signed by anybody either OS
recognises. Signing and notarisation are out of scope here, and neither is faked.

`electronVersion` is pinned in `electron-builder.yml` because this is an npm **workspace**:
electron-builder looks for `electron` in the package's own `node_modules`, npm hoists it to the
repo root, and the range `^33.0.0` is not something it will guess from. If the two diverge the
package step fails loudly rather than packaging against a runtime nobody tested.

---

## What is tested, and how

| | |
|---|---|
| `tests/workspace-desktop-renderer.test.ts` | **the renderer, driven as a real script in a real DOM.** esbuild bundles `src/renderer.ts` the same way `npm run build` does, jsdom loads the shipping `index.html`, and the whole of `@interego/workspace-client` runs unstubbed. Exactly one thing is scripted: `window.interego`, the IPC channel. 34 cases, each one a sentence the shell must or must not be able to put on screen. |
| `tests/workspace-client-membership.test.ts` | the writers, grant verification, the canvas outcomes, the role-label rule. |
| `tools/drive-membership-live.ts` | the same module functions against the **live fleet**, two real identities, two real pods. |

The bundle is built **inside** the renderer test rather than read from `dist/`, so a stale build
cannot hide a change — that has happened twice in this repo, once hiding a fix and once hiding a
removal.

---

## Why Electron and not Tauri

Tauri is the better shape — no bundled Chromium, ~10 MB instead of ~200 MB — and this machine
already has what its native half needs: WebView2 151.0.4129.59, MSVC 14.44.35207, Windows SDK
10.0.26100.0. What it does **not** have is a Rust toolchain: `cargo --version` and
`rustc --version` both answer *command not found*. Shipping a Tauri app from here would mean
shipping one that had never been built or run.

Two smaller reasons point the same way. The wallet path needs secp256k1 signing and an OS
secret store in the privileged process, which Electron gives in TypeScript (`ethers`,
`safeStorage`); Tauri would need Rust for both. And the loopback receiver is a Node HTTP
server, which *is* the Electron main process and would be a Rust task there.

**What would change to switch:** nothing in `@interego/workspace-client`, and nothing in
`auth.ts` beyond the transport of three IPC calls. That surface was kept to three channels for
this reason.
