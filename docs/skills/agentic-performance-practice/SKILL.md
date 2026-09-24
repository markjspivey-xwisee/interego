---
name: interego-agentic-performance-practice
description: "Agentic performance practice as Interego affordances: 12 tools (read-intervention-methods, review-method-evidence, contextualize-situation, define-capability, map-affordance, actualize, and more). Use when an agent plans and records a performance intervention: reading the method catalogue, contextualising a task, choosing an intervention, recording what happened and how it turned out, and attesting readiness."
license: MIT
metadata:
  vertical: agentic-performance-practice
  source: applications/agentic-performance-practice/affordances.ts
  affordances: 12
  manifest: {base}/affordances
  generator: tools/build-skills.ts
---

# Agentic performance practice

Use when an agent plans and records a performance intervention: reading the method catalogue, contextualising a task, choosing an intervention, recording what happened and how it turned out, and attesting readiness.

Everything here is derived from `applications/agentic-performance-practice/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `{base}/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `{base}/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

`{base}` is the origin of a deployment of this vertical's bridge; none is public at the time of generation.

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `{base}/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST {base}/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `agp.read_intervention_methods` | Discover the versioned consulting and management cycle and the implementation method for each intervention. | `GET {base}/performance/methods` *(HTTP only)* |
| `agp.review_method_evidence` | Check supplied artifact pointers and notes against the selected method criteria. | `POST {base}/performance/methods/review` *(HTTP only)* |
| `agp.contextualize_situation` | Publish an agp:PerformanceSituation and place its work regime BEFORE choosing any method. | `POST {base}/agp/contextualize_situation` |
| `agp.define_capability` | Publish an agp:Capability composed of its constituent skills, tools, and knowledge (agp:composedOf). | `POST {base}/agp/define_capability` |
| `agp.map_affordance` | Publish an agp:PerformanceAffordance — an action-possibility a situation offers a performer — and the agp:Capability it requires to be actualized. | `POST {base}/agp/map_affordance` |
| `agp.actualize` | Record an agp:Actualization — a capability engaging a situation's affordance to yield agp:Performance. | `POST {base}/agp/actualize` |
| `agp.diagnose` | Read a situation's regime and route to the regime-appropriate method. | `POST {base}/agp/diagnose` |
| `agp.plan_intervention` | Emit an agp:InterventionPlan from a diagnosis. | `POST {base}/agp/plan_intervention` |
| `agp.evaluate_intervention` | Publish an agp:InterventionEvaluation (reaction / capability / transfer / outcome) attesting whether an intervention worked, closing the loop via iep:supersede… | `POST {base}/agp/evaluate_intervention` |
| `agp.list_practice` | Read the operator's agp: state from the pod: situations + regimes, capabilities + constituents, performance affordances, actualizations + performances, diagnos… | `POST {base}/agp/list_practice` |
| `agp.prepare_readiness_evidence` | Derive (never caller-assert) a readiness decision for one exact candidate digest from a held-out evaluation rule. | `POST {base}/agp/prepare_readiness_evidence` |
| `agp.extend_standards` | Author an extension to a standard IN THE FLOW OF WORK: a new xAPI context extension, an xAPI Profile fragment (concepts/templates/patterns), or an IEEE-LER / A… | `POST {base}/agp/extend_standards` |

