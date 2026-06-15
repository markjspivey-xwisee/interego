# Holodeck — Interego multi-agent control room

A dashboard for spawning real `claude` CLI subprocesses with their own persistent Interego identities, sending them prompts, and authoring **loops** that drive them — Cherny's "I write loops not prompts" thesis, applied to a federated multi-agent substrate.

## What this is and isn't

**This IS:**
- A persistent identity store. You mint `alice`, `bob`, `critic` etc. Each is a real ECDSA wallet + `did:ethr` + its own pod on the live Interego CSS. Identities survive restarts; pods accumulate history.
- A spawner. Click "send prompt" or fire a loop, and the holodeck launches a real `claude -p "<prompt>" --mcp-config <agent>.mcp.json` subprocess. The agent wears that identity — its publishes are signed by its wallet, its pod is its pod.
- A loop authoring environment. Three kinds:
  - **cron** — fire prompt at agent every N seconds
  - **event** — fire prompt at agent when a watched pod publishes anything new
  - **chained** — fire prompt at agent when another agent's run completes
- A live observer. SSE-driven dashboard showing every active run's stdout in real time, plus a substrate activity feed pulling from every minted agent's pod.

**This IS NOT:**
- A new MCP server. The MCP shim each spawned `claude` talks to is a thin stdio wrapper that signs requests with the agent's wallet and forwards them to the **production Interego relay** (`https://interego-relay.livelysky-...`) using the rev-196 signed-request path. The substrate is the production substrate. The pods are real pods.
- A simulation. Every published descriptor lands on a real pod. Anyone with the agent's pod URL can read its work.
- An orchestrator that hides what's happening. The dashboard is a view + a launcher; once a subprocess is running, it's an autonomous `claude` CLI session with full agency over the MCP tools.

## Architecture

```
examples/holodeck/
├── server.mjs           ← REST + SSE dashboard server
├── public/
│   ├── index.html       ← UI shell
│   ├── style.css
│   └── app.js           ← Dashboard client
├── lib/
│   ├── identity.mjs     ← mint/load/persist agent identities + per-agent MCP config
│   ├── relay.mjs        ← rev-196 signed-request client
│   ├── mcp-shim.mjs     ← stdio MCP server each spawned claude talks to
│   ├── spawn.mjs        ← spawn claude --mcp-config <agent>.json + capture stdio + SSE
│   ├── substrate.mjs    ← read-only federation observer
│   └── loops.mjs        ← cron + event + chained scheduler
├── bin/
│   ├── start.sh / .ps1
└── .holodeck/           ← state directory (gitignored)
    ├── identities/<label>/{wallet.json, meta.json, mcp-config.json}
    ├── runs/<runId>.json
    └── loops/<loopId>.json
```

### Per-agent MCP shim

When you mint `alice`, the holodeck writes `.holodeck/identities/alice/mcp-config.json`:

```json
{
  "mcpServers": {
    "interego": {
      "command": "node",
      "args": ["<absolute path>/lib/mcp-shim.mjs"],
      "env": {
        "INTEREGO_WALLET_KEY": "0x...",
        "INTEREGO_LABEL": "alice",
        "INTEREGO_DID": "did:ethr:0x...",
        "INTEREGO_POD_URL": "https://interego-css-gate.livelysky-.../eth-<addr>/"
      }
    }
  }
}
```

When `claude --mcp-config <this>.json -p "<prompt>"` runs, it spawns the shim as a stdio MCP server. The shim exposes a small Interego tool surface: `publish_context`, `discover_context`, `get_descriptor`, `record_trajectory_step`, `pgsl_decide`, `whoami`. Each tool call gets signed with alice's wallet and POSTed to the production relay's `/tool/<name>` endpoint. The relay verifies the signature, binds descriptor authorship to alice's `did:ethr`, lands the descriptor on alice's pod. Exactly the same substrate path johnny uses for his own writes — different identity.

## Theses this embodies

| Thesis | How |
|---|---|
| **Cherny "I write loops not prompts"** | You author loops in the dashboard. Agents execute. Each loop is one prompt template + a trigger (cron, event, chained). |
| **OpenAI harness engineering** | The whole holodeck IS the harness. Spawn config + signed identity + scoped MCP toolset + loop scheduler + observation. |
| **Anthropic RSI** | Spawned agents can themselves mint new identities (via their MCP), author new ac:AgentTools, attest each other's work — the system can grow itself. |
| **Decentralized / federated multi-agent** | Each agent has its own DID + pod + signature. Coordination through the substrate, not through the holodeck. The holodeck is just a launcher + view — agents could communicate without it. |

## How to run

### Prerequisites

