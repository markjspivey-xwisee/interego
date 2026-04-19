# @interego/mcp

**MCP server for [Interego](https://github.com/markjspivey-xwisee/interego)** — exposes 25 tools for publishing, discovering, composing, and reasoning over typed knowledge graphs through Solid pods. Compatible with Claude Code, Claude Desktop, Cursor, Windsurf, Cline, and any other MCP client.

## Install

```bash
# No install needed — npx fetches it on demand
npx -y @interego/mcp
```

Or pin it globally:

```bash
npm install -g @interego/mcp
context-graphs-mcp
```

## Configure your MCP client

### Claude Code

Edit `~/.claude.json` (or your project's `.claude/mcp.json`):

```jsonc
{
  "mcpServers": {
    "interego": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

Restart Claude Code. The tools will appear under the `mcp__interego__*` prefix.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```jsonc
{
  "mcpServers": {
    "interego": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your workspace:

```jsonc
{
  "mcpServers": {
    "interego": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```jsonc
{
  "mcpServers": {
    "interego": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

## What you get

Once configured, your AI agent has these 25 tools available:

| Category | Tools |
|---|---|
| **Identity** | `setup_identity`, `link_wallet`, `register_agent`, `verify_agent`, `revoke_agent` |
| **Publishing** | `publish_context` (with optional `share_with`), `publish_directory` |
| **Discovery** | `discover_context`, `discover_all`, `discover_directory`, `get_descriptor`, `resolve_webfinger`, `list_known_pods`, `get_pod_status` |
| **Federation** | `add_pod`, `remove_pod`, `subscribe_to_pod`, `subscribe_all` |
| **PGSL substrate** | `pgsl_ingest`, `pgsl_resolve`, `pgsl_lattice_status`, `pgsl_meet`, `pgsl_to_turtle` |
| **Reasoning** | `analyze_question` |
| **Wallet** | `check_balance` |

### What `publish_context` actually does

Not just a Solid PUT. Each call:

1. **Encrypts the graph payload** as an X25519 envelope (`nacl.box` + XSalsa20-Poly1305). Every non-revoked `cg:AuthorizedAgent` on the target pod with a registered `cg:encryptionPublicKey` becomes a recipient — same content readable from every one of your surfaces (VS Code, Desktop, Mobile, claude.ai), unreadable by anyone else including the storage provider.
2. **Auto-registers this agent** on the target pod if it isn't already, with its X25519 public key + a delegation credential. Per-surface identity (e.g. `claude-code-vscode-<userId>` vs `chatgpt-<userId>` vs `cursor-<userId>`) — each surface is a first-class recipient with its own DID. The relay auto-detects the surface slug from the OAuth client's DCR-registered `client_name` (unknown clients fall back to `mcp-client`, never silently `claude-*`). The `<userId>` portion is derived from your first credential (`u-pk-<hash>` for passkeys, `u-eth-<addr>` for wallets, `u-did-<hash>` for DIDs) — never a string you typed.
3. **Appends a hypermedia block** (`cg:affordance`) to the descriptor that is simultaneously `cg:Affordance` + `cgh:Affordance` + `hydra:Operation` + `dcat:Distribution`. Clients follow `hydra:target` / `dcat:accessURL` — no filename conventions, no Interego-specific contract. DCAT-aware catalogs can ingest the descriptor natively.
4. **Pins the descriptor to IPFS** (Pinata) and writes an anchor receipt at `/anchors/<timestamp>.json` for content-addressed verification.

### Cross-pod sharing (one graph, specific other people)

`publish_context` accepts `share_with: ["did:web:...", "acct:bob@example.com", "https://bob.example.com/profile#me", ...]`. Each handle is resolved via DID resolution or WebFinger (RFC 7033) to the other person's pod; their authorized agents' encryption keys are pulled and added as recipients on *that one graph's* envelope. No pod-level ACL change; your other graphs stay encrypted only to your own agents.

### `get_descriptor` follows hypermedia links

When you pass a descriptor `.ttl` URL, `get_descriptor` parses the `cg:affordance` block, follows the `dcat:accessURL` to the envelope, decrypts using this agent's X25519 key, and returns **both** the descriptor metadata and the decrypted payload in one response. No separate fetch step.

## Example prompts

After installing, try these in your AI client:

> "Set up an identity for me named Sarah Chen with agent label 'Claude Code (Sarah)'"

> "Publish this graph to my pod with high trust and a temporal facet valid through 2026"

> "Ingest this paragraph into PGSL and show me the resulting lattice structure"

> "What's the meet of fragments urn:pgsl:abc and urn:pgsl:xyz?"

> "Discover all context descriptors on bob.example.com that have a Trust facet"

> "Subscribe to all pods I know about and notify me when anything new is published"

The LLM picks the right tool based on what you ask — you don't have to remember tool names or schemas.

## Configuration via environment variables

```bash
CG_OWNER=https://id.example.com/agent/profile#me \
CG_AGENT=urn:agent:claude-code:my-laptop \
CG_HOME_POD=https://pod.example.com/agent/ \
CG_KNOWN_PODS=https://bob.example.com/,https://alice.example.com/ \
npx -y @interego/mcp
```

| Variable | Default | Purpose |
|---|---|---|
| `CG_OWNER` | `https://id.example.com/agent/profile#me` | The pod owner's WebID |
| `CG_AGENT` | `urn:agent:claude-code:local` | Identifier for this AI agent instance |
| `CG_HOME_POD` | `http://localhost:3456/agent/` | Default Solid pod for publishing |
| `CG_KNOWN_PODS` | _(empty)_ | Comma-separated pod URLs to seed the federation |

## Build from source

```bash
git clone https://github.com/markjspivey-xwisee/interego.git
cd context-graphs

# Build the library first
npm install
npm run build
npm pack   # creates interego-core-0.2.0.tgz

# Then build the MCP server against the local library
cd mcp-server
npm install ../interego-core-*.tgz --no-save
npm install   # picks up the rest of the deps
npm run build
node dist/server.js
```

## Remote MCP for mobile / claude.ai

The stdio server in this package is for desktop clients that can spawn a subprocess. For **claude.ai mobile / web custom connectors** (which speak MCP over HTTPS and require OAuth), use the cloud-hosted `interego-relay` instead.

- **Connector URL:** your deployment's relay, e.g. `https://interego-relay.<your-env>.azurecontainerapps.io/mcp`
- **Authentication:** OAuth 2.1 + PKCE + Dynamic Client Registration. The relay's `/authorize` page offers three passwordless sign-in methods: **passkey** (WebAuthn), **Ethereum wallet** (SIWE), and **did:key** (Ed25519 signature). No shared secrets anywhere, no user-claimable identifiers — the userId is derived from your first credential (`u-pk-<hash>` / `u-eth-<addr>` / `u-did-<hash>`), so an attacker can't bind their passkey to your display alias.
- **Per-surface agent, auto-detected:** each OAuth-connected surface auto-registers on the user's pod as its own `cg:AuthorizedAgent` with its own X25519 key. The relay maps the client's DCR `client_name` to a slug automatically — `ChatGPT` → `chatgpt-<userId>`, `OpenAI Codex` → `openai-codex-<userId>`, `Claude Code (VS Code)` → `claude-code-vscode-<userId>`, `Cursor` / `Windsurf` / `Cline` / `Zed` / `Continue` each get their own slug. Unknown clients fall back to the generic `mcp-client`, never silently `claude-*`.
- **Self-audit:** `GET <identity-url>/auth-methods/me` with your bearer token lists the wallets, passkey credential IDs, and DIDs currently registered to your account — use this to spot any foreign credentials (a risk under the pre-fix userId-claim hijack, now closed).

### Relay deployment env

| Variable | Default | Purpose |
|---|---|---|
| `RELAY_DEFAULT_SURFACE_AGENT` | `mcp-client` | Surface slug used when the OAuth `client_name` is absent or unrecognised. Deliberately not `claude-*`. |
| `RELAY_SURFACE_AGENT` | _(unset)_ | Legacy alias for `RELAY_DEFAULT_SURFACE_AGENT`. Pin to e.g. `claude-mobile` if the relay serves exactly one surface. |
| `BOOTSTRAP_INVITES` | _(empty)_ | Identity-side env. `userA:tokenA,userB:tokenB` — single-use tokens that let a legacy seeded userId (e.g. `markj`) claim its first credential. See `deploy/identity/AUTH-ARCHITECTURE.md`. |

See [`deploy/mcp-relay/`](../deploy/mcp-relay/) in the parent repo for deployment; [`deploy/identity/AUTH-ARCHITECTURE.md`](../deploy/identity/AUTH-ARCHITECTURE.md) for the full auth flow.

## Documentation

- **Architecture:** [`docs/e2ee.md`](../docs/e2ee.md) — envelope format, recipient sets, hypermedia link pattern, key lifecycle.
- **Ontology:** [`docs/ns/README.md`](../docs/ns/README.md) — 12 ontologies, 607 defined terms, CI-gated consistency.
- **Auth:** [`deploy/identity/AUTH-ARCHITECTURE.md`](../deploy/identity/AUTH-ARCHITECTURE.md) — SIWE / WebAuthn / did:key flows, DID as canonical identity.

## License

CC-BY-4.0 — see [LICENSE](../LICENSE) in the parent repository.

## Issues and contributions

[github.com/markjspivey-xwisee/interego/issues](https://github.com/markjspivey-xwisee/interego/issues)
