# LLM telemetry: every affordance

Derived from `applications/llm-telemetry/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 8 affordances.

## `llm_telemetry.profile`

**Read the LLM xAPI profile**

Read the versioned, general LLM telemetry vocabulary, statement templates and observation-stream pattern.

- Action: `urn:iep:action:llm-telemetry:profile`
- HTTP: `GET https://foxxi-bridge.interego.xwisee.com/llm-telemetry/profile` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/ld+json`
- Inputs: none

## `llm_telemetry.ingest`

**Record LLM observations**

Sign {events:[...]} with the authenticated observer using sign_request then act, or act(sign_payload:true). Server and client deliveries require their independent capture opt-in; explicit manual-observation events are a signed one-off action. Accepts 1–20 allowlisted metadata events, validates xAPI in the actual own-lens LRS, then awaits encrypted PGSL persistence. Retry identical source_event_id and metadata; conflicting reuse returns 409. Content, credentials and transcripts are excluded.

- Action: `urn:iep:action:llm-telemetry:ingest`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/ingest` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `events` | array of object | yes | Metadata observations conforming to /llm-telemetry/event-schema. Actor is bound by verified signature. |
| `capture_revision` | integer | no | Required for server observations: the durable consent revision read before the operation. |

## `llm_telemetry.query`

**Query sessions and insights**

Sign the query with your bound identity. Read only your observer records from the actual LRS lens and a fresh encrypted PGSL snapshot, preserving provenance and exposing unavailable sources and conflicting IDs. Returns sessions, timeline, measured usage, capture-gap insights and paginated xAPI statements. No prompt or response text is collected.

- Action: `urn:iep:action:llm-telemetry:query`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/query` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `session_id` | string | no | Optional opaque session ID; empty means all observed sessions. |
| `source` | string | no | Optional reporting adapter, for example codex-hooks. |
| `model` | string | no | Optional exact model identifier reported by the source. |
| `runtime_agent_id` | string | no | Optional exact runtime agent identifier. Distinct from the signature-bound observer agent_id. |
| `tool_name` | string | no | Optional exact tool name. |
| `status` | one of `ok`, `error`, `cancelled`, `unknown` | no | Optional explicit event outcome. Completion alone does not mean success. |
| `kind` | string | no | Optional event kind, for example tool-failed. |
| `capture_mode` | one of `live`, `backfill`, `validation` | no | Optional live, backfill or validation observation filter. |
| `capture_channel` | one of `server`, `client`, `manual` | no | Select server, client or explicit manual observations. Multiple channels may observe the same work. |
| `since` | string | no | Optional inclusive UTC event time, for example 2026-09-16T00:00:00Z. |
| `until` | string | no | Optional inclusive UTC event time. |
| `limit` | integer | no | Event page size (default 50). Aggregates cover the full matching snapshot. |
| `offset` | integer | no | Event page offset (default 0). |
| `view` | one of `sessions`, `timeline`, `report`, `export` | no | Choose the report presentation. |

## `llm_telemetry.capture_read`

**Read capture settings**

Read your independent server and client reporting opt-ins. Both default to off. The server observer covers Interego /mcp requests; client reporters use the existing connection with host hook configuration and review.

- Action: `urn:iep:action:llm-telemetry:capture-read`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/capture/read` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`
- Inputs: none

## `llm_telemetry.capture_update`

**Change capture settings**

Opt this authenticated observer into server reporting, client reporting, both or neither. Omitted switches retain their value. Disabling refuses new automatic deliveries; it does not erase history or disable hooks in another host. Client installation and hook trust remain separate.

- Action: `urn:iep:action:llm-telemetry:capture-update`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/capture/update` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `server_enabled` | boolean | no | Allow automatic metadata recording for authenticated calls through Interego MCP. |
| `client_enabled` | boolean | no | Accept reports from client hooks and runtime adapters. Does not install or trust a collector. |
| `expected_revision` | integer | no | The revision displayed by Capture settings. A stale change is refused. |

## `llm_telemetry.client_setup`

**Set up client reporting**

Read hosted metadata-only hook configuration for an existing Interego MCP connection. Supports Codex CLI and Claude Code CLI/VS Code contracts; other surfaces report their coverage limits explicitly. Does not install a plugin, connect another server, change consent or approve host trust. Configuration availability is not proof of live delivery.

- Action: `urn:iep:action:llm-telemetry:client-setup`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/client-setup` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `client` | one of `overview`, `codex`, `claude-code`, `claude-code-vscode`, `codex-vscode`, `chatgpt-work`, `chatgpt-web`, `claude-web` | no | Runtime or surface to configure; omitted means support overview. |
| `server_name` | string | no | Exact existing MCP server name in the selected client. Required to generate configuration. No credentials or new connection. |

## `llm_telemetry.collector_create`

**Create native collector credential**

Create a private, expiring, ingest-only credential bound to this authenticated observer. Requires client consent. Returns native Claude Code OTLP HTTP/JSON settings. Does not configure a host. Keep the credential private.

- Action: `urn:iep:action:llm-telemetry:collector-create`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/collector/create` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | one of `claude-code-otel`, `claude-cowork-otel` | no | Native exporter source. Defaults to Claude Code. |
| `account_id` | string | no | Your exact user.account_uuid; mandatory for organization-wide Cowork export so other users are excluded. |
| `capture_mode` | one of `live`, `validation` | yes | Live native observations or explicitly separated validation fixtures. |

## `llm_telemetry.collector_revoke`

**Revoke collector credential**

Revoke one own collector credential. Existing observations are preserved.

- Action: `urn:iep:action:llm-telemetry:collector-revoke`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/collector/revoke` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `collector_id` | string | yes | Collector ID returned at creation. |

