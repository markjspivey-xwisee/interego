# P2P Transport — Cross-Surface Deployment Guide

**Status:** shipped (Tier 5 of [`spec/STORAGE-TIERS.md`](../spec/STORAGE-TIERS.md)).

The same wallet on your phone and your desktop can publish, query, and subscribe to descriptor announcements through a shared relay — no central server you operate, no special mobile build, no NAT punching.

This doc covers the deployment topology. The protocol surface is documented in [`src/p2p/`](../src/p2p/) and tested in [`tests/p2p.test.ts`](../tests/p2p.test.ts).

---

## What "P2P" means here

We use **relay-mediated P2P** in the Nostr sense:

- Relays are commodity, anyone can run one, multiple per client.
- No relay is authoritative — clients aggregate from several.
- Identity lives in the client's wallet; relays never hold private keys.
- Relays only store + forward signed events; they have no logic and can't censor undetectably.

This is *federated*, not strictly *peer-to-peer*. We make the call deliberately because:

1. **Mobile clients can't run libp2p nodes.** Phones can't keep a DHT alive on a battery; browsers have limited transport options. Mobile-first → relay-mediated.
2. **The Nostr ecosystem already exists.** Public relays everywhere; well-tooled; well-understood. Reusing it is cheaper than rebuilding it.
3. **The protocol surface is unchanged from what a true libp2p tier would look like.** When NAT-traversed mobile P2P becomes practical, the `P2pRelay` interface gets a libp2p implementation; nothing else changes.

---

## The pieces

```
┌─────────────────┐                       ┌─────────────────┐
│ claude.ai mobile│                       │  Claude Code    │
│ ChatGPT app     │                       │  on desktop     │
│ (or any MCP     │                       │  (MCP stdio)    │
│  client)        │                       │                 │
└────────┬────────┘                       └────────┬────────┘
         │ WebSocket                                │ WebSocket
         │ (signed Nostr-shaped events)             │
         │                                          │
         ▼                                          ▼
    ┌─────────────────────────────────────────────────────┐
    │  Nostr relay (any conformant one)                   │
    │  - public: relay.damus.io, nos.lol, ...             │
    │  - private: nostr-rs-relay on your VPS              │
    │  - in-memory: InMemoryRelay (tests)                 │
    └─────────────────────────────────────────────────────┘
                          │
                          │ replicates events to other relays
                          │ (multi-relay clients fan out)
                          ▼
    ┌─────────────────────────────────────────────────────┐
    │  Other relays in the federation                     │
    └─────────────────────────────────────────────────────┘

Identity:    same secp256k1 wallet on every surface
Storage:     descriptor BYTES live in IPFS / Solid pod / inline
             the relay event carries the CID + summary, not the bytes
Discovery:   Nostr filters (kinds, authors, tag values, time)
Notification: relay subscriptions deliver events as they arrive
```

The shared object is the wallet. The shared infrastructure is the relay URL. Everything else is per-surface configuration.

---

## Wiring it up

### Desktop — Claude Code via the MCP

The MCP server already imports `@interego/core`. Add a P2P subscription that runs in the background and surfaces incoming descriptors as MCP notifications:

```ts
import { P2pClient, importWallet } from '@interego/core';
import { WebSocketRelay } from './your-websocket-adapter.js';
// ^ A 100-line adapter that implements P2pRelay over WebSocket per
//   the NIP-01 wire protocol. We don't ship one yet because we want
//   to keep @interego/core dependency-free; adapters live in
//   downstream apps.

const wallet = importWallet(process.env.CG_PRIVATE_KEY!, 'agent', 'desktop-claude-code');
const relay = new WebSocketRelay('wss://relay.example.com');
const p2p = new P2pClient(relay, wallet);

// Surface incoming descriptors to the user as they arrive
p2p.subscribeDescriptors({ /* filter */ }, (announcement) => {
  // emit an MCP notification, or stash for the next tool call
});
```

Set `CG_P2P_RELAY=wss://relay.example.com` in your MCP config to enable.

