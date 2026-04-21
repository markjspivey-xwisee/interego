# Interego 1.0 --- System Architecture

**Draft Specification**

**Layer:** Layer 1 — Protocol. Normative. See [LAYERS.md](LAYERS.md) for the layering discipline.

**Latest version:** This document

**Editors:** Interego

**Abstract:** This document is the normative specification of the Interego 1.0 protocol — a compositional framework for typed graph contexts over RDF 1.2 Named Graphs. It defines the descriptor model, facet vocabulary, composition operators, serialization, and federation behavior that every conforming implementation must satisfy. Examples and architectural patterns are illustrative; the reference TypeScript implementation `@interego/core` is one such implementation and is not itself normative.

**Status:** Draft.

**Normative language:** The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in [RFC 2119] and [RFC 8174] when, and only when, they appear in all capitals.

**Conformance:** An implementation conforms to Interego 1.0 if and only if it passes the [conformance test suite](conformance/README.md) at the version that accompanies this document. Absence of the suite at the time of first publication means no full conformance claim is possible until it ships; implementations MAY claim *provisional conformance* subject to suite ratification.

**Out of scope — what this document is not:**

- Not a deployment manual. Specific container runtimes, object stores, and identity providers are Layer 3 implementation choices.
- Not a domain ontology. `code:`, `med:`, `learning:`, and every future domain vocabulary are separate artifacts riding on top of this protocol; they MUST NOT appear in `cg:` / `cgh:` / `pgsl:` / `ie:` / `align:`.
- Not a product spec. `@interego/core`, the relay, the dashboard, and the CLI are reference implementations; they do not bind the protocol to their choices.

---

## 1. Overview

Interego is composable, verifiable, federated context infrastructure.
It provides a massively multi-agent shared memory with typed context, trust,
algebraic composition, and structural intelligence.

Every Named Graph has context: who created it, when, under what interpretive
frame, at what confidence, with what trust credential, through what causal
model. Interego makes that context structured, composable,
machine-readable, and cryptographically verifiable.

The system is NOT a knowledge graph and NOT a RAG alternative. It is the
generalized infrastructure layer underneath both. PGSL (the Poly-Granular
Sequence Lattice) is the substrate that subsumes knowledge graphs: ingest
RDF and you get SPARQL and reasoners; ingest raw text, xAPI, LERS, or any
domain format via ingestion profiles, and you get the same structural
operations. The system's value is not in competing with LLMs at text
comprehension --- it is in providing the infrastructure that agents operate
on top of: typed metadata, trust chains, access control, algebraic
composition, structural deduplication, and provenance.

### 1.1 Peircean Frame

The system is grounded in Peircean triadic semiotics:

- The PGSL lattice provides the shared **representamen** (signs).
  Content-addressed atoms are canonical sign vehicles.
- Context Descriptors provide the **interpretant** (meaning per agent).
  The same fact can be Asserted by one agent and Hypothetical by another.
- Composition operators define how interpretants merge: union, intersection,
  restriction, override.
- The real-world referent is the **object** of the sign relation.

### 1.2 Syntagmatic/Paradigmatic Structure

- **Syntagmatic axis:** The chain (horizontal, sequential composition,
  overlapping pairs). A chain is a syntagm.
- **Paradigmatic axis:** The substitution set (vertical, what can fill a
  position). The paradigm set P(S, i) is the set of atoms appearing at
  position i across chains matching pattern S.
- **Constraints:** Link two syntagmatic positions across paradigmatic sets.
  Shapes constrain paradigmatic selection based on syntagmatic requirements.
- **Usage-based semantics:** Paradigm sets are NOT declared top-down by an
  ontologist. They emerge from the lattice through patterns of use.

---

## 2. Design Principles

1. **Zero runtime dependencies for core.** Validation is programmatic (no
   SHACL engine required). SHACL shapes are exported as Turtle strings for
   use with external engines. The only runtime dependencies are Node.js
   built-ins (`node:crypto`).

2. **Content-addressed everything.** SHA-256 hashes produce canonical URIs.
   Same input always produces the same URI regardless of agent, pod, or
   time. URI scheme: `urn:pgsl:atom:{sha256}`, `urn:pgsl:fragment:{sha256}`.

3. **Composition is algebraic.** Four operators form a bounded lattice with
   category-theoretic proofs (presheaf naturality, idempotence,
   commutativity, associativity, absorption). Each facet type defines its
   own merge semantics.

4. **Semiotic foundation.** Descriptors are Peircean signs. The Sign
   functor phi/psi forms an adjunction between the descriptor category and
   the semiotic category. The Semiotic Field Functor maps to SAT.

5. **Usage-based semantics.** Meaning is usage, not declaration. "You shall
   know a word by the company it keeps" (Firth). Paradigm sets emerge from
   co-occurrence. Yoneda: a node IS its relationships.

6. **URI-based identity with local display resolution.** Identity is
   structural (content hash). Display names are resolved locally. An
   unauthorized agent can compute paradigm set sizes and structural
   relationships without accessing values.

7. **Local-first, progressive persistence.** Everything works on localhost
   with zero internet. Cloud deployment is additive. Content starts in
   memory (tier 0) and promotes monotonically through 5 tiers.

8. **Discriminated union pattern.** All 9 facet types use
   `{ type: 'Temporal' | 'Provenance' |... }` for exhaustive switch
   matching. TypeScript compiler enforces completeness.

9. **W3C vocabulary reuse.** 23+ standard namespaces. No novel vocabulary
   when W3C provides one.

10. **Real cryptography.** No mocks. ethers.js v6 for ECDSA, tweetnacl for
    NaCl encryption, real IPFS CIDs, real SIWE verification.

---

## 3. Layer Architecture

The system is organized in 9 core layers plus 12 extension layers, each
building on the ones below.

### 3.1 Layer 1: PGSL (Poly-Granular Sequence Lattice)

The content substrate. A deterministic, content-addressed lattice of
overlapping sub-structures representing sequential data.

**Mathematical foundation:**

- **Presheaf:** P: L^op -> Set. The lattice is a presheaf over the level
  category L. Each level l maps to the set of fragments at that level.
- **Monad:** MintAtom (eta: unit), Ingest (mu: multiplication via
  iterative construction), Resolve (epsilon: counit, extracting readable
  content). Monad laws (associativity, identity) ensure PGSLs compose.
- **Pullback:** The overlapping pair construction at each level is a
  categorical pullback in the presheaf topos.

**Core operations:**

| Operation | Function | Description |
|-----------|----------|-------------|
| Create | `createPGSL(provenance)` | Initialize empty lattice with provenance |
| Mint | `mintAtom(pgsl, value)` | Unit: V -> PGSL. Content-addressed atom creation |
| Ingest | `ingest(pgsl, text, opts?)` | Multiplication: tokenize, mint atoms, build levels |
| Resolve | `resolve(pgsl, uri)` | Counit: URI -> readable string |
| Query | `queryNeighbors(pgsl, uri, dir)` | Navigate lattice by direction |
| Stats | `latticeStats(pgsl)` | Atom/fragment/level counts, containment annotations |
| Build | `ensureBuilt(pgsl, uri)` | Lazy construction: materialize deferred chains |
| Sign | `signNode(pgsl, uri, signer)` | ECDSA-sign a node |
| Verify | `verifyNodeSignature(pgsl, uri)` | Verify node signature |
| CIDs | `computeLatticeCids(pgsl)` | Compute IPFS CIDs for all nodes |
| Annotations | `computeContainmentAnnotations(pgsl)` | Containment role annotations |

**Lazy construction:** Chains may be deferred (not fully constructed until
accessed). Level capping limits lattice depth for performance.
`ensureBuilt()` materializes deferred chains on demand.

**Types:**

- `Value = string | number | boolean` --- ground set
- `TokenGranularity = 'character' | 'word' | 'sentence' | 'structured'`
- `Level: number` --- granularity (atom count in fragment)
- `Height: number` --- topological depth
- `Node = Atom | Fragment` --- discriminated union
- `PGSLInstance` --- the lattice state (nodes Map, provenance, options)
- `ContainmentAnnotation` --- parent/child with role

**Key modules:**

| Module | Lines | Purpose |
|--------|-------|---------|
| `pgsl/lattice.ts` | 753 | Monad operations, URI generation, lazy construction |
| `pgsl/category.ts` | 327 | Presheaf, pullback, geometric morphism, naturality |
| `pgsl/types.ts` | 308 | Set-theoretic foundation types |
| `pgsl/geometric.ts` | 269 | Geometric morphism between lattices |

### 3.2 Layer 2: Context Descriptors

Typed metadata that wraps named graphs with structured, composable context.

**9 facet types** (discriminated union on `type` field):

| Facet | Type Name | What it captures | W3C Alignment |
|-------|-----------|------------------|---------------|
| Temporal | `Temporal` | When valid (from/to) | OWL-Time, Dublin Core |
| Provenance | `Provenance` | Who generated, from what | PROV-O |
| Agent | `Agent` | Which AI agent, on behalf of whom | PROV-O, ActivityStreams |
| Access Control | `AccessControl` | Who can read/write | WAC |
| Semiotic | `Semiotic` | Asserted/Hypothetical/etc., confidence | Peircean semiotics |
| Trust | `Trust` | Self/attested/crypto-verified | VC 2.0, DID Core |
| Federation | `Federation` | Where stored, sync protocol | DCAT 3, Solid |
| Causal | `Causal` | Structural causal model | Pearl's SCM |
| Projection | `Projection` | Vocabulary mapping | SKOS, Hydra |

