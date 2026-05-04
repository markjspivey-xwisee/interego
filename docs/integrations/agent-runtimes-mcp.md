# Interego under any MCP-speaking agent runtime

> Path 1 of the four integration paths laid out in
> [agent-runtime-integration.md](agent-runtime-integration.md). This page
> shows how to plug Interego into an existing agent runtime via MCP — no
> new code, no new types, no specialized integration shim.

Interego is a substrate. It does not ship its own user-facing agent
runtime. Instead, it exposes its full primitive surface (publish typed
descriptors, discover them, federate, attest, sign, anchor, share E2EE)
as a stdio MCP server. **Any agent runtime that can speak MCP can mount
Interego as a memory + identity + federation layer** by editing one
config file.

This document covers the two most-asked-about runtimes — OpenClaw and
Hermes Agent — but the recipe is the same for every other MCP client
(VS Code Copilot, OpenAI Codex, Cursor, Claude Code itself). When a new
one arrives, this page does not need to change; the substrate primitives
already compose into whatever loop the runtime exposes.

---

## What plugging Interego into an agent runtime gets you

A bare agent runtime stores memory in local Markdown / SQLite. It has
no cryptographic identity, no cross-user federation, no typed context,
no audit trail, no governance.

Adding Interego as an MCP server gives the agent — *as ordinary tools*
that the LLM can decide to call — every primitive in the substrate:

| Substrate capability | Becomes the tool | What the agent gains |
|---|---|---|
| Persist a typed memory | `publish_context` | Modal status, signed provenance, supersedes-chain, pod-rooted truth |
| Recall it later | `discover_context` | Cross-session, cross-pod, cross-user query with type/temporal/access filters |
| Share with another person | `publish_context` with `share_with: [did:web:bob, ...]` | Per-publish E2EE envelope; no infrastructure change |
| Read another pod | `discover_all`, `subscribe_to_pod` | Federated agent memory without a central server |
| Cite who said what | `get_descriptor` | Full provenance walk back to the signing agent + human owner |
| Audit-grade record | `publish_context` with `compliance: true, compliance_framework: "EU AI Act § 13"` | Signed, anchored, framework-cited descriptor an auditor can verify cold |
| Verify an agent identity | `register_agent`, `verify_agent` | Wallet-rooted DID + capability passport |
| Multi-axis review | `publish_context` of `amta:Attestation` | Same primitive whether you're reviewing a tool, a fact, a skill, a teaching |

Notice what's NOT in this table: nothing runtime-specific. The agent's
memory is just a typed descriptor. The agent's skill is just a typed
descriptor. The agent's audit event is just a typed descriptor. They
all use the same `publish_context` / `discover_context` operations.
The interesting properties (federation, attestation, promotion,
supersession) are emergent from how the descriptors compose, not coded
specially.

---

## Recipe

### 1. Run the Interego stdio MCP server once

Clone the repo, install, build:

```bash
git clone https://github.com/markjspivey-xwisee/interego.git
cd interego
npm install
npm run build
```

The MCP server lives at `mcp-server/dist/server.js` and speaks stdio.
You will reference its absolute path in each runtime's MCP config below.

You will also need a Solid-style pod URL for storage. The pod is the
substrate's source of truth — it can be a local file-backed test pod,
your own self-hosted pod, or a hosted pod from any provider speaking
the spec. See [spec/pod-setup.md](../spec/pod-setup.md) for options.

### 2. Wire it into your runtime's MCP config

#### OpenClaw

OpenClaw discovers MCP servers through its standard
`openclaw mcp add` flow. The CLI accepts a stdio command line:

```bash
openclaw mcp add interego \
  --command "node" \
  --args "/abs/path/to/interego/mcp-server/dist/server.js" \
  --env CG_DEFAULT_POD_URL=https://your-pod.example/agent-name/ \
  --env CG_DEFAULT_AGENT_DID=did:web:your-pod.example
```

OpenClaw will surface every Interego tool to the agent automatically.
No further config — when the LLM decides "I should remember this", it
calls `publish_context`; when asked "what did we agree on about X", it
calls `discover_context` first.

For [proactive triggers](../../mcp-server/server.ts) (the agent
calling Interego *unprompted* on phrases like "remember this",
"share with bob", "who said that", "is this still true"), the MCP
server's instructions block already encodes the triggers and OpenClaw
will surface them to the LLM as part of the tool description.

#### Hermes Agent

Hermes' MCP integration uses the same shape. Edit
`~/.hermes/config.toml` (or per-host equivalent):

```toml
[[mcp.servers]]
name = "interego"
command = "node"
args = ["/abs/path/to/interego/mcp-server/dist/server.js"]
env = { CG_DEFAULT_POD_URL = "https://your-pod.example/agent-name/", CG_DEFAULT_AGENT_DID = "did:web:your-pod.example" }
```

