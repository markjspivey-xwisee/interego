# `@interego/lpc-bridge-example`

> **NOT first-party Interego.** Optional reference reification of the [`learner-performer-companion`](../) vertical's affordances as named MCP tools. Anyone can fork + maintain their own.

## What this is

A small Express + MCP server that exposes the LPC vertical's 6 affordances as named MCP tools (`lpc.ingest_training_content`, `lpc.grounded_answer`, etc.) for clients that prefer named-tool ergonomics over generic affordance discovery.

The bridge is **independent** of the generic Interego personal-bridge — it runs on its own port (default `6010`), depends on `@interego/core`, and serves only the LPC capability surface. Run multiple per-vertical bridges side by side if you want.

## Two reachability paths

This bridge serves **both** paths to the same underlying publishers (single source of truth: [`../affordances.ts`](../affordances.ts)):

- **Generic protocol-level discovery** at `GET /affordances` — returns the `cg:Affordance / hydra:Operation / dcat:Distribution` Turtle manifest. Any generic Interego agent walks this and invokes via standard HTTP.
- **Named MCP tools** at `POST /mcp` — tool schemas derived from the same affordance declarations.

Generic agents don't need this bridge at all — they can use the protocol-level path against any Interego deployment that publishes LPC affordances. The bridge is convenience, not requirement.

## Run

```bash
npm install
npm run build

# Configure the user's pod (override per-call via tool args if needed)
export LPC_DEFAULT_POD_URL=https://your-pod.example/me/
export LPC_DEFAULT_USER_DID=did:web:you.example

# Optional: deployment URL the bridge is reachable at (used in /affordances manifest)
export BRIDGE_DEPLOYMENT_URL=http://localhost:6010

PORT=6010 npm start
```

Once running:
- `http://localhost:6010/` — meta + tool list
- `http://localhost:6010/mcp` — MCP endpoint (POST initialize / tools/list / tools/call)
- `http://localhost:6010/affordances` — protocol-native manifest (Turtle)
- `http://localhost:6010/lpc/<verb>` — direct HTTP endpoint per affordance

## Connect an MCP client

```jsonc
// Claude Desktop config
{
  "mcpServers": {
    "lpc": { "url": "http://localhost:6010/mcp" }
  }
}
```

After reload, 6 tools available: `lpc.ingest_training_content`, `lpc.import_credential`, `lpc.record_performance_review`, `lpc.record_learning_experience`, `lpc.grounded_answer`, `lpc.list_wallet`.

## Configuration

| Env var | Default | What |
|---|---|---|
| `PORT` | `6010` | TCP port to bind. |
| `BRIDGE_DEPLOYMENT_URL` | `http://localhost:${PORT}` | URL substituted into affordance `hydra:target` values when serving the manifest. Set to the bridge's actual reachable URL when deploying. |
| `LPC_DEFAULT_POD_URL` | (required if no per-call `pod_url` arg) | User's Solid pod URL. |
| `LPC_DEFAULT_USER_DID` | (required if no per-call `user_did` arg) | User's DID. |

## See also

- [Vertical README](../README.md) — what the LPC vertical is + Tier 1-8 test surface
- [Affordance declarations](../affordances.ts) — the spec-level source of truth
- [Bridge framework](../../_shared/vertical-bridge/) — `createVerticalBridge()` reused by all per-vertical bridges
- [Applications index](../../README.md) — verticals are emergent applications, not part of the protocol