**Builder pattern:**

```
ContextDescriptor.create(id)
.describes(graphIRI)
.temporal({ validFrom, validTo })
.delegatedBy(owner, agent)
.asserted(confidence)
.selfAsserted(issuerDID)
.federation({ origin, storageEndpoint, syncProtocol })
.version(n)
.build()
```

**Validation:** Programmatic SHACL-equivalent. `validate(descriptor)` returns
`{ conforms: boolean, violations: ValidationViolation[] }`. Validates
required fields, type constraints, and cross-facet consistency.

**Open facet registry:** New facet types can be registered with custom merge
strategies via `model/registry.ts`.

**Key types:**

- `ContextDescriptorData` --- immutable data record (all fields `readonly`)
- `ContextTypeName` --- discriminated union of 9 type names
- `ModalStatus = 'Asserted' | 'Hypothetical' | 'Counterfactual' | 'Quoted' | 'Retracted'`
- `TrustLevel = 'SelfAsserted' | 'ThirdPartyAttested' | 'CryptographicallyVerified'`
- `IRI` --- branded string type for type safety

**Key modules:**

| Module | Lines | Purpose |
|--------|-------|---------|
| `model/types.ts` | 815 | All type definitions for the descriptor model |
| `model/descriptor.ts` | 441 | `ContextDescriptor` builder class |
| `model/delegation.ts` | 327 | Human-agent delegation with EIP-712 |
| `model/semiotic.ts` | 283 | Sign functor, adjunction, field functor |
| `model/category.ts` | 347 | Presheaf naturality, lattice law proofs |
| `model/registry.ts` | 180 | Open facet registry with merge strategies |
| `model/causality.ts` | 637 | Pearl's SCM: do-calculus, d-separation, counterfactual |
| `validation/validator.ts` | 422 | Programmatic SHACL-equivalent validation |
| `validation/shacl-shapes.ts` | 183 | SHACL Turtle export |

### 3.3 Layer 3: Composition Operators

Four set-theoretic operators over Context Descriptors forming a bounded
lattice.

| Operator | Function | Symbol | Semantics |
|----------|----------|--------|-----------|
| Union | `union(a, b)` | cup | All facets from both; per-facet merge |
| Intersection | `intersection(a, b)` | cap | Only shared facets; per-facet meet |
| Restriction | `restriction(d, types[])` | \| | Keep only specified facet types |
| Override | `override(base, patch)` | >> | Patch facets replace base facets |

**Algebraic properties:**

- Meet = intersection, Join = union (bounded lattice)
- Idempotent: `union(a, a) = a`
- Commutative: `union(a, b) = union(b, a)`
- Associative: `union(union(a, b), c) = union(a, union(b, c))`
- Absorption: `union(a, intersection(a, b)) = a`

**Per-facet merge semantics:** Each facet type defines how it merges under
union and intersection. Temporal facets take the wider/narrower interval.
Trust facets take the higher/lower level. Semiotic facets average
confidence. Provenance facets merge derivation chains.

**Triple-level inheritance:** `effectiveContext(descriptor, triple)` applies
the inheritance rule from spec section 3.5 --- graph-level context flows to
triples unless overridden.

**Key module:** `model/composition.ts` (260 lines). Exports: `union`,
`intersection`, `restriction`, `override`, `effectiveContext`,
`resetComposedIdCounter`.

### 3.4 Layer 4: Coherence Verification

Usage-based semantic agreement between agents. Sharing a sign (same atom
URI) is necessary but not sufficient for sharing meaning. The critical
distinction: data interoperability (shared signs) does not imply semantic
interoperability (shared meaning).

**Three states:**

| State | Meaning | Danger Level |
|-------|---------|-------------|
| Verified | Sections glue; usage signatures agree | Safe |
| Divergent | Obstruction found; incompatible usage | Known risk |
| Unexamined | No verification performed | DANGEROUS --- the null state |

**Axiom:** Systems MUST NOT treat Unexamined as implicitly Verified.

**Usage signatures:** For atom `a` in store `G`, the usage signature is the
multiset of `(position, co-occurring-atom)` pairs across all chains
containing `a`. This captures positional behavior and collocational profile.

**Semantic overlap:** Jaccard index over usage signatures, yielding a
continuous measure in [0, 1]. Threshold-based classification: overlap > 0.7
is Verified, overlap < 0.3 is Divergent, between is Unexamined pending
further evidence.

**Semantic profiles:** Per-atom usage analysis including position
distribution, co-occurrence matrix, paradigm membership, and cross-agent
overlap scores.

**Coherence certificates:** Signed attestations with:
- `agentA`, `agentB` --- the verified pair
- `topic` --- the shared sign checked
- `status` --- Verified or Divergent
- `semanticOverlap` --- continuous [0, 1]
- `computationHash` --- SHA-256 for deterministic replay verification
- `semanticProfile` --- per-atom analysis
- `obstruction` --- if Divergent: `{ type: 'term-mismatch' | 'structure-mismatch' | 'frame-incompatible' }`

**Coverage:** Ratio of examined pairs to total pairs: `|examined| / C(n, 2)`.
`computeCoverage(agents)` reports examined, unexamined, and total counts.

**Key functions:** `verifyCoherence(pgslA, pgslB, agentA, agentB, topic)`,
`computeCoverage(agents)`, `getCertificates()`, `getCoherenceStatus(a, b)`.

**Key module:** `pgsl/coherence.ts` (360 lines).

### 3.5 Layer 5: Paradigm Constraints

Structural rules on what can fill positions in chains. The paradigmatic
axis of the Saussurean framework, applied to PGSL.

**Definitions:**

- **Syntagmatic pattern:** S = (p_0, p_1,..., p_n) where each p_i is a
  concrete atom or wildcard `?`.
- **Paradigm set:** P(S, i) = { a in Atoms | exists chain C matching S
  with C[i] = a }. Emerges from usage, not declaration.
- **Paradigm constraint:** Tuple (S, i, op, T) where op is a set operation
  and T is a target set or paradigm reference.

**Five operations** (bounded lattice under set inclusion):

| Operation | Symbol | Semantics |
|-----------|--------|-----------|
| Subset | subseteq | P(S, i) must be a subset of T |
| Intersect | cap | P(S, i) intersection T must be non-empty |
| Union | cup | Result is P(S, i) union T |
| Exclude | setminus | P(S, i) must contain no element of T |
| Equal | = | P(S, i) must equal T exactly |

**SPARQL-based computation:** Paradigm sets are computed via SPARQL queries
against the PGSL triple store. The `computeParadigm(pattern, position)`
function in `server.ts` evaluates patterns against the lattice, supporting
both atom-level and fragment-level paradigm members.

**SHACL integration:** Bidirectional. Constraints generate SHACL NodeShapes
with PropertyShapes on chain positions. SHACL shapes with `sh:in`, `sh:not`,
or `sh:class` can be extracted as paradigm constraints.

**Constraint registry:** Stored as PGSL content. Supports registration,
deregistration, dependency tracking, version history, and federation
(constraints may reference remote paradigm sets).

**Group-level paradigms:** Paradigm computation operates at both atom AND
fragment level. Outer paradigms treat fragments (groups) as paradigm
members, enabling structural constraints at multiple granularities.

**Key module:** `examples/pgsl-browser/server.ts` (paradigm computation,
constraint CRUD, constraint evaluation). Spec: `spec/paradigm-constraints.md`.

### 3.6 Layer 6: Decision Functor (OODA)

Natural transformation D: Obs -> Act from observation presheaves to action
categories.

**OODA formalization:**

1. **Observe:** `extractObservations(pgsl, agent, certificates)` --- query
   presheaf fibers for current sections. Collects PGSL content, active
   Context Descriptors, coherence states, and constraint status.

2. **Orient:** Run coherence verification on relevant section pairs.
   Compute semantic overlap scores. Classify coherence states.

3. **Decide:** `selectStrategy(observations)` --- apply the natural
   transformation. Returns one of four strategies:

   | Strategy | Condition | Action |
   |----------|-----------|--------|
   | Exploit | High coherence, known territory | Use verified sections directly |
   | Explore | Low coverage, unknown territory | Trigger verification |
   | Delegate | Divergence detected | Escalate to human or specialist |
   | Abstain | Insufficient information, high risk | Take no action |

4. **Act:** `decide(pgsl, agent, certificates)` --- execute the selected
   affordance. Returns ranked `Decision[]` with confidence scores,
   justifications, and causal chains.

**Affordance computation:** `computeAffordances(pgsl, coherenceState)` ---
Verified sections yield full affordances; Divergent yield read-only with
warnings; Unexamined yield cautious affordances with verification offered.

**Composition:** `composeDecisions(results)` --- merge decisions from
multiple agents into a unified action plan.