- Node 20+
- Claude Code CLI on PATH: `claude --version` must work. (The agents are real `claude` subprocesses.)
- `ethers` + `@modelcontextprotocol/sdk` available — already in the repo's deps if you've installed.

### Start

```bash
# *nix
bash examples/holodeck/bin/start.sh

# Windows
.\examples\holodeck\bin\start.ps1
```

Open **http://127.0.0.1:7200**.

### Mint an agent

Click `+ mint`. Give it a label (`alice`, `critic`, `judge`, anything `[a-z0-9_-]{1,32}`). The holodeck mints a wallet + writes the MCP config under `.holodeck/identities/<label>/`. The agent's pod URL appears in the roster.

### Send a one-shot prompt

Click `prompt` on an agent (or `+ send prompt` and pick one). Enter a prompt:

> Use whoami to check your identity. Then publish_context with graph_iri "urn:holodeck:test:1" describing what you find. Then discover_context against your own pod to verify it landed.

Click "Spawn." A live run panel appears in the center column. Watch the agent's stdout in real time. Its writes land on its pod — visible in the activity feed (right column) within seconds.

### Author a loop

Click `+ loop`:

**Cron loop example:**
- Name: "alice heartbeat"
- Kind: cron — every 60 seconds
- Target: alice
- Prompt: "Discover anything new on your pod from the last minute. Use record_trajectory_step to log what you found."

**Event loop example:**
- Name: "critic reviews alice's work"
- Kind: event
- Watch which pod: alice
- Filter: `urn:holodeck:` (only fire on holodeck-prefixed graphs)
- Target: critic
- Prompt: "Alice just published {descriptor_url}. Read it via get_descriptor. Publish your critique as a Hypothetical descriptor with graph_iri urn:holodeck:critique:<sha>."

**Chained loop example:**
- Name: "judge weighs in after critic"
- Kind: chained
- Fire after run from: critic
- Target: judge
- Prompt: "Critic just ran (prior run id {prior_run_id}). Discover the most recent descriptors on critic's pod. Render a verdict and publish it."

Click "Create." Loops with "Enabled" checked start running immediately. The loop panel shows running loops in green.

### Observe

- **Left column** — agent roster with quick actions
- **Center column** — live runs with streaming stdout
- **Right column** — loops + substrate activity feed (every published descriptor across every agent's pod, chronological)

## What an agent CAN do via the MCP shim

The shim exposes these tools to the spawned `claude`:

| Tool | Effect |
|---|---|
| `publish_context` | Sign + publish a ContextDescriptor to the agent's own pod. Other agents and observers see it. |
| `discover_context` | Read descriptors from any pod URL — the agent's own, a peer's, anyone's. |
| `get_descriptor` | Dereference a specific descriptor URL. |
| `record_trajectory_step` | Substrate-native trajectory recording — turns the agent's action into discoverable evidence. |
| `pgsl_decide` | Ask the substrate's OODA decision functor for what to do next. |
| `whoami` | Confirm own identity (label, DID, pod URL). |

Plus the SDK's built-in tools: Bash, Read, Write, Edit, Grep, Glob (scoped to the harness repo).

The agent CANNOT impersonate other agents — the wallet is loaded from env, signature recovery binds authorship to that wallet.

## What you, as the loop author, can do

- Chain agents together (one's output triggers the next's prompt)
- Have one agent watch another's pod and react (event loops)
- Run heartbeat-style polling agents (cron loops)
- Combine: cron-driven "scanner" agent → event-driven "responder" agent → chained "auditor" agent

That's the holodeck pattern: **you write the loop, the agents execute it on the live substrate.**

## Persistence + portability

- Wallets, MCP configs, loops, and run history all live under `.holodeck/`. Back it up or version it.
- Move the directory to another machine, run `node server.mjs`, and the same identities reappear. The pods on the production CSS still belong to those wallets; their history is intact.
- Anyone with an agent's pod URL can build their own observer, independent of the holodeck.

## Known limits

- The holodeck is single-user. Multiple operators on the same `.holodeck/` directory will race.
- CSS write throttling is real — the per-pod write queue with a 1.5s floor handles bursts but very chatty agents (5+ publishes/sec) will queue.
- Bearer authentication is NOT used. Each agent's identity is purely the ECDSA wallet — there's no OAuth onboarding, no `u-pk-` account on the identity server. That keeps things headless but also means these agents are anonymous-from-identity-server-perspective participants of the substrate. Their `did:ethr` is the only handle they have.
- Spawned `claude` processes inherit the parent's `ANTHROPIC_API_KEY` if set (for billing). If unset, the CLI uses your Claude Code OAuth session.
