# Interego 1.0: Paradigm Constraints, Emergent Semantics, and Coherence Verification

**W3C Community Group Draft Specification Addendum**

**Latest version:** This document

**Editors:** Interego Community Group

**Abstract:** This document specifies the paradigm constraint system, emergent
semantics model, coherence verification protocol, decision functor, and causal
model integration for Interego 1.0. These mechanisms extend the core PGSL
lattice and Context Descriptor infrastructure with usage-based semantic analysis,
compositional constraint operations, and formally grounded decision-making.

**Status:** Draft. This specification addendum is intended for discussion within
the W3C Interego Community Group.

---

## 1. Paradigm Constraints

### 1.1 Overview

In structural linguistics, a **syntagm** is a sequential chain of signs, and a
**paradigm** is the set of signs substitutable at a given position within that
chain. Interego adopts this framing directly: chains in PGSL are syntagms;
the set of atoms that may appear at each position constitutes a paradigm set.

Paradigm constraints restrict which atoms may occupy specific positions within
syntagmatic patterns, enabling structural validation, emergent typing, and
cross-agent interoperability.

### 1.2 Definitions

**Definition 1.1 (Syntagmatic Pattern).** A syntagmatic pattern S is a sequence
of position specifications (p_0, p_1, ..., p_n) where each p_i is either a
concrete atom or a wildcard `?`.

**Definition 1.2 (Paradigm Set).** For a syntagmatic pattern S and position
index i, the paradigm set P(S, i) is the set of all atoms a such that there
exists at least one chain C matching S with C[i] = a:

```
P(S, i) = { a in Atoms | exists C in Chains : matches(C, S) and C[i] = a }
```

**Definition 1.3 (Paradigm Constraint).** A paradigm constraint is a tuple
(S, i, op, T) where S is a syntagmatic pattern, i is a position index, op is a
paradigm operation, and T is a target set or paradigm reference.

### 1.3 Operations

Five operations are defined over paradigm sets. Together they form a bounded
lattice under set inclusion.

| Operation | Symbol | Semantics |
|-----------|--------|-----------|
| Subset | `subset` (subseteq) | P(S, i) must be a subset of T |
| Intersect | `intersect` (cap) | Result is P(S, i) intersection T; must be non-empty |
| Union | `union` (cup) | Result is P(S, i) union T |
| Exclude | `exclude` (setminus) | P(S, i) must contain no element of T |
| Equal | `equal` (=) | P(S, i) must equal T exactly |

**Theorem 1.1 (Bounded Lattice).** The paradigm sets of a PGSL store, ordered
by set inclusion, form a bounded lattice where:
- The bottom element is the empty set (no atoms).
- The top element is the full atom set of the store.
- Meet is set intersection.
- Join is set union.

Paradigm operations correspond to lattice operations: `subset` asserts a
position in the lower cone of T; `equal` pins to a specific lattice element;
`exclude` removes elements; `intersect` computes the meet; `union` computes the
join.

### 1.4 SPARQL-Based Paradigm Computation

Paradigm sets are computed via SPARQL queries against the PGSL store. The
canonical query form:

```sparql
SELECT ?candidate WHERE {
  ?chain pgsl:matchesPattern ?pattern .
  ?chain pgsl:positionAtom ?pos ?candidate .
  FILTER(?pos = ?targetPosition)
}
```

This query returns all atoms appearing at position `?targetPosition` across
chains matching `?pattern`. The result set is the paradigm set P(S, i).

For constraint evaluation, a second query checks the operation:

```sparql
ASK WHERE {
  # For subset constraint: every candidate must be in T
  FILTER NOT EXISTS {
    ?chain pgsl:matchesPattern ?pattern .
    ?chain pgsl:positionAtom ?pos ?candidate .
    FILTER(?pos = ?targetPosition)
    FILTER(?candidate NOT IN (?t1, ?t2, ...))
  }
}
```

### 1.5 SHACL Integration

Paradigm constraints have a bidirectional mapping to SHACL shapes:

**Constraints to Shapes.** Each paradigm constraint (S, i, op, T) generates a
SHACL NodeShape targeting chains matching S, with a PropertyShape on position i:

```turtle
ex:constraint-shape a sh:NodeShape ;
  sh:targetClass pgsl:Chain ;
  sh:property [
    sh:path ( pgsl:position_i ) ;
    sh:in ( T ) ;           # for subset/equal
  ] .
```

**Shapes to Constraints.** SHACL shapes with `sh:in`, `sh:not`, or `sh:class`
on chain position paths can be extracted as paradigm constraints, enabling
import of external validation vocabularies.

### 1.6 Constraint Registry

All active constraints are maintained in a constraint registry, itself stored as
PGSL content. The registry supports:

- Registration and deregistration of constraints.
- Dependency tracking between constraints.
- Version history via content-addressed snapshots.
- Federation: constraints may reference paradigm sets in remote stores.

---

## 2. Emergent Semantics

### 2.1 Theoretical Foundation

Interego adopts a **usage-based** theory of meaning, grounded in:

- **Wittgenstein:** "The meaning of a word is its use in the language."
- **Firth:** "You shall know a word by the company it keeps."

Meaning is not declared by ontology authors; it **emerges** from patterns of
use across agents and contexts.

### 2.2 Shared Signs vs. Shared Meaning

**Definition 2.1 (Shared Sign).** Two agents A_1 and A_2 share a sign s if both
possess the atom corresponding to s in their respective PGSL stores:

```
SharedSign(A_1, A_2, s) iff s in Atoms(A_1) and s in Atoms(A_2)
```

Because PGSL atoms are content-addressed, identity is structural: the same
content yields the same URI regardless of the agent that created it.

**Definition 2.2 (Shared Meaning).** Two agents share the meaning of sign s if
they use s in the same syntagmatic contexts:

```
SharedMeaning(A_1, A_2, s) iff UsageSig(A_1, s) approximates UsageSig(A_2, s)
```

Sharing a sign is necessary but not sufficient for sharing meaning. The
critical distinction: data interoperability (shared signs) does not imply
semantic interoperability (shared meaning).

### 2.3 Usage Signatures

**Definition 2.3 (Usage Signature).** The usage signature of atom a in store G
is the multiset of (position, co-occurring-atom) pairs across all chains
containing a:

```
UsageSig(G, a) = { (i, C[j]) | C in Chains(G), C[i] = a, j != i }
```

The usage signature captures both the **positional behavior** of an atom (which
syntagmatic slots it fills) and its **collocational profile** (which atoms
appear alongside it).

### 2.4 Semantic Overlap

**Definition 2.4 (Semantic Overlap).** The semantic overlap between atom a as
used in stores G_1 and G_2 is:

```
Overlap(G_1, G_2, a) = |UsageSig(G_1, a) intersection UsageSig(G_2, a)| /
                        |UsageSig(G_1, a) union UsageSig(G_2, a)|
```

This is the Jaccard index over usage signatures. It yields a continuous measure
in [0, 1] where:
- 0 means completely disjoint usage (shared sign, no shared meaning).
- 1 means identical usage (shared sign and shared meaning).

### 2.5 Semantic Profile

The semantic profile of an atom is the complete usage analysis including:

1. **Position distribution:** histogram of positions occupied.
2. **Co-occurrence matrix:** frequency of co-occurring atoms per position.
3. **Paradigm membership:** which paradigm sets P(S, i) include this atom.
4. **Cross-agent overlap:** semantic overlap scores with each known peer.

Semantic profiles are computed lazily and cached as PGSL content for
reuse across coherence verification runs.

---

## 3. Coherence Verification

### 3.1 Coherence States

Every pair of Context Descriptors (sections of a presheaf) exists in exactly one
of three coherence states:

| State | Symbol | Definition |
|-------|--------|------------|
| **Verified** | V | Sections are compatible; a gluing exists |
| **Divergent** | D | An obstruction has been identified |
| **Unexamined** | U | No verification has been performed |

**Axiom 3.1 (Dangerous Null).** The Unexamined state is explicitly
distinguished from both Verified and Divergent. Systems MUST NOT treat
Unexamined as implicitly Verified. The Unexamined state represents an
epistemic gap that may conceal either agreement or conflict.

