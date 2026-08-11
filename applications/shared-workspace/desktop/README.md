# Interego Workspace — desktop shell

Against the **live** relay, with no fixtures anywhere in it:

    boot -> create an account with a passkey -> a pod is provisioned for you
         -> lobby: getting set up, who you are, your inbox, the workspaces you accepted
         -> your agent's model (your own subscription, or an honest "not here")
         -> link Discord by publishing the delegation on your own pod
         -> create a workspace / invite somebody / accept an invitation
         -> channel: roster, stream, canvas
         -> post an entry, save the canvas, meet a 412 and merge forward
         -> turn your agent on: it drafts into the composer and stops

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
| authorise a delegate on your own pod, and revoke it | `delegatePlan` / `publishDelegation` / `revokeDelegation` / `readDelegates` | yes |
| run one of your delegates on your own model subscription | `decideTurn` / `briefPrompt` / `checkDraft` / `delegateCeiling` + `modelprovider.ts` | yes |
| tell a delegate's entry from its delegator's, as a reader | `readEntryAuthorship` / `authorshipLine` | yes |
| **address a message to one named agent — yours or another member's** | `postEntry`'s `addressedTo` → `iep:addressedTo` in the signed region, `notifyAsk` for an absent host | yes |
| **receive one, and refuse an inbox notice not addressed to a key held here** | `readRequests` / `verifyRequest` | yes |

**Addressing and authorship are different axes, and the two controls are deliberately far apart.**
"Speaking as" above the composer picks which of *your own* delegates is activated to compose — an
author, written as `prov:wasAttributedTo`. **Ask** on a roster row picks who a message is *for* —
an addressee, written as `iep:addressedTo`, usually somebody else's agent. Neither is inferred
from the other by any reader, and an entry may carry one, both, or neither.

Every delegate row above comes from **`@interego/core/delegate`**, not from the workspace package.
"An identity a person authorises to act for them" is an Interego concept — it sits beside the
`AuthorizedAgentData` / signed-VC / `verifyDelegation` model that has always carried `delegatedBy` —
so this app, the Discord conduit and the published artifact all reach it from the layer below
rather than from each other. `@interego/workspace-client` re-exports it and adds exactly two things
of its own: `delegateCeiling`, which composes the substrate's scope ceiling with a workspace ROLE
ceiling, and `readEntryAuthorship`, a Turtle adapter over the substrate's `judgeAuthorship`.

---

## What a brand-new user does, start to finish, with nothing but the app

1. **Open it and press *Create an account with a passkey*.** Windows Hello / Touch ID both creates
   the account and signs in; there is no password and no sign-up form. The ceremony happens in the
   system browser rather than in this window, because `clientDataJSON.origin` has to be the
   identity server's and a page loaded from disk cannot produce one — that also means a real
   platform authenticator instead of a soft key this program made up. First run takes **anywhere
   from about 2 s to about 31 s** while the relay provisions a pod — measured at both ends, so
   half a minute is normal and is not a hang; the boot checklist counts up and names the step
   rather than spinning. Wallet sign-in stays on the same card for people who already have a
   `u-eth-…` pod.
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

It mints four identities — two people and **two delegates of the first** — authorises both
delegates on A's own pod, creates and accepts a workspace across both people, has A type something
and B ask a real question, runs A's first delegate for real and appends its answer *under the
delegate's own session*, proves a sibling delegate refuses to answer the same message twice, has
the second delegate answer the next one, reads all three authors back apart by dereferencing, and
revokes the first. It also measures the identity property directly: the same key signed in twice
under `DELEGATE_SURFACE` is the same delegate, and signed in under a different OAuth client name is
a different one — which is why the constant exists. All checks pass.


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

### Whose entry it is — settled, and it is not you

**An agent is a DELEGATE. It is not you, and the record says so.** The previous version of this
section described the opposite as a defensible open question: the local agent ran under your
session, appended to your log, and produced an entry indistinguishable from one you typed. That
was wrong at the level of the whole proposition — if a reader cannot tell *Mark said* from *Mark's
agent said*, the provenance this substrate exists to preserve is gone.

What ships now:

* **A delegate has its own key and its own agent id.** You mint one (or adopt one minted
  elsewhere) and *you* authorise it, with `register_agent` on your own pod — the same own-pod-gated
  row you use for the Discord bot, and `revoke_agent` withdraws it unilaterally.
