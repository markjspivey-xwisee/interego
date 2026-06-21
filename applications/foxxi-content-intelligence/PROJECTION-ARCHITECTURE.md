# Projection Architecture

Foxxi's conformance surfaces (xAPI 2.0, SCORM 2004, cmi5, LTI 1.3
Advantage, OneRoster, and the bridge's own performance / agent state)
are implemented as **projections over the Interego substrate** rather
than as parallel native stores. From the outside they look like the
standard they implement; from the inside every state change is a real
`iep:ContextDescriptor` on the tenant pod.

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
                              in-memory store);
                              state mutation
                              marks the surface
                              dirty
                                    │
                                    ▼
                  ┌─────────────────────────────────────────┐
                  │     PROJECTION layer (this repo)        │
                  │  PodStatementStore  (per-record)        │
                  │  PodKeyValueStore   (per-record, KV)    │
                  │  pod-snapshot-publisher (per-surface)   │
                  │  withPublishLock()  (one publish        │
                  │                      in-flight per      │
                  │                      bridge process)    │
                  └─────────────────────────────────────────┘
                                    │
                              tryPublishBounded()
                              (~4s budget on the
                              synchronous path;
                              overflow continues
                              in background)
                                    │
                                    ▼
                  ┌─────────────────────────────────────────┐
                  │            css-gate (sidecar)           │
                  │  GET/HEAD/OPTIONS → anonymous           │
                  │  POST/PUT/PATCH/DELETE → Bearer-gated   │
                  │  (buffers body, then forwards to CSS)   │
                  └─────────────────────────────────────────┘
                                    │
                              authenticated
                              write
                                    ▼
                  ┌─────────────────────────────────────────┐
                  │       INSIDE: Interego substrate        │
                  │     Solid pod / iep:ContextDescriptor    │
                  │  Seven facets · supersedes chains ·     │
                  │  HATEOAS affordances · PGSL atoms       │
                  └─────────────────────────────────────────┘
                                    ▲
                                    │
                              readers (federation,
                              dashboard, peer
                              bridges) hit CSS
                              directly OR via the
                              gate — reads are
                              anonymous either way
