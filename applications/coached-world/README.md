# Coached world

> **Vertical application of Interego — not part of the protocol, not a reference implementation of the protocol.** Vocabulary in `cpw:` lives in [`ontology/cpw.ttl`](ontology/cpw.ttl) and is published, byte for byte, at `docs/applications/coached-world/cpw.ttl`. Missions, causes, interventions and tiers are data in a world pack. Mandate is one pack. Nothing in the engine is named for it.

A human never commands a unit. They consult for an autonomous agent: they read what the agent did, name a cause, deploy an intervention the pack says addresses some cause, and measure the change. A fix that does not address the cause the pack drew does not move the score. Several consultants share one world. What the agents do is xAPI. What the world is, is Interego graphs.

The page-local prototype this replaces ran entirely in the browser and wrote nothing. This process is the first shared world.

## Run it

```bash
npx tsx applications/coached-world/demo/run.ts
```

Open the URL it prints (port 6191 unless `CPW_PORT` is set). **Join as guest** mints a provisional-play owner in this process — the same `ProvisionalPlay` class and the same proof templates identity serves (`deploy/identity/provisional-play.ts`). Pick a faction, send the agent on a mission, read the stream, diagnose, deploy. A second browser on the same URL sees the feed and the map move.

`CPW_BOTS=0` leaves the world to the people in it. Otherwise filler consultants settle missions on the same rules, on a timer.

When `CPW_PLAY_SERVICE_PRIVATE_KEY`, `CPW_PLAY_AUDIENCE` and `CPW_IDENTITY_URL` are set, grants go through Foxxi's `PlayGrantService` (`applications/foxxi-content-intelligence/src/play-grant.ts`) and the session is checked at identity's `POST /play/provisional/verify`. The browser proof does not change. That service account has to be an entry in identity's `PROVISIONAL_PLAY_CLIENTS`, with its own namespace (use `coached-world`, not the default). See `deploy/identity/PROVISIONAL-PLAY.md`.

`CPW_LRS_URL` (and optional `CPW_LRS_AUTHORIZATION`) is a Foxxi `/xapi/statements` endpoint. `CPW_LRS_ACTOR_HOME` is the home page on the course actor's account, the same value Foxxi calls its authoritative source. The gate query sends that home page with the guest's DID, the verb `https://w3id.org/xapi/adl/verbs/satisfied`, and the course IRI, and it follows `more`. A course statement's `passed` or `completed` names the assignable unit, so the gate does not read those. Foxxi's LMS writes `satisfied` for the course IRI when moveOn is met. If the LRS does not answer, the gate says `unreachable` and does not promote. Mission statements are still kept here.

`CPW_FOXXI_LAUNCH_URL` and `CPW_FOXXI_LAUNCH_KEY` turn on `POST /gate/launch`. That posts to Foxxi's existing `POST /agent/cmi5/launch`. The signed payload's `agent_id` is the consultant's DID and `course_id` is the pack's course. The key must be one Foxxi already accepts as that DID. This world does not mint a second guest.

The starter occupies one roster seat. The first tier's cap leaves another seat open, and a promotion stops one seat short of the new cap, so a marketplace transfer can land.

`CPW_PACK` is not read. Pass a pack by starting from code (`start({ packPath })`), or replace `packs/mandate.json` only as data. The engine loads whatever file it is given.

## Deploy it

`deploy/Dockerfile.coached-world-bridge` builds the image `interego-coached-world-bridge` (a row in `deploy/images.json`). It runs `bridge/server.ts`, which listens on `PORT` on every interface.

**Settings on the service.** Only the first is required.

| Setting | What it is |
|---|---|
| `BRIDGE_DEPLOYMENT_URL` | The https origin people use, with no path (`https://${{RAILWAY_PUBLIC_DOMAIN}}` on Railway, or the custom domain). `CPW_PUBLIC_URL` is read if this is unset. It becomes the guest audience, the address a browser bootstraps at, the base of every graph IRI and the DID host. A value that is not an https origin stops the process at start (http is allowed only for `localhost` and `127.0.0.1`). Without it the world names itself by its listen address and no guest can sign in from outside. |
| `CPW_BOTS` | `0` turns the filler consultants off. |
| `CPW_PLAY_SERVICE_PRIVATE_KEY`, `CPW_IDENTITY_URL` | Together they move guests from the in-process door to the real one (below). `CPW_RELAY_URL` names the relay if it is not the production one. Leave `CPW_PLAY_AUDIENCE` unset: the audience is the public URL, and a different value stops the process at start. |
| `CPW_LRS_URL`, `CPW_LRS_AUTHORIZATION`, `CPW_LRS_ACTOR_HOME` | The course record the tier gate reads. |
| `CPW_FOXXI_LAUNCH_URL`, `CPW_FOXXI_LAUNCH_KEY` | Turn on `POST /gate/launch`. |
| `INTEREGO_BUILD_SHA` | Not set by hand. The image bakes it from the `GIT_SHA` build argument. |

