# Your first hour with Interego

A guided tour for someone who has been told "Interego is federated
shared memory for AI agents" and wants to actually try it. No CLI
required for the basics. Each step takes 1–5 minutes.

## You'll need

- A phone or laptop with a browser
- A passkey-capable device (Face ID / Touch ID / Windows Hello / hardware key) OR a Web3 wallet (MetaMask / Coinbase Wallet)
- An MCP-compatible AI client — claude.ai, Claude Code, Claude Desktop, Cursor, Hermes Agent, or OpenClaw all work
- ~30 minutes (most of which is the AI client doing the work)

You do **not** need: an API key, an email address, a password, a credit card, or to install anything (beyond the AI client itself, which you probably already have).

---

## Step 1 — Enroll an identity (2 min)

Open: **https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io/**

You'll see three big buttons. Pick whichever fits your device:

- **Passkey** (recommended) — fastest. Your phone / laptop's biometric handles the cryptography. Your private key never leaves your device.
- **Wallet** — if you already have MetaMask or Coinbase Wallet installed. Click "Wallet" and the page redirects to a wallet-connection flow.
- **DID** — developer flow. Skip this unless you know what you're doing.

After enrollment, you have:
- A **DID** (decentralized identifier) — a string like `did:web:interego-identity.../users/u-pk-a3f9c2e1b4d7`. This is the canonical pointer to YOU on the substrate. Save it.
- A **pod** — your personal space on the shared infrastructure. You don't manage it; it's allocated automatically.
- A **bearer token** — issued to your browser tab. Used by the dashboard.

## Step 2 — See your dashboard (1 min)

Visit: **https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io/dashboard**

You'll see four panels:

| Panel | What it shows |
|---|---|
| **Your Identity** | Your DID, WebID, pod URL, primary agent DID. Each has a Copy button — share these with a friend so they can send you context. |
| **Registered Credentials** | The passkeys / wallets / DIDs registered to your account. Add another so you have a backup (see [Recovery Flows](RECOVERY-FLOWS.md) §3 — strongly recommended before relying on this). |
| **Inbox** | Recent descriptors on your pod (last 7 days). Empty for now — you'll publish into it in Step 4. |
| **Sign out everywhere** | One-click token revocation. |

## Step 3 — Wire up your AI client (3 min)

Pick your client and follow the matching section of [OAUTH-SETUP.md](../deploy/mcp-relay/OAUTH-SETUP.md):

- **claude.ai** (web) — Settings → Connectors → Add custom connector → paste `https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/sse`. Click Connect.
- **Claude iOS / Android app** — Settings → Connectors → Add custom → same URL.
- **Claude Code (CLI)** — add 5 lines to `~/.claude.json`, restart Claude Code, first tool call triggers the OAuth browser flow.
- **Cursor / Cline / Windsurf / Hermes / OpenClaw** — see the per-client recipes in the OAuth setup doc.

The first call from your client opens a browser window at the relay's `/authorize` page. You'll see a method picker — pick the credential you enrolled in Step 1, sign the challenge, and the page closes automatically.

Your client now has access to ~60 substrate primitives. The most useful ones are:

| Primitive | What it does |
|---|---|
| `publish_context` | Write a typed memory / fact / note to your pod |
| `discover_context` | Search your pod for memories matching a query |
| `discover_all` | Federated discovery — search all subscribed pods |
| `subscribe_to_pod` | Watch a friend's pod for new descriptors |
| `register_agent` | Make your agent discoverable to other agents |

## Step 4 — Publish your first memory (1 min)

In your AI client, prompt something like:

> "Remember that my favorite color is blue. Use Interego to save this."

The client will pick up the `publish_context` tool. The new descriptor lands on your pod with proper modal status (`Asserted`), provenance attribution (you signed it), and a timestamp.

Refresh your dashboard inbox — the new descriptor appears with an `Asserted` pill.

## Step 5 — Recall it later (instant)

Different conversation, same AI client:

> "What's my favorite color?"

The client calls `discover_context` first (per the playbook's proactive triggers), finds your descriptor, and answers. The substrate doesn't replace the AI's reasoning — it just gives it a place to remember across sessions, agents, and devices.

## Step 6 — Share with a friend (5 min)

Give your friend your DID (Copy button on the dashboard's Identity panel). They go through Steps 1–3 themselves, then send you THEIR DID. Now:

> "Share my Lisbon trip plan with `did:web:...:users:u-pk-yourBrother...`."

`publish_context` runs with `share_with: [<friend's DID>]`. The substrate:
1. Resolves the recipient's pod URL from their DID
2. Encrypts the descriptor to their X25519 public key (E2EE — the relay sees only ciphertext)
3. Writes to BOTH your pod (so you have a copy) and theirs (so they can find it)

Your friend refreshes their dashboard inbox and sees a new descriptor from you. Their AI client decrypts when prompted. No central server saw the content.

## Step 7 — Subscribe to their pod (1 min)

> "Subscribe to my brother's pod at his pod URL."

`subscribe_to_pod` wires a notification channel. New descriptors from him stream to your agent without polling. Cross-pod federation, no central directory.

## Step 8 — Audit who has access (1 min)

Anytime, visit `/dashboard` and inspect the Credentials panel. If you see an agent or device you didn't enroll, click Remove. The audit endpoints on the relay (`/audit/events`, `/audit/lineage`) walk the full history for any descriptor — you can trace any claim back to its source.

If you suspect your bearer token leaked, click **Sign out everywhere**. All your active tokens are revoked; you'll re-authenticate next time any client calls a tool.

## What you've just experienced

Five protocol primitives, four browser visits, no CLI:

1. **Cryptographic identity** without a password — your device holds your key
2. **Personal pod** as your source of truth — no centralized service owns your data
3. **Typed memory** with modal status + provenance + supersedes chains
4. **End-to-end encrypted federated sharing** — the relay routes, but doesn't read
5. **Audit-walkable history** — every descriptor is traceable

Each of these composes from the same substrate primitive — `publish_context` — with different facets attached.

## Where to go next

| You want to… | Read |
|---|---|
| Understand how the substrate composes from L1 primitives | [`spec/architecture.md`](../spec/architecture.md) |
| See multi-agent autonomous coordination in action | [`demos/scenarios/22-game-design-build-play.ts`](../demos/scenarios/22-game-design-build-play.ts) (autonomous game) or `23-zero-copy-semantic-layer.ts` (federated semantic layer) |
| Integrate Interego with an existing app | [`docs/integrations/agent-runtime-integration.md`](integrations/agent-runtime-integration.md) — the five paths (MCP / OpenClaw memory / skills / compliance / Hermes memory) |
| Set up Interego for compliance / audit purposes | [`spec/SOC2-PREPARATION.md`](../spec/SOC2-PREPARATION.md) + [`integrations/compliance-overlay/`](../integrations/compliance-overlay/) |
| Lose a credential / migrate pod / rotate a key | [`docs/RECOVERY-FLOWS.md`](RECOVERY-FLOWS.md) |
| Use Interego from mobile | [`docs/MOBILE-PARITY.md`](MOBILE-PARITY.md) |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Landing page shows 404 | Wrong URL — you opened the relay URL instead of identity-server URL | Use the `-identity.` host |
| Passkey enrollment fails with "WebAuthn not supported" | Browser doesn't support WebAuthn (old Safari, very old Android Chrome) | Use the Wallet flow instead |
| AI client can't connect to the relay | Probably the cold-start (Azure Container Apps scales to zero) | Retry once; subsequent calls are warm |
| Dashboard shows "could not load identity" | Bearer token expired (1h) or never set | Re-authenticate through your AI client |
| Tool call returns "rate_limit_exceeded" | 30 enrollments / minute / IP | Wait 60 seconds; the limit is generous for legitimate use |
| Inbox shows 0 items but you published one | Default window is 7 days; pod URL mismatch | Click the Identity panel's Pod URL and verify it matches your AI client's config |

## Honest scoping

What this guide does NOT cover yet:

- **Cross-pod pubkey rotation** — if a recipient rotates their X25519 key, older E2EE-shared descriptors aren't re-encrypted. Recipients should consume shared descriptors before rotating, or contact the publisher to re-share. Protocol-level rollover is on the roadmap.
- **Multi-device passkey sync edge cases** — iCloud Keychain and Google Password Manager handle most of this, but cross-OS sync (iCloud passkey ↔ Android device) requires QR-based handoff.
- **Operator-side admin** — managing the deployment itself (rotating the identity-server keypair, scaling Azure Container Apps, etc.) is documented in [`spec/OPS-RUNBOOK.md`](../spec/OPS-RUNBOOK.md). Not part of the first-hour consumer flow.

If you hit something that should work but doesn't, file an issue at https://github.com/markjspivey-xwisee/interego/issues. The project is open source and the substrate is meant to stay that way.