* **Its identity is not this app.** Measured against the live relay: the agent id the relay issues
  is `did:web:<identity host>:agents:<oauth client_name>-<pod>`, so the client name is *inside* the
  identity. Delegates therefore sign in under one shared constant, `DELEGATE_SURFACE`, not under
  this app's name — the same key is the same delegate in any client that holds it. Minting shows
  you the key once, and there is an import field, so a delegate can move machines.
* **Delegates are plural.** One person may authorise several — an Anthropic-backed one and an
  OpenAI-backed one — each with its own scope, each revocable alone, all writing into the same log
  and all distinguishable. The provider is how a delegate *thinks*, not who it is: two delegates
  can run on the same one.
* **The entry says who wrote it.** `prov:wasAttributedTo <the delegate>`, plus
  `<the delegate> prov:actedOnBehalfOf <you>`. Your own entries carry
  `prov:wasAttributedTo <your WebID>` and no delegation statement — required on *both*, because if
  only one form carried an author then "no author" would have to be read as "the human", and
  absence is not evidence. The workspace's own published shape requires it, so the relay refuses an
  entry that names nobody.
* **A delegate's write is made under the delegate's own relay session,** not yours. So the relay
  authenticates it, the write is scope-gated on your `register_agent` row, and `revoke_agent`
  actually stops it.
* **Its ceiling is its own.** Two ceilings, both narrowing: your seat's role, which it inherits and
  cannot exceed, and the scope you gave *that* delegate. A delegate granted `ReadOnly` cannot post
  even though you can, and its sibling granted `PublishOnly` still can.
* **The draft still goes in the composer, and Post is withheld while it sits there unedited.** Post
  appends as *you*; the delegate has its own Send. The same text through the two buttons makes two
  different records and only one of them is true. Change a character and the words are yours again.

**A conduit is not a delegate, and that line did not move.** The Discord bot relays a message you
*typed*: you wrote the words, so the entry is yours and is attributed to you. Only text an agent
*composed* is the agent's. `discord/tests/record.test.ts` drives the real record path and pins it.

**What the signature proves, exactly.** Measured on this relay, on a delegated write and an
own-pod write alike: the proof's `verificationMethod` is one key — the relay's own delegation
signer, identical for every pod and every agent here. Only the `issuer` distinguishes them. So the
panel says *the relay signed a statement that the caller it authenticated as `<did>` published
this*, and says outright that it is **not** the delegate's own wallet. Nothing on any screen in
this app says "signed by your delegate".

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

### And then a second review refuted the fixes

The same exercise was run again against the corrected code. It refuted nearly all of it, including
one thing neither the first review nor the live drive could have shown.

**`at` is not a fact — it is a number the other member chose.** `SeenEntry.at` comes from
`validFrom`, which comes from the **optional `valid_from` argument to `publish_context`**. So the
whole "have I spoken since they did" guard was arithmetic on a value the author of the entry
supplies. One member publishing an entry dated a year ahead makes every reply of mine permanently
"older" than theirs: the guard never fires and the agent answers that entry on **every poll,
forever**. Dating one in the past does the mirror and makes the agent mute toward that member. The
renderer's own comment already called cross-stream time *advisory* — "these clocks were never
synchronised, and there is no shared sequencer" — for **rendering order**; promoting it to
authoritative for a **write** was the error. The client's own record of what it has answered is now
the primary guard, because it is the one input another member cannot touch, and the timestamps are
a secondary signal that can only add refusals. **Its limit is stated rather than hidden:** the
record is per-run, so a restart between drafting and posting can produce one duplicate — bounded,
and visible in the composer first.

**The exclusion of undated entries was asymmetric.** For *their* entries "cannot be placed" means
"never new", which is safe. For *mine* it meant "never spoke" — the guard was skipped entirely and
the loop returned. An undated entry of the agent's own is now a refusal.

**Unread rows were still being skipped silently.** A descriptor whose *signed region* could not be
located comes back with no `error` and `isEntry: false`. The shell renders that to the human as
"body unread"; the agent read the same row as "not an entry" and skipped it without counting it.

**And the partial-read refusal had become a permanent mute.** Failed body reads were cached forever
— `rows.filter(r => !S.bodies.has(r.url))` never retries — so one transient 502 anywhere shut the
agent down for the rest of the session, with copy that read as momentary. Failures are now evicted
so the next poll is the retry.

**The composer wipe destroyed the user's own typing**, unconditionally, on every workspace change —
against this file's own rule ("locked, not emptied"). Only a draft the agent put there is discarded
now.

