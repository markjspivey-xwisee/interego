# Context Graphs: Presentation Outline and Speaker Notes

**Target duration:** 30 minutes (25 min presentation + 5 min Q&A)

**Audience:** W3C Community Group members, standards engineers, multi-agent
system practitioners.

**Setup requirements:** Browser with Context Graphs UI loaded, terminal with
PGSL store running, demo data pre-loaded (healthcare handoff scenario).

---

## Slide 1: Title

**Context Graphs: Composable, Verifiable, Federated Context Infrastructure**

W3C Community Group Presentation

**Time:** 1 minute

### Speaker Notes

Open with the core positioning: Context Graphs is infrastructure, not an
application. It sits beneath agent frameworks the way HTTP sits beneath web
applications. Mention the three properties in the subtitle -- composable,
verifiable, federated -- as the throughline for the talk. Each subsequent
slide will ground one or more of these properties.

---

## Slide 2: Problem

**Multi-agent systems share data but not meaning.**

- Same term, different contexts: "patient" in ER vs. Pharmacy
- Data exchange is solved; semantic interoperability is not
- The "unexamined coherence" problem: systems assume agreement without checking

**Time:** 3 minutes

### Speaker Notes

Use a concrete example: two hospital departments both have a "patient" field.
They can exchange JSON. But the ER means "person currently being triaged" while
Pharmacy means "person with an active prescription." The data exchanges
successfully, but downstream reasoning fails silently. This is the unexamined
coherence problem: the system treats unknown agreement as if it were verified
agreement. Emphasize that this is not a data format problem -- it is a
semantics problem. Existing standards (JSON-LD, RDF) solve syntax; Context
Graphs addresses whether agents actually mean the same thing.

---

## Slide 3: Architecture

**Four layers:**

1. **PGSL** -- Content-addressed lattice (atoms, fragments, chains, overlapping pairs)
2. **Context Descriptors** -- Typed metadata with trust levels
3. **Coherence** -- Usage-based verification (Verified / Divergent / Unexamined)
4. **Decision Functor** -- Observation to action via natural transformation

**Time:** 3 minutes

### Speaker Notes

Show the architecture diagram. Walk through bottom-up: PGSL provides the
content-addressed substrate. Context Descriptors attach meaning and provenance.
Coherence verification checks whether different agents actually agree. The
Decision Functor turns all of this into action. Emphasize that each layer is
independently useful but they compose. You can use PGSL without coherence. You
can use coherence without the decision functor. This is the "composable" part
of the subtitle.

---

## Slide 4: PGSL Demo

**Live demo: Lattice construction**

- Input: "mark is human"
- Atoms: `mark`, `is`, `human` (content-addressed, immutable)
- Fragment: ordered subset
- Chain: complete syntagmatic sequence
- Overlapping pair: two chains sharing an atom

**Key property:** Same content produces the same URI on any agent, anywhere.

**Time:** 4 minutes

### Speaker Notes

Switch to the terminal. Create a PGSL store. Add the chain "mark is human."
Show the atom URIs -- point out they are derived from content, not assigned.
Add a second chain "mark is tall." Show the overlapping pair on "mark." This
is the foundation: structural identity from content. No coordination needed
between agents to agree on identifiers. If two agents both encounter "mark,"
they get the same atom URI independently. Walk back to the slide and connect
this to federation: content-addressing is what makes zero-coordination
federation possible.

### Demo Commands

```bash
# Create store and add chains
pgsl store create demo
pgsl chain add demo "mark is human"
pgsl chain add demo "mark is tall"
pgsl overlap show demo mark
```

---

## Slide 5: Paradigm Constraints

**Chain = syntagm, + dropdown = paradigm**

- P(S, i): atoms at position i across chains matching pattern S
- Five operations: subset, intersect, union, exclude, equal
- Forms a bounded lattice on paradigm sets
- Two-click constraint creation in browser UI

**Time:** 4 minutes

### Speaker Notes

This is the linguistic core. A chain is a syntagm -- a sequence in context.
The paradigm is what COULD go in each slot. Show the browser UI. Click on a
position in a chain. The dropdown shows all atoms that have appeared at that
position across all matching chains. That dropdown IS the paradigm set. Now
show constraint creation: select two paradigm sets, pick an operation (e.g.,
"subset"), done. Two clicks. The constraint restricts what atoms are valid at
that position. Connect to SHACL: each constraint generates a SHACL shape
automatically. Connect to SPARQL: paradigm computation is a SELECT query
under the hood.

### Demo Instructions

1. Open browser UI to the chain view.
2. Click position 2 in the pattern "mark is ?" to show paradigm dropdown.
3. Show atoms: `human`, `tall`, etc.
4. Create a subset constraint limiting position 2 to `{human, tall, mortal}`.
5. Show generated SHACL shape in the inspector panel.

---

## Slide 6: TLA Pipeline

**Flight Simulator to Verifiable Credential**

1. Flight simulator emits xAPI statements
2. xAPI mapped to competency assertions
3. Competency linked to LERS credential
4. Credential issued with trust level

**Trust escalation:**
- SelfAsserted (learner claims)
- ThirdPartyAttested (instructor confirms)
- CryptographicallyVerified (signed credential)

**Time:** 3 minutes

### Speaker Notes

