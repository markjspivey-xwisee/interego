# E2EE Architecture

End-to-end encryption of pod content, structured as **per-agent recipient sets** with **self-describing hypermedia** so clients can retrieve + decrypt without knowing the server's internals.

## First principles

1. **Storage is zero-trust.** CSS, Azure Files, the IPFS pinning service, and anyone with raw read access to a pod URL sees only ciphertext for private content. No operator in the chain has enough material to read user data.
2. **Keys live with agents.** Each agent surface (Claude Code stdio, Claude Desktop, Claude Mobile relay, any future client) holds its own X25519 keypair and never leaves it. The server stores only public keys.
3. **Metadata stays discoverable.** Descriptor *facets* (type, temporal range, modal status, trust level) remain plaintext so federation queries work. Graph *content* (the actual triples) is encrypted. The split is deliberate: discovery without disclosure.
4. **Hypermedia-native.** A descriptor self-describes the path from metadata to encrypted payload via `cg:affordance [ a dcat:Distribution, hydra:Operation, cg:Affordance, cgh:Affordance ; … ]`. Clients follow the link; they never reconstruct URLs by filename convention.

## Three encryption surfaces

| Surface | What's encrypted | Applied by | Recipients |
|---|---|---|---|
| **Graph envelope** | The named-graph payload (TriG) behind a descriptor | `publish()` in `src/solid/client.ts` | Every `cg:AuthorizedAgent` on the pod with an `cg:encryptionPublicKey`, plus any `share_with` handles' agents |
| **Facet value** | Individual sensitive field within a facet (e.g. `prov:wasAttributedTo`) | `encryptFacetValue()` in `src/crypto/facet-encryption.ts` | Explicit recipient list per field |
| **PGSL atom** | The value of a single lattice atom | `mintEncryptedAtom()` in `src/pgsl/lattice.ts` | Pod-scoped agent set; URI still content-addressed |

All three use the same nacl-box envelope format (`X25519` key-exchange + `XSalsa20-Poly1305` AEAD + one wrapped content-key per recipient).

## The envelope format

```json
{
  "content": {
    "ciphertext": "<base64>",
    "nonce": "<base64 24 bytes>",
    "algorithm": "XSalsa20-Poly1305"
  },
  "wrappedKeys": [
    {
      "recipientPublicKey": "<base64 X25519>",
      "wrappedKey": "<base64>",
      "nonce": "<base64 24 bytes>",
      "senderPublicKey": "<base64 X25519>"
    },
    // ... one entry per recipient
  ],
  "algorithm": "X25519-XSalsa20-Poly1305",
  "version": 1
}
```

**Wire shape:** single JSON document, served with `Content-Type: application/jose+json`, hosted alongside the descriptor at `<descriptor-url>-graph.envelope.jose.json`. Filename is internal — clients reach it through the hypermedia block below, not by convention.

## The hypermedia link (descriptor → envelope)

Every encrypted descriptor Turtle includes this block:

```turtle
<> cg:affordance [
    a cg:Affordance, cgh:Affordance, hydra:Operation, dcat:Distribution ;
    cg:action cg:canDecrypt ;
    hydra:method "GET" ;
    hydra:target <https://pod/.../slug-graph.envelope.jose.json> ;
    hydra:returns cg:EncryptedGraphEnvelope ;
    hydra:title "Fetch encrypted graph envelope" ;
    dcat:accessURL <https://pod/.../slug-graph.envelope.jose.json> ;
    dcat:mediaType "application/jose+json" ;
    cg:encrypted true ;
    cg:encryptionAlgorithm "X25519-XSalsa20-Poly1305" ;
    cg:recipientCount 3
] .
```

**Four compatible types on one RDF node:**
- `cg:Affordance` — discovery-time capability declaration (matches `cg:canPublish` / `cg:canDiscover` / `cg:canSubscribe` pattern)
- `cgh:Affordance` — harness-execution-time affordance for decorator pipelines
- `hydra:Operation` — HATEOAS client dispatch target
- `dcat:Distribution` — DCAT-3 compatible for external catalog ingestion

Any client speaking any of these vocabularies can dispatch the retrieval without Interego-specific understanding. DCAT-aware catalogs ingest these as data-product distributions; Hydra clients auto-generate UI; harness agents integrate into affordance pipelines.

## The recipient set

On every publish, the recipient set is the union of:

1. **Every non-revoked `cg:AuthorizedAgent`** on the target pod that has registered a `cg:encryptionPublicKey`. Read from `<pod>/agents` via `readAgentRegistry()`.
2. **The publishing agent's own key** (always included so the author can re-read their own publishes later).
3. **External agents from `share_with`** handles — each handle resolved via WebFinger / DID / direct pod URL to the target user's pod, their authorized agents' keys pulled and added. One graph, selective disclosure without pod-level ACL changes.

Registration is automatic: `publish_context` auto-registers the calling agent on the target pod's registry (including its X25519 public key) if it isn't already present. Per-surface agents (e.g. `claude-code-vscode-<userId>`, `chatgpt-<userId>`, `cursor-<userId>`) therefore each become first-class recipients on their first write — no piggybacking on a shared agent. The relay derives the surface slug automatically from the OAuth client's DCR-registered `client_name`; unknown clients fall back to `mcp-client` rather than `claude-*`, so nothing silently masquerades. The `<userId>` portion is itself derived from the user's first credential (`u-pk-…` for passkeys, `u-eth-…` for wallets, `u-did-…` for DIDs) — never a user-claimed string.

## Key lifecycle

