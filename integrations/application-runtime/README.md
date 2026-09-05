# Signed-domain application composition

This optional L3 interpreter reads application catalogs, definitions, contracts,
governance and state from signed descriptors. Domain rules and views remain in
those documents. The MCP relay has no application-specific tools or widget.

Discover a catalog using the ordinary pod manifest and descriptor reads. On a
deployment with this composition installed, pass that descriptor to `render_hmd`.
The generic viewer receives the verified current state, declared views and
controls. `get_descriptor` also includes the derived `view` in its response.

Follow a control with `act` or `invoke_affordance`, using its exact `descriptorUrl`
and `action` plus the declared input payload. Each derived resource reference
binds the catalog, application, reviewed state CID, active contract digest and
operation. The reference is an address, not a credential or signed descriptor.
Every invocation re-fetches and verifies the authoritative documents.

Preview and refresh receive only read capabilities. Preview rechecks authority
after evidence resolution and cannot sign, publish, initialize a pod or register
an agent. An OAuth grant containing only `mcp:read` admits these precisely
classified operations; other generic invocations remain write-gated.

Submission revalidates the active signed action, authenticated actor, inputs,
evidence and guard, then publishes through the relay's existing authorization and
current-head CAS gates. The successor must independently verify and replay.
If publication succeeds but subsequent verification fails, the result records
that publication occurred, so a caller does not mistake it for a safe retry.

## Installation

The default `deploy/Dockerfile.relay` target ships the neutral relay. The explicit
`reference` target also compiles and installs this composition. The reference
deployment opts into that target in `deploy/images.json`.

For a separately assembled deployment, set `INTEREGO_RESOURCE_COMPOSITIONS` to a
JSON array of local module paths, resolved relative to the relay's compiled
`resource-compositions.js`. Remote URLs and document-selected code imports are
refused. An empty configuration installs no domain interpreters.

Adding another application using this contract format requires publishing its
signed documents, with no new MCP registration. Adding a different interpreter
is an explicit composition/deployment decision, outside the substrate tool list.

MCP tool and widget metadata can still be cached by a host. A new chat is not a
guaranteed refresh. Tool-surface digests identify the advertised server revision;
they cannot force the host to reload it.
