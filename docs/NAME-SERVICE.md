# Interego Name Service — design + reference runtime

> **Status:** design note **+ shipped reference runtime**
> ([`src/naming/`](../src/naming/index.ts), tests in
> [`tests/naming.test.ts`](../tests/naming.test.ts)). Non-normative.
>
> **Layer:** L2 architecture pattern. A construction *over* L1
> primitives (typed descriptors, the seven facets, `cg:supersedes`,
> federated discovery) — sibling of [`registry:`](ns/registry.ttl) and
> [`passport:`](ns/passport.ttl). It adds **no new L1/L2 ontology
> terms**: a name is a `foaf:nick` literal on a DID, inside an ordinary
> Context Descriptor.

## At a glance — the shipped API

```ts
import { attestName, resolveName, namesFor, defaultNameTrustPolicy } from '@interego/core';

// Attest a name (publishes a signed, provenance-stamped descriptor):
await attestName({ subject: aliceDid, name: 'alice' }, config);

// Forward: name → principals, trust-ranked (NOT a single answer):
const hits = await resolveName('alice', config, { pods: [myPod, ...subscribedPods] });

// Reverse: principal → its attested names:
const names = await namesFor(aliceDid, config);
```

`buildNameAttestation` is the pure (pod-free) builder; `attestName`
publishes it. `resolveName` / `namesFor` walk the given pods, parse
name-attestation graphs, and rank with a **pluggable trust policy**
(`defaultNameTrustPolicy` drops retracted/superseded bindings and ranks
`CryptographicallyVerified` > `ThirdPartyAttested` > `SelfAsserted`,
recency as tiebreaker). All resolvers take an injectable `fetch`, like
the rest of the substrate's federated calls.

## The question

Can Interego have a name service — a way to resolve a human-friendly
name (`alice`) to a principal (a DID, a pod, an agent set) and back?

Yes. Most of the machinery already exists; what a "name service" adds is
a thin, first-principles-aligned layer on top.

## What already exists

Interego already ships a tiered identity resolver,
`resolveIdentifier()` ([`src/solid/discovery.ts`](../src/solid/discovery.ts)),
which takes a `did:`, an `acct:user@host`, or a WebID URL and walks:

| Tier | Mechanism |
|---|---|
| T1 | DID-Web resolution (`did:web:host:users:name` → DID document → storage endpoint) |
| T2 | WebFinger (RFC 7033 — `acct:user@host` → WebID / pod) |
| T3 | `.well-known/interego-agents` catalog |
| T4 | Federation-directory descriptor (the pod directory) |
| T5 | Social-graph walk (BFS from a seed) |
| T6 | On-chain registry (ERC-8004) |

Plus `resolveWebFinger`, `resolveDidWeb`, `resolveHandleToPodUrl`, and
the federated **pod directory** (`publishPodDirectory` /
`fetchPodDirectory`). The identity server already serves
`/.well-known/webfinger`, `/.well-known/did.json`, and WebID profiles.

**So forward resolution from a *qualified* identifier
(`did:` / `acct:` / URL) → pod / WebID / agents is already built.**
`did:web` already gives you DNS-rooted, globally-unique names for free.

## The constraint

Interego's first principles are explicit (see `CLAUDE.md`):

> DIDs are canonical identifiers; **userId is derived, not claimed.** The
> server never accepts a user-supplied userId.

