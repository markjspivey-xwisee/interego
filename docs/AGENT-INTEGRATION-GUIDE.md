# Agent Integration Guide

**Audience:** maintainers of AI agent frameworks and harnesses (OpenClaw, Cursor, Cline, Aider, Roo Code, Continue, Codex CLI, custom in-house agents) — anyone who builds the system prompt + tooling that ships in an AI product.

**One-page version:** add the Interego MCP to your config, embed the snippet below in your system prompt, and your agents can publish + discover federated typed-context memory across pods. No code changes required from your side — Interego is a substrate, not an integration.

---

## What Interego is, in two sentences

Interego is composable, verifiable, federated context infrastructure for multi-agent shared memory. It gives every AI agent a typed, cryptographically-attributable memory layer that lives on the user's Solid pod — the same memory accessible from any compliant agent on any framework.

## What it does for your users

- **Memory portability.** Their AI memory follows them across surfaces. They switch from your tool to another and the memory comes with them. (Removes lock-in concerns.)
- **Cryptographic privacy.** Every cross-pod share is end-to-end encrypted; pod servers see ciphertext.
- **Provenance + trust.** Every claim carries who-made-it, when, with-what-confidence — auditable forever.
- **Cross-agent collaboration.** Their agent + their colleague's agent (different framework) can co-author memory through the pod.

## Adding the MCP

Stdio (local):

```json
{
  "mcpServers": {
    "interego": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

HTTP/SSE (remote, OAuth-gated, for browser/cloud agents):

```
https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp
```

That's it. Your agent now has 60 Interego tools (six progressive tiers: core, delegation, federation, identity, PGSL, and crypto/x402). The MCP server's `initialize` response includes top-level instructions explaining the protocol, and `docs://interego/playbook` is fetched on demand the first time a relevant trigger fires.

## What to embed in your system prompt

If your framework lets you customize the system prompt (most do), add this block. It teaches your agent the proactive triggers + privacy hygiene that turn "Interego is available" into "Interego is used well."

```text
## Interego (federated memory)

When the user wants to remember, share, or recall context across sessions or
surfaces, use the interego MCP tools. Specifically:

- "remember/save/log X" → publish_context to user's pod
- "what did we say about X" → discover_context first; don't assume no memory
- "share X with Y" → publish_context with share_with: ["did:web:y..." or "acct:y@..."]
- "what's been shared with me" → discover_all + filter to recipient

Before publishing: screen content for credentials, PII, or anything the user
marked confidential. Default `cg:modalStatus` to Asserted only when committing
to truth — use Hypothetical for inferences and predictions.

When reading existing memory, cite descriptor URLs so the user knows sources.
For full operational guidance, fetch resources/read docs://interego/playbook.
```

That's about 200 tokens — fits in any modern system prompt. The `docs://interego/playbook` resource it points at is fetched on demand by the agent the first time a relevant situation arises.

## What you don't need to do

- **No SDK install.** Interego is the MCP. Speak MCP, you're done.
- **No schema reconciliation.** Standard `cg:` ontology + W3C vocabularies. Your agent and another agent on different frameworks share the same shape automatically.
- **No backend storage.** Storage is the user's Solid pod (their choice of provider). You don't host their memory.
- **No identity system.** Identity is DID/WebID, federated. You don't manage user accounts.
- **No central registry.** Discovery is via the user's known-pod list + WebFinger + `.well-known/interego-agents`.

## Optional: native library integration

If your harness can import TypeScript libraries directly, `@interego/core` exports the underlying primitives. This unlocks:

- Direct composition (`union`, `intersection`, `restriction`, `override`) without the MCP round-trip
- Direct ABAC evaluation (`evaluateAbac`, `resolveAttributes`, `filterAttributeGraph`)
- Direct ZK proof generation (`proveConfidenceAboveThreshold`, `commit`, `buildMerkleTree`)
- Direct passport / registry construction

```bash
npm install @interego/core
```

