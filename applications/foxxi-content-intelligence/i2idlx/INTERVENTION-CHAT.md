# Intervention chat

The Interventions view brings an identified intervention into the surrounding AI
conversation. Its model supplies the answer; Foxxi prepares source passages and
the workbench's pinned glossary context. No separate model API key is required.
This document describes the implementation. Deployment and actual-host acceptance
must be recorded separately.

## Use

Open **Interventions**, then browse available public courses and hosted packages,
enter an existing identifier, or supply text, Markdown or structured JSON for any
other intervention. A job aid, simulation, coaching plan, process change or
environmental intervention keeps its own type. Descriptions of an intervention
are reference material, not evidence that the intervention has been delivered.

Choose whether to use, understand, improve or evaluate the intervention. Attach
glossary concepts when useful, enter a question, and preview the source context.
**Ask ChatGPT** sends an explicit request to the connected conversation. Answers
and follow-up discussion appear there. A successful delivery acknowledgement is
not an answer, completed task or learning result.

The pane retains its draft during navigation while the workbench stays open.
It does not automatically save supplied material to browser storage or a pod.
The conversation owns its discussion history; no server chat session is created.

## Shared read contract

- `i2idlx_interventions` / `GET /i2idlx/api/interventions` returns at most forty
  public entries. Browse is an explicit user action. Package metadata uses the
  existing GET-only reader, without generating or persisting descriptions.
- `i2idlx_intervention_ask` / `POST /i2idlx/api/intervention-ask` accepts a question,
  source, perspective and optional glossary concept IDs. The same executor
  prepares the packet for both transports.
- `source: authored-course` uses `intervention_id` for an already publicly indexed
  authored course. An optional author DID must match its known owner; it cannot
  direct the public App to another pod.
- `source: package` uses the lowercase SHA-256 of a package already hosted by this
  deployment. Native package readers separate instructional pages from structured
  questions. ZIP entry and inflation budgets apply before parsing.
- `source: supplied` carries an intervention object with `id`, `title`, free-text
  `kind`, optional `source_uri` and `version`, and `sections` containing only
  `id`, `title` and `body`. Identifiers are references and are never fetched.

Inputs are bounded to 96,000 UTF-8 bytes. A packet contains at most twenty-four
instructional excerpts and fourteen pinned glossary concepts, within 256,000
output bytes. Citation IDs, source identifiers, source versions, omitted material
and excerpt truncation stay explicit. Missing content is not invented.

The App neither starts an attempt nor submits assessments, writes learner or
xAPI records, changes consent, publishes content or invokes a server model.
Structured assessment, answer, verifier and private fields are excluded. Ordinary
source prose remains untrusted reference data, with no claim of semantic screening.
I2IDL-X mappings remain proposed/Hypothetical. Retrieval and conversation do not
establish achievement or causal intervention effectiveness.

## Verification

The source includes executor validation/projection tests, pure source projection
tests and wire-level REST/MCP parity and catalog tests. Browser checks exercise
the UI and protocol against an explicitly simulated host. Required CI, deployed
readbacks and actual ChatGPT acceptance remain distinct evidence.
