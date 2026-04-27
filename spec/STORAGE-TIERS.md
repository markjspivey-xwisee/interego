# Storage Tiers — Local-First by Design

**Audience:** developers and operators choosing how to deploy Interego.

**TL;DR:** Interego runs entirely on your laptop with zero external services by default. The MCP server auto-spawns a local Solid pod the first time you publish, the IPFS provider defaults to local-only CID computation, and the identity service has a local-key mode. Add network, TLS, and federation as you grow — each tier inherits everything below it.

---

## The five tiers

| Tier | Name | What's external | When to use |
|---|---|---|---|
| 0 | Library-only | Nothing | Embedding the protocol in your own app — compose / validate / sign / serialize without any daemon |
| 1 | Local single-machine pod | Nothing | Default for the MCP. Personal AI memory, one machine |
| 2 | LAN | LAN reachability | Phone + laptop sharing a pod, dev/staging on a home network |
| 3 | Self-hosted public pod | DNS + TLS | Production single-tenant deployment on your own VPS |
| 4 | Federated across pods | Other people's pods | Cross-pod sharing, multi-organization collaboration |
| 5 | Fully peer-to-peer | (none) | **Not yet built** — would need libp2p / NAT traversal |

Each tier is a strict superset of the one below. You don't choose between them — you decide how far up the stack you want to go.

---

## Tier 0 — Library-only

**You import `@interego/core` into your code and never start a daemon.**

```ts
import {
  ContextDescriptor,
  toTurtle,
  validate,
  importWallet,
  signDescriptor,
  verifyDescriptorSignature,
  cryptoComputeCid,
} from '@interego/core';

const desc = ContextDescriptor.create('urn:cg:my-claim')
  .describes('urn:graph:my-data')
  .selfAsserted('did:key:z6Mk...')
  .build();

const turtle = toTurtle(desc);
const cid = cryptoComputeCid(turtle);
const wallet = importWallet('0xabc...', 'agent');
const signed = await signDescriptor(desc.id, turtle, wallet);
const verify = await verifyDescriptorSignature(signed, turtle);
```

**What works:** descriptor construction, validation, composition (union/intersection/restriction/override), Turtle/JSON-LD serialization, ECDSA signing + verification, IPFS CID computation, encryption (NaCl envelope), ZK proofs (Merkle inclusion, range proofs), PGSL lattice operations, framework conformance reports.

**What you give up:** federation (no other pod to talk to), persistence (you decide where to write turtles), discoverability (no manifest is published anywhere).

**Use this when:** you want Interego inside an existing system that has its own storage.

---

## Tier 1 — Local single-machine pod (default)

**The MCP server auto-spawns Community Solid Server (CSS) the first time you publish.**

Just run the MCP. No pre-flight setup:

```bash
npx @interego/mcp
```

On first `publish_context` call, the MCP:
1. Checks if a Solid pod is reachable at `CG_BASE_URL` (default `http://localhost:3456/`)
2. If not, spawns CSS locally (`mcp-server/server.ts:321-345`) using `examples/multi-agent/css-config.json`
3. CSS writes to disk, file-backed, at `--rootFilePath` (default: a temp dir; configurable via env)

Configuration (all optional):

| Env var | Default | What it does |
|---|---|---|
| `CG_BASE_URL` | `http://localhost:3456/` | URL of your local pod |
| `CG_POD_NAME` | `markj` | Slug for your pod path |
| `CG_IPFS_PROVIDER` | `local` | CIDs are computed but not pinned to any network |
| `CG_DID` | `did:web:<pod>.local` | Your identity (local-mode synthetic) |

**What works:** everything in Tier 0, plus full publish / discover / subscribe / compose / framework reports against a real Solid pod. Notifications via WebSocket. Encrypted envelopes with your X25519 key. Compliance-grade descriptors (signed + locally-computed CID; the CID is *correct*, just not retrievable from IPFS unless you upgrade the provider).

**What you give up:** sharing with people on other machines (your pod is on `localhost`).

**Use this when:** you're a single person on a single machine and want all of Interego with no setup.

---

## Tier 2 — LAN

**Same as Tier 1, but your pod is reachable from other devices on your network.**

Two changes from Tier 1:
1. Bind CSS to a non-localhost interface (set `--baseUrl` to your LAN IP or hostname, e.g. `http://laptop.local:3456/`).
2. Set `CG_BASE_URL` on the *other* device to the same URL.

You'll want HTTPS even on a LAN once you're carrying any sensitive content — `mkcert` or your home CA can issue a cert in 30 seconds.

**What works:** everything in Tier 1, plus your phone / second laptop reading + writing the same pod.

**What you give up:** anyone outside your LAN. NAT means you're not internet-reachable.

**Use this when:** you have a few devices and want shared memory across them, but no need for the public internet.

