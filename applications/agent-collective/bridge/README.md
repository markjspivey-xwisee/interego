# `@interego/ac-bridge-example`

> **NOT first-party Interego.** Optional reference reification of the [`agent-collective`](../) vertical's affordances as named MCP tools.

## What this is

Small Express + MCP server exposing the agent-collective's 5 affordances (tool authoring, attestation, promotion, teaching package bundling, cross-agent audit) as named MCP tools (`ac.*`). Independent per-vertical bridge, separate from the generic personal-bridge.

## Two reachability paths

- **Generic discovery** at `GET /affordances`
- **Named MCP tools** at `POST /mcp` — derived from [`../affordances.ts`](../affordances.ts)

## Run

```bash
npm install && npm run build

export AC_DEFAULT_POD_URL=https://your-pod.example/me/
export AC_DEFAULT_AGENT_DID=did:web:agent.example

PORT=6040 BRIDGE_DEPLOYMENT_URL=http://localhost:6040 npm start
```

Connect any MCP client to `http://localhost:6040/mcp` for the 5 named tools.

## Configuration

| Env var | Default | What |
|---|---|---|
| `PORT` | `6040` | TCP port. |
| `BRIDGE_DEPLOYMENT_URL` | `http://localhost:${PORT}` | URL for `hydra:target` substitution. |
| `AC_DEFAULT_POD_URL` | (required) | Authoring agent's pod URL. |
| `AC_DEFAULT_AGENT_DID` | (required) | Authoring agent's DID. |

## See also

- [Vertical README](../README.md) — multi-agent federation + tool authoring discipline
- [Affordance declarations](../affordances.ts)
- [Bridge framework](../../_shared/vertical-bridge/)
- [Applications index](../../README.md)
