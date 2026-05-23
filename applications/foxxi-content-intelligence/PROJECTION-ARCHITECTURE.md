# Projection Architecture

Foxxi's conformance surfaces (xAPI 2.0, SCORM 2004, cmi5, LTI 1.3
Advantage, OneRoster, and the bridge's own performance / agent state)
are implemented as **projections over the Interego substrate** rather
than as parallel native stores. From the outside they look like the
standard they implement; from the inside every state change is a real
`cg:ContextDescriptor` on the tenant pod.

## The pattern

```
                  ┌─────────────────────────────────────────┐
                  │           OUTSIDE: the standard         │
                  │   (xAPI / SCORM / cmi5 / LTI / ...)     │
                  └─────────────────────────────────────────┘
                                    │
                              handler reads /
                              writes a typed
                              cache (the hot
                              in-memory store)
                                    │
                                    ▼
                  ┌─────────────────────────────────────────┐
                  │     PROJECTION layer (this repo)        │
                  │  PodStatementStore  (per-record)        │
                  │  PodKeyValueStore   (per-record, KV)    │
                  │  pod-snapshot-publisher (per-surface)   │
                  └─────────────────────────────────────────┘
                                    │
                              publish() to pod
                              (cg:ContextDescriptor
                              + TriG named graph
                              + pgsl:Atom)
                                    ▼
                  ┌─────────────────────────────────────────┐
                  │       INSIDE: Interego substrate        │
                  │     Solid pod / cg:ContextDescriptor    │
                  │  Seven facets · supersedes chains ·     │
                  │  HATEOAS affordances · PGSL atoms       │
                  └─────────────────────────────────────────┘
```

Two granularities of projection are in use:

- **Per-record** (the canonical pattern). Every individual record gets
  its own descriptor with a stable IRI. Used for xAPI Statements
  (`PodStatementStore`) and every Performance Architecture work product
  (`outcome-descriptor-publisher.ts`). Voiding / supersedes is
  expressed as chained descriptors.

- **Per-surface snapshot** (debounced). The whole surface's in-memory
  state is captured as one `foxxi:<Surface>TenantSnapshot` descriptor,
  versioned, supersedes-chained. Used for surfaces where many fields
  are mutated together by long-running handlers (SCORM sequencing,
  cmi5 launches, LTI line items, OneRoster overlay, Foxxi
  TenantPartition stores). Cheaper to wire than per-record without
  losing the substrate-as-source-of-truth property.

The choice is a granularity trade-off, not an architectural compromise:
per-record gives finer dereferencing + supersedes-chain semantics;
per-surface gives a single descriptor that captures the whole subsystem
in one inspectable artifact. Both publish through the same
`@interego/core publish()`, both land in the same pod, both follow the
same seven-facet shape.

## Today's coverage

| Surface                           | Projection         | Type IRI                              | Granularity   |
|-----------------------------------|--------------------|---------------------------------------|---------------|
| xAPI Statements                   | `PodStatementStore`| `foxxi:LearningStatement` + `tincan:Statement` | per-record    |
| xAPI Activity State / Profiles    | `pod-snapshot`     | `foxxi:XapiTenantSnapshot`            | per-surface   |
| Performance situations            | per-record         | `foxxi:Situation`                     | per-record    |
| Performance outcomes              | per-record         | `foxxi:Outcome`                       | per-record    |
| Performance plans                 | per-record         | `foxxi:PerformancePlan`               | per-record    |
| Calibration profile flip          | per-record         | `foxxi:CalibrationProfile`            | per-record (supersedes-chained) |
| Teaching package + attestation    | per-record         | `ac:TeachingPackage` + `amta:Attestation` | per-record |
| Agent participation claim         | per-record         | `foxxi:ParticipationClaim`            | per-record    |
| SCORM 2004 SeqSession             | `pod-snapshot`     | `foxxi:ScormTenantSnapshot`           | per-surface   |
| cmi5 launches + AU satisfaction   | `pod-snapshot`     | `foxxi:Cmi5TenantSnapshot`            | per-surface   |
| LTI 1.3 line items                | `pod-snapshot`     | `foxxi:LtiTenantSnapshot`             | per-surface   |
| OneRoster imported overlay        | `pod-snapshot`     | `foxxi:OneRosterSnapshot`             | per-surface   |
| Agent trajectories                | `pod-snapshot`     | `foxxi:AgentTrajectorySnapshot`       | per-surface (periodic) |
| Performance probes                | `pod-snapshot`     | `foxxi:PerformanceProbeSnapshot`      | per-surface (periodic) |
| Evaluation registry               | `pod-snapshot`     | `foxxi:EvaluationSnapshot`            | per-surface (periodic) |

