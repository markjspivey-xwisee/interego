# `@interego/lrs-bridge-example`

> **NOT first-party Interego.** Optional reference reification of the [`lrs-adapter`](../) vertical's affordances as named MCP tools.

## What this is

Small Express + MCP server exposing the LRS adapter's 4 affordances (`ingest_statement`, `ingest_statement_batch`, `project_descriptor`, `lrs_about`) as named MCP tools (`lrs.*`). Auto-negotiates xAPI version (2.0.0 preferred; 1.0.3 fallback for legacy LRSes like SCORM Cloud).

## Two reachability paths

- **Generic discovery** at `GET /affordances`
- **Named MCP tools** at `POST /mcp` — derived from [`../affordances.ts`](../affordances.ts)

## Run

```bash
npm install && npm run build

export LRS_DEFAULT_POD_URL=https://your-pod.example/me/
export LRS_DEFAULT_USER_DID=did:web:you.example

PORT=6030 BRIDGE_DEPLOYMENT_URL=http://localhost:6030 npm start
```

Connect any MCP client to `http://localhost:6030/mcp` for the 4 named tools.

LRS endpoint + auth pass per call (or set as defaults in your client) — they're the bridge between Interego and the EXTERNAL LRS:
- `lrs_endpoint` (e.g., `https://cloud.scorm.com/lrs/<APP_ID>/sandbox`)
- `lrs_username` / `lrs_password` — Basic auth for that LRS
- `lrs_preferred_version` — `'2.0.0'` or `'1.0.3'` (default 2.0.0 with auto-fallback)

## Configuration

| Env var | Default | What |
|---|---|---|
| `PORT` | `6030` | TCP port. |
| `BRIDGE_DEPLOYMENT_URL` | `http://localhost:${PORT}` | URL for `hydra:target` substitution. |
| `LRS_DEFAULT_POD_URL` | (required) | User's pod URL. |
| `LRS_DEFAULT_USER_DID` | (required) | User's DID. |

## See also

- [Vertical README](../README.md) — bidirectional xAPI ↔ Interego translation discipline
- [Affordance declarations](../affordances.ts)
- [Bridge framework](../../_shared/vertical-bridge/)
- [Applications index](../../README.md)