| Event | What happens to keys |
|---|---|
| **Agent startup** | Load or generate X25519 keypair at `agent-key-<id>.json` (stdio) or `/app/relay-agent-key.json` (relay). File is mode 0600. Persists across container restarts when a persistent volume is mounted. |
| **First publish** | Agent auto-registers on the pod's `<pod>/agents` Turtle registry with `cg:encryptionPublicKey "<base64>"`. Delegation credential written to `/credentials/<agent-id>.jsonld`. |
| **Subsequent publishes** | Registry is re-read, recipient set collected, envelope wrapped for everyone. Idempotent. |
| **Key rotation** | Publish with new keypair — subsequent envelopes include new key as recipient. Old envelopes keep working via old wrapped-keys. |
| **Revocation** | Remove agent from registry, optionally re-encrypt recent descriptors without the revoked key (old envelopes that a revoked agent already decrypted once are irrecoverably out of your control — this is true of all E2EE systems). |

## What this buys

- **Zero-trust storage**: CSS, Azure Files, Pinata see only ciphertext. Proven via canary test — `FIRST_PRINCIPLES_CANARY_*` strings written as graph content are never present in the raw bytes served by CSS, only in `get_descriptor` output after envelope decryption.
- **Per-agent provenance**: every descriptor's `prov:wasAssociatedWith` is a `did:web` IRI tied to a specific surface. ChatGPT writes attribute to `did:web:…:agents:chatgpt-u-pk-<hash>`, Claude Code writes to `did:web:…:agents:claude-code-vscode-u-pk-<hash>`, etc. No piggybacking, no collapsed identity, no string collisions across users because the `<userId>` tail is derived from credential material.
- **Federation without ACL contortion**: `share_with` adds recipients cryptographically. Bob's agent can decrypt the shared graph; everything else on your pod stays inaccessible because his keys aren't in those envelopes.
- **HATEOAS navigation**: a cold SPARQL client hitting a descriptor URL learns, from the RDF alone, where the payload is, what format, whether encrypted, which algorithm, what HTTP verb to use. No baked-in filename conventions.

## Known tradeoffs

- **Per-agent E2EE, not per-device.** The X25519 private key lives on the host running the agent (laptop for stdio, relay VM for OAuth clients). True user-device-to-pod encryption requires MCP-client-level crypto which isn't supported yet by mainstream Claude clients. The envelope format doesn't change for that transition — it's additive.
- **Filename-based companion layout.** The envelope lives at `<descriptor-url>-graph.envelope.jose.json`. Not a protocol constant — clients reach it via `hydra:target` / `dcat:accessURL`. If you want to rename or migrate, the descriptor points at the new location; no client update required. But the current runtime uses this layout for simplicity.
- **Recipient-set ciphertext fanout.** Each envelope carries one wrapped content-key per recipient; fan-out linear in agent count. Fine for personal use (3-10 agents); consider KEM trees for mesh deployments with hundreds of recipients.
- **No forward secrecy.** Same X25519 identity keys are used for all envelopes — compromise of a private key retroactively exposes everything encrypted to it. Acceptable for the current threat model (trusted personal devices, no long-term adversary); a future extension would rotate per-publish ephemeral keys.
- **DPoP not yet bound to envelopes.** Bearer tokens are the current authentication vehicle for accessing the pod. Adding DPoP (RFC 9449) so every MCP request carries a signed JWT from the client would pair cleanly with this architecture; tracked in the auth follow-ups.

## References in the code

| Concern | File |
|---|---|
| Envelope format + primitives | [`src/crypto/encryption.ts`](../src/crypto/encryption.ts) |
| Facet-value encryption | [`src/crypto/facet-encryption.ts`](../src/crypto/facet-encryption.ts) |
| PGSL atom encryption | [`src/pgsl/lattice.ts`](../src/pgsl/lattice.ts) — `mintEncryptedAtom`, `resolveAtomValue` |
| Publish with encryption | [`src/solid/client.ts`](../src/solid/client.ts) — `publish()`, `buildDistributionBlock()`, `parseDistributionFromDescriptorTurtle()` |
| Cross-pod sharing | [`src/solid/sharing.ts`](../src/solid/sharing.ts) |
| Agent-registry key management | [`mcp-server/server.ts`](../mcp-server/server.ts), [`deploy/mcp-relay/server.ts`](../deploy/mcp-relay/server.ts) — `ensureRegistry`, `handlePublishContext` |
| Identity + auth-methods | [`deploy/identity/server.ts`](../deploy/identity/server.ts), [`deploy/identity/AUTH-ARCHITECTURE.md`](../deploy/identity/AUTH-ARCHITECTURE.md) |

## References in the ontology

| Concept | Definition |
|---|---|
| `cg:EncryptedGraphEnvelope` | [`docs/ns/cg.ttl`](ns/cg.ttl) — `rdfs:subClassOf dcat:Distribution` |
| `cg:GraphPayload` | [`docs/ns/cg.ttl`](ns/cg.ttl) — plaintext variant |
| `cg:EncryptedValue` | [`docs/ns/cg.ttl`](ns/cg.ttl) — facet-value wrapper |
| `cg:canDecrypt`, `cg:canFetchPayload` | [`docs/ns/cg.ttl`](ns/cg.ttl) — affordance individuals |
| `cg:encrypted`, `cg:encryptionAlgorithm`, `cg:recipientCount` | [`docs/ns/cg.ttl`](ns/cg.ttl) — distribution properties |
| `cg:encryptionPublicKey` on `cg:AuthorizedAgent` | [`docs/ns/cg.ttl`](ns/cg.ttl) — per-agent recipient key |
| `cg:sharedWith` | [`docs/ns/cg.ttl`](ns/cg.ttl) — cross-pod sharing declaration |