---

## Tier 3 — Self-hosted public pod

**Run CSS on your own VPS with DNS + TLS.**

This is exactly what `deploy/Dockerfile.css` + `deploy/azure-deploy.sh` build, but on your own infra:

```bash
docker build -f deploy/Dockerfile.css -t my-pod .
docker run -p 3456:3456 \
  -e CSS_BASE_URL=https://pod.example.com/ \
  -v $(pwd)/data:/data \
  my-pod
```

Then point your DNS at the host, terminate TLS at a reverse proxy (nginx / Caddy / Cloudflare), and update `CG_BASE_URL` clients use.

**What works:** everything in Tier 2, plus internet-reachable for any client that knows your URL.

**What you give up:** nothing of substance — at this point you have a fully-featured personal pod.

**Use this when:** you want a single-tenant deployment, you don't trust a hosted provider with even encrypted content, and you can run a server.

---

## Tier 4 — Federated across pods

**Your pod talks to other people's pods cryptographically.**

Federation is built into the protocol — there's nothing to enable, just other pods to discover.

```ts
// Cross-pod sharing — encrypts to recipient's published agent keys
publish_context({
  graph_iri: 'urn:graph:project-x',
  graph_content: '...',
  share_with: ['acct:bob@bob.example', 'did:web:carol.example#mcp'],
});

// Cross-pod discovery — fans out to known pods
discover_all({ subject: 'urn:graph:project-x' });

// WebFinger resolution
resolve_webfinger({ resource: 'acct:bob@bob.example' });
```

Discovery primitives:

- **WebFinger** — `acct:user@host` resolves to a pod URL via `https://host/.well-known/webfinger?resource=...`
- **DID resolution** — `did:web:host` resolves via `https://host/.well-known/did.json`
- **Pod manifest discovery** — `https://pod/.well-known/context-graphs-directory` lists everything publishable
- **Agent registry** — each pod publishes its authorized agents' X25519 keys for cross-pod E2EE

**What works:** everything in Tier 3, plus cross-pod publish / discover / share / federated compliance reports / multi-pod witness attestation.

**What you give up:** nothing — this is the full Interego experience.

**Use this when:** you want shared memory across organizations, multi-agent collaboration, or to participate in the broader Interego federation.

---

## Tier 5 — Relay-mediated peer-to-peer (Nostr-style, shipped)

**Pods exchange descriptor announcements through Nostr-style commodity relays. Mobile + desktop work the same way; no central server we operate.**

Implemented as [`src/p2p/`](../src/p2p/):

- **Identity** — your secp256k1 wallet IS your peer identity. Same key the operator uses for compliance signing, x402, SIWE.
- **Events** — NIP-01-shaped: `id` is sha256 of canonical JSON, `sig` is ECDSA over the id (Schnorr adapter for public-Nostr interop is a future drop-in).
- **Kinds** — three custom kinds in the NIP-33 parameterized-replaceable range: `30040` descriptor announcement, `30041` directory, `30042` attestation.
- **Relays** — `P2pRelay` interface lets the same client speak to:
  - `InMemoryRelay` (this repo) for tests + single-process simulation
  - WebSocket → any conformant Nostr relay (write the adapter; the protocol stays unchanged)
  - libp2p-backed peer (a future Tier 6)

```ts
import { P2pClient, InMemoryRelay, importWallet } from '@interego/core';

const wallet = importWallet('0x...', 'agent', 'me');
const relay = new InMemoryRelay(); // or any P2pRelay implementation
const client = new P2pClient(relay, wallet);

await client.publishDescriptor({
  descriptorId: 'urn:cg:my-claim',
  cid: 'bafkrei...',
  graphIri: 'urn:graph:my-data',
  facetTypes: ['Temporal', 'Trust'],
});

const found = await client.queryDescriptors({ graphIri: 'urn:graph:my-data' });
```

**Storage tradeoff:** Nostr events carry the manifest entry (descriptor ID, CID, graph IRI, facet types, conformsTo). The descriptor *bytes* still live somewhere content-addressed (IPFS, your pod, a peer who has it). Nostr is the discovery + notification plane; storage stays in Tier 1-4 substrates. Hybrid by design.

**Cross-surface (mobile + desktop):** the `P2pClient` API is transport-agnostic. Mobile clients (claude.ai app, ChatGPT app) speak WebSocket to a relay; desktop clients (Claude Code, custom MCP servers) do the same. They exchange events through any common relay without sharing infrastructure. See [`docs/p2p.md`](../docs/p2p.md) for the deployment topology.

**What you give up vs. true libp2p P2P:**
- Relays are still servers (just commodity ones — anyone can run one). Not censorship-immune; just censorship-resistant.
- Event size is constrained by relay policy (~64KB typical). Big descriptors must use CID + external storage.

