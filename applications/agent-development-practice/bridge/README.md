# `@interego/adp-bridge-example`

> **NOT first-party Interego.** Optional reference reification of the [`agent-development-practice`](../) vertical's affordances as named MCP tools.

## What this is

Small Express + MCP server exposing the ADP vertical's 8 affordances (capability declaration, probe / fragment / synthesis / evolution / constraint / capability-evolution / cycle-list) as named MCP tools (`adp.*`) for ergonomic LLM tool selection. Independent of the generic Interego personal-bridge.

## Two reachability paths

- **Generic discovery** at `GET /affordances` — protocol-native Turtle manifest
- **Named MCP tools** at `POST /mcp` — schemas derived from [`../affordances.ts`](../affordances.ts)

Generic agents can use the protocol path; this bridge is convenience for opinionated clients.

## Run

```bash
npm install && npm run build

export ADP_DEFAULT_POD_URL=https://your-pod.example/me/
export ADP_DEFAULT_OPERATOR_DID=did:web:you.example

PORT=6020 BRIDGE_DEPLOYMENT_URL=http://localhost:6020 npm start
```

Connect any MCP client to `http://localhost:6020/mcp` for the 8 named tools.

## Configuration

| Env var | Default | What |
|---|---|---|
| `PORT` | `6020` | TCP port. |
| `BRIDGE_DEPLOYMENT_URL` | `http://localhost:${PORT}` | URL for `hydra:target` substitution. |
| `ADP_DEFAULT_POD_URL` | (required) | User's pod URL. |
| `ADP_DEFAULT_OPERATOR_DID` | (required) | Operator DID. |

## See also

- [Vertical README](../README.md) — what ADP is + the probe-cycle workflow
- [Affordance declarations](../affordances.ts) — single source of truth
- [Bridge framework](../../_shared/vertical-bridge/)
- [Applications index](../../README.md)
