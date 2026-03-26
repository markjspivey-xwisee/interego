# @foxxi/context-graphs

Reference implementation of **[Context Graphs 1.0](https://markjspivey-xwisee.github.io/context-graphs/spec/context-graphs-1.0-wd.html)** — a compositional framework for typed graph contexts over RDF 1.2 Named Graphs.

Context Graphs gives autonomous AI agents the infrastructure to publish, discover, compose, and reason over knowledge graphs with full provenance, trust, temporal validity, semiotic metadata, causal models, and cryptographic verification — federated across decentralized Solid pods.

**Author:** Mark Spivey / [Foxxi Mediums Inc.](https://foxximediums.com)
**License:** CC-BY-4.0
**W3C Community Group:** [Context Graph CG](https://www.w3.org/community/context-graph/) (launching March 2026)

---

## What It Does

Every Named Graph has context: who created it, when, under what interpretive frame, at what confidence, with what trust credential, through what causal model. Context Graphs makes that context **structured, composable, machine-readable, and cryptographically verifiable**.

An AI agent (Claude Code, Codex, OpenClaw, etc.) produces a knowledge graph. This library wraps that graph with a **Context Descriptor** declaring:

| Facet | What it captures | W3C Alignment |
|-------|-----------------|---------------|
| **Temporal** | When is this valid? | OWL-Time, Dublin Core |
| **Provenance** | Who generated it, from what? | PROV-O |
| **Agent** | Which AI agent, on behalf of which human? | PROV-O, ActivityStreams |
| **AccessControl** | Who can read/write? | WAC |
| **Semiotic** | Asserted or hypothetical? At what confidence? | Peircean triadic semiotics |
| **Trust** | Self-asserted, attested, or cryptographically verified? | VC 2.0, DID Core |
| **Federation** | Where is this stored, how does it sync? | DCAT 3, Solid Protocol |
| **Causal** | What structural causal model governs this? | Pearl's SCM framework |
| **Projection** | How does this map to other vocabularies? | SKOS, Hydra |

Two agents can then **compose** their descriptors via set-theoretic operators (union, intersection, restriction, override) forming a **bounded lattice** — merging knowledge with full provenance chains preserved.

---

## Architecture

```
@foxxi/context-graphs
├── src/
│   ├── model/        Core types, ContextDescriptor builder, composition operators,
│   │                 delegation, category theory (presheaf, naturality, lattice laws),
│   │                 semiotic formalization (Sign functor, adjunction, field functor),
│   │                 open facet registry with merge strategies
│   ├── rdf/          Namespaces (23+), Turtle/JSON-LD/TriG serializers,
│   │                 RDF 1.2 triple annotation support
│   ├── validation/   Programmatic SHACL-equivalent validator, SHACL shapes export
│   ├── sparql/       Parameterized SPARQL 1.2 query pattern builders
│   ├── solid/        publish(), discover(), subscribe(), directory, WebFinger,
│   │                 DID resolution, IPFS anchoring
│   ├── pgsl/         Poly-Granular Sequence Lattice — content-addressed substrate,
│   │                 entity/relation extraction, ontological inference, usage-based
│   │                 semantics, structural retrieval, fact extraction, computation
│   │                 (date arithmetic, counting, aggregation, abstention detection)
│   ├── affordance/   Affordance engine integrating 8 frameworks:
│   │                 Gibson, Norman, Pearl, Boyd (OODA), Endsley (SA),
│   │                 Bratman (BDI), Friston (active inference), stigmergy
│   ├── crypto/       Real cryptography — ethers.js ECDSA, NaCl E2E encryption,
│   │                 ZK proofs (Merkle, range, temporal), SIWE (ERC-4361),
│   │                 ERC-8004 agent identity, IPFS CID computation, Pinata pinning
│   └── causality     Pearl's SCM: do-calculus, d-separation, backdoor/front-door
│                     criteria, counterfactual evaluation
├── mcp-server/       MCP server (24 tools) for Claude Code / AI agents
├── deploy/           Dockerfiles, Azure Container Apps, identity server, relay
│   ├── identity/     WebID + DID + Ed25519 + WebFinger + bearer tokens + SIWE
│   ├── mcp-relay/    HTTP/REST bridge with auth, X402 payments, IPFS pinning
│   └── css-config/   Community Solid Server configuration
├── examples/         Dashboard UI + multi-agent demo
├── benchmarks/       LongMemEval (94.0%) + LoCoMo (80.0%) evaluation suites
└── tests/            264 tests across 10 suites
```

### Design Principles

- **Zero runtime dependencies for the core.** Validation is programmatic. SHACL shapes exported as Turtle strings.
- **Discriminated union pattern.** All 9+ facet types use `{ type: 'Temporal' | 'Provenance' | ... }` for exhaustive switch matching.
- **Composition is algebraic.** Four operators form a bounded lattice with category-theoretic proofs (presheaf naturality, idempotence, commutativity, associativity, absorption).
- **Semiotic foundation.** Descriptors are Peircean signs. The Sign functor phi/psi forms an adjunction between the descriptor category and the semiotic category. The Semiotic Field Functor maps to SAT.
- **PGSL substrate.** Content is canonically addressed via the Poly-Granular Sequence Lattice — deterministic, structurally shared, with categorical pullback construction.
- **Real cryptography.** No mocks. ethers.js v6 for ECDSA, tweetnacl for NaCl encryption, real IPFS CIDs, real SIWE verification.
- **Local-first.** Everything works on localhost with zero internet. Cloud deployment is additive.
- **W3C vocabulary reuse.** 23+ standard namespaces (PROV-O, OWL-Time, DCAT, WAC, VC, DID, Solid, Hydra, DPROD, SKOS, FOAF).

---

## Quick Start

```bash
git clone https://github.com/markjspivey-xwisee/context-graphs.git
cd context-graphs
npm install
npm run build
npm test  # 264 tests
```

### Build a Context Descriptor

```typescript
import { ContextDescriptor, validate, toTurtle } from '@foxxi/context-graphs';
import type { IRI } from '@foxxi/context-graphs';

const descriptor = ContextDescriptor.create('urn:cg:my-analysis:1' as IRI)
  .describes('urn:graph:project:arch-v1' as IRI)
  .temporal({ validFrom: '2026-03-20T00:00:00Z' })
  .delegatedBy(
    'https://id.example.com/alice/profile#me' as IRI,  // owner (human)
    'urn:agent:anthropic:claude-code:vscode' as IRI,    // agent (AI)
  )
  .asserted(0.92)
  .selfAsserted('did:web:alice.example' as IRI)
  .federation({
    origin: 'https://pod.example.com/alice/' as IRI,
    storageEndpoint: 'https://pod.example.com/alice/' as IRI,
    syncProtocol: 'SolidNotifications',
  })
  .version(1)
  .build();

const result = validate(descriptor);
console.log(result.conforms); // true
console.log(toTurtle(descriptor));
```

### Publish to a Solid Pod

```typescript
import { publish, discover, subscribe } from '@foxxi/context-graphs';

const result = await publish(descriptor, graphTurtle, 'https://pod.example.com/alice/');
// → { descriptorUrl, graphUrl, manifestUrl }
// → IPFS pinned (if configured): ipfs://Qm...
// → Anchor receipt written to pod: /anchors/{id}.json

const entries = await discover('https://pod.example.com/bob/', {
  facetType: 'Semiotic', validFrom: '2026-01-01T00:00:00Z',
});

const sub = await subscribe('https://pod.example.com/bob/', (event) => {
  console.log(`${event.type} on ${event.resource}`);
});
```

### Compose Descriptors

```typescript
import { union, intersection, restriction } from '@foxxi/context-graphs';

const merged = union(descriptorA, descriptorB);
const common = intersection(descriptorA, descriptorB);
const trustOnly = restriction(merged, ['Trust', 'Semiotic']);
```

---

## PGSL — Poly-Granular Sequence Lattice

The content substrate. Deterministic hierarchical data structure representing sequential data as a lattice of overlapping sub-structures with content-addressed canonical URIs.

```typescript
import { createPGSL, embedInPGSL, pgslResolve, latticeMeet } from '@foxxi/context-graphs';

const pgsl = createPGSL({ wasAttributedTo: 'did:web:alice', generatedAtTime: new Date().toISOString() });

const uriA = embedInPGSL(pgsl, 'autonomous agents share knowledge graphs');
const uriB = embedInPGSL(pgsl, 'knowledge graphs enable semantic interoperability');

const meet = latticeMeet(pgsl, uriA, uriB);
const shared = pgslResolve(pgsl, meet!); // "knowledge graphs" — structural overlap
```

PGSL provides:
- **Content-addressed atoms** — same input always produces the same URI
- **Structural sharing** — two texts sharing sub-sequences share lattice fragments
- **Lattice meet** — greatest lower bound finds the largest shared sub-sequence
- **Categorical pullback** — overlapping pair construction as a universal property
- **Entity/relation extraction** — extract structured facts from natural language
- **Ontological inference** — synonym groups, IS-A hierarchies, part-of relations
- **Usage-based semantics** — co-occurrence mining, Yoneda embedding, emergent synonyms
- **Structural computation** — date arithmetic, counting, aggregation, abstention detection

---

## Affordance Engine

Integrates 8 theoretical frameworks for autonomous agent decision-making:

| Framework | What it provides | Module |
|-----------|-----------------|--------|
| **Gibson** | Relational affordances (agent x environment) | `computeAffordances()` |
| **Norman** | Signifiers + anti-affordances | `extractSignifiers()` |
| **Pearl** | Affordances as interventional queries P(Y\|do(X)) | `CausalAffordanceEffect` |
| **Boyd (OODA)** | Observe -> Orient -> Decide -> Act with IG&C | `OODACycle` |
| **Endsley (SA)** | Perception -> Comprehension -> Projection | `SituationalAwarenessLevel` |
| **Bratman (BDI)** | Beliefs -> Desires -> Intentions | `AgentState` |
| **Friston** | Active inference, surprise evaluation | `evaluateSurprise()` |
| **Stigmergy** | Affordance landscape tracking across pods | `StigmergicField` |

```typescript
import { computeAffordances, computeCognitiveStrategy } from '@foxxi/context-graphs';

// What can this agent do with this descriptor?
const affordances = computeAffordances(agentProfile, descriptor);
// → { affordances: [...], antiAffordances: [...], signifiers: [...], saLevel: {...} }

// What cognitive strategy should answer this question?
const strategy = computeCognitiveStrategy('How many days between X and Y?');
// → { strategy: 'temporal-twopass', computationType: 'date-arithmetic', ... }
```

---

## Causality — Pearl's SCM Framework

```typescript
import { buildSCM, doIntervention, isDSeparated, evaluateCounterfactual } from '@foxxi/context-graphs';

const scm = buildSCM({
  variables: [{ name: 'X' }, { name: 'Y' }, { name: 'Z' }],
  edges: [{ from: 'X', to: 'Y' }, { from: 'Y', to: 'Z' }],
});

const mutilated = doIntervention(scm, { variable: 'Y', value: '1' });
const separated = isDSeparated(scm, 'X', 'Z', new Set(['Y'])); // true
const counterfactual = evaluateCounterfactual(scm, {
  intervention: { variable: 'X', value: '0' },
  outcome: 'Z',
  evidence: { Y: '1' },
});
```

---

## Cryptography

All real. No mocks.

### E2E Encryption (NaCl)

```typescript
import { generateKeyPair, createEncryptedEnvelope, openEncryptedEnvelope } from '@foxxi/context-graphs';

const owner = generateKeyPair();  // X25519
const agent = generateKeyPair();
const envelope = createEncryptedEnvelope(turtleContent, [agent.publicKey, owner.publicKey], owner);
const decrypted = openEncryptedEnvelope(envelope, agent); // only authorized agents can read
```

### Zero-Knowledge Proofs

```typescript
import { proveConfidenceAboveThreshold, proveDelegationMembership, proveTemporalOrdering } from '@foxxi/context-graphs';

// Prove confidence > 0.8 without revealing exact value
const { proof } = proveConfidenceAboveThreshold(0.95, 0.8);

// Prove "I'm in the authorized agent set" without revealing which agent
const membershipProof = proveDelegationMembership(myAgentId, authorizedAgents);

// Prove "published before time T" without revealing exact time
const temporalProof = proveTemporalOrdering(myTimestamp, deadline);
```

### Wallets & SIWE

```typescript
import { createWallet, createDelegation, signDescriptor, verifySiweSignature } from '@foxxi/context-graphs';

const humanWallet = await createWallet('human', 'Alice');  // real secp256k1
const agentWallet = await createWallet('agent', 'Claude');
const delegation = await createDelegation(humanWallet, agentWallet, 'ReadWrite'); // EIP-712
const signed = await signDescriptor(descriptorId, turtle, agentWallet); // real ECDSA
```

### IPFS Pinning

```typescript
import { pinDescriptor, computeCid } from '@foxxi/context-graphs';

const cid = computeCid(turtleContent);  // real SHA-256 CID
const anchor = await pinDescriptor(descriptorId, turtle, { provider: 'pinata', apiKey: '...' });
// → pinned to IPFS, dereferenceable globally
```

---

## MCP Server — 24 Tools for AI Agents

### Setup

Add to `.mcp.json` (VS Code) or `claude_desktop_config.json` (Desktop):

```json
{
  "mcpServers": {
    "context-graphs": {
      "command": "cmd",
      "args": ["/c", "npx", "tsx", "path/to/context-graphs/mcp-server/server.ts"],
      "env": {
        "CG_POD_NAME": "your-name",
        "CG_AGENT_ID": "urn:agent:anthropic:claude-code:vscode",
        "CG_OWNER_WEBID": "https://your-identity-server/users/you/profile#me",
        "CG_OWNER_NAME": "Your Name",
        "CG_BASE_URL": "https://your-css-instance/"
      }
    }
  }
}
```

Auto-onboarding: first tool call provisions pod + registry + credential automatically.

### Tool Categories

**Core (6):** `publish_context`, `discover_context`, `get_descriptor`, `subscribe_to_pod`, `get_pod_status`, `analyze_question`

**Delegation (3):** `register_agent`, `revoke_agent`, `verify_agent`

**Federation (8):** `discover_all`, `subscribe_all`, `list_known_pods`, `add_pod`, `remove_pod`, `discover_directory`, `publish_directory`, `resolve_webfinger`

**Identity (2):** `setup_identity`, `link_wallet`

**PGSL (5):** `pgsl_ingest`, `pgsl_resolve`, `pgsl_lattice_status`, `pgsl_meet`, `pgsl_to_turtle`

### Progressive Tiers

Set `CG_TOOL_TIER` to control which tools are exposed:

| Tier | Tools | For |
|------|-------|-----|
| `core` | 6 | New users learning the basics |
| `standard` | 17 | Teams federating across pods |
| `full` | 19 | Users with crypto/wallet integration |
| `all` (default) | 24 | Power users, researchers |

---

## Identity & Delegation

The pod belongs to the **owner** (human/org). Agents are **delegates**.

```
Owner (human)
├── WebID: https://identity-server/users/alice/profile#me
├── DID: did:web:identity-server:users:alice
├── Pod: https://css-server/alice/
├── Authorized agents:
│   ├── claude-code-vscode  [ReadWrite]
│   ├── claude-desktop      [ReadWrite]
│   └── codex-cli           [DiscoverOnly]
└── Delegation credentials: /alice/credentials/*.jsonld (VC format)
```

Supports: WebID, DID (did:web), W3C Verifiable Credentials, Open Badges 3.0, IEEE LERS, SIWE (ERC-4361), ERC-8004 agent identity tokens, Universal Wallet.

---

## Federation — Three Discovery Approaches

1. **Known Pods** — `CG_KNOWN_PODS` env var
2. **Pod Directory Graphs** — decentralized RDF registries
3. **WebFinger** — RFC 7033 DNS-rooted discovery (same as ActivityPub)

---

## Benchmarks

| Benchmark | Score | Method | LLM Calls | Cost |
|-----------|-------|--------|-----------|------|
| **LongMemEval** | **94.0%** (500q) | Affordance-routed strategies + structural computation | ~2/question | $0 (subscription) |
| **LoCoMo** | **80.0%** (50q) | PGSL KG + structural + LLM | ~1/question | $0 (subscription) |
| Supermemory (production) | 85.2% | Vector embeddings + reranking | Unknown | Paid |
| Supermemory (ASMR experimental) | ~99% | 18+ LLM calls/question | 19/question | ~$10/run |

Our 94.0% uses ~2 LLM calls/question vs their ~19. The structural layer (PGSL, entity extraction, ontological inference, computation) handles retrieval and arithmetic. The LLM handles comprehension.

---

## Deployment

### Local (zero internet)

```bash
# Just works — auto-starts Community Solid Server
CG_BASE_URL=http://localhost:3456/ npx tsx mcp-server/server.ts
```

### Azure Container Apps

```bash
cd deploy && bash azure-deploy.sh
```

Deploys: CSS (Solid server), Dashboard (observation UI), MCP Relay (HTTP bridge), Identity Server (WebID + DID + SIWE).

---

## Development

```bash
npm install
npm run build        # TypeScript → dist/
npm test             # 264 tests across 10 suites
npm run test:watch   # Watch mode
```

### Test Suites

| Suite | Tests | Coverage |
|---|---|---|
| `context-graphs.test.ts` | 44 | Builder, composition, validation, serialization |
| `solid.test.ts` | 20 | Publish, discover, subscribe, agent registry |
| `federation.test.ts` | 21 | Pod directory, multi-pod, WebFinger, Hydra |
| `causality.test.ts` | 38 | SCM, do-calculus, d-separation, counterfactual |
| `pgsl.test.ts` | 31 | Lattice, category, geometric morphism |
| `projection.test.ts` | 15 | Vocabulary mapping, binding strength |
| `affordance.test.ts` | 23 | Gibson, Norman, OODA, BDI, Friston, stigmergy |
| `crypto.test.ts` | 25 | Wallets, ECDSA, delegation, SIWE |
| `encryption-zk.test.ts` | 30 | NaCl encryption, ZK proofs, selective disclosure |
| (additional) | 17 | Category theory, semiotic functor |

---

## Related Projects

Part of the Foxxi Mediums knowledge infrastructure:

- **[@foxxi/hela-store](https://github.com/foxximediums/hela-store)** — HELA's topos-theoretic xAPI stack (presheaf category E = Set^(C_xAPI^op))
- **SAT (Semiotic Agent Topos)** — The Semiotic Facet maps directly to SAT's Semiotic Field Functor (Sigma)
- **PGSL (Poly-Granular Sequence Lattice)** — Abstract data type for canonical sequence addressing

---

## Spec Compliance

Implements the [Context Graphs 1.0 Working Draft](https://markjspivey-xwisee.github.io/context-graphs/spec/context-graphs-1.0-wd.html):

- Section 3.1: Context Descriptor structure
- Section 3.4: Composition operators forming a bounded lattice
- Section 3.5: Triple-level inheritance via `effectiveContext()`
- Section 5: All facet types with W3C vocabulary alignment
- Section 6: Serialization (Turtle, JSON-LD, TriG)
- Section 7: SPARQL 1.2 query patterns

Extensions beyond the spec: PGSL substrate, Pearl causality, affordance engine, E2E encryption, ZK proofs, IPFS anchoring, structural computation, cognitive strategy routing.