### Mobile — claude.ai app or ChatGPT app

Mobile clients connect to MCP servers via HTTPS. The bridge that does the WebSocket connection to the Nostr relay lives at the MCP server — *not* on the phone. The mobile app's view is exactly the same MCP tool calls it uses today; the underlying transport is the relay.

Two deployment shapes:

**Shape A — operator runs an MCP-relay bridge:**
- You deploy `@interego/mcp-relay` on a server, plus the WebSocket relay adapter.
- Mobile app connects via HTTPS/SSE to your MCP relay (same way it connects to any other custom connector today).
- The MCP relay translates tool calls into P2P events on the Nostr relay.
- Pros: zero phone-side configuration. Cons: you're operating a server.

**Shape B — user provides their own bridge:**
- The user runs a small "personal MCP relay" on their always-on device (home server, Raspberry Pi, NAS) — just a Node process that imports `@interego/core` + a WebSocket adapter.
- Their phone's MCP client points at *their* personal MCP relay over their LAN or via Tailscale.
- The personal MCP relay handles the Nostr WebSocket; the phone never speaks Nostr directly.
- Pros: no shared operator; truly user-owned. Cons: requires an always-on home device.

Both shapes work today. Both produce the same protocol-level behavior: the user's wallet signs events; events flow through the chosen Nostr relay; the user's other surfaces see them.

---

## Relay choices

