# `@interego/personal-bridge`

> Your local-first P2P hub for Interego. One URL, all your devices, no central server we operate.

## What this is

A small Node process you run on your own infrastructure (laptop / Raspberry Pi / NAS / Tailscale-exposed home server). It exposes:

- An **MCP server** at `POST /mcp` — any MCP client (claude.ai mobile, ChatGPT app, Claude Code, Cursor, custom) can connect to it as a custom connector.
- A **REST API** at `/api/*` — for non-MCP clients and the admin UI.
- An **admin UI** at `GET /` — status, sharing config, live event feed.
- An embedded **InMemoryRelay** so no external server is required for purely local-first operation.

Your data stays on your network unless you explicitly opt in to sharing.

## Why one URL forever

The right mental model is: **one bridge URL, all your devices**. You don't switch URLs to toggle local vs global.

- Default: bridge runs locally; data stays on your network.
- Per-publish opt-in: pass `share_with` to encrypt to specific recipients (the bridge handles the envelope; recipients need to be reachable through a common relay).
- Per-bridge opt-in: set `EXTERNAL_RELAYS=wss://relay.example.com,...` to mirror events to public Nostr relays so anyone watching them can see your published events.

There's no `local` / `global` switch because the model isn't binary. Sharing is a gradient — you choose per-thing.

## Quick start

```bash
cd examples/personal-bridge
npm install
npm run build
PORT=5050 BRIDGE_KEY=0xYOUR_PRIVATE_KEY npm start
```

You'll see:

```
@interego/personal-bridge running
  Bind:           http://0.0.0.0:5050
  Bridge pubkey:  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  Signing:        ecdsa
  Encryption pk:  ...base64...
  External relays: (none — fully local)

Point your MCP clients at:
  http://<your-host>:5050/mcp

Admin UI:  http://<your-host>:5050/
```

Open the admin UI in any browser to verify.

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `5050` | TCP port to bind |
| `BIND` | `0.0.0.0` | Bind address. Use `127.0.0.1` to firewall to the local machine. |
| `BRIDGE_KEY` | (test key) | Your wallet private key. **MUST be set in production.** Persist this for stable identity. |
| `SIGNING_SCHEME` | `ecdsa` | `ecdsa` (Ethereum-style address) or `schnorr` (BIP-340 x-only — for public-Nostr-relay interop). |
| `EXTERNAL_RELAYS` | `(empty)` | Comma-separated `wss://` URLs of public Nostr relays to mirror events to. Empty = fully local. |

## Connecting devices

Each MCP client points at the same bridge URL — that URL is your permanent identity hub.

| Device | How |
|---|---|
| Phone (claude.ai mobile, ChatGPT app) | Add custom MCP connector → `https://your-host.tailnet.ts.net:5050/mcp` (Tailscale, recommended) or `http://laptop.local:5050/mcp` (LAN, when on same network). |
| Desktop Claude Code | `.mcp.json` entry → `{"mcpServers":{"personal-bridge":{"url":"http://localhost:5050/mcp"}}}` (when bridge runs on same machine) or LAN/Tailscale URL when remote. |
| Cursor / Continue / Cline | Same shape — custom MCP server URL pointing at the bridge. |

For mobile to reach a desktop bridge across networks, **Tailscale is the right answer.** It gives you a stable hostname that works from anywhere, no port-forwarding, no public exposure.

## Tools the bridge exposes

| Tool | What it does |
|---|---|
| `publish_p2p` | Publish a descriptor announcement (kind 30040) to the local relay. Local-only by default; pass recipient pubkeys via `share_encrypted` for cross-recipient sharing. |
| `query_p2p` | Query descriptors by author / graph / facet. |
| `share_encrypted` | 1:N encrypted share (kind 30043). Each recipient needs both signing pubkey (for filtering) and X25519 encryption pubkey (for the envelope). |
| `query_my_inbox` | List encrypted shares addressed to this bridge. |
| `decrypt_share` | Decrypt one of those by event id. Returns plaintext or null. |
| `bridge_status` | Bridge identity, scheme, pubkeys, external relay config. |

## Sharing across people (multi-bridge federation)

To share with another person who also runs a bridge:

1. Both bridges set `EXTERNAL_RELAYS` to a common public Nostr relay (e.g., `wss://relay.damus.io`).
2. Their bridge publishes encrypted shares addressed to your signing pubkey + X25519 encryption pubkey.
3. Your bridge's `query_my_inbox` returns events matching your tag.
4. `decrypt_share` opens the envelope.

The relay sees: ciphertext + recipient signing pubkeys + topic. The relay does NOT see plaintext or your encryption keys. A non-recipient who fetches the event cannot decrypt it.

## v1 limitations

- **External relay forwarding is config-only in this version** — `EXTERNAL_RELAYS` is reflected in `/status` but the actual WebSocket forwarder isn't yet wired. For v1 the embedded `InMemoryRelay` only delivers to clients connected to the same bridge process. v1.1 plan: add a `WebSocketRelayMirror` adapter that forwards every event published to the local relay onto each configured external relay, and subscribes to incoming events from them.
- **No persistent storage of relay events** — events live in process memory. v1.1 plan: pluggable backing store (file or SQLite) for events.
- **No auth** — the bridge listens for whoever can reach the URL. Bind to `127.0.0.1` and access through Tailscale (which authenticates) for the simplest secure setup. Future: add bearer-token auth for direct internet exposure.

## Architecture

```
Your phone, desktop, etc.
       │
       │ MCP/HTTPS or REST
       ▼
┌──────────────────────────────────┐
│ @interego/personal-bridge        │
│  ├─ /mcp     Streamable HTTP MCP │
│  ├─ /api/*   REST endpoints      │
│  ├─ /events  SSE live feed       │
│  ├─ /        Admin UI            │
│  └─ embedded InMemoryRelay ─────┐│
└──────────────────────────────────┘
                                  │
                  optional        │
                  EXTERNAL_RELAYS │
                  (v1.1)          │
                                  ▼
                       Public Nostr relay(s)
                                  │
                                  ▼
                       Other people's bridges
```

## See also

- [`spec/STORAGE-TIERS.md`](../../spec/STORAGE-TIERS.md) — the 5-tier deployment ladder; this bridge is the recommended Tier 5 setup.
- [`docs/p2p.md`](../../docs/p2p.md) — full deployment topology + the cross-surface story.
- [`tests/p2p.test.ts`](../../tests/p2p.test.ts) — 16 tests of the underlying P2P transport.
