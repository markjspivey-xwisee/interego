# A Discord bot that turns a thread into a record

`/workspace start` in a Discord thread creates a `wsp:` workspace on the caller's **own pod**.
From then on, each linked participant's messages land as signed, chained `wsp:Entry` records on
**their own pod**. Discord is the interface; the substrate is the record. When the thread scrolls
away, or the server dies, or someone leaves, the record still stands: dereferenceable,
per-author, content-bound, chain intact.

The workspace this bot creates is the same workspace the desktop app and the published artifact
read and write. It is a third **client** of `@interego/workspace-client`, not a third
implementation — the naming scheme, the seat fold, the chain walk, the Turtle writers and the
compare-and-swap append are all the module's.

---

## The identity decision, and why

**A Discord user has no Interego identity.** Whose pod does their message land on?

This bot answers: **the pod they proved they control, written to under a delegation THEY
published on it.** The bot never holds a credential of anybody's but its own.

### How it works

1. `/workspace link` — the bot replies privately with its own agent DID and the exact call to
   make. It mints nothing secret; see below.
2. The participant, **from their own Interego client** (desktop app, published workspace page, or
   an MCP connector), publishes a delegation on their own pod:

   ```
   register_agent { agent_id: "<the bot's agent DID>", scope: "PublishOnly",
                    label: "discord-link <their own Discord user id>" }
   ```

   `register_agent` is own-pod gated at the relay (`requireOwnPod`) — nobody can write that row
   on somebody else's pod, including the bot.
3. `/workspace link-confirm pod:<their pod>` — the bot checks, from the substrate alone:
   - the pod's own delegation registry lists the bot's agent, un-revoked;
   - that row's `label` is exactly `discord-link <the id of the account running this command>`;
   - `verify_agent` reports `enforcement.writeEligible: true` **and** echoes back the pod it
     actually examined.

   Only then is the Discord account bound to the pod.

**Why the label, and not just `verify_agent`.** `verify_agent` answers "may this agent write to
that pod". It does not answer "is that pod this Discord user's" — nothing in the substrate knows
what a Discord user is. Without the label, the moment one person delegates the bot, any other
Discord account could name that pod and have its words written there.

**★ Why the label is not a secret.** The obvious design — mint a nonce, ask the claimant to
publish it, treat possession as proof — is wrong here, and a test written to check that the nonce
was never *rendered* is what surfaced it. **A delegation row is world-readable**:
`get_pod_status { pod_name: <anyone's> }` answers for any pod and returns
`delegationRegistry.rows` with their labels (measured live). So publishing the nonce publishes
it, and whoever reads that pod first can present it and bind *their* Discord account to *your*
pod — after which their messages land on your pod under your WebID, and your own confirm fails
with "already claimed". That is a record falsely attributed, the one outcome this bot must not
produce.

So the label is the claim itself rather than a proof of one: the pod's owner writing, in a
document only they can write, *"I authorise this agent on behalf of Discord account U."* A reader
learns nothing new — a Discord id is already public — and can do nothing with it, because the bot
computes the label it looks for from the id of the account **actually running the confirm**. To
bind pod P to account A you must control P *and* be A. Nothing expires, nothing leaks, and there
is nothing to race.

### Why not hold the user's own OAuth bearer

That was the other real option — run the relay's authorization flow per participant and keep the
bearer. Rejected:

- **Scope.** A relay OAuth bearer is the user's *whole* identity. It can `register_agent` with
  `tenant_admin`, revoke their other agents, read their inbox, and publish anywhere they can. A
  delegation row is one named agent with `PublishOnly`.
- **Revocation.** `revoke_agent` is the owner's unilateral act on their own pod. It works whether
  or not this bot cooperates and whether or not this bot is running. Deleting a stored bearer
  requires the bot to be honest about having done it.
- **The consent is part of the record.** The delegation is a document on the participant's pod
  that any third party can check with `verify_agent`. A token in the bot's database is not.