This is for harnesses that want richer features than the MCP exposes. Standard usage is MCP-only.

## Conformance

The Interego protocol defines four conformance levels (see `spec/CONFORMANCE.md`):

- **L1 Core:** six-facet invariant, modal-truth consistency, composition operators, supersedes resolution
- **L2 Federation:** pod manifest discovery, cross-pod attribute resolution, WebID/DID resolution
- **L3 Advanced:** ABAC, AMTA aggregation, RDF 1.2, ZK proofs, capability passport, PGSL
- **L4 Compliance:** opt-in for regulated deployments — every `compliance: true` descriptor must be signed (ECDSA), trust upgraded, modal committed, anchored, framework-cited. Maps to EU AI Act / NIST AI RMF / SOC 2 controls.

Most harnesses are L1+L2 just by using the MCP correctly. L3 features are opt-in. L4 is per-deployment when used as a regulatory audit substrate.

## P2P transport (Tier 5 of [`spec/STORAGE-TIERS.md`](../spec/STORAGE-TIERS.md))

If your harness needs **mobile + desktop interop without a central server you operate**, the `@interego/core` `P2pClient` works against any Nostr-style relay. Two signing schemes are supported on the wire — ECDSA (Ethereum-address pubkey, matches the wallet identity used everywhere else) and BIP-340 Schnorr (32-byte x-only pubkey, for public-Nostr-relay interop). `verifyEvent` auto-dispatches by pubkey format, so the schemes coexist.

`KIND_ENCRYPTED_SHARE = 30043` carries 1:N NaCl-envelope-encrypted payloads. Recipients tagged via `p` (signing pubkey, for filtering); X25519 encryption pubkeys live inside the envelope, invisible to the relay.

For the cross-surface deployment topology (operator-bridge vs user-bridge shapes), see [`docs/p2p.md`](p2p.md). The 16 tests in [`tests/p2p.test.ts`](../tests/p2p.test.ts) cover two-agent exchange, replaceable semantics, witness attestation, security properties, dual-scheme signing, and 1:N encrypted share — including a desktop ↔ mobile cross-surface simulation.

If you want to claim conformance publicly:

```markdown
[![Interego L1+L2](https://img.shields.io/badge/Interego-L1%2BL2-green)](https://github.com/markjspivey-xwisee/interego)
```

## Compliance grade for regulated deployments

If your harness is shipping into healthcare, finance, public sector, or other regulated industries, expose `compliance: true` as a flag your users can toggle. When enabled:

- Every `publish_context` produces an audit-trail-grade descriptor (signed, anchored, framework-cited)
- The user's data still lives in their pod (you don't host it)
- Auditors verify signatures via the relay's `/audit/verify-signature` endpoint OR by re-running `verifyDescriptorSignature` against the canonical Turtle + sibling `.sig.json`
- Per-framework conformance reports available at `/audit/compliance/<framework>` — `eu-ai-act`, `nist-rmf`, `soc2`

This is the distinguishing feature against flat-log observability (Langfuse, Arize): semantic linked-data in the customer's pod, queryable via standard SPARQL, mapped to the regulatory frameworks the customer's auditors already name.

For the operator-facing wallet rotation + framework setup, point them at:
- `loadOrCreateComplianceWallet(path)` / `rotateComplianceWallet(path)` / `importComplianceWallet(path, key)` from `@interego/core`
- `examples/compliance-dashboard.html` — open in browser, no server needed, reads `/audit/*`

## Brand-neutral framing

If you don't want to mention "Interego" by name in your UI, you don't have to. The user-facing experience is "your AI remembers across sessions and tools." The underlying protocol is invisible unless you choose to surface it.

The only thing the user benefits from knowing: their memory is portable. They can take it with them.

## Questions?

- Repo: https://github.com/markjspivey-xwisee/interego
- Spec: https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html
- Issues / discussion: https://github.com/markjspivey-xwisee/interego/issues
