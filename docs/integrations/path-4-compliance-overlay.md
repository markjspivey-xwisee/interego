# Path 4 — agent-runtime compliance overlay

> Path 4 of [agent-runtime-integration.md](agent-runtime-integration.md).
> Every agent action emits a signed, framework-cited
> `cg:ContextDescriptor` — EU AI Act / NIST RMF / SOC 2 audit grade.

## What this is

The
[`@interego/compliance-overlay`](../../integrations/compliance-overlay/)
package wraps a runtime's tool-call event stream as compliance-grade
typed descriptors.

Architectural framing: every agent action — every tool call the
runtime emits — is *structurally* a `prov:Activity` performed by an
agent on behalf of an owner. Interego already encodes this, plus
control-citation via `dct:conformsTo` into the framework ontologies
declared in `docs/ns/eu-ai-act.ttl` / `nist-rmf.ttl` / `soc2.ttl`.
The overlay is the translator from the runtime's `(toolName, args,
result)` shape to the typed descriptor.

Substrate-pure construction is in
[`overlay.ts`](../../integrations/compliance-overlay/src/overlay.ts);
it does NOT introduce a new compliance facet, a new event-type
ontology, or a new framework table.

## What composes from existing primitives

| Audit property | Provided by |
|---|---|
| Signed authorship | Trust facet (self-asserted at publish; pod-side wallet signs on save) |
| Provenance attribution | PROV `wasAttributedTo` (owner) + `wasAssociatedWith` (agent) — separated cleanly |
| Modal-status filtering | success → Asserted, partial → Hypothetical, failure → Counterfactual |
| Time-bounded validity | Temporal facet with `validFrom` / `prov:startedAtTime` / `prov:endedAtTime` |
| Control citations | `dct:conformsTo` triples into the existing FRAMEWORK_CONTROLS table |
| Tamper detection | `cg:contentHash` over the event fingerprint |
| Anchored audit pair | `publish_context(compliance: true, ...)` adds ECDSA signature + IPFS CID; the overlay produces the descriptor; this finishing happens server-side |
| Cross-pod regulator access | `share_with: [did:web:auditor]` per descriptor; per-event scope |

## Two-layer API

```typescript
import { buildAgentActionDescriptor, recordAgentAction } from '@interego/compliance-overlay';

// Pure construction — no pod required
const built = buildAgentActionDescriptor(
  { toolName: 'web_browser.fetch', args: {...}, outcome: 'success', agentDid, onBehalfOf, ... },
  { framework: 'eu-ai-act' },
);

// Async write through the substrate
const { eventIri, descriptorUrl, graphUrl, cited } = await recordAgentAction(
  event,
  { podUrl: 'https://pod.example/agent/', defaultCitation: { framework: 'eu-ai-act' } },
);
```

## Per-event citation override

Different actions cite different controls. Override per call without
touching config:

```typescript
await recordAgentAction(event, config, {
  framework: 'soc2',
  controls: ['https://markjspivey-xwisee.github.io/interego/ns/soc2#CC8.1'],
});
```

When `controls` is omitted, the overlay defaults to every IRI in the
framework's `FRAMEWORK_CONTROLS` table — the wide citation. Tighten
it when you know the specific clause that applies.

## Honest scoping

* **Not the only path.** When the runtime's tool maps onto an existing
  operator-event shape (deploy, access change, wallet rotation,
  incident, quarterly review), the `src/ops/buildXEvent` builders
  produce tighter descriptors. Use those directly when applicable;
  the overlay is for the long tail of generic agent actions.
* **Argument privacy.** The overlay records `args` by default. Set
  `recordArgs: false` for sensitive runtimes; the substrate's
  `src/privacy/` preflight also runs at publish and halts on
  detected secrets.
* **Signing happens at publish.** The overlay produces the
  descriptor + graph; ECDSA signing + IPFS anchoring happen via the
  MCP server's `publish_context(compliance: true, ...)` route. The
  substrate's compliance pipeline is the one that adds
  cryptographic finishing, not the overlay.

## See also

* [`integrations/compliance-overlay/`](../../integrations/compliance-overlay/)
  — the package
* [`spec/SOC2-PREPARATION.md`](../../spec/SOC2-PREPARATION.md) — full
  SOC 2 evidence story
* [`docs/ns/eu-ai-act.ttl`](../../docs/ns/eu-ai-act.ttl) — EU AI Act
  control vocab
* [`src/ops/`](../../src/index.ts) — operator-event builders, used
  directly when the action shape matches
