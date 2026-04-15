# Interego Developer Guide

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- npm

### Installation

```bash
git clone https://github.com/markjspivey-xwisee/interego.git
cd context-graphs
npm install
npm run build
npm test
```

### Running the Server

Start the PGSL browser server (which includes the Observatory and all APIs):

```bash
npx tsx examples/pgsl-browser/server.ts
```

By default the server starts on port 5000. Configure via environment variables:

```bash
PORT=5000 CLEAN=1 npx tsx examples/pgsl-browser/server.ts
```

| Variable       | Default                          | Description                              |
|----------------|----------------------------------|------------------------------------------|
| `PORT`         | `5000`                           | Server port                              |
| `CSS_URL`      | `http://localhost:3456/`         | Community Solid Server URL               |
| `POD_NAME`     | `markj`                          | Default pod name                         |
| `CLEAN`        | `0`                              | `1` = start with empty lattice           |
| `KNOWN_PODS`   | (empty)                          | Comma-separated pod URLs to discover     |

### Key URLs

| URL                          | Purpose                                    |
|------------------------------|-------------------------------------------|
| `http://localhost:5000/`     | PGSL Lattice Browser (node explorer)       |
| `http://localhost:5000/observatory` | Observatory (federation, SPARQL, demo) |
| `http://localhost:5000/ontology`    | System ontology (Turtle)               |
| `http://localhost:5000/ontology/shacl` | SHACL shape definitions            |
| `http://localhost:5000/api-doc`     | Hydra API documentation                |
| `http://localhost:5000/catalog`     | DCAT data catalog                      |
| `http://localhost:5000/dump.ttl`    | Full RDF dump (Turtle)                 |
| `http://localhost:5000/dump.jsonld` | Full RDF dump (JSON-LD)               |
| `http://localhost:5000/sparql`      | SPARQL Protocol endpoint               |


## Core Concepts

### Atoms

Atoms are the ground-level units of meaning, content-addressed by short, human-readable names. Each atom gets a deterministic URN based on its value:

```typescript
import { createPGSL, mintAtom, pgslResolve } from '@interego/core';

const pgsl = createPGSL({
  wasAttributedTo: 'urn:agent:my-agent',
  generatedAtTime: new Date().toISOString(),
});

// Mint an atom — returns a URN like urn:pgsl:sha256:abc123
const uri = mintAtom(pgsl, 'instrument-approach');
console.log(pgslResolve(pgsl, uri)); // "instrument-approach"
```

Atoms are level-0 nodes. They are content-addressed: the same string always produces the same atom URI.

### Chains

Chains are typed relationships between atoms (or other fragments). They represent syntagmatic structure — the sequential ordering of signs in context:

```typescript
import { embedInPGSL } from '@interego/core';

// Embed a natural-language statement; the system tokenizes and creates
// atoms + a fragment chain automatically
const fragUri = embedInPGSL(pgsl, 'Chen completed ILS-approach');
```

Under the hood, this creates atoms for each token and a level-1 fragment that chains them together.

### Fragments

Fragments are composed chains at higher levels of the lattice. A level-1 fragment chains atoms; a level-2 fragment chains level-1 fragments, and so on. This recursive composition is the core structural principle:

```typescript
import { ingest, latticeStats } from '@interego/core';

// Ingest multiple statements — the lattice automatically builds
// higher-level fragments where structural overlap occurs
ingest(pgsl, [
  'Chen completed ILS-approach with score 92',
  'Park completed ILS-approach with score 85',
  'Ortiz completed ILS-approach with score 94',
]);

const stats = latticeStats(pgsl);
console.log(stats);
// { atoms: 15, fragments: 12, maxLevel: 2, totalNodes: 27 }
```

### Paradigm Sets

A paradigm set P(S, i) is the set of atoms (or fragments) that can fill position i in chains matching pattern S. Paradigms are **live queries** computed from actual usage, not static declarations:

```typescript
// Via the API:
// POST /api/paradigm
// { "pattern": ["?", "completed", "ILS-approach"], "position": 0 }
//
// Returns: { "paradigm": ["Chen", "Park", "Ortiz"] }
//
// These are the atoms that actually appear in position 0
// of chains matching [?, "completed", "ILS-approach"]
```

Paradigm constraints relate two paradigm sets via algebraic operations:

