# @interego/mcp

**MCP server for [Interego](https://github.com/interego/interego)** — exposes 28 tools for publishing, discovering, composing, and reasoning over typed knowledge graphs through Solid pods. Compatible with Claude Code, Claude Desktop, Cursor, Windsurf, Cline, and any other MCP client.

## Install

```bash
# No install needed — npx fetches it on demand
npx -y @interego/mcp
```

Or pin it globally:

```bash
npm install -g @interego/mcp
context-graphs-mcp
```

## Configure your MCP client

### Claude Code

Edit `~/.claude.json` (or your project's `.claude/mcp.json`):

```jsonc
{
  "mcpServers": {
    "context-graphs": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

Restart Claude Code. The tools will appear under the `mcp__context-graphs__*` prefix.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```jsonc
{
  "mcpServers": {
    "context-graphs": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your workspace:

```jsonc
{
  "mcpServers": {
    "context-graphs": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```jsonc
{
  "mcpServers": {
    "context-graphs": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

## What you get

Once configured, your AI agent has these 28 tools available:

| Category | Tools |
|---|---|
| **Identity** | `setup_identity`, `link_wallet`, `register_agent`, `verify_agent`, `revoke_agent` |
| **Publishing** | `publish_context`, `publish_directory` |
| **Discovery** | `discover_context`, `discover_all`, `discover_directory`, `get_descriptor`, `resolve_webfinger`, `list_known_pods`, `get_pod_status` |
| **Federation** | `add_pod`, `remove_pod`, `subscribe_to_pod`, `subscribe_all` |
| **PGSL substrate** | `pgsl_ingest`, `pgsl_resolve`, `pgsl_lattice_status`, `pgsl_meet`, `pgsl_to_turtle` |
| **Reasoning** | `analyze_question` |
| **Wallet** | `check_balance` |

## Example prompts

After installing, try these in your AI client:

> "Set up an identity for me named Sarah Chen with agent label 'Claude Code (Sarah)'"

> "Publish this graph to my pod with high trust and a temporal facet valid through 2026"

> "Ingest this paragraph into PGSL and show me the resulting lattice structure"

> "What's the meet of fragments urn:pgsl:abc and urn:pgsl:xyz?"

> "Discover all context descriptors on bob.example.com that have a Trust facet"

> "Subscribe to all pods I know about and notify me when anything new is published"

The LLM picks the right tool based on what you ask — you don't have to remember tool names or schemas.

## Configuration via environment variables

```bash
CG_OWNER=https://id.example.com/agent/profile#me \
CG_AGENT=urn:agent:claude-code:my-laptop \
CG_HOME_POD=https://pod.example.com/agent/ \
CG_KNOWN_PODS=https://bob.example.com/,https://alice.example.com/ \
npx -y @interego/mcp
```

| Variable | Default | Purpose |
|---|---|---|
| `CG_OWNER` | `https://id.example.com/agent/profile#me` | The pod owner's WebID |
| `CG_AGENT` | `urn:agent:claude-code:local` | Identifier for this AI agent instance |
| `CG_HOME_POD` | `http://localhost:3456/agent/` | Default Solid pod for publishing |
| `CG_KNOWN_PODS` | _(empty)_ | Comma-separated pod URLs to seed the federation |

## Build from source

```bash
git clone https://github.com/interego/interego.git
cd context-graphs

# Build the library first
npm install
npm run build
npm pack   # creates interego-core-0.2.0.tgz

# Then build the MCP server against the local library
cd mcp-server
npm install ../interego-core-*.tgz --no-save
npm install   # picks up the rest of the deps
npm run build
node dist/server.js
```

## License

CC-BY-4.0 — see [LICENSE](../LICENSE) in the parent repository.

## Issues and contributions

[github.com/interego/interego/issues](https://github.com/interego/interego/issues)