This is the real-world deployment example. The Total Learning Architecture
(TLA) pipeline starts with a learner in a flight simulator. The simulator
emits xAPI statements: "pilot performed crosswind landing with score 92."
Context Graphs maps this through the competency framework and issues a LERS
credential. The key insight is trust escalation: the raw xAPI statement is
SelfAsserted. When an instructor reviews and confirms, it becomes
ThirdPartyAttested. When it is signed as a verifiable credential, it becomes
CryptographicallyVerified. Each level is a Context Descriptor with increasing
trust weight. The coherence system can then verify that the competency
assertion and the credential actually refer to the same demonstrated skill.

---

## Slide 7: Coherence Demo

**Healthcare handoff: three departments**

| Department | "patient" usage | "diagnosis" usage |
|------------|----------------|-------------------|
| ER | active triage | preliminary |
| Radiology | imaging subject | imaging finding |
| Pharmacy | prescription holder | confirmed condition |

- "patient": high semantic overlap (0.82) -- shared meaning
- "diagnosis": low semantic overlap (0.31) -- divergent meaning
- Result: emergent data contract identifying the divergence

**Time:** 4 minutes

### Speaker Notes

Switch to the demo. Show three Context Descriptors representing ER, Radiology,
and Pharmacy. Run coherence verification. Point to the "patient" atom: high
overlap score because all three departments use it in similar syntagmatic
patterns (subject of care actions). Now point to "diagnosis": low overlap
because ER uses it as "working hypothesis," Radiology uses it as "imaging
interpretation," and Pharmacy uses it as "confirmed ICD code." The system
flags this divergence automatically. No one had to write an ontology or define
a mapping. The divergence emerged from usage analysis. This is the emergent
data contract: the system discovered that these three departments need to
agree on what "diagnosis" means before they can safely exchange it. Show the
coherence certificate with the obstruction type: term-mismatch on "diagnosis."

### Demo Instructions

1. Load pre-built healthcare scenario: `pgsl demo load healthcare`.
2. Run coherence verification: `coherence verify --all`.
3. Show results table with overlap scores.
4. Inspect the divergent pair (ER, Pharmacy) on "diagnosis."
5. Show the coherence certificate JSON.

---

## Slide 8: Decision Functor

**OODA loop formalized as natural transformation**

1. **Observe:** Query presheaf fibers for current context sections
2. **Orient:** Run coherence verification, compute overlap scores
3. **Decide:** Natural transformation D: Obs --> Act selects strategy
4. **Act:** Execute selected affordance, update store

**Strategies:** Exploit | Explore | Delegate | Abstain

**Time:** 3 minutes

### Speaker Notes

This is the formal decision-making layer. The OODA loop is a well-known
military decision framework. Context Graphs formalizes it using category
theory. The observation functor collects presheaf sections -- what the agent
can see. The orientation phase is coherence verification -- understanding the
reliability of what you see. The decision is a natural transformation --
a structure-preserving map from observations to actions. The four strategies
correspond to different coherence states: Exploit when you have high verified
coherence, Explore when coverage is low, Delegate when divergence needs human
resolution, Abstain when the risk of acting on unexamined coherence is too
high. Emphasize that Abstain is a valid and important action -- it is better
to do nothing than to act on unverified assumptions.

---

## Slide 9: Federation

**How it composes across boundaries**

- Solid pods as storage backend
- Cross-pod discovery via content-addressed lookup
- Composition operators: union, intersection, restriction, override
- Zero-dependency TypeScript implementation
- 324+ passing tests

**Time:** 3 minutes

### Speaker Notes

Federation is the "federated" part of the subtitle. Each agent has its own
PGSL store, potentially in a Solid pod. Because atoms are content-addressed,
agents can discover shared content without a central registry. The composition
operators let you combine stores: union merges, intersection finds common
ground, restriction filters by pattern, override lets one store's content
take precedence. All of this is implemented in zero-dependency TypeScript --
no runtime dependencies beyond the language itself. Mention the test count
(324+) as evidence of maturity. The implementation is open source and
available for review.

---

## Slide 10: What's Next

**Standardization and adoption roadmap**

- W3C Community Group specification finalization
- Production deployments in education (TLA) and healthcare
- Agent SDK integration (provide Context Graphs as infrastructure for any
  agent framework)
- Formal verification of lattice properties
- Performance benchmarking at scale (target: 1M+ chains)

**Time:** 2 minutes

### Speaker Notes

Close with the forward-looking roadmap. The specification is moving toward
Community Group Report status. Production deployments in TLA are ongoing.
The next major integration target is agent SDKs -- making Context Graphs
available as a composable layer that any agent framework can adopt. Mention
that the formal properties (lattice, natural transformation, d-separation)
are not just theoretical niceties; they enable formal verification of system
properties, which matters for safety-critical deployments. End with a call
to participation: the Community Group is open, contributions are welcome,
and the specification benefits from diverse implementation experience.

---

## Q&A

**Time:** 5 minutes reserved

### Anticipated Questions

**Q: How does this differ from RDF/OWL ontology alignment?**
A: Ontology alignment requires upfront agreement on shared vocabulary.
Context Graphs discovers agreement (or disagreement) from usage patterns.
It complements ontology approaches -- you can use both.

**Q: What is the performance overhead of coherence verification?**
A: Verification is O(n * m) where n is shared atoms and m is average chain
length. In practice, incremental verification (only checking changed content)
keeps this tractable. Certificates cache results.

**Q: Does this require all agents to use PGSL?**
A: No. Any structured data can be projected into PGSL for analysis. The
content-addressing layer handles the mapping. Agents keep their native
formats.

**Q: How does trust escalation interact with coherence?**
A: Higher trust levels increase the weight of coherence evidence. A
CryptographicallyVerified section provides stronger coherence evidence than
a SelfAsserted one, reflected in the verification thresholds.