A conventional name service — a registrar where you *claim* `alice`,
first-come-first-served, backed by a root and namespace governance —
**directly violates this** and re-centralizes what Interego
deliberately decentralizes. (See [ENS, below](#relationship-to-ens) for
why a registrar *necessarily* has a coordination point.)

So an Interego name service must not be a registrar.

## The model: a name is a verifiable attestation

A name binding is an ordinary `cg:ContextDescriptor`:

```turtle
<urn:cg:name-attestation:…>
    a cg:ContextDescriptor ;
    cg:describes <urn:graph:…> .
# the graph it describes:
<did:web:pod.example:users:abc> foaf:nick "alice" .
```

…carrying the standard facets:

- **Trust facet** — who attests this binding, at what trust level
  (`SelfAsserted`, or `CryptographicallyVerified` when a third party
  co-signs). A self-attestation (`alice` says she's `alice`) and a
  peer-attestation (`bob` confirms `alice` is `alice`) are the same
  shape at different trust levels.
- **Provenance facet** — `wasAttributedTo` / `wasGeneratedBy`,
  audit-walkable.
- **Temporal facet** — `validFrom` / `validUntil`.
- **`cg:supersedes`** — renaming or reassigning is a supersession chain,
  never a destructive overwrite. The history stays.

No new vocabulary: `foaf:nick` is W3C FOAF (already in
[`src/rdf/namespaces.ts`](../src/rdf/namespaces.ts)); the DID document's
own `alsoKnownAs` (W3C DID Core) carries URI-shaped aliases. The
descriptor + facet model is L1.

**Resolution is discovery + trust evaluation, not a registry lookup.**
Conflicts — two DIDs both attesting `"alice"` — are resolved by the
*resolver's own trust policy*: attestation count, attester trust level,
recency, social distance, ABAC predicates. There is no first-come
winner, because there is no central ledger to be first on.

## The gap — what a reference implementation adds

Small, all composing existing primitives:

1. **Forward: bare name → principal.** A new entry path
   `resolveName("alice", trustPolicy)` that discovers name-attestation
   descriptors across the federation (own pod + subscribed pods + the
   pod directory), trust-ranks them, and returns a **ranked candidate
   set** — *not* a single guaranteed answer. The caller (or its agent)
   picks, or applies a stricter policy. This is a new tier alongside
   T1–T6, not a replacement.
2. **Reverse: principal → names.** `namesFor(did)` — discover
   attestations whose graph describes that DID. Useful for display
   ("you're talking to *alice* / did:web:…").
3. **Conflict resolution as policy, not mechanism.** Ship a default
   trust policy (prefer self-attestation co-signed by N peers; prefer
   higher trust level; prefer most recent non-superseded), but make it
   pluggable — a pod, an org, or an agent can supply its own. Reuse the
   existing ABAC + `amta:` multi-axis attestation machinery; the
   substrate already evaluates trust this way for everything else.
4. **Optional: a federation name index.** Extend the pod directory to
   carry a `name → did` index per pod, so `resolveName` doesn't have to
   walk every pod. The index is a *cache/hint*, not an authority — it's
   re-derivable from the attestation descriptors themselves.
5. **Optional: a host-free convenience form.** A surface convention
   (`@alice`, or `alice~interego`) that the federation index resolves.
   This is explicitly a **convenience view, not a guarantee** — it
   resolves to a trust-ranked set, exactly like `resolveName`.

A reference runtime would live in `src/naming/` (or extend
`src/solid/discovery.ts`), with the resolver and the default trust
policy. Non-normative L2, like `src/registry/` and `src/passport/`.

## Relationship to ENS

ENS makes the **opposite, deliberate trade**: a single global
namespace where `alice.eth` means one thing to everyone. Global
uniqueness *requires* a coordination point — a root node, a canonical
registry contract, governance (the ENS DAO) over pricing and policy.
ENS decentralizes that coordination point as hard as is compatible with
global uniqueness (runs it on a permissionless chain, self-custodial
ownership, DAO-governed root) — but it cannot eliminate it, because
global agreement on a namespace is itself a coordination problem.

Interego's attestation model refuses the coordination point and so
gives up global uniqueness: a name is trust-relative, each resolver
decides. That is the correct trade *for Interego* — federation,
verifiability, no central authority are the project's non-negotiables —
but it is a trade, not a free lunch. See the tradeoff table below.

**They compose rather than compete.** ENS can store a DID record, so an
Interego name service can treat ENS as **one optional resolution tier**
— `alice.eth → DID record → pod` — pulling in ENS's global uniqueness
*where a user wants it*, without ENS becoming the root of Interego's own
naming. Same for `did:web` (DNS-rooted) — it's already a tier. The
attestation layer is the *default*; globally-unique namespaces are
*opt-in tiers under it*.

## What this is — and is not

| | Interego name service (attestation) | ENS-style registrar |
|---|---|---|
| Coordination point | none | root + registry + governance |
| Name semantics | attested, trust-relative | claimed, globally unique |
| Conflict resolution | resolver's trust policy | first-come-first-served + rent |
| Uniqueness guarantee | **none** (a name *can* be contested) | global |
| New authority introduced | none | the registrar / DAO |
| Squatting-resistant | n/a (no scarce namespace to squat) | via pricing/rent |
| Fits Interego first principles | yes | no (re-centralizes) |

The honest cost: **no globally-unique guarantee.** `alice` is not
guaranteed to mean one entity everywhere — it means whoever your trust
graph says it means. For Interego that is a feature, not a bug: it's the
same stance the substrate takes on identity, memory, and federation
everywhere else. Where a caller genuinely needs global uniqueness, they
opt into a `did:web` or ENS tier.

## First-principles checklist

- ✅ No central registrar, no root, no namespace governance.
- ✅ Names are *attested*, not *claimed* — consistent with "userId is
  derived, not claimed."
- ✅ Federated — resolution walks pods + directory; no membership service.
- ✅ Verifiable — every binding is a signed, provenance-stamped descriptor.
- ✅ Non-destructive — renames are `cg:supersedes` chains.
- ✅ Composes existing primitives — descriptors, facets, discovery, ABAC,
  `amta:`, the pod directory. **No new L1/L2 ontology terms.**
- ✅ Layer-clean — L2 pattern, sibling of `registry:` / `passport:`.

## Build status

**Shipped** ([`src/naming/index.ts`](../src/naming/index.ts) +
[`src/solid/discovery.ts`](../src/solid/discovery.ts); 18 tests, plus a
runnable demo at [`examples/demo-name-service.mjs`](../../examples/demo-name-service.mjs)):

- ✅ `buildNameAttestation` — pure builder (content-addressed on
  `(subject, name)`; idempotent re-attestation).
- ✅ `attestName` — builds + publishes a signed, provenance-stamped
  attestation descriptor.
- ✅ `resolveName` — forward, federated, trust-ranked candidate set.
- ✅ `namesFor` — reverse lookup.
- ✅ `defaultNameTrustPolicy` — pluggable; drops retracted/superseded,
  ranks by trust level + recency.
- ✅ Injectable `fetch` on every resolver.
- ✅ **`resolveIdentifier` TN tier** — `resolveIdentifier(id, { naming })`
  surfaces `resolveName` as a tier of the unified resolver. A bare name
  is syntactically indistinguishable from any other unknown string, so
  it can't be auto-detected — the `naming` option is opt-in, and the
  tier only runs for an otherwise-`unknown` id. It populates a new
  `kind: 'name'` + `nameCandidates` (the full ranked set, because a name
  is trust-relative) and mirrors the top candidate's `subject` into
  `webId` for single-answer callers. (`naming/index.ts` imports from
  source modules, not the `../index.js` barrel, to keep the
  `discovery → naming` edge cycle-free.)

**Not yet built (optional, deferred):**

1. Extend the pod directory with an optional `name → did` index, so
   federated resolution doesn't have to walk every pod. (The index is a
   cache/hint, re-derivable from the attestation descriptors — not an
   authority.)
2. A host-free convenience namespace (`@alice`) resolved via the
   federation index — explicitly a convenience view over a trust-ranked
   set, not a uniqueness guarantee.
3. A `docs/ns/naming.ttl` *only if* typed shapes are ever needed — the
   binding itself stays plain `foaf:nick`, so likely never.

## See also

- [`src/solid/discovery.ts`](../src/solid/discovery.ts) — the tiered
  resolver this extends
- [`docs/ns/registry.ttl`](ns/registry.ttl),
  [`docs/ns/passport.ttl`](ns/passport.ttl) — the L2-pattern precedent
- [`spec/LAYERS.md`](../spec/LAYERS.md) — layering discipline