**What you get:**
- Mobile + desktop interop with no special infrastructure beyond a relay URL.
- Identity is the same wallet you already have. **Two pubkey formats supported on the wire** — Ethereum-style address (ECDSA) for Interego-internal events, BIP-340 x-only pubkey (Schnorr) for public-Nostr-relay interop. The same private key produces both; clients dispatch on pubkey format automatically.
- **1:N encrypted share** — Tier 4's cross-pod E2EE feature works across the P2P transport too via `KIND_ENCRYPTED_SHARE` (kind 30043). The relay sees ciphertext + recipient signing pubkeys; only addressed recipients can decrypt with their X25519 keypair. Closes the prior Tier 4-vs-Tier 5 capability gap.
- Censorship-resistance (publish to multiple relays; aggregate from multiple relays).
- Bootstrap problem solved (public Nostr relay lists are well-known).

**Tested end-to-end:** [`tests/p2p.test.ts`](../tests/p2p.test.ts) — 16 tests covering two-agent exchange, replaceable semantics, third-party observation, directory advertisement, witness attestation, security (tampered events rejected, foreign signatures rejected), dual-scheme signing (ECDSA + Schnorr), 1:N encrypted share, and a desktop ↔ mobile cross-surface simulation.

### Run it locally — `@interego/personal-bridge`

For zero-config Tier 5 with no central server we operate, see [`examples/personal-bridge/`](../examples/personal-bridge/). One Node process you run on your laptop / Raspberry Pi / NAS / Tailscale-exposed home server. Embeds `InMemoryRelay`, exposes MCP at `POST /mcp`, REST at `/api/*`, an admin UI at `/`. All your devices point at the same bridge URL forever — no URL switching, no global/local mode toggle. Sharing is per-publish (`share_with`) or per-bridge (`EXTERNAL_RELAYS` env var to mirror to public Nostr relays). Local-first by default. See [`examples/personal-bridge/README.md`](../examples/personal-bridge/README.md) for the quick start + cross-device connection table.

### Why "Tier 5" not "Tier 5+"

A future tier could replace relays with libp2p (no servers, even commodity ones). The protocol surface is unchanged; only `P2pRelay` would have a new implementation. We aren't building it today because relay-mediated solves the practical "mobile + desktop" use case at a fraction of the complexity.

---

## Tier-by-tier capability matrix

| Capability | T0 | T1 | T2 | T3 | T4 | T5 |
|---|---|---|---|---|---|---|
| Build / validate / compose descriptors | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ECDSA signing + verification | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| IPFS CID computation (no pinning) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ZK proofs (Merkle, range, temporal) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Persistent pod storage | – | ✓ | ✓ | ✓ | ✓ | ✓ (hybrid: events on relay, content on IPFS/pod) |
| WebSocket notifications | – | ✓ | ✓ | ✓ | ✓ | ✓ (via relay subscriptions) |
| Multi-device single-user | – | – | ✓ | ✓ | ✓ | ✓ |
| Internet-reachable pod | – | – | – | ✓ | ✓ | – (relay-reachable instead) |
| Cross-pod publish / discover | – | – | – | – | ✓ | ✓ (via relay) |
| Cross-pod E2EE share | – | – | – | – | ✓ | ✓ (KIND_ENCRYPTED_SHARE, 1:N envelope) |
| Federated witness attestation | – | – | – | – | ✓ | ✓ |
| IPFS pin to a real network (Pinata / Filecoin) | – | – (use `local`) | – | optional | optional | optional |
| Mobile + desktop interop with no central infra | – | – | – | – | partial | ✓ |
| Truly server-less (no relays anywhere) | – | – | – | – | – | – (would be Tier 6) |

---

## Choosing your tier

Default to Tier 1 — it's zero-config, works offline, and gives you the full protocol surface. Move up only when you need what the next tier adds:

- "I want my phone to share memory with my laptop" → Tier 2
- "I want a colleague to read my pod" → Tier 3
- "I want pods at different organizations to compose memories" → Tier 4
- "I want no servers anywhere" → Tier 5 (not built; open an issue)

You can move up a tier without changing application code — only deployment config changes. The protocol surface is identical.

---

## Verifying your tier works

The smoke tests in [`tests/storage-tiers.test.ts`](../tests/storage-tiers.test.ts) cover Tier 0, Tier 1 (with an in-memory pod), and Tier 4 (with two in-memory pods talking to each other). Run them with:

```bash
npx vitest run tests/storage-tiers.test.ts --reporter=verbose
```

For Tiers 2 / 3, the verification is operational: stand up CSS, point a client at it, run any of the demo scripts in [`examples/`](../examples/) using the `CG_DEMO_POD` env var (see [`examples/_lib.mjs`](../examples/_lib.mjs)).

For Tier 5, the verification will exist when the tier does.