## Cross-restart durability

Every projected surface hydrates from the pod on bridge startup. If the
container restarts mid-run:
- xAPI Statements come back via `PodStatementStore.rehydrateIfStale()`.
- LMS surfaces come back via `loadLatestSnapshot()` calls in each
  module's startup path.
- Agent trajectories / probes / evaluations come back via the bridge's
  `hydrateBridgeStateFromPod()`.

The pod is the source of truth across container lifetimes; the
in-memory stores are derived hot caches.

## What's next (deferred work, intentionally scoped out of this cut)

### 1. Real cross-pod federation

The federation read path currently composes the tenant profile with a
seeded peer corpus (`SAMPLE_PEER_OUTCOMES`). The architecture supports
real federation — `cg:FederationFacet` is populated, `composeCalibrationProfiles`
is symmetric, descriptors are dereferenceable across pods — but no
second deployed bridge instance + second pod is provisioned today.

To turn it on:
1. Deploy a second bridge instance (e.g. `interego-foxxi-bridge-peer`)
   with its own `FOXXI_TENANT_POD_URL` pointing at a separate pod.
2. Replace the `SAMPLE_PEER_OUTCOMES` seed with `discover()` calls
   against the peer pod, filtered by `conformsTo foxxi:Outcome`.
3. Each pod publishes its own outcomes; each bridge composes both;
   the calibration profile becomes a real two-org composition.

Scope: a second container app + DNS + ~50 lines of refactor in
`performance-routes.ts` to swap the seed for a real fetch.

### 2. Dashboard as linked-data browser

The dashboard-app currently consumes the bridge's JSON-LD responses
but renders them as conventional UI components rather than as a
descriptor browser. The bridge's `_affordances` block is already
HATEOAS-correct; the dashboard could follow `hydra:target` links and
render the actual Turtle / descriptor graph natively.

To turn it on:
1. Wire `useLinkedDataAffordance(uri)` hook that GETs `text/turtle`,
   parses with `@interego/core`'s parser, hands the descriptor tree to
   the renderer.
2. Add a "Pod browser" route that lists `foxxi:Outcome`, `foxxi:LearningStatement`,
   `foxxi:ScormTenantSnapshot`, etc., across the federation, with
   click-through to dereferenceable Turtle.
3. Render `cg:Affordance` blocks as actionable buttons (POST a
   superseding outcome, GET the graph payload, etc.).

Scope: significant UI work, multiple weeks. The substrate side is
already done — the dashboard just needs to consume what the bridge
already serves.

### 3. Full per-record refactor of per-surface snapshots

The snapshot pattern publishes the whole surface as one descriptor per
debounce window. For some uses (xAPI Activity State documents, LTI
line items) a per-record projection (one descriptor per state-doc,
one descriptor per line-item) would give finer dereferenceability and
cleaner federation semantics. Mechanical refactor — same
`PodKeyValueStore<T>` primitive that backs `PodStatementStore`.

## Why this is the right default

Three properties the projection pattern preserves that a parallel
store violates:

1. **Substrate as source of truth.** Container restart never loses
   data; federation discovers it natively; auditors can verify it
   without bridge access.

2. **Uniform semantic surface.** Every work product carries the seven
   facets, modal status, provenance chain, trust level, federation
   origin. Operators can write one query that works across all
   surfaces (`discover({ conformsTo: foxxi:Outcome })`) instead of
   N different surface-specific APIs.

3. **Compositional emergence.** The reflexive calibration loop, the
   downward-causation annotation, the modal flip — none of these
   are bridge logic. They are properties of the *graph of descriptors*
   in the pod. Same machinery applies to every projected surface for
   free; you don't reinvent emergent semantics per protocol.

"Parallel to Interego" stops being a quiet default; any new endpoint
defaults to a projection and any deviation has to be justified.
