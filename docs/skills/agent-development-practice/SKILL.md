---
name: interego-agent-development-practice
description: "Agent development practice as Interego affordances: 8 tools (define-capability, record-probe, record-narrative-fragment, emerge-synthesis, record-evolution-step, refine-constraint, and more). Use when an agent is developing itself deliberately: defining a capability, practising it, recording the attempt and the evidence, and reviewing what changed."
license: MIT
metadata:
  vertical: agent-development-practice
  source: applications/agent-development-practice/affordances.ts
  affordances: 8
  manifest: {base}/affordances
  generator: tools/build-skills.ts
---

# Agent development practice

Use when an agent is developing itself deliberately: defining a capability, practising it, recording the attempt and the evidence, and reviewing what changed.

Everything here is derived from `applications/agent-development-practice/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `{base}/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `{base}/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

`{base}` is the origin of a deployment of this vertical's bridge; none is public at the time of generation.

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `{base}/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST {base}/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `adp.define_capability` | Declare a capability SPACE (not target) with rubric criteria as guides (not gates) and a Cynefin domain. | `POST {base}/adp/define_capability` |
| `adp.record_probe` | Record a safe-to-fail probe. | `POST {base}/adp/record_probe` |
| `adp.record_narrative_fragment` | Record a narrative observation against a probe. | `POST {base}/adp/record_narrative_fragment` |
| `adp.emerge_synthesis` | Compose multiple narrative fragments into a synthesis. | `POST {base}/adp/emerge_synthesis` |
| `adp.record_evolution_step` | Operator amplify/dampen decision. | `POST {base}/adp/record_evolution_step` |
| `adp.refine_constraint` | Refine a constraint emerged from synthesis cycles. | `POST {base}/adp/refine_constraint` |
| `adp.recognize_capability_evolution` | Record a passport:LifeEvent biographical record for an emergent capability. | `POST {base}/adp/recognize_capability_evolution` |
| `adp.list_cycle` | Load the operator's probe cycle state from the pod: capabilities, probes, fragments, syntheses, evolution steps, constraints, capability evolution events. | `POST {base}/adp/list_cycle` |