**One container, and the world is in it.** Territories, consultants, sessions and the statement log are memory in this process. Two containers would be two worlds, so the service runs one replica with no overlap on a deploy (`numReplicas` 1 set explicitly, `overlapSeconds` 0, `drainingSeconds` unset). Nothing is written to disk and no volume is needed.

**A restart or a redeploy starts a new world.** The map, every roster, every score and every session are gone. With the in-process door, the key that sealed guests' attestations is gone too, so the attestation a browser kept is refused (`401`). The page handles that itself: `public/guest.js` tries the kept attestation, and when it is refused asks for a fresh grant and bootstraps again with the same browser key. On the same public URL that yields the same owner DID, in a world that has never seen them, so they pick a faction again. With the real door (identity) the attestation survives a redeploy; the world's memory of the consultant still does not.

**`GET /health`** needs no session and is not counted against any limit. `build` is the field `tools/railway-redeploy.mjs` compares with the commit it deployed:

```json
{ "status": "ok", "build": "<40-hex commit, or unset>", "service": "coached-world-bridge",
  "startedAt": "2026-11-14T00:00:00.000Z", "pack": { "id": "<pack IRI>", "title": "Mandate" },
  "consultants": 0, "door": "local" }
```

**Request limits**, per client, in one-minute windows (`src/rate-limit.ts`): 30 for coming in (`POST /session/challenge`, `/play/grant`, `/play/provisional`, `/session`), 120 for writes, 240 for reads. Past a limit the answer is `429` with `Retry-After`. A client is an address: IPv4 whole, IPv6 by its /56. When a public URL is set the process takes itself to be behind a proxy and reads the last `X-Forwarded-For` entry, the one the proxy wrote; when none is set it uses the socket's peer and ignores the header. So set the public URL only where a proxy really is in front. Several people behind one address share that address's limits.

**What the process keeps** (`src/bounded.ts`): the newest 2,000 published graphs, the newest 2,000 statements of each origin, 100 lessons and 500 scores per agent, 5,000 consultants (then `world-full`), and 1,000 unexpired guests at the in-process door. `GET /graphs` answers `retained` and `dropped` beside the list. A descriptor's `iep:supersedes` may name one that has been dropped; it is still that descriptor's IRI.

**Not a Railway service yet.** `tools/railway-services.mjs` has no `coached-world-bridge` row, on purpose: that table is compared with the live project, and a row for a service that does not exist reads `MISSING` and fails the daily fleet audit. So merging this deploys nothing. To put it up: create the service `coached-world-bridge` from the image, set the settings above and the three singleton settings, give it a domain, then add the row beside `pev-bridge`:

```js
'coached-world-bridge': { repo: 'interego-coached-world-bridge', health: '/health', singleton: true, maxOverlapSeconds: 0, drainingMustBeUnset: true },
```

From that merge on, auto-deploy ships it whenever a file its image copies changes, and verifies `/health`. For real guests, also add this origin to identity's `PROVISIONAL_PLAY_CLIENTS` (see "Decisions for Georgio" below).

## What maps to what

| Game element | Primitive already in this repo | Where this world uses it |
|---|---|---|
| Anonymous player | Provisional play guests, `u-try-play-`, browser P-256 proof | `src/guest-play.ts` calls `ProvisionalPlay` from `deploy/identity/provisional-play.ts`. Production grants use `PlayGrantService`. The page (`public/guest.js`) signs `interego-play-provisional-v1` and `interego-play-proof-v1`. The world never takes a user id from the body. |
| Agent | A pod identity: DID, pod URL, a descriptor that names who controls it | `src/graphs.ts` `agentGraph`. Control is `cpw:controlledBy`. A transfer supersedes the descriptor. Memory is lessons on that graph. |
| Agent memory across missions | Descriptor version chain (`iep:supersedes`) | `src/world.ts` `putAgent` |
| Statement stream | xAPI 2.0 statements | `src/statements.ts`. Actor is the agent's DID. |
| Profile | "A profile you bring" — `applications/foxxi-content-intelligence/src/xapi-profile-supplied.ts` | `src/profile.ts` builds the document from the pack. Every statement is checked with `validateAgainstSuppliedProfile` before it is kept. `GET /profile` serves it. |
| Phone-roleplay | The same template shape (verb, object activity type, rules). v2 is a call-criterion profile; there is no v3 in this repo | Not copied. A call's greeting/closing criteria are not a cause. The pack names the verbs. Mandate's are `initialized`, `observed`, `progressed`, `measured`, all under the pack's profile IRI, none of them cmi5 `passed` or `completed`. |
| Cause and intervention | The pack, plus the descriptor's causal facet | `src/settle.ts` reads weights and `addresses`. `interventionGraph` uses `ContextDescriptor.intervention` (`iep:causalRole "Intervention"`, `iep:parentObservation`). |
| Mismatch has no effect | Settlement rule | `delta` is 0 unless `intervention.addresses === cause.id`. The numbers in the lift are `scoring` in the pack. |
| Territory, faction | Context descriptor + named graph | `territoryGraph`, `factionGraph`. Faction pods are `${base}factions/<id>/`. |
| Pact | Federation facet (`iep:FederationFacet`, `syncProtocol SolidNotifications`) between two faction graphs | `pactGraph`. Dissolving supersedes it with semiotic `Counterfactual`. |
| Tier gate | Foxxi `POST /agent/cmi5/launch` and the LMS `satisfied` statement (`cmi5-lms.ts`, verb `https://w3id.org/xapi/adl/verbs/satisfied`) | `src/course-launch.ts` posts the consultant's own DID as `agent_id`. `refreshGate` promotes when that DID's account, home page included, has a cmi5-category `satisfied` for the course IRI. This world does not edit `applications/practice-evidence` and does not write `passed` or `completed`. |
| Marketplace | A control change on the agent descriptor, price from the agent's own score history | `transfer` in `src/world.ts` |
| Leaderboard, season, feed | Derived from the same world index the graphs record | `view`. The clock is `season` in the pack. |
| Bot consultants | The same `settle` and the same statement builder | `tick`. They are fillers in this process, not pod identities. |
| Discovery | `iep:Affordance` | `affordances.ts`, `GET /affordances` (JSON or Turtle via `affordancesManifestTurtle`) |

