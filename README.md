# @foxxi/context-graphs

Reference implementation of **[Context Graphs 1.0](https://markjspivey-xwisee.github.io/context-graphs/spec/context-graphs-1.0-wd.html)** — a compositional framework for typed graph contexts over RDF 1.2 Named Graphs.

Context Graphs lets AI coding agents publish, discover, and compose knowledge graphs with full provenance, trust, temporal validity, and semiotic metadata — federated across decentralized Solid pods.

**Author:** Mark Spivey / [Foxxi Mediums Inc.](https://foxximediums.com)
**License:** CC-BY-4.0

---

## What It Does

Every Named Graph has context: who created it, when, under what interpretive frame, at what confidence, with what trust credential. Context Graphs makes that context **structured, composable, and machine-readable**.

An AI agent (Claude Code, Codex, etc.) analyzes your codebase and produces a knowledge graph. This library wraps that graph with a **Context Descriptor** declaring:

- **Temporal** — when is this valid? (OWL-Time, Dublin Core)
- **Provenance** — who generated it, from what? (PROV-O)
- **Agent** — which AI agent, on behalf of which human? (PROV-O, ActivityStreams)
- **Access Control** — who can read/write? (WAC)
- **Semiotic** — is this asserted or hypothetical? at what confidence? (Peircean triadic semiotics)
- **Trust** — self-asserted, third-party attested, or cryptographically verified? (VC 2.0, DID Core)
- **Federation** — where is this stored, how does it sync? (DCAT 3, Solid Protocol)

Two agents can then **compose** their descriptors via set-theoretic operators (union, intersection, restriction, override) to merge knowledge with full provenance chains preserved.

---

## Architecture

```
@foxxi/context-graphs
├── src/
│   ├── model/        Core types, ContextDescriptor builder, composition operators, delegation
│   ├── rdf/          Namespaces (20+), Turtle serializer, JSON-LD serializer/parser
│   ├── validation/   Programmatic SHACL-equivalent validator, SHACL shapes export
│   ├── sparql/       Parameterized SPARQL 1.2 query pattern builders
│   └── solid/        publish(), discover(), subscribe(), directory, WebFinger
├── mcp-server/       MCP server (16 tools) for Claude Code / AI agents
├── deploy/           Dockerfiles + Azure Container Apps deployment
├── examples/         Dashboard UI + multi-agent demo
└── tests/            85 tests across 3 suites
```

### Design Principles

- **Zero runtime dependencies.** Validation is programmatic — no SHACL engine required. SHACL shapes are exported as Turtle strings for external engines.
- **Discriminated union pattern.** All seven facet types use `{ type: 'Temporal' | 'Provenance' | ... }` for exhaustive switch matching.
- **Composition is algebraic.** The four operators form a bounded lattice. Each facet type defines its own merge semantics per the spec's §3.4.
- **W3C vocabulary reuse.** 20+ standard namespaces (PROV-O, OWL-Time, DCAT, WAC, VC, DID, Solid, Hydra, DPROD). Every class IRI and property IRI is typed and exported.

---

## Installation

```bash
npm install @foxxi/context-graphs
```

Requires Node.js ≥ 20.0.0. Zero runtime dependencies.

---

## Quick Start

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
  .semiotic({
    modalStatus: 'Asserted',
    epistemicConfidence: 0.92,
    groundTruth: true,
  })
  .trust({
    trustLevel: 'SelfAsserted',
    issuer: 'https://id.example.com/alice/profile#me' as IRI,
  })
  .federation({
    origin: 'https://pod.example.com/alice/' as IRI,
    storageEndpoint: 'https://pod.example.com/alice/' as IRI,
    syncProtocol: 'SolidNotifications',
  })
  .version(1)
  .build();

// Validate
const result = validate(descriptor);
console.log(result.conforms); // true

// Serialize to Turtle
console.log(toTurtle(descriptor));
```

### Publish to a Solid Pod

```typescript
import { publish, discover, subscribe } from '@foxxi/context-graphs';

// Publish descriptor + graph to a pod
const result = await publish(descriptor, graphTurtle, 'https://pod.example.com/alice/', {
  fetch: authenticatedFetch,
});
// → { descriptorUrl, graphUrl, manifestUrl }

// Discover what's on a pod
const entries = await discover('https://pod.example.com/bob/', {
  facetType: 'Semiotic',
  validFrom: '2026-01-01T00:00:00Z',
});

// Subscribe to live changes via WebSocket
const sub = await subscribe('https://pod.example.com/bob/', (event) => {
  console.log(`${event.type} on ${event.resource} at ${event.timestamp}`);
});
```

### Compose Two Descriptors

```typescript
import { union, intersection } from '@foxxi/context-graphs';

// Union: merge all facets from both descriptors
const merged = union(descriptorA, descriptorB);

// Intersection: keep only shared facet types
const common = intersection(descriptorA, descriptorB);
```

---

## MCP Server — AI Agent Integration

The MCP server gives AI coding agents (Claude Code, Codex CLI, etc.) direct access to context graphs through the [Model Context Protocol](https://modelcontextprotocol.io).

### Setup

Add to your `.mcp.json` (VS Code) or `claude_desktop_config.json` (Claude Desktop):

```json
{
  "mcpServers": {
    "context-graphs": {
      "command": "cmd",
      "args": ["/c", "npx", "tsx", "path/to/context-graphs/mcp-server/server.ts"],
      "env": {
        "CG_POD_NAME": "your-pod-name",
        "CG_AGENT_ID": "urn:agent:anthropic:claude-code:vscode",
        "CG_OWNER_WEBID": "https://id.example.com/you/profile#me",
        "CG_OWNER_NAME": "Your Name",
        "CG_BASE_URL": "https://your-css-instance.example.com/"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CG_HOME_POD` | Full URL of agent's home pod (takes precedence) | Computed from BASE_URL + POD_NAME |
| `CG_BASE_URL` | CSS base URL | `http://localhost:3456/` |
| `CG_POD_NAME` | Pod name on the CSS | `agent` |
| `CG_AGENT_ID` | Agent identity IRI | `urn:agent:claude-code:local` |
| `CG_OWNER_WEBID` | Owner's WebID | Auto-generated |
| `CG_OWNER_NAME` | Owner's display name | — |
| `CG_DID` | Agent's DID | `did:web:{pod_name}.local` |
| `CG_KNOWN_PODS` | Comma-separated pod URLs for auto-discovery | — |
| `CG_DIRECTORY_URL` | URL of a PodDirectory graph to auto-load | — |
| `CG_PORT` | CSS port for local startup | `3456` |

### 16 MCP Tools

**Core:**

| Tool | Description |
|---|---|
| `publish_context` | Publish a context-annotated knowledge graph to your Solid pod |
| `discover_context` | Discover descriptors on a pod, with optional delegation verification |
| `get_descriptor` | Fetch the full Turtle of a specific descriptor |
| `subscribe_to_pod` | Subscribe to live WebSocket notifications from a pod |
| `get_pod_status` | Check a pod's owner, agents, descriptors, and notifications |

**Delegation:**

| Tool | Description |
|---|---|
| `register_agent` | Register an AI agent as authorized to act on behalf of the pod owner |
| `revoke_agent` | Revoke an agent's delegation |
| `verify_agent` | Verify an agent is authorized by checking the pod's agent registry |

**Federation:**

| Tool | Description |
|---|---|
| `discover_all` | Fan out discovery across ALL known pods |
| `subscribe_all` | Subscribe to WebSocket notifications from ALL known pods |
| `list_known_pods` | List all pods in the federation registry |
| `add_pod` | Add a pod URL to the federation registry |
| `remove_pod` | Remove a pod from the registry |
| `discover_directory` | Import pods from a PodDirectory graph |
| `publish_directory` | Publish your pod registry as a PodDirectory |
| `resolve_webfinger` | Resolve a WebFinger identifier to discover a pod (RFC 7033) |

---

## Identity & Delegation Model

The pod belongs to the **owner** (a human or organization). Agents are **delegates** acting on the owner's behalf.

```
Owner (human)
├── WebID: https://id.example.com/alice/profile#me
├── Pod: https://pod.example.com/alice/
│
├── Authorized agents:
│   ├── claude-code-vscode  [ReadWrite]
│   ├── claude-desktop      [ReadWrite]
│   └── codex-cli           [DiscoverOnly]
│
└── Agent Registry: /alice/agents (RDF Turtle)
    └── Delegation Credentials: /alice/credentials/*.jsonld (VC format)
```

When an agent publishes a descriptor:
- `prov:wasAttributedTo` → the owner (human)
- `prov:wasAssociatedWith` → the agent (AI tool)
- Trust facet references the delegation credential

When another agent consumes it:
1. Fetch descriptor from pod
2. Read `wasAttributedTo` (owner) and `wasAssociatedWith` (agent)
3. Fetch `/agents` registry from the pod
4. Confirm the agent is listed as authorized and not revoked
5. Check temporal validity of the delegation
6. Accept or reject based on trust policy

---

## Federation — Three Discovery Approaches

### 1. Known Pods (manual)

```bash
CG_KNOWN_PODS="https://pod.alice.com/alice/,https://pod.bob.com/bob/"
```

The agent discovers from each on startup and when `discover_all` is called.

### 2. Pod Directory Graphs (decentralized registry)

A pod publishes a directory — itself an RDF graph:

```turtle
<urn:directory:team> a cg:PodDirectory ;
    cg:hasPod [ cg:podUrl <https://pod.alice.com/alice/> ; cg:owner <https://id.alice.com/profile#me> ] ;
    cg:hasPod [ cg:podUrl <https://pod.bob.com/bob/> ; cg:owner <https://id.bob.com/profile#me> ] .
```

Any agent can fetch the directory and import all listed pods.

### 3. WebFinger (DNS-rooted, RFC 7033)

```
GET https://alice.com/.well-known/webfinger?resource=acct:alice@alice.com
```

Returns the pod URL in the JRD response. Same pattern ActivityPub uses for Mastodon federation. No central registry — DNS is the root of trust.

---

## Manifest Format — Hydra & DPROD Aligned

The `.well-known/context-graphs` manifest is a **Hydra Collection** with HATEOAS affordances:

```turtle
<manifest> a hydra:Collection, cg:DataProduct ;
    hydra:manages [ hydra:property cg:describes ; hydra:object cg:ManifestEntry ] ;
    hydra:operation [
        hydra:method "GET" ;
        hydra:title "Discover context descriptors"
    ] ;
    hydra:operation [
        hydra:method "PUT" ;
        hydra:title "Publish new context descriptor"
    ] ;
    cg:affordance cg:canDiscover, cg:canSubscribe ;
    cg:outputPort [ a dcat:Distribution ; dcat:mediaType "text/turtle" ] .
```

Agents can introspect what operations a pod supports before interacting.

---

## Type System

### Core Types

```typescript
type IRI = string & { readonly __brand: 'IRI' };

type ContextTypeName =
  | 'Temporal' | 'Provenance' | 'Agent'
  | 'AccessControl' | 'Semiotic' | 'Trust' | 'Federation';

type ModalStatus = 'Asserted' | 'Hypothetical' | 'Counterfactual' | 'Quoted' | 'Retracted';
type TrustLevel = 'SelfAsserted' | 'ThirdPartyAttested' | 'CryptographicallyVerified';
type CompositionOperator = 'union' | 'intersection' | 'restriction' | 'override';
type DelegationScope = 'ReadWrite' | 'ReadOnly' | 'PublishOnly' | 'DiscoverOnly';
```

### Seven Facet Types (Discriminated Union)

| Facet | W3C Alignment | Key Fields |
|---|---|---|
| **Temporal** | OWL-Time, Dublin Core | `validFrom`, `validUntil`, `temporalResolution` |
| **Provenance** | PROV-O | `wasGeneratedBy`, `wasDerivedFrom`, `wasAttributedTo` |
| **Agent** | PROV-O, ActivityStreams | `assertingAgent`, `onBehalfOf`, `agentRole` |
| **AccessControl** | WAC | `authorizations[]`, `consentBasis` |
| **Semiotic** | Peircean semiotics | `modalStatus`, `epistemicConfidence` [0.0–1.0], `groundTruth` |
| **Trust** | VC 2.0, DID Core | `verifiableCredential`, `issuer`, `trustLevel` |
| **Federation** | DCAT 3, LDP, Solid | `origin`, `storageEndpoint`, `syncProtocol` |

---

## Serialization

### Turtle

```typescript
import { toTurtle, toTurtleDocument } from '@foxxi/context-graphs';

const turtle = toTurtle(descriptor);           // Just the triples
const doc = toTurtleDocument(descriptor);      // With @prefix declarations
```

### JSON-LD

```typescript
import { toJsonLd, toJsonLdString, fromJsonLd } from '@foxxi/context-graphs';

const jsonld = toJsonLd(descriptor);
const str = toJsonLdString(descriptor, { pretty: true });
const parsed = fromJsonLd(jsonldObject);
```

---

## Validation

```typescript
import { validate, assertValid, getShaclShapesTurtle } from '@foxxi/context-graphs';

const result = validate(descriptor);
// { conforms: boolean, violations: [{ path, message, severity }] }

assertValid(descriptor); // Throws if invalid

// Export SHACL shapes for use with external engines
const shacl = getShaclShapesTurtle();
```

---

## SPARQL Query Patterns

```typescript
import {
  queryContextForGraph,
  queryGraphsAtTime,
  queryGraphsByModalStatus,
  queryGraphsByTrustLevel,
  queryProvenanceChain,
} from '@foxxi/context-graphs';

const sparql = queryContextForGraph('urn:graph:my-analysis' as IRI);
const atTime = queryGraphsAtTime('2026-03-20T00:00:00Z');
const asserted = queryGraphsByModalStatus('Asserted');
const trusted = queryGraphsByTrustLevel('CryptographicallyVerified');
const provenance = queryProvenanceChain('urn:graph:my-analysis' as IRI);
```

---

## Deployment

### Docker

Three Dockerfiles in `deploy/`:

```bash
# Community Solid Server
docker build -f deploy/Dockerfile.css -t context-graphs-css .

# Dashboard (real-time observation UI)
docker build -f deploy/Dockerfile.dashboard -t context-graphs-dashboard .

# MCP Relay (HTTP bridge for remote agents)
docker build -f deploy/Dockerfile.relay -t context-graphs-relay .
```

### Azure Container Apps

One-command deployment:

```bash
cd deploy && bash azure-deploy.sh
```

Deploys three services:
- **CSS** — Community Solid Server (internal ingress, port 3456)
- **Dashboard** — Real-time observation UI (external, port 4000)
- **MCP Relay** — HTTP/SSE bridge with 15 tools (external, port 8080)

The relay exposes the same tools as the stdio MCP server but over HTTP, so agents running anywhere can connect.

### MCP Relay Endpoints

```
GET  /health          Health check
GET  /tools           List available tools
POST /tool/:name      Call a tool via REST
GET  /sse             SSE stream for real-time events
POST /messages        MCP JSON-RPC over HTTP
```

---

## Development

```bash
npm install          # Install devDependencies
npm run build        # Compile TypeScript → dist/
npm test             # Run vitest (85 tests)
npm run test:watch   # Watch mode
npm run test:coverage # Coverage report
npm run lint         # ESLint
```

### Test Suites

| Suite | Tests | Coverage |
|---|---|---|
| `context-graphs.test.ts` | 44 | Builder, composition, validation, serialization, namespaces, SPARQL, SHACL |
| `solid.test.ts` | 20 | Publish, discover, subscribe, agent registry, delegation |
| `federation.test.ts` | 21 | Pod directory, multi-pod, WebFinger, Hydra manifest |

---

## Module Exports

The package provides fine-grained subpath exports:

```typescript
import { ... } from '@foxxi/context-graphs';          // Everything
import { ... } from '@foxxi/context-graphs/model';    // Types, builder, composition
import { ... } from '@foxxi/context-graphs/rdf';      // Serializers, namespaces
import { ... } from '@foxxi/context-graphs/validation'; // Validator, SHACL shapes
import { ... } from '@foxxi/context-graphs/sparql';   // Query pattern builders
import { ... } from '@foxxi/context-graphs/solid';    // Pod client, directory, WebFinger
```

---

## Related Projects

Part of the Foxxi Mediums knowledge infrastructure:

- **[@foxxi/hela-store](https://github.com/foxximediums/hela-store)** — HELA's topos-theoretic xAPI stack (presheaf category ℰ = Set^(𝒞_xAPI^op))
- **SAT (Semiotic Agent Topos)** — The Semiotic Facet maps directly to SAT's Semiotic Field Functor (Σ)
- **HyprCat × HyprAgent** — Federation Facet aligns with the three-world federation model

---

## Spec Compliance

This implementation follows the [Context Graphs 1.0 Working Draft](https://markjspivey-xwisee.github.io/context-graphs/spec/context-graphs-1.0-wd.html):

- §3.1 Context Descriptor structure
- §3.4 Composition operators (union, intersection, restriction, override) forming a bounded lattice
- §3.5 Triple-level inheritance via `effectiveContext()`
- §5 All seven facet types with W3C vocabulary alignment
- §6 Serialization (Turtle, JSON-LD, TriG)
- §7 SPARQL 1.2 query patterns
- §8 SHACL validation shapes