| Operation   | Symbol | Meaning                                           |
|-------------|--------|---------------------------------------------------|
| `subset`    | `⊆`    | P(A,i) must be a subset of P(B,j)                 |
| `intersect` | `∩`    | Must appear in both P(A,i) AND P(B,j)             |
| `union`     | `∪`    | Can appear in either P(A,i) OR P(B,j)             |
| `exclude`   | `∖`    | Must be in P(A,i) but NOT in P(B,j)               |
| `equal`     | `=`    | P(A,i) must equal P(B,j)                          |

### Context Descriptors

Context Descriptors annotate Named Graphs with 9 typed facets. Every piece of knowledge gets rich metadata:

```typescript
import { ContextDescriptor, validate, toTurtle } from '@interego/core';

const desc = ContextDescriptor.create('urn:cg:my-context')
.describes('urn:graph:observations-2026-Q1')
.temporal({
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: '2026-03-31T23:59:59Z',
  })
.asserted(0.95)
.selfAsserted('did:web:identity.example.com')
.build();

const result = validate(desc);
console.log(result.conforms); // true
console.log(toTurtle(desc));
```

The 9 facet types:

| Facet           | Purpose                                     |
|-----------------|---------------------------------------------|
| Temporal        | Valid-from / valid-until time range          |
| Provenance      | Who created it, when, how                    |
| Agent           | Which agent produced or attested             |
| Semiotic        | Modal status, epistemic confidence           |
| Trust           | SelfAsserted / ThirdPartyAttested / CryptographicallyVerified |
| AccessControl   | Who can read/write/administer                |
| Federation      | Pod origin, sync status, CRDT metadata       |
| Causal          | SCM links, counterfactual evaluation         |
| Structural      | PGSL lattice position, containment           |

### Composition

Context Descriptors compose algebraically via four operators that form a bounded lattice:

```typescript
import { union, intersection, restriction, override } from '@interego/core';

// Union: merge two descriptors (widest temporal range, highest trust, etc.)
const merged = union(descA, descB);

// Intersection: common ground between descriptors
const common = intersection(descA, descB);

// Restriction: A filtered through B's constraints
const restricted = restriction(descA, descB);

// Override: B's facets take precedence over A's
const overridden = override(descA, descB);
```


## Building an Agent

Interego uses Agent Accountability Types (AATs) to control what agents can do. Here is the full lifecycle.

### 1. Choose an AAT

Built-in AATs define capability profiles:

| AAT        | Capabilities                                    |
|------------|------------------------------------------------|
| Observer   | Read lattice, query, discover                   |
| Analyst    | Observer + compose, constrain, coherence        |
| Executor   | Analyst + ingest, publish, write                |
| Arbiter    | Executor + verify, delegate, policy decisions   |
| Archivist  | Executor + checkpoint, restore, freeze          |
| FullAccess | Everything                                      |

### 2. Register with Identity Server

```typescript
import {
  createAATRegistry, registerAAT, ObserverAAT, AnalystAAT,
  validateAction
} from '@interego/core';

const registry = createAATRegistry();
registerAAT(registry, ObserverAAT);
registerAAT(registry, AnalystAAT);

// Validate an action against an AAT
const allowed = validateAction(registry, 'aat:observer', 'ingest');
console.log(allowed); // false — observers can't ingest
```

### 3. Create a Pod

Pods are Solid-compatible containers. Each pod stores context descriptors, graphs, and manifests:

```typescript
// Via API:
// POST /api/pods/add
// { "url": "http://localhost:3456/my-agent/" }
```

### 4. Create an Enclave

Enclaves are isolated workspaces for tentative operations. An agent can fork an enclave, work in isolation, then merge or abandon:

```typescript
// POST /api/enclaves
// { "agentId": "analyst-1", "agentDid": "did:web:analyst.example.com" }
//
// Response: { "id": "enc:1234", "agentId": "analyst-1", "status": "active" }
```

### 5. Ingest Knowledge

Feed content into the PGSL lattice. The system tokenizes, builds atoms, chains, and fragments:

```typescript
// POST /api/ingest
// { "text": "Chen completed ILS approach with score 92" }
//
// Or use ingestion profiles for structured data:
// POST /api/chain
// {
//   "profile": "xapi",
//   "data": {
//     "actor": { "name": "Chen" },
//     "verb": { "id": "http://adlnet.gov/xapi/completed" },
//     "object": { "id": "ils-approach", "definition": { "name": "ILS Approach" } },
//     "result": { "score": { "scaled": 0.92 }, "success": true }
//   }
// }
```