**`agent:cancel` still could not stop the probe.** The claim that a turn "has no child of its own to
kill yet" was simply false: `probeClaude` spawns one under a 20-second timeout and never plumbed its
killer out. And `agent:cancel` returned the set size as `stopped`, counting turns it had only
*flagged* — so the renderer said "Stopped" about a process nobody had signalled. It now reports
`flagged` and `killed` separately.

**Only one of three streams was guarded.** `stdout` and `stderr` are torn down on the same paths as
`stdin` and had no `error` listener.

**Absence was still being asserted in two places.** `renderModelCard` hard-coded "the tool is not
here to ask" for every `loggedIn: null` — false in three of the four cases, which print "installed:
yes, at C:\…" on the row above. And `renderAgent` hid the whole panel when `S.seats` was empty,
which is equally the state of *an unread roster*: a convener pod that did not answer silently drew
"you are not seated" as an established fact.

**One defect it found has nothing to do with the agent.** `teardownWorkspace` reset `S.canvas` and
never cleared the canvas *textarea*, and `loadCanvas` returns early for a canvas that does not exist
yet — leaving one workspace's unsaved text in the box with a "Create on your pod" button now
pointing at a **different** workspace's canvas IRI. One press published it there. Fixed here because
it is the same shape as the agent's own leak, one box over.

**And two of the tests were false witnesses.** The renderer's undated-entry case passed with the
defect restored — the scripted store substitutes a default `validFrom`, so it could never produce
the input the case was named for. It has been removed and replaced by module-level tests at the
altitude where the ordering is decided, each one verified to FAIL against its own revert before
being kept. The `modelprovider` cases are honest but characterize only pure functions: the EPIPE
fix has no test, and nothing exercises the `Turn` lifecycle in `main.ts`.

**Known and not fixed:** an active IME preedit is not protected by the composer guard (it tests
`.value`, which a preedit has not yet committed); `cp.kill()` on Windows terminates one process
rather than a tree; `agent:cancel` is not scoped per window (unreachable today — the app only opens
a second window when zero exist); `setupSteps` keys its finding-against on `providers[0]` while the
positive keys on `find(usable)`, which agree only while there is one provider; and the `Turn`
lifecycle in `main.ts` has no automated test at all.

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

`challengeLabel` and `SNOWFLAKE_RX` are **one definition, in `@interego/workspace-discord`**, and
this shell depends on that package for the link plan. The comment on `challengeLabel` warned that
"two format sites is how a link flow comes to reject every honest user" while the bot was still the
only site; a copy here would have made that come true. They spent a round inside
`@interego/workspace-client`, which fixed the duplication and created a worse problem — a Discord
snowflake regex in the package that the published artifact, this shell and the bot all bundle,
including an artifact with no Discord feature at all. Every other conduit would have arrived the
same way, one regex at a time. They now live in the conduit that owns them; still one site.

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

## The three ways to sign in

All end at the **same** credential — an OAuth bearer minted by the relay's own authorization
server at `POST /token`. SIWE and WebAuthn are two ways of satisfying `POST /oauth/verify` for
one pending authorization, not two token types. What differs is the pod the relay provisions,
and that is permanent:

| Sign-in | Where the secret is | Pod prefix | Browser needed |
|---|---|---|---|
| Wallet key on this machine | OS secret store (`safeStorage`) | `u-eth-...` | no |
| **A wallet key you already have** | OS secret store, after you paste it | whatever pod that key owns | no |
| Sign in in my browser (passkey / Windows Hello) | the platform authenticator | `u-pk-...` | yes |

### Signing in as an identity you already have, and why the app was broken without it

"Use a wallet key on this machine" **mints** a key when it does not find one, and until this
change there was no way to hand it a key you already had. Somebody whose pod already holds
everything they have written — from the Discord conduit, from another machine, from the
published artifact — signed in here and got a **third, empty identity**, with no path back to
the one that is actually theirs. That is not cosmetic: two identities belonging to one human
split the roster into two members, split attribution between them, and make "whose delegate is
that agent" unanswerable.

So the sign-in card takes a `0x`-prefixed secp256k1 key, derives the address, signs in by SIWE
as whatever pod that key owns, and stores it exactly as a minted key is stored.

