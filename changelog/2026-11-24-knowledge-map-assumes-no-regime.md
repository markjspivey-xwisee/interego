## 2026-11-24 — Foxxi: the knowledge map assumes no regime, and says what it takes

`POST /knowledge/map` splits a competency into what to write down and what to
enable as a flow, and the work regime decides which. The route read a regime
that was missing, or not one of the four names exactly, as Knowable, and
answered with things to codify.

That is the default `POST /performance/plan` stopped making in June: a
situation nobody had classified was planned as a gap to close. Here it reached
a caller the same way. An unclassified diagnosis carries no `domain`, so a
client passing `diagnosis.domain` on to this route sent no regime and was told
to write content. `"emergent"` in lower case got the same answer.

Found on 2026-11-24 while reviewing a client of the deployed bridge. Against
`foxxi-bridge.interego.xwisee.com`, a body with no regime and a body with
`"regime": "emergent"` both came back Knowable, codify-and-connect, with one
component to codify.

- **A regime that was not given is refused.** A missing regime, or one that is
  not `Evident`, `Knowable`, `Emergent` or `Turbulent` exactly, is answered 400
  with the four names, what was sent, and where a regime comes from. No map is
  made.
- **`GET /knowledge` publishes the input.** `_affordances.mapKnowledge` now
  carries `expects` (competency, regime, components, performer), `refuses` and
  `returns`, as `GET /performance` does for the plan route. Until now the index
  gave a method, a link and a sentence, and a client had to read this file to
  learn that `components[]` is required.

**A caller that sent no regime is now refused where it used to get a Knowable
map.** The one caller in this repository, the dashboard's performance demo
panel, sends a regime for every scenario.

Not changed: a component whose name is not one of the five is still dropped
without a word, and the request is refused only when none is left.

Tests: `applications/agentic-performance-practice/tests/knowledge-map-assumes-no-regime.test.ts`.
