# Context Graphs 1.0 --- System Architecture

**W3C Community Group Draft Specification**

**Latest version:** This document

**Editors:** Mark Spivey / Foxxi Mediums Inc.

**Abstract:** This document is the single source of truth for the architecture
of Context Graphs 1.0 --- a compositional framework for typed graph contexts
over RDF 1.2 Named Graphs. It describes the complete system as implemented in
the `@foxxi/context-graphs` reference implementation: a zero-dependency
TypeScript library (ESM, Node 20+) totaling 22,636 lines across 66 modules.

**Status:** Draft. Intended for discussion within the W3C Context Graphs
Community Group.

---

## 1. Overview

Context Graphs is composable, verifiable, federated context infrastructure.
It provides a massively multi-agent shared memory with typed context, trust,
algebraic composition, and structural intelligence.

Every Named Graph has context: who created it, when, under what interpretive
frame, at what confidence, with what trust credential, through what causal
model. Context Graphs makes that context structured, composable,
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
   `{ type: 'Temporal' | 'Provenance' | ... }` for exhaustive switch
   matching. TypeScript compiler enforces completeness.

9. **W3C vocabulary reuse.** 23+ standard namespaces. No novel vocabulary
   when W3C provides one.

10. **Real cryptography.** No mocks. ethers.js v6 for ECDSA, tweetnacl for
    NaCl encryption, real IPFS CIDs, real SIWE verification.

---

## 3. Layer Architecture

The system is organized in 9 layers, each building on the one below.

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

- **Syntagmatic pattern:** S = (p_0, p_1, ..., p_n) where each p_i is a
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
| Publish | `publish(descriptor, graph, podUrl)` | Write descriptor + graph to pod |
| Discover | `discover(podUrl, filters)` | Query pod manifest with facet filters |
| Subscribe | `subscribe(podUrl, callback)` | Solid Notifications subscription |
| Directory | `publishToDirectory()` | Advertise pod in directory |
| WebFinger | `resolveWebFinger(account)` | DNS-rooted agent discovery |

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

### 5.2 E2E Encryption

- **Library:** tweetnacl (X25519 + XSalsa20-Poly1305)
- **Key exchange:** `generateKeyPair()` --- X25519 keypairs
- **Encrypt:** `createEncryptedEnvelope(content, recipientKeys, sender)`
- **Decrypt:** `openEncryptedEnvelope(envelope, recipient)`
- Multi-recipient: content key wrapped per recipient

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
| `cg:` | `https://markjspivey-xwisee.github.io/context-graphs/ns/cg#` | Context Graphs system |
| `pgsl:` | `https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#` | PGSL lattice |

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

387 tests across 15 suites. Zero type errors.

| Suite | Tests | Coverage |
|-------|-------|----------|
| `context-graphs.test.ts` | 44 | Builder, composition, validation, serialization |
| `xapi-conformance.test.ts` | 60 | xAPI profile, IFI priority, result/context structure |
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

### 13.1 W3C Context Graphs 1.0 Working Draft

The reference implementation conforms to the
[Context Graphs 1.0 Working Draft](https://markjspivey-xwisee.github.io/context-graphs/spec/context-graphs-1.0-wd.html):

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

---

## References

- **[CG-CORE]** Context Graphs 1.0 Core Specification. W3C Community Group Draft.
- **[CG-PARADIGM]** Context Graphs 1.0: Paradigm Constraints, Emergent Semantics, and Coherence Verification.
- **[CG-PERSIST]** Context Graphs 1.0: Progressive Persistence Tier System.
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