**No key is ever replaced.** Account keys are stored under the address of the key inside them
(`account-0x…`), the same scheme delegate keys already used, so importing a second identity
**adds** one. There is no code path that discards a private key, because a private key is the
whole of an identity: no registry, no recovery, nobody to ask. The sign-in screen lists every
key this machine holds, says which one the plain wallet button uses, and lets you sign in as any
of them. **Sign out** (in the header) drops the session and keeps every key — that is what makes
switching possible without relaunching. Deleting a key is a separate, confirmed act whose dialog
names the pod that becomes unreachable.

An install from before this change has its only key in the single legacy `wallet-privkey` slot.
It is **copied** into an address-named one at startup and the legacy file is left exactly where
it was — removing it after a successful copy would be tidier, and would also mean that a bug in
the copy costs somebody their pod.

**A pasted key that is not a key is refused by name, not as "invalid".** `src/privatekey.ts` is
one parser used by both the account import and the delegate import (which previously had its own
regex and its own single sentence). A pasted **address** is told it is the public half; a copy
that wrapped is told it has a space in it and is *not* silently spliced back together; a short
copy is told it is short; and 64 valid hex digits that are zero or at/above the secp256k1 group
order — the case a length-and-hex regex waves straight through — are refused for that reason.
The renderer runs it before anything crosses IPC and the main process runs it again as the guard.

Measured against the live fleet on 2026-08-09, driving the shipping app with the maintainer's own
key (`tools/drive-account-import-live.ts`): sign-in reached `u-eth-8f3b8e939600` in 2.2 s, the
key appeared nowhere in the rendered document, and the lobby listed the workspace created from
**Discord** — `…/ns/u-eth-8f3b8e939600/d-1535759551247417436`, titled "workspace" — whose stream
rendered its `hello workspace!` entry. Neither client owns that workspace; the pod does.

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
src/privatekey.ts what a pasted key is, and — when it is not one — exactly what is wrong
                  with it; one parser for the account import and the delegate import
src/secrets.ts    safeStorage, and an explicit refusal when it is not available;
                  account and delegate keys both named after the address inside them,
                  so nothing an import does can overwrite an identity
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

**Cold start on a fresh identity is 2–31 s** — re-measured 2026-08-08, two brand-new wallets
signed in minutes apart through `npm run selftest`, one taking **2.5 s** and the other **30.7 s**
against the same fleet on the same code path. That order-of-magnitude spread is the finding: the
range quoted below (and previously in the boot copy) was drawn from a handful of runs on one
afternoon and was too narrow to be safe, because a user told "12 to 17 seconds" who waits thirty
concludes it has hung and kills the app mid-provision. The user-facing copy now quotes the slow
end. The older figures, all still valid observations, follow.

Historically: **12-16 s on a fresh identity**, because the first pod-aware call provisions a
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
machine — Windows 10 x64, electron-builder 25.1.8, Electron 33.4.11 — re-measured 2026-08-11.

