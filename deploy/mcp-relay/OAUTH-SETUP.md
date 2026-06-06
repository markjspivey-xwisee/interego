# OAuth setup for MCP clients

The Interego relay is an OAuth 2.1 Protected Resource. Any MCP client
that speaks OAuth (Claude Code, Claude Desktop, claude.ai, Cursor,
Cline, Windsurf, ChatGPT custom connectors, Hermes Agent, OpenClaw)
can mount the relay's `/mcp` endpoint by following the discovery flow
documented here.

## Transports: `/mcp` vs `/sse`

The relay exposes two MCP transports on the same OAuth resource:

- **`/mcp`** — Streamable HTTP, the modern unified MCP transport.
  Preferred by Claude Code, Cursor, Codex CLI, Windsurf, Cline,
  ChatGPT custom connectors, and Claude.ai. Use this everywhere
  unless your client only supports the older transport.
- **`/sse`** — Server-Sent Events, the original MCP transport.
  Retained for backward compatibility with clients that haven't
  moved to Streamable HTTP yet. Same OAuth, same scopes, same
  agent-minting behavior — just swap the path suffix.

All examples below publish the `/mcp` URL as the primary; replace
the suffix with `/sse` only when a specific client requires it.

## Quick path — most clients

The relay advertises everything an OAuth-compliant client needs via
two well-known endpoints:

```
GET https://your-relay-host/.well-known/oauth-authorization-server
GET https://your-relay-host/.well-known/oauth-protected-resource
```

These return JSON metadata pointing the client at the
`/authorize`, `/token`, and `/mcp` endpoints. **Most modern MCP
clients discover all of this automatically the first time they hit
the relay** — you only need to give the client the relay URL.

Separately, the identity server (not the relay) additionally exposes
`/.well-known/webfinger` (RFC 7033) for resolving `acct:user@host`
handles to WebID / DID / pod URL — used by `share_with`, the name
service, and federation peer discovery.

The relay's hosted reference:

```
https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp
```

## Per-client config

### Claude Code (CLI)

Add to `~/.claude.json`:

```jsonc
{
  "mcpServers": {
    "interego": {
      "url": "https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp"
    }
  }
}
```

Restart Claude Code. First tool call triggers OAuth — a browser
window opens at `/authorize`, the relay's method picker asks you to
choose passkey / wallet / DID, you sign the challenge, the page
redirects back with the token. Claude Code stores the refresh token
in `~/.claude/oauth-tokens.json` (per-server).

### Claude Desktop / claude.ai web + mobile

**Claude Desktop:** Settings → Connectors → Add custom connector.
Paste the `/mcp` URL. Click Connect. Same browser flow as above.

**claude.ai:** Settings → Connectors → Custom connectors → New.
Paste the `/mcp` URL. claude.ai handles the OAuth dance entirely
in-app.

**Coverage:** the same connector entry covers Claude.ai web AND the
Claude mobile app (iOS and Android). Connector settings sync via
your Anthropic account, so you only configure it once — the mobile
app picks it up automatically on next sign-in.

### Cursor

`.cursor/mcp.json` in your workspace OR `~/.cursor/mcp.json`
globally:

```jsonc
{
  "mcpServers": {
    "interego": {
      "url": "https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp"
    }
  }
}
```

Restart Cursor. OAuth flow opens in your default browser.

### Cline / Windsurf

Same JSON shape as Claude Code's `~/.claude.json`. Different config
paths:

- **Cline:** open the Cline panel → Settings → MCP Servers → add.
- **Windsurf:** `~/.codeium/windsurf/mcp_config.json`.

### Hermes Agent (Nous Research)

Edit `~/.hermes/config.toml`:

```toml
[[mcp.servers]]
name = "interego"
url = "https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp"
```

Restart Hermes. OAuth flow opens in your default browser; Hermes
caches the token in its config dir.

### OpenClaw

```bash
openclaw mcp add interego \
  --url "https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp"
```

### ChatGPT (custom connectors) — web + mobile

Custom MCP connectors are available on **ChatGPT Pro, Team, and
Enterprise** plans. Settings → Connectors → Add. Paste the `/mcp`
URL. ChatGPT runs the OAuth flow in a browser tab and persists the
token for that workspace.

**Coverage:** the same connector covers ChatGPT on the web AND the
ChatGPT mobile app (iOS and Android). Connector settings sync via
your OpenAI account, so a connector added on the web is immediately
usable from the mobile app once you're signed in.

