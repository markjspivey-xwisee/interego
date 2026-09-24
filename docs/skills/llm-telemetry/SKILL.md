---
name: interego-llm-telemetry
description: "LLM telemetry as Interego affordances: 8 tools (profile, ingest, query, capture-read, capture-update, client-setup, and more). Use when observing an agent's own model calls as xAPI: capturing sessions and turns, querying and reporting on them, finding capture gaps, or exporting the observation stream. Served by the Foxxi bridge."
license: MIT
metadata:
  vertical: llm-telemetry
  source: applications/llm-telemetry/affordances.ts
  affordances: 8
  manifest: "https://foxxi-bridge.interego.xwisee.com/affordances"
  generator: tools/build-skills.ts
---

# LLM telemetry

Use when observing an agent's own model calls as xAPI: capturing sessions and turns, querying and reporting on them, finding capture gaps, or exporting the observation stream. Served by the Foxxi bridge.

Everything here is derived from `applications/llm-telemetry/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `https://foxxi-bridge.interego.xwisee.com/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `https://foxxi-bridge.interego.xwisee.com/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `https://foxxi-bridge.interego.xwisee.com/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST https://foxxi-bridge.interego.xwisee.com/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `llm_telemetry.profile` | Read the versioned, general LLM telemetry vocabulary, statement templates and observation-stream pattern. | `GET https://foxxi-bridge.interego.xwisee.com/llm-telemetry/profile` *(HTTP only)* |
| `llm_telemetry.ingest` | Sign {events:[...]} with the authenticated observer using sign_request then act, or act(sign_payload:true). | `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/ingest` *(HTTP only)* |
| `llm_telemetry.query` | Sign the query with your bound identity. | `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/query` *(HTTP only)* |
| `llm_telemetry.capture_read` | Read your independent server and client reporting opt-ins. | `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/capture/read` *(HTTP only)* |
| `llm_telemetry.capture_update` | Opt this authenticated observer into server reporting, client reporting, both or neither. | `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/capture/update` *(HTTP only)* |
| `llm_telemetry.client_setup` | Read hosted metadata-only hook configuration for an existing Interego MCP connection. | `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/client-setup` *(HTTP only)* |
| `llm_telemetry.collector_create` | Create a private, expiring, ingest-only credential bound to this authenticated observer. | `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/collector/create` *(HTTP only)* |
| `llm_telemetry.collector_revoke` | Revoke one own collector credential. | `POST https://foxxi-bridge.interego.xwisee.com/agent/llm-telemetry/collector/revoke` *(HTTP only)* |