Restart Hermes; the substrate's tools will appear in the agent's tool
table next to its built-in 40-odd tools.

#### Any other MCP client

Most MCP clients (Claude Code, VS Code Copilot in chat mode, Cursor,
Codex, …) read a JSON config of the form:

```json
{
  "mcpServers": {
    "interego": {
      "command": "node",
      "args": ["/abs/path/to/interego/mcp-server/dist/server.js"],
      "env": {
        "CG_DEFAULT_POD_URL": "https://your-pod.example/agent-name/",
        "CG_DEFAULT_AGENT_DID": "did:web:your-pod.example"
      }
    }
  }
}
```

The exact filename varies by client (e.g. `~/.claude/mcp.json`,
`.cursor/mcp.json`, etc.). The block is identical.

---

## What's actually happening at runtime

When the agent reaches for memory, the LLM emits a tool call. The MCP
server resolves the tool name to a substrate primitive:

```
LLM:                              Substrate:
─────                             ─────────
"call publish_context(...)"   →   ContextDescriptor.create(...)
                                    .temporal(...)
                                    .agent(authoringDID, signed=true)
                                    .asserted(0.9)
                                    .build()
                                  → publish(desc, graph, podUrl, { encrypt: ... })
                                  → wallet-rooted DID signs
                                  → optional anchoring (PGSL fragment + IPFS CID)
                                  → returned: descriptorUrl, graphUrl
```

```
"call discover_context(...)"  →   discover(podUrl, { typeFilter, temporal, ... })
                                  → enumerates the pod's `.ttl` index
                                  → resolves cg:supersedes chains
                                  → returns Asserted heads, with provenance
```

The agent runtime never has to know any of this. It speaks MCP; the
substrate does the typing, signing, federation, modal reasoning. When
the agent later writes the same fact again — that's a supersession,
which the substrate composes into a chain, which the auditor can walk.
None of that is in the agent runtime's code.

---

## Architectural framing — why MCP is the right interface

The substrate's seven facets (Temporal, Provenance, Agent,
AccessControl, Semiotic, Trust, Federation) and four composition
operators (union, intersection, restriction, override) are by design
*technology-neutral* — Layer-1 of the layering discipline. MCP is the
ergonomic at the surface; everything underneath is plain Interego.

This means a runtime that adopted Path 1 today and wants to graduate to
[Path 2 (memory plugin)](path-2-openclaw-memory-plugin.md),
[Path 3 (skills as affordances)](path-3-skills-as-affordances.md), or
[Path 4 (compliance overlay)](path-4-compliance-overlay.md) does not
have to migrate any descriptors. They were already typed. They were
already signed. They were already federable. The deeper paths just
remove a layer of indirection — they don't reshape the data model.

That property — **the substrate doesn't change shape with the
ergonomic** — is the point.

---

## Honest scoping

* **MCP server is the only ergonomic right now.** A runtime that
  doesn't speak MCP needs Path 2-style adapter work. Most modern
  runtimes converge on MCP precisely because of this property.
* **The agent runtime decides when to call.** Interego does not push
  memories at the agent. The MCP server's tool descriptions encode the
  proactive triggers (e.g. "user says 'remember this' → publish_context"),
  but the LLM's loop is what actually reaches for the tool. A more
  tightly coupled integration is what Path 2 buys.
* **Pod hygiene is the operator's job.** Interego will not delete the
  agent's old memories on its behalf. Use the modal-status /
  cg:supersedes pattern to retire facts; never overwrite. The substrate
  enforces this on the descriptor side; the agent must surface the
  pattern to the user.
* **Sensitive content screening runs server-side.** The MCP server
  has a privacy preflight (API keys, JWTs, PII patterns) that will halt
  a publish and surface a confirmation. This is enforced in
  `src/privacy/` regardless of which runtime called the tool.

---

## See also

* [agent-runtime-integration.md](agent-runtime-integration.md) — the
  four-path integration map
* [path-2-openclaw-memory-plugin.md](path-2-openclaw-memory-plugin.md)
  — when MCP is too loose; deeper coupling at OpenClaw's memory-engine
  slot
* [path-3-skills-as-affordances.md](path-3-skills-as-affordances.md)
  — agentskills.io SKILL.md ↔ `cg:Affordance` translator; emergent
  attestation, promotion, federation
* [path-4-compliance-overlay.md](path-4-compliance-overlay.md) — every
  agent action becomes a signed, framework-cited compliance descriptor
* [../ARCHITECTURAL-FOUNDATIONS.md](../ARCHITECTURAL-FOUNDATIONS.md) —
  why the substrate's primitives compose this way
