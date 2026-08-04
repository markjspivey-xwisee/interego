# Cross-device test plan — actual phone + actual desktop

What's tested in CI is real code on real WebSocket transport, but it all runs in one process. **What CI cannot prove is the cross-device deployment**: an actual phone running claude.ai or ChatGPT mobile, an actual desktop running Claude Code, both connected to one personal-bridge, exchanging real memory.

That test happens on your hardware. This document is the runbook.

Read the split precisely, because the earlier wording here overstated it. The suite already proves the protocol layer and those runs are evidence: `tests/p2p.test.ts` exercises publish → query → live subscribe between two clients that share nothing but a relay, `tests/personal-bridge.test.ts` exercises all six bridge tools through the same handlers `/mcp` dispatches to, and `tests/file-backed-relay.test.ts` exercises restart replay against a temp file. What no in-process run can substitute for is the physical boundary: two separate devices, two vendor MCP clients we do not control, and a real network between them. This runbook covers that residue and nothing wider.

**No run of this has been published yet.** Until one is, treat the cross-device claim as untested rather than proven, and record what you get in [Recorded runs](#recorded-runs) below.

---

## Prerequisites

- A device running the personal bridge (laptop, Pi, NAS, home server). For mobile-from-anywhere, this device should be reachable over Tailscale or have a public hostname with TLS.
- A phone with claude.ai or ChatGPT installed, signed in, with custom MCP connector support.
- A desktop with Claude Code installed.
- Optional: a second machine to act as a peer (for the multi-bridge test).

---

## Setup

### 1. Run the bridge

On your bridge device:

```bash
git clone https://github.com/markjspivey-xwisee/interego.git
cd interego
npm install
npm run build
cd examples/personal-bridge
npm install
npm run build
# A phone has to reach this bridge, so it binds past loopback — which REQUIRES a
# credential. The bridge refuses to start on a non-loopback BIND without one, because
# it holds the X25519 key derived from BRIDGE_KEY: anyone who can reach the port
# could otherwise list your encrypted inbox and decrypt it.
export BRIDGE_TOKEN=$(openssl rand -hex 32)
BIND=0.0.0.0 PORT=5050 BRIDGE_KEY=0x<your-private-key> BRIDGE_TOKEN=$BRIDGE_TOKEN node dist/server.js
```

You should see:

```
@interego/personal-bridge running
  Bind:           http://0.0.0.0:5050
  Bridge pubkey:  0x...
  Auth:           Bearer token required (BRIDGE_TOKEN)
  ...
```

Open `http://localhost:5050/?access_token=$BRIDGE_TOKEN` in any browser on the same machine — the admin UI should load, and the address bar should end up with the token stripped out of it.

### 2. Make the bridge reachable from your phone

Pick one:

- **Tailscale (recommended).** Install Tailscale on the bridge device; note its `*.tailnet.ts.net` hostname. Install Tailscale on your phone. Bridge URL becomes `https://your-bridge.tailnet.ts.net:5050/mcp`.
- **LAN (same network only).** Use your bridge device's mDNS hostname (`laptop.local`) or LAN IP. Bridge URL becomes `http://laptop.local:5050/mcp`.
- **Public hostname + TLS.** Reverse proxy via Caddy or Cloudflare Tunnel for `https://bridge.yourname.com/mcp`. More setup; not recommended for personal use.

### 3. Connect Claude Code (desktop)

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "personal-bridge": {
      "url": "http://localhost:5050/mcp",
      "headers": { "Authorization": "Bearer <your BRIDGE_TOKEN>" }
    }
  }
}
```

(Or the same Tailscale/public URL the phone uses, if the bridge is on a different machine.) The `headers` entry is not optional once `BRIDGE_TOKEN` is set — without it every call returns `401 {"error":"bridge credential required"}`.

Restart Claude Code. You should see `personal-bridge` show up in the MCP servers list with 6 tools (publish_p2p, query_p2p, share_encrypted, query_my_inbox, decrypt_share, bridge_status).

### 4. Connect your phone (claude.ai or ChatGPT)

Open the app, go to settings → custom MCP connectors → add new. URL: the bridge URL from step 2, plus an `Authorization: Bearer <your BRIDGE_TOKEN>` header if the client supports custom headers. If it does not, this is the point at which the runbook stops — do not work around it by unsetting `BRIDGE_TOKEN`, because a bridge reachable from a phone with no credential is reachable by anything else on that path too. Record the client and its limitation in [Recorded runs](#recorded-runs).

The app should successfully connect and discover the same 6 tools.

---

## Tests to run

Each test passes if you can reproduce the listed observation. Track each one — the value is the **complete chain** working, not any single step.

### Test 1 — desktop publishes, phone reads

1. **On desktop (Claude Code):**
   ```
   Use personal-bridge:publish_p2p with descriptorId='urn:iep:test:from-desktop',
   cid='bafkrei-from-desktop', graphIri='urn:graph:cross-device-test',
   summary='hello from my laptop'
   ```
2. **On phone (claude.ai or ChatGPT):**
   ```
   Use personal-bridge:query_p2p with graphIri='urn:graph:cross-device-test'
   ```

**PASS** if the phone returns one descriptor whose summary is "hello from my laptop" and whose publisher matches the bridge's pubkey.

### Test 2 — phone publishes, desktop reads

Reverse of Test 1. Publish from phone, query from desktop. Same expectation.

### Test 3 — bridge admin UI shows live activity

Open the bridge admin UI in any browser. Run Tests 1 and 2 again. Verify that:

- The "Local events" counter increments
- The live event feed shows each new descriptor with its sender pubkey
- The "Sharing mode" badge says "Local-only"

### Test 4 — verify nothing leaves your network

While running Test 1, on the bridge device:

```bash
# Linux/macOS
sudo tcpdump -i any -nn 'tcp and not port 22 and not src host 127.0.0.1 and not dst host 127.0.0.1'
```

Or use Little Snitch / equivalent. Run a publish from the phone, observe the bridge.

**PASS** if the only traffic is between phone ↔ bridge (Tailscale or LAN). No connections to public Nostr relays, no calls to any third party we don't operate.

### Test 5 — encrypted share to a second person

Requires a second person with their own bridge.

1. Both bridges set `EXTERNAL_RELAYS=wss://relay.damus.io` (or any common public Nostr relay).
2. Bob's bridge owner runs `bridge_status` and reports their `bridgePubkey` + `encryptionPubkey`.
3. Alice (you) runs `share_encrypted` with Bob's pubkeys + a test plaintext.
4. Bob runs `query_my_inbox` then `decrypt_share` on the resulting event ID.

