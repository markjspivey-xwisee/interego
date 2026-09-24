---
name: interego-lrs-adapter
description: "LRS adapter as Interego affordances: 4 tools (ingest-statement, ingest-statement-batch, project-descriptor, lrs-about). Use at the boundary between xAPI learning record stores and Interego pods: ingesting statements as descriptors, projecting descriptors out to an LRS, and querying the experience index."
license: MIT
metadata:
  vertical: lrs-adapter
  source: applications/lrs-adapter/affordances.ts
  affordances: 4
  manifest: {base}/affordances
  generator: tools/build-skills.ts
---

# LRS adapter

Use at the boundary between xAPI learning record stores and Interego pods: ingesting statements as descriptors, projecting descriptors out to an LRS, and querying the experience index.

Everything here is derived from `applications/lrs-adapter/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `{base}/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `{base}/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

`{base}` is the origin of a deployment of this vertical's bridge; none is public at the time of generation.

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `{base}/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST {base}/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `lrs.ingest_statement` | Fetch a single xAPI Statement from an LRS by ID, project as iep:ContextDescriptor in the user's pod with lrs:StatementIngestion audit. | `POST {base}/lrs/ingest_statement` |
| `lrs.ingest_statement_batch` | Fetch a batch of xAPI Statements from an LRS by filter (verb / activity / agent / since / until / limit) and publish each as iep:ContextDescriptor in the user'… | `POST {base}/lrs/ingest_statement_batch` |
| `lrs.project_descriptor` | Read an Asserted descriptor from the pod and project to xAPI Statement, POST to the LRS. | `POST {base}/lrs/project_descriptor` |
| `lrs.lrs_about` | Probe the LRS's /xapi/about endpoint to discover supported xAPI versions. | `POST {base}/lrs/lrs_about` |

