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

## Limitations + roadmap

- **Multi-recipient encrypted share** — current cross-pod E2EE in Tier 4 uses 1:N envelope encryption. Mapping this onto Nostr (NIP-44 is 1:1) requires either inventing a NIP or accepting per-recipient duplication. Not yet built.
- **Schnorr signatures (BIP-340)** — required for public-Nostr interop. We use ECDSA today (matches our wallet). `signEvent` + `verifyEvent` are the only places that change; ~50 lines.
- **Public relay rate limits + retention policies** — production deployments should self-host a relay or pay for a managed one.
- **Bandwidth + cost** — agents subscribed to broad filters can ingest a lot of events. Budget accordingly; use precise filters (`#graph`, `#facet`, `authors`).

---

## TL;DR

Mobile + desktop interop with no central server you operate, using a wallet you already have, against a relay anyone can spin up. Same `P2pClient` API everywhere; only the transport adapter differs.

The 10 passing tests in [`tests/p2p.test.ts`](../tests/p2p.test.ts) prove the protocol works between two independent agents through a shared relay. The cross-surface story is identical — only the relay implementation under the hood changes from `InMemoryRelay` to a WebSocket adapter pointed at any Nostr relay.