**Types:** `DecisionStrategy`, `DecisionResult`, `Decision`, `Affordance`,
`ObservationSection`.

**Key module:** `pgsl/decision-functor.ts` (560 lines).

### 3.7 Layer 7: Progressive Persistence

Five-tier persistence with URI invariance across all tiers.

| Tier | Name | Storage | Durability | Resolution | Trust |
|------|------|---------|-----------|------------|-------|
| 0 | Memory | In-process Map | Ephemeral | Direct lookup, O(1) | Lowest |
| 1 | Local | Filesystem/DB | Survives restart | File read | Low |
| 2 | Pod | Solid pod | Federated | HTTP + WAC auth | Moderate |
| 3 | IPFS | Distributed | Pinned globally | CID gateway | High |
| 4 | Chain | Blockchain | Permanent | On-chain hash | Highest |

**URI invariance:** `urn:pgsl:atom:{sha256(v)}` is the same regardless of
tier. The content hash IS the identity. Tier metadata (pod URL, CID,
transaction hash) is associated with the URI but does not participate in
URI computation.

**Promotion:** Monotonic (up tiers), recorded with ECDSA-signed
`PromotionRecord`. Content at lower tiers MAY be garbage-collected after
tier 4 anchoring.

**Promotion functions:**

- `promoteToLocal(uri)` --- Tier 0 to 1
- `promoteToPod(uri)` --- Tier 0/1 to 2
- `promoteToIpfs(uri)` --- Any to 3
- `promoteToChain(uri)` --- Any to 4
- `promoteBatch(uris, options)` --- Batch promotion

**Resolution protocol:** Cascade through tiers 0-4 in order; first success
wins. `resolve(registry, uri, authorization)` implements the cascade.
Tier 4 confirms existence but cannot provide content.

**Structural encryption:** Structure visible (URIs, levels, item counts,
containment), values encrypted. Enables structural operations without
exposing content. X25519 key exchange for content key distribution.

**Registry:** `createPersistenceRegistry()` returns a `PersistenceRegistry`
mapping each URI to `PersistenceRecord[]` entries. `persistenceStats()`
returns tier distribution.

**Key module:** `pgsl/persistence.ts` (371 lines).
Spec: `spec/progressive-persistence.md`.

### 3.8 Layer 8: Federation

Each agent owns their Solid pod. Federation is discovery-based.

**Three discovery approaches:**

1. **Known Pods:** `CG_KNOWN_PODS` environment variable lists pod URLs.
2. **Pod Directory Graphs:** Decentralized RDF registries.
   `publishToDirectory()`, `discoverFromDirectory()`.
3. **WebFinger:** RFC 7033 DNS-rooted discovery (same mechanism as
   ActivityPub). `resolveWebFinger()`.

**Federation operations:**

| Operation | Function | Description |
|-----------|----------|-------------|
| Publish | `publish(descriptor, graph, podUrl, { encrypt })` | Write descriptor + graph to pod. When `encrypt` is set, wraps the graph in an X25519 envelope + appends a `cg:affordance` hypermedia block to the descriptor |
| Discover | `discover(podUrl, filters)` | Query pod manifest with facet filters |
| Subscribe | `subscribe(podUrl, callback)` | Solid Notifications subscription |
| Directory | `publishToDirectory()` | Advertise pod in directory |
| WebFinger | `resolveWebFinger(account)` | DNS-rooted agent discovery |
| Cross-pod sharing | `resolveRecipients(handles)` | Resolve DIDs / WebIDs / acct: handles to their pods + authorized agents' X25519 keys for selective envelope recipient inclusion |

**Cross-pod selective sharing:** `publish()` accepts `options.encrypt.recipients` as an explicit key list. The library helper `resolveRecipients(handles, fetch)` (in `solid/sharing.ts`) turns a list of external identity handles (`did:web:...`, `https://.../profile#me`, `acct:bob@host`) into their pods' authorized agents' keys. Union that with your own pod's recipient set when you want a specific graph readable by a specific other person — no pod-level ACL change required. See [`docs/e2ee.md`](../docs/e2ee.md) §"The recipient set" for the composition rules.

**Trust escalation:**

- **SelfAsserted:** Agent claims identity. Lowest trust.
- **ThirdPartyAttested:** Another agent vouches. Medium trust.
- **CryptographicallyVerified:** ECDSA signature chain from human
  principal through delegation to agent. Highest trust.

**Agent registry:** Each pod maintains an agent registry
(`writeAgentRegistry`, `readAgentRegistry`) listing authorized agents with
their roles and delegation credentials.

**Delegation credentials:** Written as W3C Verifiable Credentials in
JSON-LD format (`writeDelegationCredential`). Verification via
`verifyAgentDelegation`.

**Key modules:**

| Module | Lines | Purpose |
|--------|-------|---------|
| `solid/client.ts` | 770 | Publish, discover, subscribe, agent registry |
| `solid/directory.ts` | 145 | Pod directory graphs |
| `solid/webfinger.ts` | 135 | WebFinger resolution |
| `solid/did.ts` | 159 | DID resolution |
| `solid/anchors.ts` | 285 | IPFS anchoring from pod |
| `solid/ipfs.ts` | 111 | IPFS integration |
| `solid/types.ts` | 191 | Federation types |

### 3.9 Layer 9: Virtualized RDF Layer

The entire system is queryable as standard RDF. Any SPARQL client
(Comunica, Apache Jena, Protege) works against the system.

**Endpoints:**

| Endpoint | Method | Content-Type | Description |
|----------|--------|-------------|-------------|
| `/ontology` | GET | `text/turtle` | Full OWL ontology (cg:, pgsl:, Hydra, DCAT, PROV-O) |
| `/ontology/shacl` | GET | `text/turtle` | System SHACL shapes |
| `/api-doc` | GET | `application/ld+json` | Hydra API description (machine-readable) |
| `/catalog` | GET | `text/turtle` | DCAT/DPROD federation catalog |
| `/sparql` | GET/POST | `application/sparql-results+json` | W3C SPARQL Protocol |
| `/sparql/update` | POST | `application/sparql-update` | SPARQL INSERT DATA with PGSL write-back |
| `/dump.ttl` | GET | `text/turtle` | Full system Turtle export |
| `/dump.jsonld` | GET | `application/ld+json` | Full system JSON-LD export |

**Materialization:** `materializeSystem(state)` converts the entire system
state (PGSL nodes, descriptors, certificates, persistence records,
constraints, pods) into a `TripleStore` of standard RDF triples.

**SPARQL Protocol:** `executeSparqlProtocol(state, query, accept)` handles
GET/POST with content negotiation. Returns `application/sparql-results+json`
for SELECT/ASK or `text/turtle` for CONSTRUCT/DESCRIBE.

**Write-back:** `writeBackTriples(state, triples)` and
`sparqlUpdateHandler(state, updateString)` parse INSERT DATA statements and
flow mutations back into PGSL operations (mintAtom, ingest).

**System ontology:** `generateSystemOntology()` produces a full OWL ontology
covering every class and property in the system.
`generateSystemShapes()` produces SHACL shapes.
`generateHydraApiDoc()` produces a Hydra API description.
`generateCatalog()` produces a DCAT/DPROD federation catalog.

**Comunica interop:** Tested with the Comunica SPARQL engine against the
`/sparql` endpoint. Standard RDF tooling interoperability confirmed.

**In-memory SPARQL engine** (independent of virtualized layer):

| Function | Description |
|----------|-------------|
| `createTripleStore()` | Initialize empty triple store |
| `materializeTriples(pgsl)` | PGSL lattice -> RDF triples |
| `parseSparql(query)` | Parse SPARQL string to AST |
| `executeSparql(store, query)` | Execute parsed query |
| `executeSparqlString(store, query)` | Parse + execute |
| `sparqlQueryPGSL(pgsl, query)` | Materialize + execute |

Supports: SELECT, ASK, FILTER, OPTIONAL, UNION, ORDER BY, LIMIT, OFFSET,
GROUP BY, HAVING, aggregates (COUNT, SUM, AVG, MIN, MAX), DISTINCT, BIND,
VALUES, REGEX, and property paths.

**Key modules:**

| Module | Lines | Purpose |
|--------|-------|---------|
| `rdf/virtualized-layer.ts` | 781 | System materialization, SPARQL Protocol, write-back |
| `rdf/system-ontology.ts` | 860 | OWL ontology, SHACL shapes, Hydra, DCAT/DPROD |
| `pgsl/sparql-engine.ts` | 848 | In-memory SPARQL engine (parser + executor) |
| `rdf/serializer.ts` | 533 | Turtle and TriG serializers |
| `rdf/jsonld.ts` | 413 | JSON-LD serializer and parser |
| `rdf/namespaces.ts` | 321 | 23+ W3C namespace constants, class/property IRIs |

### 3.10 Agent Framework

Abstract Agent Types (AAT) provide role-based behavioral contracts for
multi-agent systems operating over PGSL.

**Six agent types:**