**PASS** if Bob reads the plaintext Alice sent, and the relay only ever sees ciphertext (verify by checking the relay's events tab if it exposes one, or by knowing how NIP-44 works).

### Test 6 — restart resilience

Restart the bridge process. Reconnect from phone + desktop, then re-run the Test 1 query.

**PASS** if the descriptor published before the restart is still returned, with the same `eventId`, and new publishes work without re-pairing.

Persistence is on by default: the bridge appends to `BRIDGE_DATA_DIR/events.jsonl` (default `~/.interego-bridge`), encrypted at rest under a key derived from `BRIDGE_KEY`, and replays the file on boot. `GET /status` reports `persistence.mode: "file-backed"` when it is on. Set `BRIDGE_PERSIST=0` for the volatile in-memory relay, in which case the same restart does leave the descriptor gone — that is the opt-in, not the default.

---

## What a successful run proves

If all 6 tests pass on your kit:

1. The protocol works end-to-end across real device boundaries.
2. Local-first is real — Tests 1-4 prove no data leaves your network.
3. Cross-bridge federation is real — Test 5 proves it works against actual public Nostr infrastructure (when opted in).
4. The bridge does what it says.

---

## Recorded runs

| Date | Operator | Bridge host | Phone client | Tests 1-4 | Test 5 | Test 6 | Notes |
| ---- | -------- | ----------- | ------------ | --------- | ------ | ------ | ----- |
| _(none yet)_ | | | | | | | |

This is the ledger the header points at. An empty table means the cross-device path has never been run end-to-end on real hardware by anyone, which is the current state. Add a row when you run it, including failures — a recorded failure is worth more than an absent row.

---

## What to file as a bug

If any test fails:

- Capture the bridge's stderr (the `node dist/server.js` output)
- Capture the admin UI's `/status` JSON
- Capture the phone-app or Claude-Code MCP log if available
- Open an issue at https://github.com/markjspivey-xwisee/interego/issues

Tests 5 + 6 specifically depend on parts of the system (WebSocketRelayMirror v1.1 + persistence) that have unit tests but the manual cross-device path may surface real-world cases the unit tests don't cover.