**The published build is `desktop-0.2.1`.** That sentence is here, at the top of this section and
not only inside a table cell, because the table said `0.1.0` for three hours after `0.2.0` shipped
(#313) — a version number is the one fact a reader takes on trust, so it gets its own line and is
updated in the same commit that publishes.

| target | status here | evidence |
|---|---|---|
| **win** `zip` + `nsis` | **BUILT, INSTALLED FROM THE PUBLISHED RELEASE, LAUNCHED, AND PUBLISHED** | `Interego Workspace-0.2.1-win.zip` 128,014,841 B, `…-setup.exe` 92,185,147 B, both built from `6d4ed0b` on a green master and attached to the `desktop-0.2.1` GitHub release. The evidence is not that they packed: the setup was **downloaded back from the release URL** (SHA256 `679BF1C2…2098`, byte-identical to what was built), installed with `/S` over the running 0.2.0, and the registry then reported `Interego Workspace 0.2.1`. The installed `app.asar` was searched for the strings this release exists for (`withheldPanel`, `readModalStatus`, `withdrawn it as an assertion`) and carries all of them, so the bytes on disk are the fix and not a stale copy. It was then launch-smoked with `tools/ci-launch-smoke.ts` — `SMOKE OK: window reached did-finish-load and closed cleanly` — and started normally, where it held a window titled `Interego Workspace`. ★ **AND THE FIRST TWO LAUNCH ATTEMPTS EXITED 0 WITH NO WINDOW, WHICH WAS THE ENVIRONMENT AND NOT THE BUILD.** `ELECTRON_RUN_AS_NODE=1` is exported by the terminal an Electron-based editor spawns, and this agent's shell inherits it; with it set, Electron runs as plain Node, `app` is undefined and no window is ever created. It is the exact trap `ci-launch-smoke.ts` already strips, which is why the smoke passed on the same binary that had appeared dead. Unset it before launching the app by hand. |
| **linux** app tree (`--linux dir`) | **BUILT** | `release/linux-unpacked/` — 279 MB. The real `linux-x64` Electron runtime is downloaded and the app packed into it; `resources/app.asar` is present. The application packs for Linux on this machine; only the two Linux *package formats* do not. |
| **linux** `AppImage` | **NOT BUILDABLE ON WINDOWS; BUILT AND LAUNCHED IN CI; PUBLISHED** | On Windows: `⨯ cannot execute … appimage-12.0.1\linux-x64\mksquashfs: file does not exist`. The file IS in the cache; it is a Linux **ELF** (`\x7fELF` verified), so Windows cannot exec it and Node reports the spawn failure as ENOENT. On `ubuntu-latest`, `.github/workflows/desktop-package.yml` now builds this AppImage and then starts it headlessly under `xvfb-run` (via `tools/ci-launch-smoke.ts`, `--appimage-extract-and-run`), asserting the window reaches `did-finish-load` with the shipping sandbox enabled — so this target is now known to launch on Linux, not only to pack. Exactly one AppImage is produced, so unlike the macOS legs there is no ambiguity about which artifact was started: it is `Interego Workspace-<version>-x86_64.AppImage`, and that is the file attached to `desktop-0.2.0`. ★ **IT IS NOT ATTACHED TO `desktop-0.2.1`.** That release was cut from the maintainer's Windows machine, which cannot produce it, and nobody has yet downloaded the CI leg's artifact and attached it. So the Linux binary a person can install today is still the 0.2.0 one, and it does not contain this release's fix. |
| **linux** `deb` | **NOT BUILDABLE ON WINDOWS** | `⨯ cannot execute  cause=exec: "fpm": executable file not found in %PATH%`. electron-builder shells out to `fpm`, which is not shipped for Windows hosts. Built (not launch-tested) on the `ubuntu-latest` CI leg alongside the AppImage. |
| **mac** `zip` + `dmg` | **BUILT; ONE OF TWO ARCHITECTURES LAUNCHED IN CI; UNSIGNED, UNPUBLISHED** | Built on a `macos-latest` runner by `desktop-package.yml`, which then starts the packaged `.app` directly (`…/Contents/MacOS/Interego Workspace`, via `tools/ci-launch-smoke.ts`) and asserts it reaches a window. ★ **AND THAT IS WHY NO macOS BINARY SHIPPED WITH `desktop-0.2.0`, OR WITH `desktop-0.2.1`.** The leg produces **two** architectures — `release/mac/` (x64) and `release/mac-arm64/` — and the launch step is `app=$(ls -d "$rel"/mac*/*.app \| head -n1)`, which starts exactly ONE of them and never echoes which. So one of the two dmgs is a binary nobody has run, and the log does not say which one, so neither can be published. The fix is for that step to launch every `.app` it finds and print the path; until then this row stays UNPUBLISHED. Separately, the launch check never signs in, so `safeStorage` on macOS remains untested. |

So: **Linux packages need a Linux host** and **macOS needs a Mac**, and neither is this machine.
What is no longer true is that nothing checks them: `desktop-package.yml` runs the Windows,
macOS and Linux package scripts on hosted runners of each OS AND then launches each packaged
artifact headlessly, failing the leg if it does not reach a window. That gate exists because of a
specific failure — see below.

★ **AND THE BUILD WAS BROKEN FOR FOUR MERGES BEFORE ANYONE ASKED IT TO RUN.** At #289 (`16e1d98`)
`RelayClient` moved into the `@interego/core/relay` subpath export. This package's `tsconfig.json`
still said `"moduleResolution": "node"`, which predates `exports` and cannot resolve a subpath,
so `WorkspaceClient extends RelayClient` collapsed and `tsc` reported 48 errors — `podStatus`,
`tool`, `manifest`, `descriptor`, `tx`, `fetchProfileTurtle` all "does not exist". `npm run build`
exited non-zero, so `npm run package` never reached electron-builder and the app could not be
built at all. No gate went red, because no gate built it: `tools/typecheck-gate.mjs` compiles the
program described by `tsconfig.check.json`, which is a *different program with a different
resolver*. The resolver is now `bundler` — what esbuild, which does the actual emit, already
does — and `desktop-package.yml` is what makes the next such break visible on the PR that causes
it.

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