| Type | Role | Capabilities |
|------|------|-------------|
| Observer | Read-only monitoring | canPerceive only |
| Analyst | Read + analyze | canPerceive, can derive insights |
| Executor | Read + write | canPerceive, canAct |
| Arbiter | Conflict resolution | canPerceive, canAct, adjudicates disputes |
| Archivist | Preservation-focused | canPerceive, mustPreserve |
| FullAccess | Unrestricted | canPerceive, canAct, all capabilities |

**Behavioral contracts:** Each agent type declares `canPerceive`,
`canAct`, and `mustPreserve` boolean flags. These contracts filter the
affordance space before any other processing --- the agent framework
integrates as a decorator with priority 1 (highest), ensuring that
role-based restrictions are applied before all other decorators in the
chain.

**Key module:** `pgsl/agent-framework.ts`.

### 3.11 Deontic Policy Engine

Fine-grained normative policies evaluated per-affordance in the decorator
chain.

**PolicyRule structure:**

- `mode`: `DeonticMode` --- one of `permit`, `deny`, or `duty`
- `subject`: agent or role the rule applies to
- `action`: the affordance or action class governed
- `condition`: optional predicate for conditional rules

**Evaluation semantics:**

- **Deny overrides permit:** If any deny rule matches, the affordance is
  blocked regardless of permits.
- **Duties accumulate:** All matching duty rules are collected and must be
  fulfilled.
- **Default policies:** Three built-in defaults:
  1. Immutable atoms --- atoms cannot be mutated after creation
  2. Require provenance --- all writes must include provenance metadata
  3. Escalate critical --- critical actions are escalated to Arbiter agents

Policies are evaluated per-affordance within the decorator chain,
after the agent framework filter and before domain-specific decorators.

**Key module:** `pgsl/agent-framework.ts`.

### 3.12 PROV Action Tracing

Every action in the system produces a W3C PROV-O compliant provenance
record.

**Trace structure:**

- `agent`: the acting agent
- `activity`: the action performed
- `entity`: the artifact produced or modified
- `startedAtTime` / `endedAtTime`: temporal bounds
- `wasGeneratedBy` / `used` / `wasAssociatedWith`: PROV-O relations

**Append-only trace store:** All traces are stored in an append-only log.
No trace can be deleted or modified after creation.

**TracedAffordance wrapper:** Wraps any affordance to automatically
capture a PROV-O record when the affordance is exercised. This ensures
complete audit trails without manual instrumentation.

**Turtle serialization:** Traces can be exported as standard PROV-O
Turtle for interoperability with external provenance tools.

**Key module:** `pgsl/agent-framework.ts`.

### 3.13 Affordance Decorators

A pluggable decorator chain that enriches HATEOAS responses with
contextual affordances from multiple sources.

**Architecture:** Each decorator implements a standard interface and is
composed in a priority-ordered chain. Decorators receive the current
affordance set and return an enriched set.

**7 built-in decorators:**

| Decorator | Priority | Purpose |
|-----------|----------|---------|
| Core | 0 | Base PGSL affordances (mint, ingest, resolve, navigate) |
| Ontology Pattern | 2 | RDF/OWL-derived structural suggestions |
| Coherence | 3 | Coherence-state-aware affordance filtering |
| Persistence | 4 | Tier-promotion affordances |
| xAPI Domain | 5 | xAPI-specific affordances for learning data |
| Federation | 6 | Cross-pod discovery and sync affordances |
| LLM Advisor | 7 | AI-suggested structural improvements |

**Affordance metadata:** Each decorator-contributed affordance includes:

- `trustLevel`: confidence in the suggestion source
- `confidence`: numeric score [0, 1]
- `rationale`: human-readable explanation

**Structural suggestions:** Decorators can suggest structural operations
including `nest` (create containment), `reify` (make implicit structure
explicit), `group` (aggregate related items), and `split` (decompose
complex structures).

**Key module:** `pgsl/affordance-decorators.ts`.

### 3.14 Enclaves

DID-bound isolated PGSL instances for sandboxed experimentation and
controlled collaboration.

**Lifecycle:**

- `fork(source, did)`: Create a new enclave as a snapshot of an existing
  PGSL instance, bound to a DID.
- `freeze(enclave)`: Make the enclave read-only, preserving its state.
- `merge(enclave, target, strategy)`: Merge enclave content back. Merge
  strategies include `union` (all content) and `intersection` (only
  shared content).
- `abandon(enclave)`: Discard the enclave and its content.

**Full audit trail:** Every enclave operation (fork, freeze, merge,
abandon) is recorded with timestamps, agent identity, and PROV-O
provenance.

**Key module:** `pgsl/infrastructure.ts`.

### 3.15 Checkpoint/Recovery

Immutable state snapshots with content hashing for reliable state
management.

**Operations:**

- `checkpoint(pgsl)`: Capture an immutable snapshot of the current PGSL
  state. The snapshot is content-hashed (SHA-256) for integrity
  verification.
- `restore(checkpoint)`: Restore PGSL state from a checkpoint. The
  content hash is verified before restoration.
- `diff(checkpointA, checkpointB)`: Compute the structural difference
  between two checkpoints, reporting added, removed, and modified nodes.

**Serialization:** Checkpoints serialize the complete PGSL state
(nodes, provenance, options) to a portable format for backup and
transfer.

**Key module:** `pgsl/infrastructure.ts`.

### 3.16 CRDT Sync

Conflict-free replicated data type (CRDT) synchronization for
eventually-consistent multi-agent collaboration.

**Vector clocks:** Each agent maintains a vector clock tracking causal
ordering of operations. Operations are merged using vector clock
comparison to detect concurrency.

**Causal ordering:** Operations are applied in causal order. Concurrent
operations are merged using CRDT semantics.

**Idempotent operations:** The core PGSL operations (`mint-atom`,
`ingest-chain`) are naturally idempotent due to content-addressing ---
minting the same atom twice produces the same URI with no side effects.

**PGSL as grow-only CRDT:** The PGSL lattice is a natural grow-only
CRDT (G-Set). Atoms and fragments are only added, never removed.
Content-addressing ensures convergence: all replicas that have seen
the same set of operations will have identical state.

**Key module:** `pgsl/infrastructure.ts`.

### 3.17 Introspection Agents

Automated discovery and ingestion of external data sources into PGSL.

**Supported source types:**

- **JSON:** Auto-scan JSON objects and arrays, generating chains from
  key-value paths.
- **CSV:** Parse tabular data, generating chains from column headers
  and row values.
- **RDF:** Ingest existing RDF datasets, mapping triples to PGSL chains.
- **API:** Crawl REST/Hydra API endpoints, discovering structure and
  generating representative chains.

**Generated artifacts:**

- PGSL chains representing the discovered structure
- SHACL shapes describing the inferred schema
- Paradigm constraints capturing observed regularities

**Key module:** `pgsl/discovery.ts`.

### 3.18 Zero-Copy Virtual Layer

Lazy-loading virtual references for large-scale PGSL instances.

**Reference-based access:** Virtual references point to PGSL content
without loading it into memory. Content is resolved on demand when
accessed.

**Cache management:**

- **LRU (Least Recently Used):** Evicts the least recently accessed
  content when the cache reaches capacity.
- **FIFO (First In, First Out):** Evicts the oldest cached content.

**Resolve on demand:** Virtual references are transparently resolved
when their content is needed, with resolved values cached according
to the active eviction policy.

**Key module:** `pgsl/discovery.ts`.

### 3.19 Homoiconic Metagraph

The PGSL lattice describes itself using its own representational
primitives.

**Self-description:** The lattice contains meta-atoms that describe
the lattice's own structure:

- **Counts:** Number of atoms, fragments, and levels
- **Levels:** Depth and breadth of the lattice hierarchy
- **Invariants:** Structural properties that hold across the lattice

**Self-referential query:** SPARQL queries over the metagraph enable
introspective analysis --- the system can reason about its own
structure using the same query mechanisms used for domain content.

**Key module:** `pgsl/discovery.ts`.

### 3.20 Marketplace Discovery

Hydra-driven registry for discovering and composing system components.

**Registration:** Components register themselves via Hydra API
descriptions, advertising their capabilities and interfaces.

**Discoverable component types:**

- **Agents:** Available agent instances with their AAT types and
  capabilities
- **Data sources:** PGSL instances and external data endpoints
- **Decorators:** Affordance decorators available for composition
- **Profiles:** Ingestion profiles for domain-specific data mapping

**Capability-based discovery:** Consumers query the marketplace by
required capabilities rather than by name, enabling loose coupling
and substitutability.

**Key module:** `pgsl/discovery.ts`.

### 3.21 Personal Broker

Per-agent PGSL instance managing an agent's private knowledge and
conversational state.

**Per-agent PGSL:** Each agent maintains its own PGSL lattice for
private knowledge that is not shared with the federation unless
explicitly published.

**Memory types:**

- **Semantic memory:** Facts and relationships (PGSL chains)
- **Episodic memory:** Temporal sequences of events and experiences
- **Procedural memory:** Learned strategies and action patterns

**Conversations:** The broker manages multi-turn conversational state,
tracking context across interactions.

**Presence status:** Agents publish presence information (online,
offline, busy) through the broker for coordination.

**Key module:** `pgsl/agent-framework.ts`.

