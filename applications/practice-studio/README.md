# Practice studio

> **Vertical application — not protocol, not a reference implementation.**
> Namespace `studio:` (`ontology/studio.ttl`). It does not add terms to `iep:`.

A thin practice product on top of the role-play player and the phone-roleplay
xAPI profile v3. Scenarios, sessions, scores, coaching notes and a learner's
progress are records agents discover and invoke. The page at
`docs/applications/practice-studio/` is the library, the practice session, the
results view and the authoring box.

The practice page opens the hosted role-play player and its scenario as they
stand. That package — per-turn `took-turn` statements, `resultAfterReview`,
the scenario version `urn:pev:scenario:2820abbd51e6ac5c#version-1`, and
`GET /cmi5/reviewed` — is the player's. This studio does not edit those files
and does not publish a new package. A real attempt is what the player writes
when a course launches it, including consent, the clock, and the agent-test
mark. Practice Evidence imports that registration. This studio does not.

`studio.score_attempt` is a separate, unrecorded calculation: the caller
declares reply indexes, and the studio applies the same scripted arithmetic
the player uses. The record says `observed: false` and `source: declared-choices`.
It writes no xAPI statement. An omitted `actorKind` is `agent`, so a tool call
is not stored as a person's attempt. The learner value is the label the caller
sent, kept in this process, not a keyed pseudonym.

## Affordances

| Tool | Act |
|---|---|
| `studio.list_scenarios` | Library |
| `studio.create_scenario` | Author a scenario document |
| `studio.start_session` | Open a session and return the player URL |
| `studio.score_attempt` | Score declared reply indexes and write coaching notes |
| `studio.list_progress` | Declared scores for one learner label |

`GET /` and `GET /affordances` are the discovery documents.

The store is the process. Restarting drops it. Nothing is authenticated, so
the process listens on loopback. `STUDIO_INSECURE_BIND=1` is required before
it will listen anywhere else, and that flag means anyone who can reach it can
read and write every record.

## Run

```bash
npx tsx applications/practice-studio/bridge/server.ts
```

Then open `http://127.0.0.1:6120/ui/`. `PORT` changes the port. Leave `HOST`
unset. `BRIDGE_DEPLOYMENT_URL` is the origin written into affordance targets
when you are looking at the process through a proxy on the same machine.

## Deploy

Do not treat this pull request as a production deploy.

The static page lives under `docs/`, the same tree the role-play player is
already published from (GitHub Pages, `docs/.nojekyll`). Publishing that tree
hosts the library and a preview of the player. Scoring, progress and authoring
need the process above.

Do not put this process on a public host until it authenticates callers. No
image is added here, and nothing in this change is deployed. There is no
Cloudflare account and no new paid service.

The profile snapshot is a copy of the published v3 document at
`https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/v/3`
so tests do not depend on the network. Refresh it from that URL when the
document changes. The studio does not send statements that follow it.