### 3.2 Verification Protocol

Verification proceeds by comparing usage signatures across section boundaries:

1. **Enumerate shared atoms** between two Context Descriptors.
2. **Compute usage signatures** for each shared atom in both contexts.
3. **Calculate semantic overlap** for each shared atom.
4. **Classify:** If all overlaps exceed the verification threshold (default
   0.7), the pair is Verified. If any overlap falls below the divergence
   threshold (default 0.3), the pair is Divergent. Otherwise, the pair
   remains Unexamined pending further evidence.

### 3.3 Certificates

**Definition 3.1 (Coherence Certificate).** A coherence certificate is a signed
attestation of verification with the following structure:

```
Certificate {
  sections:       (CD_1, CD_2)
  state:          Verified | Divergent
  evidence:       Map<Atom, OverlapScore>
  computationHash: Hash          // for deterministic replay
  timestamp:      DateTime
  issuer:         AgentID
  signature:      Signature
}
```

The `computationHash` enables **replay verification**: any agent can recompute
the verification and confirm the certificate by comparing hashes.

### 3.4 Coverage

**Definition 3.2 (Coherence Coverage).** For a set of Context Descriptors
{CD_1, ..., CD_n}, coherence coverage is the ratio of examined pairs to total
pairs:

```
Coverage = |{ (i,j) : state(CD_i, CD_j) != Unexamined }| / C(n, 2)
```

Coverage is reported as a value in [0, 1]. Systems SHOULD track coverage and
alert when it falls below acceptable thresholds for the deployment context.

### 3.5 Obstruction Types

When verification identifies divergence, the obstruction is classified:

| Type | Description |
|------|-------------|
| `term-mismatch` | Same atom, incompatible usage signatures |
| `structure-mismatch` | Incompatible syntagmatic patterns for shared domain |
| `frame-incompatible` | Paradigm sets have irreconcilable constraint conflicts |

Obstructions are recorded in the coherence certificate evidence and
surfaced as actionable diagnostics.

---

## 4. Decision Functor

### 4.1 Formal Definition

**Definition 4.1 (Decision Functor).** The decision functor is a natural
transformation D: Obs --> Act where:

- **Obs** is the observation functor mapping each context to its presheaf
  sections (available information).
- **Act** is the action functor mapping each context to its available
  affordances (possible actions).

For each context c, D_c: Obs(c) --> Act(c) selects an action given the
current observations.

### 4.2 Observation Sections

Observations are drawn from presheaf fibers over the current context. Each
fiber provides a local view:

```
Obs(c) = { section s | s is a section of the presheaf F over open set U
           containing c }
```

The observation includes the PGSL content, active Context Descriptors,
coherence state of all known pairs, and paradigm constraint status.

### 4.3 Affordance Computation

Affordances are computed from the coherence state:

- **Verified sections** yield full affordances (read, write, compose, federate).
- **Divergent sections** yield restricted affordances (read-only, with
  divergence warnings).
- **Unexamined sections** yield cautious affordances (read with "unverified"
  annotation, explicit verification action offered).

Affordances are expressed as HATEOAS links in the REST API, enabling
hypermedia-driven navigation.

### 4.4 Strategy Selection

The decision functor selects from four strategies:

| Strategy | Condition | Action |
|----------|-----------|--------|
| **Exploit** | High coherence, known territory | Use verified sections directly |
| **Explore** | Low coverage, unknown territory | Trigger verification of Unexamined pairs |
| **Delegate** | Divergence detected, resolution needed | Escalate to human or specialized agent |
| **Abstain** | Insufficient information, high risk | Take no action; request more context |

### 4.5 OODA Loop Formalization

The decision functor implements a formalized OODA loop:

1. **Observe:** Query presheaf fibers for current sections. Collect PGSL
   content, Context Descriptors, and constraint state.

2. **Orient:** Run coherence verification on relevant section pairs. Compute
   semantic overlap scores. Classify coherence states.

3. **Decide:** Apply the natural transformation D. Given observations and
   coherence state, select strategy and specific action.