| Relay | What it gives you |
|---|---|
| **Public Nostr relay** (e.g., wss://relay.damus.io, wss://nos.lol) | Zero ops; immediate global reach; subject to relay's policies |
| **Self-hosted nostr-rs-relay** | Full control over retention, rate limits, allow-lists; one Docker container |
| **`InMemoryRelay`** | Single-process simulation for tests + local dev |
| **Multi-relay (client connects to N)** | Censorship-resistance; one relay can't drop your events; client aggregates |

For audit-grade or compliance use, recommend self-hosted relay + multi-relay broadcast. For personal multi-device use, public relays work fine.

---

## What the relay sees

Relays see the **announcement event**, not the descriptor body:

- Event author (your wallet's pubkey)
- Descriptor IRI (`d` tag — used for replaceability)
- IPFS CID of the descriptor turtle (`cid` tag)
- Graph IRI (`graph` tag)
- Facet types (`facet` tags) — e.g., "Temporal", "Trust"
- `dct:conformsTo` IRIs (`conformsTo` tags)
- Optional summary in `content`

What the relay does NOT see: your descriptor's actual claim data, encrypted envelopes, attribute values, etc. Those live in the IPFS-anchored bytes (or your Solid pod), and only key holders can read them.

If you need to keep even the announcement private, encrypt the `content` field with NIP-44 (1:1) or set up an Interego-only private relay with allow-listed pubkeys.

---

## Testing your setup

The 10 tests in [`tests/p2p.test.ts`](../tests/p2p.test.ts) all run against `InMemoryRelay`. To validate against a real relay:

1. Implement a `WebSocketRelay` class that satisfies `P2pRelay` (publish via `["EVENT", event]`, query via `["REQ", subId, filter]`, etc. — see NIP-01).
2. Substitute it for `InMemoryRelay` in the tests.
3. Run against a public relay or a local `nostr-rs-relay` container.

The same code passes; only the transport changes.

---

## Two-scheme signing (ECDSA + Schnorr coexist)

Every `P2pClient` is configured with one signing scheme but the verifier handles both:

```ts
// Internal-only events: ECDSA, Ethereum-address pubkey
const internal = new P2pClient(relay, wallet, { signingScheme: 'ecdsa' });

// Public-Nostr interop: Schnorr (BIP-340), x-only pubkey
const publicNostr = new P2pClient(relay, wallet, { signingScheme: 'schnorr' });

// Same wallet, two pubkey representations:
internal.pubkey      // 0x... (42 chars)
publicNostr.pubkey   // 8318... (64 hex, no prefix)
```

The wire format auto-dispatches: `verifyEvent(e)` looks at `pubkey` length / prefix and routes to the correct verifier. A relay can carry events of both schemes simultaneously; clients filter by author transparently.

Why this matters: an Interego deployment can run on private relays with ECDSA (matching the wallet identity used everywhere else in the protocol — compliance signing, x402, SIWE), AND publish to public Nostr relays with Schnorr-signed events that interop with non-Interego Nostr clients. One wallet, two faces, full ecosystem participation.

## 1:N encrypted share

Tier 4 cross-pod sharing uses 1:N NaCl envelope encryption (one content key, wrapped per recipient). Tier 5 reuses exactly that envelope, wrapped in a custom event kind (`KIND_ENCRYPTED_SHARE = 30043`):

```ts
await alice.publishEncryptedShare({
  plaintext: 'sensitive payload',
  recipients: [
    { sigPubkey: bob.pubkey, encryptionPubkey: bobX25519PublicKey },
    { sigPubkey: carol.pubkey, encryptionPubkey: carolX25519PublicKey },
  ],
  senderEncryptionKeyPair: aliceX25519KeyPair,
  topic: 'finance-q3',
});

// Bob queries shares addressed to him; decrypts with his X25519 key
const inbox = await bob.queryEncryptedShares({ recipientSigPubkey: bob.pubkey });
const plaintext = bob.decryptEncryptedShare(inbox[0]);
```

The relay sees:
- Ciphertext (the envelope)
- Recipients' signing pubkeys (in `p` tags — required so each recipient can filter for "events addressed to me")
- Optional `topic` tag

The relay does NOT see:
- The plaintext
- The recipients' encryption keys (those are X25519, separate from signing pubkeys)
- Whether decryption succeeds for any given recipient

A non-recipient who fetches the event can attempt decryption — and it fails. The wrapped keys are encrypted to specific X25519 pubkeys; without the matching secret key the content key cannot be unwrapped.

This is identical to the Tier 4 cross-pod share security model — only the transport differs.

## Limitations + roadmap

- **Public relay rate limits + retention policies** — production deployments should self-host a relay or pay for a managed one.
- **Bandwidth + cost** — agents subscribed to broad filters can ingest a lot of events. Budget accordingly; use precise filters (`#graph`, `#facet`, `authors`).
- **`KIND_ENCRYPTED_SHARE` is currently an Interego-only kind** — public Nostr clients without our adapter won't decode the envelope. Encrypted-share interop with the broader Nostr ecosystem would require either a NIP submission or a NIP-44 (1:1) duplicate-per-recipient adapter.

---

## TL;DR

Mobile + desktop interop with no central server you operate, using a wallet you already have, against a relay anyone can spin up. Same `P2pClient` API everywhere; only the transport adapter differs.

The 16 passing tests in [`tests/p2p.test.ts`](../tests/p2p.test.ts) prove the protocol works between two independent agents through a shared relay (including dual-scheme signing and 1:N encrypted share). The cross-surface story is identical — only the relay implementation under the hood changes from `InMemoryRelay` to a WebSocket adapter pointed at any Nostr relay.

## Ready-to-run reference: `@interego/personal-bridge`

If you want a single Node process that **embodies the whole local-first story**, see [`examples/personal-bridge/`](../examples/personal-bridge/):

- One `npx`-shaped binary (`node dist/server.js` for now).
- Exposes `POST /mcp` (Streamable HTTP MCP), `/api/*` REST, `GET /` admin UI.
- Embeds `InMemoryRelay` so no external relay is required.
- Default behavior: **truly local** — `EXTERNAL_RELAYS` env var is empty, nothing leaves the bridge unless you opt in.
- All your devices point at the same URL forever (Tailscale or LAN). Sharing is per-publish (`share_with`) or per-bridge (`EXTERNAL_RELAYS` for broadcast).

This is the recommended Tier 5 deployment for a single user with multiple devices. To share with another person, both bridges add the same public Nostr relay (or a self-hosted one) to `EXTERNAL_RELAYS` and exchange recipient pubkeys.
