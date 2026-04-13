# Context Graphs: Context Layer + Harness

_A note on how the system is positioned, and why the distinction is load-bearing._

## TL;DR

Context Graphs is **both a context layer and a harness**, and the two halves are designed for each other. The context layer is the PGSL substrate — a content-addressed, lattice-structured memory that anything can plug into. The harness is the scaffolding around LLMs and agents — panels, routing, runtime eval, decorators, tracing — that relies on the substrate's structure to make its decisions. You can peel off the harness and still have a useful context layer. You cannot peel off the context layer, because the harness's reliability comes from having a real substrate to reason over instead of raw prompt strings.

## The two layers

### Context layer (substrate)

If you stopped the project here, you'd have a content-addressed, compositional memory substrate that anything could plug into — no LLM required. Pure data and structure.

- **PGSL itself** — lattice, atoms, fibers, pullbacks, co-occurrence matrix
- **Structural retrieval** and usage-based similarity
- **RDF / OWL / SHACL export** and coherence verification
- **Progressive persistence** (memory → local → pod → IPFS → chain)
- **Federation, discovery, virtual layer, metagraph**

Source: [`src/pgsl/lattice.ts`](../src/pgsl/lattice.ts), [`src/pgsl/category.ts`](../src/pgsl/category.ts), [`src/pgsl/retrieval.ts`](../src/pgsl/retrieval.ts), [`src/pgsl/usage-semantics.ts`](../src/pgsl/usage-semantics.ts), [`src/pgsl/rdf.ts`](../src/pgsl/rdf.ts), [`src/pgsl/persistence.ts`](../src/pgsl/persistence.ts), [`src/pgsl/discovery.ts`](../src/pgsl/discovery.ts).

### Harness (scaffolding around LLMs / agents)

This is clearly harness machinery: it wraps LLMs with routing, verification, confidence scoring, retry logic, and observability.

- **Question router** — classifies a question and dispatches it to the right strategy
- **Panel-of-experts pattern** — multiple independent LLM readings (reader, extractor, skeptic, arbiter) vote on an answer
- **Runtime eval** — confidence-driven retry and abstention, with per-strategy historical accuracy tracking
- **Decision functor** — observation → affordance → strategy → decide, i.e. an OODA loop compiled into a functor
- **Affordance decorators** — pluggable annotators (ontology patterns, coherence, persistence, xAPI, federation, LLM advisor) that enrich responses with HATEOAS-style next-action hints
- **Agent framework** — Abstract Agent Types (AAT), deontic policy engine, PROV tracing, Personal Broker
- **Tool loops and type-aware judging**

Source: [`src/pgsl/question-router.ts`](../src/pgsl/question-router.ts), [`src/pgsl/runtime-eval.ts`](../src/pgsl/runtime-eval.ts), [`src/pgsl/decision-functor.ts`](../src/pgsl/decision-functor.ts), [`src/pgsl/affordance-decorators.ts`](../src/pgsl/affordance-decorators.ts), [`src/pgsl/agent-framework.ts`](../src/pgsl/agent-framework.ts), and the benchmark runner at [`benchmarks/run-pgsl-native.ts`](../benchmarks/run-pgsl-native.ts).

## Why the distinction matters

Most "harness" frameworks (LangChain, AutoGPT-style loops, even Claude Code itself) wrap an LLM but treat memory as an afterthought — a vector DB bolted on the side. Most "context layer" products (Pinecone, Weaviate, Mem0) are just retrieval stores with no opinion about how the LLM should use them.

What's novel here is that **the harness and the context layer are designed for each other**:

1. **The harness's decisions are driven by structural signals from the context layer.**
   `computeConfidence()` reads `latticeStats`, `ranked` retrieval scores, and shared-atom counts to score answers. Confidence isn't vibes — it's derived from the substrate. See [`src/pgsl/runtime-eval.ts`](../src/pgsl/runtime-eval.ts).

2. **The context layer's affordances are computed by the harness's decorators and exposed through HATEOAS.**
   The context layer doesn't just store; it advertises navigable actions. Each decorator reads the substrate and decides what an agent can meaningfully do next from here. See [`src/pgsl/affordance-decorators.ts`](../src/pgsl/affordance-decorators.ts).

3. **PROV tracing ties harness decisions back to substrate atoms.**
   "Why did the agent give this answer?" is answerable by walking the lattice. The trace is not a string log — it's linked data over the same atoms the answer was built from. See [`src/pgsl/agent-framework.ts`](../src/pgsl/agent-framework.ts).

## The cleaner framing

Think of Context Graphs as:

> **A context layer that comes with its own reliability harness** —
> or equivalently,
> **a harness whose reliability comes from having a real substrate to reason over instead of raw prompt strings.**

If you peeled the harness off, you'd still have a useful context layer that other harnesses could wrap. If you peeled the context layer off, the harness would collapse — because the panels, the confidence scoring, the decision functor, and the PROV tracing all assume the substrate is there.

So: not "context layer **or** harness" but **"context layer + a harness that's been co-designed with it."** The co-design is the thing that's hard to reproduce by composing off-the-shelf parts.

## Evidence from the benchmark

On LongMemEval, a 500-question long-term-memory benchmark, this co-design shows up concretely:

- **Structural-first retrieval** (atom overlap, IDF, co-occurrence expansion) ranks sessions before any LLM touches them. Variance goes down because the LLM sees the right context every time.
- **Panel voting with an always-run skeptic** catches systematic errors where two experts make the same mistake (e.g., both wrongly including an adopted child when the question asks "born"). One LLM call cannot catch this; three can.
- **Entity verification as a separate step** (before any date math) reduced abstention variance from "oscillates between answer and abstain" to "deterministic". The substrate's explicit entity check is what made this possible — the harness could ask a precise structural question instead of a fuzzy one.
- **Runtime eval with confidence scoring** triggers a constrained-choice arbiter when the panel disagrees. The arbiter is bounded by the panel's actual counts — it cannot invent new numbers — which keeps the tiebreaker stable.

The headline number (86.6% raw / 89.2% adjusted on the full 500, stable 90.3% on the hardest 31-question subset) is not the interesting outcome. The interesting outcome is that **the variance went to zero** on the stable subset after these co-designed improvements were wired in. That's the signal that the harness and substrate are actually reinforcing each other, not just sitting next to each other.

## See also

- [`developer-guide.md`](developer-guide.md) — how to use the library
- [Context Graphs 1.0 spec](spec/) — the formal specification
- [`CLAUDE.md`](../CLAUDE.md) — project-level guidance for Claude Code
