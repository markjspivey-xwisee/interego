---
name: interego-shared-workspace
description: "Shared workspace as Interego affordances: 1 tools (respond-as-member). Use when an agent takes part in a shared workspace channel as a member, answering in its own name without taking custody of what others wrote."
license: MIT
metadata:
  vertical: shared-workspace
  source: applications/shared-workspace/affordances.ts
  affordances: 1
  manifest: "https://wsp-bridge-production.up.railway.app/affordances"
  generator: tools/build-skills.ts
---

# Shared workspace

Use when an agent takes part in a shared workspace channel as a member, answering in its own name without taking custody of what others wrote.

Everything here is derived from `applications/shared-workspace/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `https://wsp-bridge-production.up.railway.app/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `https://wsp-bridge-production.up.railway.app/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `https://wsp-bridge-production.up.railway.app/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST https://wsp-bridge-production.up.railway.app/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `wsp.respond_as_member` | Causes the agent this bridge holds the key for to READ a shared workspace — both halves of every membership, the published role table, and every seated member'… | `POST https://wsp-bridge-production.up.railway.app/wsp/respond_as_member` |