## OAuth scopes

The relay advertises three OAuth scopes in its
`/.well-known/oauth-authorization-server` metadata
(`scopes_supported`). A client picks one by passing it as the
standard `scope` query parameter on `/authorize`:

| Scope | Semantics |
|---|---|
| `mcp` | Full access. Read AND write. Default when no `scope` parameter is supplied. |
| `mcp:read` | Read-only. Discover / get-descriptor / list-pods etc. work; every write tool (publish_context, register_agent, pgsl_ingest, …) returns 403 `insufficient_scope`. |
| `mcp:write` | Explicit write-side. Currently a synonym for `mcp`. Advertised so the read/write vocabulary is symmetric. |

The relay issues:

- **Access token** — bearer, 1h TTL, carries `userId` / `agentId` /
  `podUrl` in the token's `extra` field AND the granted scope set in
  its `scope` claim
- **Refresh token** — 14d TTL, rotating on every use (RFC 6749 §10.4)

### Two scope layers — not the same thing

The OAuth scope above (`mcp` / `mcp:read` / `mcp:write`) is enforced
at the OAUTH LAYER — it gates on the bearer's `scope` claim. It is
independent of the SUBSTRATE-LAYER per-agent scope
(`cg:scope: ReadWrite | ReadOnly | PublishOnly | DiscoverOnly`)
declared in the pod's agent registry, which is gated by the signed
delegation chain.

Either gate can independently produce a 403:

- A bearer with `scope=mcp:read` calling `publish_context` → 403
  from the OAuth gate (this is the path FIX D exposes).
- A bearer with `scope=mcp` whose underlying delegated agent has
  `cg:scope: ReadOnly` calling `publish_context` → 403 from the
  substrate gate (this is FIX 4, pre-existing).

Verifiers should test both, because they enforce different
invariants.

### Verifying the read-only 403 (FIX D)

External verifiers can drive the OAuth-layer 403 entirely through
the public OAuth flow — no admin / introspection secret required:

1. **Register a client** (standard RFC 7591 DCR):

   ```bash
   curl -s -X POST https://your-relay-host/register \
     -H 'content-type: application/json' \
     -d '{"client_name":"scope-verifier","redirect_uris":["http://localhost:8765/cb"]}'
   ```

   Note the returned `client_id`.

2. **Start the authorize flow with `scope=mcp:read`** in a browser:

   ```
   https://your-relay-host/authorize
     ?response_type=code
     &client_id=<CLIENT_ID>
     &redirect_uri=http://localhost:8765/cb
     &code_challenge=<PKCE_S256>
     &code_challenge_method=S256
     &scope=mcp:read
     &state=verify
   ```

   The consent page shows `scopes: mcp:read`. Sign in.

3. **Exchange the code for a token** (PKCE):

   ```bash
   curl -s -X POST https://your-relay-host/token \
     -d grant_type=authorization_code \
     -d code=<CODE> \
     -d client_id=<CLIENT_ID> \
     -d code_verifier=<PKCE_VERIFIER> \
     -d redirect_uri=http://localhost:8765/cb
   ```

   The response is `{ "access_token":"…", "scope":"mcp:read", … }`
   — confirm the `scope` claim is exactly `mcp:read`.

4. **Attempt a write tool with that bearer**:

   ```bash
   curl -s -X POST https://your-relay-host/mcp \
     -H "Authorization: Bearer $ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
       "name":"publish_context",
       "arguments":{"descriptor_id":"urn:cg:verify:1","graph_content":"<#x> <#p> <#o> ."}
     }}'
   ```

   The response wraps a 403 envelope:

   ```json
   {
     "error":"insufficient_scope",
     "code":403,
     "requiredScope":["mcp","mcp:write"],
     "grantedScope":["mcp:read"],
     "reason":"tool \"publish_context\" requires OAuth scope \"mcp\" or \"mcp:write\"; bearer was issued with [\"mcp:read\"]"
   }
   ```

5. **Confirm read tools still work** with the same bearer:

   ```bash
   curl -s -X POST https://your-relay-host/mcp \
     -H "Authorization: Bearer $ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
       "name":"discover_context","arguments":{}
     }}'
   ```

   Returns descriptors normally — proving the gate is scope-typed,
   not a blanket block.

## Per-surface agent minting

The relay maps the OAuth client's `client_name` (set during Dynamic
Client Registration per RFC 7591) to a **surface slug**:

| `client_name` | Surface slug | Minted agent ID |
|---|---|---|
| Claude Code (VS Code) | `claude-code-vscode` | `claude-code-vscode-<userId>` |
| Claude Code | `claude-code` | `claude-code-<userId>` |
| Claude Desktop | `claude-desktop` | `claude-desktop-<userId>` |
| Claude Mobile | `claude-mobile` | `claude-mobile-<userId>` |
| claude.ai (anything else Claude) | `claude` | `claude-<userId>` |
| Cursor | `cursor` | `cursor-<userId>` |
| Hermes Agent | `hermes-agent` | `hermes-agent-<userId>` |
| OpenClaw | `openclaw` | `openclaw-<userId>` |
| ChatGPT (custom connector) | `chatgpt` | `chatgpt-<userId>` |
| Anything else | `mcp-client` | `mcp-client-<userId>` |

You can audit which agents have been minted on your account at
`https://interego-identity.../auth-methods/me` or in the
`/dashboard` UI.

## Self-hosting your own relay

The hosted reference is for evaluation. For production deployments,
clone the repo and run your own:

```bash
git clone https://github.com/markjspivey-xwisee/interego.git
cd interego/deploy/mcp-relay
npm install && npm run build

# Environment variables (.env or shell):
export PORT=4040
export INTEREGO_IDENTITY_URL=https://your-identity-host/
export INTEREGO_CSS_URL=https://your-css-host/
export INTEREGO_OAUTH_BASE_URL=https://your-relay-host/

# The relay's OAuth provider state is durable across container restarts:
# DCR client records, issued access tokens, issued refresh tokens, and
# the federation subscription registry are all mirrored to the
# service-account pod below, so a restart no longer drops live MCP
# sessions or peer-pod subscriptions. Back this pod with a persistent
# CSS storage backend (not in-memory) if you want that durability.

# Optional — service-account pod URL where the relay persists:
#   - clients/         OAuth Dynamic Client Registration records
#   - tokens/          issued access tokens
#   - tokens-refresh/  issued refresh tokens
#   - federation/      known-pod / subscription registry entries
# Defaults to `${CSS_URL}svc-relay-dcr/`. MUST NOT point at any human
# user's pod; CSS auto-creates the container on first PUT, so the pod
# does not need to exist before the relay starts writing to it. Token
# files are named by sha256(token) — the raw bearer string never lands
# on disk.
# export RELAY_OAUTH_STORE_POD=https://your-css-host/svc-relay-dcr/

npm start
```

The relay needs the identity server + CSS pod-server to be reachable;
both ship as separate Dockerfiles in `deploy/`. See
`deploy/azure-deploy.sh` for the Azure Container Apps recipe used by
the hosted reference.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser opens to a 404 at `/authorize` | Wrong URL — you pasted the identity-server URL instead of the relay URL. | Use the `-relay.` host, not the `-identity.` host. |
| OAuth completes but tools fail with 401 | Refresh token expired (14 days), revoked via sign-out-everywhere (bumps `sessionEpoch`), or `TOKEN_SIGNING_KEY` rotated/missing on the identity server. Container restart no longer triggers this — both the relay's OAuth tokens and the identity server's bearer tokens are persistent across redeploys (see `RELAY_OAUTH_STORE_POD` + `TOKEN_SIGNING_KEY`). | Restart the client to trigger re-authorization; also check `TOKEN_SIGNING_KEY` env var is stable across deploys. |
| "Could not reach relay" on first call | Cold start on Azure Container Apps — the relay scales to zero. | Retry once; subsequent calls warm. |
| 429 Too Many Requests during enrollment | Per-IP rate limit on `/auth/*` (30 enrollments / min). | Wait one minute; the limit is generous for legitimate use. |
| Multiple agents appear in `/auth-methods/me` | Each MCP client mints its own surface agent. Expected. | Revoke unused agents via the dashboard if needed. |

## See also

- `docs/integrations/agent-runtimes-mcp.md` — Path 1 integration map
- `deploy/identity/AUTH-ARCHITECTURE.md` — first-principles auth model
- `deploy/identity/webfinger.ts` — WebFinger (RFC 7033) at the
  identity host; resolves `acct:user@host` to WebID / DID / pod URL
- `https://datatracker.ietf.org/doc/html/rfc7591` — OAuth Dynamic
  Client Registration (the spec the relay implements)