---

## 4. Ingestion Profiles

Domain-specific data mapping into PGSL. Each profile defines how to
transform a domain object into one or more chains.

### 4.1 xAPI Profile

Transforms xAPI statements into multiple short-atom chains:

- Core statement: `(actor, verb, object)` with normalized, short atoms
- Identity chain: `(actor, identity, IFI-value)` for IFI binding
- Name chain: `(actor, name, display-name)` for display resolution
- Result chains: `(actor, object, property, value)` for score/duration/success

Uses `transformMulti()` to produce all chains from a single statement.
Handles IFI priority (account > mbox > mbox_sha1sum > openid), nested
context activities, and result extensions.

### 4.2 LERS Profile

Transforms IEEE LERS credentials with issuer/subject/achievement/evidence
nesting:

- Issuer chain: `(subject, issuer, issuer-id)`
- Achievement chain: `(subject, achievement, achievement-name)`
- Evidence chain: `(subject, evidence, evidence-summary)`
- Level chain: `(subject, achievement, level, level-value)`

### 4.3 RDF Profile

Transforms RDF triples into subject/predicate/object triple structure.
Each triple becomes a 3-atom chain.

### 4.4 Custom Profiles

Register via `registerProfile({ name, description, transform })`. The
transform function receives domain input and returns a canonical string
representation for PGSL ingestion.

**Key functions:** `ingestWithProfile(pgsl, profileName, data)`,
`batchIngestWithProfile(pgsl, profileName, dataArray)`,
`registerProfile(profile)`, `getProfile(name)`, `listProfiles()`.

**Key module:** `pgsl/profiles.ts` (383 lines).

---

## 5. Cryptography

All real implementations. No mocks.

### 5.1 ECDSA Signing

- **Library:** ethers.js v6 (secp256k1 curve)
- **Wallet creation:** `createWallet(role, name)` --- real secp256k1
  keypairs for both human and agent roles
- **Descriptor signing:** `signDescriptor(id, turtle, wallet)` ---
  ECDSA signature over descriptor content
- **Verification:** `verifyDescriptorSignature(id, turtle, signature)`

### 5.2 End-to-End Encryption

- **Library:** tweetnacl (X25519 + XSalsa20-Poly1305)
- **Key exchange:** `generateKeyPair()` --- X25519 keypairs
- **Encrypt:** `createEncryptedEnvelope(content, recipientKeys, sender)`
- **Decrypt:** `openEncryptedEnvelope(envelope, recipient)`
- Multi-recipient: content key wrapped per recipient

**Three encryption surfaces** (all using the same envelope format):

| Surface | What's encrypted | Where emitted |
|---|---|---|
| Graph envelope | Full named-graph payload behind a descriptor | `publish()` when `options.encrypt` is set |
| Facet value | Individual sensitive field inside a facet | `encryptFacetValue()` in `crypto/facet-encryption.ts` |
| PGSL atom | Content of a single lattice atom | `mintEncryptedAtom()` in `pgsl/lattice.ts` |

**Recipient set composition** (graph envelope):

1. Every non-revoked `cg:AuthorizedAgent` on the target pod with a registered `cg:encryptionPublicKey`.
2. The publishing agent's own X25519 key (always included).
3. Any `share_with` handles resolved to external pods' authorized agents (see §3.8 Federation).

**Per-agent, not per-device**: each surface (stdio, relay, future clients) holds its own X25519 keypair; the user's pod lists every surface as a first-class `cg:AuthorizedAgent`. Revocation is per-surface. The envelope format is identical whether the key lives on a user's device, a server-side agent host, or a future hardware-backed wallet.

**Wire format**: the envelope is a JSON document served at `<slug>-graph.envelope.jose.json` with `Content-Type: application/jose+json`. Structure: `{ content: { ciphertext, nonce, algorithm }, wrappedKeys: [{ recipientPublicKey, wrappedKey, nonce, senderPublicKey }], algorithm: "X25519-XSalsa20-Poly1305", version: 1 }`. See [`docs/e2ee.md`](../docs/e2ee.md) for the full architecture.

**Descriptor link to envelope** (HATEOAS — see §6): every descriptor Turtle embeds a `cg:affordance` block that is simultaneously `cg:Affordance`, `cgh:Affordance`, `hydra:Operation`, and `dcat:Distribution`. Clients follow `hydra:target` / `dcat:accessURL` — no filename convention. Described further in §6.4.

#### 5.2.1 Cleartext / ciphertext layering (normative protocol boundary)

The protocol partitions the artifact store into two layers with distinct reader contracts. This partition is the single most important architectural property of Interego at the protocol level:

| Layer | Contents | Reader contract | SPARQL-queryable? |
|---|---|---|---|
| **Descriptor layer** | ContextDescriptor RDF: facets, provenance, modal status, trust, temporal bounds, federation pointers, hypermedia affordances, revocation conditions (where present) | MUST be readable without decryption keys | **MUST** be queryable via SPARQL without any decryption step |
| **Payload layer** | Named-graph content addressed by the descriptor (e.g. the encrypted envelope) | MAY require decryption keys (encryption is OPTIONAL at the protocol level but normative when invoked) | MUST NOT require decryption for federation-layer reasoning that depends only on descriptor metadata |

Normatively, every claim the protocol asks readers to reason about across a federation — recipient eligibility, modal status, temporal validity, revocation condition, trust level — **MUST** be expressible in the descriptor layer. If a new claim can only be evaluated by reading decrypted content, it is out-of-protocol.

This is why the descriptor carries six facets: the facets are the query surface the federation can reach without holding any key. The payload is epistemically opaque to unauthorized readers by design.

**Implementation implication (informative):** the reference implementation publishes descriptors as Turtle at publicly-readable URLs and payloads as JOSE envelopes at companion URLs. Any implementation adopting different serializations or transports MUST preserve this cleartext/ciphertext split at the protocol boundary.

#### 5.2.2 Temporal semantics: `generatedAtTime` vs. `validFrom` (normative distinction)

The protocol distinguishes two temporal concepts that implementations MUST NOT conflate:

- `prov:generatedAtTime` (ProvenanceFacet) — the wall-clock moment at which the assertion was made by the agent.
- `cg:validFrom` / `cg:validUntil` (TemporalFacet) — the boundaries of the interval over which the assertion holds.

These values are often equal in new claims — the author is asserting "I claim this, and it starts being true now." They diverge for:

- Backdated claims ("I claim today that event E happened at time T₀ < now").
- Scheduled claims ("I claim today that policy P starts at T₁ > now").
- Retroactive corrections ("I claim today that the previously-published assertion started earlier than I originally said").

Implementations MUST accept explicit `validFrom` / `validUntil` values distinct from the auto-stamped `generatedAtTime`. Writers SHOULD auto-stamp `generatedAtTime` only when the caller has not supplied one; they MUST NOT copy `generatedAtTime` into `validFrom` as a default when the caller has supplied one.

**Future-dated `validFrom` is legal** at the protocol level but SHOULD emit a warning at validation time to surface scheduled-claim patterns for reader awareness. Server clocks MUST be UTC; renderers are responsible for local-time presentation.

#### 5.2.3 Interval-contains discovery: `effective_at` (normative)

Discovery filters MUST distinguish **endpoint filters** (`valid_from` / `valid_until` — "is the descriptor's interval endpoint on this side of T?") from the **interval-contains filter** (`effective_at` — "is T inside the descriptor's validity interval?"). The two are distinct queries and a conformant implementation MUST NOT conflate them.

Given a descriptor with `validFrom = F` and (optionally) `validUntil = U`, and a filter `effective_at = T`:

- Match iff `F ≤ T` AND (`U ≥ T` OR `U` absent).
- If the descriptor's manifest entry omits `validFrom` or `validUntil`, conformant implementations SHOULD treat the omitted endpoint as "always-started" / "never-ends" respectively — *but* they MUST document this (the reference implementation does).

Manifest writers MUST emit `cg:validFrom` / `cg:validUntil` for every new descriptor so downstream federation readers can compute the interval-contains query without fetching each descriptor body.

#### 5.2.4 Descriptor-level cross-references (normative)

`cg:ContextDescriptor` carries these optional top-level predicates for cross-descriptor relationships:

- `cg:supersedes <iri>` — this descriptor replaces the named prior descriptor.
- `dct:conformsTo <iri>` — this descriptor's claim conforms to the named schema, vocabulary, or shape.

These MUST be mirrored from the encrypted graph content at publish time (see `normalizePublishInputs` in the reference implementation) and written into both the descriptor Turtle and the manifest entry. Federation readers filter on these without needing to decrypt the payload.

### 5.3 Zero-Knowledge Proofs

Fiat-Shamir transform for non-interactive proofs:

| Proof Type | Function | What it proves |
|-----------|----------|---------------|
| Confidence | `proveConfidenceAboveThreshold(value, threshold)` | Value > threshold without revealing value |
| Membership | `proveDelegationMembership(agent, set)` | Agent in authorized set without revealing which |
| Temporal | `proveTemporalOrdering(time, deadline)` | Published before time T without revealing exact time |
| Range | Range proofs | Value in range without revealing value |
| Merkle | Merkle membership proofs | Inclusion in Merkle tree |
| Fragment | Fragment membership proofs | Fragment in lattice |

