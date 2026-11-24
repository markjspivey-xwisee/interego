# Practice studio

> **Vertical application — not protocol, not a reference implementation.**
> Namespace `studio:` (`ontology/studio.ttl`). It does not add terms to `iep:`.

A thin practice product on top of the role-play player and the phone-roleplay
xAPI profile v3. Scenarios, sessions, scores, coaching notes and a learner's
progress are records agents discover and invoke. The page at
`docs/applications/practice-studio/` is the library, the practice session, the
results view and the authoring box.

The practice session **is** the existing player
(`docs/applications/practice-evidence/roleplay-player/`). The seeded scenario
is `double-charged-subscription.json`. When a framed player finishes, the page
sends the replies taken to `studio.score_attempt`. That act replays the script
the way the player does, writes a score and coaching notes, and emits xAPI
statements. Those statements are checked, in process, against the v3 profile
snapshot in `profile/phone-roleplay-xapi.ttl` (the document at
`https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/v/3`)
using Foxxi's supplied-profile checker.

A pass-gate, including the seeded scenario, closes with `terminated` and does
not send `completed`, `passed` or `failed`. The score stays provisional.
`pev.import_launched_attempt` on the practice-evidence bridge is how a reviewed
record is taken from an LRS; this studio does not replace that bridge.

## Affordances

| Tool | Act |
|---|---|
| `studio.list_scenarios` | Library |
| `studio.create_scenario` | Author a scenario document |
| `studio.start_session` | Open a session and return the player URL |
| `studio.score_attempt` | Score, coach, and validate v3 statements |
| `studio.list_progress` | One learner's attempts, pass rate, criterion averages |

`GET /` and `GET /affordances` are the discovery documents. The learner's name
is not written into a statement; the actor account is a keyed pseudonym.

The store is the process. Restarting drops it. That is deliberate: this
surface does not write a pod and does not hold a model key.

## Run

```bash
npx tsx applications/practice-studio/bridge/server.ts
```

Then open `http://127.0.0.1:6120/ui/`. `PORT` and `HOST` override the bind.
`BRIDGE_DEPLOYMENT_URL` is the origin written into affordance targets when a
proxy sits in front.

## Deploy

Do not treat this pull request as a production deploy.

The static page lives under `docs/`, the same tree the role-play player is
already published from (GitHub Pages, `docs/.nojekyll`). Publishing that tree
hosts the library and a preview of the player. Scoring, progress and authoring
need the process above.

The existing Railway project already runs `pev-bridge` and `foxxi-bridge`.
Putting the studio beside them later means a new service on that project, not
a new vendor: `PORT`, `HOST=::` behind the proxy, and `BRIDGE_DEPLOYMENT_URL`
set to the service's https origin. No image is added here, and nothing in this
change is deployed. There is no Cloudflare account and no new paid service.

The profile snapshot is a copy of the published v3 document so tests do not
depend on the network. Refresh it from the URL above when that document changes.
