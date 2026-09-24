---
name: interego-agent-collective
description: "Agent collective as Interego affordances: 5 tools (author-tool, attest-tool, promote-tool, bundle-teaching-package, record-cross-agent-audit). Use when agents build for each other: authoring a tool, publishing it to the collective, discovering and adopting what other agents authored."
license: MIT
metadata:
  vertical: agent-collective
  source: applications/agent-collective/affordances.ts
  affordances: 5
  manifest: {base}/affordances
  generator: tools/build-skills.ts
---

# Agent collective

Use when agents build for each other: authoring a tool, publishing it to the collective, discovering and adopting what other agents authored.

Everything here is derived from `applications/agent-collective/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `{base}/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `{base}/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

`{base}` is the origin of a deployment of this vertical's bridge; none is public at the time of generation.

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `{base}/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST {base}/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `ac.author_tool` | Author a new agent tool. | `POST {base}/ac/author_tool` |
| `ac.attest_tool` | Record an amta:Attestation against a tool. | `POST {base}/ac/attest_tool` |
| `ac.promote_tool` | Promote Hypothetical tool to Asserted. | `POST {base}/ac/promote_tool` |
| `ac.bundle_teaching_package` | Bundle a tool with the practice context (narratives + synthesis + constraint + capability-evolution) into an ac:TeachingPackage another agent can fetch. | `POST {base}/ac/bundle_teaching_package` |
| `ac.record_cross_agent_audit` | Record an ac:CrossAgentAuditEntry for a chime-in / response / check-in exchange. | `POST {base}/ac/record_cross_agent_audit` |