### 5.4 Identity Standards

| Standard | Support |
|----------|---------|
| SIWE (ERC-4361) | `createSiweMessage()`, `signSiweMessage()`, `verifySiweSignature()` |
| ERC-8004 | `createAgentToken()` --- agent identity tokens |
| EIP-712 | `createDelegation()` --- typed structured data delegation |
| DID | `did:web` resolution via `solid/did.ts` |
| WebID | Profile documents on Solid pods |
| W3C VC | Delegation credentials as Verifiable Credentials |

### 5.5 IPFS

- **CID computation:** `computeCid(content)` --- real SHA-256 CID
- **Pinning:** `pinDescriptor(id, turtle, config)` via Pinata or web3.storage
- **Integration:** `solid/ipfs.ts` and `crypto/ipfs.ts`

**Key modules:**

| Module | Lines | Purpose |
|--------|-------|---------|
| `crypto/wallet.ts` | 518 | Wallets, ECDSA, delegation, SIWE, ERC-8004 |
| `crypto/encryption.ts` | 393 | NaCl E2E encryption, envelope creation |
| `crypto/ipfs.ts` | 210 | CID computation, IPFS pinning |
| `crypto/zk/proofs.ts` | 441 | All ZK proof implementations |
| `crypto/types.ts` | 291 | Crypto type definitions |

---

## 6. HATEOAS API

Every node in the PGSL lattice is uniquely addressed and dereferenceable.
The API follows hypermedia-driven navigation.

### 6.1 Node Endpoint

`GET /node/{uri}` returns:

| Field | Content |
|-------|---------|
| `_structure` | Items (for fragments), value (for atoms), level, kind |
| `_context` | Containers (parent fragments), containment annotations |
| `_paradigm` | `sourceOptions` (what can precede), `targetOptions` (what can follow), active `constraints` |
| `_controls` | Fully-specified hypermedia forms (method, href, fields, templates) |
| `_links` | `self`, `up` (containers), `down` (items) |

### 6.2 Chain Endpoint

`POST /api/chain` with `{ uris: string[] }` returns:

| Field | Content |
|-------|---------|
| `items` | Resolved chain members with URIs, values, levels, kinds |
| `innerNeighbors` | Sequence extensions (left/right) |
| `outerNeighbors` | Containing fragments (what embeds this chain as a unit) |
| `outerParadigm` | Paradigm patterns at the group level |
| `_controls` | Chain-level affordances |

### 6.3 Controls

Controls are fully-specified hypermedia forms:

```
{
  rel: string,          // e.g., 'create-constraint', 'chain-view'
  title: string,        // human-readable action description
  method: string,       // HTTP method
  href: string,         // target URL
  fields: [{            // form fields with types and optional defaults
    name, type, value?, options?
  }]
}
```

Authorization determines which controls are visible. Unverified coherence
state restricts available controls.

### 6.4 Descriptor Affordance (Hypermedia link to graph payload)

Every `cg:ContextDescriptor` emitted by `publish()` carries a self-describing
affordance block that is simultaneously:

- `cg:Affordance`      — discovery-time capability declaration (matches
                          `cg:canPublish` / `cg:canDiscover` /
                          `cg:canSubscribe` pattern)
- `cgh:Affordance`     — harness-execution-time affordance for
                          decorator pipelines
- `hydra:Operation`    — HATEOAS client dispatch target
- `dcat:Distribution`  — DCAT-3 compatible for external catalog ingestion

```turtle
<> cg:affordance [
    a cg:Affordance, cgh:Affordance, hydra:Operation, dcat:Distribution ;
    cg:action cg:canDecrypt ;   # or cg:canFetchPayload for plaintext
    hydra:method "GET" ;
    hydra:target <.../slug-graph.envelope.jose.json> ;
    hydra:returns cg:EncryptedGraphEnvelope ;
    hydra:title "Fetch encrypted graph envelope" ;
    dcat:accessURL <.../slug-graph.envelope.jose.json> ;
    dcat:mediaType "application/jose+json" ;
    cg:encrypted true ;
    cg:encryptionAlgorithm "X25519-XSalsa20-Poly1305" ;
    cg:recipientCount 3
] .
```

Four compatible types on one RDF node — any client speaking any one of
these vocabularies can dispatch the retrieval without Interego-specific
understanding. DCAT-aware catalogs ingest the descriptor as a dataset;
Hydra clients auto-generate UI; harness agents integrate it into
affordance-decorator pipelines; cg: discovery sees it as a capability.

**No filename conventions.** Clients follow `hydra:target` /
`dcat:accessURL`. The companion envelope's location is declared in the
descriptor itself — rename it, move it to a different pod, host it via
a different URI scheme — every consumer updates automatically because
the descriptor is the source of truth.

`parseDistributionFromDescriptorTurtle()` in `@interego/core` (exported
from the top-level index) extracts `{ accessURL, mediaType, encrypted,
encryptionAlgorithm }` from any descriptor Turtle so library consumers
and MCP tools follow the link the same way.

### 6.5 Per-surface agent identity

Each surface a user operates from (Claude Code VS Code, Claude Desktop,
Claude Mobile via OAuth, claude.ai web, any future client) registers
as its own first-class `cg:AuthorizedAgent` on the user's pod, with:

- Its own `did:web:<identity-host>:agents:<surface-id>` DID
- Its own persisted X25519 keypair for envelope decryption
- Its own delegation credential at `/credentials/<agent-id>.jsonld`
- Its own `cg:encryptionPublicKey` in the pod's agent registry

The identity server's OAuth `/auth/*` endpoints accept a `surfaceAgent`
hint from the relay; identity mints or reuses `<hint>-<userId>` as the
per-surface agent. The relay auto-detects the surface slug from the
OAuth client's DCR-registered `client_name` (`Claude Code (VS Code)` →
`claude-code-vscode`; `ChatGPT` → `chatgpt`; `Cursor` → `cursor`;
`OpenAI Codex` → `openai-codex`; unknown-but-slugifiable names become
their own slug; genuinely absent or garbage names fall back to the
generic `mcp-client` — deliberately NOT `claude-*` so no unknown
client silently masquerades as Claude). Every descriptor this surface
writes attributes to its surface DID via `prov:wasAssociatedWith`.

The userId portion of the agent IRI is itself derived from the user's
first credential (`u-pk-<sha256(credId)[:12]>`, `u-eth-<addr[:12]>`,
or `u-did-<sha256(did)[:12]>`) — never a user-supplied string. Legacy
seeded userIds are gated behind a single-use `BOOTSTRAP_INVITES` env
token; see `deploy/identity/AUTH-ARCHITECTURE.md`.

Pod attribution, envelope recipient sets, and revocation are all
per-surface — no agent piggybacks on another surface's delegation,
and any surface can be revoked independently.

---

## 7. Browser and Observatory

### 7.1 PGSL Browser

Interactive chain view with:

- Chain visualization: atoms as boxes, fragments as groups
- Paradigm boxes: click any position to see its paradigm set (the dropdown)
- Constraint creation: create constraints between paradigm positions
- Graph visualization: lattice structure rendering
- Node Explorer: search by value, view paradigm/controls/structure

### 7.2 Observatory

8-tab real-time dashboard for monitoring multi-agent federation:

| Tab | Content |
|-----|---------|
| Federation | Pod registry, status, descriptor counts |
| Descriptors | Facet browsing, descriptor details |
| Trust | Trust chain visualization, delegation audit |
| Composition | Algebraic operator playground |
| SPARQL | Query interface against materialized system |
| SHACL | Three-layer validation (core + structural + domain) |
| Coherence | Usage-based verification, semantic profiles, coverage |
| Decisions | OODA decision functor results per agent |

### 7.3 TLA Demo

7-phase interactive pipeline demonstrating the full system:

1. **Setup:** 6 pods, 6 ethers.js wallets, 3 EIP-712 delegations
2. **xAPI Ingestion:** 15 statements, PGSL structural ingestion, ECDSA signing
3. **Competency Assessment:** SPARQL queries, affordance engine, Pearl's SCM
4. **Credential Issuance:** Composition (intersection), SHACL, IEEE LERS, ECDSA
5. **Learner Discovery:** Bidirectional discovery, signature + delegation verification
6. **External Verification:** Full trust chain audit, cohort overlap via SPARQL
7. **Coherence and Decisions:** Usage-based coherence verification, decision functor

**Key files:** `examples/pgsl-browser/server.ts` (2,494 lines),
`examples/pgsl-browser/index.html`, `examples/pgsl-browser/observatory.html`.

---

## 8. MCP Server

24 tools for AI agent integration via the Model Context Protocol.

### 8.1 Tool Categories

| Category | Count | Tools |
|----------|-------|-------|
| Core | 6 | `publish_context`, `discover_context`, `get_descriptor`, `subscribe_to_pod`, `get_pod_status`, `analyze_question` |
| Delegation | 3 | `register_agent`, `revoke_agent`, `verify_agent` |
| Federation | 8 | `discover_all`, `subscribe_all`, `list_known_pods`, `add_pod`, `remove_pod`, `discover_directory`, `publish_directory`, `resolve_webfinger` |
| Identity | 2 | `setup_identity`, `link_wallet` |
| PGSL | 5 | `pgsl_ingest`, `pgsl_resolve`, `pgsl_lattice_status`, `pgsl_meet`, `pgsl_to_turtle` |