- **No callback.** An authorization code has to be delivered somewhere; a chat bot has no
  browser. Delegation needs no redirect at all.

### Why not "the bot holds one pod and records everything"

Because that is a single authority holding everyone's words, which is the model this whole
argument is against. The record would be the bot's, attributed to Discord handles, and would die
with the bot.

---

## What a signature on these entries proves — and what it does not

Measured against the live relay on 2026-08-07, on both delegated and own-pod writes:

**It proves.** The relay signed a statement that the caller it had authenticated as
`<the bot's agent DID>` published this descriptor to this pod, and — because
`contentBinding: bound-at-signing` — the signed payload commits to a digest of the entry's
canonical triples. The text cannot be changed afterwards without the proof failing.

**It does not prove.** That the participant's own key signed anything. The proof's
`verificationMethod` is `did:ethr:0xd144353a…3331` — the relay's own delegation signer, **one
key, the same for every pod and every agent on this deployment**. It is not a wallet signature
and it is not evidence that a human signed. It also says nothing about whether the pod owner
authorised that agent; that is a separate document — the pod's own delegation registry.

The chain of attribution, in full: *entry → signed by the relay as agent B → B delegated on pod P
by P's owner, in a document only P's owner can write → that document names Discord account U, and
U is who ran the confirm*. Every link is independently checkable, and the last one rests on the
pod owner having written U's id rather than somebody else's — which they can only be tricked into,
never raced out of.

The bot renders all of this after every append rather than saying "recorded and signed".

---

## Two honest limits

**`PublishOnly` is pod-wide.** The substrate has no per-graph delegation scope, so a participant
who links is letting this bot publish *any* graph to their pod, not only workspace entries. What
bounds it is that it is one named agent, every write is content-bound and attributed to it, and
withdrawal is unilateral. The link instruction says this in as many words.

**Revocation is enforced by the bot before it is enforced by the relay.** Measured 2026-08-07:
immediately after `revoke_agent`, the relay still ACCEPTED the bot's next cross-pod publish — its
scope gate caches per (agent, pod) for `AGENT_REGISTRATION_CACHE_TTL_MS`, 60 s on this deployment.
`verify_agent` is not cached and answered correctly at once. So this bot asks before every write
and stops itself; it does not lean on the relay to stop it.

---

## Commands

| Command | What it does |
| --- | --- |
| `/workspace start` | Creates the five workspace documents on the caller's own pod and seats them as convener. The slug is derived from the thread id, so the IRI is `<relay>/ns/<convener pod>/d-<thread id>`. |
| `/workspace link` | Prints the bot's agent DID and the exact `register_agent` call to publish (private reply). |
| `/workspace link-confirm pod:<pod>` | Verifies the delegation and binds the account. |
| `/workspace unlink` | Makes the bot forget the binding. **Does not revoke** — it says so. |
| `/workspace show` | The composed view: roster with each non-seat's own reason, the newest entries from every seated member's own log, and the IRI anyone can follow. |
| `/workspace who` | Every agent addressable in this thread — one line per delegate of **every seated pod, not only yours** — with whether its host is running, whose pod authorises it, and whether its scope lets it append. |
| `/workspace ask agent:<pick> task:<what>` | Puts a request on the record addressed to **one** agent. `agent:` autocompletes live against each seated pod's own registry and submits the full agent DID; a label matching two delegates is refused rather than guessed. |

**A Discord `@mention` is not an address and is never read as one.** A mention resolves to a
Discord account, which this bot's index maps to one pod, which that pod's registry maps to N
delegates — half an address. The addressable unit is the delegate's agent DID, and `/workspace ask`
is the only thing that sets one. An ordinary message, mentions and all, is written unaddressed.

Messages from a linked participant in a started thread become entries on their pod. A participant
who is **not** linked is ignored — visibly: the bot says once, in the thread, that nothing of
theirs has been written anywhere. Unlinked people can talk freely and nothing is recorded.