4. **Act:** Execute the selected affordance. Update the PGSL store. Emit
   new Context Descriptors if state changed. Loop.

Each phase maps to a well-defined computational step with deterministic
outputs given the same inputs, enabling replay and audit.

---

## 5. Causal Model Integration

### 5.1 Paradigm Constraints as Structural Causal Model

The paradigm constraint registry can be interpreted as a structural causal
model (SCM) where:

- **Variables** are paradigm sets P(S, i).
- **Structural equations** are the constraint operations relating paradigm sets.
- **Exogenous inputs** are the raw chains in the PGSL store.

**Definition 5.1 (Constraint SCM).** The constraint SCM is a tuple
(V, U, F, P_U) where:
- V = { P(S, i) | for all registered constraints }
- U = { Chains(G) } (exogenous: the actual chain content)
- F = { f_c | c is a constraint, f_c computes the constrained paradigm set }
- P_U is the distribution over chain content

### 5.2 Building the SCM

The `buildSCM` operation constructs a causal graph from the constraint
registry:

```
buildSCM(registry) {
  nodes = unique paradigm set references in registry
  edges = for each constraint (S, i, op, T):
            add edge from P(S, i) to T if op induces dependency
  return DAG(nodes, edges)
}
```

Cycles in the constraint graph indicate mutual dependencies and are
flagged as warnings; resolution requires constraint relaxation or
explicit ordering.

### 5.3 Counterfactual Evaluation

The SCM enables counterfactual queries:

**"What if constraint C were removed?"** Recompute all downstream paradigm
sets with C disabled. Compare the resulting paradigm sets against the
current state. Report which atoms would be admitted or excluded.

**"What if atom a were added to position i?"** Propagate the addition through
all constraints referencing P(S, i). Report constraint violations and
cascading effects.

Counterfactual evaluation supports constraint authoring by previewing the
impact of changes before committing them.

### 5.4 D-Separation

**Definition 5.2 (Paradigm Independence).** Two paradigm sets P(S_1, i) and
P(S_2, j) are independent given a conditioning set Z if they are d-separated
in the constraint SCM given Z.

D-separation identifies which paradigm sets can be modified independently,
enabling:
- Parallel constraint evaluation.
- Modular federation (independent subgraphs can be delegated to different
  agents).
- Efficient incremental recomputation.

### 5.5 HATEOAS Affordance Filtering

Causal reasoning filters the affordances presented in HATEOAS responses:

1. Compute the current coherence state and constraint satisfaction.
2. For each candidate affordance, evaluate causal consequences via the SCM.
3. Filter affordances whose causal effects would violate constraints or
   reduce coherence.
4. Rank remaining affordances by expected coherence improvement.

This ensures that agents navigating via hypermedia links are guided toward
actions that maintain or improve system coherence.

---

## Conformance

Implementations claiming conformance to this specification addendum MUST:

1. Implement paradigm set computation as defined in Section 1.2.
2. Support all five paradigm operations (Section 1.3).
3. Distinguish the three coherence states including Unexamined (Section 3.1).
4. Never treat Unexamined as Verified (Axiom 3.1).
5. Produce coherence certificates with replay hashes (Section 3.3).

Implementations MAY additionally support:
- SPARQL-based paradigm computation (Section 1.4).
- SHACL bidirectional mapping (Section 1.5).
- Decision functor strategies (Section 4.4).
- Causal model integration (Section 5).

---

## References

- **[CG-CORE]** Interego 1.0 Core Specification.
- **[PGSL]** PGSL: Content-Addressed Lattice for Structured Knowledge.
- **[SHACL]** W3C Shapes Constraint Language (SHACL). W3C Recommendation.
- **[SPARQL]** W3C SPARQL 1.1 Query Language. W3C Recommendation.
- **[PEARL]** Pearl, J. Causality: Models, Reasoning, and Inference. 2009.
- **[WITTGENSTEIN]** Wittgenstein, L. Philosophical Investigations. 1953.
- **[FIRTH]** Firth, J.R. A Synopsis of Linguistic Theory. 1957.