### 6. Publish to Pod

Write context-annotated knowledge to a Solid pod:

```typescript
import { publish, ContextDescriptor, toTurtle } from '@interego/core';

const desc = ContextDescriptor.create('urn:cg:obs-1')
.describes('urn:graph:chen-training')
.temporal({ validFrom: '2026-03-15T00:00:00Z' })
.asserted(0.92)
.selfAsserted('did:web:lrs.example.com')
.build();

const turtle = toTurtle(desc);

await publish(
  'http://localhost:3456/markj/',
  desc,
  '<urn:graph:chen-training> { <urn:chen> <urn:completed> <urn:ils-approach>. }',
  { fetch: authenticatedFetch }
);
```

### 7. Discover Others

Discover descriptors across the federation:

```typescript
import { discover } from '@interego/core';

const entries = await discover('http://localhost:3456/other-pod/', undefined, {
  fetch: solidFetch,
});

for (const entry of entries) {
  console.log(entry.describes, entry.facetTypes);
}
```

### 8. Verify Coherence

Usage-based coherence checks whether two agents use shared signs in compatible ways. The dangerous state is **unexamined** — agents proceeding as if aligned without verification:

```typescript
// POST /api/coherence/check
// {}
//
// Response:
// {
//   "coverage": {
//     "coverage": 0.85,
//     "verified": 3,
//     "divergent": 1,
//     "unexamined": 0,
//     "totalPairs": 4
//   },
//   "certificates": [
//     {
//       "agentA": "LRS", "agentB": "Competency",
//       "status": "verified",
//       "semanticOverlap": 0.82,
//       "sharedPatterns": 12
//     }
//   ]
// }
```

### 9. Make Decisions

The decision functor implements an OODA loop (Observe, Orient, Decide, Act):

```typescript
// POST /api/decisions
// {}
//
// Response:
// {
//   "agents": [
//     {
//       "agent": "Analyst",
//       "strategy": "exploit",
//       "observations": { "atomCount": 45, "patternCount": 12 },
//       "affordanceCount": 8,
//       "coverage": 85,
//       "decisions": [
//         {
//           "type": "recommend",
//           "confidence": 0.91,
//           "description": "Additional training on emergency procedures"
//         }
//       ]
//     }
//   ]
// }
```


## API Reference

### HATEOAS Node API

Every node is a self-descriptive hypermedia resource. The API follows REST/HATEOAS conventions — each response includes links to related resources and available controls.

```
GET /api/node/{uri}
```

Returns:
- Identity: URI, resolved name, kind (Atom/Fragment), level
- Structure: items, left/right constituents (for fragments)
- Context: containers (what contains this node)
- Paradigm: source options (what comes before), target options (what comes after), active constraints
- Controls: available HATEOAS operations (links + methods)
- Suggestions: decorator-generated structural suggestions

```
GET /api/all
```

Returns all nodes in the lattice with resolved names and levels.

```
GET /api/stats
```

Returns: `{ atoms, fragments, maxLevel, totalNodes }`

```
GET /api/resolve-hash/{hash}
```

Resolve a content hash to its node URI and value.

### Chain API

```
POST /api/chain
```

Create a chain (fragment) from existing atoms or ingestion profile data:

```json
{
  "items": ["atom-value-1", "atom-value-2", "atom-value-3"]
}
```

Or with an ingestion profile:

```json
{
  "profile": "xapi",
  "data": { "actor": {}, "verb": {}, "object": {}, "result": {} }
}
```

```
POST /api/ingest
```

Ingest free text into the lattice:

```json
{ "text": "Chen completed ILS approach with score 92" }
```

```
POST /api/ingest-uris
```

Ingest raw URIs directly into the lattice.

```
POST /api/meet
```

Find structural overlap (lattice meet) between two nodes.

```
POST /api/focus
```

Focus the lattice on a specific node and its neighborhood.

### SPARQL Protocol

Standard W3C SPARQL Protocol endpoint:

```
GET  /sparql?query=SELECT+...
POST /sparql  (Content-Type: application/sparql-query)
POST /sparql/update  (Content-Type: application/sparql-update)
```

Also available as a JSON API:

```
POST /api/sparql
{ "query": "PREFIX pgsl: <https://...> SELECT ?atom ?value WHERE { ?atom a pgsl:Atom ; pgsl:value ?value. } LIMIT 20" }
```

Response:

```json
{
  "type": "SELECT",
  "count": 20,
  "bindings": [
    { "atom": "urn:pgsl:sha256:abc", "value": "instrument-approach" }
  ]
}
```

### Marketplace

```
GET  /api/marketplace              — List all marketplace listings with stats
POST /api/marketplace              — Register a new agent/service listing
GET  /api/marketplace/discover?type=agent&capabilities=ingest,analyze
GET  /api/marketplace/hydra        — Hydra API description (Turtle)
```

Register a listing:

```json
{
  "name": "xAPI Ingestion Agent",
  "type": "agent",
  "description": "Ingests xAPI statements into the PGSL lattice",
  "provider": "did:web:lrs.example.com",
  "trustLevel": "ThirdPartyAttested",
  "capabilities": ["ingest", "xapi", "transform"]
}
```

### Enclaves & Checkpoints

Enclaves provide isolated workspaces:

```
POST /api/enclaves                 — Create enclave
GET  /api/enclaves                 — List all enclaves
POST /api/enclaves/:id/freeze      — Freeze an enclave (immutable snapshot)
POST /api/enclaves/:id/merge       — Merge enclave back (union/intersection/override)
```

Checkpoints capture lattice state for rollback:

```
POST /api/checkpoints              — Create checkpoint
GET  /api/checkpoints              — List checkpoints
```

Create a checkpoint:

```json
{ "label": "pre-ingestion-v2", "enclaveId": "enc:1234" }
```

Response:

```json
{
  "id": "cp:5678",
  "atomCount": 45,
  "fragmentCount": 32,
  "contentHash": "sha256:abc123..."
}
```

### PROV Traces

Every action is recorded as a W3C PROV-O trace:

```
GET  /api/traces                   — List all traces (filter: ?agent=X&activity=Y)
GET  /api/traces/turtle            — Export all traces as Turtle
```

Response:

```json
{
  "traces": [
    {
      "id": "urn:prov:trace:1234",
      "activity": "ingest",
      "agent": "LRS",
      "agentAAT": "aat:executor",
      "entity": "urn:pgsl:sha256:abc",
      "startedAt": "2026-03-15T14:30:00Z",
      "success": true
    }
  ],
  "total": 42
}
```

### Ontology & Dumps

```
GET /ontology                      — System ontology (Turtle)
GET /ontology/shacl                — SHACL shape definitions (Turtle)
GET /api-doc                       — Hydra API documentation (JSON-LD)
GET /catalog                       — DCAT data catalog (Turtle)
GET /dump.ttl                      — Full RDF dump (Turtle)
GET /dump.jsonld                   — Full RDF dump (JSON-LD)
```

### Paradigm Constraints

```
POST   /api/constraints            — Create a paradigm constraint
GET    /api/constraints            — List all constraints
DELETE /api/constraints/:id        — Remove a constraint
POST   /api/paradigm               — Compute a paradigm set
POST   /api/constraints/candidates — Suggest constraint candidates
POST   /api/constraints/shacl      — Import SHACL shapes as constraints
GET    /api/constraints/shacl      — Export constraints as SHACL Turtle
```

### Coherence & Decisions

```
POST /api/coherence/check          — Run coherence verification across agents
POST /api/decisions                — Run OODA decision functor for all agents
```

### AAT & Policy

```
GET  /api/aat                      — List registered Agent Accountability Types
POST /api/aat/validate             — Validate an action against an AAT
GET  /api/policy                   — List policy rules
POST /api/policy                   — Add a policy rule
```

### Metagraph (Self-Reference)

```
GET  /api/metagraph                — Generate metagraph (lattice describing itself)
POST /api/metagraph/ingest         — Ingest metagraph into the lattice
GET  /api/metagraph/validate       — Validate metagraph consistency
POST /api/metagraph/query          — Query metagraph with natural language
```

### SHACL Validation

```
GET /api/shacl                     — Run 3-layer SHACL validation
```

Returns:

```json
{
  "conforms": true,
  "violationCount": 0,
  "violations": []
}
```

Or on failure:

```json
{
  "conforms": false,
  "violationCount": 2,
  "violations": [
    {
      "shape": "AtomMustHaveValue",
      "path": "pgsl:value",
      "message": "Every Atom must have exactly one value",
      "node": "urn:pgsl:sha256:abc",
      "severity": "violation"
    }
  ]
}
```


## Ingestion Profiles

### xAPI (Native)

