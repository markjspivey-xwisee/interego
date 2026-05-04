# Path 3 — agentskills.io SKILL.md as `cg:Affordance`

> Path 3 of [agent-runtime-integration.md](agent-runtime-integration.md).
> Bidirectional translator that turns the agentskills.io packaging
> standard into a federated, attestable, governable layer — without
> any new substrate types.

## What this is

[agentskills.io](https://agentskills.io/specification) is the
convergence-point format for portable agent skills:

```
my-skill/
├── SKILL.md          # YAML frontmatter + Markdown instructions
├── scripts/          # Optional executables
├── references/       # Optional documentation
└── assets/           # Optional templates
```

OpenClaw, Hermes Agent, OpenAI Codex, VS Code Copilot, Microsoft Agent
Framework, and Cursor all consume this format. None of them have a
shared, federated, attestable layer for skills — every user's skills
live in their own `~/.openclaw/skills/`, `~/.hermes/skills/`, etc.

A SKILL.md is *structurally* a `cg:Affordance` — a discoverable named
capability with a hydra-style invocation surface. Interego already has
this typed predicate. The translator goes both ways:

* **publish:** SKILL.md directory → typed `cg:Affordance` descriptor
  with PROV provenance, modal status, content-hashed `pgsl:Atom` for
  every file, signed authorship.
* **discover:** any cross-pod `discover` for affordances yields back a
  reconstructible SKILL.md directory the runtime drops into its skill
  folder.

What composes from existing substrate primitives — **with no new
code** — once skills are typed descriptors:

| Property | Composes from |
|---|---|
| Multi-axis attestation | `amta:Attestation` (correctness / safety / efficiency / generality) — same flow as the AC vertical's tool attestation |
| Modal-status promotion | `cg:Hypothetical → cg:Asserted` via cohort threshold (Demo 19) |
| Versioning | `cg:supersedes` chain across SKILL.md edits |
| Federated discovery | `discover_all` / `subscribe_to_pod` — a colleague's skill is discoverable from your pod if shared |
| E2EE skill share | `publish_context(share_with: [did:web:bob])` — per-skill visibility |
| Governance | `cgh:PromotionConstraint` — "this skill cannot be Asserted until it has a safety-axis attestation" (Demo 19's machinery, no skill-specific code) |
| Tamper detection | `cg:contentHash` on every `pgsl:Atom`, including SKILL.md and every script/reference file |
| Audit trail | PROV-O `wasAttributedTo` (owner) + `wasAssociatedWith` (agent), supersedes-walkable |
| Compliance | When a skill is for a regulated workflow, publish via the [compliance overlay](path-4-compliance-overlay.md) — Article-15 cited in the same descriptor |

## Translator API

`src/skills/index.ts`:

```typescript
import {
  parseSkillMd,
  emitSkillMd,
  skillBundleToDescriptor,
  descriptorGraphToSkillBundle,
  descriptorGraphToSkillMd,
} from '@interego/core';

// Forward: SKILL.md package → typed descriptor + graph
const bundle: SkillBundle = {
  skillMd: readFileSync('./my-skill/SKILL.md', 'utf-8'),
  files: new Map([
    ['scripts/extract.py', readFileSync('./my-skill/scripts/extract.py', 'utf-8')],
    ['references/REFERENCE.md', readFileSync('./my-skill/references/REFERENCE.md', 'utf-8')],
  ]),
};

const { descriptor, graphContent, skillIri } = skillBundleToDescriptor(bundle, {
  authoringAgentDid: 'did:web:alice.example',
  modalStatus: 'Hypothetical',         // default — community will promote
  hydraTarget: 'https://my-host/skills/pdf-processing/run',  // optional
});

await publish(descriptor, graphContent, podUrl);

// Reverse: pod descriptor → bundle (drop into ~/.hermes/skills/)
const hits = await discover(podUrl);
for (const hit of hits) {
  if (!hit.types.includes('https://markjspivey-xwisee.github.io/interego/ns/cg#Affordance')) continue;
  const trig = await fetchGraph(hit.graphUrl);
  const recovered = descriptorGraphToSkillBundle(trig);
  // Write recovered.skillMd + recovered.files into ~/.hermes/skills/<name>/
}
```

## What's *not* in the translator

The translator is intentionally narrow:

* No new namespace. Uses only `cg:`, `cgh:`, `dct:`, `hydra:`, `dcat:`,
  `pgsl:`, `prov:`, `rdfs:` — every predicate already in the protocol.
* No new IRI scheme rules. Skill IRIs use
  `urn:cg:skill:<name>:<sha256(SKILL.md)[:16]>` — the same shape as
  `urn:cg:tool:<name>:<id>` the AC vertical uses for tools. Stable +
  content-derived = same skill produces the same IRI from any author.
* No new attestation flow. The AC vertical's `attestTool` /
  `promoteTool` work unchanged on a skill IRI; `amta:axis` of
  `correctness` / `safety` / `efficiency` / `generality` apply
  identically.

The substrate doesn't know it's a "skill" rather than a "tool" or a
"teaching package" — they're all `cg:Affordance` subjects with
provenance + modal status. The translator is the only piece that
cares about the SKILL.md surface; everything else is composition.

## Demo

See [`demos/scenarios/22-skills-as-substrate.ts`](../../demos/scenarios/22-skills-as-substrate.ts)
*(future)*. Three agents publish SKILL.md skills to a shared pod; a
`cgh:PromotionConstraint` requires a safety-axis attestation; agents
cross-attest; some skills get promoted, some don't. Discovery from a
fourth agent's pod yields the promoted skills back as ready-to-drop
SKILL.md directories.

## See also

* [Path 1 — Interego as MCP server](agent-runtimes-mcp.md)
* [Path 2 — OpenClaw memory plugin](path-2-openclaw-memory-plugin.md)
* [Path 4 — compliance overlay](path-4-compliance-overlay.md)
* [agentskills.io specification](https://agentskills.io/specification)
* [`src/skills/`](../../src/skills/) — the translator implementation