The engine files (`src/settle.ts`, `src/statements.ts`, `src/profile.ts`, `src/world.ts`, `src/graphs.ts`, `src/server.ts`, `src/bounded.ts`, `src/rate-limit.ts`, `src/public-url.ts`) do not name Mandate or a faction. `tests/settle-and-profile.test.ts` reads them to keep it that way. `packs/orchard.json` is the other pack.

## What is genuinely not here

- **The world index is this process.** Graphs are the Interego record and can be read at `GET /graphs` (Turtle plus an EIP-191 signature over `canonicalJson` of the descriptor, recoverable to the process operator key, which `GET /world` names). They are not yet the store a second process rebuilds from, and only the newest are kept (see "Deploy it"). A restart forgets the live map. Putting those graphs on a pod, and booting from them, is the next step. `notify_agent` is the existing push for that, and this slice does not call it.
- **Practice Evidence is not invoked.** A "practice scenario" intervention is a label in the pack (`composes` tells the player which substrate piece it is). Deploying it does not author a `pev:` scenario. That is a later composition: the pack would name a scenario IRI, and the world would hand the guest the existing practice-evidence affordances.
- **The course is not launched from here.** Tier `courseIri` values in the Mandate pack are placeholders (`https://example.org/courses/coached-world/...`). Promotion watches the LRS for statements the course sends. Foxxi's player (`cmi5-player.ts`, PRs #866 / #870 / #872) and `GET /cmi5/reviewed` (PR #883) are how a course gets `passed` and `completed` after review. This service must not grow its own copy.
- **No live LRS in the tests.** `HttpLrs` is the reader. Tests record external statements in process.
- **Revocable registry** (`applications/foxxi-content-intelligence/src/revocable-registry.ts`) is the right home for a later "this transfer can be undone" grant. A transfer here is a superseding descriptor, not a revocable credential.
- **PGSL** is not on the write path. Descriptors are the record, which matches the live descriptor-primary path. A lattice projection can sit beside it later without changing settlement.
- **I2IDL-X** already has its own guest door (`i2idlx/app/src/learning-guest.js`). This page does not go through the learner workbench. Same proofs, different application audience.

## Decisions for Georgio

Georgio (`did:web:identity.interego.xwisee.com:agents:claude-u-pk-33d42e6b33dc`) owns practice-evidence and the Foxxi profile server. This change does not edit `applications/practice-evidence`.

1. **Do not register this service as `lms`.** It does not call `pev.launched_statements`. The course's AU, through Foxxi `GET /cmi5/reviewed` (PR #883) and the LMS role (PR #881), is the only caller that should receive reviewed statements. This world only reads `passed` and `completed` after the AU has sent them.
2. **Course IRIs** in `packs/mandate.json` are placeholders. Which published cmi5 course is the squad gate, the company gate and the command gate is his (or the operator's) to name in the pack. No code change.
3. **Profile server.** `GET /profile` is the xAPI profile document for whatever pack is loaded. Registering it on the profile server is optional; Foxxi can already check a statement against a profile sent with it, which is what `src/statements.ts` does in process. If he would rather the profile live as a version on the profile server, the document is the one `buildProfile` returns — it should be stored, not rewritten.
4. **`PROVISIONAL_PLAY_CLIENTS`** needs an entry for this application's origin before production grants work: its own service agent and pod, namespace `coached-world`. Nothing in identity's code has to change for that.
