# Pattern: Resource-Scoped Affordances

**Layer:** L2 — Architecture (informative pattern).
**Reference runtime:** `applications/_shared/affordance-mcp/` (`AffordanceScope`, `affordancesFor`).
**Status:** Informative. Verticals MAY adopt; nothing in L1 depends on it.

## Problem

A bridge that exposes a vertical's capabilities as `iep:Affordance`
descriptors has a catalogue of *every* operation it supports. The naive
HATEOAS serialization attaches that whole catalogue to every resource —
the entry point, every collection, every item. A client reading a
single course item is then told it can `assign_audience`,
`coverage_query`, `connect_lms`, and a dozen other operations that have
nothing to do with the course in front of it.

Richardson Maturity Model Level 3 and Amundsen's *RESTful Web APIs*
(Ch. 5) both say the opposite: **a resource should advertise only the
affordances that are valid for its own current state.** An order in
`pending` offers `cancel`; once it ships it offers `return` instead.
The state transition *is* the change in advertised affordances. A
client should be able to drive the application purely by following what
each resource offers, without out-of-band knowledge of which operation
applies where.

## Pattern

Each affordance optionally declares an **`AffordanceScope`** — the set
of resource contexts in which it is applicable. When a bridge
serializes a resource, it filters its affordance catalogue through
`affordancesFor(resourceContext, affordances)` and attaches only the
matching subset to that resource's `_affordances`.

```ts
interface AffordanceScope {
  collections?: readonly string[];  // collection names, or '*'
  modalStatus?: readonly string[];  // applicable iep:modalStatus values
}
```

- An affordance with **no** `appliesTo` scope is *unscoped* — it is
  advertised on every resource (the backward-compatible default).
- A scoped affordance is advertised on a resource only when **every**
  declared dimension matches the resource's `ResourceContext`
  (`collection` + optional `modalStatus`).

### Entry-point exemption

The entry point is the one resource that SHOULD carry the full
catalogue. Clients fetch the entry point once, cache it, and resolve
affordances by name from there (the substrate's affordance-walk relies
on this). Bridges therefore skip the filter for the entry point — or,
equivalently, scope catalogue-wide affordances to include the `'entry'`
sentinel collection.

## Layering

This is an L2 *pattern*, not an L1 protocol change. It introduces **no
new `iep:` term**: `AffordanceScope` is a property of the affordance-
declaration record (the `applications/_shared/affordance-mcp` TS shape),
and the filter is a pure function over existing data. `iep:modalStatus`
— the one substrate term it reads — already exists in L1. A vertical
that ignores the pattern is unaffected; its affordances stay unscoped.

The reference filter `affordancesFor` lives beside the affordance-MCP
derivation it complements. It is deterministic, dependency-free, and
safe to run on every resource serialization.

## Worked example — Foxxi Content Intelligence

`applications/foxxi-content-intelligence/affordances.ts` annotates its
capability catalogue:

| Affordance | `appliesTo.collections` |
|---|---|
| `discover_assigned_courses` | `profiles` |
| `consume_lesson` | `courses`, `profiles` |
| `ask_course_question[_agentic]`, `retrieve_course_context` | `courses` |
| `coverage_query`, `publish_concept_map` | `courses` |
| `publish_authoring_policy` | `policies`, `courses` |
| `assign_audience` | `groups`, `policies` |
| `connect_lms` | `integrations` |

Everything else stays unscoped. A learner reading their own
`/profiles/{uuid}` no longer sees `connect_lms`; an admin reading
`/integrations/{uuid}` no longer sees `ask_course_question`. The
entry-point `/api/foxxi/v1` still lists the whole catalogue.

## When NOT to use it

- Tiny verticals with a handful of affordances where every operation is
  genuinely global — the filter is harmless but adds annotation noise.
- Affordances whose applicability genuinely depends on per-request
  authorization rather than resource state — that is an ABAC concern
  (see `abac.ttl`), evaluated at invocation, not an advertising
  concern. Scope advertises *what exists for this resource*; ABAC
  decides *whether this caller may invoke it*. Use both.