### 8.2 Progressive Tiers

| Tier | Tool Count | Audience |
|------|------------|----------|
| `core` | 6 | New users |
| `standard` | 17 | Teams federating |
| `full` | 19 | Crypto/wallet users |
| `all` (default) | 24 | Power users |

Set via `CG_TOOL_TIER` environment variable.

### 8.3 Auto-Onboarding

First tool call provisions: pod creation, registry initialization,
credential generation. No manual setup required.

**Key files:** `mcp-server/server.ts`, `mcp-server/pod-registry.ts`.

---

## 9. Deployment

### 9.1 Local (Zero Internet)

```bash
CG_BASE_URL=http://localhost:3456/ npx tsx mcp-server/server.ts
```

Auto-starts Community Solid Server. Everything works offline.

### 9.2 Azure Container Apps

```bash
cd deploy && bash azure-deploy.sh
```

Deploys 4 services:

| Service | Purpose |
|---------|---------|
| CSS | Community Solid Server (pod hosting) |
| Dashboard | Observatory UI |
| MCP Relay | HTTP/REST bridge with auth, X402 payments, IPFS pinning |
| Identity | WebID + DID + Ed25519 + WebFinger + bearer tokens + SIWE |

### 9.3 Docker

5 Dockerfiles in `deploy/`:

- CSS configuration (`deploy/css-config/`)
- Identity server (`deploy/identity/`)
- MCP relay (`deploy/mcp-relay/`)
- Dashboard
- Browser

### 9.4 Identity Server

Full identity provider supporting:

- WebID profile documents
- DID (did:web) resolution
- Ed25519 key generation
- WebFinger (RFC 7033) discovery
- Bearer token authentication
- SIWE (ERC-4361) wallet-based auth

---

## 10. Ontology and Namespaces

### 10.1 System Ontologies

| Prefix | Namespace | Scope |
|--------|-----------|-------|
| `cg:` | `https://markjspivey-xwisee.github.io/interego/ns/cg#` | Interego system |
| `pgsl:` | `https://markjspivey-xwisee.github.io/interego/ns/pgsl#` | PGSL lattice |

### 10.2 W3C Standard Namespaces

23+ namespaces imported and typed in `rdf/namespaces.ts`:

| Prefix | Standard | Usage |
|--------|----------|-------|
| `rdf:` | RDF 1.1 | Type system |
| `rdfs:` | RDF Schema | Class/property hierarchy |
| `xsd:` | XML Schema | Datatypes |
| `owl:` | OWL 2 | Ontology language |
| `prov:` | PROV-O | Provenance |
| `time:` | OWL-Time | Temporal |
| `dcterms:` | Dublin Core Terms | Metadata |
| `as:` | Activity Streams | Agent activities |
| `sh:` | SHACL | Shapes validation |
| `acl:` | WAC | Access control |
| `vc:` | VC 2.0 | Verifiable Credentials |
| `did:` | DID Core | Decentralized Identifiers |
| `dcat:` | DCAT 3 | Data catalogs |
| `ldp:` | LDP | Linked Data Platform |
| `solid:` | Solid | Solid Protocol terms |
| `oa:` | Web Annotation | Annotation model |
| `hydra:` | Hydra | API descriptions |
| `dprod:` | DPROD | Data products |
| `foaf:` | FOAF | Agent descriptions |
| `skos:` | SKOS | Concept schemes |

All namespace constants, class IRIs, and property IRIs are typed and
exported. The `expand()`/`compact()` helpers handle prefix-to-full-IRI
conversion.

---

## 11. Test Coverage

608 tests across 19 suites. Zero type errors.

| Suite | Tests | Coverage |
|-------|-------|----------|
| `agent-framework.test.ts` | 68 | AAT types, deontic policies, PROV tracing, personal broker |
| `xapi-conformance.test.ts` | 60 | xAPI profile, IFI priority, result/context structure |
| `multi-agent-integration.test.ts` | 59 | Multi-agent coordination, enclaves, CRDT sync |
| `discovery.test.ts` | 50 | Introspection, virtual layer, metagraph, marketplace |
| `infrastructure.test.ts` | 47 | Enclaves, checkpoint/recovery, CRDT sync |
| `context-graphs.test.ts` | 44 | Builder, composition, validation, serialization |
| `causality.test.ts` | 38 | SCM, do-calculus, d-separation, counterfactual |
| `encryption-zk.test.ts` | 33 | NaCl encryption, ZK proofs, selective disclosure |
| `pgsl.test.ts` | 31 | Lattice, category, geometric morphism |
| `crypto.test.ts` | 25 | Wallets, ECDSA, delegation, SIWE |
| `affordance.test.ts` | 23 | Gibson, Norman, OODA, BDI, Friston, stigmergy |
| `federation.test.ts` | 21 | Pod directory, multi-pod, WebFinger, Hydra |
| `solid.test.ts` | 20 | Publish, discover, subscribe, agent registry |
| `pgsl-sparql.test.ts` | 19 | Triple store, SPARQL execution, generators |
| `pgsl-tools.test.ts` | 19 | LLM tools, tool call parsing, tool loop |
| `sdk-extractors.test.ts` | 17 | Category theory, semiotic functor |
| `projection.test.ts` | 15 | Vocabulary mapping, binding strength |
| `pgsl-shacl.test.ts` | 13 | Core/structural/domain SHACL validation |
| `pgsl-coherence.test.ts` | 9 | Coherence verification, coverage, certificates |

Test runner: Vitest. All composition tests use `resetComposedIdCounter()` in
`beforeEach` for deterministic IDs.

---

## 12. Module Reference

Complete table of all TypeScript modules in `src/`, sorted by directory.

### 12.1 Core (`src/`)

| Module | Lines | Exports |
|--------|-------|---------|
| `index.ts` | 631 | Barrel exports for entire library |
| `sdk.ts` | 401 | SDK convenience functions |

### 12.2 Model (`src/model/`)

| Module | Lines | Key Exports |
|--------|-------|-------------|
| `types.ts` | 815 | `IRI`, `ContextDescriptorData`, `ContextTypeName`, `ModalStatus`, `TrustLevel`, `CompositionOperator`, all facet interfaces |
| `causality.ts` | 637 | `buildSCM`, `doIntervention`, `isDSeparated`, `evaluateCounterfactual` |
| `descriptor.ts` | 441 | `ContextDescriptor` class (builder pattern) |
| `category.ts` | 347 | Presheaf naturality, lattice law verification |
| `delegation.ts` | 327 | `createDelegation`, `verifyDelegation`, EIP-712 typed data |
| `semiotic.ts` | 283 | Sign functor, adjunction, Semiotic Field Functor |
| `composition.ts` | 260 | `union`, `intersection`, `restriction`, `override`, `effectiveContext` |
| `registry.ts` | 180 | Open facet registry, merge strategy registration |
| `index.ts` | 51 | Barrel exports |

### 12.3 PGSL (`src/pgsl/`)

| Module | Lines | Key Exports |
|--------|-------|-------------|
| `sparql-engine.ts` | 848 | `parseSparql`, `executeSparql`, `sparqlQueryPGSL`, `materializeTriples`, `TripleStore` |
| `lattice.ts` | 753 | `createPGSL`, `mintAtom`, `ingest`, `resolve`, `queryNeighbors`, `latticeStats`, `ensureBuilt` |
| `shacl.ts` | 581 | `validateCorePGSL`, `validateStructuralPGSL`, `validateDomainShapes`, `validateAllPGSL` |
| `decision-functor.ts` | 560 | `extractObservations`, `computeAffordances`, `selectStrategy`, `decide`, `composeDecisions` |
| `fact-extraction.ts` | 405 | Structured fact extraction from natural language |
| `profiles.ts` | 383 | `ingestWithProfile`, `registerProfile`, `batchIngestWithProfile`, `XapiStatement`, `LersCredential` |
| `usage-semantics.ts` | 374 | Usage-based co-occurrence mining, Yoneda embedding |
| `persistence.ts` | 371 | `createPersistenceRegistry`, `recordPersistence`, `promoteToIpfs`, `promoteToChain`, `resolve` |
| `computation.ts` | 368 | Date arithmetic, counting, aggregation, abstention detection |
| `coherence.ts` | 360 | `verifyCoherence`, `computeCoverage`, `getCertificates`, `CoherenceCertificate` |
| `question-router.ts` | 329 | Cognitive strategy routing for questions |
| `advanced-temporal.ts` | 328 | Advanced temporal reasoning |
| `category.ts` | 327 | Presheaf P: L^op -> Set, fiber, pullback, naturality |
| `rdf.ts` | 422 | PGSL namespace, lattice-to-RDF serialization |
| `types.ts` | 308 | `Value`, `Atom`, `Fragment`, `Node`, `PGSLInstance`, `TokenGranularity` |
| `ontological-inference.ts` | 301 | Synonym groups, IS-A, part-of inference |
| `relation-extraction.ts` | 288 | Entity-relation extraction |
| `retrieval.ts` | 273 | Content retrieval and search |
| `geometric.ts` | 269 | Geometric morphism between lattices |
| `index.ts` | 258 | Barrel exports |
| `entity-extraction.ts` | 207 | Named entity extraction |
| `temporal-retrieval.ts` | 171 | Temporal query resolution |
| `tools.ts` | 458 | LLM tool interface (5 tools), multi-turn dispatch loop |
| `agent-framework.ts` | --- | AAT types, deontic policies, PROV tracing, personal broker |
| `affordance-decorators.ts` | --- | Pluggable decorator chain, 7 built-in decorators |
| `infrastructure.ts` | --- | Enclaves, checkpoint/recovery, CRDT sync |
| `discovery.ts` | --- | Introspection agents, virtual layer, metagraph, marketplace |