The built-in xAPI ingestion profile transforms xAPI statements into PGSL chains. Each statement becomes a multi-atom chain with actor, verb, object, result, and timestamp:

```typescript
import { ingestWithProfile, getProfile } from '@interego/core';

const xapiStatement = {
  actor: { name: 'Chen', mbox: 'mailto:chen@example.com' },
  verb: { id: 'http://adlnet.gov/xapi/completed', display: { 'en-US': 'completed' } },
  object: {
    id: 'http://example.com/activities/ils-approach',
    definition: { name: { 'en-US': 'ILS Approach Rwy 28L' } },
  },
  result: {
    score: { scaled: 0.92, raw: 92, max: 100 },
    success: true,
    duration: 'PT45M',
  },
  timestamp: '2026-03-15T14:30:00Z',
};

const profile = getProfile('xapi');
const chains = ingestWithProfile(pgsl, 'xapi', xapiStatement);
```

Via the API:

```
POST /api/chain
{
  "profile": "xapi",
  "data": {... xAPI statement... }
}
```

### Custom Profiles

Create custom ingestion profiles by defining a transform function that maps domain data to PGSL chain items:

```typescript
// A profile is a transform: domain data -> array of string values
// Each value becomes an atom, and the array becomes a chain
const myProfile = {
  name: 'security-finding',
  transform: (data: any) => [
    data.scanner,          // atom: scanner name
    data.severity,         // atom: severity level
    data.cve,              // atom: CVE identifier
    data.host,             // atom: affected host
    data.status,           // atom: finding status
  ],
};
```


## Decorators

### Built-in Decorators

Decorators provide structural suggestions when exploring nodes. They analyze a node's lattice position and propose additional structure. The default registry includes decorators for:

- **Symmetry**: suggests inverse relationships (if A->B exists, propose B->A)
- **Transitivity**: suggests transitive closure chains
- **Temporal**: suggests temporal ordering relationships
- **Competency**: suggests skill/competency relationships based on domain patterns

Decorators are applied automatically when exploring nodes via `/api/node/{uri}`. Suggestions appear in the `_suggestions` array:

```json
{
  "uri": "urn:pgsl:sha256:abc",
  "resolved": "Chen",
  "_suggestions": [
    {
      "type": "competency",
      "description": "Link to competency framework",
      "proposed": "Chen -> demonstrates -> instrument-approach",
      "rationale": "Multiple successful completions indicate demonstrated competency"
    }
  ]
}
```

### Writing a Custom Decorator

```typescript
import { createDefaultRegistry, decorateNode } from '@interego/core';

const registry = createDefaultRegistry();

// Add a custom decorator
registry.register({
  name: 'compliance-check',
  applies: (node, pgsl) => {
    // Only apply to nodes that look like regulatory items
    return node.kind === 'Atom' && node.value.toString().includes('regulation');
  },
  suggest: (node, pgsl) => {
    return [{
      type: 'compliance',
      description: 'Check regulatory compliance status',
      proposed: `${node.value} -> compliant-with -> current-framework`,
      rationale: 'Regulatory atoms should be linked to compliance frameworks',
    }];
  },
});

// Apply decorators to a node
const suggestions = decorateNode(registry, pgsl, nodeUri);
```


## Federation

### Solid Pods

Interego uses Solid (Social Linked Data) pods as the persistence and identity layer. Each agent has a pod that stores:

- **Context Descriptors** (`.ttl` files): typed metadata about knowledge
- **Graph content** (`.trig` files): the actual RDF knowledge graphs
- **Manifests**: indexes of all descriptors on the pod

```typescript
import { discover, publish } from '@interego/core';

// Discover all descriptors on a pod
const entries = await discover('http://localhost:3456/alice/');

// Publish new knowledge to a pod
await publish('http://localhost:3456/alice/', descriptor, graphContent);
```

### Cross-pod Discovery

The Observatory's Federation tab shows all discovered pods. Add pods manually or programmatically:

```
POST /api/pods/add
{ "url": "http://localhost:3456/other-agent/" }
```

Discover descriptors from a specific pod:

```
POST /api/pods/discover
{ "url": "http://localhost:3456/other-agent/" }
```

The system crawls each pod's manifest, fetches descriptors, and makes them available for composition, coherence checking, and SPARQL queries.

### CRDT Sync

Federation metadata on Context Descriptors tracks sync state. The composition operators (union, intersection, restriction, override) handle merge conflicts deterministically:

- **Union**: widest temporal range, highest trust, all access grants
- **Intersection**: overlapping temporal range, minimum trust, shared access
- **Restriction**: A's data filtered through B's constraints
- **Override**: B's facets replace A's (last-writer-wins)

These operators form a bounded lattice with well-defined merge semantics per facet type.


## Examples

### Security Audit (3 Agents)

A multi-agent security audit where Scanner, Analyst, and Lead collaborate:

```typescript
import { createPGSL, ingest, embedInPGSL } from '@interego/core';

// Agent 1: Scanner — ingests raw findings
const pgsl = createPGSL({
  wasAttributedTo: 'urn:agent:scanner',
  generatedAtTime: new Date().toISOString(),
});

ingest(pgsl, [
  'scanner found CVE-2026-1234 on host web-server-1 severity critical',
  'scanner found CVE-2026-5678 on host db-server-2 severity high',
  'scanner found CVE-2026-9012 on host web-server-1 severity medium',
]);

// Agent 2: Analyst — adds context and assessment
ingest(pgsl, [
  'analyst assessed CVE-2026-1234 exploitable true remediation patch-available',
  'analyst assessed CVE-2026-5678 exploitable false remediation workaround',
]);

// Agent 3: Lead — makes decisions
// POST /api/decisions to run the OODA functor
// The lead agent sees all observations, checks coherence with
// scanner and analyst, then decides on remediation priority.
```

### TLA Pipeline (Flight Training)

The Observatory includes a complete 7-phase Total Learning Architecture demo:

1. **Setup**: Register pods for LRS, Competency, and Credential agents
2. **xAPI Ingest**: Ingest xAPI flight training statements for 3 learners
3. **Competency**: Map learning records to competency frameworks
4. **Credentials**: Issue verifiable credentials based on competency
5. **Discovery**: Cross-pod discovery of all agent knowledge
6. **Verify**: Cryptographic verification of credential chains
7. **Coherence & Decisions**: Check inter-agent coherence + run OODA decisions

Run it from the Observatory UI or programmatically:

```
POST /api/demo/run    — Advance to next phase
POST /api/demo/reset  — Reset to phase 0
```

### Self-Referential Knowledge Base

The metagraph feature allows the lattice to describe itself:

```typescript
// Generate a metagraph — the lattice creates atoms describing
// its own structure (atom count, fragment count, level distribution)
// GET /api/metagraph

// Ingest the metagraph back into the lattice — now the lattice
// contains knowledge about its own structure
// POST /api/metagraph/ingest

// Validate consistency — does the metagraph accurately describe
// the lattice (including itself)?
// GET /api/metagraph/validate

// Query the metagraph in natural language
// POST /api/metagraph/query
// { "question": "How many atoms does the lattice contain?" }
```

This creates a fixed-point: the lattice containing accurate descriptions of itself, including the meta-atoms that describe the lattice.


## SDK Quick Start

For programmatic access, use the high-level SDK:

```typescript
import { ContextGraphsSDK } from '@interego/core';

const cg = new ContextGraphsSDK({
  podUrl: 'http://localhost:3456/alice/',
  token: 'cg_your_token_here',
  agentId: 'urn:agent:my-app',
});

// Publish context-annotated knowledge
await cg.publish('urn:graph:my-data', turtleContent, {
  confidence: 0.95,
  task: 'Security assessment Q1 2026',
});

// Discover all descriptors on a pod
const entries = await cg.discover();

// Ingest into the local PGSL lattice
cg.ingest('New finding: CVE-2026-1234 affects web-server-1');

// Find structural overlap between two fragments
const overlap = cg.meet(fragmentA, fragmentB);
```


## Troubleshooting

### Common Issues

**Empty lattice on startup**: Set `CLEAN=1` to start fresh, or ensure a Community Solid Server is running at `CSS_URL`.

**SPARQL returns no results**: The triple store materializes from the PGSL lattice. Ingest content first, then query.

**Pod unreachable**: Check that the Solid server is running and the pod URL is correct. The Observatory Federation tab shows pod status.

**SHACL violations**: Run `GET /api/shacl` to see validation details. Three layers are checked: Core (node constraints), Structural (lattice invariants), and Domain (custom shapes).

### Useful Commands

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build TypeScript
npm run build

# Watch mode (auto-rebuild on change)
npm run watch

# Clean build artifacts
npm run clean
```
