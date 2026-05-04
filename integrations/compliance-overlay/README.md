# @interego/compliance-overlay

Path 4 of the [agent-runtime-integration](../../docs/integrations/agent-runtime-integration.md)
map. Wraps every tool call an agent runtime emits as a compliance-grade
typed Interego descriptor.

## What it does

Takes the runtime's per-tool-call event tuple (toolName, args, outcome,
agent, timing) and produces a typed `cg:ContextDescriptor` whose graph
declares:

* `prov:Activity` typing — auditor walks PROV chains as expected
* `cgh:AgentAction` for substrate-side filtering (e.g. SPARQL queries
  over "all agent actions in the past 30 days that touched X")
* `dct:conformsTo` triples citing the regulatory controls
  (`eu-ai-act:Article15`, `soc2:CC8.1`, etc.) already declared in the
  substrate's compliance ontologies — no new IRIs are minted
* `prov:wasAttributedTo` (owner) and `prov:wasAssociatedWith` (agent)
  separated cleanly, per the existing PROV facet semantics
* Modal-status mapping: `success → Asserted`, `partial → Hypothetical`,
  `failure → Counterfactual` — auditors can filter "show me only the
  actions that didn't achieve their stated goal" without runtime
  string-matching error messages

Every property an auditor wants from an agent-action audit trail comes
from existing substrate primitives. The overlay does NOT introduce a
new compliance facet, a new event-type ontology, or a new framework
mapping; it composes the FRAMEWORK_CONTROLS table already in
`src/compliance/`.

## Two-layer API

`buildAgentActionDescriptor(event, citation)` — substrate-pure
construction. Returns `{ descriptor, graphContent, eventIri, ... }`.
Pure synchronous; testable without a pod.

`recordAgentAction(event, config, citation?)` — async writes the
descriptor through `publish()`. Returns `{ descriptorUrl, graphUrl, cited }`.

## Use

```typescript
import { recordAgentAction } from '@interego/compliance-overlay';

const config = {
  podUrl: 'https://your-pod.example/agent/',
  defaultCitation: { framework: 'eu-ai-act' },
  recordArgs: true,
};

// Inside your agent runtime's tool-call middleware:
async function onToolCallComplete(toolName, args, result, durationMs, outcome) {
  await recordAgentAction(
    {
      toolName,
      args,
      resultSummary: typeof result === 'string' ? result.slice(0, 500) : JSON.stringify(result).slice(0, 500),
      outcome,
      durationMs,
      agentDid: 'did:web:your-pod.example',
      onBehalfOf: 'did:web:human-owner.example',
      sessionId: currentSessionId,
    },
    config,
  );
}
```

For deeper assurance (ECDSA-signed sidecar, IPFS anchoring), publish
through the MCP `publish_context(compliance: true, compliance_framework: ...)`
tool instead of the bridge — same descriptor + graph, the MCP server
adds signature + anchor on top. The overlay produces the typed
content; the compliance pipeline does the cryptographic finishing.

## Per-event citation override

Different actions cite different controls. Override the citation per
event without touching config:

```typescript
await recordAgentAction(event, config, {
  framework: 'soc2',
  controls: ['https://markjspivey-xwisee.github.io/interego/ns/soc2#CC8.1'],
});
```

When `controls` is empty / omitted, the overlay defaults to every
control declared in the framework's `FRAMEWORK_CONTROLS` table — the
sensible "wide" citation for a generic action. Tighten it when you
know which specific clause applies.

## Honest scoping

* The overlay is generic. For runtime tools that map onto an existing
  operator-event shape (deploy, access change, wallet rotation,
  incident, quarterly review), call `src/ops/buildDeployEvent` etc.
  directly — they're tighter fits and cite better-targeted controls
  out of the box.
* The overlay does NOT extract args automatically. The runtime decides
  what to pass. The privacy preflight in `src/privacy/` runs at
  publish time and will halt + warn on detected secrets.
* Compliance-grade signing happens at publish time (MCP server's
  compliance route). The overlay produces the descriptor; signing is
  separate.

## See also

* [`docs/integrations/agent-runtime-integration.md`](../../docs/integrations/agent-runtime-integration.md)
  — the four-path map
* [`src/ops/`](../../src/index.ts) — `buildDeployEvent`,
  `buildAccessChangeEvent`, etc. — operator-event builders. Use them
  directly when the action shape matches.
* [`spec/SOC2-PREPARATION.md`](../../spec/SOC2-PREPARATION.md) — the
  full SOC 2 evidence story; this overlay is one piece.