### 12.4 RDF (`src/rdf/`)

| Module | Lines | Key Exports |
|--------|-------|-------------|
| `system-ontology.ts` | 860 | `generateSystemOntology`, `generateSystemShapes`, `generateHydraApiDoc`, `generateCatalog` |
| `virtualized-layer.ts` | 781 | `materializeSystem`, `executeSparqlProtocol`, `writeBackTriples`, `systemToTurtle`, `systemToJsonLd` |
| `serializer.ts` | 533 | `toTurtle`, `toTriG`, Turtle serialization |
| `jsonld.ts` | 413 | `toJsonLd`, `fromJsonLd`, JSON-LD serialization/parsing |
| `namespaces.ts` | 321 | 23+ namespace constants, `CGClass`, `CGProp`, `expand`, `compact` |
| `index.ts` | 33 | Barrel exports |

### 12.5 Solid (`src/solid/`)

| Module | Lines | Key Exports |
|--------|-------|-------------|
| `client.ts` | 770 | `publish`, `discover`, `subscribe`, `writeAgentRegistry`, `readAgentRegistry` |
| `anchors.ts` | 285 | IPFS anchor management |
| `types.ts` | 191 | Federation types |
| `did.ts` | 159 | DID resolution |
| `directory.ts` | 145 | Pod directory graphs |
| `webfinger.ts` | 135 | WebFinger (RFC 7033) resolution |
| `ipfs.ts` | 111 | IPFS integration |
| `index.ts` | 59 | Barrel exports |

### 12.6 Validation (`src/validation/`)

| Module | Lines | Key Exports |
|--------|-------|-------------|
| `validator.ts` | 422 | `validate`, `ValidationResult`, `ValidationViolation` |
| `shacl-shapes.ts` | 183 | `generateShaclShapes`, SHACL Turtle export |
| `index.ts` | 2 | Barrel exports |

### 12.7 Affordance (`src/affordance/`)

| Module | Lines | Key Exports |
|--------|-------|-------------|
| `compute.ts` | 598 | `computeAffordances`, `extractSignifiers`, `evaluateSurprise` |
| `engine.ts` | 533 | Affordance engine integrating 8 frameworks |
| `types.ts` | 344 | `OODACycle`, `SituationalAwarenessLevel`, `AgentState`, `StigmergicField` |
| `index.ts` | 64 | Barrel exports |

### 12.8 Crypto (`src/crypto/`)

| Module | Lines | Key Exports |
|--------|-------|-------------|
| `wallet.ts` | 518 | `createWallet`, `createDelegation`, `signDescriptor`, `createSiweMessage`, `signSiweMessage` |
| `zk/proofs.ts` | 441 | ZK proofs: confidence, membership, temporal, range, Merkle |
| `encryption.ts` | 393 | `generateKeyPair`, `createEncryptedEnvelope`, `openEncryptedEnvelope` |
| `types.ts` | 291 | Crypto type definitions |
| `ipfs.ts` | 210 | `computeCid`, `pinDescriptor` |
| `index.ts` | 126 | Barrel exports |
| `zk/index.ts` | 34 | Barrel exports |

### 12.9 Other (`src/`)

| Module | Lines | Key Exports |
|--------|-------|-------------|
| `sparql/patterns.ts` | 297 | Parameterized SPARQL 1.2 query pattern builders |
| `sparql/index.ts` | 13 | Barrel exports |
| `connectors/index.ts` | 288 | External system connectors |
| `extractors/index.ts` | 243 | Category theory extractors, semiotic functor |

---

## 13. Conformance

### 13.1 W3C Interego 1.0 Working Draft

The reference implementation conforms to the
[Interego 1.0 Working Draft](https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html):

- **Section 3.1:** Context Descriptor structure --- `ContextDescriptorData` type
- **Section 3.2:** Context facets --- 9 facet types (Temporal, Provenance, Agent, AccessControl, Semiotic, Trust, Federation, Causal, Projection)
- **Section 3.3:** Context-graph bindings --- `describes` field on descriptor
- **Section 3.4:** Composition operators --- `union`, `intersection`, `restriction`, `override` forming bounded lattice
- **Section 3.5:** Triple-level inheritance --- `effectiveContext()` function
- **Section 5:** All facet types with W3C vocabulary alignment
- **Section 6:** Serialization --- Turtle (`toTurtle`), JSON-LD (`toJsonLd`), TriG (`toTriG`)
- **Section 7:** SPARQL 1.2 query patterns --- `sparql/patterns.ts`

### 13.2 Specification Addendums

| Addendum | File | Status |
|----------|------|--------|
| Paradigm Constraints | `spec/paradigm-constraints.md` | Syntagm/paradigm, 5 operations, emergent semantics, coherence protocol, decision functor, causal integration |
| Progressive Persistence | `spec/progressive-persistence.md` | 5-tier persistence, URI invariance, resolution protocol, structural encryption |

### 13.3 Extensions Beyond Spec

The reference implementation includes capabilities beyond the core
specification:

- PGSL content-addressed substrate
- Pearl's SCM (do-calculus, d-separation, counterfactual)
- Affordance engine (8 frameworks)
- E2E encryption (NaCl)
- Zero-knowledge proofs (Fiat-Shamir)
- IPFS anchoring and pinning
- Structural computation (date arithmetic, counting, aggregation)
- Cognitive strategy routing
- Entity/relation/fact extraction
- Usage-based semantics and ontological inference
- In-memory SPARQL engine
- Three-layer SHACL validation
- Virtualized RDF layer with SPARQL Protocol
- MCP server for AI agent integration
- Abstract Agent Types (AAT) with behavioral contracts
- Deontic policy engine (permit/deny/duty)
- W3C PROV-O action tracing with append-only trace store
- Pluggable affordance decorator chain (7 built-in decorators)
- DID-bound enclaves (fork, freeze, merge, abandon)
- Checkpoint/recovery with content-hashed snapshots
- CRDT sync with vector clocks and causal ordering
- Introspection agents (JSON, CSV, RDF, API auto-scan)
- Zero-copy virtual layer with LRU/FIFO cache
- Homoiconic metagraph (self-describing lattice)
- Marketplace discovery (Hydra-driven component registry)
- Personal broker (per-agent PGSL, semantic/episodic/procedural memory)

---

## References

- **[CG-CORE]** Interego 1.0 Core Specification. Draft.
- **[CG-PARADIGM]** Interego 1.0: Paradigm Constraints, Emergent Semantics, and Coherence Verification.
- **[CG-PERSIST]** Interego 1.0: Progressive Persistence Tier System.
- **[PGSL]** PGSL: Content-Addressed Lattice for Structured Knowledge.
- **[RDF]** W3C RDF 1.1 Concepts and Abstract Syntax. W3C Recommendation.
- **[SPARQL]** W3C SPARQL 1.1 Query Language. W3C Recommendation.
- **[SHACL]** W3C Shapes Constraint Language (SHACL). W3C Recommendation.
- **[SOLID]** Solid Protocol. W3C Community Group Report.
- **[WAC]** Web Access Control. W3C Community Group Report.
- **[PROV-O]** W3C PROV-O: The PROV Ontology. W3C Recommendation.
- **[OWL-TIME]** W3C Time Ontology in OWL. W3C Recommendation.
- **[DCAT]** W3C Data Catalog Vocabulary (DCAT). W3C Recommendation.
- **[HYDRA]** Hydra Core Vocabulary. W3C Community Group Report.
- **[VC]** W3C Verifiable Credentials Data Model 2.0. W3C Recommendation.
- **[DID]** W3C Decentralized Identifiers (DIDs) v1.0. W3C Recommendation.
- **[IPFS]** InterPlanetary File System. Protocol Labs.
- **[PEARL]** Pearl, J. Causality: Models, Reasoning, and Inference. 2009.
- **[WITTGENSTEIN]** Wittgenstein, L. Philosophical Investigations. 1953.
- **[FIRTH]** Firth, J.R. A Synopsis of Linguistic Theory. 1957.
- **[EIP-712]** Ethereum Typed Structured Data Hashing and Signing.
- **[ERC-4361]** Sign-In with Ethereum (SIWE).
- **[ERC-8004]** Agent Identity Tokens.