```

Storage stays zero-trust: the CSS instance accepts anonymous reads and
writes if hit directly. The gate is an operational write boundary in
front of CSS, not an ACL on the pod itself. Trust lives at the
verifier + reader layer (signature checks on descriptors), so an L2 /
L3 vertical that wants stricter write rules layers its own gate without
changing the substrate.

Two granularities of projection are in use:

- **Per-record** (the canonical pattern). Every individual record gets
  its own descriptor with a stable IRI. Used for xAPI Statements
  (`PodStatementStore`) and every Performance Architecture work product
  (`outcome-descriptor-publisher.ts`). Voiding / supersedes is
  expressed as chained descriptors.

- **Per-surface snapshot** (dirty-triggered). The whole surface's
  in-memory state is captured as one `foxxi:<Surface>TenantSnapshot`
  descriptor, versioned, supersedes-chained. A snapshot is published
  only when the surface module itself calls `dirty()` after a real
  state mutation — there is no heartbeat or periodic timer. (The
  earlier 30-second auto-dirty interval was removed because it
  generated a manifest-write storm against an idle bridge.) Used for
  surfaces where many fields are mutated together by long-running
  handlers (SCORM sequencing, cmi5 launches, LTI line items, OneRoster
  overlay, Foxxi TenantPartition stores). Cheaper to wire than
  per-record without losing the substrate-as-source-of-truth property.

All publishes — per-record or per-surface — funnel through
`withPublishLock()` in `src/bridge-signer.ts`. That mutex keeps at most
one publish in-flight per bridge process, so concurrent dirty markers
and incoming outcome posts serialize against the manifest instead of
racing each other.

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
| Agent trajectories                | `pod-snapshot`     | `foxxi:AgentTrajectorySnapshot`       | per-surface (dirty-triggered) |
| Performance probes                | `pod-snapshot`     | `foxxi:PerformanceProbeSnapshot`      | per-surface (dirty-triggered) |
| Evaluation registry               | `pod-snapshot`     | `foxxi:EvaluationSnapshot`            | per-surface (dirty-triggered) |

## Cross-restart durability

Every projected surface hydrates from the pod on bridge startup. If the
container restarts mid-run:
- xAPI Statements come back via `PodStatementStore.rehydrateIfStale()`.
- LMS surfaces come back via `loadLatestSnapshot()` calls in each
  module's startup path.
- Agent trajectories / probes / evaluations come back via the bridge's
  `hydrateBridgeStateFromPod()`.

The pod is the eventual source of truth across container lifetimes; the
in-memory stores are derived hot caches.

## The publish path is bounded, not blocking

A `POST /performance/outcome` (and `POST /agent/teach`) does two
things in order:

1. **Synchronously, before the response.** Verify the request
   signature (`signedPayload` + ECDSA recovered address must match
   `author.id`'s 0x-suffix; missing fields → 401 `signature required`,
   mismatched recovery → 401 `signature does not verify`). On success
   the outcome is inserted into `liveOutcomes` immediately, so a
   subsequent read on this bridge sees it without waiting on the pod.

2. **On a bounded budget.** The descriptor PUT to the pod is wrapped
   in `tryPublishBounded()` with a ~4s ceiling on the synchronous
   path. If the pod write completes inside the budget, the response
   includes the published descriptor URIs. If it doesn't, the
   response returns with `published: []` and the same publish keeps
   running in the background — the hot cache already has the outcome,
   the pod catches up eventually, and the next read or hydrate sees
   it. This is why slow pod writes no longer stall the API the way
   they did before commit 32cc030.

Concurrent publishes inside one bridge process serialize through
`withPublishLock()`, so an in-flight background publish doesn't race
a newly arriving synchronous one against the same manifest. The
publish path is bounded per-request and serialized per-process; the
pod is the eventual source of truth, and the in-memory mirror is the
hot cache that fronts it.

## What's next (deferred work, intentionally scoped out of this cut)

### 1. Real cross-pod federation

The federation read path currently composes the tenant profile with a
seeded peer corpus (`SAMPLE_PEER_OUTCOMES`). The architecture supports
real federation — `iep:FederationFacet` is populated, `composeCalibrationProfiles`
is symmetric, descriptors are dereferenceable across pods — but no
second deployed bridge instance + second pod is provisioned today.

The reader-side filter that gates admission to the federated
calibration profile already runs in production:
`federation-outcome-loader` verifies each peer descriptor's
`foxxi:agentSignature` against the DID named in `prov:wasGeneratedBy`,
and drops anything that doesn't recover to that DID. Unsigned peer
outcomes still land on disk (storage is zero-trust and will accept
them), but the loader silently excludes them from composition. Trust
lives at the reader, not at the store.

To turn it on:
1. Deploy a second bridge instance (e.g. `interego-foxxi-bridge-peer`)
   with its own `FOXXI_TENANT_POD_URL` pointing at a separate pod.
2. Give the peer bridge a stable service identity by setting
   `FOXXI_BRIDGE_PRIVATE_KEY` (0x-prefixed 32-byte hex) so its
   descriptors carry a recoverable `did:key:0x<addr>#bridge` —
   without this, the loader will reject them as unsigned/unverifiable
   and the calibration profile will compose with an empty peer set.
3. Replace the `SAMPLE_PEER_OUTCOMES` seed with `discover()` calls
   against the peer pod, filtered by `conformsTo foxxi:Outcome` and
   passed through the same signature-verifying loader the local
   tenant uses.
4. Each pod publishes its own signed outcomes; each bridge composes
   both; the calibration profile becomes a real two-org composition
   that only counts descriptors whose `foxxi:agentSignature` recovers
   to the claimed author DID.

Scope: a second container app + DNS + ~50 lines of refactor in
`performance-routes.ts` to swap the seed for a real fetch through the
existing signature-verifying loader.

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
3. Render `iep:Affordance` blocks as actionable buttons (POST a
   superseding outcome, GET the graph payload, etc.).

Scope: significant UI work, multiple weeks. The substrate side is
already done — the dashboard just needs to consume what the bridge
already serves.

### 3. Full per-record refactor of per-surface snapshots

The snapshot pattern publishes the whole surface as one descriptor each
time the surface is marked dirty. For some uses (xAPI Activity State
documents, LTI line items) a per-record projection (one descriptor per
state-doc, one descriptor per line-item) would give finer
dereferenceability and cleaner federation semantics. Mechanical
refactor — same `PodKeyValueStore<T>` primitive that backs
`PodStatementStore`.

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
