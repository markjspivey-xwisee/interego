# Mobile parity — using Interego from phone-based MCP clients

The Interego substrate is transport-neutral: it speaks MCP, and any
MCP-compatible client can mount it. This document covers what works
today on mobile and where the rough edges are.

## What works on mobile today

| Client | Surface | Status |
|---|---|---|
| **claude.ai web (iPhone Safari / Android Chrome)** | HTTP/SSE via relay's `/sse` | ✅ Works end-to-end — OAuth flow in-browser, passkey or wallet enrollment, tools render in the conversation. The cleanest mobile experience. |
| **Claude iOS / Android app** | Custom connectors (Settings → Connectors → Add custom) | ✅ Works — same SSE endpoint. Adds the relay as a tool source for any conversation. |
| **ChatGPT iOS / Android app** | Custom connectors (subscription tier dependent) | ✅ Works on supported tiers. Same SSE endpoint. |
| **Hermes Agent (any backend)** | Modal / Daytona / SSH backend | ✅ Works headlessly — Hermes on Modal hibernates between turns, wakes when paged via Discord / Telegram / Slack / WhatsApp / Signal / SMS. Mobile users interact through the messaging app; the relay talks to Hermes' Modal endpoint. |
| **Cursor mobile** | (No mobile client) | ❌ Cursor is desktop-only. Same code via Hermes-on-Modal or claude.ai works around it. |
| **OpenClaw mobile** | (No mobile client) | ❌ Same as Cursor. Run on a VPS / home server and access via SSH from mobile if you want OpenClaw specifically. |

## Onboarding on mobile

Identical to desktop:

1. Open `https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io/` in mobile Safari / Chrome.
2. Tap **Passkey** (or **Wallet** if you have a mobile wallet like MetaMask Mobile / Coinbase Wallet).
3. iOS Face ID / Android biometrics handles the WebAuthn ceremony. Your passkey lives in iCloud Keychain or Google Password Manager — synced across your devices.
4. Visit `/dashboard` to see your DID + inbox.

**One catch:** mobile browsers handle the OAuth callback redirect
differently than desktop. claude.ai mobile + Claude iOS handle the
redirect cleanly. Some third-party clients (e.g. older ChatGPT
versions, certain Android browsers) may require manually copying the
callback URL into the client. Modern WebAuthn-aware clients handle
this transparently.

## Cross-device passkey

Apple's iCloud Keychain and Google Password Manager sync your passkey
across your devices automatically. You enroll once on your phone and
the same passkey is available on your laptop without re-enrollment.

For hardware-key users (YubiKey, etc.) on mobile: iOS supports
USB-C / Lightning hardware keys directly via the WebAuthn flow.
Android supports USB and BLE hardware keys.

## Push-to-act flows

For "your agent should act when something happens on the pod" patterns
(the Demo 21-style autonomous coordination from a phone), the
recommended setup is:

1. **Run Hermes Agent on Modal** — serverless, hibernates when idle,
   wakes when paged.
2. **Configure Hermes to receive events from Telegram / Discord /
   Slack / WhatsApp / Signal / SMS** — Hermes' gateway supports all of
   these out of the box.
3. **Add Interego as an MCP server** in Hermes' config (see
   [OAUTH-SETUP.md](../deploy/mcp-relay/OAUTH-SETUP.md) §Hermes).
4. **Subscribe Hermes to your pod** — `subscribe_to_pod` with your
   pod URL. New descriptors trigger Hermes' attention; it can reply
   via the messaging channel.

Result: you message Hermes from your phone via WhatsApp ("did Alice
share anything new?"), Hermes consults the substrate, replies in
WhatsApp. No mobile-specific Interego client needed.

## Known mobile rough edges

| Issue | Workaround |
|---|---|
| Mobile keyboard doesn't show special characters needed for some bearer tokens | Use the dashboard's Copy buttons to avoid manual typing |
| Smaller screens occasionally cut off long DIDs in the dashboard's `<code>` blocks | Tap Copy and paste into another app to verify the full string |
| Some Android browsers don't autocomplete passkey IDs across sites | Re-enroll on the specific device if cross-device sync fails. Rare. |
| `claude.ai` connector cache may stick to an old token | Sign out + sign back in via claude.ai's Connector settings |

## Architecturally pure: there's no "mobile" in the protocol

Every interaction is HTTP + RDF. Mobile vs. desktop is purely a
client concern. The relay doesn't know or care whether the SSE
connection is from a phone, a laptop, a CI runner, or a serverless
function on Modal — it issues the same OAuth tokens and serves the
same tool surface.

This is the substrate-stays-substrate principle from the
architectural foundations: the protocol is technology-neutral; the
clients run on whatever shape suits the user.

## See also

- [OAUTH-SETUP.md](../deploy/mcp-relay/OAUTH-SETUP.md) — per-client OAuth setup
- [`docs/integrations/agent-runtimes-mcp.md`](integrations/agent-runtimes-mcp.md) — Path 1 integration recipes (covers Hermes-on-Modal in detail)
- Hermes Agent docs: https://hermes-agent.nousresearch.com/docs/