A linked participant who has not been seated yet is seated on first speaking: a Contributor grant
on the convener's pod and an acceptance on their own. Both halves need a live delegation on the
respective pod, so neither can be manufactured.

---

## What the maintainer must supply

Two secrets. **Neither may ever be in the repo**; both are read from the environment only and
there is no config file and no default.

| Variable | What | Where it comes from |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | the bot token | Discord Developer Portal → your application → Bot → Reset Token |
| `INTEREGO_BOT_KEY` | a secp256k1 private key, `0x`-prefixed | `openssl rand -hex 32`, prefixed with `0x`. This is the bot's **own** identity — it decides the bot's pod and its agent DID, so keep it: a new key is a new agent, and every participant would have to delegate again. |

Optional: `INTEREGO_RELAY` (default `https://relay.interego.xwisee.com`),
`INTEREGO_IDENTITY` (default `https://identity.interego.xwisee.com`),
`INTEREGO_DISCORD_STATE` (default `~/.interego/discord-workspace.json`).

### In the Discord Developer Portal

1. Create an application, add a Bot.
2. **Bot → Privileged Gateway Intents → MESSAGE CONTENT: ON.** Without it the gateway connects
   and every message arrives with empty content. The bot treats close code 4014 as fatal and
   names this toggle rather than recording blanks.
3. OAuth2 → URL Generator → scopes `bot` + `applications.commands`; bot permissions
   *Send Messages*, *Read Message History*, *Use Slash Commands*. Invite it to a server.

### Run it

```bash
export DISCORD_BOT_TOKEN=...
export INTEREGO_BOT_KEY=0x...
npm start --workspace @interego/workspace-discord
```

It prints its pod, its wallet address, and **its agent DID — the string participants delegate**.
Slash commands are registered on start; Discord can take up to an hour to roll global commands
out.

To register the commands and exit:

```bash
npm run register-commands --workspace @interego/workspace-discord
```

### Deploying it on the fleet, and the full two-person setup

Running it locally is above. To deploy it as a service on Railway — the same GHCR-image path every
other service uses — and for the complete start-to-finish setup (creating the Discord application,
the MESSAGE CONTENT intent and what its absence looks like, the invite URL's exact scopes and
permissions, generating `INTEREGO_BOT_KEY` and what losing it means, and the ordered flow two
people follow to link their pods and record a thread), see **[`DEPLOY.md`](DEPLOY.md)**.

---

## What was driven live, and what was not

```bash
npx tsx applications/shared-workspace/discord/tools/drive-bot-live.ts
npx tsx applications/shared-workspace/discord/tools/probe-delegation-live.ts
```

`drive-bot-live.ts` mints three disposable identities, has two of them publish real delegations
from their own clients, and then runs **the bot's own command functions** against
`https://relay.interego.xwisee.com`: refuse before linking, refuse a pod that delegated nothing,
refuse a junk pod, link, read the published label back from a *third party's* session and confirm
it still cannot be used to steal the pod, convene, ignore an unlinked speaker, append from two
authors onto two pods, advance a chain, fold the roster, compose the view, revoke and be refused,
unlink. All checks pass.

**Discord itself is not driven,** and cannot be from here: a real gateway connection needs a bot
token only the maintainer can supply. `src/discord.ts` is covered by `tests/gateway.test.ts`,
which drives the real class with the real JSON frames Discord sends — handshake, resume, invalid
session, the heartbeat-ack zombie, the privileged-intent close code, subcommand flattening, and
the REST layer's mention suppression and 429 handling. `src/main.ts` — the wiring between the two
halves — is exercised by neither and is the honest gap.

---

## Not in scope

Canvas; invitations issued from Discord (seating happens on first speech instead); agents
participating in-channel; more than one thread per workspace; message **edits and deletes** (an
edited Discord message does not amend the entry already written, and this bot does not pretend
otherwise); attachments; threads inside threads; sharding; per-route rate-limit buckets;
recovering a thread binding after the index file is lost (the workspace survives — see
`src/links.ts` — but the bot has to be told which pod convenes which thread again).
