# Practice studio

> **Vertical application — not protocol, not a reference implementation.**
> Namespace `studio:` (`ontology/studio.ttl`). It does not add terms to `iep:`.

A library, an authoring box and a progress view on the hosted role-play player.
The page at `docs/applications/practice-studio/` is that front end.

`studio.start_session` opens a cmi5 launch with `buildCmi5Launch`, the function
the Foxxi bridge's `POST /agent/cmi5/launch` uses. The signer is the learner's
LMS account on that launch. The hosted player writes its own statements to the
endpoint the launch names: consent, the clock, the turns, the scores, and the
agent-test mark when `learnerPlace` is `agent`.

`studio.list_progress` reads that registration with Practice Evidence's
`readLaunchedCall`, the function `pev.import_launched_attempt` runs. The result
is that read. This process does not write a score, does not invent a statement,
and does not store an attempt on the Practice Evidence pod. Storing one remains
`pev.import_launched_attempt`, which needs the learner's own signed read of the
registration.

The hosted player and its scenario package are not modified here. A launch of
the seeded scenario carries `resultAfterReview`,
`urn:pev:scenario:2820abbd51e6ac5c#version-1` and the `took-turn` verb as that
package already publishes them.

## Affordances

| Tool | Act |
|---|---|
| `studio.list_scenarios` | Library. No signature. |
| `studio.create_scenario` | Author a scenario. Signed. Only that author can replace it. |
| `studio.start_session` | cmi5 launch of the hosted player for the signer. |
| `studio.list_progress` | Practice Evidence's read of one registration the signer launched. |

`GET /` and `GET /affordances` are the discovery documents.

A rubric whose levels are not listed from the lowest value to the highest is
refused. The player and this check share that order.

## Auth

Creating a scenario, opening a launch and reading progress take the same signed
request as other Interego acts: `_signed_payload` and `_signature` over
`sha256:<hex>`. The recovered signer is the learner. A signature does not read
another learner's launch or replace another author's scenario.

The store is the process. Restarting drops it. Nothing is authenticated beyond
that signature, so the process also listens on loopback. `STUDIO_INSECURE_BIND=1`
is required before it will listen anywhere else.

## Run

```bash
npx tsx applications/practice-studio/bridge/server.ts
```

Then open `http://127.0.0.1:6120/ui/`. `PORT` changes the port. Leave `HOST`
unset. The launch URL names this listen address, because that is where the
player posts its statements.

## Deploy

Do not treat this pull request as a production deploy.

The static page lives under `docs/`, the same tree the role-play player is
already published from (GitHub Pages, `docs/.nojekyll`). Publishing that tree
hosts the library. A launch, the statement store and the progress read need
the process above, and a signed caller.

No image is added here, and nothing in this change is deployed. There is no
Cloudflare account and no new paid service.

The profile snapshot is a copy of the published v3 document at
`https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/v/3`
so a scenario that arrives without an xapi block can be given the terms the
player reads. Refresh it from that URL when the document changes.
